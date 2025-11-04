// ---------- RIPLY BINANCE SPOT BOT (clean) ----------
// Rad samo na SPOT-u. Čita ključeve iz ENV-a.
// BINANCE_API_KEY, BINANCE_API_SECRET su obavezni.
//
// Dodatne ENV varijable (opciono):
// SYMBOL=BTCUSDT
// POSITION_SIZE_USDT=20
// LIVE_TRADING=false         // ako postaviš true -> stvarni nalozi
// TAKE_PROFIT_PCT=0.006      // 0.6%
// STOP_LOSS_PCT=0.004        // 0.4%
// PORT=8080

import 'dotenv/config';
import http from 'http';
import Binance from 'binance-api-node';

const REQUIRED = ['BINANCE_API_KEY', 'BINANCE_API_SECRET'];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`❌ ENV varijabla nedostaje: ${k}`);
    process.exit(1);
  }
}

// --- Konfig ---
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const SYMBOL = (process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const POSITION_SIZE_USDT = Number(process.env.POSITION_SIZE_USDT || 20);
const LIVE_TRADING = String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true';

const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || '0.006');
const STOP_LOSS_PCT   = Number(process.env.STOP_LOSS_PCT   || '0.004');

// --- Pomoćne ---
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const nowISO = () => new Date().toISOString();

function logOk(msg)    { console.log(`✅ ${msg}`); }
function logInfo(msg)  { console.log(`ℹ️  ${msg}`); }
function logWarn(msg)  { console.warn(`⚠️  ${msg}`); }
function logErr(e, ctx = '') {
  const body = (e && (e.body || e.response || e.message)) || e;
  console.error(`❌ ${ctx} ${body ? JSON.stringify(body) : ''}`);
}

// --- Keep-alive HTTP (Railway) ---
const PORT = Number(process.env.PORT || 8080);
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('riply-binance-bot alive\n');
}).listen(PORT, () => logInfo(`[keep-alive] HTTP server listening on port ${PORT}`));

// --- Dijagnostika konekcije / permisija ---
async function diagnostics() {
  try {
    await client.ping();
    const t = await client.time();
    logOk(`[heartbeat] ${nowISO()}`);

    // Provjera account-a i permisija
    const acc = await client.accountInfo({ recvWindow: 10000 });
    logOk('Bot uspješno povezan na Binance API!');
    logInfo(`canTrade: ${acc.canTrade} | makerCommission: ${acc.makerCommission}`);

    // Test SPOT naloga (ne troši sredstva)
    await client.orderTest({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'MARKET',
      // Binance dopušta orderTest bez quantity/quoteOrderQty, ali mnogi nalozi traže jedan od ta dva.
      // Stoga uzmi malu količinu preko trenutne cijene.
      quantity: await smallQty(SYMBOL, 10), // ~10 USDT test
      recvWindow: 10000,
    });
    logOk('orderTest (SPOT) prošao — permisije OK.');

  } catch (e) {
    logErr(e, 'Greška u dijagnostici:');
    throw e;
  }
}

// Izračun male količine po trenutnoj cijeni
async function smallQty(symbol, quoteUSDT = 10) {
  const priceMap = await client.prices({ symbol });
  const price = Number(priceMap[symbol]);
  if (!price || !isFinite(price)) throw new Error(`Ne mogu dobiti cijenu za ${symbol}`);
  // Za BTC tipično 6 ili 5 decimala radi — za sigurnost 6 i trim trailing nule
  const qty = (quoteUSDT / price).toFixed(6);
  return qty;
}

// --- Glavna petlja (placeholder za tvoju strategiju) ---
async function mainLoop() {
  while (true) {
    try {
      // Ovdje bi išla tvoja logika signala (FAST/BALANCED/STRICT...)
      // Trenutno samo heartbeat na ~60s.
      logInfo(`[loop] Živ sam. SYMBOL=${SYMBOL} LIVE=${LIVE_TRADING} @ ${nowISO()}`);
      await sleep(60_000);
    } catch (e) {
      logErr(e, 'Greška u petlji:');
      // tipične API greške: -2015 (permissions), -1021 (timestamp)
      await sleep(10_000);
    }
  }
}

// --- (Opcionalno) Realni nalozi — aktiviraj samo ako postaviš LIVE_TRADING=true ---
async function placeMarketOrder(side, quoteUSDT) {
  if (!LIVE_TRADING) {
    logWarn('LIVE_TRADING=false → preskačem stvarni order.');
    return;
  }
  try {
    const qty = await smallQty(SYMBOL, quoteUSDT);
    const order = await client.order({
      symbol: SYMBOL,
      side,
      type: 'MARKET',
      quantity: qty,
      recvWindow: 10000,
    });
    logOk(`Order poslan: ${side} ${qty} ${SYMBOL} (id=${order.orderId})`);
    return order;
  } catch (e) {
    logErr(e, 'Greška pri slanju MARKET naloga:');
    throw e;
  }
}

// --- Start ---
(async () => {
  try {
    await diagnostics();     // provjera konekcije + permisija + orderTest
    mainLoop();              // pokreni glavnu petlju (signali/heartbeat)
  } catch (e) {
    logErr(e, 'Fatalna greška pri startu:');
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGINT', () => { logInfo('SIGINT -> izlazim.'); process.exit(0); });
process.on('SIGTERM', () => { logInfo('SIGTERM -> izlazim.'); process.exit(0); });
