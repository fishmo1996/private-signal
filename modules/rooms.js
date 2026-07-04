/**
 * modules/rooms.js
 * 角色與聊天室(DM / 群聊 / Story)的建立、刪除與初始化規則。
 */

import {
  getState, genId, persist, getCharacter, getRoom, getRoomMessages, getRoomCharacters,
} from './state.js';

/* ---------------- 角色 ---------------- */

/**
 * 建立角色,並自動建立對應 DM room。
 * @returns {{character:object, dmRoom:object}}
 */
export async function createCharacter(data) {
  const state = getState();
  const now = Date.now();
  const character = {
    id: genId('char'),
    name: (data.name || '未命名角色').trim(),
    description: data.description || '',
    personality: data.personality || '',
    scenario: data.scenario || '',
    systemPrompt: data.systemPrompt || '',
    firstMessage: data.firstMessage || '',
    alternateGreetings: Array.isArray(data.alternateGreetings) ? data.alternateGreetings.filter(Boolean) : [],
    avatarEmoji: data.avatarEmoji || '',
    avatarImage: data.avatarImage || null,   // 壓縮後的 dataURL 頭像
    knownPersonaId: data.knownPersonaId || state.defaultPersonaId || null, // 他認識的那個「你」
    proactivity: data.proactivity || 'mid', // 主動程度:off 不主動 | low | mid | high
    noPhone: !!data.noPhone,               // 非現代世界角色:不發社群/不主動傳訊/不看動態
    emojiStyle: data.emojiStyle || '',     // emoji 習慣(自由文字,如「只用🐟,像個大叔」)
    relationships: data.relationships || {}, // 與其他角色的關係:{對方id: 描述}(群聊/正文雙方在場時注入)
    themeColor: data.themeColor || '#8ea7ff',
    createdAt: now,
  };
  state.characters.push(character);

  const dmRoom = {
    id: genId('room'),
    type: 'dm',
    title: character.name,
    personaId: character.knownPersonaId || state.defaultPersonaId || null,
    participantIds: ['player', character.id],
    createdAt: now,
    initialized: false,
  };
  state.rooms.push(dmRoom);
  state.messagesByRoom[dmRoom.id] = [];

  await persist();
  return { character, dmRoom };
}

/** 更新角色資料;DM room 標題同步更新。 */
export async function updateCharacter(id, patch) {
  const state = getState();
  const c = getCharacter(id);
  if (!c) return null;
  Object.assign(c, patch);
  const dm = findDmRoom(id);
  if (dm) dm.title = c.name;
  await persist();
  return c;
}

/**
 * 刪除角色,並妥善清理相關資料:
 * - 刪除其 DM room 與訊息
 * - 從群聊/Story 參與者移除;群聊剩不到 2 名角色、Story 剩 0 名角色時整間刪除
 * - 刪除該角色的私密記憶
 */
export async function deleteCharacter(id) {
  const state = getState();
  const idx = state.characters.findIndex((c) => c.id === id);
  if (idx === -1) return;
  state.characters.splice(idx, 1);

  const roomsToDelete = [];
  for (const room of state.rooms) {
    if (room.type === 'dm' && room.participantIds.includes(id)) {
      roomsToDelete.push(room.id);
      continue;
    }
    if (room.participantIds.includes(id)) {
      room.participantIds = room.participantIds.filter((p) => p !== id);
      const remaining = room.participantIds.filter((p) => p !== 'player').length;
      if (room.type === 'group' && remaining < 2) roomsToDelete.push(room.id);
      if (room.type === 'story' && remaining < 1) roomsToDelete.push(room.id);
    }
  }
  for (const roomId of roomsToDelete) deleteRoomInternal(roomId);

  delete state.memories.byCharacterId[id];

  // 清理社群:該角色的貼文(連同留言)、留言與 seed 記錄
  if (Array.isArray(state.posts)) {
    const removedPostIds = state.posts.filter((p) => p.authorId === id).map((p) => p.id);
    state.posts = state.posts.filter((p) => p.authorId !== id);
    for (const pid of removedPostIds) {
      if (state.commentsByPostId) delete state.commentsByPostId[pid];
      if (state.currentPostId === pid) state.currentPostId = null;
    }
  }
  if (state.commentsByPostId) {
    for (const pid of Object.keys(state.commentsByPostId)) {
      state.commentsByPostId[pid] = state.commentsByPostId[pid].filter((c) => c.authorId !== id);
    }
  }
  if (Array.isArray(state.socialSeededCharIds)) {
    state.socialSeededCharIds = state.socialSeededCharIds.filter((cid) => cid !== id);
  }

  if (state.currentCharacterId === id) state.currentCharacterId = null;
  if (state.currentRoomId && !getRoom(state.currentRoomId)) {
    state.currentRoomId = null;
    state.phoneView = 'home';
  }
  await persist();
}

