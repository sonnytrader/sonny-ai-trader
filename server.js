const express=require("express");
const fs=require("fs"),path=require("path");
const app=express();app.use(express.json());

const PORT=process.env.PORT||10000;
const SYSTEM="Sonny AI Signal Scanner V5.4";
const BASE="https://api.bitget.com";
const PRODUCT="usdt-futures";

const FILE=path.join(__dirname,"sonny_performance.json");

const C={
  REFRESH:60000,
  MIN_VOL:3000000,
  MARKET:100,
  ANALYZE:70,
  BATCH:8,
  DELAY:100,
  H4:100,
  H2:100,
  M15:150,
  LOOK4:30,
  LOOK2:30,
  RETEST:.8,
  ENTRY:.4,
  RSI:14,
  LONG_MIN:48,
  LONG_MAX:68,
  SHORT_MIN:32,
  SHORT_MAX:52,
  SCORE:75,
  MAX_SIG:8,
  MAX_PREP:8,
  MISSED_BUFFER:.25,
  COOLDOWN:15*60*1000,
  MAX_MISSED:5,
  MAX_HISTORY:200,
  LAST50:50,
  MAX_AGE:6*60*60*1000
};

let market=[];
let cached=null;
let lastScan=null;
let lastError=null;
let running=false;
let discoveryTime=null;

const active=new Map();
const missed=[];
const cooldowns=new Map();
const perf=[];


/*
=========================================================
HELPERS
=========================================================
*/

function log(x){
  console.log(`[${new Date().toISOString()}] ${x}`);
}

function sleep(ms){
  return new Promise(r=>setTimeout(r,ms));
}

function rnd(x,d=6){
  return Number.isFinite(x)
    ? Number(x.toFixed(d))
    : 0;
}

function pct(x,b){
  return Number.isFinite(x)&&
         Number.isFinite(b)&&
         b
    ? x/b*100
    : 0;
}


/*
=========================================================
INDICATORS
=========================================================
*/

function ema(a,p){

  if(!a||a.length<p)return null;

  let k=2/(p+1);

  let v=
    a
      .slice(0,p)
      .reduce((x,y)=>x+y,0)/p;

  for(let i=p;i<a.length;i++){

    v=
      (a[i]-v)*k+v;

  }

  return v;
}

function sma(a,p){

  return !a||a.length<p
    ? null
    : a
        .slice(-p)
        .reduce((x,y)=>x+y,0)/p;

}

function rsi(a,p=14){

  if(!a||a.length<=p)return null;

  let g=0;
  let l=0;

  for(let i=1;i<=p;i++){

    let d=a[i]-a[i-1];

    if(d>=0)
      g+=d;
    else
      l-=d;

  }

  let ag=g/p;
  let al=l/p;

  for(let i=p+1;i<a.length;i++){

    let d=a[i]-a[i-1];

    let gg=d>0?d:0;
    let ll=d<0?-d:0;

    ag=(ag*(p-1)+gg)/p;
    al=(al*(p-1)+ll)/p;

  }

  return al===0
    ? 100
    : 100-100/(1+ag/al);

}


/*
=========================================================
BITGET
=========================================================
*/

async function bitget(pathname,params={}){

  const u=
    new URL(
      BASE+pathname
    );

  for(
    const[k,v]
    of Object.entries(params)
  ){

    if(
      v!==undefined &&
      v!==null &&
      v!==""
    ){

      u.searchParams.set(
        k,
        String(v)
      );

    }

  }

  const r=
    await fetch(u);

  const t=
    await r.text();

  if(!r.ok){

    throw Error(
      `Bitget HTTP ${r.status} - ${t.slice(0,200)}`
    );

  }

  let j;

  try{

    j=
      JSON.parse(t);

  }catch{

    throw Error(
      "Bitget JSON parse error"
    );

  }

  if(j.code!=="00000"){

    throw Error(
      `Bitget ${j.code} - ${j.msg||"Unknown"}`
    );

  }

  return j.data;

}


/*
=========================================================
CANDLE PARSER
=========================================================
*/

function candles(data){

  return Array.isArray(data)
    ? data
        .map(r=>({

          time:+r[0],
          open:+r[1],
          high:+r[2],
          low:+r[3],
          close:+r[4],
          volume:+r[5],
          quoteVolume:+(r[6]||0)

        }))
        .filter(
          x=>Number.isFinite(x.close)
        )
        .sort(
          (a,b)=>a.time-b.time
        )
    : [];

}

async function getCandles(
  symbol,
  granularity,
  limit
){

  return candles(
    await bitget(
      "/api/v2/mix/market/candles",
      {
        symbol,
        productType:PRODUCT,
        granularity,
        limit
      }
    )
  );

}


/*
=========================================================
MARKET DISCOVERY
=========================================================
*/

async function discover(){

  const[
    contracts,
    tickers
  ]=
    await Promise.all([

      bitget(
        "/api/v2/mix/market/contracts",
        {
          productType:PRODUCT
        }
      ),

      bitget(
        "/api/v2/mix/market/tickers",
        {
          productType:PRODUCT
        }
      )

    ]);

  const valid=
    new Set(
      contracts
        .filter(
          x=>
            x.symbolType==="perpetual" &&
            x.symbolStatus==="normal" &&
            x.quoteCoin==="USDT"
        )
        .map(
          x=>x.symbol
        )
    );

  market=
    tickers
      .filter(
        x=>valid.has(x.symbol)
      )
      .map(x=>{

        const p=+x.lastPr;
        const h=+x.high24h;
        const l=+x.low24h;
        const v=+(x.quoteVolume||0);
        const c=+(x.change24h||0);

        return{

          symbol:x.symbol,

          price:p,

          change24h:
            Math.abs(c)<=1
              ? c*100
              : c,

          volume24h:v,

          range24h:
            p
              ? (h-l)/p*100
              : 0

        };

      })
      .filter(
        x=>
          x.volume24h>=C.MIN_VOL
      )
      .map(x=>{

        let s=0;

        const m=
          Math.abs(
            x.change24h
          );

        s+=
          x.volume24h>=1e8
            ?25
            :x.volume24h>=3e7
              ?20
              :x.volume24h>=1e7
                ?15
                :10;

        s+=
          m>=5
            ?25
            :m>=3
              ?20
              :m>=1.5
                ?12
                :0;

        s+=
          x.range24h>=8
            ?25
            :x.range24h>=5
              ?20
              :x.range24h>=3
                ?12
                :0;

        return{
          ...x,
          discoveryScore:s
        };

      })
      .sort(
        (a,b)=>
          b.discoveryScore-
          a.discoveryScore
      )
      .slice(
        0,
        C.MARKET
      );

  discoveryTime=
    new Date().toISOString();

  log(
    `Discovery tamamlandı. ${market.length} uygun coin bulundu.`
  );

  return market;

}


