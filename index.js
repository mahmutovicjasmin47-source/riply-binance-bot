// ====== Aggressive Daily Target Scalper (Spot BTCUSDC) ======
require('dotenv').config();
const Binance = require('binance-api-node').default;
const http = require('http');

// ====== ENV ======
const API_KEY    = process.env.BINANCE_API_KEY || process.env.API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET || process.env.API_SECRET;
if (!API_KEY || !API_SECRET) { console.error('[FATAL] Missing API keys'); process.exit(1); }

const SYMBOL  = (process.env.SYMBOL || 'BTCUSDC').toUpperCase();
const LIVE    = (process.env.LIVE_TRADING || 'true').toLowerCase() === 'true';

// % vrijednosti (npr. "0.4" = 0.4%)
const TP_PCT  = Number(process.env.TAKE_PROFIT_PCT || '0.4');
const SL_PCT  = Number(process.env.STOP_LOSS_PCT   || '0.25');
const POS_PCT = Math.max(0, Math.min(1, Number(process.env.POSITION_SIZE_PCT || '0.35')));

// Dnevna pravila
const DAILY_TARGET_PCT = Number(process.env.DAILY_TARGET_PCT || '0.6'); // stop kad dosegne target
const NO_NEG_DAY       = (process.env.NO_NEGATIVE_DAY || 'true').toLowerCase() === 'true';
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || '12', 10);

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
  return ks.map(k=>({ h:Number(k.high), c:Number(k.close) }));
}
const sma = (arr,n)=> arr.slice(-n).reduce((s,x)=>s+x,0)/n;

// ====== State ======
let inPosition=false, entryPrice=0, posQty=0;
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

// ====== Strategy (aggressive breakout + trend confirm) ======
async function entrySignal(){
  const m1 = await klines('1m', 25);
  const m5 = await klines('5m', 25);
  if (m1.length<21 || m5.length<21) return false;

  const m1c = m1.map(x=>x.c), m5c = m5.map(x=>x.c);
  const m1s5=sma(m1c,5), m1s20=sma(m1c,20);
  const m5s5=sma(m5c,5), m5s20=sma(m5c,20);
  const lastClose = m1c[m1c.length-1];
  const prevHigh  = m1[m1.length-2].h;

  // brzi breakout + uptrend filteri
  return (lastClose > prevHigh * 1.0002) && (m1s5 > m1s20) && (m5s5 > m5s20);
}

async function cancelAllSells(){
  const open = await client.openOrders({ symbol: SYMBOL });
  for (const o of open) if (o.side==='SELL'){
    await client.cancelOrder({ symbol: SYMBOL, orderId: o.orderId });
    await sleep(120);
  }
}

async function placeOCO(entry, qty){
  const tp = roundTick(entry*(1+TP_PCT/100), filters.tickSize);
  const sl = roundTick(entry*(1-SL_PCT/100), filters.tickSize);
  const slLim = roundTick(sl*0.999, filters.tickSize);

  await client.orderOco({
    symbol:SYMBOL, side:'SELL', quantity: String(qty),
    price:String(tp), stopPrice:String(sl), stopLimitPrice:String(slLim),
    stopLimitTimeInForce:'GTC'
  });
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

  if (!LIVE){
    console.log(`[DRY BUY] qty=${q} @~${price}`);
    inPosition=true; entryPrice=price; posQty=q;
    tradesToday++;
    return await placeOCO(entryPrice, posQty);
  }

  try{
    const buy = await client.order({ symbol:SYMBOL, side:'BUY', type:'MARKET', quantity:String(q) });
    const fillP = buy.fills?.length
      ? buy.fills.reduce((s,f)=>s+Number(f.price)*Number(f.qty),0) / buy.fills.reduce((s,f)=>s+Number(f.qty),0)
      : price;
    inPosition=true; entryPrice=fillP; posQty=Number(buy.executedQty);
    tradesToday++;
    console.log(`[BUY] qty=${posQty} @ ${entryPrice}`);
    await sendAlert(`🟢 BUY ${SYMBOL} qty=${posQty} @ ${entryPrice}`);
    await placeOCO(entryPrice, posQty);
  }catch(e){
    console.error('[BUY ERROR]', e.body||e.message||e);
  }
}

async function poll(){
  try{
    maybeResetDay();

    const p = await getPrice();
    process.stdout.write(`\r[Heartbeat] ${SYMBOL}: ${p}`);

    if (inPosition && entryPrice>0){
      // provjera zatvaranja (ako nema više base -> zatvoreno TP ili SL)
      const { freeBase } = await balances();
      if (freeBase < filters.minQty/2){
        const exitPrice = p;
        const pnl = pct(exitPrice, entryPrice); // aproksimacija
        todayPnlPct += pnl;
        console.log(`\n[CLOSE] PnL=${pnl.toFixed(3)}% | Daily=${todayPnlPct.toFixed(3)}% | Trades=${tradesToday}`);
        await sendAlert(`✅ CLOSE ${SYMBOL} PnL=${pnl.toFixed(3)}% | Daily=${todayPnlPct.toFixed(3)}% | Trades=${tradesToday}`);
        inPosition=false; entryPrice=0; posQty=0;

        // Ako smo target pogodili ili smo ispod nule (No-Red-Day), stani do sutra
        if (dayGuardsActive()) return;

        // inače kratak cooldown da ne skače odmah nazad
        cooldownUntil = Date.now() + 20_000;
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
  console.log('[ENV] TP/SL:', TP_PCT, SL_PCT, ' POS:', POS_PCT);
  console.log('[ENV] DailyTarget:', DAILY_TARGET_PCT, '% | NoRedDay:', NO_NEG_DAY, '| MaxTrades:', MAX_TRADES_PER_DAY);
  await loadFilters();
  setInterval(poll, 2500);
  await sendAlert(`🤖 Start ${SYMBOL} | TP ${TP_PCT}% | SL ${SL_PCT}% | POS ${Math.round(POS_PCT*100)}% | Target ${DAILY_TARGET_PCT}% | Max ${MAX_TRADES_PER_DAY}/dan`);
})();

// ====== Keep-alive for Railway ======
http.createServer((req,res)=>res.end('Bot running')).listen(process.env.PORT||8080);

// Safety: restart on hard errors so Railway relaunches
process.on('uncaughtException', async (e)=>{ await sendAlert('⛔ uncaught: '+(e?.message||e)); process.exit(1); });
process.on('unhandledRejection', async (e)=>{ await sendAlert('⛔ unhandled: '+(e?.message||e)); process.exit(1); });
