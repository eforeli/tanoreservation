import {NextResponse} from 'next/server';
import {jsonError,rpc} from '@/lib/server';

export const dynamic='force-dynamic';

export async function GET(){
 const {data,error}=await rpc('booking_calendar',{});
 if(error||!data){
  console.error('booking calendar',error?.code);
  return jsonError('暫時無法讀取可預約日期',503);
 }
 return NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});
}
