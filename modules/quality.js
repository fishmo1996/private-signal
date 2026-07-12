/**
 * quality.js — 輸出品質工具(v81)。
 * 1) assessDmDrift:DM 走鐘偵測(f1 計數器與 e3 保險絲共用)——只「偵測」不硬剝,
 *    硬剝旁白會毀掉可讀內容;偵測命中就標記給 UI 掛重生提示+進統計。
 * 2) recordDrift / driftSummary:每房近 30 次生成的走鐘率與清潔器出手紀錄,
 *    開發資訊可視化——卡片改完有沒有變乖、promptLang A/B,看數字不用人工數。
 * 3) auditCharacterCard(f2):卡片體檢——「名字:(動作)」劇本格式範例是 DM 小說腔的
 *    頭號病原(v80 陳以彥實案),匯入/編輯時直接標出來給改法。
 */

const COLON = '[::\\uFE30\\uFE55\\u2236]';

/** DM 輸出走鐘評估。輸入「模型原始輸出」(清潔前)。命中 ≥2 個特徵才算走鐘,單一特徵放行。 */
export function assessDmDrift(rawText, { chatFeel = true } = {}) {
  const t = String(rawText || '').trim();
  const len = [...t].length;
  const flags = [];
  // ① 該拆沒拆:聊天感開著、內容夠長、卻通篇沒有任何分隔(行式或行內都沒有)
  if (chatFeel && len > 150 && !/-{3,}/.test(t)) flags.push('nosplit');
  // ② 括號旁白佔比:全形/半形括號內 10 字以上的長段,總佔比 >35%
  let paren = 0;
  for (const m of t.matchAll(/[((]([^))]{10,})[))]/g)) paren += [...m[1]].length;
  if (len && paren / len > 0.35) flags.push('paren');
  // ③ 行首名字前綴形態(不看具體名字,只看「短字串+冒號」開頭)
  if (new RegExp(`^[^\\n::\\uFE30\\uFE55\\u2236]{1,16}${COLON}`).test(t)) flags.push('prefix');
  // ④ 第三人稱旁白動詞密度(他/她+神態動詞 ≥2 處)
  const narration = (t.match(/(他|她)[^\n。,,]{0,8}(說道|嘆了|看著|望著|凝視|伸手|放下|抬起|皺眉|挑眉|低聲|沉默|苦笑)/g) || []).length;
  if (narration >= 2) flags.push('narration');
  return { drifted: flags.length >= 2, flags };
}

/** 每房走鐘紀錄(近 30 次滾動)。rec = { drift, flags[], fixes[] }。 */
export function recordDrift(state, roomId, rec) {
  if (!state.driftStats) state.driftStats = {};
  if (!Array.isArray(state.driftStats[roomId])) state.driftStats[roomId] = [];
  const arr = state.driftStats[roomId];
  arr.push({ t: Date.now(), d: rec.drift ? 1 : 0, f: rec.flags || [], x: rec.fixes || [] });
  if (arr.length > 30) arr.splice(0, arr.length - 30);
}

/** 開發資訊用摘要:各房 {roomId, n, driftRate, fixCounts}(近 30 次),依走鐘率排序。 */
export function driftSummary(state) {
  const out = [];
  for (const [roomId, arr] of Object.entries(state.driftStats || {})) {
    if (!arr.length) continue;
    const fixCounts = {};
    for (const rec of arr) for (const x of rec.x || []) fixCounts[x] = (fixCounts[x] || 0) + 1;
    out.push({
      roomId,
      n: arr.length,
      driftRate: arr.reduce((a, r) => a + r.d, 0) / arr.length,
      fixCounts,
    });
  }
  return out.sort((a, b) => b.driftRate - a.driftRate);
}

/** f2 卡片體檢:回傳 findings [{level:'warn'|'info', field, msg}]。 */
export function auditCharacterCard(card) {
  const c = card || {};
  const findings = [];
  const scriptRe = new RegExp(`(^|\\n)\\s*[^\\n::\\uFE30\\uFE55\\u2236]{1,12}${COLON}\\s*[((「*]`);
  const fields = [
    ['systemPrompt', 'systemPrompt'], ['scenario', '情境'], ['firstMessage', '開場白'],
  ];
  for (const [key, label] of fields) {
    const v = String(c[key] || '');
    if (scriptRe.test(v)) {
      findings.push({ level: 'warn', field: key, msg: `${label} 含「名字:(動作)」劇本格式——模型會模仿它寫小說腔+名字前綴(v80 實案病原)。改成純訊息或敘事句。` });
    }
  }
  for (const g of (Array.isArray(c.alternateGreetings) ? c.alternateGreetings : [])) {
    if (scriptRe.test(String(g))) {
      findings.push({ level: 'warn', field: 'alternateGreetings', msg: '備用開場含劇本格式,同上建議。' });
      break;
    }
  }
  const sp = String(c.systemPrompt || '');
  if (/(第三人稱|旁白|小說筆法|描寫[^\n]{0,6}(動作|神態|心理))/.test(sp)) {
    findings.push({ level: 'warn', field: 'systemPrompt', msg: 'systemPrompt 在教旁白/第三人稱描寫——DM 房會跟「像打字」指令打架。這類指示建議放正文專用卡或風格模組。' });
  }
  if ([...sp].length > 1500) {
    findings.push({ level: 'info', field: 'systemPrompt', msg: `systemPrompt 約 ${[...sp].length} 字,每次生成都全額計費;可考慮把背景故事移到世界書(關鍵字才觸發)。` });
  }
  if (/[^\p{Script=Han}A-Za-z0-9·]/u.test(String(c.name || '').trim())) {
    findings.push({ level: 'info', field: 'name', msg: '名字帶符號/表符:v80 起剝除有模糊層能救,但乾淨的名字最穩。' });
  }
  return findings;
}
