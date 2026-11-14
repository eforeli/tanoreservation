'use client';
import {useEffect,useState,useCallback} from 'react';
import {createClient} from '@supabase/supabase-js';
import ReservationLog from '@/components/ReservationLog';
import {adminText,type AdminLanguage} from '@/lib/admin-i18n';
const supa=()=>createClient(process.env.NEXT_PUBLIC_SUPABASE_URL||'',process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY||process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||'');
const dateToday=()=>{const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const part=(type:string)=>parts.find(p=>p.type===type)?.value||'';return `${part('year')}-${part('month')}-${part('day')}`;};
type R={id:string;confirmation_code:string;guest_name:string;guest_phone:string;party_size:number;starts_at:string;status:string;notes:string;source:string;reservation_tables:{restaurant_tables:{code:string}|null}|null};
type Block={id:string;start_at:string;end_at:string|null;reason:string;restaurant_tables:{code:string}|null};
type Special={id:string;business_date:string;is_closed:boolean;notes:string;periods:{start:string;end:string}[]|null;closure_periods:{start:string;end:string}[]|null;opens_at:string|null;closes_at:string|null};
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
const displayBookingDate=(s:string)=>{const day=localDate(s);const weekday=['日','一','二','三','四','五','六'][new Date(`${day}T12:00:00+08:00`).getUTCDay()];return `${day} (${weekday}）`;};
const isoTime=(date:string,time:string)=>new Date(`${date}T${time}:00+08:00`).toISOString();
export default function Admin(){
 const [language,setLanguage]=useState<AdminLanguage>(()=>typeof window!=='undefined'&&window.sessionStorage.getItem('tano_admin_language')==='zh'?'zh':'es');
 const t=(value:string)=>adminText(value,language);
 const [client]=useState(supa),[token,setToken]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[date,setDate]=useState(dateToday),[tableDate,setTableDate]=useState(dateToday),[view,setView]=useState<'day'|'7'|'30'>('day'),[tab,setTab]=useState<'bookings'|'new'|'tables'|'settings'|'special'|'reservation-log'>('bookings'),[items,setItems]=useState<R[]>([]),[tableItems,setTableItems]=useState<R[]>([]),[blocks,setBlocks]=useState<Block[]>([]),[futureBlocks,setFutureBlocks]=useState<Block[]>([]),[specials,setSpecials]=useState<Special[]>([]),[settings,setSettings]=useState<Settings|null>(null),[settingsTab,setSettingsTab]=useState<'rules'|'hours'>('rules'),[weeklyHours,setWeeklyHours]=useState<WeeklyDay[]>([]),[error,setError]=useState(''),[message,setMessage]=useState(''),[loading,setLoading]=useState(false),[filter,setFilter]=useState(''),[bookingRefreshKey,setBookingRefreshKey]=useState(0),[toast,setToast]=useState<{text:string;kind:'success'|'error'}|null>(null),[specialPage,setSpecialPage]=useState(false),[specialMode,setSpecialMode]=useState<'closed'|'partial'|'open'>('closed');
 const [form,setForm]=useState({date:dateToday(),time:'17:00',partySize:2,name:'',phone:'',notes:'',source:'phone',status:'confirmed'}),[editId,setEditId]=useState('');
 const [block,setBlock]=useState({tableCode:'A1',date:dateToday(),start:'17:00',end:'19:00',reason:''}),[blockEditId,setBlockEditId]=useState(''),[blockPage,setBlockPage]=useState(false),[blockMode,setBlockMode]=useState<'range'|'ongoing'>('range'),[blockSaving,setBlockSaving]=useState(false);
 const [special,setSpecial]=useState({business_date:dateToday(),is_closed:true,periods:[{start:'17:00',end:'21:00'}],closure_periods:[{start:'18:00',end:'19:00'}],notes:''}),[specialEditDate,setSpecialEditDate]=useState('');
 const request=useCallback(async(path:string,method='GET',body?:unknown)=>{const r=await fetch(`/api/admin/${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});const v=await r.json();if(!r.ok)throw Error(v.error||`HTTP ${r.status}`);return v;},[token]);
 const refresh=useCallback(async()=>{if(!token)return;setLoading(true);try{const bookingsDate=view==='day'?date:dateToday();const [r,t,b,allBlocks,s,x]=await Promise.all([request(`reservations?date=${bookingsDate}&days=${view==='day'?1:view}`),request(`reservations?date=${tableDate}&days=1`),request(`blocks?date=${tableDate}`),request('blocks?scope=future'),request('settings'),request('special')]);setItems(r.items);setTableItems(t.items);setBlocks(b.items.filter((item:Block)=>!item.end_at||new Date(item.end_at)>new Date()));setFutureBlocks(allBlocks.items);setSettings(s.settings);setWeeklyHours(normalizeWeeklyHours(s.hours||[]));setSpecials(x.items);setError('');}catch(e){setError(String(e));}finally{setLoading(false);}},[token,date,tableDate,view,request,bookingRefreshKey]);
 useEffect(()=>{client.auth.getSession().then(({data})=>setToken(data.session?.access_token||''));const {data:{subscription}}=client.auth.onAuthStateChange((_e,s)=>setToken(s?.access_token||''));return()=>subscription.unsubscribe();},[client]);
 useEffect(()=>{void refresh();},[refresh]);
 useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),2000);return()=>clearTimeout(timer);},[toast]);
 async function login(e:React.FormEvent){e.preventDefault();setError('');const {error}=await client.auth.signInWithPassword({email,password});if(!error)window.sessionStorage.setItem('tano_admin_language',language);if(error){setError(error.message);setToast({text:t("登入失敗：")+error.message,kind:'error'});}}
 async function act(run:()=>Promise<unknown>{t(",success=t("操作已儲存"))")}{setError('');setMessage('');try{const outcome=await run();await refresh();setToast({text:typeof outcome==='string'?outcome:success,kind:'success'});return true;}catch(e){setToast({text:e instanceof Error?e.message:String(e),kind:'error'});return false;}}
 async function createOrEdit(e:React.FormEvent){e.preventDefault();const success=await act(async()=>{const payload={...form,partySize:Number(form.partySize),idempotencyKey:crypto.randomUUID()};if(editId)await request(`reservations/${editId}`,'PATCH',payload);else await request('reservations','POST',payload);},editId?t("訂位已更新"):t("訂位已新增"));if(success){setEditId('');setTab('bookings');}}
 function openNewBooking(){setEditId('');setForm({date:dateToday(),time:'17:00',partySize:2,name:'',phone:'',notes:'',source:'phone',status:'confirmed'});setTab('new');}
 function editBlock(b:Block){setBlockEditId(b.id);setBlockMode(b.end_at?'range':'ongoing');setBlock({tableCode:b.restaurant_tables?.code||'A1',date:localDate(b.start_at),start:taipei(b.start_at),end:b.end_at?taipei(b.end_at):'19:00',reason:b.reason||''});setBlockPage(true);}
 function resetBlock(){setBlockEditId('');setBlockMode('range');setBlock({tableCode:'A1',date:tableDate,start:'17:00',end:'19:00',reason:''});}
 function openNewBlock(){resetBlock();setBlockPage(true);}
 function closeBlockPage(){setBlockPage(false);resetBlock();}
 async function saveBlock(e:React.FormEvent){e.preventDefault();if(blockSaving)return;setBlockSaving(true);const success=await act(async()=>{if(blockMode==='range'&&block.end<=block.start)throw Error(t("結束時間必須晚於開始時間"));const payload={tableCode:block.tableCode,start:isoTime(block.date,block.start),end:blockMode==='ongoing'?null:isoTime(block.date,block.end),reason:block.reason};await request(blockEditId?`blocks/${blockEditId}`:'blocks',blockEditId?'PATCH':'POST',payload);},blockEditId?t("鎖桌已更新"):t("鎖桌已新增"));setBlockSaving(false);if(success){setTableDate(block.date);setBlockPage(false);resetBlock();}}
 function editSpecial(s:Special){setSpecialEditDate(s.business_date);setSpecialMode(s.is_closed?'closed':s.closure_periods?.length?'partial':'open');setSpecial({business_date:s.business_date,is_closed:s.is_closed,notes:s.notes||'',periods:s.periods?.length?s.periods:s.opens_at&&s.closes_at?[{start:s.opens_at.slice(0,5),end:s.closes_at.slice(0,5)}]:[{start:'17:00',end:'21:00'}],closure_periods:s.closure_periods?.length?s.closure_periods:[{start:'18:00',end:'19:00'}]});setSpecialPage(true);}
 function resetSpecial(){setSpecialEditDate('');setSpecialMode('closed');setSpecial({business_date:dateToday(),is_closed:true,periods:[{start:'17:00',end:'21:00'}],closure_periods:[{start:'18:00',end:'19:00'}],notes:''});}
 function openNewSpecial(){resetSpecial();setSpecialPage(true);}
 function chooseBookingRange(next:'day'|'7'|'30'){if(next==='day'){setDate(dateToday());}if(view===next&&(next!=='day'||date===dateToday()))setBookingRefreshKey(n=>n+1);setView(next);}
 function closeSpecial(){setSpecialPage(false);resetSpecial();}
 async function saveSpecial(e:React.FormEvent){e.preventDefault();const success=await act(async()=>{if(specialEditDate&&specialEditDate!==special.business_date)throw Error(t("編輯時不可修改日期，請刪除原紀錄後新增"));const result=await request('special','POST',{...special,mode:specialMode});return result.existingBookings>{t("0?`設定已儲存；當日已有 $")}{result.existingBookings} 筆訂位，請聯絡客人確認`:'特殊日期已儲存';});if(success)closeSpecial();}
 function edit(r:R){const d=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.starts_at));setForm({date:d,time:taipei(r.starts_at),partySize:r.party_size,name:r.guest_name,phone:r.guest_phone,notes:r.notes,source:r.source,status:r.status});setEditId(r.id);setTab('new');}
 async function cancel(r:R){if(!confirm(`確定取消 ${r.guest_name} ${r.confirmation_code} 的訂位？`))return;await act(()=>request(`reservations/${r.id}/cancel`,'POST',{reason:t("管理員取消")}));}
 function updateWeeklyDay(weekday:number,patch:Partial<WeeklyDay>){setWeeklyHours(prev=>prev.map(d=>d.weekday===weekday?{...d,...patch}:d));}
 function updateWeeklyPeriod(weekday:number,index:number,field:keyof WeeklyPeriod,value:string){setWeeklyHours(prev=>prev.map(d=>d.weekday===weekday?{...d,periods:d.periods.map((p,i)=>i===index?{...p,[field]:value}:p)}:d));}
 async function saveWeeklyHours(e:React.FormEvent){e.preventDefault();await act(async()=>{const response=await request('weekly-hours','PATCH',weeklyHours);setWeeklyHours(normalizeWeeklyHours(response.hours));},t("常態營業時間已儲存"));}
 if(!token)return <section className="panel narrow">{toast&&<div role="status" className={`toast ${toast.kind}`}>{toast.text}</div>}<h1>{t("員工專區")}</h1><form onSubmit={login}><label>{t("語言")}<select value={language} onChange={e=>setLanguage(e.target.value as AdminLanguage)}><option value="es">Español (Argentina)</option><option value="zh">{t("繁體中文")}</option></select></label><label>{t("員工編號")}<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>{t("通行憑證")}<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>{error&&<p className="error">{error}</p>}<button className="primary full">{t("登入")}</button></form></section>;
 if(tab==='new')return <section className="panel narrow admin-editor-screen">
  <button type="button" className="block-back" onClick={()=>{setEditId('');setTab('bookings');}}>{t("← 返回訂位詳情")}</button>
  <h1>{editId?t("編輯訂位"):t("新增訂位")}</h1>
  {toast&&<div role="status" className={`toast ${toast.kind}`}>{toast.text}</div>}
  <form onSubmit={createOrEdit}>
   <div className="two">
    <label>{t("日期")}<input type="date" required value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></label>
    <label>{t("入席時間")}<input type="time" step="1800" required value={form.time} onChange={e=>setForm({...form,time:e.target.value})}/></label>
    <label>{t("人數")}<select value={form.partySize} onChange={e=>setForm({...form,partySize:Number(e.target.value)})}>{[1,2,3,4,5].map(x=><option key={x}>{x}</option>)}</select></label>
    <label>{t("姓名")}<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
    <label>{t("手機")}<input required value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></label>
   </div>
   <label>{t("備註")}<textarea value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></label>
   <div className="block-editor-actions"><button type="button" onClick={()=>{setEditId('');setTab('bookings');}}>{t("返回")}</button><button type="submit" className="primary">{editId?'儲存修改':t("建立訂位")}</button></div>
  </form>
 </section>;
 if(specialPage)return <section className="panel narrow admin-editor-screen">
  <button type="button" className="block-back" onClick={closeSpecial}>{t("← 返回特殊日期列表")}</button>
  <h1>{specialEditDate?t("編輯特殊休假與營業"):t("新增特殊休假與營業")}</h1>
  {toast&&<div role="status" className={`toast ${toast.kind}`}>{toast.text}</div>}
  <form onSubmit={saveSpecial}>
   <label>{t("日期")}<input type="date" required min={dateToday()} value={special.business_date} disabled={!!specialEditDate} onChange={e=>setSpecial({...special,business_date:e.target.value})}/></label>
   <label>{t("類型")}<select value={specialMode==='open'?'open':'holiday'} onChange={e=>setSpecialMode(e.target.value==='open'?'open':'closed')}>
    <option value="holiday">{t("休假")}</option>
    <option value="open">{t("營業")}</option>
   </select></label>
   {specialMode!=='open'&&<label className="special-all-day"><input type="checkbox" checked={specialMode==='closed'} onChange={e=>setSpecialMode(e.target.checked?'closed':'partial')}/>{t("全天休假")}</label>}
   {specialMode==='closed'&&<p className="notice small">{t("全天休假，前台將顯示「本日公休」。")}</p>}
   {specialMode==='partial'&&<><h3>{t("休假時段")}</h3><p className="muted small">{t("從當天常態營業時間扣除下列休息時段，其他時間依常態營業設定。")}</p>
    {special.closure_periods.map((p,i)=><div className="special-period" key={i}>
      <label>{t("開始")}<input type="time" required value={p.start} onChange={e=>setSpecial({...special,closure_periods:special.closure_periods.map((x,j)=>i===j?{...x,start:e.target.value}:x)})}/></label>
      <label>{t("結束")}<input type="time" required value={p.end} onChange={e=>setSpecial({...special,closure_periods:special.closure_periods.map((x,j)=>i===j?{...x,end:e.target.value}:x)})}/></label>
      <button type="button" disabled={special.closure_periods.length===1} onClick={()=>setSpecial({...special,closure_periods:special.closure_periods.filter((_,j)=>j!==i)})}>{t("移除")}</button>
     </div>)}
    <button type="button" disabled={special.closure_periods.length>=8} onClick={()=>setSpecial({...special,closure_periods:[...special.closure_periods,{start:'18:00',end:'19:00'}]})}>{t("＋新增休假時段")}</button>
   </>}
   {specialMode==='open'&&<><h3>{t("特殊營業時段")}</h3>
    {special.periods.map((p,i)=><div className="special-period" key={i}>
      <label>{t("開始")}<input type="time" required value={p.start} onChange={e=>setSpecial({...special,periods:special.periods.map((x,j)=>i===j?{...x,start:e.target.value}:x)})}/></label>
      <label>{t("結束")}<input type="time" required value={p.end} onChange={e=>setSpecial({...special,periods:special.periods.map((x,j)=>i===j?{...x,end:e.target.value}:x)})}/></label>
      <button type="button" disabled={special.periods.length===1} onClick={()=>setSpecial({...special,periods:special.periods.filter((_,j)=>j!==i)})}>{t("移除")}</button>
     </div>)}
    <button type="button" disabled={special.periods.length>=8} onClick={()=>setSpecial({...special,periods:[...special.periods,{start:'17:00',end:'21:00'}]})}>{t("＋新增營業時段")}</button>
   </>}
   <label>{t("備註")}<input maxLength={500} value={special.notes} onChange={e=>setSpecial({...special,notes:e.target.value})}/></label>
   <div className="block-editor-actions"><button type="button" onClick={closeSpecial}>{t("返回")}</button><button className="primary" type="submit">{specialEditDate?t("儲存修改"):t("儲存特殊日期")}</button></div>
  </form>
 </section>;
 if(blockPage)return <section className="panel narrow block-editor-screen">
  <button type="button" className="block-back" onClick={closeBlockPage}>{t("← 返回桌況與鎖桌")}</button>
  <h1>{blockEditId?t("編輯鎖桌"):t("新增鎖桌")}</h1>
  <p className="muted small">{t("選擇餐桌、日期及鎖定時段。若與既有訂位衝突，系統會阻止儲存。")}</p>
  {toast&&<div role="status" className={`toast ${toast.kind}`}>{toast.text}</div>}
  <form onSubmit={e=>void saveBlock(e)}>
   <div className="two">
    <label>{t("日期 ")}<span className="required-star" aria-hidden="true">*</span><input type="date" required value={block.date} onChange={e=>setBlock({...block,date:e.target.value})}/></label>
    <label>{t("桌號 ")}<span className="required-star" aria-hidden="true">*</span><select required value={block.tableCode} onChange={e=>setBlock({...block,tableCode:e.target.value})}>{['A1','A2','A3','A4','A5'].map(x=><option key={x} value={x}>{x}</option>)}</select></label>
   </div>
   <label>{t("鎖定方式")}</label>
   <div className="block-mode" role="group" aria-label={t("鎖定方式")}>
    <button type="button" className={blockMode==='range'?'selected':''} aria-pressed={blockMode==='range'} onClick={()=>setBlockMode('range')}>{t("指定時間區間")}</button>
    <button type="button" className={blockMode==='ongoing'?'selected':''} aria-pressed={blockMode==='ongoing'} onClick={()=>setBlockMode('ongoing')}>{t("持續鎖定")}</button>
   </div>
   <div className="two">
    <label>{t("開始時間 ")}<span className="required-star" aria-hidden="true">*</span><input type="time" required value={block.start} onChange={e=>setBlock({...block,start:e.target.value})}/></label>
    {blockMode==='range'&&<label>{t("結束時間 ")}<span className="required-star" aria-hidden="true">*</span><input type="time" required min={block.start} value={block.end} onChange={e=>setBlock({...block,end:e.target.value})}/></label>}
   </div>
   {blockMode==='ongoing'&&<p className="notice small">{t("此餐桌將從指定時間起持續鎖定，直到員工手動解除。")}</p>}
   <label>{t("鎖桌原因（選填）")}<input maxLength={500} value={block.reason} onChange={e=>setBlock({...block,reason:e.target.value})} placeholder={t("例如：包場、設備維修")}/></label>
   <div className="block-editor-actions"><button type="button" onClick={closeBlockPage} disabled={blockSaving}>{t("返回")}</button><button type="submit" className="primary" disabled={blockSaving}>{blockSaving?t("儲存中…"):blockEditId?t("儲存修改"):t("儲存鎖桌")}</button></div>
  </form>
 </section>;
 const shown=items.filter(r=>[r.guest_name,r.guest_phone,r.confirmation_code,r.status].some(s=>s.includes(filter)));
 return <section className="panel"><div className="toolbar" style={{justifyContent:'space-between'}}><div><div className="eyebrow">TANO OPERATIONS</div><h1>{t("員工專用")}</h1></div><button onClick={()=>{window.sessionStorage.removeItem('tano_admin_language');setLanguage('es');void client.auth.signOut();}}>{t("登出")}</button></div><div className="tabs">{([['bookings',t("訂位詳情")],['tables',t("桌況與鎖桌")],['special',t("特殊休假與營業")],['settings',t("營運設定")],['reservation-log',t("訂位log")]] as const).map(([k,v])=><button className={tab===k?'active':''} key={k} onClick={()=>{if(k==='bookings'&&view==='day'){const today=dateToday();setDate(today);if(date===today)setBookingRefreshKey(n=>n+1);}setTab(k);}} >{t(v)}</button>)}</div>{toast&&<div role="status" className={`toast ${toast.kind}`}>{toast.text}</div>}
 {tab==='bookings'&&<><div className="toolbar booking-controls"><div className="range-buttons"><button type="button" className={view==='day'?'active':''} onClick={()=>chooseBookingRange('day')}>{t("指定日期")}</button><button type="button" className={view==='7'?'active':''} onClick={()=>chooseBookingRange('7')}>{t("未來 7 日")}</button><button type="button" className={view==='30'?'active':''} onClick={()=>chooseBookingRange('30')}>{t("未來 30 日")}</button></div>{view==='day'&&<label>{t("查看日期")}<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>}<label>{t("搜尋姓名／電話／編號")}<input value={filter} onChange={e=>setFilter(e.target.value)}/></label></div><div className="stats booking-stats"><span>{t("總組數：")}{shown.filter(r=>r.status!=='cancelled').length}</span><span>{t("總人數：")}{shown.filter(r=>r.status!=='cancelled').reduce((s,r)=>s+r.party_size,0)}</span><button type="button" className="primary" onClick={openNewBooking}>{t("＋ 新增訂位")}</button></div><div className="tablewrap"><table className="responsive-table booking-detail-table"><thead><tr>{['日期',t("入席"),t("人數"),t("客人"),t("電話"),t("桌位"),t("訂位編號"),t("備註"),t("操作")].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{shown.map(r=><tr key={r.id}><td data-label={t("日期")}>{displayBookingDate(r.starts_at)}</td><td data-label={t("入席")}>{taipei(r.starts_at)}</td><td data-label={t("人數")}>{r.party_size}</td><td data-label={t("客人")}>{r.guest_name}</td><td data-label={t("電話")}><a href={`tel:${r.guest_phone}`}>{r.guest_phone}</a></td><td data-label={t("桌位")}>{r.reservation_tables?.restaurant_tables?.code||'—'}</td><td data-label={t("訂位編號")}>{r.confirmation_code}</td><td data-label={t("備註")}>{r.notes||'—'}</td><td data-label={t("操作")}><div className="actions"><button onClick={()=>edit(r)} disabled={r.status==='cancelled'}>{t("編輯")}</button><button onClick={()=>cancel(r)} disabled={r.status==='cancelled'}>{t("取消")}</button></div></td></tr>)}</tbody></table>{loading?'載入中…':!shown.length?t("所選期間沒有訂位"):''}</div></>}
  {tab==='tables'&&<>
  <div className="toolbar block-table-header"><h2>{t("桌位時間軸（訂位／鎖定）")}</h2></div>
  <div className="toolbar"><label>{t("查看日期")}<input type="date" value={tableDate} onChange={e=>setTableDate(e.target.value)}/></label></div>
  <div className="grid-table">{['A1','A2','A3','A4','A5'].map(code=>{const timeline=[
   ...tableItems.filter(r=>r.reservation_tables?.restaurant_tables?.code===code&&r.status!=='cancelled'&&localDate(r.starts_at)===tableDate).map(r=>({type:'booking' as const,key:r.id,start:r.starts_at,reservation:r})),
   ...blocks.filter(b=>b.restaurant_tables?.code===code).map(b=>({type:'block' as const,key:b.id,start:b.start_at,block:b}))
  ].sort((a,b)=>new Date(a.start).getTime()-new Date(b.start).getTime());return <div className="tablecard" key={code}><strong>{code}</strong>{timeline.map(event=>event.type==='booking'?<p key={event.key}>{taipei(event.reservation.starts_at)} {event.reservation.guest_name} · {event.reservation.party_size}人</p>:<p key={event.key} className="notice">{t("鎖定 ")}{taipei(event.block.start_at)}{event.block.end_at?'–'+taipei(event.block.end_at):t(" 起持續")}<br/>{event.block.reason}</p>)}</div>;})}</div>
  <section className="block-list-section">
   <div className="toolbar block-list-heading" style={{justifyContent:'space-between',alignItems:'center'}}>
    <h2>{t("鎖桌紀錄")}</h2><button type="button" className="primary" onClick={openNewBlock}>{t("＋ 新增鎖桌")}</button>
   </div>
   <p className="muted small">{t("顯示未來所有鎖桌，以及目前仍持續生效的鎖定，不受上方桌況日期影響。")}</p>
   {futureBlocks.length===0?<p className="muted">{t("目前沒有未來或持續生效的鎖桌紀錄")}</p>:
    <div className="tablewrap"><table className="responsive-table">
     <thead><tr><th>{t("日期")}</th><th>{t("時間區間")}</th><th>{t("桌號")}</th><th>{t("操作")}</th></tr></thead>
     <tbody>{futureBlocks.map(b=><tr key={b.id}>
      <td data-label={t("日期")}>{localDate(b.start_at)}</td>
      <td data-label={t("時間區間")}>{taipei(b.start_at)}–{b.end_at?taipei(b.end_at):t("持續鎖定")}</td>
      <td data-label={t("桌號")}>{b.restaurant_tables?.code||'—'}</td>
      <td data-label={t("操作")}><div className="actions">
       <button type="button" onClick={()=>editBlock(b)}>{t("編輯")}</button>
       <button type="button" onClick={()=>{if(confirm(t("確定解除這筆鎖桌？")))void act(()=>request(`blocks/${b.id}/release`,'POST',{}),t("鎖桌已解除"));}}>{t("刪除")}</button>
      </div></td>
     </tr>)}</tbody>
    </table></div>}
  </section>
 </>}
 {tab==='special'&&<section className="special-list-section">
  <div className="toolbar block-list-heading" style={{justifyContent:'space-between',alignItems:'center'}}>
   <h2>{t("即將到來的特殊日期")}</h2>
   <button type="button" className="primary" onClick={openNewSpecial}>{t("＋ 新增休假/營業")}</button>
  </div>
  {!specials.length&&<p className="muted">{t("目前沒有特殊休假／營業紀錄")}</p>}
  <div className="tablewrap"><table className="responsive-table"><thead><tr><th>{t("日期")}</th><th>{t("時間")}</th><th>{t("類型")}</th><th>{t("備註")}</th><th>{t("操作")}</th></tr></thead>
   <tbody>{specials.map(s=><tr key={s.id}>
    <td data-label={t("日期")}>{s.business_date}</td>
    <td data-label={t("時間")}>{s.is_closed?t("全天"):s.closure_periods?.length?s.closure_periods.map(p=>p.start+'–'+p.end).join('、'):(s.periods?.length?s.periods.map(p=>p.start+'–'+p.end).join('、'):s.opens_at?.slice(0,5)+'–'+s.closes_at?.slice(0,5))}</td>
    <td data-label={t("類型")}>{s.is_closed?t("休息（全天）"):s.closure_periods?.length?t("休息（部分）"):t("營業")}</td>
    <td data-label={t("備註")}>{s.notes||'—'}</td>
    <td data-label={t("操作")}><div className="actions">
     <button type="button" onClick={()=>editSpecial(s)}>{t("編輯")}</button>
     <button type="button" onClick={()=>{if(confirm(t("確定刪除這筆特殊日期設定？")))void act(()=>request(`special/${s.business_date}`,'DELETE'),t("資料已刪除"));}}>{t("刪除")}</button>
    </div></td>
   </tr>)}</tbody>
  </table></div>
 </section>}
 {tab==='reservation-log'&&<ReservationLog request={request} language={language}/>}
 {tab==='settings'&&settings&&<>
  <h2>{t("營運設定")}</h2>
  <div className="settings-subtabs" role="group" aria-label={t("營運設定分類")}>
   <button type="button" className={settingsTab==='rules'?'active':''} aria-pressed={settingsTab==='rules'} onClick={()=>setSettingsTab('rules')}>{t("訂位規則")}</button>
   <button type="button" className={settingsTab==='hours'?'active':''} aria-pressed={settingsTab==='hours'} onClick={()=>setSettingsTab('hours')}>{t("常態營業時間")}</button>
  </div>
  {settingsTab==='rules'&&<>
   <p className="muted small">{t("數值保存在 Supabase，更新網站版本不會還原已儲存設定。變更後請確認既有訂位；修改規則不會自動取消原訂位。")}</p>
   <form onSubmit={e=>{e.preventDefault();void act(async()=>{const response=await request('settings','PATCH',settings);setSettings(response.settings);},t("訂位規則已儲存"));}}>
    <div className="two">{fields.map((key,i)=><label key={key}>{t(labels[i])}<input type="number" required value={settings[key]} onChange={e=>setSettings({...settings,[key]:Number(e.target.value)})}/></label>)}</div>
    <button type="submit" className="primary">{t("儲存設定")}</button>
   </form>
  </>}
  {settingsTab==='hours'&&<>
   <p className="muted small">{t("可設定週一至週日各自的營業日及多個時段。特殊休假與營業設定優先於此常態時間；修改時間不會自動取消已成立訂位。")}</p>
   <form onSubmit={saveWeeklyHours}>
    <div className="weekly-hours-list">{weekdays.map(({id,label})=>{const day=weeklyHours.find(d=>d.weekday===id);if(!day)return null;return <section key={id} className="weekly-day">
     <div className="weekly-day-header">
      <h3>{t(label)}</h3>
      <label className="weekly-day-state">當日狀態
       <select aria-label={t(label)+t(t("營業狀態"))} value={day.is_closed?'closed':'open'} onChange={e=>updateWeeklyDay(id,{is_closed:e.target.value==='closed',periods:e.target.value==='closed'?day.periods:day.periods.length?day.periods:[{start:'17:00',end:'21:00'}]})}>
        <option value="open">{t("營業")}</option><option value="closed">{t("公休")}</option>
       </select>
      </label>
     </div>
     {!day.is_closed&&<>
      {day.periods.map((p,i)=><div className="weekly-period" key={i}>
       <label>{t("開始時間")}<input type="time" required value={p.start} onChange={e=>updateWeeklyPeriod(id,i,'start',e.target.value)}/></label>
       <label>{t("結束時間")}<input type="time" required value={p.end} onChange={e=>updateWeeklyPeriod(id,i,'end',e.target.value)}/></label>
       <button type="button" disabled={day.periods.length===1} aria-label={t(label)+' '+(language==='es'?'Quitar turno ':t("移除第"))+(i+1)+(language==='es'?'':t("個時段"))} onClick={()=>updateWeeklyDay(id,{periods:day.periods.filter((_,j)=>j!==i)})}>{t("移除")}</button>
      </div>)}
      <button type="button" className="weekly-add" disabled={day.periods.length>=8} onClick={()=>updateWeeklyDay(id,{periods:[...day.periods,{start:'12:00',end:'14:00'}]})}>{t("＋ 新增時段")}</button>
     </>}
     {day.is_closed&&<p className="muted small">{t("公休，不開放訂位")}</p>}
    </section>;})}</div>
    <div className="weekly-save"><button className="primary" type="submit">{t("儲存常態營業時間")}</button></div>
   </form>
  </>}
 </>}
 </section>;
}