/**
 * modules/chat.js
 * 訊息傳送與第一版的本機假回覆(mock)。
 * 不呼叫任何 API。所有假回覆都會先經過 buildPrompt,
 * 取用角色設定、玩家設定與可見記憶，讓未來換成真實 AI 時資料流一致。
 */

import { getCharacter,
  getState, genId, persist, getRoom, getRoomMessages, getRoomCharacters,
} from './state.js';
import { buildPrompt, buildGroupPrompt, buildStoryPrompt, buildPeekPrompt, buildRoomInnerVoicePrompt } from './prompt.js';
import { getApiConfig, generateReply, stripNamePrefix, parseGroupReplies, stripTsPrefix } from './api.js';
import { extractVoiceTag, extractMoodTag, extractStatusTag } from './voice.js';
import { anniversaryTextFor } from './album.js';
import { anniversaryMemoryHits } from './memory.js';
import { ttsAvailable } from './voice.js';

/* ---------------- 基礎工具 ---------------- */

export function hashStr(s) {
  let h = 7;
  for (const ch of String(s)) h = ((h * 31) + ch.codePointAt(0)) >>> 0;
  return h;
}

export function pick(arr, seed) {
  return arr[seed % arr.length];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 取使用者訊息的短片段供角色「接話」。 */
export function echoOf(text, max = 16) {
  const clean = text.trim().replace(/\s+/g, ' ');
  const clause = clean.split(/[。!?!?,,\n]/)[0] || clean;
  return clause.length > max ? clause.slice(0, max) + '…' : clause;
}

/** 取角色個性的第一小段。 */
export function traitOf(character, max = 14) {
  const p = (character.personality || '').trim();
  if (!p) return '';
  const clause = p.split(/[。!?!?,,、\n]/)[0] || p;
  return clause.length > max ? clause.slice(0, max) + '…' : clause;
}

/** 取角色情境的第一小段。 */
export function sceneOf(character, max = 20) {
  const s = (character.scenario || '').trim();
  if (!s) return '';
  const clause = s.split(/[。!?!?\n]/)[0] || s;
  return clause.length > max ? clause.slice(0, max) + '…' : clause;
}

/** 從 prompt 的可見記憶中取一條當作「角色記得的事」。 */
function memoryHintOf(prompt, seed) {
  const pool = [
    ...prompt.meta.privateMemories,
    ...prompt.meta.roomMemories,
    ...prompt.meta.sharedMemories,
  ].filter((m) => m.content);
  if (!pool.length) return '';
  const m = pick(pool, seed);
  return m.content.length > 24 ? m.content.slice(0, 24) + '…' : m.content;
}

function appendMessage(roomId, { role, senderId, content, image = null, sharedPost = null, choices = null, voice = false, missedCall = false }) {
  const msgs = getRoomMessages(roomId);
  const msg = {
    id: genId('msg'),
    role,
    senderId,
    content,
    ...(image ? { image } : {}),
    ...(sharedPost ? { sharedPost } : {}),   // {postId, authorName, excerpt, image}:引用的貼文卡
    ...(choices && choices.length ? { choices } : {}), // 正文行動選項(僅最後一則顯示)
    ...(voice ? { voice: true } : {}),                 // 語音訊息(以聲波樣式呈現，點播用 TTS 唸)
    ...(missedCall ? { missedCall: true } : {}),       // 未接來電留言(提案 D):程式端設定，不靠模型標記
    createdAt: Date.now(),
  };
  msgs.push(msg);
  return msg;
}

/* ---------------- Mock 回覆:DM ---------------- */

/**
 * 依角色設定與使用者最後一句，產生 1~2 則短私訊。
 * 選擇邏輯可重現(以訊息內容、訊息數與角色 id 做 seed),但不完全死板。
 */
export function generateMockDmReply({ character, userText, prompt, msgCount }) {
  const seed = hashStr(userText) + msgCount * 17 + hashStr(character.id);
  const echo = echoOf(userText);
  const trait = traitOf(character);
  const scene = sceneOf(character);
  const memHint = memoryHintOf(prompt, seed);
  const player = getState().player.playerName || '你';

  const mains = [
    `「${echo}」……我剛剛把這句話讀了兩遍。跟我多說一點？`,
    `${player},你說${echo}的時候，是認真的，還是想看我的反應？`,
    `${echo}。嗯，收到了。我這邊${scene ? scene : '沒什麼特別的事'},所以你講的每件事我都有在聽。`,
    `等等——${echo}?這件事你之前完全沒提過。`,
    `我在想怎麼回你比較好。${echo}這種話，不太適合隨便回。`,
    `${echo}啊……${trait ? `像我這種${trait}的人,` : ''}大概只會先說：先別急，慢慢講。`,
  ];

  const flavors = [
    trait ? `說真的,${trait}也是會累的。` : `說真的，今天有點安靜。`,
    memHint ? `對了，我還記得「${memHint}」這件事。沒忘。` : `對了，別讓我一個人猜太久。`,
    scene ? `這邊${scene},等你有空再跟你細講。` : `等你回我，我再繼續說。`,
    character.avatarEmoji ? `${character.avatarEmoji}` : `……就這樣。`,
  ];

  const replies = [pick(mains, seed)];
  // 訊息數為偶數、或使用者訊息偏長時，補一則短句，製造私訊節奏。
  if (msgCount % 2 === 0 || userText.length > 24) {
    replies.push(pick(flavors, seed >> 3));
  }
  return replies;
}

/* ---------------- Mock 回覆：群聊 ---------------- */

/**
 * 產生一個「自然訊息包」:
 * - 一位主要回覆者
 * - 0~2 位補充/吐槽/貼圖文字/延後訊息
 * - 每回合最多三則，不強迫人人回覆，角色間偶爾互相接話。
 */
export function generateMockGroupReplies({ room, userText, msgCount }) {
  const chars = getRoomCharacters(room);
  if (!chars.length) return [];
  const seed = hashStr(userText) + msgCount * 13;
  const echo = echoOf(userText);

  const main = chars[seed % chars.length];
  const mainPrompt = buildPrompt({ character: main, roomId: room.id });
  const memHint = memoryHintOf(mainPrompt, seed);
  const mainTrait = traitOf(main);

  const mainLines = [
    `${echo}?我先回好了，免得又冷場。`,
    `這題我接。${echo}的話，我的答案很簡單：看情況。`,
    `${memHint ? `等等，這跟之前「${memHint}」那件事有關吧？` : `${echo}……讓我想三秒。好，想完了，我有意見。`}`,
    `${mainTrait ? `以一個${mainTrait}的人的立場,` : ''}我覺得${echo}這件事值得認真聊。`,
    `你直接在群裡丟「${echo}」，是想看我們吵起來嗎？`,
  ];

  const replies = [{
    characterId: main.id,
    content: pick(mainLines, seed),
    delay: 700 + (seed % 400),
  }];

  // 0~2 位補充者；短訊息、有時只有 emoji、有時接主要回覆者的話。
  const others = chars.filter((c) => c.id !== main.id);
  const extraCount = Math.min(others.length, [0, 1, 1, 2][(seed >> 2) % 4]);

  for (let i = 0; i < extraCount; i += 1) {
    const c = others[(seed + i * 7) % others.length];
    if (replies.some((r) => r.characterId === c.id)) continue;
    const extraLines = [
      `${main.name}講得比我想說的還快。`,
      `${c.avatarEmoji || '…'}`,
      `我先記下來，等下私下回你。開玩笑的，這裡大家都看得到。`,
      `+1。不過「${echo}」這部分，我保留意見。`,
      `笑死,${main.name}你回得也太認真。`,
      `路過，表示看到了。`,
    ];
    replies.push({
      characterId: c.id,
      content: pick(extraLines, seed + i * 31),
      delay: 1500 + i * 900 + (seed % 300),
    });
  }
  return replies.slice(0, 3);
}

/* ---------------- Mock 回覆:Story ---------------- */

/**
 * 產生一段敘事 + 一段角色對話(兩則訊息)。
 */
export function generateMockStoryReply({ room, userText, msgCount }) {
  const chars = getRoomCharacters(room);
  const seed = hashStr(userText) + msgCount * 11;
  const echo = echoOf(userText, 20);
  const player = getState().player.playerName || '你';

  const speaker = chars[seed % Math.max(chars.length, 1)] || null;
  const scene = speaker ? sceneOf(speaker, 24) : '';
  const prompt = speaker ? buildPrompt({ character: speaker, roomId: room.id }) : null;
  const memHint = prompt ? memoryHintOf(prompt, seed) : '';

  const narrations = [
    `${player}的話落在空氣裡，像一顆石子沉進水面。${scene ? `${scene}的氣息還沒散去,` : ''}沒有人急著打破這片刻的靜。`,
    `一陣短暫的停頓。${speaker ? `${speaker.name}的手指停了一下,` : ''}光線在牆上緩慢移動，把「${echo}」這句話拉得很長。`,
    `場景微微傾斜了一度——不是真的傾斜，只是氣氛變了。${player}能感覺到，有什麼被這句話推動了。`,
  ];

  const dialogues = speaker ? [
    `「${echo}……」${speaker.name}緩緩開口，聲音壓得很低，「你確定要在這個時候說這種話？」`,
    `${speaker.name}看向${player},沉默了幾秒，才說：「好。那我們就照你說的走。但別回頭。」`,
    `「${memHint ? `我一直記得${memHint}。` : '我不會假裝沒聽見。'}」${speaker.name}向前一步，「所以,${echo}——說清楚一點。」`,
  ] : [
    `(這個場景目前沒有角色。到左側新增角色，或建立新的場景。)`,
  ];

  return {
    narration: pick(narrations, seed),
    dialogue: pick(dialogues, seed >> 2),
    speakerId: speaker ? speaker.id : 'system',
  };
}

/* ---------------- 傳送流程 ---------------- */

let busyRoomIds = new Set();

export function isRoomBusy(roomId) {
  return busyRoomIds.has(roomId);
}

/**
 * 使用者送出訊息 → 產生對應 room 類型的假回覆。
 * @param {string} roomId
 * @param {string} text
 * @param {(info:{typingBy?:string})=>void} notify 每次畫面需要更新時呼叫
 */
export async function sendUserMessage(roomId, text, notify, image = null, sharedPost = null) {
  const room = getRoom(roomId);
  if (!room || (!text.trim() && !image && !sharedPost) || busyRoomIds.has(roomId)) return;
  if (room.type === 'peek') return; // 旁觀群：你不在裡面，說不了話(UI 已藏輸入框，這裡是底層防呆)

  busyRoomIds.add(roomId);
  try {
    appendMessage(roomId, {
      role: 'user', senderId: 'player', content: text.trim(),
      ...(image ? { image } : {}),
      ...(sharedPost ? { sharedPost } : {}),
    });
    await persist();
    notify({});
    await runGeneration(roomId, text.trim() || '(圖片)', notify, 0);
  } finally {
    busyRoomIds.delete(roomId);
    notify({});
  }
}

/** 每個 room 的重新生成次數(僅存在本次瀏覽階段，用來變化 mock 的隨機種子)。 */
const regenCount = new Map();

/**
 * 重新生成：刪掉最後一個玩家訊息之後的所有 AI 回覆，用同樣的上下文重打一次。
 * 不保留舊版本(接受制：滿意就留，不滿意就 roll 掉)。
 */
export async function regenerateLastReply(roomId, notify) {
  const state = getState();
  const room = getRoom(roomId);
  if (!room || busyRoomIds.has(roomId)) return;
  const msgs = state.messagesByRoom[roomId] || [];
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return; // 沒有玩家訊息(例如只有 firstMessage)就不重roll

  busyRoomIds.add(roomId);
  try {
    msgs.splice(lastUserIdx + 1); // 移除該訊息之後的所有回覆
    await persist();
    notify({});
    const n = (regenCount.get(roomId) || 0) + 1;
    regenCount.set(roomId, n);
    await runGeneration(roomId, msgs[lastUserIdx].content, notify, n * 17);
  } finally {
    busyRoomIds.delete(roomId);
    notify({});
  }
}

/** 依 room 類型產生回覆(真實 API 或 mock)。seedOffset 讓 mock 重roll 有變化。 */
async function runGeneration(roomId, text, notify, seedOffset = 0) {
  const state = getState();
  const room = getRoom(roomId);
  {
    const msgCount = getRoomMessages(roomId).length + seedOffset;

    if (room.type === 'dm') {
      const character = getRoomCharacters(room)[0];
      if (!character) return;
      const prompt = buildPrompt({ character, roomId });
      const cfg = getApiConfig();

      if (cfg.useRealApi && cfg.apiKey && cfg.model) {
        // 真實 AI 回覆(目前僅 DM)。你的訊息已寫入並保存,API 失敗也不會遺失。
        notify({ typingBy: character.name });
        const r = await generateReply(cfg, prompt);
        if (r.ok) {
          const md = extractMoodTag(stripNamePrefix(r.text, [character.name]));
          if (md.mood) { room.mood = { emoji: md.mood, at: Date.now() }; }
          const st = extractStatusTag(md.content);
          applyStatusTag(character, st.status);
          const vt = extractVoiceTag(st.content);
          if (vt.voice || getState().settings.chatFeel === false) {
            // 語音訊息維持單則
            appendMessage(roomId, {
              role: 'character',
              senderId: character.id,
              content: splitChatParts(vt.content, [character.name]).join('\n') || vt.content,
              ...(vt.voice ? { voice: true } : {}),
            });
          } else {
            const parts = splitChatParts(vt.content, [character.name]);
            for (const [pi, part] of parts.entries()) {
              if (pi > 0) {
                notify({ typingBy: character.name });
                // eslint-disable-next-line no-await-in-loop
                await sleep(500 + Math.min(part.length * 12, 900));
              }
              appendMessage(roomId, { role: 'character', senderId: character.id, content: part });
              // eslint-disable-next-line no-await-in-loop
              await persist();
              notify({});
            }
          }
        } else {
          appendMessage(roomId, {
            role: 'system',
            senderId: 'system',
            content: `AI 回覆失敗:${r.message}。你的訊息已保留；可稍後重試，或到設定關閉「使用真實 AI」改用本機假回覆。`,
          });
        }
        await persist();
        notify({});
        return;
      }

      const replies = generateMockDmReply({ character, userText: text, prompt, msgCount });
      for (const content of replies) {
        notify({ typingBy: character.name });
        await sleep(650 + Math.min(content.length * 35, 1400));
        appendMessage(roomId, { role: 'character', senderId: character.id, content });
        await persist();
        notify({});
      }
    } else if (room.type === 'group') {
      const cfgG = getApiConfig();
      const participants = getRoomCharacters(room);
      // @點名：訊息含「@角色名」時，該角色必回
      const mentioned = participants.find((c) => text.includes(`@${c.name}`)) || null;
      if (cfgG.useRealApi && cfgG.apiKey && cfgG.model) {
        // 一次 API 呼叫產生整包多角色訊息(而非每角色各打一次，省成本)
        notify({ typingBy: (mentioned || participants[0])?.name || '' });
        const r = await generateReply(cfgG, buildGroupPrompt({ roomId, mentionName: mentioned?.name || null }));
        if (r.ok) {
          const pack = parseGroupReplies(r.text, participants);
          if (!pack.length) {
            appendMessage(roomId, { role: 'system', senderId: 'system', content: 'AI 回覆了無法解析的內容，請再試一次。你的訊息已保留。' });
            await persist(); notify({});
            return;
          }
          for (const p of pack) {
            const c = state.characters.find((ch) => ch.id === p.characterId);
            notify({ typingBy: c ? c.name : '' });
            await sleep(500 + Math.min(p.content.length * 25, 1200));
            appendMessage(roomId, { role: 'character', senderId: p.characterId, content: p.content });
            await persist();
            notify({});
          }
        } else {
          appendMessage(roomId, { role: 'system', senderId: 'system', content: `AI 回覆失敗:${r.message}。你的訊息已保留。` });
          await persist(); notify({});
        }
        return;
      }
      let pack = generateMockGroupReplies({ room, userText: text, msgCount });
      if (mentioned) {
        const idx = pack.findIndex((m) => m.characterId === mentioned.id);
        if (idx > 0) { const [hit] = pack.splice(idx, 1); pack.unshift(hit); }
        else if (idx === -1) {
          pack = [{ characterId: mentioned.id, content: `@到我?${echoOf(text)}我在。`, delay: 700 }, ...pack].slice(0, 3);
        }
      }
      for (const r of pack) {
        const c = state.characters.find((ch) => ch.id === r.characterId);
        notify({ typingBy: c ? c.name : '' });
        await sleep(r.delay);
        appendMessage(roomId, { role: 'character', senderId: r.characterId, content: r.content });
        await persist();
        notify({});
      }
    } else if (room.type === 'story') {
      const cfgS = getApiConfig();
      const chars = getRoomCharacters(room);
      if (cfgS.useRealApi && cfgS.apiKey && cfgS.model && chars[0]) {
        notify({ typingBy: '場景' });
        const r = await generateReply(cfgS, buildStoryPrompt({ roomId }));
        if (r.ok) {
          const parsed = extractStoryChoices(stripNamePrefix(r.text, chars.map((c) => c.name)));
          appendMessage(roomId, {
            role: 'narrator',
            senderId: chars[0].id,
            content: parsed.content,
            ...(parsed.choices.length ? { choices: parsed.choices } : {}),
          });
        } else {
          appendMessage(roomId, { role: 'system', senderId: 'system', content: `AI 回覆失敗:${r.message}。你的訊息已保留。` });
        }
        await persist(); notify({});
        return;
      }
      const { narration, dialogue, speakerId } = generateMockStoryReply({ room, userText: text, msgCount });
      const mockChoices = getState().settings?.storyChoices
        ? ['繼續觀察', `回應${getRoomCharacters(room)[0]?.name || '對方'}`, '轉身離開'] : [];
      notify({ typingBy: '場景' });
      await sleep(900);
      appendMessage(roomId, { role: 'narrator', senderId: 'system', content: narration });
      await persist();
      notify({});
      notify({ typingBy: '' });
      await sleep(900);
      appendMessage(roomId, {
        role: speakerId === 'system' ? 'system' : 'character',
        senderId: speakerId,
        content: dialogue,
        ...(mockChoices.length ? { choices: mockChoices } : {}),
      });
      await persist();
      notify({});
    }
  }
}

/* ------------------------------------------------------------
 * 訊息編輯與刪除
 * ------------------------------------------------------------ */

export async function editMessage(roomId, messageId, content) {
  const msgs = getRoomMessages(roomId);
  const msg = msgs.find((m) => m.id === messageId);
  if (!msg || !String(content).trim()) return null;
  msg.content = String(content).trim();
  msg.editedAt = Date.now();
  await persist();
  return msg;
}

export async function deleteMessage(roomId, messageId) {
  const state = getState();
  const msgs = state.messagesByRoom[roomId] || [];
  const idx = msgs.findIndex((m) => m.id === messageId);
  if (idx !== -1) msgs.splice(idx, 1);
  await persist();
}

/* ------------------------------------------------------------
 * 群聊自燃：角色們自己聊起來(↻ 觸發，與其他刷新共用節流哲學)
 * ------------------------------------------------------------ */

export function selfChatCooldownLeft() {
  const state = getState();
  const cooldownMs = (state.settings.autoPostCooldownMin ?? 10) * 60000;
  return Math.max(0, Math.ceil(((state.selfChatLastRefresh || 0) + cooldownMs - Date.now()) / 1000));
}

/**
 * 讓群聊裡的角色們自己聊 2~5 則(不需要玩家先說話)。
 * 素材=他們共同知道的事(群內對話/公開動態/圈子共享記憶/彼此關係);
 * 任何人的 DM 私密內容都不會進來。
 */
export async function selfChat(roomId, notify, opts = {}) {
  const state = getState();
  const room = getRoom(roomId);
  if (!room || (room.type !== 'group' && room.type !== 'peek') || busyRoomIds.has(roomId)) {
    return { ok: false, message: '這裡不能自聊' };
  }
  const isEmptyRoom = (getRoomMessages(roomId) || []).length === 0;
  if (!opts.force && !isEmptyRoom) {
    // 空房第一把免冷卻；冷卻只在「成功」後才開始計(失敗不燒額度)
    const left = selfChatCooldownLeft();
    if (left > 0) return { ok: false, message: `再等 ${Math.ceil(left / 60)} 分鐘可以再刷新` };
  }

  busyRoomIds.add(roomId);
  try {
    const participants = getRoomCharacters(room);
    const cfg = getApiConfig();
    if (cfg.useRealApi && cfg.apiKey && cfg.model) {
      let prompt;
      if (room.type === 'peek') {
        prompt = buildPeekPrompt({ roomId }); // 已含合成 user 回合
      } else {
        prompt = buildGroupPrompt({ roomId, selfTalk: true });
        prompt.messages = [
          ...prompt.messages,
          { role: 'user', content: '(群組安靜了一陣子，你們之中有人先開口。)' },
        ];
      }
      notify({ typingBy: participants[0]?.name || '' });
      const r = await generateReply(cfg, prompt);
      if (!r.ok) {
        appendMessage(roomId, { role: 'system', senderId: 'system', content: `刷新失敗:${r.message}(冷卻未消耗，可直接再按一次)` });
        await persist(); notify({ typingBy: '' }); notify({});
        return { ok: false, message: r.message };
      }
      const replies = parseGroupReplies(r.text, participants, 5);
      if (!replies.length) {
        appendMessage(roomId, { role: 'system', senderId: 'system', content: '這次大家都沒開口(模型輸出無法解析);冷卻未消耗，再按一次試試。' });
        await persist(); notify({ typingBy: '' }); notify({});
        return { ok: false, message: '這次大家都沒開口，再試一次' };
      }
      state.selfChatLastRefresh = Date.now();
      for (const [i, rep] of replies.entries()) {
        notify({ typingBy: getCharacter(rep.characterId)?.name || '' });
        // eslint-disable-next-line no-await-in-loop
        await sleep(700 + i * 500);
        appendMessage(roomId, { role: 'character', senderId: rep.characterId, content: rep.content });
        // eslint-disable-next-line no-await-in-loop
        await persist();
        notify({});
      }
      notify({ typingBy: '' });
      return { ok: true, count: replies.length };
    }
    // mock:兩三句互虧
    state.selfChatLastRefresh = Date.now();
    const seed = hashStr(roomId) + Math.floor(Date.now() / 60000);
    const [c1, c2] = [participants[seed % participants.length], participants[(seed + 1) % participants.length]];
    const lastUser = getRoomMessages(roomId).filter((m) => m.role === 'user').slice(-1)[0];
    const topic = lastUser ? echoOf(lastUser.content) : '最近那件事';
    const lines = [
      { c: c1, t: `欸，說到${topic},你們怎麼看？` },
      { c: c2, t: `${traitOf(c2) ? `我這種${traitOf(c2)}的人` : '我'}只想說：先吃飯再說。` },
      { c: c1, t: '……你每次都這樣。' },
    ];
    for (const [i, l] of lines.entries()) {
      if (!l.c) continue;
      notify({ typingBy: l.c.name });
      // eslint-disable-next-line no-await-in-loop
      await sleep(600 + i * 400);
      appendMessage(roomId, { role: 'character', senderId: l.c.id, content: l.t });
      // eslint-disable-next-line no-await-in-loop
      await persist();
      notify({});
    }
    notify({ typingBy: '' });
    return { ok: true, count: lines.length };
  } finally {
    busyRoomIds.delete(roomId);
  }
}

/* ------------------------------------------------------------
 * 提案 G:內心話。按需生成「他說這句話當下心裡真正在想什麼」,
 * 存進訊息的 innerVoice 欄(再按=展開，不重打)。素材=本人 DM prompt 範圍。
 * ------------------------------------------------------------ */
const innerVoiceBusy = new Set();

/** 提案 M:狀態落地(節流:3 小時內已更新過就丟棄，防模型鸚鵡成每回必發)。 */
function applyStatusTag(character, statusText) {
  if (!statusText || !character || character.noPhone) return;
  const THROTTLE = 3 * 60 * 60 * 1000;
  if (character.status?.at && Date.now() - character.status.at < THROTTLE) return;
  character.status = { text: statusText, at: Date.now() };
}

export async function generateInnerVoice(roomId, messageId, characterId = null) {
  const room = getRoom(roomId);
  if (!room) return { ok: false, message: '找不到房間' };
  if (room.type === 'peek') return { ok: false, message: '旁觀房不支援心聲' };
  const msg = (getRoomMessages(roomId) || []).find((m) => m.id === messageId);
  if (!msg) return { ok: false, message: '找不到訊息' };

  // 目標角色：角色訊息=發話者本人；正文旁白=呼叫端指定
  let character = null;
  if (msg.role === 'character') {
    character = room.type === 'dm' ? getRoomCharacters(room)[0] : getCharacter(msg.senderId);
  } else if (msg.role === 'narrator' && room.type === 'story' && characterId) {
    character = getCharacter(characterId);
  }
  if (!character) return { ok: false, message: msg.role === 'narrator' ? '請選擇要窺探的角色' : '只有角色的訊息有心聲' };

  // 快取：角色訊息單欄；旁白多人欄
  if (msg.role === 'character' && msg.innerVoice) return { ok: true, cached: true, text: msg.innerVoice };
  if (msg.role === 'narrator' && msg.innerVoices?.[character.id]) {
    return { ok: true, cached: true, text: msg.innerVoices[character.id] };
  }
  const busyKey = `${messageId}:${character.id}`;
  if (innerVoiceBusy.has(busyKey)) return { ok: false, message: '生成中…' };
  innerVoiceBusy.add(busyKey);
  try {
    const cfg = getApiConfig();
    let text;
    if (cfg.useRealApi && cfg.apiKey && cfg.model) {
      const prompt = room.type === 'dm'
        ? buildPrompt({ character, roomId, innerVoiceOf: messageId })
        : buildRoomInnerVoicePrompt({ character, roomId, messageId });
      if (!prompt) return { ok: false, message: '這個房型不支援心聲' };
      const r = await generateReply(cfg, prompt, { tier: 'secondary' });
      if (!r.ok) return { ok: false, message: r.message };
      text = stripNamePrefix(r.text, [character.name]).trim();
      if (!text) return { ok: false, message: '模型回傳了空內容，再按一次試試' };
    } else {
      text = '(嘴上說得輕鬆，其實剛剛心跳快得不像話。希望沒被發現。)';
    }
    if (msg.role === 'character') {
      msg.innerVoice = text;
    } else {
      msg.innerVoices = msg.innerVoices || {};
      msg.innerVoices[character.id] = text;
    }
    await persist();
    return { ok: true, text };
  } finally {
    innerVoiceBusy.delete(busyKey);
  }
}

/** 聊天感模式：把「---」分隔的回覆拆成多則(上限 3),像連發訊息。 */
export function splitChatParts(text, names = []) {
  let t = String(text || '');
  // v64:模型會把第二則黏在同一行——「內容。---名字: (時間戳)內容」——行內的 --- 不換行,
  // 原本的拆條切不到,名字/時間戳剝除器也只認行首,三道防線同時被繞過。
  // 對策:行內「---名字:」與「---(時間戳)」先轉成標準分隔,再走原本的拆條。
  for (const n of (Array.isArray(names) ? names : [names])) {
    if (!n) continue;
    const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp('\\s*-{3,}\\s*' + esc + '\\s*[::]\\s*', 'g'), '\n---\n');
  }
  t = t.replace(/\s*-{3,}\s*(?=[((][^\n]{0,18}?[\d0-9]{1,2}\s*[::][\d0-9]{2})/g, '\n---\n');
  return t
    .split(/\n\s*-{3,}\s*\n?|^\s*-{3,}\s*$/m)
    .map((tt) => stripTsPrefix(tt).trim()) // v62:拆條後每則再剝一次時間戳
    .filter(Boolean)
    .slice(0, 3);
}

/** 從正文輸出抽出「▷ 選項」行：回傳 {content, choices}。 */
export function extractStoryChoices(text) {
  const lines = String(text || '').split('\n');
  const choices = [];
  const body = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^[▷▶>]\s*/.test(t)) {
      const c = t.replace(/^[▷▶>]\s*/, '').trim();
      if (c) choices.push(c);
    } else body.push(line);
  }
  return { content: body.join('\n').trim(), choices: choices.slice(0, 4) };
}

