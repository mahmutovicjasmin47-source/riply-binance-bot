// ===============================
//  RIPLY AGGRESSIVE DUAL-ARMOR BOT
// ===============================

import pkg from 'binance-api-node';
const Binance = pkg.default;   // << OVO RJEŠAVA TVOJU GREŠKU

// ----- ENV -----
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// ----- SETTINGS -----
const PAIRS = ["BTCUSDC", "ETHUSDC", "BNBUSDC", "SOLUSDC"];

const SCAN_INTERVAL = 1500;
const SIGNAL_THRESHOLD = 0.58;
const MAX_POSITIONS = 3;
const TRAIL_STEP = 0.25;
const HARD_STOP_LOSS = -0.35;
const GLOBAL_STOP = -1.2;
const MIN_PROFIT_CLOSE = 0.22;

let positions = {};
let globalPNL = 0;

// AI signal mock
function aiSignal() {
  return Math.random();
}

function applyTrailing(pair, entry, price) {
  const change = ((price - entry) / entry) * 100;

  if (change >= TRAIL_STEP) return { exit: true, pnl: change };
  if (change <= HARD_STOP_LOSS) return { exit: true, pnl: change };

  return { exit: false, pnl: change };
}

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
        const result = applyTrailing(pair, entry, price);

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

console.log("🔥 RIPLY AI BOT AKTIVAN — AGRESIVNI + SIGURNI MOD UKLJUČEN 🔥");
setInterval(runBot, SCAN_INTERVAL);
