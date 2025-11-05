require('dotenv').config();
const Binance = require('binance-api-node').default;

// Povezivanje sa Binance API
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET
});

// Učitavanje konfiguracije iz ENV
const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const POSITION_SIZE_USDT = parseFloat(process.env.POSITION_SIZE_USDT || '10');
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '0.4');
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || '0.6');
const LIVE_TRADING = process.env.LIVE_TRADING === "true";

async function trade() {
  try {
    console.log("✅ Bot povezan sa Binance API");

    const prices = await client.prices();
    const currentPrice = parseFloat(prices[SYMBOL]);

    console.log(`📊 Trenutna cijena ${SYMBOL}: ${currentPrice}`);

    // Logika pozicije
    const stopLossPrice = currentPrice * (1 - STOP_LOSS_PCT / 100);
    const takeProfitPrice = currentPrice * (1 + TAKE_PROFIT_PCT / 100);

    console.log(`📉 Stop Loss: ${stopLossPrice.toFixed(2)}`);
    console.log(`📈 Take Profit: ${takeProfitPrice.toFixed(2)}`);

    if (LIVE_TRADING) {
      console.log("🚀 *TRGOVANJE UKLJUČENO* (LIVE_TRADING=true)");

      await client.order({
        symbol: SYMBOL,
        side: 'BUY',
        type: 'MARKET',
        quoteOrderQty: POSITION_SIZE_USDT
      });

      console.log(`✅ Kupovina izvršena: ${POSITION_SIZE_USDT} USDT u ${SYMBOL}`);
    } else {
      console.log("🔎 Simulacija: LIVE_TRADING=false → ne kupujemo, samo pratimo.");
    }

  } catch (err) {
    console.error("❌ Greška u botu:", err.message || err);
  }
}

// Pokretanje bota u petlji
setInterval(trade, 15000); // radi svakih 15 sekundi
console.log("🤖 Bot pokrenut...");
