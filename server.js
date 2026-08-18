const express=require('express');
const app=express();
app.use(express.json());

const PORT=process.env.PORT||10000;
const BASE='https://api.bitget.com';
const PRODUCT='usdt-futures';

const CFG={
  REFRESH_MS:60000,
  MIN_VOLUME_USDT:3000000,
  MARKET_LIMIT:100,
  ANALYZE_LIMIT:70,
  BATCH_SIZE:8,
  BATCH_DELAY_MS:100,
  FOUR_HOUR_LIMIT:100,
  TWO_HOUR_LIMIT:100,
  FIFTEEN_MIN_LIMIT:150,
  LEVEL_LOOKBACK_4H:30,
  LEVEL_LOOKBACK_2H:30,
  RETEST_DISTANCE_PERCENT:.8,
  MAX_ENTRY_DISTANCE_PERCENT:.9,
  RSI_PERIOD:14,
  RSI_LONG_MIN:48,
  RSI_LONG_MAX:68,
  RSI_SHORT_MIN:32,
  RSI_SHORT_MAX:52,
  MIN_SIGNAL_SCORE:75,
  MAX_SIGNALS:8,
  MAX_PREPARING:8
};

let marketCache=[];
let lastScan=null;
let scanRunning=false;
let cachedResult=null;
let lastError=null;
let discoveryTime=null;

const log=x=>console.log(`[${new Date().toISOString()}] ${x}`);

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const round=(v,d=6)=>
  Number.isFinite(v)
    ? Number(v.toFixed(d))
    : 0;

const pct=(v,b)=>
  Number.isFinite(v)&&
  Number.isFinite(b)&&
  b!==0
    ? v/b*100
    : 0;


/*
=========================================================
BITGET
=========================================================
*/

async function bitget(path,params={}){

  const u=new URL(BASE+path);

  Object.entries(params).forEach(([k,v])=>{
    if(
      v!==undefined &&
      v!==null &&
      v!==''
    ){
      u.searchParams.set(k,String(v));
    }
  });

  const r=await fetch(u);

  const t=await r.text();

  if(!r.ok){
    throw new Error(
      `Bitget HTTP ${r.status} - ${t.slice(0,200)}`
    );
  }

  let j;

  try{
    j=JSON.parse(t);
  }catch{
    throw new Error('Bitget JSON parse error');
  }

  if(j.code!=='00000'){
    throw new Error(
      `Bitget ${j.code} - ${j.msg||'Unknown error'}`
    );
  }

  return j.data;
}


/*
=========================================================
CANDLE PARSER
=========================================================
*/

function parseCandles(data){

  if(!Array.isArray(data)){
    return [];
  }

  return data
    .map(r=>({
      time:+r[0],
      open:+r[1],
      high:+r[2],
      low:+r[3],
      close:+r[4],
      volume:+r[5],
      quoteVolume:+(r[6]||0)
    }))
    .filter(x=>Number.isFinite(x.close))
    .sort((a,b)=>a.time-b.time);
}


/*
=========================================================
RSI
=========================================================
*/

function rsi(v,p=14){

  if(!v||v.length<=p){
    return null;
  }

  let g=0;
  let l=0;

  for(let i=1;i<=p;i++){

    const c=v[i]-v[i-1];

    if(c>=0){
      g+=c;
    }else{
      l-=c;
    }
  }

  let ag=g/p;
  let al=l/p;

  for(let i=p+1;i<v.length;i++){

    const c=v[i]-v[i-1];

    const gg=c>0?c:0;
    const ll=c<0?-c:0;

    ag=(ag*(p-1)+gg)/p;
    al=(al*(p-1)+ll)/p;
  }

  if(al===0){
    return 100;
  }

  return 100-100/(1+ag/al);
}


/*
=========================================================
MARKET DISCOVERY
=========================================================
*/

