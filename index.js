import Binance from "binance-api-node";

const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// Live ili test mode
const LIVE = process.env.LIVE_TRADING === "true";

// Parovi
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// Iznos kupovine
const ORDER_SIZE = 10;

// Trailing stop
const TRAILING_DISTANCE = 0.003;
const MIN_PROFIT = 0.01;

console.log("🤖 BOT POKRENUT...");
console.log("Live trading:", LIVE);
console.log("Parovi:", PAIRS.join(", "));

// ---- PRICE ----
async function getPrice(symbol) {
  try {
    const r = await client.prices({ symbol });
    return parseFloat(r[symbol]);
  } catch (err) {
    console.log("❌ PRICE ERROR:", err.message);
    return null;
  }
}

// ---- BUY ----
async function buy(symbol) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST BUY", symbol);
      return { executedQty: "0.0001" };
    }

    const order = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: ORDER_SIZE.toString(),
    });

    console.log("🟢 BUY EXECUTED", symbol, order);
    return order;
  } catch (err) {
    console.log("❌ BUY ERROR:", err.body || err);
    return null;
  }
}

// ---- SELL ----
async function sell(symbol, qty) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST SELL", symbol);
      return null;
    }

    const o = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qty.toString(),
    });

    console.log("🔴 SELL EXECUTED", symbol, o);
    return o;
  } catch (err) {
    console.log("❌ SELL ERROR:", err.body || err);
    return null;
  }
}

// ---- TRADE ----
async function trade(symbol) {
  const price = await getPrice(symbol);
  if (!price) return;

  console.log("⏱️ START:", symbol, price);

  const buyOrder = await buy(symbol);
  if (!buyOrder) return;

  const qty = parseFloat(buyOrder.executedQty);
  let entry = price;
  let trailingStop = entry * (1 - TRAILING_DISTANCE);

  let active = true;
  while (active) {
    await new Promise((r) => setTimeout(r, 3000));

    const p = await getPrice(symbol);
    if (!p) continue;

    if (p > entry) {
      entry = p;
      trailingStop = entry * (1 - TRAILING_DISTANCE);
    }

    if (p <= trailingStop && p > entry * (1 + MIN_PROFIT)) {
      await sell(symbol, qty);
      active = false;
    }
  }
}

// 🌙 INFINITE LOOP – radi NON STOP
async function loop() {
  while (true) {
    for (const pair of PAIRS) {
      await trade(pair);
    }
  }
}

loop();
