export const TZ = 'Asia/Taipei';
export const TABLES = [
  {code:'A1',base_capacity:2,max_capacity:3},
  {code:'A2',base_capacity:2,max_capacity:2},
  {code:'A3',base_capacity:2,max_capacity:3},
  {code:'A4',base_capacity:4,max_capacity:5},
  {code:'A5',base_capacity:4,max_capacity:5}
] as const;
export const pad = (n:number) => String(n).padStart(2,'0');
const taipeiDayFormat = new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'});
export function localDay(date=new Date()):string {
  const parts = taipeiDayFormat.formatToParts(date);
  const part = (type:string) => parts.find(value=>value.type===type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function dateTimeTaipei(date:string,time:string):string { return `${date}T${time}:00+08:00`; }
export function taipeiDisplay(iso:string):string { return new Intl.DateTimeFormat('zh-TW',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso)); }
export const STATUS_LABELS:Record<string,string>={confirmed:'已確認',seated:'已入席',completed:'已完成',no_show:'未到',cancelled:'已取消'};
