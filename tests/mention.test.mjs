/**
 * tests/mention.test.mjs — 群聊 @ 點名偵測純函式(v93 起常駐)。
 * detectMention 自 chat.js 內聯抽出(v89 m2 邏輯),本檔守「行為與抽出前一致」+邊界:
 *   - 全名硬點名(快選列插入的形態,最穩)
 *   - 模糊形:去姓、尾二、尾一(擁有者慣用簡稱)
 *   - 同分歧義 → null(寧可不搶答不點錯人:兩人尾字相同時放棄硬點名)
 *   - 無 @ / 無命中 / 空輸入 → null
 *   - 最長形優先(@全名 命中全名而非某人的尾字)
 *   - 附「參考實作」等價性:對隨機組合,detectMention 與內聯原始迴圈結果一致
 * 純函式測試,不需 jsdom/state——但沿用 _env 的斷言器維持一致輸出格式。
 */
import { t, summary } from './_env.mjs';
import { detectMention, nameForms, bareName } from '../modules/mention.js';

const C = (name) => ({ id: name, name }); // 精簡角色物件(detectMention 只讀 name,回傳原物件)

// ── bareName / nameForms 基礎 ──
t(bareName('@陳以彥!') === '陳以彥', 'bareName 剝符號');
t(JSON.stringify(nameForms('陳以彥')) === JSON.stringify(['陳以彥', '以彥', '彥']),
  'nameForms:三字名 → 全名/去姓(=尾二,去重)/尾一');
t(JSON.stringify(nameForms('小美')) === JSON.stringify(['小美', '美']),
  'nameForms:二字名 → 全名/尾一(去姓與尾二皆重合)');

// ── 全名硬點名 ──
{
  const ps = [C('陳以彥'), C('林子勳')];
  t(detectMention('@陳以彥 在嗎', ps) === ps[0], '全名點名命中');
  t(detectMention('@林子勳你看', ps) === ps[1], '全名點名命中(另一人)');
}

// ── 模糊形:去姓 / 尾二 / 尾一 ──
{
  const ps = [C('陳以彥'), C('王大明')];
  t(detectMention('@以彥 幫我', ps) === ps[0], '去姓簡稱命中');
  t(detectMention('@彥 過來', ps) === ps[0], '尾一字命中');
  t(detectMention('@大明 呢', ps) === ps[1], '尾二字命中');
}

// ── 同分歧義 → null(核心安全性:寧可不搶答)──
{
  const ps = [C('陳小明'), C('王小明')]; // 尾二「小明」、尾一「明」都撞
  t(detectMention('@小明 在嗎', ps) === null, '兩人尾二同形 → 放棄硬點名');
  t(detectMention('@明 你好', ps) === null, '兩人尾一同形 → 放棄硬點名');
  // 但用完整全名仍能區分(全名唯一,分數更高且不撞)
  t(detectMention('@陳小明 在嗎', ps) === ps[0], '撞尾字時,全名仍可精確點名');
}

// ── 最長形優先 ──
{
  const ps = [C('阿明'), C('陳阿明')]; // 「阿明」是前者全名、也是後者尾二
  // @陳阿明 → 後者全名(len3)勝過前者全名(len2)
  t(detectMention('@陳阿明', ps) === ps[1], '較長全名優先於較短全名的尾字命中');
}

// ── 無命中 / 無 @ / 空輸入 → null ──
t(detectMention('大家好啊', [C('甲'), C('乙')]) === null, '無 @ → null');
t(detectMention('@丙 在嗎', [C('甲'), C('乙')]) === null, '@ 了不存在的人 → null');
t(detectMention('', [C('甲')]) === null, '空字串 → null');
t(detectMention('@甲', null) === null, 'participants 非陣列 → null');
t(detectMention(null, [C('甲')]) === null, 'text 為 null → null');

// ── 等價性:對隨機情境,detectMention == 內聯原始迴圈 ──
function inlineOriginal(text, participants) { // 抽出前的原碼(逐字複製,當參考真值)
  const bareM = (x) => String(x || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
  let mentioned = null; let best = 0; let tie = false;
  for (const c of participants) {
    const nb = bareM(c.name);
    const forms = [...new Set([nb, nb.slice(1), nb.slice(-2), nb.slice(-1)])].filter((f) => f);
    let score = 0;
    for (const f of forms) if (f.length > score && text.includes(`@${f}`)) score = f.length;
    if (!score) continue;
    if (score > best) { best = score; mentioned = c; tie = false; } else if (score === best) tie = true;
  }
  if (tie) mentioned = null;
  return mentioned;
}
{
  const pool = ['陳以彥', '林子勳', '王大明', '小美', '阿豪', '楊皓', '陳小明', '李四'];
  let mismatches = 0;
  const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  for (let i = 0; i < 300; i += 1) {
    const n = 2 + Math.floor(rng() * 3);
    const ps = [];
    while (ps.length < n) { const nm = pool[Math.floor(rng() * pool.length)]; if (!ps.some((p) => p.name === nm)) ps.push(C(nm)); }
    const target = ps[Math.floor(rng() * ps.length)];
    const forms = nameForms(target.name);
    const form = forms[Math.floor(rng() * forms.length)];
    const text = `隨機前綴 @${form} 隨機後綴`;
    const a = detectMention(text, ps);
    const b = inlineOriginal(text, ps);
    if (a !== b) { mismatches += 1; if (mismatches <= 3) console.log('  MISMATCH', text, ps.map((p) => p.name)); }
  }
  t(mismatches === 0, `等價性:300 組隨機情境 detectMention 全等內聯原始迴圈`);
}

summary('點名偵測');
