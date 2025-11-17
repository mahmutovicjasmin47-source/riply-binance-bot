// index.js – BTCUSDC scalping bot (jedan bot, LOT_SIZE fix)

const Binance = require('binance-api-node').default;

// ===== ENV VARIJALE =====
const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,

  SYMBOL = 'BTCUSDC',
  LIVE_TRADING = 'false',

  STOP_LOSS_PCT = '0.6',
  TAKE_PROFIT_PCT = '0.12',
  TP_LOW_PCT = '0.08',
  TP_HIGH_PCT = '0.16',

  DAILY_TARGET_PCT = '20.0',
  MAX_TRADES_PER_DAY = '60',
  POSITION_SIZE_PCT = '0.60',

  SL_START_PCT = '0.12',
  TRAILING_STOP = 'true',
  TRAIL_STEP_PCT = '0.05',

  NO_NEGATIVE_DAY = 'false',
  MIN_USDC_POSITION = '5'
} = process.env;

// konverzija u brojeve
const liveTrading     = LIVE_TRADING === 'true';
const stopLossPct     = parseFloat(STOP_LOSS_PCT);
const takeProfitPct   = parseFloat(TAKE_PROFIT_PCT);
const tpLowPct        = parseFloat(TP_LOW_PCT);
const tpHighPct       = parseFloat(TP_HIGH_PCT);
const dailyTargetPct  = parseFloat(DAILY_TARGET_PCT);
const maxTradesPerDay = parseInt(MAX_TRADES_PER_DAY, 10);
const posSizePct      = parseFloat(POSITION_SIZE_PCT);
const slStartPct      = parseFloat(SL_START_PCT);
const trailingStop    = TRAILING_STOP === 'true';
const trailStepPct    = parseFloat(TRAIL_STEP_PCT);
const noNegativeDay   = NO_NEGATIVE_DAY === 'true';
const minUsdcPosition = parseFloat(MIN_USDC_POSITION) || 5;

// ===== signal konfiguracija (sigurni/agresivni scalping) =====
const SIGNAL_CFG = {
  intervalMs:     10000,    // 10 sekundi između analiza
  volMin:         0.0005,   // 0.05% minimalna volatilnost
  volMax:         0.0150,   // 1.50% max (previše ludo -> skip)
  slopeFastBuy:   0.0007,   // +0.07% u ~10 minuta
  slopeFastSell: -0.0007,   // -0.07%
  slopeSlowBuy:   0.0003,   // +0.03% u ~30 minuta
  slopeSlowSell: -0.0003,   // -0.03%
  maxRet10Abs:    0.0040,   // ako 10-min pomak > 0.4% -> preskoči
  maxRet30Abs:    0.0100    // ako 30-min pomak > 1.0% -> preskoči
};

// ===== Binance client =====
const client = Binance({
  apiKey: BINANCE_API_KEY,
  apiSecret: BINANCE_API_SECRET
});

// exchangeInfo filteri (LOT_SIZE, MIN_NOTIONAL) za SYMBOL
let symbolFilters = null;

// stanje
let openPosition = null; // { side, entryPrice, qty, highest, lowest, ... }
let dailyPnlPct = 0;
let tradesToday = 0;
let lastDay = null;

function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// učitavanje Binance filtera
async function loadSymbolFilters() {
  try {
    const info = await client.exchangeInfo();
    const s = info.symbols.find(x => x.symbol === SYMBOL);
    if (!s) {
      log('Nisam našao symbol u exchangeInfo:', SYMBOL);
      return;
    }
    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
    const minNotional = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');

    symbolFilters = {
      minQty: lot ? parseFloat(lot.minQty) : 0,
      stepSize: lot ? parseFloat(lot.stepSize) : 0,
      minNotional: minNotional ? parseFloat(minNotional.minNotional) : 0
    };

    log('Učitan Binance filter za', SYMBOL, symbolFilters);
  } catch (err) {
    console.error('Greška u loadSymbolFilters:', err.message || err);
  }
}

// za USDC balans
async function getAccountBalanceUSDC() {
  const accountInfo = await client.accountInfo();
  const usdc = accountInfo.balances.find(b => b.asset === 'USDC');
  return usdc ? parseFloat(usdc.free) : 0;
}

// prilagođavanje količine na LOT_SIZE
function adjustQuantity(rawQty) {
  if (!symbolFilters || !symbolFilters.stepSize || !symbolFilters.minQty) {
    return rawQty;
  }
  let qty = rawQty;

  if (qty < symbolFilters.minQty) {
    qty = symbolFilters.minQty;
  }

  const step = symbolFilters.stepSize;
  qty = Math.floor(qty / step) * step; // zaokruži dole na najbliži step

  return qty;
}

