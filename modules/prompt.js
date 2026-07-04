/**
 * modules/prompt.js
 * buildPrompt:組合未來真實 AI API 所需的完整上下文。
 * 第一版沒有任何 API 呼叫;mock 回覆邏輯會取用這裡的結果,
 * 以確保未來換成真實 API 時,資料流不需要重寫。
 */

import { getState, getRoom, getRoomMessages, getRoomCharacters } from './state.js';
import { matchEntries } from './worldbook.js';
import { personaForRoom, getPersona } from './persona.js';

const RECENT_MESSAGE_LIMIT = 12;
const CROSS_ROOM_LIMIT = 4;

/**
 * 為「某個角色在某個 room 中回覆」組合上下文。
 *
 * 記憶可見性規則(嚴格遵守):
 * - shared:所有角色可見(來自群聊公開事件)。
 * - byCharacterId[characterId]:只有該角色本人可見(DM 私密記憶)。
 * - byRoomId[roomId]:只有目前 room 的參與角色可見(Story 場景私密事件)。
 * - 其他角色的 DM 內容永遠不會出現在這裡。
 *
 * @param {object} opts
 * @param {object} opts.character 要回覆的角色
 * @param {string} opts.roomId 目前 room
 * @returns {{system:string, messages:Array, meta:object}}
 */
export function buildPrompt({ character, roomId }) {
  const state = getState();
  const room = getRoom(roomId);
  const participants = getRoomCharacters(room);
  const player = state.player;

  /* --- 記憶(依可見性過濾) --- */
  const sharedMemories = sortMemories(state.memories.shared);
  const privateMemories = sortMemories(state.memories.byCharacterId[character.id] || []);
  const roomMemories = room.participantIds.includes(character.id) || room.type === 'dm'
    ? sortMemories(state.memories.byRoomId[roomId] || [])
    : [];

  /* --- 目前 room 最近訊息 --- */
  const recentMessages = getRoomMessages(roomId)
    .slice(-RECENT_MESSAGE_LIMIT)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      speaker: speakerName(m, state, room),
      content: m.sharedPost
        ? `[分享了一篇社群貼文|${m.sharedPost.authorName}:${m.sharedPost.excerpt}]${m.content ? ` ${m.content}` : ''}`
        : m.content,
      ...(m.image ? { image: m.image } : {}),
      ...(m.sharedPost?.image ? { image: m.sharedPost.image } : {}),
    }));

  /* --- 跨介面內容:只取「這個角色也在場」的其他 room 的少量近期訊息 --- */
  const crossContext = collectCrossRoomContext(character, roomId);

  const persona = personaForRoom(room);

  /* --- 世界書:掃最近訊息文字,只帶入被觸發(或常駐)的條目 --- */
  const recentText = recentMessages.map((m) => m.content).join('\n');
  const loreEntries = matchEntries({ characterId: character.id, recentText });
  const loreText = loreEntries.length
    ? loreEntries.map((e) => `- (${e.bookName}/${e.title}) ${e.content}`).join('\n')
    : '(無被觸發的條目)';

  /* --- 每模式回覆字數上限(供未來真實 API 與風格指令使用) --- */
  const maxReplyChars = state.apiConfig?.maxReplyChars?.[room.type]
    ?? { dm: 800, group: 1200, story: 4000 }[room.type];

  /* --- 回覆風格指令 --- */
  const styleGuide = {
    dm: '風格:私訊。短訊息、自然、口語,像手機上打字。一到兩句即可。以角色第一人稱直接輸出內容,絕對不要在開頭加上自己的名字或「名字:」前綴。',
    group: '風格:群組聊天。自然節奏,不必每人每回合都發言;可補充、吐槽、接話或延後回覆。',
    story: '風格:互動敘事,以小說筆法輸出:場景描述、動作、心理與對話交織。對話用引號呈現,不要用「名字:台詞」的劇本格式,也不要在開頭加名字前綴。',
  }[room.type]
  + (room.type === 'story' && state.settings?.storyFormat?.trim()
    ? ` ${state.settings.storyFormat.trim()}`
    : '');

  const system = [
    `【角色設定】${character.systemPrompt || '(未提供 systemPrompt)'}`,
    `【角色名稱】${character.name}`,
    `【角色描述】${character.description || '(未提供)'}`,
    `【個性】${character.personality || '(未提供)'}`,
    `【情境】${character.scenario || '(未提供)'}`,
    `【玩家】${persona?.name || '(未命名玩家)'}:${persona?.description || '(未提供描述)'}`,
    `【目前聊天室】類型 ${room.type},名稱「${room.title}」,參與角色:${participants.map((c) => c.name).join('、') || '(無)'}`,
    `【共享記憶】\n${formatMemories(sharedMemories)}`,
    `【${character.name} 的私密記憶(其他角色不可見)】\n${formatMemories(privateMemories)}`,
    `【本場景記憶(僅本 room 參與者可見)】\n${formatMemories(roomMemories)}`,
    `【世界書(依關鍵字觸發)】\n${loreText}`,
    `【最近的社群動態(公開,所有人都看得到)】\n${recentFeedText(state)}`,
    `【其他介面中,${character.name} 可知曉的近期內容】\n${formatCross(crossContext)}`,
    `【回覆指令】${styleGuide} 單則回覆長度上限約 ${maxReplyChars} 字。`,
    ...(room.authorNote?.trim()
      ? [`【作者備註(當前對話的最高優先指令,凌駕以上所有設定)】${room.authorNote.trim()}`]
      : []),
  ].join('\n\n');

  /*
   * ============================================================
   * 未來真實 AI API 應在這裡接收 buildPrompt 的結果,
   * 並傳入 model、system prompt、messages 與必要的安全設定。
   * 不要在公開靜態網站中硬編碼 API key;
   * 真實部署時請改走受保護的 serverless proxy 或後端。
   *
   * 範例(僅示意,第一版不執行):
   *   const { system, messages } = buildPrompt({ character, roomId });
   *   await fetch(YOUR_PROXY_URL, {
   *     method: 'POST',
   *     body: JSON.stringify({ model, system, messages, safety: {...} }),
   *   });
   * ============================================================
   */

  return {
    system,
    messages: recentMessages,
    meta: {
      maxReplyChars,
      loreEntryCount: loreEntries.length,
      characterId: character.id,
      roomId,
      roomType: room.type,
      sharedMemories,
      privateMemories,
      roomMemories,
      crossContext,
    },
  };
}

