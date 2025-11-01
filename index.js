import Binance from 'binance-api-node';
import dotenv from 'dotenv';

dotenv.config();

const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

async function startBot() {
  console.log('Bot je pokrenut...');

  const prices = await client.prices();
  console.log('BTC/USDT cijena je:', prices.BTCUSDT);

  // primjer kupovine
  // await client.order({
  //   symbol: 'BTCUSDT',
  //   side: 'BUY',
  //   type: 'MARKET',
  //   quantity: 0.001,
  // });
}

startBot();
