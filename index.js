import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

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

// STATE
let prices = [];
let antiCrashUntil = 0;

let startingStake = null;
let stakeMultiplier = 1;
let position = null;

// Binance API
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
  return api(
    "POST",
    "/api/v3/order",
    { symbol: SYMBOL, side, type: "MARKET", quantity: qty.toFixed(6) },
    true
  );
}

// AI SCORE
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
  const momentum =
