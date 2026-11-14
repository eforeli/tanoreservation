import type {Metadata} from 'next';
import './style.css';
import SiteShell from '@/components/SiteShell';
export const metadata:Metadata={title:'TANO 塔諾廚房｜線上訂位',description:'TANO 塔諾廚房官方訂位系統'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-Hant"><body><SiteShell>{children}</SiteShell></body></html>}