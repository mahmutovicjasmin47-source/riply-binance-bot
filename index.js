require('dotenv').config();
const Binance = require('binance-api-node').default;

// --- Binance klient ---
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// --- Konfig iz ENV ---
const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const POSITION_SIZE_USDT = parseFloat(process.env.POSITION_SIZE_USDT || '10');
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '0.4');
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || '0.6');
const LIVE_TRADING = (process.env.LIVE_TRADING || 'false') === 'true';

// --- Glavna funkcija ---
async function trade() {
  try {
    const prices = await client.prices();
    const currentPrice = parseFloat(prices[SYMBOL]);
    if (!currentPrice) {
      console.log(`⚠️ Nema cijene za ${SYMBOL} još...`);
      return;
    }

    console.log(`📊 ${SYMBOL} = ${currentPrice}`);

    const sl = currentPrice * (1 - STOP_LOSS_PCT / 100);
    const tp = currentPrice * (1 + TAKE_PROFIT_PCT / 100);

    console.log(`📉 SL: ${sl.toFixed(2)} | 📈 TP: ${tp.toFixed(2)}`);

    if (LIVE_TRADING) {
      await client.order({
        symbol: SYMBOL,
        side: 'BUY',
        type: 'MARKET',
        quoteOrderQty: POSITION_SIZE_USDT,
      });
      console.log(`✅ Kupljeno za ${POSITION_SIZE_USDT} USDT (${SYMBOL})`);
    } else {
      console.log('🔎 Simulacija (LIVE_TRADING=false) – bez naloga.');
    }
  } catch (err) {
    console.error('❌ Greška:', err?.message || err);
  }
}

// Pokreći na 15s
setInterval(trade, 15000);
console.log('🤖 Bot pokrenut...');

// --- VAŽNO: HTTP keep-alive da Railway ne gasi servis ---
const http = require('http');
const PORT = process.env.PORT || 8080;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
  })
  .listen(PORT, () => console.log(`🌐 Keep-alive na portu ${PORT}`));
