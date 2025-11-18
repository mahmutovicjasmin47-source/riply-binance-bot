import Binance from 'binance-api-node';

const client = Binance({
  apiKey: process.env.BINANCE_KEY,
  apiSecret: process.env.BINANCE_SECRET,
});

async function main() {
  console.log("Bot radi ✔");
  
  const price = await client.prices({ symbol: process.env.SYMBOL });
  console.log("Cijena:", price);
}

main();
