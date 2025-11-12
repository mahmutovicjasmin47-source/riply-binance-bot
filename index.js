require('dotenv').config();
const Binance = require('binance-api-node').default;
const http = require('http');

// ====== ENV ======
const API_KEY    = process.env.BINANCE_API_KEY || process.env.API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET || process.env.API_SECRET;
if (!API_KEY || !API_SECRET) { console.error('[FATAL] Missing API keys'); process.exit(1); }

const LIVE    = (process.env.LIVE_TRADING || 'true').toLowerCase() === 'true';

// Lista simbola i alokacije kapitala (zbroj = 1.0)
/*
  Primjer:
  SYMBOLS="BTCUSDC,ETHUSDC,BNBUSDC"
  ALLOC_PCT="BTCUSDC:0.5,ETHUSDC:0.3,BNBUSDC:0.2"
*/
const SYMBOLS   = (process.env.SYMBOLS || 'BTCUSDC,ETHUSDC,BNBUSDC')
  .split(',').map(s => s.trim().toUpperCase());

const ALLOC_MAP = {};
(String(process.env.ALLOC_PCT || 'BTCUSDC:0.5,ETHUSDC:0.3,BNBUSDC:0.2')
  .split(',')).forEach(x => {
    const [sym, val] = x.split(':');
    if (sym && val) ALLOC_MAP[sym.toUpperCase()] = Math.max(0, Math.min(1, Number(val)));
  });

// Koliki dio (0..1) od ALOKIRANOG USDC ulazimo po trejdu (npr. 0.50 = 50%)
const INVEST_PCT = Math.max(0, Math.min(1, Number(process.env.INVEST_PCT || '0.50')));

// TP u rasponu – nasumično izmedju min i max (u %)
const TP_MIN = Number(process.env.TP_PCT_MIN || '1.5');
const TP_MAX = Number(process.env.TP_PCT_MAX || '2.4');

// Fiksni „hard” SL i trailing SL (u %)
const SL_PCT     = Number(process.env.STOP_LOSS_PCT || '0.25');   // sigurnosni hard stop
const TRAIL_PCT  = Number(process.env.TRAILING_PCT   || '0.60');   // koliko daleko „vuče“ stop od vrha

// Dnevne zaštite
const DAILY_TARGET_PCT = Number(process.env.DAILY_TARGET_PCT || '3'); // globalno (svi parovi)
const NO_NEG_DAY       = (process.env.NO_NEGATIVE_DAY || 'true').toLowerCase() === 'true';
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || '7', 10);

// Telegram (opciono)
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
const ALERTS   = (!!TG_TOKEN && !!TG_CHAT);

// ====== Client ======
const client = Binance({ apiKey: API_KEY, apiSecret: API_SECRET });

// ====== Helpers ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pct = (a,b) => ((a-b)/b)*100;
const randTP = () => (TP_MIN + Math.random()*(TP_MAX - TP_MIN));

async function sendAlert(msg) {
  try {
    if (!ALERTS) return;
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: TG_CHAT, text: String(msg) }) });
  } catch {}
}

async function price(symbol){
  const t = await client.prices({ symbol });
  return Number(t[symbol]);
}

async function getFilters(symbol){
  const ex = await client.exchangeInfo();
  const s = ex.symbols.find(x=>x.symbol===symbol);
  const lot  = s.filters.find(f=>f.filterType==='LOT_SIZE');
  const tick = s.filters.find(f=>f.filterType==='PRICE_FILTER');
  const noti = s.filters.find(f=>['NOTIONAL','MIN_NOTIONAL'].includes(f.filterType));
  return {
    stepSize: Number(lot.stepSize),
    minQty: Number(lot.minQty),
    tickSize: Number(tick.tickSize),
    minNotional: noti ? Number(noti.minNotional || noti.notional) : 10
  };
}
function roundStep(q, step){ const p = Math.floor(q/step)*step; return Number(p.toFixed(8)); }
function roundTick(p, tick){ const r = Math.round(p/tick)*tick; return Number(r.toFixed(8)); }

