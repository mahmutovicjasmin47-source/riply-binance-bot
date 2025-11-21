import 'dotenv/config';
import Binance from 'binance-api-node';

const client = Binance.default({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// simple health check
console.log("Bot started...");

// basic loop
async function loop() {
  try {
    const prices = await client.prices();
    console.log("Current prices:", prices.BTCUSDT);
  } catch (err) {
    console.error("Error:", err);
  }
}

setInterval(loop, 5000);
