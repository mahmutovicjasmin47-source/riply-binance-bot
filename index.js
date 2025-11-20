import axios from "axios";
import crypto from "crypto";

// ------------------------------
// KONFIG
// ------------------------------
const CONFIG = {
    stakePct: 0.70,              // koristi 70% kapitala
    minVolatility: 0.0010,       // min volatilnost
    tpStart: 0.003,              // 0.3% aktivira trailing TP
    tpTrail: 0.002,              // trailing 0.2%
    stopLoss: -0.015,            // -1.5% SL
    aiTrendWindow: 20,           // AI trend score (20 svijeća)
    antiCrashPct: -0.022,        // -2.2% crash zaštita
    antiCrashWindowMs: 60000,    // 1 min crash analiza
    crashPauseMs: 150000,        // 2.5 min pauza nakon crashera
    loopMs: 2000                 // 2 sekunde delay
};

// ------------------------------
// BINANCE API
// ------------------------------
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;

// TRADE MOD
const LIVE = (process.env.LIVE_TRADING || "false").toLowerCase() === "true";

// ASSETS LISTA IZ VARIJABLE
const ASSETS = process.env.ASSETS.split(",");

// ------------------------------
// HMAC Potpis
// ------------------------------
function sign(query) {
    return crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
}

// ------------------------------
// Binance GET poziv
// ------------------------------
async function api(path, params = "") {
    const timestamp = Date.now();
    const query = params ? `${params}&timestamp=${timestamp}` : `timestamp=${timestamp}`;
    const signature = sign(query);

    const url = `https://api.binance.com${path}?${query}&signature=${signature}`;

    return axios.get(url, {
        headers: { "X-MBX-APIKEY": API_KEY }
    }).then(r => r.data);
}

// ------------------------------
// Binance POST poziv
// ------------------------------
async function post(path, params) {
    const timestamp = Date.now();
    const query = `${params}&timestamp=${timestamp}`;
    const signature = sign(query);

    const url = `https://api.binance.com${path}?${query}&signature=${signature}`;

    return axios.post(url, {}, {
        headers: { "X-MBX-APIKEY": API_KEY }
    }).then(r => r.data);
}

// ------------------------------
// Cijena
// ------------------------------
async function getPrice(symbol) {
    const r = await axios.get("https://api.binance.com/api/v3/ticker/price?symbol=" + symbol);
    return parseFloat(r.data.price);
}

// ------------------------------
// AI TREND ANALIZA
// ------------------------------
async function aiTrend(symbol) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=${CONFIG.aiTrendWindow}`;
    const r = await axios.get(url);
    const candles = r.data.map(c => ({
        open: parseFloat(c[1]),
        close: parseFloat(c[4]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3])
    }));

    let score = 0;
    for (let i = 1; i < candles.length; i++) {
        if (candles[i].close > candles[i].open) score++;
        else score--;
    }

    const vol = Math.abs(candles[candles.length - 1].high - candles[candles.length - 1].low)
        / candles[candles.length - 1].low;

    return { score, vol };
}

// ------------------------------
// BALANCE
// ------------------------------
async function getUSDCBalance() {
    const data = await api("/api/v3/account");
    const bal = data.balances.find(b => b.asset === "USDC");
    return parseFloat(bal.free);
}

// ------------------------------
// MARKET BUY
// ------------------------------
async function buy(symbol, amount) {
    if (!LIVE) {
        console.log("SIM BUY:", symbol, amount);
        return;
    }
    return post("/api/v3/order", `symbol=${symbol}&side=BUY&type=MARKET&quoteOrderQty=${amount}`);
}

// ------------------------------
// MARKET SELL
// ------------------------------
async function sell(symbol, amount) {
    if (!LIVE) {
        console.log("SIM SELL:", symbol, amount);
        return;
    }
    return post("/api/v3/order", `symbol=${symbol}&side=SELL&type=MARKET&quantity=${amount}`);
}

// ------------------------------
// GLAVNA PETLJA
// ------------------------------
let lastCrash = 0;
let holding = null;
let entryPrice = 0;

async function loop() {
    try {
        // Anti-crash
        if (Date.now() - lastCrash < CONFIG.crashPauseMs) {
            console.log("⛔ Pauza zbog crash detekcije...");
            return setTimeout(loop, CONFIG.loopMs);
        }

        // Ako držimo poziciju -> trailing TP / SL
        if (holding) {
            const price = await getPrice(holding);
            const pnl = (price - entryPrice) / entryPrice;

            if (pnl <= CONFIG.stopLoss) {
                console.log("⛔ Stop Loss HIT -> SELL:", holding);
                await sell(holding, (await getBalanceSize(holding)));
                holding = null;
                return setTimeout(loop, CONFIG.loopMs);
            }

            if (pnl >= CONFIG.tpStart) {
                if (pnl <= CONFIG.tpStart - CONFIG.tpTrail) {
                    console.log("🎯 Trailing TP -> SELL:", holding);
                    await sell(holding, (await getBalanceSize(holding)));
                    holding = null;
                    return setTimeout(loop, CONFIG.loopMs);
                }
                console.log("📈 Trailing", holding, "PNL=", (pnl * 100).toFixed(2) + "%");
            }
        }

        // Ako ne držimo poziciju -> tražimo ulaz
        if (!holding) {
            let best = null;
            let bestScore = -999;

            for (let sym of ASSETS) {
                const { score, vol } = await aiTrend(sym);

                if (vol < CONFIG.minVolatility) continue;
                if (score > bestScore) {
                    best = sym;
                    bestScore = score;
                }
            }

            if (bestScore > 3) {
                const bal = await getUSDCBalance();
                const stake = bal * CONFIG.stakePct;

                console.log("🚀 BUY:", best, "AI score:", bestScore);
                await buy(best, stake);

                holding = best;
                entryPrice = await getPrice(best);
            } else {
                console.log("Nema pozitivnog AI signala, čekam.");
            }
        }
    } catch (e) {
        console.log("ERROR:", e.message);
        lastCrash = Date.now();
    }

    setTimeout(loop, CONFIG.loopMs);
}

// START
console.log("🚀 MULTI-ASSET AI BOT STARTAN");
loop();
