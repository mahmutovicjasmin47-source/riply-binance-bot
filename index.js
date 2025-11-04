// ---------- RIPLY BINANCE SPOT BOT (CLEAN) ----------
// Radi na SPOT-u. Čita ENV promenljive:
//   BINANCE_API_KEY, BINANCE_API_SECRET  (obavezno)
// Dodatno (opciono):
//   SYMBOL=BTCUSDT
//   POSITION_SIZE_USDT=20
//   LIVE_TRADING=false
//   TAKE_PROFIT_PCT=0.006
//   STOP_LOSS_PCT=0.004
//   PORT=8080

import 'dotenv/config';
import http from 'http';
import * as BinanceImport from 'binance-api-node';

// ESM/CJS kompatibilnost – neke verzije vraćaju default, neke objekat:
const Binance = BinanceImport.default || BinanceImport;

// ---- Validacija ENV ----
const REQUIRED = ['BINANCE_API_KEY', 'BINANCE_API_SECRET'];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`❌ Nedostaje ENV varijabla: ${k}`);
    process.exit(1);
  }
}

// ---- Konfig ----
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const SYMBOL = (process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const POSITION_SIZE_USDT = Number(process.env.POSITION_SIZE_USDT || 20);
const LIVE_TRADING = String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true';
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || '0.006');
const STOP_LOSS_PCT   = Number(process.env.STOP_LOSS_PCT   || '0.004');

// ---- Pomocne ----
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const nowISO = () => new Date().toISOString();
const ok  = (m) => console.log(`✅ ${m}`);
const info= (m) => console.log(`ℹ️  ${m}`);
const warn= (m) => console.warn(`⚠️  ${m}`);
const err = (e, ctx='') => {
  const body = (e && (e.body || e.response || e.message)) || e;
  console.error(`❌ ${ctx} ${body ? JSON.stringify(body) : ''}`);
};

// ---- Keep-alive HTTP (Railway) ----
const PORT = Number(process.env.PORT || 8080);
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('riply-binance-bot alive\n');
}).listen(PORT, () => info(`[keep-alive] HTTP server listening on port ${PORT}`));

// ---- Utility: mala količina po trenutnoj cijeni ----
async function smallQty(symbol, quoteUSDT = 10) {
  const priceMap = await client.prices({ symbol });
  const price = Number(priceMap[symbol]);
  if (!price || !isFinite(price)) throw new Error(`Ne mogu dobiti cijenu za ${symbol}`);
  return (quoteUSDT / price).toFixed(6); // za BTC 6 decimala je ok
}

// ---- Dijagnostika konekcije / permisija ----
async function diagnostics() {
  try {
    await client.ping();
    await client.time();
    ok(`[heartbeat] ${nowISO()}`);

    const acc = await client.accountInfo({ recvWindow: 10000 });
    ok('Bot uspješno povezan na Binance API!');
    info(`canTrade=${acc.canTrade} makerCommission=${acc.makerCommission}`);

    // orderTest ne troši sredstva – provjerava SPOT permisije
    await client.orderTest({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'MARKET',
      quantity: await smallQty(SYMBOL, 10),
      recvWindow: 10000,
    });
    ok('orderTest (SPOT) prošao — permisije OK.');
  } catch (e) {
    err(e, 'Greška u dijagnostici:');
    throw e;
  }
}

// ---- Realni nalozi (samo kad LIVE_TRADING=true) ----
async function placeMarketOrder(side, quoteUSDT) {
  if (!LIVE_TRADING) {
    warn('LIVE_TRADING=false → preskačem stvarni order.');
    return;
  }
  try {
    const quantity = await smallQty(SYMBOL, quoteUSDT);
    const order = await client.order({
      symbol: SYMBOL,
      side,
      type: 'MARKET',
      quantity,
      recvWindow: 10000,
    });
    ok(`Order poslan: ${side} ${quantity} ${SYMBOL} (id=${order.orderId})`);
    return order;
  } catch (e) {
    err(e, 'Greška pri slanju MARKET naloga:');
    throw e;
  }
}

// ---- Glavna petlja (ovde ide tvoja strategija) ----
async function mainLoop() {
  while (true) {
    try {
      // TODO: ovde ubacujemo FAST/BALANCED/STRICT logiku signala.
      info(`[loop] Živ sam. SYMBOL=${SYMBOL} LIVE=${LIVE_TRADING} @ ${nowISO()}`);
      await sleep(60_000);
    } catch (e) {
      err(e, 'Greška u petlji:'); // npr. -2015 permissions, -1021 timestamp
      await sleep(10_000);
    }
  }
}

// ---- Start ----
(async () => {
  try {
    await diagnostics();
    mainLoop();
  } catch (e) {
    err(e, 'Fatalna greška pri startu:');
    process.exit(1);
  }
})();

process.on('SIGINT',  () => { info('SIGINT -> izlazim.');  process.exit(0); });
process.on('SIGTERM', () => { info('SIGTERM -> izlazim.'); process.exit(0); });