async function accountBalances(){
  const acc = await client.accountInfo();
  const get = a => Number(acc.balances.find(b=>b.asset===a)?.free||0);
  return {
    USDC: get('USDC'),
    BTC : get('BTC'),
    ETH : get('ETH'),
    BNB : get('BNB'),
  };
}
async function candles(symbol, interval, limit){
  const ks = await client.candles({ symbol, interval, limit });
  return ks.map(k=>({ h:Number(k.high), c:Number(k.close) }));
}
const sma = (arr,n)=> arr.slice(-n).reduce((s,x)=>s+x,0)/n;

// ====== Per-symbol state ======
const state = {};
const filtersCache = {};
for (const sym of SYMBOLS){
  state[sym] = {
    inPos:false, entry:0, qty:0,
    peak:0, trailStop:0, tpPct:randTP(),
    tradesToday:0,
  };
}

// Global dnevna metrika
let dayKey = new Date().toISOString().slice(0,10);
let dailyPnL = 0; // u %
function resetDayIfNeeded(){
  const k = new Date().toISOString().slice(0,10);
  if (k!==dayKey){
    dayKey=k; dailyPnL=0;
    for (const sym of SYMBOLS){ state[sym].tradesToday=0; }
    console.log('\n[DAY] Reset dnevnih metrika.');
    sendAlert('📆 Novi dan: reset.');
  }
}
function guardsActive(){
  if (DAILY_TARGET_PCT>0 && dailyPnL >= DAILY_TARGET_PCT){
    console.log(`[GUARD] Dnevni target +${dailyPnL.toFixed(2)}% ≥ ${DAILY_TARGET_PCT}%`);
    return true;
  }
  if (NO_NEG_DAY && dailyPnL < 0){
    console.log(`[GUARD] No-Red-Day aktivan (${dailyPnL.toFixed(2)}%)`);
    return true;
  }
  return false;
}

// ====== Signal (brzi breakout + trend filter) ======
async function entrySignal(symbol){
  const m1 = await candles(symbol,'1m',25);
  const m5 = await candles(symbol,'5m',25);
  if (m1.length<21 || m5.length<21) return false;
  const m1c=m1.map(x=>x.c), m5c=m5.map(x=>x.c);
  const m1s5=sma(m1c,5),  m1s20=sma(m1c,20);
  const m5s5=sma(m5c,5),  m5s20=sma(m5c,20);
  const lastClose = m1c[m1c.length-1];
  const prevHigh  = m1[m1.length-2].h;

  return (lastClose > prevHigh*1.0002) && (m1s5>m1s20) && (m5s5>m5s20);
}

// ====== Trading core ======
async function tryEnter(symbol){
  if (guardsActive()) return;
  const s = state[symbol];
  if (s.inPos) return;

  const ok = await entrySignal(symbol);
  if (!ok) return;

  const quote = 'USDC';
  const acc = await accountBalances();
  const freeUSDC = acc[quote];

  // alokacija po simbolu
  const alloc = Math.max(0, Math.min(1, ALLOC_MAP[symbol] || 0));
  if (alloc===0) return;

  // koliko ulažemo (alokacija * invest_pct * slobodan USDC)
  let spendUSDC = freeUSDC * alloc * INVEST_PCT;
  if (!filtersCache[symbol]) filtersCache[symbol] = await getFilters(symbol);
  const f = filtersCache[symbol];
  if (spendUSDC < f.minNotional) return;

  const p = await price(symbol);
  let qty = spendUSDC / p;
  qty = Math.max(f.minQty, roundStep(qty, f.stepSize));
  if (qty*p < f.minNotional) return;

  if (!LIVE){
    s.inPos=true; s.entry=p; s.qty=qty; s.peak=p; s.trailStop=p*(1-TRAIL_PCT/100); s.tpPct=randTP();
    console.log(`[DRY BUY] ${symbol} q=${qty} @ ${p} | TP=${s.tpPct.toFixed(2)}%`);
    return;
  }

  try{
    const buy = await client.order({ symbol, side:'BUY', type:'MARKET', quantity:String(qty) });
    const fillP = buy.fills && buy.fills.length
      ? buy.fills.reduce((s,f)=>s+Number(f.price)*Number(f.qty),0) / buy.fills.reduce((s,f)=>s+Number(f.qty),0)
      : p;

    s.inPos=true; s.entry=fillP; s.qty=Number(buy.executedQty);
    s.peak=fillP; s.trailStop=fillP*(1-TRAIL_PCT/100); s.tpPct=randTP();
    s.tradesToday++;
    console.log(`[BUY] ${symbol} qty=${s.qty} @ ${s.entry} | TP=${s.tpPct.toFixed(2)}%`);
    sendAlert(`🟢 BUY ${symbol} @ ${fillP} | qty ${s.qty} | TP ${s.tpPct.toFixed(2)}%`);
  }catch(e){ console.error('[BUY ERROR]', symbol, e.body||e.message||e); }
}

