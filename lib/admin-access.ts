export type AdminRole = 'owner' | 'staff';

export function canAccessAdminRoute(role:AdminRole,method:string,path:readonly string[]):boolean {
 if(role==='owner')return true;
 const [area,,action]=path;
 if(method==='GET')return path.length===1&&['session','reservations','blocks','reservation-log'].includes(area);
 if(area!=='reservations'&&area!=='blocks')return false;
 if(method==='PATCH')return path.length===2;
 if(method==='POST')return path.length===1||
  (path.length===3&&action===(area==='reservations'?'cancel':'release'));
 return false;
}
