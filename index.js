// === Binance SPOT bot (Railway) ===
// Koristi ENV varijable:
// BINANCE_API_KEY, BINANCE_API_SECRET, SYMBOL, POSITION_SIZE_USDT, STOP_LOSS_PCT, TAKE_PROFIT_PCT, LIVE_TRADING

const Binance = require('node-binance-api');

// --- ENV & validacija ---
const API_KEY    = process.env.BINANCE_API_KEY || "";
const API_SECRET = process.env.BINANCE_API_SECRET || "";

const SYMBOL             = (process.env.SYMBOL || 'BTCUSDC').toUpperCase(); // npr. BTCUSDC, BTCEUR
const POSITION_SIZE_USDT = parseFloat(process.env.POSITION_SIZE_USDT || '40'); // kolika pozicija u USDT/EUR
const STOP_LOSS_PCT      = parseFloat(process.env.STOP_LOSS_PCT || '0.4');     // 0.4% SL
const TAKE_PROFIT_PCT    = parseFloat(process.env.TAKE_PROFIT_PCT || '0.6');   // 0.6% TP
const LIVE_TRADING       = (process.env.LIVE_TRADING || 'false') === 'true';   // true = stvarno trguje

function mask(s){ if(!s) return ''; return s.slice(0,4) + '***' + s.slice(-4); }
console.log('[ENV] SYMBOL=', SYMBOL);
console.log('[ENV] LIVE_TRADING=', LIVE_TRADING);
console.log('[ENV] API_KEY=', mask(API_KEY));
console.log('[ENV] API_SECRET=', mask(API_SECRET));

// Minimalna provjera
if(!API_KEY || !API_SECRET){
  console.error("Greška: You need to pass an API key and secret to make authenticated calls.");
  process.exit(1);
}

// --- Klijent ---
const binance = new Binance().options({
  APIKEY: API_KEY,
  APISECRET: API_SECRET,
  recvWindow: 6_000
});

// --- Pomocne ---
async function getPrice(symbol){
  const t = await binance.prices(symbol);
  return parseFloat(t[symbol]);
}

async function getFilters(symbol){
  const info = await binance.exchangeInfo();
  const s = info.symbols.find(x => x.symbol === symbol);
  if(!s) throw new Error(`This symbol is not permitted for this account or does not exist: ${symbol}`);
  const lot = s.filters.find(f=>f.filterType==='LOT_SIZE');
  const stepSize = parseFloat(lot.stepSize);
  const quote = s.quoteAsset; // USDC, USDT, EUR...
  return { stepSize, quote };
}

function roundStep(qty, step){
  const p = Math.round(qty/step)*step;
  return parseFloat(p.toFixed(8));
}

// --- Glavna rutina (jedan pokušaj kupovine + OCO) ---
async function runOnce(){
  try{
    const { stepSize } = await getFilters(SYMBOL);
    const price = await getPrice(SYMBOL);
    if(!price || !isFinite(price)) throw new Error('Nema cijene za '+SYMBOL);

    // Izračun količine iz budžeta
    const qtyRaw = POSITION_SIZE_USDT / price;
    const qty = roundStep(qtyRaw, stepSize);

    // SL/TP nivo (u %)
    const slPrice = +(price * (1 - STOP_LOSS_PCT/100)).toFixed(2);
    const tpPrice = +(price * (1 + TAKE_PROFIT_PCT/100)).toFixed(2);

    console.log(`\n${SYMBOL} | Cijena: ${price} | QTY: ${qty}`);
    console.log(`SL: ${slPrice} | TP: ${tpPrice} | LIVE=${LIVE_TRADING}`);

    if(!LIVE_TRADING){
      console.log('Simulacija: bez stvarnih naloga.');
      return;
    }

    // Market buy
    const buy = await binance.marketBuy(SYMBOL, qty);
    console.log('Kupovina OK:', buy.orderId);

    // OCO sell (TP & SL)
    // Napomena: na nekim quote valutama (npr. EUR) OCO nije dostupan; u tom slučaju postavljamo 2 odvojena naloga
    try{
      const oco = await binance.sell(SYMBOL, qty, tpPrice, { stopPrice: slPrice, type: 'OCO' });
      console.log('OCO postavljen:', oco.orderListId);
    }catch(e){
      console.warn('OCO nije dostupan; pokušavam odvojene naloge...', e.body || e.message);
      await binance.sell(SYMBOL, qty, tpPrice);                         // limit TP
      await binance.sell(SYMBOL, qty, null, {type:'STOP_LOSS', stopPrice: slPrice}); // SL
      console.log('Postavljeni odvojeni TP i SL nalozi.');
    }

  }catch(err){
    const body = err?.body || err?.message || String(err);
    if(body.includes('Invalid API-key') || body.includes('account')){
      console.error('Greška: Invalid API key, IP, or permissions for action.');
    }else if(body.includes('not permitted')){
      console.error('Greška: This symbol is not permitted for this account. Promijeni SYMBOL env ili enable par na Binance-u.');
    }else{
      console.error('Greška:', body);
    }
  }
}

// Keep-alive na 8080 da Railway ne gasi kontejner
const http = require('http');
http.createServer((_,res)=>{ res.writeHead(200); res.end('Bot pokrenut..'); }).listen(8080, ()=> {
  console.log('Keep-alive na portu 8080');
});

// Pokreni
runOnce();

// (Opcionalno) ponavljaj svakih 10 min:
// setInterval(runOnce, 10*60*1000);
