// index.js – FINAL verzija scalping bota za Railway (BTC / ETH / BNB spot USDC)

// ✅ DEPENDENCY: binance-api-node
const Binance = require('binance-api-node').default;

// ====== ENV VARIJABLE (podesi u Railway) ======
const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,

  SYMBOL = 'BTCUSDC',        // npr. BTCUSDC / ETHUSDC / BNBUSDC
  LIVE_TRADING = 'false',    // 'true' za pravi trading, 'false' za simulaciju

  // Rizik / money management
  POSITION_SIZE_PCT = '0.60', // koliko % USDC balansa koristiti (0.60 = 60%)
  DAILY_TARGET_PCT  = '25.0',
  MAX_TRADES_PER_DAY = '80',
  NO_NEGATIVE_DAY   = 'false', // 'true' = stop ako padneš -DAILY_TARGET

  // SL / TP
  STOP_LOSS_PCT   = '0.5',
  TAKE_PROFIT_PCT = '0.12', // ne koristi se direktno, imamo TP_LOW/HIGH
  TP_LOW_PCT      = '0.08',
  TP_HIGH_PCT     = '0.14',

  // Trailing stop
  SL_START_PCT   = '0.10',
  TRAILING_STOP  = 'true',
  TRAIL_STEP_PCT = '0.05'
} = process.env;

// konverzija tipova
const liveTrading     = LIVE_TRADING === 'true';
const posSizePct      = parseFloat(POSITION_SIZE_PCT);
const dailyTargetPct  = parseFloat(DAILY_TARGET_PCT);
const maxTradesPerDay = parseInt(MAX_TRADES_PER_DAY, 10);
const noNegativeDay   = NO_NEGATIVE_DAY === 'true';

const stopLossPct   = parseFloat(STOP_LOSS_PCT);
const tpLowPct      = parseFloat(TP_LOW_PCT);
const tpHighPct     = parseFloat(TP_HIGH_PCT);
const slStartPct    = parseFloat(SL_START_PCT);
const trailingStop  = TRAILING_STOP === 'true';
const trailStepPct  = parseFloat(TRAIL_STEP_PCT);

// ====== SIGNAL CONFIG (safe-aggressive) ======
const SIGNAL_CFG = {
  intervalMs:     10000,   // 10s između analiza
  volMin:         0.0005,  // 0.05% min volatilnost
  volMax:         0.0100,  // 1.00% max volatilnost
  slopeFastBuy:   0.0007,  // +0.07% u ~10 minuta
  slopeSlowBuy:   0.0003,  // +0.03% u ~30 minuta
  maxRet10Abs:    0.0040,  // 0.4% – ako više, preskoči
  maxRet30Abs:    0.0080   // 0.8% – ako više, preskoči
};

// ====== Binance client ======
const client = Binance({
  apiKey: BINANCE_API_KEY,
  apiSecret: BINANCE_API_SECRET
});

// ====== STANJE BOTA ======
let openPosition = null;  // { side, entryPrice, qty, ... }
let dailyPnlPct = 0;
let tradesToday = 0;
let lastDay = null;

let symbolFilters = null; // LOT_SIZE / MIN_NOTIONAL info
let keepAliveCounter = 0;

function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// ====== UČITAVANJE SYMBOL INFO (LOT_SIZE, MIN_NOTIONAL) ======
async function loadSymbolFilters() {
  const info = await client.exchangeInfo();
  const sym = info.symbols.find(s => s.symbol === SYMBOL);
  if (!sym) {
    throw new Error(`Symbol ${SYMBOL} nije pronađen u exchangeInfo`);
  }

  const lot = sym.filters.find(f => f.filterType === 'LOT_SIZE');
  const minNotional = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL');

  const minQty = lot ? parseFloat(lot.minQty) : 0;
  const stepSize = lot ? parseFloat(lot.stepSize) : 0;
  const minNotionalVal = minNotional ? parseFloat(minNotional.minNotional) : 0;

  // broj decimala iz stepSize (npr. 0.0001 -> 4)
  let qtyDecimals = 6;
  if (lot && lot.stepSize.includes('.')) {
    qtyDecimals = lot.stepSize.split('.')[1].length;
  }

  symbolFilters = {
    minQty,
    stepSize,
    minNotional: minNotionalVal,
    qtyDecimals
  };

  log('Symbol filters učitani za', SYMBOL, '| minQty =', minQty, 'stepSize =', stepSize, 'minNotional =', minNotionalVal);
}

