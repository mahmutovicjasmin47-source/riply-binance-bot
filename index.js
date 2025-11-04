require('dotenv').config();
const Binance = require('binance-api-node').default;

// Učitaj varijable okruženja
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const POSITION_SIZE = parseFloat(process.env.POSITION_SIZE_USDT || 10);
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || 0.4);
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || 0.6);
const LIVE_TRADING = process.env.LIVE_TRADING === 'true';

async function trade() {
  try {
    console.log('✅ Bot uspješno povezan na Binance API!');
    const prices = await client.prices();
    console.log('📊 Trenutna cijena', SYMBOL, prices[SYMBOL]);

    // Ako je LIVE_TRADING true, možeš ubaciti logiku za kupovinu/prodaju ovdje
    if (LIVE_TRADING) {
      console.log(`🔁 Live trading aktivan za ${SYMBOL}`);
    } else {
      console.log('🧪 Test mode aktivan (bez pravih transakcija)');
    }
  } catch (err) {
    console.error('❌ Greška u petlji:', err.message);
  }
}

trade();
setInterval(trade, 60 * 1000); // pokreće svakih 60 sekundi
