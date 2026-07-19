/**
 * modules/memory.js
 * 記憶管理。第一版沒有真實 AI,不假裝做語意摘要:
 * 「記憶候選」以訊息原文截取產生，並讓使用者在儲存前手動編輯。
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

  // 共享記憶預設綁「當前對話的圈子」；玩家發言標註人設名
  let circleId = null;
  if (visibility === 'shared') {
    const persona = personaForRoom(room);
    circleId = persona?.id || null;
    if (message.role === 'user' && persona?.name) content = `(${persona.name})${content}`;
  }

  return {
    content,          // 訊息原文截取；使用者可在儲存前編輯
    visibility,       // shared | private | room
    characterId,      // visibility 為 private 時使用
    circleId,         // shared 時：綁定的圈子(personaId);null = 全域
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
    ...(candidate.visibility === 'shared' ? { circleId: candidate.circleId || null } : {}),
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

export async function editMemory(memoryId, newContent, patch = {}) {
  const loc = locateMemory(memoryId);
  if (!loc) return;
  const m = loc.list[loc.idx];
  m.content = newContent.trim();
  if (patch.eventDate !== undefined) m.eventDate = String(patch.eventDate || '').trim();
  if (patch.annualDate !== undefined) {
    const ad = String(patch.annualDate || '').trim();
    m.annualDate = /^\d{2}-\d{2}$/.test(ad) ? ad : '';
  }
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

/** 群聊公開事件寫入共享記憶(由群聊流程呼叫)。v85(k2):預設綁本房圈子,不再寫全域。 */
export async function addSharedMemoryFromGroup(content, roomId) {
  const room = getRoom(roomId);
  return addMemory({
    content,
    visibility: 'shared',
    circleId: (room && personaForRoom(room)?.id) || null,
    sourceRoomId: roomId,
  });
}

/** 這個角色(依其圈子)看得到的共享記憶。circleId=null 的為全域。 */
export function sharedMemoriesFor(circleId) {
  const state = getState();
  return (state.memories.shared || []).filter((m) => !m.circleId || m.circleId === circleId);
}

/* ------------------------------------------------------------
 * 對話摘要：把「上次摘要點之後」的訊息濃縮成記憶候選(手動觸發)
 * ------------------------------------------------------------ */

/** 上次摘要點之後的新訊息(最多 60 則)。 */
export function messagesSinceSummary(roomId) {
  const room = getRoom(roomId);
  const state = getState();
  const cursor = room?.summarizedUpTo || 0;
  return (state.messagesByRoom[roomId] || [])
    .filter((m) => m.createdAt > cursor && m.role !== 'system')
    .slice(-60);
}

export function buildSummaryPrompt(roomId) {
  const room = getRoom(roomId);
  const state = getState();
  const msgs = messagesSinceSummary(roomId);
  const persona = personaForRoom(room);
  const lines = msgs.map((m) => {
    const who = m.role === 'user' ? (persona?.name || '玩家')
      : m.role === 'narrator' ? '(敘事)'
        : (state.characters.find((c) => c.id === m.senderId)?.name || '角色');
    return `${who}:${m.content}`;
  }).join('\n');

  const system = [
    '你是記憶整理助手。把以下對話濃縮成 3~6 條「值得長期記住」的記憶條目。',
    '每條 15~50 字、繁體中文、第三人稱、只記事實與約定(誰、做了什麼、約好什麼、關係變化),不要心情形容詞堆砌。',
    '只輸出 JSON 字串陣列，例如 ["兩人打賭游泳，輸的請飲料","子勳的生日是門鎖密碼"],不要其他文字。',
  ].join('\n');

  return {
    system,
    messages: [{ role: 'user', content: `對話紀錄:\n${lines}` }],
    meta: { maxReplyChars: 800, roomType: 'summary' },
  };
}

/**
 * 產生摘要候選。真實 AI:單次呼叫;mock:抽最長的幾則截取。
 * 只回傳候選，不寫入任何記憶(由使用者勾選後存)。
 */
export async function generateSummaryCandidates(roomId) {
  const msgs = messagesSinceSummary(roomId);
  if (msgs.length < 4) return { ok: false, message: '新訊息太少(不足 4 則),先聊一點再摘要吧' };
  const { getApiConfig, generateReply } = await import('./api.js');
  const cfg = getApiConfig();
  if (!(cfg.useRealApi && cfg.apiKey && cfg.model)) {
    const items = [...msgs].sort((a, b) => (b.content || '').length - (a.content || '').length)
      .slice(0, 4)
      .map((m) => m.content.replace(/\s+/g, ' ').slice(0, 50));
    return { ok: true, items };
  }
  const r = await generateReply(cfg, buildSummaryPrompt(roomId), { tier: 'secondary' });
  if (!r.ok) return { ok: false, message: r.message };
  let raw = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const st = raw.indexOf('['); const en = raw.lastIndexOf(']');
  if (st !== -1 && en > st) raw = raw.slice(st, en + 1);
  let items;
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed.map((x) => String(x).trim()).filter(Boolean) : null;
  } catch { items = null; }
  if (!items) {
    items = r.text.split('\n').map((l) => l.replace(/^[-•\d.、\s]+/, '').trim()).filter((l) => l.length > 4).slice(0, 6);
  }
  return items.length ? { ok: true, items } : { ok: false, message: '模型沒有產出可用的條目，再試一次' };
}

