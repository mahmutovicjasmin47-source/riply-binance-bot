import Binance from "binance-api-node";

const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// 🔥 Live trading (obavezno postavi LIVE_TRADING=true u Railway)
const LIVE = process.env.LIVE_TRADING === "true";

// ☑ Parovi
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// ☑ Iznos kupovine (USDC)
const ORDER_SIZE = 10;

// ☑ Trailing stop (0.3%)
const TRAILING = 0.003;

// ☑ Minimalni profit da omogući SELL
const MIN_PROFIT = 0.01;

console.log("🤖 ULTIMATE BOT – OPCIJA A (stalno)");
console.log("LIVE:", LIVE);
console.log("PAROVI:", PAIRS.join(", "));
console.log("-------------------------------------");

async function getPrice(symbol) {
  try {
    const r = await client.prices({ symbol });
    return parseFloat(r[symbol]);
  } catch {
    return null;
  }
}

async function buy(symbol) {
  if (!LIVE) {
    console.log("🟡 TEST BUY:", symbol);
    return { executedQty: "0.0001" };
  }

  try {
    const order = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: ORDER_SIZE.toString(),
    });

    console.log("🟢 BUY EXECUTED", symbol);
    return order;
  } catch (err) {
    console.log("❌ BUY ERROR:", err.body || err);
    return null;
  }
}

async function sell(symbol, qty) {
  if (!LIVE) {
    console.log("🟡 TEST SELL:", symbol);
    return;
  }

  try {
    const order = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qty.toString(),
    });

    console.log("🔴 SELL EXECUTED", symbol);
    return order;
  } catch (err) {
    console.log("❌ SELL ERROR:", err.body || err);
  }
}

async function trade(symbol) {
  console.log("⏱️ START:", symbol);

  const entryPrice = await getPrice(symbol);
  if (!entryPrice) return;

  const buyOrder = await buy(symbol);
  if (!buyOrder) return;

  const qty = parseFloat(buyOrder.executedQty);
  let highest = entryPrice;
  let trailingStop = highest * (1 - TRAILING);

  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    const price = await getPrice(symbol);
    if (!price) continue;

    if (price > highest) {
      highest = price;
      trailingStop = highest * (1 - TRAILING);
    }

    if (price <= trailingStop && price > entryPrice * (1 + MIN_PROFIT)) {
      await sell(symbol, qty);
      console.log("💰 PROFIT SELL:", symbol);
      return;
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
