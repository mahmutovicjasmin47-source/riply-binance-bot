// ===== ENV & CLIENT =====
require('dotenv').config();
const Binance = require('binance-api-node').default;

const client = Binance({
  apiKey: process.env.API_KEY,
  apiSecret: process.env.API_SECRET,
});

// ===== KONFIG =====
const SYMBOL = process.env.SYMBOL || 'BTCUSDC';     // par (ti koristiš BTC/USDC)
const LIVE   = (process.env.LIVE_TRADING || 'true') === 'true';

// 90% balansa, TP 0.9%, SL 0.4%
const INVEST_PCT = 0.90;
const TAKE_PROFIT_PCT = 0.009; // +0.9%
const STOP_LOSS_PCT   = 0.004; // -0.4%

// ===== POMOĆNE =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getFilters(symbol) {
  const info = await client.exchangeInfo();
  const s = info.symbols.find(x => x.symbol === symbol);
  if (!s) throw new Error(`Symbol not found: ${symbol}`);
  const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
  const tick = s.filters.find(f => f.filterType === 'PRICE_FILTER');
  const minNot = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');

  const stepSize   = Number(lot.stepSize);
  const tickSize   = Number(tick.tickSize);
  const minQty     = Number(lot.minQty);
  const minNotional= minNot ? Number(minNot.minNotional) : 0;

  const roundStep = (qty) => Math.floor(qty / stepSize) * stepSize + 0;
  const roundTick = (p)   => Math.round(p / tickSize) * tickSize + 0;

  return { stepSize, tickSize, minQty, minNotional, roundStep, roundTick };
}

async function getBalances() {
  const acc = await client.accountInfo();
  const base = SYMBOL.slice(0, SYMBOL.length - 4); // "BTCUSDC" -> "BTC"
  const quote = SYMBOL.slice(-4);                  // "USDC"

  const b = (asset) => Number((acc.balances.find(x => x.asset === asset)?.free) || 0);
  return { baseFree: b(base), quoteFree: b(quote), base, quote };
}

async function getPrice() {
  const p = await client.prices({ symbol: SYMBOL });
  return Number(p[SYMBOL]);
}

// ===== GLAVNA TRGOVINA (jedan ulaz + OCO TP/SL) =====
async function tradeOnce() {
  try {
    const { roundStep, roundTick, minQty, minNotional } = await getFilters(SYMBOL);
    const { baseFree, quoteFree, base, quote } = await getBalances();
    const price = await getPrice();

    console.log(`[INFO] ${SYMBOL} price: ${price}`);
    console.log(`[BAL]  ${base}: ${baseFree}, ${quote}: ${quoteFree}`);

    // Iznos za kupovinu = 90% QUOTE balansa
    const spend = quoteFree * INVEST_PCT;
    if (spend <= 0) return console.log('[SKIP] Nema quote balansa.');

    // Koliko BTC kupujemo
    let qty = spend / price;
    qty = roundStep(qty);

    if (qty < minQty) return console.log(`[SKIP] Qty ispod minQty (${qty} < ${minQty}).`);
    if (spend < minNotional) return console.log(`[SKIP] Notional ispod minimalnog (${spend} < ${minNotional}).`);

    if (!LIVE) {
      console.log(`[PAPER] BUY ${qty} ${base} @ ~${price}`);
      return;
    }

    // Market BUY
    console.log(`[ORDER] MARKET BUY ${qty} ${base}`);
    const buy = await client.order({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'MARKET',
      quantity: qty.toFixed(8)
    });

    // Cijena ulaza (prosjek)
    const fillPrice = buy.fills?.length
      ? buy.fills.reduce((s, f) => s + Number(f.price) * Number(f.qty), 0) /
        buy.fills.reduce((s, f) => s + Number(f.qty), 0)
      : price;

    // Izračun TP/SL
    const tpPrice = roundTick(fillPrice * (1 + TAKE_PROFIT_PCT));
    const slPrice = roundTick(fillPrice * (1 - STOP_LOSS_PCT));
    const stopLimitPrice = roundTick(slPrice * 0.999); // mrvu ispod stop-a

    console.log(`[TP/SL] TP: ${tpPrice} (+0.9%), SL: ${slPrice} (-0.4%)`);

    // Pokušaj OCO SELL za TP i SL
    try {
      await client.orderOco({
        symbol: SYMBOL,
        side: 'SELL',
        quantity: qty.toFixed(8),
        price: tpPrice.toString(),
        stopPrice: slPrice.toString(),
        stopLimitPrice: stopLimitPrice.toString(),
        stopLimitTimeInForce: 'GTC'
      });
      console.log('[ORDER] OCO SELL postavljen (TP + SL).');
    } catch (e) {
      // Ako OCO nije dozvoljen na paru, fallback: prvo SL, pa TP (oprezno!)
      console.log('[WARN] OCO nije dostupan, stavljam odvojeno SL i TP.');
      await client.order({
        symbol: SYMBOL,
        side: 'SELL',
        type: 'STOP_LOSS_LIMIT',
        stopPrice: slPrice.toString(),
        price: stopLimitPrice.toString(),
        timeInForce: 'GTC',
        quantity: qty.toFixed(8)
      });
      await client.order({
        symbol: SYMBOL,
        side: 'SELL',
        type: 'LIMIT',
        price: tpPrice.toString(),
        timeInForce: 'GTC',
        quantity: qty.toFixed(8)
      });
      console.log('[ORDER] LIMIT TP i STOP_LIMIT SL postavljeni.');
    }

  } catch (err) {
    console.error('[ERROR]', err.message || err);
  }
}

// ===== KEEP-ALIVE & POVREMENI IZVJEŠTAJ =====
(async () => {
  console.log(`[ENV] SYMBOL: ${SYMBOL}`);
  console.log(`[ENV] LIVE_TRADING: ${LIVE}`);
  console.log('[BOT] Pokrećem…');

  // Jedan ulaz odmah (možeš po želji promijeniti u periodične ulaze)
  await tradeOnce();

  // Keep-alive log (Railway ne gasi kontejner)
  while (true) {
    try {
      const p = await getPrice();
      process.stdout.write(`\r[Heartbeat] ${SYMBOL}: ${p}`);
    } catch {}
    await sleep(15000);
  }
})();
