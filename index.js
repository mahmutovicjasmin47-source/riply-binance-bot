import Binance from "binance-api-node";

// 🔐 API ključevi iz Railway varijabli
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// 🔥 Live mode
const LIVE = process.env.LIVE_TRADING === "true";

// Parovi
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// Iznos kupovine
const ORDER_SIZE = 10;

// Trailing stop distance (0.3%)
const TRAILING_DISTANCE = 0.003;

// Minimalni profit (1%)
const MIN_PROFIT = 0.01;

console.log("🤖 ULTIMATE BOT pokrenut (Opcija C)");
console.log("Live:", LIVE);
console.log("Parovi:", PAIRS.join(", "));
console.log("----------------------------------------");

// 📌 Dohvati cijenu
async function getPrice(symbol) {
  try {
    const r = await client.prices({ symbol });
    return parseFloat(r[symbol]);
  } catch (err) {
    console.log("❌ PRICE ERROR:", err.message);
    return null;
  }
}

// 📌 BUY MARKET
async function buy(symbol) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST BUY:", symbol);
      return { executedQty: "0.003" };
    }

    const order = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: ORDER_SIZE.toString(),
    });

    console.log("🟢 BUY EXECUTED:", symbol, order);
    return order;
  } catch (err) {
    console.log("❌ BUY ERROR:", err.body || err);
    return null;
  }
}

// 📌 SELL MARKET
async function sell(symbol, quantity) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST SELL:", symbol);
      return;
    }

    const order = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: quantity.toString(),
    });

    console.log("🔴 SELL EXECUTED:", symbol, order);
  } catch (err) {
    console.log("❌ SELL ERROR:", err.body || err);
  }
}

// 📌 Glavni trading loop
async function trade(symbol) {
  const entryPrice = await getPrice(symbol);
  if (!entryPrice) return;

  console.log("⏱️ START:", symbol, entryPrice);

  const buyOrder = await buy(symbol);
  if (!buyOrder) return;

  const qty = parseFloat(buyOrder.executedQty);

  let highPrice = entryPrice;
  let trailingStop = highPrice * (1 - TRAILING_DISTANCE);

  // ✔️ Loop prati tržište
  while (true) {
    await new Promise((r) => setTimeout(r, 4000));
    const p = await getPrice(symbol);
    if (!p) continue;

    // Update high price
    if (p > highPrice) {
      highPrice = p;
      trailingStop = highPrice * (1 - TRAILING_DISTANCE);
    }

    // Trailing stop triggered
    if (p <= trailingStop && p > entryPrice * (1 + MIN_PROFIT)) {
      console.log("📉 TRAILING STOP HIT -> SELL", symbol);
      await sell(symbol, qty);
      return;
    }
  }
}

// 📌 Bot radi non-stop
async function loop() {
  while (true) {
    for (const pair of PAIRS) {
      await trade(pair);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

loop();
