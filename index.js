import crypto from "crypto";
import fetch from "node-fetch";

// ENV VARS
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const LIVE_TRADING = process.env.LIVE_TRADING === "true";

// Trading parovi
const SYMBOLS = ["BTCUSDC", "ETHUSDC", "BNBUSDC", "SOLUSDC"];

// Pomocne funkcije
function sign(query) {
  return crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
}

async function api(path, params = "") {
  const timestamp = Date.now();
  const query = params + `&timestamp=${timestamp}`;
  const signature = sign(query);

  const url = `https://api.binance.com${path}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": API_KEY },
  });

  return res.json();
}

async function getPrice(symbol) {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );
    const data = await res.json();
    return parseFloat(data.price);
  } catch (e) {
    return null;
  }
}

// Minimalistički AI indikator (demo)
function aiSignal(price) {
  const rnd = Math.random();
  if (rnd > 0.97) return "BUY";
  if (rnd < 0.03) return "SELL";
  return "NONE";
}

// MAIN LOOP
console.log("🚀 MULTI-ASSET AI BOT STARTAN");

let logCooldown = 0;

async function loop() {
  try {
    for (let symbol of SYMBOLS) {
      const price = await getPrice(symbol);
      if (!price) continue;

      const signal = aiSignal(price);

      // Proces signala
      if (signal === "BUY" && LIVE_TRADING) {
        console.log(`🟢 AI BUY signal ➜ ${symbol} @ ${price}`);
      }

      if (signal === "SELL" && LIVE_TRADING) {
        console.log(`🔴 AI SELL signal ➜ ${symbol} @ ${price}`);
      }
    }

    // LOG RATE LIMIT PREVENTION – samo 1 put na 10 sekundi
    if (logCooldown <= 0) {
      console.log("⏳ AI analiza u toku…");
      logCooldown = 5; // 5 ciklusa × 2 sekunde = 10 sec
    } else {
      logCooldown--;
    }

  } catch (err) {
    console.log("Error:", err.message);
  }
}

setInterval(loop, 2000);
