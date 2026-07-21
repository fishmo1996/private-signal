/**
 * modules/phonepeek.js — 提案 K:偷看角色手機。
 * 三種快照:draft 未送出草稿 / search 搜尋紀錄 / playlist 最近播放。
 * 一次一呼叫、玩家手動觸發、走次要模型；快照存檔可回看,
 * 但【不變式】快照內容永不進入任何 prompt(同 innerVoice)。
 */

import { getState, genId, persist, getCharacter } from './state.js';
import { recordPeek } from './quality.js';
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
    .split('\n').map((l) => l.trim()).filter(Boolean)
    // v76:UI 動詞前綴剝除(擁有者截圖「送出如何讓女朋友停止撒嬌」)——剝前綴留關鍵字,不丟整行。
    // 「送出」開頭的真實搜尋幾乎不存在,無冒號也剝;「傳送/輸入/搜尋/查詢」則可能是內容本身
    // (「傳送門」「搜尋不到朋友的IG」),必須帶冒號(明確是標籤)才剝,避免誤傷。
    .map((l) => l.replace(/^送出[::]?\s*/, '').replace(/^(?:傳送|輸入|搜尋|查詢)[::]\s*/, '').trim())
    .filter(Boolean);
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
  // v76:下限閘門——任務要 5~8 條,清潔後剩不到 3 條=那次生成幾乎全髒,殘渣通常就是
  // 漏網對話句(擁有者截圖:整包只剩一條「準備好迎接我了嗎?」)。整包失格回空,
  // 呼叫端報「攔下請重按」;寧可空手也不端殘菜(v74 教訓的延伸)。
  if (kept.length < 3) return '';
  return kept.join('\n');
}

/**
 * v68:草稿快照輕量清潔。草稿格式是「真心話||OS」用 || 分隔,不能套搜尋那套逐行過濾
 * (會誤刪),只針對草稿實際會出的兩種髒東西:HTML 標籤殘骸、以及被當成內容吐出來的
 * 「---」分隔線與純旁白行。
 */
/**
 * v86.1:播放清單格式閘門(三快照最後一塊拼圖;v76 只裝了草稿與搜尋)。
 * 擁有者截圖:「最近播放」整包只剩一句要傳給玩家的台詞(「我馬上就到,別亂跑…」)。
 * 合約=任務規定的「歌名 — 歌手」每行一首+尾行「循環理由:…」;
 * 沒有分隔符的行(=台詞/訊息走鐘)一律丟;歌曲行全滅 → 回空攔下重按。
 */
export function sanitizePlaylistSnapshot(text) {
  const lines = String(text || '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .split('\n').map((l) => l.trim().replace(/^[♪♫🎵🎶]\s*/, ''))
    .filter((l) => l && !/^-{2,}$/.test(l));
  const songs = [];
  let reason = '';
  for (const l of lines) {
    if (/^循環理由\s*[::]/.test(l)) { if (!reason) reason = l; continue; }
    // 歌曲行合約:歌名 — 歌手(認 em/en dash、全形橫線、hyphen、｜/|、by)
    if (/\S\s*(?:—|–|─|-|｜|\|)\s*\S/.test(l) || /\sby\s/i.test(l)) { songs.push(l); continue; }
    // 其餘=台詞/訊息/說明走鐘,丟
  }
  if (!songs.length) return ''; // 全滅=整包走鐘,攔下讓上層回「重按」
  return [...songs.slice(0, 8), ...(reason ? [reason] : [])].join('\n');
}

export function sanitizeDraftSnapshot(text, characterName = '') {
  const bare = (x) => String(x || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
  const selfBare = bare(characterName);
  const lines = String(text || '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // HTML 標籤殘骸
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !/^-{2,}$/.test(l) && !/^[-—=~*·。\s]+$/.test(l)) // 丟純分隔線/純符號行
    .filter((l) => !/^\|\|/.test(l)) // v70:丟「||」開頭的行(缺收件人/本體、只剩內心註記的走鐘草稿)
    // v76:欄位守門——沒有任何「||」的裸句=走鐘(缺「沒送出的原因」欄,擁有者截圖:整包只剩
    // 一句下一則台詞充當草稿)。合法格式=三欄新版或二欄舊版,至少含一個 ||;全丟=回空攔下重按。
    .filter((l) => l.includes('||'))
    // v84.3:收件人守門——模型偶爾把「誰寫給誰」搞混,吐出寄給「自己」的草稿
    // (擁有者截圖:謝子勳 To:謝子勳 約自己吃熱炒)。第一欄=收件人,正規化後與角色
    // 本名相同/互含(≥2字)一律丟;寧可少一則,不留人格分裂快照。
    .filter((l) => {
      if (!selfBare) return true;
      const rb = bare(String(l.split('||')[0] || '').replace(/^To\s*[::]?/i, ''));
      if (!rb) return true;
      const hit = rb === selfBare || (rb.length >= 2 && selfBare.length >= 2 && (rb.includes(selfBare) || selfBare.includes(rb)));
      return !hit;
    });
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
      if (!r.ok) {
        recordPeek(getState(), peekType, r.blocked ? 'block' : 'err', r.message); // v87(p3)+v94.1(u4) 病歷
        await persist();
        return { ok: false, message: r.message };
      }
      content = stripNamePrefix(r.text, [character.name]).trim();
      if (peekType === 'search') content = sanitizeSearchSnapshot(content); // v61 輸出端防線
      if (peekType === 'draft') content = sanitizeDraftSnapshot(content, character.name); // v68 清潔+v84.3 自寄守門
      if (peekType === 'playlist') content = sanitizePlaylistSnapshot(content); // v86.1:播放清單格式閘門
      // v77(根源二):安全攔截已在 generateReply 層辨識並帶真實原因回來(上面的 r.message),
      // 走到這裡的空內容=清潔器攔下的格式走鐘,重按確實有效,文案不誤導。
      if (!String(content || '').trim()) {
        recordPeek(getState(), peekType, 'gate', '整包不合格式(清潔器攔下)'); // v87(p3)+v94.1(u4)
        await persist();
        return { ok: false, message: '這次生成的內容整包不合格式,已幫你攔下——再按一次「更新快照」通常就正常。' };
      }
      recordPeek(getState(), peekType, 'ok'); // v87(p3)
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
