/* ========= riply multi-asset bot =========
 * Exchange: Binance (spot)
 * Client:   binance-api-node
 * Features:
 *  - Multi-symbol (BTC/ETH/BNB vs USDC)
 *  - Target weights (rebalance) 50/30/20
 *  - Dynamic trailing SL + TP per trade (random in range)
 *  - Daily guards: target %, no-negative-day, max trades
 *  - 100% reinvest (compound)
 *  - Uses existing holdings (sells/buys to reach targets)
 * ======================================== */

require('dotenv').config();
const Binance = require('binance-api-node').default;
const http = require('http');

const API_KEY    = process.env.BINANCE_API_KEY || process.env.API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET || process.env.API_SECRET;
if (!API_KEY || !API_SECRET) { console.error('[FATAL] Missing API keys'); process.exit(1); }

const LIVE  = (process.env.LIVE_TRADING || 'true').toLowerCase() === 'true';

// ---- portfolio & risk ----
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDC,ETHUSDC,BNBUSDC')
  .split(',').map(s => s.trim().toUpperCase());

const TARGET_W = {
  BTCUSDC: Number(process.env.TARGET_W_BTC || '0.50'), // 50%
  ETHUSDC: Number(process.env.TARGET_W_ETH || '0.30'), // 30%
  BNBUSDC: Number(process.env.TARGET_W_BNB || '0.20')  // 20%
};

// raspon TP (%) po trejdu (npr. 1.5–2.4)
const TP_MIN = Number(process.env.TP_MIN_PCT || '1.5');
const TP_MAX = Number(process.env.TP_MAX_PCT || '2.4');

// trailing stop (dinamički) – koliki “korak” spoilujemo iza cijene
const TRAIL_PCT = Number(process.env.TRAIL_PCT || '0.6'); // 0.6% iza high-a

// fallback “hard” SL ako trailing ne uhvati
const HARD_SL_PCT = Number(process.env.HARD_SL_PCT || '0.35');

// koliki dio slobodnog USDC-a koristimo po ulasku (0–1)
const POSITION_SIZE_PCT = Math.max(0, Math.min(1, Number(process.env.POSITION_SIZE_PCT || '0.50')));

// dnevne zaštite
const DAILY_TARGET_PCT = Number(process.env.DAILY_TARGET_PCT || '3');   // npr. 3% dnevno
const NO_NEG_DAY       = (process.env.NO_NEGATIVE_DAY || 'true').toLowerCase() === 'true';
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || '12', 10);

// rebalance
const REBALANCE_EVERY_SEC   = parseInt(process.env.REBALANCE_EVERY_SEC || '600', 10); // svakih 10 min
const REBALANCE_TOLERANCE_P = Number(process.env.REBALANCE_TOLERANCE_P || '3'); // dopušteno odstupanje od cilja

// --- client ---
const client = Binance({ apiKey: API_KEY, apiSecret: API_SECRET });

// --- helpers ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pct = (a,b) => ((a-b)/b)*100;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

let filters = {}; // per-symbol

async function loadFilters() {
  const ex = await client.exchangeInfo();
  for (const sym of SYMBOLS) {
    const s = ex.symbols.find(x => x.symbol === sym);
    if (!s) throw new Error(`Symbol ${sym} not found`);
    const lot  = s.filters.find(f=>f.filterType==='LOT_SIZE');
    const tick = s.filters.find(f=>f.filterType==='PRICE_FILTER');
    const noti = s.filters.find(f=>['NOTIONAL','MIN_NOTIONAL'].includes(f.filterType));
    filters[sym] = {
      stepSize: Number(lot.stepSize),
      minQty: Number(lot.minQty),
      tickSize: Number(tick.tickSize),
      minNotional: noti ? Number(noti.minNotional || noti.notional) : 10
    };
  }
}
const roundStep = (q, step)=> Number((Math.floor(q/step)*step).toFixed(8));
const roundTick = (p, tick)=> Number((Math.round(p/tick)*tick).toFixed(8));

async function price(sym){
  const t = await client.prices({ symbol: sym });
  return Number(t[sym]);
}
async function account() {
  const acc = await client.accountInfo();
  const get = (a)=> Number(acc.balances.find(b=>b.asset===a)?.free || 0);
  const map = {};
  for (const sym of SYMBOLS) {
    const quote = sym.endsWith('USDC') ? 'USDC' : sym.slice(-4);
    const base  = sym.replace(quote,'');
    map[sym] = { base, quote, freeBase:get(base), freeQuote:get(quote) };
  }
  // ukupni USDC
  map.USDC = get('USDC');
  return map;
}

