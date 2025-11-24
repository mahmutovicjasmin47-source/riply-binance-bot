import Binance from "binance-api-node";

// API konekcija
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// Konstante
const LIVE = process.env.LIVE_TRADING === "true";
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// Opcija C (srednji rizik)
const ORDER_SIZE = 15;                 // veći profit
const TRAILING = 0.004;                // 0.4% trailing stop
const MIN_PROFIT = 0.006;              // 0.6% minimalni profit
const CHECK_DELAY = 4000;              // 4 sekunde

// Status pozicije da spreči dupli BUY
const activeTrades = {
  BTCUSDC: null,
  ETHUSDC: null
};

// Cijena
async function getPrice(symbol) {
  try {
    const r = await client.prices({ symbol });
    return parseFloat(r[symbol]);
  } catch {
    return null;
  }
}

// BUY
async function buy(symbol) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST BUY:", symbol);
      return { executedQty: "0.001" };
    }

    const o = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: ORDER_SIZE.toString(),
    });

    console.log("🟢 BUY EXECUTED:", symbol);
    return o;
  } catch (err) {
    console.log("❌ BUY ERROR:", err?.body?.msg || err?.message);
    return null;
  }
}

// SELL
async function sell(symbol, qty) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST SELL:", symbol);
      return;
    }

    const o = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qty.toString(),
    });

    console.log("🔴 SELL EXECUTED:", symbol);
  } catch (err) {
    console.log("❌ SELL ERROR:", err?.body?.msg || err?.message);
  }
}

// GLAVNI TRADE
async function trade(symbol) {
  if (activeTrades[symbol]) return;   // Sprečava dupli BUY

  const price = await getPrice(symbol);
  if (!price) return;

  console.log(`⏱ START: ${symbol} ${price}`);

  const order = await buy(symbol);
  if (!order) return;

  const qty = parseFloat(order.executedQty);
  let entry = price;
  let trailingStop = entry * (1 - TRAILING);

  activeTrades[symbol] = { entry, qty };

  // LOOP TRAILING STOPA
  let run = true;

  while (run) {
    await new Promise(r => setTimeout(r, CHECK_DELAY));

    const p = await getPrice(symbol);
    if (!p) continue;

    // pomjera stop prema gore
    if (p > entry) {
      entry = p;
      trailingStop = entry * (1 - TRAILING);
    }

    // Uslov za zaštitu + profit
    if (p <= trailingStop && p > activeTrades[symbol].entry * (1 + MIN_PROFIT)) {
      await sell(symbol, qty);
      run = false;
      activeTrades[symbol] = null;
      console.log(`✔ PROFIT KOMPILIRAN: ${symbol}`);
    }
  }
}

// GLAVNA PETLJA — ALI BEZ LOOP BUY ERRORA
async function start() {
  console.log("🤖 ULTIMATE BOT — OPCIJA C (srednji rizik)");
  console.log("LIVE =", LIVE);
  console.log("PAROVI =", PAIRS.join(", "));
  console.log("----------------------------------------");

  while (true) {
    for (const pair of PAIRS) {
      try {
        if (!activeTrades[pair]) {
          await trade(pair);
        }
      } catch (err) {
        console.log("⚠ LOOP ERROR:", err.message);
      }
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}

start();
