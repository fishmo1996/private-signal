/**
 * modules/api.js
 * API / LLM 連線設定層。
 * 注意:目前「對話回覆」仍是本機 mock;這裡先提供設定介面、連線測試與模型列表,
 * 讓之後串接時 buildPrompt → 真實 API 只差最後一步。
 *
 * 金鑰只存在本機瀏覽器的 IndexedDB,不會上傳任何地方;
 * 但若日後部署到 GitHub Pages 供他人使用,請改走 serverless proxy,勿讓金鑰出現在前端。
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
  return state.apiConfig;
}

export function defaultApiConfig() {
  return {
    provider: 'openai',
    apiKey: '',
    model: '',
    baseUrl: '',                 // custom 供應商用
    maxReplyChars: { dm: 800, group: 1200, story: 4000 }, // 每模式一則回覆的字數上限
    contextBudget: 20000,        // 上下文預算(概略 token 數,供未來裁切用)
    useRealApi: false,           // 總開關:開啟後對話使用真實 AI
    modelList: [],               // 「取得最新模型」的快取,供下拉選單使用
    temperature: 1.0,            // 溫度:創作建議 0.9~1.2
    topP: 0.95,
    thinkingBudget: '',          // Gemini 思考預算:留空=模型預設,0=關閉思考(省額度)
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
 * 部分供應商可能擋瀏覽器直連(CORS),失敗時會誠實回報,不影響手動填模型名。
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

/** 連線測試:能列出模型就算通。 */
export async function testConnection(cfg = getApiConfig()) {
  if (!cfg.apiKey && cfg.provider !== 'custom') {
    return { ok: false, message: '請先填入 API 金鑰' };
  }
  const r = await listModels(cfg);
  return r.ok
    ? { ok: true, message: `連線成功,共 ${r.models.length} 個模型可用` }
    : { ok: false, message: r.message };
}

/* ------------------------------------------------------------
 * 真實 AI 回覆(目前僅私訊 DM 使用)。
 * ------------------------------------------------------------ */

/** 模型名稱正規化:去空白、去 models/ 前綴(Gemini 清單常見)。 */
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

/** 依供應商組出聊天請求(純函式,便於測試)。 */
export function buildChatRequest(cfg, { system, messages, meta }) {
  const base = cfg.provider === 'custom'
    ? String(cfg.baseUrl || '').replace(/\/+$/, '')
    : PROVIDERS[cfg.provider]?.base || '';
  // 中文約 1 字 1~2 token,寬鬆抓 2 倍再設上限
  const maxTokens = Math.min(8192, Math.max(256, Math.round((meta?.maxReplyChars || 800) * 2)));

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
export async function generateReply(cfg, prompt) {
  const model = normalizeModel(cfg.provider, cfg.model);
  if (!model) return { ok: false, message: '尚未設定模型,請到設定挑選' };
  if (/\s/.test(model) || (cfg.provider === 'gemini' && /[A-Z]/.test(model))) {
    return {
      ok: false,
      message: `「${cfg.model}」看起來是顯示名稱,不是 API 模型 id。請到設定按「↻ 取得最新模型」,從下拉選單挑選(正確格式像 gemini-flash-lite-latest)`,
    };
  }
  try {
    const req = buildChatRequest(cfg, prompt);
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
    });
    if (!res.ok) {
      const hint = { 401: '金鑰無效', 403: '金鑰無權限', 429: '達到速率/每日額度限制,稍後再試' }[res.status] || '';
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* noop */ }
      return { ok: false, message: `HTTP ${res.status}${hint ? `(${hint})` : ''}${detail ? `:${detail.slice(0, 120)}` : ''}` };
    }
    const data = await res.json();
    const text = extractReplyText(cfg.provider, data).trim();
    if (!text) return { ok: false, message: '模型回傳了空內容(可能被安全過濾或輸出長度不足)' };
    const cap = prompt.meta?.maxReplyChars || 800;
    return { ok: true, text: text.length > cap ? `${text.slice(0, cap)}…` : text };
  } catch (err) {
    return { ok: false, message: `連線失敗:${err.message}` };
  }
}

/* ------------------------------------------------------------
 * 回覆後處理
 * ------------------------------------------------------------ */

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 刮掉模型愛加的「名字:」前綴(整段開頭與每行開頭都處理;容忍名稱前後空白、粗體與引號包裹)。 */
export function stripNamePrefix(text, names = []) {
  let out = String(text || '');
  const list = (Array.isArray(names) ? names : [names])
    .filter(Boolean)
    .map((n) => String(n).trim())
    .filter(Boolean);
  for (const name of list) {
    const re = new RegExp(
      `^\\s*[*_「『\\[(]*\\s*${escapeRegex(name)}\\s*[」』\\])*_]*\\s*[::]\\s*`,
      'gm',
    );
    out = out.replace(re, '').replace(re, ''); // 刮兩次,處理「名字:名字:」的怪輸出
  }
  return out.trim();
}

/**
 * 解析群聊的 JSON 回覆 → [{characterId, content}](最多 3 則)。
 * 模型偶爾會包 markdown 圍欄或講廢話,盡量撈出 JSON;
 * 真的解析不了就把整段當成第一位參與者的單則回覆,不浪費這次呼叫。
 */
export function parseGroupReplies(text, participants) {
  const names = participants.map((c) => c.name);
  let raw = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) raw = raw.slice(start, end + 1);

  let items = null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) items = parsed;
  } catch { /* fallthrough */ }

  if (!items) {
    const content = stripNamePrefix(text, names);
    return content && participants[0]
      ? [{ characterId: participants[0].id, content }]
      : [];
  }

  const out = [];
  for (const item of items) {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) continue;
    const name = String(item.name || '').trim();
    const c = participants.find((p) => p.name === name)
      || participants.find((p) => name && (p.name.includes(name) || name.includes(p.name)));
    if (!c) continue;
    out.push({ characterId: c.id, content: stripNamePrefix(item.content, names) });
    if (out.length >= 3) break;
  }
  return out;
}
