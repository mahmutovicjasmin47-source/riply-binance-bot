// index.js — RIPLY Binance BOT (SPOT)
// Radi s env varijablama: BINANCE_API_KEY, BINANCE_API_SECRET, SYMBOL, POSITION_SIZE_USDT, LIVE_TRADING
// Opcione env: TAKE_PROFIT_PCT (npr "0.006" = 0.6%), STOP_LOSS_PCT (npr "0.004" = 0.4%)

import BinanceImport from 'binance-api-node';
import http from 'http';

const Binance = BinanceImport.default ?? BinanceImport;

// ====== ENV ======
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const SYMBOL = (process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const POSITION_USDT = Number(process.env.POSITION_SIZE_USDT || '10');
const LIVE = String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true';

const TP_PCT = Number(process.env.TAKE_PROFIT_PCT || '0.006'); // 0.6%
const SL_PCT = Number(process.env.STOP_LOSS_PCT || '0.004');   // 0.4%

if (!API_KEY || !API_SECRET) {
  console.error('❌ Nedostaju BINANCE_API_KEY / BINANCE_API_SECRET');
  process.exit(1);
}

// ====== KLIJENT ======
const client = Binance({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
});

// ====== POMOĆNE ======
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function roundToStep(value, step) {
  const p = Math.round(value / step) * step;
  // fiksiraj plutajuću tačnost
  const dec = (step.toString().split('.')[1] || '').length;
  return Number(p.toFixed(dec));
}

async function getFilters() {
  const info = await client.exchangeInfo();
  const sym = info.symbols.find((s) => s.symbol === SYMBOL);
  if (!sym) throw new Error(`Symbol ${SYMBOL} nije pronađen na SPOT-u.`);
  const lot = sym.filters.find((f) => f.filterType === 'LOT_SIZE');
  const price = sym.filters.find((f) => f.filterType === 'PRICE_FILTER');
  return {
    stepSize: Number(lot.stepSize),
    minQty: Number(lot.minQty),
    tickSize: Number(price.tickSize),
  };
}

async function getLastPrice() {
  const t = await client.bookTicker({ symbol: SYMBOL });
  return Number(t.askPrice || t.price);
}

async function hasOpenOrders() {
  const oo = await client.openOrders({ symbol: SYMBOL });
  return (oo || []).length > 0;
}

// provjeri da li imamo aktivnu SPOT poziciju (drži kolicinu u assetu)
async function getFreeAssetQty() {
  const base = SYMBOL.replace('USDT', '');
  const acc = await client.accountInfo();
  const b = acc.balances.find((x) => x.asset === base);
  return b ? Number(b.free) : 0;
}

// ====== GLAVNA LOGIKA ======
async function tradeLoop() {
  try {
    // 0) Keep-alive heartbeat
    console.log(`[heartbeat] ${new Date().toISOString()}`);

    // 1) Ako postoje otvorene narudžbe – preskoči krug
    if (await hasOpenOrders()) {
      console.log('↺ Otvorene narudžbe postoje – čekam…');
      return;
    }

    const { stepSize, tickSize } = await getFilters();
    const price = await getLastPrice();

    // ako nemamo kolicinu u assetu -> KUPI
    const qtyFree = await getFreeAssetQty();
    if (qtyFree < stepSize) {
      const qtyRaw = POSITION_USDT / price;
      const qty = Math.max(roundToStep(qtyRaw, stepSize), stepSize);

      if (!LIVE) {
        console.log(`(DRY) BUY ${SYMBOL} qty=${qty}`);
        return;
      }

      console.log(`🟢 Market BUY ${SYMBOL} qty=${qty}`);
      const order = await client.order({
        symbol: SYMBOL,
        side: 'BUY',
        type: 'MARKET',
        quantity: qty.toString(),
      });

      // koristimo prosječnu cijenu iz fill-ova
      const filledPrice =
        order.fills?.length
          ? order.fills.reduce((s, f) => s + Number(f.price) * Number(f.qty), 0) /
            order.fills.reduce((s, f) => s + Number(f.qty), 0)
          : price;

      // postavi TP/SL kao OCO (sell)
      const tp = roundToStep(filledPrice * (1 + TP_PCT), tickSize);
      const sl = roundToStep(filledPrice * (1 - SL_PCT), tickSize);

      console.log(`📌 Postavljam OCO SELL: TP=${tp}, SL=${sl}`);
      await client.orderOco({
        symbol: SYMBOL,
        side: 'SELL',
        quantity: qty.toString(),
        price: tp.toString(),
        stopPrice: sl.toString(),
        stopLimitPrice: sl.toString(),
        stopLimitTimeInForce: 'GTC',
      });

      return;
    }

    // ako imamo kolicinu, pretpostavljamo da su TP/SL nalozi vec postavljeni (ili korisnik drži coin)
    console.log(`ℹ️ Pozicija postoji (${qtyFree}); čekam TP/SL ili ručno zatvaranje…`);
  } catch (err) {
    console.error('❌ Greška u petlji:', err?.message || err);
  }
}

// ====== STARTUP TEST ======
(async () => {
  try {
    await client.time(); // ping
    console.log('✅ Bot uspješno povezan na Binance API!');
    console.log('Server vrijeme:', (await client.time()).serverTime || Date.now());
  } catch (e) {
    console.error('❌ Greška pri konekciji:', e?.message || e);
    process.exit(1);
  }
})();

// ====== SCHEDULER (svakih 60 sekundi) ======
setInterval(tradeLoop, 60_000);
tradeLoop();

// ====== KEEP-ALIVE HTTP za Railway ======
const PORT = process.env.PORT || 3000;
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
  })
  .listen(PORT, () => {
    console.log(`[keep-alive] HTTP server listening on port ${PORT}`);
  });
