import { Spot } from '@binance/connector'
import dotenv from 'dotenv'
dotenv.config()

// --- API ---
const apiKey = process.env.API_KEY
const apiSecret = process.env.API_SECRET
const client = new Spot(apiKey, apiSecret)

// --- KONFIG ---
const PAIRS = ["BTCUSDC", "ETHUSDC"]
const CAPITAL_USAGE = 0.70
const DAILY_TARGET = 1.01        // 1% dnevni profit
const TRAILING_DISTANCE = 0.004  // 0.4% trailing
const STOP_LOSS = 0.97           // -3% max gubitak

let positions = {}
let entryPrices = {}
let highestPrice = {}
let targetHitToday = false

// --- GET PRICE ---
async function getPrice(symbol) {
    try {
        const res = await client.tickerPrice(symbol)
        return parseFloat(res.data.price)
    } catch (e) {
        console.log("❌ Price fetch error:", e.message)
        return null
    }
}

// --- GET BALANCE ---
async function getBalance(asset) {
    try {
        const res = await client.account()
        const balance = res.data.balances.find(b => b.asset === asset)
        return parseFloat(balance.free)
    } catch (e) {
        console.log("❌ Balance error:", e.message)
        return 0
    }
}

// --- BUY ---
async function buy(symbol, price) {
    const base = symbol.replace("USDC", "")
    const usdc = await getBalance("USDC")
    const amountUSDC = usdc * CAPITAL_USAGE
    const qty = amountUSDC / price

    try {
        await client.newOrder(symbol, "BUY", "MARKET", { quantity: qty.toFixed(6) })
        console.log(`🟢 BUY ${symbol} @ ${price} qty=${qty}`)
        positions[symbol] = qty
        entryPrices[symbol] = price
        highestPrice[symbol] = price
    } catch (e) {
        console.log("❌ BUY error:", e.response?.data || e.message)
    }
}

// --- SELL ---
async function sell(symbol, price) {
    try {
        const qty = positions[symbol]
        await client.newOrder(symbol, "SELL", "MARKET", { quantity: qty.toFixed(6) })
        console.log(`🔴 SELL ${symbol} @ ${price}`)
        positions[symbol] = 0
        entryPrices[symbol] = null
        highestPrice[symbol] = null
    } catch (e) {
        console.log("❌ SELL error:", e.response?.data || e.message)
    }
}

// --- MAIN LOOP ---
async function loop() {
    for (const symbol of PAIRS) {
        const price = await getPrice(symbol)
        if (!price) continue

        console.log(`⏱ ${symbol}: ${price}`)

        // --- Ako nema pozicije → kupi ---
        if (!positions[symbol] || positions[symbol] === 0) {
            await buy(symbol, price)
            continue
        }

        // --- Trailing ---
        if (price > highestPrice[symbol]) {
            highestPrice[symbol] = price
        }

        const trailExit = highestPrice[symbol] * (1 - TRAILING_DISTANCE)
        const stopLossExit = entryPrices[symbol] * STOP_LOSS

        // --- DAILY TARGET ---
        if (!targetHitToday && price >= entryPrices[symbol] * DAILY_TARGET) {
            console.log("🎯 Daily target hit")
            targetHitToday = true
            await sell(symbol, price)
            continue
        }

        // --- TRAILING EXIT ---
        if (price <= trailExit) {
            console.log("📉 Trailing stop triggered")
            await sell(symbol, price)
            continue
        }

        // --- STOP LOSS ---
        if (price <= stopLossExit) {
            console.log("🛑 STOP LOSS triggered")
            await sell(symbol, price)
            continue
        }
    }
}

console.log("🤖 ULTIMATE BOT (Opcija C) pokrenut...")
setInterval(loop, 6000)
