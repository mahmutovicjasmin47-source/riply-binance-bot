// ===============================
//  RIPLY SAFE-AGGRESSIVE BOT (C MODE)
// ===============================

// ----- IMPORT (ISPRAVAN ZA NODE 22 + RAILWAY) -----
import { default as Binance } from 'binance-api-node';

// ----- INIT -----
const client = Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
});

// ----- SETTINGS -----
const PAIRS = ["BTCUSDC", "ETHUSDC", "BNBUSDC", "SOLUSDC"];

// SIGURAN + POLUAGRESIVAN MOD (C)
const SCAN_INTERVAL = 2000;
const SIGNAL_THRESHOLD = 0.63;
const MAX_POSITIONS = 2;
const TRAIL_STEP = 0.20;
const HARD_STOP = -0.25;
const GLOBAL_STOP = -0.90;
const MIN_PROFIT_CLOSE = 0.18;

// ----- STATE -----
let positions = {};
let globalPNL = 0;

// ----- AI SIGNAL (SIMULACIJA) -----
function aiSignal() {
    return Math.random();
}

// ----- TRAILING LOGIKA -----
function trailing(entry, price) {
    const pnl = ((price - entry) / entry) * 100;

    if (pnl >= TRAIL_STEP) return { exit: true, pnl };
    if (pnl <= HARD_STOP) return { exit: true, pnl };

    return { exit: false, pnl };
}

// ----- MAIN LOOP -----
async function runBot() {
    try {
        for (const pair of PAIRS) {
            const ticker = await client.prices({ symbol: pair });
            const price = parseFloat(ticker[pair]);

            // NEMA POZICIJE → TRAŽI SIGNAL
            if (!positions[pair]) {
                const signal = aiSignal();

                if (signal >= SIGNAL_THRESHOLD && Object.keys(positions).length < MAX_POSITIONS) {
                    positions[pair] = { entry: price };
                    console.log(`🚀 Ulazim u ${pair} @ ${price}`);
                }

            } else {
                // AKTIVNA POZICIJA
                const { entry } = positions[pair];
                const check = trailing(entry, price);

                if (check.exit) {
                    globalPNL += check.pnl;
                    console.log(`💰 Zatvaram ${pair}: PNL=${check.pnl.toFixed(2)}%`);
                    delete positions[pair];
                }
            }
        }

        // GLOBAL STOP PROTECTION
        if (globalPNL <= GLOBAL_STOP) {
            console.log(`🛑 GLOBAL STOP — BOT SE GASI (Total PNL=${globalPNL.toFixed(2)}%)`);
            process.exit(0);
        }

    } catch (err) {
        console.log("Greška:", err.message);
    }
}

console.log("🔥 RIPLY C-MODE BOT AKTIVAN (SIGURAN + POLUAGRESIVAN) 🔥");
setInterval(runBot, SCAN_INTERVAL);
