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

summary('JSON 救援');
