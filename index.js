// ===== elementi =====
const connTxt      = document.getElementById('connTxt');
const connDot      = document.getElementById('connDot');
const pairSel      = document.getElementById('pairSel');
const voiceToggle  = document.getElementById('voiceToggle');
const reconnectBtn = document.getElementById('reconnectBtn');
const signalTxt    = document.getElementById('signalTxt');
const filterTxt    = document.getElementById('filterTxt');
const priceEl      = document.getElementById('priceEl');
const modeBtns     = document.querySelectorAll('.mode-btn') || [];

// ===== stanje / parametri =====
let ws            = null;
let wsPair        = "btcusdc";
let currentSymbol = "BTCUSDC";
let voiceOn       = false;

// ==== STANDARDNI (stari / mirniji) mod za BNBUSDC & ETHUSDC ====
function setSignal(txt){
  signalTxt.textContent = txt;
  signalTxt.classList.remove('buy','sell');

  if(txt === "Kupi")  signalTxt.classList.add('buy');
  if(txt === "Prodaj")signalTxt.classList.add('sell');

  if(txt === "Kupi" || txt === "Prodaj"){
    if(navigator.vibrate) navigator.vibrate(50);
    if(voiceOn && 'speechSynthesis' in window){
      const u = new SpeechSynthesisUtterance(txt);
      u.lang  = "bs-BA";
      u.rate  = 1.05;
      u.pitch = 1;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    }
  }
}

// jednostavan demo za BNB/ETH – manje agresivan, više “random”
async function loadAndRunStandard(symbol){
  filterTxt.textContent = `Standardni mod za ${symbol}`;
  await new Promise(r => setTimeout(r, 400));

  const r = Math.random();
  if(r < 0.10){
    setSignal("Kupi");
  }else if(r > 0.90){
    setSignal("Prodaj");
  }else{
    signalTxt.textContent = "Čekaj";
    signalTxt.classList.remove('buy','sell');
  }
}

// ==== AGRESIVNI, PAMETNI BTCUSDC BOT ====

// parametri agresivnog bota
const aggressiveSymbol = "BTCUSDC";
let aggressivePriceHistory = [];
let aggressiveLastSignalTime = 0;
const aggressiveCooldownMs = 20000; // min 20s između dva signala

const aggressiveCfg = {
  volMin:       0.0008,  // 0.08%
  volMax:       0.0080,  // 0.80%
  slopeFastBuy: 0.0010,  // +0.10% u ~10s
  slopeFastSell:-0.0010, // -0.10% u ~10s
  slopeSlowBuy: 0.0005,  // +0.05% u ~30s
  slopeSlowSell:-0.0005  // -0.05% u ~30s
};

function aggressiveUpdateDecision(){
  const now = Date.now();
  const recent = aggressivePriceHistory.filter(p => now - p.t <= 60000);
  if(recent.length < 8) return;

  const last = recent[recent.length - 1].p;

  const recent10 = recent.filter(p => now - p.t <= 10000);
  const recent30 = recent.filter(p => now - p.t <= 30000);

  if(recent10.length < 3 || recent30.length < 5) return;

  const first10 = recent10[0].p;
  const first30 = recent30[0].p;

  const ret10 = (last - first10) / first10;
  const ret30 = (last - first30) / first30;

  let hi = recent30[0].p;
  let lo = recent30[0].p;
  for(const x of recent30){
    if(x.p > hi) hi = x.p;
    if(x.p < lo) lo = x.p;
  }
  const vol = (hi - lo) / last;

  filterTxt.textContent =
    `BTCUSDC AGG | Vol ${(vol*100).toFixed(2)}% | Δ10s ${(ret10*100).toFixed(2)}% | Δ30s ${(ret30*100).toFixed(2)}%`;

  if(vol < aggressiveCfg.volMin || vol > aggressiveCfg.volMax){
    // previše mrtvo ili previše divlje – ne radi
    return;
  }

  if(now - aggressiveLastSignalTime < aggressiveCooldownMs){
    return;
  }

  const strongUp =
    ret10 >= aggressiveCfg.slopeFastBuy &&
    ret30 >= aggressiveCfg.slopeSlowBuy;

  const strongDown =
    ret10 <= aggressiveCfg.slopeFastSell &&
    ret30 <= aggressiveCfg.slopeSlowSell;

  if(strongUp && !strongDown){
    setSignal("Kupi");
    aggressiveLastSignalTime = now;
  }else if(strongDown && !strongUp){
    setSignal("Prodaj");
    aggressiveLastSignalTime = now;
  }else{
    if(signalTxt.textContent !== "Kupi" && signalTxt.textContent !== "Prodaj"){
      signalTxt.textContent = "Čekaj";
      signalTxt.classList.remove('buy','sell');
    }
  }
}

// ===== WebSocket live cijena =====
async function connectWs(symbol){
  try{ if(ws) ws.close(); }catch(e){}

  currentSymbol = symbol.toUpperCase();
  wsPair = currentSymbol.toLowerCase();

  const url = `wss://stream.binance.com:9443/ws/${wsPair}@trade`;
  ws = new WebSocket(url);

  connTxt.textContent = "povezivanje…";
  connDot.classList.remove('ok');
  connDot.classList.add('err');

  // reset agresivne historije kad mijenjaš par
  aggressivePriceHistory = [];
  aggressiveLastSignalTime = 0;

  ws.onopen = () => {
    connTxt.textContent = "povezano";
    connDot.classList.remove('err');
    connDot.classList.add('ok');

    // na otvaranju: ako je BTCUSDC -> agresivni mod,
    // inače standardni mod kao i prije
    if(currentSymbol === aggressiveSymbol){
      filterTxt.textContent = "BTCUSDC AGGRESIVE bot aktivan";
      signalTxt.textContent = "Čekaj";
      signalTxt.classList.remove('buy','sell');
    }else{
      loadAndRunStandard(currentSymbol);
    }
  };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if(m.p){
      const price = +m.p;
      priceEl.textContent = price.toFixed(2);

      if(currentSymbol === aggressiveSymbol){
        const now = Date.now();
        aggressivePriceHistory.push({ t: now, p: price });
        const cutoff = now - 90000;
        aggressivePriceHistory = aggressivePriceHistory.filter(p => p.t >= cutoff);

        aggressiveUpdateDecision();
      }
    }
  };

  ws.onclose = () => {
    connTxt.textContent = "zatvoreno";
    connDot.classList.remove('ok');
    connDot.classList.add('err');
  };
}

// ===== event listeneri =====
voiceToggle.addEventListener('click', ()=>{
  voiceOn = !voiceOn;
  voiceToggle.classList.toggle('on', voiceOn);
});

reconnectBtn.addEventListener('click', ()=>{
  const symbol = pairSel.value || "BTCUSDC";
  connectWs(symbol);
});

pairSel.addEventListener('change', ()=>{
  const symbol = pairSel.value;
  connectWs(symbol);
});

// ako imaš mode dugmad, neka samo mijenjaju izgled (logiku sad ne diramo)
modeBtns.forEach(btn=>{
  btn.addEventListener('click', ()=>{
    modeBtns.forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ===== start =====
connectWs("BTCUSDC");
