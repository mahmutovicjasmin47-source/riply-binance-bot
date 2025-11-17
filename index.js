// index.js – BUY-only spot scalping bot (BTC/BNB/ETH)

// ================== BINANCE KLIJENT ==================
const Binance = require('binance-api-node').default;

const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,

  // osnovno
  SYMBOL = 'BTCUSDC',
  LIVE_TRADING = 'false',

  // menadžment rizika
  POSITION_SIZE_PCT = '0.60',   // koliko % USDC ulazi u jednu poziciju
  STOP_LOSS_PCT = '0.5',        // hard SL od ulaza (u %)
  TP_LOW_PCT = '0.12',          // niži TP (u %)
  TP_HIGH_PCT = '0.18',         // viši TP (u %)

  SL_START_PCT = '0.10',        // kada smo ovoliko u plusu, pali trailing (u %)
  TRAILING_STOP = 'true',
  TRAIL_STEP_PCT = '0.05',      // koliko daleko stoji trailing (u %)

  DAILY_TARGET_PCT = '20.0',    // dnevni target u %
  MAX_TRADES_PER_DAY = '60',
  NO_NEGATIVE_DAY = 'false',

  // signal / analiza – možeš ostaviti default
  LOOP_INTERVAL_MS = '10000',       // 10s
  VOL_MIN_PCT = '0.05',             // 0.05% min volatilnost
  VOL_MAX_PCT = '3.0',              // 3% max volatilnost
  SLOPE_FAST_BUY_PCT = '0.15',      // brži nagib (~10m) za BUY
  SLOPE_SLOW_BUY_PCT = '0.05'       // sporiji nagib (~30m) za BUY
} = process.env;

// konverzija
const liveTrading     = LIVE_TRADING === 'true';
const posSizePct      = parseFloat(POSITION_SIZE_PCT);
const stopLossPct     = parseFloat(STOP_LOSS_PCT);
const tpLowPct        = parseFloat(TP_LOW_PCT);
const tpHighPct       = parseFloat(TP_HIGH_PCT);
const slStartPct      = parseFloat(SL_START_PCT);
const trailingStop    = TRAILING_STOP === 'true';
const trailStepPct    = parseFloat(TRAIL_STEP_PCT);
const dailyTargetPct  = parseFloat(DAILY_TARGET_PCT);
const maxTradesPerDay = parseInt(MAX_TRADES_PER_DAY, 10);
const noNegativeDay   = NO_NEGATIVE_DAY === 'true';

const SIGNAL_CFG = {
  intervalMs:      parseInt(LOOP_INTERVAL_MS, 10) || 10000,
  volMin:          parseFloat(VOL_MIN_PCT) / 100,
  volMax:          parseFloat(VOL_MAX_PCT) / 100,
  slopeFastBuy:    parseFloat(SLOPE_FAST_BUY_PCT) / 100,
  slopeSlowBuy:    parseFloat(SLOPE_SLOW_BUY_PCT) / 100
};

// Binance client
const client = Binance({
  apiKey: BINANCE_API_KEY,
  apiSecret: BINANCE_API_SECRET
});

// ================== STATE ==================
let openPosition = null; // { entryPrice, qty, highest, lowest, tpLow, tpHigh, slHard, ... }
let dailyPnlPct = 0;
let tradesToday = 0;
let lastDay = null;

// info o simbolu (LOT_SIZE, MIN_NOTIONAL)
let symbolFilters = {
  minQty: null,
  stepSize: null,
  minNotional: null,
  qtyDecimals: 6
};

// ================== POMOĆNE FUNKCIJE ==================
function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

async function loadSymbolFilters() {
  const info = await client.exchangeInfo();
  const s = info.symbols.find(x => x.symbol === SYMBOL);
  if (!s) {
    log('Nisam našao simbol u exchangeInfo:', SYMBOL);
    return;
  }

  const lot = s.filters.find(f => f.filterType === 'LOT_SIZE') ||
              s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
  const minNotional = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');

  if (lot) {
    symbolFilters.minQty   = parseFloat(lot.minQty);
    symbolFilters.stepSize = parseFloat(lot.stepSize);

    const stepStr = lot.stepSize.toString();
    const idx = stepStr.indexOf('.');
    symbolFilters.qtyDecimals = idx === -1 ? 0 : stepStr.length - idx - 1;
  }

  if (minNotional) {
    symbolFilters.minNotional = parseFloat(minNotional.minNotional);
  }

  log('Symbol filters:', SYMBOL, symbolFilters);
}

