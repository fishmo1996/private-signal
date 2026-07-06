/**
 * modules/charcard.js
 * 角色卡匯入/匯出。
 * 匯出：本站完整角色包 JSON、通用 Character Card V2 JSON。
 * 匯入：本站包、Character Card V2/V3 JSON、以及 PNG 角色卡
 *      (SillyTavern / RisuAI 匯出的圖卡,JSON 藏在 PNG 的 tEXt chunk)。
 * 安全：匯出絕不含 API 金鑰、聊天紀錄、私密記憶；匯入驗證失敗不動任何資料。
 */

import { getState } from './state.js';
import { createCharacter } from './rooms.js';
import { createWorldbook, addEntry, updateWorldbook } from './worldbook.js';

/* ------------------------------------------------------------
 * 匯出
 * ------------------------------------------------------------ */

/** 這個角色綁定的(非全域)世界書，一併打包。 */
function boundBooksOf(characterId) {
  return (getState().worldbooks || []).filter(
    (b) => !b.scope?.global && (b.scope?.characterIds || []).includes(characterId),
  );
}

/** 本站完整角色包：含頭像/主題色/主動程度/綁定世界書。不含聊天、記憶、金鑰、人設 id。 */
export function exportCharacterPack(character) {
  return JSON.stringify({
    format: 'private-signal-character',
    version: 1,
    exportedAt: Date.now(),
    secretsExcluded: true,
    character: {
      name: character.name,
      description: character.description || '',
      personality: character.personality || '',
      scenario: character.scenario || '',
      systemPrompt: character.systemPrompt || '',
      firstMessage: character.firstMessage || '',
      alternateGreetings: character.alternateGreetings || [],
      relationship: character.relationship || '',
      avatarEmoji: character.avatarEmoji || '',
      avatarImage: character.avatarImage || null,
      themeColor: character.themeColor || '#8ea7ff',
      proactivity: character.proactivity || 'mid',
      emojiStyle: character.emojiStyle || '',
    },
    worldbooks: boundBooksOf(character.id).map((b) => ({
      name: b.name,
      enabled: b.enabled,
      entries: b.entries.map((e) => ({
        title: e.title, keywords: e.keywords, content: e.content,
        alwaysOn: e.alwaysOn, priority: e.priority ?? 100, enabled: e.enabled,
      })),
    })),
  }, null, 2);
}

/** 通用 Character Card V2 JSON(自有欄位放 extensions.privateSignal)。 */
export function exportCharacterCardV2(character) {
  const books = boundBooksOf(character.id);
  const characterBook = books.length
    ? {
      name: books[0].name,
      entries: books.flatMap((b) => b.entries).map((e, i) => ({
        keys: e.keywords || [],
        content: e.content,
        enabled: e.enabled !== false,
        insertion_order: e.priority ?? 100,
        constant: !!e.alwaysOn,
        name: e.title || `entry-${i}`,
      })),
    }
    : undefined;

  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name,
      description: character.description || '',
      personality: character.personality || '',
      scenario: character.scenario || '',
      first_mes: character.firstMessage || '',
      mes_example: '',
      system_prompt: character.systemPrompt || '',
      post_history_instructions: '',
      alternate_greetings: character.alternateGreetings || [],
      tags: [],
      creator: '',
      creator_notes: '',
      character_version: '1',
      ...(characterBook ? { character_book: characterBook } : {}),
      extensions: {
        privateSignal: {
          themeColor: character.themeColor || '#8ea7ff',
          proactivity: character.proactivity || 'mid',
          emojiStyle: character.emojiStyle || '',
          avatarEmoji: character.avatarEmoji || '',
          relationship: character.relationship || '',
          ...(character.avatarImage ? { avatarImage: character.avatarImage } : {}),
        },
      },
    },
  }, null, 2);
}

/* ------------------------------------------------------------
 * PNG tEXt chunk 解析(純前端，無套件)
 * ------------------------------------------------------------ */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

export function isZip(bytes) {
  return bytes.length > 4 && ZIP_MAGIC.every((v, i) => bytes[i] === v);
}

/**
 * 極簡 ZIP 讀取器(僅支援 stored 與 deflate,足夠 .charx 使用)。
 * 走 Central Directory 取得正確的壓縮方式與位移，回傳 {檔名: Uint8Array}。
 */
