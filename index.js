import Binance from "binance-api-node";

// 🔐 API ključ
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// 🔥 Live trading ON/OFF
const LIVE = process.env.LIVE_TRADING === "true";

// Parovi koje bot koristi
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// Iznos kupovine u USDC
const ORDER_SIZE = 10;

// Trailing stop parametri
const TRAILING_DISTANCE = 0.003;  // 0.3%
const MIN_PROFIT = 0.01;          // 1%

console.log("🤖 ULTIMATE BOT POKRENUT");
console.log("Live trading:", LIVE);
console.log("Parovi:", PAIRS.join(", "));
console.log("-------------------------------------");

// ================================
// 📌 Cijena
// ================================
async function getPrice(symbol) {
  try {
    const p = await client.prices({ symbol });
    return parseFloat(p[symbol]);
  } catch (err) {
    console.log("❌ PRICE ERROR:", err.message);
    return null;
  }
}

// ================================
// 📌 MARKET BUY
// ================================
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

    console.log("🟢 BUY EXECUTED:", symbol, order);
    return order;

  } catch (err) {
    console.log("❌ BUY ERROR:", err.body || err);
    return null;
  }
}

// ================================
// 📌 MARKET SELL
// ================================
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

    console.log("🔴 SELL EXECUTED:", symbol, order);
    return order;

  } catch (err) {
    console.log("❌ SELL ERROR:", err.body || err);
  }
}

// ================================
// 📌 GLAVNI TRADE LOOP
// ================================
async function trade(symbol) {
  console.log(`⏱️ START: ${symbol}`);
  
  const price = await getPrice(symbol);
  if (!price) return;

  const buyOrder = await buy(symbol);
  if (!buyOrder) return;

  const qty = parseFloat(buyOrder.executedQty);
  let entry = price;
  let trailingStop = entry * (1 - TRAILING_DISTANCE);

  console.log(`📈 ENTRY ${symbol}: ${entry}`);

  let active = true;

  while (active) {
    await new Promise(r => setTimeout(r, 3000));
    const current = await getPrice(symbol);
    if (!current) continue;

    // Update trailing
    if (current > entry) {
      entry = current;
      trailingStop = entry * (1 - TRAILING_DISTANCE);
    }

    // Sell trigger
    if (current <= trailingStop && current > entry * (1 + MIN_PROFIT)) {
      await sell(symbol, qty);
      active = false;
    }
  }
}

// ================================
// ♾️ Infinite Loop
// ================================
async function loop() {
  while (true) {
    for (const symbol of PAIRS) {
      await trade(symbol);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

loop();