// zaokruživanje količine na stepSize
function normalizeQty(rawQty) {
  const { minQty, stepSize } = symbolFilters;
  if (!minQty || !stepSize) return rawQty;

  const floored = Math.floor(rawQty / stepSize) * stepSize;
  return floored;
}

async function getAccountBalanceUSDC() {
  const accountInfo = await client.accountInfo();
  const usdc = accountInfo.balances.find(b => b.asset === 'USDC');
  return usdc ? parseFloat(usdc.free) : 0;
}

// ================== GLAVNA ANALIZA ==================
async function analyzeAndTrade() {
  try {
    const today = getDateKey();
    if (lastDay !== today) {
      lastDay = today;
      tradesToday = 0;
      dailyPnlPct = 0;
      log('--- Novi dan, reset brojača ---');
    }

    if (dailyPnlPct >= dailyTargetPct) {
      log('DAILY TARGET dostignut, pauza. PnL% =', dailyPnlPct.toFixed(2));
      return;
    }

    if (noNegativeDay && dailyPnlPct <= -dailyTargetPct) {
      log('NO_NEGATIVE_DAY aktivan, preveliki minus, pauza. PnL% =', dailyPnlPct.toFixed(2));
      return;
    }

    if (tradesToday >= maxTradesPerDay) {
      log('MAX_TRADES_PER_DAY dostignut, pauza.');
      return;
    }

    // 30 × 1m candle (≈30 min)
    const candles = await client.candles({ symbol: SYMBOL, interval: '1m', limit: 30 });
    if (!candles || candles.length < 10) {
      log('Premalo candle podataka.');
      return;
    }

    const closes = candles.map(c => parseFloat(c.close));
    const lastClose = closes[closes.length - 1];
    const first10 = closes[closes.length - 10];
    const first30 = closes[0];

    const ret10 = (lastClose - first10) / first10;  // ~10m promjena
    const ret30 = (lastClose - first30) / first30;  // ~30m promjena

    const high30 = Math.max(...closes);
    const low30  = Math.min(...closes);
    const vol30  = (high30 - low30) / lastClose;

    // volatilnost filter
    if (vol30 < SIGNAL_CFG.volMin || vol30 > SIGNAL_CFG.volMax) {
      log(`Volatilnost out-of-range: ${(vol30*100).toFixed(2)}% -> skip.`);
      return;
    }

    log(
      `Analiza ${SYMBOL}: ret10=${(ret10*100).toFixed(3)}%`,
      `ret30=${(ret30*100).toFixed(3)}%`,
      `vol30=${(vol30*100).toFixed(2)}%`
    );

    // ako je već otvorena pozicija -> samo menadžment
    if (openPosition) {
      await manageOpenPosition(lastClose);
      return;
    }

    // BUY signal (samo LONG)
    const strongUp =
      ret10 >= SIGNAL_CFG.slopeFastBuy &&
      ret30 >= SIGNAL_CFG.slopeSlowBuy;

    if (strongUp) {
      await openLong(lastClose);
    } else {
      log('Nema jasnog signala -> čekam.');
    }

  } catch (err) {
    console.error('Greška u analyzeAndTrade:', err.message || err);
  }
}

// ================== OTVARANJE LONG POZICIJE ==================
async function openLong(price) {
  if (tradesToday >= maxTradesPerDay) return;

  const balanceUSDC = await getAccountBalanceUSDC();
  if (balanceUSDC <= 0) {
    log('Nema USDC balansa za otvaranje pozicije.');
    return;
  }

  let usedUSDC = balanceUSDC * posSizePct;
  if (usedUSDC < 5) {
    log('Premali balans/pozicija (ispod 5 USDC).');
    return;
  }

  let qty = usedUSDC / price;
  qty = normalizeQty(qty);

  if (!qty || qty <= 0) {
    log('Normalizovana količina je 0, skip.');
    return;
  }

  const notional = qty * price;

  if (symbolFilters.minNotional && notional < symbolFilters.minNotional) {
    log(`Premali notional (${notional.toFixed(4)}), MIN_NOTIONAL=${symbolFilters.minNotional}.`);
    return;
  }

  if (symbolFilters.minQty && qty < symbolFilters.minQty) {
    log(`Premala količina (${qty}), MIN_QTY=${symbolFilters.minQty}.`);
    return;
  }

  const qtyStr = qty.toFixed(symbolFilters.qtyDecimals || 6);
  tradesToday += 1;

  log(`OTVARANJE BUY pozicije: qty=${qtyStr} @ ${price}`);

  if (liveTrading) {
    try {
      await client.order({
        symbol: SYMBOL,
        side: 'BUY',
        type: 'MARKET',
        quantity: qtyStr
      });
    } catch (err) {
      console.error('Greška pri slanju BUY ORDER-a:', err.message || err);
      return;
    }
  } else {
    log('(SIMULACIJA) LIVE_TRADING=false, ne šaljem pravi BUY order.');
  }

  openPosition = {
    entryPrice: price,
    qty,
    highest: price,
    lowest: price,
    tpLow:  price * (1 + tpLowPct / 100),
    tpHigh: price * (1 + tpHighPct / 100),
    slHard: price * (1 - stopLossPct / 100),
    trailingActive: false,
    trailingStopPrice: null
  };
}