export async function readZipEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 從檔尾找 EOCD(End of Central Directory,簽名 0x06054b50)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('ZIP 結構損毀(找不到目錄)');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true); // central directory 起點
  const out = {};
  for (let n = 0; n < count; n += 1) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOffset = dv.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    // 讀 local header 算資料起點
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      out[name] = raw;
    } else if (method === 8) {
      // eslint-disable-next-line no-await-in-loop
      out[name] = await inflateRaw(raw);
    } // 其他壓縮法略過
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(raw) {
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Node 測試環境退路
  const { inflateRawSync } = await import('node:zlib');
  return new Uint8Array(inflateRawSync(raw));
}

export function isPng(bytes) {
  return bytes.length > 8 && PNG_MAGIC.every((v, i) => bytes[i] === v);
}

/** 讀出 PNG 內所有 tEXt chunk → { keyword: text }。 */
export function parsePngTextChunks(bytes) {
  const out = {};
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const dataStart = pos + 8;
    if (len < 0 || dataStart + len > bytes.length) break;
    if (type === 'tEXt') {
      const data = bytes.subarray(dataStart, dataStart + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = String.fromCharCode(...data.subarray(0, nul));
        let text = '';
        const body = data.subarray(nul + 1);
        // 大檔避免展開運算子爆堆疊
        for (let i = 0; i < body.length; i += 8192) {
          text += String.fromCharCode(...body.subarray(i, i + 8192));
        }
        out[keyword] = text;
      }
    }
    if (type === 'IEND') break;
    pos = dataStart + len + 4; // 跳過 CRC
  }
  return out;
}

