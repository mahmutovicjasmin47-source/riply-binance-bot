import dotenv from "dotenv";
import { Spot } from "@binance/connector";

dotenv.config();

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;
const client = new Spot(apiKey, apiSecret);

const PAIRS = ["BTCUSDC", "ETHUSDC"];
const CAPITAL_PERCENT = 0.7; // 70%
const DAILY_TARGET = 1.01; // 1% profit cilj
const TRAILING_PERCENT = 0.003; // 0.3% trailing safety
const CHECK_INTERVAL = 5000; // svakih 5 sekundi

let boughtPrices = {};
let trailingStops = {};
let invested = false;
let startBalance = null;

// ----------- GET BALANCE -----------
async function getBalance() {
  const acc = await client.account();
  const usdc = acc.data.balances.find(b => b.asset === "USDC");
  return parseFloat(usdc.free);
}

// ----------- GET PRICE -----------
async function getPrice(symbol) {
  const r = await client.tickerPrice(symbol);
  return parseFloat(r.data.price);
}

// ----------- BUY -----------
async function buy(symbol, amountUSDC) {
  try {
    const price = await getPrice(symbol);
    const qty = (amountUSDC / price).toFixed(6);

    await client.newOrder(symbol, "BUY", "MARKET", { quantity: qty });

    boughtPrices[symbol] = price;
    trailingStops[symbol] = price * (1 - TRAILING_PERCENT);

    console.log(`🟢 BUY ${symbol} @ ${price} qty=${qty}`);
  } catch (err) {
    console.log(`❌ BUY ERROR ${symbol}:`, err.response?.data || err);
  }
}

// ----------- SELL -----------
async function sell(symbol) {
  try {
    const acc = await client.account();
    const a = acc.data.balances.find(b => b.asset === symbol.replace("USDC", ""));
    const qty = parseFloat(a.free).toFixed(6);

    if (qty > 0.00001) {
      await client.newOrder(symbol, "SELL", "MARKET", { quantity: qty });
      console.log(`🔴 SELL ${symbol} qty=${qty}`);
    }
  } catch (err) {
    console.log(`❌ SELL ERROR ${symbol}:`, err.response?.data || err);
  }
}

// ----------- MAIN LOOP -----------
async function loop() {
  try {
    const balance = await getBalance();

    // Init start balance
    if (!startBalance) startBalance = balance;

    const totalBalance = balance;

    // MAIN LOG
    const prices = {};
    for (let p of PAIRS) {
      prices[p] = await getPrice(p);
    }

    console.log(`⏱  BTC: ${prices.BTCUSDC}   |   ETH: ${prices.ETHUSDC}`);

    // ------------------- BUY LOGIC -------------------
    if (!invested) {
      const investUSDC = totalBalance * CAPITAL_PERCENT;

      console.log("🟦 Kupovina aktivirana...");

      await buy("BTCUSDC", investUSDC / 2);
      await buy("ETHUSDC", investUSDC / 2);

      invested = true;
      return;
    }

    // ------------------- TRAILING TAKE PROFIT -------------------
    for (let sym of PAIRS) {
      if (!boughtPrices[sym]) continue;

      const price = prices[sym];

      // Move trailing stop up
      if (price > boughtPrices[sym]) {
        trailingStops[sym] = price * (1 - TRAILING_PERCENT);
      }

      // Trigger trailing stop
      if (price <= trailingStops[sym]) {
        console.log(`⚠️ TRAILING STOP TRIGGERED for ${sym}`);
        await sell(sym);
        invested = false;
        return;
      }
    }

    // ------------------- DAILY PROFIT TARGET -------------------
    if (totalBalance >= startBalance * DAILY_TARGET) {
      console.log("🏆 DNEVNI PROFIT OSTVAREN — SELL ALL");
      await sell("BTCUSDC");
      await sell("ETHUSDC");
      invested = false;
      return;
    }

  } catch (err) {
    console.log("⚠️ Loop error:", err.response?.data || err.message);
  }
}

// Run continuously every 5 seconds
setInterval(loop, CHECK_INTERVAL);

console.log("🤖 Ultimate Bot (Opcija C) — ACTIVE 24/7");
