'use client';
import {createContext,useContext} from 'react';
const LanguageContext=createContext({language:'zh' as const});
export function useLanguage(){return useContext(LanguageContext);}
export default function SiteShell({children}:{children:React.ReactNode}){
 return <LanguageContext.Provider value={{language:'zh'}}>
  <header className="topbar">
   <div className="brand">TANO <small>ARGENTINE · STEAK · FIRE</small></div>
   <nav aria-label="主選單">
    <a href="/reserve">線上訂位</a>
    <a href="/admin">員工專用</a>
   </nav>
  </header>
  <main>{children}</main>
  <footer>© TANO 塔諾廚房 · 台中市南屯區大墩路918號</footer>
 </LanguageContext.Provider>;
}
