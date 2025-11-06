// ===== ENV & CLIENT =====
require('dotenv').config();
const Binance = require('binance-api-node').default;

// ENV VARS (Railway -> Variables)
const LIVE_TRADING = String(process.env.LIVE_TRADING || 'true') === 'true';
const SYMBOL        = process.env.SYMBOL || 'BTCUSDC';
const TP_PCT        = Number(process.env.TAKE_PROFIT_PCT || 0.9);   // %
const SL_PCT        = Number(process.env.STOP_LOSS_PCT   || 0.4);   // %
const POS_PCT       = Number(process.env.POSITION_SIZE_PCT || 0.9); // 90% balansa

const client = Binance({
  apiKey: process.env.BINANCE_API_KEY || process.env.API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET || process.env.API_SECRET
});

if (!client) {
  console.error('[FATAL] Binance client not created.');
  process.exit(1);
}

console.log('[BOT] Pokrećem…');
console.log('[ENV] SYMBOL:', SYMBOL);
console.log('[ENV] LIVE_TRADING:', LIVE_TRADING);

// ===== POMOĆNE FUNKCIJE =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function roundStep(value, step) {
  const p = Math.round(Math.log10(1/Number(step)));
  return Number((Math.floor(Number(value) / Number(step)) * Number(step)).toFixed(p));
}

async function getSymbolFilters(symbol) {
  const ex = await client.exchangeInfo();
  const s  = ex.symbols.find(x => x.symbol === symbol);
  if (!s) throw new Error(`Symbol ${symbol} not found on exchange.`);
  const lot   = s.filters.find(f => f.filterType === 'LOT_SIZE');
  const minN  = s.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
  const price = s.filters.find(f => f.filterType === 'PRICE_FILTER');
  return {
    stepSize: lot ? lot.stepSize : '0.000001',
    minNotional: minN ? Number(minN.minNotional || minN.notional) : 10,
    tickSize: price ? price.tickSize : '0.01'
  };
}

async function getPrice(symbol) {
  const t = await client.prices({ symbol });
  return Number(t[symbol]);
}

async function getQuoteFree(quoteAsset='USDC') {
  const acc = await client.accountInfo();
  const bal = acc.balances.find(b => b.asset === quoteAsset);
  return bal ? Number(bal.free) : 0;
}

async function placeOCO(symbol, qty, buyPrice) {
  const tpPrice   = buyPrice * (1 + TP_PCT/100);
  const slTrigger = buyPrice * (1 - SL_PCT/100);
  const slLimit   = slTrigger * 0.999; // malo ispod triggerea

  // Zaokruživanje na tickSize
  const { tickSize } = await getSymbolFilters(symbol);
  const p = Math.round(Math.log10(1/Number(tickSize)));
  const fmt = (x) => Number(x.toFixed(p));

  console.log(`[OCO] qty=${qty}, TP=${fmt(tpPrice)}, SL=${fmt(slTrigger)} / SLlim=${fmt(slLimit)}`);

  if (!LIVE_TRADING) {
    console.log('[DRY] Preskačem OCO (test mode).');
    return;
  }

  // OCO SELL
  await client.orderOco({
    symbol,
    side: 'SELL',
    quantity: String(qty),
    price: String(fmt(tpPrice)),
    stopPrice: String(fmt(slTrigger)),
    stopLimitPrice: String(fmt(slLimit)),
    stopLimitTimeInForce: 'GTC'
  });

  console.log('[OCO] Postavljen.');
}

async function tryEnter() {
  try {
    const { stepSize, minNotional } = await getSymbolFilters(SYMBOL);
    const price   = await getPrice(SYMBOL);
    const quote   = SYMBOL.endsWith('USDC') ? 'USDC'
                 : SYMBOL.endsWith('USDT') ? 'USDT'
                 : SYMBOL.slice(-4); // grubo fallback

    const free = await getQuoteFree(quote);
    let spend  = free * POS_PCT;

    if (spend < minNotional) {
      console.log(`[INFO] Nedovoljno sredstava: free=${free} ${quote}, minimum=${minNotional}.`);
      return;
    }

    // Izračun količine i zaokruživanje na stepSize
    let qty = spend / price;
    qty = roundStep(qty, stepSize);
    if (qty * price < minNotional) {
      console.log('[INFO] Nakon zaokruživanja ispod minNotionala — preskačem.');
      return;
    }

    if (!LIVE_TRADING) {
      console.log(`[DRY] BUY ${SYMBOL} qty=${qty} @~${price}`);
    } else {
      console.log(`[TRADE] BUY MARKET ${SYMBOL} qty=${qty}`);
      await client.order({
        symbol: SYMBOL,
        side: 'BUY',
        type: 'MARKET',
        quantity: String(qty)
      });
    }

    // Postavi OCO TP/SL
    await placeOCO(SYMBOL, qty, price);

  } catch (e) {
    console.error('[ERROR enter]', e.message || e);
  }
}

// ===== GLAVNA PETLJA =====
// Jednostavna strategija: ako nema otvorenih SELL naloga (OCO), pokušaj kupiti jednom pa čekaj.
async function loop() {
  while (true) {
    try {
      // Ako već imamo otvorenih SELL naloga, ne ulazimo ponovo
      const open = await client.openOrders({ symbol: SYMBOL });
      const hasSell = open.some(o => o.side === 'SELL');
      if (!hasSell) {
        await tryEnter();
      } else {
        console.log('[STATE] Očekujem ishod TP/SL… otvorenih SELL naloga:', open.length);
      }
    } catch (e) {
      console.error('[LOOP ERROR]', e.message || e);
    }
    await sleep(15_000); // svakih 15s
  }
}

// Kickoff (ne ruši se ako nema API ključeva — ali neće trgovati)
(async () => {
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
    console.error('[WARN] Nema API KEY/SECRET — provjeri Railway Variables.');
  }
  // heartbeat u logovima svake 3s
  setInterval(async () => {
    try { 
      const p = await getPrice(SYMBOL);
      console.log(`[Heartbeat] ${SYMBOL}: ${p}`);
    } catch {}
  }, 3000);

  // glavni rad
  loop();
})();

// ===== Railway keep-alive (PORT) =====
const http = require('http');
http.createServer((req, res) => res.end('Bot is running')).listen(process.env.PORT || 8080);