/* ---------------- helpers ---------------- */

function sortMemories(list) {
  return [...list].sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
}

/**
 * 群聊專用 prompt:一次 API 呼叫產生整包多角色訊息(省成本)。
 * 隱私規則:因為同一個 prompt 會產生多位角色的發言,
 * 這裡「只」放公開資訊——所有參與者的公開設定、共享記憶、場景記憶與世界書;
 * 絕不放任何角色的 DM 私密記憶,避免互相洩漏。
 */
export function buildGroupPrompt({ roomId, mentionName = null }) {
  const state = getState();
  const room = getRoom(roomId);
  const participants = getRoomCharacters(room);
  const personaG = personaForRoom(room);

  const recentMessages = getRoomMessages(roomId)
    .slice(-RECENT_MESSAGE_LIMIT)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      speaker: speakerName(m, state, room),
      content: m.sharedPost
        ? `[分享了一篇社群貼文|${m.sharedPost.authorName}:${m.sharedPost.excerpt}]${m.content ? ` ${m.content}` : ''}`
        : m.content,
      ...(m.image ? { image: m.image } : {}),
      ...(m.sharedPost?.image ? { image: m.sharedPost.image } : {}),
    }));

  const recentText = recentMessages.map((m) => m.content).join('\n');
  // 世界書:對任一參與者生效的條目取聯集(去重)
  const seen = new Set();
  const lore = [];
  for (const c of participants) {
    for (const e of matchEntries({ characterId: c.id, recentText })) {
      if (!seen.has(e.id)) { seen.add(e.id); lore.push(e); }
    }
  }
  const loreText = lore.length
    ? lore.map((e) => `- (${e.bookName}/${e.title}) ${e.content}`).join('\n')
    : '(無被觸發的條目)';

  const sharedMemories = sortMemories(state.memories.shared);
  const roomMemories = sortMemories(state.memories.byRoomId[roomId] || []);
  const maxReplyChars = state.apiConfig?.maxReplyChars?.group ?? 1200;

  const profiles = participants.map((c) => [
    `- ${c.name}:${c.description || '(無描述)'}`,
    `  個性:${c.personality || '(未提供)'}`,
    c.scenario ? `  情境:${c.scenario}` : '',
    c.systemPrompt ? `  指令:${c.systemPrompt}` : '',
  ].filter(Boolean).join('\n')).join('\n');

  const system = [
    `你要同時扮演一個群組聊天室裡的多位角色。`,
    `【聊天室】「${room.title}」,成員:${participants.map((c) => c.name).join('、')}`,
    `【角色公開資料】\n${profiles}`,
    `【玩家】${personaG?.name || '(未命名玩家)'}:${personaG?.description || '(未提供描述)'}`,
    `【共享記憶】\n${formatMemories(sharedMemories)}`,
    `【本聊天室記憶】\n${formatMemories(roomMemories)}`,
    `【世界書(依關鍵字觸發)】\n${loreText}`,
    `【最近的社群動態(公開,所有人都看得到)】\n${recentFeedText(state)}`,
    ...(mentionName ? [`【點名】玩家在訊息中 @ 了「${mentionName}」:他必須回應;其他人可以補充,也可以不出聲。`] : []),
    `【輸出格式】只輸出 JSON 陣列,不要任何其他文字或 markdown 圍欄:`
      + `[{"name":"角色名","content":"訊息內容"}]。`
      + `1 到 3 則;像真實群聊一樣自然接話,不必每個角色都發言;`
      + `content 是手機短訊口吻,單則不超過 ${maxReplyChars} 字,不要在內容裡加名字前綴。`,
    ...(room.authorNote?.trim()
      ? [`【作者備註(當前對話的最高優先指令,凌駕以上所有設定)】${room.authorNote.trim()}`]
      : []),
  ].join('\n\n');

  return { system, messages: recentMessages, meta: { maxReplyChars, roomType: 'group' } };
}

