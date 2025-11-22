import dotenv from "dotenv";
import { Spot } from "@binance/connector";
dotenv.config();

// ========================
//  KLIJENT
// ========================
const client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);

// ========================
//  POSTAVKE BOTA
// ========================
const SYMBOLS = ["BTCUSDC", "ETHUSDC"];  // tvoji parovi
const POSITION_PCT = 0.70;               // ulaže 70% kapitala
const TARGET_DAILY = 1.0;                // 1% dnevni cilj
const TRAILING_SL = 0.35;                // trailing stop 0.35% (štiti profit)
const COOL_DOWN = 8000;                  // 8 sekundi pauze između ulaza

let dailyPNL = 0;
let lastDay = new Date().toISOString().slice(0, 10);
let inTrade = {};

// inicijalizira prazne pozicije
SYMBOLS.forEach(sym => inTrade[sym] = { active: false, entry: 0, qty: 0 });


// ========================
//  FUNKCIJE
// ========================
async function getPrice(symbol) {
  const res = await client.tickerPrice(symbol);
  return Number(res.data.price);
}

async function getBalances() {
  const acc = await client.account();
  const list = acc.data.balances;
  const usdc = Number(list.find(a => a.asset === "USDC")?.free ?? 0);
  return usdc;
}

function pctChange(current, entry) {
  return ((current - entry) / entry) * 100;
}


// ========================
//  GLAVNA LOGIKA
// ========================
async function tradeSymbol(symbol) {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);

  if (dayKey !== lastDay) {
    dailyPNL = 0;
    lastDay = dayKey;
    console.log(`\n📅 Novi dan – reset`)
  }

  if (dailyPNL >= TARGET_DAILY) {
    console.log(`🎯 Dnevni target ${TARGET_DAILY}% postignut – pauza`);
    return;
  }

  const price = await getPrice(symbol);

  // =======================
  //  AKO SMO U POZICIJI → PROVJERA
  // =======================
  if (inTrade[symbol].active) {

    const entry = inTrade[symbol].entry;
    const p = pctChange(price, entry);

    // trailing stop logika
    if (p >= TRAILING_SL) {
      console.log(`🔒 Trailing aktiviran ${symbol} +${p.toFixed(3)}%`);
    }

    // izlaz ako trailing padne
    if (p < -0.25) {
      console.log(`❌ Stop-loss ${symbol} (${p.toFixed(3)}%)`);
      inTrade[symbol].active = false;
      dailyPNL += p;
      return;
    }

    // izlaz ako target po trejdu
    if (p >= 0.5) {
      console.log(`✅ Profit ${symbol} +${p.toFixed(3)}%`);
      dailyPNL += p;
      inTrade[symbol].active = false;
      return;
    }

    return;
  }

  // =======================
  //  AKO NISMO U POZICIJI → ULASCI
  // =======================
  const usdc = await getBalances();
  const spend = usdc * POSITION_PCT;

  if (spend < 5) return; // premalo

  const qty = (spend / price).toFixed(6);

  // simulirani ulaz
  inTrade[symbol] = {
    active: true,
    entry: price,
    qty: qty
  };

  console.log(`🟢 BUY ${symbol} @ ${price} qty=${qty}`);
}


// ========================
//  LOOP
// ========================
async function loop() {
  try {
    for (const sym of SYMBOLS) {
      await tradeSymbol(sym);
      await new Promise(r => setTimeout(r, COOL_DOWN));
    }
  } catch (err) {
    console.log("Greška:", err.message);
  }

  setTimeout(loop, 2000);
}

console.log("🤖 Stabilni bot (Opcija A) pokrenut...");
loop();