async function discoverMarket(){

  log('Bitget piyasası yeniden taranıyor...');

  const [
    contracts,
    tickers
  ]=await Promise.all([

    bitget(
      '/api/v2/mix/market/contracts',
      {
        productType:PRODUCT
      }
    ),

    bitget(
      '/api/v2/mix/market/tickers',
      {
        productType:PRODUCT
      }
    )

  ]);

  const valid=new Set(

    contracts
      .filter(c=>
        c.symbolType==='perpetual' &&
        c.symbolStatus==='normal' &&
        c.quoteCoin==='USDT'
      )
      .map(c=>c.symbol)

  );

  marketCache=

    tickers
      .filter(t=>valid.has(t.symbol))
      .map(t=>{

        const ch=+t.change24h||0;

        return{
          symbol:t.symbol,
          price:+t.lastPr,
          volume24h:+t.quoteVolume||0,

          change24h:
            Math.abs(ch)<=1
              ?ch*100
              :ch,

          high24h:+t.high24h,
          low24h:+t.low24h
        };

      })
      .filter(
        x=>x.volume24h>=CFG.MIN_VOLUME_USDT
      )
      .sort(
        (a,b)=>b.volume24h-a.volume24h
      )
      .slice(
        0,
        CFG.MARKET_LIMIT
      );

  discoveryTime=
    new Date().toISOString();

  log(
    `Discovery tamamlandı. ${marketCache.length} uygun coin bulundu.`
  );

  return marketCache;
}


/*
=========================================================
CANDLES
=========================================================
*/

async function getCandles(
  symbol,
  tf,
  limit
){

  return parseCandles(

    await bitget(
      '/api/v2/mix/market/candles',
      {
        symbol,
        productType:PRODUCT,
        granularity:tf,
        limit
      }
    )

  );
}


/*
=========================================================
LEVELS
=========================================================
*/

function getLevels(c,look){

  if(c.length<look+5){
    return null;
  }

  const closed=c.slice(0,-1);

  const history=
    closed.slice(
      -look-1,
      -1
    );

  if(history.length<look){
    return null;
  }

  return{

    current:closed.at(-1),

    resistance:
      Math.max(
        ...history.map(x=>x.high)
      ),

    support:
      Math.min(
        ...history.map(x=>x.low)
      ),

    previousClose:
      history.at(-1).close
  };
}


/*
=========================================================
BREAKOUT
=========================================================
*/

/*
ÖNEMLİ:

Eski sistem sadece son kapanan mumda
kırılım arıyordu.

Bu sürüm son 6 kapanmış mum içinde
kırılım olmuşsa yakalar.
*/

function detectBreakout(
  c,
  look,
  recentBars=6
){

  const lv=getLevels(c,look);

  if(!lv){
    return null;
  }

  const closed=c.slice(0,-1);

  let L=false;
  let S=false;

  let bi=-1;
  let bd=null;

  const start=Math.max(
    1,
    closed.length-recentBars
  );

  for(
    let i=start;
    i<closed.length;
    i++
  ){

    const cur=closed[i];
    const prev=closed[i-1];

    if(
      cur.close>lv.resistance &&
      prev.close<=lv.resistance
    ){

      L=true;
      bi=i;
      bd='LONG';
    }

    if(
      cur.close<lv.support &&
      prev.close>=lv.support
    ){

      S=true;
      bi=i;
      bd='SHORT';
    }
  }

  return{

    ...lv,

    current:
      closed.at(-1),

    previous:
      closed.at(-2),

    longBreakout:L,
    shortBreakout:S,

    breakoutIndex:bi,
    breakoutDirection:bd
  };
}


/*
=========================================================
SCORE
=========================================================
*/

function calculateScore({
  breakout4H,
  breakout2H,
  retest,
  rsiOK,
  rsi,
  direction
}){

  let s=0;

  if(breakout4H){
    s+=35;
  }

  if(breakout2H){
    s+=30;
  }

  if(retest){
    s+=20;
  }

  if(rsiOK){
    s+=10;
  }

  if(
    direction==='LONG' &&
    rsi>=52 &&
    rsi<=63
  ){
    s+=5;
  }

  if(
    direction==='SHORT' &&
    rsi>=37 &&
    rsi<=48
  ){
    s+=5;
  }

  return Math.min(
    100,
    s
  );
}


/*
=========================================================
TRADE PLAN
=========================================================
*/

function createTradePlan({
  market,
  direction,
  level,
  rsi,
  score,
  reason
}){

  const price=market.price;

  const entryLow=
    direction==='LONG'
      ?level*.998
      :level*1.002;

  const entryHigh=
    direction==='LONG'
      ?level*1.004
      :level*.996;

  const stop=
    direction==='LONG'
      ?level*.982
      :level*1.018;

  const risk=
    Math.abs(
      price-stop
    );

  let tp1;
  let tp2;
  let tp3;

  if(direction==='LONG'){

    tp1=level+risk*1.5;
    tp2=level+risk*2;
    tp3=level+risk*3;

  }else{

    tp1=level-risk*1.5;
    tp2=level-risk*2;
    tp3=level-risk*3;

  }

  return{

    symbol:market.symbol,

    direction,

    strategy:
      '4H / 2H BREAKOUT + RETEST + RSI',

    score,

    price:
      round(price,8),

    entryLow:
      round(entryLow,8),

    entryHigh:
      round(entryHigh,8),

    stop:
      round(stop,8),

    tp1:
      round(tp1,8),

    tp2:
      round(tp2,8),

    tp3:
      round(tp3,8),

    rsi:
      round(rsi,1),

    change24h:
      round(market.change24h,2),

    volume24h:
      round(
        market.volume24h/1e6,
        2
      ),

    level:
      round(level,8),

    reason,

    tradingView:
      `https://www.tradingview.com/chart/?symbol=BITGET:${market.symbol}`
  };
}