// --- day state ---
let dayKey = new Date().toISOString().slice(0,10);
let todayPnlPct = 0;
let tradesToday = 0;

function maybeResetDay() {
  const k = new Date().toISOString().slice(0,10);
  if (k !== dayKey) {
    dayKey = k; todayPnlPct = 0; tradesToday = 0;
    console.log('\n[DAY] Reset metrika.');
  }
}
function dayGuard() {
  if (DAILY_TARGET_PCT>0 && todayPnlPct >= DAILY_TARGET_PCT) return '[GUARD] daily target hit';
  if (NO_NEG_DAY && todayPnlPct < 0) return '[GUARD] no-negative-day active';
  if (tradesToday >= MAX_TRADES_PER_DAY) return '[GUARD] max trades/day';
  return '';
}

// --- trailing state per symbol ---
const pos = {};
for (const s of SYMBOLS) pos[s] = { in:false, qty:0, entry:0, trailTop:0, tpPct:0 };

// choose TP in [TP_MIN, TP_MAX]
const pickTP = ()=> Number((TP_MIN + Math.random()*(TP_MAX-TP_MIN)).toFixed(2));

// --- trading logic ---
async function enter(sym){
  const guard = dayGuard(); if (guard) return;

  const info = await account();
  const p = await price(sym);
  const { stepSize, minQty, minNotional } = filters[sym];

  const freeUSDC = info.USDC;
  let spend = freeUSDC * POSITION_SIZE_PCT;
  if (spend < minNotional) return; // premalo

  let qty = spend / p;
  qty = Math.max(minQty, roundStep(qty, stepSize));
  if (qty * p < minNotional) return;

  if (!LIVE) {
    console.log(`[DRY BUY ${sym}] qty=${qty} @${p}`);
  } else {
    try {
      const buy = await client.order({ symbol: sym, side:'BUY', type:'MARKET', quantity:String(qty) });
      const fillP = buy.fills?.length
        ? buy.fills.reduce((s,f)=>s+Number(f.price)*Number(f.qty),0)/buy.fills.reduce((s,f)=>s+Number(f.qty),0)
        : p;
      pos[sym].qty   = Number(buy.executedQty);
      pos[sym].entry = fillP;
      pos[sym].in    = true;
      pos[sym].trailTop = fillP;            // start trailing
      pos[sym].tpPct = pickTP();            // random TP
      tradesToday++;
      console.log(`[BUY ${sym}] qty=${pos[sym].qty} @${pos[sym].entry} | TP=${pos[sym].tpPct}% trail=${TRAIL_PCT}%`);
    } catch (e) {
      console.error('[BUY ERROR]', e.body||e.message||e);
      return;
    }
  }

  // Place OCO for hard TP/SL as backup (trailing će raditi ručno u petlji)
  await placeOCO(sym, pos[sym].entry, pos[sym].qty, pos[sym].tpPct, HARD_SL_PCT);
}

async function placeOCO(sym, entry, qty, tpPct, slPct) {
  try {
    const f = filters[sym];
    const tp = roundTick(entry*(1+tpPct/100), f.tickSize);
    const sl = roundTick(entry*(1-slPct/100), f.tickSize);
    const slLim = roundTick(sl*0.999, f.tickSize);
    if (!LIVE) { console.log(`[OCO ${sym}] TP ${tp} | SL ${sl} | qty ${qty}`); return; }
    await client.orderOco({
      symbol:sym, side:'SELL', quantity:String(qty),
      price:String(tp), stopPrice:String(sl), stopLimitPrice:String(slLim),
      stopLimitTimeInForce:'GTC'
    });
  } catch (e) {
    console.log('[OCO WARN]', sym, e.body||e.message||e);
  }
}

async function pollPositions(){
  for (const sym of SYMBOLS) {
    const p = await price(sym);
    process.stdout.write(`\r[Heartbeat] ${sym}: ${p}   `);

    // trailing SL logika
    if (pos[sym].in) {
      pos[sym].trailTop = Math.max(pos[sym].trailTop, p);
      const trailStop = pos[sym].trailTop * (1 - TRAIL_PCT/100);

      // close by trailing?
      if (p <= trailStop) {
        await closeMarket(sym, p, 'TRAIL');
      } else {
        // close by TP % (soft check)
        const up = pct(p, pos[sym].entry);
        if (up >= pos[sym].tpPct) {
          await closeMarket(sym, p, 'TP');
        }
      }
    } else {
      await entry(sym);
    }
  }
}

