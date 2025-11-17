import Binance from 'binance-api-node'

const client = Binance({
  apiKey: process.env.BINANCE_KEY,
  apiSecret: process.env.BINANCE_SECRET
})

const PAIRS = ["BTCUSDC", "ETHUSDC", "BNBUSDC"]

// Minimalni iznos za kupovinu po coinu
const MIN_BUY = 30     // 30 USDC minimum
const TAKE_PROFIT = 0.004  // 0.4%
const STOP_LOSS = -0.005   // -0.5%

async function getBalance() {
  const balances = await client.accountInfo()
  const usdc = balances.balances.find(b => b.asset === "USDC")
  return parseFloat(usdc.free)
}

async function getPrice(pair) {
  const ticker = await client.prices({ symbol: pair })
  return parseFloat(ticker[pair])
}

async function getPosition(pair) {
  const trades = await client.myTrades({ symbol: pair })
  if (!trades.length) return null

  const buys = trades.filter(t => t.isBuyer)
  const sells = trades.filter(t => !t.isBuyer)

  const buyAmount = buys.reduce((a, t) => a + parseFloat(t.qty), 0)
  const sellAmount = sells.reduce((a, t) => a + parseFloat(t.qty), 0)

  const netQty = buyAmount - sellAmount

  if (netQty <= 0) return null

  const totalBuyCost = buys.reduce((a, t) => a + parseFloat(t.qty) * parseFloat(t.price), 0)
  const avgPrice = totalBuyCost / buyAmount

  return { qty: netQty, avgPrice }
}

async function analyze(pair) {
  const currentPrice = await getPrice(pair)
  const pos = await getPosition(pair)

  console.log(`Z – Analiza ${pair}: price=${currentPrice} pos=${pos ? pos.qty : 0}`)

  if (!pos) {
    const usdc = await getBalance()
    if (usdc < MIN_BUY) {
      console.log("Z – Premali balans. Čekam...")
      return
    }

    const qty = MIN_BUY / currentPrice

    try {
      await client.order({
        symbol: pair,
        side: "BUY",
        type: "MARKET",
        quantity: qty.toFixed(5)
      })
      console.log(`Z – BUY otvoren za ${pair}: qty=${qty}`)
    } catch (err) {
      console.log("Greška BUY:", err.message)
    }
    return
  }

  const pnl = (currentPrice - pos.avgPrice) / pos.avgPrice

  if (pnl >= TAKE_PROFIT) {
    try {
      await client.order({
        symbol: pair,
        side: "SELL",
        type: "MARKET",
        quantity: pos.qty.toFixed(5)
      })
      console.log(`Z – SELL (TP) za ${pair}: profit ${(pnl * 100).toFixed(2)}%`)
    } catch (err) {
      console.log("Greška SELL:", err.message)
    }
    return
  }

  if (pnl <= STOP_LOSS) {
    try {
      await client.order({
        symbol: pair,
        side: "SELL",
        type: "MARKET",
        quantity: pos.qty.toFixed(5)
      })
      console.log(`Z – SELL (SL) za ${pair}: loss ${(pnl * 100).toFixed(2)}%`)
    } catch (err) {
      console.log("Greška SELL:", err.message)
    }
  }
}

async function loopBot() {
  while (true) {
    for (const pair of PAIRS) {
      await analyze(pair)
      await new Promise(r => setTimeout(r, 4000)) // 4 sek pauze
    }
  }
}

console.log("🔥 Bot startan — koristi cijeli saldo automatski.")
loopBot()
