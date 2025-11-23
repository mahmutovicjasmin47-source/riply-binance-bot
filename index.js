import Binance from "node-binance-api";

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;

const ASSETS = process.env.ASSETS
  ? process.env.ASSETS.split(",").map(a => a.trim())
  : ["BTCUSDC", "ETHUSDC"];

const LIVE = process.env.LIVE_TRADING === "true"; 
const DAILY_TARGET = process.env.DAILY_TARGET ? Number(process.env.DAILY_TARGET) : 1.0; // 1%

// Trailing TP parametri
const TRAILING_PERCENT = 0.4;  // 0.4% trailing
const STOP_LOSS_PERCENT = 0.7; // 0.7% anti-loss

const binance = new Binance().options({
  APIKEY: apiKey,
  APISECRET: apiSecret
});

console.log("🤖 ULTIMATE BOT pokrenut (Opcija C)...");
console.log("Live trading:", LIVE);
console.log("Trading parovi:", ASSETS.join(", "));

// Čuva pozicije
let positions = {};

async function getPrice(symbol) {
  try {
    const data = await binance.prices(symbol);
    return Number(data[symbol]);
  } catch (err) {
    console.log("❌ Price fetch error:", err.message);
    return null;
  }
}

async function placeBuy(symbol, amountUSDC) {
  if (!LIVE) return console.log(`🟡 TEST MODE BUY ${symbol}`);

  try {
    return await binance.marketBuy(symbol, amountUSDC);
  } catch (err) {
    console.log("❌ BUY error:", err.body || err.message);
    return null;
  }
}

async function placeSell(symbol, quantity) {
  if (!LIVE) return console.log(`🟡 TEST MODE SELL ${symbol}`);

  try {
    return await binance.marketSell(symbol, quantity);
  } catch (err) {
    console.log("❌ SELL error:", err.body || err.message);
    return null;
  }
}

async function trade(symbol) {
  const price = await getPrice(symbol);
  if (!price) return;

  console.log(`⏱  ${symbol}: ${price}`);

  // Ako nema otvorene pozicije → kupi
  if (!positions[symbol]) {
    const quantity = 10 / price; // 10 USDC po assetu, možeš povećati
    const buy = await placeBuy(symbol, quantity);

    if (buy) {
      positions[symbol] = {
        entry: price,
        highest: price
      };
      console.log(`🟢 Kupljeno ${symbol} @ ${price}`);
    }
    return;
  }

  // Ako postoji otvorena pozicija
  let pos = positions[symbol];

  // update highest price
  if (price > pos.highest) pos.highest = price;

  // trailing TP
  const drop = ((pos.highest - price) / pos.highest) * 100;
  if (drop >= TRAILING_PERCENT) {
    console.log(`💰 Trailing TP SELL ${symbol}`);
    await placeSell(symbol, 1); // 1 = full pozicija (spot auto računa)
    positions[symbol] = null;
    return;
  }

  // stop-loss
  const loss = ((pos.entry - price) / pos.entry) * 100;
  if (loss >= STOP_LOSS_PERCENT) {
    console.log(`🛑 Anti-loss SELL ${symbol}`);
    await placeSell(symbol, 1);
    positions[symbol] = null;
    return;
  }
}

async function loop() {
  for (const symbol of ASSETS) {
    await trade(symbol);
  }
}

setInterval(loop, 6000); // 6 sekundi
