/**
 * tests/privacy.test.mjs — 隱私鐵律不變式(HANDOVER §3):
 * 1) DM 內容(H7)與私密記憶(K9)只進本人 DM prompt;群/正文/旁觀/手機偷看/他人 DM 全拿不到
 * 2) 共享記憶按圈子隔離(C3 只給該圈)
 * 3) 備註標籤 persona.label / character.label(L5/L6)絕不進任何 prompt
 * 慣例:祕密代號法——私密資料塞代號,斷言其他建構器輸出不含代號。
 */
import { t, summary, freshState } from './_env.mjs';

const state = await freshState();
const { createCharacter, createGroup, createStory, createPeek } = await import('../modules/rooms.js');
const {
  buildPrompt, buildGroupPrompt, buildStoryPrompt, buildPeekPrompt, buildPhonePeekPrompt,
} = await import('../modules/prompt.js');
const { getRoomMessages } = await import('../modules/state.js');
const { persist } = await import('../modules/state.js');

// --- 佈景:兩角色、四房型、私密記憶與 DM 訊息裡塞祕密代號 ---
const { character: A, dmRoom: dmA } = await createCharacter({ name: '甲' });
const { character: B, dmRoom: dmB } = await createCharacter({ name: '乙' });
A.label = '祕密代號L6';
state.personas[0].label = '祕密代號L5';

// 私密記憶(只有甲本人可見)
state.memories.byCharacterId[A.id] = [
  { id: 'm-k9', content: '祕密代號K9', createdAt: Date.now(), eventDate: '' },
];
// 另一圈的共享記憶(甲乙都在預設圈,不得看到 C3)
state.memories.shared.push(
  { id: 'm-c3', circleId: 'psn_other_circle', content: '祕密代號C3', createdAt: Date.now(), eventDate: '' },
  { id: 'm-s1', circleId: null, content: '全域共享S1', createdAt: Date.now(), eventDate: '' },
);
// 甲的 DM 私訊內容
getRoomMessages(dmA.id).push(
  { id: 'msg-1', role: 'user', senderId: 'player', content: '祕密代號H7', createdAt: Date.now() },
  { id: 'msg-2', role: 'character', senderId: A.id, content: '收到', createdAt: Date.now() },
);
const g = await createGroup('群', [A.id, B.id]);
const sc = await createStory('正文', [A.id, B.id]);
const pk = await createPeek('旁觀', [A.id, B.id]);
await persist();

const SECRETS = ['K9', 'H7'];
const LABELS = ['L5', 'L6'];

function noLeak(text, name, codes) {
  for (const c of codes) t(!String(text).includes(c), `${name} 不含 ${c}`);
}

// 建構器回傳 {system, messages, meta}——整包 stringify 檢查,system/歷史/meta 一個都跑不掉
const flat = (p) => JSON.stringify(p);

// --- 正控制組:甲本人的 DM prompt 應拿得到自己的私密資料與全域共享 ---
const pA = flat(buildPrompt({ character: A, roomId: dmA.id }));
t(pA.includes('K9'), '本人 DM 含私密記憶 K9(正控制)');
t(pA.includes('S1'), '本人 DM 含全域共享 S1(正控制)');
t(!pA.includes('C3'), '本人 DM 不含他圈共享 C3(圈子隔離)');
noLeak(pA, '本人 DM', LABELS);

// --- 其他建構器全部不得見到 K9 / H7 / 標籤 ---
noLeak(flat(buildPrompt({ character: B, roomId: dmB.id })), '他人 DM(乙)', [...SECRETS, ...LABELS, 'C3']);
noLeak(flat(buildGroupPrompt({ roomId: g.id })), '群聊', [...SECRETS, ...LABELS]);
noLeak(flat(buildStoryPrompt({ roomId: sc.id })), '正文', [...SECRETS, ...LABELS]);
noLeak(flat(buildPeekPrompt({ roomId: pk.id })), '旁觀', [...SECRETS, ...LABELS]);

for (const type of ['draft', 'search', 'playlist']) {
  noLeak(flat(buildPhonePeekPrompt({ character: B, peekType: type })), `手機偷看(乙/${type})`, [...SECRETS, ...LABELS]);
}
// 甲本人的手機偷看可以有 K9(他自己的記憶),但標籤仍不得出現
noLeak(flat(buildPhonePeekPrompt({ character: A, peekType: 'draft' })), '手機偷看(甲)', LABELS);

summary('隱私鐵律');
