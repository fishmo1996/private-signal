/**
 * modules/prompt.js
 * buildPrompt:組合未來真實 AI API 所需的完整上下文。
 * 第一版沒有任何 API 呼叫;mock 回覆邏輯會取用這裡的結果,
 * 以確保未來換成真實 API 時,資料流不需要重寫。
 */

import { getState, getRoom, getRoomMessages, getRoomCharacters } from './state.js';
import { matchEntries } from './worldbook.js';
import { personaForRoom, getPersona } from './persona.js';
import { sharedMemoriesFor } from './memory.js';
import { albumTextFor, anniversaryTextFor } from './album.js';

const HARD_MESSAGE_CAP = 80;

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/** 訊息時間戳:'7/4(週六) 23:41'。 */
export function fmtMsgTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 距今間隔的人話:'剛剛' / '25 分鐘前' / '5 小時前' / '3 天前'。 */
export function fmtGap(ts) {
  const diff = Date.now() - ts;
  if (diff < 120000) return '剛剛';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分鐘前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小時前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

/** 角色間關係(僅雙方都在場的配對)。無任何關係時回傳空陣列。 */
function relationshipSection(participants) {
  const lines = [];
  for (const a2 of participants) {
    for (const b2 of participants) {
      if (a2.id === b2.id) continue;
      const desc = a2.relationships?.[b2.id];
      if (desc && String(desc).trim()) lines.push(`- ${a2.name} 對 ${b2.name}:${String(desc).trim()}`);
    }
  }
  return lines.length ? [`【角色之間的關係】\n${lines.join('\n')}`] : [];
}

/** 【現在時間】段(現實時間軸;noPhone 與正文不使用)。 */
function nowSection(lastMsgTs = null) {
  const line = `現在是 ${fmtMsgTime(Date.now())}`;
  return lastMsgTs
    ? [`【現在時間】${line};上一則訊息是${fmtGap(lastMsgTs)}。`]
    : [`【現在時間】${line}。`];
} // 極端上限,避免超多短訊息造成組裝負擔

/**
 * 依「上下文預算(字)」由新到舊挑選歷史訊息:
 * 正文一則可能數千字、DM 一則可能十個字,固定則數兩頭不討好;
 * 改用字數預算,長文自動少帶幾則、短訊自動多帶幾十則。至少保留 2 則。
 */
function budgetSlice(msgs) {
  const budget = getState().apiConfig?.contextBudget || 20000;
  const picked = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0 && picked.length < HARD_MESSAGE_CAP; i -= 1) {
    const m = msgs[i];
    const cost = (m.content?.length || 0) + (m.image ? 800 : 0) + (m.sharedPost ? 100 : 0);
    if (used + cost > budget && picked.length >= 2) break;
    picked.unshift(m);
    used += cost;
  }
  return picked;
}