/** 存入勾選的摘要條目後，推進摘要進度點(下次只摘新增部分)。 */
export async function commitSummary(roomId, savedCount) {
  const room = getRoom(roomId);
  const msgs = messagesSinceSummary(roomId);
  if (room && msgs.length) room.summarizedUpTo = msgs[msgs.length - 1].createdAt;
  await persist();
  return savedCount;
}

/* ------------------------------------------------------------
 * 正文章節封存：摘要整章 → 存進場景記憶 → 清空對話重新開始。
 * 舊章完整訊息存進 room.archivedChapters,可回翻、隨備份攜帶。
 * ------------------------------------------------------------ */

export async function archiveChapter(roomId, { title = '' } = {}) {
  const state = getState();
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room || room.type !== 'story') return { ok: false, message: '只有正文場景可以封存章節' };
  const msgs = state.messagesByRoom[roomId] || [];
  if (msgs.length < 4) return { ok: false, message: '本章還太短(不足 4 則),再跑一段吧' };

  // 1) 摘要(真實 API 或 mock 都走既有摘要管線)
  const r = await generateSummaryCandidates(roomId);
  if (!r.ok) return r;
  const n = (room.chapterCount || 0) + 1;
  const chapterTitle = String(title || '').trim() || `第 ${n} 章`;
  const summaryBody = r.items.map((it) => `- ${typeof it === 'string' ? it : it.content}`).join('\n');

  // 2) 摘要存成場景記憶(下一章的說書人會記得前情)
  if (!state.memories.byRoomId[roomId]) state.memories.byRoomId[roomId] = [];
  state.memories.byRoomId[roomId].push({
    id: genId('mem'),
    content: `【${chapterTitle}|前情】\n${summaryBody}`,
    visibility: 'room',
    pinned: false,
    sourceRoomId: roomId,
    createdAt: Date.now(),
  });

  // 3) 整章原文封存，清空當前對話
  if (!Array.isArray(room.archivedChapters)) room.archivedChapters = [];
  room.archivedChapters.push({
    n,
    title: chapterTitle,
    messages: msgs,
    archivedAt: Date.now(),
  });
  room.chapterCount = n;
  state.messagesByRoom[roomId] = [];
  room.summarizedUpTo = 0;

  await persist();
  return { ok: true, n, title: chapterTitle, summaryCount: r.items.length };
}

/* ------------------------------------------------------------
 * 提案 C:紀念日自動感知(全本地日期運算，零額外 API)。
 * eventDate 預設由 createdAt 導出;annualDate 為生日類年年觸發。
 * ------------------------------------------------------------ */

/** Date → 'YYYY-MM-DD'(本地時區)。 */
export function dateKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 相對時間附註:'(約 N 天前 / N 個月前 / N 年前)';不足 1 天回 null。 */
export function relativeTimeNote(memory, now = Date.now()) {
  const base = memory.eventDate
    ? new Date(`${memory.eventDate}T12:00:00`).getTime()
    : memory.createdAt;
  if (!base) return null;
  const days = Math.floor((now - base) / 86400000);
  if (days < 1) return null;
  if (days < 60) return `(約 ${days} 天前)`;
  if (days < 365) return `(約 ${Math.floor(days / 30)} 個月前)`;
  return `(約 ${Math.floor(days / 365)} 年前,${Math.floor((days % 365) / 30)} 個月)`;
}

/**
 * 紀念日偵測：回傳 null 或 { type:'monthly'|'yearly'|'annual', n }。
 * monthly=事件日同「日」且至少滿 1 個月;yearly=同月同日且至少滿 1 年(yearly 優先於 monthly);
 * annual=annualDate(MM-DD)命中今天,n=0(年年觸發，不算年數)。
 */
export function anniversaryInfo(memory, now = Date.now()) {
  const today = new Date(now);
  if (memory.annualDate) {
    const key = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (memory.annualDate === key) return { type: 'annual', n: 0 };
  }
  const evStr = memory.eventDate || (memory.createdAt ? dateKeyOf(memory.createdAt) : null);
  if (!evStr) return null;
  const [ey, em, ed] = evStr.split('-').map(Number);
  const sameDay = today.getDate() === ed;
  if (!sameDay) return null;
  const monthsDiff = (today.getFullYear() - ey) * 12 + (today.getMonth() + 1 - em);
  if (monthsDiff <= 0) return null;
  if (today.getMonth() + 1 === em) return { type: 'yearly', n: today.getFullYear() - ey };
  return { type: 'monthly', n: monthsDiff };
}

/** 一位角色「今天」命中的紀念日記憶(私密+其圈子共享+指定房的場景記憶)。 */
export function anniversaryMemoryHits(characterId, roomId = null, now = Date.now()) {
  const state = getState();
  const c = getCharacterById(characterId);
  const pools = [
    ...(state.memories.byCharacterId[characterId] || []),
    ...sharedMemoriesFor(c?.knownPersonaId || state.defaultPersonaId),
    ...(roomId ? (state.memories.byRoomId[roomId] || []) : []),
  ];
  const hits = [];
  for (const m of pools) {
    const info = anniversaryInfo(m, now);
    if (info) hits.push({ memory: m, ...info });
  }
  return hits.slice(0, 2); // 一天最多兩個，避免轟炸
}

function getCharacterById(id) {
  return (getState().characters || []).find((x) => x.id === id) || null;
}
