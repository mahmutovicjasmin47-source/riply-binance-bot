// index.js – safe-aggressive scalping bot za 1 simbol (Railway backend)

const Binance = require('binance-api-node').default;

// ===== ENV VARIJABLE =====
const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,

  SYMBOL = 'BTCUSDC',
  LIVE_TRADING = 'false',

  STOP_LOSS_PCT = '0.5',

  // koristiš TP_LOW_PCT i TP_HIGH_PCT za dvije target zone
  TAKE_PROFIT_PCT = '0.12', // opcionalno, za info
  TP_LOW_PCT = '0.08',
  TP_HIGH_PCT = '0.14',

  DAILY_TARGET_PCT = '25.0',
  MAX_TRADES_PER_DAY = '80',
  POSITION_SIZE_PCT = '0.60', // koliko % USDC ulažeš po trade-u

  SL_START_PCT = '0.10',      // kad smo ovoliko u plusu, pali trailing
  TRAILING_STOP = 'true',
  TRAIL_STEP_PCT = '0.05',

  NO_NEGATIVE_DAY = 'false'
} = process.env;

// --- konverzija env vrijednosti ---
const liveTrading     = LIVE_TRADING === 'true';
const stopLossPct     = parseFloat(STOP_LOSS_PCT);
const takeProfitPct   = parseFloat(TAKE_PROFIT_PCT); // samo informativno
const tpLowPct        = parseFloat(TP_LOW_PCT);
const tpHighPct       = parseFloat(TP_HIGH_PCT);
const dailyTargetPct  = parseFloat(DAILY_TARGET_PCT);
const maxTradesPerDay = parseInt(MAX_TRADES_PER_DAY, 10);
const posSizePct      = parseFloat(POSITION_SIZE_PCT);
const slStartPct      = parseFloat(SL_START_PCT);
const trailingStop    = TRAILING_STOP === 'true';
const trailStepPct    = parseFloat(TRAIL_STEP_PCT);
const noNegativeDay   = NO_NEGATIVE_DAY === 'true';

// ===== CONFIG ZA SIGNALE =====
const SIGNAL_CFG = {
  intervalMs:     10000,   // 10s između analiza
  volMin:         0.0005,  // 0.05% min volatilnost
  volMax:         0.0100,  // 1.00% max (previše ludo -> ne radi)
  slopeFastBuy:   0.0007,  // +0.07% u ~10 minuta
  slopeFastSell: -0.0007,  // -0.07%
  slopeSlowBuy:   0.0003,  // +0.03% u ~30 minuta
  slopeSlowSell: -0.0003,  // -0.03%
  maxRet10Abs:    0.0040,  // ako 10-min pomak > 0.4% -> skip
  maxRet30Abs:    0.0080   // ako 30-min pomak > 0.8% -> skip
};

// ===== BINANCE CLIENT =====
const client = Binance({
  apiKey: BINANCE_API_KEY,
  apiSecret: BINANCE_API_SECRET
});

// ===== STANJE =====
let openPosition = null; // { side, entryPrice, qty, ... }
let dailyPnlPct = 0;
let tradesToday = 0;
let lastDay = null;

// ===== HELPER FUNKCIJE =====
function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

async function getAccountBalanceUSDC() {
  const accountInfo = await client.accountInfo();
  const usdc = accountInfo.balances.find(b => b.asset === 'USDC');
  return usdc ? parseFloat(usdc.free) : 0;
}

// koliko decimala smijemo za qty (grubo po simbolu)
function formatQty(symbol, qty) {
  let decimals = 6;
  if (symbol.startsWith('BNB')) decimals = 3;      // BNBUSDC
  else if (symbol.startsWith('ETH')) decimals = 5; // ETHUSDC
  // BTC ostaje 6
  const factor = Math.pow(10, decimals);
  const floored = Math.floor(qty * factor) / factor;
  return floored.toFixed(decimals);
}

// ===== ANTI-DUMP FILTER (ISPRAVLJEN) =====
// gleda zadnje 2 × 1m svijeće – ako druga svijeća padne npr. >0.4% -> dump
async function checkForDump(symbol) {
  try {
    const candles = await client.candles({
      symbol,
      interval: '1m',
      limit: 2
    });

    if (!candles || candles.length < 2) return false;

    const prev = parseFloat(candles[0].close);
    const last = parseFloat(candles[1].close);

    const dropPct = (last - prev) / prev * 100;

    // dump ako je pad manji ili jednak -0.4%
    const isDump = dropPct <= -0.4;
    if (isDump) {
      log(`checkForDump: DETEKTOVAN dump na ${symbol} (drop=${dropPct.toFixed(2)}%) -> ne ulazim.`);
    }
    return isDump;
  } catch (err) {
    console.log('Greška u checkForDump:', err.message || err);
    return false;
  }
}

