import pg from 'pg';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
// Starts from an empty, disposable local PostgreSQL cluster, as tanoqa.
const cfg={host:'127.0.0.1',port:55439,user:'tanoqa',database:'postgres'};
const migrations=new URL('../supabase/migrations/',import.meta.url);
const db=new pg.Client(cfg);
await db.connect();
const q=(s,p=[])=>db.query(s,p);
const one=async(s,p=[])=>Object.values((await q(s,p)).rows[0]??{})[0];
await q("create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create schema extensions; create extension pgcrypto with schema extensions; set search_path=public,extensions;");
for (const file of (await fs.readdir(migrations)).sort()) {
  try{await q(await fs.readFile(new URL(file,migrations),'utf8'));}catch(e){throw Error(file+' '+e.message)}
}
if(process.env.QA_INIT_ONLY){await db.end();process.exit(0);}
const today=await one("select (now() at time zone 'Asia/Taipei')::date::text");
const [closed,day,next,saturday]=(await q(
  "select array_agg(d::date::text order by d) as dates from generate_series($1::date+1,$1::date+14,'1 day') d where extract(dow from d) in (1,2,3,6) and d<date_trunc('week',$1::date+7)+interval '7 days' and d>=date_trunc('week',$1::date+7)",[today]
)).rows[0].dates;
const actor=randomUUID();
let seq=0;
const freshPhone=()=> '09'+String(++seq).padStart(8,'0');
const createSQL="select public.create_booking($1,$2,$3,$4,$5,$6,$7,$8,$9) as result";
const input=(d=day,time='17:00',s=2,phone=freshPhone(),key=randomUUID(),source='web')=>[d,time,s,'TANO QA Synthetic',phone,'QA synthetic fixture',source,key,source==='web'?null:actor];
const create=(...args)=>one(createSQL,input(...args));
const row=code=>q("select r.id,r.updated_at,r.starts_at,r.status,r.guest_phone,r.party_size, t.code as table_code,extract(epoch from (r.dining_ends_at-r.starts_at))/60 as dining,extract(epoch from (r.table_released_at-r.dining_ends_at))/60 as buffer from public.reservations r join public.reservation_tables rt on rt.reservation_id=r.id join public.restaurant_tables t on t.id=rt.table_id where r.confirmation_code=$1",[code]).then(x=>x.rows[0]);
const slots=(d=day,n=2)=>one('select public.get_available_slots($1,$2)',[d,n]);
const state=(d=day,n=2)=>one('select public.booking_day_state($1,$2)',[d,n]);
const only=async(...tables)=>q('update public.restaurant_tables set is_active=code=any($1::text[])',[tables]);
const at=(d,t)=>d+'T'+t+':00+08:00';
const block=(table,d,a,b)=>one('select public.admin_block_table($1,$2,$3,$4,$5)',[table,at(d,a),b?at(d,b):null,'QA synthetic',actor]);
const reset=async()=>q("truncate public.customer_booking_verify_attempts,public.customer_booking_sessions,public.customer_booking_audit_logs,public.reservation_tables,public.reservations,public.table_blocks,public.admin_audit_logs,public.special_business_hours restart identity; update public.restaurant_tables set is_active=true; update public.booking_settings set dining_minutes=90,buffer_minutes=20,slot_interval_minutes=30,booking_window_days=30,min_advance_minutes=30,extra_chairs_total=2,max_arrivals_per_slot=5,max_online_party_size=5,last_seating_offset_minutes=90;");
const checks=[];
async function test(id,label,fn){await reset();try{const observed=await fn(); checks.push({id,label,status:'Pass',observed});}catch(e){checks.push({id,label,status:'Fail',observed:e.message,code:e.code});} console.log(checks.at(-1));}
await test('I01','建立、確認編號及分桌交易',async()=>{let r=await create();let x=await row(r.confirmation_code);assert.match(r.confirmation_code,/^[A-Z0-9]{6}$/);assert.equal(x.table_code,'A2');assert.equal(x.status,'confirmed');assert.equal(x.party_size,2);return '一筆訂位、一筆 A2 關聯';});
await test('I02','相同重送鍵僅建立一筆',async()=>{const p=input();const a=await one(createSQL,p);const b=await one(createSQL,p);assert.equal(a.confirmation_code,b.confirmation_code);assert.equal(Number(await one('select count(*) from public.reservations')),1);});
await test('I03','同手機同日不可重複建立，隔日可訂',async()=>{const p=freshPhone();await create(day,'17:00',2,p);await assert.rejects(create(day,'17:30',2,p),/duplicate phone/);await create(next,'17:00',2,p);});
await test('I04','顧客查單、改期、取消及稽核',async()=>{const p=freshPhone();const a=await create(day,'17:00',2,p);const v=await one('select public.customer_verify_booking($1,$2,$3,$4)',[a.confirmation_code,p,'a'.repeat(64),'b'.repeat(64)]);const wrong=await one('select public.customer_verify_booking($1,$2,$3,$4)',[a.confirmation_code,freshPhone(),'c'.repeat(64),'b'.repeat(64)]);assert.equal(wrong,null);assert.equal(v.can_manage,true);const edited=await one('select public.customer_update_booking($1,$2,$3,$4,$5,$6,$7,$8)',['a'.repeat(64),next,'17:30',3,v.guest_name,p,'Updated QA',v.updated_at]);assert.equal(edited.party_size,3);assert.equal(edited.guest_phone,p);await assert.rejects(one('select public.customer_get_booking($1)',['a'.repeat(64)]),/session expired/);const u=await one('select public.customer_verify_booking($1,$2,$3,$4)',[a.confirmation_code,p,'d'.repeat(64),'b'.repeat(64)]);const c=await one('select public.customer_cancel_booking($1,$2)',['d'.repeat(64),u.updated_at]);assert.equal(c.status,'cancelled');assert.equal(Number(await one('select count(*) from public.customer_booking_audit_logs')),2);});
await test('I05','改期撞滿回滾，原單可查',async()=>{await only('A2');let p=freshPhone();let a=await create(day,'17:00',2,p);await create(next,'17:00',2);let v=await one('select public.customer_verify_booking($1,$2,$3,$4)',[a.confirmation_code,p,'a'.repeat(64),'b'.repeat(64)]);await assert.rejects(one('select public.customer_update_booking($1,$2,$3,$4,$5,$6,$7,$8)',['a'.repeat(64),next,'17:00',2,v.guest_name,p,'',v.updated_at]),/unavailable/);let r=await row(a.confirmation_code);assert.equal(r.starts_at.toISOString(),new Date(at(day,'17:00')).toISOString());});
await test('I06','後台人工建立、改期、取消、分類稽核',async()=>{let a=await create(day,'17:00',2,freshPhone(),randomUUID(),'phone');let r=await row(a.confirmation_code);await q('select public.admin_update_booking($1,$2,$3,$4,$5,$6,$7,$8,$9)',[r.id,next,'17:30',3,'QA synthetic',r.guest_phone,'updated','confirmed',actor]);let u=await row(a.confirmation_code);assert.equal(u.party_size,3);assert.equal(u.starts_at.toISOString(),new Date(at(next,'17:30')).toISOString());await q('select public.admin_cancel_booking($1,$2,$3)',[r.id,'QA only',actor]);assert.equal((await row(a.confirmation_code)).status,'cancelled');assert.equal(Number(await one("select count(*) from public.admin_audit_logs where entity_type='reservation'")),3);});
await test('B01','依人數分桌與拒絕 6 人',async()=>{const out=[];for(const n of [1,2,3,4,5]){await reset();const r=await create(day,'17:00',n);out.push((await row(r.confirmation_code)).table_code)}assert.deepEqual(out,['A2','A2','A4','A4','A4']);await assert.rejects(create(day,'17:30',6),/not eligible/);return out;});
await test('B02','兩張小桌同時加椅最多一桌',async()=>{await only('A1','A3');const a=await create(day,'17:00',3);assert.equal((await row(a.confirmation_code)).table_code,'A1');const b=await create(day,'17:30',3).catch(()=>null);assert.equal(b===null?null:(await row(b.confirmation_code)).table_code,null,'重疊期間最多只有一張小桌可加椅');});
await test('B03','共享加椅峰值不得超過兩張',async()=>{await only('A1','A4','A5');const a=await create(day,'17:00',5);const b=await create(day,'17:30',5);await assert.rejects(create(day,'18:00',3),/unavailable/);assert.notEqual((await row(a.confirmation_code)).table_code,(await row(b.confirmation_code)).table_code);});
await test('B04','90+20、精確半開區間',async()=>{await only('A2');let a=await create();let r=await row(a.confirmation_code);assert.equal(Number(r.dining),90);assert.equal(Number(r.buffer),20);const res=await one("select public.find_table_for_booking($1,2) is not null",[at(day,'18:49')]);assert.equal(res,false);assert.equal(await one("select public.find_table_for_booking($1,2) is not null",[at(day,'18:50')]),true);await assert.rejects(create(day,'18:30'),/unavailable/);await create(day,'19:00');});
await test('B05','每時段新入席上限及不同桌',async()=>{await q('update public.booking_settings set max_arrivals_per_slot=2');let a=await create();let b=await create();assert.notEqual((await row(a.confirmation_code)).table_code,(await row(b.confirmation_code)).table_code);await assert.rejects(create(),/unavailable/);});
await test('B06','鎖桌阻擋、既有訂位衝突及解除',async()=>{await only('A2');let a=await block('A2',day,'17:00','18:00');await assert.rejects(create(),/unavailable/);await q('select public.admin_unblock_table($1,$2)',[a.id,actor]);await create();await assert.rejects(block('A2',day,'17:30','19:00'),/已有訂位/);});
await test('B07','公休、特殊營業、部分休假',async()=>{assert.equal(await state(closed),'closed');await q("insert into public.special_business_hours(business_date,is_closed,periods) values($1,false,'[{\"start\":\"17:00\",\"end\":\"21:00\"}]')",[closed]);assert.equal(await state(closed),'available');await q("insert into public.special_business_hours(business_date,is_closed,closure_periods) values($1,false,'[{\"start\":\"18:00\",\"end\":\"19:00\"}]')",[day]);assert.deepEqual(await slots(),['19:00','19:30']);await assert.rejects(create(day,'17:00'),/not eligible/);});
await test('B08','結束前入席與預約視窗',async()=>{assert.equal((await slots(day)).at(-1),'19:30');assert.equal((await slots(saturday)).at(-1),'20:00');assert.deepEqual(await slots(await one("select ($1::date+31)::text",[today])),[]);});
await test('B09','跨日鎖桌且隔日開始時段可重新使用',async()=>{await only('A2');const a=await one('select public.admin_block_table($1,$2,$3,$4,$5)',['A2',at(day,'23:00'),at(next,'17:30'),'QA synthetic',actor]);assert.ok(a.id);await assert.rejects(create(next,'17:00'),/unavailable/);await create(next,'17:30');});
await test('B10','跨深夜時段查詢須在逾時前正常結束',async()=>{await q("insert into public.special_business_hours(business_date,is_closed,periods) values($1,false,'[{\"start\":\"22:00\",\"end\":\"23:59\"}]')",[day]);const late=await slots();assert.deepEqual(late,['22:00']);});
await test('B11','同時競爭最後一桌，只有一筆成功',async()=>{await only('A2');const a=new pg.Client(cfg),b=new pg.Client(cfg);await Promise.all([a.connect(),b.connect()]);try{let res=await Promise.allSettled([a.query(createSQL,input()),b.query(createSQL,input())]);assert.equal(res.filter(x=>x.status==='fulfilled').length,1);assert.match(res.find(x=>x.status==='rejected').reason.message,/unavailable/);assert.equal(Number(await one('select count(*) from public.reservation_tables')),1);return '兩個獨立 PostgreSQL 連線，一筆成功、一筆無庫存';}finally{await Promise.all([a.end(),b.end()]);}});
await test('B12','依後台設定使用 10 或 20 分鐘緩衝，既有訂位保留原占用',async()=>{await q('update public.booking_settings set buffer_minutes=10,last_seating_offset_minutes=60');let a=await create();let r=await row(a.confirmation_code);assert.equal(Number(r.buffer),10);await q('update public.booking_settings set buffer_minutes=20');const b=await create(day,'18:00');assert.equal(Number((await row(b.confirmation_code)).buffer),20);assert.equal(Number((await row(a.confirmation_code)).buffer),10);});
await test('B13','取消後重新釋出桌位與加椅',async()=>{await only('A4');let a=await create(day,'17:00',5);await assert.rejects(create(day,'17:00',5),/unavailable/);let r=await row(a.confirmation_code);await q('select public.admin_cancel_booking($1,$2,$3)',[r.id,'QA',actor]);await create(day,'17:00',5);});
await test('B14','同日同手機併發送出僅一筆',async()=>{const a=new pg.Client(cfg),b=new pg.Client(cfg);await Promise.all([a.connect(),b.connect()]);const p=freshPhone();try{let res=await Promise.allSettled([a.query(createSQL,input(day,'17:00',2,p)),b.query(createSQL,input(day,'17:30',2,p))]);assert.equal(res.filter(x=>x.status==='fulfilled').length,1);assert.match(res.find(x=>x.status==='rejected').reason.message,/duplicate phone/);}finally{await Promise.all([a.end(),b.end()]);}});
await test('B15','後台取消與改期重疊，已取消的訂位不能恢復',async()=>{
 const a=await create();const r=await row(a.confirmation_code);
 const c=new pg.Client(cfg),m=new pg.Client(cfg);await Promise.all([c.connect(),m.connect()]);
 try{
  await c.query('begin');
  await c.query('select public.admin_cancel_booking($1,$2,$3)',[r.id,'QA concurrent cancel',actor]);
  const pending=m.query('select public.admin_update_booking($1,$2,$3,$4,$5,$6,$7,$8,$9)',[r.id,day,'17:30',2,'QA synthetic',r.guest_phone,'','confirmed',actor]).then(()=>true,()=>false);
  let locked=false;
  for(let scan=0;scan<35;scan++){locked=await one("select exists(select 1 from pg_stat_activity where wait_event='advisory' and query like 'select public.admin_update_booking%')");if(locked)break;await new Promise(r=>setTimeout(r,30));}
  assert.ok(locked,'更新交易應已讀取舊資料並正在等待日期鎖');
  await c.query('commit');
  const accepted=await pending;const state=(await row(a.confirmation_code)).status;
  assert.equal(state,'cancelled','取消交易提交後，另一筆舊畫面的改期仍被接受='+accepted+'，實際狀態='+state);
 }finally{await Promise.all([c.end(),m.end()]);}
});
await test('B16','顧客改期不能造成同手機同日兩筆有效訂位',async()=>{
 const p=freshPhone();const a=await create();await create(day,'18:00',2,p);const b=await create(next,'17:00',2,p);
 const s=await one('select public.customer_verify_booking($1,$2,$3,$4)',[b.confirmation_code,p,'a'.repeat(64),'b'.repeat(64)]);
 await one('select public.customer_update_booking($1,$2,$3,$4,$5,$6,$7,$8)',['a'.repeat(64),day,'17:30',2,s.guest_name,p,'',s.updated_at]).catch(()=>null);
 assert.equal(Number(await one("select count(*) from public.reservations where guest_phone=$1 and (starts_at at time zone 'Asia/Taipei')::date=$2 and status='confirmed'",[p,day])),1,'顧客改期後同一手機在同一天存在兩筆有效訂位');
});
await test('B17','跨日清桌與已取消紀錄不阻擋庫存',async()=>{
 await only('A2');await q("update public.booking_settings set slot_interval_minutes=10,last_seating_offset_minutes=30");
 await q("insert into public.special_business_hours(business_date,is_closed,periods) values($1,false,$2::jsonb)",[day,JSON.stringify([{start:"22:00",end:"23:50"}])]);
 await create(day,'23:20',2);assert.equal(await one("select public.find_table_for_booking($1,2) is null",[at(next,'01:09')]),true);
 assert.equal(await one("select public.find_table_for_booking($1,2) is not null",[at(next,'01:10')]),true);
});
await test('B18','同手機原訂位取消後當天可重訂',async()=>{
 const p=freshPhone();const a=await create(day,'17:00',2,p);const r=await row(a.confirmation_code);
 await q('select public.admin_cancel_booking($1,$2,$3)',[r.id,'QA',actor]);await create(day,'17:00',2,p);
});
await test('B19','跨日鎖桌與新訂位交錯時不得同時成立',async()=>{
 await only('A2');
 const c=new pg.Client(cfg),m=new pg.Client(cfg);await Promise.all([c.connect(),m.connect()]);
 try{
  await c.query('begin');
  await c.query('select public.admin_block_table($1,$2,$3,$4,$5)',['A2',at(day,'23:00'),at(next,'17:30'),'QA synthetic',actor]);
  const pending=m.query(createSQL,input(next,'17:00')).then(()=>true,()=>false);
  const result=await Promise.race([pending,new Promise(r=>setTimeout(()=>r('pending'),250))]);
  await c.query('commit');
  const accepted=result==='pending'?await pending:result;
  assert.equal(accepted,false,'跨日鎖桌與隔日新訂位同時成立，兩者對應同一桌且區間重疊');
 }finally{await Promise.all([c.end(),m.end()]);}
});
await test('B20','員工改期與顧客跨日改期同時執行',async()=>{
 const p=freshPhone(),a=await create(day,'17:00',2,p),r=await row(a.confirmation_code);
 const v=await one('select public.customer_verify_booking($1,$2,$3,$4)',[a.confirmation_code,p,'a'.repeat(64),'b'.repeat(64)]);
 const c=new pg.Client(cfg),m=new pg.Client(cfg);await Promise.all([c.connect(),m.connect()]);
 try{
  await c.query('begin');
  await c.query('select public.admin_update_booking($1,$2,$3,$4,$5,$6,$7,$8,$9)',[r.id,next,'17:00',2,'QA Synthetic',p,'','confirmed',actor]);
  const pending=m.query('select public.customer_update_booking($1,$2,$3,$4,$5,$6,$7,$8)',['a'.repeat(64),next,'18:00',2,v.guest_name,p,'',v.updated_at]).then(()=>null,e=>e.message);
  await c.query('commit');
  assert.match(await pending,/reservation changed/);
  assert.equal((await row(a.confirmation_code)).starts_at.toISOString(),new Date(at(next,'17:00')).toISOString());
 }finally{await Promise.all([c.end(),m.end()]);}
});
await test('B21','特殊休假剛儲存時不能再接受舊畫面送出的訂位',async()=>{
 await only('A2');
 const c=new pg.Client(cfg),m=new pg.Client(cfg);await Promise.all([c.connect(),m.connect()]);
 try{
  await c.query('begin');
  await c.query('insert into public.special_business_hours(business_date,is_closed) values($1,true)',[day]);
  const pending=m.query(createSQL,input()).then(()=>true,()=>false);
  const result=await Promise.race([pending,new Promise(r=>setTimeout(()=>r('pending'),250))]);
  await c.query('commit');
  const accepted=result==='pending'?await pending:result;
  assert.equal(accepted,false,'未提交的整日休假與同一時段新訂位可同時成立，需明定設定原子性及衝突處置');
 }finally{await Promise.all([c.end(),m.end()]);}
});
await test('B22','兩個員工表單互相覆蓋時，舊版本須被拒絕',async()=>{
 const a=await create(),r=await row(a.confirmation_code);
 const args=[r.id,day,'17:00',2,'QA synthetic',r.guest_phone,'First','confirmed',actor];
 // Preserve PostgreSQL microseconds exactly as the JSON API does.
 const stamp=await one('select updated_at::text from public.reservations where id=$1',[r.id]);
 const edit='select public.admin_update_booking_versioned($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)';
 await q(edit,[...args,stamp]);
 args[6]='Stale';
 await assert.rejects(q(edit,[...args,stamp]),/reservation changed/);
 assert.equal(await one('select notes from public.reservations where id=$1',[r.id]),'First');
});
await test('B23','小桌加椅可在另一小桌用餐結束時立即使用',async()=>{
 await only('A1','A3');const a=await create(day,'17:00',3);
 assert.equal((await row(a.confirmation_code)).table_code,'A1');
 const b=await create(day,'18:30',3);
 assert.equal((await row(b.confirmation_code)).table_code,'A3');
});
await test('B24','先成立的訂位遇到之後的休假仍保留',async()=>{
 const a=await create();
 await q('insert into public.special_business_hours(business_date,is_closed) values($1,true)',[day]);
 await assert.rejects(create(day,'17:30'),/not eligible/);
 assert.equal((await row(a.confirmation_code)).status,'confirmed');
});
if(process.env.QA_OUTPUT)await fs.writeFile(process.env.QA_OUTPUT,JSON.stringify(checks,null,2));
if(checks.some(check=>check.status==='Fail'))process.exitCode=1;
await db.end();
