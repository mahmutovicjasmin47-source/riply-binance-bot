// ===== ENV & CLIENT =====
require('dotenv').config();
const Binance = require('binance-api-node').default;

const API_KEY = process.env.BINANCE_API_KEY || process.env.API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET || process.env.API_SECRET;
if (!API_KEY || !API_SECRET) {
  console.error("[ERROR] Missing API key/secret env vars.");
  process.exit(1);
}

const client = Binance({ apiKey: API_KEY, apiSecret: API_SECRET });

// ===== CONFIG =====
const SYMBOL = (process.env.SYMBOL || 'BTCUSDC').toUpperCase();
const LIVE = String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true';

// %. Primjeri: 0.9 => 0.9%
const TP_PCT = Number(process.env.TAKE_PROFIT_PCT || '0.9');   // take profit
const SL_PCT = Number(process.env.STOP_LOSS_PCT || '0.4');     // stop loss
const POSITION_PCT = Number(process.env.POSITION_SIZE_PCT || '0.9'); // 90% kapitala

// Agresivna zaštita
const MOVE_BE_AT = 0.35;   // +0.35% -> pomjeri SL na BE + 0.05%
const BE_OFFSET = 0.05;    // +0.05% iznad ulaza
const TRAIL_ON_AT = 0.7;   // +0.7% -> uključi trailing
const TRAIL_GAP = 0.25;    // trailing udaljenost 0.25%

// Opće
const HEARTBEAT_MS = 3000;
const COOLDOWN_MS = 2 * 60 * 1000;

// ===== STATE =====
let filters = null;
let inPosition = false;
let entryPrice = null;
let qty = null;
let lastActionTs = 0;
let trailingActive = false;

// ===== HELPERS =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function loadFilters() {
  const info = await client.exchangeInfo();
  const s = info.symbols.find(x => x.symbol === SYMBOL);
  if (!s) throw new Error(`Symbol ${SYMBOL} not found on exchange`);
  const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
  const price = s.filters.find(f => f.filterType === 'PRICE_FILTER');
  const notional = s.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
  filters = {
    stepSize: Number(lot.stepSize),
    minQty: Number(lot.minQty),
    tickSize: Number(price.tickSize),
    minNotional: notional ? Number(notional.minNotional) : 10
  };
}

function roundStep(x, step) {
  const p = Math.round(x / step) * step;
  return Number(p.toFixed(8));
}

function roundPrice(p) {
  const tick = filters.tickSize;
  const res = Math.floor(p / tick) * tick;
  return Number(res.toFixed(8));
}

function pct(a, b) {
  return ((a - b) / b) * 100;
}

async function getBalances() {
  const acc = await client.accountInfo();
  const freeUSDC = Number(acc.balances.find(b => b.asset === 'USDC')?.free || 0);
  const freeBTC  = Number(acc.balances.find(b => b.asset === 'BTC')?.free || 0);
  return { freeUSDC, freeBTC };
}

async function getOpenOrders() {
  const orders = await client.openOrders({ symbol: SYMBOL });
  return orders;
}

async function getPrice() {
  const t = await client.prices({ symbol: SYMBOL });
  return Number(t[SYMBOL]);
}

async function klines(interval, limit) {
  const ks = await client.candles({ symbol: SYMBOL, interval, limit });
  return ks.map(k => Number(k.close));
}

function sma(arr, n) {
  if (arr.length < n) return null;
  const s = arr.slice(-n).reduce((a,b)=>a+b,0);
  return s / n;
}

async function upTrendSignal() {
  const m1 = await klines('1m', 25);
  const m5 = await klines('5m', 25);
  const m1s5 = sma(m1, 5),  m1s20 = sma(m1, 20);
  const m5s5 = sma(m5, 5),  m5s20 = sma(m5, 20);
  return (m1s5 && m1s20 && m5s5 && m5s20) && (m1s5 > m1s20) && (m5s5 > m5s20);
}

// Cancel all open sell orders (helper for trailing / BE move)
async function cancelAllSells() {
  const open = await getOpenOrders();
  for (const o of open) {
    if (o.side === 'SELL') {
      await client.cancelOrder({ symbol: SYMBOL, orderId: o.orderId });
      await sleep(300);
    }
  }
}

async function placeOCOTakeProfitStop(q, entry) {
  const price = await getPrice();

  const tpPrice = roundPrice(entry * (1 + TP_PCT / 100));
  const stopPrice = roundPrice(entry * (1 - SL_PCT / 100));
  const stopLimitPrice = roundPrice(stopPrice * 0.999); // mali buffer

  // Binance zahtijeva količinu u ispravnom stepu
  const qRounded = Math.max(filters.minQty, roundStep(q, filters.stepSize));

  if (!LIVE) {
    console.log(`[PAPER] OCO SELL -> qty ${qRounded}, TP ${tpPrice}, SL ${stopPrice}/${stopLimitPrice}`);
    return;
  }

  try {
    // orderOco je podržan u binance-api-node
    await client.orderOco({
      symbol: SYMBOL,
      side: 'SELL',
      quantity: qRounded.toFixed(8),
      price: tpPrice.toFixed(8),
      stopPrice: stopPrice.toFixed(8),
      stopLimitPrice: stopLimitPrice.toFixed(8),
      stopLimitTimeInForce: 'GTC'
    });
    console.log(`[OCO] Postavljen TP ${tpPrice} i SL ${stopPrice} (qty ${qRounded})`);
  } catch (err) {
    console.error('[OCO ERROR]', err.body || err.message || err);
  }
}

