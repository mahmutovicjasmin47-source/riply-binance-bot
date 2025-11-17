// index.js – scalping bot sa AUTO-RESETOM starih pozicija

const Binance = require('binance-api-node').default;

// ===== ENV varijable =====
const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,

  SYMBOL = 'BTCUSDC',        // npr. BTCUSDC / ETHUSDC / BNBUSDC
  POSITION_ASSET = 'BTC',    // BTC ili ETH ili BNB (zavisno od servisa)
  LIVE_TRADING = 'false',

  STOP_LOSS_PCT = '0.5',
  TAKE_PROFIT_PCT = '0.12',
  TP_LOW_PCT = '0.08',
  TP_HIGH_PCT = '0.14',

  DAILY_TARGET_PCT = '25.0',
  MAX_TRADES_PER_DAY = '80',
  POSITION_SIZE_PCT = '0.60',

  SL_START_PCT = '0.10',
  TRAILING_STOP = 'true',
  TRAIL_STEP_PCT = '0.05',

  NO_NEGATIVE_DAY = 'false',

  // 🔥 NOVO: reset starih pozicija
  RESET_MODE = 'true'
} = process.env;

// konverzija
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
const resetMode       = RESET_MODE === 'true';

// ===== safe-aggressive config za signale =====
const SIGNAL_CFG = {
  intervalMs:     10000,   // 10s između analiza
  volMin:         0.0005,  // 0.05% min volatilnost
  volMax:         0.0100,  // 1.00% max
  slopeFastBuy:   0.0007,  // +0.07% ~10 min
  slopeFastSell: -0.0007,  // -0.07%
  slopeSlowBuy:   0.0003,  // +0.03% ~30 min
  slopeSlowSell: -0.0003,  // -0.03%
  maxRet10Abs:    0.0040,  // >0.4% u 10m -> skip
  maxRet30Abs:    0.0080   // >0.8% u 30m -> skip
};

// ===== Binance client =====
const client = Binance({
  apiKey: BINANCE_API_KEY,
  apiSecret: BINANCE_API_SECRET
});

// ===== stanje =====
let openPosition = null; // { side, entryPrice, qty, ... }
let dailyPnlPct = 0;
let tradesToday = 0;
let lastDay = null;
let lastPing = Date.now();

function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}
function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

async function getAccountInfo() {
  return client.accountInfo();
}

async function getBalance(asset) {
  const info = await getAccountInfo();
  const b = info.balances.find(x => x.asset === asset);
  return b ? parseFloat(b.free) : 0;
}

async function getAccountBalanceUSDC() {
  return getBalance('USDC');
}

// 🔥 NOVO: AUTO-RESET postojećih pozicija u tom coinu
let resetDone = false;

async function autoResetOldPosition() {
  if (!resetMode || resetDone) return;

  const freeAsset = await getBalance(POSITION_ASSET);
  if (freeAsset <= 0) {
    resetDone = true; // nema šta da se resetuje
    return;
  }

  log(`RESET_MODE: pronađen postojeći balans ${POSITION_ASSET} = ${freeAsset}. Prodajem u USDC...`);

  if (liveTrading) {
    try {
      await client.order({
        symbol: SYMBOL,
        side: 'SELL',
        type: 'MARKET',
        quantity: freeAsset.toFixed(6)
      });
      log('RESET_MODE: SELL order poslan.');
    } catch (err) {
      console.error('RESET_MODE: greška pri slanju SELL order-a:', err.message || err);
    }
  } else {
    log('(SIMULACIJA) RESET_MODE: ne šaljem pravi SELL order.');
  }

  resetDone = true;
}

// ===== glavni dio: analiza + trade =====
async function analyzeAndTrade() {
  try {
    const now = Date.now();
    if (now - lastPing > 60000) {
      log('KEEPALIVE ping — bot je živ.');
      lastPing = now;
    }

    const today = getDateKey();
    if (lastDay !== today) {
      lastDay = today;
      tradesToday = 0;
      dailyPnlPct = 0;
      log('--- Novi dan, reset brojača ---');
    }

    // prvo PRODAJ stare pozicije (reset)
    await autoResetOldPosition();

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

    if (vol30 < SIGNAL_CFG.volMin || vol30 > SIGNAL_CFG.volMax) {
      log(`Volatilnost out-of-range: ${(vol30*100).toFixed(2)}% -> skip.`);
      return;
    }

    if (Math.abs(ret10) > SIGNAL_CFG.maxRet10Abs || Math.abs(ret30) > SIGNAL_CFG.maxRet30Abs) {
      log(`Previše jak nagib (ret10=${(ret10*100).toFixed(2)}%, ret30=${(ret30*100).toFixed(2)}%), skip.`);
      return;
    }

    if (openPosition) {
      await manageOpenPosition(lastClose);
      return;
    }

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
  if (balanceUSDC <= 5) {
    log('Premali balans/pozicija (ispod 5 USDC).');
    return;
  }

  const usedUSDC = balanceUSDC * posSizePct;
  if (usedUSDC < 5) {
    log('Premali balans/pozicija (ispod 5 USDC).');
    return;
  }

  const qty = usedUSDC / price;
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

  if (!pos.trailingActive && trailingStop && movePct >= slStartPct) {
    pos.trailingActive = true;
    pos.trailingStopPrice = pos.side === 'BUY'
      ? lastPrice * (1 - trailStepPct/100)
      : lastPrice * (1 + trailStepPct/100);
    log('Trailing stop AKTIVIRAN @', pos.trailingStopPrice.toFixed(2));
  }

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

  if ((pos.side === 'BUY'  && lastPrice <= pos.slHard) ||
      (pos.side === 'SELL' && lastPrice >= pos.slHard)) {
    log('HARD SL pogođen.');
    await closePosition(lastPrice, 'SL_HARD');
    return;
  }

  if (pos.trailingActive && pos.trailingStopPrice) {
    if ((pos.side === 'BUY'  && lastPrice <= pos.trailingStopPrice) ||
        (pos.side === 'SELL' && lastPrice >= pos.trailingStopPrice)) {
      log('TRAILING STOP pogođen.');
      await closePosition(lastPrice, 'TRAILING');
      return;
    }
  }

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
      await client.order({
        symbol: SYMBOL,
        side: pos.side === 'BUY' ? 'SELL' : 'BUY',
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

// ===== glavni loop =====
async function mainLoop() {
  await analyzeAndTrade();
}

log('Bot startan za simbol', SYMBOL, '| liveTrading =', liveTrading, '| resetMode =', resetMode);
setInterval(mainLoop, SIGNAL_CFG.intervalMs);
