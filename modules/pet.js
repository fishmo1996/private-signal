/**
 * modules/pet.js — 提案 L:桌面寵物。零 API 純前端。
 * 只住主畫面底部:隨機走走停停、偶爾坐下/趴睡;點擊冒罐頭台詞泡泡。
 * 計時器在 unmount 時清乾淨(參考 clockTimer 模式);
 * prefers-reduced-motion 時改靜態坐姿;jsdom 環境包 try/catch 不炸。
 */

import { getState } from './state.js';

let petTimer = null;
let bubbleTimer = null;
let petEl = null;

const DEFAULT_LINES = [
  '汪!',
  '汪汪!',
  '(搖尾巴)',
  '(歪頭)',
  '(把肚子翻給你)',
  '(蹭了蹭你的手)',
  '汪?(看向門口)',
  '(打了個大呵欠)',
  '(繞著你轉圈圈)',
  '(趴下,下巴貼地看著你)',
];

/** 內建簡筆狗 SVG(未上傳圖時的預設豬皮)。 */
const FALLBACK_SVG = `<svg viewBox="0 0 64 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <ellipse cx="34" cy="34" rx="18" ry="11" fill="#e8d5a3"/>
  <circle cx="16" cy="24" r="10" fill="#e8d5a3"/>
  <path d="M9 16 Q6 8 12 12 Z" fill="#c9b078"/>
  <path d="M22 15 Q26 7 27 13 Z" fill="#c9b078"/>
  <circle cx="13" cy="23" r="1.6" fill="#4a3f2f"/>
  <circle cx="19" cy="23" r="1.6" fill="#4a3f2f"/>
  <ellipse cx="16" cy="28" rx="2.4" ry="1.6" fill="#4a3f2f"/>
  <path d="M50 30 Q58 22 56 32" stroke="#c9b078" stroke-width="4" fill="none" stroke-linecap="round"/>
  <rect x="24" y="42" width="4" height="6" rx="2" fill="#c9b078"/>
  <rect x="40" y="42" width="4" height="6" rx="2" fill="#c9b078"/>
</svg>`;

export function petSettings() {
  const s = getState().settings;
  if (!s.pet) {
    s.pet = { enabled: true, name: '豬皮', lines: [...DEFAULT_LINES], imgStand: null, imgWalk: null, imgSit: null };
  }
  return s.pet;
}

function reducedMotion() {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; } catch { return false; }
}

function imgFor(pose) {
  const p = petSettings();
  const map = { stand: p.imgStand, walk: p.imgWalk || p.imgStand, sit: p.imgSit || p.imgStand };
  const src = map[pose];
  return src ? `<img src="${src}" alt="">` : FALLBACK_SVG;
}

function speak() {
  if (!petEl) return;
  const lines = petSettings().lines?.length ? petSettings().lines : DEFAULT_LINES;
  const line = lines[Math.floor(Math.random() * lines.length)];
  const bubble = petEl.querySelector('.pet-bubble');
  if (!bubble) return;
  bubble.textContent = line;
  bubble.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { if (bubble) bubble.hidden = true; }, 2500);
}

function setPose(pose) {
  if (!petEl) return;
  const body = petEl.querySelector('.pet-body');
  if (body) body.innerHTML = imgFor(pose);
  petEl.dataset.pose = pose;
}

function wander(container) {
  if (!petEl || !container) return;
  const roll = Math.random();
  if (roll < 0.45) {
    // 走:挑個新位置,方向翻面
    const max = Math.max(40, (container.clientWidth || 320) - 70);
    const x = 10 + Math.random() * (max - 10);
    const cur = parseFloat(petEl.style.left) || 20;
    petEl.style.transform = x < cur ? 'scaleX(-1)' : 'scaleX(1)';
    petEl.style.left = `${x}px`;
    setPose('walk');
  } else if (roll < 0.8) {
    setPose('stand');
  } else {
    setPose('sit');
  }
}

/** 掛上寵物(只在主畫面呼叫)。jsdom 安全:全程 try/catch。 */
export function mountPet(container) {
  try {
    unmountPet();
    const p = petSettings();
    if (!p.enabled || !container) return;
    petEl = document.createElement('div');
    petEl.className = 'desktop-pet';
    petEl.setAttribute('role', 'img');
    petEl.setAttribute('aria-label', p.name || '桌面寵物');
    petEl.innerHTML = `<div class="pet-bubble" hidden></div><div class="pet-body"></div>`;
    petEl.style.left = '24px';
    container.appendChild(petEl);
    petEl.addEventListener('click', speak);
    if (reducedMotion()) {
      petEl.classList.add('pet-static');
      setPose('sit');
      return;
    }
    setPose('stand');
    petTimer = setInterval(() => {
      try { wander(container); } catch { /* jsdom 無尺寸也不炸 */ }
    }, 2600 + Math.random() * 1800);
  } catch { /* 任何環境問題都不影響主畫面 */ }
}

/** 卸下寵物與計時器(離開主畫面時必呼叫,參考 clockTimer 清理模式)。 */
export function unmountPet() {
  if (petTimer) { clearInterval(petTimer); petTimer = null; }
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
  if (petEl) { petEl.remove(); petEl = null; }
}
