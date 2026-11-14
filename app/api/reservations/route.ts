import {NextRequest,NextResponse} from 'next/server';
import {booking} from '@/lib/schema';
import {rpc,jsonError,toPublicError} from '@/lib/server';
export async function POST(req:NextRequest){
 if(Number(req.headers.get('content-length')||0)>10000)return jsonError('資料過長',413);
 let body:unknown;try{body=await req.json();}catch{return jsonError('資料格式錯誤');}
 const parsed=booking.safeParse(body);if(!parsed.success||parsed.data.source!=='web')return jsonError('訂位資料不完整');
 const b=parsed.data;
 if(!/^09\d{8}$/.test(b.phone))return jsonError('手機號碼須為 09 開頭的 10 位數字');
 const {data,error}=await rpc('create_booking',{p_date:b.date,p_time:b.time,p_party_size:b.partySize,p_name:b.name,p_phone:b.phone,p_notes:b.notes,p_source:'web',p_key:b.idempotencyKey,p_actor:null});
 if(error){console.error('booking',error.code,error.message);return jsonError(toPublicError(error.message),error.message.includes('unavailable')?409:400);}
 return NextResponse.json({reservation:data},{status:201});
}