import 'dotenv/config';
import Binance from 'binance-api-node';

// CONNECT CLIENT
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET
});

async function startBot() {
  console.log("Bot pokrenut...");

  try {
    const account = await client.accountInfo();
    console.log("USPEŠNO POVEZANO SA BINANCE ✔️");
    console.log("Balans:", account.balances);

  } catch (error) {
    console.error("GREŠKA:", error);
  }
}

startBot();