/*
=========================================================
SIGNAL ENGINE
=========================================================
*/

function buildSignal({
  market,
  fourHour,
  twoHour,
  fifteen
}){

  if(
    !fourHour||
    !twoHour||
    !fifteen
  ){
    return null;
  }

  const price=
    market.price;

  const closes=
    fifteen
      .slice(0,-1)
      .map(x=>x.close);

  const rv=
    rsi(
      closes,
      CFG.RSI_PERIOD
    );

  if(rv===null){
    return null;
  }


  /*
  ========================================================
  LONG
  ========================================================
  */

  if(
    fourHour.longBreakout &&
    twoHour.longBreakout
  ){

    const level=
      fourHour.resistance;

    const retest=

      price>=
        level*
        (
          1-
          CFG.RETEST_DISTANCE_PERCENT/100
        )

      &&

      price<=
        level*
        (
          1+
          CFG.MAX_ENTRY_DISTANCE_PERCENT/100
        );

    const ok=
      rv>=CFG.RSI_LONG_MIN &&
      rv<=CFG.RSI_LONG_MAX;

    if(
      retest&&
      ok
    ){

      const score=
        calculateScore({

          breakout4H:true,
          breakout2H:true,
          retest:true,
          rsiOK:true,
          rsi:rv,
          direction:'LONG'

        });

      if(
        score>=CFG.MIN_SIGNAL_SCORE
      ){

        return createTradePlan({

          market,

          direction:'LONG',

          level,

          rsi:rv,

          score,

          reason:
            '4H direnç kırılımı + 2H onayı + fiyat kırılan seviyeye yakın + 15M RSI LONG giriş bölgesinde.'

        });
      }
    }
  }


  /*
  ========================================================
  SHORT
  ========================================================
  */

  if(
    fourHour.shortBreakout &&
    twoHour.shortBreakout
  ){

    const level=
      fourHour.support;

    const retest=

      price<=
        level*
        (
          1+
          CFG.RETEST_DISTANCE_PERCENT/100
        )

      &&

      price>=
        level*
        (
          1-
          CFG.MAX_ENTRY_DISTANCE_PERCENT/100
        );

    const ok=
      rv>=CFG.RSI_SHORT_MIN &&
      rv<=CFG.RSI_SHORT_MAX;

    if(
      retest&&
      ok
    ){

      const score=
        calculateScore({

          breakout4H:true,
          breakout2H:true,
          retest:true,
          rsiOK:true,
          rsi:rv,
          direction:'SHORT'

        });

      if(
        score>=CFG.MIN_SIGNAL_SCORE
      ){

        return createTradePlan({

          market,

          direction:'SHORT',

          level,

          rsi:rv,

          score,

          reason:
            '4H destek kırılımı + 2H onayı + fiyat kırılan seviyeye yakın + 15M RSI SHORT giriş bölgesinde.'

        });
      }
    }
  }

  return null;
}


/*
=========================================================
PREPARING
=========================================================
*/

