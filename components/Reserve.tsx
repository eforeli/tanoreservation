'use client';
import {useEffect,useState} from 'react';
import {useLanguage} from '@/components/SiteShell';

function taiwanToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
type Receipt={confirmation_code:string;starts_at:string;party_size:number;guest_name:string;guest_phone:string};
const strings={
 zh:{
  bookingConfirmed:'訂位成功',bookingCode:'訂位編號',guest:'姓名',persons:'人數',date:'日期',time:'時間',personUnit:' 位',
  copyTitle:'複製訂位資料',copied:'訂位資訊已複製',copyFailed:'複製失敗，請手動截圖保存',
  receiptNotice:'請複製訂位資料，貼到官方LINE，餐廳將核對確認。',changeNotice:'＊若需取消或修改訂位資訊，請提早Line通知我們。',
  heading:'預約 TANO 的一席',tagline:'炭火慢慢逼出肉香，也定下 TANO 的味道。',
  diningDate:'用餐日期',party:'用餐人數',chooseTime:'選擇入席時間',loading:'查詢可訂時段中…',empty:'當日目前沒有可訂時段',closed:'本日公休',full:'本日訂位額滿',unavailable:'目前沒有可開放的訂位時段',
  contactName:'聯絡姓名',phone:'手機號碼',namePlaceholder:'請填寫姓名',phonePlaceholder:'09xxxxxxxx',
  notes:'備註（選填）',notesPlaceholder:'例如：過敏資訊',requiredName:'請填寫聯絡姓名',requiredPhone:'請填寫手機號碼',phoneFormat:'10 碼手機號碼',
  terms:'尖峰時段(若客滿)用餐時間為 90 分鐘，離峰時段則不限時。\n送出即同意訂位保留與取消規則依餐廳為主。',
  submit:'確認訂位',submitting:'送出中…',largeParty:'6 人以上請透過 TANO LINE 官方帳號聯絡餐廳。',
  connectionFailed:'連線失敗，請重新整理',notComplete:'訂位未完成',networkError:'網路錯誤，請確認訂位是否成立再重試',
 },
 en:{
  bookingConfirmed:'Reservation Confirmed',bookingCode:'Reservation Code',guest:'Name',persons:'Party Size',date:'Date',time:'Time',personUnit:' guests',
  copyTitle:'Copy all reservation details',copied:'Reservation details copied',copyFailed:'Unable to copy. Please save a screenshot instead.',
  receiptNotice:'Copy your reservation details and send them to our official LINE account',changeNotice:'*To cancel or change your reservation, please notify us early via LINE.',
  heading:'Reserve a Table at TANO',tagline:'Slowly grilled over charcoal, crafted with the unmistakable taste of TANO.',
  diningDate:'Dining Date',party:'Party Size',chooseTime:'Select an Arrival Time',loading:'Checking available times…',empty:'No available times for this date',closed:'Closed today',full:'Fully booked today',unavailable:'No booking times available',
  contactName:'Contact Name',phone:'Mobile Number',namePlaceholder:'Enter your name',phonePlaceholder:'09xxxxxxxx',
  notes:'Notes (optional)',notesPlaceholder:'e.g., food allergies',requiredName:'Please enter your name',requiredPhone:'Please enter your mobile number',phoneFormat:'10-digit mobile number',
  terms:'During peak hours (when fully booked), dining time is limited to 90 minutes. Otherwise, stay as long as you like.\nBy submitting, you agree that the restaurant’s reservation holding and cancellation policies apply.',
  submit:'Confirm Reservation',submitting:'Submitting…',largeParty:'For parties of 6 or more, please contact TANO through our official LINE account.',
  connectionFailed:'Connection failed. Please refresh the page.',notComplete:'Reservation could not be completed',networkError:'Network error. Please check whether your reservation was confirmed before trying again.',
 }
} as const;

