/**
 * modules/worldbook.js
 * 世界書(lorebook):多本書 × 多條目。
 * 條目有「觸發關鍵字」與「內容」;buildPrompt 時只把被觸發(或常駐)的條目塞進 prompt,
 * 沒被提到的設定不吃 token。書可設為全域，或只綁定特定角色。
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

export async function addEntry(bookId, { title, keywords, content, alwaysOn, priority, secondaryKeywords }) {
  const book = getWorldbook(bookId);
  if (!book) return null;
  const entry = {
    id: genId('wbe'),
    title: String(title || '').trim() || '(未命名條目)',
    keywords: Array.isArray(keywords) ? keywords : parseKeywords(keywords),
    secondaryKeywords: Array.isArray(secondaryKeywords) ? secondaryKeywords : parseKeywords(secondaryKeywords), // v61 selective:空=不設守門
    content: String(content || '').trim(),
    alwaysOn: !!alwaysOn,   // 常駐：不需關鍵字，永遠進 prompt
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 100,          // 權重：同時觸發搶位子時，數字大的先進(類似 ST 的 order)
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
  if (patch.secondaryKeywords !== undefined) {
    entry.secondaryKeywords = Array.isArray(patch.secondaryKeywords) ? patch.secondaryKeywords : parseKeywords(patch.secondaryKeywords);
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
 * - 條目需啟用；常駐條目直接進；其餘需關鍵字命中 recentText(不分大小寫)
 * - maxChars 控制總量，避免吃爆 token(常駐優先，再依關鍵字命中順序)
 */
export function matchEntries({ characterId, roomId = null, recentText, presentNames = [], maxChars = 2400 }) {
  const text = String(recentText || '').toLowerCase();
  // v61 selective:條目若填了次要關鍵字，主關鍵字命中後還需「任一次要關鍵字」
  // 出現在 recentText,或包含於 presentNames(該房在場角色的名字)之中，才算觸發。
  // 次要關鍵字留空=行為與舊版完全相同；常駐條目不受次要關鍵字限制。
  const present = (presentNames || []).map((n) => String(n || '').toLowerCase()).filter(Boolean);
  const secondaryOk = (e) => {
    const sec = (e.secondaryKeywords || []).map((k) => String(k || '').toLowerCase()).filter(Boolean);
    if (!sec.length) return true;
    return sec.some((k) => text.includes(k) || present.some((n) => n.includes(k)));
  };
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
      } else if ((e.keywords || []).some((k) => k && text.includes(String(k).toLowerCase())) && secondaryOk(e)) {
        hits.push({ ...e, bookName: book.name, rank: 1 });
      }
    }
  }
  // 常駐最優先；其餘依權重(大者先)、再依建立時間
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
 * 世界書匯出/匯入(不含任何機密；匯入一律建立新書，永不覆蓋)
 * ------------------------------------------------------------ */

