import Binance from "binance-api-node";

// 🔐 Povezivanje API ključeva
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// 🔥 Live ili test mode
const LIVE = process.env.LIVE_TRADING === "true";

// Parovi koje bot trguje
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// Koliko kupujemo u USDC
const ORDER_SIZE = 10;

// Trailing stop distance
const TRAILING_DISTANCE = 0.003; // 0.3%

// Minimalni profit za SELL
const MIN_PROFIT = 0.01; // 1%

console.log("🤖 ULTIMATE BOT pokrenut...");
console.log("Live trading:", LIVE);
console.log("Parovi:", PAIRS.join(", "));
console.log("----------------------------------------");

// 📌 Cijena
async function getPrice(symbol) {
  try {
    const p = await client.prices({ symbol });
    return parseFloat(p[symbol]);
  } catch (err) {
    console.log("❌ PRICE ERROR:", err.message);
    return null;
  }
}

// 📌 MARKET BUY
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

// 📌 MARKET SELL
async function sell(symbol, qty) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST MODE SELL", symbol);
      return;
    }

    const order = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qty.toString(),
    });

    console.log("🔴 SELL EXECUTED", symbol, order);
  } catch (err) {
    console.log("❌ SELL ERROR:", err.body || err);
  }
}

// 📌 GLAVNI LOOP — radi 24/7
async function tradeLoop() {
  for (const symbol of PAIRS) {
    const price = await getPrice(symbol);
    if (!price) continue;

    console.log("⏱️ Cijena:", symbol, price);

    const buyOrder = await buy(symbol);
    if (!buyOrder || !buyOrder.executedQty) continue;

    const qty = parseFloat(buyOrder.executedQty);
    let entry = price;
    let trailingStop = entry * (1 - TRAILING_DISTANCE);

    console.log(`▶️ Trailing start ${symbol}: entry ${entry}, stop ${trailingStop}`);

    let active = true;

    while (active) {
      await new Promise((r) => setTimeout(r, 3000));

      const p = await getPrice(symbol);
      if (!p) continue;

      // Ako cijena raste → trailing raste
      if (p > entry) {
        entry = p;
        trailingStop = entry * (1 - TRAILING_DISTANCE);
      }

      // Ako padne ispod trailing stopa → SELL
      if (p <= trailingStop && p > entry * (1 + MIN_PROFIT)) {
        console.log("🔻 Trailing stop aktiviran!", symbol);
        await sell(symbol, qty);
        active = false;
      }
    }
  }
}

setInterval(tradeLoop, 8000);
