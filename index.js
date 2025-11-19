import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import express from "express";

dotenv.config();

// =======================
// CONFIG
// =======================
const SYMBOL = "BTCUSDC";
const BASE_ASSET = "BTC";
const QUOTE_ASSET = "USDC";

const CONFIG = {
  stakePct: 0.70,
  stakeIncrement: 0.10,
  maxStakeMultiplier: 3,
  baseSL: -0.018,
  tpTriggerPct: 0.0020,
  tpTrail: 0.0016,
  trendWindow: 24,
  minVolatility: 0.0009,
  maxFlatRange: 0.0012,
  antiCrashPct: -0.028,
  crashPauseMs: 240000,
  loopMs: 700,
  minOrder: 5
};

// =======================
// STATE
// =======================
let prices = [];
let antiCrashUntil = 0;
let stakeMultiplier = 1;
let position = null;

// =======================
// BINANCE REST API
// =======================
const API_KEY = process.env.BINANCE_KEY;
const API_SECRET = process.env.BINANCE_SECRET;
const BASE_URL = "https://api.binance.com";

function sign(data) {
  return crypto.createHmac("sha256", API_SECRET).update(data).digest("hex");
}

async function api(method, path, params = {}, signed = false) {
  const ts = Date.now();
  const q = new URLSearchParams(params);

  if (signed) {
    q.append("timestamp", ts);
    q.append("signature", sign(q.toString()));
  }

  const url = `${BASE_URL}${path}?${q.toString()}`;
  return (
    await axios({
      method,
      url,
      headers: signed ? { "X-MBX-APIKEY": API_KEY } : {},
    })
  ).data;
}

async function getPrice() {
  const r = await api("GET", "/api/v3/ticker/price", { symbol: SYMBOL });
  return parseFloat(r.price);
}

async function getBalance(asset) {
  const acc = await api("GET", "/api/v3/account", {}, true);
  const b = acc.balances.find((x) => x.asset === asset);
  return b ? parseFloat(b.free) : 0;
}

async function order(side, qty) {
  console.log(`🚀 Sending REAL order: ${side} | qty=${qty}`);
  return api(
    "POST",
    "/api/v3/order",
    { symbol: SYMBOL, side, type: "MARKET", quantity: qty.toFixed(6) },
    true
  );
}

// =======================
// AI SCORE SYSTEM
// =======================
function computeAIScore() {
  if (prices.length < CONFIG.trendWindow) return 0;

  const first = prices[0];
  const last = prices[prices.length - 1];
  const trend = (last - first) / first;

  let score = 0;

  if (trend > 0.0015) score += 20;
  if (trend > 0.003) score += 15;
  if (trend < -0.0015) score -= 20;

  const volatility =
    (Math.max(...prices) - Math.min(...prices)) / prices[0];
  if (volatility < CONFIG.minVolatility) score -= 10;

  if (volatility < CONFIG.maxFlatRange) score -= 20;

  return score;
}

// =======================
// MAIN LOOP
// =======================
async function loop() {
  while (true) {
    try {
      const price = await getPrice();
      prices.push(price);
      if (prices.length > CONFIG.trendWindow) prices.shift();

      const now = Date.now();

      // ANTI CRASH
      if (prices.length > 2) {
        const change = (price - prices[0]) / prices[0];
        if (change <= CONFIG.antiCrashPct) {
          antiCrashUntil = now + CONFIG.crashPauseMs;
          console.log(`⚠️ ANTI-CRASH ACTIVATED for 4 min`);
        }
      }

      if (now < antiCrashUntil) {
        console.log(`⏸ Crash pause active...`);
        await new Promise((r) => setTimeout(r, CONFIG.loopMs));
        continue;
      }

      const score = computeAIScore();

      console.log(
        `Price=${price} | AI SCORE=${score} | STATE=${position ? "OPEN" : "FLAT"}`
      );

      // ==========================
      // NO POSITION → LOOK FOR ENTRY
      // ==========================
      if (!position) {
        if (score > 25) {
          const usdc = await getBalance(QUOTE_ASSET);
          const stake = usdc * CONFIG.stakePct * stakeMultiplier;

          if (stake < CONFIG.minOrder) {
            console.log("⚠️ Premalo USDC za ulaz.");
          } else {
            const qty = stake / price;
            await order("BUY", qty);

            position = {
              entry: price,
              qty,
              highest: price,
            };

            console.log(`🟢 BUY @ ${price} | qty=${qty}`);
          }
        }
      }

      // ==========================
      // POSITION OPEN → MANAGE TP / SL
      // ==========================
      else {
        const pnl = (price - position.entry) / position.entry;

        // STOP LOSS
        if (pnl <= CONFIG.baseSL) {
          await order("SELL", position.qty);
          console.log(`🔴 STOP LOSS @ ${price}`);
          position = null;
          stakeMultiplier = 1;
        }

        // TRAILING TAKE PROFIT
        if (pnl >= CONFIG.tpTriggerPct) {
          if (price > position.highest) position.highest = price;

          if (price < position.highest * (1 - CONFIG.tpTrail)) {
            await order("SELL", position.qty);
            console.log(`💰 TAKE PROFIT @ ${price}`);

            stakeMultiplier = Math.min(
              stakeMultiplier * (1 + CONFIG.stakeIncrement),
              CONFIG.maxStakeMultiplier
            );

            position = null;
          }
        }
      }
    } catch (err) {
      console.error("❌ ERROR:", err.message);
    }

    await new Promise((r) => setTimeout(r, CONFIG.loopMs));
  }
}

// =======================
// KEEP-ALIVE SERVER
// =======================
const app = express();
app.get("/", (req, res) => res.send("Bot running"));
app.listen(3000, () => console.log("Keep-alive server started."));

console.log("🚀 AI SCALPER V10 STARTING...");
loop();
import express from "express";
const app = express();

app.get("/", (req, res) => {
  res.send("AI Scalper V10 is running...");
});

// Railway zahtijeva PORT varijablu
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server alive on port", PORT);
});
