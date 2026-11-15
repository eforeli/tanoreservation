import Link from 'next/link';
export default function Page(){return <section className="panel narrow booking-entry">
 <div className="booking-entry-intro">
  <div className="eyebrow">TANO RESERVATION</div>
  <h1>歡迎來到 TANO 訂位服務</h1>
  <p className="muted">炭火慢慢逼出肉香，也定下 TANO 的味道。</p>
 </div>
 <Link href="/reserve/new" className="booking-link-primary">預約訂位</Link>
 <p className="muted small">已有訂位？ <Link className="booking-text-link" href="/reserve/manage">取消／修改訂位資訊</Link></p>
 </section>;}