// Pomakni SL na break-even (+ offset) ili napravi trailing
async function adjustProtection(entry, mode) {
  const price = await getPrice();
  if (mode === 'BE') {
    const beStop = roundPrice(entry * (1 + BE_OFFSET / 100));
    const beStopLimit = roundPrice(beStop * 0.999);
    await cancelAllSells();
    await client.orderOco({
      symbol: SYMBOL,
      side: 'SELL',
      quantity: qty.toFixed(8),
      price: roundPrice(entry * (1 + TP_PCT / 100)).toFixed(8),
      stopPrice: beStop.toFixed(8),
      stopLimitPrice: beStopLimit.toFixed(8),
      stopLimitTimeInForce: 'GTC'
    });
    console.log(`[BE] SL pomjeren na ${beStop}`);
  } else if (mode === 'TRAIL') {
    const trailStop = roundPrice(price * (1 - TRAIL_GAP / 100));
    const trailStopLimit = roundPrice(trailStop * 0.999);
    await cancelAllSells();
    await client.orderOco({
      symbol: SYMBOL,
      side: 'SELL',
      quantity: qty.toFixed(8),
      price: roundPrice(entry * (1 + TP_PCT / 100)).toFixed(8), // TP ostaje
      stopPrice: trailStop.toFixed(8),
      stopLimitPrice: trailStopLimit.toFixed(8),
      stopLimitTimeInForce: 'GTC'
    });
    console.log(`[TRAIL] SL sada prati (${TRAIL_GAP}%) -> ${trailStop}`);
  }
}

// ===== MAIN LOOP =====
async function main() {
  console.log(`[BOT] Start | LIVE=${LIVE} | SYMBOL=${SYMBOL}`);
  await loadFilters();

  // Inicijalno stanje pozicije
  const { freeBTC } = await getBalances();
  inPosition = freeBTC > filters.minQty;
  if (inPosition) {
    entryPrice = Number((await client.myTrades({ symbol: SYMBOL, limit: 1 }))[0]?.price) || (await getPrice());
    qty = freeBTC;
    console.log(`[STATE] Već u poziciji: qty=${qty} entry≈${entryPrice}`);
  }

  while (true) {
    try {
      const price = await getPrice();
      console.log(`[Heartbeat] ${SYMBOL}: ${price.toFixed(2)}`);

      // Ako smo u poziciji, prati zaštite
      if (inPosition && entryPrice) {
        const prof = pct(price, entryPrice);

        if (!trailingActive && prof >= MOVE_BE_AT) {
          await adjustProtection(entryPrice, 'BE');
        }
        if (prof >= TRAIL_ON_AT) {
          trailingActive = true;
          await adjustProtection(entryPrice, 'TRAIL');
        }

        // Provjera da li je pozicija zatvorena (nema više BTC)
        const { freeBTC: f } = await getBalances();
        if (f < filters.minQty / 2) {
          inPosition = false;
          entryPrice = null;
          qty = null;
          trailingActive = false;
          lastActionTs = Date.now();
          console.log('[STATE] Pozicija zatvorena. Cooldown...');
        }
      }

      // Ako nismo u poziciji, traži signal za ulaz
      if (!inPosition && Date.now() - lastActionTs > COOLDOWN_MS) {
        const goLong = await upTrendSignal();
        if (goLong) {
          const { freeUSDC } = await getBalances();
          let spend = freeUSDC * Math.max(0, Math.min(1, POSITION_PCT));
          if (spend < filters.minNotional) {
            console.log(`[INFO] Premalo USDC (${freeUSDC}) za minNotional ${filters.minNotional}`);
          } else {
            const p = price;
            let q = spend / p;
            q = Math.max(filters.minQty, roundStep(q, filters.stepSize));

            if (!LIVE) {
              console.log(`[PAPER BUY] qty=${q}, price=${p}`);
              inPosition = true;
              entryPrice = p;
              qty = q;
              await placeOCOTakeProfitStop(q, entryPrice);
            } else {
              try {
                const buy = await client.order({
                  symbol: SYMBOL,
                  side: 'BUY',
                  type: 'MARKET',
                  quantity: q.toFixed(8),
                });
                inPosition = true;
                entryPrice = Number(buy.fills?.[0]?.price) || p;
                qty = Number(buy.executedQty);
                console.log(`[BUY] qty=${qty} @ ${entryPrice}`);
                await placeOCOTakeProfitStop(qty, entryPrice);
              } catch (err) {
                console.error('[BUY ERROR]', err.body || err.message || err);
              }
            }
          }
        }
      }

    } catch (e) {
      console.error('[LOOP ERROR]', e.body || e.message || e);
    }
    await sleep(HEARTBEAT_MS);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
