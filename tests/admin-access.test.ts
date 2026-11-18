import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canAccessAdminRoute} from '../lib/admin-access';

test('staff retain booking and lock operations but cannot access business settings',()=>{
 for(const path of ['session','reservations','blocks','reservation-log'])
  assert.equal(canAccessAdminRoute('staff','GET',[path]),true);
 for(const [area,action] of [['reservations','cancel'],['blocks','release']]){
  assert.equal(canAccessAdminRoute('staff','POST',[area]),true);
  assert.equal(canAccessAdminRoute('staff','PATCH',[area,'id']),true);
  assert.equal(canAccessAdminRoute('staff','POST',[area,'id',action]),true);
  assert.equal(canAccessAdminRoute('staff','POST',[area,'id','unknown']),false);
 }
 for(const path of [['settings'],['special'],['special','booking-count'],['weekly-hours']]){
  for(const method of ['GET','POST','PATCH','DELETE']){
   assert.equal(canAccessAdminRoute('staff',method,path),false);
   assert.equal(canAccessAdminRoute('owner',method,path),true);
  }
 }
});
