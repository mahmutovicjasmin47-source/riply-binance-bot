// index.js – backend bot za Railway (Node.js), BEZ browser koda

const Binance = require('binance-api-node').default;

// ===== Env varijable =====
const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,
  SYMBOL = 'BTCUSDC',
  LIVE_TRADING = 'false',
  STOP_LOSS_PCT = '0.5',
  TAKE_PROFIT_PCT = '0.5',
  TP_LOW_PCT = '0.3',
  TP_HIGH_PCT = '0.7',
  DAILY_TARGET_PCT = '6.0',
  MAX_TRADES_PER_DAY = '25',
  POSITION_SIZE_PCT = '0.30',
  SL_START_PCT = '0.3',
  TRAILING_STOP = 'true',
  TRAIL_STEP_PCT = '0.15',
  NO_NEGATIVE_DAY = 'true'
} = process.env;

// konverzija u brojeve / boole
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

// ===== Binance client =====
const client = Binance({
  apiKey: BINANCE_API_KEY,
  apiSecret: BINANCE_API_SECRET
});

// ===== stanje bota =====
let openPosition = null; // { side, entryPrice, qty, highest, lowest }
let dailyPnlPct = 0;
let tradesToday = 0;
let lastDay = null;

async function getAccountBalanceUSDC() {
  const accountInfo = await client.accountInfo();
  const usdc = accountInfo.balances.find(b => b.asset === 'USDC');
  return usdc ? parseFloat(usdc.free) : 0;
}

// helper za datum (YYYY-MM-DD)
function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}

// log helper
function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// ===== strategija: analiza 1m candle-a =====
async function analyzeAndTrade() {
  try {
    const today = getDateKey();
    if (lastDay !== today) {
      // reset brojača novog dana
      lastDay = today;
      tradesToday = 0;
      dailyPnlPct = 0;
      log('--- Novi dan, reset brojača ---');
    }

    if (dailyPnlPct >= dailyTargetPct) {
      log('DAILY TARGET hit, više ne trgujem danas. PnL% =', dailyPnlPct.toFixed(2));
      return;
    }

    if (noNegativeDay && dailyPnlPct < -dailyTargetPct) {
      log('NO_NEGATIVE_DAY aktivan, u prevelikom minusu – pauza za danas.', dailyPnlPct.toFixed(2));
      return;
    }

    if (tradesToday >= maxTradesPerDay) {
      log('MAX_TRADES_PER_DAY dostignut, više ne trgujem danas.');
      return;
    }

    // zadnjih 30 minuta 1m candle
    const candles = await client.candles({ symbol: SYMBOL, interval: '1m', limit: 30 });

    if (!candles || candles.length < 10) {
      log('Premalo candle podataka.');
      return;
    }

    const closes = candles.map(c => parseFloat(c.close));
    const lastClose = closes[closes.length - 1];
    const first10 = closes[closes.length - 10];
    const first30 = closes[0];

    const ret10 = (lastClose - first10) / first10; // kraći nagib
    const ret30 = (lastClose - first30) / first30; // duži nagib

    const high30 = Math.max(...closes);
    const low30  = Math.min(...closes);
    const vol30  = (high30 - low30) / lastClose;

    // Lagani filter – tržište ne smije biti mrtvo
    if (vol30 < 0.001) {
      log('Niska volatilnost, preskačem. Vol30=', (vol30*100).toFixed(2)+'%');
      return;
    }

    // Ako imamo otvorenu poziciju, prvo provjeri SL/TP/trailing
    if (openPosition) {
      await manageOpenPosition(lastClose);
      return;
    }

    // NEMAMO poziciju → tražimo ulaz
    const strongUp   = ret10 > 0.001 && ret30 > 0.0005;   // 0.10% i 0.05%+
    const strongDown = ret10 < -0.001 && ret30 < -0.0005; // -0.10% i -0.05%-

    log(`Analiza: ret10=${(ret10*100).toFixed(2)}% ret30=${(ret30*100).toFixed(2)}% vol30=${(vol30*100).toFixed(2)}%`);

    if (strongUp) {
      await openTrade('BUY', lastClose);
    } else if (strongDown) {
      await openTrade('SELL', lastClose);
    } else {
      log('Nema jasnog signala -> čekam.');
    }

  } catch (err) {
    console.error('Greška u analyzeAndTrade:', err.message || err);
  }
}

async function openTrade(side, price) {
  if (tradesToday >= maxTradesPerDay) return;

  const balanceUSDC = await getAccountBalanceUSDC();
  if (balanceUSDC <= 0) {
    log('Nema USDC balansa za otvaranje pozicije.');
    return;
  }

  const usedUSDC = balanceUSDC * posSizePct;
  if (usedUSDC < 5) { // minimalno, da ne radi gluposti
    log('Premali balans/pozicija za otvaranje trejda.');
    return;
  }

  const qty = usedUSDC / price;
  tradesToday += 1;

  log(`OTVARANJE ${side} pozicije: qty=${qty.toFixed(6)} @ ${price}`);

  if (liveTrading) {
    try {
      if (side === 'BUY') {
        await client.order({
          symbol: SYMBOL,
          side: 'BUY',
          type: 'MARKET',
          quantity: qty.toFixed(6)
        });
      } else {
        await client.order({
          symbol: SYMBOL,
          side: 'SELL',
          type: 'MARKET',
          quantity: qty.toFixed(6)
        });
      }
    } catch (err) {
      console.error('Greška pri slanju ORDER-a:', err.message || err);
      return;
    }
  } else {
    log('(SIMULACIJA) – LIVE_TRADING=false, ne šaljem pravi order.');
  }

  openPosition = {
    side,
    entryPrice: price,
    qty,
    highest: price,
    lowest: price,
    tpLow:  price * (1 + (side === 'BUY' ? tpLowPct/100 : -tpLowPct/100)),
    tpHigh: price * (1 + (side === 'BUY' ? tpHighPct/100 : -tpHighPct/100)),
    slHard: price * (1 + (side === 'BUY' ? -stopLossPct/100 : stopLossPct/100)),
    trailingActive: false,
    trailingStopPrice: null
  };
}

