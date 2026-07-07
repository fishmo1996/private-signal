/**
 * modules/phonepeek.js — 提案 K:偷看角色手機。
 * 三種快照:draft 未送出草稿 / search 搜尋紀錄 / playlist 最近播放。
 * 一次一呼叫、玩家手動觸發、走次要模型；快照存檔可回看,
 * 但【不變式】快照內容永不進入任何 prompt(同 innerVoice)。
 */

import { getState, genId, persist, getCharacter } from './state.js';
import { getApiConfig, generateReply, stripNamePrefix } from './api.js';
import { buildPhonePeekPrompt } from './prompt.js';

export const PEEK_TYPES = {
  draft: { label: '📝 未送出的草稿', hint: '他打了又刪、刪了又打的那些' },
  search: { label: '🔍 最近搜尋', hint: '瀏覽器不會說謊' },
  playlist: { label: '🎧 最近播放', hint: '歌單就是心情' },
};

const peekBusy = new Set();

/**
 * v61:搜尋快照的輸出端防線(鸚鵡防範通則:prompt 端講規則、輸出端做剝除)。
 * 丟棄不像「搜尋關鍵字」的行：括號開頭的旁白、冒號結尾的開場白、超長敘述句。
 * 全部被過濾時退回原文，寧可醜也不吞掉內容。
 */
export function sanitizeSearchSnapshot(text) {
  const lines = String(text || '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // v67:清掉模型手滑吐出的 HTML 標籤殘骸(</blockquote> 等)
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const kept = lines.filter((l) => {
    if (/^[((\[【「]/.test(l)) return false;        // 旁白/動作描寫開頭
    if (/[::]$/.test(l)) return false;              // 開場白(冒號結尾)
    if (/^[-—=~*·.。\s]+$/.test(l)) return false;    // 純符號行(拆條分隔線「---」的鸚鵡)
    if (/[,,。;;]/.test(l)) return false;           // 含逗號/句號=在講話,真人搜尋不打這些
    if (/妳/.test(l)) return false;                   // 第二人稱=對玩家說話,不是搜尋
    if (/[!?!?~]/.test(l) && l.length > 24) return false; // 帶語氣的長句
    if (l.length > 40) return false;                  // 真人搜尋詞不會這麼長
    if (/輸出|^請|快照|搜尋紀錄/.test(l)) return false; // v74:模型複述任務指令(「請輸出你的搜尋紀錄」echo)
    return true;
  });
  // v74:全部被攔=整包都是髒的,回空讓呼叫端報「重按一次」——舊 fallback 把髒原文
  // 原樣放行(「全髒=全放」),擁有者親眼看到「---」與指令複述兩條並排展出。
  return kept.join('\n');
}

/**
 * v68:草稿快照輕量清潔。草稿格式是「真心話||OS」用 || 分隔,不能套搜尋那套逐行過濾
 * (會誤刪),只針對草稿實際會出的兩種髒東西:HTML 標籤殘骸、以及被當成內容吐出來的
 * 「---」分隔線與純旁白行。
 */
export function sanitizeDraftSnapshot(text) {
  const lines = String(text || '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // HTML 標籤殘骸
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !/^-{2,}$/.test(l) && !/^[-—=~*·。\s]+$/.test(l)) // 丟純分隔線/純符號行
    .filter((l) => !/^\|\|/.test(l)); // v70:丟「||」開頭的行(缺收件人/本體、只剩內心註記的走鐘草稿)
  return lines.join('\n').trim();
}

function listOf(charId) {
  const state = getState();
  if (!state.phonePeeksByCharacterId) state.phonePeeksByCharacterId = {};
  if (!state.phonePeeksByCharacterId[charId]) state.phonePeeksByCharacterId[charId] = [];
  return state.phonePeeksByCharacterId[charId];
}

export function phonePeeksFor(charId) {
  return listOf(charId);
}

const MOCK = {
  draft: '其實今天在台上一直在找你的位置||太黏了，刪掉\n下次練團要不要來？我可以先跟他們說||講得好像我很期待一樣，算了',
  search: '練團完很累 正常嗎\n怎麼自然地約人\n附近 宵夜 兩個人\n心跳很快 是生病嗎',
  playlist: '半拍之後 — 霧燈樂隊\n慢速城市 — 陳無眠\n你家樓下 — 週末計畫\n循環理由：今天不太想聽吵的，想聽會想到某個人的。',
};

/** 生成一張快照。回傳 {ok, entry?} */
export async function generatePhonePeek(characterId, peekType) {
  const character = getCharacter(characterId);
  if (!character) return { ok: false, message: '找不到角色' };
  if (character.noPhone) return { ok: false, message: '他沒有手機可以偷看' };
  if (!PEEK_TYPES[peekType]) return { ok: false, message: '未知的快照類型' };
  const busyKey = `${characterId}:${peekType}`;
  if (peekBusy.has(busyKey)) return { ok: false, message: '生成中…' };
  peekBusy.add(busyKey);
  try {
    const cfg = getApiConfig();
    let content;
    if (cfg.useRealApi && cfg.apiKey && cfg.model) {
      const prompt = buildPhonePeekPrompt({ character, peekType });
      const r = await generateReply(cfg, prompt, { tier: 'secondary' });
      if (!r.ok) return { ok: false, message: r.message };
      content = stripNamePrefix(r.text, [character.name]).trim();
      if (peekType === 'search') content = sanitizeSearchSnapshot(content); // v61 輸出端防線
      if (peekType === 'draft') content = sanitizeDraftSnapshot(content); // v68:草稿去 --- 與 HTML
      if (!String(content || '').trim()) {
        return { ok: false, message: '這次生成的內容整包不合格式,已幫你攔下——再按一次「更新快照」通常就正常。' };
      }
      if (!content) return { ok: false, message: '這一則被模型服務暫時擋下了(常見於敏感詞誤判)。再按一次「更新快照」通常就正常——這不是你的問題。' };
    } else {
      content = MOCK[peekType];
    }
    const entry = { id: genId('peek'), type: peekType, content, createdAt: Date.now() };
    listOf(characterId).unshift(entry); // 新在前
    await persist();
    return { ok: true, entry };
  } finally {
    peekBusy.delete(busyKey);
  }
}
