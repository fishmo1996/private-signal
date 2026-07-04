/**
 * modules/home.js
 * 鎖定畫面與主畫面的內容產生器。
 * 這裡只產生 HTML 字串與時間文字;事件綁定交給 ui.js,避免模組互相依賴。
 */

import { getState, getConfig, getCharacter } from './state.js';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function clockString(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dateString(d = new Date()) {
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 星期${WEEKDAYS[d.getDay()]}`;
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function firstLine(text, max) {
  const t = String(text || '').trim().split('\n')[0];
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 主畫面 App 圖示定義(原創幾何字符 + CSS 色塊,不使用真實平台圖示)。 */
export const HOME_APPS = [
  { id: 'story',    label: '正文',   view: 'story-list', glyph: '❖', tone: 'c' },
  { id: 'album',    label: '相簿',   view: 'album',      glyph: '✧', tone: 'b' },
  { id: 'player',   label: '玩家',   view: 'player',     glyph: '✿', tone: 'g' },
  { id: 'worldbook', label: '世界書', view: 'worldbook',  glyph: '▤', tone: 'f' },
];

/** 底部 dock:最常用的四顆常駐。 */
export const DOCK_APPS = [
  { id: 'chat',     label: '聊天',   view: 'chat-friends', glyph: '◖◗', tone: 'a' },
  { id: 'social',   label: '社群',   view: 'social-feed',  glyph: '✶',  tone: 'b' },
  { id: 'people',   label: '聯絡人', view: 'people',       glyph: '◉',  tone: 'd' },
  { id: 'settings', label: '設定',   view: 'settings',     glyph: '◎',  tone: 'e' },
];

/** 鎖定畫面 HTML。點擊或向上滑動解鎖(由 ui.js 綁定)。 */
export function buildLockScreenHTML() {
  const cfg = getConfig();
  return `
    <div class="lock-screen" id="lockScreen" tabindex="0" role="button"
         aria-label="點擊或向上滑動解鎖">
      <div class="lock-halo" aria-hidden="true"></div>
      <div class="lock-clock">${clockString()}</div>
      <div class="lock-date">${dateString()}</div>
      <div class="lock-app">${esc(cfg.appName)}</div>
      <div class="lock-hint">
        <span class="lock-arrow" aria-hidden="true">︿</span>
        點擊或向上滑動解鎖
      </div>
    </div>`;
}

/** 主畫面 HTML:時間、日期、目前角色狀態卡、App 網格。 */
export function buildHomeHTML() {
  const state = getState();
  const current = (state.currentCharacterId && getCharacter(state.currentCharacterId))
    || state.characters[0]
    || null;

  const statusCard = (state.settings?.showStatusCard === false) ? '' : current
    ? `
      <button class="home-status" data-status-char="${esc(current.id)}"
              style="--c:${esc(current.themeColor)}" aria-label="查看 ${esc(current.name)}">
        <span class="avatar" style="--c:${esc(current.themeColor)}" aria-hidden="true">
          ${esc(current.avatarEmoji?.trim() || current.name.trim().slice(0, 1) || '·')}
        </span>
        <span class="home-status-text">
          <span class="home-status-name">${esc(current.name)}</span>
          <span class="home-status-line">${esc(firstLine(current.scenario, 18) || '在線上')}</span>
        </span>
      </button>`
    : `
      <button class="home-status empty" data-go="people" aria-label="前往新增角色">
        <span class="avatar" style="--c:#6b7280" aria-hidden="true">＋</span>
        <span class="home-status-text">
          <span class="home-status-name">還沒有角色</span>
          <span class="home-status-line">到「聯絡人」建立第一位</span>
        </span>
      </button>`;

  const customIcons = state.settings?.appIcons || {};
  const iconOf = (app) => `
    <button class="app-icon tone-${app.tone}" data-go="${esc(app.view)}" aria-label="開啟${esc(app.label)}">
      <span class="app-glyph ${customIcons[app.id] ? 'has-img' : ''}" aria-hidden="true">${
  customIcons[app.id] ? `<img src="${customIcons[app.id]}" alt="">` : app.glyph
}</span>
      <span class="app-label">${esc(app.label)}</span>
    </button>`;

  return `
    <div class="phone-home dock-layout">
      <div class="home-top big">
        <div class="home-clock">${clockString()}</div>
        <div class="home-date">${dateString()}</div>
      </div>
      ${statusCard}
      <div class="app-grid">${HOME_APPS.map(iconOf).join('')}</div>
      <div class="home-flex-space"></div>
      <div class="page-dots" aria-hidden="true"><i></i><i class="active"></i><i></i></div>
      <div class="home-dock">${DOCK_APPS.map(iconOf).join('')}</div>
    </div>`;
}
