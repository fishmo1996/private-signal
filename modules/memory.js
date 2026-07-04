/**
 * modules/memory.js
 * 記憶管理。第一版沒有真實 AI,不假裝做語意摘要:
 * 「記憶候選」以訊息原文截取產生,並讓使用者在儲存前手動編輯。
 */

import { getState, genId, persist, getRoom } from './state.js';
import { personaForRoom } from './persona.js';

const CANDIDATE_MAX_LEN = 80;

/**
 * 依訊息與所在 room 產生一個可編輯的記憶候選(尚未儲存)。
 * 可見範圍規則:
 * - DM   → 該角色的私密記憶(private)
 * - 群聊 → 共享記憶(shared)
 * - Story→ 場景記憶(room)
 */
export function createMemoryCandidate(message, roomId) {
  const room = getRoom(roomId);
  if (!room) return null;

  let visibility = 'shared';
  let characterId = null;
  if (room.type === 'dm') {
    visibility = 'private';
    characterId = room.participantIds.find((p) => p !== 'player') || null;
  } else if (room.type === 'story') {
    visibility = 'room';
  }

  const raw = message.content.trim().replace(/\s+/g, ' ');
  let content = raw.length > CANDIDATE_MAX_LEN ? raw.slice(0, CANDIDATE_MAX_LEN) + '…' : raw;

  // 共享記憶是全域的:玩家的發言標註人設名,讓不同圈子的角色知道那是「誰」說的
  if (visibility === 'shared' && message.role === 'user') {
    const persona = personaForRoom(room);
    if (persona?.name) content = `(${persona.name})${content}`;
  }

  return {
    content,          // 訊息原文截取;使用者可在儲存前編輯
    visibility,       // shared | private | room
    characterId,      // visibility 為 private 時使用
    sourceRoomId: roomId,
  };
}

/** 將(可能已被使用者編輯的)候選正式存入記憶。 */
export async function addMemory(candidate) {
  const state = getState();
  const memory = {
    id: genId('mem'),
    content: candidate.content.trim(),
    sourceRoomId: candidate.sourceRoomId || null,
    visibility: candidate.visibility,
    createdAt: Date.now(),
    pinned: !!candidate.pinned,
  };
  if (!memory.content) return null;

  if (candidate.visibility === 'private' && candidate.characterId) {
    if (!state.memories.byCharacterId[candidate.characterId]) {
      state.memories.byCharacterId[candidate.characterId] = [];
    }
    state.memories.byCharacterId[candidate.characterId].push(memory);
  } else if (candidate.visibility === 'room' && candidate.sourceRoomId) {
    if (!state.memories.byRoomId[candidate.sourceRoomId]) {
      state.memories.byRoomId[candidate.sourceRoomId] = [];
    }
    state.memories.byRoomId[candidate.sourceRoomId].push(memory);
  } else {
    memory.visibility = 'shared';
    state.memories.shared.push(memory);
  }
  await persist();
  return memory;
}

/** 找到記憶所在的 list 與 index。 */
function locateMemory(memoryId) {
  const state = getState();
  const pools = [];
  pools.push({ list: state.memories.shared });
  for (const cid of Object.keys(state.memories.byCharacterId)) {
    pools.push({ list: state.memories.byCharacterId[cid] });
  }
  for (const rid of Object.keys(state.memories.byRoomId)) {
    pools.push({ list: state.memories.byRoomId[rid] });
  }
  for (const pool of pools) {
    const idx = pool.list.findIndex((m) => m.id === memoryId);
    if (idx !== -1) return { list: pool.list, idx };
  }
  return null;
}

export async function editMemory(memoryId, newContent) {
  const loc = locateMemory(memoryId);
  if (!loc) return;
  loc.list[loc.idx].content = newContent.trim();
  await persist();
}

export async function togglePin(memoryId) {
  const loc = locateMemory(memoryId);
  if (!loc) return;
  loc.list[loc.idx].pinned = !loc.list[loc.idx].pinned;
  await persist();
}

export async function deleteMemory(memoryId) {
  const loc = locateMemory(memoryId);
  if (!loc) return;
  loc.list.splice(loc.idx, 1);
  await persist();
}

/** 群聊公開事件寫入共享記憶(由群聊流程呼叫)。 */
export async function addSharedMemoryFromGroup(content, roomId) {
  return addMemory({
    content,
    visibility: 'shared',
    sourceRoomId: roomId,
  });
}
