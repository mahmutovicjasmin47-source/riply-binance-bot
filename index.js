require('dotenv').config();
const Binance = require('binance-api-node').default;
const http = require('http');

const API_KEY    = process.env.BINANCE_API_KEY || process.env.API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET || process.env.API_SECRET;
if (!API_KEY || !API_SECRET) { console.error('[FATAL] Missing API keys'); process.exit(1); }

const SYMBOL  = (process.env.SYMBOL || 'BTCUSDC').toUpperCase();
const LIVE    = (process.env.LIVE_TRADING || 'true').toLowerCase() === 'true';

// rizik/profit
const TP_LOW  = Number(process.env.TP_LOW_PCT  || '1.2');  // % (donja granica)
const TP_HIGH = Number(process.env.TP_HIGH_PCT || '1.6');  // % (gornja – bira se po volatilnosti)
const SL_START= Number(process.env.SL_START_PCT|| '0.30'); // početni SL (% od cijene ulaza)
const TRAIL   = (process.env.TRAILING_STOP || 'true').toLowerCase()==='true';
const TRAIL_STEP = Number(process.env.TRAIL_STEP_PCT || '0.10'); // koliko svako podizanje SL

const POS_PCT = Math.max(0, Math.min(1, Number(process.env.POSITION_SIZE_PCT || '0.50')));

// dnevna pravila
const DAILY_TARGET_PCT   = Number(process.env.DAILY_TARGET_PCT || '3.5');
const NO_NEG_DAY         = (process.env.NO_NEGATIVE_DAY || 'true').toLowerCase()==='true';
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || '10', 10);

// klijent
const client = Binance({ apiKey: API_KEY, apiSecret: API_SECRET });

// util
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const pct = (a,b)=>((a-b)/b)*100;
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));

let filters=null;
async function loadFilters(){
  const ex = await client.exchangeInfo();
  const s = ex.symbols.find(x=>x.symbol===SYMBOL);
  if(!s) throw new Error(`Symbol ${SYMBOL} not found`);
  const lot  = s.filters.find(f=>f.filterType==='LOT_SIZE');
  const tick = s.filters.find(f=>f.filterType==='PRICE_FILTER');
  const noti = s.filters.find(f=>['NOTIONAL','MIN_NOTIONAL'].includes(f.filterType));
  filters = {
    stepSize:Number(lot.stepSize),
    minQty:Number(lot.minQty),
    tickSize:Number(tick.tickSize),
    minNotional:noti ? Number(noti.minNotional||noti.notional) : 10
  };
}
const roundStep=(q,step)=>Number((Math.floor(q/step)*step).toFixed(8));
const roundTick=(p,tick)=>Number((Math.round(p/tick)*tick).toFixed(8));

async function price(){ const t=await client.prices({symbol:SYMBOL}); return Number(t[SYMBOL]); }
async function balances(){
  const acc = await client.accountInfo();
  const quote = SYMBOL.endsWith('USDC') ? 'USDC' : SYMBOL.slice(-4);
  const base  = SYMBOL.replace(quote,'');
  const get = a => Number(acc.balances.find(b=>b.asset===a)?.free||0);
  return { base, quote, freeBase:get(base), freeQuote:get(quote) };
}
async function klines(interval,limit){
  const ks = await client.candles({ symbol:SYMBOL, interval, limit });
  return ks.map(k=>({ h:Number(k.high), l:Number(k.low), c:Number(k.close), v:Number(k.volume) }));
}
const sma=(arr,n)=>arr.slice(-n).reduce((s,x)=>s+x,0)/n;
const rsi=(closes, n=14)=>{
  if (closes.length<n+1) return 50;
  let gains=0,losses=0;
  for(let i=closes.length-n;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    if(d>0) gains+=d; else losses-=d;
  }
  const rs = losses===0 ? 100 : gains/losses;
  return 100 - (100/(1+rs));
};

// stanje
let inPos=false, entry=0, qty=0;
let trailSL=0, target=0;
let todayPnlPct=0, tradesToday=0, cooldownUntil=0;
let dayKey = new Date().toISOString().slice(0,10);