async function closeMarket(sym, px, reason){
  try {
    const { stepSize, minQty } = filters[sym];
    const acc = await account();
    const qtyFree = acc[sym].freeBase;
    if (qtyFree < minQty/2) { pos[sym].in=false; return; }

    let qty = roundStep(qtyFree, stepSize);
    if (!LIVE) {
      console.log(`\n[DRY SELL ${sym}] qty=${qty} @~${px} reason=${reason}`);
    } else {
      await client.order({ symbol:sym, side:'SELL', type:'MARKET', quantity:String(qty) });
    }

    const pnl = pct(px, pos[sym].entry);
    todayPnlPct += pnl;
    pos[sym] = { in:false, qty:0, entry:0, trailTop:0, tpPct:0 };
    console.log(`\n[CLOSE ${sym}] reason=${reason} PnL=${pnl.toFixed(3)}% | Daily=${todayPnlPct.toFixed(3)}% | Trades=${tradesToday}`);

  } catch (e) {
    console.error('\n[SELL ERROR]', e.body||e.message||e);
  }
}

// --- rebalans (koristi postojeći kapital) ---
let lastReb = 0;
async function maybeRebalance(){
  const now = Date.now();
  if (now - lastReb < REBALANCE_EVERY_SEC*1000) return;
  lastReb = now;

  const acc = await account();
  // ukupna USDC vrijednost portfelja (USDC + vrijednost base)
  let totalUSDC = acc.USDC;
  const prices = {};
  for (const s of SYMBOLS) {
    prices[s] = await price(s);
    totalUSDC += acc[s].freeBase * prices[s];
  }
  if (totalUSDC <= 0) return;

  // cilj po simbolu
  for (const s of SYMBOLS) {
    const want = totalUSDC * TARGET_W[s];
    const have = acc[s].freeBase * prices[s]; // vrijednost u USDC
    const diffPct = pct(have, want);          // + znači imamo više od cilja
    if (Math.abs(diffPct) < REBALANCE_TOLERANCE_P) continue;

    // Ako imamo previše -> prodaj višak u USDC
    if (diffPct > 0) {
      const toSellUSDC = (have - want);
      const qty = roundStep(toSellUSDC / prices[s], filters[s].stepSize);
      if (qty * prices[s] >= filters[s].minNotional && qty >= filters[s].minQty) {
        if (!LIVE) console.log(`\n[REB SELL ${s}] qty=${qty}`);
        else await client.order({ symbol:s, side:'SELL', type:'MARKET', quantity:String(qty) });
      }
    } else { // premalo -> dokupimo iz USDC-a
      const needUSDC = (want - have);
      if (acc.USDC >= needUSDC) {
        const qty = roundStep(needUSDC / prices[s], filters[s].stepSize);
        if (qty * prices[s] >= filters[s].minNotional && qty >= filters[s].minQty) {
          if (!LIVE) console.log(`\n[REB BUY ${s}] qty=${qty}`);
          else await client.order({ symbol:s, side:'BUY', type:'MARKET', quantity:String(qty) });
        }
      }
    }
    await sleep(200);
  }
}

// --- main loop ---
async function loop(){
  try{
    maybeResetDay();

    const g = dayGuard();
    if (g) { process.stdout.write(`\r${g}`); return; }

    await pollPositions();
    await maybeRebalance();
  } catch(e){
    console.error('\n[LOOP ERROR]', e.body||e.message||e);
  }
}

// ---- boot ----
(async()=>{
  console.log('[ENV] LIVE:', LIVE);
  console.log('[ENV] SYMBOLS:', SYMBOLS.join(', '));
  console.log('[ENV] TARGET_W:', TARGET_W);
  console.log('[ENV] TP range %:', TP_MIN, '-', TP_MAX, '| trail %:', TRAIL_PCT, '| hard SL %:', HARD_SL_PCT);
  console.log('[ENV] POS % of USDC:', POSITION_SIZE_PCT);
  console.log('[ENV] Daily target %:', DAILY_TARGET_PCT, '| NoRedDay:', NO_NEG_DAY, '| MaxTrades:', MAX_TRADES_PER_DAY);
  console.log('[ENV] Rebalance each s:', REBALANCE_EVERY_SEC, '| tolerance %:', REBALANCE_TOLERANCE_P);

  await loadFilters();
  setInterval(loop, 2500);
})();
http.createServer((req,res)=>res.end('bot running')).listen(process.env.PORT||8080);