async function manageOpen(symbol){
  const s = state[symbol];
  if (!s.inPos) return;
  const p = await price(symbol);

  // trailing peak / stop
  if (p > s.peak){
    s.peak = p;
    s.trailStop = s.peak * (1 - TRAIL_PCT/100);
  }

  const hitTP = p >= s.entry * (1 + s.tpPct/100);
  const hitSL = p <= s.entry * (1 - SL_PCT/100);
  const hitTrail = p <= s.trailStop;

  if (!(hitTP||hitSL||hitTrail)) return;

  // sell market
  if (!LIVE){
    const exitP = p;
    const pnl = pct(exitP, s.entry);
    dailyPnL += pnl;
    console.log(`[DRY CLOSE] ${symbol} PnL=${pnl.toFixed(2)}% | Daily=${dailyPnL.toFixed(2)}%`);
    s.inPos=false; s.entry=0; s.qty=0; s.peak=0;
    return;
  }

  try{
    await client.order({ symbol, side:'SELL', type:'MARKET', quantity:String(s.qty) });
    const exitP = p;
    const pnl = pct(exitP, s.entry);
    dailyPnL += pnl;
    console.log(`[SELL] ${symbol} PnL=${pnl.toFixed(2)}% | Daily=${dailyPnL.toFixed(2)}%`);
    sendAlert(`✅ CLOSE ${symbol} PnL=${pnl.toFixed(2)}% | Daily=${dailyPnL.toFixed(2)}%`);
  }catch(e){ console.error('[SELL ERROR]', symbol, e.body||e.message||e); }
  s.inPos=false; s.entry=0; s.qty=0; s.peak=0;
}

async function loop(){
  try{
    resetDayIfNeeded();
    for (const sym of SYMBOLS){
      process.stdout.write(`\r[Heartbeat] ${sym}`);
      if (!state[sym].inPos){
        if (state[sym].tradesToday < MAX_TRADES_PER_DAY) await tryEnter(sym);
      } else {
        await manageOpen(sym);
      }
      await sleep(800); // kratka pauza po simbolu
    }
  }catch(e){
    console.error('\n[LOOP ERROR]', e.body||e.message||e);
  }
}

// ====== Boot ======
(async ()=>{
  console.log('[ENV] LIVE:',LIVE);
  console.log('[ENV] SYMBOLS:',SYMBOLS.join(', '));
  console.log('[ENV] ALLOC_PCT:',ALLOC_MAP);
  console.log('[ENV] INVEST_PCT:', INVEST_PCT);
  console.log('[ENV] TP range:', TP_MIN,'–',TP_MAX,'% | SL:',SL_PCT,'%', '| TRAIL:',TRAIL_PCT,'%');
  console.log('[ENV] DailyTarget:', DAILY_TARGET_PCT, '% | NoRedDay:', NO_NEG_DAY, '| MaxTrades:', MAX_TRADES_PER_DAY);

  for (const s of SYMBOLS){ filtersCache[s]=await getFilters(s); }

  setInterval(loop, 2500);
  sendAlert(`🤖 Start multi-bot (${SYMBOLS.join(', ')})`);
})();

// Keep-alive za Railway
http.createServer((req,res)=>res.end('OK')).listen(process.env.PORT||8080);

// Restart na hard greške (da se Railway automatski podigne)
process.on('uncaughtException', async (e)=>{ await sendAlert('⛔ uncaught: '+(e?.message||e)); process.exit(1); });