function bookToExportShape(book) {
  return {
    name: book.name,
    enabled: book.enabled,
    scope: {
      global: !!book.scope?.global,
      // 角色/聊天室 id 在別台裝置沒有意義，匯出時不帶，匯入後重新綁定
    },
    entries: book.entries.map((e) => ({
      title: e.title,
      keywords: e.keywords || [],
      secondaryKeywords: e.secondaryKeywords || [],
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
 * - SillyTavern / Risu 世界書 JSON(entries 為物件表或陣列，含 key/keys/content/constant/order)
 * 回傳正規化 [{name, enabled, entries[]}];失敗丟人話錯誤，絕不動 state。
 */
export function parseWorldbookImport(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('不是有效的 JSON 檔');
  }

  // 本站格式(新:private-signal-worldbook + worldbooks[];舊:maliphone-lorebook + lorebook{})
  const isOwnFormat = parsed.format === 'private-signal-worldbook' || parsed.format === 'maliphone-lorebook';
  if (isOwnFormat && Array.isArray(parsed.worldbooks)) {
    const books = parsed.worldbooks.map((b) => ({
      name: b.name || '匯入的世界書',
      enabled: b.enabled !== false,
      entries: (b.entries || []).map(normalizeImportEntry).filter((e) => e.content),
    }));
    if (!books.length) throw new Error('備份檔裡沒有世界書');
    return books;
  }
  // 舊版單本格式:{ lorebook: { name, entries[] } }
  if (isOwnFormat && parsed.lorebook && Array.isArray(parsed.lorebook.entries)) {
    return [{
      name: parsed.lorebook.name || '匯入的世界書',
      enabled: parsed.lorebook.enabled !== false,
      entries: parsed.lorebook.entries.map(normalizeImportEntry).filter((e) => e.content),
    }];
  }

  // ST/Risu 傳統格式:{ entries: {0:{...},1:{...}} } 或 { entries: [...] }
  // v94.3 擴充:Risu 新版把條目包在各種殼裡——逐殼剝(擁有者實案:「之前可以現在不行」
  // =檔案來源換了新版格式,不是解析器退化,迴圈測試已自證)
  const candidates = [
    parsed.entries,
    parsed.data?.entries,                       // 卡片式包裝
    parsed.character_book?.entries,             // V2 card book 單獨存檔
    parsed.data?.character_book?.entries,
    parsed.lorebook?.entries ?? parsed.lorebook, // Risu lorebook 殼(entries 或直接陣列)
    parsed.data?.lorebook,                      // Risu 模組匯出
    Array.isArray(parsed.data) ? parsed.data : null, // data 直接是條目陣列
  ];
  for (const cand of candidates) {
    if (!cand) continue;
    const arr = Array.isArray(cand) ? cand : Object.values(cand);
    if (arr.length && arr.some((e) => e && typeof e === 'object')) {
      const entries = arr.map(normalizeImportEntry).filter((e) => e.content);
      if (entries.length) {
        return [{ name: parsed.name || parsed.data?.name || '匯入的世界書', enabled: true, entries }];
      }
    }
  }

  // 深度掃描保底:在物件樹裡(深度≤4)找「長得像條目陣列」的東西——
  // 過半元素是帶內容欄(content/text/entry)的物件即候選;確認視窗會顯示條目數讓玩家把關,
  // 且匯入永不覆蓋既有資料,誤判成本=一本可刪的新書。
  const found = deepFindEntries(parsed, 0);
  if (found) {
    const entries = found.map(normalizeImportEntry).filter((e) => e.content);
    if (entries.length) return [{ name: '匯入的世界書(自動辨識)', enabled: true, entries }];
  }

  // v94.3:錯誤訊息自報頂層鍵名——就算失敗,訊息本身就是診斷書,回報即可精準補格式
  const topKeys = Object.keys(parsed || {}).slice(0, 8).join(', ') || '(空物件)';
  throw new Error(`無法辨識的世界書格式(頂層鍵:${topKeys})——把這整句回報給開發 AI 即可精準支援`);
}

/** v94.3:深度掃描——樹裡找過半元素帶內容欄的物件陣列。 */
function deepFindEntries(node, depth) {
  if (depth > 4 || !node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    const objs = node.filter((e) => e && typeof e === 'object');
    if (objs.length >= Math.max(1, node.length / 2)
      && objs.some((e) => typeof (e.content ?? e.text ?? e.entry) === 'string')) return node;
    return null;
  }
  for (const v of Object.values(node)) {
    const hit = deepFindEntries(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function normalizeImportEntry(e, i) {
  // v94.3:key 欄補「字串型」(Risu 常以逗號分隔字串存 key),content 補 text/entry 變體
  const rawKeys = e.keywords ?? e.keys ?? e.key ?? [];
  const keys = Array.isArray(rawKeys) ? rawKeys
    : typeof rawKeys === 'string' ? rawKeys.split(/[,,]/) : [];
  const order = [e.priority, e.insertion_order, e.order]
    .find((v) => Number.isFinite(Number(v)));
  const secKeys = Array.isArray(e.secondaryKeywords) ? e.secondaryKeywords
    : Array.isArray(e.keysecondary) ? e.keysecondary
      : Array.isArray(e.secondary_keys) ? e.secondary_keys : [];
  return {
    title: e.title || e.comment || e.name || `條目 ${i + 1}`,
    keywords: keys.map((k) => String(k).trim()).filter(Boolean),
    secondaryKeywords: secKeys.map((k) => String(k).trim()).filter(Boolean),
    content: String(e.content ?? e.text ?? e.entry ?? '').trim(),
    alwaysOn: !!(e.alwaysOn ?? e.constant),
    priority: order !== undefined ? Number(order) : 100,
    enabled: e.enabled !== false && e.disable !== true,
  };
}

/** 執行匯入：每本都建立為新書(全域、預設啟用依檔案),回傳新書清單。 */
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
