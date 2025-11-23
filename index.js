import Binance from "binance-api-node";

const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const LIVE = process.env.LIVE_TRADING === "true";

const PAIRS = ["BTCUSDC", "ETHUSDC"];

console.log("🤖 ULTIMATE BOT POKRENUT");
console.log("LIVE:", LIVE);
console.log("PAROVI:", PAIRS.join(", "));
console.log("----------------------------------------");

// ---- MINIMAL ORDER SIZE ----
async function getMinNotional(symbol) {
  const info = await client.exchangeInfo();
  const rule = info.symbols.find((s) => s.symbol === symbol);
  const filter = rule.filters.find((f) => f.filterType === "NOTIONAL");
  return parseFloat(filter.minNotional);
}

// ---- GET PRICE ----
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
async function buy(symbol, amount) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST MODE BUY:", symbol);
      return { executedQty: "0.0000" };
    }

    const order = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: amount.toString(),
    });

    console.log("🟢 BUY EXECUTED", symbol);
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
      console.log("🟡 TEST MODE SELL:", symbol);
      return null;
    }

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
    return null;
  }
}

// ---- MAIN LOOP ----
async function loop() {
  for (const symbol of PAIRS) {
    const price = await getPrice(symbol);
    if (!price) continue;

    console.log(`⏱ START: ${symbol} ${price}`);

    const min = await getMinNotional(symbol);
    const ORDER_SIZE = (min + 1).toFixed(2);

    console.log("✔ Minimalni order:", ORDER_SIZE, "USDC");

    const buyOrder = await buy(symbol, ORDER_SIZE);
    if (!buyOrder) continue;

    const qty = parseFloat(buyOrder.executedQty);
    if (qty === 0) {
      console.log("⚠ BUY qty = 0 (test mode ili error)");
      continue;
    }

    console.log("📌 KUPOVINA QTY:", qty);

    // odmah prodamo — čisto da vidimo da radi
    await sell(symbol, qty);
  }

  // loop na 15 sekundi
  setTimeout(loop, 15000);
}

loop();
