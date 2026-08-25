import React, { useState, useEffect, useRef, useCallback } from 'react';
import './ArbitrageDashboard.css';

/* ═══ TYPES ═══ */
type DashMode = 'personal' | 'union';
type ConnType = 'api' | 'ssh';

interface SpreadItem {
  pair: string; from_ex: string; to_ex: string;
  spread_pct: number; volume_24h: number; status: 'active'|'closing'|'watching';
}
interface AgentSignal {
  name: string; status: 'online'|'alert'|'offline';
  last_signal: string; confidence: number;
}
interface ExBalance { exchange: string; balance_usd: number; allocated_pct: number; }
interface RiskMetric { label: string; value: number; max: number; unit: string; }
interface TradeLog { id: string; pair: string; spread: number; profit: number; time: string; }

/* ═══ ANIMATED NUMBER ═══ */
const AnimNum: React.FC<{value:number;prefix?:string;decimals?:number;cls?:string}> =
  ({value,prefix='',decimals=2,cls=''}) => {
  const [display, setDisplay] = useState(value);
  const ref = useRef(value);
  useEffect(() => {
    const s=ref.current, e=value, dur=800; let t0:number;
    const step=(ts:number)=>{
      if(!t0)t0=ts; const p=Math.min((ts-t0)/dur,1);
      const ease=1-Math.pow(1-p,3);
      setDisplay(s+(e-s)*ease);
      if(p<1)requestAnimationFrame(step); else ref.current=e;
    };
    requestAnimationFrame(step);
  }, [value]);
  return <span className={`anim-num ${cls}`}>{prefix}{display.toFixed(decimals)}</span>;
};

/* ═══ PULSE ═══ */
const Pulse:React.FC<{color:string}> = ({color}) => (
  <span className="pulse-wrap">
    <span className="pulse-dot" style={{background:color}}/>
    <span className="pulse-ring" style={{borderColor:color}}/>
  </span>
);

/* ═══ GAUGE ═══ */
const Gauge:React.FC<{value:number;max:number;label:string;unit:string}> =
  ({value,max,label,unit}) => {
  const pct=Math.min(value/max,1);
  const r=38,c=2*Math.PI*r, off=c*(1-pct);
  const col=pct<0.5?'#c8a44e':pct<0.8?'#d4442a':'#ff1744';
  return (
    <div className="gauge">
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#1a1a1a" strokeWidth="6"/>
        <circle cx="50" cy="50" r={r} fill="none" stroke={col} strokeWidth="6"
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
          className="gauge-arc" transform="rotate(-90 50 50)"/>
      </svg>
      <div className="gauge-text">
        <span className="gauge-val">{value.toFixed(1)}{unit}</span>
        <span className="gauge-label">{label}</span>
      </div>
    </div>
  );
};

/* ═══ SPARKLINE ═══ */
const Sparkline:React.FC<{data:number[];w?:number;h?:number}> = ({data,w=200,h=40}) => {
  const mn=Math.min(...data),mx=Math.max(...data);
  const pts=data.map((v,i)=>
    `${(i/(data.length-1))*w},${h-((v-mn)/(mx-mn||1))*h}`
  ).join(' ');
  return (
    <svg width={w} height={h} className="sparkline">
      <defs><linearGradient id="spk" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#d4442a"/><stop offset="100%" stopColor="#c8a44e"/>
      </linearGradient></defs>
      <polyline points={pts} fill="none" stroke="url(#spk)" strokeWidth="2"/>
    </svg>
  );
};

/* ═══ MODE SWITCHER ═══ */
const ModeSwitcher:React.FC<{mode:DashMode;onChange:(m:DashMode)=>void}> = ({mode,onChange}) => (
  <div className="mode-switch">
    <button className={`mode-btn ${mode==='personal'?'active':''}`}
      onClick={()=>onChange('personal')}>
      <span className="mode-icon">◇</span> PERSONAL
    </button>
    <button className={`mode-btn ${mode==='union'?'active':''}`}
      onClick={()=>onChange('union')}>
      <span className="mode-icon">◆</span> UNION FUND
    </button>
  </div>
);

/* ════════════════════════════════════════════════
   MAIN DASHBOARD
   ════════════════════════════════════════════════ */