// pomoćna za LOT_SIZE
function floorToStep(qty, stepSize) {
  if (!stepSize || stepSize === 0) return qty;
  return Math.floor(qty / stepSize) * stepSize;
}

// ====== BALANS USDC ======
async function getAccountBalanceUSDC() {
  const accountInfo = await client.accountInfo();
  const usdc = accountInfo.balances.find(b => b.asset === 'USDC');
  return usdc ? parseFloat(usdc.free) : 0;
}

// ====== GLAVNA ANALIZA ======
async function analyzeAndTrade() {
  try {
    // dnevni reset
    const today = getDateKey();
    if (lastDay !== today) {
      lastDay = today;
      tradesToday = 0;
      dailyPnlPct = 0;
      log('--- Novi dan, reset brojača ---');
    }

    // dnevni target / zaštita
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

    // 30x1m candle
    const candles = await client.candles({ symbol: SYMBOL, interval: '1m', limit: 30 });
    if (!candles || candles.length < 10) {
      log('Premalo candle podataka.');
      return;
    }

    const closes = candles.map(c => parseFloat(c.close));
    const lastClose = closes[closes.length - 1];
    const first10  = closes[closes.length - 10];
    const first30  = closes[0];

    const ret10 = (lastClose - first10) / first10;
    const ret30 = (lastClose - first30) / first30;

    const high30 = Math.max(...closes);
    const low30  = Math.min(...closes);
    const vol30  = (high30 - low30) / lastClose;

    // volatilnost filter
    if (vol30 < SIGNAL_CFG.volMin || vol30 > SIGNAL_CFG.volMax) {
      log(`Volatilnost out-of-range: ${(vol30 * 100).toFixed(2)}% -> skip.`);
      return;
    }

    // prejaki nagibi (previše ludo)
    if (Math.abs(ret10) > SIGNAL_CFG.maxRet10Abs || Math.abs(ret30) > SIGNAL_CFG.maxRet30Abs) {
      log(`Previše jak nagib (ret10=${(ret10*100).toFixed(2)}%, ret30=${(ret30*100).toFixed(2)}%), skip.`);
      return;
    }

    // Ako je pozicija već otvorena, samo njom upravljamo
    if (openPosition) {
      await manageOpenPosition(lastClose);
      return;
    }

    // *** NEMA POZICIJE -> TRAŽIMO BUY SIGNAL (nema shorta) ***
    const strongUp =
      ret10 >= SIGNAL_CFG.slopeFastBuy &&
      ret30 >= SIGNAL_CFG.slopeSlowBuy;

    log(`Analiza ${SYMBOL}: ret10=${(ret10*100).toFixed(3)}% ret30=${(ret30*100).toFixed(3)}% vol30=${(vol30*100).toFixed(2)}%`);

    if (strongUp) {
      await openTrade('BUY', lastClose);
    } else {
      log('Nema jasnog signala -> čekam.');
    }

  } catch (err) {
    console.error('Greška u analyzeAndTrade:', err.message || err);
  }
}

