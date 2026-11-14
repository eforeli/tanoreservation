'use client';
import {createContext,useContext,useEffect,useState} from 'react';
type Language='zh'|'en';
const LanguageContext=createContext<{language:Language;setLanguage:(value:Language)=>void}>({language:'zh',setLanguage:()=>{}});
export function useLanguage(){return useContext(LanguageContext);}
export default function SiteShell({children}:{children:React.ReactNode}){
 const [language,setLanguage]=useState<Language>('zh');
 useEffect(()=>{try{const saved=window.localStorage.getItem('tano-language');if(saved==='zh'||saved==='en')setLanguage(saved);}catch{/* Storage may be unavailable. */}},[]);
 useEffect(()=>{document.documentElement.lang=language==='zh'?'zh-Hant':'en';try{window.localStorage.setItem('tano-language',language);}catch{/* Storage may be unavailable. */}},[language]);
 return <LanguageContext.Provider value={{language,setLanguage}}>
  <header className="topbar">
   <div className="brand">TANO <small>ARGENTINE · STEAK · FIRE</small></div>
   <nav aria-label={language==='zh'?'主選單':'Main navigation'}>
    <a href="/reserve">{language==='zh'?'線上訂位':'Reservations'}</a>
    <a href="/admin">{language==='zh'?'員工專用':'Staff Only'}</a>
    <div className="language-switch" role="group" aria-label={language==='zh'?'語言切換':'Language'}>
     <button type="button" aria-pressed={language==='zh'} className={language==='zh'?'active':''} onClick={()=>setLanguage('zh')}>繁中</button>
     <button type="button" aria-pressed={language==='en'} className={language==='en'?'active':''} onClick={()=>setLanguage('en')}>EN</button>
    </div>
   </nav>
  </header>
  <main>{children}</main>
  <footer>{language==='zh'?'© TANO 塔諾廚房 · 台中市南屯區大墩路918號':'© TANO · 918 Dadun Road, Nantun District, Taichung, Taiwan'}</footer>
 </LanguageContext.Provider>;
}