// index.js
require('dotenv').config();
const Binance = require('binance-api-node').default;
const http = require('http');

// ====== ENV ======
const API_KEY    = process.env.BINANCE_API_KEY || process.env.API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET || process.env.API_SECRET;
if (!API_KEY || !API_SECRET) { console.error('[FATAL] Missing API keys'); process.exit(1); }

const SYMBOL  = (process.env.SYMBOL || 'BTCUSDC').toUpperCase();
const LIVE    = (process.env.LIVE_TRADING || 'true').toLowerCase() === 'true';

// ► Kompoundiranje: stavi 1.0 za 100% uloženog kapitala (sav slobodni USDC)
const POS_PCT = Math.max(0, Math.min(1, Number(process.env.POSITION_SIZE_PCT || '1.0')));

// ► Adaptivni TP između 1.5% i 2.4% (po defaultu)
const TP_MIN_PCT = Number(process.env.TP_MIN_PCT || '1.5');
const TP_MAX_PCT = Number(process.env.TP_MAX_PCT || '2.4');

// ► Fiksni SL (hard-stop) – radi kao “sigurnosni pod” dok trailing ne preuzme
const SL_PCT      = Number(process.env.STOP_LOSS_PCT   || '0.40');

// ► Trailing stop: kad profit pređe TRAIL_START_PCT, SL počinje pratiti cijenu s TRAIL_PCT
const USE_TRAIL       = (process.env.USE_TRAIL || 'true').toLowerCase()==='true';
const TRAIL_START_PCT = Number(process.env.TRAIL_START_PCT || '0.60'); // kad smo +0.6%, “naoružaj” trailing
const TRAIL_PCT       = Number(process.env.TRAIL_PCT       || '0.40'); // zaostajanje SL-a = 0.4% ispod vrha

// Dnevna pravila
const DAILY_TARGET_PCT   = Number(process.env.DAILY_TARGET_PCT || '10'); // ti želiš 10% dnevno
const NO_NEG_DAY         = (process.env.NO_NEGATIVE_DAY || 'false').toLowerCase() === 'true'; // ti želiš false
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || '7', 10); // 7 ulaza/dan

// Telegram (opciono)
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
const ALERTS   = (!!TG_TOKEN && !!TG_CHAT);

// ====== Client ======
const client = Binance({ apiKey: API_KEY, apiSecret: API_SECRET });

// ====== Helpers ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pct = (a,b) => ((a-b)/b)*100;

async function sendAlert(msg) {
  try {
    if (!ALERTS) return;
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: TG_CHAT, text: String(msg) }) });
  } catch {}
}

let filters=null;
async function loadFilters() {
  const ex = await client.exchangeInfo();
  const s = ex.symbols.find(x=>x.symbol===SYMBOL);
  if(!s) throw new Error(`Symbol ${SYMBOL} not found`);
  const lot  = s.filters.find(f=>f.filterType==='LOT_SIZE');
  const tick = s.filters.find(f=>f.filterType==='PRICE_FILTER');
  const noti = s.filters.find(f=>['NOTIONAL','MIN_NOTIONAL'].includes(f.filterType));
  filters = {
    stepSize: Number(lot.stepSize),
    minQty: Number(lot.minQty),
    tickSize: Number(tick.tickSize),
    minNotional: noti ? Number(noti.minNotional || noti.notional) : 10
  };
}

function roundStep(q, step){ const p = Math.floor(q/step)*step; return Number(p.toFixed(8)); }
function roundTick(p, tick){ const r = Math.round(p/tick)*tick; return Number(r.toFixed(8)); }

async function getPrice(){
  const t = await client.prices({ symbol: SYMBOL });
  return Number(t[SYMBOL]);
}

async function balances() {
  const acc = await client.accountInfo();
  const quote = SYMBOL.endsWith('USDC') ? 'USDC' : SYMBOL.slice(-4);
  const base = SYMBOL.replace(quote,'');
  const get = (a)=> Number(acc.balances.find(b=>b.asset===a)?.free || 0);
  return { base, quote, freeBase:get(base), freeQuote:get(quote) };
}

async function klines(interval, limit) {
  const ks = await client.candles({ symbol: SYMBOL, interval, limit });
  return ks.map(k=>({ h:Number(k.high), l:Number(k.low), c:Number(k.close) }));
}
const sma = (arr,n)=> arr.slice(-n).reduce((s,x)=>s+x,0)/n;

function stdev(arr){
  const m = sma(arr, arr.length);
  const v = arr.reduce((s,x)=>s+(x-m)*(x-m),0)/arr.length;
  return Math.sqrt(v);
}

// ====== State ======
let inPosition=false, entryPrice=0, posQty=0;
let highestSinceEntry=0;
let lastPlacedSL=0, lastPlacedTP=0;
let lastOcoTs=0;
let cooldownUntil=0;
let todayPnlPct=0;
let tradesToday=0;
let lastDayKey = new Date().toISOString().slice(0,10); // YYYY-MM-DD UTC

