require('dotenv').config();
const Binance = require('binance-api-node').default;

const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const SYMBOL = process.env.SYMBOL || 'BTCUSDC';
const TAKE_PROFIT = parseFloat(process.env.TAKE_PROFIT_PCT) || 0.9;
const STOP_LOSS = parseFloat(process.env.STOP_LOSS_PCT) || 0.4;
const LIVE = process.env.LIVE_TRADING === "true";

console.log("[ENV] SYMBOL:", SYMBOL);
console.log("[ENV] LIVE_TRADING:", LIVE);
console.log("[BOT] Pokrećem...");

async function heartbeat() {
  try {
    const ticker = await client.prices({ symbol: SYMBOL });
    console.log(`[Heartbeat] ${SYMBOL}: ${ticker[SYMBOL]}`);
  } catch (err) {
    console.error("[Heartbeat Error]:", err.message);
  }
}

setInterval(heartbeat, 3000);
