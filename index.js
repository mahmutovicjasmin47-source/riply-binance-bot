import Binance from "binance-api-node";

// 🔑 API ključevi iz Railway varijabli
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET
});

// 🟡 PARAMETRI BOTA
const PAIR = "BTCUSDC";
const CAPITAL_PERCENT = 0.70;     // koristi 70% kapitala
const AUTO_INCREASE = 0.10;       // +10% nakon profita
const MAX_MULTIPLIER = 3;         // sigurnosni limit
const INTERVAL_MS = 1500;         // skeniranje svakih ~1.5 sekunde

// Trailing parametri
const TRAIL_START = 0.003;        // 0.3% profit aktivira trailing
const TRAIL_DISTANCE = 0.002;     // povlačenje 0.2%

// Sigurnosne granice
const STOP_LOSS = -0.008;         // max -0.8% gubitak
const CRASH_DROP = -0.015;        // -1.5% u minuti → pauza
const CRASH_WINDOW_MS = 60000;
const CRASH_PAUSE_MIN = 5;
const MIN_POSITION_USDC = 30;

// 🟣 STATE
let stakeMultiplier = 1;
let trailingHigh = null;
let pauseUntil = 0;
let priceHistory = [];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  const buyQty = buys.reduce((a, t) => a + parseFloat(t.qty), 0);
  const sellQty = sells.reduce((a, t) => a + parseFloat(t.qty), 0);

  const qty = buyQty - sellQty;
  if (qty <= 0) return null;

  const totalBuyCost = buys.reduce((a, t) => a + parseFloat(t.qty) * parseFloat(t.price), 0);
  const avg = totalBuyCost / buyQty;

  return { qty, avgPrice: avg };
}

function crashGuard(price) {
  const now = Date.now();
  priceHistory.push({ time: now, price });

  priceHistory = priceHistory.filter(p => now - p.time <= CRASH_WINDOW_MS);

  if (priceHistory.length < 2) return;

  const start = priceHistory[0].price;
  const drop = (price - start) / start;

  if (drop <= CRASH_DROP) {
    pauseUntil = now + CRASH_PAUSE_MIN * 60000;
    console.log("⚠️ DETECTED MARKET DUMP → PAUSE ", CRASH_PAUSE_MIN, "min");
  }
}

async function buy(price) {
  const balance = await getBalanceUSDC();
  const stake = balance * CAPITAL_PERCENT * stakeMultiplier;

  if (stake < MIN_POSITION_USDC) {
    console.log("Premalo USDC za ulaz.");
    return;
  }

  const qty = stake / price;

  try {
    await client.order({
      symbol: PAIR,
      side: "BUY",
      type: "MARKET",
      quantity: qty.toFixed(5)
    });

    trailingHigh = null;
    console.log(`🟢 BUY: qty=${qty.toFixed(5)}, stake=${stake.toFixed(2)}`);
  } catch (err) {
    console.log("BUY ERROR:", err.message);
  }
}

async function sell(pos, price, pnl) {
  try {
    await client.order({
      symbol: PAIR,
      side: "SELL",
      type: "MARKET",
      quantity: pos.qty.toFixed(5)
    });

    console.log(`🔴 SELL: PnL = ${(pnl * 100).toFixed(2)}%`);

    stakeMultiplier = Math.min(stakeMultiplier * (1 + AUTO_INCREASE), MAX_MULTIPLIER);
    console.log(`📈 NOVI MULTIPLIER: ${stakeMultiplier.toFixed(2)}x`);

    trailingHigh = null;
  } catch (err) {
    console.log("SELL ERROR:", err.message);
  }
}

async function tradeLoop() {
  console.log("🔥 AGRESIVNI BOT STARTAN — BTCUSDC 🔥");

  while (true) {
    try {
      const price = await getPrice();
      crashGuard(price);

      const now = Date.now();
      if (now < pauseUntil) {
        console.log("⏸ PAUZA ZBOG DUMPA...");
        await sleep(INTERVAL_MS);
        continue;
      }

      const pos = await getPosition();

      if (!pos) {
        await buy(price);
      } else {
        const pnl = (price - pos.avgPrice) / pos.avgPrice;

        if (pnl <= STOP_LOSS) {
          await sell(pos, price, pnl);
        }

        if (pnl >= TRAIL_START) {
          if (!trailingHigh || price > trailingHigh) trailingHigh = price;

          const stop = trailingHigh * (1 - TRAIL_DISTANCE);

          if (price <= stop) {
            await sell(pos, price, pnl);
          }
        }
      }
    } catch (err) {
      console.log("LOOP ERROR:", err.message);
    }

    await sleep(INTERVAL_MS);
  }
}

tradeLoop();
