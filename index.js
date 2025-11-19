// MULTI-ASSET AI SPOT BOT (BTC, ETH, BNB, SOL)
// Auto-trading bot sa AI score, volatility filter, trailing TP, SL, anti-crash
// Ulaže 70% kapitala u NAJBOLJI par u datom trenutku

import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

// ---------------------------------------------
// KONFIGURACIJA
// ---------------------------------------------
const ASSETS = ["BTCUSDC", "ETHUSDC", "BNBUSDC", "SOLUSDC"];

const CONFIG = {
  stakePct: 0.70,       // 70% kapitala
  tpStart: 0.003,       // 0.3% aktivira trailing TP
  tpTrail: 0.002,       // trailing 0.2%
  stopLoss: -0.015,     // -1.5% SL
  aiTrendWindow: 24,
  minVolatility: 0.0010,
  antiCrashPct: -0.022,
  antiCrashWindowMs: 60000,
  crashPauseMs: 180000,
  loopMs: 1500,
  minOrder: 5
};

// ---------------------------------------------
// BINANCE API
// ---------------------------------------------
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
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

async function getPrice(symbol) {
  const r = await api("GET", "/api/v3/ticker/price", { symbol });
  return parseFloat(r.price);
}

async function getBalance(asset) {
  const acc = await api("GET", "/api/v3/account", {}, true);
  const b = acc.balances.find((x) => x.asset === asset);
  return b ? parseFloat(b.free) : 0;
}

async function sendOrder(symbol, side, qty) {
  return api(
    "POST",
    "/api/v3/order",
    { symbol, side, type: "MARKET", quantity: qty.toFixed(6) },
    true
  );
}

// ---------------------------------------------
// STATE
// ---------------------------------------------
let history = {
  BTCUSDC: [],
  ETHUSDC: [],
  BNBUSDC: [],
  SOLUSDC: []
};

let antiCrashUntil = 0;
let position = null;

// ---------------------------------------------
// AI SCORE
// ---------------------------------------------
function computeAIScore(symbol) {
  const arr = history[symbol];
  if (arr.length < CONFIG.aiTrendWindow) return -999;

  const first = arr[0];
  const last = arr[arr.length - 1];
  const trend = (last - first) / first;

  let score = 0;

  if (trend > 0.002) score += 30;
  if (trend > 0.004) score += 20;
  if (trend < -0.002) score -= 30;

  const half = arr[Math.floor(arr.length / 2)];
  const momentum = (last - half) / half;

  if (momentum > 0.0015) score += 20;
  if (momentum < -0.001) score -= 20;

  const high = Math.max(...arr);
  const low = Math.min(...arr);
  const volatility = (high - low) / last;

  if (volatility < CONFIG.minVolatility) score -= 40;

  return score;
}

// ---------------------------------------------
// ANTI-CRASH MEHANIZAM
// ---------------------------------------------
function updateCrashGuard(symbol, price) {
  const now = Date.now();
  history[symbol].push(price);
  history[symbol] = history[symbol].slice(-60);

  if (history[symbol].length < 2) return;

  const first = history[symbol][0];
  const change = (price - first) / first;

  if (change <= CONFIG.antiCrashPct) {
    antiCrashUntil = now + CONFIG.crashPauseMs;
    console.log(`⚠️ ANTICRASH: ${symbol} pao ${(change * 100).toFixed(2)}%, pauza aktivna`);
  }
}

// ---------------------------------------------
// TRADING LOGIKA – BEZ POZICIJE
// ---------------------------------------------
async function handleNoPosition(prices) {
  const now = Date.now();

  if (now < antiCrashUntil) {
    console.log("⏸ Pauza zbog anti-crash zaštite");
    return;
  }

  const usdc = await getBalance("USDC");
  const stake = usdc * CONFIG.stakePct;

  if (stake < CONFIG.minOrder) {
    console.log("Premalo USDC za poziciju.");
    return;
  }

  // AI score za sve parove
  let scores = {};
  for (let s of ASSETS) {
    scores[s] = computeAIScore(s);
  }

  // Najbolji par
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];

  if (scores[best] < 0) {
    console.log("Nema pozitivnog AI signala, čekam.");
    return;
  }

  const entry = prices[best];
  const qty = stake / entry;

  console.log(`🚀 KUPUJEM ${best} @ ${entry} qty=${qty}`);

  await sendOrder(best, "BUY", qty);

  position = {
    symbol: best,
    entry,
    qty,
    trailingHigh: entry,
  };
}

// ---------------------------------------------
// TRADING LOGIKA – SA POZICIJOM
// ---------------------------------------------
async function handlePosition(price) {
  const pnl = (price - position.entry) / position.entry;

  // STOP LOSS
  if (pnl <= CONFIG.stopLoss) {
    console.log(`🛑 STOP LOSS @ ${price}`);
    await sendOrder(position.symbol, "SELL", position.qty);
    position = null;
    return;
  }

  // TRAILING TP
  if (pnl >= CONFIG.tpStart) {
    if (price > position.trailingHigh) {
      position.trailingHigh = price;
    }

    const trailStop = position.trailingHigh * (1 - CONFIG.tpTrail);

    if (price <= trailStop) {
      console.log(`💰 TRAILING TP SELL @ ${price}`);
      await sendOrder(position.symbol, "SELL", position.qty);
      position = null;
      return;
    }

    console.log(`… Trailing ${position.symbol}: HL=${position.trailingHigh} PNL=${(pnl*100).toFixed(2)}%`);
  } else {
    console.log(`Pozicija ${position.symbol}: PNL=${(pnl*100).toFixed(2)}%`);
  }
}

// ---------------------------------------------
// MAIN LOOP
// ---------------------------------------------
async function loop() {
  let prices = {};

  for (let s of ASSETS) {
    const price = await getPrice(s);
    prices[s] = price;

    updateCrashGuard(s, price);
    history[s].push(price);
    history[s] = history[s].slice(-CONFIG.aiTrendWindow);
  }

  if (!position) {
    await handleNoPosition(prices);
  } else {
    await handlePosition(prices[position.symbol]);
  }

  setTimeout(loop, CONFIG.loopMs);
}

console.log("🚀 MULTI-ASSET AI BOT STARTAN");
loop();