function resetDayIfNeeded(){
  const k = new Date().toISOString().slice(0,10);
  if (k!==dayKey){
    dayKey = k; todayPnlPct=0; tradesToday=0; cooldownUntil=0;
    console.log('\n[DAY] Reset dnevnih metrika.');
  }
}

function dayGuardActive(){
  if (DAILY_TARGET_PCT>0 && todayPnlPct>=DAILY_TARGET_PCT){
    console.log(`[GUARD] Dnevni target dosegnut +${todayPnlPct.toFixed(2)}%.`);
    return true;
  }
  if (NO_NEG_DAY && todayPnlPct<0){
    console.log(`[GUARD] No-Red-Day aktivan (${todayPnlPct.toFixed(2)}%).`);
    return true;
  }
  if (tradesToday>=MAX_TRADES_PER_DAY){
    console.log(`[GUARD] Max trades/dan (${tradesToday}/${MAX_TRADES_PER_DAY}).`);
    return true;
  }
  return false;
}

// izbor TP na osnovu volatilnosti (ATR-lite preko m1 high/low)
function selectTPpct(m1){
  const last20 = m1.slice(-20);
  const rng = last20.map(k=>k.h-k.l);
  const avg = rng.reduce((s,x)=>s+x,0)/rng.length;
  const lastClose = m1[m1.length-1].c;
  const volaPct = (avg/lastClose)*100; // ~ % prosječne svijeće
  // ako je volatilnije => malo viši TP, inače niži
  const t = clamp(TP_LOW + (TP_HIGH-TP_LOW)*(clamp(volaPct,0.3,1.0)-0.3)/(1.0-0.3), TP_LOW, TP_HIGH);
  return t;
}

async function entrySignal(){
  const m1 = await klines('1m', 40);
  const m5 = await klines('5m', 40);
  if (m1.length<25 || m5.length<25) return { ok:false };

  const c1 = m1.map(x=>x.c);
  const c5 = m5.map(x=>x.c);
  const ma1_5 = sma(c1,5), ma1_20=sma(c1,20);
  const ma5_5 = sma(c5,5), ma5_20=sma(c5,20);
  const last = c1[c1.length-1];
  const prevHigh = m1[m1.length-2].h;

  const upTrend = (ma1_5>ma1_20)&&(ma5_5>ma5_20);
  const breakout = last > prevHigh*1.0002;
  const r = rsi(c1,14);

  const ok = upTrend && breakout && r>48 && r<75; // ne previše overbought
  const tppct = selectTPpct(m1);
  return { ok, tppct };
}

async function cancelAllOrders(){
  try{
    const open = await client.openOrders({ symbol:SYMBOL });
    for(const o of open){ await client.cancelOrder({ symbol:SYMBOL, orderId:o.orderId }); await sleep(80); }
  }catch(e){}
}

async function placeProtectiveOCO(entryPx, q){
  const sl = roundTick(entryPx*(1 - SL_START/100), filters.tickSize);
  const tp = roundTick(entryPx*(1 + target/100),  filters.tickSize);
  const slLim = roundTick(sl*0.999, filters.tickSize);
  try{
    await client.orderOco({
      symbol:SYMBOL, side:'SELL', quantity:String(q),
      price:String(tp), stopPrice:String(sl), stopLimitPrice:String(slLim),
      stopLimitTimeInForce:'GTC'
    });
    trailSL = sl;
    console.log(`[OCO] TP ${tp} | SL ${sl} | qty ${q}`);
  }catch(e){ console.error('[OCO ERROR]', e.body||e.message||e); }
}

