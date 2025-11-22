import { Spot } from '@binance/connector';
import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;

const client = new Spot(apiKey, apiSecret);

// PAROVI KOJE KORISTI TVOJ BOT
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// GLAVNI LOOP 24/7
async function loop() {
  try {
    const prices = {};

    for (const pair of PAIRS) {
      const res = await client.tickerPrice(pair);
      prices[pair] = res.data.price;
    }

    console.log(
      "⏱ ", 
      `BTC: ${prices.BTCUSDC}  |  ETH: ${prices.ETHUSDC}`
    );

    // Ako želiš aktivan trading uključi u Railway:
    // LIVE_TRADING = true
    if (process.env.LIVE_TRADING === "true") {
      await runStrategy(prices);
    }

  } catch (err) {
    console.log("⚠️ Greška u loop-u:", err.message);
  }

  setTimeout(loop, 5000); // bot radi svakih 5 sekundi bez gašenja
}

async function runStrategy(prices) {
  try {
    console.log("🤖 Trading logika aktivna...");
    // Ovdje kasnije ubacujemo 1% strategiju – sve spremno.
  } catch (err) {
    console.log("❌ Greška u tradingu:", err.message);
  }
}

console.log("🤖 Stabilni bot (Opcija A) pokrenut...");
loop();
