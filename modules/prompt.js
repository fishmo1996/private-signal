/**
 * modules/prompt.js
 * buildPrompt:組合未來真實 AI API 所需的完整上下文。
 * 第一版沒有任何 API 呼叫;mock 回覆邏輯會取用這裡的結果,
 * 以確保未來換成真實 API 時，資料流不需要重寫。
 */

import { getState, getRoom, getRoomMessages, getRoomCharacters, getCharacter } from './state.js';
import { matchEntries } from './worldbook.js';
import { personaForRoom, getPersona } from './persona.js';
import { sharedMemoriesFor, relativeTimeNote, anniversaryMemoryHits } from './memory.js';
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

/**
 * 角色「本人」對其他角色的關係(單向，只有他自己這一側;v61)。
 * DM 與偷看手機用：他知道自己怎麼看待認識的人，但拿不到對方的卡片內容——隱私鐵律不變。
 */
function ownRelationshipsSection(character) {
  const state = getState();
  const lines = Object.entries(character.relationships || {})
    .map(([rid, desc]) => {
      const other = state.characters.find((cc) => cc.id === rid);
      const d = String(desc || '').trim();
      return other && d ? `- ${other.name}:${d}` : null;
    })
    .filter(Boolean);
  return lines.length ? [`【${character.name} 認識的人(你與他們的關係)】\n${lines.join('\n')}`] : [];
}

/** 【現在時間】段(現實時間軸;noPhone 與正文不使用)。 */
function nowSection(lastMsgTs = null) {
  const line = `現在是 ${fmtMsgTime(Date.now())}`;
  const noEcho = '對話紀錄裡訊息前的「(日期 時間)」與記憶後的「(約 N 天前)」都是系統附註，只供你理解時間脈絡——你的輸出絕對不要包含這些格式。';
  return lastMsgTs
    ? [`【現在時間】${line};上一則訊息是${fmtGap(lastMsgTs)}。${noEcho}`]
    : [`【現在時間】${line}。${noEcho}`];
} // 極端上限，避免超多短訊息造成組裝負擔

/**
 * 依「上下文預算(字)」由新到舊挑選歷史訊息:
 * 正文一則可能數千字、DM 一則可能十個字，固定則數兩頭不討好;
 * 改用字數預算，長文自動少帶幾則、短訊自動多帶幾十則。至少保留 2 則。
 */
function budgetSlice(msgs) {
  const budget = getState().apiConfig?.contextBudget || 20000;
  const picked = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0 && picked.length < HARD_MESSAGE_CAP; i -= 1) {
    const m = msgs[i];
    const cost = (m.content?.length || 0) + (m.image ? 800 : 0) + (m.sharedPost ? 100 + ((m.sharedPost.commentContext?.length || 0) * 40) : 0);
    if (used + cost > budget && picked.length >= 2) break;
    picked.unshift(m);
    used += cost;
  }
  return picked;
}

