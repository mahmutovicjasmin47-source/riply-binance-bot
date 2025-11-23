import Binance from "binance-api-node";

const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// ✔ Radni parovi
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// ✔ Konfiguracija bota
const LIVE = process.env.LIVE_TRADING === "true";
const TRADE_AMOUNT_USDC = 10;       // svaka pozicija 10 USDC
const TAKE_PROFIT = 0.01;           // 1% profit
const STOP_LOSS = 0.005;            // 0.5% gubitka
const TRAILING = 0.003;             // pomjeranje stop-a 0.3%

// ✔ memorija aktivnih pozicija
let positions = {};

function log(msg) {
  console.log(msg);
}

// 📌 Dobijanje cijena
async function getPrice(symbol) {
  try {
    const res = await client.prices({ symbol });
    return parseFloat(res[symbol]);
  } catch (err) {
    log(`❌ Price error: ${err}`);
    return null;
  }
}

// 📌 Kupovina
async function buy(symbol, price) {
  if (!LIVE) return log(`🟡 TEST MODE BUY ${symbol} @ ${price}`);

  try {
    const qty = +(TRADE_AMOUNT_USDC / price).toFixed(6);

    const order = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quantity: qty,
    });

    log(`🟢 BUY EXECUTED ${symbol}, qty=${qty}`);
    return order;
  } catch (err) {
    log(`❌ BUY error: ${JSON.stringify(err)}`);
  }
}

// 📌 Prodaja
async function sell(symbol, qty) {
  if (!LIVE) return log(`🟡 TEST MODE SELL ${symbol}`);

  try {
    await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: qty,
    });

    log(`🔴 SELL EXECUTED ${symbol}`);
  } catch (err) {
    log(`❌ SELL error: ${JSON.stringify(err)}`);
  }
}

// 📌 Glavni loop
async function loop() {
  for (const symbol of PAIRS) {
    const price = await getPrice(symbol);
    if (!price) continue;

    log(`⏱  ${symbol}: ${price}`);

    const pos = positions[symbol];

    // ——— Ako nemamo aktivnu poziciju → KUPI ———
    if (!pos) {
      const order = await buy(symbol, price);
      if (order) {
        positions[symbol] = {
          entry: price,
          qty: order.fills
            ? parseFloat(order.fills[0].qty)
            : TRADE_AMOUNT_USDC / price,
          peak: price,
        };
      }
      continue;
    }

    // ——— Ako već imamo poziciju → prati cijenu ———
    pos.peak = Math.max(pos.peak, price);

    const gain = (price - pos.entry) / pos.entry;
    const dropFromPeak = (pos.peak - price) / pos.peak;

    // ✔ STOP-LOSS zaštita
    if (gain <= -STOP_LOSS) {
      log(`🛑 STOP-LOSS triggered on ${symbol}`);
      await sell(symbol, pos.qty);
      delete positions[symbol];
      continue;
    }

    // ✔ TAKE-PROFIT normalan
    if (gain >= TAKE_PROFIT) {
      if (dropFromPeak >= TRAILING) {
        log(`📉 TRAILING TAKE PROFIT triggered on ${symbol}`);
        await sell(symbol, pos.qty);
        delete positions[symbol];
      }
    }
  }
}

log("🤖 ULTIMATE BOT pokrenut...");
log(`Live trading: ${LIVE}`);
log(`Trading parovi: ${PAIRS.join(", ")}`);

setInterval(loop, 5000); // svakih 5 sekundi