function buildPreparing({
  market,
  fourHour,
  twoHour,
  fifteen
}){

  if(
    !fourHour||
    !twoHour||
    !fifteen
  ){
    return null;
  }

  const price=
    market.price;

  const rv=
    rsi(
      fifteen
        .slice(0,-1)
        .map(x=>x.close),
      CFG.RSI_PERIOD
    );

  if(rv===null){
    return null;
  }

  const ld=
    pct(
      fourHour.resistance-price,
      price
    );

  const sd=
    pct(
      price-fourHour.support,
      price
    );

  const l2=
    pct(
      twoHour.resistance-price,
      price
    );

  const s2=
    pct(
      price-twoHour.support,
      price
    );


  /*
  LONG HAZIRLANIYOR
  */

  if(
    ld>=0 &&
    ld<=1 &&
    l2<=1.5 &&
    rv>=45 &&
    rv<=70
  ){

    return{

      symbol:market.symbol,

      direction:'LONG',

      price:
        round(price,8),

      trigger:
        round(
          fourHour.resistance,
          8
        ),

      distance:
        round(ld,3),

      rsi:
        round(rv,1),

      message:
        `Fiyat ${round(ld,3)}% uzakta. 4H direncin kırılması bekleniyor.`,

      tradingView:
        `https://www.tradingview.com/chart/?symbol=BITGET:${market.symbol}`
    };
  }


  /*
  SHORT HAZIRLANIYOR
  */

  if(
    sd>=0 &&
    sd<=1 &&
    s2<=1.5 &&
    rv>=30 &&
    rv<=55
  ){

    return{

      symbol:market.symbol,

      direction:'SHORT',

      price:
        round(price,8),

      trigger:
        round(
          fourHour.support,
          8
        ),

      distance:
        round(sd,3),

      rsi:
        round(rv,1),

      message:
        `Fiyat ${round(sd,3)}% uzakta. 4H desteğin kırılması bekleniyor.`,

      tradingView:
        `https://www.tradingview.com/chart/?symbol=BITGET:${market.symbol}`
    };
  }

  return null;
}


/*
=========================================================
COIN ANALYSIS
=========================================================
*/

async function analyzeCoin(market){

  try{

    const[
      f4,
      h2,
      m15
    ]=await Promise.all([

      getCandles(
        market.symbol,
        '4H',
        CFG.FOUR_HOUR_LIMIT
      ),

      getCandles(
        market.symbol,
        '2H',
        CFG.TWO_HOUR_LIMIT
      ),

      getCandles(
        market.symbol,
        '15m',
        CFG.FIFTEEN_MIN_LIMIT
      )

    ]);

    if(
      f4.length<40||
      h2.length<40||
      m15.length<50
    ){
      return null;
    }

    const four=
      detectBreakout(
        f4,
        CFG.LEVEL_LOOKBACK_4H
      );

    const two=
      detectBreakout(
        h2,
        CFG.LEVEL_LOOKBACK_2H
      );

    const signal=
      buildSignal({

        market,

        fourHour:four,

        twoHour:two,

        fifteen:m15
      });

    if(signal){

      return{

        type:'SIGNAL',

        signal
      };
    }

    const preparing=
      buildPreparing({

        market,

        fourHour:
          getLevels(
            f4,
            CFG.LEVEL_LOOKBACK_4H
          ),

        twoHour:
          getLevels(
            h2,
            CFG.LEVEL_LOOKBACK_2H
          ),

        fifteen:m15
      });

    if(preparing){

      return{

        type:'PREPARING',

        preparing
      };
    }

    return null;

  }catch(e){

    log(
      `Analiz hatası ${market.symbol}: ${e.message}`
    );

    return null;
  }
}


/*
=========================================================
MARKET DIRECTION
=========================================================
*/

async function calculateMarketDirection(){

  const t=
    marketCache.filter(
      x=>
        x.symbol==='BTCUSDT'||
        x.symbol==='ETHUSDT'
    );

  if(!t.length){

    return{

      direction:'YATAY',

      label:'VERİ BEKLENİYOR',

      reason:
        'BTC / ETH verisi bekleniyor.'
    };
  }

  let b=0;
  let s=0;

  t.forEach(x=>{

    if(x.change24h>1){
      b++;
    }

    if(x.change24h<-1){
      s++;
    }

  });

  if(b>s){

    return{

      direction:'LONG',

      label:'PİYASA YUKARI',

      reason:
        'Ana piyasa göstergeleri yükseliş ağırlıklı.'
    };
  }

  if(s>b){

    return{

      direction:'SHORT',

      label:'PİYASA AŞAĞI',

      reason:
        'Ana piyasa göstergeleri düşüş ağırlıklı.'
    };
  }

  return{

    direction:'YATAY',

    label:'PİYASA YATAY',

    reason:
      'Piyasa yönü net değil.'
  };
}


/*
=========================================================
RADAR
=========================================================
*/

