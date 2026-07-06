/**
 * modules/persona.js
 * 多人設(persona):你可以有多個「你」，每個角色認識其中一個。
 * - 每個角色有 knownPersonaId:他認識的那個你
 * - 每個對話(room)有 personaId:這個對話裡你是誰(建立時自動帶入，可手動換)
 * - 貼文/留言記錄 personaId:用哪個身分發的
 * - 「圈子」= 同一個 personaId:社群互動只由認識該人設的角色出面(方案一)
 */

import { getState, genId, persist } from './state.js';

export function getPersonas() {
  const state = getState();
  if (!state.personas) state.personas = [];
  return state.personas;
}

export function getPersona(id) {
  return getPersonas().find((p) => p.id === id) || null;
}

/** 預設人設(一定存在;migrate 會從舊的 player 資料建立)。 */
export function defaultPersona() {
  const state = getState();
  return getPersona(state.defaultPersonaId) || getPersonas()[0] || null;
}

/** 這個 room 目前的人設。 */
export function personaForRoom(room) {
  return (room && getPersona(room.personaId)) || defaultPersona();
}

/** 這篇貼文屬於哪個圈子(personaId)。玩家貼文=發文人設；角色貼文=作者認識的人設。 */
export function circleOfPost(post, getCharacter) {
  if (!post) return null;
  if (post.authorId === 'player') return post.personaId || getState().defaultPersonaId;
  const c = getCharacter(post.authorId);
  return c ? (c.knownPersonaId || getState().defaultPersonaId) : null;
}

/** 讓舊程式碼(state.player)看到的資料 = 預設人設的鏡像。 */
export function syncPlayerMirror() {
  const state = getState();
  const p = defaultPersona();
  if (!p) return;
  state.player = {
    playerName: p.name,
    playerDescription: p.description,
    avatarImage: p.avatarImage || null,
  };
}

export async function createPersona({ name, description = '', avatarImage = null, label = '' }) {
  const persona = {
    id: genId('psn'),
    name: String(name || '').trim() || '未命名人設',
    description: String(description || ''),
    avatarImage: avatarImage || null,
    createdAt: Date.now(),
  };
  getPersonas().push(persona);
  await persist();
  return persona;
}

export async function updatePersona(id, patch) {
  const p = getPersona(id);
  if (!p) return null;
  if (patch.name !== undefined) p.name = String(patch.name).trim() || p.name;
  if (patch.description !== undefined) p.description = String(patch.description);
  if (patch.label !== undefined) p.label = String(patch.label).trim();
  if (patch.avatarImage !== undefined) p.avatarImage = patch.avatarImage;
  syncPlayerMirror();
  await persist();
  return p;
}

/**
 * 刪除人設：最後一個不可刪;
 * 指到它的角色/對話/貼文/留言全部改指預設人設，不刪任何內容。
 */
export async function deletePersona(id) {
  const state = getState();
  const personas = getPersonas();
  if (personas.length <= 1) throw new Error('至少要保留一個人設');
  const idx = personas.findIndex((p) => p.id === id);
  if (idx === -1) return;
  personas.splice(idx, 1);
  if (state.defaultPersonaId === id) state.defaultPersonaId = personas[0].id;
  if (state.activePersonaId === id) state.activePersonaId = state.defaultPersonaId;
  const fb = state.defaultPersonaId;
  for (const c of state.characters) if (c.knownPersonaId === id) c.knownPersonaId = fb;
  for (const r of state.rooms) if (r.personaId === id) r.personaId = fb;
  for (const p of state.posts || []) if (p.personaId === id) p.personaId = fb;
  for (const list of Object.values(state.commentsByPostId || {})) {
    for (const cm of list) if (cm.personaId === id) cm.personaId = fb;
  }
  syncPlayerMirror();
  await persist();
}
