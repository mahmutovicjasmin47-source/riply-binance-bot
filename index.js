// RIPLY BINANCE SPOT BOT — 24/7, 90% ALLOCATION, TP/SL (CommonJS)
require('dotenv').config();
const http = require('http');
const Binance = require('binance-api-node').default;

// === ENV ===
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const SYMBOL = (process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const LIVE_TRADING = String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true';
const POSITION_SIZE_USDT = Number(process.env.POSITION_SIZE_USDT || 10); // minimalno za test
const STOP_LOSS_PCT_RAW = Number(process.env.STOP_LOSS_PCT || 0.4);      // npr 0.4 = 0.4%
const TAKE_PROFIT_PCT_RAW = Number(process.env.TAKE_PROFIT_PCT || 0.6);  // npr 0.6 = 0.6%

// Pretvori vrijednosti: ako je >=1 tumači kao procenat (npr 0.6 -> 0.006 = 0.6%)
const pctToFrac = (v) => (v >= 1 ? v / 100 : v);
const SL = pctToFrac(STOP_LOSS_PCT_RAW);
const TP = pctToFrac(TAKE_PROFIT_PCT_RAW);

const RECV = 10000;               // recvWindow
const MIN_QUOTE = 5;              // minimalno ~$5 notional na SPOT-u
const ALLOC_FRAC = 0.90;          // 90% dostupnog USDT
let lastBuyPrice = null;          // pamti zadnju kupovnu cijenu (in-memory)

// === Util ===
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = {
  ok:  (m)=>console.log(`✅ ${m}`),
  i:   (m)=>console.log(`ℹ️  ${m}`),
  w:   (m)=>console.warn(`⚠️  ${m}`),
  err: (e,c='')=>console.error(`❌ ${c}`, e?.body || e?.message || e)
};

// Keep-alive server da Railway ne gasi kontejner
http.createServer((_,res)=>res.end('Bot radi')).listen(8080, ()=>log.i('keep-alive na portu 8080'));

// Vrati trenutnu cijenu simbola
async function getPrice(symbol) {
  const m = await client.prices({ symbol });
  return Number(m[symbol]);
}

// Zaokruživanje količine (BTC dozvoljava 6-8 decimala)
function roundQty(qty) {
  return Number(qty.toFixed(6));
}

// Stanje računa (USDT/BTC free)
async function getBalances() {
  const acc = await client.accountInfo({ recvWindow: RECV });
  const find = (asset) => Number((acc.balances.find(b => b.asset === asset)?.free) || 0);
  return {
    usdt: find('USDT'),
    btc:  find('BTC'),
    canTrade: acc.canTrade
  };
}

// Kupovina: uloži 90% dostupnog USDT-a (ili POSITION_SIZE_USDT ako želiš minimum)
async function buyIfNoPosition() {
  const { usdt, btc } = await getBalances();
  if (btc > 0.00001) return false; // već imamo poziciju

  // izračun količine
  const price = await getPrice(SYMBOL);
  const budget = Math.max(POSITION_SIZE_USDT, usdt * ALLOC_FRAC);
  if (budget < MIN_QUOTE) { log.w(`Premalo USDT (${usdt.toFixed(2)}) za kupovinu.`); return false; }

  const qty = roundQty(budget / price);
  if (!LIVE_TRADING) {
    log.i(`(TEST) KUPI ${qty} ${SYMBOL} (~${budget.toFixed(2)} USDT) @ ${price}`);
    lastBuyPrice = price;
    return true;
  }

  const order = await client.order({
    symbol: SYMBOL,
    side: 'BUY',
    type: 'MARKET',
    quantity: qty,
    recvWindow: RECV
  });
  // Prosječna kupovna cijena (ako nije direktno dostupna, koristi trenutnu)
  lastBuyPrice = price;
  log.ok(`Kupljeno ${qty} ${SYMBOL} (≈ ${budget.toFixed(2)} USDT) @ ~${price}`);
  return true;
}

// Prodaja cijele BTC pozicije pri TP/SL
async function sellIfHitTargets() {
  const { btc } = await getBalances();
  if (btc < 0.00001 || !lastBuyPrice) return false;

  const price = await getPrice(SYMBOL);
  const tpPrice = lastBuyPrice * (1 + TP);
  const slPrice = lastBuyPrice * (1 - SL);

  if (price >= tpPrice) {
    if (!LIVE_TRADING) {
      log.i(`(TEST) TAKE-PROFIT SELL ${btc} @ ${price} (TP ${((TP)*100).toFixed(2)}%)`);
      lastBuyPrice = null;
      return true;
    }
    const order = await client.order({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'MARKET',
      quantity: roundQty(btc),
      recvWindow: RECV
    });
    lastBuyPrice = null;
    log.ok(`TP prodaja ${btc} ${SYMBOL} @ ~${price}`);
    return true;
  }

  if (price <= slPrice) {
    if (!LIVE_TRADING) {
      log.i(`(TEST) STOP-LOSS SELL ${btc} @ ${price} (SL ${((SL)*100).toFixed(2)}%)`);
      lastBuyPrice = null;
      return true;
    }
    const order = await client.order({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'MARKET',
      quantity: roundQty(btc),
      recvWindow: RECV
    });
    lastBuyPrice = null;
    log.ok(`SL prodaja ${btc} ${SYMBOL} @ ~${price}`);
    return true;
  }

  return false;
}

async function heartbeat() {
  try {
    await client.ping();
    await client.time();
    const { canTrade } = await getBalances();
    log.ok('Bot uspješno povezan na Binance API!');
    log.i(`LIVE_TRADING=${LIVE_TRADING} | canTrade=${canTrade} | SYMBOL=${SYMBOL}`);
  } catch (e) { log.err(e, 'Dijagnostika'); }
}

// Glavna petlja (svakih ~15s provjera)
async function loop() {
  while (true) {
    try {
      // 1) Ako nemamo poziciju, kupi 90% USDT
      const didBuy = await buyIfNoPosition();

      // 2) Ako imamo poziciju, provjeri TP/SL i prodaj 100% ako je ispunjeno
      const didSell = await sellIfHitTargets();

      // 3) Info
      const p = await getPrice(SYMBOL);
      log.i(`[${now()}] Price=${p} | lastBuy=${lastBuyPrice || '-'} | TP=${(TP*100).toFixed(2)}% | SL=${(SL*100).toFixed(2)}%`);

    } catch (e) {
      log.err(e, 'Greška u petlji');
    }
    await sleep(15000); // 15 sekundi
  }
}

// Start
(async () => {
  await heartbeat();
  loop();
})();

process.on('SIGINT',  ()=>{ log.i('SIGINT');  process.exit(0); });
process.on('SIGTERM', ()=>{ log.i('SIGTERM'); process.exit(0); });
