// Theme
function toggleTheme(){
  document.documentElement.classList.toggle('light');
  localStorage.setItem('pf-theme',document.documentElement.classList.contains('light')?'light':'dark');
}
if(localStorage.getItem('pf-theme')==='light') document.documentElement.classList.add('light');

const SERVER='';
let portfolio={},prices={},editingId=null,openSyms=new Set(),historyData=[];
let chartTotal=0; // cached for chartHoverReset
let valuesHidden=false;

function toggleValuesMask(){
  valuesHidden=!valuesHidden;
  const btn=document.getElementById('maskBtn');
  if(btn) btn.classList.toggle('active',valuesHidden);
  render();
}

// ── Shared constants ─────────────────────────────────────────────────────────
const BADGE_COLORS=['#4da3ff','#00d26a','#ff4757','#ffb300','#a855f7','#06b6d4','#f97316','#ec4899'];
const WARN_ICON_SVG=`<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

// ── Shared helpers ───────────────────────────────────────────────────────────
const today=()=>new Date().toISOString().split('T')[0];
const getActiveSyms=()=>Object.keys(portfolio).filter(s=>portfolio[s]?.length>0);

function symStats(sym){
  const ps=portfolio[sym];
  const totalQty=ps.reduce((s,p)=>s+p.qty,0);
  const totalCost=ps.reduce((s,p)=>s+p.qty*p.price,0);
  return{totalQty,totalCost,avgPrice:totalQty>0?totalCost/totalQty:0};
}

function buildBadgeHtml(sym,bgColor,topLevel,symAlerts){
  if(!topLevel) return`<div class="sym-badge" style="background:linear-gradient(135deg,${bgColor},${bgColor}cc)">${sym.slice(0,3)}</div>`;
  const ttHtml=symAlerts.map(a=>`
    <div class="tt-item">
      <div class="tt-dot ${a.level}"></div>
      <div><div class="tt-title">${a.title}</div><div class="tt-desc">${a.desc}</div></div>
    </div>`).join('');
  return`<div class="badge-wrap">
    <div class="sym-badge" style="background:linear-gradient(135deg,${bgColor},${bgColor}cc)">${sym.slice(0,3)}</div>
    <div class="warn-dot ${topLevel}"
      onclick="event.stopPropagation()"
      onmouseenter="showTooltip(event,'tt-${sym}')"
      onmouseleave="hideTooltip('tt-${sym}')">${WARN_ICON_SVG}</div>
    <div class="warn-tooltip" id="tt-${sym}">${ttHtml}</div>
  </div>`;
}

// ── Sell Modal ───────────────────────────────────────────────────────────────
function toggleSellForm(sym){
  const m=document.getElementById('sellModal');
  if(sym){
    document.getElementById('sSym').value=sym;
    document.getElementById('sDate').value=today();
    document.getElementById('sQty').value='';
    document.getElementById('sPrice').value='';
    document.getElementById('sellPreview').textContent='';
    document.getElementById('smSymName').textContent=sym;

    const{totalQty,avgPrice}=symStats(sym);
    const cur=prices[sym]?.price;
    document.getElementById('smSymLabel').textContent=`${totalQty.toLocaleString('vi-VN')} CP đang nắm · Giá vốn ${fp(avgPrice)}`;

    const bar=document.getElementById('smPriceBar');
    if(cur){
      const diff=cur-avgPrice;
      const pct=avgPrice>0?(diff/avgPrice*100):0;
      const c=pColor(diff);
      bar.innerHTML=`<span style="font-size:22px;font-weight:800;color:var(--t1);font-family:'IBM Plex Mono',monospace">${fp(cur)}</span><span style="font-size:12px;color:${c};margin-left:10px;font-weight:700">${pSign(diff)}${pct.toFixed(2)}%</span><span style="font-size:11px;color:var(--t3);margin-left:auto">Giá hiện tại</span>`;
      document.getElementById('sPrice').value=cur;
    } else {
      bar.innerHTML=`<span style="font-size:12px;color:var(--t3)">Chưa có giá thị trường</span>`;
    }

    m.classList.add('open');
    setTimeout(()=>document.getElementById('sQty').focus(),50);
  } else {
    m.classList.remove('open');
  }
}

function showSellError(msg,highlightQty=false){
  const el=document.getElementById('sellPreview');
  el.innerHTML=`<span style="color:var(--dn);font-weight:600">⚠ ${msg}</span>`;
  if(highlightQty){
    const q=document.getElementById('sQty');
    q.style.borderColor='var(--dn)';q.style.color='var(--dn)';
  }
}

function clearSellError(){
  document.getElementById('sellPreview').innerHTML='';
  const q=document.getElementById('sQty');
  q.style.borderColor='';q.style.color='';
}

async function submitSell(){
  const sym=document.getElementById('sSym').value.trim().toUpperCase();
  const qty=parseInt(document.getElementById('sQty').value);
  const price=parseFloat(document.getElementById('sPrice').value);
  const date=document.getElementById('sDate').value;
  if(!sym||!qty||!price||!date){showSellError('Vui lòng điền đầy đủ thông tin',!qty);return;}
  const btn=document.getElementById('sellBtn');
  const btnOrig=btn.innerHTML;
  btn.disabled=true;btn.innerHTML='Đang bán...';
  clearSellError();
  try{
    const r=await fetch(SERVER+'/portfolio/sell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:sym,qty,price,date})});
    const j=await r.json();
    if(!r.ok||j.error){showSellError(j.error||'Không bán được',true);btn.disabled=false;btn.innerHTML=btnOrig;return;}
    toggleSellForm();
    showSellToast(sym,qty,price,j.entry?.pnl,j.entry?.pnlPct);
    await refreshPortfolio();
    await loadHistory();
  }catch(e){showSellError(e.message);}
  btn.disabled=false;btn.innerHTML=btnOrig;
}

function showSellToast(sym,qty,price,pnl,pnlPct){
  let t=document.getElementById('sellToast');
  if(!t){
    t=document.createElement('div');t.id='sellToast';
    t.style.cssText='position:fixed;bottom:60px;right:20px;padding:12px 18px;border-radius:12px;font-size:13px;font-weight:600;color:#fff;z-index:9999;transition:opacity .3s;pointer-events:none;max-width:280px;line-height:1.5';
    document.body.appendChild(t);
  }
  const sign=pnl>=0?'+':'';
  t.style.background=pnl>=0?'#2f9e44':'#e03131';
  t.innerHTML=`Đã bán <b>${qty} ${sym}</b> @ <b>${price}</b><br>Lãi/Lỗ: <b>${sign}${(pnl/1e3).toFixed(2)} tr (${sign}${pnlPct?.toFixed(1)}%)</b>`;
  t.style.opacity='1';clearTimeout(t._tm);t._tm=setTimeout(()=>{t.style.opacity='0'},4000);
}

// ── History Panel ────────────────────────────────────────────────────────────
async function loadHistory(){
  try{const r=await fetch(SERVER+'/portfolio/history');historyData=await r.json();}catch{historyData=[];}
}

function toggleHistoryPanel(){
  const p=document.getElementById('historyPanel');
  const c=document.getElementById('content');
  const showing=p.style.display!=='none';
  if(showing){p.style.display='none';if(c)c.style.display='';}
  else{p.style.display='block';if(c)c.style.display='none';renderHistory();}
}

function renderHistory(){
  const el=document.getElementById('historyContent');
  const filter=document.getElementById('historyFilter')?.value||'';
  const data=filter?historyData.filter(h=>h.symbol===filter):historyData;

  const sel=document.getElementById('historyFilter');
  if(sel){
    const syms=[...new Set(historyData.map(h=>h.symbol))].sort();
    sel.innerHTML='<option value="">Tất cả mã</option>'+syms.map(s=>`<option value="${s}"${s===filter?' selected':''}>${s}</option>`).join('');
  }

  if(!data.length){el.innerHTML=`<div style="text-align:center;padding:60px 20px;color:var(--t3);font-size:14px">Chưa có giao dịch bán nào${filter?' cho '+filter:''}</div>`;return;}

  // Single-pass stats
  const stats=data.reduce((a,h)=>({totalPnl:a.totalPnl+h.pnl,wins:a.wins+(h.pnl>0?1:0)}),{totalPnl:0,wins:0});
  const{totalPnl,wins}=stats;
  const winRate=data.length>0?(wins/data.length*100).toFixed(0):0;
  const pnlColor=totalPnl>=0?'var(--up)':'var(--dn)';
  const pnlSign=totalPnl>=0?'+':'';

  const rows=data.map(h=>{
    const pc=pColor(h.pnl);
    const ps=pSign(h.pnl);
    const bg=pBg(h.pnl);
    const bd=h.pnl>0?'var(--up-bd)':h.pnl<0?'var(--dn-bd)':'transparent';
    return`<div class="hist-row">
      <span style="font-family:'IBM Plex Mono',monospace;color:var(--t3)">${h.sellDate}</span>
      <span><a href="/detail.html?s=${h.symbol}" style="font-family:'Inter',sans-serif;font-weight:800;font-size:13px;color:var(--navy);text-decoration:none">${h.symbol}</a></span>
      <span style="text-align:right;font-family:'IBM Plex Mono',monospace;color:var(--t2)">${h.qty.toLocaleString('vi-VN')}</span>
      <span style="text-align:right;font-family:'IBM Plex Mono',monospace;color:var(--t3)">${h.buyPrice?.toFixed(2)??'—'}</span>
      <span style="text-align:right;font-family:'IBM Plex Mono',monospace;font-weight:700;color:var(--t1)">${h.sellPrice}</span>
      <span style="text-align:right">
        <span style="display:inline-flex;flex-direction:column;align-items:flex-end;padding:3px 8px;border-radius:6px;background:${bg};border:1px solid ${bd}">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;color:${pc}">${ps}${(h.pnl/1e3).toFixed(2)} tr</span>
          <span style="font-size:10px;color:${pc}">${ps}${h.pnlPct?.toFixed(1)}%</span>
        </span>
      </span>
    </div>`;
  }).join('');

  el.innerHTML=`<div class="hist-summary">
    <div style="padding:14px 18px;border-radius:12px;background:var(--card);border:1px solid var(--border)">
      <div style="font-size:10px;font-weight:700;color:var(--t3);letter-spacing:.6px;margin-bottom:6px">TỔNG LÃI/LỖ THỰC</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-weight:800;font-size:20px;color:${pnlColor}">${pnlSign}${(totalPnl/1e3).toFixed(2)} tr</div>
    </div>
    <div style="padding:14px 18px;border-radius:12px;background:var(--card);border:1px solid var(--border)">
      <div style="font-size:10px;font-weight:700;color:var(--t3);letter-spacing:.6px;margin-bottom:6px">SỐ LỆNH</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-weight:800;font-size:20px;color:var(--t1)">${data.length}</div>
    </div>
    <div style="padding:14px 18px;border-radius:12px;background:var(--card);border:1px solid var(--border)">
      <div style="font-size:10px;font-weight:700;color:var(--t3);letter-spacing:.6px;margin-bottom:6px">TỶ LỆ THẮNG</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-weight:800;font-size:20px;color:${winRate>=50?'var(--up)':'var(--dn)'}">${winRate}%</div>
      <div style="font-size:11px;color:var(--t3)">${wins}/${data.length} lệnh</div>
    </div>
  </div>
  <div class="hist-card">
    <div class="hist-header">
      <span>Ngày bán</span><span>Mã</span><span style="text-align:right">KL</span><span style="text-align:right">Giá vốn</span><span style="text-align:right">Giá bán</span><span style="text-align:right">Lãi / Lỗ</span>
    </div>${rows}</div>`;
}

function showTooltip(e,id){
  const tt=document.getElementById(id);
  if(!tt) return;
  if(tt.parentElement!==document.body) document.body.appendChild(tt);
  const r=e.currentTarget.getBoundingClientRect();
  const vw=window.innerWidth;
  const ttW=260;
  let left=r.left;
  if(left+ttW>vw-12) left=vw-ttW-12;
  if(left<8) left=8;
  tt.style.cssText=`top:${r.bottom+window.scrollY+6}px;left:${left}px;position:absolute`;
  tt.classList.add('visible');
}
function hideTooltip(id){
  document.getElementById(id)?.classList.remove('visible');
}

// ── Formatters ───────────────────────────────────────────────────────────────
const fp=v=>{if(v==null)return'—';return parseFloat(v).toLocaleString('vi-VN',{minimumFractionDigits:1,maximumFractionDigits:2})};
const fMoney=v=>{
  if(valuesHidden){
    const a=Math.abs(v);
    if(a>=1e6) return '*.** tỷ';
    if(a>=1e3) return '**.* tr';
    return '*** ng';
  }
  const a=Math.abs(v);
  if(a>=1e6) return (v/1e6).toFixed(2)+' tỷ';
  if(a>=1e3) return (v/1e3).toFixed(1)+' tr';
  return v.toFixed(0)+' ng';
};
const pColor=v=>v>0?'var(--up)':v<0?'var(--dn)':'var(--t3)';
const pSign=v=>v>0?'+':'';
const pBg=v=>v>0?'var(--up-bg)':v<0?'var(--dn-bg)':'transparent';

function toggleAddForm(){
  const f=document.getElementById('addForm');
  f.classList.toggle('open');
  if(f.classList.contains('open')){
    document.getElementById('fDate').value=today();
    document.getElementById('fSym').focus();
  }
}

async function fetchRealtimePrice(sym){
  try{
    const r=await fetch(SERVER+'/price?symbol='+sym);
    if(!r.ok) return null;
    const d=await r.json();
    if(d.price!=null) return{price:d.price,change:d.change,ref:d.ref};
  }catch(e){}
  return null;
}

async function fetchTechnical(sym){
  try{
    const r=await fetch(SERVER+'/analyze-detail?symbol='+sym);
    const d=await r.json();
    if(d.latestPrice!=null) return{
      trend:d.trend||null,indicators:d.indicators||null,
      supportResistance:d.supportResistance||null,
      volume:d.volume||null,predictions:d.predictions||null,
    };
  }catch(e){}
  return null;
}

async function init(){
  document.getElementById('loading').style.display='flex';
  document.getElementById('content').style.display='none';
  document.getElementById('empty').style.display='none';
  try{const r=await fetch(SERVER+'/portfolio');portfolio=await r.json();}catch(e){portfolio={};}
  loadHistory(); // fire-and-forget — history only needed when panel opens
  const syms=getActiveSyms();
  if(syms.length===0){
    document.getElementById('loading').style.display='none';
    document.getElementById('empty').style.display='';
    return;
  }

  const rtResults=await Promise.allSettled(syms.map(s=>fetchRealtimePrice(s)));
  rtResults.forEach((r,i)=>{
    if(r.status==='fulfilled'&&r.value) prices[syms[i]]={...prices[syms[i]]||{},...r.value};
  });
  document.getElementById('loading').style.display='none';
  document.getElementById('content').style.display='';
  render();

  const techResults=await Promise.allSettled(syms.map(s=>fetchTechnical(s)));
  techResults.forEach((r,i)=>{
    if(r.status==='fulfilled'&&r.value) prices[syms[i]]={...prices[syms[i]]||{},...r.value};
  });
  updateAlertBadges();
}

function render(){renderHero();renderTable();}

// Cập nhật chỉ badge warning — không redraw toàn bộ, tránh giật
function updateAlertBadges(){
  getActiveSyms().forEach(sym=>{
    const pd=prices[sym];
    if(!pd) return;
    const symAlerts=extractSignals(sym,pd);
    const topLevel=symAlerts.some(a=>a.level==='danger')?'danger':symAlerts.length?'warn':null;
    const bgColor=BADGE_COLORS[sym.charCodeAt(0)%BADGE_COLORS.length];
    // Use data-sym for O(1) lookup instead of scanning all rows by text
    const row=document.querySelector(`.tbl-row[data-sym="${sym}"]`);
    if(!row) return;
    const cell=row.querySelector('span:first-child');
    if(cell) cell.innerHTML=buildBadgeHtml(sym,bgColor,topLevel,symAlerts);
  });
}

function buildDonutPaths(data,total,cx,cy,r,inner){
  let startAngle=0,paths='',labels='';
  const midR=(r+inner)/2;
  data.forEach(d=>{
    const pct=d.val/total;
    const angle=pct*2*Math.PI;
    const endAngle=startAngle+angle;
    const gap=data.length>1?0.016:0;
    const sa=startAngle+gap,ea=endAngle-gap;
    const ox1=cx+r*Math.cos(sa),oy1=cy+r*Math.sin(sa);
    const ox2=cx+r*Math.cos(ea),oy2=cy+r*Math.sin(ea);
    const lrg=angle>Math.PI?1:0;
    const iox1=cx+inner*Math.cos(sa),ioy1=cy+inner*Math.sin(sa);
    const iox2=cx+inner*Math.cos(ea),ioy2=cy+inner*Math.sin(ea);
    paths+=`<path d="M${ox1},${oy1} A${r},${r} 0 ${lrg},1 ${ox2},${oy2} L${iox2},${ioy2} A${inner},${inner} 0 ${lrg},0 ${iox1},${ioy1} Z"
      fill="${d.color}" opacity="0.9"
      onmouseenter="chartHover('${d.sym}','${d.color}',${(pct*100).toFixed(1)},${d.val})"
      onmouseleave="chartHoverReset()"
      style="cursor:pointer;transition:all .15s"
      onmouseover="this.style.opacity=1;this.style.filter='brightness(1.15)'" onmouseout="this.style.opacity=0.9;this.style.filter=''"/>`;
    if(pct>=0.06){
      const midAngle=startAngle+angle/2;
      const lx=cx+midR*Math.cos(midAngle);
      const ly=cy+midR*Math.sin(midAngle);
      labels+=`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}"
        text-anchor="middle" dominant-baseline="middle"
        transform="rotate(90,${lx.toFixed(1)},${ly.toFixed(1)})"
        font-family='Inter,sans-serif' font-weight="800"
        font-size="${pct>=0.15?'11':pct>=0.09?'10':'9'}"
        fill="white" opacity="0.95" pointer-events="none"
        style="text-shadow:0 1px 3px rgba(0,0,0,.4)">${d.sym}</text>`;
    }
    startAngle=endAngle;
  });
  return paths+labels;
}

function extractSignals(sym,pd){
  const alerts=[];
  const{indicators:ind,trend,supportResistance:sr,price}=pd;
  if(!ind||!price) return alerts;

  if(trend?.alignment==='STRONG_DOWN'){
    alerts.push({level:'danger',key:'TREND_STRONG_DOWN',
      title:'3/3 khung đồng thuận GIẢM',
      desc:trend.alignmentDesc||'Tất cả khung thời gian đều cho tín hiệu giảm — cân nhắc cắt lỗ hoặc giảm tỷ trọng.',
      chips:['Xu hướng giảm mạnh']});
  }

  if(sr?.resistances){
    sr.resistances.forEach(r=>{
      const pct=((r.price-price)/price*100);
      if(pct>=0&&pct<3){
        alerts.push({level:'warn',key:'NEAR_RESISTANCE_'+r.price,
          title:`Đang tiến sát kháng cự ${fp(r.price)}`,
          desc:`Giá hiện tại ${fp(price)} cách kháng cự ${fp(r.price)} chỉ ${pct.toFixed(1)}% (vùng này đã test ${r.touches} lần). Cân nhắc chốt một phần.`,
          chips:[`Còn ${pct.toFixed(1)}% đến kháng cự`,`${r.touches} lần test`]});
      }
    });
  }

  if(ind.rsi!=null&&ind.rsi>75){
    alerts.push({level:'warn',key:'RSI_OB',
      title:`RSI quá mua (${ind.rsi.toFixed(1)})`,
      desc:`RSI ${ind.rsi.toFixed(1)} vượt ngưỡng 75 — vùng quá mua mạnh, xác suất điều chỉnh ngắn hạn tăng cao.`,
      chips:[`RSI ${ind.rsi.toFixed(1)}`,'Quá mua']});
  }

  if(ind.macd!=null&&ind.macdSignal!=null&&ind.macdHistogram!=null&&ind.macdHistogram<0&&ind.macd<ind.macdSignal){
    alerts.push({level:'warn',key:'MACD_BEAR',
      title:'MACD cắt xuống Signal',
      desc:`MACD (${ind.macd.toFixed(3)}) vừa cắt xuống dưới Signal (${ind.macdSignal.toFixed(3)}) — tín hiệu đà giảm đang hình thành.`,
      chips:['MACD ↓ Signal','Đà giảm']});
  }

  if(ind.bbUpper!=null&&price>ind.bbUpper*0.995){
    alerts.push({level:'warn',key:'BB_UPPER',
      title:'Giá chạm dải BB trên',
      desc:`Giá ${fp(price)} đang chạm/vượt Bollinger Band trên (${fp(ind.bbUpper)}) — thường báo hiệu mua quá mức ngắn hạn.`,
      chips:['BB Upper','Mua quá mức']});
  }

  return alerts;
}

function renderHero(){
  const syms=getActiveSyms();
  const PIE_COLORS=['#4da3ff','#00d26a','#ffb300','#a855f7','#06b6d4','#f97316','#ff4757','#ec4899','#14b8a6','#eab308'];

  // Single pass: compute totals, best/worst, and per-symbol values
  let totalCost=0,totalValue=0,totalQty=0;
  let bestSym='',bestPct=-Infinity,worstSym='',worstPct=Infinity;
  const symValues=syms.map((sym,i)=>{
    const cur=prices[sym]?.price;
    const ps=portfolio[sym];
    let cost=0,qty=0,val=0;
    ps.forEach(p=>{cost+=p.qty*p.price;qty+=p.qty;val+=p.qty*(cur||p.price);});
    totalCost+=cost;totalQty+=qty;totalValue+=val;
    if(cur&&qty>0){
      const avg=cost/qty;
      const pct=(cur-avg)/avg*100;
      if(pct>bestPct){bestPct=pct;bestSym=sym;}
      if(pct<worstPct){worstPct=pct;worstSym=sym;}
    }
    return{sym,val,color:PIE_COLORS[i%PIE_COLORS.length]};
  }).sort((a,b)=>b.val-a.val);

  const pnl=totalValue-totalCost;
  const pnlPct=totalCost>0?(pnl/totalCost*100):0;
  const c=pColor(pnl),s=pSign(pnl);

  chartTotal=symValues.reduce((acc,d)=>acc+d.val,0); // cache for chartHoverReset
  const donutPaths=chartTotal>0?buildDonutPaths(symValues,chartTotal,110,110,95,54):'';

  const legendItems=symValues.map(d=>{
    const pct=(d.val/chartTotal*100).toFixed(1);
    return`<div class="hero-legend-item" onmouseenter="chartHover('${d.sym}','${d.color}',${pct},${d.val})" onmouseleave="chartHoverReset()">
      <div class="hero-legend-dot" style="background:${d.color}"></div>
      <span class="hero-legend-sym">${d.sym}</span>
      <span class="hero-legend-pct">${pct}%</span>
      <span class="hero-legend-val">${fMoney(d.val)}</span>
    </div>`;
  }).join('');

  document.getElementById('heroSection').innerHTML=`
    <div class="hero">
      <div class="hero-body">
        <div class="hero-info">
          <div class="hero-top">
            <div>
              <div class="hero-label">Giá trị danh mục</div>
              <div class="hero-value">${fMoney(totalValue)}</div>
              <div class="hero-sub">
                <span>Vốn: ${fMoney(totalCost)}</span>
                <span style="color:var(--border)">|</span>
                <span>${syms.length} mã · ${totalQty.toLocaleString('vi-VN')} CP</span>
              </div>
            </div>
            <div class="hero-pnl">
              <div class="hero-label">Lãi / Lỗ</div>
              <div class="hero-pnl-val" style="color:${c}">${s}${fMoney(pnl)}</div>
              <div class="hero-pnl-pct" style="color:${c}">${s}${pnlPct.toFixed(2)}%</div>
            </div>
          </div>
          <div class="hero-legend">${legendItems}</div>
        </div>
        <div class="hero-donut">
          <svg viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg">${donutPaths}</svg>
          <div class="hero-donut-center" id="chartCenter">
            <div class="hero-donut-val">${syms.length} mã</div>
            <div class="hero-donut-lbl">${fMoney(chartTotal)}</div>
          </div>
        </div>
      </div>
      <div class="hero-stats">
        <div class="hero-stat">
          <div class="hero-stat-label">Tổng vốn đầu tư</div>
          <div class="hero-stat-val">${fMoney(totalCost)}</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-label">Mã tốt nhất</div>
          <div class="hero-stat-val" style="color:var(--up)">${bestSym?bestSym+' '+pSign(bestPct)+bestPct.toFixed(1)+'%':'—'}</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-label">Mã yếu nhất</div>
          <div class="hero-stat-val" style="color:var(--dn)">${worstSym?worstSym+' '+pSign(worstPct)+worstPct.toFixed(1)+'%':'—'}</div>
        </div>
      </div>
    </div>
  `;
}

function chartHover(sym,color,pct,val){
  const el=document.getElementById('chartCenter');
  if(el) el.innerHTML=`<div class="hero-donut-val" style="color:${color}">${sym}</div><div class="hero-donut-lbl">${pct}%</div><div class="hero-donut-lbl">${fMoney(val)}</div>`;
}
function chartHoverReset(){
  const el=document.getElementById('chartCenter');
  if(el) el.innerHTML=`<div class="hero-donut-val">${getActiveSyms().length} mã</div><div class="hero-donut-lbl">${fMoney(chartTotal)}</div>`;
}

function renderTable(){
  const syms=getActiveSyms();

  // Pre-compute values for sort — avoids O(n²) reduce in comparator
  const symVals=Object.fromEntries(syms.map(s=>{
    const cur=prices[s]?.price;
    return[s,portfolio[s].reduce((a,p)=>a+p.qty*(cur||p.price),0)];
  }));
  syms.sort((a,b)=>symVals[b]-symVals[a]);

  const rows=syms.map(sym=>{
    const ps=portfolio[sym];
    const cur=prices[sym]?.price;
    const chg=prices[sym]?.change;
    const{totalQty,totalCost,avgPrice}=symStats(sym);
    const mktVal=cur?cur*totalQty:totalCost;
    const pnl=cur?(cur-avgPrice)*totalQty:0;
    const pnlPct=avgPrice>0&&cur?((cur-avgPrice)/avgPrice*100):0;
    const c=pColor(pnl),sg=pSign(pnl);
    const isOpen=openSyms.has(sym);

    let chgHtml='';
    if(chg){
      const cm=String(chg).match(/^([+-]?[\d,\.]+)\(([+-]?[\d,\.]+)\s*%\)/);
      if(cm){
        const cv=parseFloat(cm[1].replace(',','.'));
        chgHtml=`<span class="sym-chg" style="color:${pColor(cv)}">${cm[2]}%</span>`;
      }
    }

    const bgColor=BADGE_COLORS[sym.charCodeAt(0)%BADGE_COLORS.length];
    // Cache extractSignals result — used here and potentially by updateAlertBadges
    const symAlerts=extractSignals(sym,prices[sym]||{price:cur});
    const topLevel=symAlerts.some(a=>a.level==='danger')?'danger':symAlerts.length?'warn':null;

    const subRows=ps.map((p,i)=>{
      const pl=cur?(cur-p.price)*p.qty:0;
      const plPct2=p.price>0&&cur?((cur-p.price)/p.price*100):0;
      return`<div class="sub-row">
        <span style="font-size:10px;color:var(--t3)">${i+1}</span>
        <span style="color:var(--t3)" class="mono">${p.date}</span>
        <span style="text-align:right;font-weight:700;color:var(--t2)" class="mono">${p.qty.toLocaleString('vi-VN')}</span>
        <span style="text-align:right;color:var(--t3)" class="mono">${fp(p.price)}</span>
        <span style="text-align:right">
          <span style="font-weight:700;color:${pColor(pl)}" class="mono">${pSign(pl)}${(pl/1e3).toFixed(1)} tr</span>
        </span>
        <span class="sub-actions">
          <button class="sub-btn edit" onclick="event.stopPropagation();startEdit('${sym}',${p.id},${p.qty},${p.price},'${p.date}')" title="Sửa">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--navy)" stroke-width="2.2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="sub-btn del" onclick="event.stopPropagation();removePos('${sym}',${p.id})" title="Xóa">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--dn)" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>
      </div>`;
    }).join('');

    return`
      <div class="tbl-row" data-sym="${sym}" onclick="toggleSym('${sym}')">
        <span>${buildBadgeHtml(sym,bgColor,topLevel,symAlerts)}</span>
        <span class="sym-info">
          <div style="display:flex;align-items:center;gap:8px">
            <a href="/detail.html?s=${sym}" class="sym-link" onclick="event.stopPropagation()">${sym}</a>
            ${chgHtml}
          </div>
          <span style="font-size:11px;color:var(--t3)" class="mono">${cur?fp(cur):'N/A'}</span>
        </span>
        <span style="text-align:right;font-weight:700;font-size:13px;color:var(--t2)" class="mono">${totalQty.toLocaleString('vi-VN')}</span>
        <span style="text-align:right;font-size:13px;color:var(--t3)" class="mono">${fp(avgPrice)}</span>
        <span style="text-align:right;font-weight:600;font-size:13px;color:var(--t2)" class="mono">${fMoney(mktVal)}</span>
        <span style="text-align:right">
          <div class="pl-chip" style="background:${pBg(pnl)}">
            <span class="pl-chip-val" style="color:${c}">${sg}${fMoney(pnl)}</span>
            <span class="pl-chip-pct" style="color:${c}">${sg}${pnlPct.toFixed(1)}%</span>
          </div>
        </span>
        <span style="text-align:center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--t3)" stroke-width="2" style="transition:transform .2s;transform:rotate(${isOpen?180:0}deg)"><path d="M6 9l6 6 6-6"/></svg>
        </span>
      </div>
      <div class="row-expand${isOpen?' open':''}" id="expand-${sym}">
        <div style="display:flex;justify-content:flex-end;margin-top:8px;margin-bottom:4px">
          <button class="btn" style="padding:5px 14px;font-size:11px;background:var(--dn-bg);color:var(--dn);border:1px solid var(--dn-bd);display:flex;align-items:center;gap:5px;font-weight:700;border-radius:8px" onclick="event.stopPropagation();toggleSellForm('${sym}')" title="Bán ${sym}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="7 8 3 12 7 16"/><line x1="21" y1="12" x2="3" y2="12"/></svg>
            Bán ${sym}
          </button>
        </div>
        <div id="edit-${sym}"></div>
        <div class="sub-header">
          <span>#</span><span>Ngày</span><span style="text-align:right">KL</span><span style="text-align:right">Giá mua</span><span style="text-align:right">Lãi/Lỗ</span><span></span>
        </div>
        ${subRows}
      </div>`;
  }).join('');

  document.getElementById('tableSection').innerHTML=`
    <div class="tbl-card">
      <div class="tbl-header">
        <span></span><span>Mã</span><span style="text-align:right">KL</span><span style="text-align:right">Giá vốn</span><span style="text-align:right">Giá trị</span><span style="text-align:right">Lãi / Lỗ</span><span></span>
      </div>${rows}</div>`;
}

function toggleSym(sym){
  if(openSyms.has(sym))openSyms.delete(sym);else openSyms.add(sym);
  document.getElementById('expand-'+sym)?.classList.toggle('open');
}

async function submitAdd(){
  const sym=document.getElementById('fSym').value.trim().toUpperCase();
  const qty=parseInt(document.getElementById('fQty').value);
  const price=parseFloat(document.getElementById('fPrice').value);
  const date=document.getElementById('fDate').value;
  if(!sym||!qty||!price||!date){alert('Vui lòng điền đầy đủ thông tin');return;}
  const btn=document.getElementById('addBtn');
  btn.disabled=true;btn.textContent='Đang thêm...';
  try{
    await fetch(SERVER+'/portfolio/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:sym,qty,price,date})});
    document.getElementById('fSym').value='';
    document.getElementById('fQty').value='';
    document.getElementById('fPrice').value='';
    if(!prices[sym]){
      const rt=await fetchRealtimePrice(sym);
      if(rt) prices[sym]={...rt};
      fetchTechnical(sym).then(tech=>{if(tech){prices[sym]={...prices[sym],...tech};render();}});
    }
    await refreshPortfolio();
  }catch(e){alert('Lỗi: '+e.message);}
  btn.disabled=false;btn.textContent='Thêm';
}

function startEdit(sym,id,qty,price,date){
  editingId={sym,id};
  const el=document.getElementById('edit-'+sym);
  if(!openSyms.has(sym)){openSyms.add(sym);document.getElementById('expand-'+sym)?.classList.add('open');}
  el.innerHTML=`
    <div class="edit-bar">
      <span style="font-size:11px;font-weight:700;color:var(--navy)">Sửa lệnh</span>
      <input type="number" id="eQty" value="${qty}" min="100" step="100" placeholder="KL"/>
      <input type="number" id="ePrice" value="${price}" step="0.05" placeholder="Giá"/>
      <input type="date" id="eDate" value="${date}"/>
      <button class="btn btn-primary" style="padding:6px 12px;font-size:11px" onclick="submitEdit()">Lưu</button>
      <button class="btn btn-ghost" style="padding:6px 12px;font-size:11px" onclick="cancelEdit('${sym}')">Hủy</button>
    </div>
  `;
  document.getElementById('eQty').focus();
}

async function submitEdit(){
  if(!editingId)return;
  const qty=parseInt(document.getElementById('eQty').value);
  const price=parseFloat(document.getElementById('ePrice').value);
  const date=document.getElementById('eDate').value;
  if(!qty||!price||!date)return;
  await fetch(SERVER+'/portfolio/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:editingId.sym,id:editingId.id,qty,price,date})});
  cancelEdit(editingId.sym);editingId=null;
  await refreshPortfolio();
}

function cancelEdit(sym){editingId=null;const el=document.getElementById('edit-'+sym);if(el)el.innerHTML='';}

async function removePos(sym,id){
  if(!confirm('Xóa lệnh này?'))return;
  await fetch(SERVER+'/portfolio/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:sym,id})});
  await refreshPortfolio();
}

async function refreshPortfolio(){
  try{const r=await fetch(SERVER+'/portfolio');portfolio=await r.json();}catch(e){portfolio={};}
  const syms=getActiveSyms();
  if(syms.length===0){document.getElementById('content').style.display='none';document.getElementById('empty').style.display='';return;}
  document.getElementById('content').style.display='';document.getElementById('empty').style.display='none';
  const missing=syms.filter(s=>!prices[s]?.price);
  if(missing.length){
    const rts=await Promise.allSettled(missing.map(s=>fetchRealtimePrice(s)));
    rts.forEach((r,i)=>{if(r.status==='fulfilled'&&r.value) prices[missing[i]]={...prices[missing[i]]||{},...r.value};});
  }
  render();
}

async function refreshAll(){
  const btn=document.getElementById('refreshBtn');
  btn.disabled=true;btn.style.opacity='.5';prices={};
  await init();
  btn.disabled=false;btn.style.opacity='1';
}

document.getElementById('fDate').value=today();
init();

// ── Taskbar clock ────────────────────────────────────────────────────────────
(function(){
  function tick(){
    const n=new Date();
    const el=document.getElementById('tbTime');
    if(el) el.innerHTML=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0')+'<br>'+n.getDate()+'/'+(n.getMonth()+1)+'/'+n.getFullYear();
  }
  tick();setInterval(tick,15000);
})();
