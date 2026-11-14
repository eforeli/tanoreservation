import {NextRequest,NextResponse} from 'next/server';
import {randomBytes,createHash} from 'node:crypto';
import {z} from 'zod';
import {booking} from '@/lib/schema';
import {rpc} from '@/lib/server';

export const dynamic='force-dynamic';
const COOKIE='tano_customer_booking';
const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
const fail=(error:string,status:number)=>NextResponse.json({error},{status,headers:{'Cache-Control':'no-store'}});
const credentials=z.object({
 code:z.string().trim().min(6).max(32),
 phone:z.string().regex(/^09\d{8}$/)
});
const update=booking.omit({idempotencyKey:true,source:true}).extend({expectedUpdatedAt:z.iso.datetime({offset:true})});
const expected=z.object({expectedUpdatedAt:z.iso.datetime({offset:true})});
function session(req:NextRequest){
 const token=req.cookies.get(COOKIE)?.value;
 return token&&/^[a-f0-9]{64}$/.test(token)?tokenHash(token):null;
}
function cookieResponse(payload:unknown,token?:string){
 const response=NextResponse.json(payload,{headers:{'Cache-Control':'no-store'}});
 if(token)response.cookies.set(COOKIE,token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/api/customer-booking',maxAge:900});
 return response;
}
function originAllowed(req:NextRequest){
 const origin=req.headers.get('origin');
 return !!origin && origin===req.nextUrl.origin;
}
function mapFailure(message:string){
 if(/session expired/.test(message))return fail('查詢已逾時，請重新輸入訂單編號與電話',401);
 if(/reservation changed/.test(message))return fail('訂位資料已變更，請重新查詢',409);
 if(/unavailable/.test(message))return fail('所選時段已無足夠座位，請選擇其他時段',409);
 if(/not eligible/.test(message))return fail('此筆訂位或選擇時段目前無法線上修改／取消',403);
 if(/rate limited/.test(message))return fail('查詢次數過多，請於 15 分鐘後再試',429);
 return fail('系統暫時無法處理，請稍後再試',503);
}
export async function POST(req:NextRequest){
 if(!originAllowed(req))return fail('無效的請求來源',403);
 if(Number(req.headers.get('content-length')||0)>10000)return fail('資料過長',413);
 let input:unknown;try{input=await req.json();}catch{return fail('資料格式錯誤',400);}
 const {action,...raw}=input&&typeof input==='object'?input as Record<string,unknown>:{};
 if(action==='verify'){
  const parsed=credentials.safeParse(raw);if(!parsed.success)return fail('請輸入正確的訂單編號與手機號碼',400);
  const token=randomBytes(32).toString('hex');
  const ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
  const ipHash=tokenHash(ip);
  const {data,error}=await rpc('customer_verify_booking',{
   p_code:parsed.data.code,p_phone:parsed.data.phone,p_token_hash:tokenHash(token),p_ip_hash:ipHash
  });
  if(error){console.error('customer verify',error.code);return mapFailure(error.message);}
  if(!data)return fail('無法確認訂位資料，請檢查訂單編號與電話號碼',401);
  return cookieResponse({reservation:data},token);
 }
 const hash=session(req);if(!hash)return fail('請先查詢訂位',401);
 if(action==='update'){
  const parsed=update.safeParse(raw);if(!parsed.success)return fail('請填寫完整正確的訂位資料',400);
  const b=parsed.data;
  const {data,error}=await rpc('customer_update_booking',{
   p_token_hash:hash,p_date:b.date,p_time:b.time,p_party:b.partySize,
   p_name:b.name,p_phone:b.phone,p_notes:b.notes,p_expected_updated_at:b.expectedUpdatedAt
  });
  if(error){console.error('customer update',error.code);return mapFailure(error.message);}
  const response=cookieResponse({reservation:data});
  response.cookies.delete(COOKIE);
  return response;
 }
 if(action==='cancel'){
  const parsed=expected.safeParse(raw);if(!parsed.success)return fail('資料格式錯誤',400);
  const {data,error}=await rpc('customer_cancel_booking',{p_token_hash:hash,p_expected_updated_at:parsed.data.expectedUpdatedAt});
  if(error){console.error('customer cancel',error.code);return mapFailure(error.message);}
  const response=cookieResponse({reservation:data});response.cookies.delete(COOKIE);return response;
 }
 return fail('不支援的操作',400);
}
export async function GET(req:NextRequest){
 const hash=session(req);if(!hash)return fail('請先查詢訂位',401);
 const mode=req.nextUrl.searchParams.get('mode');
 if(mode==='slots'){
  const date=req.nextUrl.searchParams.get('date')||'';
  const party=Number(req.nextUrl.searchParams.get('partySize'));
  if(!z.iso.date().safeParse(date).success||!Number.isInteger(party)||party<1||party>5)return fail('日期或人數不正確',400);
  const {data,error}=await rpc('customer_available_slots',{p_token_hash:hash,p_date:date,p_party_size:party});
  if(error)return mapFailure(error.message);
  return cookieResponse({slots:data||[],state:(data||[]).length?'available':'unavailable'});
 }
 const {data,error}=await rpc('customer_get_booking',{p_token_hash:hash});
 if(error)return mapFailure(error.message);
 return cookieResponse({reservation:data});
}
