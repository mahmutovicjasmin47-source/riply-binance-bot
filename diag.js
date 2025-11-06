// === ENV LOADING & VALIDATION ===
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_SECRET_KEY;

const LIVE_TRADING = (process.env.LIVE_TRADING || "false").toString().toLowerCase() === "true";
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const POSITION_SIZE_USDT = Number(process.env.POSITION_SIZE_USDT || "10");
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || "0.4");
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || "0.6");

const Binance = require('node-binance-api');
const binance = new Binance().options({
  APIKEY: API_KEY,
  APISECRET: API_SECRET
});

// Mali test da vidimo jesu li ključevi učitani
const mask = (s) => (s ? s.slice(0,4) + "****" + s.slice(-4) : "NEMA");
console.log("[ENV] API KEY:", mask(API_KEY));
console.log("[ENV] SYMBOL:", SYMBOL, "| LIVE_TRADING:", LIVE_TRADING);

if (!API_KEY || !API_SECRET) {
  console.error("\n❌ ENV problem: API ključevi nisu učitani!");
  console.error("Provjeri nazive varijabli na Railway-u:");
  console.error("BINANCE_API_KEY  i  BINANCE_SECRET_KEY\n");
  process.exit(1);
}

// === TRADING LOGIKA ===
async function trade() {
  try {
    const price = await binance.prices(SYMBOL);
    const currentPrice = Number(price[SYMBOL]);

    console.log(`\n${SYMBOL} = ${currentPrice}`);

    const stopLoss = currentPrice * (1 - STOP_LOSS_PCT / 100);
    const takeProfit = currentPrice * (1 + TAKE_PROFIT_PCT / 100);

    console.log(`SL: ${stopLoss.toFixed(2)} | TP: ${takeProfit.toFixed(2)}`);

    if (!LIVE_TRADING) {
      console.log("🔍 Simulacija aktivna (LIVE_TRADING=false) — bez naloga.");
      return;
    }

    // MARKER: OVDJE IDE NALOG
    console.log("✅ Slanje BUY naloga...");
    await binance.marketBuy(SYMBOL, POSITION_SIZE_USDT / currentPrice);
    console.log("✅ BUY izvršen!");

  } catch (err) {
    console.error("Greška:", err.message);
  }
}

// pokrećemo svakih 30 sekundi
console.log("🚀 Bot pokrenut...");
trade();
setInterval(trade, 30000);
