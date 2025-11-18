import Binance from "binance-api-node";

const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET
});

// ================== KONFIG ==================
const PAIR = process.env.SYMBOL || "BTCUSDC";

const CAPITAL_PERCENT = 0.60;
const AUTO_INCREASE = 0.10;
const MAX_MULTIPLIER = 3;

const TRAIL_START = 0.003;
const TRAIL_DISTANCE = 0.0025;

const STOP_LOSS = -0.01;

const CRASH_DROP = -0.02;
const CRASH_WINDOW_MS = 60000;
const CRASH_PAUSE_MIN = 5;

const INTERVAL_MS = 1000;
const MIN_POSITION_USDC = 25;

// ================== STATE ==================
let stakeMultiplier = 1;
let trailingHigh = null;
let pauseUntil = 0;
let priceHistory = [];

// ================== UTILS ==================
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getBalanceUSDC() {
  const acc = await client.accountInfo();
  const usdc = acc.balances.find(b => b.asset === "USDC");
  return usdc ? parseFloat(usdc.free) : 0;
}

async function getPrice() {
  const t = await client.prices({ symbol: PAIR });
  return parseFloat(t[PAIR]);
}

async function getPosition() {
  const trades = await client.myTrades({ symbol: PAIR });

  if (!trades.length) return null;

  const buys = trades.filter(t => t.isBuyer);
  const sells = trades.filter(t => !t.isBuyer);

  const buyAmount = buys.reduce((a, t) => a + parseFloat(t.qty), 0);
  const sellAmount = sells.reduce((a, t) => a + parseFloat(t.qty), 0);

  const qty = buyAmount - sellAmount;

  if (qty <= 0) return null;

  const totalBuyCost = buys.reduce(
    (a, t) => a + parseFloat(t.qty) * parseFloat(t.price),
    0
  );

  return {
    qty,
    avgPrice: totalBuyCost / buyAmount
  };
}

function updateCrashGuard(price) {
  const now = Date.now();
  priceHistory.push({ time: now, price });

  priceHistory = priceHistory.filter(p => now - p.time <= CRASH_WINDOW_MS);

  if (priceHistory.length < 2) return;

  const first = priceHistory[0];
  const change = (price - first.price) / first.price;

  if (change <= CRASH_DROP) {
    pauseUntil = now + CRASH_PAUSE_MIN * 60 * 1000;
    console.log(`⚠️ CRASH DETECTED: ${ (change*100).toFixed(2) }% — pausing`);
  }
}

// ================== NO POSITION ==================
async function handleNoPosition(price) {
  const now = Date.now();
  if (now < pauseUntil) return;

  const bal = await getBalanceUSDC();
  const stake = bal * CAPITAL_PERCENT * stakeMultiplier;

  if (stake < MIN_POSITION_USDC) return;
  if (bal < stake) return;

  const qty = stake / price;

  try {
    await client.order({
      symbol: PAIR,
      side: "BUY",
      type: "MARKET",
      quantity: qty.toFixed(5)
    });

    trailingHigh = null;
    console.log(`BUY ${qty}`);
  } catch (err) {
    console.log("BUY ERROR:", err.message);
  }
}

// ================== POSITION LOGIC ==================
async function handleOpenPosition(pos, price) {
  const pnl = (price - pos.avgPrice) / pos.avgPrice;

  if (pnl <= STOP_LOSS) {
    await client.order({
      symbol: PAIR,
      side: "SELL",
      type: "MARKET",
      quantity: pos.qty.toFixed(5)
    });

    stakeMultiplier = 1;
    trailingHigh = null;
    console.log("STOP LOSS");
    return;
  }

  if (pnl >= TRAIL_START) {
    if (!trailingHigh || price > trailingHigh) trailingHigh = price;

    const stop = trailingHigh * (1 - TRAIL_DISTANCE);

    if (price <= stop) {
      await client.order({
        symbol: PAIR,
        side: "SELL",
        type: "MARKET",
        quantity: pos.qty.toFixed(5)
      });

      stakeMultiplier = Math.min(stakeMultiplier * (1 + AUTO_INCREASE), MAX_MULTIPLIER);
      trailingHigh = null;
      console.log("TP PROFIT");
      return;
    }
  }
}

// ================== MAIN LOOP ==================
async function loop() {
  console.log("🚀 BOT STARTED");

  while (true) {
    try {
      const price = await getPrice();
      updateCrashGuard(price);

      const pos = await getPosition();

      if (!pos) await handleNoPosition(price);
      else await handleOpenPosition(pos, price);

    } catch (err) {
      console.log("Cycle error:", err.message);
    }

    await sleep(INTERVAL_MS);
  }
}

loop();