// ===== glavna logika: analiza + trade =====
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
      log('DAILY TARGET dostignut, pauza za danas. PnL% =', dailyPnlPct.toFixed(2));
      return;
    }

    if (noNegativeDay && dailyPnlPct <= -dailyTargetPct) {
      log('NO_NEGATIVE_DAY aktivan, preveliki minus, pauza za danas. PnL% =', dailyPnlPct.toFixed(2));
      return;
    }

    if (tradesToday >= maxTradesPerDay) {
      log('MAX_TRADES_PER_DAY dostignut, pauza za danas.');
      return;
    }

    // 30 × 1m candle (30 minuta)
    const candles = await client.candles({ symbol: SYMBOL, interval: '1m', limit: 30 });
    if (!candles || candles.length < 10) {
      log('Premalo candle podataka.');
      return;
    }

    const closes = candles.map(c => parseFloat(c.close));
    const lastClose = closes[closes.length - 1];
    const first10 = closes[closes.length - 10];
    const first30 = closes[0];

    const ret10 = (lastClose - first10) / first10;
    const ret30 = (lastClose - first30) / first30;

    const high30 = Math.max(...closes);
    const low30  = Math.min(...closes);
    const vol30  = (high30 - low30) / lastClose;

    // filter volatilnosti
    if (vol30 < SIGNAL_CFG.volMin || vol30 > SIGNAL_CFG.volMax) {
      log(`Volatilnost out-of-range: ${(vol30*100).toFixed(2)}% -> skip.`);
      return;
    }

    // filter za brutalne spike-ove
    if (Math.abs(ret10) > SIGNAL_CFG.maxRet10Abs || Math.abs(ret30) > SIGNAL_CFG.maxRet30Abs) {
      log(`Previše jak nagib (ret10=${(ret10*100).toFixed(2)}%, ret30=${(ret30*100).toFixed(2)}%), skip.`);
      return;
    }

    // ako postoji otvorena pozicija -> prvo njome upravljamo
    if (openPosition) {
      await manageOpenPosition(lastClose);
      return;
    }

    // nema pozicije -> tražimo ulaz
    const strongUp =
      ret10 >= SIGNAL_CFG.slopeFastBuy &&
      ret30 >= SIGNAL_CFG.slopeSlowBuy;

    const strongDown =
      ret10 <= SIGNAL_CFG.slopeFastSell &&
      ret30 <= SIGNAL_CFG.slopeSlowSell;

    log(`Analiza ${SYMBOL}: ret10=${(ret10*100).toFixed(3)}% ret30=${(ret30*100).toFixed(3)}% vol30=${(vol30*100).toFixed(2)}%`);

    if (strongUp && !strongDown) {
      await openTrade('BUY', lastClose);
    } else if (strongDown && !strongUp) {
      await openTrade('SELL', lastClose);
    } else {
      log('Nema jasnog signala -> čekam.');
    }

  } catch (err) {
    console.error('Greška u analyzeAndTrade:', err.message || err);
  }
}

// ===== otvaranje trade-a =====
async function openTrade(side, price) {
  if (tradesToday >= maxTradesPerDay) return;

  const balanceUSDC = await getAccountBalanceUSDC();
  if (balanceUSDC <= 0) {
    log('Nema USDC balansa za otvaranje pozicije.');
    return;
  }

  const usedUSDCraw = balanceUSDC * posSizePct;
  if (usedUSDCraw < minUsdcPosition) {
    log('Premali balans/pozicija (ispod', minUsdcPosition, 'USDC).');
    return;
  }

  let qty = usedUSDCraw / price;
  qty = adjustQuantity(qty);

  const notional = qty * price;
  if (symbolFilters && symbolFilters.minNotional && notional < symbolFilters.minNotional) {
    log(`Notional too small (${notional.toFixed(2)}), MIN_NOTIONAL=${symbolFilters.minNotional}, skip.`);
    return;
  }

  tradesToday += 1;

  log(`OTVARANJE ${side} pozicije: qty=${qty.toFixed(6)} @ ${price}`);

  if (liveTrading) {
    try {
      await client.order({
        symbol: SYMBOL,
        side,
        type: 'MARKET',
        quantity: qty.toFixed(6)
      });
    } catch (err) {
      console.error('Greška pri slanju ORDER-a:', err.message || err);
      return; // ne otvaraj lokalnu poziciju ako order nije prošao
    }
  } else {
    log('(SIMULACIJA) LIVE_TRADING=false, ne šaljem pravi order.');
  }

  openPosition = {
    side,
    entryPrice: price,
    qty,
    highest: price,
    lowest: price,
    tpLow:  price * (1 + (side === 'BUY' ?  tpLowPct/100 : -tpLowPct/100)),
    tpHigh: price * (1 + (side === 'BUY' ?  tpHighPct/100 : -tpHighPct/100)),
    slHard: price * (1 + (side === 'BUY' ? -stopLossPct/100 :  stopLossPct/100)),
    trailingActive: false,
    trailingStopPrice: null
  };
}

