import dotenv from "dotenv";
dotenv.config();

import Binance from "binance-api-node";

// Konekcija na Binance API
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

async function main() {
  console.log("Bot radi ✔");

  try {
    // Cijena BTCUSDC
    const price = await client.prices({ symbol: "BTCUSDC" });
    console.log("Cijena BTCUSDC:", price.BTCUSDC);
  } catch (err) {
    console.error("Greška:", err.message);
  }
}

main();
