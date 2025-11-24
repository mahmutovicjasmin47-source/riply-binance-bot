import Binance from "binance-api-node";

// -------------------------------
//   CONFIG
// -------------------------------
const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const LIVE = process.env.LIVE_TRADING === "true";

// Parovi za trgovanje
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// IZNOS INVESTICIJE PO TRADE-u (SADA 5 USDC)
const ORDER_SIZE = 5;

// Profit i gubitak
const TAKE_PROFIT = 0.004; 
const STOP_LOSS = -0.003;

// Cooldown između tradeova (7 min)
const COOLDOWN = 60000 * 7;

console.log("🤖 ULTIMATE BOT — FIXED VERSION");
console.log("LIVE MODE:", LIVE);
console.log("TRGUJE PAROVE:", PAIRS.join(", "));
console.log("---------------------------------------");

// -------------------------------
//   FUNKCIJE
// -------------------------------

// Uzimanje cijene
async function getPrice(symbol) {
  try {
    const r = await client.prices({ symbol });
    return parseFloat(r[symbol]);
  } catch (err) {
    console.log("❌ PRICE ERROR:", err.message);
    return null;
  }
}

// Provjera balansa (DODANO)
async function getUSDCBalance() {
  try {
    const acc = await client.accountInfo();
    const bal = acc.balances.find(b => b.asset === "USDC");
    return parseFloat(bal.free);
  } catch (err) {
    console.log("❌ BALANCE ERROR:", err.message);
    return 0;
  }
}

// Market BUY
async function buyMarket(symbol) {
  try {
    if (!LIVE) {
      console.log("🟡 TEST BUY:", symbol);
      return { executedQty: "0" };
    }

    // ➤ AUTO PROVJERA BALANSA
    const bal = await getUSDCBalance();
    if (bal < ORDER_SIZE) {
      console.log(`⛔ SKIP BUY — premalo USDC (${bal} USDC dostupno)`);
      return null;
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

// Market SELL
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

// Jedan trade ciklus
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

    if (diff >= TAKE_PROFIT) {
      await sellMarket(symbol, qty);
      console.log("💰 PROFIT CLOSED:", symbol);
      active = false;
    }

    if (diff <= STOP_LOSS) {
      await sellMarket(symbol, qty);
      console.log("🛑 STOP LOSS:", symbol);
      active = false;
    }
  }
}

// Glavna petlja
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