/** 最近社群動態摘要(公開資訊,所有聊天 prompt 共用)。 */
function recentFeedText(state, limit = 4) {
  const posts = (state.posts || []).slice(0, limit);
  if (!posts.length) return '(目前沒有動態)';
  return posts.map((p) => {
    const who = p.authorId === 'player'
      ? (getPersona(p.personaId)?.name || '玩家')
      : (state.characters.find((c) => c.id === p.authorId)?.name || '?');
    const text = p.content.length > 40 ? `${p.content.slice(0, 40)}…` : p.content;
    return `- ${who}:${text}${p.image ? '(附圖)' : ''}`;
  }).join('\n');
}

function formatMemories(list) {
  if (!list.length) return '(無)';
  return list.map((m) => `- ${m.pinned ? '📌 ' : ''}${m.content}`).join('\n');
}

function formatCross(list) {
  if (!list.length) return '(無)';
  return list.map((x) => `- [${x.roomTitle}] ${x.speaker}:${x.content}`).join('\n');
}

function speakerName(msg, state, room) {
  if (msg.role === 'user') return personaForRoom(room)?.name || '玩家';
  if (msg.senderId === 'system') return '旁白';
  const c = state.characters.find((ch) => ch.id === msg.senderId);
  return c ? c.name : '角色';
}

/**
 * 蒐集角色在其他 room(自己是參與者)的少量近期內容。
 * 因為以 participantIds 過濾,別的角色的 DM 永遠不會被撈進來。
 */
function collectCrossRoomContext(character, currentRoomId) {
  const state = getState();
  const out = [];
  const rooms = state.rooms
    .filter((r) => r.id !== currentRoomId && r.participantIds.includes(character.id))
    .sort((a, b) => b.createdAt - a.createdAt);

  for (const r of rooms) {
    const msgs = (state.messagesByRoom[r.id] || []).slice(-2);
    for (const m of msgs) {
      out.push({
        roomId: r.id,
        roomTitle: r.title,
        speaker: speakerName(m, state, r),
        content: m.content.length > 60 ? m.content.slice(0, 60) + '…' : m.content,
      });
      if (out.length >= CROSS_ROOM_LIMIT) return out;
    }
  }
  return out;
}
