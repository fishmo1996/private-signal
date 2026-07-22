/**
 * tests/membudget.test.mjs — v98(w1)記憶預算閘門(照候補簿必加斷言):
 * 1) 預算內:行為與現狀逐字等價(所有記憶照舊全進)
 * 2) 超預算:釘選恆全進(即使它最舊最胖);未釘的「最舊」條被裁、最新條保留
 * 3) 只動 DM 主建構器:場景記憶不受預算影響;群聊等其他建構器語意不變
 */
import { t, summary, freshState } from './_env.mjs';

const state = await freshState();
const { createCharacter, createGroup } = await import('../modules/rooms.js');
const { buildPrompt, buildGroupPrompt } = await import('../modules/prompt.js');
const { persist } = await import('../modules/state.js');

const NOW = Date.now();
const { character: A, dmRoom } = await createCharacter({ name: '甲' });

/* --- 1) 預算內逐字等價:小量記憶,開關預算前後 system 相同 --- */
state.memories.shared.push({ id: 's1', circleId: null, content: '小共享S', createdAt: NOW - 3000, eventDate: '', pinned: false });
state.memories.byCharacterId[A.id] = [
  { id: 'p1', content: '小私密P', createdAt: NOW - 2000, eventDate: '', pinned: false },
];
await persist();
state.settings.memoryBudget = 3000; // 明示預設
const sysA = buildPrompt({ character: A, roomId: dmRoom.id }).system;
delete state.settings.memoryBudget; // 未設=??3000,同值
const sysB = buildPrompt({ character: A, roomId: dmRoom.id }).system;
t(sysA === sysB && sysA.includes('小共享S') && sysA.includes('小私密P'), '預算內:行為與現狀逐字等價,全數照舊注入');

/* --- 2) 超預算:釘選恆進、未釘最舊被裁 --- */
state.settings.memoryBudget = 100;
state.memories.byCharacterId[A.id] = [
  { id: 'pin-old', content: `釘選老胖${'胖'.repeat(120)}`, createdAt: NOW - 90 * 86400000, eventDate: '', pinned: true },
  { id: 'u-new', content: `未釘最新${'新'.repeat(60)}`, createdAt: NOW - 1000, eventDate: '', pinned: false },
  { id: 'u-old', content: `未釘最舊${'舊'.repeat(60)}`, createdAt: NOW - 60 * 86400000, eventDate: '', pinned: false },
];
const p2 = buildPrompt({ character: A, roomId: dmRoom.id });
t(p2.system.includes('釘選老胖'), '釘選超預算仍在(恆全進,不占未釘預算)');
t(p2.system.includes('未釘最新'), '未釘:新到舊裝入,最新條保留');
t(!p2.system.includes('未釘最舊'), '未釘:預算滿後最舊條被裁');
t(p2.meta.privateMemories.every((m) => m.id !== 'u-old'), 'meta 與 prompt 一致(被裁的不在 meta)');

/* --- 合池:共享+私密共用一份預算(共享的新條會排擠私密的舊條,反之亦然) --- */
state.memories.shared.push({ id: 's-newest', circleId: null, content: `共享更新${'共'.repeat(60)}`, createdAt: NOW - 500, eventDate: '', pinned: false });
const p3 = buildPrompt({ character: A, roomId: dmRoom.id });
t(p3.system.includes('共享更新') && !p3.system.includes('未釘最新'), '合池:更新的共享條進場,排擠掉次新的私密條(共用預算)');

/* --- 3) 範圍:場景記憶與其他建構器不受影響 --- */
state.memories.byRoomId[dmRoom.id] = [{ id: 'r1', content: `場景記憶R${'場'.repeat(150)}`, createdAt: NOW - 100, eventDate: '', pinned: false }];
t(buildPrompt({ character: A, roomId: dmRoom.id }).system.includes('場景記憶R'), '場景記憶不吃這道預算(既有語意不變)');
const { character: B } = await createCharacter({ name: '乙' });
const g = await createGroup('群', [A.id, B.id]);
state.memories.shared.push({ id: 's-fat', circleId: null, content: `群用胖共享${'群'.repeat(200)}`, createdAt: NOW - 200, eventDate: '', pinned: false });
t(buildGroupPrompt({ roomId: g.id }).system.includes('群用胖共享'), '群聊建構器不吃 DM 預算閘門(超 100 字仍全進)');

summary('記憶預算閘門(w1)');
