import 'dotenv/config';
import { Spot } from '@binance/connector';

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;

if (!apiKey || !apiSecret) {
    console.error("❌ API KEY ili SECRET nedostaje!");
    process.exit(1);
}

const client = new Spot(apiKey, apiSecret);

// Glavni bot loop
async function runBot() {
    try {
        console.log("✅ Bot je pokrenut...");

        // Primjer: uzmi cijenu BTC-a
        const price = await client.tickerPrice('BTCUSDT');
        console.log("📈 BTC cijena:", price.data.price);

        // Ovdje idu tvoje future logike (kupovina, prodaja, strategija...)

    } catch (err) {
        console.error("❌ Greška u botu:", err.message);
    }
}

runBot();
