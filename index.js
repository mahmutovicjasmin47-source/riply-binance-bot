import Binance from '@binance/connector';
import dotenv from 'dotenv';
dotenv.config();

const client = new Binance.Spot(
  process.env.BINANCE_API_KEY,
  process.env.BINANCE_API_SECRET
);

const PAIRS = ["BTCUSDC", "ETHUSDC"];
const CAPITAL_PERCENT = 0.70;  // 70%
const DAILY_TARGET = 0.01;     // 1%
const STOP_LOSS = -0.015;      // -1.5%
const TRAILING = 0.007;        // 0.7%

let entryPrices = {};
let highestPrices = {};
let invested = false;

// ----------------------------
// Helper: Get price
// ----------------------------
async function getPrice(symbol) {
  const ticker = await client.tickerPrice(symbol);
  return parseFloat(ticker.data.price);
}

// ----------------------------
// TRADE: BUY with 70% capital
// ----------------------------
async function buyAssets() {
  const acc = await client.account();
  const usdc = acc.data.balances.find(a => a.asset === "USDC");
  let balance = parseFloat(usdc.free);

  if (balance < 10) {
    console.log("⚠️ Nema dovoljno USDC za trgovinu.");
    return;
  }

  const perAsset = (balance * CAPITAL_PERCENT) / PAIRS.length;

  for (let pair of PAIRS) {
    const price = await getPrice(pair);
    const qty = (perAsset / price).toFixed(6);

    await client.newOrder(pair, "BUY", "MARKET", { quoteOrderQty: perAsset });

    entryPrices[pair] = price;
    highestPrices[pair] = price;

    console.log(`🟢 BUY ${pair} @ ${price} qty=${qty}`);
  }

  invested = true;
}

// ----------------------------
// TRADE: SELL logic
// ----------------------------
async function checkSell() {
  for (let pair of PAIRS) {
    const price = await getPrice(pair);

    // Update highest price for trailing TP
    if (price > highestPrices[pair]) {
      highestPrices[pair] = price;
    }

    const change = (price - entryPrices[pair]) / entryPrices[pair];

    // Take profit trailing
    if (change >= DAILY_TARGET ||
        price <= highestPrices[pair] * (1 - TRAILING)) {
      await client.newOrder(pair, "SELL", "MARKET");
      console.log(`🔵 SELL ${pair} @ ${price} (TAKE PROFIT)`);
      invested = false;
    }

    // Stop loss
    if (change <= STOP_LOSS) {
      await client.newOrder(pair, "SELL", "MARKET");
      console.log(`🔴 SELL ${pair} @ ${price} (STOP LOSS)`);
      invested = false;
    }
  }
}

// ----------------------------
// MAIN LOOP 24/7
// ----------------------------
async function loop() {
  try {
    if (!invested) {
      console.log("🤖 Stabilni bot (Opcija A) pokrenut...");
      await buyAssets();
    } else {
      await checkSell();
    }
  } catch (err) {
    console.log("⚠️ Greška u loop-u:", err.message);
  }

  // Loop svakih 5 sekundi (24/7)
  setTimeout(loop, 5000);
}

loop();
