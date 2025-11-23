const Binance = require('binance-api-node').default;

// Binance client (uzima ključeve iz Railway varijabli)
const client = Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET
});

// Trading parovi
const PAIRS = ["BTCUSDC", "ETHUSDC"];

// Live ili test mode
const LIVE = process.env.LIVE_TRADING === "true";

// Amount (možeš mijenjati)
const BUY_AMOUNT = 10; // 10 USDC po kupovini

console.log("🤖 ULTIMATE BOT pokrenut...");
console.log("Live trading:", LIVE);
console.log("Parovi:", PAIRS.join(", "));
console.log("----------------------------------------");

async function tradeLoop() {
    try {
        for (const symbol of PAIRS) {
            const price = await client.prices({ symbol });
            const current = parseFloat(price[symbol]);

            console.log(`⏱️ ${symbol}: ${current}`);

            if (!LIVE) {
                console.log(`🟡 TEST MODE BUY ${symbol}`);
                continue;
            }

            // LIVE BUY
            try {
                const order = await client.order({
                    symbol,
                    side: 'BUY',
                    type: 'MARKET',
                    quoteOrderQty: BUY_AMOUNT.toString()
                });

                console.log(`🟢 BUY EXECUTED ${symbol}`, order);
            } catch (err) {
                console.log(`❌ BUY ERROR ${symbol}:`, err.body || err.message);
            }
        }
    } catch (e) {
        console.log("❌ General error:", e);
    }
}

// Loop svakih 30 sekundi
setInterval(tradeLoop, 30000);

tradeLoop();
