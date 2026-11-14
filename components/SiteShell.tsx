'use client';
import {createContext,useContext,useEffect,useRef,useState} from 'react';
const LanguageContext=createContext({language:'zh' as const});
export function useLanguage(){return useContext(LanguageContext);}
export default function SiteShell({children}:{children:React.ReactNode}){
 const [menuOpen,setMenuOpen]=useState(false);
 const menuRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(!menuOpen)return;
  function outside(e:PointerEvent){if(!menuRef.current?.contains(e.target as Node))setMenuOpen(false);}
  function key(e:KeyboardEvent){if(e.key==='Escape')setMenuOpen(false);}
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};
 },[menuOpen]);
 return <LanguageContext.Provider value={{language:'zh'}}>
  <header className="topbar">
   <div className="brand">TANO <small>ARGENTINE · STEAK · FIRE</small></div>
   <nav aria-label="網站選單" className="site-nav">
    <div className="site-menu" ref={menuRef}>
     <button className="site-menu-toggle" type="button" aria-label="開啟網站選單" aria-expanded={menuOpen} aria-controls="site-menu-items" onClick={()=>setMenuOpen(v=>!v)}>
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
     </button>
     {menuOpen&&<div id="site-menu-items" className="site-menu-items" role="menu">
      <a role="menuitem" href="/reserve" onClick={()=>setMenuOpen(false)}>線上訂位</a>
      <a role="menuitem" href="/admin" onClick={()=>setMenuOpen(false)}>員工專用</a>
     </div>}
    </div>
   </nav>
  </header>
  <main>{children}</main>
  <footer>© TANO 塔諾廚房 · 台中市南屯區大墩路918號</footer>
 </LanguageContext.Provider>;
}