function maybeResetDay() {
  const dayKey = new Date().toISOString().slice(0,10);
  if (dayKey !== lastDayKey) {
    lastDayKey = dayKey;
    todayPnlPct = 0;
    tradesToday = 0;
    cooldownUntil = 0;
    console.log('\n[DAY] Reset dnevnih metrika (UTC).');
    sendAlert('📆 Novi dan: reset metrika.');
  }
}

async function calcAdaptiveTpPct(){
  // Volatilnost po 1m svijećama → adaptivni TP između TP_MIN_PCT i TP_MAX_PCT
  const m1 = await klines('1m', 30);
  if (m1.length < 10) return TP_MIN_PCT;
  const rets = [];
  for (let i=1;i<m1.length;i++){
    const r = Math.abs(pct(m1[i].c, m1[i-1].c));
    rets.push(r);
  }
  const vol = stdev(rets);               // “dnevna” mikro-volatilnost u %
  const clamp = (x,a,b)=> Math.max(a, Math.min(b, x));
  const k = clamp(vol*3, TP_MIN_PCT, TP_MAX_PCT); // mapiraj volatilnija tržišta prema višem TP-u
  return Number(k.toFixed(2));
}

async function cancelAllSells(){
  const open = await client.openOrders({ symbol: SYMBOL });
  for (const o of open) if (o.side==='SELL'){
    await client.cancelOrder({ symbol: SYMBOL, orderId: o.orderId });
    await sleep(120);
  }
}

async function placeOCO(tpPrice, slPrice, qty){
  const tp = roundTick(tpPrice, filters.tickSize);
  const sl = roundTick(slPrice, filters.tickSize);
  const slLim = roundTick(sl*0.999, filters.tickSize);

  await client.orderOco({
    symbol:SYMBOL, side:'SELL', quantity: String(qty),
    price:String(tp), stopPrice:String(sl), stopLimitPrice:String(slLim),
    stopLimitTimeInForce:'GTC'
  });
  lastPlacedSL = sl;
  lastPlacedTP = tp;
  lastOcoTs = Date.now();
  console.log(`[OCO] TP ${tp} | SL ${sl} (qty ${qty})`);
  await sendAlert(`🎯 OCO postavljen (TP ${tp}, SL ${sl})`);
}

function dayGuardsActive(){
  if (DAILY_TARGET_PCT > 0 && todayPnlPct >= DAILY_TARGET_PCT) {
    console.log(`[GUARD] Dnevni target dosegnut +${todayPnlPct.toFixed(3)}% (target ${DAILY_TARGET_PCT}%). Pauza do sutra.`);
    return true;
  }
  if (NO_NEG_DAY && todayPnlPct < 0) {
    console.log(`[GUARD] No-Red-Day aktivan (${todayPnlPct.toFixed(3)}%). Pauza do sutra.`);
    return true;
  }
  if (tradesToday >= MAX_TRADES_PER_DAY) {
    console.log(`[GUARD] Max trades/dan (${tradesToday}/${MAX_TRADES_PER_DAY}). Pauza do sutra.`);
    return true;
  }
  return false;
}

// ====== Ulaz: brzi breakout + trend filter ======
async function entrySignal(){
  const m1 = await klines('1m', 25);
  const m5 = await klines('5m', 25);
  if (m1.length<21 || m5.length<21) return false;

  const m1c = m1.map(x=>x.c), m5c = m5.map(x=>x.c);
  const m1s5=sma(m1c,5), m1s20=sma(m1c,20);
  const m5s5=sma(m5c,5), m5s20=sma(m5c,20);
  const lastClose = m1c[m1c.length-1];
  const prevHigh  = m1[m1.length-2].h;

  return (lastClose > prevHigh * 1.0002) && (m1s5 > m1s20) && (m5s5 > m5s20);
}

async function tryEnter(){
  if (Date.now()<cooldownUntil) return;
  if (dayGuardsActive()) return;

  const ok = await entrySignal();
  if (!ok) return;

  const { freeQuote } = await balances();
  const price = await getPrice();
  let spend = freeQuote * POS_PCT;
  if (spend < filters.minNotional) { console.log('[INFO] premalo quote'); return; }

  let q = spend/price; q = Math.max(filters.minQty, roundStep(q, filters.stepSize));
  if (q*price < filters.minNotional) return;

  // Kupovina
  if (!LIVE){
    inPosition=true; entryPrice=price; posQty=q;
    highestSinceEntry = entryPrice;
    tradesToday++;
    const tpPct = await calcAdaptiveTpPct();
    const tpPrice = entryPrice*(1 + tpPct/100);
    const slPrice = entryPrice*(1 - SL_PCT/100);
    await cancelAllSells();
    return await placeOCO(tpPrice, slPrice, posQty);
  }

  try{
    const buy = await client.order({ symbol:SYMBOL, side:'BUY', type:'MARKET', quantity:String(q) });
    const fillP = buy.fills?.length
      ? buy.fills.reduce((s,f)=>s+Number(f.price)*Number(f.qty),0) / buy.fills.reduce((s,f)=>s+Number(f.qty),0)
      : price;
    inPosition=true; entryPrice=fillP; posQty=Number(buy.executedQty);
    highestSinceEntry = entryPrice;
    tradesToday++;
    console.log(`[BUY] qty=${posQty} @ ${entryPrice}`);
    await sendAlert(`🟢 BUY ${SYMBOL} qty=${posQty} @ ${entryPrice}`);

    const tpPct = await calcAdaptiveTpPct();               // adaptivni cilj 1.5–2.4%
    const tpPrice = entryPrice*(1 + tpPct/100);
    const slPrice = entryPrice*(1 - SL_PCT/100);           // početni hard-stop
    await cancelAllSells();
    await placeOCO(tpPrice, slPrice, posQty);
  }catch(e){
    console.error('[BUY ERROR]', e.body||e.message||e);
  }
}

