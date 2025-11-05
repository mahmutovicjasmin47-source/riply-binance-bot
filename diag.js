// diag.js — test API SPOT permissions
import crypto from "crypto";
import fetch from "node-fetch";

const API_KEY = "OVDJE_API_KEY";
const API_SECRET = "OVDJE_SECRET";

const BASE = "https://api.binance.com";

function sign(query) {
  return crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
}

async function main() {
  try {
    const t = await (await fetch(`${BASE}/api/v3/time`)).json();
    console.log("Server time OK:", t);

    const qsAcc = `timestamp=${Date.now()}`;
    const acc = await (await fetch(`${BASE}/api/v3/account?${qsAcc}&signature=${sign(qsAcc)}`, {
      headers: { "X-MBX-APIKEY": API_KEY }
    })).json();
    console.log("ACCOUNT result:", acc);

    const ts = Date.now();
    const params = `symbol=BTCUSDT&side=BUY&type=MARKET&timestamp=${ts}`;
    const sig = sign(params);

    const testOrder = await (await fetch(`${BASE}/api/v3/order/test?${params}&signature=${sig}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": API_KEY }
    })).json();

    console.log("TEST ORDER result:", testOrder);
  } catch (e) {
    console.error("DIAG ERROR:", e);
  }
}

main();
