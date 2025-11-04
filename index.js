// RIPLY BINANCE SPOT — ROBUST ESM/CJS LOADER (fix za "Binance is not a function")
import 'dotenv/config';
import http from 'http';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ---- Robusno učitavanje binance-api-node (ESM/CJS kompat) ----
let BinanceFactory;
try {
  const mod = await import('binance-api-node');               // ESM pokušaj
  BinanceFactory =
    (mod && typeof mod.default === 'function') ? mod.default :
    (typeof mod === 'function') ? mod :
    (mod && typeof mod.Binance === 'function') ? mod.Binance : null;
} catch {
  const mod = require('binance-api-node');                     // CJS fallback
  BinanceFactory =
    (mod && typeof mod.default === 'function') ? mod.default :
    (typeof mod === 'function') ? mod :
    (mod && typeof mod.Binance === 'function') ? mod.Binance : null;
}

if (!BinanceFactory) {
  console.error('❌ Ne mogu dobiti Binance factory iz paketa. Provjeri verziju "binance-api-node".');
  console.error('Savjet: u package.json ostavi "binance-api-node": "^0.12.5" i Node >= 18.');
  // Ne gasim proces – server će ostati živ da vidiš log.
}

// ---- ENV ----
const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error('❌ Nedostaju BINANCE_API_KEY / BINANCE_API_SECRET u ENV.');
}

// ---- Keep-alive HTTP (Railway) ----
const PORT = Number(process.env.PORT || 8080);
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('riply-binance-bot alive\n');
}).listen(PORT, () => console.log(`ℹ️ keep-alive na portu ${PORT}`));

// ---- Ako je factory pronađen, kreiraj klijenta i uradi minimalnu dijagnostiku ----
async function start() {
  if (!BinanceFactory) {
    console.error('⚠️  Preskačem Binance pozive jer factory nije pronađen.');
    return;
  }
  const client = BinanceFactory({ apiKey, apiSecret });

  try {
    await client.ping();
    await client.time();
    const acc = await client.accountInfo({ recvWindow: 10000 });
    console.log('✅ Povezan na Binance. canTrade=', acc.canTrade);
  } catch (e) {
    console.error('❌ Konekcija/perm greška:', e.body || e.message || e);
  }

  setInterval(() => {
    console.log('💓 heartbeat', new Date().toISOString());
  }, 60_000);
}

start();

process.on('SIGINT',  () => { console.log('SIGINT');  process.exit(0); });
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0); });