function deleteRoomInternal(roomId) {
  const state = getState();
  const i = state.rooms.findIndex((r) => r.id === roomId);
  if (i !== -1) state.rooms.splice(i, 1);
  delete state.messagesByRoom[roomId];
  delete state.memories.byRoomId[roomId];
  if (state.currentRoomId === roomId) {
    state.currentRoomId = null;
    state.phoneView = 'home';
  }
}

/** 手動刪除一間群聊或 Story(DM 隨角色存在,不單獨刪)。 */
export async function deleteRoom(roomId) {
  const room = getRoom(roomId);
  if (!room || room.type === 'dm') return;
  deleteRoomInternal(roomId);
  await persist();
}

/* ---------------- Room 查詢與建立 ---------------- */

export function findDmRoom(characterId) {
  const state = getState();
  return state.rooms.find(
    (r) => r.type === 'dm' && r.participantIds.includes(characterId),
  ) || null;
}

/** 建立群聊;至少需要 2 個角色。 */
export async function createGroup(title, characterIds) {
  const state = getState();
  if (!Array.isArray(characterIds) || characterIds.length < 2) {
    throw new Error('群聊至少需要兩個角色。');
  }
  const room = {
    id: genId('room'),
    type: 'group',
    title: (title || '未命名群組').trim(),
    personaId: getCharacter(characterIds[0])?.knownPersonaId || state.defaultPersonaId || null,
    participantIds: ['player', ...characterIds],
    createdAt: Date.now(),
    initialized: false,
  };
  state.rooms.push(room);
  state.messagesByRoom[room.id] = [];
  await persist();
  return room;
}

/** 建立 Story 場景;至少需要 1 個角色。 */
export async function createStory(title, characterIds) {
  const state = getState();
  if (!Array.isArray(characterIds) || characterIds.length < 1) {
    throw new Error('場景至少需要一個角色。');
  }
  const room = {
    id: genId('room'),
    type: 'story',
    title: (title || '未命名場景').trim(),
    personaId: getCharacter(characterIds[0])?.knownPersonaId || state.defaultPersonaId || null,
    participantIds: ['player', ...characterIds],
    createdAt: Date.now(),
    initialized: false,
  };
  state.rooms.push(room);
  state.messagesByRoom[room.id] = [];
  await persist();
  return room;
}

/* ---------------- 首次開啟的初始化規則 ---------------- */

/**
 * 進入 room 時呼叫。嚴格遵守只插入一次的規則:
 * - DM:messagesByRoom 不存在或長度為 0 時,插入該角色 firstMessage(role: character),之後絕不重複。
 * - Story:未初始化且沒有訊息時,依參與角色的 scenario 建立一則開場敘事,只建立一次。
 * - Group:未初始化時插入一句原創的簡短系統歡迎語。
 */
