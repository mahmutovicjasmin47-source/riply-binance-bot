import { Spot } from '@binance/connector';
import dotenv from 'dotenv';
dotenv.config();

const client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);

// PETLJA ZA TEST — stabilno radi svakih 2 sekunde
async function loop() {
  try {
    const response = await client.tickerPrice('BTCUSDT');
    console.log("BTC:", response.data.price);
  } catch (err) {
    console.error("Greška:", err.message);
  }

  setTimeout(loop, 2000);
}

console.log("✅ Bot pokrenut...");
loop();
