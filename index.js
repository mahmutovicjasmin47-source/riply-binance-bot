import dotenv from "dotenv";
import { Spot } from "@binance/connector";

dotenv.config();

const client = new Spot(
  process.env.BINANCE_API_KEY,
  process.env.BINANCE_API_SECRET
);

// ===============================
// KONFIGURACIJA BOTA
// ===============================
const PAIRS = ["BTCUSDC", "ETHUSDC"];   // Parovi
const INVEST_PERCENT = 0.70;            // 70% kapitala
const TAKE_PROFIT = 1.0;                // +1% target
const STOP_LOSS = -2.0;                 // -2% zaštita
const TRAILING = 0.40;                  // 0.40% trailing
// ===============================

let openPositions = {}; // Čuva aktivne tradove

console.log("🤖 Stabilni bot (Opcija A) pokrenut…");

// =====================================
// Funkcija: UZMI CIJENE
// =====================================
async function getPrices() {
  const data = await client.tickerPrice("");
  const result = {};
  data.forEach(p => {
    if (PAIRS.includes(p.symbol)) {
      result[p.symbol] = Number(p.price);
    }
  });
  return result;
}

// =====================================
// Funkcija: BUY
// =====================================
async function buySymbol(symbol, price) {
  try {
    // Uzimamo balance USDC
    const bal = await client.userAsset();
    const usdc = bal.data.find(a => a.asset === "USDC");
    const total = Number(usdc.free);

    const amountUSDC = total * INVEST_PERCENT;
    const qty = (amountUSDC / price).toFixed(6);

    await client.newOrder(symbol, "BUY", "MARKET", {
      quantity: qty,
    });

    openPositions[symbol] = {
      entry: price,
      highest: price,
      active: true
    };

    console.log(`🟢 BUY ${symbol} @ ${price} qty=${qty}`);
  } catch (err) {
    console.log(`❌ BUY error ${symbol}:`, err.response?.data || err);
  }
}

// =====================================
// Funkcija: SELL
// =====================================
async function sellSymbol(symbol, price) {
  try {
    const bal = await client.userAsset();
    const coin = symbol.replace("USDC", "");
    const asset = bal.data.find(a => a.asset === coin);

    if (!asset || Number(asset.free) <= 0) return;

    await client.newOrder(symbol, "SELL", "MARKET", {
      quantity: Number(asset.free).toFixed(6),
    });

    console.log(`🔴 SELL ${symbol} @ ${price}`);
    openPositions[symbol].active = false;
  } catch (err) {
    console.log(`❌ SELL error ${symbol}:`, err.response?.data || err);
  }
}

// =====================================
// GLAVNI LOOP
// =====================================
async function loop() {
  try {
    const prices = await getPrices();

    for (const symbol of PAIRS) {
      const price = prices[symbol];

      // Ako nema otvorene pozicije → kupi
      if (!openPositions[symbol] || !openPositions[symbol].active) {
        await buySymbol(symbol, price);
        continue;
      }

      let pos = openPositions[symbol];

      // trailing – pomjeraj najvišu cijenu
      if (price > pos.highest) pos.highest = price;

      const changeFromEntry = ((price - pos.entry) / pos.entry) * 100;
      const trailingDrop =
        ((price - pos.highest) / pos.highest) * 100;

      // 📌 TAKE PROFIT 1%
      if (changeFromEntry >= TAKE_PROFIT && trailingDrop <= -TRAILING) {
        await sellSymbol(symbol, price);
        continue;
      }

      // 📌 STOP LOSS -2%
      if (changeFromEntry <= STOP_LOSS) {
        await sellSymbol(symbol, price);
        continue;
      }

      // Print monitoring
      console.log(
        `⏱ ${symbol} price=${price} | entry=${pos.entry} | high=${pos.highest}`
      );
    }
  } catch (err) {
    console.log("⚠️ Greška u loop-u:", err);
  }

  setTimeout(loop, 3000); // radi svake 3 sekunde NON-STOP
}

loop();
