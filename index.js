require('dotenv').config();
const Binance = require('binance-api-node').default;

// ✅ Rezervni unos API ključeva (ako Railway ne učita ENV)
const API_KEY = process.env.BINANCE_API_KEY?.trim() || 'fHTaDjB2LcS8oaEuADpOeg29AkDhPAsKJ7k9W7aD4kyuLxQ85WgL0V5vAV2dM';
const API_SECRET = process.env.BINANCE_API_SECRET?.trim() || 't3JOY3KKqux56WeVby0kQQYcpaM1112vjFIrPkryMqQoiOld11ZaSIKPI7INuJbR';

// ✅ Inicijalizacija Binance klijenta
const client = Binance({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  httpBase: 'https://api.binance.com',
  useServerTime: true,
  recvWindow: 60000
});

// ✅ Varijable okruženja
const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const POSITION_SIZE_USDT = parseFloat(process.env.POSITION_SIZE_USDT || '10');
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '0.4');
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || '0.6');
const LIVE_TRADING = process.env.LIVE_TRADING === 'true';

// ✅ Dijagnostika API ključa
(async () => {
  try {
    console.log('🔄 Testiram konekciju prema Binance API...');
    await client.ping();
    console.log('🌐 Ping OK — konekcija uspostavljena.');

    const account = await client.accountInfo();
    console.log('✅ API ključ validan. Bot ima pristup Binance računu.');
    console.log(`📊 Trading simbol: ${SYMBOL}`);
    console.log(`💰 Pozicija: ${POSITION_SIZE_USDT} USDT`);
    console.log(`🛑 Stop loss: ${STOP_LOSS_PCT}%`);
    console.log(`🎯 Take profit: ${TAKE_PROFIT_PCT}%`);
    console.log(`🧩 Live trading: ${LIVE_TRADING}`);

    tradeLoop();
  } catch (err) {
    console.error('❌ Greška u API dijagnostici!');
    console.error('Poruka:', err?.message || err);
    console.error('Kod:', err?.code || '');
    console.error('Napomena: Provjeri da API ključ i Secret nisu regenerisani.');
    process.exit(1);
  }
})();

// ✅ Glavna petlja
async function tradeLoop() {
  try {
    console.log('🚀 Bot uspješno pokrenut. Čeka signal...');
    const prices = await client.prices();
    console.log('📈 Trenutna cijena za', SYMBOL, ':', prices[SYMBOL]);
  } catch (error) {
    console.error('⚠️ Greška u tradeLoop:', error.message);
  }

  setTimeout(tradeLoop, 120000);
}
