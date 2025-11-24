import Binance from "binance-api-node";

// 🔐 API
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// 🔥 Live mode
const LIVE = process.env.LIVE_TRADING === "true";

// Parovi
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// Iznos za kupovinu
const ORDER_SIZE = 10;

// Koliko često bot loop-a
const LOOP_TIME = 5000;

console.log("🤖 ULTIMATE BOT — OPCIJA A (stalno)");
console.log("PAIRS:", PAIRS.join(", "));
console.log("LIVE:", LIVE);
console.log("----------------------------------------");

// Cijena
async function getPrice(symbol) {
  try {
    const r = await client.prices({ symbol });
    return parseFloat(r[symbol]);
  } catch (e) {
    console.log("❌ PRICE ERROR:", e.message);
    return null;
  }
}

// BUY
async function buy(symbol) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST BUY", symbol);
      return { executedQty: "0.00000" };
    }

    const order = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: ORDER_SIZE.toString(),
    });

    console.log("🟢 BUY EXECUTED", symbol);
    return order;

  } catch (e) {
    console.log("❌ BUY ERROR:", e.body || e.message);
    return null;
  }
}

// Glavna petlja — OPCIJA A (stalno)
async function loop() {
  for (const symbol of PAIRS) {
    console.log("⏱️ START:", symbol);

    const price = await getPrice(symbol);
    if (!price) continue;

    const order = await buy(symbol);
    if (!order) continue;
  }

  setTimeout(loop, LOOP_TIME);
}

// Start
loop();