async function runRadar(){

  if(scanRunning){

    return cachedResult||
      {
        success:false,
        error:'Tarama zaten çalışıyor.'
      };
  }

  scanRunning=true;
  lastError=null;

  const started=Date.now();

  try{

    await discoverMarket();

    const candidates=
      marketCache.slice(
        0,
        CFG.ANALYZE_LIMIT
      );

    const signals=[];
    const preparing=[];

    log(
      `Radar başladı. ${candidates.length} coin analiz edilecek.`
    );


    for(
      let i=0;
      i<candidates.length;
      i+=CFG.BATCH_SIZE
    ){

      const results=
        await Promise.all(

          candidates
            .slice(
              i,
              i+CFG.BATCH_SIZE
            )
            .map(analyzeCoin)

        );

      results.forEach(r=>{

        if(
          r?.type==='SIGNAL'
        ){
          signals.push(
            r.signal
          );
        }

        if(
          r?.type==='PREPARING'
        ){
          preparing.push(
            r.preparing
          );
        }

      });

      await sleep(
        CFG.BATCH_DELAY_MS
      );
    }


    signals.sort(
      (a,b)=>b.score-a.score
    );

    preparing.sort(
      (a,b)=>a.distance-b.distance
    );


    const md=
      await calculateMarketDirection();


    cachedResult={

      success:true,

      system:
        'Sonny AI Signal Scanner V5',

      timestamp:
        new Date().toISOString(),

      refresh:
        'EVERY 60 SECONDS',

      strategy:
        '4H / 2H BREAKOUT + RETEST + RSI',

      market:md,

      stats:{

        market:
          marketCache.length,

        analyzed:
          candidates.length,

        signals:
          Math.min(
            signals.length,
            CFG.MAX_SIGNALS
          ),

        preparing:
          Math.min(
            preparing.length,
            CFG.MAX_PREPARING
          ),

        duration:
          round(
            (Date.now()-started)/1000,
            1
          )
      },

      signals:
        signals.slice(
          0,
          CFG.MAX_SIGNALS
        ),

      preparing:
        preparing.slice(
          0,
          CFG.MAX_PREPARING
        ),

      mode:
        'MANUAL SIGNAL ONLY'
    };


    lastScan=
      new Date().toISOString();


    log(
      `RADAR tamamlandı | Market: ${marketCache.length} | Analiz: ${candidates.length} | SIGNAL: ${cachedResult.stats.signals} | PREPARING: ${cachedResult.stats.preparing}`
    );

    return cachedResult;

  }catch(e){

    lastError=e.message;

    log(
      `RADAR ERROR: ${e.message}`
    );

    return{

      success:false,

      error:e.message,

      system:
        'Sonny AI Signal Scanner V5'
    };

  }finally{

    scanRunning=false;
  }
}


/*
=========================================================
WEB UI
=========================================================
*/

