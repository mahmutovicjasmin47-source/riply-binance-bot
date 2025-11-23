import 'dotenv/config';
import { Spot } from '@binance/connector';

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;

const client = new Spot(apiKey, apiSecret);

// Podesavanja
const PAIRS = ["BTCUSDC", "ETHUSDC"];
const CAPITAL_PERCENT = 0.70;
const TRAILING_PERCENT = 0.35;   // trailing take profit
const SAFETY_DROP = -3;          // max dozvoljeni pad prije zaštitne prodaje

let entryPrices = {};
let trailingHigh = {};
let positions = {};

async function getBalance() {
  const res = await client.userAsset();
  return res.data;
}

async function getPrice(symbol) {
  const res = await client.tickerPrice(symbol);
  return Number(res.data.price);
}

async function buy(symbol) {
  const balance = await getBalance();
  const usdcObj = balance.find(a => a.asset === "USDC");
  if (!usdcObj) return console.log("❌ Nema USDC!");

  const free = Number(usdcObj.free);
  const amount = free * CAPITAL_PERCENT;

  if (amount < 5) return console.log("❌ Premalo USDC za trgovanje!");

  const price = await getPrice(symbol);
  const qty = (amount / price).toFixed(5);

  try {
    const order = await client.newOrder(symbol, "BUY", "MARKET", { quantity: qty });
    console.log(`🟢 BUY ${symbol} @ ${price} qty=${qty}`);

    entryPrices[symbol] = price;
    trailingHigh[symbol] = price;
    positions[symbol] = true;
  } catch (e) {
    console.log("❌ BUY greška:", e.response?.data || e);
  }
}

async function sell(symbol) {
  try {
    const balance = await getBalance();
    const asset = symbol.replace("USDC", "");
    const coin = balance.find(a => a.asset === asset);

    if (!coin || Number(coin.free) === 0) return;

    const qty = Number(coin.free).toFixed(5);

    await client.newOrder(symbol, "SELL", "MARKET", { quantity: qty });

    console.log(`🔴 SELL ${symbol} qty=${qty}`);
    positions[symbol] = false;
  } catch (e) {
    console.log("❌ SELL greška:", e.response?.data || e);
  }
}

async function loop() {
  for (const symbol of PAIRS) {
    try {
      const price = await getPrice(symbol);
      console.log(`⏱️ ${symbol}: ${price}`);

      // Ako nema pozicije — kupi
      if (!positions[symbol]) {
        await buy(symbol);
        continue;
      }

      // Ako postoji pozicija — trailing logika
      if (positions[symbol]) {
        const entry = entryPrices[symbol];

        // Trailing high update
        if (price > trailingHigh[symbol]) {
          trailingHigh[symbol] = price;
        }

        // Ako je pao ispod trailing % — prodaj
        const dropFromHigh = ((price - trailingHigh[symbol]) / trailingHigh[symbol]) * 100;

        if (dropFromHigh < -TRAILING_PERCENT) {
          console.log(`🔻 Trailing SELL trigger (${symbol})`);
          await sell(symbol);
          continue;
        }

        // Safety net — max dozvoljen gubitak
        const loss = ((price - entry) / entry) * 100;

        if (loss < SAFETY_DROP) {
          console.log(`⚠️ Safety SELL trigger (${symbol})`);
          await sell(symbol);
          continue;
        }
      }

    } catch (err) {
      console.log(`⚠️ Greška u loop-u:`, err.response?.data || err);
    }
  }
}

console.log("🤖 ULTIMATE Bot (Opcija C) pokrenut...");

// Loop svakih 5 sekundi
setInterval(loop, 5000);
