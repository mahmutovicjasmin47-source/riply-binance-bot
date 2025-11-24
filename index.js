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
const PAIRS = ["BTCUSDC", "ETHUSDC", "SOLUSDC", "AVAXUSDC"];

// Profit parametri
const TAKE_PROFIT = 0.006;      // 0.6% profit
const SCALP_PROFIT = 0.002;     // 0.2% scalping
const STOP_LOSS = -0.003;       // sigurnosni SL
const COOLDOWN = 60000 * 3;     // 3 minute između trgovina

console.log("🔥 ULTIMATE SMART BOT — TREND VERSION");
console.log("LIVE MODE:", LIVE);
console.log("Parovi:", PAIRS.join(", "));
console.log("---------------------------------------");


// -------------------------------
//   BALANCE + PRICE
// -------------------------------

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

async function getPrice(symbol) {
  try {
    const r = await client.prices({ symbol });
    return parseFloat(r[symbol]);
  } catch {
    return null;
  }
}


// -------------------------------
//   TREND ANALIZA
// -------------------------------

async function trendStrength(symbol) {
  const p1 = await getPrice(symbol);
  await new Promise(r => setTimeout(r, 500));
  const p2 = await getPrice(symbol);

  if (!p1 || !p2) return -999;

  return (p2 - p1) / p1;
}

async function pickBestSymbol() {
  let best = null;
  let strength = -999;

  for (const pair of PAIRS) {
    const s = await trendStrength(pair);
    console.log(`📊 Trend ${pair}: ${s}`);

    if (s > strength) {
      best = pair;
      strength = s;
    }
  }

  console.log(`⚡ Najbolji par trenutno: ${best} (trend: ${strength})`);
  return best;
}


// -------------------------------
//   ORDER SIZE (2–3% kapitala)
// -------------------------------

async function getOrderSize() {
  const bal = await getUSDCBalance();
  const min = bal * 0.02;
  const max = bal * 0.03;

  const order = Math.max(10, Math.min(max, min * 2));
  return parseFloat(order.toFixed(2));
}


// -------------------------------
//   BUY + SELL
// -------------------------------

async function buyMarket(symbol) {
  try {
    const ORDER_SIZE = await getOrderSize();
    const bal = await getUSDCBalance();
    if (bal < ORDER_SIZE) {
      console.log("⛔ Premalo balansa!");
      return null;
    }

    const order = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: ORDER_SIZE.toString(),
    });

    console.log(`🟢 BUY EXECUTED: ${symbol} (${ORDER_SIZE} USDC)`);
    return order;
  } catch (err) {
    console.log("❌ BUY ERROR:", err.body?.msg || err.message);
    return null;
  }
}

async function sellMarket(symbol, qty) {
  try {
    const order = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qty.toString(),
    });

    console.log(`🔴 SELL EXECUTED: ${symbol}`);
    return order;
  } catch (err) {
    console.log("❌ SELL ERROR:", err.body?.msg || err.message);
    return null;
  }
}


// -------------------------------
//   TRADE CIKLUS
// -------------------------------

async function tradeSymbol(symbol) {
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

    if (diff >= SCALP_PROFIT) {
      await sellMarket(symbol, qty);
      console.log("⚡ SCALP PROFIT:", symbol);
      active = false;
    }

    if (diff <= STOP_LOSS) {
      await sellMarket(symbol, qty);
      console.log("🛑 STOP LOSS:", symbol);
      active = false;
    }
  }
}


// -------------------------------
//   MAIN LOOP
// -------------------------------

async function startBot() {
  while (true) {
    const symbol = await pickBestSymbol();
    await tradeSymbol(symbol);

    console.log(`😴 COOLDOWN ${COOLDOWN/60000} min...`);
    await new Promise(r => setTimeout(r, COOLDOWN));
  }
}

startBot();