const HTML=`

<!doctype html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
Sonny AI Signal Scanner V5
</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:#080b12;
  color:#f5f7fb;
  font-family:Arial,sans-serif;
}

.container{
  width:min(1250px,94%);
  margin:25px auto 50px;
}

.header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:18px;
}

.title{
  font-size:28px;
  font-weight:900;
}

.subtitle{
  color:#8d98aa;
}

.online{
  padding:9px 14px;
  border-radius:20px;
  background:#0d2118;
  color:#43e58b;
  border:1px solid #174d31;
  font-weight:800;
}

.market-box,
.stat,
.panel{
  background:#111722;
  border:1px solid #202b3b;
  border-radius:15px;
  padding:20px;
  margin-bottom:18px;
}

.market-title,
.stat-label{
  color:#7d8799;
  font-size:11px;
  font-weight:800;
}

.market-direction{
  font-size:28px;
  font-weight:900;
}

.stats{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;
}

.stat{
  margin:0;
}

.stat-value{
  font-size:21px;
  font-weight:900;
  margin-top:7px;
}

.panel h2{
  margin:0 0 5px;
}

.panel-description{
  color:#8d98aa;
}

.signal-card{
  background:#0c121d;
  border:1px solid #26354a;
  border-radius:14px;
  padding:18px;
  margin-bottom:12px;
}

.signal-top{
  display:flex;
  justify-content:space-between;
}

.coin{
  font-size:20px;
  font-weight:900;
}

.long{
  color:#45e58d;
}

.short{
  color:#ff647a;
}

.score{
  background:#1c2635;
  padding:6px 9px;
  border-radius:7px;
  font-weight:900;
}

.strategy{
  margin-top:8px;
  color:#9ba7ba;
  font-size:12px;
}

.price-line{
  margin-top:15px;
}

.price{
  font-size:20px;
  font-weight:900;
}

.grid-plan{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:8px;
  margin-top:15px;
}

.plan{
  background:#151d2a;
  border-radius:9px;
  padding:10px;
}

.plan-label{
  color:#68758a;
  font-size:10px;
}

.plan-value{
  margin-top:5px;
  font-weight:900;
  font-size:13px;
}

.reason{
  margin-top:15px;
  padding:11px;
  border-radius:8px;
  background:#121a27;
  color:#a8b3c5;
  font-size:12px;
}

.open-tv{
  display:inline-block;
  margin-top:13px;
  padding:9px 13px;
  background:#e9edf4;
  color:#0b1018;
  text-decoration:none;
  border-radius:8px;
  font-size:12px;
  font-weight:900;
}

.prepare-card{
  display:flex;
  justify-content:space-between;
  padding:14px;
  border-bottom:1px solid #202a39;
}

.trigger{
  text-align:right;
}

.distance{
  color:#e8c55d;
  font-size:12px;
}

.status{
  margin-top:12px;
  color:#7e8b9e;
  font-size:12px;
}

button{
  border:0;
  border-radius:8px;
  padding:11px 15px;
  font-weight:900;
  cursor:pointer;
}

@media(max-width:800px){

  .stats{
    grid-template-columns:repeat(2,1fr);
  }

  .grid-plan{
    grid-template-columns:repeat(2,1fr);
  }

  .header{
    display:block;
  }

  .online{
    display:inline-block;
    margin-top:12px;
  }

}

</style>

</head>

<body>

<div class="container">

<div class="header">

<div>

<div class="title">
🚀 Sonny AI Signal Scanner V5
</div>

<div class="subtitle">
4H / 2H Breakout · Retest · RSI
</div>

</div>

<div class="online">
● SÜREKLİ AKTİF
</div>

</div>


<div class="market-box">

<div class="market-title">
GENEL PİYASA DURUMU
</div>

<div
  id="marketDirection"
  class="market-direction"
>
YÜKLENİYOR...
</div>

<div
  id="marketReason"
  class="subtitle"
>
Piyasa analiz ediliyor.
</div>

</div>


<div class="stats">

<div class="stat">

<div class="stat-label">
Piyasa
</div>

<div
  id="marketCount"
  class="stat-value"
>
-
</div>

</div>


<div class="stat">

<div class="stat-label">
Analiz
</div>

<div
  id="analyzed"
  class="stat-value"
>
-
</div>

</div>


<div class="stat">

<div class="stat-label">
Aktif Sinyal
</div>

<div
  id="signalCount"
  class="stat-value"
>
0
</div>

</div>


<div class="stat">

<div class="stat-label">
Son Tarama
</div>

<div
  id="lastScan"
  class="stat-value"
>
-
</div>

</div>

</div>


<div class="panel">

<h2>
🚨 AKTİF SİNYALLER
</h2>

<div class="panel-description">
4H/2H kırılımı + retest + RSI şartlarını karşılayan coinler.
</div>

<div id="signals">
Sistem tarama yapıyor...
</div>

</div>


<div class="panel">

<h2>
🟡 HAZIRLANAN FIRSATLAR
</h2>

<div class="panel-description">
Kırılım beklenen güçlü adaylar.
</div>

<div id="preparing">
-
</div>

</div>


<div class="panel">

<button onclick="loadResult()">
↻ Şimdi Yenile
</button>

<div
  id="status"
  class="status"
>
Sistem başlatılıyor...
</div>

</div>

</div>


<script>

function fp(v){

  if(
    v==null||
    !Number.isFinite(Number(v))
  ){
    return '-';
  }

  let n=Number(v);

  if(n>=100)
    return n.toFixed(2);

  if(n>=1)
    return n.toFixed(4);

  if(n>=.01)
    return n.toFixed(6);

  return n.toFixed(8);
}


function tv(s){

  window.open(
    'https://www.tradingview.com/chart/?symbol=BITGET:'+
    encodeURIComponent(s),
    '_blank'
  );

}


function renderSignals(a){

  const b=
    document.getElementById(
      'signals'
    );

  if(
    !a||
    !a.length
  ){

    b.innerHTML=
      '<div class="panel-description">'+
      'Şu anda tüm şartları karşılayan aktif sinyal yok.'+
      '</div>';

    return;
  }


  b.innerHTML=
    a.map(x=>`

      <div class="signal-card">

        <div class="signal-top">

          <div
            class="coin ${
              x.direction==='LONG'
                ?'long'
                :'short'
            }"
            onclick="tv('${x.symbol}')"
          >

            ${x.symbol}
            ·
            ${x.direction}

          </div>

          <div class="score">

            GÜÇ
            ${x.score}/100

          </div>

        </div>


        <div class="strategy">

          ${x.strategy}

        </div>


        <div class="price-line">

          Anlık fiyat:

          <span class="price">
            ${fp(x.price)}
          </span>

          · RSI:

          <b>
            ${x.rsi}
          </b>

        </div>


        <div class="grid-plan">


          <div class="plan">

            <div class="plan-label">
              GİRİŞ
            </div>

            <div class="plan-value">

              ${fp(x.entryLow)}
              -
              ${fp(x.entryHigh)}

            </div>

          </div>


          <div class="plan">

            <div class="plan-label">
              STOP
            </div>

            <div class="plan-value">
              ${fp(x.stop)}
            </div>

          </div>


          <div class="plan">

            <div class="plan-label">
              TP1
            </div>

            <div class="plan-value">
              ${fp(x.tp1)}
            </div>

          </div>


          <div class="plan">

            <div class="plan-label">
              TP2
            </div>

            <div class="plan-value">
              ${fp(x.tp2)}
            </div>

          </div>


          <div class="plan">

            <div class="plan-label">
              TP3
            </div>

            <div class="plan-value">
              ${fp(x.tp3)}
            </div>

          </div>

        </div>


        <div class="reason">

          <b>Neden sinyal?</b>

          <br>

          ${x.reason}

        </div>


        <a
          class="open-tv"
          href="${x.tradingView}"
          target="_blank"
        >

          📊 TRADINGVIEW'DE AÇ

        </a>

      </div>

    `).join('');

}


function renderPreparing(a){

  const b=
    document.getElementById(
      'preparing'
    );

  if(
    !a||
    !a.length
  ){

    b.innerHTML=
      '<div class="panel-description">'+
      'Şu anda hazırlanan güçlü fırsat yok.'+
      '</div>';

    return;
  }


  b.innerHTML=
    a.map(x=>`

      <div class="prepare-card">

        <div>

          <b
            class="${
              x.direction==='LONG'
                ?'long'
                :'short'
            }"
          >

            ${x.symbol}
            ·
            ${x.direction}

          </b>

          <div class="prepare-info">

            Anlık:
            ${fp(x.price)}

            · RSI:
            ${x.rsi}

          </div>

        </div>


        <div class="trigger">

          <b>

            Tetik:
            ${fp(x.trigger)}

          </b>

          <div class="distance">

            ${x.distance}%
            uzakta

          </div>

        </div>

      </div>

    `).join('');

}


function update(d){

  if(!d){
    return;
  }


  if(d.market){

    const e=
      document.getElementById(
        'marketDirection'
      );

    e.textContent=
      d.market.label;

    e.className=
      'market-direction '+
      (
        d.market.direction==='LONG'
          ?'long'
          :d.market.direction==='SHORT'
            ?'short'
            :''
      );


    document.getElementById(
      'marketReason'
    ).textContent=
      d.market.reason;

  }


  if(d.stats){

    document.getElementById(
      'marketCount'
    ).textContent=
      d.stats.market;

    document.getElementById(
      'analyzed'
    ).textContent=
      d.stats.analyzed;

    document.getElementById(
      'signalCount'
    ).textContent=
      d.stats.signals;

  }


  if(d.timestamp){

    document.getElementById(
      'lastScan'
    ).textContent=
      new Date(
        d.timestamp
      ).toLocaleTimeString(
        'tr-TR'
      );

  }


  renderSignals(
    d.signals
  );

  renderPreparing(
    d.preparing
  );

}


async function loadResult(){

  try{

    const r=
      await fetch(
        '/api/result?_='+Date.now(),
        {
          cache:'no-store'
        }
      );


    if(!r.ok){

      throw new Error(
        'HTTP '+r.status
      );

    }


    const d=
      await r.json();


    if(d.result){

      update(
        d.result
      );


      document.getElementById(
        'status'
      ).textContent=
        d.scanning
          ?'Sistem taramayı sürdürüyor...'
          :'Sistem aktif. Her dakika yeni tarama yapılıyor.';

    }else{

      document.getElementById(
        'status'
      ).textContent=
        d.message||
        'İlk tarama bekleniyor...';

    }

  }catch(e){

    document.getElementById(
      'status'
    ).textContent=
      'Sunucu bağlantı hatası: '+
      e.message;

  }

}


/*
İlk açılış
*/

loadResult();


/*
Ekran 10 saniyede bir
sunucudan yeni sonucu alır.
*/

setInterval(
  loadResult,
  10000
);

</script>

</body>

</html>

`;


