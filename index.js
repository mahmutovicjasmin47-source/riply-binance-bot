// ===============================
//  R I P L Y   B I N A N C E  B O T
//  SPOT – auto 90% position sizing
// ===============================

const Binance = require('node-binance-api');

// --- ENV ---
const API_KEY    = process.env.BINANCE_API_KEY || process.env.API_KEY || "";
const API_SECRET = process.env.BINANCE_API_SECRET || process.env.BINANCE_SECRET_KEY || process.env.API_SECRET || "";

const SYMBOL           = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const STOP_LOSS_PCT    = parseFloat(process.env.STOP_LOSS_PCT || "0.4"); // %
const TAKE_PROFIT_PCT  = parseFloat(process.env.TAKE_PROFIT_PCT || "0.6"); // %
const LIVE_TRADING     = (process.env.LIVE_TRADING || "false").toString().toLowerCase() === "true";

// mask mali
const mask = s => (s ? s.slice(0, 4) + "..." + s.slice(-4) : "");
console.log("[ENV] SYMBOL:", SYMBOL, "| LIVE:", LIVE_TRADING);
console.log("[ENV] API_KEY:", mask(API_KEY), "| API_SECRET:", mask(API_SECRET));

// provjera ključeva
if (!API_KEY || !API_SECRET) {
  console.error("ENV problem: nedostaje BINANCE_API_KEY ili BINANCE_API_SECRET.");
  process.exit(1);
}

// --- Binance klijent (SPOT) ---
const client = Binance().options({
  APIKEY: API_KEY,
  APISECRET: API_SECRET,
  recvWindow: 20_000,
});

// --- Pomoćne funkcije ---
async function getSpotPrice(symbol) {
  const prices = await client.prices(symbol);
  if (!prices || !prices[symbol]) throw new Error("Price not available.");
  return parseFloat(prices[symbol]);
}

async function getUsdtFree() {
  const acc = await client.accountInfo();
  const usdt = acc.balances.find(b => b.asset === "USDT");
  return usdt ? parseFloat(usdt.free) : 0;
}

// 90% od dostupnog USDT balansa
async function getDynamicPositionSize() {
  try {
    const free = await getUsdtFree();
    const spend = free * 0.90;
    return spend > 0 ? spend : 0;
  } catch (e) {
    console.log("Greška pri dohvatu balansa:", e.body || e.message);
    return 0;
  }
}

// MARKET kupovina korištenjem quoteOrderQty (iznos u USDT)
async function marketBuyQuote(symbol, quoteAmount) {
  // node-binance-api: quantity=0 i options.quoteOrderQty = iznos u kotiranoj valuti (USDT)
  return client.marketBuy(symbol, 0, { quoteOrderQty: quoteAmount });
}

// Jednostavan „tick“ – prikaže cijenu, SL/TP, i (ako je LIVE) pokuša kupiti za 90% USDT
let placing = false;
async function tick() {
  if (placing) return;
  try {
    const price = await getSpotPrice(SYMBOL);
    const sl = price * (1 - STOP_LOSS_PCT / 100);
    const tp = price * (1 + TAKE_PROFIT_PCT / 100);
    console.log(`${SYMBOL} = ${price.toFixed(2)} | SL: ${sl.toFixed(2)} | TP: ${tp.toFixed(2)}`);

    if (!LIVE_TRADING) {
      console.log("Simulacija (LIVE_TRADING=false) – bez naloga.");
      return;
    }

    const spend = await getDynamicPositionSize();
    if (spend < 5) {
      console.log("Premalo USDT za trgovanje (potrebno > 5 USDT).");
      return;
    }

    placing = true;
    console.log(`Pokušaj kupovine MARKET za ~${spend.toFixed(2)} USDT (90% balansa)...`);
    const order = await marketBuyQuote(SYMBOL, spend);
    console.log("BUY OK:", order.orderId || order);

    // SL/TP zapis samo informativno (egzekuciju SL/TP možeš dodati kasnije kao OCO)
    console.log("Napomena: SL/TP nisu postavljeni kao nalog u ovoj verziji; dodati OCO ako želiš auto-izlaz.");

  } catch (e) {
    const msg = e.body || e.message || e;
    console.error("Greška:", msg);
    if (typeof msg === "string" && msg.includes("Invalid API-key")) {
      console.error("Provjeri API permissions (Enable Reading + Enable Spot & Margin Trading) i da koristiš ispravne ključeve.");
    }
    if (typeof msg === "string" && msg.includes("insufficient balance")) {
      console.error("Nedovoljan balans – provjeri USDT spot balans.");
    }
  } finally {
    placing = false;
  }
}

// pokreni odmah i onda svakih 60s
tick();
setInterval(tick, 60 * 1000);

// lagani keep-alive na Railway
require('http').createServer((_, res) => res.end('ok')).listen(process.env.PORT || 8080, () => {
  console.log("Bot pokrenut…");
});
