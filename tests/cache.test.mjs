/**
 * tests/cache.test.mjs — 提案 c1 快取分層的六條必加斷言:
 * 1) 快取穩定性:凍結 Date.now、固定 state 下,同房連跑兩輪 buildPrompt → system 逐字相等,
 *    且不含「現在是」「約 N 天前」「本輪觸發」字樣
 * 2) 動態尾巴完整性:原 system 的動態段(現在時間/觸發式世界書/紀念日/社群動態/跨介面)
 *    內容等價地出現在 dynamicTail,且依修訂一併入「最新 user 訊息文字最前」
 * 3) 錨定行為:未超預算起點不變;超預算裁至 ≤65% 且立新錨;錨失效不拋錯重立;分岔房不繼承
 * 4) 隱私迴歸:dynamicTail 不得讓私密素材流入非本人建構器(全套另由 privacy.test.mjs 重跑)
 * 5) 鸚鵡迴歸:REL_TIME_ECHO 剝除器保留不拆(全套另由 parrot.test.mjs 重跑)
 * 6) 保險絲:>120,000 字的請求被擋下且錯誤文案如實(不承諾重按有效)
 */
import { t, summary, freshState } from './_env.mjs';

// 凍結時間:一切時間相關素材(紀念日命中、日期附註、現在時間)以此為準
const NOW = new Date('2026-07-21T20:00:00').getTime();
const realNow = Date.now;
Date.now = () => NOW;

const state = await freshState();
const { createCharacter, createGroup, branchRoom } = await import('../modules/rooms.js');
const { buildPrompt, budgetSlice } = await import('../modules/prompt.js');
const { getRoomMessages, persist } = await import('../modules/state.js');
const {
  saveApiConfig, generateReply, estimateRequestChars, REQUEST_CHAR_FUSE, stripNamePrefix,
} = await import('../modules/api.js');

/* --- 佈景:一個 DM 房塞滿全部動態素材 --- */
const { character: A, dmRoom: dmA } = await createCharacter({ name: '甲' });
const { character: B } = await createCharacter({ name: '乙' });

// 世界書:一常駐條目+一觸發式條目(全域書)
state.worldbooks = [{
  id: 'wb1', name: '測試書', enabled: true, scope: { global: true },
  entries: [
    { id: 'e-const', title: '常駐', enabled: true, alwaysOn: true, keywords: [], secondaryKeywords: [], content: '常駐世界觀W0', createdAt: NOW - 1000, priority: 100 },
    { id: 'e-trig', title: '觸發', enabled: true, alwaysOn: false, keywords: ['咖啡'], secondaryKeywords: [], content: '觸發條目W1', createdAt: NOW - 900, priority: 100 },
  ],
}];

// 記憶:私密一筆(有 eventDate,供絕對日期斷言)+共享一筆「上個月今天」(供紀念日命中)
state.memories.byCharacterId[A.id] = [
  { id: 'm-p1', content: '私密記憶M1', createdAt: NOW - 30 * 86400000, eventDate: '2026-06-11' },
];
state.memories.shared.push(
  { id: 'm-s1', circleId: null, content: '共享紀念MS', createdAt: NOW - 30 * 86400000, eventDate: '2026-06-21' },
);
// 乙的私密記憶(祕密代號法:絕不可流入甲的 prompt/尾巴)
state.memories.byCharacterId[B.id] = [
  { id: 'm-b1', content: '祕密代號TAIL9', createdAt: NOW - 1000, eventDate: '' },
];

// 社群動態一篇(無圈=全域可見)
state.posts = [{ id: 'post1', authorId: 'player', personaId: null, content: '公開動態P1', createdAt: NOW - 5000 }];

// 跨介面內容:甲也在的群,丟一則訊息
const g = await createGroup('小群', [A.id, B.id]);
getRoomMessages(g.id).push({ id: 'gm1', role: 'user', senderId: 'player', content: '跨介面內容X1', createdAt: NOW - 4000 });

// DM 歷史:含「咖啡」觸發字
getRoomMessages(dmA.id).push(
  { id: 'd1', role: 'user', senderId: 'player', content: '想喝咖啡', createdAt: NOW - 3000 },
  { id: 'd2', role: 'character', senderId: A.id, content: '走啊', createdAt: NOW - 2000 },
  { id: 'd3', role: 'user', senderId: 'player', content: '現在出發', createdAt: NOW - 1000 },
);
await persist();

/* --- 1) 快取穩定性 --- */
const p1 = buildPrompt({ character: A, roomId: dmA.id });
const p2 = buildPrompt({ character: A, roomId: dmA.id });
t(p1.system === p2.system, '固定 state 連跑兩輪 system 逐字相等');
t(!p1.system.includes('現在是'), 'system 不含「現在是」');
t(!/約\s*\d+\s*(天|個月|年)前/.test(p1.system), 'system 不含「約 N 天前」');
t(!p1.system.includes('本輪觸發'), 'system 不含「本輪觸發」');
t(p1.system.includes('(6/11)'), '記憶附註為絕對日期 (M/D)(私密 eventDate)');
t(p1.system.includes('常駐世界觀W0'), '常駐世界書條目留在 system');
t(!p1.system.includes('觸發條目W1'), '觸發式世界書條目不在 system');

