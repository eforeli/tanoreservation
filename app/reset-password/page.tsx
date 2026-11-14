'use client';
import {useEffect,useState} from 'react';
import {createClient} from '@supabase/supabase-js';
const makeClient=()=>createClient(process.env.NEXT_PUBLIC_SUPABASE_URL||'',process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY||process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||'',{auth:{detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}});
export default function ResetPassword(){
 const [client]=useState(makeClient);
 const [email,setEmail]=useState('');
 const [password,setPassword]=useState('');
 const [confirm,setConfirm]=useState('');
 const [ready,setReady]=useState(false);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const [error,setError]=useState('');
 const [finished,setFinished]=useState(false);
 useEffect(()=>{
  let active=true;
  const {data:{subscription}}=client.auth.onAuthStateChange((event,session)=>{
   if(active && event==='PASSWORD_RECOVERY' && session)setReady(true);
  });
  client.auth.getSession().then(({data})=>{if(active && data.session)setReady(true);});
  return()=>{active=false;subscription.unsubscribe();};
 },[client]);
 async function send(e:React.FormEvent){e.preventDefault();setError('');setMessage('');setBusy(true);
  const {error}=await client.auth.resetPasswordForEmail(email.trim(),{redirectTo:`${window.location.origin}/reset-password`});
  setBusy(false);if(error){setError(error.message);return;}setMessage('如果此信箱有有效帳號，系統會寄送密碼重設連結。請使用最新收到的郵件。');
 }
 async function update(e:React.FormEvent){e.preventDefault();setError('');
  if(password.length<12){setError('請使用至少 12 個字元的密碼。');return;}
  if(password!==confirm){setError('兩次輸入的密碼不一致。');return;}
  setBusy(true);const {error}=await client.auth.updateUser({password});
  setBusy(false);if(error){setError(error.message);return;}
  setFinished(true);setPassword('');setConfirm('');await client.auth.signOut();
 }
 return <section className="panel narrow"><div className="eyebrow">TANO ADMIN</div><h1>重設管理員密碼</h1>
 {finished?<><p>新密碼已更新。請返回管理員登入頁。</p><a href="/admin">返回管理員登入</a></>:ready?
 <form onSubmit={update}><p className="muted">請設定新的管理員密碼。</p><label>新密碼（至少 12 字元）<input type="password" autoComplete="new-password" minLength={12} required value={password} onChange={e=>setPassword(e.target.value)}/></label><label>確認新密碼<input type="password" autoComplete="new-password" minLength={12} required value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>{error&&<p role="alert" className="error">{error}</p>}<button className="primary full" disabled={busy}>{busy?'處理中…':'儲存新密碼'}</button></form>:
 <form onSubmit={send}><p className="muted">輸入 Supabase Authentication 中建立的管理員 Email，系統會寄送密碼重設郵件。</p><label>Email<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label>{error&&<p role="alert" className="error">{error}</p>}{message&&<p className="notice">{message}</p>}<button className="primary full" disabled={busy}>{busy?'寄送中…':'寄送密碼重設郵件'}</button></form>}
 <p className="muted center"><a href="/admin">返回管理員登入</a></p>
 </section>;
}