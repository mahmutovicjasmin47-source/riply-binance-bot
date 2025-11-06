// ==========================================
//  RIPLY BINANCE SPOT BOT — 90% + OCO (SL/TP)
//  Fokus: minimalan gubitak (vrlo tijesan SL)
//  Mode B: dozvoljeni višestruki ulazi (average up/down)
// ==========================================

const Binance = require('node-binance-api');

// -------- ENV --------
const API_KEY    = process.env.BINANCE_API_KEY || "";
const API_SECRET = process.env.BINANCE_API_SECRET || "";
const SYMBOL     = (process.env.SYMBOL || "BTCEUR").toUpperCase();
const LIVE_TRADING = (process.env.LIVE_TRADING || "false").toString().toLowerCase() === "true";
// Preporuka za minimalni gubitak:
const STOP_LOSS_PCT   = parseFloat(process.env.STOP_LOSS_PCT || "0.15"); // % npr 0.15
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || "0.55"); // % npr 0.55

const mask = s => (s ? s.slice(0,4) + "…" + s.slice(-4) : "none");
console.log("[ENV] SYMBOL:", SYMBOL, "| LIVE:", LIVE_TRADING);
console.log("[ENV] KEY:", mask(API_KEY), "| SECRET:", mask(API_SECRET));
console.log("[ENV] SL%:", STOP_LOSS_PCT, "| TP%:", TAKE_PROFIT_PCT);

if (!API_KEY || !API_SECRET) {
  console.error("❌ Nedostaje BINANCE_API_KEY ili BINANCE_API_SECRET.");
  process.exit(1);
}

// -------- Klijent --------
const client = Binance().options({
  APIKEY: API_KEY,
  APISECRET: API_SECRET,
  recvWindow: 20_000,
});

