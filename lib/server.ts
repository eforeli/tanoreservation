import 'server-only';
import {createClient} from '@supabase/supabase-js';
import {NextRequest,NextResponse} from 'next/server';
const url=()=>{const s=process.env.NEXT_PUBLIC_SUPABASE_URL||process.env.SUPABASE_URL;if(!s)throw Error('Missing Supabase URL');return s;};
export const db=()=>createClient(url(),process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SECRET_KEY||'INVALID',{auth:{persistSession:false,autoRefreshToken:false}});
const publicKey=()=>process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY||process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_PUBLISHABLE_KEY||'INVALID';
export async function adminUser(req:NextRequest){
 const token=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'');if(!token)return null;
 const client=createClient(url(),publicKey(),{auth:{persistSession:false}});
 const {data,error}=await client.auth.getUser(token);if(error||!data.user)return null;
 const {data:admin,error:err}=await db().from('admin_users').select('user_id').eq('user_id',data.user.id).maybeSingle();
 if(err||!admin)return null;return data.user;
}
export const jsonError=(message:string,status=400)=>NextResponse.json({error:message},{status});
export const safeError=(e:unknown)=>e instanceof Error?e.message:'系統發生錯誤';
export async function rpc(name:string,args:Record<string,unknown>){return db().rpc(name,args);}
export function toPublicError(msg:string){return /unavailable|not eligible|capacity|conflict|closed|too late|outside window/i.test(msg)?'該時段目前無法預約，請重新選擇':'訂位未完成，請稍後再試或聯絡餐廳';}