/*
=========================================================
ROUTES
=========================================================
*/

app.get(
  '/',
  (req,res)=>{

    res.setHeader(
      'Content-Type',
      'text/html; charset=utf-8'
    );

    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate'
    );

    res.setHeader(
      'Pragma',
      'no-cache'
    );

    res.setHeader(
      'Expires',
      '0'
    );

    res.send(
      HTML
    );

  }
);


/*
=========================================================
HEALTH
=========================================================
*/

app.get(
  '/health',
  (req,res)=>

    res.json({

      success:true,

      status:'healthy',

      system:
        'Sonny AI Signal Scanner V5',

      strategy:
        '4H / 2H BREAKOUT + RETEST + RSI',

      uptime:
        process.uptime()

    })
);


/*
=========================================================
STATUS
=========================================================
*/

app.get(
  '/api/status',
  (req,res)=>

    res.json({

      success:true,

      system:
        'Sonny AI Signal Scanner V5',

      status:
        scanRunning
          ?'SCANNING'
          :'ONLINE',

      strategy:
        '4H / 2H BREAKOUT + RETEST + RSI',

      refresh:
        '60 SECONDS',

      lastScan,

      discoveryTime,

      market:
        marketCache.length,

      error:
        lastError

    })
);


/*
=========================================================
MANUAL SCAN
=========================================================
*/