// ===== upravljanje otvorenom pozicijom =====
async function manageOpenPosition(lastPrice) {
  const pos = openPosition;
  if (!pos) return;

  if (pos.side === 'BUY') {
    if (lastPrice > pos.highest) pos.highest = lastPrice;
    if (lastPrice < pos.lowest)  pos.lowest  = lastPrice;
  } else {
    if (lastPrice < pos.lowest)  pos.lowest  = lastPrice;
    if (lastPrice > pos.highest) pos.highest = lastPrice;
  }

  const movePct = (lastPrice - pos.entryPrice) / pos.entryPrice * (pos.side === 'BUY' ? 100 : -100);

  // aktiviraj trailing kada smo dovoljno u plusu
  if (!pos.trailingActive && trailingStop && movePct >= slStartPct) {
    pos.trailingActive = true;
    pos.trailingStopPrice = pos.side === 'BUY'
      ? lastPrice * (1 - trailStepPct/100)
      : lastPrice * (1 + trailStepPct/100);
    log('Trailing stop AKTIVIRAN @', pos.trailingStopPrice.toFixed(2));
  }

  // ažuriraj trailing stop
  if (pos.trailingActive && pos.trailingStopPrice) {
    if (pos.side === 'BUY') {
      const candidate = lastPrice * (1 - trailStepPct/100);
      if (candidate > pos.trailingStopPrice) {
        pos.trailingStopPrice = candidate;
        log('Trailing stop BUY pomjeren @', pos.trailingStopPrice.toFixed(2));
      }
    } else {
      const candidate = lastPrice * (1 + trailStepPct/100);
      if (candidate < pos.trailingStopPrice) {
        pos.trailingStopPrice = candidate;
        log('Trailing stop SELL pomjeren @', pos.trailingStopPrice.toFixed(2));
      }
    }
  }

  // hard SL
  if ((pos.side === 'BUY'  && lastPrice <= pos.slHard) ||
      (pos.side === 'SELL' && lastPrice >= pos.slHard)) {
    log('HARD SL pogođen.');
    await closePosition(lastPrice, 'SL_HARD');
    return;
  }

  // trailing SL
  if (pos.trailingActive && pos.trailingStopPrice) {
    if ((pos.side === 'BUY'  && lastPrice <= pos.trailingStopPrice) ||
        (pos.side === 'SELL' && lastPrice >= pos.trailingStopPrice)) {
      log('TRAILING STOP pogođen.');
      await closePosition(lastPrice, 'TRAILING');
      return;
    }
  }

  // TP zona
  const hitLow = pos.side === 'BUY'
    ? lastPrice >= pos.tpLow
    : lastPrice <= pos.tpLow;

  const hitHigh = pos.side === 'BUY'
    ? lastPrice >= pos.tpHigh
    : lastPrice <= pos.tpHigh;

  if (hitHigh) {
    await closePosition(lastPrice, 'TP_HIGH');
  } else if (hitLow && !pos.trailingActive) {
    await closePosition(lastPrice, 'TP_LOW');
  } else {
    log(`Pozicija (${pos.side}) @${pos.entryPrice}, sada ${lastPrice}, move=${movePct.toFixed(2)}%`);
  }
}

// ===== zatvaranje pozicije =====
async function closePosition(price, reason) {
  const pos = openPosition;
  if (!pos) return;

  log(`ZATVARANJE pozicije (${reason}) po cijeni ${price}`);

  if (liveTrading) {
    try {
      const side = pos.side === 'BUY' ? 'SELL' : 'BUY';
      await client.order({
        symbol: SYMBOL,
        side,
        type: 'MARKET',
        quantity: pos.qty.toFixed(6)
      });
    } catch (err) {
      console.error('Greška pri zatvaranju ORDER-a:', err.message || err);
    }
  } else {
    log('(SIMULACIJA) LIVE_TRADING=false, ne šaljem pravi close order.');
  }

  const pnlPct = (price - pos.entryPrice) / pos.entryPrice * (pos.side === 'BUY' ? 100 : -100);
  dailyPnlPct += pnlPct;
  log(`Trade PnL: ${pnlPct.toFixed(2)}% | Daily PnL: ${dailyPnlPct.toFixed(2)}%`);

  openPosition = null;
}

// keepalive log
function keepAlive() {
  log('KEEPALIVE ping — bot je živ.');
}

// ===== glavni loop =====
async function mainLoop() {
  await analyzeAndTrade();
}

// start
(async () => {
  log('Bot startan za simbol', SYMBOL, '| liveTrading =', liveTrading);
  await loadSymbolFilters();
  await mainLoop();
  setInterval(mainLoop, SIGNAL_CFG.intervalMs);
  setInterval(keepAlive, 5 * 60 * 1000);
})();
