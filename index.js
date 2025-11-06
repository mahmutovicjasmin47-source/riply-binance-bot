require('dotenv').config();
const Binance = require('node-binance-api');

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET
});

// CONFIG
const SYMBOL = "BTCUSDC"; // TRGUJEMO SA BTC/USDC
const INVEST_PERCENT = 0.9; // 90% NOVCA UĐE U TRADE
const TAKE_PROFIT = 0.9 / 100; // 0.9% TAKE PROFIT
const STOP_LOSS = 0.4 / 100; // 0.4% STOP LOSS

async function runBot() {
  try {
    const account = await binance.balance();
    const usdcBalance = parseFloat(account.USDC.available);

    if (usdcBalance <= 0) return console.log("Nema sredstava za trgovinu.");

    const investAmount = usdcBalance * INVEST_PERCENT;

    console.log(`Kupujem BTC za ${investAmount} USDC...`);

    let buyOrder = await binance.marketBuy(SYMBOL, investAmount / (await getPrice()));

    const entryPrice = parseFloat(buyOrder.fills[0].price);

    console.log(`Kupljeno po cijeni: ${entryPrice}`);

    const tpPrice = entryPrice * (1 + TAKE_PROFIT);
    const slPrice = entryPrice * (1 - STOP_LOSS);

    console.log(`Take Profit na: ${tpPrice}`);
    console.log(`Stop Loss na: ${slPrice}`);

    // Praćenje cijene u realnom vremenu
    binance.websockets.trades([SYMBOL], trade => {
      const price = parseFloat(trade.p);

      if (price >= tpPrice) {
        console.log("Cijena dosegla take profit! Prodajem...");
        binance.marketSell(SYMBOL, buyOrder.executedQty);
      }

      if (price <= slPrice) {
        console.log("Cijena pala na stop loss! Prodajem...");
        binance.marketSell(SYMBOL, buyOrder.executedQty);
      }
    });

  } catch (err) {
    console.log("Greška: ", err);
  }
}

async function getPrice() {
  const price = await binance.prices(SYMBOL);
  return parseFloat(price[SYMBOL]);
}

runBot();
