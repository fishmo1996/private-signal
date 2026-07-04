/**
 * modules/voice.js
 * 語音訊息:可插拔的 TTS 供應商架構。
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

/** 從 AI 輸出偵測「[語音]」標記:回傳 {content, voice}。 */
export function extractVoiceTag(text) {
  const t = String(text || '');
  const m = t.match(/^\s*(?:\[語音\]|【語音】)\s*/);
  if (m) return { content: t.slice(m[0].length).trim(), voice: true };
  return { content: t, voice: false };
}

/** 估算語音秒數(顯示用,粗抓每秒 5 字)。 */
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
