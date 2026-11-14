import {NextRequest,NextResponse} from 'next/server';
import {adminUser,db,jsonError,rpc} from '@/lib/server';
import {booking,day,settingsSchema} from '@/lib/schema';
import {z} from 'zod';
export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
const validUuid=(s:string)=>z.uuid().safeParse(s).success;
const decode=async(req:NextRequest)=>{try{return await req.json();}catch{return null;}};
const fail=(message:string)=>jsonError(message,400);
const specialSchema=z.object({business_date:day,is_closed:z.boolean(),notes:z.string().max(500),periods:z.array(z.object({start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)})).max(8)}).superRefine((v,ctx)=>{if(!v.is_closed&&v.periods.length===0)ctx.addIssue({code:'custom',message:'請填寫營業時段'});const ordered=[...v.periods].sort((a,b)=>a.start.localeCompare(b.start));ordered.forEach((p,i)=>{if(p.end<=p.start||(i>0&&p.start<ordered[i-1].end))ctx.addIssue({code:'custom',message:'營業時間重疊或不合法'});});});
const weeklyPeriod=z.object({start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)});
const weeklySchema=z.array(z.object({weekday:z.number().int().min(0).max(6),is_closed:z.boolean(),periods:z.array(weeklyPeriod).max(8)})).length(7).superRefine((days,ctx)=>{
 if(new Set(days.map(d=>d.weekday)).size!==7)ctx.addIssue({code:'custom',message:'必須提供週一至週日七天的設定'});
 days.forEach(d=>{
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
 if(p[0]==='reservations'){
  const date=req.nextUrl.searchParams.get('date')||'';if(!day.safeParse(date).success)return fail('日期錯誤');
  const days=Number(req.nextUrl.searchParams.get('days')||1);if(![1,7,30].includes(days))return fail('查詢天數無效');
  const begin=`${date}T00:00:00+08:00`,end=new Date(new Date(begin).getTime()+days*86400000).toISOString();
  const {data,error}=await s.from('reservations').select('*,reservation_tables(table_id,restaurant_tables(code))').gte('starts_at',begin).lt('starts_at',end).order('starts_at');
  if(error)return jsonError(error.message,500);return NextResponse.json({items:data});
 }
 if(p[0]==='blocks'){
  if(req.nextUrl.searchParams.get('scope')==='future'){
   const now=new Date().toISOString();
   const {data,error}=await s.from('table_blocks').select('*,restaurant_tables(code)').is('released_at',null).or(`end_at.is.null,end_at.gt.${now}`).order('start_at');
   if(error)return jsonError(error.message,500);return NextResponse.json({items:data});
  }
  const date=req.nextUrl.searchParams.get('date')||'';if(!day.safeParse(date).success)return fail('日期錯誤');
  const from=`${date}T00:00:00+08:00`,to=new Date(new Date(from).getTime()+86400000).toISOString();
  const {data,error}=await s.from('table_blocks').select('*,restaurant_tables(code)').lt('start_at',to).or(`end_at.is.null,end_at.gt.${from}`).is('released_at',null).order('start_at');
  if(error)return jsonError(error.message,500);return NextResponse.json({items:data});
 }
 if(p[0]==='special'){const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const {data,error}=await s.from('special_business_hours').select('*').gte('business_date',today).order('business_date');if(error)return jsonError(error.message,500);return NextResponse.json({items:data});}
 if(p[0]==='settings'){const [{data:settings,error},{data:hours,error:hoursError}]=await Promise.all([s.from('booking_settings').select('*').eq('id',1).single(),s.from('weekly_business_hours').select('*').order('weekday')]);if(error||hoursError)return jsonError(error?.message||hoursError?.message||'讀取營運設定失敗',500);return NextResponse.json({settings,hours});}
 return jsonError('路由不存在',404);
}
export async function POST(req:NextRequest,{params}:Context){
 const user=await adminUser(req);if(!user)return jsonError('未授權',401);
 const p=(await params).path;const body=await decode(req);if(!body)return fail('格式錯誤');
 if(p[0]==='reservations'&&p.length===1){const v=booking.safeParse(body);if(!v.success)return fail('訂位資料無效');const b=v.data;if(b.source==='web')return fail('請選擇人工訂位來源');const {data,error}=await rpc('create_booking',{p_date:b.date,p_time:b.time,p_party_size:b.partySize,p_name:b.name,p_phone:b.phone,p_notes:b.notes,p_source:b.source,p_key:b.idempotencyKey,p_actor:user.id});if(error)return fail(error.message);return NextResponse.json({reservation:data});}
 if(p[0]==='reservations'&&p.length===3&&p[2]==='cancel'&&validUuid(p[1])){const {error}=await rpc('admin_cancel_booking',{p_id:p[1],p_reason:String(body.reason||''),p_actor:user.id});if(error)return fail(error.message);return NextResponse.json({ok:true});}
 if(p[0]==='blocks'&&p.length===1){const schema=z.object({tableCode:z.enum(['A1','A2','A3','A4','A5']),start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true}).nullable(),reason:z.string().max(500)});const v=schema.safeParse(body);if(!v.success)return fail('鎖桌資料錯誤');const {data,error}=await rpc('admin_block_table',{p_table_code:v.data.tableCode,p_start:v.data.start,p_end:v.data.end,p_reason:v.data.reason,p_actor:user.id});if(error)return fail(error.message);return NextResponse.json({result:data});}
 if(p[0]==='blocks'&&p.length===3&&p[2]==='release'&&validUuid(p[1])){const {error}=await rpc('admin_unblock_table',{p_id:p[1],p_actor:user.id});if(error)return fail(error.message);return NextResponse.json({ok:true});}
 if(p[0]==='special'&&p.length===1){const v=specialSchema.safeParse(body);if(!v.success)return fail('特殊營業設定無效，請確認時段沒有重疊');const d=v.data;const periods=d.is_closed?[]:[...d.periods].sort((a,b)=>a.start.localeCompare(b.start));const payload={business_date:d.business_date,is_closed:d.is_closed,notes:d.notes,periods,opens_at:periods[0]?.start||null,closes_at:periods[periods.length-1]?.end||null};const {error}=await db().from('special_business_hours').upsert(payload,{onConflict:'business_date'});if(error)return fail(error.message);await db().from('admin_audit_logs').insert({actor_user_id:user.id,action:'upsert',entity_type:'special_business_hours',new_value:payload});const begin=`${d.business_date}T00:00:00+08:00`,end=new Date(new Date(begin).getTime()+86400000).toISOString();const {count}=await db().from('reservations').select('id',{count:'exact',head:true}).in('status',['confirmed','seated']).gte('starts_at',begin).lt('starts_at',end);return NextResponse.json({ok:true,existingBookings:count||0});}
 return jsonError('路由不存在',404);
}
export async function PATCH(req:NextRequest,{params}:Context){
 const user=await adminUser(req);if(!user)return jsonError('未授權',401);
 const p=(await params).path;const body=await decode(req);if(!body)return fail('資料格式錯誤');
 if(p[0]==='reservations'&&p.length===2&&validUuid(p[1])){const v=booking.omit({idempotencyKey:true,source:true}).extend({status:z.enum(['confirmed','seated','completed','no_show'])}).safeParse(body);if(!v.success)return fail('修改內容無效');const b=v.data;const {error}=await rpc('admin_update_booking',{p_id:p[1],p_date:b.date,p_time:b.time,p_party:b.partySize,p_name:b.name,p_phone:b.phone,p_notes:b.notes,p_status:b.status,p_actor:user.id});if(error)return fail(error.message);return NextResponse.json({ok:true});}
 if(p[0]==='blocks'&&p.length===2&&validUuid(p[1])){const schema=z.object({tableCode:z.enum(['A1','A2','A3','A4','A5']),start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true}).nullable(),reason:z.string().max(500)});const v=schema.safeParse(body);if(!v.success)return fail('鎖桌資料錯誤');const {error}=await rpc('admin_edit_block_table',{p_id:p[1],p_table_code:v.data.tableCode,p_start:v.data.start,p_end:v.data.end,p_reason:v.data.reason,p_actor:user.id});if(error)return fail(error.message);return NextResponse.json({ok:true});}
 if(p[0]==='weekly-hours'){
  const parsed=weeklySchema.safeParse(body);
  if(!parsed.success)return fail('常態營業時間無效，請確認七天資料完整且時段不重疊');
  const rows=parsed.data.map(d=>{
   const periods=d.is_closed?[]:[...d.periods].sort((a,b)=>a.start.localeCompare(b.start));
   return {weekday:d.weekday,is_closed:d.is_closed,periods,opens_at:periods[0]?.start||null,closes_at:periods[periods.length-1]?.end||null};
  });
  const s=db();
  const {data:previous,error:readError}=await s.from('weekly_business_hours').select('*').order('weekday');
  if(readError)return jsonError(readError.message,500);
  const {error}=await s.from('weekly_business_hours').upsert(rows,{onConflict:'weekday'});
  if(error)return fail(error.message);
  const {data:saved,error:verifyError}=await s.from('weekly_business_hours').select('*').order('weekday');
  if(verifyError||!saved||saved.length!==7)return jsonError('資料已提交，但重新讀取失敗，請重新整理確認',500);
  await s.from('admin_audit_logs').insert({actor_user_id:user.id,action:'update',entity_type:'weekly_business_hours',old_value:previous,new_value:rows});
  return NextResponse.json({ok:true,hours:saved});
 }
 if(p[0]==='settings'){
  const v=settingsSchema.safeParse(body);if(!v.success)return fail('設定值不合法');
  const {data:old}=await db().from('booking_settings').select('*').eq('id',1).single();
  const {data:saved,error}=await db().from('booking_settings').update({...v.data,updated_at:new Date().toISOString()}).eq('id',1).select('*').single();if(error)return fail(error.message);
  await db().from('admin_audit_logs').insert({actor_user_id:user.id,action:'update',entity_type:'booking_settings',old_value:old,new_value:v.data});return NextResponse.json({ok:true,settings:saved});
 }
 return jsonError('路由不存在',404);
}
export async function DELETE(req:NextRequest,{params}:Context){
 const user=await adminUser(req);if(!user)return jsonError('未授權',401);
 const p=(await params).path;
 if(p[0]==='special'&&p.length===2&&day.safeParse(p[1]).success){const s=db();const {data:old,error:readError}=await s.from('special_business_hours').select('*').eq('business_date',p[1]).maybeSingle();if(readError)return fail(readError.message);if(!old)return jsonError('找不到紀錄',404);const {error}=await s.from('special_business_hours').delete().eq('business_date',p[1]);if(error)return fail(error.message);await s.from('admin_audit_logs').insert({actor_user_id:user.id,action:'delete',entity_type:'special_business_hours',entity_id:old.id,old_value:old});return NextResponse.json({ok:true});}
 return jsonError('路由不存在',404);
}
