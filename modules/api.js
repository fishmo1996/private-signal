/**
 * modules/api.js
 * API / LLM 連線設定層。
 * 注意：目前「對話回覆」仍是本機 mock;這裡先提供設定介面、連線測試與模型列表,
 * 讓之後串接時 buildPrompt → 真實 API 只差最後一步。
 *
 * 金鑰只存在本機瀏覽器的 IndexedDB,不會上傳任何地方;
 * 但若日後部署到 GitHub Pages 供他人使用，請改走 serverless proxy,勿讓金鑰出現在前端。
 */

import { getState, persist } from './state.js';

export const PROVIDERS = {
  openai:    { label: 'OpenAI',            base: 'https://api.openai.com/v1' },
  gemini:    { label: 'Google Gemini',     base: 'https://generativelanguage.googleapis.com/v1beta' },
  anthropic: { label: 'Anthropic Claude',  base: 'https://api.anthropic.com/v1' },
  custom:    { label: '自訂(OpenAI 相容)', base: '' },
};

export function getApiConfig() {
  const state = getState();
  if (!state.apiConfig) {
    state.apiConfig = defaultApiConfig();
  }
  if (state.apiConfig.secondaryModel === undefined) state.apiConfig.secondaryModel = '';
  if (state.apiConfig.promptLang === undefined) state.apiConfig.promptLang = 'zh'; // v78:指令骨架語言
  return state.apiConfig;
}

export function defaultApiConfig() {
  return {
    provider: 'openai',
    apiKey: '',
    model: '',
    secondaryModel: '',          // 次要模型(同供應商同金鑰；空=一切照舊全走主要)
    baseUrl: '',                 // custom 供應商用
    maxReplyChars: { dm: 800, group: 1200, story: 4000 }, // 每模式一則回覆的字數上限
    contextBudget: 20000,        // 上下文預算(字數):對話歷史由新到舊裝進 prompt,裝滿即止
    useRealApi: false,           // 總開關：開啟後對話使用真實 AI
    modelList: [],               // 「取得最新模型」的快取，供下拉選單使用
    temperature: 1.0,            // 溫度：創作建議 0.9~1.2
    topP: 0.95,
    thinkingBudget: '',          // Gemini 思考預算：留空=模型預設,0=關閉思考(省額度)
    promptLang: 'zh',            // v78:固定回覆指令的骨架語言 'zh'|'en'(en=實驗,省指令 token;內容血肉一律中文)
    safetyLevel: 'default',      // Gemini 內容安全:default | relaxed | none(官方 safetySettings 參數)
    presets: [null, null, null], // P1~P3:{name, provider, apiKey, model, baseUrl}
  };
}

export async function saveApiConfig(patch) {
  const cfg = getApiConfig();
  Object.assign(cfg, patch);
  await persist();
  return cfg;
}

/** 把目前連線設定存入預設槽(0~2)。 */
export async function savePreset(slot) {
  const cfg = getApiConfig();
  cfg.presets[slot] = {
    name: `P${slot + 1}`,
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    temperature: cfg.temperature,
    topP: cfg.topP,
    thinkingBudget: cfg.thinkingBudget,
  };
  await persist();
}

/** 載入預設槽。 */
export async function loadPreset(slot) {
  const cfg = getApiConfig();
  const p = cfg.presets[slot];
  if (!p) return false;
  Object.assign(cfg, {
    provider: p.provider, apiKey: p.apiKey, model: p.model, baseUrl: p.baseUrl,
    ...(p.temperature !== undefined
      ? { temperature: p.temperature, topP: p.topP, thinkingBudget: p.thinkingBudget }
      : {}),
  });
  await persist();
  return true;
}

function baseOf(cfg) {
  return cfg.provider === 'custom'
    ? String(cfg.baseUrl || '').replace(/\/+$/, '')
    : PROVIDERS[cfg.provider]?.base || '';
}

/**
 * 取得模型列表。回傳 {ok, models?, message?}。
 * 部分供應商可能擋瀏覽器直連(CORS),失敗時會誠實回報，不影響手動填模型名。
 */
