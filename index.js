import BinanceImport from 'binance-api-node';
import dotenv from 'dotenv';
dotenv.config();

// ako je potreban .default, koristi ga automatski
const Binance = BinanceImport.default ? BinanceImport.default : BinanceImport;
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET
});

// test da sve radi
client.time().then(time => {
  console.log("✅ Bot uspješno povezan na Binance API!");
  console.log("Server vrijeme:", time);
}).catch(err => {
  console.error("❌ Greška pri konekciji:", err.message);
});