// ================== MENADŽMENT OTVORENE POZICIJE (LONG) ==================
async function manageOpenPosition(lastPrice) {
  const pos = openPosition;
  if (!pos) return;

  if (lastPrice > pos.highest) pos.highest = lastPrice;
  if (lastPrice < pos.lowest)  pos.lowest  = lastPrice;

  const movePct = (lastPrice - pos.entryPrice) / pos.entryPrice * 100;

  // aktiviraj trailing stop kad smo dovoljno u plusu
  if (!pos.trailingActive && trailingStop && movePct >= slStartPct) {
    pos.trailingActive = true;
    pos.trailingStopPrice = lastPrice * (1 - trailStepPct / 100);
    log('Trailing stop AKTIVIRAN @', pos.trailingStopPrice.toFixed(2));
  }

  // ažuriraj trailing stop
  if (pos.trailingActive && pos.trailingStopPrice) {
    const candidate = lastPrice * (1 - trailStepPct / 100);
    if (candidate > pos.trailingStopPrice) {
      pos.trailingStopPrice = candidate;
      log('Trailing stop pomjeren @', pos.trailingStopPrice.toFixed(2));
    }
  }

  // HARD SL
  if (lastPrice <= pos.slHard) {
    log('HARD SL pogođen.');
    await closePosition(lastPrice, 'SL_HARD');
    return;
  }

  // TRAILING SL
  if (pos.trailingActive && pos.trailingStopPrice && lastPrice <= pos.trailingStopPrice) {
    log('TRAILING STOP pogođen.');
    await closePosition(lastPrice, 'TRAILING');
    return;
  }

  // TAKE PROFIT
  const hitLow  = lastPrice >= pos.tpLow;
  const hitHigh = lastPrice >= pos.tpHigh;

  if (hitHigh) {
    await closePosition(lastPrice, 'TP_HIGH');
  } else if (hitLow && !pos.trailingActive) {
    await closePosition(lastPrice, 'TP_LOW');
  } else {
    log(`Pozicija LONG @${pos.entryPrice}, sada ${lastPrice}, move=${movePct.toFixed(2)}%`);
  }
}

// ================== ZATVARANJE POZICIJE (SELL) ==================
async function closePosition(price, reason) {
  const pos = openPosition;
  if (!pos) return;

  const qtyStr = pos.qty.toFixed(symbolFilters.qtyDecimals || 6);
  log(`ZATVARANJE LONG pozicije (${reason}) po cijeni ${price}, qty=${qtyStr}`);

  if (liveTrading) {
    try {
      await client.order({
        symbol: SYMBOL,
        side: 'SELL',
        type: 'MARKET',
        quantity: qtyStr
      });
    } catch (err) {
      console.error('Greška pri slanju SELL ORDER-a:', err.message || err);
    }
  } else {
    log('(SIMULACIJA) LIVE_TRADING=false, ne šaljem pravi SELL order.');
  }

  const pnlPct = (price - pos.entryPrice) / pos.entryPrice * 100;
  dailyPnlPct += pnlPct;
  log(`Trade PnL: ${pnlPct.toFixed(2)}% | Daily PnL: ${dailyPnlPct.toFixed(2)}%`);

  openPosition = null;
}

// ================== GLAVNI LOOP ==================
async function mainLoop() {
  await analyzeAndTrade();
}

// ================== START ==================
async function start() {
  log('Bot startan za simbol', SYMBOL, '| liveTrading =', liveTrading);
  await loadSymbolFilters();
  setInterval(mainLoop, SIGNAL_CFG.intervalMs);
}

start().catch(err => {
  console.error('Fatalna greška pri startu bota:', err.message || err);
});
