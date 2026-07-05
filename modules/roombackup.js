/**
 * modules/roombackup.js
 * 個別聊天室的備份與還原(單一故事線的可攜檔案)。
 *
 * 隱私隔離規則(鐵律):
 * - DM 匯出:只帶「這位角色」的私密記憶;其他角色的任何私密資料絕不進檔。
 * - 群聊/正文匯出:完全不帶任何私密記憶(群體空間本來就只有公開資訊)。
 * - 共享記憶一律不帶(屬於圈子/全域層級,走全域備份)。
 * - API 金鑰、其他聊天室的訊息,永不進檔。
 *
 * 匯入規則:一律「建立新聊天室副本」,永不覆蓋既有資料;
 * 參與角色依名字比對——群聊/正文可沿用同名角色,DM 若同名角色已存在
 * 則建立「名字(匯入)」的新角色以避免一角色多 DM 的歧義。
 * 驗證失敗以人話報錯,且不動任何 state。
 */

import {
  getState, genId, persist, getCharacter, getRoomMessages,
} from './state.js';
import { createCharacter, createGroup, createStory } from './rooms.js';

/** 角色的可攜快照(僅公開欄位;無 id、無人設綁定)。 */
function charSnapshot(c) {
  return {
    name: c.name,
    description: c.description || '',
    personality: c.personality || '',
    scenario: c.scenario || '',
    systemPrompt: c.systemPrompt || '',
    firstMessage: c.firstMessage || '',
    alternateGreetings: c.alternateGreetings || [],
    relationship: c.relationship || '',
    avatarEmoji: c.avatarEmoji || '',
    avatarImage: c.avatarImage || null,
    themeColor: c.themeColor || '#8ea7ff',
    proactivity: c.proactivity || 'mid',
    noPhone: !!c.noPhone,
    emojiStyle: c.emojiStyle || '',
  };
}

export function exportRoomJson(roomId) {
  const state = getState();
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room) throw new Error('找不到這個聊天室');
  const charIds = room.participantIds.filter((id) => id !== 'player');
  const chars = charIds.map((id) => getCharacter(id)).filter(Boolean);
  const idToName = new Map(chars.map((c) => [c.id, c.name]));

  // 訊息:senderId 轉為可攜的 senderName(匯入時依名字重新對映)
  const messages = getRoomMessages(roomId).map((m) => ({
    role: m.role,
    senderName: m.senderId === 'player' ? 'player'
      : m.senderId === 'system' ? 'system'
        : (idToName.get(m.senderId) || 'narrator'),
    content: m.content,
    ...(m.image ? { image: m.image } : {}),
    ...(m.sharedPost ? { sharedPost: m.sharedPost } : {}),
    ...(m.choices?.length ? { choices: m.choices } : {}),
    ...(m.editedAt ? { editedAt: m.editedAt } : {}),
    createdAt: m.createdAt,
  }));

  // 記憶:場景記憶一律帶;私密記憶只有 DM 且只帶「這位角色」的
  const roomMemories = (state.memories.byRoomId[roomId] || [])
    .map((m) => ({ content: m.content, pinned: !!m.pinned, createdAt: m.createdAt }));
  let privateMemories = [];
  if (room.type === 'dm' && chars[0]) {
    privateMemories = (state.memories.byCharacterId[chars[0].id] || [])
      .map((m) => ({ content: m.content, pinned: !!m.pinned, createdAt: m.createdAt }));
  }

  return JSON.stringify({
    format: 'private-signal-room',
    version: 1,
    exportedAt: Date.now(),
    secretsExcluded: true,
    room: {
      type: room.type,
      title: room.title,
      authorNote: room.authorNote || '',
      statusBar: room.statusBar || '',
      chapterCount: room.chapterCount || 0,
      archivedChapters: room.archivedChapters || [],
    },
    participants: chars.map(charSnapshot),
    messages,
    roomMemories,
    privateMemories,
  }, null, 2);
}

/** 解析並驗證,失敗丟人話錯誤;絕不動 state。 */
export function parseRoomImport(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('不是有效的 JSON 檔');
  }
  if (parsed.format !== 'private-signal-room') {
    throw new Error('這不是聊天室備份檔(format 不符);全域備份請走設定 → 資料');
  }
  if (!parsed.room?.type || !Array.isArray(parsed.participants) || !Array.isArray(parsed.messages)) {
    throw new Error('備份檔結構不完整(缺 room / participants / messages)');
  }
  if (!['dm', 'group', 'story', 'peek'].includes(parsed.room.type)) {
    throw new Error(`未知的聊天室型別:${parsed.room.type}`);
  }
  if (!parsed.participants.length || parsed.participants.some((p) => !p?.name)) {
    throw new Error('備份檔缺少參與角色資料');
  }
  return parsed;
}

