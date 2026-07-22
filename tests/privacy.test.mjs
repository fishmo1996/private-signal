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


// --- v79(d2/d3):旁觀群素材升級的隱私邊界 ---
// d2 只帶「全體旁觀成員都在場」的一般群聊;部分成員在場的群、DM、正文一律不進。
const { getRoomMessages: grm79 } = await import('../modules/state.js');
const gAB = await createGroup('全員群79', [A.id, B.id]);
grm79(gAB.id).push({ id: 'm79-1', role: 'user', senderId: 'player', content: '祕密代號GAB', createdAt: Date.now() });
const { character: C79 } = await createCharacter({ name: '丙79' });
const gOnlyA = await createGroup('缺席群79', [A.id, C79.id]); // 乙不在這個群
grm79(gOnlyA.id).push({ id: 'm79-2', role: 'user', senderId: 'player', content: '祕密代號G2X', createdAt: Date.now() });
dmA.relationshipStage = '階段代號S79';
await persist();
const pPk79 = flat(buildPeekPrompt({ roomId: pk.id }));
t(pPk79.includes('GAB'), '旁觀:全員在場的群聊內容進得來(d2 正控制)');
t(!pPk79.includes('G2X'), '旁觀:部分成員在場的群聊絕不進(乙不在就不帶,防穿幫)');
t(pPk79.includes('S79'), '旁觀:成員各自對玩家的關係階段進得來(d3 正控制)');
noLeak(pPk79, '旁觀(v79 素材升級後)', SECRETS); // DM 內容 H7/私密記憶 K9 仍然拿不到
noLeak(pPk79, '旁觀(v79 素材升級後)', LABELS);
// d1:留言進旁觀素材,但圈子隔離仍在——他圈貼文的留言不得進
const { createPost: cp79, addComment: ac79 } = await import('../modules/social.js');
const otherPost = await cp79('player', '他圈貼文79', null, 'psn_other_circle');
if (otherPost) await ac79(otherPost.id, A.id, '祕密代號C79留言');
const pPk79b = flat(buildPeekPrompt({ roomId: pk.id }));
t(!pPk79b.includes('C79'), '旁觀:他圈貼文的留言不進(d1 圈子隔離沿用)');


// --- v83(h1/h2/h4):社群兩級隱私——留言包滴水不漏,單人呼叫只帶「本人的」 ---
const {
  buildSocialPrompt: bsp83, buildAutoPostPrompt: bap83,
  buildSoloSocialReplyPrompt: solo83, createPost: cp83, addComment: ac83,
} = await import('../modules/social.js');
const post83 = await cp83('player', '公開貼文83');
const cm83 = await ac83(post83.id, A.id, '甲的留言');
const pkg83 = flat(bsp83({ post: post83, triggerText: 'x' }));
noLeak(pkg83, '留言包(h1 後)', [...SECRETS, ...LABELS]); // 多角色共用:私密記憶/DM 依然滴水不漏
t(pkg83.includes('S79'), '留言包:關係階段軟性注入(h1 正控制,擁有者核准)');
t(flat(bap83(A)).includes('K9'), '發文(甲):含本人私密記憶(h2 正控制)');
t(!flat(bap83(B)).includes('K9'), '發文(乙):絕不含他人私密記憶');
const solo83A = flat(solo83({ post: post83, character: A, triggerText: 'x', replyToCommentId: cm83.id }));
t(solo83A.includes('K9') && solo83A.includes('S79'), '指名回覆(甲):本人記憶+關係階段(h4 正控制)');
noLeak(solo83A, '指名回覆(甲)', LABELS); // 備註標籤永不進 prompt(H7 是甲自己的 DM,單人呼叫本來就可帶)
const solo83B = flat(solo83({ post: post83, character: B, triggerText: 'x' }));
t(!solo83B.includes('K9') && !solo83B.includes('H7'), '指名回覆(乙):拿不到甲的記憶與甲的 DM');


// --- v85(j1/k2):群聊 @單人呼叫的兩級隱私+記憶寫入綁圈 ---
const { buildGroupSoloPrompt } = await import('../modules/prompt.js');
const gs85A = flat(buildGroupSoloPrompt({ roomId: g.id, characterId: A.id }));
t(gs85A.includes('K9') && /S79/.test(gs85A), '群@單人(甲):本人私密記憶+關係階段進得來(j1 正控制)');
noLeak(gs85A, '群@單人(甲)', LABELS);
const gs85B = flat(buildGroupSoloPrompt({ roomId: g.id, characterId: B.id }));
t(!gs85B.includes('K9') && !gs85B.includes('H7'), '群@單人(乙):拿不到甲的記憶與甲的 DM');
const pkg85 = flat(buildGroupPrompt({ roomId: g.id }));
t(!pkg85.includes('K9'), '群整包:私密記憶依然滴水不漏(j1 未動 A 級牆)');
// k2:群事件寫入綁圈
const { addSharedMemoryFromGroup, sharedMemoriesFor: smf85 } = await import('../modules/memory.js');
await addSharedMemoryFromGroup('圈內事件M85', g.id);
const gCircle = (await import('../modules/persona.js')).personaForRoom(g)?.id;
t(smf85(gCircle).some((m) => m.content.includes('M85')), 'k2:群事件寫入本圈看得到');
t(!smf85('psn_other_circle').some((m) => m.content.includes('M85')), 'k2:群事件寫入不再是全域(他圈看不到)');


// --- v94.4:發文近況的圈子過濾(全站最後一條無過濾的社群素材管線) ---
const { createPost: cp944 } = await import('../modules/social.js');
await cp944('player', '本圈近況N44');
const otherP944 = await cp944('player', '他圈祕密N44X', null, 'psn_other_circle');
const ap944 = flat(bap83(A));
t(ap944.includes('N44') && !ap944.includes('N44X'), '發文近況:本圈貼文進、他圈貼文絕不進(圈子過濾)');

// --- v96(y1):旁觀群心聲——單人生成給本人 DM 等級,別人的私密仍一字不進 ---
const { buildRoomInnerVoicePrompt: birv96 } = await import('../modules/prompt.js');
getRoomMessages(pk.id).push({ id: 'pkm-1', role: 'character', senderId: A.id, content: '在群裡嘴硬', createdAt: Date.now() });
const pv96A = flat(birv96({ character: A, roomId: pk.id, messageId: 'pkm-1' }));
t(pv96A.includes('K9'), '旁觀心聲(甲):含本人私密記憶(DM 等級正控制)');
t(pv96A.includes('S79'), '旁觀心聲(甲):含他 DM 主線房的關係階段(正控制)');
t(!pv96A.includes('H7'), '旁觀心聲(甲):DM 訊息內容不進(等級=記憶+階段,不含私訊史)');
noLeak(pv96A, '旁觀心聲(甲)', LABELS);
const pv96B = flat(birv96({ character: B, roomId: pk.id, messageId: 'pkm-1' }));
t(!pv96B.includes('K9') && !pv96B.includes('H7'), '旁觀心聲(乙):拿不到甲的私密記憶與甲的 DM');
noLeak(pv96B, '旁觀心聲(乙)', LABELS);
t(birv96({ character: A, roomId: dmA.id, messageId: 'msg-2' }) === null, '房型閘門:DM 房不走此建構器(既有分流不變)');

summary('隱私鐵律');
