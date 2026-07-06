/**
 * modules/search.js
 * 全域搜尋：訊息 / 記憶 / 貼文 / 日記，全部本機比對，零 API 消耗。
 */

import { getState, getCharacter } from './state.js';
import { getPersona } from './persona.js';

function snippet(text, q, span = 18) {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text.slice(0, span * 2);
  const start = Math.max(0, idx - span);
  return `${start > 0 ? '…' : ''}${text.slice(start, idx + q.length + span)}${idx + q.length + span < text.length ? '…' : ''}`;
}

/**
 * @returns {{messages:[], memories:[], posts:[], diaries:[]}} 各類最多 limit 筆
 */
export function searchAll(query, limit = 12) {
  const q = String(query || '').trim().toLowerCase();
  const out = { messages: [], memories: [], posts: [], diaries: [] };
  if (q.length < 1) return out;
  const state = getState();

  for (const room of state.rooms) {
    const msgs = state.messagesByRoom[room.id] || [];
    for (const m of msgs) {
      if (out.messages.length >= limit) break;
      if ((m.content || '').toLowerCase().includes(q)) {
        const who = m.senderId === 'player' ? '你'
          : m.senderId === 'system' ? '系統'
            : (getCharacter(m.senderId)?.name || '旁白');
        out.messages.push({
          roomId: room.id, roomTitle: room.title, roomType: room.type,
          who, snippet: snippet(m.content, q), createdAt: m.createdAt,
        });
      }
    }
  }
  out.messages.sort((a, b) => b.createdAt - a.createdAt);

  const pushMem = (m, where) => {
    if (out.memories.length >= limit) return;
    if ((m.content || '').toLowerCase().includes(q)) {
      out.memories.push({ where, snippet: snippet(m.content, q), pinned: !!m.pinned });
    }
  };
  for (const m of state.memories.shared || []) pushMem(m, m.circleId ? '共享(圈子)' : '共享(全域)');
  for (const [cid, list] of Object.entries(state.memories.byCharacterId || {})) {
    for (const m of list) pushMem(m, `${getCharacter(cid)?.name || '?'} 的私密`);
  }
  for (const [rid, list] of Object.entries(state.memories.byRoomId || {})) {
    const r = state.rooms.find((x) => x.id === rid);
    for (const m of list) pushMem(m, `場景:${r?.title || '?'}`);
  }

  for (const p of state.posts || []) {
    if (out.posts.length >= limit) break;
    if ((p.content || '').toLowerCase().includes(q)) {
      const who = p.authorId === 'player' ? (getPersona(p.personaId)?.name || '你') : (getCharacter(p.authorId)?.name || '?');
      out.posts.push({ postId: p.id, who, snippet: snippet(p.content, q), createdAt: p.createdAt });
    }
  }

  for (const [cid, list] of Object.entries(state.diariesByCharacterId || {})) {
    for (const d of list) {
      if (out.diaries.length >= limit) break;
      if ((d.content || '').toLowerCase().includes(q)) {
        out.diaries.push({ characterId: cid, who: getCharacter(cid)?.name || '?', snippet: snippet(d.content, q), createdAt: d.createdAt });
      }
    }
  }
  return out;
}
