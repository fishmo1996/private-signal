/**
 * tests/promptlang.test.mjs — promptLang 雙語骨架同步不變式(v92 起常駐)。
 * v78 立下「zh/en 兩版語意必須同步」但只靠註解提醒——本檔把它變成紅綠燈。
 * 守的三件事(改任一版規則、另一版沒跟上就會亮紅):
 *   1. 硬規則不可掉:en 版三型建構器結尾都必須有「繁中輸出」與「」引號」兩條
 *   2. 設定開關對稱:chatFeel/voiceTag/moodEmoji/charStatus 關掉時,zh 與 en 同步失效
 *   3. 標記不翻譯:[心情:x][狀態:...][語音][▷] 在兩版都維持原樣(輸出端收割器認的是這些字面)
 * 註:只驗「骨架語言開關」涵蓋的三型(DM/群聊/正文);心聲/點名/自聊指令 v78 明訂維持中文,不在範圍。
 */
import { t, summary, freshState } from './_env.mjs';

const state = await freshState();
const { createCharacter, createGroup, createStory } = await import('../modules/rooms.js');
const { buildPrompt, buildGroupPrompt, buildStoryPrompt } = await import('../modules/prompt.js');
const api = await import('../modules/api.js');

// 佈景:一 DM、一群聊、一正文
const { character: A, dmRoom } = await createCharacter({ name: '甲', systemPrompt: '測試角色' });
const { character: B } = await createCharacter({ name: '乙' });
const group = await createGroup('群', [A.id, B.id]);
const story = await createStory('場景', [A.id]);

const flat = (p) => (typeof p.system === 'string' ? p.system : JSON.stringify(p.system));
async function setLang(lang) { await api.saveApiConfig({ promptLang: lang }); }
function buildAll() {
  return {
    dm: flat(buildPrompt({ character: A, roomId: dmRoom.id })),
    group: flat(buildGroupPrompt({ roomId: group.id })),
    story: flat(buildStoryPrompt({ roomId: story.id })),
  };
}
// chatFeel 真正管的是「回覆指令/Reply Rules」那一段;system 尾端另有 v80 三明治
// (【格式重申…】/[Format override…]),它獨立於 chatFeel、兩版都恆含 ---,不納入開關斷言。
function replySection(sys) {
  const seg = sys.split('\n\n').find((s) => s.includes('回覆指令') || s.includes('Reply Rules'));
  return seg || '';
}

// ── 1) en 版硬規則:三型都要有繁中輸出 + 「」引號 ──
await setLang('en');
const en = buildAll();
for (const [k, sys] of Object.entries(en)) {
  t(/Traditional Chinese \(Taiwan\)/.test(sys), `en/${k}:含「繁體中文輸出」硬規則`);
  t(sys.includes('「」'), `en/${k}:含「」引號硬規則`);
}
// 骨架確實切成英文(抓「沒真的切換」的漂移)
t(/【Reply Rules】/.test(en.dm), 'en/dm:骨架為英文(Reply Rules)');
t(/【Output Format】/.test(en.group), 'en/group:骨架為英文(Output Format)');
t(/Style: interactive fiction/.test(en.story), 'en/story:骨架為英文(Style)');

// ── 2) 標記不翻譯:兩版都維持中文字面(輸出端收割器認這些)──
await setLang('zh');
const zh = buildAll();
t(zh.dm.includes('[心情:') && en.dm.includes('[心情:'), '[心情:x] 兩版皆維持原樣');
t(zh.dm.includes('[語音]') && en.dm.includes('[語音]'), '[語音] 兩版皆維持原樣');
t(zh.dm.includes('[狀態') && en.dm.includes('[狀態'), '[狀態:...] 兩版皆維持原樣');
t(zh.story.includes('▷') && en.story.includes('▷'), '▷ 選項符號兩版皆維持原樣');

// ── 3) 設定開關對稱:關掉某開關時,zh 與 en 同步不再掛該標記 ──
// voiceTag 關 → 兩版都不得出現 [語音] 指令
state.settings.voiceTag = false;
await setLang('zh'); const zhNoVoice = buildAll();
await setLang('en'); const enNoVoice = buildAll();
t(!zhNoVoice.dm.includes('[語音]'), 'voiceTag 關:zh 不掛語音標記');
t(!enNoVoice.dm.includes('[語音]'), 'voiceTag 關:en 同步不掛語音標記');
state.settings.voiceTag = true;

// moodEmoji 關 → 兩版都不得出現 [心情 指令
state.settings.moodEmoji = false;
await setLang('zh'); const zhNoMood = buildAll();
await setLang('en'); const enNoMood = buildAll();
t(!zhNoMood.dm.includes('[心情:'), 'moodEmoji 關:zh 不掛心情標記');
t(!enNoMood.dm.includes('[心情:'), 'moodEmoji 關:en 同步不掛心情標記');
state.settings.moodEmoji = true;

// charStatus 關 → 兩版都不得出現 [狀態 指令
state.settings.charStatus = false;
await setLang('zh'); const zhNoStatus = buildAll();
await setLang('en'); const enNoStatus = buildAll();
t(!zhNoStatus.dm.includes('[狀態'), 'charStatus 關:zh 不掛狀態標記');
t(!enNoStatus.dm.includes('[狀態'), 'charStatus 關:en 同步不掛狀態標記');
state.settings.charStatus = true;

// chatFeel 關 → 兩版 DM 都改「單則」模式(不再要求 --- 拆條)
state.settings.chatFeel = false;
await setLang('zh'); const zhNoFeel = buildAll();
await setLang('en'); const enNoFeel = buildAll();
t(!replySection(zhNoFeel.dm).includes('---'), 'chatFeel 關:zh 回覆指令段不要求 --- 拆條');
t(!/separated by a line containing only/.test(replySection(enNoFeel.dm)), 'chatFeel 關:en 回覆指令段同步不要求 --- 拆條');
// 反向迴歸:chatFeel 開時,回覆指令段兩版都應含拆條要求(確認斷言有效、非恆真)
{
  const zhOn = replySection(zh.dm), enOn = replySection(en.dm);
  t(zhOn.includes('---'), 'chatFeel 開:zh 回覆指令段含 --- 拆條(斷言有效性)');
  t(/separated by a line containing only/.test(enOn), 'chatFeel 開:en 回覆指令段含 --- 拆條(斷言有效性)');
}
state.settings.chatFeel = true;

// ── 4) 預設仍是 zh,且 zh 骨架為中文(迴歸:預設行為不變)──
await setLang('zh');
const back = buildAll();
t(/【回覆指令】/.test(back.dm), 'zh/dm:骨架為中文(回覆指令)');
t(/【輸出格式】/.test(back.group), 'zh/group:骨架為中文(輸出格式)');
t(!/【Reply Rules】/.test(back.dm), 'zh/dm:不混入英文骨架');

summary('promptLang 雙語同步');
