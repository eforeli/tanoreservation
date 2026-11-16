import {NextRequest} from 'next/server';
import {adminUser,db,jsonError,rpc,privateJson} from '@/lib/server';
import {booking,day,settingsSchema} from '@/lib/schema';
import {z} from 'zod';
import {localDay,dateTimeTaipei} from '@/lib/constants';
export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
const validUuid=(s:string)=>z.uuid().safeParse(s).success;
const decode=async(req:NextRequest)=>{try{return await req.json();}catch{return null;}};
const fail=(message:string)=>jsonError(message,400);
const expectedDbErrors=new Map<string,[number,string]>([
 ['reservation changed',[409,'訂位資料已變更，請重新開啟訂位再試']],
 ['invalid transition',[409,'訂位狀態已變更，請重新整理']],
 ['unavailable',[409,'該時段目前無法預約，請重新選擇']],
 ['not eligible',[400,'訂位資料或時段不符合規則']],
 ['not found',[404,'找不到紀錄']],
 ['invalid period',[400,'時段不合法或彼此重疊']],
 ['unknown table',[400,'指定的餐桌不存在']],
 ['已有訂位，無法鎖桌！',[409,'已有訂位，無法鎖桌！']],
 ['該時段已有鎖桌紀錄',[409,'該時段已有鎖桌紀錄']],
]);
function adminDbError(error:{code?:string;message:string}|null){
 const expected=error?.code==='P0001'?expectedDbErrors.get(error.message):undefined;
 if(expected)return jsonError(expected[1],expected[0]);
 console.error('admin database operation failed',error?.code);
 return jsonError('暫時無法完成操作，請稍後再試',500);
}
const periodSchema=z.object({start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)});
const fixedSeatingTimes=z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(24).default([]);
const fixedTimeError='固定入席時間不可重複，且須在營業時段內';
function validSeatings(times:string[],periods:{start:string;end:string}[]){
 return new Set(times).size===times.length && times.every(time=>
  periods.some(period=>period.start<=time && time<period.end)
 );
}
const specialSchema=z.object({business_date:day,is_closed:z.boolean(),notes:z.string().max(500),fixed_seating_times:fixedSeatingTimes,periods:z.array(periodSchema).max(8),closure_periods:z.array(periodSchema).max(8).default([]),mode:z.enum(['closed','partial','open'])}).superRefine((v,ctx)=>{
 if(v.mode==='open'&&!validSeatings(v.fixed_seating_times,v.periods))ctx.addIssue({code:'custom',message:fixedTimeError});
 if(v.mode==='open'&&v.periods.length===0)ctx.addIssue({code:'custom',message:'特別營業至少需要一個時段'});
 if(v.mode==='partial'&&v.closure_periods.length===0)ctx.addIssue({code:'custom',message:'部分休息至少需要一個時段'});
 for(const periods of [v.periods,v.closure_periods]){
  const ordered=[...periods].sort((a,b)=>a.start.localeCompare(b.start));
  ordered.forEach((p,i)=>{if(p.end<=p.start||(i>0&&p.start<ordered[i-1].end))ctx.addIssue({code:'custom',message:'時段不合法或彼此重疊'});});
 }
});
const weeklyPeriod=z.object({start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)});
const weeklySchema=z.array(z.object({weekday:z.number().int().min(0).max(6),is_closed:z.boolean(),periods:z.array(weeklyPeriod).max(8),fixed_seating_times:fixedSeatingTimes})).length(7).superRefine((days,ctx)=>{
 if(new Set(days.map(d=>d.weekday)).size!==7)ctx.addIssue({code:'custom',message:'必須提供週一至週日七天的設定'});
 days.forEach(d=>{
  if(!d.is_closed&&!validSeatings(d.fixed_seating_times,d.periods))ctx.addIssue({code:'custom',message:fixedTimeError});
  if(!d.is_closed&&d.periods.length===0)ctx.addIssue({code:'custom',message:'營業日必須至少有一個時段'});
  const sorted=[...d.periods].sort((a,b)=>a.start.localeCompare(b.start));
  sorted.forEach((period,i)=>{
   if(period.end<=period.start||(i>0&&period.start<sorted[i-1].end))ctx.addIssue({code:'custom',message:'營業時段不可重疊，結束必須晚於開始'});
  });
 });
});
export async function GET(req:NextRequest,{params}:Context){
 const user=await adminUser(req);if(!user)return jsonError('未授權',401);
 const p=(await params).path;const s=db();
 if(p[0]==='reservation-log'&&p.length===1){
  const q=req.nextUrl.searchParams;
  const page=Number(q.get('page')||1);
  const dateFrom=q.get('from')||'',dateTo=q.get('to')||'';
  const code=(q.get('code')||'').trim().toUpperCase();
  const phone=(q.get('phone')||'').trim();
  const actor=q.get('actor')||'all';
  if(!Number.isInteger(page)||page<1||page>10000||code.length>32||phone.length>24||!['all','customer','admin'].includes(actor)
   ||(dateFrom&&!day.safeParse(dateFrom).success)||(dateTo&&!day.safeParse(dateTo).success)
   ||(dateFrom&&dateTo&&dateFrom>dateTo))return fail('篩選條件無效');
  let query=s.from('reservation_change_log').select('*',{count:'exact'}).order('changed_at',{ascending:false}).order('id',{ascending:false});
  if(dateFrom)query=query.gte('changed_at',new Date(dateTimeTaipei(dateFrom,'00:00')).toISOString());
  if(dateTo)query=query.lt('changed_at',new Date(new Date(dateTimeTaipei(dateTo,'00:00')).getTime()+86400000).toISOString());
  if(code)query=query.ilike('confirmation_code','%'+code.replace(/[%_,]/g,'')+'%');
  if(phone)query=query.ilike('guest_phone','%'+phone.replace(/[%_,]/g,'')+'%');
  if(actor!=='all')query=query.eq('actor',actor);
  const {data,error,count}=await query.range((page-1)*10,page*10-1);
  if(error){console.error('reservation log',error.code);return jsonError('無法查詢訂位 Log',500);}
  return privateJson({items:data||[],total:count||0,page,pageSize:10});
 }
 if(p[0]==='reservations'){
  const date=req.nextUrl.searchParams.get('date')||'';if(!day.safeParse(date).success)return fail('日期錯誤');
  const days=Number(req.nextUrl.searchParams.get('days')||1);if(![1,7,30].includes(days))return fail('查詢天數無效');
  const begin=dateTimeTaipei(date,'00:00'),end=new Date(new Date(begin).getTime()+days*86400000).toISOString();
  const {data,error}=await s.from('reservations').select('id,confirmation_code,guest_name,guest_phone,party_size,starts_at,created_at,updated_at,status,notes,source,reservation_tables(restaurant_tables(code))').neq('status','cancelled').gte('starts_at',begin).lt('starts_at',end).order('starts_at');
  if(error)return adminDbError(error);return privateJson({items:data});
 }
 if(p[0]==='blocks'){
  if(req.nextUrl.searchParams.get('scope')==='future'){
   const now=new Date().toISOString();
   const {data,error}=await s.from('table_blocks').select('*,restaurant_tables(code)').is('released_at',null).or(`end_at.is.null,end_at.gt.${now}`).order('start_at');
   if(error)return adminDbError(error);return privateJson({items:data});
  }
  const date=req.nextUrl.searchParams.get('date')||'';if(!day.safeParse(date).success)return fail('日期錯誤');
  const from=dateTimeTaipei(date,'00:00'),to=new Date(new Date(from).getTime()+86400000).toISOString();
  const {data,error}=await s.from('table_blocks').select('*,restaurant_tables(code)').lt('start_at',to).or(`end_at.is.null,end_at.gt.${from}`).is('released_at',null).order('start_at');
  if(error)return adminDbError(error);return privateJson({items:data});
 }
 if(p[0]==='special'&&p[1]==='booking-count'&&p.length===2){
  const date=req.nextUrl.searchParams.get('date');
  if(!day.safeParse(date).success)return fail('日期錯誤');
  const start=date+'T00:00:00+08:00';
  const end=new Date(new Date(start).getTime()+86400000).toISOString();
  const {count,error}=await s.from('reservations').select('id',{count:'exact',head:true})
   .in('status',['confirmed','seated']).gte('starts_at',start).lt('starts_at',end);
  if(error)return adminDbError(error);
  return privateJson({count:count??0});
 }
 if(p[0]==='special'){const today=localDay();const {data,error}=await s.from('special_business_hours').select('*').gte('business_date',today).order('business_date');if(error)return adminDbError(error);return privateJson({items:data});}
 if(p[0]==='settings'){const [{data:settings,error},{data:hours,error:hoursError}]=await Promise.all([s.from('booking_settings').select('*').eq('id',1).single(),s.from('weekly_business_hours').select('*').order('weekday')]);if(error||hoursError)return adminDbError(error||hoursError);return privateJson({settings,hours});}
 return jsonError('路由不存在',404);
}
export async function POST(req:NextRequest,{params}:Context){
 const user=await adminUser(req);if(!user)return jsonError('未授權',401);
 const p=(await params).path;const body=await decode(req);if(!body)return fail('格式錯誤');
 if(p[0]==='reservations'&&p.length===1){const v=booking.safeParse(body);if(!v.success)return fail('訂位資料無效');const b=v.data;if(b.source==='web')return fail('請選擇人工訂位來源');const {data,error}=await rpc('create_booking',{p_date:b.date,p_time:b.time,p_party_size:b.partySize,p_name:b.name,p_phone:b.phone,p_notes:b.notes,p_source:b.source,p_key:b.idempotencyKey,p_actor:user.id});if(error)return adminDbError(error);return privateJson({reservation:data});}
 if(p[0]==='reservations'&&p.length===3&&p[2]==='cancel'&&validUuid(p[1])){const {error}=await rpc('admin_cancel_booking',{p_id:p[1],p_reason:String(body.reason||''),p_actor:user.id});if(error)return adminDbError(error);return privateJson({ok:true});}
 if(p[0]==='blocks'&&p.length===1){const schema=z.object({tableCode:z.enum(['A1','A2','A3','A4','A5']),start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true}).nullable(),reason:z.string().max(500)});const v=schema.safeParse(body);if(!v.success)return fail('鎖桌資料錯誤');const {data,error}=await rpc('admin_block_table',{p_table_code:v.data.tableCode,p_start:v.data.start,p_end:v.data.end,p_reason:v.data.reason,p_actor:user.id});if(error)return adminDbError(error);return privateJson({result:data});}
 if(p[0]==='blocks'&&p.length===3&&p[2]==='release'&&validUuid(p[1])){const {error}=await rpc('admin_unblock_table',{p_id:p[1],p_actor:user.id});if(error)return adminDbError(error);return privateJson({ok:true});}
 if(p[0]==='special'&&p.length===1){const v=specialSchema.safeParse(body);if(!v.success)return fail(v.error.issues.some(issue=>issue.message===fixedTimeError)?fixedTimeError:'特殊營業設定無效，請確認時段沒有重疊');const d=v.data;const periods=d.mode==='open'?[...d.periods].sort((a,b)=>a.start.localeCompare(b.start)):[];const closure_periods=d.mode==='partial'?[...d.closure_periods].sort((a,b)=>a.start.localeCompare(b.start)):[];const payload={business_date:d.business_date,is_closed:d.mode==='closed',notes:d.notes,periods,closure_periods,fixed_seating_times:d.mode==='open'?[...d.fixed_seating_times].sort():[],opens_at:periods[0]?.start||null,closes_at:periods[periods.length-1]?.end||null};const {error}=await db().from('special_business_hours').upsert(payload,{onConflict:'business_date'});if(error)return adminDbError(error);await db().from('admin_audit_logs').insert({actor_user_id:user.id,action:'upsert',entity_type:'special_business_hours',new_value:payload});const begin=dateTimeTaipei(d.business_date,'00:00'),end=new Date(new Date(begin).getTime()+86400000).toISOString();const {count}=await db().from('reservations').select('id',{count:'exact',head:true}).in('status',['confirmed','seated']).gte('starts_at',begin).lt('starts_at',end);return privateJson({ok:true,existingBookings:count||0});}
 return jsonError('路由不存在',404);
}
export async function PATCH(req:NextRequest,{params}:Context){
 const user=await adminUser(req);if(!user)return jsonError('未授權',401);
 const p=(await params).path;const body=await decode(req);if(!body)return fail('資料格式錯誤');
 if(p[0]==='reservations'&&p.length===2&&validUuid(p[1])){const v=booking.omit({idempotencyKey:true,source:true}).extend({status:z.enum(['confirmed','seated','completed','no_show']),expectedUpdatedAt:z.iso.datetime({offset:true})}).safeParse(body);if(!v.success)return fail('修改內容無效');const b=v.data;const {error}=await rpc('admin_update_booking_versioned',{p_id:p[1],p_date:b.date,p_time:b.time,p_party:b.partySize,p_name:b.name,p_phone:b.phone,p_notes:b.notes,p_status:b.status,p_actor:user.id,p_expected_updated_at:b.expectedUpdatedAt});if(error)return adminDbError(error);return privateJson({ok:true});}
 if(p[0]==='blocks'&&p.length===2&&validUuid(p[1])){const schema=z.object({tableCode:z.enum(['A1','A2','A3','A4','A5']),start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true}).nullable(),reason:z.string().max(500)});const v=schema.safeParse(body);if(!v.success)return fail('鎖桌資料錯誤');const {error}=await rpc('admin_edit_block_table',{p_id:p[1],p_table_code:v.data.tableCode,p_start:v.data.start,p_end:v.data.end,p_reason:v.data.reason,p_actor:user.id});if(error)return adminDbError(error);return privateJson({ok:true});}
 if(p[0]==='weekly-hours'){
  const parsed=weeklySchema.safeParse(body);
  if(!parsed.success)return fail(parsed.error.issues.some(issue=>issue.message===fixedTimeError)?fixedTimeError:'常態營業時間無效，請確認七天資料完整且時段不重疊');
  const rows=parsed.data.map(d=>{
   const periods=d.is_closed?[]:[...d.periods].sort((a,b)=>a.start.localeCompare(b.start));
   return {weekday:d.weekday,is_closed:d.is_closed,periods,fixed_seating_times:d.is_closed?[]:[...d.fixed_seating_times].sort(),opens_at:periods[0]?.start||null,closes_at:periods[periods.length-1]?.end||null};
  });
  const s=db();
  const {data:previous,error:readError}=await s.from('weekly_business_hours').select('*').order('weekday');
  if(readError)return adminDbError(readError);
  const {error}=await s.from('weekly_business_hours').upsert(rows,{onConflict:'weekday'});
  if(error)return adminDbError(error);
  const {data:saved,error:verifyError}=await s.from('weekly_business_hours').select('*').order('weekday');
  if(verifyError||!saved||saved.length!==7)return jsonError('資料已提交，但重新讀取失敗，請重新整理確認',500);
  await s.from('admin_audit_logs').insert({actor_user_id:user.id,action:'update',entity_type:'weekly_business_hours',old_value:previous,new_value:rows});
  return privateJson({ok:true,hours:saved});
 }
 if(p[0]==='settings'){
  const v=settingsSchema.safeParse(body);if(!v.success)return fail('設定值不合法');
  const {data:old}=await db().from('booking_settings').select('*').eq('id',1).single();
  const {data:saved,error}=await db().from('booking_settings').update({...v.data,updated_at:new Date().toISOString()}).eq('id',1).select('*').single();if(error)return adminDbError(error);
  await db().from('admin_audit_logs').insert({actor_user_id:user.id,action:'update',entity_type:'booking_settings',old_value:old,new_value:v.data});return privateJson({ok:true,settings:saved});
 }
 return jsonError('路由不存在',404);
}
export async function DELETE(req:NextRequest,{params}:Context){
 const user=await adminUser(req);if(!user)return jsonError('未授權',401);
 const p=(await params).path;
 if(p[0]==='special'&&p.length===2&&day.safeParse(p[1]).success){const s=db();const {data:old,error:readError}=await s.from('special_business_hours').select('*').eq('business_date',p[1]).maybeSingle();if(readError)return adminDbError(readError);if(!old)return jsonError('找不到紀錄',404);const {error}=await s.from('special_business_hours').delete().eq('business_date',p[1]);if(error)return adminDbError(error);await s.from('admin_audit_logs').insert({actor_user_id:user.id,action:'delete',entity_type:'special_business_hours',entity_id:old.id,old_value:old});return privateJson({ok:true});}
 return jsonError('路由不存在',404);
}