/* --- 2) 動態尾巴完整性+修訂一位置 --- */
const tail = p1.meta.dynamicTail;
t(tail.startsWith('【系統附註|'), '尾巴以系統附註框式開頭');
t(tail.includes('【現在時間】') && tail.includes('現在是'), '尾巴含【現在時間】全文');
t(tail.includes('【世界書|本輪觸發】') && tail.includes('觸發條目W1'), '尾巴含本輪觸發的世界書條目');
t(!tail.includes('常駐世界觀W0'), '常駐條目不重複進尾巴');
t(tail.includes('【今天是特別的日子】') && tail.includes('共享紀念MS'), '尾巴含紀念日升級段(語意不變)');
t(tail.includes('公開動態P1'), '尾巴含最近社群動態');
t(tail.includes('跨介面內容X1'), '尾巴含跨介面近期內容');
const lastUser = [...p1.messages].reverse().find((m) => m.role === 'user');
t(lastUser.content.startsWith('【系統附註|'), '修訂一:尾巴併入最新 user 訊息文字最前');
t(lastUser.content.includes('現在出發'), '玩家原文仍在(附註之後)');
t(p1.messages.filter((m) => m.content.includes('【系統附註|')).length === 1, '尾巴只注入一處');
t(!/約\s*\d+\s*(天|個月|年)前/.test(tail), '尾巴的勿複述文案不再提「約 N 天前」舊格式');

/* --- 4) 隱私:尾巴不讓私密素材流入非本人 prompt(全套由 privacy.test.mjs 重跑) --- */
t(!JSON.stringify(p1).includes('TAIL9'), '乙的私密記憶不在甲的整包 prompt(含尾巴)');

/* --- 5) 鸚鵡:剝除器保留不拆(全套由 parrot.test.mjs 重跑) --- */
t(stripNamePrefix('約好了(約 3 天前)見面', []) === '約好了見面', 'REL_TIME_ECHO 剝除器仍有效(舊資料防線)');

/* --- 3) 錨定行為(直接打 budgetSlice 純函式) --- */
await saveApiConfig({ contextBudget: 100 });
const mk = (i) => ({ id: `x${i}`, role: 'user', content: '三'.repeat(30), createdAt: NOW - 100000 + i });
const msgs = Array.from({ length: 10 }, (_, i) => mk(i + 1));
const room = { id: 'r-slice', type: 'dm', ctxAnchorMsgId: null };
const s1 = budgetSlice(msgs, room);
const anchor1 = room.ctxAnchorMsgId;
t(s1.length === 3 && anchor1 === s1[0].id, '無錨:照現行邏輯裁一次並立錨(錨=最舊一則)');
const s2 = budgetSlice(msgs, room);
t(s2[0].id === s1[0].id && room.ctxAnchorMsgId === anchor1, '未超預算連續呼叫:起點與錨皆不變');
msgs.push(mk(11), mk(12)); // 錨起算成本 150 > 100 → 重錨
const s3 = budgetSlice(msgs, room);
const cost3 = s3.reduce((s, m) => s + m.content.length, 0);
t(cost3 <= Math.floor(100 * 0.65), '超預算:裁至 ≤65%×預算');
t(room.ctxAnchorMsgId === s3[0].id && room.ctxAnchorMsgId !== anchor1, '超預算:立新錨');
room.ctxAnchorMsgId = 'ghost-已刪訊息';
let sliceOk = true; let s4 = [];
try { s4 = budgetSlice(msgs, room); } catch { sliceOk = false; }
t(sliceOk && room.ctxAnchorMsgId === s4[0].id, '錨失效:不拋錯、重立錨');
await saveApiConfig({ contextBudget: 10 });
t(budgetSlice(msgs, { id: 'r2', type: 'dm', ctxAnchorMsgId: null }).length === 2, '「至少保留 2 則」語意不變');
await saveApiConfig({ contextBudget: 100 });
t(budgetSlice(msgs).length === 3 && budgetSlice(msgs)[0].id === msgs[msgs.length - 3].id, '不帶 room(其他建構器):行為與舊裁法相同、不讀不寫錨');

// 分岔房不繼承:真實 branchRoom 深拷貝會帶著母房的錨,但訊息全換新 id → 錨失效重立
const anchorMother = dmA.ctxAnchorMsgId; // buildPrompt 已為母房立過錨
const br = await branchRoom(dmA.id, 'd3');
t(br.ctxAnchorMsgId === anchorMother, '前提確認:分岔深拷貝帶著母房的錨值');
const brSlice = budgetSlice(getRoomMessages(br.id), br);
t(br.ctxAnchorMsgId !== anchorMother && br.ctxAnchorMsgId === brSlice[0].id, '分岔房:母房錨天然失效 → 立自己的錨(不繼承)');

/* --- 6) 保險絲 --- */
t(estimateRequestChars({ system: 'ab', messages: [{ content: 'cd', speaker: 'ef' }] }) === 6, '估量含 system+內容+speaker 前綴');
const fuseCfg = { provider: 'openai', apiKey: 'k', model: 'm' };
const big = { system: 'x'.repeat(REQUEST_CHAR_FUSE + 1), messages: [], meta: { maxReplyChars: 800 } };
const r = await generateReply(fuseCfg, big);
t(r.ok === false && r.message.includes('單次請求過大'), '>120,000 字被擋下且文案如實');
t(!r.message.includes('再試') && !r.message.includes('重按'), '文案不承諾重按有效');

Date.now = realNow;
summary('c1 快取分層');
