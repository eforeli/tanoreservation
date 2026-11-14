'use client';
import {useEffect,useState,useCallback} from 'react';
import {createClient} from '@supabase/supabase-js';
const supa=()=>createClient(process.env.NEXT_PUBLIC_SUPABASE_URL||'',process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY||process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||'');
const dateToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
type R={id:string;confirmation_code:string;guest_name:string;guest_phone:string;party_size:number;starts_at:string;status:string;notes:string;source:string;reservation_tables:{restaurant_tables:{code:string}|null}|null};
type Block={id:string;start_at:string;end_at:string|null;reason:string;restaurant_tables:{code:string}|null};
type Special={id:string;business_date:string;is_closed:boolean;notes:string;periods:{start:string;end:string}[]|null;opens_at:string|null;closes_at:string|null};
type WeeklyPeriod={start:string;end:string};
type WeeklyRecord={weekday:number;is_closed:boolean;periods:WeeklyPeriod[]|null;opens_at:string|null;closes_at:string|null};
type WeeklyDay={weekday:number;is_closed:boolean;periods:WeeklyPeriod[]};
const weekdays=[{id:1,label:'週一'},{id:2,label:'週二'},{id:3,label:'週三'},{id:4,label:'週四'},{id:5,label:'週五'},{id:6,label:'週六'},{id:0,label:'週日'}];
function normalizeWeeklyHours(records:WeeklyRecord[]):WeeklyDay[]{
 return weekdays.map(({id})=>{
  const r=records.find(x=>x.weekday===id);
  if(!r)return {weekday:id,is_closed:true,periods:[]};
  return {weekday:id,is_closed:r.is_closed,periods:r.periods?.length?r.periods.map(p=>({start:p.start.slice(0,5),end:p.end.slice(0,5)})):r.opens_at&&r.closes_at?[{start:r.opens_at.slice(0,5),end:r.closes_at.slice(0,5)}]:[]};
 });
}
type Settings={dining_minutes:number;buffer_minutes:number;slot_interval_minutes:number;booking_window_days:number;min_advance_minutes:number;extra_chairs_total:number;max_arrivals_per_slot:number;max_online_party_size:number;last_seating_offset_minutes:number};
const fields:(keyof Settings)[]=['dining_minutes','buffer_minutes','slot_interval_minutes','booking_window_days','min_advance_minutes','extra_chairs_total','max_arrivals_per_slot','max_online_party_size','last_seating_offset_minutes'];
const labels=['用餐分鐘','緩衝分鐘','時段間隔分鐘','開放預約天數','最少提前分鐘','加椅總數','每時段新入席組數','最大線上人數','打烊前最晚入席分鐘'];
const taipei=(s:string)=>new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(s));
const localDate=(s:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s));
const isoTime=(date:string,time:string)=>new Date(`${date}T${time}:00+08:00`).toISOString();
export default function Admin(){
 const [client]=useState(supa),[token,setToken]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[date,setDate]=useState(dateToday),[tableDate,setTableDate]=useState(dateToday),[view,setView]=useState<'day'|'7'|'30'>('day'),[tab,setTab]=useState<'bookings'|'new'|'tables'|'settings'|'special'>('bookings'),[items,setItems]=useState<R[]>([]),[tableItems,setTableItems]=useState<R[]>([]),[blocks,setBlocks]=useState<Block[]>([]),[futureBlocks,setFutureBlocks]=useState<Block[]>([]),[specials,setSpecials]=useState<Special[]>([]),[settings,setSettings]=useState<Settings|null>(null),[settingsTab,setSettingsTab]=useState<'rules'|'hours'>('rules'),[weeklyHours,setWeeklyHours]=useState<WeeklyDay[]>([]),[error,setError]=useState(''),[message,setMessage]=useState(''),[loading,setLoading]=useState(false),[filter,setFilter]=useState(''),[toast,setToast]=useState<{text:string;kind:'success'|'error'}|null>(null);
 const [form,setForm]=useState({date:dateToday(),time:'17:00',partySize:2,name:'',phone:'',notes:'',source:'phone',status:'confirmed'}),[editId,setEditId]=useState('');
 const [block,setBlock]=useState({tableCode:'A1',date:dateToday(),start:'17:00',end:'19:00',reason:''}),[blockEditId,setBlockEditId]=useState(''),[blockPage,setBlockPage]=useState(false),[blockMode,setBlockMode]=useState<'range'|'ongoing'>('range'),[blockSaving,setBlockSaving]=useState(false);
 const [special,setSpecial]=useState({business_date:dateToday(),is_closed:true,periods:[{start:'17:00',end:'21:00'}],notes:''}),[specialEditDate,setSpecialEditDate]=useState('');
 const request=useCallback(async(path:string,method='GET',body?:unknown)=>{const r=await fetch(`/api/admin/${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});const v=await r.json();if(!r.ok)throw Error(v.error||`HTTP ${r.status}`);return v;},[token]);
 const refresh=useCallback(async()=>{if(!token)return;setLoading(true);try{const bookingsDate=view==='day'?date:dateToday();const [r,t,b,allBlocks,s,x]=await Promise.all([request(`reservations?date=${bookingsDate}&days=${view==='day'?1:view}`),request(`reservations?date=${tableDate}&days=1`),request(`blocks?date=${tableDate}`),request('blocks?scope=future'),request('settings'),request('special')]);setItems(r.items);setTableItems(t.items);setBlocks(b.items.filter((item:Block)=>!item.end_at||new Date(item.end_at)>new Date()));setFutureBlocks(allBlocks.items);setSettings(s.settings);setWeeklyHours(normalizeWeeklyHours(s.hours||[]));setSpecials(x.items);setError('');}catch(e){setError(String(e));}finally{setLoading(false);}},[token,date,tableDate,view,request]);
 useEffect(()=>{client.auth.getSession().then(({data})=>setToken(data.session?.access_token||''));const {data:{subscription}}=client.auth.onAuthStateChange((_e,s)=>setToken(s?.access_token||''));return()=>subscription.unsubscribe();},[client]);
 useEffect(()=>{void refresh();},[refresh]);
 useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),2000);return()=>clearTimeout(timer);},[toast]);
 async function login(e:React.FormEvent){e.preventDefault();setError('');const {error}=await client.auth.signInWithPassword({email,password});if(error){setError(error.message);setToast({text:'登入失敗：'+error.message,kind:'error'});}}
 async function act(run:()=>Promise<unknown>,success='操作已儲存'){setError('');setMessage('');try{const outcome=await run();await refresh();setToast({text:typeof outcome==='string'?outcome:success,kind:'success'});return true;}catch(e){setToast({text:e instanceof Error?e.message:String(e),kind:'error'});return false;}}
 async function createOrEdit(e:React.FormEvent){e.preventDefault();await act(async()=>{const payload={...form,partySize:Number(form.partySize),idempotencyKey:crypto.randomUUID()};if(editId)await request(`reservations/${editId}`,'PATCH',payload);else await request('reservations','POST',payload);setEditId('');setTab('bookings');});}
 function editBlock(b:Block){setBlockEditId(b.id);setBlockMode(b.end_at?'range':'ongoing');setBlock({tableCode:b.restaurant_tables?.code||'A1',date:localDate(b.start_at),start:taipei(b.start_at),end:b.end_at?taipei(b.end_at):'19:00',reason:b.reason||''});setBlockPage(true);}
 function resetBlock(){setBlockEditId('');setBlockMode('range');setBlock({tableCode:'A1',date:tableDate,start:'17:00',end:'19:00',reason:''});}
 function openNewBlock(){resetBlock();setBlockPage(true);}
 function closeBlockPage(){setBlockPage(false);resetBlock();}
 async function saveBlock(e:React.FormEvent){e.preventDefault();if(blockSaving)return;setBlockSaving(true);const success=await act(async()=>{if(blockMode==='range'&&block.end<=block.start)throw Error('結束時間必須晚於開始時間');const payload={tableCode:block.tableCode,start:isoTime(block.date,block.start),end:blockMode==='ongoing'?null:isoTime(block.date,block.end),reason:block.reason};await request(blockEditId?`blocks/${blockEditId}`:'blocks',blockEditId?'PATCH':'POST',payload);},blockEditId?'鎖桌已更新':'鎖桌已新增');setBlockSaving(false);if(success){setTableDate(block.date);setBlockPage(false);resetBlock();}}
 function editSpecial(s:Special){setSpecialEditDate(s.business_date);setSpecial({business_date:s.business_date,is_closed:s.is_closed,notes:s.notes||'',periods:s.periods?.length?s.periods:s.opens_at&&s.closes_at?[{start:s.opens_at.slice(0,5),end:s.closes_at.slice(0,5)}]:[{start:'17:00',end:'21:00'}]});}
 function resetSpecial(){setSpecialEditDate('');setSpecial({business_date:dateToday(),is_closed:true,periods:[{start:'17:00',end:'21:00'}],notes:''});}
 function edit(r:R){const d=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.starts_at));setForm({date:d,time:taipei(r.starts_at),partySize:r.party_size,name:r.guest_name,phone:r.guest_phone,notes:r.notes,source:r.source,status:r.status});setEditId(r.id);setTab('new');}
 async function cancel(r:R){if(!confirm(`確定取消 ${r.guest_name} ${r.confirmation_code} 的訂位？`))return;await act(()=>request(`reservations/${r.id}/cancel`,'POST',{reason:'管理員取消'}));}
 function updateWeeklyDay(weekday:number,patch:Partial<WeeklyDay>){setWeeklyHours(prev=>prev.map(d=>d.weekday===weekday?{...d,...patch}:d));}
 function updateWeeklyPeriod(weekday:number,index:number,field:keyof WeeklyPeriod,value:string){setWeeklyHours(prev=>prev.map(d=>d.weekday===weekday?{...d,periods:d.periods.map((p,i)=>i===index?{...p,[field]:value}:p)}:d));}
 async function saveWeeklyHours(e:React.FormEvent){e.preventDefault();await act(async()=>{const response=await request('weekly-hours','PATCH',weeklyHours);setWeeklyHours(normalizeWeeklyHours(response.hours));},'常態營業時間已儲存');}
 if(!token)return <section className="panel narrow">{toast&&<div role="status" className={`toast ${toast.kind}`}>{toast.text}</div>}<h1>員工專區</h1><form onSubmit={login}><label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>密碼<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>{error&&<p className="error">{error}</p>}<button className="primary full">登入</button></form></section>;
 if(blockPage)return <section className="panel narrow block-editor-screen">
  <button type="button" className="block-back" onClick={closeBlockPage}>← 返回桌況與鎖桌</button>
  <h1>{blockEditId?'編輯鎖桌':'新增鎖桌'}</h1>
  <p className="muted small">選擇餐桌、日期及鎖定時段。若與既有訂位衝突，系統會阻止儲存。</p>
  {toast&&<div role="status" className={`toast ${toast.kind}`}>{toast.text}</div>}
  <form onSubmit={e=>void saveBlock(e)}>
   <div className="two">
    <label>日期 <span className="required-star" aria-hidden="true">*</span><input type="date" required value={block.date} onChange={e=>setBlock({...block,date:e.target.value})}/></label>
    <label>桌號 <span className="required-star" aria-hidden="true">*</span><select required value={block.tableCode} onChange={e=>setBlock({...block,tableCode:e.target.value})}>{['A1','A2','A3','A4','A5'].map(x=><option key={x} value={x}>{x}</option>)}</select></label>
   </div>
   <label>鎖定方式</label>
   <div className="block-mode" role="group" aria-label="鎖定方式">
    <button type="button" className={blockMode==='range'?'selected':''} aria-pressed={blockMode==='range'} onClick={()=>setBlockMode('range')}>指定時間區間</button>
    <button type="button" className={blockMode==='ongoing'?'selected':''} aria-pressed={blockMode==='ongoing'} onClick={()=>setBlockMode('ongoing')}>持續鎖定</button>
   </div>
   <div className="two">
    <label>開始時間 <span className="required-star" aria-hidden="true">*</span><input type="time" required value={block.start} onChange={e=>setBlock({...block,start:e.target.value})}/></label>
    {blockMode==='range'&&<label>結束時間 <span className="required-star" aria-hidden="true">*</span><input type="time" required min={block.start} value={block.end} onChange={e=>setBlock({...block,end:e.target.value})}/></label>}
   </div>
   {blockMode==='ongoing'&&<p className="notice small">此餐桌將從指定時間起持續鎖定，直到員工手動解除。</p>}
   <label>鎖桌原因（選填）<input maxLength={500} value={block.reason} onChange={e=>setBlock({...block,reason:e.target.value})} placeholder="例如：包場、設備維修"/></label>
   <div className="block-editor-actions"><button type="button" onClick={closeBlockPage} disabled={blockSaving}>返回</button><button type="submit" className="primary" disabled={blockSaving}>{blockSaving?'儲存中…':blockEditId?'儲存修改':'儲存鎖桌'}</button></div>
  </form>
 </section>;
 const shown=items.filter(r=>[r.guest_name,r.guest_phone,r.confirmation_code,r.status].some(s=>s.includes(filter)));
 return <section className="panel"><div className="toolbar" style={{justifyContent:'space-between'}}><div><div className="eyebrow">TANO OPERATIONS</div><h1>員工專用</h1></div><button onClick={()=>client.auth.signOut()}>登出</button></div><div className="tabs">{([['bookings','訂位詳情'],['new','新增／編輯'],['tables','桌況與鎖桌'],['special','特殊休假與營業'],['settings','營運設定']] as const).map(([k,v])=><button className={tab===k?'active':''} key={k} onClick={()=>{if(k==='new'){setEditId('');setForm(prev=>({...prev,date:dateToday(),time:'17:00',partySize:2,name:'',phone:'',notes:'',source:'phone',status:'confirmed'}));}setTab(k);}}>{v}</button>)}</div>{toast&&<div role="status" className={`toast ${toast.kind}`}>{toast.text}</div>}
 {tab==='bookings'&&<><div className="toolbar booking-controls"><div className="range-buttons"><button type="button" className={view==='day'?'active':''} onClick={()=>{setDate(dateToday());setView('day');}}>指定日期</button><button type="button" className={view==='7'?'active':''} onClick={()=>setView('7')}>未來 7 日</button><button type="button" className={view==='30'?'active':''} onClick={()=>setView('30')}>未來 30 日</button></div>{view==='day'&&<label>查看日期<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>}<label>搜尋姓名／電話／編號<input value={filter} onChange={e=>setFilter(e.target.value)}/></label><button type="button" onClick={()=>refresh()}>重新整理</button></div><div className="stats"><span>總組數：{shown.filter(r=>r.status!=='cancelled').length}</span><span>總人數：{shown.filter(r=>r.status!=='cancelled').reduce((s,r)=>s+r.party_size,0)}</span></div><div className="tablewrap"><table className="responsive-table"><thead><tr>{['日期','入席','人數','客人','電話','桌位','訂位編號','備註','操作'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{shown.map(r=><tr key={r.id}><td data-label="日期">{localDate(r.starts_at)}</td><td data-label="入席">{taipei(r.starts_at)}</td><td data-label="人數">{r.party_size}</td><td data-label="客人">{r.guest_name}</td><td data-label="電話"><a href={`tel:${r.guest_phone}`}>{r.guest_phone}</a></td><td data-label="桌位">{r.reservation_tables?.restaurant_tables?.code||'—'}</td><td data-label="訂位編號">{r.confirmation_code}</td><td data-label="備註">{r.notes||'—'}</td><td data-label="操作"><div className="actions"><button onClick={()=>edit(r)} disabled={r.status==='cancelled'}>編輯</button><button onClick={()=>cancel(r)} disabled={r.status==='cancelled'}>取消</button></div></td></tr>)}</tbody></table>{loading?'載入中…':!shown.length?'所選期間沒有訂位':''}</div></>}
 {tab==='new'&&<form onSubmit={createOrEdit}><h2>{editId?'編輯訂位':'新增電話／私訊／現場訂位'}</h2><div className="two"><label>日期<input type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></label><label>入席時間<input type="time" step="1800" value={form.time} onChange={e=>setForm({...form,time:e.target.value})}/></label><label>人數<select value={form.partySize} onChange={e=>setForm({...form,partySize:Number(e.target.value)})}>{[1,2,3,4,5].map(x=><option key={x}>{x}</option>)}</select></label><label>姓名<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>手機<input required value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></label></div><label>備註<textarea value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></label><button className="primary">{editId?'儲存修改':'建立訂位'}</button> <button type="button" onClick={()=>{setEditId('');setForm({...form,name:'',phone:'',notes:'',source:'phone',status:'confirmed'});}}>清空</button></form>}
 {tab==='tables'&&<>
  <div className="toolbar block-table-header"><h2>桌位時間軸（訂位／鎖定）</h2></div>
  <div className="toolbar"><label>查看日期<input type="date" value={tableDate} onChange={e=>setTableDate(e.target.value)}/></label></div>
  <div className="grid-table">{['A1','A2','A3','A4','A5'].map(code=>{const timeline=[
   ...tableItems.filter(r=>r.reservation_tables?.restaurant_tables?.code===code&&r.status!=='cancelled'&&localDate(r.starts_at)===tableDate).map(r=>({type:'booking' as const,key:r.id,start:r.starts_at,reservation:r})),
   ...blocks.filter(b=>b.restaurant_tables?.code===code).map(b=>({type:'block' as const,key:b.id,start:b.start_at,block:b}))
  ].sort((a,b)=>new Date(a.start).getTime()-new Date(b.start).getTime());return <div className="tablecard" key={code}><strong>{code}</strong>{timeline.map(event=>event.type==='booking'?<p key={event.key}>{taipei(event.reservation.starts_at)} {event.reservation.guest_name} · {event.reservation.party_size}人</p>:<p key={event.key} className="notice">鎖定 {taipei(event.block.start_at)}{event.block.end_at?'–'+taipei(event.block.end_at):' 起持續'}<br/>{event.block.reason}</p>)}</div>;})}</div>
  <section className="block-list-section">
   <div className="toolbar block-list-heading" style={{justifyContent:'space-between',alignItems:'center'}}>
    <h2>鎖桌紀錄</h2><button type="button" className="primary" onClick={openNewBlock}>＋ 新增鎖桌</button>
   </div>
   <p className="muted small">顯示未來所有鎖桌，以及目前仍持續生效的鎖定，不受上方桌況日期影響。</p>
   {futureBlocks.length===0?<p className="muted">目前沒有未來或持續生效的鎖桌紀錄</p>:
    <div className="tablewrap"><table className="responsive-table">
     <thead><tr><th>日期</th><th>時間區間</th><th>桌號</th><th>操作</th></tr></thead>
     <tbody>{futureBlocks.map(b=><tr key={b.id}>
      <td data-label="日期">{localDate(b.start_at)}</td>
      <td data-label="時間區間">{taipei(b.start_at)}–{b.end_at?taipei(b.end_at):'持續鎖定'}</td>
      <td data-label="桌號">{b.restaurant_tables?.code||'—'}</td>
      <td data-label="操作"><div className="actions">
       <button type="button" onClick={()=>editBlock(b)}>編輯</button>
       <button type="button" onClick={()=>{if(confirm('確定解除這筆鎖桌？'))void act(()=>request(`blocks/${b.id}/release`,'POST',{}),'鎖桌已解除');}}>刪除</button>
      </div></td>
     </tr>)}</tbody>
    </table></div>}
  </section>
 </>}
 {tab==='special'&&<><h2>{specialEditDate?'編輯特殊休假與營業':'新增特殊休假與營業'}</h2><form onSubmit={e=>{e.preventDefault();void act(async()=>{if(specialEditDate&&specialEditDate!==special.business_date)throw Error('編輯時不可修改日期，請刪除原紀錄後新增');const result=await request('special','POST',special);if(result.ok)resetSpecial();return result.existingBookings>0?`設定已儲存；當日已有 ${result.existingBookings} 筆訂位，請主動聯絡客人`:'操作已儲存';});}}><div className="two"><label>日期<input type="date" min={dateToday()} value={special.business_date} disabled={!!specialEditDate} onChange={e=>setSpecial({...special,business_date:e.target.value})}/></label><label>當日狀態<select value={special.is_closed?'closed':'open'} onChange={e=>setSpecial({...special,is_closed:e.target.value==='closed'})}><option value="closed">休息</option><option value="open">特別營業</option></select></label></div>{!special.is_closed&&<><h3>營業時段</h3>{special.periods.map((p,i)=><div className="two" key={i}><label>開始<input type="time" required value={p.start} onChange={e=>setSpecial({...special,periods:special.periods.map((x,j)=>i===j?{...x,start:e.target.value}:x)})}/></label><label>結束<input type="time" required value={p.end} onChange={e=>setSpecial({...special,periods:special.periods.map((x,j)=>i===j?{...x,end:e.target.value}:x)})}/><button type="button" disabled={special.periods.length===1} onClick={()=>setSpecial({...special,periods:special.periods.filter((_,j)=>j!==i)})}>移除時段</button></label></div>)}<button type="button" disabled={special.periods.length>=8} onClick={()=>setSpecial({...special,periods:[...special.periods,{start:'17:00',end:'21:00'}]})}>＋新增時段</button></>}<label>備註<input value={special.notes} onChange={e=>setSpecial({...special,notes:e.target.value})}/></label><button className="primary">{specialEditDate?'儲存修改':'儲存特殊日期'}</button> {specialEditDate&&<button type="button" onClick={resetSpecial}>取消編輯</button>}</form><section><h2>即將到來的特殊日期</h2>{!specials.length&&<p className="muted">目前沒有特殊休假／營業紀錄</p>}<div className="tablewrap"><table className="responsive-table"><thead><tr><th>日期</th><th>時間</th><th>類型</th><th>備註</th><th>操作</th></tr></thead><tbody>{specials.map(s=><tr key={s.id}><td data-label="日期">{s.business_date}</td><td data-label="時間">{s.is_closed?'全天':(s.periods?.length?s.periods.map(p=>p.start+'–'+p.end).join('、'):s.opens_at?.slice(0,5)+'–'+s.closes_at?.slice(0,5))}</td><td data-label="類型">{s.is_closed?'休息':'營業'}</td><td data-label="備註">{s.notes||'—'}</td><td data-label="操作"><div className="actions"><button type="button" onClick={()=>editSpecial(s)}>編輯</button><button type="button" onClick={()=>{if(confirm('確定刪除這筆特殊日期設定？'))void act(()=>request(`special/${s.business_date}`,'DELETE'),'資料已刪除');}}>刪除</button></div></td></tr>)}</tbody></table></div></section></>}
 {tab==='settings'&&settings&&<>
  <h2>營運設定</h2>
  <div className="settings-subtabs" role="group" aria-label="營運設定分類">
   <button type="button" className={settingsTab==='rules'?'active':''} aria-pressed={settingsTab==='rules'} onClick={()=>setSettingsTab('rules')}>訂位規則</button>
   <button type="button" className={settingsTab==='hours'?'active':''} aria-pressed={settingsTab==='hours'} onClick={()=>setSettingsTab('hours')}>常態營業時間</button>
  </div>
  {settingsTab==='rules'&&<>
   <p className="muted small">數值保存在 Supabase，更新網站版本不會還原已儲存設定。變更後請確認既有訂位；修改規則不會自動取消原訂位。</p>
   <form onSubmit={e=>{e.preventDefault();void act(async()=>{const response=await request('settings','PATCH',settings);setSettings(response.settings);},'訂位規則已儲存');}}>
    <div className="two">{fields.map((key,i)=><label key={key}>{labels[i]}<input type="number" required value={settings[key]} onChange={e=>setSettings({...settings,[key]:Number(e.target.value)})}/></label>)}</div>
    <button type="submit" className="primary">儲存設定</button>
   </form>
  </>}
  {settingsTab==='hours'&&<>
   <p className="muted small">可設定週一至週日各自的營業日及多個時段。特殊休假與營業設定優先於此常態時間；修改時間不會自動取消已成立訂位。</p>
   <form onSubmit={saveWeeklyHours}>
    <div className="weekly-hours-list">{weekdays.map(({id,label})=>{const day=weeklyHours.find(d=>d.weekday===id);if(!day)return null;return <section key={id} className="weekly-day">
     <div className="weekly-day-header">
      <h3>{label}</h3>
      <label className="weekly-day-state">當日狀態
       <select aria-label={label+'營業狀態'} value={day.is_closed?'closed':'open'} onChange={e=>updateWeeklyDay(id,{is_closed:e.target.value==='closed',periods:e.target.value==='closed'?day.periods:day.periods.length?day.periods:[{start:'17:00',end:'21:00'}]})}>
        <option value="open">營業</option><option value="closed">公休</option>
       </select>
      </label>
     </div>
     {!day.is_closed&&<>
      {day.periods.map((p,i)=><div className="weekly-period" key={i}>
       <label>開始時間<input type="time" required value={p.start} onChange={e=>updateWeeklyPeriod(id,i,'start',e.target.value)}/></label>
       <label>結束時間<input type="time" required value={p.end} onChange={e=>updateWeeklyPeriod(id,i,'end',e.target.value)}/></label>
       <button type="button" disabled={day.periods.length===1} aria-label={label+'移除第'+(i+1)+'個時段'} onClick={()=>updateWeeklyDay(id,{periods:day.periods.filter((_,j)=>j!==i)})}>移除</button>
      </div>)}
      <button type="button" className="weekly-add" disabled={day.periods.length>=8} onClick={()=>updateWeeklyDay(id,{periods:[...day.periods,{start:'12:00',end:'14:00'}]})}>＋ 新增時段</button>
     </>}
     {day.is_closed&&<p className="muted small">公休，不開放訂位</p>}
    </section>;})}</div>
    <div className="weekly-save"><button className="primary" type="submit">儲存常態營業時間</button></div>
   </form>
  </>}
 </>}
 </section>;
}