export default function Reserve(){
 const {language}=useLanguage();const t=strings[language];
 const [date,setDate]=useState(taiwanToday),[party,setParty]=useState(2),[slots,setSlots]=useState<string[]>([]),[time,setTime]=useState(''),[dayState,setDayState]=useState<'closed'|'full'|'unavailable'|'available'>('unavailable'),[name,setName]=useState(''),[phone,setPhone]=useState(''),[notes,setNotes]=useState('');
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState<Receipt|null>(null);
 const [key]=useState(()=>crypto.randomUUID()),[copied,setCopied]=useState(false);
 useEffect(()=>{let live=true;setTime('');setError('');setLoading(true);fetch(`/api/availability?date=${date}&partySize=${party}`,{cache:'no-store'})
  .then(r=>r.json()).then(x=>{if(live){setSlots(x.slots||[]);setDayState(x.state||'unavailable');if(x.error)setError(language==='zh'?x.error:t.notComplete);}})
  .catch(()=>{if(live)setError(t.connectionFailed);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[date,party,language,t.connectionFailed,t.notComplete]);
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2000);return()=>clearTimeout(timer);},[copied]);
 async function submit(e:React.FormEvent){e.preventDefault();if(!time||busy)return;
  if(!/^09\d{8}$/.test(phone)){setError(t.phoneFormat);return;}
  if(!name.trim()){setError(t.requiredName);return;}
  setBusy(true);setError('');
  try{const r=await fetch('/api/reservations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date,time,partySize:party,name,phone,notes,idempotencyKey:key,source:'web'})});
   const v=await r.json();if(!r.ok){setError(language==='zh'?(v.error||t.notComplete):t.notComplete);return;}setReceipt({...v.reservation,guest_phone:phone});}
  catch{setError(t.networkError);}finally{setBusy(false);}
 }
 if(receipt){
  const when=new Date(receipt.starts_at);
  const calendarDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(when).replace(/-/g,'/');
  const weekday=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',weekday:'short'}).format(when);
  const dateText=`${calendarDate} (${weekday}.)`;
  const timeText=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}).format(when);
  const copyText=[`${t.bookingCode}：${receipt.confirmation_code}`,`${t.guest}：${receipt.guest_name}`,`${t.persons}：${receipt.party_size}`,`${t.date}：${dateText}`,`${t.time}：${timeText}`,`${t.phone}：${receipt.guest_phone}`,'',t.changeNotice].join('\n');
  return <section className="panel narrow">
   <div className="eyebrow">BOOKING CONFIRMED</div><h1>{t.bookingConfirmed}</h1>
   <div className="receipt">
    <p>{t.bookingCode}：{receipt.confirmation_code}</p>
    <p>{t.guest}：{receipt.guest_name}</p>
    <p>{t.persons}：{receipt.party_size}</p>
    <p>{t.date}：{dateText}</p>
    <p>{t.time}：{timeText}</p>
    <p>{t.phone}：{receipt.guest_phone}</p>
    <p className="receipt-change-notice">{t.changeNotice}</p>
   </div>
   {copied&&<div role="status" className="copy-popup">{t.copied}</div>}
   {error&&<p role="alert" className="error">{error}</p>}
   <p className="receipt-notice receipt-highlight">請<strong>複製</strong>訂位資料，貼到<strong>官方LINE</strong>，餐廳將核對確認。</p>
   <div className="receipt-copy-container"><button type="button" className="primary receipt-copy-button" onClick={async()=>{try{await navigator.clipboard.writeText(copyText);setCopied(true);}catch{setError(t.copyFailed);}}}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span>{t.copyTitle}</span></button></div>
  </section>;
 }
 return <section className="panel narrow">
  <div className="eyebrow">RESERVATION</div><h1>{t.heading}</h1><p className="muted">{t.tagline}</p>
  <form onSubmit={submit}>
   <div className="two">
    <label className="date-field">{t.diningDate}<input type="date" required min={taiwanToday()} value={date} onChange={e=>setDate(e.target.value)}/></label>
    <label>{t.party}<select value={party} onChange={e=>setParty(Number(e.target.value))}>{[1,2,3,4,5].map(n=><option key={n} value={n}>{n}{t.personUnit}</option>)}</select></label>
   </div>
   <label>{t.chooseTime}</label>
   <div className="slots">{loading?t.loading:slots.length?slots.map(s=><button type="button" className={s===time?'selected':''} key={s} onClick={()=>setTime(s)}>{s}</button>):dayState==='closed'?t.closed:dayState==='full'?t.full:t.unavailable}</div>
   <div className="two">
    <label>{t.contactName} <span className="required-star" aria-hidden="true">*</span><input value={name} required maxLength={80} autoComplete="name" onChange={e=>setName(e.target.value)} placeholder={t.namePlaceholder}/></label>
    <label>{t.phone} <span className="required-star" aria-hidden="true">*</span>
     <input type="tel" inputMode="numeric" autoComplete="tel-national" pattern="09[0-9]{8}" minLength={10} maxLength={10} required value={phone}
      onInvalid={e=>{const input=e.currentTarget;input.setCustomValidity(input.validity.valueMissing?t.requiredPhone:t.phoneFormat);}}
      onChange={e=>{e.currentTarget.setCustomValidity('');setPhone(e.target.value.replace(/\D/g,'').slice(0,10));}}
      placeholder={t.phonePlaceholder}/>
    </label>
   </div>
   <label>{t.notes}<textarea maxLength={500} value={notes} onChange={e=>setNotes(e.target.value)} placeholder={t.notesPlaceholder} rows={3}/></label>
   <p className="muted small reservation-terms">{t.terms}</p>
   {error&&<p role="alert" className="error">{error}</p>}
   <button className="primary full" disabled={!time||busy||loading}>{busy?t.submitting:t.submit}</button>
  </form>
  <p className="muted center">{t.largeParty}</p>
 </section>;
}
