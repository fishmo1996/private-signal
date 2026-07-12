/**
 * modules/voice.js
 * 語音訊息：可插拔的 TTS 供應商架構。
 * 目前內建 browser(Web Speech API,免費、點播才合成、零 token);
 * 之後想升級付費 TTS(男友嗓那種),實作同介面的 provider 掛進 PROVIDERS 即可,
 * UI 與「[語音] 標記」判斷邏輯完全不用動。
 */

import { getState, persist } from './state.js';

const hasSpeech = typeof globalThis.speechSynthesis !== 'undefined'
  && typeof globalThis.SpeechSynthesisUtterance !== 'undefined';

let currentUtterance = null;
let speakingKey = null;        // 正在播放的訊息 id(供 UI 顯示 ■)
let onStateChange = () => {};

export function setVoiceStateListener(fn) { onStateChange = fn || (() => {}); }
export function speakingMessageKey() { return speakingKey; }
export function ttsAvailable() { return hasSpeech; }

/** 裝置上的中文語音(zh-TW 優先排前)。回傳 [{voiceURI, name, lang}]。 */
export function listChineseVoices() {
  if (!hasSpeech) return [];
  const all = globalThis.speechSynthesis.getVoices() || [];
  const zh = all.filter((v) => /^zh/i.test(v.lang));
  zh.sort((a, b) => {
    const tw = (v) => (/tw|taiwan/i.test(v.lang) || /taiwan|臺灣|台灣/i.test(v.name) ? 0 : 1);
    return tw(a) - tw(b) || a.name.localeCompare(b.name);
  });
  return zh.map((v) => ({ voiceURI: v.voiceURI, name: v.name, lang: v.lang }));
}

