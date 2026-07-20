/**
 * modules/mention.js — 群聊 @ 點名偵測(v93 自 chat.js 內聯抽出的純函式)。
 * v89(m2)的規則,行為與抽出前逐位元相同:
 *   - 每位參與者生成「形集」:去符號全名 nb、去姓 nb.slice(1)、尾二 nb.slice(-2)、尾一 nb.slice(-1)
 *   - 文中出現「@形」即命中,取該角色命中的「最長形」長度當分數
 *   - 最高分且唯一者 = 點名;同分歧義或無人命中 = 回 null(寧可不搶答,不可點錯人)
 *   - 快選列插入的是全名(最長形),天然拿到最高分、最穩
 * 純函式:無副作用、不碰 state,呼叫端(chat.js 群聊 send)只用其回傳的角色物件。
 */

/** 去掉非「漢字/英數」字元,得到可比對的裸名(@、空白、標點都剝掉)。 */
export function bareName(x) {
  return String(x || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
}

/** 一個裸名的所有可點名「形」(去重、去空):全名 / 去姓 / 尾二 / 尾一。 */
export function nameForms(name) {
  const nb = bareName(name);
  return [...new Set([nb, nb.slice(1), nb.slice(-2), nb.slice(-1)])].filter((f) => f);
}

/**
 * 從訊息文字判定被 @ 點名的唯一角色。
 * @param {string} text 玩家送出的訊息
 * @param {Array<{name:string}>} participants 群聊參與角色(需含 name;回傳原物件)
 * @returns {object|null} 命中的角色物件;同分歧義或無命中回 null
 */
export function detectMention(text, participants) {
  const msg = String(text || '');
  if (!msg.includes('@') || !Array.isArray(participants)) return null;

  let mentioned = null;
  let best = 0;
  let tie = false;
  for (const c of participants) {
    let score = 0;
    for (const f of nameForms(c?.name)) {
      if (f.length > score && msg.includes(`@${f}`)) score = f.length;
    }
    if (!score) continue;
    if (score > best) { best = score; mentioned = c; tie = false; } else if (score === best) tie = true;
  }
  return tie ? null : mentioned;
}