// ====== OTVARANJE TRADE-A (samo BUY na spotu) ======
async function openTrade(side, price) {
  if (tradesToday >= maxTradesPerDay) return;
  if (!symbolFilters) {
    log('Symbol filters nisu učitani – skip.');
    return;
  }

  const balanceUSDC = await getAccountBalanceUSDC();
  if (balanceUSDC <= 0) {
    log('Nema USDC balansa za otvaranje pozicije.');
    return;
  }

  // koristimo dio balansa (60%, 30%, 10%...)
  const usedUSDC = balanceUSDC * posSizePct;

  // minimalna vlastita granica 5 USDC
  if (usedUSDC < 5) {
    log('Premali balans/pozicija (ispod 5 USDC).');
    return;
  }

  // izračun qty iz USDC
  let qty = usedUSDC / price;

  // LOT_SIZE – floor na stepSize
  qty = floorToStep(qty, symbolFilters.stepSize);

  // provjera LOT_SIZE i MIN_NOTIONAL
  if (qty < symbolFilters.minQty) {
    log('Premali qty za LOT_SIZE. qty=', qty, 'minQty=', symbolFilters.minQty);
    return;
  }

  const notional = qty * price;
  if (notional < symbolFilters.minNotional) {
    log('Premali notional za MIN_NOTIONAL. notional=', notional.toFixed(4), 'minNotional=', symbolFilters.minNotional);
    return;
  }

  const qtyStr = qty.toFixed(symbolFilters.qtyDecimals);

  tradesToday += 1;
  log(`OTVARANJE ${side} pozicije: qty=${qtyStr} @ ${price}`);

  if (liveTrading) {
    try {
      await client.order({
        symbol: SYMBOL,
        side: 'BUY',       // samo BUY ulaz
        type: 'MARKET',
        quantity: qtyStr
      });
    } catch (err) {
      console.error('Greška pri slanju ORDER-a:', err.message || err);
      return; // ne otvaramo poziciju ako order faila
    }
  } else {
    log('(SIMULACIJA) LIVE_TRADING=false, ne šaljem pravi ORDER.');
  }

  // upisujemo stanje otvorene pozicije
  openPosition = {
    side: 'BUY',
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

// ====== UPRAVLJANJE OTVORENOM POZICIJOM ======
async function manageOpenPosition(lastPrice) {
  const pos = openPosition;
  if (!pos) return;

  // update high/low
  if (lastPrice > pos.highest) pos.highest = lastPrice;
  if (lastPrice < pos.lowest)  pos.lowest  = lastPrice;

  const movePct = (lastPrice - pos.entryPrice) / pos.entryPrice * 100;

  // aktivacija trailing stopa
  if (!pos.trailingActive && trailingStop && movePct >= slStartPct) {
    pos.trailingActive = true;
    pos.trailingStopPrice = lastPrice * (1 - trailStepPct / 100);
    log('Trailing stop AKTIVIRAN @', pos.trailingStopPrice.toFixed(2));
  }

  // pomjeranje trailing stopa
  if (pos.trailingActive && pos.trailingStopPrice) {
    const candidate = lastPrice * (1 - trailStepPct / 100);
    if (candidate > pos.trailingStopPrice) {
      pos.trailingStopPrice = candidate;
      log('Trailing stop BUY pomjeren @', pos.trailingStopPrice.toFixed(2));
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

  // TP zona
  const hitLow  = lastPrice >= pos.tpLow;
  const hitHigh = lastPrice >= pos.tpHigh;

  if (hitHigh) {
    await closePosition(lastPrice, 'TP_HIGH');
  } else if (hitLow && !pos.trailingActive) {
    await closePosition(lastPrice, 'TP_LOW');
  } else {
    log(`Pozicija (BUY) @${pos.entryPrice}, sada ${lastPrice}, move=${movePct.toFixed(2)}%`);
  }
}

// ====== ZATVARANJE POZICIJE (SELL MARKET) ======
async function closePosition(price, reason) {
  const pos = openPosition;
  if (!pos) return;

  const qtyStr = pos.qty.toFixed(symbolFilters ? symbolFilters.qtyDecimals : 6);
  log(`ZATVARANJE pozicije (${reason}) po cijeni ${price}, qty=${qtyStr}`);

  if (liveTrading) {
    try {
      await client.order({
        symbol: SYMBOL,
        side: 'SELL',
        type: 'MARKET',
        quantity: qtyStr
      });
    } catch (err) {
      console.error('Greška pri zatvaranju ORDER-a:', err.message || err);
      // čak i ako faila, nećemo ostaviti openPosition zauvijek
    }
  } else {
    log('(SIMULACIJA) LIVE_TRADING=false, ne šaljem SELL ORDER.');
  }

  const pnlPct = (price - pos.entryPrice) / pos.entryPrice * 100;
  dailyPnlPct += pnlPct;
  log(`Trade PnL: ${pnlPct.toFixed(2)}% | Daily PnL: ${dailyPnlPct.toFixed(2)}%`);

  openPosition = null;
}

// ====== GLAVNI LOOP + KEEPALIVE ======
async function mainLoop() {
  await analyzeAndTrade();

  keepAliveCounter += 1;
  if (keepAliveCounter % 60 === 0) {
    log('KEEPALIVE ping — bot je živ.');
  }
}

// ====== START ======
async function start() {
  try {
    await loadSymbolFilters();
  } catch (err) {
    console.error('Greška pri učitavanju symbol filters:', err.message || err);
    return;
  }

  log('Bot startan za simbol', SYMBOL, '| liveTrading =', liveTrading);
  await mainLoop();
  setInterval(mainLoop, SIGNAL_CFG.intervalMs);
}

start();
