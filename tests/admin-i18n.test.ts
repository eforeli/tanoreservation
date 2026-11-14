import assert from 'node:assert/strict';
import test from 'node:test';
import {adminText} from '../lib/admin-i18n';

test('admin defaults can be rendered in Argentine Spanish',()=>{
 assert.equal(adminText('員工專區','es'),'Acceso del personal');
 assert.equal(adminText('登入','es'),'Iniciar sesión');
 assert.equal(adminText('訂位詳情','es'),'Reservas');
 assert.equal(adminText('訂位log','es'),'Historial de cambios');
 assert.equal(adminText('載入中…','es'),'Cargando…');
 assert.equal(adminText('所選期間沒有訂位','es'),'No hay reservas en el período seleccionado');
});

test('Traditional Chinese retains original UI labels',()=>{
 for(const key of ['員工專區','訂位詳情','取消','營運設定','訂位 log']){
  assert.equal(adminText(key,'zh'),key);
 }
});

test('server validation errors and sign-in feedback are localized',()=>{
 assert.equal(adminText('日期錯誤','es'),'La fecha no es válida.');
 assert.equal(adminText('未授權','es'),'Acceso no autorizado');
 assert.equal(adminText('Invalid login credentials','es'),'Correo o contraseña incorrectos.');
});

test('unknown API errors remain visible rather than being dropped',()=>{
 assert.equal(adminText('HTTP 503','es'),'HTTP 503');
});
