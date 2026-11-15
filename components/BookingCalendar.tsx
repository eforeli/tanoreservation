'use client';

import {useEffect,useId,useRef,useState} from 'react';
import {ChevronDown} from 'lucide-react';

type CalendarData={today:string;lastDate:string;windowDays:number;closedDates:string[]};
const weekdays=['日','一','二','三','四','五','六'];
const monthStart=(date:string)=>new Date(date.slice(0,7)+'-01T00:00:00Z');
const isoDate=(date:Date)=>date.toISOString().slice(0,10);

export default function BookingCalendar({date,onSelect}:{date:string;onSelect:(date:string)=>void}){
 const id=useId();
 const trigger=useRef<HTMLButtonElement>(null);
 const [data,setData]=useState<CalendarData|null>(null);
 const [open,setOpen]=useState(false);
 const [month,setMonth]=useState('');
 const [showClosedNotice,setShowClosedNotice]=useState(false);
 const [failed,setFailed]=useState(false);
 const [attempt,setAttempt]=useState(0);

 useEffect(()=>{
  const controller=new AbortController();
  fetch('/api/booking-calendar',{cache:'no-store',signal:controller.signal})
   .then(async response=>{
    if(!response.ok)throw Error();
    const calendar:CalendarData=await response.json();
    setData(calendar);
    setMonth(calendar.today.slice(0,7));
   })
   .catch(()=>{if(!controller.signal.aborted)setFailed(true);});
  return()=>controller.abort();
 },[attempt]);

 function close(){
  setOpen(false);
  setShowClosedNotice(false);
  trigger.current?.focus();
 }

 function shiftMonth(amount:number){
  const next=monthStart(month);
  next.setUTCMonth(next.getUTCMonth()+amount);
  setMonth(isoDate(next).slice(0,7));
  setShowClosedNotice(false);
 }

 const first=data?data.today.slice(0,7):'';
 const last=data?data.lastDate.slice(0,7):'';
 const calendarStart=month?monthStart(month):null;
 const dayCount=calendarStart?new Date(Date.UTC(calendarStart.getUTCFullYear(),calendarStart.getUTCMonth()+1,0)).getUTCDate():0;

 return <div className="date-field" onKeyDown={event=>{
  if(event.key==='Escape'&&open){event.preventDefault();close();}
 }}>
  <label htmlFor={id+'-trigger'}>用餐日期</label>
  <button ref={trigger} id={id+'-trigger'} type="button" className="calendar-trigger"
   aria-expanded={open} aria-controls={id+'-calendar'} aria-describedby={data?id+'-window':undefined}
   onClick={()=>{
    if(data&&!open){
     const selected=date.slice(0,7);
     setMonth(selected>=first&&selected<=last?selected:first);
    }
    setShowClosedNotice(false);
    setOpen(!open);
   }}>
   {date||'選擇日期'}
   <ChevronDown size={18} aria-hidden="true" focusable="false"/>
  </button>
  {data&&<p className="muted small calendar-hint" id={id+'-window'}>僅開放提前{data.windowDays}天訂位</p>}
  <div id={id+'-calendar'} hidden={!open} className="calendar-picker">
   {!data&&(!failed?<p role="status">載入可預約日期中…</p>:<>
    <p role="alert">暫時無法讀取可預約日期</p>
    <button type="button" onClick={()=>{setFailed(false);setAttempt(attempt+1);}}>重新載入</button>
   </>)}
   {data&&calendarStart&&<>
    <div className="calendar-nav">
     <button type="button" aria-label="上個月" disabled={month<=first} onClick={()=>shiftMonth(-1)}>‹</button>
     <span aria-live="polite">{calendarStart.getUTCFullYear()} 年 {calendarStart.getUTCMonth()+1} 月</span>
     <button type="button" aria-label="下個月" disabled={month>=last} onClick={()=>shiftMonth(1)}>›</button>
    </div>
    <div className="calendar-days">
     {weekdays.map(day=><span key={day} aria-hidden="true">{day}</span>)}
     {Array.from({length:calendarStart.getUTCDay()},(_,i)=><span key={'blank-'+i} aria-hidden="true"/>)}
     {Array.from({length:dayCount},(_,i)=>{
      const value=month+'-'+String(i+1).padStart(2,'0');
      const closed=data.closedDates.includes(value);
      const past=value<data.today;
      const unavailable=closed||value>data.lastDate;
      return <button key={value} type="button" disabled={past}
       className={unavailable?'calendar-unavailable':undefined}
       aria-pressed={unavailable?undefined:date===value}
       aria-label={closed?value+' 公休':unavailable?value+' 超出預約範圍':value}
       onClick={()=>{
        if(unavailable){setShowClosedNotice(true);return;}
        onSelect(value);close();
       }}>{i+1}</button>;
     })}
    </div>
    <div role="status">{showClosedNotice&&<p className="calendar-closed-notice">本日公休</p>}</div>
   </>}
  </div>
 </div>;
}
