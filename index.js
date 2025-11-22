import dotenv from "dotenv";
import { Spot } from "@binance/connector";

dotenv.config();

// Binance klijent
const client = new Spot(
  process.env.BINANCE_API_KEY,
  process.env.BINANCE_API_SECRET
);

console.log("🤖 Stabilni bot (Opcija A) pokrenut...");

// 🟢 Funkcija za kupovinu
async function buy(symbol, amount) {
  try {
    const priceData = await client.tickerPrice(symbol);
    const price = parseFloat(priceData.data.price);
    const qty = (amount / price).toFixed(6);

    await client.newOrder(symbol, "BUY", "MARKET", { quantity: qty });

    console.log(`🟢 BUY ${symbol} @ ${price} qty=${qty}`);
  } catch (err) {
    console.error("❌ BUY error:", err.message);
  }
}

// 🟢 Početna kupovina (BTC + ETH)
async function initialBuy() {
  const capital = Number(process.env.CAPITAL || 100);
  const portion = capital * 0.7; // 70% kapitala

  await buy("BTCUSDC", portion / 2);
  await buy("ETHUSDC", portion / 2);
}

// 🔁 Beskrajna petlja (24/7)
async function loop() {
  try {
    const btc = await client.tickerPrice("BTCUSDC");
    const eth = await client.tickerPrice("ETHUSDC");

    console.log(
      "⏱ BTC:", btc.data.price,
      "| ETH:", eth.data.price
    );

  } catch (e) {
    console.log("⚠️ API greška, bot nastavlja dalje…");
  }

  setTimeout(loop, 5000); // 5 sekundi
}

// ▶️ Start
initialBuy();
loop();