// -------- Exchange info / filteri --------
let F = null; // filters
async function loadSymbolFilters() {
  const info = await client.exchangeInfo();
  const s = info.symbols.find(x => x.symbol === SYMBOL);
  if (!s) throw new Error(`Symbol ${SYMBOL} nije dozvoljen za tvoj račun.`);
  const lot  = s.filters.find(f => f.filterType === "LOT_SIZE");
  const tick = s.filters.find(f => f.filterType === "PRICE_FILTER");
  const noti = s.filters.find(f => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
  F = {
    stepSize: parseFloat(lot?.stepSize || "0.000001"),
    minQty: parseFloat(lot?.minQty || "0.000001"),
    tickSize: parseFloat(tick?.tickSize || "0.01"),
    minNotional: parseFloat(noti?.minNotional || "5"),
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset, // USDT/EUR...
  };
  console.log("[FILTER] stepSize:", F.stepSize, "tickSize:", F.tickSize, "minNotional:", F.minNotional, "| quote:", F.quoteAsset);
}
function roundToStep(qty, step) { return Math.floor(qty / step) * step; }
function roundToTick(price, tick){ return Math.floor(price / tick) * tick; }

// -------- Balansi / cijena --------
async function getSpotPrice() {
  const prices = await client.prices(SYMBOL);
  if (!prices || !prices[SYMBOL]) throw new Error("Price not available.");
  return parseFloat(prices[SYMBOL]);
}
async function getQuoteFree() {
  // FREE balans u kotiranoj valuti (USDT/EUR...)
  const acc = await client.accountInfo();
  const q = acc.balances.find(b => b.asset === F.quoteAsset);
  return q ? parseFloat(q.free) : 0;
}

// -------- Guardovi (za “minimalni gubitak”) --------
// 1) Ne trguj ako je spread prevelik (loša likvidnost)
async function spreadIsTight(maxBps = 10) {
  // maxBps = 10 -> 0.10%
  const ob = await client.bookTickers(SYMBOL);
  const bid = parseFloat(ob.bidPrice), ask = parseFloat(ob.askPrice);
  const mid = (bid + ask) / 2;
  if (!bid || !ask) return false;
  const bps = ((ask - bid) / mid) * 10000;
  return bps <= maxBps;
}
// 2) Ne trguj ako je volatilnost 1m prevelika (lagani guard)
async function oneMinuteVolatilityOk(maxPct = 0.6) {
  try {
    const kl = await client.candlesticks(SYMBOL, "1m", { limit: 3 });
    if (!Array.isArray(kl) || kl.length === 0) return true;
    // zadnja svijeća
    const k = kl[kl.length - 1];
    const o = parseFloat(k[1]), h = parseFloat(k[2]), l = parseFloat(k[3]);
    const vol = ((h - l) / o) * 100;
    return vol <= maxPct;
  } catch { return true; }
}

// -------- 90% dynamic sizing + kupovina + OCO --------
async function buyWithOco90() {
  // Guard: spread i volat.
  const tight = await spreadIsTight(10);      // 0.10%
  const calm  = await oneMinuteVolatilityOk(0.6); // 0.6%
  if (!tight) { console.log("⛔ Spread previsok — preskačem tick."); return; }
  if (!calm)  { console.log("⛔ Volatilnost previsoka — preskačem tick."); return; }

  const price = await getSpotPrice();
  const slPrice = roundToTick(price * (1 - STOP_LOSS_PCT / 100), F.tickSize);
  const tpPrice = roundToTick(price * (1 + TAKE_PROFIT_PCT / 100), F.tickSize);

  // izračun potrošnje u kotiranoj valuti (USDT/EUR) — 90% FREE
  const freeQ = await getQuoteFree();
  const spendQuote = Math.floor((freeQ * 0.90) * 100) / 100; // 2 decimale quote (dovoljno)
  if (spendQuote < F.minNotional) {
    console.log(`⛔ Premalo ${F.quoteAsset} (free ${freeQ.toFixed(2)}). MIN_NOTIONAL=${F.minNotional}.`);
    return;
  }

  if (!LIVE_TRADING) {
    console.log(`SIM: kupovina za ~${spendQuote} ${F.quoteAsset} @ ~${price}. OCO: TP=${tpPrice}, SL=${slPrice}`);
    return;
  }

  // MARKET BUY koristeći quoteOrderQty (iznos u USDT/EUR)
  console.log(`🟢 MARKET BUY ~${spendQuote} ${F.quoteAsset}...`);
  const buy = await client.marketBuy(SYMBOL, 0, { quoteOrderQty: spendQuote });

  // izračun kupljene količine (executedQty) i avg cijene
  const executedQty = parseFloat(buy?.executedQty || 0);
  if (executedQty <= 0) {
    console.log("⚠️ Nije dobijena executedQty; prekidam OCO.");
    return;
  }
  // Zaokruži qty na LOT step
  const qty = Math.max(roundToStep(executedQty, F.stepSize), F.minQty);
  // OCO SELL: limit TP + stop-limit SL
  // Ako je TP<=SL zbog tick rounding, malo ih odmakni
  let tp = tpPrice, sl = slPrice;
  if (tp <= sl) tp = roundToTick(sl + F.tickSize * 2, F.tickSize);

  console.log(`📌 Postavljam OCO SELL: qty=${qty} ${F.baseAsset} | TP=${tp} | SL=${sl}`);
  const oco = await client.orderOcoSell({
    symbol: SYMBOL,
    quantity: qty,
    price: tp.toFixed(8),
    stopPrice: sl.toFixed(8),
    stopLimitPrice: sl.toFixed(8),
    stopLimitTimeInForce: "GTC",
  });
  console.log("✅ OCO postavljen:", (oco?.orderReports || []).map(r => r.status).join(", "));
}

// -------- Glavni loop --------
// Minimalistički loop: svake 60s pokušaj jedan ulaz (Mode B dozvoljava više ulaza)
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const price = await getSpotPrice();
    const sl = price * (1 - STOP_LOSS_PCT / 100);
    const tp = price * (1 + TAKE_PROFIT_PCT / 100);
    console.log(`${SYMBOL} = ${price.toFixed(2)} | SL: ${sl.toFixed(2)} | TP: ${tp.toFixed(2)}`);

    await buyWithOco90(); // pokušaj ulaza + OCO zaštita
  } catch (e) {
    const msg = e.body || e.message || e;
    console.error("Greška:", msg);
    if (typeof msg === "string" && msg.includes("Invalid API-key")) {
      console.error("Provjeri: Enable Reading + Enable Spot & Margin Trading; i da su API key/secret tačni.");
    }
    if (typeof msg === "string" && msg.includes("insufficient balance")) {
      console.error("Nedovoljan balans u " + (F?.quoteAsset ?? "quote asset") + ".");
    }
  } finally {
    busy = false;
  }
}

// -------- Start --------
(async () => {
  try {
    await loadSymbolFilters();
    await tick();
    setInterval(tick, 60 * 1000); // svakih 60s
  } catch (e) {
    console.error("Fatal:", e.body || e.message || e);
    process.exit(1);
  }
})();

// Keep-alive server (Railway)
require('http')
  .createServer((_, res) => res.end('ok'))
  .listen(process.env.PORT || 8080, () => console.log("Bot pokrenut…"));
