/**
 * tests/jsonrescue.test.mjs — JSON 救援解析不變式(v66 banter 首戰事故):
 * 1) 合法 JSON 路徑迴歸(含 markdown 圍欄)
 * 2) 裸換行/尾逗號炸掉 JSON.parse 時,正則逐物件救援
 * 3) 全救不回才走 fallback,且 fallback 是可讀文字(不是原始碼示人)
 */
import { t, summary, freshState } from './_env.mjs';

await freshState();
const { parseGroupReplies } = await import('../modules/api.js');

const P = [{ id: 'c1', name: '甲' }, { id: 'c2', name: '乙' }];

// 1) 合法 JSON
const r1 = parseGroupReplies('[{"name":"甲","content":"哈囉"},{"name":"乙","content":"嗨"}]', P);
t(r1.length === 2 && r1[0].characterId === 'c1' && r1[1].content === '嗨', '合法 JSON 正常解析');

const r2 = parseGroupReplies('```json\n[{"name":"甲","content":"哈囉"}]\n```', P);
t(r2.length === 1 && r2[0].characterId === 'c1', 'markdown 圍欄剝除後解析');

// 2) 裸換行救援(JSON.parse 必炸的輸入)
const broken = '[{"name":"甲","content":"第一行\n第二行"},{"name":"乙","content":"嗨"},]';
let parseThrew = false;
try { JSON.parse(broken); } catch { parseThrew = true; }
t(parseThrew, '前提確認:這筆輸入 JSON.parse 會炸');
const r3 = parseGroupReplies(broken, P);
t(r3.length === 2, '裸換行+尾逗號:正則救援撈回兩則');
t(r3[0].content.includes('第一行') && r3[0].content.includes('第二行'), '救援後裸換行內容還原');

// 3) 全救不回 → fallback 給第一位參與者,而且不是空的
const r4 = parseGroupReplies('模型今天心情不好只想聊天不想給 JSON', P);
t(r4.length === 1 && r4[0].characterId === 'c1' && r4[0].content.length > 0, '垃圾輸出 fallback 為第一人單則');

// 4) 名字模糊配對(includes 雙向)
const r5 = parseGroupReplies('[{"name":"甲同學","content":"在"}]', P);
t(r5.length === 1 && r5[0].characterId === 'c1', '名字模糊配對(甲同學→甲)');

// 5) 空 content 條目被略過
const r6 = parseGroupReplies('[{"name":"甲","content":""},{"name":"乙","content":"有料"}]', P);
t(r6.length === 1 && r6[0].characterId === 'c2', '空 content 略過不佔額度');

// 6) v77:平衡大括號救援第二層——鍵序顛倒(content 在 name 前)正則層撈不到,平衡層要接住
const r7 = parseGroupReplies('{"content":"嗨","name":"甲"}', P);
t(r7.length === 1 && r7[0].characterId === 'c1' && r7[0].content === '嗨', 'v77 平衡大括號救援:鍵序顛倒+漏外層 [] 仍撈回');

// 7) v77:合法路徑迴歸——加固不可影響正常 JSON
const r7b = parseGroupReplies('[{"name":"甲","content":"哈囉"},{"name":"乙","content":"嗨"}]', P);
t(r7b.length === 2, 'v77 迴歸:合法 JSON 不受加固影響');

// 8) v77(根源二):Gemini 安全攔截誤報修正——blockReason/finishReason 回真實原因與 blocked 型別,
//    不再統一誤報「格式不合」誤導使用者無效重按(擁有者連按五次實案)
const { generateReply } = await import('../modules/api.js');
const CFG = { provider: 'gemini', apiKey: 'k', model: 'gemini-test', presets: [null, null, null] };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, candidates: [] }) });
const rb1 = await generateReply(CFG, { system: 's', messages: [], meta: {} });
t(!rb1.ok && rb1.blocked === true && /安全過濾/.test(rb1.message) && /PROHIBITED_CONTENT/.test(rb1.message), 'v77 安全攔截:blockReason 回真實原因(blocked 型別)');
globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }) });
const rb2 = await generateReply(CFG, { system: 's', messages: [], meta: {} });
t(!rb2.ok && rb2.blocked === true, 'v77 安全攔截:finishReason=SAFETY 同樣分流');
globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '正常回覆' }] } }] }) });
const rb3 = await generateReply(CFG, { system: 's', messages: [], meta: {} });
t(rb3.ok && rb3.text === '正常回覆', 'v77 迴歸:finishReason=STOP 正常路徑不受影響');

summary('JSON 救援');
