// MINIMAL RIPLY BINANCE SPOT – STABILNA VERZIJA
import 'dotenv/config';
import http from 'http';
import * as BinanceImport from 'binance-api-node';
const Binance = BinanceImport.default || BinanceImport;

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;

if (!apiKey || !apiSecret) {
  console.error('❌ Nedostaju BINANCE_API_KEY ili BINANCE_API_SECRET u ENV.');
}

const client = Binance({ apiKey, apiSecret });

const PORT = Number(process.env.PORT || 8080);
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('riply-binance-bot alive\n');
}).listen(PORT, () => console.log(`ℹ️ keep-alive na portu ${PORT}`));

async function start() {
  try {
    await client.ping();
    await client.time();
    const acc = await client.accountInfo({ recvWindow: 10000 });
    console.log('✅ Povezan na Binance. canTrade=', acc.canTrade);
  } catch (e) {
    console.error('❌ Konekcija/perm error:', e.body || e.message || e);
  }

  // heartbeat petlja – nikad se ne gasi
  setInterval(() => {
    console.log('💓 heartbeat', new Date().toISOString());
  }, 60_000);
}

start();

// sigurno gašenje
process.on('SIGINT', () => { console.log('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0); });