async function tryEnter(){
  if (Date.now()<cooldownUntil) return;
  if (dayGuardActive()) return;

  const sig = await entrySignal();
  if (!sig.ok) return;

  target = sig.tppct; // 1.2–1.6 po volatilnosti

  const { freeQuote } = await balances();
  const px = await price();
  let spend = freeQuote * POS_PCT;
  if (spend<filters.minNotional){ return; }

  let q = spend/px; q = Math.max(filters.minQty, roundStep(q, filters.stepSize));
  if (q*px<filters.minNotional) return;

  if (!LIVE){
    inPos=true; entry=px; qty=q;
    tradesToday++;
    console.log(`[DRY BUY] ${SYMBOL} qty=${qty} @ ${entry}`);
    await cancelAllOrders();
    await placeProtectiveOCO(entry, qty);
    return;
  }

  try{
    const buy = await client.order({ symbol:SYMBOL, side:'BUY', type:'MARKET', quantity:String(q) });
    const fillP = buy.fills?.length
      ? buy.fills.reduce((s,f)=>s+Number(f.price)*Number(f.qty),0) / buy.fills.reduce((s,f)=>s+Number(f.qty),0)
      : px;
    inPos=true; entry=fillP; qty=Number(buy.executedQty);
    tradesToday++;
    console.log(`[BUY] ${SYMBOL} qty=${qty} @ ${entry}`);

    await cancelAllOrders();
    await placeProtectiveOCO(entry, qty);
  }catch(e){ console.error('[BUY ERROR]', e.body||e.message||e); }
}

async function tryTrail(){
  if(!inPos || !TRAIL) return;
  const px = await price();
  const gainPct = pct(px, entry); // koliko smo u plusu
  // ako smo iznad (SL_START + TRAIL_STEP), podigni SL u stepovima
  const desiredSL = entry * (1 + Math.max(0, gainPct - SL_START)/100) * (1 - TRAIL_STEP/100);
  const newSL = roundTick(desiredSL, filters.tickSize);

  if (newSL > trailSL){
    // podigni SL (otkaži staro OCO i postavi novo sa istim TP)
    try{
      await cancelAllOrders();
      const tp = roundTick(entry*(1 + target/100), filters.tickSize);
      const slLim = roundTick(newSL*0.999, filters.tickSize);
      await client.orderOco({
        symbol:SYMBOL, side:'SELL', quantity:String(qty),
        price:String(tp), stopPrice:String(newSL), stopLimitPrice:String(slLim),
        stopLimitTimeInForce:'GTC'
      });
      trailSL = newSL;
      console.log(`[TRAIL] SL -> ${trailSL} (gain=${gainPct.toFixed(2)}%)`);
    }catch(e){ console.error('[TRAIL ERROR]', e.body||e.message||e); }
  }
}

async function detectCloseAndUpdatePnL(){
  if(!inPos) return;
  const { freeBase } = await balances();
  if (freeBase < filters.minQty/2){
    // pozicija zatvorena (TP ili SL)
    const px = await price();
    const pnl = pct(px, entry);
    todayPnlPct += pnl;
    inPos=false; entry=0; qty=0; trailSL=0; target=0;
    console.log(`[CLOSE] PnL=${pnl.toFixed(2)}% | Daily=${todayPnlPct.toFixed(2)}% | Trades=${tradesToday}`);
    // cooldown 15s da ne uskače odmah
    cooldownUntil = Date.now()+15000;
  }
}

async function loop(){
  try{
    resetDayIfNeeded();
    const px = await price();
    process.stdout.write(`\r[Heartbeat] ${SYMBOL}: ${px}`);

    if (dayGuardActive()) return;

    if (inPos){
      await tryTrail();
      await detectCloseAndUpdatePnL();
    } else {
      await tryEnter();
    }
  }catch(e){ console.error('\n[LOOP ERROR]', e.body||e.message||e); }
}

// boot
(async()=>{
  console.log('[ENV] SYMBOL:',SYMBOL);
  console.log('[ENV] POS %:', Math.round(POS_PCT*100),' | TP:', TP_LOW,'–',TP_HIGH,'% | SL start:',SL_START,'% | Trail:',TRAIL,' step',TRAIL_STEP,'%');
  console.log('[ENV] DailyTarget:',DAILY_TARGET_PCT,'% | NoRedDay:',NO_NEG_DAY,'| MaxTrades:',MAX_TRADES_PER_DAY);
  await loadFilters();
  setInterval(loop, 2500);
})();
http.createServer((req,res)=>res.end('Bot running')).listen(process.env.PORT||8080);
process.on('uncaughtException', ()=>process.exit(1));
