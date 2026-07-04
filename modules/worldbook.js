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
    scope: { global: true, characterIds: [], roomIds: [] }, // 全域 / 綁角色 / 綁聊天室
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
      roomIds: Array.isArray(patch.scope.roomIds) ? patch.scope.roomIds : [],
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

export async function addEntry(bookId, { title, keywords, content, alwaysOn, priority }) {
  const book = getWorldbook(bookId);
  if (!book) return null;
  const entry = {
    id: genId('wbe'),
    title: String(title || '').trim() || '(未命名條目)',
    keywords: Array.isArray(keywords) ? keywords : parseKeywords(keywords),
    content: String(content || '').trim(),
    alwaysOn: !!alwaysOn,   // 常駐:不需關鍵字,永遠進 prompt
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 100,          // 權重:同時觸發搶位子時,數字大的先進(類似 ST 的 order)
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
  if (patch.priority !== undefined) entry.priority = Number.isFinite(Number(patch.priority)) ? Number(patch.priority) : entry.priority;
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
export function matchEntries({ characterId, roomId = null, recentText, maxChars = 2400 }) {
  const text = String(recentText || '').toLowerCase();
  const hits = [];
  for (const book of getWorldbooks()) {
    if (!book.enabled) continue;
    const inScope = book.scope?.global
      || (book.scope?.characterIds || []).includes(characterId)
      || (roomId && (book.scope?.roomIds || []).includes(roomId));
    if (!inScope) continue;
    for (const e of book.entries) {
      if (!e.enabled || !e.content) continue;
      if (e.alwaysOn) {
        hits.push({ ...e, bookName: book.name, rank: 0 });
      } else if ((e.keywords || []).some((k) => k && text.includes(String(k).toLowerCase()))) {
        hits.push({ ...e, bookName: book.name, rank: 1 });
      }
    }
  }
  // 常駐最優先;其餘依權重(大者先)、再依建立時間
  hits.sort((a, b) => a.rank - b.rank || (b.priority ?? 100) - (a.priority ?? 100) || a.createdAt - b.createdAt);
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

/* ------------------------------------------------------------
 * 世界書匯出/匯入(不含任何機密;匯入一律建立新書,永不覆蓋)
 * ------------------------------------------------------------ */

function bookToExportShape(book) {
  return {
    name: book.name,
    enabled: book.enabled,
    scope: {
      global: !!book.scope?.global,
      // 角色/聊天室 id 在別台裝置沒有意義,匯出時不帶,匯入後重新綁定
    },
    entries: book.entries.map((e) => ({
      title: e.title,
      keywords: e.keywords || [],
      content: e.content,
      alwaysOn: !!e.alwaysOn,
      priority: e.priority ?? 100,
      enabled: e.enabled !== false,
    })),
    createdAt: book.createdAt,
  };
}

/** 匯出單本世界書 JSON。 */
export function exportWorldbookJson(bookId) {
  const book = getWorldbook(bookId);
  if (!book) throw new Error('找不到這本世界書');
  return JSON.stringify({
    format: 'private-signal-worldbook',
    version: 1,
    exportedAt: Date.now(),
    secretsExcluded: true,
    worldbooks: [bookToExportShape(book)],
  }, null, 2);
}

/** 匯出全部世界書 JSON。 */
export function exportAllWorldbooksJson() {
  return JSON.stringify({
    format: 'private-signal-worldbook',
    version: 1,
    exportedAt: Date.now(),
    secretsExcluded: true,
    worldbooks: getWorldbooks().map(bookToExportShape),
  }, null, 2);
}

/**
 * 解析世界書匯入檔。支援:
 * - 本站格式(format: private-signal-worldbook,單本或多本)
 * - SillyTavern / Risu 世界書 JSON(entries 為物件表或陣列,含 key/keys/content/constant/order)
 * 回傳正規化 [{name, enabled, entries[]}];失敗丟人話錯誤,絕不動 state。
 */
export function parseWorldbookImport(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('不是有效的 JSON 檔');
  }

  // 本站格式
  if (parsed.format === 'private-signal-worldbook' && Array.isArray(parsed.worldbooks)) {
    const books = parsed.worldbooks.map((b) => ({
      name: b.name || '匯入的世界書',
      enabled: b.enabled !== false,
      entries: (b.entries || []).map(normalizeImportEntry).filter((e) => e.content),
    }));
    if (!books.length) throw new Error('備份檔裡沒有世界書');
    return books;
  }

  // ST/Risu 格式:{ entries: {0:{...},1:{...}} } 或 { entries: [...] }
  const rawEntries = parsed.entries
    ? (Array.isArray(parsed.entries) ? parsed.entries : Object.values(parsed.entries))
    : null;
  if (rawEntries && rawEntries.length) {
    return [{
      name: parsed.name || '匯入的世界書',
      enabled: true,
      entries: rawEntries.map(normalizeImportEntry).filter((e) => e.content),
    }];
  }

  throw new Error('無法辨識的世界書格式(找不到 entries)');
}

function normalizeImportEntry(e, i) {
  const keys = Array.isArray(e.keywords) ? e.keywords
    : Array.isArray(e.keys) ? e.keys
      : Array.isArray(e.key) ? e.key : [];
  const order = [e.priority, e.insertion_order, e.order]
    .find((v) => Number.isFinite(Number(v)));
  return {
    title: e.title || e.comment || e.name || `條目 ${i + 1}`,
    keywords: keys.map((k) => String(k).trim()).filter(Boolean),
    content: String(e.content || '').trim(),
    alwaysOn: !!(e.alwaysOn ?? e.constant),
    priority: order !== undefined ? Number(order) : 100,
    enabled: e.enabled !== false && e.disable !== true,
  };
}

/** 執行匯入:每本都建立為新書(全域、預設啟用依檔案),回傳新書清單。 */
export async function importWorldbooks(normalizedBooks) {
  const created = [];
  for (const b of normalizedBooks) {
    // eslint-disable-next-line no-await-in-loop
    const book = await createWorldbook(b.name);
    book.enabled = b.enabled;
    for (const e of b.entries) {
      // eslint-disable-next-line no-await-in-loop
      await addEntry(book.id, e);
    }
    created.push(book);
  }
  await persist();
  return created;
}
