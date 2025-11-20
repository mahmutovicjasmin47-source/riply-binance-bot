import crypto from "crypto";

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const LIVE = process.env.LIVE_TRADING === "true";

const SYMBOLS = ["BTCUSDC", "ETHUSDC", "BNBUSDC", "SOLUSDC"];
const INTERVAL = 2000; // 2 sekunde
const AI_THRESHOLD = 0.32; 
const TRAILING_TP = 0.0045; 
const STOP_LOSS = -0.0035;
const COOLDOWN = 3000;

let lastTradeTime = 0;
let activePositions = {};

async function binanceRequest(path, params = "") {
  const timestamp = Date.now();
  const query = params + `timestamp=${timestamp}`;
  const signature = crypto
    .createHmac("sha256", API_SECRET)
    .update(query)
    .digest("hex");

  const url = `https://api.binance.com${path}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": API_KEY },
  });

  return await res.json();
}

async function getPrice(symbol) {
  const r = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
  );
  const j = await r.json();
  return parseFloat(j.price);
}

function generateAISignal(priceHistory) {
  const last = priceHistory[priceHistory.length - 1];
  const prev = priceHistory[priceHistory.length - 2];

  const momentum = (last - prev) / prev;
  const randomBoost = Math.random() * 0.1;

  return momentum + randomBoost;
}

async function checkSymbol(symbol) {
  const prices = [];
  for (let i = 0; i < 6; i++) {
    prices.push(await getPrice(symbol));
    await new Promise((r) => setTimeout(r, 50));
  }

  const signal = generateAISignal(prices);

  if (!activePositions[symbol] && signal > AI_THRESHOLD) {
    const price = prices.at(-1);

    if (LIVE) {
      await openPosition(symbol);
    }

    activePositions[symbol] = {
      entry: price,
      highest: price,
    };

    console.log(`🚀 Ulazim u trade ${symbol} po cijeni: ${price}`);
  }

  if (activePositions[symbol]) {
    const price = prices.at(-1);
    const pos = activePositions[symbol];

    if (price > pos.highest) pos.highest = price;

    const pnl = (price - pos.entry) / pos.entry;

    if (pnl >= TRAILING_TP) {
      console.log(`🔥 TP → ${symbol} profit = ${(pnl * 100).toFixed(2)}%`);
      if (LIVE) await closePosition(symbol);
      delete activePositions[symbol];
      return;
    }

    if (pnl <= STOP_LOSS) {
      console.log(`⚠️ STOP LOSS → ${symbol} = ${(pnl * 100).toFixed(2)}%`);
      if (LIVE) await closePosition(symbol);
      delete activePositions[symbol];
      return;
    }

    console.log(`Pozicija ${symbol}: PNL=${(pnl * 100).toFixed(2)}%`);
  }
}

async function openPosition(symbol) {
  console.log(`📥 BUY ${symbol}`);
}

async function closePosition(symbol) {
  console.log(`📤 SELL ${symbol}`);
}

async function botLoop() {
  const now = Date.now();
  if (now - lastTradeTime < COOLDOWN) return;
  lastTradeTime = now;

  for (const s of SYMBOLS) {
    checkSymbol(s);
  }
}

console.log("🔥 PREMIUM AI BOT STARTAN – AGRESIVNI MODE AKTIVAN 🔥");
setInterval(botLoop, INTERVAL);