/**
 * 匯入:建立新聊天室副本。回傳 { room, createdCharacters }。
 */
export async function importRoom(parsed) {
  const state = getState();
  const nameToId = new Map();
  const createdCharacters = [];

  // 角色:群聊/正文沿用同名;DM 同名時建「(匯入)」新角色避免一角多 DM
  for (const snap of parsed.participants) {
    const existing = state.characters.find((c) => c.name === snap.name);
    if (existing && parsed.room.type !== 'dm') {
      nameToId.set(snap.name, existing.id);
      continue;
    }
    const data = { ...snap };
    if (existing && parsed.room.type === 'dm') data.name = `${snap.name}(匯入)`;
    // eslint-disable-next-line no-await-in-loop
    const { character } = await createCharacter(data);
    nameToId.set(snap.name, character.id);
    createdCharacters.push(character);
  }
  const charIds = parsed.participants.map((p) => nameToId.get(p.name));

  // 房間:DM 用剛建立角色的 DM;群聊/正文建新房
  let room;
  if (parsed.room.type === 'dm') {
    room = state.rooms.find((r) => r.type === 'dm' && r.participantIds.includes(charIds[0]));
  } else if (parsed.room.type === 'peek') {
    const { createPeek } = await import('./rooms.js');
    room = charIds.length >= 2
      ? await createPeek(`${parsed.room.title}(匯入)`, charIds)
      : await createStory(`${parsed.room.title}(匯入)`, charIds);
  } else if (parsed.room.type === 'group') {
    room = charIds.length >= 2
      ? await createGroup(`${parsed.room.title}(匯入)`, charIds)
      : await createStory(`${parsed.room.title}(匯入)`, charIds); // 單人群聊備份退化為場景
  } else {
    room = await createStory(`${parsed.room.title}(匯入)`, charIds);
  }
  if (!room) throw new Error('聊天室建立失敗');
  if (parsed.room.authorNote) room.authorNote = parsed.room.authorNote;
  if (parsed.room.statusBar) room.statusBar = parsed.room.statusBar;
  if (parsed.room.chapterCount) room.chapterCount = parsed.room.chapterCount;
  if (Array.isArray(parsed.room.archivedChapters) && parsed.room.archivedChapters.length) {
    room.archivedChapters = parsed.room.archivedChapters;
  }

  // 訊息:整批覆蓋新房(DM 會蓋掉自動插入的開場白,忠實還原備份)
  state.messagesByRoom[room.id] = parsed.messages.map((m) => ({
    id: genId('msg'),
    role: m.role || 'user',
    senderId: m.senderName === 'player' ? 'player'
      : m.senderName === 'system' ? 'system'
        : (nameToId.get(m.senderName) || 'system'),
    content: m.content || '',
    ...(m.image ? { image: m.image } : {}),
    ...(m.sharedPost ? { sharedPost: m.sharedPost } : {}),
    ...(Array.isArray(m.choices) && m.choices.length ? { choices: m.choices } : {}),
    ...(m.editedAt ? { editedAt: m.editedAt } : {}),
    createdAt: m.createdAt || Date.now(),
  }));
  if (parsed.room.type === 'dm') room.initialized = true;

  // 記憶
  if (Array.isArray(parsed.roomMemories) && parsed.roomMemories.length) {
    state.memories.byRoomId[room.id] = parsed.roomMemories.map((m) => ({
      id: genId('mem'),
      content: m.content,
      visibility: 'room',
      pinned: !!m.pinned,
      sourceRoomId: room.id,
      createdAt: m.createdAt || Date.now(),
    }));
  }
  if (parsed.room.type === 'dm' && Array.isArray(parsed.privateMemories) && parsed.privateMemories.length) {
    const cid = charIds[0];
    if (!state.memories.byCharacterId[cid]) state.memories.byCharacterId[cid] = [];
    for (const m of parsed.privateMemories) {
      state.memories.byCharacterId[cid].push({
        id: genId('mem'),
        content: m.content,
        visibility: 'private',
        characterId: cid,
        pinned: !!m.pinned,
        sourceRoomId: room.id,
        createdAt: m.createdAt || Date.now(),
      });
    }
  }

  await persist();
  return { room, createdCharacters };
}
