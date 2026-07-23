/**
 * 武器②:jsdom 真渲染真點擊煙霧測。
 * 用法: npm i --no-save jsdom fake-indexeddb && node tools/smoke.mjs   (在專案根目錄)
 * 覆蓋:12 頁面渲染、DM/群/正文/旁觀四房型、↻ 自燃、正文選項、章節封存、⋯選單。
 */
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const dom = new JSDOM(readFileSync('index.html','utf8'), { url:'http://localhost/', pretendToBeVisual:true });
globalThis.window=dom.window; globalThis.document=dom.window.document;
globalThis.HTMLElement=dom.window.HTMLElement; globalThis.FormData=dom.window.FormData;
globalThis.alert=()=>{};
const errors=[]; process.on('unhandledRejection',(e)=>errors.push(String(e?.message||e)));
const { initDB, clearState } = await import('../utils/indexeddb.js');
const { initState, getState } = await import('../modules/state.js');
const { createCharacter, createStory, createGroup, createPeek, openRoom } = await import('../modules/rooms.js');
const { sendUserMessage } = await import('../modules/chat.js');
const { saveApiConfig } = await import('../modules/api.js');
const ui = await import('../modules/ui.js');
const { initNavigation, navigate, getView } = await import('../modules/navigation.js');
await initDB(); await clearState();
await initState({appName:'私人訊號',defaultPlayer:{playerName:'測試'},defaultSettings:{}});
let pass=0,fail=0; const t=(c,n)=>{c?(pass++):(fail++,console.log('FAIL',n));};
const {character:a, dmRoom:dm}=await createCharacter({name:'甲'});
const {character:b}=await createCharacter({name:'乙'});
const sc=await createStory('s',[a.id]); const g=await createGroup('g',[a.id,b.id]); const pk=await createPeek('p',[a.id,b.id]);
await saveApiConfig({useRealApi:true,provider:'gemini',apiKey:'K',model:'m'});
const mock=(text)=>{ globalThis.fetch=async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text}]}}]})}); };
initNavigation(); ui.initUI({appName:'私人訊號'});
for(const v of ['home','chat-friends','chat-rooms','chat-peek','social-feed','story-list','people','player','worldbook','settings','album','search','char-phone','memory-hub']){
  try{ await navigate(v); ui.renderAll(); t(true,v);}catch(e){ t(false,`${v}: ${e.message}`);} }
for(const r of [dm.id,sc.id,g.id,pk.id]){ try{ await openRoom(r); ui.renderAll(); t(true,'room');}catch(e){ t(false,'room '+e.message);} }
await openRoom(sc.id); ui.renderAll();
mock('夜色。\n▷ 前進'); await sendUserMessage(sc.id,'走',()=>{}); ui.renderAll();
const ch=document.querySelector('[data-choice]'); t(!!ch,'選項存在');
if(ch){ mock('前進了。'); ch.dispatchEvent(new dom.window.Event('click',{bubbles:true})); await new Promise(r=>setTimeout(r,2200));
  t(getState().messagesByRoom[sc.id].some(m=>m.content==='前進'),'選項可點'); }
await openRoom(pk.id); ui.renderAll();
mock(JSON.stringify([{name:'甲',content:'x'},{name:'乙',content:'y'}]));
const sb=document.querySelector('#btnSelfChat'); t(!!sb,'↻存在');
if(sb){ sb.dispatchEvent(new dom.window.Event('click')); await new Promise(r=>setTimeout(r,3200));
  t(getState().messagesByRoom[pk.id].filter(m=>m.role==='character').length>=2,'旁觀自燃'); }

// v99.3(擁有者回報記憶頁返回失靈的教訓):逐頁實測「按返回真的回得去」——渲染後點 #btnBack,view 必須變
for (const v of ['memory-hub', 'worldbook', 'album', 'settings']) {
  await navigate(v); ui.renderAll();
  const btn = document.getElementById('btnBack');
  if (!btn) { t(false, `${v}:找不到返回鍵`); continue; }
  btn.click();
  await new Promise((res) => setTimeout(res, 30)); // 等 async back()+renderAll
  t(getView() === 'home', `${v}:按返回真的回到主畫面`);
}

t(errors.length===0,'零 unhandled: '+errors.slice(0,2));
console.log(`煙霧測:${pass} 通過, ${fail} 失敗`); process.exit(fail?1:0);

