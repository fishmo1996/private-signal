/**
 * tests/meminbox.test.mjs — v99(y3)待確認記憶收件匣(照候補簿必加斷言):
 * 1) 提案絕不進任何 prompt(祕密代號法,五型建構器全掃)
 * 2) 開關預設關=零呼叫;mock 模式不提案;非 DM 房不提案
 * 3) 節流:未達 N 則新訊息不打;達標打一次並更新錨;失敗不連環燒(門檻先記)
 * 4) 採納:入庫為「該角色私密記憶」(DM 記住同語意),收件匣移除
 * 5) 駁回:僅移除,不入庫不留痕
 */
import { t, summary, freshState } from './_env.mjs';

const state = await freshState();
const { createCharacter, createGroup } = await import('../modules/rooms.js');
const {
  maybeProposeMemories, adoptInboxItem, rejectInboxItem, memoryInbox,
} = await import('../modules/memory.js');
const { buildPrompt, buildGroupPrompt, buildPeekPrompt, buildStoryPrompt } = await import('../modules/prompt.js');
const { saveApiConfig } = await import('../modules/api.js');
const { getRoomMessages, persist } = await import('../modules/state.js');

/* --- mock fetch:計次+回可控 JSON 陣列 --- */
let fetchCount = 0;
let replyItems = ['兩人約好週五去海邊看日落', '玄恆記住了玩家怕打雷'];
globalThis.fetch = async () => {
  fetchCount += 1;
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(replyItems) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  };
};

const { character: A, dmRoom } = await createCharacter({ name: '甲' });
const { character: B } = await createCharacter({ name: '乙' });
const push = (n) => { for (let i = 0; i < n; i += 1) getRoomMessages(dmRoom.id).push({ id: `m${Date.now()}${i}${Math.random()}`, role: i % 2 ? 'character' : 'user', senderId: i % 2 ? A.id : 'player', content: `訊息${i}`, createdAt: Date.now() }); };
await saveApiConfig({ provider: 'openai', apiKey: 'k', model: 'm', useRealApi: true });

/* --- 2) 開關預設關/mock/房型 --- */
push(10);
let r = await maybeProposeMemories(dmRoom.id);
t(r.skipped === 'off' && fetchCount === 0, '開關預設關:不提案、零呼叫');
state.settings.memoryInboxOn = true;
const g = await createGroup('群', [A.id, B.id]);
r = await maybeProposeMemories(g.id);
t(r.skipped === 'roomType' && fetchCount === 0, '非 DM 房:不提案');
state.apiConfig.useRealApi = false;
r = await maybeProposeMemories(dmRoom.id);
t(r.skipped === 'mock' && fetchCount === 0, 'mock 模式:不提案不燒(假提案=噪音)');
state.apiConfig.useRealApi = true;

/* --- 3) 節流+提案入匣 --- */
r = await maybeProposeMemories(dmRoom.id); // 10 則新訊息 ≥ 預設 6
t(r.ok && r.added === 2 && fetchCount === 1, '達門檻:提案一次、入匣 2 筆(上限 2)');
t(dmRoom.memInboxAt === getRoomMessages(dmRoom.id).length, '節流錨更新為當下訊息數');
r = await maybeProposeMemories(dmRoom.id);
t(r.skipped === 'throttle' && fetchCount === 1, '未累積新訊息:節流擋下、零新呼叫');
push(3);
r = await maybeProposeMemories(dmRoom.id);
t(r.skipped === 'throttle' && fetchCount === 1, '新訊息未達 N(預設 6):仍節流');

/* --- 1) 提案絕不進任何 prompt(祕密代號法) --- */
memoryInbox().push({ id: 'inb-x', roomId: dmRoom.id, characterId: A.id, content: '祕密代號INBX', suggestedCircle: null, createdAt: Date.now() });
await persist();
const { createStory, createPeek } = await import('../modules/rooms.js');
const sc = await createStory('正文', [A.id, B.id]);
const pk = await createPeek('旁觀', [A.id, B.id]);
const flat = (p) => JSON.stringify(p);
t(!flat(buildPrompt({ character: A, roomId: dmRoom.id })).includes('INBX'), 'DM prompt 不含收件匣提案');
t(!flat(buildGroupPrompt({ roomId: g.id })).includes('INBX'), '群 prompt 不含收件匣提案');
t(!flat(buildStoryPrompt({ roomId: sc.id })).includes('INBX'), '正文 prompt 不含收件匣提案');
t(!flat(buildPeekPrompt({ roomId: pk.id })).includes('INBX'), '旁觀 prompt 不含收件匣提案');

/* --- 4) 採納 --- */
const before = (state.memories.byCharacterId[A.id] || []).length;
const adopted = await adoptInboxItem('inb-x');
t(adopted && (state.memories.byCharacterId[A.id] || []).some((m) => m.content === '祕密代號INBX'), '採納:入庫為該角色私密記憶(DM 記住同語意)');
t((state.memories.byCharacterId[A.id] || []).length === before + 1, '採納:私密池 +1');
t(!memoryInbox().some((x) => x.id === 'inb-x'), '採納:收件匣移除');
t(!state.memories.shared.some((m) => m.content?.includes('INBX')), '採納:絕不落入共享池(隱私語意)');

/* --- 5) 駁回 --- */
const n0 = memoryInbox().length; // 先前提案的 2 筆還在
const target = memoryInbox()[0];
t(await rejectInboxItem(target.id) === true && memoryInbox().length === n0 - 1, '駁回:僅移除收件匣');
t(!(state.memories.byCharacterId[A.id] || []).some((m) => m.content === target.content), '駁回:未入庫不留痕');
t(await rejectInboxItem('inb-不存在') === false, '駁回不存在的 id:安全回 false');

summary('記憶收件匣(y3)');