/** 全域提示詞：所有模式的 prompt 開頭第一段(設定 → 提示詞)。 */
export function globalPromptSection(roomId = null) {
  const state = getState();
  const settings = state.settings || {};
  const room = roomId ? state.rooms.find((r) => r.id === roomId) : null;
  const out = [];
  const gp = settings.globalPrompt?.trim();
  if (gp) out.push(`【全域指令(適用所有對話)】${gp}`);
  for (const m of settings.styleModules || []) {
    // 房間層級覆寫：本對話可單獨開/關某模組；未設定則跟隨全域
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
export function buildPrompt({ character, roomId, innerVoiceOf = null }) {
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
  const useRealTime = !character.noPhone; // 現實時間軸：非現代角色不吃
  let srcMsgs = getRoomMessages(roomId);
  if (innerVoiceOf) {
    const idx = srcMsgs.findIndex((mm) => mm.id === innerVoiceOf);
    if (idx >= 0) srcMsgs = srcMsgs.slice(0, idx + 1);
  }
  const recentMessages = budgetSlice(srcMsgs)
    .slice()
    .map((m) => {
      const base = m.sharedPost
        ? sharedPostText(m)
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

  /* --- 跨介面內容：只取「這個角色也在場」的其他 room 的少量近期訊息 --- */
  const crossContext = collectCrossRoomContext(character, roomId);

  const persona = personaForRoom(room);

  /* --- 世界書：掃最近訊息文字，只帶入被觸發(或常駐)的條目 --- */
  const recentText = recentMessages.map((m) => m.content).join('\n');
  const loreEntries = matchEntries({ characterId: character.id, roomId, recentText, presentNames: participants.map((p) => p.name) });
  const loreText = loreEntries.length
    ? loreEntries.map((e) => `- (${e.bookName}/${e.title}) ${e.content}`).join('\n')
    : '(無被觸發的條目)';

  /* --- 每模式回覆字數上限(供未來真實 API 與風格指令使用) --- */
  const maxReplyChars = state.apiConfig?.maxReplyChars?.[room.type]
    ?? { dm: 800, group: 1200, story: 4000 }[room.type]
    ?? 800; // 未知房型防禦：退回 DM 規格，絕不輸出 undefined

  /* --- 回覆風格指令 --- */
  // v77(根源三):DM 指令瘦身——原版與聊天感段重複陳述「第一人稱/口語/像打字」三處以上,
  // 重寫為不重複的緊湊版,語意不變(重複=token 浪費且稀釋服從度)。
  // v78:指令骨架語言開關(apiConfig.promptLang 'zh'|'en',預設 zh)。英文骨架省指令
  // token 且格式服從度較好;台詞錨、作者備註、世界書等「內容血肉」一律保持中文。
  // ★兩版語意必須同步:改任何一版的規則,另一版要跟著改(標記格式 [心情:x] 等不翻譯,
  // 輸出端收割器認的是中文標籤)。英文版結尾兩條硬規則必留:繁中輸出+「」引號。
  const promptEn = state.apiConfig?.promptLang === 'en' && room.type === 'dm';
  const styleGuide = ({
    dm: '風格：私訊。你正在手機上打字回訊息：第一人稱、口語、精短。行首絕不加自己的名字或「名字：」前綴。',
    group: '風格：群組聊天。自然節奏，不必每人每回合都發言；可補充、吐槽、接話或延後回覆。',
    story: '風格：互動敘事，以小說筆法輸出：場景描述、動作、心理與對話交織。對話用引號呈現，不要用「名字：台詞」的劇本格式，也不要在開頭加名字前綴。',
  }[room.type] ?? '風格：私訊。短訊息、自然、口語。')
  + (room.type === 'story' && state.settings?.storyFormat?.trim()
    ? ` ${state.settings.storyFormat.trim()}`
    : '');

  const dmReplyGuideZh = `【回覆指令】${styleGuide} ${
  state.settings?.chatFeel !== false
    ? '把回覆拆成 1~3 則短訊息(每則 ≤100 字),訊息之間用單獨一行「---」分隔,「---」不可寫在句子中間。禁止第三人稱旁白與神態描寫；偶爾必要時才用括號短註，只寫你此刻真正在做的事，不要固定口頭禪式的重複動作。'
    : ''
} emoji 預設節制:多數訊息不帶表符,偶爾在情緒真的需要時用一個;若上面有【Emoji 習慣】則完全以其為準。無論如何禁止使用 😏(除非 Emoji 習慣裡明確要求)。${
  state.settings?.voiceTag !== false && !character.noPhone
    ? '如果這則訊息更適合「用說的」(情緒濃的時刻、撒嬌、慵懶的晚安、哼一句歌),在訊息最開頭加上標記[語音]——大約一成的時機，別常用。'
    : ''
}${
  state.settings?.moodEmoji !== false && !character.noPhone
    ? ' 在整段輸出的最後另起一行加上「[心情:x]」,x 是最能代表你此刻對玩家心情的一個 emoji。'
    : ''
}${
  state.settings?.charStatus !== false && !character.noPhone
    ? ' 另外，你在通訊軟體上掛著一個所有人可見的狀態(像個性簽名)。僅在這次對話讓你的狀態「確實會改變」時，才在輸出最後另起一行加上「[狀態：一句話]」(15 字內)——多數回覆不需要。狀態是公開的，絕不可包含只有你和玩家兩人知道的私密細節。'
    : ''
}${room.type === 'dm' && state.settings?.chatFeel !== false ? '' : ` 單則回覆長度上限約 ${maxReplyChars} 字。`}`;

  // v78 英文版:與中文版逐段同語意(含設定開關條件),不是照抄交接文件——文件版把
  // [心情][狀態] 寫死且漏了 [語音],照抄會讓設定開關在英文模式下失效。
  const dmReplyGuideEn = '【Reply Rules】'
    + (state.settings?.chatFeel !== false
      ? 'You are texting as this character in a real messaging app. First person, casual, like typing on a phone. Send 1-3 short messages (each ≤100 Chinese characters), separated by a line containing only "---"; never put "---" mid-sentence. Never prefix your own name. No third-person narration or stage directions; a brief parenthetical only for what you are actually doing right now — no habitual filler actions.'
      : `Reply as one message: first person, casual, like typing on a phone, within about ${maxReplyChars} Chinese characters. Never prefix your own name; no third-person narration or stage directions.`)
    + ' Emoji: sparing — most messages carry none; never 😏. If an【Emoji 習慣】section exists above, follow it exactly.'
    + (state.settings?.voiceTag !== false && !character.noPhone
      ? ' If a message is better spoken than typed (charged emotion, a sleepy goodnight, humming a line), start that message with the tag [語音] — at most about 1 in 10 messages.'
      : '')
    + (state.settings?.moodEmoji !== false && !character.noPhone
      ? ' End the whole output with a new line "[心情:x]" (x = ONE emoji for your current feeling toward the player).'
      : '')
    + (state.settings?.charStatus !== false && !character.noPhone
      ? ' Add a new line "[狀態:...]" (≤15 Chinese characters, publicly visible, never private details only you two share) ONLY if this exchange truly changes your public status — most replies do not.'
      : '')
    + ' Reply ONLY in Traditional Chinese (Taiwan). Use 「」 for quoted speech.';

  const system = [
    ...globalPromptSection(roomId),
    `【角色設定】${character.systemPrompt || '(未提供 systemPrompt)'}`,
    `【角色名稱】${character.name}`,
    ...(character.emojiStyle?.trim() && !character.noPhone ? [`【Emoji 習慣】${character.emojiStyle.trim()}`] : []),
    `【角色描述】${character.description || '(未提供)'}`,
    `【個性】${character.personality || '(未提供)'}`,
    `【情境】${character.scenario || '(未提供)'}`,
    `【玩家】${persona?.name || '(未命名玩家)'}:${persona?.description || '(未提供描述)'}`,
    `【目前聊天室】類型 ${room.type},名稱「${room.title}」，參與角色:${participants.map((c) => c.name).join('、') || '(無)'}`,
    `【共享記憶】\n${formatMemories(sharedMemories, { withRelativeTime: true })}`,
    `【${character.name} 的私密記憶(其他角色不可見)】\n${formatMemories(privateMemories, { withRelativeTime: true })}`,
    ...anniversarySection(character.id, roomId),
    ...ownRelationshipsSection(character),
    ...(room.relationshipStage?.trim() ? [`【目前與玩家的關係階段】${room.relationshipStage.trim()}(作為背景理解，不要逐字複述此欄內容)`] : []),
    ...(albumTextFor(character.id) ? [`【共同的回憶(相簿)】\n${albumTextFor(character.id)}`] : []),
    ...(!character.noPhone && anniversaryTextFor(character.id) ? [`【特別的日子】${anniversaryTextFor(character.id)}——如果自然，可以提起它。`] : []),
    `【本場景記憶(僅本 room 參與者可見)】\n${formatMemories(roomMemories)}`,
    `【世界書(依關鍵字觸發)】\n${loreText}`,
    ...(useRealTime ? nowSection(lastTs) : []),
    ...(character.noPhone ? [] : [`【最近的社群動態(公開)】\n${recentFeedText(state, persona?.id)}`]),
    `【其他介面中,${character.name} 可知曉的近期內容】\n${formatCross(crossContext)}`,
    innerVoiceOf
      ? '【任務】以下不是要你回覆對話：請寫出你剛才說出最後那則訊息的「當下」，心裡真正的想法——表面沒說出口的部分(動作洩漏的、語氣藏著的、不敢講的)。第一人稱純內心獨白,100~200 字；不要對玩家喊話、不要寫你接下來要說的話或任何新的訊息、不要引號包裹、不要描述自己的動作、不要以日期或時間開頭、不要任何標記格式。輸出繁體中文。'
      : (promptEn ? dmReplyGuideEn : dmReplyGuideZh),
    ...(room.authorNote?.trim()
      ? [`【作者備註(當前對話的最高優先指令，凌駕以上所有設定)】${room.authorNote.trim()}`]
      : []),
  ].join('\n\n');

  /*
   * ============================================================
   * 未來真實 AI API 應在這裡接收 buildPrompt 的結果,
   * 並傳入 model、system prompt、messages 與必要的安全設定。
   * 不要在公開靜態網站中硬編碼 API key;
   * 真實部署時請改走受保護的 serverless proxy 或後端。
   *
   * 範例(僅示意，第一版不執行):
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
      maxReplyChars: innerVoiceOf ? 300 : maxReplyChars,
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
 * 隱私規則：因為同一個 prompt 會產生多位角色的發言,
 * 這裡「只」放公開資訊——所有參與者的公開設定、共享記憶、場景記憶與世界書;
 * 絕不放任何角色的 DM 私密記憶，避免互相洩漏。
 */
/**
 * 旁觀群 prompt:角色們自己的私下群組，玩家不在場(但在偷看)。
 * 素材只有公開資訊：彼此資料、關係、圈子共享記憶、公開動態、本群歷史。
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
    for (const e of matchEntries({ characterId: c.id, roomId, recentText, presentNames: participants.map((pp) => pp.name) })) {
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

  // v79(d2):共同在場的群聊注入——只帶「全體旁觀成員都在場」的一般群聊(他們親身
  // 經歷過的內容),依最近活躍取 2 房、各尾端 6 則、每則截 60 字。DM/正文/其他旁觀房
  // 一律不進(隱私鐵律不動;正文=擁有者選擇不帶,劇情時間與現實脫鉤)。部分成員在場
  // 的群也不帶——避免「不在場的人知道了群內容」這種穿幫(有隱私測試把關)。
  const witnessedGroups = state.rooms
    .filter((r) => r.type === 'group' && !r.branchedFrom
      && participants.every((c) => r.participantIds.includes(c.id)))
    .map((r) => ({ room: r, msgs: getRoomMessages(r.id) }))
    .filter((g) => g.msgs.length)
    .sort((x, y) => (y.msgs[y.msgs.length - 1]?.createdAt || 0) - (x.msgs[x.msgs.length - 1]?.createdAt || 0))
    .slice(0, 2)
    .map(({ room: r, msgs }) => {
      const pName = personaForRoom(r)?.name || '玩家';
      const lines = msgs.slice(-6).map((m) => {
        const who = m.senderId === 'player' || m.role === 'user'
          ? pName
          : (state.characters.find((c) => c.id === m.senderId)?.name || '成員');
        const body = String(m.content || '').length > 60 ? `${String(m.content).slice(0, 60)}…` : String(m.content || '');
        return `  ‣ ${who}:${body}`;
      });
      return `「${r.title}」(${pName} 也在這個群):\n${lines.join('\n')}`;
    });

  // v79(d3):各成員對玩家的關係階段(取各自 DM 主線房的 relationshipStage)——
  // 這是他們各自心裡的立場,注入後八卦的態度會穩(暗戀的閃躲、看不順眼的嗆)。
  const stageLines = participants.map((c) => {
    const dm = state.rooms.find((r) => r.type === 'dm' && !r.branchedFrom && r.participantIds.includes(c.id));
    const st = dm?.relationshipStage?.trim();
    return st ? `- ${c.name}:${st}` : '';
  }).filter(Boolean);

  const system = [
    ...globalPromptSection(roomId),
    `這是「${room.title}」——以下角色們自己的私下群組。`,
    `【成員】\n${profiles.join('\n')}`,
    ...relationshipSection(participants),
    `【重要】玩家「${personaP?.name || '那個人'}」不在這個群組裡，看不到這裡的訊息。`
    + '你們可以自然聊到這個人——背著本人講話的那種語氣；絕對不要對這個人喊話，也不要代替其發言。',
    `【關於「${personaP?.name || '那個人'}」你們知道的】${personaP?.description?.trim() || '(所知不多)'}`,
    '【務實原則】聊到這個人時，只根據上面的資料、共享記憶與這個群裡聊過的內容;'
    + '不知道的事可以用猜的口吻(「不知道他最近在幹嘛」),但不要編造沒發生過的具體事件。',
    ...(stageLines.length ? [
      `【各自對「${personaP?.name || '那個人'}」目前的關係階段(每人自己心裡的立場;會影響你講到這個人時的語氣與態度,但絕不要把這欄唸出來或明講階段)】\n${stageLines.join('\n')}`,
    ] : []),
    `【共享記憶(大家都知道的事)】\n${formatMemories(sharedMemories)}`,
    ...(participants.every((c) => c.noPhone) ? [] : [`【最近的社群動態(公開,含留言)】\n${recentFeedDetailText(state, personaP?.id)}`]),
    ...(witnessedGroups.length ? [`【你們都在場的群組最近聊到(你們親身經歷過的)】\n${witnessedGroups.join('\n')}`] : []),
    ...nowSection(getRoomMessages(roomId).slice(-1)[0]?.createdAt || null),
    ...(loreLines.length ? [`【世界設定】\n${loreLines.join('\n')}`] : []),
    '【自聊指令】從共同知道的事挑話題聊 2~5 則，有來有往，可以互虧、歪樓、八卦不在場的人。',
    '【語感】依成員的年齡與彼此的熟度說話。若是台灣年輕人的私下群組,用真實的打字習慣:'
    + '句子短而碎、超口語,語助詞和輕度髒話自然出現(幹、靠、笑死、==、484、好了啦、關我屁事),'
    + '可以已讀亂回、跳話題、嗆人不用鋪陳,同一人可連發多則短句(輸出多個同名物件)。'
    + '不要書面語、不要議論文式的完整長句、不要每個人講話都一樣長。',
    '【輸出格式】只輸出 JSON 陣列，不要其他文字:[{"name":"角色名","content":"訊息"}]。',
  ].filter(Boolean).join('\n\n');
  return {
    system,
    messages: [...recentMessages, { role: 'user', content: '(群組安靜了一陣子，你們之中有人先開口。)' }],
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
        ? sharedPostText(m)
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
  // 世界書：對任一參與者生效的條目取聯集(去重)
  const seen = new Set();
  const lore = [];
  for (const c of participants) {
    for (const e of matchEntries({ characterId: c.id, roomId, recentText, presentNames: participants.map((pp) => pp.name) })) {
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
    `【聊天室】「${room.title}」，成員:${participants.map((c) => c.name).join('、')}`,
    `【角色公開資料】\n${profiles}`,
    `【玩家】${personaG?.name || '(未命名玩家)'}:${personaG?.description || '(未提供描述)'}`,
    `【共享記憶】\n${formatMemories(sharedMemories, { withRelativeTime: true })}`,
    `【本聊天室記憶】\n${formatMemories(roomMemories)}`,
    `【世界書(依關鍵字觸發)】\n${loreText}`,
    ...relationshipSection(participants),
    ...(useRealTimeG ? nowSection(lastTsG) : []),
    ...(participants.every((c) => c.noPhone) ? [] : [`【最近的社群動態(公開)】\n${recentFeedText(state, personaG?.id)}`]),
    ...(selfTalk ? [
      '【自聊模式】玩家目前沒有說話。你們自己聊起來：從共同知道的近期內容(群裡聊過的、公開動態、大家都知道的事)挑話題,'
      + '2~5 則，有來有往，可以互虧、可以歪樓；不要對玩家喊話，也不要代替玩家發言。',
    ] : []),
    ...(mentionName ? [`【點名】玩家在訊息中 @ 了「${mentionName}」：他必須回應；其他人可以補充，也可以不出聲。`] : []),
    state.apiConfig?.promptLang === 'en' // v78:骨架語言開關(內容血肉仍中文;兩版語意必須同步)
      ? '【Output Format】Output ONLY a JSON array — no other text, no markdown fences: '
        + '[{"name":"角色名","content":"訊息內容"}]. '
        + '1 to 3 items; chat naturally like a real group — not everyone has to speak. '
        + 'Each "content" is phone-texting tone, ≤100 Chinese characters, no name prefix inside content. '
        + 'All "content" must be in Traditional Chinese (Taiwan). Use 「」 for quoted speech.'
      : `【輸出格式】只輸出 JSON 陣列，不要任何其他文字或 markdown 圍欄:`
      + `[{"name":"角色名","content":"訊息內容"}]。`
      + `1 到 3 則；像真實群聊一樣自然接話，不必每個角色都發言;`
      + `content 是手機短訊口吻，每則 ≤100 字，不要在內容裡加名字前綴。`,
    ...(room.authorNote?.trim()
      ? [`【作者備註(當前對話的最高優先指令，凌駕以上所有設定)】${room.authorNote.trim()}`]
      : []),
  ].join('\n\n');

  return { system, messages: recentMessages, meta: { maxReplyChars, roomType: 'group' } };
}

/** 最近社群動態摘要(公開資訊，所有聊天 prompt 共用)。 */

/** v73:分享貼文卡的文字化(含私下聊帶來的留言脈絡)。三個呼叫點共用,勿再抄散。 */
function sharedPostText(m) {
  const sp = m.sharedPost;
  let base = `[分享了一篇社群貼文|${sp.authorName}:${sp.excerpt}`;
  if (sp.commentContext?.length) {
    const thread = sp.commentContext
      .map((cc) => `${cc.focus ? '»' : ''}${cc.name}:${cc.content}`)
      .join(' / ');
    const focus = sp.commentContext.find((cc) => cc.focus);
    base += `|這篇底下的留言串:${thread}`;
    if (focus) base += `|玩家點名要私下聊的是「${focus.name}:${focus.content}」——你記得這句話,接著這個話題聊`;
  }
  base += ']';
  return `${base}${m.content ? ` ${m.content}` : ''}`;
}

function recentFeedText(state, personaId = null, limit = 4) {
  // v62 圈子隔離:玩家有多個人設(不同世界觀分身)時,角色只看得到「他認識的那個你」
  // 所屬圈子的貼文;無圈子標記的舊貼文視為全域可見。修「同居線角色把家教線人設
  // 發的披薩文當成眼前這個你」的跨圈污染。
  const pid = personaId || state.defaultPersonaId;
  const circleOfPost = (pp) => pp.personaId
    || (pp.authorId !== 'player'
      ? (state.characters.find((c) => c.id === pp.authorId)?.knownPersonaId || state.defaultPersonaId)
      : null); // v70:舊角色貼文沒記圈 → 用作者認識的人設動態推,別再當全域可見
  const posts = (state.posts || [])
    .filter((pp) => { const cir = circleOfPost(pp); return !cir || cir === pid; })
    .slice(0, limit);
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
 * v79(d1):社群素材加料版——僅旁觀群使用(其他房維持 recentFeedText 省 token)。
 * 旁觀群的八卦素材以前只有「4 篇×截 40 字、零留言」,但角色跟玩家的互動大多發生在
 * 留言區 → 他們剛在留言區聊完、轉頭進旁觀群卻全盲(擁有者實測「銜接不上」)。
 * 這版帶:最近 3 篇較完整內文(截 120 字)+每篇尾端 4 則留言(含誰回覆誰,截 60 字)。
 * 圈子隔離規則與 recentFeedText 完全相同。
 */
function recentFeedDetailText(state, personaId = null, { limit = 3, postChars = 120, cmtCount = 4, cmtChars = 60 } = {}) {
  const pid = personaId || state.defaultPersonaId;
  const circleOfPost = (pp) => pp.personaId
    || (pp.authorId !== 'player'
      ? (state.characters.find((c) => c.id === pp.authorId)?.knownPersonaId || state.defaultPersonaId)
      : null);
  const nameOf = (authorId, cPersonaId) => (authorId === 'player'
    ? (getPersona(cPersonaId)?.name || '玩家')
    : (state.characters.find((c) => c.id === authorId)?.name || '?'));
  const posts = (state.posts || [])
    .filter((pp) => { const cir = circleOfPost(pp); return !cir || cir === pid; })
    .slice(0, limit);
  if (!posts.length) return '(目前沒有動態)';
  return posts.map((p) => {
    const text = p.content.length > postChars ? `${p.content.slice(0, postChars)}…` : p.content;
    const cms = ((state.commentsByPostId || {})[p.id] || []).slice(-cmtCount).map((cm) => {
      const body = cm.content.length > cmtChars ? `${cm.content.slice(0, cmtChars)}…` : cm.content;
      const target = cm.replyTo?.name ? `(回覆 ${cm.replyTo.name})` : '';
      return `  ‣ ${nameOf(cm.authorId, cm.personaId)}${target}:${body}`;
    });
    return `- ${nameOf(p.authorId, p.personaId)}:${text}${p.image ? '(附圖)' : ''}${cms.length ? `\n${cms.join('\n')}` : ''}`;
  }).join('\n');
}

/**
 * 正文專用 prompt:全員說書人視角(開放世界引擎)。
 * 隱私規則同群聊：只含在場者的公開資料 + 共享/場景記憶 + 世界書，絕不含私密記憶。
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
        ? sharedPostText(m)
        : m.content,
      ...(m.image ? { image: m.image } : {}),
    }));

  const recentText = recentMessages.map((m) => m.content).join('\n');
  const seen = new Set(); const lore = [];
  for (const c of participants) {
    for (const e of matchEntries({ characterId: c.id, roomId, recentText, presentNames: participants.map((pp) => pp.name) })) {
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

  const promptEnS = state.apiConfig?.promptLang === 'en'; // v78:骨架語言(兩版語意必須同步)
  const choiceGuide = state.settings?.storyChoices
    ? (promptEnS
      ? 'After the narration, on new lines list 2-3 possible player actions, each line starting with "▷" (≤10 Chinese characters each); make them distinct — the player may also ignore them and type freely.'
      : '敘事結束後，另起新行以「▷」開頭列出 2~3 個玩家可採取的行動選項(每個一行,10 字內);選項要有差異，玩家也可以無視選項自行輸入。')
    : '';
  const styleGuide = (promptEnS
    ? 'Style: interactive fiction. You are the storyteller of this scene, advancing all present characters with novelistic prose: setting, action, interiority and dialogue interwoven. '
      + 'Dialogue inside 「」 quotes — never script format like "名字:台詞", never name prefixes. '
      + 'Walk-on NPCs (clerks, passersby, drivers) may enter naturally, but never speak for established characters who are not present.'
    : '風格：互動敘事，你是這個場景的說書人，以小說筆法同時推進所有在場角色：場景描述、動作、心理與對話交織。'
    + '對話用「」引號呈現，不要「名字：台詞」的劇本格式，不要名字前綴。'
    + '允許引入未事先定義的路人與臨時 NPC(店員、路人、司機等),自然登場即可；但不要替不在場的既有角色代言。')
    + (state.settings?.storyFormat?.trim() ? ` ${state.settings.storyFormat.trim()}` : ''); // 使用者 storyFormat=內容血肉,原樣附加不翻譯

  // 內建導演指令：英文寫(省 token、服從度佳),單/多人自動切換配方;
  // 使用者的 storyFormat 與作者備註排在其後，永遠優先。
  const directorCommon = 'Anchor the passage in one concrete sensory detail (touch, sound, scent): establish it early, return to it at the end.'
    + ' Never write lazy summary lines like 「他沉默了」or「一陣停頓」— render silence and pauses through concrete description.'
    + " Stay strictly in the player's POV; describe only what they can perceive."
    + ` Dialogue in natural Taiwanese Mandarin. Write roughly ${Math.round(maxReplyChars * 0.6)}–${maxReplyChars} Chinese characters per reply; unfold the scene patiently, do not rush the plot or wrap up early.`
    + ' Always write the story itself in Traditional Chinese (Taiwan).';
  const director = state.settings?.storyDirector !== false
    ? `【Scene Direction】${participants.length >= 2
      ? 'Before writing, silently assign each present character ONE distinct reaction mode for this beat (e.g. one reacts physically, one retorts, one deflects with humor) — never let two characters respond the same way to the same thing. '
      : 'Only one character is present: go deep, not wide. For each beat, render both the surface reaction AND what stays unspoken — what gestures leak, what the tone hides; the drama lives in that gap. Keep the camera close: micro-expressions, small movements, the charged space between the two of them. '
    }${directorCommon}`
    : '';

  const system = [
    ...globalPromptSection(roomId),
    `你是互動小說的說書人，負責「${room.title}」這個場景。`,
    ...(room.statusBar?.trim() ? [`【當前狀態(劇情時間/地點/狀態，以此為準)】${room.statusBar.trim()}`] : []),
    ...(room.relationshipStage?.trim() ? [`【目前與玩家的關係階段】${room.relationshipStage.trim()}(作為背景理解，不要逐字複述此欄內容)`] : []),
    `【在場角色(公開資料)】\n${profiles}`,
    `【玩家角色】${persona?.name || '(未命名玩家)'}:${persona?.description || '(未提供描述)'}`,
    ...relationshipSection(participants),
    `【共享記憶】\n${formatMemories(sharedMemories)}`,
    `【本場景記憶】\n${formatMemories(roomMemories)}`,
    `【世界書(依關鍵字觸發)】\n${loreText}`,
    ...(participants.every((c) => c.noPhone) ? [] : [`【最近的社群動態(公開；僅供了解角色近況，其發文時間與正文的劇情時間無關)】\n${recentFeedText(state, persona?.id)}`]),
    promptEnS
      ? `【Reply Rules】${styleGuide} ${choiceGuide} Target ${Math.round(maxReplyChars * 0.6)}~${maxReplyChars} Chinese characters this turn; advance in beats, weaving dialogue, action and interiority. Write ONLY in Traditional Chinese (Taiwan). Use 「」 for quoted speech.`
      : `【回覆指令】${styleGuide} ${choiceGuide} 本回合目標 ${Math.round(maxReplyChars * 0.6)}~${maxReplyChars} 字，分幕推進，含對話/動作/心理。`,
    ...(director ? [director] : []),
    ...(room.authorNote?.trim()
      ? [`【作者備註(當前對話的最高優先指令，凌駕以上所有設定)】${room.authorNote.trim()}`]
      : []),
  ].join('\n\n');

  return { system, messages: recentMessages, meta: { maxReplyChars, roomType: 'story', participantCount: participants.length } };
}

function formatMemories(list, { withRelativeTime = false } = {}) {
  if (!list.length) return '(無)';
  return list.map((m) => {
    const note = withRelativeTime ? (relativeTimeNote(m) || '') : '';
    return `- ${m.pinned ? '📌 ' : ''}${m.content}${note}`;
  }).join('\n');
}

/** 提案 C:今天命中的紀念日 → 醒目段落(程式算好餵給模型，模型不用會算數學)。 */
function anniversarySection(characterId, roomId) {
  const hits = anniversaryMemoryHits(characterId, roomId);
  if (!hits.length) return [];
  const lines = hits.map(({ memory, type, n }) => {
    const label = type === 'annual' ? '每年的今天' : type === 'yearly' ? `正好滿 ${n} 年` : `正好滿 ${n} 個月`;
    return `- 【今天距離這件事${label}】${memory.content}`;
  }).join('\n');
  return [`【今天是特別的日子】\n${lines}\n如果自然，可以提起或以行動表現；不必刻意宣告日期。`];
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
 * 因為以 participantIds 過濾，別的角色的 DM 永遠不會被撈進來。
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

/* ------------------------------------------------------------
 * 提案 J:正文/群聊心聲建構器。
 * 素材=該角色「本人知道的範圍」：他的私密記憶+圈子共享+該房可見素材+
 * 歷史裁切到該則訊息。正文用劇情時間(不注入相對時間);群聊用現實時間。
 * ------------------------------------------------------------ */
export function buildRoomInnerVoicePrompt({ character, roomId, messageId }) {
  const state = getState();
  const room = getRoom(roomId);
  if (!room || (room.type !== 'story' && room.type !== 'group')) return null;
  const isStory = room.type === 'story';
  const persona = personaForRoom(room);

  let srcMsgs = getRoomMessages(roomId) || [];
  const idx = srcMsgs.findIndex((mm) => mm.id === messageId);
  if (idx >= 0) srcMsgs = srcMsgs.slice(0, idx + 1);
  const recentMessages = budgetSlice(srcMsgs).slice().map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    speaker: m.role === 'narrator' ? '旁白' : (m.role === 'user' ? (persona?.name || '玩家') : (getCharacter(m.senderId)?.name || '')),
    content: m.content,
  }));

  const privates = state.memories.byCharacterId[character.id] || [];
  const shared = sharedMemoriesFor(character.knownPersonaId || state.defaultPersonaId);
  const roomMems = state.memories.byRoomId[roomId] || [];
  const rt = { withRelativeTime: !isStory };

  const system = [
    `你是「${character.name}」。`,
    `【角色描述】${character.description || '(未提供)'}`,
    `【個性】${character.personality || '(未提供)'}`,
    `【玩家】${persona?.name || '(未命名玩家)'}:${persona?.description || '(未提供描述)'}`,
    `【${character.name} 的私密記憶(只有你自己知道)】\n${formatMemories(privates, rt)}`,
    `【共享記憶】\n${formatMemories(shared, rt)}`,
    ...(roomMems.length ? [`【本${isStory ? '場景' : '聊天室'}記憶】\n${formatMemories(roomMems)}`] : []),
    ...(isStory && room.statusBar?.trim() ? [`【當前狀態(劇情時間/地點/狀態，以此為準)】${room.statusBar.trim()}`] : []),
    ...(room.relationshipStage?.trim() ? [`【目前與玩家的關係階段】${room.relationshipStage.trim()}(背景理解，不要複述)`] : []),
    `【任務】以下是${isStory ? '一段正文場景' : '一段群組聊天'}的紀錄(「旁白」是場景敘述)。請寫出紀錄最後那一刻，你(${character.name})心裡真正的想法——這一幕底下你沒說出口的部分(動作洩漏的、語氣藏著的、不敢講的)。第一人稱純內心獨白,100~200 字${isStory ? ',以劇情當下的時空為準，不要提及現實日期' : ''}。不要對任何人喊話、不要引號包裹、不要描述自己的動作、不要任何標記格式。輸出繁體中文。`,
  ].join('\n\n');

  return { system, messages: recentMessages, meta: { maxReplyChars: 300, roomType: room.type, mode: 'innerVoice' } };
}

/* ------------------------------------------------------------
 * 提案 K:偷看角色手機。素材=該角色 DM 視角同構+他的日記。
 * 三種快照:draft 未送出草稿 / search 搜尋紀錄 / playlist 最近播放。
 * ------------------------------------------------------------ */
export function buildPhonePeekPrompt({ character, peekType }) {
  const state = getState();
  const dmRoom = state.rooms.find((r) => r.type === 'dm' && !r.branchedFrom && r.participantIds.includes(character.id));
  const persona = dmRoom ? personaForRoom(dmRoom) : getPersona(state.defaultPersonaId);
  const privates = state.memories.byCharacterId[character.id] || [];
  const shared = sharedMemoriesFor(character.knownPersonaId || state.defaultPersonaId);
  const diaries = (state.diariesByCharacterId?.[character.id] || []).slice(0, 4)
    .map((d) => `- ${String(d.content || '').slice(0, 120)}`).join('\n');
  const recentMessages = dmRoom
    ? budgetSlice(getRoomMessages(dmRoom.id)).slice(-24).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      speaker: m.role === 'user' ? (persona?.name || '玩家') : character.name,
      content: m.content,
    }))
    : [];

  const TASKS = {
    draft: `【任務】想像你(${character.name})的手機訊息 App 裡，躺著幾則「打了又沒送出」的草稿。輸出 2~4 則：大多是想傳給${persona?.name || '玩家'}的，可以有一則是給你認識的其他人。每行一則，格式三欄：收件人||草稿內容||一句沒送出的原因(內心註記)。草稿的語氣必須符合你平常的訊息風格與目前的關係階段；沒送出的原因要誠實(遲疑、害羞、覺得太黏、時機不對……)。每一行三欄都必須齊全：不要輸出缺收件人或缺草稿內容的行,不要輸出只有內心註記的行。`,
    search: `【任務】輸出你(${character.name})手機瀏覽器「最近的搜尋紀錄」5~8 條，由最近到較早。每行一條搜尋關鍵字，像真人會打的那樣(可以口語、可以打錯重搜、可以好笑、可以洩露口是心非)。這些搜尋要反映你最近真正掛心的事。每行必須是「純搜尋關鍵字」：不要開場白、不要對任何人說話、不要括號動作或旁白描寫、不要任何說明句;不要複述你們對話裡說過的句子(搜尋紀錄不是訊息),也不要輸出「---」或任何分隔線。搜尋條目不要包含你自己的名字或自稱——沒有人會用自己的名字當每條搜尋的開頭。你認識的人也不會出現在你的搜尋裡：你不需要上網查你早就認識的人是誰。`,
    playlist: `【任務】輸出你(${character.name})音樂 App 的「最近播放」5~6 首。每行一首，格式：歌名 — 歌手。優先使用真實存在的歌曲與歌手(只列歌名與歌手，絕不要輸出任何歌詞)，選歌要符合你的品味與此刻心境；想不到合適的真歌時，可以混入虛構的，但要聽起來像真的存在。最後另起一行，以「循環理由：」開頭，寫一句你此刻反覆播放這些歌的原因。`,
  };

  const system = [
    `你是「${character.name}」。`,
    `【角色描述】${character.description || '(未提供)'}`,
    `【個性】${character.personality || '(未提供)'}`,
    `【玩家】${persona?.name || '(未命名玩家)'}:${persona?.description || '(未提供描述)'}`,
    `【${character.name} 的私密記憶(只有你自己知道)】\n${formatMemories(privates, { withRelativeTime: true })}`,
    `【共享記憶】\n${formatMemories(shared, { withRelativeTime: true })}`,
    ...ownRelationshipsSection(character),
    ...(diaries ? [`【你最近的日記(你的私密視角)】\n${diaries}`] : []),
    ...(dmRoom?.relationshipStage?.trim() ? [`【目前與玩家的關係階段】${dmRoom.relationshipStage.trim()}(背景理解，不要複述)`] : []),
    TASKS[peekType] || TASKS.search,
    '【格式】純文字，一行一項；不要編號、不要 markdown、不要引號包裹、不要任何說明或前後綴。輸出繁體中文。',
  ].join('\n\n');

  return { system, messages: recentMessages, meta: { maxReplyChars: 600, mode: 'phonePeek', peekType } };
}
