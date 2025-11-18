import Binance from "binance-api-node/dist/index.js"

const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET
})

// ================== KONFIG ==================
const PAIR = process.env.SYMBOL || "BTCUSDC"

// Kapital
const CAPITAL_PERCENT = 0.60        // 60% balansa po ulazu
const AUTO_INCREASE = 0.10          // +10% nakon profita
const MAX_MULTIPLIER = 3            // sigurnosni max 3x

// Trailing logika
const TRAIL_START = 0.003           // 0.3% profit -> uključi trailing
const TRAIL_DISTANCE = 0.0025       // 0.25% ispod high-a

// Rizik
const STOP_LOSS = -0.01             // -1% hard SL

// Anti-crash
const CRASH_DROP = -0.02            // -2% u minuti
const CRASH_WINDOW_MS = 60000       // 1 minut
const CRASH_PAUSE_MIN = 5           // pauza 5 min

// Ostalo
const INTERVAL_MS = 1000            // 1 sekunda
const MIN_POSITION_USDC = 25        // minimalni ulaz

// ================== STATE ==================
let stakeMultiplier = 1
let trailingHigh = null
let pauseUntil = 0
let priceHistory = []

// ================== UTILS ==================

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getBalanceUSDC() {
  const acc = await client.accountInfo()
  const usdc = acc.balances.find(b => b.asset === "USDC")
  return usdc ? parseFloat(usdc.free) : 0
}

async function getPrice() {
  const t = await client.prices({ symbol: PAIR })
  return parseFloat(t[PAIR])
}

async function getPosition() {
  const trades = await client.myTrades({ symbol: PAIR })

  if (!trades.length) return null

  const buys = trades.filter(t => t.isBuyer)
  const sells = trades.filter(t => !t.isBuyer)

  const buyAmount = buys.reduce((a, t) => a + parseFloat(t.qty), 0)
  const sellAmount = sells.reduce((a, t) => a + parseFloat(t.qty), 0)

  const qty = buyAmount - sellAmount
  if (qty <= 0) return null

  const totalBuyCost = buys.reduce(
    (a, t) => a + parseFloat(t.qty) * parseFloat(t.price),
    0
  )
  const avg = totalBuyCost / buyAmount

  return { qty, avgPrice: avg }
}

function updateCrashGuard(price) {
  const now = Date.now()
  priceHistory.push({ time: now, price })

  priceHistory = priceHistory.filter(p => now - p.time <= CRASH_WINDOW_MS)

  if (priceHistory.length < 2) return

  const first = priceHistory[0]
  const change = (price - first.price) / first.price

  if (change <= CRASH_DROP) {
    pauseUntil = now + CRASH_PAUSE_MIN * 60 * 1000
    console.log(
      `⚠️ CRASH DETECTED: pad ${(change*100).toFixed(2)}%, pauza ${CRASH_PAUSE_MIN} min`
    )
  }
}

// ================== BEZ POZICIJE ==================

async function handleNoPosition(price) {
  const now = Date.now()
  if (now < pauseUntil) {
    const left = ((pauseUntil - now) / 60000).toFixed(1)
    console.log(`⏸ Pauza zbog anti-crash zaštite: još ~${left} min`)
    return
  }

  const bal = await getBalanceUSDC()
  const stake = bal * CAPITAL_PERCENT * stakeMultiplier

  if (stake < MIN_POSITION_USDC) {
    console.log(`Premalo za ulaz, balans=${bal.toFixed(2)} USDC`)
    return
  }

  if (bal < stake) {
    console.log(`Nema dovoljno balansa (${bal.toFixed(2)} < stake ${stake.toFixed(2)})`)
    return
  }

  const qty = stake / price

  try {
    await client.order({
      symbol: PAIR,
      side: "BUY",
      type: "MARKET",
      quantity: qty.toFixed(5)
    })

    trailingHigh = null

    console.log(
      `✅ BUY ${PAIR}: qty=${qty.toFixed(5)}, stake=${stake.toFixed(2)}, mult=${stakeMultiplier.toFixed(2)}`
    )
  } catch (err) {
    console.log("❌ BUY ERROR:", err.message)
  }
}

// ================== SA POZICIJOM ==================

async function handleOpenPosition(pos, price) {
  const pnl = (price - pos.avgPrice) / pos.avgPrice

  // STOP LOSS
  if (pnl <= STOP_LOSS) {
    try {
      await client.order({
        symbol: PAIR,
        side: "SELL",
        type: "MARKET",
        quantity: pos.qty.toFixed(5)
      })
      console.log(`🛑 SL SELL: gubitak ${(pnl*100).toFixed(2)}%`)
      stakeMultiplier = 1
      trailingHigh = null
    } catch (e) {
      console.log("❌ SL SELL ERROR:", e.message)
    }
    return
  }

  // TRAILING
  if (pnl >= TRAIL_START) {
    if (!trailingHigh || price > trailingHigh) trailingHigh = price

    const trailStop = trailingHigh * (1 - TRAIL_DISTANCE)

    if (price <= trailStop) {
      try {
        await client.order({
          symbol: PAIR,
          side: "SELL",
          type: "MARKET",
          quantity: pos.qty.toFixed(5)
        })

        console.log(`💰 PROFIT SELL: ${(pnl*100).toFixed(2)}%`)

        stakeMultiplier = Math.min(
          stakeMultiplier * (1 + AUTO_INCREASE),
          MAX_MULTIPLIER
        )

        console.log(`📈 Multiplier -> ${stakeMultiplier.toFixed(2)}x`)
        trailingHigh = null
      } catch (e) {
        console.log("❌ TP SELL ERROR:", e.message)
      }

      return
    }

    console.log(
      `… Trailing: high=${trailingHigh.toFixed(2)}, trailStop=${trailStop.toFixed(2)}, pnl=${(pnl*100).toFixed(2)}%`
    )
  } else {
    console.log(
      `Pozicija otvorena: avg=${pos.avgPrice.toFixed(2)}, price=${price.toFixed(2)}, pnl=${(pnl*100).toFixed(2)}%`
    )
  }
}

// ================== MAIN LOOP ==================

async function loop() {
  console.log("🚀 START: BTCUSDC AGGRESSIVE SAFE v3")

  while (true) {
    try {
      const price = await getPrice()
      updateCrashGuard(price)

      const pos = await getPosition()

      if (!pos) {
        await handleNoPosition(price)
      } else {
        await handleOpenPosition(pos, price)
      }
    } catch (e) {
      console.log("❌ CYCLE ERROR:", e.message)
    }

    await sleep(INTERVAL_MS)
  }
}

loop()
