export type Table = {code:string;base_capacity:number;max_capacity:number;is_active?:boolean};
export type Occupancy = {table_code:string;party_size:number;starts_at:string;dining_ends_at:string;table_released_at:string};
export type Block = {table_code:string;start_at:string;end_at:string|null;released_at?:string|null};
export type Settings = {dining_minutes:number;buffer_minutes:number;extra_chairs_total:number;max_arrivals_per_slot:number;slot_interval_minutes:number};
export const overlaps=(a:number,b:number,c:number,d:number)=>a<d && c<b;
export const t=(v:string)=>new Date(v).getTime();
export function orderTables(party:number,tables:Table[]):Table[] {
 const priority=party<=2?['A2','A1','A3','A4','A5']:party===3?['A4','A5','A1','A3','A2']:['A4','A5'];
 return tables.filter(v=>v.is_active!==false && v.max_capacity>=party).sort((a,b)=>priority.indexOf(a.code)-priority.indexOf(b.code));
}
export function chairsFeasible(start:number,end:number,need:number,rows:Occupancy[],tables:Table[],total:number):boolean {
 if(need>total)return false;
 const base=new Map(tables.map(x=>[x.code,x.base_capacity]));
 const event:{time:number;delta:number}[]=[{time:start,delta:need},{time:end,delta:-need}];
 for(const row of rows){const n=Math.max(0,row.party_size-(base.get(row.table_code)??row.party_size));if(!n)continue;
  const a=t(row.starts_at),b=t(row.dining_ends_at);
  if(overlaps(start,end,a,b)){event.push({time:Math.max(start,a),delta:n},{time:Math.min(end,b),delta:-n});}
 }
 event.sort((a,b)=>a.time-b.time || a.delta-b.delta);
 let used=0;for(const e of event){used+=e.delta;if(used>total)return false;}return true;
}
export function chooseTable(party:number,startISO:string,rows:Occupancy[],blocks:Block[],tables:Table[],settings:Settings):string|null {
 const start=t(startISO),finish=start+(settings.dining_minutes+settings.buffer_minutes)*60000,chairFinish=start+settings.dining_minutes*60000;
 if(rows.filter(r=>t(r.starts_at)===start).length>=settings.max_arrivals_per_slot)return null;
 for(const table of orderTables(party,tables)){
  if(rows.some(r=>r.table_code===table.code && overlaps(start,finish,t(r.starts_at),t(r.table_released_at))))continue;
  if(blocks.some(b=>b.table_code===table.code && !b.released_at && overlaps(start,finish,t(b.start_at),b.end_at?t(b.end_at):Infinity)))continue;
  if(!chairsFeasible(start,chairFinish,Math.max(0,party-table.base_capacity),rows,tables,settings.extra_chairs_total))continue;
  return table.code;
 }return null;
}