const ArbitrageDashboard: React.FC = () => {
  const API = import.meta.env.VITE_API_URL || 'http://localhost:8001';

  /* ── mode ── */
  const [mode, setMode] = useState<DashMode>('union');
  const [connType, setConnType] = useState<ConnType>('api');

  /* ── data state ── */
  const [spreads, setSpreads] = useState<SpreadItem[]>([]);
  const [agents, setAgents] = useState<AgentSignal[]>([]);
  const [balances, setBalances] = useState<ExBalance[]>([]);
  const [risks, setRisks] = useState<RiskMetric[]>([]);
  const [logs, setLogs] = useState<TradeLog[]>([]);
  const [pnl, setPnl] = useState(0);
  const [pnlHistory, setPnlHistory] = useState<number[]>([]);
  const [exchanges, setExchanges] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState(false);
  const [engineRunning, setEngineRunning] = useState(false);

  /* ── order form ── */
  const [orderPair, setOrderPair] = useState('');
  const [orderAmount, setOrderAmount] = useState('');
  const [orderFromEx, setOrderFromEx] = useState('');
  const [orderToEx, setOrderToEx] = useState('');
  const [executing, setExecuting] = useState(false);

  /* ── clock ── */
  const [clock, setClock] = useState(new Date());
  useEffect(()=>{const iv=setInterval(()=>setClock(new Date()),1000);return()=>clearInterval(iv);},[]);

  /* ── fetch data ── */
  const fetchData = useCallback(async () => {
    try {
      const base = `${API}/arbitrage`;
      const modeParam = `?mode=${mode}`;
      const [sp,ag,bl,rk,lg,pnlR,exR,engR] = await Promise.all([
        fetch(`${base}/spreads${modeParam}`).then(r=>r.json()).catch(()=>null),
        fetch(`${base}/agents${modeParam}`).then(r=>r.json()).catch(()=>null),
        fetch(`${base}/balances${modeParam}`).then(r=>r.json()).catch(()=>null),
        fetch(`${base}/risks${modeParam}`).then(r=>r.json()).catch(()=>null),
        fetch(`${base}/trades/recent${modeParam}`).then(r=>r.json()).catch(()=>null),
        fetch(`${base}/pnl${modeParam}`).then(r=>r.json()).catch(()=>null),
        fetch(`${API}/exchanges/list`).then(r=>r.json()).catch(()=>null),
        fetch(`${base}/engine`).then(r=>r.json()).catch(()=>null),
      ]);
      setApiError(!sp && !ag);
      setEngineRunning(engR?.engine_running ?? false);
      if(sp?.items) setSpreads(sp.items);
      if(ag?.agents) setAgents(ag.agents);
      if(bl?.balances) setBalances(bl.balances);
      if(rk?.metrics) setRisks(rk.metrics);
      if(lg?.trades) setLogs(lg.trades);
      if(pnlR) { setPnl(pnlR.total||0); setPnlHistory(pnlR.history||[]); }
      if(exR?.exchanges) setExchanges(exR.exchanges.map((e:any)=>e.name||e));
    } catch(e) { console.error('Fetch error:', e); setApiError(true); }
    finally { setLoading(false); }
  }, [API, mode]);

  useEffect(()=>{ fetchData(); const iv=setInterval(fetchData,5000); return()=>clearInterval(iv); },[fetchData]);

  /* ── execute order ── */
  const executeOrder = async () => {
    if(!orderPair||!orderAmount||!orderFromEx||!orderToEx||executing) return;
    setExecuting(true);
    try {
      const resp = await fetch(`${API}/arbitrage/execute`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          pair:orderPair, amount:parseFloat(orderAmount),
          from_exchange:orderFromEx, to_exchange:orderToEx,
          mode, connection_type:connType
        })
      });
      if(resp.ok) { setOrderPair(''); setOrderAmount(''); setOrderFromEx(''); setOrderToEx(''); }
    } catch(e) { console.error('Execute error:', e); }
    finally { setExecuting(false); }
  };

  const stColor=(s:string)=>s==='online'||s==='active'?'#00e676':s==='alert'||s==='watching'?'#ffd740':'#ff1744';

  const EmptyState:React.FC<{text:string}> = ({text}) => (
    <div style={{color:'#555',fontSize:'.8rem',padding:'12px 0',textAlign:'center',letterSpacing:'1px'}}>{text}</div>
  );

  return (
    <div className="arb-root">
      {/* ══ HEADER ══ */}
      <header className="arb-header">
        <div className="arb-logo">
          <span className="arb-diamond">◆</span>
          <h1>NEYTIS <span className="gold">ARBITRAGE</span></h1>
        </div>
        <ModeSwitcher mode={mode} onChange={setMode}/>
        <div className="arb-header-right">
          {mode==='personal' && (
            <div className="conn-switch">
              <button className={`conn-btn ${connType==='api'?'active':''}`}
                onClick={()=>setConnType('api')}>API</button>
              <button className={`conn-btn ${connType==='ssh'?'active':''}`}
                onClick={()=>setConnType('ssh')}>SSH/VIP</button>
            </div>
          )}
          <span className="arb-clock">{clock.toLocaleTimeString('ru-RU')}</span>
          <Pulse color="#00e676"/>
          <span className="arb-live">LIVE</span>
        </div>
      </header>

      {/* ── mode indicator ── */}
      <div className="mode-indicator">
        {mode==='personal'
          ? <>◇ Индивидуальный режим — ваши биржи, ваши ключи ({connType==='ssh'?'SSH/VIP':'API'})</>
          : <>◆ Фонд Союза — доверительное управление Нейтис (60% участнику / 40% проекты Союза)</>
        }
      </div>
      <div className="arb-sep"/>

      {/* ══ GRID ══ */}
      <div className="arb-grid">

        {/* ─── SPREAD MONITOR ─── */}
        <section className="arb-card card-spread">
          <h2 className="card-title"><span className="red-icon">◈</span> SPREAD MONITOR</h2>
          {apiError ? <EmptyState text="NO DATA — API UNREACHABLE"/> : spreads.length === 0
            ? <EmptyState text={engineRunning ? "Scanning..." : "ENGINE OFFLINE — no spreads"}/>
            : <div className="spread-list">
                {spreads.map((s,i)=>(
                  <div key={i} className={`spread-row ${s.status}`}>
                    <Pulse color={stColor(s.status)}/>
                    <span className="spread-pair">{s.pair}</span>
                    <span className="spread-route">{s.from_ex} → {s.to_ex}</span>
                    <span className={`spread-val ${s.spread_pct>0.3?'hot':''}`}>
                      {s.spread_pct.toFixed(2)}%
                    </span>
                    <span className="spread-vol">{s.volume_24h ? `$${(s.volume_24h/1000).toFixed(0)}K` : '—'}</span>
                  </div>
                ))}
              </div>
          }
        </section>

        {/* ─── LIVE P&L ─── */}
        <section className="arb-card card-pnl">
          <h2 className="card-title">
            <span className="red-icon">◈</span>
            {mode==='union' ? 'UNION FUND P&L' : 'PERSONAL P&L'}
          </h2>
          <div className="pnl-main">
            <AnimNum value={pnl} prefix="+$" decimals={2} cls="pnl-number"/>
          </div>
          {mode==='union' && pnl > 0 && (
            <div className="pnl-split">
              <span className="split-item">
                Участнику 60%: <span className="green">+${(pnl*0.6).toFixed(0)}</span>
              </span>
              <span className="split-item">
                Союз 40%: <span className="gold">+${(pnl*0.4).toFixed(0)}</span>
              </span>
            </div>
          )}
          <div className="pnl-sub">
            <span>Trades: <span className="white">{logs.length}</span></span>
          </div>
          {pnlHistory.length >= 2 && <Sparkline data={pnlHistory} w={280} h={50}/>}
        </section>

        {/* ─── AGENT SIGNALS ─── */}
        <section className="arb-card card-agents">
          <h2 className="card-title"><span className="red-icon">◈</span> AGENT SIGNALS</h2>
          {agents.length === 0
            ? <EmptyState text={engineRunning ? "No active agents" : "ENGINE OFFLINE — no agents"}/>
            : agents.map((a,i)=>(
              <div key={i} className="agent-row">
                <Pulse color={stColor(a.status)}/>
                <span className="agent-name">{a.name}</span>
                <span className="agent-signal">{a.last_signal}</span>
                <span className="agent-conf" style={{color:a.confidence>85?'#c8a44e':'#d4442a'}}>
                  {a.confidence}%
                </span>
              </div>
            ))
          }
        </section>

        {/* ─── ORDER ENTRY (personal only) ─── */}
        {mode==='personal' && (
          <section className="arb-card card-order">
            <h2 className="card-title"><span className="red-icon">◈</span> ORDER ENTRY</h2>
            <div className="order-form">
              <div className="input-group">
                <label>Pair</label>
                <input type="text" value={orderPair} onChange={e=>setOrderPair(e.target.value)}
                  placeholder="BTC/USDT" className="gold-input"/>
              </div>
              <div className="input-row">
                <div className="input-group half">
                  <label>Buy on</label>
                  <select value={orderFromEx} onChange={e=>setOrderFromEx(e.target.value)}
                    className="gold-input">
                    <option value="">Биржа...</option>
                    {exchanges.map(ex=><option key={ex} value={ex}>{ex}</option>)}
                  </select>
                </div>
                <div className="input-group half">
                  <label>Sell on</label>
                  <select value={orderToEx} onChange={e=>setOrderToEx(e.target.value)}
                    className="gold-input">
                    <option value="">Биржа...</option>
                    {exchanges.map(ex=><option key={ex} value={ex}>{ex}</option>)}
                  </select>
                </div>
              </div>
              <div className="input-group">
                <label>Amount (USDT)</label>
                <input type="text" value={orderAmount} onChange={e=>setOrderAmount(e.target.value)}
                  placeholder="10,000" className="gold-input"/>
              </div>
              <div className="conn-badge">
                {connType==='ssh' ? '🔐 SSH Tunnel (VIP)' : '🔑 API Keys'}
              </div>
              <button className="btn-execute" onClick={executeOrder} disabled={executing}
                style={{opacity:executing?0.6:1,cursor:executing?'not-allowed':'pointer'}}>
                <span className="btn-glow"/>{executing ? 'EXECUTING...' : 'EXECUTE (SIMULATION)'}
              </button>
            </div>
          </section>
        )}

        {/* ─── UNION INFO (union mode) ─── */}
        {mode==='union' && (
          <section className="arb-card card-union-info">
            <h2 className="card-title"><span className="red-icon">◈</span> UNION FUND STATUS</h2>
            <div className="union-stats">
              <div className="union-stat">
                <span className="union-stat-label">Общий фонд</span>
                <AnimNum value={balances.reduce((s,b)=>s+b.balance_usd,0)} prefix="$" decimals={0} cls="union-stat-val gold"/>
              </div>
              <div className="union-stat">
                <span className="union-stat-label">Режим</span>
                <span className="union-stat-val white">60/40 участнику/союзу</span>
              </div>
            </div>
            <div className="union-note">
              Нейтис управляет фондом автоматически. Выбор стратегии — в кабинете Союза.
            </div>
          </section>
        )}

        {/* ─── EXCHANGE BALANCES ─── */}
        <section className="arb-card card-balances">
          <h2 className="card-title">
            <span className="red-icon">◈</span>
            {mode==='union' ? 'FUND ALLOCATION' : 'EXCHANGE BALANCES'}
          </h2>
          {balances.length === 0
            ? <EmptyState text={apiError ? "NO DATA — API UNREACHABLE" : "No connected exchanges"}/>
            : <>
              <div className="balance-total">
                Total: <AnimNum value={balances.reduce((s,b)=>s+b.balance_usd,0)} prefix="$" decimals={0} cls="gold"/>
              </div>
              {balances.map((b,i)=>(
                <div key={i} className="balance-row">
                  <span className="bal-name">{b.exchange}</span>
                  <div className="bal-bar-wrap">
                    <div className="bal-bar" style={{width:`${b.allocated_pct}%`}}>
                      <div className="bal-bar-glow"/>
                    </div>
                  </div>
                  <span className="bal-val">${b.balance_usd.toLocaleString()}</span>
                </div>
              ))}
            </>
          }
        </section>

        {/* ─── RISK METRICS ─── */}
        <section className="arb-card card-risk">
          <h2 className="card-title"><span className="red-icon">◈</span> RISK METRICS</h2>
          {risks.length === 0
            ? <EmptyState text={engineRunning ? "No risk data" : "ENGINE OFFLINE — no metrics"}/>
            : <div className="gauges-row">
                {risks.map((r,i)=><Gauge key={i} {...r}/>)}
              </div>
          }
        </section>

        {/* ─── TRADE LOG ─── */}
        <section className="arb-card card-log">
          <h2 className="card-title"><span className="red-icon">◈</span> TRADE LOG</h2>
          <div className="log-header">
            <span>ID</span><span>Pair</span><span>Spread</span><span>Profit</span><span>Time</span>
          </div>
          {logs.length === 0
            ? <EmptyState text="No trades yet"/>
            : logs.map((l,i)=>(
              <div key={i} className="log-row">
                <span className="log-id">{l.id}</span>
                <span>{l.pair}</span>
                <span className="gold">{l.spread.toFixed(2)}%</span>
                <span className={l.profit>=0?'green':'white'}>{l.profit>=0?'+':''}${Math.abs(l.profit).toFixed(1)}</span>
                <span className="log-time">{l.time}</span>
              </div>
            ))
          }
        </section>

      </div>
    </div>
  );
};

export default ArbitrageDashboard;
