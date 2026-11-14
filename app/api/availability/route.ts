import {NextRequest,NextResponse} from 'next/server';
import {day} from '@/lib/schema';
import {rpc,jsonError} from '@/lib/server';
export const dynamic='force-dynamic';
export async function GET(req:NextRequest){
 const date=req.nextUrl.searchParams.get('date')||'';const partySize=Number(req.nextUrl.searchParams.get('partySize'));
 if(!day.safeParse(date).success||!Number.isInteger(partySize)||partySize<1||partySize>5)return jsonError('請選擇合法日期和 1–5 人');
 const [{data,error},{data:dayState,error:stateError}]=await Promise.all([rpc('get_available_slots',{p_date:date,p_party_size:partySize}),rpc('booking_day_state',{p_date:date,p_party_size:partySize})]);
 if(error||stateError){console.error('availability',error?.message,stateError?.message);return jsonError('暫時無法查詢時段',503);}
 return NextResponse.json({slots:data||[],state:dayState||'unavailable'},{headers:{'Cache-Control':'no-store'}});
}