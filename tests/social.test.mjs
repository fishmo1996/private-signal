/**
 * tests/social.test.mjs — 社群樓中樓不變式(v79 起):
 * 1) 歸樓守恆:任何結構(深樓/孤兒/循環壞資料)都不吞留言——樓主+樓中樓總數恆等於留言總數
 *    (擁有者實案:舊版 hops<20 保險絲讓 40 則長樓後段無聲消失)
 * 2) threadOf 從樓中任一則都撈得到整樓
 * 3) buildSocialPrompt 切片:指名回覆帶「那一樓完整串(尾20)+其他最新4」;無指名維持尾8
 */
import { t, summary, freshState } from './_env.mjs';

await freshState();
const { createCharacter } = await import('../modules/rooms.js');
const {
  groupComments, threadOf, addComment, createPost, getComments, buildSocialPrompt,
} = await import('../modules/social.js');

const { character: A } = await createCharacter({ name: '甲' });
const post = await createPost('player', '測試貼文本體');

const conserve = (comments) => {
  const { roots, childrenByRoot } = groupComments(comments);
  return roots.length + [...childrenByRoot.values()].reduce((n, a) => n + a.length, 0);
};

// --- 深樓 30 層(每則回覆上一則,鏈深遠超舊版 20 步保險絲) ---
let prev = null;
const ids = [];
for (let i = 0; i < 30; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  const cm = await addComment(post.id, A.id, `樓層${i}`, null,
    prev ? { commentId: prev.id, authorId: A.id, name: '甲' } : null);
  ids.push(cm.id); prev = cm;
}
const { roots, childrenByRoot } = groupComments(getComments(post.id));
t(roots.length === 1, '深樓 30 層:仍歸同一位樓主');
t((childrenByRoot.get(roots[0].id) || []).length === 29, '深樓 30 層:29 則樓中樓一則不少(舊版會吞)');
t(conserve(getComments(post.id)) === 30, '守恆:樓主+樓中樓總數=留言總數');
t(threadOf(post.id, ids[25]).length === 30, 'threadOf:從樓深處任一則撈得到整樓');
t(threadOf(post.id, ids[0]).length === 30, 'threadOf:從樓主本人也撈得到整樓');

// --- 孤兒防呆:replyTo 指向不存在的留言 → 自成樓主,不吞 ---
await addComment(post.id, A.id, '孤兒留言', null, { commentId: 'ghost-id', authorId: A.id, name: '甲' });
t(conserve(getComments(post.id)) === 31, '孤兒防呆:壞 replyTo 也不吞留言');

// --- 循環壞資料防呆(理論上不會有,匯入壞檔才可能):不無窮迴圈、不吞 ---
const x1 = await addComment(post.id, A.id, '循環1', null, null);
const x2 = await addComment(post.id, A.id, '循環2', null, { commentId: x1.id, authorId: A.id, name: '甲' });
x1.replyTo = { commentId: x2.id, authorId: A.id, name: '甲' }; // 手動製造 1↔2 互指
t(conserve(getComments(post.id)) === 33, '循環防呆:互指壞資料不無窮迴圈、不吞留言');
delete x1.replyTo;

// --- buildSocialPrompt 切片(c案) ---
const spThread = buildSocialPrompt({ post, triggerText: 'x', replyToCommentId: ids[28] });
t(spThread.system.includes('這一樓的完整對話串'), 'c案:指名回覆帶完整樓串段');
t(spThread.system.includes('樓層10') && spThread.system.includes('樓層29'), 'c案:樓串帶到尾端 20 則(舊版只帶尾 8)');
t(!spThread.system.includes('樓層3:'), 'c案:超長樓截尾 20,更早樓層不進(控預算)');
const spTop = buildSocialPrompt({ post, triggerText: 'x' });
t(spTop.system.includes('【既有留言】'), 'c案:無指名回覆維持原尾端 8 則模式');

// --- v83(h4):指名回覆單人呼叫接線 ---
const { getApiConfig } = await import('../modules/api.js');
Object.assign(getApiConfig(), { useRealApi: true, provider: 'gemini', apiKey: 'k', model: 'gemini-test' });
const st83 = (await import('../modules/state.js')).getState();
if (!st83.memories.byCharacterId) st83.memories.byCharacterId = {};
st83.memories.byCharacterId[A.id] = [{ id: 'mm83', content: '祕密代號SOLO9', createdAt: Date.now() }];
const cmA = await addComment(post.id, A.id, '甲留下的留言', null, null);
let captured = '';
globalThis.fetch = async (url, init) => {
  captured = String(init?.body || '');
  return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '甲:傻瓜,早點睡。' }] } }] }) };
};
const { generateSocialReplies } = await import('../modules/social.js');
const rr = await generateSocialReplies({ post, triggerText: '哼', replyToCommentId: cmA.id });
t(rr.ok && rr.replies.length === 1 && rr.replies[0].characterId === A.id, 'v83 h4:指名回覆某角色留言→單人呼叫,只他出面');
t(rr.replies[0].content === '傻瓜,早點睡。', 'v83 h4:單人回覆剝名字前綴');
t(captured.includes('SOLO9'), 'v83 h4:單人呼叫帶本人私密記憶(DM 等級認知)');
// 回覆「玩家自己的」留言 → 不走單人,照舊群呼叫(此處 mock 回 JSON 包)
globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[{"name":"甲","content":"群包回覆"}]' }] } }] }) });
const cmP = await addComment(post.id, 'player', '玩家自己的留言', null, null);
const rr2 = await generateSocialReplies({ post, triggerText: 'x', replyToCommentId: cmP.id });
t(rr2.ok && rr2.replies[0]?.content === '群包回覆', 'v83 h4:回覆玩家留言不走單人,落回群呼叫');

summary('社群樓中樓');