// upravljanje otvorenom pozicijom (SL, TP, trailing)
async function manageOpenPosition(lastPrice) {
  const pos = openPosition;
  if (!pos) return;

  if (pos.side === 'BUY') {
    if (lastPrice > pos.highest) pos.highest = lastPrice;
    if (lastPrice < pos.lowest)  pos.lowest  = lastPrice;
  } else { // SELL
    if (lastPrice < pos.lowest)  pos.lowest  = lastPrice;
    if (lastPrice > pos.highest) pos.highest = lastPrice;
  }

  const movePct = (lastPrice - pos.entryPrice) / pos.entryPrice * (pos.side === 'BUY' ? 100 : -100);

  // aktiviraj trailing nakon SL_START_PCT u plusu
  if (!pos.trailingActive && trailingStop && movePct >= slStartPct) {
    pos.trailingActive = true;
    pos.trailingStopPrice = pos.side === 'BUY'
      ? lastPrice * (1 - trailStepPct/100)
      : lastPrice * (1 + trailStepPct/100);
    log('Trailing stop aktiviran, start=', pos.trailingStopPrice.toFixed(2));
  }

  // ažuriraj trailing stop
  if (pos.trailingActive) {
    if (pos.side === 'BUY') {
      const candidate = lastPrice * (1 - trailStepPct/100);
      if (candidate > pos.trailingStopPrice) {
        pos.trailingStopPrice = candidate;
        log('Trailing STOP pomjeren na', pos.trailingStopPrice.toFixed(2));
      }
    } else {
      const candidate = lastPrice * (1 + trailStepPct/100);
      if (candidate < pos.trailingStopPrice) {
        pos.trailingStopPrice = candidate;
        log('Trailing STOP pomjeren na', pos.trailingStopPrice.toFixed(2));
      }
    }
  }

  // HARD stop-loss
  if ((pos.side === 'BUY'  && lastPrice <= pos.slHard) ||
      (pos.side === 'SELL' && lastPrice >= pos.slHard)) {
    log('HARD SL pogođen.');
    await closePosition(lastPrice, 'SL_HARD');
    return;
  }

  // Trailing stop izlaz
  if (pos.trailingActive && pos.trailingStopPrice) {
    if ((pos.side === 'BUY'  && lastPrice <= pos.trailingStopPrice) ||
        (pos.side === 'SELL' && lastPrice >= pos.trailingStopPrice)) {
      log('TRAILING STOP pogođen.');
      await closePosition(lastPrice, 'TRAILING');
      return;
    }
  }

  // TP zona
  const hitLow  = pos.side === 'BUY'
    ? lastPrice >= pos.tpLow
    : lastPrice <= pos.tpLow;

  const hitHigh = pos.side === 'BUY'
    ? lastPrice >= pos.tpHigh
    : lastPrice <= pos.tpHigh;

  if (hitHigh) {
    await closePosition(lastPrice, 'TP_HIGH');
  } else if (hitLow && !pos.trailingActive) {
    // ako smo ušlu u TP zonu ali trailing još nije aktivan, uzmi profit
    await closePosition(lastPrice, 'TP_LOW');
  } else {
    log(`Pozicija otvorena (${pos.side}) @${pos.entryPrice}, sada ${lastPrice}, move=${movePct.toFixed(2)}%`);
  }
}

async function closePosition(price, reason) {
  const pos = openPosition;
  if (!pos) return;

  log(`ZATVARANJE pozicije (${reason}) po cijeni ${price}`);

  if (liveTrading) {
    try {
      if (pos.side === 'BUY') {
        await client.order({
          symbol: SYMBOL,
          side: 'SELL',
          type: 'MARKET',
          quantity: pos.qty.toFixed(6)
        });
      } else {
        await client.order({
          symbol: SYMBOL,
          side: 'BUY',
          type: 'MARKET',
          quantity: pos.qty.toFixed(6)
        });
      }
    } catch (err) {
      console.error('Greška pri zatvaranju ORDER-a:', err.message || err);
    }
  } else {
    log('(SIMULACIJA) – LIVE_TRADING=false, ne šaljem pravi close order.');
  }

  const pnlPct = (price - pos.entryPrice) / pos.entryPrice * (pos.side === 'BUY' ? 100 : -100);
  dailyPnlPct += pnlPct;
  log(`Trade završen. PnL za trade: ${pnlPct.toFixed(2)}% | Daily PnL: ${dailyPnlPct.toFixed(2)}%`);

  openPosition = null;
}

// ===== glavni loop =====
async function mainLoop() {
  await analyzeAndTrade();
}

// svake 15 sekundi
log('Bot startan za simbol', SYMBOL, '| liveTrading =', liveTrading);
setInterval(mainLoop, 15000);
