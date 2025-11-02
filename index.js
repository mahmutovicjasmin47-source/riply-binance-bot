import BinanceImport from 'binance-api-node';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

// Inicijalizacija Binance klijenta
const Binance = BinanceImport.default || BinanceImport;
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// Test konekcije sa Binance API
client.time()
  .then(time => {
    console.log("✅ Bot uspješno povezan na Binance API!");
    console.log("Server vrijeme:", time);
  })
  .catch(err => {
    console.error("❌ Greška pri konekciji sa Binance API:", err?.message || err);
  });

// --- Keep-alive HTTP server (za Railway) ---
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\n');
}).listen(PORT, () => {
  console.log(`[keep-alive] HTTP server listening on port ${PORT}`);
});

// --- Heartbeat log svake minute ---
setInterval(() => {
  console.log(`[heartbeat] ${new Date().toISOString()}`);
}, 60_000);