// ===== GLAVNI DIO: ANALIZA + TRADE =====
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

    // uzimamo 30 × 1m candle (30 minuta)
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

    // mikro risk filter: ignoriramo mrtvo i ultra-ludo tržište
    if (vol30 < SIGNAL_CFG.volMin || vol30 > SIGNAL_CFG.volMax) {
      log(`Volatilnost out-of-range: ${(vol30 * 100).toFixed(2)}% -> skip.`);
      return;
    }

    // dodatni filter: ako je već lud nagib, ne ulazi
    if (Math.abs(ret10) > SIGNAL_CFG.maxRet10Abs || Math.abs(ret30) > SIGNAL_CFG.maxRet30Abs) {
      log(`Previše jak nagib (ret10=${(ret10 * 100).toFixed(2)}%, ret30=${(ret30 * 100).toFixed(2)}%), skip.`);
      return;
    }

    // ako imamo već otvorenu poziciju, prvo njom upravljamo
    if (openPosition) {
      await manageOpenPosition(lastClose);
      return;
    }

    // ANTI-DUMP – prije ulaza provjeri da nema svježeg pada
    const isDump = await checkForDump(SYMBOL);
    if (isDump) {
      return; // ne ulazimo u trade odmah nakon dump-a
    }

    // *** NEMA pozicije -> tražimo ulaz ***
    const strongUp =
      ret10 >= SIGNAL_CFG.slopeFastBuy &&
      ret30 >= SIGNAL_CFG.slopeSlowBuy;

    const strongDown =
      ret10 <= SIGNAL_CFG.slopeFastSell &&
      ret30 <= SIGNAL_CFG.slopeSlowSell;

    log(`Analiza ${SYMBOL}: ret10=${(ret10 * 100).toFixed(3)}% ret30=${(ret30 * 100).toFixed(3)}% vol30=${(vol30 * 100).toFixed(2)}%`);

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

// ===== OTVARANJE TRADE-A =====
async function openTrade(side, price) {
  if (tradesToday >= maxTradesPerDay) return;

  const balanceUSDC = await getAccountBalanceUSDC();
  if (balanceUSDC <= 0) {
    log('Nema USDC balansa za otvaranje pozicije.');
    return;
  }

  const usedUSDC = balanceUSDC * posSizePct;
  if (usedUSDC < 5) {
    log('Premali balans/pozicija (ispod 5 USDC).');
    return;
  }

  const rawQty = usedUSDC / price;
  const qtyStr = formatQty(SYMBOL, rawQty);
  const qty = parseFloat(qtyStr);

  if (qty <= 0) {
    log('Izračunata količina je 0, skip.');
    return;
  }

  tradesToday += 1;
  log(`OTVARANJE ${side} pozicije: qty=${qtyStr} @ ${price}`);

  if (liveTrading) {
    try {
      await client.order({
        symbol: SYMBOL,
        side,
        type: 'MARKET',
        quantity: qtyStr
      });
    } catch (err) {
      console.error('Greška pri slanju ORDER-a:', err.message || err);
      // ako order faila, ne pravimo openPosition
      return;
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
    tpLow:  price * (1 + (side === 'BUY' ?  tpLowPct  / 100 : -tpLowPct  / 100)),
    tpHigh: price * (1 + (side === 'BUY' ?  tpHighPct / 100 : -tpHighPct / 100)),
    slHard: price * (1 + (side === 'BUY' ? -stopLossPct / 100 :  stopLossPct / 100)),
    trailingActive: false,
    trailingStopPrice: null
  };
}

// ===== UPRAVLJANJE OTVORENOM POZICIJOM =====
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
      ? lastPrice * (1 - trailStepPct / 100)
      : lastPrice * (1 + trailStepPct / 100);
    log('Trailing stop AKTIVIRAN @', pos.trailingStopPrice.toFixed(2));
  }

  // ažuriraj trailing stop
  if (pos.trailingActive && pos.trailingStopPrice) {
    if (pos.side === 'BUY') {
      const candidate = lastPrice * (1 - trailStepPct / 100);
      if (candidate > pos.trailingStopPrice) {
        pos.trailingStopPrice = candidate;
        log('Trailing stop BUY pomjeren @', pos.trailingStopPrice.toFixed(2));
      }
    } else {
      const candidate = lastPrice * (1 + trailStepPct / 100);
      if (candidate < pos.trailingStopPrice) {
        pos.trailingStopPrice = candidate;
        log('Trailing stop SELL pomjeren @', pos.trailingStopPrice.toFixed(2));
      }
    }
  }

  // HARD SL
  if ((pos.side === 'BUY'  && lastPrice <= pos.slHard) ||
      (pos.side === 'SELL' && lastPrice >= pos.slHard)) {
    log('HARD SL pogođen.');
    await closePosition(lastPrice, 'SL_HARD');
    return;
  }

  // TRAILING SL
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

// ===== ZATVARANJE POZICIJE =====
async function closePosition(price, reason) {
  const pos = openPosition;
  if (!pos) return;

  log(`ZATVARANJE pozicije (${reason}) po cijeni ${price}`);

  if (liveTrading) {
    try {
      const closeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const qtyStr = formatQty(SYMBOL, pos.qty);

      await client.order({
        symbol: SYMBOL,
        side: closeSide,
        type: 'MARKET',
        quantity: qtyStr
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

// ===== GLAVNI LOOP =====
async function mainLoop() {
  await analyzeAndTrade();
}

// start
log('Bot startan za simbol', SYMBOL, '| liveTrading =', liveTrading, '| posSizePct =', posSizePct);
setInterval(mainLoop, SIGNAL_CFG.intervalMs);
