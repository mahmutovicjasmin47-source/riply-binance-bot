// 🚀 RIPLY BINANCE BOT — RAILWAY STABLE EDITION
// Auto-buy / sell + trailing + AI score + crash protection + keep-alive server

import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import express from "express";

dotenv.config();

// ===== KONFIG =====
const SYMBOL = "BTCUSDC";
const BASE_ASSET = "BTC";
const QUOTE_ASSET = "USDC";

const CONFIG = {
  stakePct: 0.70,
  stakeIncrement: 0.10,
  maxStakeMultiplier: 3.5,
  baseSL: -0.018,
  tpTriggerPct: 0.002,
  tpTrail: 0.0016,
  trendWindow: 24,
  minVolatility: 0.0009,
  maxFlatRange: 0.0012,
  antiCrashPct: -0.028,
  crashPauseMs: 240000,
  loopMs: 1000,
  minOrder: 5
};

// ===== STATE =====
let prices = [];
let antiCrashUntil = 0;
let startingStake = null;
let stakeMultiplier = 1;
let position = null;
let lastLogTime = 0;

// ===== BINANCE API =====
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
  const res = await axios({ method, url, headers: signed ? { "X-MBX-APIKEY": API_KEY } : {} });
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
    { symbol: SYMBOL, side, type: "MARKET", quantity: qty.toFixed(6) },
    true
  );
}

// ===== AI SCORE =====
function computeAIScore() {
  if (prices.length < CONFIG.trendWindow) return 0;

  const first = prices[0];
  const last = prices[prices.length - 1];
  const trend = (last - first) / first;
  const half = Math.floor(prices.length / 2);
  const early = prices[half];
  const momentum = (last - early) / early;
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const volatility = (maxP - minP) / last;
  const range = Math.abs(last - first) / first;

  let score = 0;
  if (trend > 0.0015) score += 20;
  if (trend > 0.003) score += 10;
  if (trend < -0.0015) score -= 20;
  if (momentum > 0.0015) score += 20;
  if (momentum < -0.0015) score -= 20;
  if (volatility > 0.0025) score += 15;
  if (volatility < CONFIG.minVolatility) score -= 15;
  if (range < CONFIG.maxFlatRange) score -= 20;
  if (momentum > 0.004) score += 25;
  if (momentum < -0.004) score -= 25;

  return Math.max(0, Math.min(100, score));
}

// ===== PRICE HISTORY + ANTI-CRASH =====
function updatePricesAndCrash(price) {
  prices.push(price);
  if (prices.length > CONFIG.trendWindow) prices.shift();

  const first = prices[0];
  const drop = (price - first) / first;
  if (drop <= CONFIG.antiCrashPct) {
    antiCrashUntil = Date.now() + CONFIG.crashPauseMs;
    console.log(`⚠️ CRASH DETECTED → pause ${(CONFIG.crashPauseMs / 60000).toFixed(1)} min`);
  }
}

// ===== STAKE LOGIKA =====
async function getStakeQty(price) {
  const usdc = await getBalance(QUOTE_ASSET);
  if (startingStake === null) startingStake = usdc * CONFIG.stakePct;
  let stake = startingStake * stakeMultiplier;
  stake = Math.min(stake, usdc * CONFIG.stakePct);
  if (stake < CONFIG.minOrder) return 0;
  return stake / price;
}

function updateStake(pnl) {
  if (pnl > 0) stakeMultiplier = Math.min(CONFIG.maxStakeMultiplier, stakeMultiplier * (1 + CONFIG.stakeIncrement));
  else stakeMultiplier = 1;
  console.log(`📊 New stake multiplier: ${stakeMultiplier.toFixed(2)}x`);
}

// ===== POZICIJE =====
async function openPosition(price) {
  if (Date.now() < antiCrashUntil) return;
  const qty = await getStakeQty(price);
  if (qty <= 0) return;

  try {
    await marketOrder("BUY", qty);
    position = { entry: price, qty, peak: price, stop: price * (1 + CONFIG.baseSL), trailing: false };
    console.log(`✅ BUY ${qty.toFixed(6)} BTC @ ${price.toFixed(2)}`);
  } catch (e) {
    console.error("BUY ERROR:", e.response?.data || e.message);
  }
}

async function closePosition(price, reason) {
  if (!position) return;
  try {
    await marketOrder("SELL", position.qty);
    const pnl = (price - position.entry) / position.entry;
    const pnlPct = pnl * 100;
    console.log(`💰 SELL @ ${price.toFixed(2)} | ${reason} | PnL=${pnlPct.toFixed(2)}%`);
    updateStake(pnl);
    position = null;
  } catch (e) {
    console.error("SELL ERROR:", e.response?.data || e.message);
  }
}

async function managePosition(price) {
  if (!position) return;
  if (price > position.peak) position.peak = price;

  const fromEntry = (price - position.entry) / position.entry;
  if (!position.trailing && fromEntry >= CONFIG.tpTriggerPct) {
    position.trailing = true;
    position.peak = price;
    console.log("🎯 TP TRIGGER → trailing active");
  }

  if (position.trailing) {
    const drop = (position.peak - price) / position.peak;
    if (drop >= CONFIG.tpTrail) await closePosition(price, "TRAIL_TP");
  }

  if (price <= position.stop) await closePosition(price, "STOP_LOSS");
}

async function maybeEnter(price) {
  if (position || Date.now() < antiCrashUntil) return;
  const score = computeAIScore();
  const now = Date.now();

  if (now - lastLogTime > 5000) {
    console.log(`Price=${price.toFixed(2)} | AI SCORE=${score}`);
    lastLogTime = now;
  }

  if (score >= 65) await openPosition(price);
}

// ===== LOOP =====
async function tick() {
  try {
    const price = await getPrice();
    updatePricesAndCrash(price);
    if (position) await managePosition(price);
    else await maybeEnter(price);
  } catch (e) {
    console.error("LOOP ERROR:", e.message);
  }
}

// ===== KEEP-ALIVE & SERVER =====
setInterval(() => console.log("💓 KEEP-ALIVE"), 20000);

setInterval(() => {
  tick().catch(e => console.error("Fatal tick:", e.message));
}, CONFIG.loopMs);

const app = express();
app.get("/", (req, res) => res.send("Riply Binance bot running ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Health server on port ${PORT}`));

console.log("🚀 BOT STARTED — Stable Edition for Railway");
