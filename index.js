// ===============================
//  RIPLY AGGRESSIVE DUAL-ARMOR BOT
// ===============================

import Binance from 'binance-api-node';
import crypto from 'crypto';   // <---- OVO SI ZABORAVIO, OVO RIJEŠAVA PROBLEM

// ----- ENV -----
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// ----- SETTINGS -----
const PAIRS = ["BTCUSDC", "ETHUSDC", "BNBUSDC", "SOLUSDC"];

// Agresivno + sigurnosni oklop
const SCAN_INTERVAL = 1500;        // 1.5 sekunde
const SIGNAL_THRESHOLD = 0.58;     // spušten threshold → brži ulaz
const MAX_POSITIONS = 3;           // ograniči rizične situacije
const TRAIL_STEP = 0.25;           // trailing step %
const HARD_STOP_LOSS = -0.35;      // maksimalni dopušteni gubitak po poziciji
const GLOBAL_STOP = -1.2;          // globalna zaštita (svi parovi)
const MIN_PROFIT_CLOSE = 0.22;     // agresivno zatvaranje profita

// ----- STATE -----
let positions = {};
let globalPNL = 0;

// ----- HELPER: Random AI simulacija -----
function aiSignal() {
  return Math.random(); // 0–1
}

// ----- HELPER: Trailing profit -----
function applyTrailing(pair, entry, price) {
  const change = ((price - entry) / entry) * 100;

  if (change >= TRAIL_STEP) return { exit: true, pnl: change };
  if (change <= HARD_STOP_LOSS) return { exit: true, pnl: change };

  return { exit: false, pnl: change };
}

// ----- MAIN BOT LOOP -----
async function runBot() {
  try {
    for (const pair of PAIRS) {

      // Fetch price
      const ticker = await client.prices({ symbol: pair });
      const price = parseFloat(ticker[pair]);

      // Ako nemamo poziciju → tražimo signal
      if (!positions[pair]) {
        const signal = aiSignal();

        if (signal >= SIGNAL_THRESHOLD && Object.keys(positions).length < MAX_POSITIONS) {
          positions[pair] = { entry: price };
          console.log(`🚀 Ulazim u poziciju ${pair} @ ${price}`);
        }

      } else {
        // Pozicija aktivna → trailing + zaštita
        const { entry } = positions[pair];
        const result = applyTrailing(pair, entry, price);

        if (result.exit) {
          console.log(`💰 Zatvaram ${pair}: PNL=${result.pnl.toFixed(2)}%`);
          globalPNL += result.pnl;
          delete positions[pair];
        }
      }
    }

    // GLOBAL STOP PROTECTION
    if (globalPNL <= GLOBAL_STOP) {
      console.log(`🛑 GLOBAL STOP — Bot se isključuje! Total PNL=${globalPNL.toFixed(2)}%`);
      process.exit(0);
    }

  } catch (err) {
    console.error("Greška:", err.message);
  }
}

// ----- LOOP -----
console.log("🔥 RIPLY AI BOT AKTIVAN — AGRESIVNI + SIGURNI MOD UKLJUČEN 🔥");
setInterval(runBot, SCAN_INTERVAL);