/* ------------------------------------------------------------
 * 角色主動傳訊(刷新觸發，與自主發文同一套節流哲學)
 * ------------------------------------------------------------ */

export function chatRefreshCooldownLeft() {
  const state = getState();
  const cooldownMs = (state.settings.autoPostCooldownMin ?? 10) * 60000;
  return Math.max(0, Math.ceil((state.chatLastRefresh + cooldownMs - Date.now()) / 1000));
}

/**
 * 主動意願評分(純本機計算，零 API 消耗)。
 * 回傳 {score, reason}:分數決定誰更可能來敲你,reason 會告訴模型「他為什麼想傳」。
 */
export function proactivityScoreFor(roomId) {
  const state = getState();
  const room = getRoom(roomId);
  if (!room || room.type !== 'dm') return { score: 0, reason: '' };
  const character = getRoomCharacters(room)[0];
  if (!character) return { score: 0, reason: '' };

  if (character.noPhone) return { score: 0, reason: '' };
  const level = character.proactivity || 'mid';
  if (level === 'off') return { score: 0, reason: '' };
  let score = { low: 0.5, mid: 1.0, high: 1.8 }[level] || 1.0;
  const reasons = [];

  const msgs = getRoomMessages(roomId);
  const last = msgs[msgs.length - 1];
  const now = Date.now();

  // 懸念：角色最後說的是問句，而玩家一直沒回
  if (last && last.role === 'character' && /[??]\s*$/.test(last.content)) {
    score += 1.2;
    reasons.push('你上次問了對方一個問題，但對方一直沒有回覆');
  }
  // 熱絡:24 小時內訊息越多，越可能順勢再敲
  const hot = msgs.filter((m) => now - m.createdAt < 86400000).length;
  if (hot >= 3) {
    score += Math.min(hot, 8) * 0.15;
    reasons.push('你們最近聊得很熱絡，話題還有延續空間');
  }
  // 冷落：太久沒動靜，想起對方
  const lastAt = last?.createdAt || room.createdAt;
  const days = (now - lastAt) / 86400000;
  if (days >= 2) {
    score += Math.min(days, 7) * 0.25;
    reasons.push(`你們已經 ${Math.floor(days)} 天沒說話了，你有點想他`);
  }
  // 紀念日：今天是你們的特別日子 → 強力加分
  const anni = anniversaryTextFor(character.id);
  if (anni) {
    score += 2.0;
    reasons.unshift(anni);
  }
  // 記憶紀念日(提案 C):滿月/週年/年年今日 → 更可能主動來找你(+1.5)
  const memAnni = anniversaryMemoryHits(character.id, room?.id || null);
  if (memAnni.length) {
    score += 1.5;
    const h = memAnni[0];
    const label = h.type === 'annual' ? '每年的今天' : h.type === 'yearly' ? `滿 ${h.n} 年` : `滿 ${h.n} 個月`;
    reasons.unshift(`今天距離「${String(h.memory.content).slice(0, 30)}」${label},你想起了這件事`);
  }
  // 記憶鉤子：釘選的私密記憶(通常是「之後要一起…」這類重要事項)
  const pinned = (getState().memories.byCharacterId[character.id] || []).filter((m) => m.pinned);
  if (pinned.length) {
    score += Math.min(pinned.length, 3) * 0.3;
    reasons.push(`你記得這些事:${pinned.slice(0, 2).map((m) => m.content.slice(0, 30)).join(';')}`);
  }

  return { score, reason: reasons[0] || '沒有特別的理由，就是想到對方了' };
}

