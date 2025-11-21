import { Spot } from '@binance/connector';
import dotenv from 'dotenv';
dotenv.config();

// Napravi Binance klijenta
const client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);

/**
 * Test: čitanje BTC cijene svake 2 sekunde
 */
async function loop() {
  try {
    const result = await client.tickerPrice('BTCUSDT');
    console.log("BTC:", result.data.price);
  } catch (err) {
    console.error("Greška:", err.message);
  }

  setTimeout(loop, 2000);
}

console.log("✅ Bot pokrenut...");
loop();
