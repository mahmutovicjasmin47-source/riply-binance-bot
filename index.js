import Binance from "binance-api-node";

// -------------------------------
//   CONFIG
// -------------------------------
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const LIVE = process.env.LIVE_TRADING === "true";

const PAIRS = ["BTCUSDC", "ETHUSDC"];

const ORDER_SIZE = 20;      // ✔ postavio si 20 USDC
const TAKE_PROFIT = 0.004;  // ✔ 0.4% profit
const STOP_LOSS = -0.003;   // ✔ -0.3% max gubitak
const COOLDOWN = 60000 * 7; // ✔ jedna trgovina svakih ~7 minuta (štedi USDC)
                           //   (možeš povećati ako želiš)

console.log("🤖 ULTIMATE BOT — OPCIJA 1");
console.log("LIVE MODE:", LIVE);
console.log("TRGUJE PAROVE:", PAIRS.join(", "));
console.log("---------------------------------------");

async function getPrice(symbol) {
  try {
    const r = await client.prices({ symbol });
    return parseFloat(r[symbol]);
  } catch (err) {
    console.log("❌ PRICE ERROR:", err.message);
    return null;
  }
}

async function buyMarket(symbol) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST BUY:", symbol);
      return { executedQty: "0" };
    }

    const order = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: ORDER_SIZE.toString(),
    });

    console.log("🟢 BUY EXECUTED:", symbol);
    return order;
  } catch (err) {
    console.log("❌ BUY ERROR:", err.body?.msg || err.message);
    return null;
  }
}

async function sellMarket(symbol, qty) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST SELL:", symbol);
      return null;
    }

    const order = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qty.toString(),
    });

    console.log("🔴 SELL EXECUTED:", symbol);
    return order;
  } catch (err) {
    console.log("❌ SELL ERROR:", err.body?.msg || err.message);
    return null;
  }
}

async function tradeSymbol(symbol) {
  console.log(`⏱ START: ${symbol}`);

  const price = await getPrice(symbol);
  if (!price) return;

  const buyOrder = await buyMarket(symbol);
  if (!buyOrder || !buyOrder.executedQty) return;

  const qty = parseFloat(buyOrder.executedQty);
  const entry = price;

  console.log(`📌 ENTRY ${symbol}: ${entry}`);

  let active = true;

  while (active) {
    await new Promise(r => setTimeout(r, 3000));

    const p = await getPrice(symbol);
    if (!p) continue;

    const diff = (p - entry) / entry;

    // TAKE PROFIT
    if (diff >= TAKE_PROFIT) {
      await sellMarket(symbol, qty);
      console.log("💰 PROFIT CLOSED:", symbol);
      active = false;
    }

    // STOP LOSS
    if (diff <= STOP_LOSS) {
      await sellMarket(symbol, qty);
      console.log("🛑 STOP LOSS:", symbol);
      active = false;
    }
  }
}

async function startBot() {
  while (true) {
    for (const pair of PAIRS) {
      await tradeSymbol(pair);
      console.log(`😴 COOLDOWN ${COOLDOWN / 60000} min...`);
      await new Promise(r => setTimeout(r, COOLDOWN));
    }
  }
}

startBot();
