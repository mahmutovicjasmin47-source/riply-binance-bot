import { Spot } from '@binance/connector';
import dotenv from 'dotenv';
dotenv.config();

const client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);

// === KONFIGURACIJA BOTA ===
const PAIRS = ["BTCUSDC", "ETHUSDC"];
const CAPITAL_PERCENT = 0.70;         // 70% kapitala
const TAKE_PROFIT = 1.01;             // +1% profit target (minimalno)
const TRAILING_BUFFER = 0.004;        // trailing take profit (0.4%)
const STOP_LOSS = 0.97;               // -3% zaštita
let positions = {};

// --- FUNKCIJE ---

async function getBalance(asset) {
  const acc = await client.account();
  const balance = acc.data.balances.find(b => b.asset === asset);
  return parseFloat(balance.free);
}

async function getPrice(symbol) {
  const ticker = await client.tickerPrice(symbol);
  return parseFloat(ticker.data.price);
}

// --- KUPUJ ---
async function buy(symbol) {
  const usdc = await getBalance("USDC");
  const invest = usdc * CAPITAL_PERCENT / PAIRS.length;
  const price = await getPrice(symbol);
  const qty = (invest / price).toFixed(6);

  await client.newOrder(symbol, "BUY", "MARKET", { quantity: qty });

  positions[symbol] = {
    entry: price,
    highest: price
  };

  console.log(`🟢 BUY ${symbol} @ ${price} qty=${qty}`);
}

// --- PRODAJ ---
async function sell(symbol) {
  const asset = symbol.replace("USDC", "");
  const bal = await getBalance(asset);
  if (bal > 0) {
    await client.newOrder(symbol, "SELL", "MARKET", { quantity: bal });
    console.log(`🔴 SELL ${symbol} @ market`);
  }
  positions[symbol] = null;
}

// --- GLAVNA LOGIKA ---
async function trade() {
  try {
    for (const symbol of PAIRS) {
      const price = await getPrice(symbol);

      // Ako nema pozicije → KUPUJ
      if (!positions[symbol]) {
        await buy(symbol);
        continue;
      }

      let pos = positions[symbol];

      // Update highest
      if (price > pos.highest) pos.highest = price;

      // Trailing take profit
      if (price <= pos.highest * (1 - TRAILING_BUFFER)) {
        console.log(`📉 Trailing TP triggered for ${symbol}`);
        await sell(symbol);
        continue;
      }

      // Normalni take profit 1%
      if (price >= pos.entry * TAKE_PROFIT) {
        console.log(`🏆 Take profit hit for ${symbol}`);
        await sell(symbol);
        continue;
      }

      // Stop-loss
      if (price <= pos.entry * STOP_LOSS) {
        console.log(`🛑 Stop-loss hit for ${symbol}`);
        await sell(symbol);
        continue;
      }
    }
  } catch (e) {
    console.log("Greška:", e);
  }
}

// --- PETLJA 24/7 ---
console.log("🤖 Stabilni bot (Opcija A) pokrenut...");
setInterval(trade, 7000);
