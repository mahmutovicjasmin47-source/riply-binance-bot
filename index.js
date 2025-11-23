import Binance from "binance-api-node";

// 🔐 API ključevi iz Railway VARIABLI
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// 🔥 Live ili test mode
const LIVE = process.env.LIVE_TRADING === "true";

// Parovi koje bot trguje
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// Kupovina u USDC
const ORDER_SIZE = 10;

// Trailing stop distance
const TRAILING = 0.003;

// Minimalni profit prije sell
const MIN_PROFIT = 0.01;

console.log("🤖 BOT STARTED");
console.log("LIVE:", LIVE);
console.log("PAIRS:", PAIRS.join(", "));
console.log("----------------------------------");

async function getPrice(symbol) {
  try {
    const p = await client.prices({ symbol });
    return parseFloat(p[symbol]);
  } catch (e) {
    console.log("❌ PRICE ERROR:", e.message);
    return null;
  }
}

async function buy(symbol) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST BUY:", symbol);
      return { executedQty: "0.0001" };
    }

    const order = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: ORDER_SIZE.toString(),
    });

    console.log("🟢 BUY DONE:", symbol, order);
    return order;
  } catch (e) {
    console.log("❌ BUY ERROR:", e.body || e);
    return null;
  }
}

async function sell(symbol, qty) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST SELL:", symbol);
      return;
    }

    const order = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qty.toString(),
    });

    console.log("🔴 SELL DONE:", symbol, order);
  } catch (e) {
    console.log("❌ SELL ERROR:", e.body || e);
  }
}

async function trade(symbol) {
  const startPrice = await getPrice(symbol);
  if (!startPrice) return;

  console.log(`⏱️ START: ${symbol} ${startPrice}`);

  const order = await buy(symbol);
  if (!order) return;

  const qty = parseFloat(order.executedQty);
  let high = startPrice;
  let stop = high * (1 - TRAILING);

  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    const p = await getPrice(symbol);
    if (!p) continue;

    if (p > high) {
      high = p;
      stop = high * (1 - TRAILING);
    }

    if (p < stop && p > startPrice * (1 + MIN_PROFIT)) {
      await sell(symbol, qty);
      break;
    }
  }
}

async function loop() {
  while (true) {
    for (const symbol of PAIRS) {
      await trade(symbol);
    }
  }
}

loop();
