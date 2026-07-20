/**
 * tests/xss.test.mjs — XSS 防線不變式(v91 起常駐):
 * 1) esc() 全站唯一實作在 utils/esc.js;五字元完整轉義;modules/ 不得再養本地副本
 * 2) safeImage():只放行 data:image dataURL 與乾淨 http(s) URL;
 *    屬性逃逸原料(引號/角括號)、javascript:、data:text/html 一律回 null
 * 3) 單房備份匯入:訊息 image / sharedPost.image 帶敵意字串 → 落地前被守門丟棄
 * 4) 角色卡匯入(V2 JSON):extensions 的 avatarImage 帶敵意字串 → 不落地
 * 5) DOM 級:src="${esc(敵意)}" 在真 DOM 中不產生第二個元素、無 onerror 屬性
 * 背景:全站 <img src="${…}"> 插值 v91 起一律包 esc();此檔守住「兩層都在」。
 */
import { t, summary, freshState } from './_env.mjs';
import { readFileSync, readdirSync } from 'node:fs';

const state = await freshState();
const { esc, safeImage } = await import('../utils/esc.js');

// ── 1) esc 單一來源與完整轉義 ──
t(esc(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;', 'esc 五字元完整轉義');
t(esc(null) === '' && esc(undefined) === '', 'esc 對 null/undefined 回空字串');
{
  let localCopies = 0;
  for (const f of readdirSync(new URL('../modules/', import.meta.url))) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(new URL(`../modules/${f}`, import.meta.url), 'utf8');
    if (/^function esc\(s\)|^function escB\(/m.test(src)) localCopies += 1;
  }
  t(localCopies === 0, 'modules/ 無本地 esc/escB 副本(唯一實作在 utils/esc.js)');
}

// ── 2) safeImage 收與擋 ──
const OK_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const HOSTILE = '"><img src=x onerror=window.__pwn=1>';
t(safeImage(OK_DATA) === OK_DATA, 'safeImage 放行 data:image dataURL');
t(safeImage('https://example.com/a.png') === 'https://example.com/a.png', 'safeImage 放行乾淨 https URL');
t(safeImage(HOSTILE) === null, 'safeImage 擋屬性逃逸字串');
t(safeImage('javascript:alert(1)') === null, 'safeImage 擋 javascript:');
t(safeImage('data:text/html;base64,PHNjcmlwdD4=') === null, 'safeImage 擋非 image 的 dataURL');
t(safeImage('https://e.com/a".png') === null, 'safeImage 擋含引號的 URL');
t(safeImage('') === null && safeImage(null) === null && safeImage(42) === null, 'safeImage 空值/非字串回 null');

// ── 3) 單房備份匯入守門(走真實 export→竄改→import 管線)──
const { exportRoomJson, parseRoomImport, importRoom } = await import('../modules/roombackup.js');
const { createCharacter } = await import('../modules/rooms.js');
const { getRoomMessages } = await import('../modules/state.js');
const { character: charA, dmRoom } = await createCharacter({ name: '甲' });
t(!!dmRoom, '前置:建角色附帶 DM 房');
getRoomMessages(dmRoom.id).push(
  { id: 'x1', role: 'character', senderId: charA.id, content: '合法訊息', createdAt: Date.now(), image: OK_DATA },
);
const tampered = JSON.parse(exportRoomJson(dmRoom.id));
const tMsg = tampered.messages.find((m) => m.content === '合法訊息');
tMsg.image = HOSTILE;
tMsg.sharedPost = { authorName: '甲', excerpt: '節錄', image: HOSTILE };
const { room: importedRoom } = await importRoom(parseRoomImport(JSON.stringify(tampered)));
const importedMsgs = getRoomMessages(importedRoom.id);
const hit = importedMsgs.find((m) => m.content === '合法訊息');
t(!!hit, '匯入後訊息本體仍在');
t(hit.image === undefined, '敵意 image 欄被守門丟棄');
t(!hit.sharedPost || hit.sharedPost.image === undefined, '敵意 sharedPost.image 被守門丟棄');
t(hit.sharedPost && hit.sharedPost.excerpt === '節錄', '分享卡其餘欄位不受影響');
{ // 合法圖不誤傷
  const clean = JSON.parse(exportRoomJson(dmRoom.id));
  const { room: r2 } = await importRoom(parseRoomImport(JSON.stringify(clean)));
  const m2 = getRoomMessages(r2.id).find((m) => m.content === '合法訊息');
  t(m2.image === OK_DATA, '合法 dataURL 匯入不誤傷');
}

// ── 4) 角色卡匯入守門(V2 JSON 的 extensions.avatarImage)──
const { parseCharacterImport, importCharacter } = await import('../modules/charcard.js');
const v2 = {
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: '乙', description: '測試', personality: '', scenario: '', first_mes: '嗨',
    extensions: { avatarImage: HOSTILE, themeColor: '#8ea7ff' },
  },
};
const normalized = await parseCharacterImport(new TextEncoder().encode(JSON.stringify(v2)));
t(normalized.avatarImage === null, '角色卡敵意 avatarImage 在解析層被丟');
await importCharacter(normalized);
const landedB = state.characters.find((c) => c.name === '乙');
t(!!landedB && !landedB.avatarImage, '匯入後落地角色不帶敵意 avatarImage');

// ── 5) DOM 級:esc 後的 src 屬性逃逸被封死 ──
document.body.innerHTML = `<img src="${esc(HOSTILE)}" alt="">`;
t(document.body.querySelectorAll('*').length === 1, 'esc 後只落地一個元素(無逃逸)');
t(!document.body.querySelector('[onerror]'), 'esc 後無 onerror 屬性');
t(window.__pwn === undefined, '注入程式未被執行');

summary('XSS 防線');
