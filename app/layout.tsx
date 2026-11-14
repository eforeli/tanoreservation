import type {Metadata} from 'next';
import './style.css';
export const metadata:Metadata={title:'TANO 塔諾廚房｜線上訂位',description:'TANO 塔諾廚房官方訂位系統'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-Hant"><body><header className="topbar"><div className="brand">TANO <small>ARGENTINE · STEAK · FIRE</small></div><nav><a href="/reserve">線上訂位</a><a href="/admin">管理後台</a></nav></header><main>{children}</main><footer>© TANO 塔諾廚房 · 台中市南屯區大墩路918號</footer></body></html>}