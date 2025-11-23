import Binance from "binance-api-node";

// 🔐 Povezivanje API ključeva iz Railway VARS
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// 🔥 Live ili test mode
const LIVE = process.env.LIVE_TRADING === "true";

// Parovi za trgovanje
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// Iznos kupovine
const ORDER_SIZE = 10;

// Trailing stop
const TRAILING_DISTANCE = 0.003; // 0.3%

// Minimalni profit
const MIN_PROFIT = 0.01; // 1%

console.log("🤖 ULTIMATE BOT pokrenut...");
console.log("Live trading:", LIVE);
console.log("Parovi:", PAIRS.join(", "));
console.log("----------------------------------------");

// ✔ Dobavljanje cijene
async function getPrice(symbol) {
  try {
    const p = await client.prices({ symbol });
    return parseFloat(p[symbol]);
  } catch (err) {
    console.log("❌ PRICE ERROR:", err.message);
    return null;
  }
}

// ✔ MARKET BUY
async function buy(symbol) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST MODE BUY", symbol);
      return { executedQty: "0.0000" };
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

// ✔ MARKET SELL
async function sell(symbol, qty) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST MODE SELL", symbol);
      return null;
    }

    const order = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qty.toString(),
    });

    console.log("🔴 SELL EXECUTED", symbol, order);
    return order;
  } catch (err) {
    console.log("❌ SELL ERROR:", err.body || err);
    return null;
  }
}

// ✔ Glavna petlja
async function trade() {
  for (const symbol of PAIRS) {
    const startPrice = await getPrice(symbol);
    if (!startPrice) continue;

    console.log("⏱ START:", symbol, startPrice);

    const order = await buy(symbol);
    if (!order) continue;

    let qty = parseFloat(order.executedQty || "0");
    if (qty === 0) qty = ORDER_SIZE / startPrice; // fallback

    let entry = startPrice;
    let stop = entry * (1 - TRAILING_DISTANCE);

    let active = true;

    while (active) {
      await new Promise((r) => setTimeout(r, 3000));

      const p = await getPrice(symbol);
      if (!p) continue;

      if (p > entry) {
        entry = p;
        stop = entry * (1 - TRAILING_DISTANCE);
      }

      if (p <= stop && p > entry * (1 + MIN_PROFIT)) {
        await sell(symbol, qty);
        active = false;
      }
    }
  }
}

// ✔ Beskonačna petlja bota
(async function loop() {
  while (true) {
    await trade();
    await new Promise((r) => setTimeout(r, 2000));
  }
})();
