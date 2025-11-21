// ===========================
// SPOT TRADING BOT – AGRESIVNI MOD
// ===========================

require('dotenv').config();
const Binance = require('binance-api-node').default;

// API ključevi
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET
});

// SETTINGS
const SYMBOL = "BTCUSDC";
let baseTradePercent = 0.70;  // 70%
let increasePerTrade = 0.10;  // 10% po tradu
let currentTradePercent = baseTradePercent;

let inPosition = false;
let entryPrice = 0;
let trailingStop = 0;

async function getPrice() {
  const ticker = await client.prices({ symbol: SYMBOL });
  return parseFloat(ticker[SYMBOL]);
}

async function getBalance() {
  const balance = await client.accountInfo();
  const usdc = balance.balances.find(b => b.asset === "USDC");
  return parseFloat(usdc.free);
}

async function buy() {
  const usdcBalance = await getBalance();
  const amountToSpend = usdcBalance * currentTradePercent;

  const price = await getPrice();
  const quantity = (amountToSpend / price).toFixed(6);

  console.log(`🟢 Kupujem ${quantity} BTC za ${amountToSpend} USDC`);

  const order = await client.order({
    symbol: SYMBOL,
    side: "BUY",
    type: "MARKET",
    quantity
  });

  inPosition = true;
  entryPrice = price;
  trailingStop = price * 0.995; // 0.5% ispod ulaza
  currentTradePercent += increasePerTrade;

  return order;
}

async function sell() {
  const balance = await client.accountInfo();
  const btc = balance.balances.find(b => b.asset === "BTC");
  const quantity = parseFloat(btc.free).toFixed(6);

  console.log(`🔴 Prodajem ${quantity} BTC (trailing profit aktiviran)`);

  const order = await client.order({
    symbol: SYMBOL,
    side: "SELL",
    type: "MARKET",
    quantity
  });

  inPosition = false;
  currentTradePercent = baseTradePercent;

  return order;
}

// MAIN LOOP
async function botLoop() {
  try {
    const price = await getPrice();
    console.log(`📈 BTCUSDC: ${price}`);

    if (!inPosition) {
      // SIGNAL ZA KUPOVINU (agresivno – trend gore)
      if (price > trailingStop) {
        await buy();
      }
    } else {
      // TRAILING PROFIT LOGIKA
      if (price > entryPrice) {
        trailingStop = price * 0.997; // podiže stop kako raste cijena
      }

      if (price < trailingStop) {
        await sell();
      }
    }

  } catch (err) {
    console.log("⚠ Greška:", err.message);
  }
}

console.log("🚀 Agresivni SPOT BOT POKRENUT...");
setInterval(botLoop, 1000); // 1 sekunda
