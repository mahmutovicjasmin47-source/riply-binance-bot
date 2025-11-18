// BTCUSDC AGGRESSIVE SMART-AI SCALPER V7
// ULTRA INTELLIGENT + ULTRA SAFE MODE
// Kombinacija svih tvojih parametara + AI safety scoring sistema

require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");

// --------------------------------------------------------
// KONFIG
// --------------------------------------------------------
const SYMBOL = "BTCUSDC";
const BASE_ASSET = "BTC";
const QUOTE_ASSET = "USDC";

const CONFIG = {
  stakePct: 0.70,               
  stakeIncrement: 0.10,          
  maxStakeMultiplier: 3.5,       
  baseSL: -0.018,                
  maxSL: -0.03,                  
  tpTriggerPct: 0.0020,          
  tpTrail: 0.0016,               
  trendWindow: 24,               
  minVolatility: 0.0009,         
  maxFlatRange: 0.0012,          
  antiCrashPct: -0.028,          
  crashWindowMs: 60000,          
  crashPauseMs: 240000,          
  loopMs: 700,                   
  minOrder: 5                    
};

// --------------------------------------------------------
// STATE
// --------------------------------------------------------
let prices = [];
let antiCrashUntil = 0;

let startingStake = null;
let stakeMultiplier = 1;
let position = null;

// --------------------------------------------------------
// Binance helper funkcije
// --------------------------------------------------------
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

const API_KEY = process.env.BINANCE_KEY;
const API_SECRET = process.env.BINANCE_SECRET;
const BASE_URL = "https://api.binance.com";

// --------------------------------------------------------
// PRICE FETCH
// --------------------------------------------------------
async function getPrice() {
  const r = await api("GET", "/api/v3/ticker/price", { symbol: SYMBOL });
  return parseFloat(r.price);
}

// --------------------------------------------------------
// BALANCE & ORDERS
// --------------------------------------------------------
async function getBalance(asset) {
  const acc = await api("GET", "/api/v3/account", {}, true);
  const b = acc.balances.find((x) => x.asset === asset);
  return b ? parseFloat(b.free) : 0;
}

async function order(side, qty) {
  return api(
    "POST",
    "/api/v3/order",
    { symbol: SYMBOL, side, type: "MARKET", quantity: qty.toFixed(6) },
    true
  );
}

// --------------------------------------------------------
// AI TREND SCORE SYSTEM (0–100)
// --------------------------------------------------------
function computeAIScore() {
  if (prices.length < CONFIG.trendWindow) return 0;

  const first = prices[0];
  const last = prices[prices.length - 1];
  const trend = (last - first) / first;

  let score = 0;

  if (trend > 0.0015) score += 20;
  if (trend > 0.003) score += 10;
  if (trend < -0.0015) score -= 20;

  const half = Math.floor(prices.length / 2);
  const early = prices[half];
  const momentum = (last - early) / early;

  if (momentum > 0.0015) score += 20;
  if (momentum < -0.0015) score -= 20;

  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const volatility = (maxP - minP) / last;

  if (volatility > 0.0025) score += 15;
  if (volatility < CONFIG.minVolatility) score -= 15;

  const range = Math.abs(last - first) / first;
  if (range < CONFIG.maxFlatRange) score -= 20;

  if (momentum > 0.004) score += 25;
  if (momentum < -0.004) score -= 25;

  return Math.max(0, Math.min(100, score));
}

// --------------------------------------------------------
// ANTI-CRASH
// --------------------------------------------------------
function updateCrash(price) {
  prices.push(price);
  if (prices.length > CONFIG.trendWindow) prices.shift();

  const first = prices[0];
  const crashChange = (price - first) / first;

  if (crashChange <= CONFIG.antiCrashPct) {
    antiCrashUntil = Date.now() + CONFIG.crashPauseMs;
    console.log("⚠️ CRASH DETECTED – STOP TRADING TEMPORARILY");
  }
}

// --------------------------------------------------------
// STAKE
// --------------------------------------------------------
async function getStake(price) {
  const usdc = await getBalance(QUOTE_ASSET);

  if (startingStake == null) startingStake = usdc * CONFIG.stakePct;

  let stake = startingStake * stakeMultiplier;
  stake = Math.min(stake, usdc * CONFIG.stakePct);
  if (stake < CONFIG.minOrder) return 0;

  return stake / price;
}

function updateStake(pnl) {
  if (pnl > 0) stakeMultiplier = Math.min(CONFIG.maxStakeMultiplier, stakeMultiplier * (1 + CONFIG.stakeIncrement));
  else stakeMultiplier = 1;
}

// --------------------------------------------------------
// POSITION
// --------------------------------------------------------
async function openPosition(price) {
  if (Date.now() < antiCrashUntil) return;

  const qty = await getStake(price);
  if (qty <= 0) return;

  try {
    await order("BUY", qty);
    position = {
      entry: price,
      qty,
      peak: price,
      stop: price * (1 + CONFIG.baseSL),
      trailing: false,
    };
    console.log("BUY @", price);
  } catch (e) {
    console.log("BUY ERROR", e.response?.data);
  }
}

async function closePosition(price, reason) {
  try {
    await order("SELL", position.qty);
    const pnl = (price - position.entry) / position.entry;
    console.log(`SELL @ ${price} | ${reason} | PnL ${(pnl * 100).toFixed(3)}%`);
    updateStake(pnl);
    position = null;
  } catch (e) {
    console.log("SELL ERROR", e.response?.data);
  }
}

// --------------------------------------------------------
// MANAGE ACTIVE POSITION
// --------------------------------------------------------
async function managePosition(price) {
  if (!position) return;

  if (price > position.peak) position.peak = price;

  const fromEntry = (price - position.entry) / position.entry;

  if (!position.trailing && fromEntry >= CONFIG.tpTriggerPct) {
    position.trailing = true;
    position.peak = price;
    console.log("🎯 TRAILING ACTIVATED");
  }

  if (position.trailing) {
    const drop = (position.peak - price) / position.peak;
    if (drop >= CONFIG.tpTrail)
      return closePosition(price, "TRAIL_TP");
  }

  if (price <= position.stop)
    return closePosition(price, "STOP_LOSS");
}

// --------------------------------------------------------
// AI ENTRY LOGIKA
// --------------------------------------------------------
async function maybeEnter(price) {
  if (position) return;
  if (Date.now() < antiCrashUntil) return;

  const score = computeAIScore();

  if (score >= 65) return openPosition(price);
}

// --------------------------------------------------------
// MAIN LOOP
// --------------------------------------------------------
async function loop() {
  try {
    const price = await getPrice();
    updateCrash(price);

    if (position) await managePosition(price);
    else await maybeEnter(price);

    console.log(
      `Price: ${price} | AI SCORE: ${computeAIScore()} | ${position ? "IN TRADE" : "FLAT"}`
    );

  } catch (e) {
    console.log("LOOP ERROR:", e.message);
  }
}

console.log("🚀 START — AI SCALPER V7 (ULTRA MODE)");
setInterval(loop, CONFIG.loopMs);