async function manageTrailing(currentPrice){
  if (!USE_TRAIL || !inPosition || posQty<=0) return;
  // Ažuriraj najvišu cijenu
  if (currentPrice > highestSinceEntry) highestSinceEntry = currentPrice;

  const upPct = pct(currentPrice, entryPrice);
  if (upPct < TRAIL_START_PCT) return; // nije “naoružan” još

  // Trailing SL = X% ispod dosadašnjeg vrha (ali nikad ispod ulaza + minimalnog SL “poda”)
  const trailSL = Math.max(
    entryPrice*(1 - SL_PCT/100),
    highestSinceEntry*(1 - TRAIL_PCT/100)
  );

  // Ako je novi SL značajno viši od zadnjeg postavljenog → rearm OCO (ne češće od 10s)
  if (trailSL > lastPlacedSL*(1+0.0005) && (Date.now()-lastOcoTs)>10_000){
    const tpPct = await calcAdaptiveTpPct(); // osvježi TP unutar 1.5–2.4% po aktualnoj vol.
    const newTP = Math.max(currentPrice, entryPrice)*(1 + tpPct/100);

    await cancelAllSells();
    await placeOCO(newTP, trailSL, posQty);
    console.log(`[TRAIL] upPct=${upPct.toFixed(2)}% | newSL=${trailSL.toFixed(4)} | newTP=${newTP.toFixed(4)}`);
    await sendAlert(`🟡 TRAIL adj SL→${trailSL.toFixed(2)} TP→${newTP.toFixed(2)} (${upPct.toFixed(2)}%)`);
  }
}

async function poll(){
  try{
    maybeResetDay();

    const p = await getPrice();
    process.stdout.write(`\r[Heartbeat] ${SYMBOL}: ${p}`);

    if (inPosition && entryPrice>0){
      await manageTrailing(p);

      // provjera zatvaranja (ako nema više base -> zatvoreno TP ili SL)
      const { freeBase } = await balances();
      if (freeBase < filters.minQty/2){
        const exitPrice = p;
        const pnl = pct(exitPrice, entryPrice); // aproksimacija
        todayPnlPct += pnl;
        console.log(`\n[CLOSE] PnL=${pnl.toFixed(3)}% | Daily=${todayPnlPct.toFixed(3)}% | Trades=${tradesToday}`);
        await sendAlert(`✅ CLOSE ${SYMBOL} PnL=${pnl.toFixed(3)}% | Daily=${todayPnlPct.toFixed(3)}% | Trades=${tradesToday}`);
        inPosition=false; entryPrice=0; posQty=0; highestSinceEntry=0; lastPlacedSL=0; lastPlacedTP=0;

        if (dayGuardsActive()) return;
        cooldownUntil = Date.now() + 20_000; // kratki cooldown
      }
    } else {
      await tryEnter();
    }
  } catch(e){
    console.error('\n[LOOP ERROR]', e.body||e.message||e);
  }
}

// ====== Boot ======
(async()=>{
  console.log('[ENV] SYMBOL:',SYMBOL);
  console.log('[ENV] LIVE:',LIVE);
  console.log('[ENV] POS%:', Math.round(POS_PCT*100), ' | TP range:', TP_MIN_PCT,'–',TP_MAX_PCT, '% | SL:', SL_PCT, '%');
  console.log('[ENV] TRAIL start:',TRAIL_START_PCT,'%', 'lag:',TRAIL_PCT,'% | DailyTarget:',DAILY_TARGET_PCT,'% | NoRedDay:',NO_NEG_DAY,'| MaxTrades:',MAX_TRADES_PER_DAY);
  await loadFilters();
  setInterval(poll, 2500);
  await sendAlert(`🤖 Start ${SYMBOL} | POS ${Math.round(POS_PCT*100)}% | TP ${TP_MIN_PCT}–${TP_MAX_PCT}% | SL ${SL_PCT}% | Trail ${TRAIL_START_PCT}%/${TRAIL_PCT}% | Target ${DAILY_TARGET_PCT}% | Max ${MAX_TRADES_PER_DAY}/dan`);
})();

// ====== Keep-alive for Railway ======
http.createServer((req,res)=>res.end('Bot running')).listen(process.env.PORT||8080);

// Safety: restart on hard errors so Railway relaunches
process.on('uncaughtException', async (e)=>{ await sendAlert('⛔ uncaught: '+(e?.message||e)); process.exit(1); });