function b64ToUtf8(b64) {
  // atob 只給 latin1,需再走 UTF-8 解碼(卡片內容常含中文)
  const bin = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/* ------------------------------------------------------------
 * 匯入：格式偵測與正規化
 * ------------------------------------------------------------ */

/**
 * 解析匯入檔(bytes: Uint8Array,可為 JSON 或 PNG 卡)。
 * 回傳正規化結果 {name, description, personality, scenario, firstMessage,
 *   systemPrompt, avatarImage, avatarEmoji, themeColor, proactivity,
 *   relationship, worldbooks:[{name, entries[]}], sourceFormat}
 * 解析失敗丟出人話錯誤；絕不修改任何 state。
 */
export async function parseCharacterImport(bytes, { pngDataUrl = null } = {}) {
  let jsonText;
  let avatarFromPng = null;

  if (isZip(bytes)) {
    // Risu V3 .charx:zip 內含 card.json,素材放 assets/
    let entries;
    try {
      entries = await readZipEntries(bytes);
    } catch {
      throw new Error('無法解開這個 .charx 檔(ZIP 結構異常)');
    }
    const cardName = Object.keys(entries).find((k) => k.toLowerCase().endsWith('card.json'));
    if (!cardName) throw new Error('.charx 裡找不到 card.json');
    jsonText = new TextDecoder('utf-8').decode(entries[cardName]);
    // 找主頭像素材(第一個 png/jpg/webp)
    const imgName = Object.keys(entries).find((k) => /\.(png|jpe?g|webp)$/i.test(k));
    if (imgName) {
      const ext = imgName.split('.').pop().toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      let b64 = '';
      const data = entries[imgName];
      for (let i = 0; i < data.length; i += 8192) {
        b64 += String.fromCharCode(...data.subarray(i, i + 8192));
      }
      const toB64 = (typeof btoa === 'function') ? btoa : ((x) => Buffer.from(x, 'binary').toString('base64'));
      avatarFromPng = `data:${mime};base64,${toB64(b64)}`;
    }
  } else if (isPng(bytes)) {
    const chunks = parsePngTextChunks(bytes);
    const raw = chunks.ccv3 || chunks.chara;
    if (!raw) throw new Error('這張 PNG 裡沒有角色卡資料(找不到 chara/ccv3 區塊)');
    try {
      jsonText = b64ToUtf8(raw);
    } catch {
      throw new Error('PNG 內的角色卡資料無法解碼');
    }
    avatarFromPng = pngDataUrl; // 圖卡本身就是頭像
  } else {
    jsonText = new TextDecoder('utf-8').decode(bytes);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('不是有效的 JSON 或 PNG 角色卡');
  }

  // 本站完整包
  if (parsed.format === 'private-signal-character' && parsed.character) {
    const c = parsed.character;
    if (!c.name) throw new Error('角色包缺少名稱');
    return {
      sourceFormat: '本站完整角色包',
      name: c.name,
      description: c.description || '',
      personality: c.personality || '',
      scenario: c.scenario || '',
      firstMessage: c.firstMessage || '',
      alternateGreetings: Array.isArray(c.alternateGreetings) ? c.alternateGreetings : [],
      systemPrompt: c.systemPrompt || '',
      relationship: c.relationship || '',
      avatarEmoji: c.avatarEmoji || '',
      avatarImage: c.avatarImage || avatarFromPng || null,
      themeColor: c.themeColor || '#8ea7ff',
      proactivity: c.proactivity || 'mid',
      emojiStyle: c.emojiStyle || '',
      worldbooks: (parsed.worldbooks || []).map(normalizeBook).filter(Boolean),
    };
  }

  // Character Card V2 / V3(spec 欄位)或 data 包裹
  const d = parsed.data && (parsed.spec || parsed.data.name) ? parsed.data : parsed;
  if (!d || !d.name) throw new Error('無法辨識的角色卡格式(缺少 name)');
  const ext = d.extensions?.privateSignal || {};
  const spec = parsed.spec === 'chara_card_v3' ? 'Character Card V3' : parsed.spec === 'chara_card_v2' ? 'Character Card V2' : '通用角色卡(V1 相容)';

  const books = [];
  if (d.character_book?.entries?.length) {
    books.push({
      name: d.character_book.name || `${d.name} 的世界書`,
      entries: d.character_book.entries.map((e, i) => ({
        title: e.name || e.comment || `條目 ${i + 1}`,
        keywords: Array.isArray(e.keys) ? e.keys : (Array.isArray(e.key) ? e.key : []),
        content: e.content || '',
        alwaysOn: !!e.constant,
        priority: Number.isFinite(Number(e.insertion_order)) ? Number(e.insertion_order) : 100,
        enabled: e.enabled !== false,
      })).filter((e) => e.content),
    });
  }

  return {
    sourceFormat: spec,
    name: d.name,
    description: d.description || '',
    personality: d.personality || '',
    scenario: d.scenario || '',
    firstMessage: d.first_mes || '',
    alternateGreetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.filter(Boolean) : [],
    systemPrompt: d.system_prompt || '',
    relationship: ext.relationship || '',
    avatarEmoji: ext.avatarEmoji || '',
    avatarImage: ext.avatarImage || avatarFromPng || null,
    themeColor: ext.themeColor || '#8ea7ff',
    proactivity: ext.proactivity || 'mid',
    emojiStyle: ext.emojiStyle || '',
    worldbooks: books,
  };
}

function normalizeBook(b) {
  if (!b || !Array.isArray(b.entries)) return null;
  return {
    name: b.name || '匯入的世界書',
    entries: b.entries.map((e, i) => ({
      title: e.title || `條目 ${i + 1}`,
      keywords: Array.isArray(e.keywords) ? e.keywords : [],
      content: e.content || '',
      alwaysOn: !!e.alwaysOn,
      priority: Number.isFinite(Number(e.priority)) ? Number(e.priority) : 100,
      enabled: e.enabled !== false,
    })).filter((e) => e.content),
  };
}

/**
 * 執行匯入：一律「建立新角色」(附新 DM),永不覆蓋既有角色。
 * 附帶的世界書建立為新書並綁定到新角色。
 */
export async function importCharacter(normalized) {
  const { character, dmRoom } = await createCharacter({
    name: normalized.name,
    description: normalized.description,
    personality: normalized.personality,
    scenario: normalized.scenario,
    systemPrompt: normalized.systemPrompt,
    firstMessage: normalized.firstMessage,
    alternateGreetings: normalized.alternateGreetings || [],
    relationship: normalized.relationship,
    avatarEmoji: normalized.avatarEmoji,
    avatarImage: normalized.avatarImage,
    themeColor: normalized.themeColor,
    proactivity: normalized.proactivity,
    emojiStyle: normalized.emojiStyle || '',
  });
  for (const b of normalized.worldbooks || []) {
    const book = await createWorldbook(b.name);
    await updateWorldbook(book.id, { scope: { global: false, characterIds: [character.id], roomIds: [] } });
    for (const e of b.entries) {
      // eslint-disable-next-line no-await-in-loop
      await addEntry(book.id, e);
    }
  }
  return { character, dmRoom };
}
