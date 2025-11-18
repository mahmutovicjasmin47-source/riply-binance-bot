import pkg from 'binance-api-node';

// uzmi default ako postoji, ili cijeli modul
const Binance = pkg.default || pkg;

const client = Binance({
  apiKey: process.env.BINANCE_KEY,
  apiSecret: process.env.BINANCE_SECRET
});

async function main() {
  console.log("Bot radi ✔");

  try {
    const symbol = process.env.SYMBOL || 'BTCUSDC';
    const price = await client.prices({ symbol });
    console.log(`Cijena za ${symbol}:`, price[symbol]);
  } catch (err) {
    console.error("Greška:", err);
  }
}

main();
