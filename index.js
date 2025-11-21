import 'dotenv/config';
import Binance from 'binance-api-node';

const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,
  SYMBOL,
  POSITION_SIZE,
  TAKE_PROFIT_PCT,
  STOP_LOSS_PCT,
  TRAILING_STOP,
  TRAIL_OFFSET,
  TRAIL_STEP
} = process.env;

const client = Binance({
  apiKey: BINANCE_API_KEY,
  apiSecret: BINANCE_API_SECRET,
});

// -------------------------------
//  SIMPLE PRICE FETCH LOOP
// -------------------------------

async function getPrice() {
  try {
    const ticker = await client.prices({ symbol: SYMBOL });
    return parseFloat(ticker[SYMBOL]);
  } catch (err) {
    console.error("Greška pri dohvaćanju cijene:", err);
    return null;
  }
}

// -------------------------------
//   SIMPLE STRATEGY (PLACEHOLDER)
// -------------------------------

async function tradeLoop() {
  console.log("Bot pokrenut...");

  while (true) {
    const price = await getPrice();

    if (!price) {
      console.log("Nema cijene, preskačem ciklus...");
      await new Promise(r => setTimeout(r, 4000));
      continue;
    }

    console.log(`Cijena ${SYMBOL}: ${price}`);

    // >>> Ovdje ide tvoja logika kupovine / prodaje <<<
    // >>> Za sada je minimalna verzija da bot radi bez grešaka <<<

    await new Promise(r => setTimeout(r, 5000));
  }
}

tradeLoop();
