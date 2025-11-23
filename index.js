import Binance from "binance-api-node";

// Klijent
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// 🔥 Live ili test mode
const LIVE = process.env.LIVE_TRADING === "true";

// Parovi koje trgujemo
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// Koliko kupujemo (u USDC)
const ORDER_SIZE = 10;

// Trailing – koliko čekamo i koliko diže stop
const TRAILING_DISTANCE = 0.003;

// Anti-loss minimalni profit
const MIN_PROFIT = 0.01;

console.log("🤖 ULTIMATE BOT pokrenut...");
console.log("Live trading:", LIVE);
console.log("Parovi:", PAIRS.join(", "));
console.log("----------------------------------------");

async function getPrice(symbol) {
  try {
    const r = await client.prices({ symbol });
    return parseFloat(r[symbol]);
  } catch (err) {
    console.log("❌ PRICE ERROR:", err.message);
    return null;
  }
}

async function buy(symbol) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST MODE BUY", symbol);
      return null;
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

async function sell(symbol, quantity) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST MODE SELL", symbol);
      return null;
    }

    const order = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: quantity.toString(),
    });

    console.log("🔴 SELL EXECUTED", symbol, order);
    return order;
  } catch (err) {
    console.log("❌ SELL ERROR:", err.body || err);
    return null;
  }
}

async function tradeLoop() {
  for (const symbol of PAIRS) {
    const price = await getPrice(symbol);
    if (!price) continue;

    console.log("⏱️", symbol, price);

    // BUY ORDER
    const buyOrder = await buy(symbol);
    if (!buyOrder) continue;

    const qty = parseFloat(buyOrder.executedQty);
    let entry = price;
    let trailingStop = entry * (1 - TRAILING_DISTANCE);

    // Trailing loop
    let active = true;
    while (active) {
      await new Promise((r) => setTimeout(r, 3000));
      const p = await getPrice(symbol);
      if (!p) continue;

      // Update trailing
      if (p > entry) {
        entry = p;
        trailingStop = entry * (1 - TRAILING_DISTANCE);
      }

      // Hit stop
      if (p <= trailingStop && p > entry * (1 + MIN_PROFIT)) {
        await sell(symbol, qty);
        active = false;
      }
    }
  }

  setTimeout(tradeLoop, 5000);
}

tradeLoop();