export async function ensureRoomInitialized(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const msgs = getRoomMessages(roomId);
  let changed = false;

  if (room.type === 'dm') {
    if (msgs.length === 0) {
      const character = getRoomCharacters(room)[0];
      // 多開場白:firstMessage + alternateGreetings 隨機挑一
      const greetings = [character?.firstMessage, ...(character?.alternateGreetings || [])]
        .map((g) => String(g || '').trim()).filter(Boolean);
      if (character && greetings.length) {
        msgs.push({
          id: genId('msg'),
          role: 'character',
          senderId: character.id,
          content: greetings[Math.floor(Math.random() * greetings.length)],
          createdAt: Date.now(),
        });
        changed = true;
      }
      room.initialized = true;
      changed = true;
    } else if (!room.initialized) {
      room.initialized = true;
      changed = true;
    }
  } else if (room.type === 'story') {
    if (!room.initialized && msgs.length === 0) {
      const chars = getRoomCharacters(room);
      msgs.push({
        id: genId('msg'),
        role: 'narrator',
        senderId: 'system',
        content: buildStoryOpening(room, chars),
        createdAt: Date.now(),
      });
      room.initialized = true;
      changed = true;
    } else if (!room.initialized) {
      room.initialized = true;
      changed = true;
    }
  } else if (room.type === 'group') {
    if (!room.initialized) {
      if (msgs.length === 0) {
        const names = getRoomCharacters(room).map((c) => c.name).join('、');
        msgs.push({
          id: genId('msg'),
          role: 'system',
          senderId: 'system',
          content: `「${room.title}」建立了。這裡有 ${names}。說點什麼吧。`,
          createdAt: Date.now(),
        });
      }
      room.initialized = true;
      changed = true;
    }
  }

  if (changed) await persist();
}

/** 依參與角色 scenario 組出 Story 開場敘事(只在初始化時使用一次)。 */
function buildStoryOpening(room, chars) {
  const state = getState();
  const playerName = state.player.playerName || '你';
  const pieces = chars
    .map((c) => {
      const s = (c.scenario || '').trim();
      const frag = s ? firstClause(s, 40) : `${c.name}正在等待這個場景開始`;
      return `${c.name}——${frag}`;
    })
    .join(';');
  return `〔${room.title}〕\n燈光還沒完全亮起。${pieces}。\n${playerName}站在場景的邊緣,下一句話會決定這裡如何開始。`;
}

function firstClause(text, max) {
  const cut = text.split(/[。!?!?\n]/)[0] || text;
  return cut.length > max ? cut.slice(0, max) + '…' : cut;
}

/* ---------------- 切換 room / view ---------------- */

export async function openRoom(roomId) {
  const r = getRoom(roomId);
  if (r && r.unread) r.unread = false;
  const state = getState();
  const room = getRoom(roomId);
  if (!room) return;
  state.currentRoomId = roomId;
  state.currentView = room.type;
  state.phoneView = room.type === 'story' ? 'story-room' : 'chat-room';
  if (room.type === 'dm') {
    const c = getRoomCharacters(room)[0];
    state.currentCharacterId = c ? c.id : null;
  }
  await ensureRoomInitialized(roomId);
  await persist();
}

export async function goPhoneView(view) {
  const state = getState();
  state.phoneView = view;
  if (view !== 'chat-room' && view !== 'story-room') state.currentRoomId = null;
  await persist();
}

/* ------------------------------------------------------------
 * 場景/群聊成員中途加入與移出
 * ------------------------------------------------------------ */

export async function addRoomMember(roomId, characterId) {
  const room = getRoom(roomId);
  const c = getCharacter(characterId);
  if (!room || !c || room.type === 'dm') return null;
  if (!room.participantIds.includes(characterId)) room.participantIds.push(characterId);
  await persist();
  return room;
}

export async function removeRoomMember(roomId, characterId) {
  const room = getRoom(roomId);
  if (!room || room.type === 'dm') return null;
  const chars = room.participantIds.filter((id) => id !== 'player');
  if (chars.length <= 1) throw new Error('至少要留一位角色在場');
  room.participantIds = room.participantIds.filter((id) => id !== characterId);
  await persist();
  return room;
}