/*
=========================================================
LEVELS
=========================================================
*/

function levels(cs,n){

  if(
    !cs ||
    cs.length<n+2
  ){

    return null;

  }

  const x=
    cs.slice(0,-1);

  const z=
    x.slice(-n);

  return{

    resistance:
      Math.max(
        ...z.map(
          c=>c.high
        )
      ),

    support:
      Math.min(
        ...z.map(
          c=>c.low
        )
      ),

    current:
      x.at(-1)

  };

}


/*
=========================================================
BREAKOUT
=========================================================
*/

function breakout(cs,n){

  if(
    !cs ||
    cs.length<n+3
  ){

    return null;

  }

  const x=
    cs.slice(0,-1);

  const recent=
    x.slice(
      -n-1,
      -1
    );

  const res=
    Math.max(
      ...recent.map(
        c=>c.high
      )
    );

  const sup=
    Math.min(
      ...recent.map(
        c=>c.low
      )
    );

  let lb=false;
  let sb=false;

  for(
    let i=
      Math.max(
        1,
        x.length-8
      );

    i<x.length;

    i++
  ){

    if(
      x[i].close>res &&
      x[i-1].close<=res
    ){

      lb=true;

    }

    if(
      x[i].close<sup &&
      x[i-1].close>=sup
    ){

      sb=true;

    }

  }

  return{

    resistance:res,
    support:sup,
    current:x.at(-1),
    longBreakout:lb,
    shortBreakout:sb

  };

}


/*
=========================================================
SCORE
=========================================================
*/

