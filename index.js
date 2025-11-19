// AI SCALPER V7 – SPOT LONG BOT + MALi SERVER ZA RAILWAY

import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import express from "express";

dotenv.config();

// --------------------------------------------------------
// KONFIG
// --------------------------------------------------------
const SYMBOL = "BTCUSDC";
const BASE_ASSET = "BTC";
const QUOTE_ASSET = "USDC";

const CONFIG = {
  stakePct: 0.70,          // 70% balansa po ulazu
  stakeIncrement: 0.10,    // +10% nakon profita
  maxStakeMultiplier: 3.5, // max 3.5x stake
  baseSL: -0.018,          // -1.8% SL
  tpTriggerPct: 0.0020,    // +0.20% aktivira trailing
  tpTrail: 0.0016,         // trailing 0.16% od peak-a
  trendWindow: 24,         // broj uzoraka za AI score
  minVolatility: 0.0009,   // 0.09% minimalna volatilnost
  maxFlatRange: 0.0012,    // 0.12% max “mrtvo” kretanje
  antiCrashPct: -0.028,    // -2.8% pad -> crash mode
  crashPauseMs: 240000,    // 4 minute pauze
  loopMs: 700,             // 0.7s loop
  minOrder: 5              // minimalna vrijednost naloga u USDC
};

// --------------------------------------------------------
// STATE
// --------------------------------------------------------
let prices = [];            // niz zadnjih cijena
let antiCrashUntil = 0;     // vrijeme do kojeg je pauza aktivna

let startingStake = null;   // početni stake u USDC
let stakeMultiplier = 1;    // dinamika uloga
let position = null;        // { entry, qty, peak, stop, trailing }

// Binance API
const API_KEY = process.env.BINANCE_KEY;
const API_SECRET = process.env.BINANCE_SECRET;
const BASE_URL = "https://api.binance.com";

// --------------------------------------------------------
// BINANCE HELPERI
// --------------------------------------------------------
function sign(data) {
  return crypto.createHmac("sha256", API_SECRET).update(data).digest("hex");
}

async function api(method, path, params = {}, signed = false) {
  const ts = Date.now();
  const q = new URLSearchParams(params);

  if (signed) {
    q.append("timestamp", ts.toString());
    q.append("signature", sign(q.toString()));
  }

  const url = `${BASE_URL}${path}?${q.toString()}`;

  const res = await axios({
    method,
    url,
    headers: signed ? { "X-MBX-APIKEY": API_KEY } : {}
  });

  return res.data;
}

async function getPrice() {
  const r = await api("GET", "/api/v3/ticker/price", { symbol: SYMBOL });
  return parseFloat(r.price);
}

async function getBalance(asset) {
  const acc = await api("GET", "/api/v3/account", {}, true);
  const b = acc.balances.find(x => x.asset === asset);
  return b ? parseFloat(b.free) : 0;
}

async function marketOrder(side, qty) {
  return api(
    "POST",
    "/api/v3/order",
    {
      symbol: SYMBOL,
      side,
      type: "MARKET",
      quantity: qty.toFixed(6)
    },
    true
  );
}

// --------------------------------------------------------
// AI SCORE SISTEM
// --------------------------------------------------------
function computeAIScore() {
  if (prices.length < CONFIG.trendWindow) return 0;

  const first = prices[0];
  const last = prices[prices.length - 1];
  const trend = (last - first) / first;

  let score = 0;

  // 1) Trend
  if (trend > 0.0015) score += 20;
  if (trend > 0.003) score += 10;
  if (trend < -0.0015) score -= 20;

  // 2) Momentum (druga polovina prozora)
  const half = Math.floor(prices.length / 2);
  const early = prices[half];
  const momentum = (last - early) / early;

  if (momentum > 0.0015) score += 20;
  if (momentum < -0.0015) score -= 20;

  // 3) Volatilnost
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const volatility = (maxP - minP) / last;

  if (volatility > 0.0025) score += 15;
  if (volatility < CONFIG.minVolatility) score -= 15;

  // 4) Flat tržište
  const range = Math.abs(last - first) / first;
  if (range < CONFIG.maxFlatRange) score -= 20;

  // 5) Spike detektor
  if (momentum > 0.004) score += 25;
  if (momentum < -0.004) score -= 25;

  return Math.max(0, Math.min(100, score));
}

// --------------------------------------------------------
// ANTI-CRASH
// --------------------------------------------------------
function updatePricesAndCrash(price) {
  prices.push(price);
  if (prices.length > CONFIG.trendWindow) prices.shift();

  if (prices.length < 2) return;

  const first = prices[0];
  const drop = (price - first) / first;

  if (drop <= CONFIG.antiCrashPct) {
    antiCrashUntil = Date.now() + CONFIG.crashPauseMs;
    console.log(
      `⚠️ CRASH MODE: pad ${(drop * 100).toFixed(2)}% → pauza ${
        CONFIG.crashPauseMs / 60000
      } min`
    );
  }
}