export async function listModels(cfg = getApiConfig()) {
  const base = baseOf(cfg);
  if (!base) return { ok: false, message: '請先填入自訂 API 位址' };
  try {
    let url; let headers = {};
    if (cfg.provider === 'gemini') {
      url = `${base}/models?key=${encodeURIComponent(cfg.apiKey)}`;
    } else if (cfg.provider === 'anthropic') {
      url = `${base}/models`;
      headers = {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      };
    } else {
      url = `${base}/models`;
      headers = { Authorization: `Bearer ${cfg.apiKey}` };
    }
    const res = await fetch(url, { headers });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.data || data.models || [])
      .map((m) => m.id || m.name?.replace(/^models\//, ''))
      .filter(Boolean)
      .sort();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, message: `連線失敗(可能是 CORS 或網路):${err.message}` };
  }
}

/** 連線測試：能列出模型就算通。 */
export async function testConnection(cfg = getApiConfig()) {
  if (!cfg.apiKey && cfg.provider !== 'custom') {
    return { ok: false, message: '請先填入 API 金鑰' };
  }
  const r = await listModels(cfg);
  return r.ok
    ? { ok: true, message: `連線成功，共 ${r.models.length} 個模型可用` }
    : { ok: false, message: r.message };
}

/* ------------------------------------------------------------
 * 真實 AI 回覆(目前僅私訊 DM 使用)。
 * ------------------------------------------------------------ */

/** 模型名稱正規化：去空白、去 models/ 前綴(Gemini 清單常見)。 */
export function normalizeModel(provider, model) {
  let m = String(model || '').trim();
  if (provider === 'gemini') m = m.replace(/^models\//, '');
  return m;
}

/** 解析 dataURL 為 {mimeType, data(base64)}。 */
function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ''));
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/**
 * c1(⑤):送出前的請求總量保險絲。120,000 字≈18 萬 token,貼近 Gemini 20 萬 token
 * 長上下文加價線;現行預算(預設 2 萬字)距此有 6 倍餘裕,正常永不觸發,
 * 純防未來改壞(20 萬 token 悲劇的二次保險)。估法照規格:system+contents 字數
 * (含 speaker 前綴,因為它會實際進請求;圖片以 base64 另計太重、不在字數規格內)。
 */
export const REQUEST_CHAR_FUSE = 120000;
export function estimateRequestChars({ system, messages }) {
  return String(system || '').length
    + (messages || []).reduce((s, m) => s + (m.content?.length || 0) + (m.speaker?.length || 0), 0);
}

