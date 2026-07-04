/**
 * modules/diary.js
 * 角色日記:第一人稱、寫給自己看的私人筆記。
 * 素材只用「這個角色自己知道的事」——他與玩家的 DM、他參與的群聊/正文、
 * 公開社群動態、共享記憶與他自己的私密記憶。其他角色的 DM 絕不進入。
 * 由角色頁的 ↻ 觸發生成(與發文/主動訊息同一套節流),絕不背景消耗 API。
 */

import { getState, genId, persist, getCharacter, getRoomMessages } from './state.js';
import { getApiConfig, generateReply, stripNamePrefix } from './api.js';
import { getPersona, defaultPersona } from './persona.js';
import { matchEntries } from './worldbook.js';
import { sharedMemoriesFor } from './memory.js';
import { albumTextFor } from './album.js';
import { globalPromptSection } from './prompt.js';
import { rollLengthDirective } from './social.js';
import { hashStr, pick, traitOf, sceneOf } from './chat.js';

export function getDiaries(characterId) {
  const state = getState();
  if (!state.diariesByCharacterId) state.diariesByCharacterId = {};
  if (!state.diariesByCharacterId[characterId]) state.diariesByCharacterId[characterId] = [];
  return state.diariesByCharacterId[characterId];
}

export async function deleteDiary(characterId, diaryId) {
  const list = getDiaries(characterId);
  const idx = list.findIndex((d) => d.id === diaryId);
  if (idx !== -1) list.splice(idx, 1);
  await persist();
}

export function diaryCooldownLeft() {
  const state = getState();
  const cooldownMs = (state.settings.autoPostCooldownMin ?? 10) * 60000;
  return Math.max(0, Math.ceil(((state.diaryLastRefresh || 0) + cooldownMs - Date.now()) / 1000));
}

/** 這個角色「知道」的近期脈絡(自己的 DM + 參與的群聊/正文,各取尾段)。 */
function knownContextOf(character) {
  const state = getState();
  const persona = getPersona(character.knownPersonaId) || defaultPersona();
  const lines = [];
  const rooms = state.rooms.filter((r) => r.participantIds.includes(character.id));
  for (const r of rooms.slice(0, 4)) {
    const msgs = getRoomMessages(r.id).slice(r.type === 'dm' ? -6 : -4);
    if (!msgs.length) continue;
    lines.push(`《${r.type === 'dm' ? '私訊' : r.title}》`);
    for (const m of msgs) {
      const who = m.role === 'user' ? (persona?.name || '玩家')
        : m.senderId === character.id ? '我'
          : (getCharacter(m.senderId)?.name || '旁白');
      lines.push(`${who}:${m.content.slice(0, 60)}`);
    }
  }
  return lines.join('\n') || '(最近沒什麼互動)';
}

export function buildDiaryPrompt(character, rng = Math.random) {
  const state = getState();
  const persona = getPersona(character.knownPersonaId) || defaultPersona();
  const context = knownContextOf(character);

  const posts = (state.posts || []).slice(0, 4)
    .map((p) => `- ${p.authorId === 'player' ? (getPersona(p.personaId)?.name || '玩家') : (getCharacter(p.authorId)?.name || '?')}:${p.content.slice(0, 40)}`)
    .join('\n') || '(無)';

  const myPrivate = (state.memories.byCharacterId[character.id] || [])
    .map((m) => `- ${m.pinned ? '(重要)' : ''}${m.content}`).join('\n') || '(無)';
  const shared = sharedMemoriesFor(character.knownPersonaId || state.defaultPersonaId).map((m) => `- ${m.content}`).join('\n') || '(無)';

  const lore = matchEntries({ characterId: character.id, recentText: context });
  const loreText = lore.length
    ? lore.map((e) => `- ${e.content}`).join('\n')
    : '(無)';

  const system = [
    ...globalPromptSection(),
    `你是「${character.name}」,正在寫只給自己看的日記。`,
    `【你的資料】${character.description || '(無)'};個性:${character.personality || '(未提供)'}${character.scenario ? `;情境:${character.scenario}` : ''}`,
    `【你最近經歷的對話】\n${context}`,
    `【最近的社群動態】\n${posts}`,
    `【你記得的事】\n${myPrivate}`,
    ...(albumTextFor(character.id) ? [`【相簿裡的回憶】\n${albumTextFor(character.id)}`] : []),
    `【大家都知道的事】\n${shared}`,
    `【世界觀】\n${loreText}`,
    `【寫作指令】第一人稱,寫給自己看——可以坦白你對「${persona?.name || '那個人'}」的真實想法,包括嘴上不會說的。`
      + `口吻要像私下的你,不是對外的你。只輸出日記內容本身,不要日期、不要名字前綴、不要引號包裹。`
      + rollLengthDirective('diary', rng),
  ].join('\n\n');

  return {
    system,
    messages: [{ role: 'user', content: '(夜深了,你翻開日記。)' }],
    meta: { maxReplyChars: 600, roomType: 'diary' },
  };
}

/**
 * 生成一篇日記。回傳 {ok, entry?, message?}。
 * @param {{force?:boolean, rng?:()=>number}} [opts]
 */
export async function generateDiary(characterId, opts = {}) {
  const state = getState();
  const rng = opts.rng || Math.random;
  const character = getCharacter(characterId);
  if (!character) return { ok: false, message: '找不到角色' };
  if (!opts.force) {
    const left = diaryCooldownLeft();
    if (left > 0) return { ok: false, message: `再等 ${Math.ceil(left / 60)} 分鐘可以再翻他的日記` };
  }
  state.diaryLastRefresh = Date.now();
  await persist();

  const cfg = getApiConfig();
  let content = '';
  if (cfg.useRealApi && cfg.apiKey && cfg.model) {
    const r = await generateReply(cfg, buildDiaryPrompt(character, rng));
    if (!r.ok) return { ok: false, message: r.message };
    content = stripNamePrefix(r.text, [character.name]);
  } else {
    const seed = hashStr(character.id) + Math.floor(Date.now() / 60000);
    content = pick([
      '今天很吵。但不討厭。',
      `${sceneOf(character) ? `${sceneOf(character)}。` : ''}想早點睡,結果又想東想西。`,
      `寫下來就好一點。${traitOf(character) ? `${traitOf(character)}的人也是會累的。` : ''}`.trim(),
      '沒什麼特別的一天。硬要說的話,有一句話一直留在腦子裡。',
    ], seed);
  }
  if (!content) return { ok: false, message: '這次沒寫出東西,再試一次' };

  const entry = { id: genId('dia'), content, createdAt: Date.now() };
  getDiaries(characterId).unshift(entry);
  await persist();
  return { ok: true, entry };
}
