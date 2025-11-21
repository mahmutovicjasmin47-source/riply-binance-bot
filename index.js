import 'dotenv/config';
import { default as Binance } from 'binance-api-node';

// KONEKCIJA NA BINANCE
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// GLAVNA FUNKCIJA
async function start() {
  console.log("Bot pokrenut...");

  try {
    // Primjer provjere balansa
    const balances = await client.accountInfo();
    console.log("BALANS:", balances.balances);

    // Primjer kupovine (NEĆE kupiti bez tvog poziva)
    /*
    await client.order({
      symbol: 'BTCUSDC',
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.0001,
    });
    */

  } catch (err) {
    console.error("Greška:", err);
  }
}

start();
