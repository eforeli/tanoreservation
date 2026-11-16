import {WALK_IN_MESSAGE} from '@/lib/constants';
import {NextRequest,NextResponse} from 'next/server';
import {booking} from '@/lib/schema';
import {rpc,jsonError,toPublicError,privateJson,bookingClientHash} from '@/lib/server';
export async function POST(req:NextRequest){
 if(Number(req.headers.get('content-length')||0)>10000)return jsonError('資料過長',413);
 let body:unknown;try{body=await req.json();}catch{return jsonError('資料格式錯誤');}
 const parsed=booking.safeParse(body);if(!parsed.success||parsed.data.source!=='web')return jsonError('訂位資料不完整');
 const b=parsed.data;
 if(!/^09\d{8}$/.test(b.phone))return jsonError('手機號碼須為 09 開頭的 10 位數字');
 const {data:allowed,error:limitError}=await rpc('allow_public_booking',{p_client_hash:bookingClientHash(req)});
 if(limitError){console.error('booking limit',limitError.code);return jsonError('暫時無法接受新訂位，請稍後再試',503);}
 if(allowed!==true)return NextResponse.json({error:'訂位嘗試次數過多，請稍後再試'},{status:429,headers:{'Cache-Control':'private, no-store','Retry-After':'900'}});
 const {data,error}=await rpc('create_booking',{p_date:b.date,p_time:b.time,p_party_size:b.partySize,p_name:b.name,p_phone:b.phone,p_notes:b.notes,p_source:'web',p_key:b.idempotencyKey,p_actor:null});
 if(error){
  if(error.message==='booking day cutoff')return jsonError(error.details||WALK_IN_MESSAGE,409);
  if(error.message.includes('duplicate phone booking day')){
   return NextResponse.json({error:'這隻手機在當天已有訂位，請直接修改訂位資訊，避免重複訂位',code:'DUPLICATE_PHONE_DAY'},{status:409,headers:{'Cache-Control':'no-store'}});
  }
  console.error('booking',error.code);
  return jsonError(toPublicError(error.message),error.message.includes('unavailable')?409:400);
 }
 return privateJson({reservation:data},201);
}