/**
 * 刷新聊天：可能有 0~1 位角色主動傳訊給你(60% 有、40% 沒有)。
 * 依「主動意願」加權抽選(懸念/熱絡/冷落/記憶鉤子/角色主動程度),
 * 並把想傳訊的原因告訴模型，讓內容呼應脈絡而非通用問候。
 * @returns {{ok:boolean, from?:string, message?:string}}
 */
export async function refreshChats(opts = {}) {
  const state = getState();
  const rng = opts.rng || Math.random;
  if (!opts.force) {
    const left = chatRefreshCooldownLeft();
    if (left > 0) return { ok: false, message: `再等 ${Math.ceil(left / 60)} 分鐘可以再刷新` };
  }
  state.chatLastRefresh = Date.now();
  await persist();

  const dms = state.rooms.filter((r) => r.type === 'dm');
  if (!dms.length) return { ok: true };
  if (rng() >= 0.6) return { ok: true }; // 40%:大家都在忙

  // 意願加權抽選：分數越高越可能被抽中，但保留隨機性
  const scored = dms
    .map((r) => ({ room: r, ...proactivityScoreFor(r.id) }))
    .filter((x) => x.score > 0 && !busyRoomIds.has(x.room.id));
  if (!scored.length) return { ok: true }; // 大家都設成不主動
  const total = scored.reduce((sum, x) => sum + x.score, 0);
  let roll = rng() * total;
  let picked = scored[scored.length - 1];
  for (const x of scored) {
    roll -= x.score;
    if (roll <= 0) { picked = x; break; }
  }
  const room = picked.room;
  const reason = picked.reason;
  const character = getRoomCharacters(room)[0];
  if (!character) return { ok: true };

  // 提案 D:未接來電(方案 b,擁有者核准)——high 才常來電、mid 低機率、low/off 永不;
  // 紀念日當天(提案 C 聯動)機率加成：有件事重要到想直接講。
  const CALL_CHANCE = { high: 0.3, mid: 0.1 };
  let callChance = CALL_CHANCE[character.proactivity || 'mid'] || 0;
  if (callChance > 0 && anniversaryMemoryHits(character.id, room.id).length) {
    callChance = Math.min(0.9, callChance + 0.25);
  }
  const isCall = callChance > 0 && rng() < callChance;

  const cfg = getApiConfig();
  let content = '';
  if (cfg.useRealApi && cfg.apiKey && cfg.model) {
    const prompt = buildPrompt({ character, roomId: room.id });
    prompt.messages = [
      ...prompt.messages,
      {
        role: 'user',
        content: isCall
          ? `(系統：你剛才打電話給玩家，但對方沒有接，現在要留一段語音留言。原因:${reason}。來電代表有件事重要到想直接講——交代一件具體的事，或一種憋不住想說的心情；開頭自然，像撥不通之後會說的話。一段完成的話(約 100~250 字),只輸出留言內容本身，不要名字前綴、不要任何標記格式。)`
          : `(系統：你想主動傳一則訊息給玩家。原因:${reason}。讓訊息自然呼應這個原因——可以延續話題、追問、分享近況。只輸出訊息內容本身,1~2 句，不要名字前綴。)`,
      },
    ];
    const r = await generateReply(cfg, prompt);
    if (!r.ok) return { ok: false, message: r.message };
    content = stripNamePrefix(r.text, [character.name]);
  } else {
    const seed = hashStr(character.id) + Math.floor(Date.now() / 60000);
    if (isCall) {
      content = pick([
        '喂?……沒接喔。也沒什麼大事，就是剛剛突然很想聽你的聲音。看到回我一下。',
        '是我。有件事想直接跟你說，結果你沒接……算了，等你回電，別太晚。',
        '你在忙吧。我留個言：今天發生了一件事，我第一個想到的就是你。回來打給我。',
      ], seed);
    } else content = pick([
      '欸，突然想到你。最近还好嗎？',
      '在忙嗎？沒事，就想丟個訊息。',
      `${traitOf(character) ? `${traitOf(character)}的人` : '我'}也是會先開口的。哈囉。`,
      '路過。想說看你上線沒。',
    ], seed).replace('还','還');
  }
  if (!content) return { ok: true };

  const mdP = extractMoodTag(content);
  if (mdP.mood) { room.mood = { emoji: mdP.mood, at: Date.now() }; }
  const stP = extractStatusTag(mdP.content);
  applyStatusTag(character, stP.status);
  const vtP = extractVoiceTag(stP.content);
  appendMessage(room.id, {
    role: 'character', senderId: character.id, content: vtP.content,
    ...(isCall
      ? { missedCall: true, ...(ttsAvailable() ? { voice: true } : {}) }
      : (vtP.voice ? { voice: true } : {})),
  });
  room.unread = true;
  await persist();
  return { ok: true, from: character.name };
}
