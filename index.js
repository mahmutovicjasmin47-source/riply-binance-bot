// ===============================
//  RIPLY AGGRESSIVE DUAL-ARMOR BOT (FIXED)
// ===============================

import { default as Binance } from 'binance-api-node';

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
const HARD_STOP_LOSS = -0.35;      // max gubitak po poziciji
const GLOBAL_STOP = -1.2;          // globalni stop
const MIN_PROFIT_CLOSE = 0.22;     // agresivno zatvaranje profita

// ----- STATE -----
let positions = {};
let globalPNL = 0;

// ----- AI RANDOM SIMULATION -----
function aiSignal() {
  return Math.random();
}

// ----- TRAILING PROFIT -----
function applyTrailing(entry, price) {
  const change = ((price - entry) / entry) * 100;

  if (change >= TRAIL_STEP) return { exit: true, pnl: change };
  if (change <= HARD_STOP_LOSS) return { exit: true, pnl: change };

  return { exit: false, pnl: change };
}

// ----- MAIN LOOP -----
async function runBot() {
  try {
    for (const pair of PAIRS) {
      const ticker = await client.prices({ symbol: pair });
      const price = parseFloat(ticker[pair]);

      if (!positions[pair]) {
        const signal = aiSignal();

        if (signal >= SIGNAL_THRESHOLD && Object.keys(positions).length < MAX_POSITIONS) {
          positions[pair] = { entry: price };
          console.log(`🚀 Ulazim u poziciju ${pair} @ ${price}`);
        }

      } else {
        const { entry } = positions[pair];
        const result = applyTrailing(entry, price);

        if (result.exit) {
          console.log(`💰 Zatvaram ${pair}: PNL=${result.pnl.toFixed(2)}%`);
          globalPNL += result.pnl;
          delete positions[pair];
        }
      }
    }

    if (globalPNL <= GLOBAL_STOP) {
      console.log(`🛑 GLOBAL STOP — Bot se isključuje! Total PNL=${globalPNL.toFixed(2)}%`);
      process.exit(0);
    }

  } catch (err) {
    console.error("Greška:", err.message);
  }
}

console.log("🔥 RIPLY AI BOT AKTIVAN — AGRESIVNI + SIGURNI MOD 🔥");
setInterval(runBot, SCAN_INTERVAL);
