import Binance from 'binance';
import dotenv from 'dotenv';
dotenv.config();

const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

/**
 * Jednostavno: svake 2 sekunde čita BTC cijenu.
 * To je test da bot radi stabilno.
 * Poslije ti ubacim trading logiku (1% dnevno), ali prvo stabilnost!
 */
async function loop() {
  try {
    const price = await client.prices('BTCUSDT');
    console.log("BTC:", price.BTCUSDT);
  } catch (err) {
    console.error("Greška:", err);
  }

  setTimeout(loop, 2000);
}

console.log("✅ Bot pokrenut...");
loop();