function score(dir,rv){

  let s=
    35+
    30+
    20+
    10;

  if(
    dir==="LONG" &&
    rv>=52 &&
    rv<=63
  ){

    s+=5;

  }

  if(
    dir==="SHORT" &&
    rv>=37 &&
    rv<=48
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

function plan(
  m,
  dir,
  level,
  rv
){

  const rawL=
    dir==="LONG"
      ?level*.998
      :level*1.002;

  const rawH=
    dir==="LONG"
      ?level*1.004
      :level*.996;

  const entryLow=
    Math.min(
      rawL,
      rawH
    );

  const entryHigh=
    Math.max(
      rawL,
      rawH
    );

  const stop=
    dir==="LONG"
      ?level*.982
      :level*1.018;

  const risk=
    Math.abs(
      level-stop
    );

  const tp1=
    dir==="LONG"
      ?level+risk*1.5
      :level-risk*1.5;

  const tp2=
    dir==="LONG"
      ?level+risk*2
      :level-risk*2;

  const tp3=
    dir==="LONG"
      ?level+risk*3
      :level-risk*3;

  return{

    symbol:
      m.symbol,

    direction:
      dir,

    strategy:
      "4H / 2H BREAKOUT + RETEST + RSI",

    score:
      score(
        dir,
        rv
      ),

    price:
      rnd(
        m.price,
        8
      ),

    entryLow:
      rnd(
        entryLow,
        8
      ),

    entryHigh:
      rnd(
        entryHigh,
        8
      ),

    stop:
      rnd(
        stop,
        8
      ),

    tp1:
      rnd(
        tp1,
        8
      ),

    tp2:
      rnd(
        tp2,
        8
      ),

    tp3:
      rnd(
        tp3,
        8
      ),

    rsi:
      rnd(
        rv,
        1
      ),

    change24h:
      rnd(
        m.change24h,
        2
      ),

    volume24h:
      rnd(
        m.volume24h/1e6,
        2
      ),

    level:
      rnd(
        level,
        8
      ),

    reason:
      dir==="LONG"
        ?"4H direnç kırılımı + 2H onayı + retest + 15M RSI LONG bölgesi."
        :"4H destek kırılımı + 2H onayı + retest + 15M RSI SHORT bölgesi.",

    tradingView:
      `https://www.tradingview.com/chart/?symbol=BITGET:${m.symbol}`

  };

}


/*
=========================================================
SIGNAL
=========================================================
*/

function signal(
  m,
  h4,
  h2,
  m15
){

  if(
    !h4 ||
    !h2 ||
    !m15
  ){

    return null;

  }

  const rv=
    rsi(
      m15
        .slice(0,-1)
        .map(
          x=>x.close
        ),
      C.RSI
    );

  if(rv==null)
    return null;


  /*
  LONG
  */

  if(
    h4.longBreakout &&
    h2.longBreakout
  ){

    const d=
      Math.abs(
        pct(
          m.price-
          h4.resistance,
          h4.resistance
        )
      );

    const ok=
      m.price>=
        h4.resistance*
        (1-C.RETEST/100) &&

      m.price<=
        h4.resistance*
        (1+C.ENTRY/100);

    if(
      d<=C.ENTRY &&
      ok &&
      rv>=C.LONG_MIN &&
      rv<=C.LONG_MAX
    ){

      return plan(
        m,
        "LONG",
        h4.resistance,
        rv
      );

    }

  }


  /*
  SHORT
  */

  if(
    h4.shortBreakout &&
    h2.shortBreakout
  ){

    const d=
      Math.abs(
        pct(
          m.price-
          h4.support,
          h4.support
        )
      );

    const ok=
      m.price<=
        h4.support*
        (1+C.RETEST/100) &&

      m.price>=
        h4.support*
        (1-C.ENTRY/100);

    if(
      d<=C.ENTRY &&
      ok &&
      rv>=C.SHORT_MIN &&
      rv<=C.SHORT_MAX
    ){

      return plan(
        m,
        "SHORT",
        h4.support,
        rv
      );

    }

  }

  return null;

}


/*
=========================================================
PREPARING
=========================================================
*/

function preparing(
  m,
  h4,
  h2,
  m15
){

  if(
    !h4 ||
    !h2 ||
    !m15
  ){

    return null;

  }

  const rv=
    rsi(
      m15
        .slice(0,-1)
        .map(
          x=>x.close
        ),
      C.RSI
    );

  if(rv==null)
    return null;

  const ld=
    pct(
      h4.resistance-
      m.price,
      m.price
    );

  const sd=
    pct(
      m.price-
      h4.support,
      m.price
    );


  if(
    ld>=0 &&
    ld<=1 &&
    pct(
      h2.resistance-
      m.price,
      m.price
    )<=1.5 &&
    rv>=45 &&
    rv<=70
  ){

    return{

      symbol:
        m.symbol,

      direction:
        "LONG",

      price:
        rnd(
          m.price,
          8
        ),

      trigger:
        rnd(
          h4.resistance,
          8
        ),

      distance:
        rnd(
          ld,
          3
        ),

      rsi:
        rnd(
          rv,
          1
        ),

      message:
        `Fiyat ${rnd(ld,3)}% uzakta. 4H direnç kırılması bekleniyor.`,

      tradingView:
        `https://www.tradingview.com/chart/?symbol=BITGET:${m.symbol}`

    };

  }


  if(
    sd>=0 &&
    sd<=1 &&
    pct(
      m.price-
      h2.support,
      m.price
    )<=1.5 &&
    rv>=30 &&
    rv<=55
  ){

    return{

      symbol:
        m.symbol,

      direction:
        "SHORT",

      price:
        rnd(
          m.price,
          8
        ),

      trigger:
        rnd(
          h4.support,
          8
        ),

      distance:
        rnd(
          sd,
          3
        ),

      rsi:
        rnd(
          rv,
          1
        ),

      message:
        `Fiyat ${rnd(sd,3)}% uzakta. 4H destek kırılması bekleniyor.`,

      tradingView:
        `https://www.tradingview.com/chart/?symbol=BITGET:${m.symbol}`

    };

  }

  return null;

}


/*
=========================================================
PERFORMANCE STORAGE
=========================================================
*/

function loadPerf(){

  try{

    if(
      fs.existsSync(FILE)
    ){

      const a=
        JSON.parse(
          fs.readFileSync(
            FILE,
            "utf8"
          )
        );

      if(
        Array.isArray(a)
      ){

        a
          .slice(
            0,
            C.MAX_HISTORY
          )
          .forEach(
            x=>perf.push(x)
          );

        log(
          `Performans geçmişi: ${perf.length} kayıt.`
        );

      }

    }

  }catch(e){

    log(
      `Performans yüklenemedi: ${e.message}`
    );

  }

}

function savePerf(){

  try{

    fs.writeFileSync(
      FILE,
      JSON.stringify(
        perf,
        null,
        2
      )
    );

  }catch(e){

    log(
      `Performans yazılamadı: ${e.message}`
    );

  }

}

function perfRec(sig){

  return(
    perf.find(
      x=>
        x.id===
        sig.performanceId
    )||null
  );

}

function newPerf(sig){

  const old=
    perfRec(sig);

  if(old)
    return old;

  const r={

    id:
      `${sig.symbol}:${sig.direction}:${Date.now()}:${Math.random().toString(36).slice(2,7)}`,

    symbol:
      sig.symbol,

    direction:
      sig.direction,

    score:
      sig.score,

    signalAt:
      sig.createdAt,

    entryLow:
      sig.entryLow,

    entryHigh:
      sig.entryHigh,

    stop:
      sig.stop,

    tp1:
      sig.tp1,

    tp2:
      sig.tp2,

    tp3:
      sig.tp3,

    status:
      "WAITING_ENTRY",

    entryPrice:
      null,

    entryAt:
      null,

    outcome:
      null,

    outcomeAt:
      null,

    rMultiple:
      null,

    maxR:
      0,

    currentPrice:
      sig.price,

    completed:
      false

  };

  perf.unshift(r);

  while(
    perf.length>
    C.MAX_HISTORY
  ){

    perf.pop();

  }

  savePerf();

  return r;

}

function complete(
  r,
  outcome,
  rval,
  reason
){

  if(
    !r ||
    r.completed
  ){

    return;

  }

  r.status=
    outcome;

  r.outcome=
    outcome;

  r.outcomeAt=
    new Date().toISOString();

  r.rMultiple=
    rnd(
      rval,
      2
    );

  r.reason=
    reason;

  r.completed=
    true;

  savePerf();

}


/*
=========================================================
LIVE PERFORMANCE
=========================================================
*/

function updatePerf(
  sig,
  p
){

  const r=
    perfRec(sig);

  if(
    !r ||
    r.completed
  ){

    return;

  }

  r.currentPrice=
    rnd(
      p,
      8
    );


  /*
  GİRİŞ BEKLENİYOR
  */

  if(
    r.status===
    "WAITING_ENTRY"
  ){

    if(
      p>=r.entryLow &&
      p<=r.entryHigh
    ){

      r.status=
        "ENTERED";

      r.entryPrice=
        rnd(
          p,
          8
        );

      r.entryAt=
        new Date().toISOString();

      r.risk=
        Math.abs(
          r.entryPrice-
          r.stop
        );

      savePerf();

      log(
        `ENTRY HIT ${r.symbol} ${r.direction} @ ${r.entryPrice}`
      );

      return;

    }


    const b=
      C.MISSED_BUFFER/
      100;

    const miss=
      r.direction===
      "LONG"

        ?p>
          r.entryHigh*
          (1+b)

        :p<
          r.entryLow*
          (1-b);

    if(miss){

      return complete(
        r,
        "MISSED",
        0,
        "Giriş bölgesi kaçtı."
      );

    }


    if(
      Date.now()-
      new Date(
        r.signalAt
      ).getTime()
      >=
      C.MAX_AGE
    ){

      return complete(
        r,
        "EXPIRED",
        0,
        "6 saat içinde giriş oluşmadı."
      );

    }

    return;

  }


  /*
  İŞLEM AÇILDI
  */

  if(
    r.status!=="ENTERED" ||
    !r.risk
  ){

    return;

  }

  const cr=
    r.direction==="LONG"

      ?(
        p-
        r.entryPrice
      )/
      r.risk

      :(
        r.entryPrice-
        p
      )/
      r.risk;

  r.maxR=
    Math.max(
      r.maxR,
      cr
    );


  if(
    r.direction==="LONG"
  ){

    if(
      p>=r.tp3
    ){

      return complete(
        r,
        "TP3",
        3,
        "TP3 görüldü."
      );

    }

    if(
      p>=r.tp2
    ){

      return complete(
        r,
        "TP2",
        2,
        "TP2 görüldü."
      );

    }

    if(
      p>=r.tp1
    ){

      return complete(
        r,
        "TP1",
        1.5,
        "TP1 görüldü."
      );

    }

    if(
      p<=r.stop
    ){

      return complete(
        r,
        "STOP",
        -1,
        "Stop görüldü."
      );

    }

  }else{

    if(
      p<=r.tp3
    ){

      return complete(
        r,
        "TP3",
        3,
        "TP3 görüldü."
      );

    }

    if(
      p<=r.tp2
    ){

      return complete(
        r,
        "TP2",
        2,
        "TP2 görüldü."
      );

    }

    if(
      p<=r.tp1
    ){

      return complete(
        r,
        "TP1",
        1.5,
        "TP1 görüldü."
      );

    }

    if(
      p>=r.stop
    ){

      return complete(
        r,
        "STOP",
        -1,
        "Stop görüldü."
      );

    }

  }

}


/*
=========================================================
PERFORMANCE SUMMARY
=========================================================
*/

function perfSummary(){

  const last=
    perf.slice(
      0,
      C.LAST50
    );

  const tr=
    last.filter(
      x=>
        [
          "TP1",
          "TP2",
          "TP3",
          "STOP"
        ].includes(
          x.outcome
        )
    );

  const wins=
    tr.filter(
      x=>
        [
          "TP1",
          "TP2",
          "TP3"
        ].includes(
          x.outcome
        )
    );

  const r=
    tr
      .map(
        x=>+x.rMultiple
      )
      .filter(
        Number.isFinite
      );

  const total=
    r.reduce(
      (a,b)=>a+b,
      0
    );

  let streak=0;
  let best=0;
  let worst=0;

  tr
    .slice()
    .reverse()
    .forEach(
      x=>{

        const w=
          x.outcome!=="STOP";

        streak=
          w
            ?(
              streak>=0
                ?streak+1
                :1
            )
            :(
              streak<=0
                ?streak-1
                :-1
            );

        if(w){

          best=
            Math.max(
              best,
              streak
            );

        }else{

          worst=
            Math.max(
              worst,
              Math.abs(
                streak
              )
            );

        }

      }
    );

  return{

    sample:
      tr.length,

    wins:
      wins.length,

    stops:
      tr.filter(
        x=>
          x.outcome===
          "STOP"
      ).length,

    missed:
      last.filter(
        x=>
          x.outcome===
          "MISSED"
      ).length,

    expired:
      last.filter(
        x=>
          x.outcome===
          "EXPIRED"
      ).length,

    open:
      last.filter(
        x=>
          !x.completed
      ).length,

    tp1SuccessRate:
      tr.length
        ?rnd(
          wins.length/
          tr.length*
          100,
          1
        )
        :0,

    averageR:
      r.length
        ?rnd(
          total/r.length,
          2
        )
        :0,

    totalR:
      rnd(
        total,
        2
      ),

    bestWinStreak:
      best,

    worstLossStreak:
      worst,

    last50:
      last.map(
        x=>({

          symbol:
            x.symbol,

          direction:
            x.direction,

          status:
            x.status,

          outcome:
            x.outcome,

          rMultiple:
            x.rMultiple,

          signalAt:
            x.signalAt,

          outcomeAt:
            x.outcomeAt

        })
      )

  };

}


/*
=========================================================
SIGNAL LIFECYCLE
=========================================================
*/

function key(s){

  return(
    `${s.symbol}:${s.direction}`
  );

}

function pushMissed(
  s,
  reason
){

  missed.unshift({

    ...s,

    status:
      "MISSED",

    missedAt:
      new Date().toISOString(),

    missedReason:
      reason

  });

  while(
    missed.length>
    C.MAX_MISSED
  ){

    missed.pop();

  }

}

function moveHistory(
  k,
  s,
  reason
){

  active.delete(k);

  pushMissed(
    s,
    reason
  );

  cooldowns.set(
    k,
    Date.now()+
    C.COOLDOWN
  );

  log(
    `SIGNAL ${s.symbol} ${s.direction} -> ${reason}`
  );

}

function lifecycle(
  s,
  p
){

  const age=
    Date.now()-
    new Date(
      s.createdAt||
      Date.now()
    ).getTime();

  if(
    age>=
    C.MAX_AGE
  ){

    return{

      ...s,

      status:
        "INVALID",

      lifecycleReason:
        "Sinyal 6 saat içinde girişe dönüşmedi; süresi doldu."

    };

  }

  const n={

    ...s,

    price:
      rnd(
        p,
        8
      ),

    status:
      "ACTIVE"

  };

  const b=
    C.MISSED_BUFFER/
    100;


  if(
    s.direction===
    "LONG"
  ){

    if(
      p>=s.tp1
    ){

      return{

        ...n,

        status:
          "MISSED",

        lifecycleReason:
          "Fiyat TP1'e ulaştı; giriş fırsatı kaçtı."

      };

    }

    if(
      p>
      s.entryHigh*
      (1+b)
    ){

      return{

        ...n,

        status:
          "MISSED",

        lifecycleReason:
          "Fiyat giriş bölgesinin üstüne çıktı; giriş fırsatı kaçtı."

      };

    }

    if(
      p<=s.stop
    ){

      return{

        ...n,

        status:
          "INVALID",

        lifecycleReason:
          "Fiyat stop seviyesine indi; sinyal geçersiz."

      };

    }

  }else{

    if(
      p<=s.tp1
    ){

      return{

        ...n,

        status:
          "MISSED",

        lifecycleReason:
          "Fiyat TP1'e ulaştı; giriş fırsatı kaçtı."

      };

    }

    if(
      p<
      s.entryLow*
      (1-b)
    ){

      return{

        ...n,

        status:
          "MISSED",

        lifecycleReason:
          "Fiyat giriş bölgesinin altına indi; giriş fırsatı kaçtı."

      };

    }

    if(
      p>=s.stop
    ){

      return{

        ...n,

        status:
          "INVALID",

        lifecycleReason:
          "Fiyat stop seviyesine çıktı; sinyal geçersiz."

      };

    }

  }

  return n;

}


/*
=========================================================
ACTIVE SIGNAL SYNC
=========================================================
*/

function sync(
  signals,
  prices
){

  /*
  Yeni sinyaller
  */

  for(
    const sig
    of signals
  ){

    const k=
      key(sig);

    const cd=
      cooldowns.get(k)||
      0;

    if(
      cd>
      Date.now()
    ){

      continue;

    }

    if(cd){

      cooldowns.delete(k);

    }

    const old=
      active.get(k);

    const m={

      ...(old||{}),

      ...sig,

      status:
        "ACTIVE",

      createdAt:
        old?.createdAt||
        new Date().toISOString()

    };

    if(
      !m.performanceId
    ){

      const r=
        newPerf(m);

      if(r){

        m.performanceId=
          r.id;

      }

    }

    active.set(
      k,
      m
    );

  }


  /*
  Canlı fiyat ile kontrol
  */

  for(
    const[k,sig]
    of active
  ){

    const p=
      prices.get(
        sig.symbol
      );

    if(
      !Number.isFinite(p)
    ){

      continue;

    }

    updatePerf(
      sig,
      p
    );

    const u=
      lifecycle(
        sig,
        p
      );

    if(
      u.status===
      "MISSED" ||
      u.status===
      "INVALID"
    ){

      moveHistory(
        k,
        u,
        u.lifecycleReason
      );

      continue;

    }

    active.set(
      k,
      u
    );

  }

  return[
    ...active.values()
  ]
    .sort(
      (a,b)=>
        b.score-
        a.score
    )
    .slice(
      0,
      C.MAX_SIG
    );

}

function priceMap(){

  const m=
    new Map();

  market.forEach(
    x=>{

      if(
        Number.isFinite(
          x.price
        )
      ){

        m.set(
          x.symbol,
          x.price
        );

      }

    }
  );

  return m;

}


/*
=========================================================
COIN ANALYSIS
=========================================================
*/

async function analyze(m){

  try{

    const[
      a,
      b,
      c
    ]=
      await Promise.all([

        getCandles(
          m.symbol,
          "4H",
          C.H4
        ),

        getCandles(
          m.symbol,
          "2H",
          C.H2
        ),

        getCandles(
          m.symbol,
          "15m",
          C.M15
        )

      ]);

    if(
      a.length<40 ||
      b.length<40 ||
      c.length<50
    ){

      return null;

    }

    const h4=
      breakout(
        a,
        C.LOOK4
      );

    const h2=
      breakout(
        b,
        C.LOOK2
      );

    const sig=
      signal(
        m,
        h4,
        h2,
        c
      );

    if(sig){

      return{

        type:
          "SIGNAL",

        signal:
          sig

      };

    }

    const pr=
      preparing(
        m,
        levels(
          a,
          C.LOOK4
        ),
        levels(
          b,
          C.LOOK2
        ),
        c
      );

    return pr
      ?{

          type:
            "PREPARING",

          preparing:
            pr

        }
      :null;

  }catch(e){

    log(
      `Analiz ${m.symbol}: ${e.message}`
    );

    return null;

  }

}


/*
=========================================================
GENERAL MARKET
=========================================================
*/

async function marketDir(){

  const x=
    market.filter(
      m=>
        m.symbol===
        "BTCUSDT" ||
        m.symbol===
        "ETHUSDT"
    );

  let up=
    x.filter(
      m=>
        m.change24h>1
    ).length;

  let down=
    x.filter(
      m=>
        m.change24h<-1
    ).length;

  if(up>down){

    return{

      direction:
        "LONG",

      label:
        "PİYASA YUKARI",

      reason:
        "BTC / ETH yükseliş ağırlıklı."

    };

  }

  if(down>up){

    return{

      direction:
        "SHORT",

      label:
        "PİYASA AŞAĞI",

      reason:
        "BTC / ETH düşüş ağırlıklı."

    };

  }

  return{

    direction:
      "YATAY",

    label:
      "PİYASA YATAY",

    reason:
      "Genel piyasa yönü net değil."

  };

}


/*
=========================================================
RADAR
=========================================================
*/

async function runRadar(){

  if(running)
    return cached;

  running=true;
  lastError=null;

  const started=
    Date.now();

  try{

    /*
    Her dakika piyasa yeniden keşfediliyor.
    */

    await discover();

    const cand=
      market.slice(
        0,
        C.ANALYZE
      );

    const sigs=[];
    const pre=[];

    for(
      let i=0;
      i<cand.length;
      i+=C.BATCH
    ){

      const batch=
        await Promise.all(
          cand
            .slice(
              i,
              i+C.BATCH
            )
            .map(
              analyze
            )
        );

      batch.forEach(
        x=>{

          if(
            x?.type===
            "SIGNAL"
          ){

            sigs.push(
              x.signal
            );

          }

          if(
            x?.type===
            "PREPARING"
          ){

            pre.push(
              x.preparing
            );

          }

        }
      );

      await sleep(
        C.DELAY
      );

    }

    const fs=
      sync(
        sigs,
        priceMap()
      );

    pre.sort(
      (a,b)=>
        a.distance-
        b.distance
    );

    const md=
      await marketDir();

    cached={

      success:
        true,

      system:
        SYSTEM,

      timestamp:
        new Date().toISOString(),

      refresh:
        "EVERY 60 SECONDS",

      strategy:
        "4H / 2H BREAKOUT + RETEST + RSI",

      market:
        md,

      stats:{

        market:
          market.length,

        analyzed:
          cand.length,

        signals:
          fs.length,

        preparing:
          Math.min(
            pre.length,
            C.MAX_PREP
          ),

        duration:
          rnd(
            (
              Date.now()-
              started
            )/1000,
            1
          )

      },

      signals:
        fs,

      missed:
        missed.slice(
          0,
          C.MAX_MISSED
        ),

      preparing:
        pre.slice(
          0,
          C.MAX_PREP
        ),

      performance:
        perfSummary(),

      mode:
        "MANUAL SIGNAL ONLY"

    };

    lastScan=
      cached.timestamp;

    log(
      `RADAR tamamlandı | Market:${market.length} | Analiz:${cand.length} | SIGNAL:${fs.length} | MISSED:${missed.length} | PREPARING:${pre.length}`
    );

    return cached;

  }catch(e){

    lastError=
      e.message;

    log(
      `RADAR ERROR: ${e.message}`
    );

    return{

      success:
        false,

      error:
        e.message,

      system:
        SYSTEM

    };

  }finally{

    running=false;

  }

}


/*
=========================================================
UI
=========================================================
*/

function fmt(p){

  if(
    !Number.isFinite(+p)
  ){

    return "-";

  }

  p=+p;

  return(
    p>=100
      ?p.toFixed(2)
      :p>=1
        ?p.toFixed(4)
        :p>=.01
          ?p.toFixed(6)
          :p.toFixed(8)
  );

}


const HTML=`<!doctype html>
<html lang="tr">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>${SYSTEM}</title>

<style>

*{
  box-sizing:border-box
}

body{
  margin:0;
  background:#080b12;
  color:#f5f7fb;
  font-family:Arial,sans-serif
}

.container{
  width:min(1100px,94%);
  margin:20px auto 50px
}

.header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:15px
}

.title{
  font-size:27px;
  font-weight:900
}

.subtitle,.muted{
  color:#7d8799;
  font-size:13px
}

.online{
  padding:9px 14px;
  border-radius:20px;
  background:#0d2118;
  color:#43e58b;
  border:1px solid #174d31;
  font-weight:800
}

.market,.panel,.stat{
  background:#111722;
  border:1px solid #202b3b;
  border-radius:15px
}

.market{
  padding:18px;
  margin-bottom:15px
}

.market-label{
  color:#7d8799;
  font-size:10px;
  font-weight:800
}

.market-dir{
  font-size:27px;
  font-weight:900;
  margin-top:5px
}

.long,.good{
  color:#45e58d
}

.short,.bad{
  color:#ff647a
}

.neutral{
  color:#e8c55d
}

.stats{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:10px;
  margin-bottom:15px
}

.stat{
  padding:13px
}

.label{
  color:#697587;
  font-size:10px;
  text-transform:uppercase
}

.value{
  font-size:20px;
  font-weight:900;
  margin-top:6px
}

.panel{
  padding:18px;
  margin-bottom:15px
}

.panel h2{
  margin:0 0 5px;
  font-size:18px
}

.desc{
  color:#7d8799;
  font-size:12px;
  line-height:1.5;
  margin-bottom:12px
}

.card{
  background:#0c121d;
  border:1px solid #26354a;
  border-radius:13px;
  padding:15px;
  margin:10px 0
}

.top{
  display:flex;
  justify-content:space-between;
  align-items:center
}

.coin{
  font-size:20px;
  font-weight:900;
  cursor:pointer
}

.score{
  background:#1c2635;
  padding:6px 9px;
  border-radius:7px;
  font-weight:900
}

.strategy{
  color:#9ba7ba;
  font-size:12px;
  margin-top:7px
}

.price{
  font-size:18px;
  font-weight:900;
  margin:12px 0
}

.plans{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:7px
}

.plan{
  background:#151d2a;
  border-radius:9px;
  padding:9px
}

.pl{
  color:#68758a;
  font-size:9px
}

.pv{
  font-weight:900;
  font-size:12px;
  margin-top:4px
}

.reason{
  background:#121a27;
  padding:10px;
  border-radius:8px;
  color:#a8b3c5;
  font-size:11px;
  margin-top:10px
}

.tv{
  display:inline-block;
  margin-top:10px;
  padding:9px 12px;
  background:#e9edf4;
  color:#090e16;
  text-decoration:none;
  border-radius:8px;
  font-size:11px;
  font-weight:900
}

.prep{
  display:flex;
  justify-content:space-between;
  padding:12px;
  border-bottom:1px solid #202a39
}

.prep:last-child{
  border:0
}

.small{
  color:#8995a8;
  font-size:11px;
  margin-top:4px
}

.missed{
  background:#17131a;
  border:1px solid #3b2b3f;
  border-radius:9px;
  padding:10px;
  margin:8px 0
}

.missed-title{
  font-weight:900;
  color:#f0b65c
}

.perfgrid{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:8px
}

.perfbox{
  background:#151d2a;
  border-radius:9px;
  padding:11px
}

.perfval{
  font-size:18px;
  font-weight:900;
  margin-top:4px
}

.perflabel{
  color:#748096;
  font-size:9px;
  text-transform:uppercase
}

.note{
  color:#7d8799;
  font-size:11px;
  line-height:1.5;
  margin-top:10px
}

.ptable{
  width:100%;
  border-collapse:collapse;
  margin-top:10px
}

.ptable th,
.ptable td{
  padding:7px 5px;
  border-bottom:1px solid #202a39;
  text-align:left;
  font-size:10px
}

.ptable th{
  color:#697587;
  text-transform:uppercase
}

.hidden{
  display:none
}

button{
  border:0;
  border-radius:8px;
  padding:10px 14px;
  font-weight:900;
  cursor:pointer;
  background:#e9edf4;
  color:#090e16
}

button.sec{
  background:#252f40;
  color:#fff
}

@media(max-width:700px){

  .stats,
  .perfgrid{
    grid-template-columns:repeat(2,1fr)
  }

  .plans{
    grid-template-columns:repeat(2,1fr)
  }

  .header{
    display:block
  }

  .online{
    display:inline-block;
    margin-top:10px
  }

}

</style>

</head>

<body>

<div class="container">

<div class="header">

<div>

<div class="title">
🚀 Sonny AI Signal Scanner V5.4
</div>

<div class="subtitle">
4H / 2H Breakout · Retest · RSI · Canlı Performans
</div>

</div>

<div class="online">
● SÜREKLİ AKTİF
</div>

</div>


<div class="market">

<div class="market-label">
GENEL PİYASA DURUMU
</div>

<div
id="md"
class="market-dir">
YÜKLENİYOR...
</div>

<div
id="mr"
class="muted">
Piyasa analiz ediliyor.
</div>

</div>


<div class="stats">

<div class="stat">
<div class="label">
Piyasa
</div>
<div
id="mc"
class="value">
-
</div>
</div>

<div class="stat">
<div class="label">
Analiz
</div>
<div
id="an"
class="value">
-
</div>
</div>

<div class="stat">
<div class="label">
Aktif Sinyal
</div>
<div
id="sc"
class="value">
0
</div>
</div>

<div class="stat">
<div class="label">
Son Tarama
</div>
<div
id="ls"
class="value">
-
</div>
</div>

</div>


<div class="panel">

<h2>
🚨 AKTİF SİNYALLER
</h2>

<div class="desc">

4H/2H kırılımı + retest + RSI şartları tamamlanan
ve giriş fırsatı hâlâ geçerli olan coinler.

</div>

<div id="signals">

<div class="desc">
Sistem tarıyor...
</div>

</div>

</div>


<div
id="missedPanel"
class="panel hidden">

<h2>
⚠️ KAÇAN / GEÇERSİZ
</h2>

<div class="desc">

Giriş fırsatı kaçan sinyaller kısa süre burada görünür.

</div>

<div id="missed">
</div>

</div>


<div class="panel">

<h2>
🟡 HAZIRLANAN FIRSATLAR
</h2>

<div class="desc">

Kırılım henüz gelmedi;
güçlü adaylar burada görünür.

</div>

<div id="preparing">

<div class="desc">
Şu anda hazırlanan fırsat yok.
</div>

</div>

</div>


<div class="panel">

<h2>
📊 SİSTEM PERFORMANSI
</h2>

<div class="desc">

Son 50 sonuçlanmış işlemi baz alır.
Sinyal geldikten sonraki gerçek fiyat hareketi ölçülür.

</div>


<div class="perfgrid">

<div class="perfbox">

<div class="perflabel">
TP1 Başarı
</div>

<div
id="wr"
class="perfval">
-%
</div>

</div>


<div class="perfbox">

<div class="perflabel">
İşlem
</div>

<div
id="ps"
class="perfval">
0
</div>

</div>


<div class="perfbox">

<div class="perflabel">
Ortalama R
</div>

<div
id="ar"
class="perfval">
0R
</div>

</div>


<div class="perfbox">

<div class="perflabel">
Toplam R
</div>

<div
id="tr"
class="perfval">
0R
</div>

</div>

</div>


<div
class="perfgrid"
style="margin-top:8px">

<div class="perfbox">

<div class="perflabel">
TP
</div>

<div
id="pw"
class="perfval">
0
</div>

</div>


<div class="perfbox">

<div class="perflabel">
STOP
</div>

<div
id="pst"
class="perfval">
0
</div>

</div>


<div class="perfbox">

<div class="perflabel">
Kaçan
</div>

<div
id="pm"
class="perfval">
0
</div>

</div>


<div class="perfbox">

<div class="perflabel">
Açık Takip
</div>

<div
id="po"
class="perfval">
0
</div>

</div>

</div>


<div
id="pn"
class="note">

Henüz yeterli sonuç yok.

</div>

<div id="recent">
</div>

</div>


<div class="panel">

<button onclick="load()">
↻ Yenile
</button>

<button
class="sec"
onclick="document.getElementById('info').classList.toggle('hidden')">
ℹ Strateji
</button>

<div
id="status"
class="note">

Sistem başlatılıyor...

</div>

</div>


<div
id="info"
class="panel hidden">

<h2>
🧠 Sonny V5.4 Nasıl Karar Veriyor?
</h2>

<div class="desc">

<b>4H:</b>
Ana destek/direnç ve gerçek mum kapanışıyla kırılım.

<br><br>

<b>2H:</b>
Kırılımı aynı yönde doğrular.

<br><br>

<b>Retest:</b>
Fiyat kırılan seviyeye geri gelir.

<br><br>

<b>15M RSI:</b>
Giriş zamanını filtreler.

<br><br>

<b>Sonuç:</b>
COIN → LONG/SHORT → GİRİŞ → STOP → TP.

<br><br>

<b>Performans:</b>
Sinyalden sonra fiyat girişe değerse ENTRY HIT;
TP1/TP2/TP3 veya STOP gerçekleşirse sonuç kaydedilir.
Giriş bölgesi kaçarsa MISSED olarak ayrılır.

</div>

</div>


<div class="note">

Sonny AI Signal Scanner V5.4 ·
Bitget Futures ·
Manual Signal Only

</div>

</div>


<script>

const fp=x=>{

  x=+x;

  if(
    !Number.isFinite(x)
  ){

    return "-";

  }

  return(
    x>=100
      ?x.toFixed(2)
      :x>=1
        ?x.toFixed(4)
        :x>=.01
          ?x.toFixed(6)
          :x.toFixed(8)
  );

};


function tv(s){

  window.open(
    "https://www.tradingview.com/chart/?symbol=BITGET:"+
    encodeURIComponent(s),
    "_blank"
  );

}


function renderSignals(a){

  const b=
    document.getElementById(
      "signals"
    );

  if(
    !a?.length
  ){

    b.innerHTML=
      '<div class="desc">Şu anda aktif sinyal yok.</div>';

    return;

  }

  b.innerHTML=
    a
      .map(
        x=>`

        <div class="card">

          <div class="top">

            <div
              class="coin ${
                x.direction==="LONG"
                  ?"long"
                  :"short"
              }"
              onclick="tv('${x.symbol}')">

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


          <div class="price">

            Anlık fiyat:
            ${fp(x.price)}

            · RSI:
            <b>
              ${x.rsi}
            </b>

          </div>


          <div class="plans">

            <div class="plan">

              <div class="pl">
                GİRİŞ
              </div>

              <div class="pv">
                ${fp(x.entryLow)}
                -
                ${fp(x.entryHigh)}
              </div>

            </div>


            <div class="plan">

              <div class="pl">
                STOP
              </div>

              <div class="pv">
                ${fp(x.stop)}
              </div>

            </div>


            <div class="plan">

              <div class="pl">
                TP1
              </div>

              <div class="pv">
                ${fp(x.tp1)}
              </div>

            </div>


            <div class="plan">

              <div class="pl">
                TP2
              </div>

              <div class="pv">
                ${fp(x.tp2)}
              </div>

            </div>


            <div class="plan">

              <div class="pl">
                TP3
              </div>

              <div class="pv">
                ${fp(x.tp3)}
              </div>

            </div>

          </div>


          <div class="reason">

            <b>Neden?</b>

            ${x.reason}

          </div>


          <a
            class="tv"
            href="${x.tradingView}"
            target="_blank">

            📊 TRADINGVIEW'DE AÇ

          </a>

        </div>

      `
      )
      .join("");

}


function renderMissed(a){

  const p=
    document.getElementById(
      "missedPanel"
    );

  const b=
    document.getElementById(
      "missed"
    );

  if(
    !a?.length
  ){

    p.classList.add(
      "hidden"
    );

    return;

  }

  p.classList.remove(
    "hidden"
  );

  b.innerHTML=
    a
      .map(
        x=>`

        <div class="missed">

          <div class="missed-title">

            ${x.symbol}
            ·
            ${x.direction}

          </div>

          <div class="small">

            Son fiyat:
            <b>
              ${fp(x.price)}
            </b>

            · Giriş:
            ${fp(x.entryLow)}
            -
            ${fp(x.entryHigh)}

          </div>

          <div class="small">

            ⚠️
            ${
              x.missedReason||
              x.lifecycleReason||
              "Fırsat kaçtı."
            }

          </div>

          <a
            class="tv"
            href="${x.tradingView}"
            target="_blank">

            📊 GRAFİĞİ AÇ

          </a>

        </div>

      `
      )
      .join("");

}


function renderPrep(a){

  const b=
    document.getElementById(
      "preparing"
    );

  if(
    !a?.length
  ){

    b.innerHTML=
      '<div class="desc">Şu anda hazırlanan güçlü fırsat yok.</div>';

    return;

  }

  b.innerHTML=
    a
      .map(
        x=>`

        <div class="prep">

          <div>

            <b
              class="${
                x.direction==="LONG"
                  ?"long"
                  :"short"
              }"
              onclick="tv('${x.symbol}')">

              ${x.symbol}
              ·
              ${x.direction}

            </b>

            <div class="small">

              Anlık:
              ${fp(x.price)}

              · RSI:
              ${x.rsi}

            </div>

          </div>


          <div
            style="text-align:right">

            <b>

              Tetik:
              ${fp(x.trigger)}

            </b>

            <div class="small">

              ${x.distance}%
              uzakta

            </div>

          </div>

        </div>

      `
      )
      .join("");

}


function renderPerf(p){

  if(!p)
    return;

  const set=
    (
      id,
      v,
      cl
    )=>{

      const e=
        document.getElementById(
          id
        );

      if(e){

        e.innerText=v;

        if(cl){

          e.className=
            "perfval "+cl;

        }

      }

    };


  set(
    "wr",
    p.sample
      ?p.tp1SuccessRate+"%"
      :"-%",

    p.tp1SuccessRate>=60
      ?"good"
      :p.tp1SuccessRate>=45
        ?"neutral"
        :"bad"
  );


  set(
    "ps",
    p.sample
  );


  set(
    "ar",
    p.averageR+"R",

    p.averageR>0
      ?"good"
      :p.averageR<0
        ?"bad"
        :"neutral"
  );


  set(
    "tr",
    p.totalR+"R",

    p.totalR>0
      ?"good"
      :p.totalR<0
        ?"bad"
        :"neutral"
  );


  set(
    "pw",
    p.wins
  );

  set(
    "pst",
    p.stops
  );

  set(
    "pm",
    p.missed
  );

  set(
    "po",
    p.open
  );


  document.getElementById(
    "pn"
  ).innerText=

    p.sample<10

      ?`Şu anda ${p.sample} sonuçlanmış işlem var. En az 30-50 işlem oluşunca oran daha anlamlı olur.`

      :`Son 50 sonuçta TP1 başarı: ${p.tp1SuccessRate}% · En iyi kazanç serisi: ${p.bestWinStreak} · En uzun kayıp serisi: ${p.worstLossStreak}.`;


  const r=
    document.getElementById(
      "recent"
    );

  r.innerHTML=
    p.last50?.length

      ?`

        <div class="note">
          Son ölçülen sinyaller
        </div>

        <table class="ptable">

          <tr>
            <th>Coin</th>
            <th>Yön</th>
            <th>Durum</th>
            <th>R</th>
          </tr>

          ${
            p.last50
              .slice(0,10)
              .map(
                x=>`

                  <tr>

                    <td>
                      <b>
                        ${x.symbol}
                      </b>
                    </td>

                    <td>
                      ${x.direction}
                    </td>

                    <td>
                      ${
                        x.outcome||
                        x.status
                      }
                    </td>

                    <td>
                      ${
                        x.rMultiple??
                        "-"
                      }${
                        x.rMultiple!=null
                          ?"R"
                          :""
                      }
                    </td>

                  </tr>

                `
              )
              .join("")
          }

        </table>

      `

      :"";

}


function update(d){

  if(!d)
    return;


  document.getElementById(
    "md"
  ).innerText=
    d.market?.label||
    "YÜKLENİYOR";


  document.getElementById(
    "mr"
  ).innerText=
    d.market?.reason||
    "";


  document.getElementById(
    "md"
  ).className=
    "market-dir "+
    (
      d.market?.direction==="LONG"
        ?"long"
        :d.market?.direction==="SHORT"
          ?"short"
          :"neutral"
    );


  document.getElementById(
    "mc"
  ).innerText=
    d.stats?.market??"-";


  document.getElementById(
    "an"
  ).innerText=
    d.stats?.analyzed??"-";


  document.getElementById(
    "sc"
  ).innerText=
    d.stats?.signals??0;


  document.getElementById(
    "ls"
  ).innerText=
    d.timestamp
      ?new Date(
        d.timestamp
      ).toLocaleTimeString(
        "tr-TR"
      )
      :"-";


  renderSignals(
    d.signals
  );

  renderMissed(
    d.missed
  );

  renderPrep(
    d.preparing
  );

  renderPerf(
    d.performance
  );

}


async function load(){

  try{

    const r=
      await fetch(
        "/api/result?_="+Date.now(),
        {
          cache:"no-store"
        }
      );

    const d=
      await r.json();

    if(
      d.result
    ){

      update(
        d.result
      );

      document.getElementById(
        "status"
      ).innerText=
        d.scanning
          ?"Tarama sürüyor..."
          :"Sistem aktif. Her dakika yeni fırsat aranıyor.";

    }else{

      document.getElementById(
        "status"
      ).innerText=
        d.message||
        "İlk tarama bekleniyor...";

    }

  }catch(e){

    document.getElementById(
      "status"
    ).innerText=
      "Bağlantı hatası: "+
      e.message;

  }

}


load();

setInterval(
  load,
  10000
);

</script>

</body>

</html>`;


