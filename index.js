import Binance from "binance-api-node";

// 🔐 API povezivanje
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// ⚙️ KONFIGURACIJA
const LIVE = process.env.LIVE_TRADING === "true";
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// 💰 Veličina kupovine
const ORDER_SIZE = 10;

// 📈 Opcija C — srednji rizik
const MIN_PROFIT = 0.004;          // 0.4% profit
const TRAILING_DISTANCE = 0.002;   // 0.2% trailing stop
const STOP_LOSS = 0.006;           // 0.6% maksimalni minus
const MAX_RETRIES = 3;

// ---------------------- UTIL FUNKCIJE ----------------------

async function getPrice(symbol) {
  try {
    const p = await client.prices({ symbol });
    return parseFloat(p[symbol]);
  } catch {
    return null;
  }
}

async function buy(symbol) {
  try {
    if (!LIVE) {
      console.log(`🟡 TEST BUY ${symbol}`);
      return { executedQty: "0.0000" };
    }

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
  try {
    if (!LIVE) {
      console.log(`🟡 TEST SELL ${symbol}`);
      return;
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
  }
}

// ---------------------- GLAVNI TRADE LOOP ----------------------

async function tradeSymbol(symbol) {
  console.log(`⏱ START: ${symbol}`);

  let retries = 0;
  let buyOrder = null;

  // 🟢 Pokušaj kupovine
  while (!buyOrder && retries < MAX_RETRIES) {
    buyOrder = await buy(symbol);
    if (!buyOrder) {
      retries++;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!buyOrder) {
    console.log(`⛔ ${symbol} — odustajem nakon ${MAX_RETRIES} pokušaja.`);
    return;
  }

  const qty = parseFloat(buyOrder.executedQty);
  let entryPrice = await getPrice(symbol);
  let highestPrice = entryPrice;

  console.log(`📌 ENTRY ${symbol}: ${entryPrice}`);

  let active = true;

  while (active) {
    await new Promise((r) => setTimeout(r, 3000));

    const price = await getPrice(symbol);
    if (!price) continue;

    // 🔼 Update highest price
    if (price > highestPrice) highestPrice = price;

    // 🟢 Profit target
    if (price >= entryPrice * (1 + MIN_PROFIT)) {
      console.log(`🏆 PROFIT HIT ${symbol}`);
      await sell(symbol, qty);
      active = false;
      break;
    }

    // 🔻 Trailing stop
    if (price <= highestPrice * (1 - TRAILING_DISTANCE)) {
      console.log(`🔻 TRAILING STOP ${symbol}`);
      await sell(symbol, qty);
      active = false;
      break;
    }

    // 🚨 Stop loss
    if (price <= entryPrice * (1 - STOP_LOSS)) {
      console.log(`⚠️ STOP LOSS ${symbol}`);
      await sell(symbol, qty);
      active = false;
      break;
    }
  }

  console.log(`🔄 ${symbol} — novi ciklus...`);
}

// ---------------------- GLOBAL LOOP ----------------------

async function startBot() {
  console.log("🤖 ULTIMATE BOT — OPCIJA C (Srednji rizik) pokrenut!");
  console.log("Parovi:", PAIRS.join(", "));
  console.log("Live:", LIVE);
  console.log("-------------------------------------");

  while (true) {
    for (const pair of PAIRS) {
      await tradeSymbol(pair);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

startBot();
