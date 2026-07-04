/**
 * modules/worldbook.js
 * 世界書(lorebook):多本書 × 多條目。
 * 條目有「觸發關鍵字」與「內容」;buildPrompt 時只把被觸發(或常駐)的條目塞進 prompt,
 * 沒被提到的設定不吃 token。書可設為全域,或只綁定特定角色。
 */

import { getState, genId, persist } from './state.js';

export function getWorldbooks() {
  const state = getState();
  if (!state.worldbooks) state.worldbooks = [];
  return state.worldbooks;
}

export function getWorldbook(id) {
  return getWorldbooks().find((b) => b.id === id) || null;
}

export async function createWorldbook(name) {
  const book = {
    id: genId('wb'),
    name: String(name || '未命名世界書').trim() || '未命名世界書',
    enabled: true,
    scope: { global: true, characterIds: [] }, // global=true 對所有角色生效
    entries: [],
    createdAt: Date.now(),
  };
  getWorldbooks().push(book);
  await persist();
  return book;
}

export async function updateWorldbook(id, patch) {
  const book = getWorldbook(id);
  if (!book) return null;
  if (patch.name !== undefined) book.name = String(patch.name).trim() || book.name;
  if (patch.enabled !== undefined) book.enabled = !!patch.enabled;
  if (patch.scope !== undefined) {
    book.scope = {
      global: !!patch.scope.global,
      characterIds: Array.isArray(patch.scope.characterIds) ? patch.scope.characterIds : [],
    };
  }
  await persist();
  return book;
}

export async function deleteWorldbook(id) {
  const state = getState();
  const idx = getWorldbooks().findIndex((b) => b.id === id);
  if (idx !== -1) state.worldbooks.splice(idx, 1);
  if (state.currentWorldbookId === id) state.currentWorldbookId = null;
  await persist();
}

/** 解析「逗號/頓號/換行」分隔的關鍵字字串成陣列。 */
export function parseKeywords(text) {
  return String(text || '')
    .split(/[,,、\n]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export async function addEntry(bookId, { title, keywords, content, alwaysOn }) {
  const book = getWorldbook(bookId);
  if (!book) return null;
  const entry = {
    id: genId('wbe'),
    title: String(title || '').trim() || '(未命名條目)',
    keywords: Array.isArray(keywords) ? keywords : parseKeywords(keywords),
    content: String(content || '').trim(),
    alwaysOn: !!alwaysOn,   // 常駐:不需關鍵字,永遠進 prompt
    enabled: true,
    createdAt: Date.now(),
  };
  book.entries.push(entry);
  await persist();
  return entry;
}

export async function updateEntry(bookId, entryId, patch) {
  const book = getWorldbook(bookId);
  const entry = book?.entries.find((e) => e.id === entryId);
  if (!entry) return null;
  if (patch.title !== undefined) entry.title = String(patch.title).trim() || entry.title;
  if (patch.keywords !== undefined) {
    entry.keywords = Array.isArray(patch.keywords) ? patch.keywords : parseKeywords(patch.keywords);
  }
  if (patch.content !== undefined) entry.content = String(patch.content).trim();
  if (patch.alwaysOn !== undefined) entry.alwaysOn = !!patch.alwaysOn;
  if (patch.enabled !== undefined) entry.enabled = !!patch.enabled;
  await persist();
  return entry;
}

export async function deleteEntry(bookId, entryId) {
  const book = getWorldbook(bookId);
  if (!book) return;
  book.entries = book.entries.filter((e) => e.id !== entryId);
  await persist();
}

/**
 * 觸發判定(純函式,buildPrompt 使用):
 * 回傳應進入該角色 prompt 的條目清單。
 * - 只看「啟用中」且(全域 或 綁定了這個角色)的書
 * - 條目需啟用;常駐條目直接進;其餘需關鍵字命中 recentText(不分大小寫)
 * - maxChars 控制總量,避免吃爆 token(常駐優先,再依關鍵字命中順序)
 */
export function matchEntries({ characterId, recentText, maxChars = 2400 }) {
  const text = String(recentText || '').toLowerCase();
  const hits = [];
  for (const book of getWorldbooks()) {
    if (!book.enabled) continue;
    const inScope = book.scope?.global || (book.scope?.characterIds || []).includes(characterId);
    if (!inScope) continue;
    for (const e of book.entries) {
      if (!e.enabled || !e.content) continue;
      if (e.alwaysOn) {
        hits.push({ ...e, bookName: book.name, priority: 0 });
      } else if ((e.keywords || []).some((k) => k && text.includes(String(k).toLowerCase()))) {
        hits.push({ ...e, bookName: book.name, priority: 1 });
      }
    }
  }
  hits.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  const out = [];
  let used = 0;
  for (const h of hits) {
    const cost = h.content.length + h.title.length + 8;
    if (used + cost > maxChars) continue;
    used += cost;
    out.push(h);
  }
  return out;
}
