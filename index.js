import Binance from 'binance-api-node';

//////////////////////////////////////////////////////
//               AGRESIVNE POSTAVKE                 //
//////////////////////////////////////////////////////

const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const PAIRS = ["BTCUSDC", "ETHUSDC", "BNBUSDC", "SOLUSDC"];

const SETTINGS = {
  SCAN_INTERVAL: 1200,      // 1.2 sekunde
  AI_THRESHOLD: 0.38,       // spušten prag za ulaz
  MAX_POSITIONS: 6,         // više pozicija odjednom
  INVEST_PER_TRADE: 12,     // 12 USDC po positionu
  TRAILING_TP: 0.23,        // brži take-profit
  CLOSE_PROFIT: 0.32,       // agresivno zatvaranje profita
  COOLDOWN: 1800,           // 1.8 sekundi
  NV_MODE: true,            // No Validation AI mode
  HARD_STOP_LOSS: -0.9      // zaštita kapitala
};

let activePositions = {};

//////////////////////////////////////////////////////
//                  AI SIGNAL                      //
//////////////////////////////////////////////////////

function aiNV() {
  return Math.random(); // NV mode → čisti AI RNG
}

//////////////////////////////////////////////////////
//              BINANCE FUNKCIJE                   //
//////////////////////////////////////////////////////

async function price(symbol) {
  const t = await client.prices({ symbol });
  return parseFloat(t[symbol]);
}

async function buy(symbol) {
  try {
    const p = await price(symbol);
    const qty = SETTINGS.INVEST_PER_TRADE / p;

    const order = await client.order({
      symbol,
      side: "BUY",
      type: "MARKET",
      quantity: qty.toFixed(6)
    });

    activePositions[symbol] = {
      entry: p,
      amount: qty,
      time: Date.now()
    };

    console.log(`🔥 KUPLJENO ${symbol} @ ${p}`);
  } catch (error) {
    console.log("BUY GREŠKA:", error);
  }
}

async function sell(symbol) {
  try {
    const pos = activePositions[symbol];
    if (!pos) return;

    const order = await client.order({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: pos.amount.toFixed(6)
    });

    console.log(`💰 PRODANO ${symbol}`);
    delete activePositions[symbol];

  } catch (error) {
    console.log("SELL GREŠKA:", error);
  }
}

//////////////////////////////////////////////////////
//                GLAVNI SCAN LOOP                 //
//////////////////////////////////////////////////////

async function loop() {
  for (const pair of PAIRS) {
    try {
      const ai = aiNV();
      const p = await price(pair);

      // Ako pozicija postoji → prati je
      if (activePositions[pair]) {
        const pos = activePositions[pair];
        const pnl = ((p - pos.entry) / pos.entry) * 100;

        console.log(`Pozicija ${pair}: PNL=${pnl.toFixed(2)}%`);

        // Hard stop loss zaštita
        if (pnl <= SETTINGS.HARD_STOP_LOSS) {
          console.log("🛑 STOP LOSS — izlaz!");
          await sell(pair);
          continue;
        }

        // Agresivni profit close
        if (pnl >= SETTINGS.CLOSE_PROFIT) {
          await sell(pair);
          continue;
        }

        continue;
      }

      // Ako nema pozicije → može otvoriti
      if (
        ai >= SETTINGS.AI_THRESHOLD &&
        Object.keys(activePositions).length < SETTINGS.MAX_POSITIONS
      ) {
        await buy(pair);
      }

      await new Promise(r => setTimeout(r, SETTINGS.COOLDOWN));

    } catch (err) {
      console.log("SCAN GREŠKA:", err);
    }
  }

  setTimeout(loop, SETTINGS.SCAN_INTERVAL);
}

//////////////////////////////////////////////////////
//                     START                       //
//////////////////////////////////////////////////////

console.log("🚀 AGRESIVNI MULTI-ASSET AI BOT STARTAN");
loop();
