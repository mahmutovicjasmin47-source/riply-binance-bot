// index.js – jedan BTC bot (BTCUSDC)

const Binance = require('binance-api-node').default;

const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,

  SYMBOL = 'BTCUSDC',       // BTC spot par
  LIVE_TRADING = 'false',   // za pravi trading stavi 'true'

  // risk / money management
  DAILY_TARGET_PCT   = '25.0',
  MAX_TRADES_PER_DAY = '80',
  NO_NEGATIVE_DAY    = 'false',

  POSITION_SIZE_PCT  = '0.60',  // 60% USDC ide u BTC poziciju

  STOP_LOSS_PCT      = '0.6',
  TP_LOW_PCT         = '0.12',
  TP_HIGH_PCT        = '0.25',

  SL_START_PCT       = '0.12',
  TRAILING_STOP      = 'true',
  TRAIL_STEP_PCT     = '0.07'
} = process.env;

// ---------- konverzija ----------
const liveTrading     = LIVE_TRADING === 'true';

const dailyTargetPct  = parseFloat(DAILY_TARGET_PCT);
const maxTradesPerDay = parseInt(MAX_TRADES_PER_DAY, 10);
const noNegativeDay   = NO_NEGATIVE_DAY === 'true';

const posSizePct      = parseFloat(POSITION_SIZE_PCT);

const stopLossPct     = parseFloat(STOP_LOSS_PCT);
const tpLowPct        = parseFloat(TP_LOW_PCT);
const tpHighPct       = parseFloat(TP_HIGH_PCT);

const slStartPct      = parseFloat(SL_START_PCT);
const trailingStop    = TRAILING_STOP === 'true';
const trailStepPct    = parseFloat(TRAIL_STEP_PCT);

// safe-aggressive signali za BTC
const SIGNAL_CFG = {
  intervalMs:   10000,   // 10s
  volMin:       0.0005,  // 0.05%
  volMax:       0.0150,  // 1.5% (malo širi za BTC)
  slopeFastBuy:  0.0007,
  slopeFastSell: -0.0007,
  slopeSlowBuy:  0.0003,
  slopeSlowSell: -0.0003,
  maxRet10Abs:   0.0040,
  maxRet30Abs:   0.0080
};

const MIN_POSITION_USDC = 5;

// ---------- Binance client ----------
const client = Binance({
  apiKey: BINANCE_API_KEY,
  apiSecret: BINANCE_API_SECRET
});

// ---------- stanje ----------
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

async function getUsdcBalance() {
  const accountInfo = await client.accountInfo();
  const usdc = accountInfo.balances.find(b => b.asset === 'USDC');
  return usdc ? parseFloat(usdc.free) : 0;
}

// ---------- analiza + trade ----------
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
      log('NO_NEGATIVE_DAY aktivan, preveliki minus. PnL% =', dailyPnlPct.toFixed(2));
      return;
    }

    if (tradesToday >= maxTradesPerDay) {
      log('MAX_TRADES_PER_DAY dostignut, pauza za danas.');
      return;
    }

    // uzmi 30 × 1m candle
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

    // volatilnost filter
    if (vol30 < SIGNAL_CFG.volMin || vol30 > SIGNAL_CFG.volMax) {
      log(`Volatilnost out-of-range: ${(vol30*100).toFixed(2)}% -> skip.`);
      return;
    }

    // brutalni spike filter
    if (Math.abs(ret10) > SIGNAL_CFG.maxRet10Abs || Math.abs(ret30) > SIGNAL_CFG.maxRet30Abs) {
      log(`Previše jak nagib (ret10=${(ret10*100).toFixed(2)}%, ret30=${(ret30*100).toFixed(2)}%), skip.`);
      return;
    }

    // ako imamo poziciju -> prvo njom upravljamo
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

    log(
      `Analiza ${SYMBOL}: ret10=${(ret10*100).toFixed(3)}% ret30=${(ret30*100).toFixed(3)}% vol30=${(vol30*100).toFixed(2)}%`
    );

    if (!strongUp && !strongDown) {
      log('Nema jasnog signala -> čekam.');
      return;
    }

    const side = strongUp ? 'BUY' : 'SELL';

    const balanceUSDC = await getUsdcBalance();
    if (balanceUSDC <= 0) {
      log('Nema USDC balansa.');
      return;
    }

    const usedUSDC = balanceUSDC * posSizePct;
    if (usedUSDC < MIN_POSITION_USDC) {
      log(`Premali balans/pozicija (ispod ${MIN_POSITION_USDC} USDC).`);
      return;
    }

    const qty = usedUSDC / lastClose;
    tradesToday += 1;

    log(`OTVARANJE ${side} pozicije: qty=${qty.toFixed(6)} @ ${lastClose}`);

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
        tradesToday -= 1;
        return;
      }
    } else {
      log('(SIMULACIJA) LIVE_TRADING=false, ne šaljem pravi order.');
    }

    openPosition = {
      side,
      entryPrice: lastClose,
      qty,
      highest: lastClose,
      lowest: lastClose,
      tpLow:  lastClose * (1 + (side === 'BUY' ?  tpLowPct/100 : -tpLowPct/100)),
      tpHigh: lastClose * (1 + (side === 'BUY' ?  tpHighPct/100 : -tpHighPct/100)),
      slHard: lastClose * (1 + (side === 'BUY' ? -stopLossPct/100 :  stopLossPct/100)),
      trailingActive: false,
      trailingStopPrice: null
    };

  } catch (err) {
    console.error('Greška u analyzeAndTrade:', err.message || err);
  }
}

// ---------- upravljanje otvorenom pozicijom ----------
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

  // aktiviraj trailing
  if (!pos.trailingActive && trailingStop && movePct >= slStartPct) {
    pos.trailingActive = true;
    pos.trailingStopPrice = pos.side === 'BUY'
      ? lastPrice * (1 - trailStepPct/100)
      : lastPrice * (1 + trailStepPct/100);
    log('Trailing stop AKTIVIRAN @', pos.trailingStopPrice.toFixed(2));
  }

  // pomjeri trailing
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

// ---------- zatvaranje pozicije ----------
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
    log('(SIMULACIJA) LIVE_TRADING=false, ne šaljem close order.');
  }

  const pnlPct = (price - pos.entryPrice) / pos.entryPrice * (pos.side === 'BUY' ? 100 : -100);
  dailyPnlPct += pnlPct;

  log(`Trade PnL: ${pnlPct.toFixed(2)}% | Daily PnL: ${dailyPnlPct.toFixed(2)}%`);

  openPosition = null;
}

// ---------- glavni loop ----------
async function mainLoop() {
  await analyzeAndTrade();
}

log('BTC bot startan za simbol', SYMBOL, '| liveTrading =', liveTrading);
setInterval(mainLoop, SIGNAL_CFG.intervalMs);
