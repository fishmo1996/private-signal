/**
 * tests/modelroute.test.mjs — v97(w3)每房模型覆寫的路由斷言:
 * 1) 覆寫房走覆寫模型(mock fetch 驗 body.model)
 * 2) 未覆寫房不受影響(主模型);空字串覆寫=跟隨全域
 * 3) 雜務通道不吃覆寫:tier secondary 走次要模型;解析順序=覆寫>次要>主
 * 4) migrate 補 modelOverride 欄
 * 5) 接線靜態斷言:chat.js 主線呼叫點帶 modelOverride、心聲呼叫點維持 tier secondary 不帶
 */
import { readFileSync } from 'node:fs';
import { t, summary, freshState } from './_env.mjs';

await freshState();
const { generateReply } = await import('../modules/api.js');
const { createCharacter } = await import('../modules/rooms.js');

/* --- mock fetch:攔截請求、記下 body,回 OpenAI 格式假回覆 --- */
let captured = null;
globalThis.fetch = async (url, init) => {
  captured = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '好' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  };
};

const cfg = { provider: 'openai', apiKey: 'k', model: 'main-model', secondaryModel: 'cheap-model' };
const prompt = { system: 's', messages: [{ role: 'user', content: 'hi' }], meta: { maxReplyChars: 100 } };

/* --- 1~3) 解析順序 --- */
let r = await generateReply(cfg, prompt);
t(r.ok && captured.model === 'main-model', '無覆寫無 tier:走主模型');
r = await generateReply(cfg, prompt, { modelOverride: 'pro-x' });
t(r.ok && captured.model === 'pro-x', '覆寫房:走覆寫模型');
r = await generateReply(cfg, prompt, { modelOverride: '   ' });
t(r.ok && captured.model === 'main-model', '空白覆寫=跟隨全域(主模型)');
r = await generateReply(cfg, prompt, { tier: 'secondary' });
t(r.ok && captured.model === 'cheap-model', '雜務(tier secondary):走次要模型、不吃覆寫(呼叫點不帶)');
r = await generateReply(cfg, prompt, { tier: 'secondary', modelOverride: 'pro-x' });
t(r.ok && captured.model === 'pro-x', '解析順序:覆寫 > 次要(候補簿明訂;實務上雜務點不帶覆寫)');
r = await generateReply({ ...cfg, secondaryModel: '' }, prompt, { tier: 'secondary' });
t(r.ok && captured.model === 'main-model', '次要未設:tier secondary 照舊退回主模型');

/* --- 4) migrate:欄位在「下一次開機」補上;開機前 undefined 由路由端容忍(=跟隨全域) --- */
const { dmRoom } = await createCharacter({ name: '甲' });
t(dmRoom.modelOverride === undefined, '前提:開機後新建的房尚無欄位(migrate 是開機時跑)');
const { persist, initState, getState } = await import('../modules/state.js');
await persist();
await initState({ appName: '測試', defaultPlayer: { playerName: '玩家' }, defaultSettings: {} }); // 模擬重開機
const reloaded = getState().rooms.find((rr) => rr.id === dmRoom.id);
t(reloaded.modelOverride === '', 'migrate:重開機後所有房補 modelOverride 空字串');

/* --- 5) 接線靜態斷言(xss.test 前例:守呼叫點不被之後的改動悄悄拆掉) --- */
const chatSrc = readFileSync(new URL('../modules/chat.js', import.meta.url), 'utf8');
t((chatSrc.match(/modelOverride: room\.modelOverride/g) || []).length >= 5,
  'chat.js 主線呼叫點(DM/主動/群包/群solo/正文)帶 modelOverride(≥5 處)');
t(chatSrc.includes("generateReply(cfg, prompt, { tier: 'secondary' })"),
  '心聲呼叫點維持 tier secondary、不帶覆寫');
const hygiene = ['diary.js', 'phonepeek.js', 'social.js', 'memory.js']
  .every((f) => !readFileSync(new URL(`../modules/${f}`, import.meta.url), 'utf8').includes('modelOverride'));
t(hygiene, '雜務模組(日記/偷看/社群/摘要)零 modelOverride 字樣(不吃覆寫)');

summary('模型路由(w3)');
