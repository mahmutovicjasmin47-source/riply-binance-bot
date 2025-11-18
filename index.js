import Binance from 'binance-api-node';

const client = Binance({
  apiKey: process.env.BINANCE_KEY,
  apiSecret: process.env.BINANCE_SECRET
});

async function main() {
  console.log("Bot radi ✔");

  try {
    const price = await client.prices({ symbol: process.env.SYMBOL });
    console.log("Cijena:", price);
  } catch (err) {
    console.error("Greška:", err);
  }
}

main();
