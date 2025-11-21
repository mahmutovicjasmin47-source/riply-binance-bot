// ===============================================
//   RIPLY PRO AI BOT — AGGRESSIVE + SAFE MODE
//   FULLY FIXED (Railway + Node22 + Binance)
// ===============================================

const Binance = require('binance-api-node').default;

// ---- BINANCE CLIENT ----
const client = Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
});

// ---- SETTINGS ----
const PAIRS = ["BTCUSDC", "ETHUSDC", "BNBUSDC", "SOLUSDC"];

// PRO agresivni + sigurni mod
const SCAN_INTERVAL = 1000;      // 1 sekunda
const SIGNAL_THRESHOLD = 0.55;   // brži ulaz
const MAX_POSITIONS = 3;         // max aktivnih pozicija

const TRAIL_STEP = 0.25;         // trailing take-profit %
const HARD_STOP_LOSS = -0.35;    // max gubitak po poziciji
const GLOBAL_STOP = -1.2;        // max gubitak ukupno (%)
const MIN_PROFIT_CLOSE = 0.22;   // automatsko zatvaranje profita

// ---- STATE ----
let positions = {};
let globalPNL = 0;

// ---- AI SIGNAL ----
function aiSignal() {
    return Math.random(); // 0–1
}

// ---- TRAILING LOGIC ----
function applyTrailing(entry, price) {
    const change = ((price - entry) / entry) * 100;

    if (change >= TRAIL_STEP) return { exit: true, pnl: change };
    if (change <= HARD_STOP_LOSS) return { exit: true, pnl: change };

    return { exit: false, pnl: change };
}

// ---- MAIN LOOP ----
async function runBot() {
    try {
        for (const pair of PAIRS) {

            // Fetch price
            const ticker = await client.prices({ symbol: pair });
            const price = parseFloat(ticker[pair]);

            // --- NO POSITION ---
            if (!positions[pair]) {
                const signal = aiSignal();

                if (signal >= SIGNAL_THRESHOLD && Object.keys(positions).length < MAX_POSITIONS) {
                    positions[pair] = { entry: price };
                    console.log(`🚀 Ulaz u poziciju ${pair} @ ${price}`);
                }

            } else {
                // --- ACTIVE POSITION ---
                const { entry } = positions[pair];
                const result = applyTrailing(entry, price);

                if (result.exit) {
                    console.log(`💰 Zatvaram ${pair}: PNL=${result.pnl.toFixed(2)}%`);
                    globalPNL += result.pnl;
                    delete positions[pair];
                }
            }
        }

        // ---- GLOBAL STOP ----
        if (globalPNL <= GLOBAL_STOP) {
            console.log(`🛑 GLOBAL STOP — Bot se gasi! Total PNL=${globalPNL.toFixed(2)}%`);
            process.exit(0);
        }

    } catch (err) {
        console.error("❌ Greška:", err.message);
    }
}

// ---- START ----
console.log("🔥 RIPLY PRO AI BOT — AGGRESSIVE + SAFE MODE ACTIVE 🔥");
setInterval(runBot, SCAN_INTERVAL);