/** 全域提示詞:所有模式的 prompt 開頭第一段(設定 → 提示詞)。 */
export function globalPromptSection(roomId = null) {
  const state = getState();
  const settings = state.settings || {};
  const room = roomId ? state.rooms.find((r) => r.id === roomId) : null;
  const out = [];
  const gp = settings.globalPrompt?.trim();
  if (gp) out.push(`【全域指令(適用所有對話)】${gp}`);
  for (const m of settings.styleModules || []) {
    // 房間層級覆寫:本對話可單獨開/關某模組;未設定則跟隨全域
    const override = room?.styleOverrides?.[m.id];
    const enabled = override === undefined ? m.enabled : override;
    if (enabled && m.content?.trim()) out.push(`【風格模組|${m.name}】${m.content.trim()}`);
  }
  return out;
}
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
  const sharedMemories = sortMemories(sharedMemoriesFor(character.knownPersonaId || state.defaultPersonaId));
  const privateMemories = sortMemories(state.memories.byCharacterId[character.id] || []);
  const roomMemories = room.participantIds.includes(character.id) || room.type === 'dm'
    ? sortMemories(state.memories.byRoomId[roomId] || [])
    : [];

  /* --- 目前 room 最近訊息 --- */
  const useRealTime = !character.noPhone; // 現實時間軸:非現代角色不吃
  const recentMessages = budgetSlice(getRoomMessages(roomId))
    .slice()
    .map((m) => {
      const base = m.sharedPost
        ? `[分享了一篇社群貼文|${m.sharedPost.authorName}:${m.sharedPost.excerpt}]${m.content ? ` ${m.content}` : ''}`
        : m.content;
      return {
        role: m.role === 'user' ? 'user' : 'assistant',
        speaker: speakerName(m, state, room),
        content: useRealTime ? `(${fmtMsgTime(m.createdAt)})${base}` : base,
        ...(m.image ? { image: m.image } : {}),
        ...(m.sharedPost?.image ? { image: m.sharedPost.image } : {}),
      };
    });
  const lastTs = getRoomMessages(roomId).slice(-1)[0]?.createdAt || null;

  /* --- 跨介面內容:只取「這個角色也在場」的其他 room 的少量近期訊息 --- */
  const crossContext = collectCrossRoomContext(character, roomId);

  const persona = personaForRoom(room);

  /* --- 世界書:掃最近訊息文字,只帶入被觸發(或常駐)的條目 --- */
  const recentText = recentMessages.map((m) => m.content).join('\n');
  const loreEntries = matchEntries({ characterId: character.id, roomId, recentText });
  const loreText = loreEntries.length
    ? loreEntries.map((e) => `- (${e.bookName}/${e.title}) ${e.content}`).join('\n')
    : '(無被觸發的條目)';

  /* --- 每模式回覆字數上限(供未來真實 API 與風格指令使用) --- */
  const maxReplyChars = state.apiConfig?.maxReplyChars?.[room.type]
    ?? { dm: 800, group: 1200, story: 4000 }[room.type]
    ?? 800; // 未知房型防禦:退回 DM 規格,絕不輸出 undefined

  /* --- 回覆風格指令 --- */
  const styleGuide = ({
    dm: '風格:私訊。短訊息、自然、口語,像手機上打字。一到兩句即可。以角色第一人稱直接輸出內容,絕對不要在開頭加上自己的名字或「名字:」前綴。',
    group: '風格:群組聊天。自然節奏,不必每人每回合都發言;可補充、吐槽、接話或延後回覆。',
    story: '風格:互動敘事,以小說筆法輸出:場景描述、動作、心理與對話交織。對話用引號呈現,不要用「名字:台詞」的劇本格式,也不要在開頭加名字前綴。',
  }[room.type] ?? '風格:私訊。短訊息、自然、口語。')
  + (room.type === 'story' && state.settings?.storyFormat?.trim()
    ? ` ${state.settings.storyFormat.trim()}`
    : '');

  const system = [
    ...globalPromptSection(roomId),
    `【角色設定】${character.systemPrompt || '(未提供 systemPrompt)'}`,
    `【角色名稱】${character.name}`,
    ...(character.emojiStyle?.trim() && !character.noPhone ? [`【Emoji 習慣】${character.emojiStyle.trim()}`] : []),
    `【角色描述】${character.description || '(未提供)'}`,
    `【個性】${character.personality || '(未提供)'}`,
    `【情境】${character.scenario || '(未提供)'}`,
    `【玩家】${persona?.name || '(未命名玩家)'}:${persona?.description || '(未提供描述)'}`,
    `【目前聊天室】類型 ${room.type},名稱「${room.title}」,參與角色:${participants.map((c) => c.name).join('、') || '(無)'}`,
    `【共享記憶】\n${formatMemories(sharedMemories)}`,
    `【${character.name} 的私密記憶(其他角色不可見)】\n${formatMemories(privateMemories)}`,
    ...(albumTextFor(character.id) ? [`【共同的回憶(相簿)】\n${albumTextFor(character.id)}`] : []),
    ...(!character.noPhone && anniversaryTextFor(character.id) ? [`【特別的日子】${anniversaryTextFor(character.id)}——如果自然,可以提起它。`] : []),
    `【本場景記憶(僅本 room 參與者可見)】\n${formatMemories(roomMemories)}`,
    `【世界書(依關鍵字觸發)】\n${loreText}`,
    ...(useRealTime ? nowSection(lastTs) : []),
    ...(character.noPhone ? [] : [`【最近的社群動態(公開,所有人都看得到)】\n${recentFeedText(state)}`]),
    `【其他介面中,${character.name} 可知曉的近期內容】\n${formatCross(crossContext)}`,
    `【回覆指令】${styleGuide} ${
  state.settings?.chatFeel !== false
    ? '以真實聊天軟體的口吻回覆:第一人稱、口語、像在打字。把回覆拆成 1~3 則短訊息(每則不超過 100 字),訊息之間用單獨一行「---」分隔。絕對不要第三人稱旁白敘事(不要寫「他抓了抓頭髮」這種)。動作或神態通常不用寫——真人打字很少描述自己的動作;偶爾需要時才用括號短註,而且要貼合你當下真實在做的事,不要有固定口頭禪式的重複動作。'
    : ''
} 訊息可自然使用 emoji,頻率與風格依角色個性。${
  state.settings?.voiceTag !== false && !character.noPhone
    ? '如果這則訊息更適合「用說的」(情緒濃的時刻、撒嬌、慵懶的晚安、哼一句歌),在訊息最開頭加上標記[語音]——大約一成的時機,別常用。'
    : ''
}${
  state.settings?.moodEmoji !== false && !character.noPhone
    ? ' 在整段輸出的最後另起一行加上「[心情:x]」,x 是最能代表你此刻對玩家心情的一個 emoji。'
    : ''
} 單則回覆長度上限約 ${maxReplyChars} 字。`,
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
/**
 * 旁觀群 prompt:角色們自己的私下群組,玩家不在場(但在偷看)。
 * 素材只有公開資訊:彼此資料、關係、圈子共享記憶、公開動態、本群歷史。
 * 任何人的 DM 私密記憶絕不進來。
 */
export function buildPeekPrompt({ roomId }) {
  const state = getState();
  const room = getRoom(roomId);
  const participants = getRoomCharacters(room);
  const personaP = personaForRoom(room);
  const sharedMemories = sharedMemoriesFor(personaP?.id);
  const recentMessages = budgetSlice(getRoomMessages(roomId))
    .map((m) => ({
      role: 'assistant',
      speaker: (state.characters.find((c) => c.id === m.senderId)?.name) || '成員',
      content: `(${fmtMsgTime(m.createdAt)})${m.content}`,
    }));
  const recentText = recentMessages.map((m) => m.content).join('\n');
  const loreLines = [];
  const seenLore = new Set();
  for (const c of participants) {
    for (const e of matchEntries({ characterId: c.id, roomId, recentText })) {
      if (seenLore.has(e.title)) continue;
      seenLore.add(e.title);
      loreLines.push(`- (${e.bookName}/${e.title}) ${e.content}`);
    }
  }
  const profiles = participants.flatMap((c) => [
    `- ${c.name}:${c.description || '(未提供)'}`,
    `  個性:${c.personality || '(未提供)'}`,
    c.emojiStyle?.trim() && !c.noPhone ? `  Emoji 習慣:${c.emojiStyle.trim()}` : '',
  ].filter(Boolean));
  const system = [
    ...globalPromptSection(roomId),
    `這是「${room.title}」——以下角色們自己的私下群組。`,
    `【成員】\n${profiles.join('\n')}`,
    ...relationshipSection(participants),
    `【重要】玩家「${personaP?.name || '那個人'}」不在這個群組裡,看不到這裡的訊息。`
    + '你們可以自然聊到這個人——背著本人講話的那種語氣;絕對不要對這個人喊話,也不要代替其發言。',
    `【關於「${personaP?.name || '那個人'}」你們知道的】${personaP?.description?.trim() || '(所知不多)'}`,
    '【務實原則】聊到這個人時,只根據上面的資料、共享記憶與這個群裡聊過的內容;'
    + '不知道的事可以用猜的口吻(「不知道他最近在幹嘛」),但不要編造沒發生過的具體事件。',
    `【共享記憶(大家都知道的事)】\n${formatMemories(sharedMemories)}`,
    ...(participants.every((c) => c.noPhone) ? [] : [`【最近的社群動態(公開)】\n${recentFeedText(state)}`]),
    ...nowSection(getRoomMessages(roomId).slice(-1)[0]?.createdAt || null),
    ...(loreLines.length ? [`【世界設定】\n${loreLines.join('\n')}`] : []),
    '【自聊指令】從共同知道的事挑話題聊 2~5 則,有來有往,可以互虧、歪樓、八卦不在場的人。',
    '【輸出格式】只輸出 JSON 陣列,不要其他文字:[{"name":"角色名","content":"訊息"}]。',
  ].filter(Boolean).join('\n\n');
  return {
    system,
    messages: [...recentMessages, { role: 'user', content: '(群組安靜了一陣子,你們之中有人先開口。)' }],
    meta: { mode: 'peek', maxReplyChars: state.apiConfig?.maxReplyChars?.group || 1200 },
  };
}

export function buildGroupPrompt({ roomId, mentionName = null, selfTalk = false }) {
  const state = getState();
  const room = getRoom(roomId);
  const participants = getRoomCharacters(room);
  const personaG = personaForRoom(room);

  const useRealTimeG = !participants.every((c) => c.noPhone);
  const recentMessages = budgetSlice(getRoomMessages(roomId))
    .slice()
    .map((m) => {
      const base = m.sharedPost
        ? `[分享了一篇社群貼文|${m.sharedPost.authorName}:${m.sharedPost.excerpt}]${m.content ? ` ${m.content}` : ''}`
        : m.content;
      return {
        role: m.role === 'user' ? 'user' : 'assistant',
        speaker: speakerName(m, state, room),
        content: useRealTimeG ? `(${fmtMsgTime(m.createdAt)})${base}` : base,
        ...(m.image ? { image: m.image } : {}),
        ...(m.sharedPost?.image ? { image: m.sharedPost.image } : {}),
      };
    });
  const lastTsG = getRoomMessages(roomId).slice(-1)[0]?.createdAt || null;

  const recentText = recentMessages.map((m) => m.content).join('\n');
  // 世界書:對任一參與者生效的條目取聯集(去重)
  const seen = new Set();
  const lore = [];
  for (const c of participants) {
    for (const e of matchEntries({ characterId: c.id, roomId, recentText })) {
      if (!seen.has(e.id)) { seen.add(e.id); lore.push(e); }
    }
  }
  const loreText = lore.length
    ? lore.map((e) => `- (${e.bookName}/${e.title}) ${e.content}`).join('\n')
    : '(無被觸發的條目)';

  const sharedMemories = sortMemories(sharedMemoriesFor(personaG?.id || state.defaultPersonaId));
  const roomMemories = sortMemories(state.memories.byRoomId[roomId] || []);
  const maxReplyChars = state.apiConfig?.maxReplyChars?.group ?? 1200;

  const profiles = participants.map((c) => [
    `- ${c.name}:${c.description || '(無描述)'}`,
    `  個性:${c.personality || '(未提供)'}`,
    c.emojiStyle?.trim() && !c.noPhone ? `  Emoji 習慣:${c.emojiStyle.trim()}` : '',
    c.scenario ? `  情境:${c.scenario}` : '',
    c.systemPrompt ? `  指令:${c.systemPrompt}` : '',
  ].filter(Boolean).join('\n')).join('\n');

  const system = [
    ...globalPromptSection(roomId),
    `你要同時扮演一個群組聊天室裡的多位角色。`,
    `【聊天室】「${room.title}」,成員:${participants.map((c) => c.name).join('、')}`,
    `【角色公開資料】\n${profiles}`,
    `【玩家】${personaG?.name || '(未命名玩家)'}:${personaG?.description || '(未提供描述)'}`,
    `【共享記憶】\n${formatMemories(sharedMemories)}`,
    `【本聊天室記憶】\n${formatMemories(roomMemories)}`,
    `【世界書(依關鍵字觸發)】\n${loreText}`,
    ...relationshipSection(participants),
    ...(useRealTimeG ? nowSection(lastTsG) : []),
    ...(participants.every((c) => c.noPhone) ? [] : [`【最近的社群動態(公開,所有人都看得到)】\n${recentFeedText(state)}`]),
    ...(selfTalk ? [
      '【自聊模式】玩家目前沒有說話。你們自己聊起來:從共同知道的近期內容(群裡聊過的、公開動態、大家都知道的事)挑話題,'
      + '2~5 則,有來有往,可以互虧、可以歪樓;不要對玩家喊話,也不要代替玩家發言。',
    ] : []),
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

/**
 * 正文專用 prompt:全員說書人視角(開放世界引擎)。
 * 隱私規則同群聊:只含在場者的公開資料 + 共享/場景記憶 + 世界書,絕不含私密記憶。
 */
export function buildStoryPrompt({ roomId }) {
  const state = getState();
  const room = getRoom(roomId);
  const participants = getRoomCharacters(room);
  const persona = personaForRoom(room);

  const recentMessages = budgetSlice(getRoomMessages(roomId))
    .slice()
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      speaker: speakerName(m, state, room),
      content: m.sharedPost
        ? `[分享了一篇社群貼文|${m.sharedPost.authorName}:${m.sharedPost.excerpt}]${m.content ? ` ${m.content}` : ''}`
        : m.content,
      ...(m.image ? { image: m.image } : {}),
    }));

  const recentText = recentMessages.map((m) => m.content).join('\n');
  const seen = new Set(); const lore = [];
  for (const c of participants) {
    for (const e of matchEntries({ characterId: c.id, roomId, recentText })) {
      if (!seen.has(e.id)) { seen.add(e.id); lore.push(e); }
    }
  }
  const loreText = lore.length
    ? lore.map((e) => `- (${e.bookName}/${e.title}) ${e.content}`).join('\n')
    : '(無被觸發的條目)';

  const sharedMemories = sortMemories(sharedMemoriesFor(persona?.id || state.defaultPersonaId));
  const roomMemories = sortMemories(state.memories.byRoomId[roomId] || []);
  const maxReplyChars = state.apiConfig?.maxReplyChars?.story ?? 4000;

  const profiles = participants.map((c) => [
    `- ${c.name}:${c.description || '(無描述)'}`,
    `  個性:${c.personality || '(未提供)'}`,
    c.emojiStyle?.trim() && !c.noPhone ? `  Emoji 習慣:${c.emojiStyle.trim()}` : '',
    c.scenario ? `  情境:${c.scenario}` : '',
    c.systemPrompt ? `  指令:${c.systemPrompt}` : '',
  ].filter(Boolean).join('\n')).join('\n');

  const choiceGuide = state.settings?.storyChoices
    ? '敘事結束後,另起新行以「▷」開頭列出 2~3 個玩家可採取的行動選項(每個一行,10 字內);選項要有差異,玩家也可以無視選項自行輸入。'
    : '';
  const styleGuide = '風格:互動敘事,你是這個場景的說書人,以小說筆法同時推進所有在場角色:場景描述、動作、心理與對話交織。'
    + '對話用「」引號呈現,不要「名字:台詞」的劇本格式,不要名字前綴。'
    + '允許引入未事先定義的路人與臨時 NPC(店員、路人、司機等),自然登場即可;但不要替不在場的既有角色代言。'
    + (state.settings?.storyFormat?.trim() ? ` ${state.settings.storyFormat.trim()}` : '');

  const system = [
    ...globalPromptSection(roomId),
    `你是互動小說的說書人,負責「${room.title}」這個場景。`,
    ...(room.statusBar?.trim() ? [`【當前狀態(劇情時間/地點/狀態,以此為準)】${room.statusBar.trim()}`] : []),
    `【在場角色(公開資料)】\n${profiles}`,
    `【玩家角色】${persona?.name || '(未命名玩家)'}:${persona?.description || '(未提供描述)'}`,
    ...relationshipSection(participants),
    `【共享記憶】\n${formatMemories(sharedMemories)}`,
    `【本場景記憶】\n${formatMemories(roomMemories)}`,
    `【世界書(依關鍵字觸發)】\n${loreText}`,
    ...(participants.every((c) => c.noPhone) ? [] : [`【最近的社群動態(公開;僅供了解角色近況,其發文時間與正文的劇情時間無關)】\n${recentFeedText(state)}`]),
    `【回覆指令】${styleGuide} ${choiceGuide} 單次輸出長度上限約 ${maxReplyChars} 字。`,
    ...(room.authorNote?.trim()
      ? [`【作者備註(當前對話的最高優先指令,凌駕以上所有設定)】${room.authorNote.trim()}`]
      : []),
  ].join('\n\n');

  return { system, messages: recentMessages, meta: { maxReplyChars, roomType: 'story', participantCount: participants.length } };
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
