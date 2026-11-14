'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
type Reservation={confirmation_code:string;guest_name:string;guest_phone:string;party_size:number;starts_at:string;notes:string;status:string;updated_at:string;can_manage:boolean};
const format=(iso:string)=>new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
export default function ManageReservation(){
 const [code,setCode]=useState(''),[phone,setPhone]=useState('');
 const [booking,setBooking]=useState<Reservation|null>(null);
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const [error,setError]=useState(''),[confirm,setConfirm]=useState(false),[cancelled,setCancelled]=useState(false);
 useEffect(()=>{let active=true;fetch('/api/customer-booking',{cache:'no-store'})
  .then(r=>r.ok?r.json():null).then(v=>{if(active&&v?.reservation)setBooking(v.reservation);})
  .catch(()=>{}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};},[]);
 async function verify(e:React.FormEvent){e.preventDefault();if(busy)return;
  setBusy(true);setError('');
  try{const response=await fetch('/api/customer-booking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'verify',code:code.trim(),phone})});
   const data=await response.json();if(!response.ok){setError(data.error||'查詢失敗');return;}setBooking(data.reservation);
  }catch{setError('網路連線失敗，請稍後再試');}finally{setBusy(false);}
 }
 async function cancel(){if(!booking||busy)return;setBusy(true);setError('');
  try{const response=await fetch('/api/customer-booking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cancel',expectedUpdatedAt:booking.updated_at})});
   const data=await response.json();if(!response.ok){setError(data.error||'取消失敗');setConfirm(false);return;}
   setBooking(data.reservation);setCancelled(true);setConfirm(false);
  }catch{setError('網路連線失敗，原訂位未確認取消，請重新查詢');setConfirm(false);}finally{setBusy(false);}
 }
 return <section className="panel narrow">
  <div className="eyebrow">MANAGE RESERVATION</div><h1>{cancelled?'訂位已取消':booking?'您的訂位資訊':'取消／修改訂位資訊'}</h1>
  {loading?<p className="muted">查詢中…</p>:cancelled&&booking?<>
   <div className="receipt"><p>訂位編號：{booking.confirmation_code}</p><p>原訂位：{format(booking.starts_at)}</p><p>此筆訂位已取消，無法自行恢復。</p></div>
   <Link href="/reserve/new" className="booking-link-primary">重新預約</Link>
  </>:booking?<>
   <div className="receipt">
    <p>訂位編號：<strong>{booking.confirmation_code}</strong></p>
    <p>姓名：{booking.guest_name}</p><p>電話：{booking.guest_phone}</p>
    <p>日期時間：{format(booking.starts_at)}</p><p>人數：{booking.party_size} 位</p>
    <p>備註：{booking.notes||'無'}</p>
    <p>狀態：{booking.status==='confirmed'?'已確認':booking.status==='cancelled'?'已取消':booking.status}</p>
   </div>
   {booking.can_manage?<div className="booking-manage-actions">
    <Link href="/reserve/manage/edit" className="booking-link-primary">修改訂位</Link>
    <button type="button" onClick={()=>setConfirm(true)} disabled={busy}>取消訂位</button>
   </div>:<p className="notice">此筆訂位目前無法線上修改或取消，如需協助請聯絡餐廳。</p>}
   {confirm&&<div className="booking-modal-backdrop" role="presentation">
    <div className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
     <h2 id="cancel-title">確定要取消這筆訂位嗎？</h2>
     <p>訂位：{format(booking.starts_at)}，{booking.party_size} 位。</p>
     <p>取消後無法自行恢復，如需再次用餐請重新預約。</p>
     <div className="booking-manage-actions">
      <button type="button" onClick={()=>setConfirm(false)} disabled={busy}>返回</button>
      <button type="button" className="booking-danger" onClick={cancel} disabled={busy}>{busy?'取消中…':'確定取消訂位'}</button>
     </div>
    </div>
   </div>}
   <p className="center small"><button type="button" onClick={()=>{setBooking(null);setError('');}}>查詢其他訂位</button></p>
  </>:<form onSubmit={verify}>
   <p className="muted">請輸入訂位成功時取得的訂單編號，以及訂位時填寫的手機號碼。</p>
   <label>訂單編號<input value={code} required maxLength={32} autoComplete="off" onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="請輸入訂位編號"/></label>
   <label>手機號碼<input type="tel" inputMode="numeric" value={phone} required pattern="09[0-9]{8}" maxLength={10} autoComplete="tel-national" onChange={e=>setPhone(e.target.value.replace(/\D/g,'').slice(0,10))} placeholder="09xxxxxxxx"/></label>
   <button className="primary full" disabled={busy}>{busy?'查詢中…':'查詢訂位'}</button>
  </>}
  {error&&<p role="alert" className="error">{error}</p>}
  <p className="center"><Link href="/reserve" className="booking-text-link">返回訂位服務</Link></p>
 </section>;
}