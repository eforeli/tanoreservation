'use client';
import {useCallback,useEffect,useState} from 'react';

type LogRow={
 id:string;confirmation_code:string;booking_created_at:string;guest_name:string;guest_phone:string;
 before_starts_at:string|null;before_party_size:number|null;
 after_starts_at:string|null;after_party_size:number|null;
 action:string;actor:'customer'|'admin';changed_at:string;
};
type Filters={from:string;to:string;code:string;phone:string;actor:'all'|'customer'|'admin'};
const empty:Filters={from:'',to:'',code:'',phone:'',actor:'all'};
const display=(value:string|null)=>value?new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)).replace(/\//g,'/'):'—';
function bookingSummary(time:string|null,party:number|null){return time?`${display(time)} · ${party??'—'} 人`:'—';}
export default function ReservationLog({request}:{request:(path:string,method?:string,body?:unknown)=>Promise<any>}){
 const [draft,setDraft]=useState<Filters>(empty);
 const [filters,setFilters]=useState<Filters>(empty);
 const [page,setPage]=useState(1);
 const [rows,setRows]=useState<LogRow[]>([]);
 const [total,setTotal]=useState(0);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [reload,setReload]=useState(0);
 const load=useCallback(async()=>{
  setBusy(true);setError('');
  try{
   const params=new URLSearchParams({page:String(page)});
   if(filters.from)params.set('from',filters.from);
   if(filters.to)params.set('to',filters.to);
   if(filters.code)params.set('code',filters.code);
   if(filters.phone)params.set('phone',filters.phone);
   if(filters.actor!=='all')params.set('actor',filters.actor);
   const result=await request('reservation-log?'+params.toString());
   setRows(result.items||[]);setTotal(result.total||0);
  }catch(e){setRows([]);setTotal(0);setError(e instanceof Error?e.message:'讀取訂位 Log 失敗');}
  finally{setBusy(false);}
 },[request,filters,page,reload]);
 useEffect(()=>{void load();},[load]);
 const totalPages=Math.max(1,Math.ceil(total/10));
 function apply(e:React.FormEvent){e.preventDefault();setPage(1);setFilters({...draft});setReload(x=>x+1);}
 function reset(){setDraft({...empty});setFilters({...empty});setPage(1);setReload(x=>x+1);}
 return <section className="reservation-log-panel">
  <h2>訂位 log</h2>
  <p className="muted small">僅顯示最近 30 天成功提交的訂位修改與取消紀錄，每頁 10 筆。</p>
  <form className="reservation-log-filters" onSubmit={apply}>
   <label>修改時間（起）<input type="date" value={draft.from} max={draft.to||undefined} onChange={e=>setDraft(v=>({...v,from:e.target.value}))}/></label>
   <label>修改時間（迄）<input type="date" value={draft.to} min={draft.from||undefined} onChange={e=>setDraft(v=>({...v,to:e.target.value}))}/></label>
   <label>訂位編號<input placeholder="搜尋編號" maxLength={32} value={draft.code} onChange={e=>setDraft(v=>({...v,code:e.target.value}))}/></label>
   <label>電話號碼<input placeholder="搜尋電話" maxLength={24} inputMode="tel" value={draft.phone} onChange={e=>setDraft(v=>({...v,phone:e.target.value}))}/></label>
   <label>操作者<select value={draft.actor} onChange={e=>setDraft(v=>({...v,actor:e.target.value as Filters['actor']}))}>
    <option value="all">全部</option><option value="customer">用戶</option><option value="admin">管理員</option>
   </select></label>
   <div className="reservation-log-filter-actions"><button type="submit" className="primary">篩選</button><button type="button" onClick={reset}>清除</button></div>
  </form>
  <div className="reservation-log-summary"><span>共 {total} 筆紀錄</span><button type="button" disabled={busy} onClick={()=>setReload(x=>x+1)}>重新整理</button></div>
  {error&&<p className="error" role="alert">{error}</p>}
  <div className="tablewrap">
   <table className="responsive-table reservation-log-table">
    <thead><tr><th>訂位編號</th><th>用戶姓名</th><th>用戶電話</th><th>修改前</th><th>修改後</th><th>修改時間</th><th>操作者</th></tr></thead>
    <tbody>
     {rows.map(row=><tr key={row.actor+'-'+row.id}>
      <td data-label="訂位編號"><div className="reservation-log-code"><strong>{row.confirmation_code}</strong><small>首次成立：{display(row.booking_created_at)}</small></div></td>
      <td data-label="用戶姓名">{row.guest_name}</td>
      <td data-label="用戶電話">{row.guest_phone}</td>
      <td data-label="修改前">{bookingSummary(row.before_starts_at,row.before_party_size)}</td>
      <td data-label="修改後">{row.action==='cancel'?'取消訂位':bookingSummary(row.after_starts_at,row.after_party_size)}</td>
      <td data-label="修改時間">{display(row.changed_at)}</td>
      <td data-label="操作者">{row.actor==='admin'?'管理員':'用戶'}</td>
     </tr>)}
     {!busy&&rows.length===0&&<tr><td colSpan={7} className="center">沒有符合條件的訂位異動紀錄</td></tr>}
    </tbody>
   </table>
  </div>
  {busy&&<p className="muted small" role="status">查詢中…</p>}
  <div className="reservation-log-pages">
   <button type="button" disabled={busy||page<=1} onClick={()=>setPage(n=>n-1)}>上一頁</button>
   <span>第 {page} / {totalPages} 頁</span>
   <button type="button" disabled={busy||page>=totalPages} onClick={()=>setPage(n=>n+1)}>下一頁</button>
  </div>
 </section>;
}