/*
=========================================================
ROUTES
=========================================================
*/

app.get(
  "/",
  (q,r)=>{

    r.setHeader(
      "Cache-Control",
      "no-store"
    );

    r.type(
      "html"
    ).send(
      HTML
    );

  }
);


app.get(
  "/health",
  (q,r)=>
    r.json({

      success:
        true,

      status:
        "healthy",

      system:
        SYSTEM,

      strategy:
        "4H / 2H BREAKOUT + RETEST + RSI",

      performance:
        perfSummary(),

      uptime:
        process.uptime()

    })
);


app.get(
  "/api/status",
  (q,r)=>
    r.json({

      success:
        true,

      status:
        running
          ?"SCANNING"
          :"ONLINE",

      strategy:
        "4H / 2H BREAKOUT + RETEST + RSI",

      refresh:
        "60 SECONDS",

      lastScan,

      discoveryTime,

      market:
        market.length,

      error:
        lastError,

      performance:
        perfSummary()

    })
);


app.get(
  "/api/scan",
  async(q,r)=>
    r.json(
      await runRadar()
    )
);


app.get(
  "/api/performance",
  (q,r)=>
    r.json({

      success:
        true,

      performance:
        perfSummary()

    })
);


app.get(
  "/api/result",
  async(q,r)=>{

    r.setHeader(
      "Cache-Control",
      "no-store"
    );

    try{

      if(
        !cached &&
        !running
      ){

        await runRadar();

      }

      if(!cached){

        return r.json({

          success:
            true,

          scanning:
            true,

          result:
            null,

          message:
            "İlk tarama devam ediyor..."

        });

      }


      /*
      CANLI FİYAT
      */

      try{

        const ts=
          await bitget(
            "/api/v2/mix/market/tickers",
            {
              productType:
                PRODUCT
            }
          );

        const pm=
          new Map(
            ts.map(
              x=>[
                x.symbol,
                +x.lastPr
              ]
            )
          );


        /*
        Aktif sinyallerin
        yaşam döngüsünü canlı fiyatla kontrol et.
        */

        sync(
          [],
          pm
        );


        cached.signals=
          [
            ...active.values()
          ]
            .sort(
              (a,b)=>
                b.score-
                a.score
            )
            .slice(
              0,
              C.MAX_SIG
            );


        cached.missed=
          missed.slice(
            0,
            C.MAX_MISSED
          );


        cached.performance=
          perfSummary();


        cached.stats.signals=
          cached.signals.length;


        cached.signals=
          cached.signals.map(
            x=>({

              ...x,

              price:
                rnd(
                  pm.get(
                    x.symbol
                  )??x.price,
                  8
                )

            })
          );

      }catch(e){

        log(
          `Live price refresh skipped: ${e.message}`
        );

      }


      r.json({

        success:
          true,

        scanning:
          running,

        result:
          cached

      });

    }catch(e){

      lastError=
        e.message;

      r.status(
        500
      ).json({

        success:
          false,

        error:
          e.message,

        result:
          cached

      });

    }

  }
);


app.use(
  (q,r)=>
    r.status(
      404
    ).json({

      success:
        false,

      error:
        "Endpoint not found"

    })
);


/*
=========================================================
SERVER
=========================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  ()=>{

    log(
      `${SYSTEM} started`
    );

    log(
      "Data source: BITGET"
    );

    log(
      "Strategy: 4H / 2H BREAKOUT + RETEST + RSI"
    );

    log(
      "Refresh: Every 60 seconds"
    );

    log(
      "Performance: LIVE FORWARD TEST"
    );

    log(
      `Server listening on port ${PORT}`
    );


    /*
    Eski performans kayıtlarını yükle.
    */

    loadPerf();


    /*
    İlk tarama.
    */

    setTimeout(
      runRadar,
      3000
    );


    /*
    Her dakika tamamen
    yeni piyasa taraması.
    */

    setInterval(
      runRadar,
      C.REFRESH
    );

  }
);