// --------------------------------------------------------
// STAKE LOGIKA
// --------------------------------------------------------
async function getStakeQty(price) {
  const usdc = await getBalance(QUOTE_ASSET);

  if (startingStake === null) {
    startingStake = usdc * CONFIG.stakePct;
    console.log("Initial stake:", startingStake.toFixed(2), "USDC");
  }

  let stake = startingStake * stakeMultiplier;
  stake = Math.min(stake, usdc * CONFIG.stakePct);

  if (stake < CONFIG.minOrder) return 0;

  return stake / price;
}

function updateStake(pnl) {
  if (pnl > 0) {
    stakeMultiplier = Math.min(
      CONFIG.maxStakeMultiplier,
      stakeMultiplier * (1 + CONFIG.stakeIncrement)
    );
  } else {
    stakeMultiplier = 1;
  }

  console.log("Stake multiplier:", stakeMultiplier.toFixed(2), "x");
}

// --------------------------------------------------------
// POZICIJE
// --------------------------------------------------------
async function openPosition(price) {
  if (Date.now() < antiCrashUntil) {
    console.log("⏸ Anti-crash pauza, ne ulazim.");
    return;
  }

  const qty = await getStakeQty(price);
  if (qty <= 0) {
    console.log("Premali stake / USDC za ulaz.");
    return;
  }

  try {
    await marketOrder("BUY", qty);

    position = {
      entry: price,
      qty,
      peak: price,
      stop: price * (1 + CONFIG.baseSL),
      trailing: false
    };

    console.log(
      `✅ OPEN LONG ${qty.toFixed(6)} BTC @ ${price.toFixed(
        2
      )} | SL=${position.stop.toFixed(2)}`
    );
  } catch (e) {
    console.error("BUY ERROR:", e.response?.data || e.message || e);
  }
}

async function closePosition(price, reason) {
  if (!position) return;

  try {
    await marketOrder("SELL", position.qty);

    const pnl = (price - position.entry) / position.entry;
    const pnlPct = pnl * 100;

    console.log(
      `🔻 CLOSE LONG @ ${price.toFixed(
        2
      )} | reason=${reason} | PnL=${pnlPct.toFixed(3)}%`
    );

    updateStake(pnl);
    position = null;
  } catch (e) {
    console.error("SELL ERROR:", e.response?.data || e.message || e);
  }
}

// --------------------------------------------------------
// UPRAVLJANJE POZICIJOM
// --------------------------------------------------------
async function managePosition(price) {
  if (!position) return;

  if (price > position.peak) position.peak = price;

  const fromEntry = (price - position.entry) / position.entry;

  // TP trigger
  if (!position.trailing && fromEntry >= CONFIG.tpTriggerPct) {
    position.trailing = true;
    position.peak = price;
    console.log("🎯 TP trigger → TRAILING mode");
  }

  // Trailing logika
  if (position.trailing) {
    const drop = (position.peak - price) / position.peak;
    if (drop >= CONFIG.tpTrail) {
      await closePosition(price, "TRAIL_TP");
      return;
    }
  }

  // Hard SL
  if (price <= position.stop) {
    await closePosition(price, "STOP_LOSS");
  }
}

// --------------------------------------------------------
// ULAZ (AI ULAZI)
// --------------------------------------------------------
async function maybeEnter(price) {
  if (position) return;
  if (Date.now() < antiCrashUntil) return;

  const score = computeAIScore();

  console.log(
    `Price=${price.toFixed(2)} | AI SCORE=${score} | ${
      position ? "IN TRADE" : "FLAT"
    }`
  );

  if (score >= 65) {
    await openPosition(price);
  }
}

// --------------------------------------------------------
// MAIN LOOP
// --------------------------------------------------------
async function tick() {
  try {
    const price = await getPrice();
    updatePricesAndCrash(price);

    if (position) {
      await managePosition(price);
    } else {
      await maybeEnter(price);
    }
  } catch (e) {
    console.error("LOOP ERROR:", e.message || e);
  }
}

console.log("🚀 START — AI SCALPER V7 (SPOT LONG, ESM)");

// pokretanje trading petlje
setInterval(() => {
  tick().catch(e => console.error("Fatal tick error:", e));
}, CONFIG.loopMs);

// --------------------------------------------------------
// MALI EXPRESS SERVER (DA RAILWAY NE GASI BOTA)
// --------------------------------------------------------
const app = express();
app.get("/", (req, res) => {
  res.send("Riply Binance bot running ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Healthcheck server listening on port ${PORT}`);
});