app.get(
  '/api/scan',
  async(req,res)=>{

    res.json(
      await runRadar()
    );

  }
);


/*
=========================================================
RESULT
=========================================================
*/

app.get(
  '/api/result',
  async(req,res)=>{

    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate'
    );

    res.setHeader(
      'Pragma',
      'no-cache'
    );

    res.setHeader(
      'Expires',
      '0'
    );


    try{

      /*
      Sayfa ilk açıldığında henüz
      sonuç yoksa taramayı başlat.
      */

      if(
        !cachedResult &&
        !scanRunning
      ){

        await runRadar();

      }


      /*
      Tarama devam ediyorsa bunu bildir.
      */

      if(!cachedResult){

        return res.json({

          success:true,

          scanning:true,

          result:null,

          message:
            'İlk tarama devam ediyor...'

        });

      }


      /*
      ANLIK FİYAT GÜNCELLEME

      Sinyal aynı kalır.
      Ekrandaki fiyat güncellenir.
      */

      try{

        const ts=
          await bitget(
            '/api/v2/mix/market/tickers',
            {
              productType:PRODUCT
            }
          );


        const pm=
          new Map(

            (Array.isArray(ts)?ts:[])
              .map(
                t=>[
                  t.symbol,
                  +t.lastPr
                ]
              )

          );


        cachedResult.signals=
          cachedResult.signals.map(x=>

            pm.has(x.symbol)

              ?{
                  ...x,
                  price:
                    round(
                      pm.get(x.symbol),
                      8
                    )
                }

              :x

          );


        cachedResult.preparing=
          cachedResult.preparing.map(x=>

            pm.has(x.symbol)

              ?{
                  ...x,
                  price:
                    round(
                      pm.get(x.symbol),
                      8
                    )
                }

              :x

          );

      }catch(e){

        log(
          'Live price refresh skipped: '+
          e.message
        );

      }


      return res.json({

        success:true,

        scanning:
          scanRunning,

        result:
          cachedResult

      });


    }catch(e){

      lastError=
        e.message;

      res.status(500).json({

        success:false,

        scanning:
          scanRunning,

        result:
          cachedResult,

        error:
          e.message

      });

    }

  }
);


/*
=========================================================
404
=========================================================
*/

app.use(
  (req,res)=>

    res.status(404).json({

      success:false,

      error:
        'Endpoint not found'

    })
);


/*
=========================================================
SERVER
=========================================================
*/

app.listen(
  PORT,
  '0.0.0.0',
  ()=>{

    log(
      'Sonny AI Signal Scanner V5 started'
    );

    log(
      'Data source: BITGET'
    );

    log(
      'Strategy: 4H / 2H BREAKOUT + RETEST + RSI'
    );

    log(
      `Server listening on port ${PORT}`
    );


    /*
    İlk tarama 3 saniye sonra.
    */

    setTimeout(
      ()=>runRadar(),
      3000
    );


    /*
    Her 60 saniyede yeni tarama.
    */

    setInterval(
      ()=>runRadar(),
      CFG.REFRESH_MS
    );

  }
);
