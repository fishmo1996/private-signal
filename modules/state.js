/**
 * modules/state.js
 * 全域狀態的建立、載入與保存。所有模組透過這裡取得同一份 state 物件。
 */

import { loadState, saveState, clearState, findLegacyState } from '../utils/indexeddb.js';

let state = null;
let config = null;

/** 產生短而不易碰撞的 id。 */
export function genId(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 依 config.json 建立初始 state(不建立任何預設角色)。 */
function createInitialState(cfg) {
  return {
    appVersion: 1,
    currentRoomId: null,
    currentCharacterId: null,
    currentView: 'dm',        // dm | group | story
    phoneView: 'home',        // 見 modules/navigation.js 的頁面一覽
    currentPostId: null,
    player: {
      playerName: (cfg.defaultPlayer && cfg.defaultPlayer.playerName) || '',
      playerDescription: (cfg.defaultPlayer && cfg.defaultPlayer.playerDescription) || '',
    },
    characters: [],
    rooms: [],
    messagesByRoom: {},
    worldbooks: [],           // 世界書(觸發式設定條目)
    currentWorldbookId: null,
    apiConfig: null,          // API/LLM 連線設定(見 modules/api.js;首次讀取時建立預設值)
    posts: [],                // 社群貼文(獨立於 messagesByRoom)
    commentsByPostId: {},     // 社群留言
    socialSeededCharIds: [],  // 已產生過初始貼文的角色
    memories: {
      shared: [],
      byCharacterId: {},
      byRoomId: {},
    },
    settings: {
      showLockScreen: false,  // 預設關閉：主畫面已內建大時鐘(可在設定開啟傳統鎖屏)
      resumeLastRoom: false,   // 重新開啟時回到上次聊天室(預設關閉：一律先進主畫面)
      ...(cfg.defaultSettings || {}),
    },
  };
}

/**
 * 舊資料補欄位(非破壞性 migration):
 * 只「新增」缺少的欄位與轉換頁面名稱,
 * 絕不重設或刪除 characters / player / rooms / messagesByRoom / memories / currentCharacterId。
 */
function migrate(s) {
  if (!s.memories) s.memories = { shared: [], byCharacterId: {}, byRoomId: {} };
  if (!s.memories.shared) s.memories.shared = [];
  if (!s.memories.byCharacterId) s.memories.byCharacterId = {};
  if (!s.memories.byRoomId) s.memories.byRoomId = {};
  if (!s.messagesByRoom) s.messagesByRoom = {};
  if (!s.rooms) s.rooms = [];
  if (!s.characters) s.characters = [];
  if (!s.player) s.player = { playerName: '', playerDescription: '' };
  if (!s.settings) s.settings = {};
  if (s.settings.showLockScreen === undefined) s.settings.showLockScreen = false;
  if (s.settings.resumeLastRoom === undefined) s.settings.resumeLastRoom = false;
  if (!s.settings.theme) s.settings.theme = 'dusk';        // dusk 暮霧深色 | sage 青霧淺綠
  if (s.settings.storyFormat === undefined) {
    s.settings.storyFormat = '玩家輸入中，括號()內為台詞，括號外為動作與敘述。你的輸出以第三人稱小說筆法呈現，角色對話用「」引號，不要模仿玩家的括號格式。';
  }
  if (s.settings.autoPostCooldownMin === undefined) s.settings.autoPostCooldownMin = 10;
  if (s.settings.globalPrompt === undefined) s.settings.globalPrompt = '';
  if (!s.settings.fontScale) s.settings.fontScale = 'normal';
  if (s.settings.showStatusCard === undefined) s.settings.showStatusCard = true;
  if (s.settings.chatFeel === undefined) s.settings.chatFeel = true;   // DM 聊天感:1~3 則短訊、口語、去旁白
  if (s.settings.moodEmoji === undefined) s.settings.moodEmoji = true; // DM 標題列的角色當下心情小表情
  if (s.settings.storyDirector === undefined) s.settings.storyDirector = true; // 內建正文導演指令(單/多人自動切換，英文省 token)
  if (s.settings.secondaryForSocialDiary === undefined) s.settings.secondaryForSocialDiary = false; // 社群發文/留言與日記走次要模型
  if (s.lastBackupAt === undefined) s.lastBackupAt = null; // 上次全域備份時間(黃燈提醒用)
  if (s.settings.lastSeenVersion === undefined) s.settings.lastSeenVersion = ''; // 更新彈窗(O-2)
  // 提案 L:settings.pet 由 pet.js petSettings() 懶初始化，不在此硬塞(避免預設台詞雙處維護)
  for (const ps of s.personas || []) {
    if (ps.label === undefined) ps.label = '';
  }
  for (const ch of s.characters || []) {
    if (ch.status === undefined) ch.status = null; // 提案 M:通訊軟體狀態 {text, at}
    if (ch.label === undefined) ch.label = ''; // v61:備註標籤(只顯示，絕不進任何 prompt;同 persona.label 規矩)
    if (ch.socialMute === undefined) ch.socialMute = false; // v65:不參與社群自動留言(常駐開關)
  }
  // v61:世界書條目補次要關鍵字(selective 觸發；空=行為與舊版完全相同)
  for (const wb of s.worldbooks || []) {
    for (const e of wb.entries || []) {
      if (!Array.isArray(e.secondaryKeywords)) e.secondaryKeywords = [];
    }
  }
  {
    // 提案 C:記憶補 eventDate(由 createdAt 導出;annualDate 選填不回填)
    const pad = (n) => String(n).padStart(2, '0');
    const keyOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const fill = (m) => { if (m && m.eventDate === undefined) m.eventDate = m.createdAt ? keyOf(m.createdAt) : ''; };
    (s.memories?.shared || []).forEach(fill);
    Object.values(s.memories?.byCharacterId || {}).forEach((l) => l.forEach(fill));
    Object.values(s.memories?.byRoomId || {}).forEach((l) => l.forEach(fill));
  }
  // 提案 I:關係階段欄(dm/story)
  for (const r of s.rooms || []) {
    if ((r.type === 'dm' || r.type === 'story') && r.relationshipStage === undefined) r.relationshipStage = '';
  }
  if (!s.settings.appIcons || typeof s.settings.appIcons !== 'object') s.settings.appIcons = {}; // {appId: dataURL} 自訂圖示包
  if (!Array.isArray(s.settings.quickReplies)) s.settings.quickReplies = ['繼續', '(描寫得更細一點)'];
  if (!Array.isArray(s.settings.outputRules)) s.settings.outputRules = [];
  if (!Array.isArray(s.settings.styleModules)) {
    // 首次建立時附兩個範例模組(預設關閉),當作範本
    s.settings.styleModules = [
      { id: `sm_${Date.now().toString(36)}a`, name: '漫才模式', enabled: false,
        content: '對話帶漫才式節奏：有人裝傻、有人吐槽，吐槽要快、狠、好笑；日常場景可以自然歪樓再拉回來。' },
      { id: `sm_${Date.now().toString(36)}b`, name: '戀愛張力', enabled: false,
        content: '增加曖昧與戀愛張力：多寫視線、距離、欲言又止的瞬間；推進要慢燒，情感變化要有鋪陳，不要突然告白。' },
    ];
  }
  if (s.socialLastRefresh === undefined) s.socialLastRefresh = 0;
  if (s.chatLastRefresh === undefined) s.chatLastRefresh = 0;
  for (const r of s.rooms || []) {
    if (!r.styleOverrides) r.styleOverrides = {};
    if (r.statusBar === undefined) r.statusBar = '';
    if (r.type === 'story' && !Array.isArray(r.archivedChapters)) r.archivedChapters = [];
    if (r.type === 'story' && r.chapterCount === undefined) r.chapterCount = 0;
  }
  if (s.settings.storyChoices === undefined) s.settings.storyChoices = true;
  if (s.diaryLastRefresh === undefined) s.diaryLastRefresh = 0;
  if (s.selfChatLastRefresh === undefined) s.selfChatLastRefresh = 0;
  if (!s.diariesByCharacterId) s.diariesByCharacterId = {};
  if (!s.phonePeeksByCharacterId) s.phonePeeksByCharacterId = {}; // 提案 K:偷看手機快照
  if (!Array.isArray(s.photos)) s.photos = [];
  if (s.settings.voiceTag === undefined) s.settings.voiceTag = true;      // 角色自己判斷何時傳語音訊息
  if (s.settings.ttsProvider === undefined) s.settings.ttsProvider = 'browser';
  for (const c of s.characters || []) {
    if (!c.voice || typeof c.voice !== 'object') c.voice = { voiceURI: '', rate: 1, pitch: 1 };
  }
  if (s.settings.bgImage === undefined) s.settings.bgImage = null;
  if (s.player && s.player.avatarImage === undefined) s.player.avatarImage = null;

  // 多人設：從舊的 player 資料建立預設人設(只做一次，非破壞性)
  if (!Array.isArray(s.personas)) s.personas = [];
  if (!s.personas.length) {
    s.personas.push({
      id: `psn_default_${Date.now().toString(36)}`,
      name: s.player?.playerName || '玩家',
      description: s.player?.playerDescription || '',
      avatarImage: s.player?.avatarImage || null,
      createdAt: Date.now(),
    });
  }
  if (!s.defaultPersonaId || !s.personas.some((p) => p.id === s.defaultPersonaId)) {
    s.defaultPersonaId = s.personas[0].id;
  }
  if (!s.activePersonaId || !s.personas.some((p) => p.id === s.activePersonaId)) {
    s.activePersonaId = s.defaultPersonaId;
  }
  for (const c of s.characters || []) {
    if (!c.knownPersonaId) c.knownPersonaId = s.defaultPersonaId;
    if (!Array.isArray(c.alternateGreetings)) c.alternateGreetings = [];
    if (!c.proactivity) c.proactivity = 'mid';
    if (c.noPhone === undefined) c.noPhone = false;
    if (c.emojiStyle === undefined) c.emojiStyle = '';
    if (!c.relationships || typeof c.relationships !== 'object') c.relationships = {};
  }
  for (const r of s.rooms || []) {
    if (!r.personaId) r.personaId = s.defaultPersonaId;
  }
  for (const post of s.posts || []) {
    if (post.authorId === 'player' && !post.personaId) post.personaId = s.defaultPersonaId;
  }
  for (const list of Object.values(s.commentsByPostId || {})) {
    for (const cm of list) {
      if (cm.authorId === 'player' && !cm.personaId) cm.personaId = s.defaultPersonaId;
    }
  }
  if (!s.posts) s.posts = [];
  if (!s.commentsByPostId) s.commentsByPostId = {};
  if (!s.socialSeededCharIds) s.socialSeededCharIds = [];
  if (s.currentPostId === undefined) s.currentPostId = null;
  if (!s.worldbooks) s.worldbooks = [];
  for (const wb of s.worldbooks || []) {
    if (wb.scope && !Array.isArray(wb.scope.roomIds)) wb.scope.roomIds = [];
    for (const e of wb.entries || []) {
      if (e.priority === undefined) e.priority = 100;
    }
  }
  if (s.currentWorldbookId === undefined) s.currentWorldbookId = null;
  if (s.apiConfig) {
    if (!s.apiConfig.maxReplyChars) s.apiConfig.maxReplyChars = { dm: 800, group: 1200, story: 4000 };
    if (!Array.isArray(s.apiConfig.presets)) s.apiConfig.presets = [null, null, null];
    if (s.apiConfig.contextBudget === undefined) s.apiConfig.contextBudget = 20000;
    if (s.apiConfig.useRealApi === undefined) s.apiConfig.useRealApi = false;
    if (s.apiConfig.temperature === undefined) s.apiConfig.temperature = 1.0;
    if (s.apiConfig.topP === undefined) s.apiConfig.topP = 0.95;
    if (s.apiConfig.thinkingBudget === undefined) s.apiConfig.thinkingBudget = '';
    if (s.apiConfig.safetyLevel === undefined) s.apiConfig.safetyLevel = 'default';
    if (!Array.isArray(s.apiConfig.modelList)) s.apiConfig.modelList = [];
  }
  if (!s.phoneView) s.phoneView = s.currentRoomId ? 'chat-room' : 'home';
  // 舊版頁面名稱 → 新版多層介面頁面
  const viewMap = {
    'list-dm': 'chat-friends',
    'list-group': 'chat-rooms',
    'list-story': 'story-list',
  };
  if (viewMap[s.phoneView]) s.phoneView = viewMap[s.phoneView];
  if (s.phoneView === 'room') {
    const room = (s.rooms || []).find((r) => r.id === s.currentRoomId);
    s.phoneView = room && room.type === 'story' ? 'story-room' : 'chat-room';
  }
  // 防禦：任何無法辨識的頁面值，一律安全退回主畫面(只改頁面指標，不動資料)
  const KNOWN_VIEWS = [
    'home', 'chat-friends', 'chat-rooms', 'chat-peek', 'chat-room', 'social-feed', 'social-post',
    'story-list', 'story-room', 'people', 'people-character', 'settings',
    'worldbook', 'worldbook-detail', 'character-diary', 'player', 'album', 'search',
  ];
  if (!KNOWN_VIEWS.includes(s.phoneView)) s.phoneView = 'home';
  return s;
}

/**
 * 初始化 state:優先讀取 IndexedDB;沒有資料時依 config 建立初始 state。
 * @param {object} loadedConfig data/config.json 的內容
 */
export async function initState(loadedConfig) {
  config = loadedConfig;

  // 讀取失敗(權限、損毀、私密模式限制等)時直接拋出,
  // 交給 app.js 顯示錯誤畫面——絕不在讀不到的情況下建立空 state 存檔,
  // 以免覆蓋掉其實還在的舊資料。
  const saved = await loadState();

  if (saved) {
    state = migrate(saved);
    return state;
  }

  // 目前資料庫確實沒有資料：先安全搜尋其他可能的舊資料庫名稱(唯讀，不動來源)。
  const legacy = await findLegacyState();
  if (legacy) {
    state = migrate(legacy.state);
    await persist(); // 複製一份到目前資料庫；來源資料庫原封不動
    return state;
  }

  // 真的完全沒有任何舊資料，才建立初始 state(同樣過一次 migrate,確保欄位齊全)。
  state = migrate(createInitialState(config));
  await persist();
  return state;
}

/** 取得目前的 state 物件(直接引用，修改後請呼叫 persist)。 */
export function getState() {
  return state;
}

/** 取得 config.json 內容。 */
export function getConfig() {
  return config;
}

/** 將目前 state 寫入 IndexedDB。 */
export async function persist() {
  await saveState(state);
}

/** 清除本機資料並回到初始狀態。 */
export async function resetAll() {
  await clearState();
  state = createInitialState(config);
  await persist();
  return state;
}

/* -------- 常用查詢 helpers -------- */

export function getCharacter(id) {
  return state.characters.find((c) => c.id === id) || null;
}

export function getRoom(id) {
  return state.rooms.find((r) => r.id === id) || null;
}

export function getRoomMessages(roomId) {
  if (!state.messagesByRoom[roomId]) state.messagesByRoom[roomId] = [];
  return state.messagesByRoom[roomId];
}

/** room 內的角色參與者(排除 "player")。 */
export function getRoomCharacters(room) {
  return room.participantIds
    .filter((pid) => pid !== 'player')
    .map((pid) => getCharacter(pid))
    .filter(Boolean);
}

/* ------------------------------------------------------------
 * 全域備份：匯出/匯入整份 state(含角色、對話、社群、記憶、世界書、設定)
 * ------------------------------------------------------------ */

export function exportStateJson() {
  // 深拷貝後移除機密:API 金鑰絕不進入備份檔(備份常被傳到雲端/通訊軟體)。
  // 不可動到執行中的 state。
  const copy = JSON.parse(JSON.stringify(state));
  if (copy.apiConfig) {
    copy.apiConfig.apiKey = '';
    if (Array.isArray(copy.apiConfig.presets)) {
      copy.apiConfig.presets = copy.apiConfig.presets.map(
        (p) => (p ? { ...p, apiKey: '' } : p),
      );
    }
  }
  return JSON.stringify(
    { exportedAt: Date.now(), app: 'private-signal', secretsExcluded: true, state: copy },
    null,
    2,
  );
}

/**
 * 從備份 JSON 匯入。驗證基本結構後覆蓋目前資料(呼叫端應先讓使用者確認)。
 * 回傳匯入後的 state;格式不對則丟出錯誤、不動任何資料。
 */
export async function importStateJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('不是有效的 JSON 檔');
  }
  const candidate = parsed.state && parsed.app === 'private-signal' ? parsed.state : parsed;
  if (!candidate || !Array.isArray(candidate.characters) || !Array.isArray(candidate.rooms)) {
    throw new Error('備份檔結構不符(缺少 characters / rooms)');
  }
  // 保留本機已輸入的 API 金鑰：備份不含機密，匯入不得清空目前裝置上的 key。
  const localKey = state?.apiConfig?.apiKey || '';
  const localPresetKeys = (state?.apiConfig?.presets || []).map((p) => p?.apiKey || '');

  state = migrate(candidate);

  if (state.apiConfig) {
    if (!state.apiConfig.apiKey && localKey) state.apiConfig.apiKey = localKey;
    if (Array.isArray(state.apiConfig.presets)) {
      state.apiConfig.presets = state.apiConfig.presets.map((p, i) => {
        if (p && !p.apiKey && localPresetKeys[i]) return { ...p, apiKey: localPresetKeys[i] };
        return p;
      });
    }
  }
  await persist();
  return state;
}