/** 朗讀前清掉不適合唸出來的符號(動作括號保留內容、去 markdown 與 emoji 雜訊)。 */
export function speechText(text) {
  return String(text || '')
    .replace(/[*_`#>]/g, '')
    .replace(/\[語音\]|【語音】/g, '')
    .trim();
}

const PROVIDERS = {
  browser: {
    speak(text, voiceCfg = {}) {
      if (!hasSpeech) return false;
      const u = new SpeechSynthesisUtterance(speechText(text));
      const voices = globalThis.speechSynthesis.getVoices() || [];
      const v = voiceCfg.voiceURI ? voices.find((x) => x.voiceURI === voiceCfg.voiceURI) : null;
      if (v) u.voice = v;
      else {
        const zhTw = voices.find((x) => /zh[-_]TW/i.test(x.lang));
        if (zhTw) u.voice = zhTw;
        u.lang = 'zh-TW';
      }
      u.rate = Number(voiceCfg.rate) || 1;
      u.pitch = Number(voiceCfg.pitch) || 1;
      u.onend = () => { speakingKey = null; currentUtterance = null; onStateChange(); };
      u.onerror = () => { speakingKey = null; currentUtterance = null; onStateChange(); };
      currentUtterance = u;
      globalThis.speechSynthesis.cancel();
      globalThis.speechSynthesis.speak(u);
      return true;
    },
    stop() {
      if (hasSpeech) globalThis.speechSynthesis.cancel();
      currentUtterance = null;
    },
  },
  // custom: { speak, stop }   ← 之後付費 TTS 的插槽(照同介面實作即可)
};

/**
 * 播放/停止切換。key 用來讓 UI 知道哪一則在播。
 * @returns {boolean} 是否開始播放(false=停止或不支援)
 */
export function toggleSpeak(key, text, voiceCfg = {}) {
  const providerName = getState()?.settings?.ttsProvider || 'browser';
  const provider = PROVIDERS[providerName] || PROVIDERS.browser;
  if (speakingKey === key) {
    provider.stop();
    speakingKey = null;
    onStateChange();
    return false;
  }
  provider.stop();
  const ok = provider.speak(text, voiceCfg);
  speakingKey = ok ? key : null;
  onStateChange();
  return ok;
}

export function stopSpeaking() {
  const providerName = getState()?.settings?.ttsProvider || 'browser';
  (PROVIDERS[providerName] || PROVIDERS.browser).stop();
  speakingKey = null;
  onStateChange();
}

/** 從 AI 輸出尾端偵測「[心情:x]」標記：回傳 {content, mood}。 */
export function extractMoodTag(text) {
  const t = String(text || '');
  const m = t.match(/\n?\s*(?:\[|【)心情[::]\s*(\S{1,4}?)\s*(?:\]|】)\s*$/);
  if (m) return { content: t.slice(0, m.index).trim(), mood: m[1] };
  return { content: t, mood: null };
}

/** 提案 M:從輸出尾偵測「[狀態：一句話]」：回傳 {content, status}。>15 字或空=丟棄但仍剝除。 */
export function extractStatusTag(text) {
  const t = String(text || '');
  const m = t.match(/\n?\s*(?:\[|【)狀態[::]\s*([^\]】\n]{0,40}?)\s*(?:\]|】)\s*$/);
  if (!m) return { content: t, status: null };
  const raw = m[1].trim();
  const status = raw && raw.length <= 15 ? raw : null; // 壞格式寧可丟棄不硬塞
  return { content: t.slice(0, m.index).trim(), status };
}

/**
 * v71:尾部標記統一收割器。模型輸出結尾的「[標籤:內容]」行(不限順序、不限數量)
 * 一次收割:認識的(心情/狀態)各就各位;不認識的山寨標記(模型自創的 [好感度:x] 等)
 * 直接丟棄不裸露。取代「先抽心情再抽狀態」的順序依賴——舊做法要求標記在絕對結尾,
 * 模型把 [心情] 寫在 [狀態] 前面就全組 miss(擁有者截圖實案)。
 * 只收「尾部連續的標記行」,遇到第一個非標記行就停,正文中的括號不受影響。
 */
export function harvestTailTags(text) {
  const lines = String(text || '').split('\n');
  let mood = null;
  let status = null;
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) { end = i; continue; } // 尾部空行一併收掉
    const m = line.match(/^(?:\[|\u3010)([^:\uFF1A\]\u3011]{1,6})[:\uFF1A]\s*([^\]\u3011]*?)\s*(?:\]|\u3011)$/); // 冒號/括號全半形皆認(明確碼位)
    if (!m) break; // 非標記行:收割結束
    const tag = m[1].trim();
    const val = m[2].trim();
    if (tag === '心情' && val && [...val].length <= 4) mood = mood ?? val;
    else if (tag === '狀態') status = status ?? (val && val.length <= 15 ? val : null);
    // 其他標籤:丟棄(不裸露、不進訊息)
    end = i;
  }
  return { content: lines.slice(0, end).join('\n').trim(), mood, status };
}

/**
 * v77:全域標籤收割器(根源一)。v71 的 harvestTailTags 假設標籤在「尾部連續行」,
 * 但模型把多則訊息黏成一大塊時,[心情:x] 會被埋在合併大塊的行內/中間(擁有者截圖:
 * 標籤以訊息內容形式渲染、還污染了心聲路徑)。對策:先用全域 regex 從全文「任意位置」
 * 抽走認識的標籤(心情/狀態),再跑尾部收割清掉山寨標記。
 * 誤吃風險評估:正文要合法出現「[心情:🔥]」這種完整標籤格式幾乎不可能,
 * 一般中括號(如「[不是標記]」)因標籤名不符不受影響(有斷言)。
 */
const MOOD_TAG_G = /(?:\[|\u3010)\s*心情\s*[:\uFF1A]\s*([^\]\u3011\n]{1,8}?)\s*(?:\]|\u3011)/g;
const STATUS_TAG_G = /(?:\[|\u3010)\s*狀態\s*[:\uFF1A]\s*([^\]\u3011\n]{0,40}?)\s*(?:\]|\u3011)/g;
export function harvestTags(text) {
  let t = String(text || '');
  let mood = null;
  let status = null;
  t = t.replace(MOOD_TAG_G, (whole, v) => {
    const val = String(v).trim();
    if (!mood && val && [...val].length <= 4) mood = val;
    return ''; // 無論收不收,標籤本體一律從內容剝除,不裸露
  });
  t = t.replace(STATUS_TAG_G, (whole, v) => {
    const val = String(v).trim();
    if (!status && val && val.length <= 15) status = val; // >15 字丟棄但仍剝除(沿 v57 規格)
    return '';
  });
  const tail = harvestTailTags(t); // 尾部山寨標記([好感度:x] 等)仍由 v71 收割器丟棄
  return { content: tail.content, mood: mood ?? tail.mood, status: status ?? tail.status };
}

/** 從 AI 輸出偵測「[語音]」標記：回傳 {content, voice}。 */
export function extractVoiceTag(text) {
  const t = String(text || '');
  const m = t.match(/^\s*(?:\[語音\]|【語音】)\s*/);
  if (m) return { content: t.slice(m[0].length).trim(), voice: true };
  return { content: t, voice: false };
}

/** 估算語音秒數(顯示用，粗抓每秒 5 字)。 */
export function estimateSeconds(text) {
  return Math.max(1, Math.round(speechText(text).length / 5));
}

/** 設定某角色的聲音配置。 */
export async function setCharacterVoice(characterId, voiceCfg) {
  const c = getState().characters.find((x) => x.id === characterId);
  if (!c) return;
  c.voice = {
    voiceURI: voiceCfg.voiceURI || '',
    rate: Math.min(2, Math.max(0.5, Number(voiceCfg.rate) || 1)),
    pitch: Math.min(2, Math.max(0.5, Number(voiceCfg.pitch) || 1)),
  };
  await persist();
}