/** 依供應商組出聊天請求(純函式，便於測試)。 */
export function buildChatRequest(cfg, { system, messages, meta }) {
  const base = cfg.provider === 'custom'
    ? String(cfg.baseUrl || '').replace(/\/+$/, '')
    : PROVIDERS[cfg.provider]?.base || '';
  // 中文約 1 字 1~2 token,寬鬆抓 2 倍再設上限
  let maxTokens = Math.min(8192, Math.max(256, Math.round((meta?.maxReplyChars || 800) * 2)));
  // v84.2:Gemini 2.5 的思考(thinking)token「計入」maxOutputTokens——心聲/偷看這類
  // 小額度任務(600 tokens)會被思考整份吃光,回空內容、finishReason=MAX_TOKENS,
  // 舊版誤報成「內容審查誤判」(擁有者實案:健康內容也連環被擋)。
  // 對策:思考未關時給足 headroom;thinkingBudget=0(已關思考)維持原額度不多花錢。
  if (cfg.provider === 'gemini') {
    const tb = cfg.thinkingBudget;
    if (tb === '' || tb === null || tb === undefined) maxTokens = Math.max(maxTokens, 4096); // 模型自管思考:保底
    else if (Number(tb) > 0) maxTokens = Math.min(16384, maxTokens + Number(tb)); // 明確預算:疊加
  }

  const model = normalizeModel(cfg.provider, cfg.model);

  if (cfg.provider === 'gemini') {
    return {
      url: `${base}/models/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => {
          const parts = [];
          const img = m.image ? parseDataUrl(m.image) : null;
          if (img) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
          parts.push({ text: m.speaker ? `${m.speaker}:${m.content}` : (m.content || '(傳了一張圖片)') });
          return { role: m.role === 'user' ? 'user' : 'model', parts };
        }),
        ...(cfg.safetyLevel && cfg.safetyLevel !== 'default' ? {
          safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
            'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
            'HARM_CATEGORY_CIVIC_INTEGRITY'] // v77:補齊全類別(官方文件的第五類)
            .map((category) => ({
              category,
              threshold: cfg.safetyLevel === 'none' ? 'BLOCK_NONE' : 'BLOCK_ONLY_HIGH',
            })),
        } : {}),
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: cfg.temperature ?? 1.0,
          topP: cfg.topP ?? 0.95,
          ...(cfg.thinkingBudget !== '' && cfg.thinkingBudget !== null && cfg.thinkingBudget !== undefined
            ? { thinkingConfig: { thinkingBudget: Number(cfg.thinkingBudget) } }
            : {}),
        },
      },
    };
  }
  if (cfg.provider === 'anthropic') {
    return {
      url: `${base}/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: {
        model,
        system,
        max_tokens: maxTokens,
        temperature: Math.min(1, cfg.temperature ?? 1.0),
        top_p: cfg.topP ?? 0.95,
        messages: messages.map((m) => {
          const text = m.speaker ? `${m.speaker}:${m.content}` : (m.content || '(傳了一張圖片)');
          const img = m.image ? parseDataUrl(m.image) : null;
          return {
            role: m.role === 'user' ? 'user' : 'assistant',
            content: img
              ? [
                { type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } },
                { type: 'text', text },
              ]
              : text,
          };
        }),
      },
    };
  }
  // openai 與自訂(OpenAI 相容)
  return {
    url: `${base}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: {
      model,
      max_tokens: maxTokens,
      temperature: cfg.temperature ?? 1.0,
      top_p: cfg.topP ?? 0.95,
      messages: [
        { role: 'system', content: system },
        ...messages.map((m) => {
          const text = m.speaker ? `${m.speaker}:${m.content}` : (m.content || '(傳了一張圖片)');
          return {
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.image
              ? [{ type: 'image_url', image_url: { url: m.image } }, { type: 'text', text }]
              : text,
          };
        }),
      ],
    },
  };
}

/** 從各供應商的回應格式取出文字。 */
export function extractReplyText(provider, data) {
  if (provider === 'gemini') {
    return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  }
  if (provider === 'anthropic') {
    return (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') || '';
  }
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * 呼叫真實 API 產生回覆。回傳 {ok, text?, message?}。
 * 失敗時誠實回報(429=額度限制、401/403=金鑰問題),不丟例外。
 */
export async function generateReply(cfg, prompt, opts = {}) {
  // v97(w3):每房模型覆寫——解析順序:房間覆寫 > tier 次要 > 主模型。
  // 只有「主線生成」的呼叫點會帶 opts.modelOverride(DM 回覆/主動訊息/群包/群自聊/群solo/正文);
  // 心聲/偷看/日記/社群/摘要等雜務呼叫點一律不帶=不受覆寫影響,正文切 Pro 不會連雜務一起變貴。
  if (opts.modelOverride?.trim()) {
    cfg = { ...cfg, model: opts.modelOverride.trim() };
  } else if (opts.tier === 'secondary' && cfg.secondaryModel?.trim()) {
    // tier: 'secondary' 且有設定次要模型時，換模型不換供應商/金鑰(F 案：摘要等雜務走便宜模型)
    cfg = { ...cfg, model: cfg.secondaryModel.trim() };
  }
  const model = normalizeModel(cfg.provider, cfg.model);
  if (!model) return { ok: false, message: '尚未設定模型，請到設定挑選' };
  if (/\s/.test(model) || (cfg.provider === 'gemini' && /[A-Z]/.test(model))) {
    return {
      ok: false,
      message: `「${cfg.model}」看起來是顯示名稱，不是 API 模型 id。請到設定按「↻ 取得最新模型」，從下拉選單挑選(正確格式像 gemini-flash-lite-latest)`,
    };
  }
  // c1(⑤):總量保險絲——超限直接擋下不送、不重試(重按不會變小,文案不引導無效重按)
  if (estimateRequestChars(prompt) > REQUEST_CHAR_FUSE) {
    return { ok: false, message: '單次請求過大:請調低上下文預算或封存章節' };
  }
  // 暫時性錯誤(429 速率限制、5xx、網路抖動)自動退避重試 2 次；金鑰類錯誤不重試。
  const RETRYABLE = new Set([429, 500, 502, 503, 529]);
  const MAX_ATTEMPTS = 3;
  let lastMessage = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const req = buildChatRequest(cfg, prompt);
      const res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
      });
      if (!res.ok) {
        const hint = { 401: '金鑰無效', 403: '金鑰無權限', 429: '達到速率/每日額度限制' }[res.status] || '';
        let detail = '';
        try { detail = (await res.json())?.error?.message || ''; } catch { /* noop */ }
        lastMessage = `HTTP ${res.status}${hint ? `(${hint})` : ''}${detail ? `:${detail.slice(0, 120)}` : ''}`;
        if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS - 1) continue;
        if (RETRYABLE.has(res.status)) lastMessage += '(已自動重試 2 次，請稍後再送一次，你的輸入還在)';
        return { ok: false, message: lastMessage };
      }
      const data = await res.json();
      // v77(根源二):安全攔截誤報修正——Gemini 被安全過濾攔下時回空 candidate 或
      // finishReason=SAFETY/blockReason,舊碼統一誤報成「格式不合」,誤導使用者無效重按
      // 五次(擁有者實案)。這裡辨識真實原因、回明確錯誤型別(blocked:true),重試無效的
      // 情況不再引導無腦重按。
      if (cfg.provider === 'gemini') {
        const blockReason = data?.promptFeedback?.blockReason || '';
        const finishReason = data?.candidates?.[0]?.finishReason || '';
        const BLOCKED_FINISH = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);
        if (blockReason || BLOCKED_FINISH.has(finishReason)) {
          return {
            ok: false,
            blocked: true,
            message: `被供應商的安全過濾攔下(${blockReason || finishReason};非格式問題)。過濾有隨機性,重按偶爾會過;常被咬的話更有效的是:到 API 設定調寬「內容安全等級」,或改寫最近一句再送。`,
          };
        }
      }
      const text = extractReplyText(cfg.provider, data).trim();
      recordUsage(cfg.provider, data, prompt.meta); // v81(f3):token 用量入帳(失敗靜默,不影響回覆)
      // v100.1:思考吃光額度的辨識改「看證據不看代碼」——擁有者實案:同一病灶有時回
      // MAX_TOKENS、有時回 STOP(想完額度歸零、一字未寫就「正常」收工),舊判準只認前者。
      // 證據=回覆空+這一發的思考 token > 0,一律如實報思考吃光。
      if (!text && cfg.provider === 'gemini'
        && (data?.candidates?.[0]?.finishReason === 'MAX_TOKENS' || (data?.usageMetadata?.thoughtsTokenCount || 0) > 0)) {
        return { ok: false, message: `輸出額度被思考(thinking)吃光了(這發思考用了 ${data?.usageMetadata?.thoughtsTokenCount || '?'} tokens),不是內容審查——再按一次通常就好;常發生的話到 API 設定把 thinkingBudget 設 0(關思考)或調低。` };
      }
      if (!text) {
        // v99.4:空回覆不再進「不明原因垃圾桶」——把 finishReason 如實吐出,懸案才有線索
        // (擁有者實案:心聲頻繁難產、非安全非額度,舊文案把原因代碼吞掉導致無從診斷)
        const fr = cfg.provider === 'gemini' ? (data?.candidates?.[0]?.finishReason || '無 candidate') : '';
        if (fr === 'RECITATION') {
          return { ok: false, message: '模型因「複述保護」(RECITATION)自行中止——它怕輸出跟受版權保護的文字太像,與內容審查無關。重按通常會過;常發生的話把最近一句改寫得更口語、少引用歌詞或書句。' };
        }
        return { ok: false, message: `這一則被模型服務暫時擋下(${fr ? `原因代碼:${fr}` : '內容審查誤判或長度不足'}),再試一次通常就好——與你的內容無關。` };
      }
      const cap = prompt.meta?.maxReplyChars || 800;
      return { ok: true, text: text.length > cap ? `${text.slice(0, cap)}…` : text };
    } catch (err) {
      lastMessage = `連線失敗:${err.message}`;
      if (attempt < MAX_ATTEMPTS - 1) continue;
      return { ok: false, message: `${lastMessage}(已自動重試 2 次)` };
    }
  }
  return { ok: false, message: lastMessage || '未知錯誤' };
}

/**
 * v81(f3):token 帳單——各供應商回應都附用量數字,以前直接丟掉。存進 state.usageLog
 * (滾動 400 筆),開發資訊出儀表板:今天/7日花費、思考 token 佔比、最燒的房。
 * meta.roomId/mode 由各 prompt 建構器帶(v81 起),沒帶的歸「其他」。
 */
function recordUsage(provider, data, meta) {
  try {
    // c1(修訂二):補記快取命中 token(c)——快取分層的帳單效果要有數字可驗,
    // 不能只憑感覺。Gemini=cachedContentTokenCount(隱式快取命中,計入 p 內、按折扣價),
    // Anthropic=cache_read_input_tokens,OpenAI=prompt_tokens_details.cached_tokens。
    const u = provider === 'gemini'
      ? {
        p: data?.usageMetadata?.promptTokenCount || 0,
        o: data?.usageMetadata?.candidatesTokenCount || 0,
        th: data?.usageMetadata?.thoughtsTokenCount || 0,
        c: data?.usageMetadata?.cachedContentTokenCount || 0,
      }
      : provider === 'anthropic'
        ? {
          p: data?.usage?.input_tokens || 0, o: data?.usage?.output_tokens || 0, th: 0,
          c: data?.usage?.cache_read_input_tokens || 0,
        }
        : {
          p: data?.usage?.prompt_tokens || 0, o: data?.usage?.completion_tokens || 0, th: 0,
          c: data?.usage?.prompt_tokens_details?.cached_tokens || 0,
        };
    if (!u.p && !u.o) return;
    const st = getState();
    if (!Array.isArray(st.usageLog)) st.usageLog = [];
    st.usageLog.push({
      t: Date.now(),
      r: meta?.roomId || null,
      k: meta?.mode || meta?.roomType || 'dm',
      ...u,
    });
    if (st.usageLog.length > 400) st.usageLog.splice(0, st.usageLog.length - 400);
  } catch { /* 記帳失敗不影響回覆 */ }
}

/* ------------------------------------------------------------
 * 回覆後處理
 * ------------------------------------------------------------ */

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 輸出替換規則(設定 → 提示詞):對所有 AI 輸出做「找→換」。
 * 例：把模型愛用的 *動作* 星號體換成(動作)。無效的 regex 會被安全跳過。
 */
export function applyOutputRules(text) {
  let out = String(text || '');
  const rules = getState()?.settings?.outputRules || [];
  for (const r of rules) {
    if (!r?.enabled || !r.find) continue;
    try {
      if (r.regex) out = out.replace(new RegExp(r.find, 'g'), r.replace ?? '');
      else out = out.split(r.find).join(r.replace ?? '');
    } catch { /* 無效規則跳過，不炸輸出 */ }
  }
  return out;
}

/**
 * v76:時間戳鸚鵡第四形態(擁有者截圖:心聲卡出現行內「陳以彥: (7/8(週三) 14:57)…」+複述下一句台詞)。
 * v70 的行內防線做在 splitChatParts,但心聲是單張思緒卡不走拆條,行內形態沒人管。
 * 對策(必需特徵=「名字:+時間戳括號」,同 v70 通則):
 * ①遇行內「名字:(時間戳)」→ 從名字處整段截尾——後面是複述的台詞,聊天室本來就看得到,留著只是噪音;
 * ②行內孤立的時間戳括號一律剝除(防誤剝沿 v60 規格:時分「緊接」右括號才算,「(晚上8:30見)」時分後有字不剝)。
 * 用在心聲兩路徑(DM/房內);聊天訊息不需要——那條線有拆條+行首剝除器管。
 */
// v80:冒號類統一——模型偶發打出視覺幾乎相同的變體冒號 ︰(U+FE30)﹕(U+FE55)∶(U+2236),
// 舊 [::] 全漏網,名字前綴穿透整條防線(陳以彥實案,截圖佐證)。名字/標籤相關 regex 一律用這組。
export const COLON_CLS = '[::\uFE30\uFE55\u2236]';
const TS_INLINE = '[((][^\\n]{0,18}?[\\d0-9]{1,2}\\s*[::][\\d0-9]{2}\\s*[))]';
export function cutInlineTsRecitation(text, names = []) {
  let out = String(text || '');
  for (const name of (Array.isArray(names) ? names : [names])) {
    const n = String(name || '').trim();
    if (!n) continue;
    out = out.replace(new RegExp(escapeRegex(n) + '\\s*' + COLON_CLS + '\\s*' + TS_INLINE + '[\\s\\S]*$'), '');
  }
  out = out.replace(new RegExp(TS_INLINE, 'g'), '');
  return out.trim();
}

/** 模型鸚鵡學舌時間戳的清除：剝掉每行開頭的「(7/5(週日) 14:22)」式前綴。
 *  寬容版(v60):模型會吐全形數字/全形冒號/雜字變體，截圖上肉眼相同但字元不同。
 *  策略：行首括號塊、容忍至多 18 個雜字(含內層括號),只要含「時：分」樣式(全半形皆認)
 *  且緊接右括號，就整塊剝除。訊息內文合法出現的「(晚上8:30見)」因時分後有字不會誤剝。 */
const TS_PREFIX = /^\s*[((][^\n]{0,18}?[\d0-9]{1,2}\s*[::][\d0-9]{2}\s*[))]\s*/gm;
const REL_TIME_ECHO = /\s*[((]約\s?\d+\s?(?:天|個月|年)前[^))]{0,12}[))]/g;

/** 刮掉模型愛加的「名字：」前綴；所有 AI 輸出的統一後處理點(含輸出替換規則)。 */
/** v62:單獨匯出時間戳剝除——模型會把「---(時間戳)」寫在同一行,整段剝除時
 *  它不在行首而漏網,拆條切掉 --- 後就浮上訊息開頭;拆條後每則再剝一次。 */
export function stripTsPrefix(text) {
  return String(text || '').replace(TS_PREFIX, '');
}

export function stripNamePrefix(text, names = []) {
  text = String(text || '').replace(TS_PREFIX, ''); // 先剝時間戳，名字前綴才會回到行首
  text = text.replace(REL_TIME_ECHO, ''); // 剝「(約 N 天前)」系統附註的鸚鵡
  let out = String(text || '');
  const list = (Array.isArray(names) ? names : [names])
    .filter(Boolean)
    .map((n) => String(n).trim())
    .filter(Boolean);
  for (const name of list) {
    const re = new RegExp(
      `^\\s*[*_「『【\\[((]*\\s*${escapeRegex(name)}\\s*[」』】\\]))*_。.]*\\s*${COLON_CLS}\\s*`,
      'gm',
    ); // v80:括號類補【】(),冒號改共用類,名字後補剝句點(「名字。:」形態)
    out = out.replace(re, '').replace(re, ''); // 刮兩次，處理「名字：名字：」的怪輸出
  }
  // v80(e4):名字模糊剝除第二層——卡名與輸出名不完全一致時(卡名帶表符/空白,或模型用
  // 簡稱「以彥:」)精確比對漏網。規則:行首「X:」的 X 去掉非中英數字後,與卡名互為包含
  // 且長度≥2(或完全相等)才剝;「陳媽媽:吃飯了」這種轉述因不包含卡名而保留(有斷言)。
  const bareOf = (x) => String(x || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
  for (const name of list) {
    const bn = bareOf(name);
    if (!bn) continue;
    out = out.replace(new RegExp(`^[ \t]*([^\n::\uFE30\uFE55\u2236]{1,16}?)[ \t]*${COLON_CLS}[ \t]*`, 'gm'), (m, cand) => {
      const bc = bareOf(cand);
      if (!bc) return m;
      // 三種命中:①正規化後全等(卡名帶表符/空白)②候選是卡名的簡稱(以彥⊂陳以彥)
      // ③候選=卡名+至多一字(「陳以彥說:」);多兩字以上(「他說陳以彥:」)視為轉述,保留
      const hit = bc === bn
        || (bc.length >= 2 && bn.includes(bc))
        || (bn.length >= 2 && bc.includes(bn) && bc.length <= bn.length + 1);
      return hit ? '' : m;
    });
  }
  // v64:名字剝除後再剝一次時間戳——覆蓋「名字:(時間戳)內容」的反向形態
  // (上面先剝 TS 是為「(時間戳)名字:」;兩個方向都要,否則名字剝掉後時間戳浮上行首沒人管)
  out = out.replace(TS_PREFIX, '').replace(REL_TIME_ECHO, '');
  return applyOutputRules(out).trim();
}

/**
 * 解析群聊的 JSON 回覆 → [{characterId, content}](最多 3 則)。
 * 模型偶爾會包 markdown 圍欄或講廢話，盡量撈出 JSON;
 * 真的解析不了就把整段當成第一位參與者的單則回覆，不浪費這次呼叫。
 */
export function parseGroupReplies(text, participants, maxReplies = 3) {
  const names = participants.map((c) => c.name);
  let raw = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    .replace(/```(?:json)?/gi, ''); // v77:圍欄不在頭尾(前後夾廢話)也剝乾淨
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) raw = raw.slice(start, end + 1);

  let items = null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) items = parsed;
  } catch { /* fallthrough */ }

  // v66:JSON.parse 炸掉時(content 含裸換行、尾逗號等模型手滑),正則逐物件救援——
  // 不依賴整段 JSON 合法,能撈幾則是幾則。沒有這層,整坨原始碼會被當成第一人的留言貼出來。
  if (!items) {
    const rescued = [];
    const rx = /"name"\s*:\s*"([^"]{1,40})"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = rx.exec(raw)) !== null) {
      let content = m[2];
      try { content = JSON.parse(`"${m[2].replace(/\r?\n/g, '\\n')}"`); } catch { /* 保留原文 */ }
      rescued.push({ name: m[1], content });
    }
    if (rescued.length) items = rescued;
  }

  // v77(根源二):平衡大括號救援第二層——正則層要求 name 在 content 前,模型把鍵序
  // 顛倒({"content":…,"name":…})或漏掉外層 [] 時撈不到。這裡逐字掃描抽出頂層平衡的
  // {…} 區塊(字串內的大括號不誤認),各自 JSON.parse;能撈幾則是幾則。
  if (!items) {
    const objs = [];
    let depth = 0; let start = -1; let inStr = false; let escNext = false;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (escNext) { escNext = false; continue; }
      if (ch === '\\') { escNext = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') { if (depth === 0) start = i; depth += 1; }
      else if (ch === '}') {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && start !== -1) { objs.push(raw.slice(start, i + 1)); start = -1; }
      }
    }
    const rescued2 = [];
    for (const o of objs) {
      try {
        const p = JSON.parse(o.replace(/\r?\n/g, '\\n'));
        if (p && typeof p.content === 'string') rescued2.push({ name: String(p.name || ''), content: p.content });
      } catch { /* 這一塊救不回就跳過 */ }
    }
    if (rescued2.length) items = rescued2;
  }

  // v94.5:名字行剖析層——lite 模型在多角色重載下常退化成「名字:內容」純文字
  // (prompt 的歷史示範本來就長這樣),舊版沒有這層 → 整坨塞給第一人(擁有者五人房實案:
  // 「全部擠在同一個人回」)。逐行掃:行首≤16字+冒號(五種變體)且模糊命中參與者=新的一則,
  // 其餘行=接續上一則。
  if (!items) {
    const lineItems = [];
    let cur = null;
    for (const line of String(text || '').split('\n')) {
      const m = line.match(/^\s*([^\n::\uFE30\uFE55\u2236]{1,16}?)\s*[::\uFE30\uFE55\u2236]\s*(.*)$/);
      const who = m ? resolveParticipant(m[1], participants) : null;
      if (who) {
        if (cur) lineItems.push(cur);
        cur = { name: who.name, content: m[2] };
      } else if (cur && line.trim()) {
        cur.content += `\n${line.trim()}`;
      }
    }
    if (cur) lineItems.push(cur);
    if (lineItems.length) items = lineItems;
  }

  if (!items) {
    const content = stripNamePrefix(text, names);
    return content && participants[0]
      ? [{ characterId: participants[0].id, content }]
      : [];
  }

  const out = [];
  for (const item of items) {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) continue;
    // v94.5:歸戶改模糊解析(正規化+唯一命中)——舊版裸 includes 認不出帶表符卡名/簡稱,
    // 認不出=整則靜默丟棄(「訊息被吃掉」實案)
    const c = resolveParticipant(item.name, participants);
    if (!c) continue;
    out.push({ characterId: c.id, content: stripNamePrefix(item.content, names) });
    if (out.length >= maxReplies) break;
  }
  return out;
}

/**
 * v94.5:參與者模糊解析——正規化(去非中英數)後:精確相等優先;否則互為包含(≥2字)
 * 且「唯一命中」才算;歧義=null(寧可跳過,不可歸錯戶)。
 */
function resolveParticipant(rawName, participants) {
  const bare = (x) => String(x || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
  const nb = bare(rawName);
  if (!nb) return null;
  const exact = participants.find((p) => bare(p.name) === nb);
  if (exact) return exact;
  // 包含比對不設長度門檻(單字卡名「甲」要能吃「甲同學」——既有斷言守著),
  // 安全閥=唯一命中:兩人以上都像就放棄,寧可跳過不歸錯戶。
  const hits = participants.filter((p) => {
    const pb = bare(p.name);
    return pb && (pb.includes(nb) || nb.includes(pb));
  });
  return hits.length === 1 ? hits[0] : null;
}
