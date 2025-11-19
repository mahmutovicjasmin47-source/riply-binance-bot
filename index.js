import axios from "axios";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

// --- SETTINGS ---
const SYMBOL = "BTCUSDT";
const INTERVAL = "1m";
const AI_THRESHOLD_BUY = 20;
const AI_THRESHOLD_SELL = -20;

// --- PRICE FETCH FUNCTION ---
async function getPrice() {
  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`
    );
    return parseFloat(res.data.price);
  } catch (err) {
    console.log("PRICE ERROR:", err.message);
    return null;
  }
}

// --- SIMPLE AI SCORE ---
function aiScore(prices) {
  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2];
  return (last - prev) * 10;
}

// --- MAIN LOOP ---
let prices = [];

async function loop() {
  const price = await getPrice();
  if (!price) return;

  prices.push(price);
  if (prices.length > 20) prices.shift();

  if (prices.length > 2) {
    const score = aiScore(prices);

    let state = "FLAT";
    if (score > AI_THRESHOLD_BUY) state = "BUY";
    if (score < AI_THRESHOLD_SELL) state = "SELL";

    console.log(
      `Price=${price} | AI SCORE=${score} | STATE=${state}`
    );
  }

  setTimeout(loop, 1000);
}

loop();

// --- EXPRESS SERVER (REQUIRED FOR RAILWAY) ---
const app = express();
app.get("/", (req, res) => {
  res.send("AI Scalper V10 running...");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server Active on PORT:", PORT);
});
