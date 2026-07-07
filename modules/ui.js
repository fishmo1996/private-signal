/**
 * modules/ui.js
 * 所有畫面渲染與互動。
 * 結構：鎖定畫面 → 主畫面(App 網格)→ 各 App 頁面(聊天/社群/正文/角色與玩家/設定)。
 * 右側為預設收合的「管理輔助面板」(記憶管理與開發資訊),不屬於手機本體。
 */

import {
  getState, getConfig, persist, resetAll,
  getCharacter, getRoom, getRoomMessages, getRoomCharacters,
} from './state.js';
import {
  createCharacter, updateCharacter, deleteCharacter,
  createGroup, createStory, deleteRoom,
  findDmRoom, openRoom,
} from './rooms.js';
import { sendUserMessage, isRoomBusy, editMessage, deleteMessage, regenerateLastReply, refreshChats , selfChat, generateInnerVoice } from './chat.js';
import { addRoomMember, removeRoomMember, createPeek, branchRoom } from './rooms.js';
import {
  createMemoryCandidate, addMemory, editMemory, togglePin, deleteMemory, generateSummaryCandidates, commitSummary, archiveChapter, messagesSinceSummary,
} from './memory.js';
import {
  getPosts, getPost, getComments, createPost, addComment, toggleLike,
  deletePost, editPost, ensureSeedPosts, generateSocialReplies,
  refreshFeed, refreshCooldownLeft,
} from './social.js';
import {
  initNavigation, isLocked, unlock, getView, navigate, back, parentView,
} from './navigation.js';
import { buildLockScreenHTML, buildHomeHTML, clockString, HOME_APPS, DOCK_APPS } from './home.js';
import { compressAvatar, compressBackground, compressPhoto } from './image.js';
import { getDiaries, generateDiary, deleteDiary } from './diary.js';
import { getPhotos, addPhoto, updatePhoto, deletePhoto } from './album.js';
import { searchAll } from './search.js';
import {
  ttsAvailable, listChineseVoices, toggleSpeak, speakingMessageKey,
  setVoiceStateListener, estimateSeconds, setCharacterVoice,
} from './voice.js';
import { exportRoomJson, parseRoomImport, importRoom } from './roombackup.js';
import { exportStoryBook } from './bookexport.js';
import { generatePhonePeek, phonePeeksFor, PEEK_TYPES } from './phonepeek.js';
import { mountPet, unmountPet, petSettings } from './pet.js';
import { exportCharacterPack, exportCharacterCardV2, parseCharacterImport, importCharacter } from './charcard.js';
import { exportStateJson, importStateJson } from './state.js';
import {
  getPersonas, getPersona, defaultPersona, personaForRoom,
  createPersona, updatePersona, deletePersona, syncPlayerMirror,
} from './persona.js';
import { buildPrompt, buildGroupPrompt, buildStoryPrompt, buildPeekPrompt } from './prompt.js';
import {
  getWorldbooks, getWorldbook, createWorldbook, updateWorldbook, deleteWorldbook,
  addEntry, updateEntry, deleteEntry, parseKeywords,
  exportWorldbookJson, exportAllWorldbooksJson, parseWorldbookImport, importWorldbooks,
} from './worldbook.js';
import {
  PROVIDERS, getApiConfig, saveApiConfig, savePreset, loadPreset,
  testConnection, listModels,
} from './api.js';
import { diagnostics } from '../utils/indexeddb.js';

const els = {};
let panelTab = 'memory';      // memory | dev
let typingBy = '';
let editingMemoryId = null;
const openMemGroups = new Set(); // 總倉庫分組的展開狀態(重繪不彈回)
let socialTypingBy = '';      // 社群留言中的「正在輸入」提示
let socialError = '';         // 社群 AI 留言失敗時的提示(顯示一次後清除)
let replyTargetId = null;     // 正在行內回覆的留言 id(回覆框長在該留言底下)
let clockTimer = null;

/* ---------------- 小工具 ---------------- */

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 較口語的相對時間(社群列表用)。 */
function fmtAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '剛剛';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  return `${Math.floor(hr / 24)} 天前`;
}

function firstLine(text, max) {
  const t = String(text || '').trim().split('\n')[0];
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** authorId 為 'player' 或角色 id 的頭像。 */
function avatarHtml(authorId, cls = '') {
  if (authorId === 'player') {
    const p = getState().player;
    if (p.avatarImage) {
      return `<span class="avatar ${cls} img" aria-hidden="true"><img src="${p.avatarImage}" alt=""></span>`;
    }
    const name = p.playerName || '你';
    return `<span class="avatar ${cls} player" style="--c:#a9b4c8" aria-hidden="true">${esc(name.trim().slice(0, 1) || '你')}</span>`;
  }
  const c = typeof authorId === 'object' ? authorId : getCharacter(authorId);
  if (!c) return `<span class="avatar ${cls}" style="--c:#6b7280" aria-hidden="true">?</span>`;
  if (c.avatarImage) {
    return `<span class="avatar ${cls} img" style="--c:${esc(c.themeColor)}" aria-hidden="true"><img src="${c.avatarImage}" alt=""></span>`;
  }
  const glyph = c.avatarEmoji?.trim() || c.name.trim().slice(0, 1) || '·';
  return `<span class="avatar ${cls}" style="--c:${esc(c.themeColor)}" aria-hidden="true">${esc(glyph)}</span>`;
}

function personaAvatarHtml(persona, cls = '') {
  if (!persona) return `<span class="avatar ${cls}" style="--c:#a9b4c8" aria-hidden="true">你</span>`;
  if (persona.avatarImage) {
    return `<span class="avatar ${cls} img" aria-hidden="true"><img src="${persona.avatarImage}" alt=""></span>`;
  }
  return `<span class="avatar ${cls} player" style="--c:#a9b4c8" aria-hidden="true">${esc(persona.name.trim().slice(0, 1) || '你')}</span>`;
}

function authorName(authorId) {
  if (authorId === 'player') return getState().player.playerName || '你';
  const c = getCharacter(authorId);
  return c ? c.name : '(已離開的角色)';
}

function currentAccent() {
  const state = getState();
  const room = state.currentRoomId ? getRoom(state.currentRoomId) : null;
  if (room) {
    const chars = getRoomCharacters(room);
    if (chars[0]) return chars[0].themeColor;
  }
  const c = state.currentCharacterId ? getCharacter(state.currentCharacterId) : null;
  return c ? c.themeColor : '#8ea7ff';
}

/**
 * App 頁面共用的標題列：明顯的返回鍵 + 標題 + 右側動作。
 * 返回鍵會標出目的地(例如「← 主畫面」「← 聊天」),不做成看不懂的小圖示。
 */
function appHeader(title, { rightHtml = '', subtitle = '', leadingHtml = '' } = {}) {
  const BACK_LABELS = {
    home: '主畫面',
    'chat-friends': '聊天',
    'chat-peek': '聊天',
    'chat-rooms': '聊天',
    'social-feed': '社群',
    'story-list': '正文',
    people: '角色',
  };
  const backLabel = BACK_LABELS[parentView()] || '返回';
  return `
    <div class="phone-header">
      <button class="back-btn" id="btnBack" aria-label="返回${esc(backLabel)}">← ${esc(backLabel)}</button>
      ${leadingHtml}
      <div class="phone-title-block">
        <div class="phone-title">${esc(title)}</div>
        ${subtitle ? `<div class="phone-status">${esc(subtitle)}</div>` : ''}
      </div>
      ${rightHtml || '<span class="phone-header-spacer"></span>'}
    </div>`;
}

function bindBack(root = els.phoneScreen) {
  const btn = root.querySelector('#btnBack');
  if (btn) {
    btn.addEventListener('click', async () => {
      await back();
      renderAll();
    });
  }
}

/* ---------------- 初始化 ---------------- */

/** 套用外觀主題到整個頁面(含手機外背景)。 */
export function applyTheme() {
  const theme = getState().settings.theme || 'dusk';
  document.body.classList.toggle('theme-sage', theme === 'sage');
  document.body.classList.toggle('theme-berry', theme === 'berry');
  const fs = getState()?.settings?.fontScale || 'normal';
  document.body.classList.remove('font-sm', 'font-lg', 'font-xl');
  if (fs === 'small') document.body.classList.add('font-sm');
  if (fs === 'large') document.body.classList.add('font-lg');
  if (fs === 'xlarge') document.body.classList.add('font-xl');
}

export function initUI() {
  setVoiceStateListener(() => {
    const v = getView();
    if (v === 'chat-room' || v === 'story-room') renderMessages();
  });
  applyTheme();
  els.phone = document.getElementById('phone');
  els.phoneScreen = document.getElementById('phoneScreen');
  els.panel = document.getElementById('panel');
  els.panelTabs = document.getElementById('panelTabs');
  els.panelBody = document.getElementById('panelBody');
  els.modalRoot = document.getElementById('modalRoot');
  els.panelToggle = document.getElementById('panelToggle');

  els.panelToggle.addEventListener('click', () => {
    const app = document.getElementById('app');
    app.classList.toggle('panel-collapsed');
    const collapsed = app.classList.contains('panel-collapsed');
    els.panelToggle.textContent = collapsed ? '⟨ 管理' : '管理 ⟩';
    els.panelToggle.setAttribute('aria-expanded', String(!collapsed));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // 鎖屏與主畫面的時鐘，每 20 秒對時一次
  clockTimer = setInterval(() => {
    const v = getView();
    if (v === 'lock') {
      const clock = els.phoneScreen.querySelector('.lock-clock');
      if (clock) clock.textContent = clockString();
    } else if (v === 'home') {
      const clock = els.phoneScreen.querySelector('.home-clock');
      if (clock) clock.textContent = clockString();
    }
  }, 20000);

  renderAll();
}

export function renderAll() {
  renderPhone();
  renderPanel();
}

/* ---------------- 手機頁面路由 ---------------- */

function renderPhone() {
  els.phone.style.setProperty('--accent', currentAccent());
  const view = getView();
  if (view !== 'home') unmountPet(); // 離開主畫面必清計時器(clockTimer 同款紀律)

  switch (view) {
    case 'lock': renderLockScreen(); break;
    case 'home': renderHome(); break;
    case 'chat-friends': renderChatApp('friends'); break;
    case 'chat-rooms': renderChatApp('rooms'); break;
    case 'chat-peek': renderChatApp('peek'); break;
    case 'chat-room': renderRoomView(); break;
    case 'social-feed': renderSocialFeed(); break;
    case 'social-post': renderSocialPost(); break;
    case 'story-list': renderStoryList(); break;
    case 'story-room': renderRoomView(); break;
    case 'people': renderPeople(); break;
    case 'player': renderPlayer(); break;
    case 'album': renderAlbum(); break;
    case 'search': renderSearch(); break;
    case 'people-character': renderCharacterDetail(); break;
    case 'character-diary': renderCharacterDiary(); break;
    case 'char-phone': renderCharPhoneList(); break;
    case 'char-phone-detail': renderCharPhoneDetail(); break;
    case 'settings': renderSettings(); break;
    case 'worldbook': renderWorldbookList(); break;
    case 'worldbook-detail': renderWorldbookDetail(); break;
    default: renderHome();
  }
}

/* ---------------- A. 鎖定畫面 ---------------- */

function applyPhoneBackground(el) {
  const bg = getState().settings.bgImage;
  if (bg && el) {
    el.style.backgroundImage = `linear-gradient(rgba(10,13,20,0.35), rgba(10,13,20,0.45)), url(${bg})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  }
}

function renderLockScreen() {
  els.phoneScreen.innerHTML = buildLockScreenHTML();
  applyPhoneBackground(els.phoneScreen.querySelector('.lock-screen'));
  const lock = els.phoneScreen.querySelector('#lockScreen');

  const doUnlock = () => {
    unlock();
    renderAll();
  };

  // 點擊解鎖
  lock.addEventListener('click', doUnlock);
  // 鍵盤(Enter / 空白 / 上)解鎖
  lock.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowUp') doUnlock();
  });
  // 滑鼠拖曳或觸控「向上滑」解鎖
  let startY = null;
  const onStart = (y) => { startY = y; };
  const onEnd = (y) => {
    if (startY !== null && startY - y > 40) doUnlock();
    startY = null;
  };
  lock.addEventListener('pointerdown', (e) => onStart(e.clientY));
  lock.addEventListener('pointerup', (e) => onEnd(e.clientY));
  // 滾輪向上也可解鎖
  lock.addEventListener('wheel', (e) => {
    if (e.deltaY < -10) doUnlock();
  }, { passive: true });
  lock.focus();
}

/* ---------------- B. 主畫面 ---------------- */

function renderHome() {
  els.phoneScreen.innerHTML = buildHomeHTML();
  applyPhoneBackground(els.phoneScreen.querySelector('.phone-home'));
  mountPet(els.phoneScreen.querySelector('.phone-home')); // 提案 L:寵物只住主畫面

  els.phoneScreen.querySelectorAll('[data-go]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await navigate(btn.dataset.go);
      renderAll();
    });
  });
  const statusBtn = els.phoneScreen.querySelector('[data-status-char]');
  if (statusBtn) {
    statusBtn.addEventListener('click', async () => {
      await navigate('people-character', { characterId: statusBtn.dataset.statusChar });
      renderAll();
    });
  }
}

/* ---------------- C. 聊天 App ---------------- */

/** 聊天 App:好友(DM)與聊天室(群聊)兩個分頁，底部可切換。 */
function renderChatApp(tab) {
  const state = getState();

  const rightHtml = tab === 'friends'
    ? '<button class="header-action" id="btnGlobalSearch">🔍</button>'
      + '<button class="header-action" id="btnChatRefresh">↻</button>'
      + '<button class="header-action" id="btnHeaderAdd">＋ 新增角色</button>'
    : (tab === 'peek'
      ? '<button class="header-action" id="btnHeaderAdd">＋ 建立旁觀群</button>'
      : '<button class="header-action" id="btnHeaderAdd">＋ 建立聊天室</button>');

  const listHtml = tab === 'friends' ? friendRowsHtml() : (tab === 'peek' ? peekRowsHtml() : groupRowsHtml());

  els.phoneScreen.innerHTML = `
    ${appHeader('聊天', { rightHtml })}
    <div class="api-status" id="chatStatus" role="status" style="padding:0 16px"></div>
    <div class="phone-list with-tabbar">${listHtml}</div>
    <div class="tabbar" role="tablist" aria-label="聊天分頁">
      <button class="tabbar-item ${tab === 'friends' ? 'active' : ''}" data-tab="chat-friends" role="tab" aria-selected="${tab === 'friends'}">
        <span class="tabbar-glyph" aria-hidden="true">◖◗</span>好友
      </button>
      <button class="tabbar-item ${tab === 'rooms' ? 'active' : ''}" data-tab="chat-rooms" role="tab" aria-selected="${tab === 'rooms'}">
        <span class="tabbar-glyph" aria-hidden="true">◍</span>聊天室
      </button>
      <button class="tabbar-item ${tab === 'peek' ? 'active' : ''}" data-tab="chat-peek" role="tab" aria-selected="${tab === 'peek'}">
        <span class="tabbar-glyph" aria-hidden="true">👁</span>旁觀
      </button>
    </div>`;

  bindBack();
  els.phoneScreen.querySelectorAll('.tabbar-item').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await navigate(btn.dataset.tab);
      renderAll();
    });
  });
  els.phoneScreen.querySelector('#btnHeaderAdd').addEventListener('click', () => {
    if (tab === 'friends') openCharacterModal({ openDmAfter: true });
    else if (tab === 'peek') openPeekModal();
    else openGroupModal();
  });
  const searchBtn = els.phoneScreen.querySelector('#btnGlobalSearch');
  if (searchBtn) {
    searchBtn.addEventListener('click', async () => { await navigate('search'); renderAll(); });
  }
  const chatRefresh = els.phoneScreen.querySelector('#btnChatRefresh');
  if (chatRefresh) {
    chatRefresh.addEventListener('click', async () => {
      const status = els.phoneScreen.querySelector('#chatStatus');
      chatRefresh.disabled = true;
      status.className = 'api-status';
      status.textContent = '看看有沒有人想找你…';
      const r = await refreshChats();
      if (getView() !== 'chat-friends') return;
      renderPhone();
      const st2 = els.phoneScreen.querySelector('#chatStatus');
      if (!st2) return;
      if (!r.ok) { st2.className = 'api-status err'; st2.textContent = r.message; return; }
      st2.className = 'api-status ok';
      st2.textContent = r.from ? `${r.from} 傳了訊息給你` : '暫時沒有人傳訊息';
    });
  }
  els.phoneScreen.querySelectorAll('[data-open-room]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await openRoom(btn.dataset.openRoom);
      renderAll();
    });
  });
  const emptyAdd = els.phoneScreen.querySelector('#btnEmptyAdd');
  if (emptyAdd) {
    emptyAdd.addEventListener('click', () => {
      if (tab === 'friends') openCharacterModal({ openDmAfter: true });
      else openGroupModal();
    });
  }
}

/** 好友分頁：每位角色一列(頭像、名字、最近訊息預覽、時間)。 */
function friendRowsHtml() {
  const state = getState();
  if (!state.characters.length) {
    return `
      <div class="list-empty">
        還沒有好友。<br>新增角色後，每位角色都會有一間專屬私訊。
        <button class="primary-btn slim" id="btnEmptyAdd">＋ 新增角色</button>
      </div>`;
  }
  return state.characters.flatMap((c) => {
    const dms = state.rooms.filter((r) => r.type === 'dm' && r.participantIds.includes(c.id));
    return dms.map((dm) => rowOfDm(c, dm));
  }).join('');
}

function rowOfDm(c, dm) {
  const state = getState();
  const msgs = state.messagesByRoom[dm.id] || [];
    const last = msgs[msgs.length - 1];
    const preview = last
      ? (last.missedCall ? '☎ 未接來電' : firstLine(last.content, 20))
      : (c.firstMessage ? firstLine(c.firstMessage, 20) : '開始聊天吧');
    return `
      <button class="list-row" data-open-room="${esc(dm.id)}">
        ${avatarHtml(c)}
        <span class="list-main">
          <span class="list-title">${esc(c.name)}${c.label?.trim() ? ` <span class="char-label">${esc(c.label.trim())}</span>` : ''}${dm.branchedFrom ? ' <span class="branch-tag">⑂分岔</span>' : ''}${getState().settings.moodEmoji !== false && dm.mood?.emoji ? ` ${dm.mood.emoji}` : ''}${dm.unread ? ' <span class="unread-dot" aria-label="未讀"></span>' : ''}</span>
          ${c.status?.text ? `<span class="char-status">${esc(c.status.text)}</span>` : ''}
          <span class="list-preview">${esc(preview)}</span>
        </span>
        ${last ? `<span class="list-time">${fmtTime(last.createdAt)}</span>` : ''}
      </button>`;
}


/** 旁觀分頁：角色們自己的群組，你只能偷看。 */
function peekRowsHtml() {
  const state = getState();
  const peeks = state.rooms.filter((r) => r.type === 'peek');
  if (!peeks.length) {
    return `<div class="list-empty">還沒有旁觀群。<br>建一個「你不在裡面」的群，按 ↻ 偷看他們聊什麼。</div>`;
  }
  return peeks.map((r) => {
    const last = (state.messagesByRoom[r.id] || []).slice(-1)[0];
    const preview = last ? firstLine(last.content, 26) : '(還沒人開口——按 ↻ 讓他們聊起來)';
    return `
      <button class="list-row" data-open-room="${esc(r.id)}">
        <span class="avatar sm neutral" aria-hidden="true">👁</span>
        <span class="list-main">
          <span class="list-title">${esc(r.title)}</span>
          <span class="list-preview">${esc(preview)}</span>
        </span>
        ${last ? `<span class="list-time">${fmtTime(last.createdAt)}</span>` : ''}
      </button>`;
  }).join('');
}

/** 建立旁觀群 modal。 */
function openPeekModal() {
  const state = getState();
  if (state.characters.length < 2) {
    openModal('<h3>建立旁觀群</h3><p class="panel-note">至少需要兩個角色。</p>');
    return;
  }
  openModal(`
    <h3>建立旁觀群</h3>
    <p class="panel-note">你不在這個群裡：他們用共同知道的事聊天(公開資訊+共享記憶+彼此關係),按 ↻ 讓他們聊起來，你只能看。任何人的私訊祕密不會出現在這裡。</p>
    <form id="peekForm">
      <label class="field">群組名稱
        <input name="title" required maxlength="30" placeholder="例：三缺一(沒有你)">
      </label>
      <div class="field-label">成員(至少 2 位):</div>
      <div class="check-list">
        ${state.characters.map((c) => `
          <label class="check-field"><input type="checkbox" name="pm" value="${esc(c.id)}"> ${esc(c.name)}</label>`).join('')}
      </div>
      <div class="form-actions"><button type="submit" class="primary-btn slim">建立</button></div>
    </form>`, {
    onOpen(root) {
      root.querySelector('#peekForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const ids = [...root.querySelectorAll('input[name="pm"]:checked')].map((i) => i.value);
        if (ids.length < 2) { alert('至少勾選兩位'); return; }
        const title = String(new FormData(e.target).get('title'));
        closeModal();
        const room = await createPeek(title, ids);
        await openRoom(room.id);
        renderAll();
      });
    },
  });
}

/** 聊天室分頁：群聊列表。 */
function groupRowsHtml() {
  const state = getState();
  const groups = state.rooms.filter((r) => r.type === 'group');
  if (!groups.length) {
    return `
      <div class="list-empty">
        還沒有聊天室。<br>把兩位以上的角色拉進同一個房間，看他們怎麼接話。
        <button class="primary-btn slim" id="btnEmptyAdd">＋ 建立聊天室</button>
      </div>`;
  }
  return groups.map((r) => {
    const chars = getRoomCharacters(r);
    const msgs = state.messagesByRoom[r.id] || [];
    const last = msgs[msgs.length - 1];
    const preview = last ? firstLine(last.content, 20) : '尚無訊息';
    return `
      <button class="list-row" data-open-room="${esc(r.id)}">
        <span class="avatar group-face" aria-hidden="true">${chars.slice(0, 2).map((c) => esc(c.avatarEmoji?.trim() || c.name.slice(0, 1))).join('')}</span>
        <span class="list-main">
          <span class="list-title">${esc(r.title)}</span>
          <span class="list-preview">${esc(preview)}</span>
        </span>
        ${last ? `<span class="list-time">${fmtTime(last.createdAt)}</span>` : ''}
      </button>`;
  }).join('');
}

/* ---------------- 對話詳情(DM / 群聊 / 正文共用) ---------------- */

function renderRoomView() {
  const state = getState();
  const room = state.currentRoomId ? getRoom(state.currentRoomId) : null;
  if (!room) { navigate('home').then(renderAll); return; }

  const chars = getRoomCharacters(room);
  const isStory = room.type === 'story';
  const statusText = room.type === 'dm'
    ? (chars[0]?.status?.text ? `♪ ${firstLine(chars[0].status.text, 20)}` // v60:角色狀態掛進房內副標
      : chars[0]?.scenario ? firstLine(chars[0].scenario, 20) : '在線上')
    : room.type === 'group'
      ? `${chars.length} 位角色`
      : `場景 · ${chars.map((c) => c.name).join('、') || '無人在場'}`;

  const deletable = room.type !== 'dm';

  els.phoneScreen.innerHTML = `
    ${appHeader(room.type === 'dm' && getState().settings.moodEmoji !== false && room.mood?.emoji ? `${room.title} ${room.mood.emoji}` : room.title, {
      subtitle: statusText,
      leadingHtml: isStory ? '<span class="avatar sm neutral" aria-hidden="true">❖</span>' : avatarHtml(chars[0], 'sm'),
      rightHtml: ((room.type === 'group' || room.type === 'peek') ? '<button class="header-action" id="btnSelfChat">↻</button>' : '')
        + `<button class="header-action" id="btnRoomMore" aria-label="更多">⋯${
  messagesSinceSummary(room.id).length >= 30 ? '<span class="unread-dot" aria-label="建議摘要"></span>' : ''
}</button>`,
    })}
    <div class="messages ${isStory ? 'story-mode' : ''}" id="messages" aria-live="polite"></div>
    <button id="__noteProxy" hidden></button>
    ${deletable ? '<button id="__delProxy" hidden></button>' : ''}
    ${room.type === 'story' ? `
      <button class="status-bar-card ${room.statusBar?.trim() ? '' : 'empty'}" id="btnStatusBar" aria-label="編輯場景狀態">
        ${room.statusBar?.trim() ? esc(room.statusBar) : '⊕ 設定場景狀態(時間/地點/衣著…)'}
      </button>` : ''}
    ${room.type === 'peek' ? `
      <div class="peek-bar">👁 你在偷看——他們不知道你看得到。按右上 ↻ 讓他們聊起來。</div>`
    : `
    ${(getState().settings.quickReplies || []).length ? `
      <div class="quick-replies">
        ${getState().settings.quickReplies.map((q, i) => `<button class="mini-btn" data-quick="${i}">${esc(q)}</button>`).join('')}
      </div>` : ''}
    <div class="attach-preview" id="attachPreview" hidden>
      <img id="attachImg" alt="待傳送的圖片">
      <button class="mini-btn danger" id="btnAttachClear">移除</button>
    </div>
    <div class="composer">
      <input type="file" id="attachFile" accept="image/*" hidden>
      <button class="persona-chip" id="btnRoomPersona" aria-label="切換這個對話的人設" title="你在這個對話中的身分">
        ${personaAvatarHtml(personaForRoom(room), 'sm')}
      </button>
      <button class="icon-btn attach-btn" id="btnAttach" aria-label="附加圖片">＋</button>
      <textarea id="composerInput" rows="1"
        placeholder="${isStory ? '輸入台詞、行動或敘事…' : '輸入訊息…'}"
        aria-label="訊息輸入框"></textarea>
      <button class="send-btn" id="btnSend" aria-label="送出訊息">送出</button>
    </div>`}`;

  bindBack();
  els.phoneScreen.querySelector('#__noteProxy').addEventListener('click', () => openAuthorNoteModal(room));
  els.phoneScreen.querySelector('#btnRoomMore').addEventListener('click', () => {
    const items = [
      ...(room.type === 'dm' ? [['diary', '📔 日記']] : [['members', '👥 成員']]),
      ...(room.type === 'dm' && !getRoomCharacters(room)[0]?.noPhone ? [['peekphone', '👀 偷看他的手機']] : []),
      ['memory', `🧠 記憶${messagesSinceSummary(room.id).length >= 30 ? '(建議摘要)' : ''}`],
      ...(room.type === 'story' ? [['book', '📖 匯出成書(離線可讀)']] : []),
      ...(room.type !== 'peek' ? [['ivlog', '👁 心聲紀錄']] : []),
      ['note', `✏️ 備註與關係階段${(room.authorNote?.trim() || room.relationshipStage?.trim()) ? ' ●' : ''}`],
      ...(deletable ? [['delete', '🗑 刪除此對話']] : []),
    ];
    const branchNote = room.branchedFrom
      ? `<div class="panel-note">⑂ 分岔自:${esc(getRoom(room.branchedFrom.roomId)?.title || '(已刪除的對話)')}</div>`
      : '';
    openModal(`
      <h3>${esc(room.title)}</h3>
      ${branchNote}
      <div class="check-list">
        ${items.map(([k, label]) => `<button class="list-row" data-room-act="${k}"><span class="list-main"><span class="list-title">${label}</span></span></button>`).join('')}
      </div>`, {
      onOpen(root) {
        root.querySelectorAll('[data-room-act]').forEach((btn2) => btn2.addEventListener('click', async () => {
          closeModal();
          const act = btn2.dataset.roomAct;
          if (act === 'memory') openRoomMemoryModal(room);
          else if (act === 'note') els.phoneScreen.querySelector('#__noteProxy')?.click();
          else if (act === 'members') openRoomMembersModal(room);
          else if (act === 'diary') {
            const dmChar = getRoomCharacters(room)[0];
            if (dmChar) { await navigate('character-diary', { characterId: dmChar.id }); renderAll(); }
          } else if (act === 'peekphone') {
            const pc = getRoomCharacters(room)[0];
            if (pc) openPhonePeekModal(pc);
          } else if (act === 'ivlog') {
            openInnerVoiceLog(room);
          } else if (act === 'book') {
            const bookR = exportStoryBook(room.id);
            if (!bookR) { alert('這個房間沒有可匯出的內容'); return; }
            const blob = new Blob([bookR.html], { type: 'text/html;charset=utf-8' });
            const aEl = document.createElement('a');
            aEl.href = URL.createObjectURL(blob);
            aEl.download = bookR.filename;
            aEl.click();
            URL.revokeObjectURL(aEl.href);
          } else if (act === 'delete') els.phoneScreen.querySelector('#__delProxy')?.click();
        }));
      },
    });
  });
  const statusBarBtn = els.phoneScreen.querySelector('#btnStatusBar');
  if (statusBarBtn) {
    statusBarBtn.addEventListener('click', () => {
      openModal(`
        <h3>場景狀態</h3>
        <p class="panel-note">會置頂進入說書人 prompt(「以此為準」),劇情時間、地點、衣著、天氣都寫這裡；隨劇情推進隨手更新。</p>
        <textarea id="statusBarBox" rows="3" maxlength="300" placeholder="八月十二日 傍晚/海邊民宿的露台/阿莫：白色洋裝，頭髮還是濕的">${esc(room.statusBar || '')}</textarea>
        <div class="form-actions"><button class="primary-btn slim" id="btnStatusBarSave">儲存</button></div>`, {
        onOpen(root) {
          root.querySelector('#btnStatusBarSave').addEventListener('click', async () => {
            room.statusBar = root.querySelector('#statusBarBox').value.trim();
            await persist();
            closeModal();
            renderPhone();
          });
        },
      });
    });
  }
  const selfChatBtn = els.phoneScreen.querySelector('#btnSelfChat');
  if (selfChatBtn) {
    selfChatBtn.addEventListener('click', async () => {
      selfChatBtn.disabled = true;
      try {
      const r = await selfChat(room.id, (info) => {
        typingBy = info.typingBy ?? typingBy;
        if (getState().currentRoomId === room.id) renderMessages();
      });
      typingBy = '';
      if (getState().currentRoomId !== room.id) return;
      renderMessages();
      if (!r.ok && r.message) alert(r.message);
      } catch (err) {
        alert(`刷新出錯:${err.message}(請把這段訊息回報)`);
      }
      const btn2 = els.phoneScreen.querySelector('#btnSelfChat');
      if (btn2) btn2.disabled = false;
    });
  }

  if (deletable) {
    els.phoneScreen.querySelector('#__delProxy').addEventListener('click', () => {
      openConfirmModal({
        title: room.type === 'group' ? '刪除這個聊天室？' : '刪除這個場景？',
        body: `「${room.title}」與其中的訊息會被移除。這個動作無法復原。`,
        confirmLabel: '刪除',
        onConfirm: async () => {
          const backTo = room.type === 'group' ? 'chat-rooms' : 'story-list';
          await deleteRoom(room.id);
          await navigate(backTo);
          renderAll();
        },
      });
    });
  }

  const input = els.phoneScreen.querySelector('#composerInput');
  const sendBtn = els.phoneScreen.querySelector('#btnSend');

  els.phoneScreen.querySelector('#btnRoomPersona')?.addEventListener('click', () => {
    openPersonaSelectModal({
      title: `這個對話中，你是誰？`,
      current: room.personaId,
      onSelect: async (pid) => {
        room.personaId = pid;
        await persist();
        renderPhone();
      },
    });
  });

  // 附加圖片(自動壓縮到長邊 1024)
  let pendingImage = null;
  const attachFile = els.phoneScreen.querySelector('#attachFile');
  const attachPreview = els.phoneScreen.querySelector('#attachPreview');
  els.phoneScreen.querySelector('#btnAttach')?.addEventListener('click', () => attachFile.click());
  if (attachFile) attachFile.addEventListener('change', async () => {
    const file = attachFile.files[0];
    if (!file) return;
    try {
      pendingImage = await compressPhoto(file);
      attachPreview.hidden = false;
      els.phoneScreen.querySelector('#attachImg').src = pendingImage;
    } catch (err) { alert(err.message); }
    attachFile.value = '';
  });
  els.phoneScreen.querySelector('#btnAttachClear')?.addEventListener('click', () => {
    pendingImage = null;
    attachPreview.hidden = true;
  });

  const doSend = async () => {
    if (!input) return;
    const text = input.value;
    if ((!text.trim() && !pendingImage) || isRoomBusy(room.id)) return;
    const image = pendingImage;
    pendingImage = null;
    attachPreview.hidden = true;
    input.value = '';
    input.style.height = 'auto'; // v60:清空後高度歸位
    sendBtn.disabled = true;
    await sendUserMessage(room.id, text, (info) => {
      typingBy = info.typingBy || '';
      const s = getState();
      if (s.currentRoomId === room.id && (s.phoneView === 'chat-room' || s.phoneView === 'story-room')) {
        renderMessages();
      }
    }, image);
    typingBy = '';
    sendBtn.disabled = false;
    if (getState().currentRoomId === room.id) renderMessages();
  };

  if (sendBtn) sendBtn.addEventListener('click', doSend);
  els.phoneScreen.querySelectorAll('[data-quick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      input.value = getState().settings.quickReplies[Number(btn.dataset.quick)] || '';
      doSend();
    });
  });
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice()) {
      e.preventDefault();
      doSend();
    }
  });
  // v60:多行輸入自動長高(封頂約五行=120px,超過改為內部捲動)
  if (input) {
    const autoGrow = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };
    input.addEventListener('input', autoGrow);
    input.dataset.autogrow = '1';
    autoGrow();
  }
  if (input) input.focus();

  renderMessages();
}

/** 訊息視窗切片：只渲染最近 count 則(長對話效能)。 */
export function windowMessages(all, count) {
  const n = Math.max(0, all.length - Math.max(1, count));
  return { msgs: all.slice(n), hiddenCount: n };
}

const MSG_WINDOW_INIT = 60;
let pendingScrollAnchor = null;
const MSG_WINDOW_STEP = 80;
let msgWindow = { roomId: null, count: MSG_WINDOW_INIT };

function renderMessages() {
  const state = getState();
  const wrap = document.getElementById('messages');
  if (!wrap || !state.currentRoomId) return;
  const room = getRoom(state.currentRoomId);
  if (!room) return;
  if (msgWindow.roomId !== room.id) msgWindow = { roomId: room.id, count: MSG_WINDOW_INIT };
  wrap.classList.toggle('story-read', room.type === 'story');
  const allMsgs = getRoomMessages(room.id);
  const { msgs, hiddenCount } = windowMessages(allMsgs, msgWindow.count);
  const loadOlderHtml = hiddenCount > 0
    ? `<div class="load-older-wrap"><button class="ghost-btn slim" id="btnLoadOlder">↑ 載入更早的 ${Math.min(MSG_WINDOW_STEP, hiddenCount)} 則(還有 ${hiddenCount} 則)</button></div>`
    : '';
  const showTime = state.settings.showTimestamps !== false;

  const html = msgs.map((m, i) => {
    const time = showTime ? `<span class="msg-time">${fmtTime(m.createdAt)}</span>` : '';
    const isLast = i === msgs.length - 1; // 視窗永遠含最新一則，尾=全量尾
    const speakBtn = (m.role === 'character' || m.role === 'narrator') && ttsAvailable()
      ? `<button class="remember-btn" data-speak="${esc(m.id)}" aria-label="朗讀">${speakingMessageKey() === m.id ? '■' : '▶'}</button>`
      : '';
    const choicesHtml = (isLast && m.choices?.length && room.type === 'story') ? `
      <div class="story-choices">
        ${m.choices.map((cc, ci) => `<button class="choice-btn" data-choice="${ci}">▷ ${esc(cc)}</button>`).join('')}
      </div>` : '';
    const rememberBtn = `<button class="remember-btn" data-remember="${esc(m.id)}" aria-label="記住這件事">記住</button>`
      + `<button class="remember-btn" data-msg-edit="${esc(m.id)}" aria-label="編輯訊息">編輯</button>`
      + `<button class="remember-btn" data-msg-branch="${esc(m.id)}" aria-label="從這裡分岔">⑂</button>`
      + ((((room.type === 'dm' || room.type === 'group' || room.type === 'story') && m.role === 'character') || (room.type === 'story' && m.role === 'narrator'))
        ? `<button class="remember-btn" data-inner-voice="${esc(m.id)}" aria-label="心聲">👁${(m.innerVoice || (m.innerVoices && Object.keys(m.innerVoices).length)) ? '' : '?'}</button>` : '')
      + `<button class="remember-btn danger" data-msg-del="${esc(m.id)}" aria-label="刪除訊息">刪除</button>`;

    if (m.role === 'system') {
      return `<div class="msg-system">${esc(m.content)}
        <button class="remember-btn danger" data-msg-del="${esc(m.id)}" aria-label="刪除訊息">刪除</button></div>`;
    }
    if (m.role === 'narrator') {
      return `
        <div class="msg-narrator">
          <div class="narrator-body">${esc(m.content).replaceAll('\n', '<br>')}${choicesHtml}</div>
          ${Object.entries(m.innerVoices || {}).map(([cid, txt]) => `<div class="inner-voice" data-iv-card="${esc(m.id)}:${esc(cid)}" hidden><b>${esc(getCharacter(cid)?.name || '?')}</b>:${esc(txt).replaceAll('\n', '<br>')}</div>`).join('')}
          <div class="msg-meta">${time}${rememberBtn}${speakBtn}</div>
        </div>`;
    }
    const imgHtml = m.image ? `<img class="msg-image" src="${m.image}" alt="訊息圖片">` : '';
    const shareHtml = m.sharedPost ? `
      <div class="shared-post-card">
        <div class="shared-post-head">${esc(m.sharedPost.authorName)} 的貼文</div>
        ${m.sharedPost.image ? `<img class="shared-post-img" src="${m.sharedPost.image}" alt="">` : ''}
        <div class="shared-post-body">${esc(m.sharedPost.excerpt)}</div>
      </div>` : '';
    if (m.role === 'user') {
      return `
        <div class="msg-row user">
          <div class="bubble user-bubble">${shareHtml}${imgHtml}${esc(m.content).replaceAll('\n', '<br>')}</div>
          <div class="msg-meta">${time}${rememberBtn}${speakBtn}</div>
        </div>`;
    }
    const c = getCharacter(m.senderId);
    const nameLine = room.type === 'dm' ? '' : `<div class="msg-sender">${esc(c ? c.name : '角色')}</div>`;
    return `
      <div class="msg-row character">
        ${avatarHtml(c, 'sm')}
        <div class="msg-col">
          ${nameLine}
          ${m.missedCall ? `
            <div class="bubble char-bubble missed-call" style="--c:${esc(c ? c.themeColor : '#6b7280')}">
              <div class="mc-head">☎ 未接來電 · ${fmtTime(m.createdAt)}</div>
              ${m.voice ? `<button class="mc-play" data-speak-note="${esc(m.id)}">${speakingMessageKey() === m.id ? '■ 停止' : '▶ 播放留言'}</button>` : ''}
              <div class="mc-body">${esc(m.content).replaceAll('\n', '<br>')}</div>
            </div>${choicesHtml}`
    : m.voice ? `
            <div class="bubble char-bubble voice-note" style="--c:${esc(c ? c.themeColor : '#6b7280')}" data-speak-note="${esc(m.id)}">
              <span class="voice-play">${speakingMessageKey() === m.id ? '■' : '▶'}</span>
              <span class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
              <span class="voice-secs">${estimateSeconds(m.content)}"</span>
            </div>
            <div class="voice-transcript">${esc(m.content).replaceAll('\n', '<br>')}</div>${choicesHtml}`
    : `<div class="bubble char-bubble" style="--c:${esc(c ? c.themeColor : '#6b7280')}">${imgHtml}${esc(m.content).replaceAll('\n', '<br>')}</div>${choicesHtml}`}
          ${m.innerVoice ? `<div class="inner-voice" data-iv-card="${esc(m.id)}" hidden>${esc(m.innerVoice).replaceAll('\n', '<br>')}</div>` : ''}
          <div class="msg-meta">${time}${rememberBtn}</div>
        </div>
      </div>`;
  }).join('');

  const typing = typingBy
    ? `<div class="msg-typing">${esc(typingBy)} 正在輸入<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`
    : '';

  const canRegen = !typingBy
    && allMsgs.some((m) => m.role === 'user')
    && allMsgs.length && allMsgs[allMsgs.length - 1].role !== 'user'
    && !isRoomBusy(room.id);
  const regenBtn = canRegen
    ? '<div class="regen-wrap"><button class="regen-btn" id="btnRegen">↻ 重新生成</button></div>'
    : '';

  wrap.innerHTML = loadOlderHtml + html + typing + regenBtn;
  if (pendingScrollAnchor !== null) {
    // 剛載入更早的訊息：維持原本閱讀位置(新高度差補回去)
    wrap.scrollTop = wrap.scrollHeight - pendingScrollAnchor;
    pendingScrollAnchor = null;
  } else {
    wrap.scrollTop = wrap.scrollHeight;
  }

  // 點訊息切換操作列(記住/編輯/刪除/▶ 平常隱藏，閱讀零噪音)
  if (!wrap.dataset.tapBound) {
    wrap.dataset.tapBound = '1';
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('button, a, .voice-note, img')) return;
      const item = e.target.closest('.msg-row, .msg-narrator');
      if (!item) return;
      const wasOpen = item.classList.contains('show-actions');
      wrap.querySelectorAll('.show-actions').forEach((x) => x.classList.remove('show-actions'));
      if (!wasOpen) item.classList.add('show-actions');
    });
  }
  const loadOlder = wrap.querySelector('#btnLoadOlder');
  if (loadOlder) {
    loadOlder.addEventListener('click', () => {
      pendingScrollAnchor = wrap.scrollHeight - wrap.scrollTop;
      msgWindow.count += MSG_WINDOW_STEP;
      renderMessages();
    });
  }

  const regen = wrap.querySelector('#btnRegen');
  if (regen) {
    regen.addEventListener('click', async () => {
      regen.disabled = true;
      await regenerateLastReply(room.id, (info) => {
        typingBy = info.typingBy || '';
        const s2 = getState();
        if (s2.currentRoomId === room.id) renderMessages();
      });
      typingBy = '';
      if (getState().currentRoomId === room.id) renderMessages();
    });
  }

  const notifyHere = (info) => {
    typingBy = info.typingBy ?? typingBy;
    if (getState().currentRoomId === room.id) renderMessages();
  };
  const charVoiceOf = (m2) => {
    const ch = m2.senderId !== 'player' && m2.senderId !== 'system' ? getCharacter(m2.senderId) : null;
    return ch?.voice || {};
  };
  wrap.querySelectorAll('[data-choice]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const lastM = allMsgs[allMsgs.length - 1];
      const choice = lastM?.choices?.[Number(btn.dataset.choice)];
      if (!choice || isRoomBusy(room.id)) return;
      await sendUserMessage(room.id, choice, notifyHere);
      typingBy = '';
      if (getState().currentRoomId === room.id) renderMessages();
    });
  });
  wrap.querySelectorAll('[data-speak]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m2 = allMsgs.find((x) => x.id === btn.dataset.speak);
      if (m2) toggleSpeak(m2.id, m2.content, charVoiceOf(m2));
    });
  });
  wrap.querySelectorAll('[data-speak-note]').forEach((el) => {
    el.addEventListener('click', () => {
      const m2 = allMsgs.find((x) => x.id === el.dataset.speakNote);
      if (m2) toggleSpeak(m2.id, m2.content, charVoiceOf(m2));
    });
  });
  wrap.querySelectorAll('[data-remember]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const msg = msgs.find((m) => m.id === btn.dataset.remember);
      if (msg) openMemoryCandidateModal(msg, room.id);
    });
  });

  wrap.querySelectorAll('[data-inner-voice]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mid = btn.dataset.innerVoice;
      const msgIv = (getState().messagesByRoom[room.id] || []).find((x) => x.id === mid);
      if (msgIv && msgIv.role === 'narrator') { openInnerVoicePicker(room, msgIv); return; }
      const card = wrap.querySelector(`[data-iv-card="${mid}"]`);
      if (card) { card.hidden = !card.hidden; return; }
      btn.disabled = true;
      btn.textContent = '…';
      const r = await generateInnerVoice(room.id, mid);
      if (!r.ok) {
        alert(r.message);
        const b2 = wrap.querySelector(`[data-inner-voice="${mid}"]`);
        if (b2) { b2.disabled = false; b2.textContent = '👁?'; }
        return;
      }
      renderMessages();
      const c2 = document.getElementById('messages')?.querySelector(`[data-iv-card="${mid}"]`);
      if (c2) c2.hidden = false;
    });
  });
  wrap.querySelectorAll('[data-msg-branch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sure = typeof window !== 'undefined' && window.confirm
        ? window.confirm('從這則訊息分岔：將建立到此為止的新聊天室副本，原房完全不受影響。繼續？')
        : true;
      if (!sure) return;
      const nr = await branchRoom(room.id, btn.dataset.msgBranch);
      if (!nr) return;
      await openRoom(nr.id);
      renderAll();
    });
  });
  wrap.querySelectorAll('[data-msg-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const msg = msgs.find((m) => m.id === btn.dataset.msgEdit);
      if (msg) openEditMessageModal(room.id, msg);
    });
  });
  wrap.querySelectorAll('[data-msg-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openConfirmModal({
        title: '刪除這則訊息？',
        body: '訊息會從對話中移除(角色之後就不會再「記得」它)。這個動作無法復原。',
        confirmLabel: '刪除',
        onConfirm: async () => {
          await deleteMessage(room.id, btn.dataset.msgDel);
          renderMessages();
        },
      });
    });
  });
}

/* ---------------- E. 社群 App ---------------- */

function postCardHtml(p, { clickable = true } = {}) {
  const comments = getComments(p.id);
  return `
    <article class="post-card ${clickable ? 'clickable' : ''}" ${clickable ? `data-open-post="${esc(p.id)}"` : ''}>
      <div class="post-head">
        ${p.authorId === 'player' ? personaAvatarHtml(getPersona(p.personaId) || defaultPersona(), 'sm') : avatarHtml(p.authorId, 'sm')}
        <span class="post-author">${esc(p.authorId === 'player' ? ((getPersona(p.personaId) || defaultPersona())?.name || '你') : authorName(p.authorId))}</span>
        <span class="post-time">${fmtAgo(p.createdAt)}</span>
      </div>
      ${p.image ? `<img class="post-image" src="${p.image}" alt="貼文圖片">` : ''}
      <div class="post-body">${esc(p.content).replaceAll('\n', '<br>')}</div>
      <div class="post-foot">
        <button class="post-action like ${p.likedByPlayer ? 'on' : ''}" data-like="${esc(p.id)}" aria-label="按讚">
          ${p.likedByPlayer ? '♥' : '♡'} ${p.likes}
        </button>
        <span class="post-action" aria-label="留言數">◌ ${comments.length}</span>
        <button class="remember-btn" data-remember-post="${esc(p.id)}" aria-label="把這則貼文存成共享記憶">記住</button>
      </div>
    </article>`;
}

function renderSocialFeed() {
  replyTargetId = null;
  // 為新角色補上初始貼文(每個角色只一次),讓版面不會空
  ensureSeedPosts().then((changed) => {
    if (changed && getView() === 'social-feed') renderSocialFeed();
  });

  const posts = getPosts();
  const cards = posts.map((p) => postCardHtml(p)).join('');

  els.phoneScreen.innerHTML = `
    ${appHeader('社群', {
      leadingHtml: `<button class="persona-chip" id="btnFeedPersona" title="目前身分，點擊切換">${personaAvatarHtml(getPersona(getState().activePersonaId) || defaultPersona(), 'sm')}</button>`,
      rightHtml: '<button class="header-action" id="btnRefreshFeed">↻ 動態</button>'
        + '<button class="header-action" id="btnNewPost">＋ 發貼文</button>',
    })}
    <div class="api-status" id="feedStatus" role="status" style="padding:0 16px"></div>
    <div class="phone-list feed">
      ${cards || `
        <div class="list-empty">
          這裡還沒有任何動態。<br>發第一篇貼文，或先去新增角色——他們也會發文。
        </div>`}
    </div>`;

  bindBack();
  els.phoneScreen.querySelector('#btnNewPost').addEventListener('click', openNewPostModal);
  els.phoneScreen.querySelector('#btnFeedPersona').addEventListener('click', () => {
    openPersonaSelectModal({
      title: '在社群裡，你現在是誰？',
      current: getState().activePersonaId,
      onSelect: async (pid) => {
        getState().activePersonaId = pid;
        await persist();
        renderPhone();
      },
    });
  });
  const refreshBtn = els.phoneScreen.querySelector('#btnRefreshFeed');
  refreshBtn.addEventListener('click', async () => {
    const status = els.phoneScreen.querySelector('#feedStatus');
    refreshBtn.disabled = true;
    status.className = 'api-status';
    status.textContent = '看看大家在幹嘛…';
    const r = await refreshFeed();
    if (getView() !== 'social-feed') return;
    if (!r.ok) {
      renderSocialFeed();
      const st2 = els.phoneScreen.querySelector('#feedStatus');
      st2.className = 'api-status err';
      st2.textContent = r.message;
      return;
    }
    renderSocialFeed();
    const st2 = els.phoneScreen.querySelector('#feedStatus');
    st2.className = 'api-status ok';
    st2.textContent = r.posted ? `有 ${r.posted} 篇新動態` : '暫時沒有人發新動態';
  });
  bindFeedEvents(els.phoneScreen);
}

function bindFeedEvents(root) {
  root.querySelectorAll('[data-open-post]').forEach((card) => {
    card.addEventListener('click', async (e) => {
      if (e.target.closest('[data-like],[data-remember-post]')) return;
      await navigate('social-post', { postId: card.dataset.openPost });
      renderAll();
    });
  });
  root.querySelectorAll('[data-like]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await toggleLike(btn.dataset.like);
      renderPhone();
    });
  });
  root.querySelectorAll('[data-remember-post]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = getPost(btn.dataset.rememberPost);
      if (p) openSharedMemoryModal(`${authorName(p.authorId)}在社群發文:${p.content}`);
    });
  });
}

function renderSocialPost() {
  const state = getState();
  const post = state.currentPostId ? getPost(state.currentPostId) : null;
  if (!post) { navigate('social-feed').then(renderAll); return; }

  const comments = getComments(post.id);

  // FB 式巢狀：依 replyTo.commentId 找出每則留言所屬的討論串根
  const byId = new Map(comments.map((c2) => [c2.id, c2]));
  const rootOf = (c2) => {
    let cur = c2; let hops = 0;
    while (cur.replyTo?.commentId && byId.has(cur.replyTo.commentId) && hops < 20) {
      cur = byId.get(cur.replyTo.commentId);
      hops += 1;
    }
    return cur.id;
  };
  const roots = [];
  const childrenByRoot = new Map();
  for (const c2 of comments) {
    const rid = rootOf(c2);
    if (rid === c2.id) { roots.push(c2); continue; }
    if (!childrenByRoot.has(rid)) childrenByRoot.set(rid, []);
    childrenByRoot.get(rid).push(c2);
  }

  const oneComment = (cm) => `
    <div class="comment-row">
      ${cm.authorId === 'player' ? personaAvatarHtml(getPersona(cm.personaId) || defaultPersona(), 'sm') : avatarHtml(cm.authorId, 'sm')}
      <div class="comment-col">
        <div class="comment-head">
          <span class="comment-author">${esc(cm.authorId === 'player' ? ((getPersona(cm.personaId) || defaultPersona())?.name || '你') : authorName(cm.authorId))}</span>
          <span class="post-time">${fmtAgo(cm.createdAt)}</span>
        </div>
        ${cm.replyTo?.name ? `<div class="reply-tag">回覆 @${esc(cm.replyTo.name)}</div>` : ''}
        <div class="comment-body">${esc(cm.content).replaceAll('\n', '<br>')}</div>
        <button class="remember-btn" data-remember-comment="${esc(cm.id)}">記住</button>
        ${cm.authorId !== 'player' ? `<button class="remember-btn" data-reply-comment="${esc(cm.id)}">回覆</button>` : ''}
        ${cm.authorId !== 'player' ? `<button class="remember-btn" data-dm-comment="${esc(cm.id)}">私下聊</button>` : ''}
        ${replyTargetId === cm.id ? `
          <div class="inline-reply">
            <textarea id="inlineReplyBox" rows="2" placeholder="回覆 ${esc(authorName(cm.authorId))}…"></textarea>
            <button class="mini-btn" data-inline-send="${esc(cm.id)}">送出</button>
            <button class="mini-btn" data-inline-cancel>取消</button>
          </div>` : ''}
      </div>
    </div>`;

  const commentHtml = roots.map((root) => `
    <div class="comment-thread">
      ${oneComment(root)}
      ${(childrenByRoot.get(root.id) || []).map((child) => `<div class="comment-child">${oneComment(child)}</div>`).join('')}
    </div>`).join('');

  const typing = socialTypingBy
    ? `<div class="msg-typing">${esc(socialTypingBy)} 正在輸入<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`
    : '';
  const errorBanner = socialError
    ? `<div class="api-status err">${esc(socialError)}</div>`
    : '';
  socialError = '';

  els.phoneScreen.innerHTML = `
    ${appHeader('貼文', {
      rightHtml: '<button class="header-action" id="btnSharePost">分享</button>'
        + '<button class="header-action" id="btnEditPost">編輯</button>'
        + '<button class="icon-btn" id="btnDeletePost" aria-label="刪除貼文">✕</button>',
    })}
    <div class="phone-list feed detail" id="postDetail">
      ${postCardHtml(post, { clickable: false })}
      <div class="comment-heading">留言 ${comments.length ? `(${comments.length})` : ''} <button class="mini-btn" id="btnBanter" title="讓他們自己在這篇底下聊起來">↻ 他們的留言</button></div>
      ${commentHtml || '<div class="list-empty small">還沒有留言。</div>'}
      ${typing}
      ${errorBanner}
    </div>
    <div class="composer">
      <textarea id="commentInput" rows="1" placeholder="留個言…(公開，所有角色都看得到)" aria-label="留言輸入框"></textarea>
      <button class="send-btn" id="btnComment" aria-label="送出留言">送出</button>
    </div>`;

  bindBack();
  bindFeedEvents(els.phoneScreen);

  els.phoneScreen.querySelector('#btnBanter')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    await runMockSocialReplies(post, null, null, null, null, true); // v65 banter:讓圈內角色自己留言互動
    const b = els.phoneScreen.querySelector('#btnBanter');
    if (b) b.disabled = false;
  });

  els.phoneScreen.querySelector('#btnDeletePost').addEventListener('click', () => {
    openConfirmModal({
      title: '刪除這篇貼文？',
      body: '貼文與底下的留言都會被移除。這個動作無法復原。',
      confirmLabel: '刪除',
      onConfirm: async () => {
        await deletePost(post.id);
        await navigate('social-feed');
        renderAll();
      },
    });
  });
  els.phoneScreen.querySelector('#btnEditPost').addEventListener('click', () => {
    openModal(`
      <h3>編輯貼文</h3>
      <label class="field">內容
        <textarea id="postEditBox" rows="5" maxlength="8000" data-counter>${esc(post.content)}</textarea>
        <span class="char-count"></span>
      </label>
      <div class="form-actions"><button class="primary-btn slim" id="postEditSave">儲存</button></div>`, {
      onOpen(root) {
        bindCharCounters(root);
        root.querySelector('#postEditSave').addEventListener('click', async () => {
          await editPost(post.id, root.querySelector('#postEditBox').value);
          closeModal();
          renderPhone();
        });
      },
    });
  });

  els.phoneScreen.querySelectorAll('[data-dm-comment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cm = comments.find((x) => x.id === btn.dataset.dmComment);
      const c = cm ? getCharacter(cm.authorId) : null;
      const dmRoom = c ? findDmRoom(c.id) : null;
      if (!c || !dmRoom) return;
      const who = post.authorId === 'player'
        ? ((getPersona(post.personaId) || defaultPersona())?.name || '你')
        : authorName(post.authorId);
      openModal(`
        <h3>私下跟 ${esc(c.name)} 聊這個</h3>
        <div class="panel-note">會把這篇貼文的引用卡帶進你們的私訊，話題從廣場拉到兩人之間。</div>
        <label class="field">想說什麼
          <textarea id="dmTopicMsg" rows="2" maxlength="500" placeholder="你剛剛那則留言是什麼意思？"></textarea>
        </label>
        <div class="form-actions"><button class="primary-btn slim" id="btnDmTopicSend">送出並前往私訊</button></div>`, {
        onOpen(root) {
          root.querySelector('#btnDmTopicSend').addEventListener('click', async () => {
            const text = root.querySelector('#dmTopicMsg').value.trim();
            if (!text) return;
            closeModal();
            const sharedPost = {
              postId: post.id,
              authorName: who,
              excerpt: post.content.length > 60 ? `${post.content.slice(0, 60)}…` : post.content,
              image: post.image || null,
            };
            await openRoom(dmRoom.id);
            renderAll();
            await sendUserMessage(dmRoom.id, text, (info) => {
              typingBy = info.typingBy || '';
              if (getState().currentRoomId === dmRoom.id) renderMessages();
            }, null, sharedPost);
            typingBy = '';
            if (getState().currentRoomId === dmRoom.id) renderMessages();
          });
        },
      });
    });
  });
  els.phoneScreen.querySelectorAll('[data-reply-comment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      replyTargetId = replyTargetId === btn.dataset.replyComment ? null : btn.dataset.replyComment;
      renderSocialPost();
      els.phoneScreen.querySelector('#inlineReplyBox')?.focus();
    });
  });
  const inlineCancel = els.phoneScreen.querySelector('[data-inline-cancel]');
  if (inlineCancel) {
    inlineCancel.addEventListener('click', () => {
      replyTargetId = null;
      renderSocialPost();
    });
  }
  const inlineSend = els.phoneScreen.querySelector('[data-inline-send]');
  if (inlineSend) {
    inlineSend.addEventListener('click', async () => {
      const cm = comments.find((c) => c.id === inlineSend.dataset.inlineSend);
      const box = els.phoneScreen.querySelector('#inlineReplyBox');
      const text = box?.value.trim();
      if (!cm || !text) return;
      const replyTo = { commentId: cm.id, authorId: cm.authorId, name: authorName(cm.authorId) };
      replyTargetId = null;
      const pid = getState().activePersonaId || getState().defaultPersonaId;
      const myComment = await addComment(post.id, 'player', text, pid, replyTo);
      renderPhone();
      const myName = (getPersona(pid) || defaultPersona())?.name || '玩家';
      await runMockSocialReplies(post, text, pid, replyTo.name, {
        commentId: myComment.id, authorId: 'player', name: myName,
      });
    });
  }
  els.phoneScreen.querySelector('#btnSharePost').addEventListener('click', () => openSharePostModal(post));

  els.phoneScreen.querySelectorAll('[data-remember-comment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cm = comments.find((c) => c.id === btn.dataset.rememberComment);
      if (cm) openSharedMemoryModal(`${authorName(cm.authorId)}在社群留言:${cm.content}`);
    });
  });

  const input = els.phoneScreen.querySelector('#commentInput');
  const sendBtn = els.phoneScreen.querySelector('#btnComment');

  const doComment = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;
    const pid = getState().activePersonaId || getState().defaultPersonaId;
    await addComment(post.id, 'player', text, pid);
    renderPhone();
    await runMockSocialReplies(post, text, pid);
    sendBtn.disabled = false;
  };

  sendBtn.addEventListener('click', doComment);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice()) {
      e.preventDefault();
      doComment();
    }
  });
  if (input) input.focus();

  const detail = els.phoneScreen.querySelector('#postDetail');
  detail.scrollTop = detail.scrollHeight;
}

/**
 * 玩家發文/留言後，依 mock 機制產生角色留言(1 位主回覆 + 0~2 位補充)。
 * 僅使用公開資訊(角色公開設定、貼文內容、共享記憶)。
 */
async function runMockSocialReplies(post, triggerText, triggerPersonaId = null, replyToName = null, threadReplyTo = null, banter = false) {
  const result = await generateSocialReplies({ post, triggerText, triggerPersonaId, replyToName, banter });
  if (!result.ok) {
    socialError = `AI 留言失敗:${result.message}。你的內容已保留。`;
    if (getView() === 'social-post') renderSocialPost();
    return;
  }
  const replies = result.replies;
  for (const r of replies) {
    const c = getCharacter(r.characterId);
    socialTypingBy = c ? c.name : '';
    if (getView() === 'social-post') renderSocialPost();
    await new Promise((res) => setTimeout(res, r.delay));
    socialTypingBy = '';
    await addComment(post.id, r.characterId, r.content, null, threadReplyTo);
    if (getView() === 'social-post' && getState().currentPostId === post.id) {
      renderSocialPost();
    }
  }
  socialTypingBy = '';
  if (getView() === 'social-post') renderSocialPost();
}

/* ---------------- F. 正文 App ---------------- */

function renderStoryList() {
  const state = getState();
  const stories = state.rooms.filter((r) => r.type === 'story');

  const items = stories.map((r) => {
    const chars = getRoomCharacters(r);
    const msgs = state.messagesByRoom[r.id] || [];
    const last = msgs[msgs.length - 1];
    return `
      <button class="scene-card" data-open-room="${esc(r.id)}">
        <span class="scene-mark" aria-hidden="true">❖</span>
        <span class="list-main">
          <span class="list-title">${esc(r.title)}</span>
          <span class="list-preview">${esc(chars.map((c) => c.name).join('、') || '無人在場')} · ${msgs.length} 段</span>
          ${last ? `<span class="scene-last">${esc(firstLine(last.content, 26))}</span>` : ''}
        </span>
      </button>`;
  }).join('');

  els.phoneScreen.innerHTML = `
    ${appHeader('正文', { rightHtml: '<button class="header-action" id="btnNewStory">＋ 建立場景</button>' })}
    <div class="phone-list scenes">
      ${items || `
        <div class="list-empty">
          正文是互動敘事的地方——一個場景、幾位角色、慢慢展開。<br>
          <button class="primary-btn slim" id="btnEmptyStory">＋ 建立第一個場景</button>
        </div>`}
    </div>`;

  bindBack();
  els.phoneScreen.querySelector('#btnNewStory').addEventListener('click', openStoryModal);
  const emptyBtn = els.phoneScreen.querySelector('#btnEmptyStory');
  if (emptyBtn) emptyBtn.addEventListener('click', openStoryModal);
  els.phoneScreen.querySelectorAll('[data-open-room]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await openRoom(btn.dataset.openRoom);
      renderAll();
    });
  });
}

/* ---------------- G. 角色與玩家 App ---------------- */

/** 全域搜尋：訊息/記憶/貼文/日記。 */
function renderSearch() {
  els.phoneScreen.innerHTML = `
    ${appHeader('搜尋')}
    <div class="phone-list">
      <div class="composer" style="padding:0 0 10px">
        <input id="searchBox" placeholder="搜尋訊息、記憶、貼文、日記…" aria-label="搜尋" autofocus>
      </div>
      <div id="searchResults"><div class="panel-note">「那句話他在哪裡說的？」——打幾個字就知道。</div></div>
    </div>`;
  bindBack();
  const box = els.phoneScreen.querySelector('#searchBox');
  const results = els.phoneScreen.querySelector('#searchResults');
  let timer = null;
  const run = () => {
    const q = box.value.trim();
    if (!q) { results.innerHTML = '<div class="panel-note">輸入關鍵字開始搜尋。</div>'; return; }
    const r = searchAll(q);
    const sec = (title, items, rowFn) => (items.length ? `
      <div class="mem-heading">${title}(${items.length})</div>${items.map(rowFn).join('')}` : '');
    results.innerHTML = (
      sec('訊息', r.messages, (m) => `
        <button class="list-row" data-jump-room="${esc(m.roomId)}">
          <span class="list-main">
            <span class="list-title">${esc(m.roomTitle)} · ${esc(m.who)}</span>
            <span class="list-preview">${esc(m.snippet)}</span>
          </span><span class="list-chevron">›</span>
        </button>`)
      + sec('記憶', r.memories, (m) => `
        <div class="list-row" style="cursor:default">
          <span class="list-main">
            <span class="list-title">${m.pinned ? '📌 ' : ''}${esc(m.where)}</span>
            <span class="list-preview">${esc(m.snippet)}</span>
          </span>
        </div>`)
      + sec('貼文', r.posts, (p) => `
        <button class="list-row" data-jump-post="${esc(p.postId)}">
          <span class="list-main">
            <span class="list-title">${esc(p.who)} 的貼文</span>
            <span class="list-preview">${esc(p.snippet)}</span>
          </span><span class="list-chevron">›</span>
        </button>`)
      + sec('日記', r.diaries, (d) => `
        <button class="list-row" data-jump-diary="${esc(d.characterId)}">
          <span class="list-main">
            <span class="list-title">${esc(d.who)} 的日記</span>
            <span class="list-preview">${esc(d.snippet)}</span>
          </span><span class="list-chevron">›</span>
        </button>`)
    ) || '<div class="list-empty">找不到。換個關鍵字?</div>';
    results.querySelectorAll('[data-jump-room]').forEach((b) => b.addEventListener('click', async () => {
      await openRoom(b.dataset.jumpRoom); renderAll();
    }));
    results.querySelectorAll('[data-jump-post]').forEach((b) => b.addEventListener('click', async () => {
      await navigate('social-post', { postId: b.dataset.jumpPost }); renderAll();
    }));
    results.querySelectorAll('[data-jump-diary]').forEach((b) => b.addEventListener('click', async () => {
      await navigate('character-diary', { characterId: b.dataset.jumpDiary }); renderAll();
    }));
  };
  box.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 200); });
}

/** 回憶相簿：照片只在本機；進 prompt 的是描述文字，分享時才給模型看圖。 */
function renderAlbum() {
  const state = getState();
  const photos = getPhotos();
  els.phoneScreen.innerHTML = `
    ${appHeader('相簿', { rightHtml: '<button class="header-action" id="btnAddPhoto">＋ 新增回憶</button>' })}
    <input type="file" id="photoFile" accept="image/*" hidden>
    <div class="phone-list">
      <div class="panel-note" style="margin:0 2px 10px">照片只存在這台裝置；被標註在場的角色會「記得」描述文字，聊天中可分享照片給他看。</div>
      ${photos.length ? `<div class="album-grid">
        ${photos.map((p) => `
          <button class="album-cell" data-open-photo="${esc(p.id)}" aria-label="檢視回憶">
            <img src="${p.image}" alt="">
            <span class="album-caption">${esc(p.caption || '(未命名)')}</span>
          </button>`).join('')}
      </div>` : '<div class="list-empty">還沒有回憶。跑完一場好劇情，幫它留一張照片吧。</div>'}
    </div>`;
  bindBack();

  const photoFile = els.phoneScreen.querySelector('#photoFile');
  els.phoneScreen.querySelector('#btnAddPhoto').addEventListener('click', () => photoFile.click());
  photoFile.addEventListener('change', async () => {
    const file = photoFile.files[0];
    photoFile.value = '';
    if (!file) return;
    try {
      const image = await compressPhoto(file);
      openPhotoModal(null, image);
    } catch { alert('圖片讀取失敗'); }
  });
  els.phoneScreen.querySelectorAll('[data-open-photo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = getPhotos().find((x) => x.id === btn.dataset.openPhoto);
      if (p) openPhotoModal(p, p.image);
    });
  });
}

/** 新增/編輯一張回憶(photo=null 為新增)。 */
function openPhotoModal(photo, image) {
  const state = getState();
  openModal(`
    <h3>${photo ? '這段回憶' : '新增回憶'}</h3>
    <img class="album-full" src="${image}" alt="回憶照片">
    <form id="photoForm">
      <label class="field">回憶描述(角色會記得這句話)
        <input name="caption" maxlength="60" required value="${esc(photo?.caption || '')}" placeholder="例：八月，和子勳在海邊看日落">
      </label>
      <label class="field">日期(自由填，可留空)
        <input name="dateText" maxlength="20" value="${esc(photo?.dateText || '')}" placeholder="2026/8/12 或「八月的某天」">
      </label>
      <div class="field-label">在場角色(勾選的人才會記得):</div>
      <div class="check-list">
        ${state.characters.map((c) => `
          <label class="check-field">
            <input type="checkbox" name="pc" value="${esc(c.id)}" ${photo?.characterIds?.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}
          </label>`).join('') || '<div class="panel-empty small">尚無角色</div>'}
      </div>
      <div class="form-actions">
        <button type="submit" class="primary-btn slim">${photo ? '儲存' : '存入相簿'}</button>
        ${photo ? '<button type="button" class="ghost-btn slim" id="btnSharePhoto">分享到聊天</button>' : ''}
        ${photo ? '<button type="button" class="danger-btn slim" id="btnDelPhoto">刪除</button>' : ''}
      </div>
    </form>`, {
    onOpen(root) {
      root.querySelector('#photoForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = {
          caption: String(fd.get('caption')),
          dateText: String(fd.get('dateText') || ''),
          characterIds: [...root.querySelectorAll('input[name="pc"]:checked')].map((i) => i.value),
        };
        if (photo) await updatePhoto(photo.id, data);
        else await addPhoto({ ...data, image });
        closeModal();
        renderPhone();
      });
      const del = root.querySelector('#btnDelPhoto');
      if (del) {
        del.addEventListener('click', async () => {
          await deletePhoto(photo.id);
          closeModal();
          renderPhone();
        });
      }
      const share = root.querySelector('#btnSharePhoto');
      if (share) {
        share.addEventListener('click', () => {
          closeModal();
          openSharePhotoModal(photo);
        });
      }
    },
  });
}

/** 分享回憶照片到聊天：走一般傳圖流程，那一輪模型會真的看到圖。 */
function openSharePhotoModal(photo) {
  const state = getState();
  const rooms = state.rooms.filter((r) => r.type === 'dm' || r.type === 'group');
  if (!rooms.length) { openModal('<h3>分享照片</h3><p class="panel-note">還沒有可分享的聊天。</p>'); return; }
  openModal(`
    <h3>分享回憶照片</h3>
    <img class="album-full" src="${photo.image}" alt="">
    <label class="field">附一句話(可留空)
      <input id="photoMsg" maxlength="500" placeholder="還記得這天嗎" value="${esc(photo.caption || '')}">
    </label>
    <div class="field-label">傳到哪裡?</div>
    <div class="check-list">
      ${rooms.map((r) => `
        <button class="list-row" data-photo-room="${esc(r.id)}">
          <span class="avatar sm neutral" aria-hidden="true">${r.type === 'group' ? '◍' : '◖◗'}</span>
          <span class="list-main"><span class="list-title">${esc(r.title)}</span></span>
        </button>`).join('')}
    </div>`, {
    onOpen(root) {
      root.querySelectorAll('[data-photo-room]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const text = root.querySelector('#photoMsg').value;
          closeModal();
          await openRoom(btn.dataset.photoRoom);
          renderAll();
          await sendUserMessage(btn.dataset.photoRoom, text, (info) => {
            typingBy = info.typingBy || '';
            if (getState().currentRoomId === btn.dataset.photoRoom) renderMessages();
          }, photo.image);
          typingBy = '';
          if (getState().currentRoomId === btn.dataset.photoRoom) renderMessages();
        });
      });
    },
  });
}

/** 玩家 App:人設管理(多個「你」)。 */
function renderPlayer() {
  const state = getState();
  els.phoneScreen.innerHTML = `
    ${appHeader('玩家', { rightHtml: '<button class="header-action" id="btnNewPersona">＋ 新增人設</button>' })}
    <div class="phone-list">
      <div class="panel-note" style="margin:0 2px 10px">你可以有多個「你」：每個角色認識其中一個，對話與發文都能切換身分。</div>
      ${getPersonas().map((ps) => `
        <button class="profile-card" data-edit-persona="${esc(ps.id)}" aria-label="編輯人設 ${esc(ps.name)}">
          ${personaAvatarHtml(ps)}
          <span class="list-main">
            <span class="list-title">${esc(ps.name)}${ps.label ? ` <span class="persona-label">— ${esc(ps.label)}</span>` : ''}${ps.id === state.defaultPersonaId ? '(預設)' : ''}</span>
            <span class="list-preview">${esc(firstLine(ps.description, 24) || '角色眼中的你——點這裡填寫')}</span>
          </span>
          <span class="list-chevron" aria-hidden="true">›</span>
        </button>`).join('')}
    </div>`;
  bindBack();
  els.phoneScreen.querySelector('#btnNewPersona').addEventListener('click', () => openPersonaModal());
  els.phoneScreen.querySelectorAll('[data-edit-persona]').forEach((btn) => {
    btn.addEventListener('click', () => openPersonaModal(getPersona(btn.dataset.editPersona)));
  });
}

function renderPeople() {
  const state = getState();

  const charRows = state.characters.map((c) => `
    <button class="list-row" data-open-char="${esc(c.id)}">
      ${avatarHtml(c)}
      <span class="list-main">
        <span class="list-title">${esc(c.name)}${c.label?.trim() ? ` <span class="char-label">${esc(c.label.trim())}</span>` : ''}</span>
        <span class="list-preview">${esc(firstLine(c.description || c.personality, 22) || '尚未填寫描述')}</span>
      </span>
      <span class="list-chevron" aria-hidden="true">›</span>
    </button>`).join('');

  els.phoneScreen.innerHTML = `
    ${appHeader('聯絡人', { rightHtml: '<button class="header-action" id="btnImportCard">匯入角色卡</button>' })}
    <input type="file" id="cardFile" accept=".json,.png,.charx,application/json,image/png" hidden>
    <div class="phone-list people">

      <div class="people-heading">
        角色(${state.characters.length})
      </div>
      <button class="primary-btn add-character" id="btnNewCharacter">＋ 新增角色</button>
      ${charRows || '<div class="list-empty small">還沒有角色。點上面的「＋ 新增角色」開始。</div>'}
    </div>`;

  bindBack();
  els.phoneScreen.querySelector('#btnNewCharacter').addEventListener('click', () => openCharacterModal({ stayInPeople: true }));

  els.phoneScreen.querySelectorAll('[data-open-char]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await navigate('people-character', { characterId: btn.dataset.openChar });
      renderAll();
    });
  });

  // 匯入角色卡(本站包 / Character Card V2/V3 JSON / PNG 圖卡)
  const cardFile = els.phoneScreen.querySelector('#cardFile');
  els.phoneScreen.querySelector('#btnImportCard').addEventListener('click', () => cardFile.click());
  cardFile.addEventListener('change', async () => {
    const file = cardFile.files[0];
    cardFile.value = '';
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let pngDataUrl = null;
      if (file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')) {
        pngDataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => rej(new Error('圖片讀取失敗'));
          r.readAsDataURL(file);
        });
      }
      const card = await parseCharacterImport(bytes, { pngDataUrl });
      openCardPreviewModal(card);
    } catch (err) {
      alert(`匯入失敗:${err.message}(目前資料未被更動)`);
    }
  });
}

function renderCharacterDetail() {
  const state = getState();
  const c = state.currentCharacterId ? getCharacter(state.currentCharacterId) : null;
  if (!c) { navigate('people').then(renderAll); return; }

  els.phoneScreen.innerHTML = `
    ${appHeader(c.name, {
      subtitle: '角色資料',
      leadingHtml: avatarHtml(c, 'sm'),
      rightHtml: '<button class="header-action" id="btnCharExport">匯出</button>'
        + '<button class="header-action" id="btnCharDiary">日記</button>',
    })}
    <div class="phone-list profile-detail">
      <form id="charEditForm">
        ${characterFormFields(c)}
        ${getState().characters.filter((o) => o.id !== c.id).length ? `
          <details class="mem-group rel-group" ${Object.values(c.relationships || {}).some((v) => v?.trim()) ? '' : ''}>
            <summary class="mem-subheading">與其他角色的關係(已填 ${Object.values(c.relationships || {}).filter((v) => v?.trim()).length}/${getState().characters.length - 1};留空=不提，只在雙方同場注入)</summary>
            ${getState().characters.filter((o) => o.id !== c.id).map((o) => `
              <label class="field">${esc(c.name)} 對 ${esc(o.name)}
                <input name="rel_${esc(o.id)}" maxlength="80" value="${esc(c.relationships?.[o.id] || '')}" placeholder="例：互看不順眼但默契絕佳的隊友">
              </label>`).join('')}
          </details>
        ` : ''}
        <div class="form-actions">
          <button type="submit" class="primary-btn slim">儲存變更</button>
          <button type="button" class="ghost-btn slim" id="btnOpenDm">開啟私訊</button>
          <button type="button" class="danger-btn slim" id="btnDeleteChar">刪除角色</button>
        </div>
      </form>
    </div>`;

  bindBack();

  bindCharCounters(els.phoneScreen);
  const getAvatar = bindAvatarUpload(els.phoneScreen, c.avatarImage);
  const voiceTest = els.phoneScreen.querySelector('[data-voice-test]');
  if (voiceTest) {
    voiceTest.addEventListener('click', () => {
      const f = els.phoneScreen.querySelector('#charEditForm');
      toggleSpeak(`test_${c.id}`, `嗨，我是${c.name}。還記得海邊那天嗎？`, {
        voiceURI: f.voiceURI.value, rate: f.vrate.value, pitch: f.vpitch.value,
      });
    });
  }
  els.phoneScreen.querySelector('#btnCharExport').addEventListener('click', () => openCardExportModal(c));
  els.phoneScreen.querySelector('#btnCharDiary').addEventListener('click', async () => {
    await navigate('character-diary', { characterId: c.id });
    renderAll();
  });
  els.phoneScreen.querySelector('#charEditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = readForm(e.target);
    data.noPhone = data.noPhone === 'on';
        data.socialMute = data.socialMute === 'on';
    data.alternateGreetings = String(data.alternateGreetings || '').split('\n').map((g) => g.trim()).filter(Boolean);
    const relationships = {};
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('rel_')) {
        const rid = k.slice(4);
        if (String(v).trim()) relationships[rid] = String(v).trim();
        delete data[k];
      }
    }
    data.relationships = relationships;
    if (data.voiceURI !== undefined) {
      await setCharacterVoice(c.id, { voiceURI: data.voiceURI, rate: data.vrate, pitch: data.vpitch });
      delete data.voiceURI; delete data.vrate; delete data.vpitch;
    }
    const av = getAvatar();
    if (av !== undefined) data.avatarImage = av;
    await updateCharacter(c.id, data);
    renderAll();
  });

  els.phoneScreen.querySelector('#btnOpenDm').addEventListener('click', async () => {
    const dm = findDmRoom(c.id);
    if (dm) {
      await openRoom(dm.id);
      renderAll();
    }
  });

  els.phoneScreen.querySelector('#btnDeleteChar').addEventListener('click', () => {
    openConfirmModal({
      title: `讓「${c.name}」離開這支手機？`,
      body: '這個角色、他的私訊、私密記憶、社群貼文，以及只剩他撐著的聊天室都會被移除。這個動作無法復原。',
      confirmLabel: '讓他離開',
      onConfirm: async () => {
        await deleteCharacter(c.id);
        await navigate('people');
        renderAll();
      },
    });
  });
}

/**
 * 綁定角色表單的頭像上傳。回傳 getAvatarImage():
 * undefined=未動、null=移除、字串=新的壓縮 dataURL。
 */
function bindAvatarUpload(root, current = null) {
  let value; // undefined 表示沒動
  const preview = root.querySelector('#avatarPreview');
  const fileInput = root.querySelector('#avatarFile');
  if (!preview) return () => undefined;
  root.querySelector('#btnAvatarPick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      value = await compressAvatar(file);
      preview.innerHTML = `<img src="${value}" alt="">`;
    } catch (err) {
      preview.innerHTML = `<span>${esc(err.message)}</span>`;
    }
  });
  root.querySelector('#btnAvatarClear').addEventListener('click', () => {
    value = null;
    preview.innerHTML = '<span>無</span>';
  });
  return () => value;
}

/* ---------------- 字數計數器 ---------------- */

/** 為 root 內所有帶 data-counter 的欄位掛上「目前/上限」字數顯示。 */
function bindCharCounters(root) {
  root.querySelectorAll('[data-counter]').forEach((input) => {
    const label = input.parentElement.querySelector('.char-count');
    if (!label) return;
    const update = () => {
      const max = input.getAttribute('maxlength');
      label.textContent = max ? `${input.value.length}/${max}` : `${input.value.length} 字`;
    };
    input.addEventListener('input', update);
    update();
  });
}

/* ---------------- 設定頁:AI 連線區塊 ---------------- */

function apiSectionHtml() {
  const cfg = getApiConfig();
  const presetBtns = [0, 1, 2].map((i) => {
    const p = cfg.presets[i];
    const label = p ? `${PROVIDERS[p.provider]?.label || p.provider} · ${p.model || '?'}` : '(空)';
    return `
      <div class="preset-row">
        <span class="preset-name">P${i + 1}</span>
        <span class="preset-info">${esc(label)}</span>
        <button class="mini-btn" data-preset-load="${i}" ${p ? '' : 'disabled'}>載入</button>
        <button class="mini-btn" data-preset-save="${i}">存入</button>
      </div>`;
  }).join('');

  const providerOpts = Object.entries(PROVIDERS)
    .map(([k, v]) => `<option value="${k}" ${cfg.provider === k ? 'selected' : ''}>${esc(v.label)}</option>`)
    .join('');

  return `
    <div class="api-section">
      <div class="field-label">API 預設槽</div>
      ${presetBtns}
      <label class="field">API 供應商
        <select name="provider" id="apiProvider">${providerOpts}</select>
      </label>
      <label class="field" id="apiBaseWrap" style="${cfg.provider === 'custom' ? '' : 'display:none'}">自訂 API 位址(OpenAI 相容)
        <input id="apiBase" value="${esc(cfg.baseUrl)}" placeholder="https://your-endpoint/v1">
      </label>
      <label class="field">API 金鑰(只存本機)
        <input id="apiKey" type="password" value="${esc(cfg.apiKey)}" placeholder="sk-...">
      </label>
      <label class="field">模型
        <div class="model-row">
          <select id="apiModelSelect">
            <option value="">${cfg.modelList.length ? '— 從清單選擇 —' : '(先按「取得最新模型」載入清單)'}</option>
            ${cfg.modelList.map((m) => `<option value="${esc(m)}" ${cfg.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
          </select>
          <button class="ghost-btn slim" id="btnApiModels">↻ 取得最新模型</button>
        </div>
        <input id="apiModel" value="${esc(cfg.model)}" placeholder="或直接手動輸入模型名稱">
      </label>
      <label class="field">次要模型(選填；同金鑰，雜務用便宜模型省錢)
        <div class="model-row">
          <select id="apiModelSelect2">
            <option value="">— 不使用次要模型 —</option>
            ${cfg.modelList.map((m) => `<option value="${esc(m)}" ${cfg.secondaryModel === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
          </select>
        </div>
        <input id="apiModel2" value="${esc(cfg.secondaryModel || '')}" placeholder="留空=一切照舊全走主要模型">
        <span class="setting-hint">有設定時：記憶摘要與章節封存自動走次要；下方開關可讓社群/日記也走次要。私訊/群聊/正文/旁觀永遠走主要。</span>
      </label>
      <label class="check-field api-toggle">
        <input type="checkbox" id="chkSecondarySocial" ${getState().settings.secondaryForSocialDiary ? 'checked' : ''}>
        社群發文/留言與日記也使用次要模型(內容你會讀，品質有感，自己試試)
      </label>
      <label class="check-field api-toggle">
        <input type="checkbox" id="chkUseRealApi" ${cfg.useRealApi ? 'checked' : ''}>
        使用真實 AI 回覆(私訊/群聊/正文全模式；群聊為單次呼叫產多角色訊息)
      </label>
      <div class="field-label">每模式單則回覆字數上限</div>
      <div class="field-row">
        <label class="field third">私訊
          <input id="lenDm" type="number" min="50" max="20000" value="${cfg.maxReplyChars.dm}">
        </label>
        <label class="field third">群聊
          <input id="lenGroup" type="number" min="50" max="20000" value="${cfg.maxReplyChars.group}">
        </label>
        <label class="field third">正文
          <input id="lenStory" type="number" min="50" max="20000" value="${cfg.maxReplyChars.story}">
        </label>
      </div>
      <label class="field">上下文預算(約略 token 數)
        <input id="ctxBudget" type="number" min="1000" max="200000" value="${cfg.contextBudget}">
      </label>
      <div class="field-label">進階參數</div>
      <div class="field-row">
        <label class="field third">溫度(0~2)
          <input id="apiTemp" type="number" min="0" max="2" step="0.1" value="${cfg.temperature ?? 1.0}">
        </label>
        <label class="field third">Top-P(0~1)
          <input id="apiTopP" type="number" min="0" max="1" step="0.05" value="${cfg.topP ?? 0.95}">
        </label>
        <label class="field third">思考預算
          <input id="apiThink" type="number" min="0" step="1" value="${esc(String(cfg.thinkingBudget ?? ''))}" placeholder="留空=預設">
        </label>
      </div>
      <label class="field">上下文預算(字；對話歷史由新到舊裝進 prompt,裝滿即止——正文自動少帶幾則、短訊自動多帶)
        <input id="apiBudget" type="number" min="2000" step="1000" value="${cfg.contextBudget || 20000}">
      </label>
      <label class="field">內容安全等級(僅 Gemini;對映官方 safetySettings 參數)
        <select id="apiSafety" class="theme-select" style="width:100%; margin-top:5px">
          <option value="default" ${cfg.safetyLevel !== 'relaxed' && cfg.safetyLevel !== 'none' ? 'selected' : ''}>預設(Google 標準過濾)</option>
          <option value="relaxed" ${cfg.safetyLevel === 'relaxed' ? 'selected' : ''}>寬鬆(只擋高風險)</option>
          <option value="none" ${cfg.safetyLevel === 'none' ? 'selected' : ''}>最寬(BLOCK_NONE,成人請自行負責)</option>
        </select>
      </label>
      <div class="panel-note">溫度：創作建議 0.9~1.2。思考預算(Gemini 2.5+):0=關閉思考最省額度；留空用模型預設；數字越大推理越深但更貴更慢。內容被安全層擋下時，錯誤訊息會顯示「模型回傳了空內容」。</div>
      <div class="form-actions">
        <button class="ghost-btn slim" id="btnApiTest">測試連線</button>
        <button class="ghost-btn slim" id="btnApiModels">取得模型列表</button>
        <button class="primary-btn slim" id="btnApiSave">儲存設定</button>
      </div>
      <div class="api-status" id="apiStatus" role="status"></div>
    </div>`;
}

function readApiForm() {
  const g = (id) => els.phoneScreen.querySelector(id);
  return {
    provider: g('#apiProvider').value,
    baseUrl: g('#apiBase') ? g('#apiBase').value.trim() : '',
    apiKey: g('#apiKey').value.trim(),
    model: g('#apiModel').value.trim(),
    secondaryModel: g('#apiModel2') ? g('#apiModel2').value.trim() : '',
    maxReplyChars: {
      dm: Math.max(50, Number(g('#lenDm').value) || 800),
      group: Math.max(50, Number(g('#lenGroup').value) || 1200),
      story: Math.max(50, Number(g('#lenStory').value) || 4000),
    },
    contextBudget: Math.max(1000, Number(g('#ctxBudget').value) || 20000),
    useRealApi: g('#chkUseRealApi').checked,
    temperature: Math.min(2, Math.max(0, Number(g('#apiTemp').value))),
    topP: Math.min(1, Math.max(0, Number(g('#apiTopP').value))),
    thinkingBudget: g('#apiThink').value.trim() === '' ? '' : Math.max(0, Number(g('#apiThink').value)),
    safetyLevel: g('#apiSafety').value,
    contextBudget: Math.max(2000, Number(g('#apiBudget').value) || 20000),
  };
}

function bindApiSection() {
  const status = els.phoneScreen.querySelector('#apiStatus');
  const say = (msg, ok = true) => {
    status.textContent = msg;
    status.className = `api-status ${ok ? 'ok' : 'err'}`;
  };

  els.phoneScreen.querySelector('#apiProvider').addEventListener('change', (e) => {
    els.phoneScreen.querySelector('#apiBaseWrap').style.display = e.target.value === 'custom' ? '' : 'none';
  });

  els.phoneScreen.querySelector('#btnApiSave').addEventListener('click', async () => {
    await saveApiConfig(readApiForm());
    say('已儲存(僅存於本機瀏覽器)');
  });

  els.phoneScreen.querySelector('#btnApiTest').addEventListener('click', async () => {
    say('測試中…');
    const r = await testConnection({ ...getApiConfig(), ...readApiForm() });
    say(r.message, r.ok);
  });

  // 下拉選單選了什麼，就同步進手動輸入欄(儲存以輸入欄為準)
  els.phoneScreen.querySelector('#apiModelSelect').addEventListener('change', (e) => {
    if (e.target.value) els.phoneScreen.querySelector('#apiModel').value = e.target.value;
  });
  els.phoneScreen.querySelector('#apiModelSelect2')?.addEventListener('change', (e) => {
    const inp = els.phoneScreen.querySelector('#apiModel2');
    if (inp && e.target.value) inp.value = e.target.value;
  });
  els.phoneScreen.querySelector('#chkSecondarySocial')?.addEventListener('change', async (e) => {
    getState().settings.secondaryForSocialDiary = e.target.checked;
    await persist();
  });

  els.phoneScreen.querySelector('#btnApiModels').addEventListener('click', async () => {
    say('取得模型中…');
    const r = await listModels({ ...getApiConfig(), ...readApiForm() });
    if (r.ok) {
      await saveApiConfig({ ...readApiForm(), modelList: r.models });
      renderPhone(); // 重繪後下拉選單就有完整清單
    } else {
      say(`${r.message}(也可以直接手動輸入模型名稱)`, false);
    }
  });

  els.phoneScreen.querySelectorAll('[data-preset-load]').forEach((b) => b.addEventListener('click', async () => {
    if (await loadPreset(Number(b.dataset.presetLoad))) renderPhone();
  }));
  els.phoneScreen.querySelectorAll('[data-preset-save]').forEach((b) => b.addEventListener('click', async () => {
    await saveApiConfig(readApiForm());
    await savePreset(Number(b.dataset.presetSave));
    renderPhone();
  }));
}

/* ---------------- 角色卡匯入預覽 / 匯出 ---------------- */

function openCardPreviewModal(card) {
  const bookCount = (card.worldbooks || []).reduce((n, b) => n + b.entries.length, 0);
  openModal(`
    <h3>匯入角色卡</h3>
    <div class="list-row" style="pointer-events:none">
      ${card.avatarImage ? `<span class="avatar img"><img src="${card.avatarImage}" alt=""></span>` : `<span class="avatar" style="--c:${esc(card.themeColor)}">${esc(card.avatarEmoji || card.name.slice(0, 1))}</span>`}
      <span class="list-main">
        <span class="list-title">${esc(card.name)}</span>
        <span class="list-preview">${esc(card.sourceFormat)} · 頭像:${card.avatarImage ? '有' : '無'} · 世界書條目:${bookCount}</span>
      </span>
    </div>
    <div class="panel-note" style="margin-top:8px">
      描述:${esc((card.description || '(無)').slice(0, 80))}${(card.description || '').length > 80 ? '…' : ''}<br>
      第一則訊息:${esc((card.firstMessage || '(無)').slice(0, 50))}${(card.firstMessage || '').length > 50 ? '…' : ''}
    </div>
    <div class="panel-note">將以「建立新角色」方式匯入(附新私訊，不覆蓋任何既有角色)。${bookCount ? '內嵌世界書會建立為新書並綁定此角色。' : ''}</div>
    <div class="form-actions">
      <button class="primary-btn slim" id="btnCardConfirm">確認匯入</button>
      <button class="ghost-btn slim" id="btnCardCancel">取消</button>
    </div>`, {
    onOpen(root) {
      root.querySelector('#btnCardCancel').addEventListener('click', closeModal);
      root.querySelector('#btnCardConfirm').addEventListener('click', async () => {
        const { character } = await importCharacter(card);
        closeModal();
        await navigate('people-character', { characterId: character.id });
        renderAll();
      });
    },
  });
}

/** 觸控裝置判定(提案 N):粗指標=手機/平板;jsdom 無 matchMedia 時回 false。 */
function isTouchDevice() {
  try { return globalThis.matchMedia?.('(pointer: coarse)')?.matches === true; } catch { return false; }
}

function downloadJson(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function openCardExportModal(c) {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  openModal(`
    <h3>匯出「${esc(c.name)}」</h3>
    <p class="panel-note">兩種格式都不含 API 金鑰、聊天紀錄與私密記憶。綁定這個角色的世界書會一併打包。</p>
    <div class="form-actions" style="flex-direction:column; align-items:stretch">
      <button class="primary-btn slim" id="btnExpPack">匯出完整角色包(本站格式，含頭像/主題色)</button>
      <button class="ghost-btn slim" id="btnExpV2">匯出通用角色卡 JSON(Character Card V2 相容)</button>
    </div>`, {
    onOpen(root) {
      root.querySelector('#btnExpPack').addEventListener('click', () => {
        downloadJson(exportCharacterPack(c), `${c.name}-pack-${date}.json`);
        closeModal();
      });
      root.querySelector('#btnExpV2').addEventListener('click', () => {
        downloadJson(exportCharacterCardV2(c), `${c.name}-v2-${date}.json`);
        closeModal();
      });
    },
  });
}

/* ---------------- 角色日記 ---------------- */

function renderCharacterDiary() {
  const state = getState();
  const c = state.currentCharacterId ? getCharacter(state.currentCharacterId) : null;
  if (!c) { navigate('people').then(renderAll); return; }
  const entries = getDiaries(c.id);

  const fmtDate = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  els.phoneScreen.innerHTML = `
    ${appHeader(`${c.name} 的日記`, {
      leadingHtml: avatarHtml(c, 'sm'),
      rightHtml: '<button class="header-action" id="btnDiaryRefresh">↻</button>',
    })}
    <div class="api-status" id="diaryStatus" role="status" style="padding:0 16px"></div>
    <div class="phone-list diary-list">
      ${entries.length ? entries.map((e) => `
        <div class="diary-entry">
          <div class="diary-date">${fmtDate(e.createdAt)}</div>
          <div class="diary-content">${esc(e.content).replaceAll('\n', '<br>')}</div>
          <button class="remember-btn danger" data-diary-del="${esc(e.id)}">刪除</button>
        </div>`).join('') : `
        <div class="list-empty">
          這裡是 ${esc(c.name)} 寫給自己看的日記。<br>按右上角的 ↻,看看他今天寫了什麼。
        </div>`}
    </div>`;

  bindBack();
  const refreshBtn = els.phoneScreen.querySelector('#btnDiaryRefresh');
  refreshBtn.addEventListener('click', async () => {
    const status = els.phoneScreen.querySelector('#diaryStatus');
    refreshBtn.disabled = true;
    status.className = 'api-status';
    status.textContent = `${c.name} 正在寫…`;
    const r = await generateDiary(c.id);
    if (getView() !== 'character-diary') return;
    renderPhone();
    const st2 = els.phoneScreen.querySelector('#diaryStatus');
    if (!st2) return;
    if (!r.ok) { st2.className = 'api-status err'; st2.textContent = r.message; return; }
    st2.className = 'api-status ok';
    st2.textContent = '寫好了';
  });
  els.phoneScreen.querySelectorAll('[data-diary-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteDiary(c.id, btn.dataset.diaryDel);
      renderPhone();
    });
  });
}

/* ---------------- 世界書 App ---------------- */

function renderWorldbookList() {
  const books = getWorldbooks();
  const rows = books.map((b) => {
    const on = b.entries.filter((e) => e.enabled).length;
    const scope = b.scope?.global
      ? '全域'
      : (b.scope?.characterIds || []).map((id) => getCharacter(id)?.name || '?').join('、') || '未綁定';
    return `
      <button class="list-row" data-open-book="${esc(b.id)}">
        <span class="avatar neutral" aria-hidden="true">▤</span>
        <span class="list-main">
          <span class="list-title">${esc(b.name)}${b.enabled ? '' : '(停用)'}</span>
          <span class="list-preview">${on} 個條目 · 適用:${esc(scope)}</span>
        </span>
        <span class="list-chevron" aria-hidden="true">›</span>
      </button>`;
  }).join('');

  els.phoneScreen.innerHTML = `
    ${appHeader('世界書', {
      rightHtml: '<button class="header-action" id="btnImportWb">匯入</button>'
        + '<button class="header-action" id="btnExportAllWb">匯出全部</button>'
        + '<button class="header-action" id="btnNewBook">＋ 新增世界書</button>',
    })}
    <input type="file" id="wbFile" accept=".json,application/json" hidden>
    <div class="phone-list">
      ${rows || `
        <div class="list-empty">
          世界書是「觸發式」的世界觀設定:<br>條目只有在對話提到關鍵字時才會進入 prompt,不浪費 token。
          <button class="primary-btn slim" id="btnEmptyBook">＋ 建立第一本世界書</button>
        </div>`}
    </div>`;

  bindBack();
  const openCreate = () => openModal(`
    <h3>新增世界書</h3>
    <form id="wbForm">
      <label class="field">名稱
        <input name="name" required placeholder="例如:OFFSET 樂團世界觀">
      </label>
      <div class="form-actions"><button type="submit" class="primary-btn slim">建立</button></div>
    </form>`, {
    onOpen(root) {
      root.querySelector('#wbForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const book = await createWorldbook(new FormData(e.target).get('name'));
        closeModal();
        await navigate('worldbook-detail', { worldbookId: book.id });
        renderAll();
      });
    },
  });
  els.phoneScreen.querySelector('#btnNewBook').addEventListener('click', openCreate);

  const wbDate = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };
  els.phoneScreen.querySelector('#btnExportAllWb').addEventListener('click', () => {
    if (!getWorldbooks().length) { alert('目前沒有世界書可匯出'); return; }
    downloadJson(exportAllWorldbooksJson(), `worldbooks-all-${wbDate()}.json`);
  });
  const wbFile = els.phoneScreen.querySelector('#wbFile');
  els.phoneScreen.querySelector('#btnImportWb').addEventListener('click', () => wbFile.click());
  wbFile.addEventListener('change', async () => {
    const file = wbFile.files[0];
    wbFile.value = '';
    if (!file) return;
    try {
      const books = parseWorldbookImport(await file.text());
      const total = books.reduce((n, b) => n + b.entries.length, 0);
      const kwCount = books.reduce((n, b) => n + b.entries.reduce((m, e) => m + e.keywords.length, 0), 0);
      openConfirmModal({
        title: `匯入 ${books.length} 本世界書？`,
        body: `${books.map((b) => `「${b.name}」`).join('、')},共 ${total} 個條目、${kwCount} 個觸發關鍵字。將建立為新書(全域生效，可再改綁定),不會覆蓋任何既有世界書。`,
        confirmLabel: '匯入',
        onConfirm: async () => {
          await importWorldbooks(books);
          renderPhone();
        },
      });
    } catch (err) {
      alert(`匯入失敗:${err.message}(目前資料未被更動)`);
    }
  });
  const emptyBtn = els.phoneScreen.querySelector('#btnEmptyBook');
  if (emptyBtn) emptyBtn.addEventListener('click', openCreate);
  els.phoneScreen.querySelectorAll('[data-open-book]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await navigate('worldbook-detail', { worldbookId: btn.dataset.openBook });
      renderAll();
    });
  });
}

function renderWorldbookDetail() {
  const state = getState();
  const book = state.currentWorldbookId ? getWorldbook(state.currentWorldbookId) : null;
  if (!book) { navigate('worldbook').then(renderAll); return; }

  const roomChecks = state.rooms.map((r) => `
    <label class="check-field">
      <input type="checkbox" name="bindRoom" value="${esc(r.id)}"
        ${(book.scope?.roomIds || []).includes(r.id) ? 'checked' : ''}
        ${book.scope?.global ? 'disabled' : ''}>
      ${r.type === 'dm' ? '私訊' : r.type === 'group' ? '群聊' : '正文'}:${esc(r.title)}
    </label>`).join('');

  const charChecks = state.characters.map((c) => `
    <label class="check-field">
      <input type="checkbox" name="bindChar" value="${esc(c.id)}"
        ${(book.scope?.characterIds || []).includes(c.id) ? 'checked' : ''}
        ${book.scope?.global ? 'disabled' : ''}>
      ${avatarHtml(c, 'sm')} ${esc(c.name)}
    </label>`).join('');

  const entries = book.entries.map((e) => `
    <div class="wb-entry ${e.enabled ? '' : 'off'}">
      <div class="wb-entry-head">
        <span class="wb-entry-title">${e.alwaysOn ? '📌 ' : ''}${esc(e.title)}</span>
        <span class="wb-entry-keys">${e.alwaysOn ? '常駐' : esc((e.keywords || []).join('、') || '(無關鍵字)')}${!e.alwaysOn && (e.secondaryKeywords || []).length ? ` ⛩${esc((e.secondaryKeywords).join('、'))}` : ''} · 權重 ${e.priority ?? 100}</span>
      </div>
      <div class="wb-entry-content">${esc(e.content)}</div>
      <div class="mem-actions">
        <button class="mini-btn" data-entry-edit="${esc(e.id)}">編輯</button>
        <button class="mini-btn" data-entry-toggle="${esc(e.id)}">${e.enabled ? '停用' : '啟用'}</button>
        <button class="mini-btn danger" data-entry-del="${esc(e.id)}">刪除</button>
      </div>
    </div>`).join('');

  els.phoneScreen.innerHTML = `
    ${appHeader(book.name, {
      subtitle: '世界書',
      rightHtml: '<button class="header-action" id="btnExportWb">匯出</button>'
        + '<button class="header-action" id="btnNewEntry">＋ 新增條目</button>',
    })}
    <div class="phone-list profile-detail">
      <form id="wbMetaForm">
        <label class="field">名稱
          <input name="name" value="${esc(book.name)}">
        </label>
        <label class="check-field">
          <input type="checkbox" name="enabled" ${book.enabled ? 'checked' : ''}> 啟用這本世界書
        </label>
        <label class="check-field">
          <input type="checkbox" name="global" ${book.scope?.global ? 'checked' : ''}> 對所有角色生效(全域)
        </label>
        <div class="field-label">或只綁定特定角色:</div>
        <div class="check-list">${charChecks || '<div class="panel-empty small">尚無角色</div>'}</div>
        <div class="field-label">或綁定特定聊天室(該對話中生效，適合場景專用設定):</div>
        <div class="check-list">${roomChecks || '<div class="panel-empty small">尚無聊天室</div>'}</div>
        <div class="form-actions">
          <button type="submit" class="primary-btn slim">儲存設定</button>
          <button type="button" class="danger-btn slim" id="btnDelBook">刪除世界書</button>
        </div>
      </form>
      <div class="people-heading">條目(${book.entries.length})</div>
      ${entries || '<div class="list-empty small">還沒有條目。條目=一段設定+它的觸發關鍵字。</div>'}
    </div>`;

  bindBack();

  // 全域勾選時，即時停用角色勾選框
  const metaForm = els.phoneScreen.querySelector('#wbMetaForm');
  metaForm.querySelector('input[name="global"]').addEventListener('change', (e) => {
    metaForm.querySelectorAll('input[name="bindChar"], input[name="bindRoom"]').forEach((cb) => { cb.disabled = e.target.checked; });
  });

  metaForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await updateWorldbook(book.id, {
      name: fd.get('name'),
      enabled: !!fd.get('enabled'),
      scope: {
        global: !!fd.get('global'),
        characterIds: [...e.target.querySelectorAll('input[name="bindChar"]:checked')].map((i) => i.value),
        roomIds: [...e.target.querySelectorAll('input[name="bindRoom"]:checked')].map((i) => i.value),
      },
    });
    renderAll();
  });

  els.phoneScreen.querySelector('#btnDelBook').addEventListener('click', () => {
    openConfirmModal({
      title: `刪除「${book.name}」？`,
      body: '這本世界書與其中所有條目都會被移除。角色與聊天資料不受影響。',
      confirmLabel: '刪除',
      onConfirm: async () => {
        await deleteWorldbook(book.id);
        await navigate('worldbook');
        renderAll();
      },
    });
  });

  els.phoneScreen.querySelector('#btnExportWb').addEventListener('click', () => {
    const d = new Date();
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    downloadJson(exportWorldbookJson(book.id), `${book.name}-worldbook-${date}.json`);
  });
  els.phoneScreen.querySelector('#btnNewEntry').addEventListener('click', () => openEntryModal(book.id));
  els.phoneScreen.querySelectorAll('[data-entry-edit]').forEach((b) => b.addEventListener('click', () => {
    const entry = book.entries.find((e) => e.id === b.dataset.entryEdit);
    if (entry) openEntryModal(book.id, entry);
  }));
  els.phoneScreen.querySelectorAll('[data-entry-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const entry = book.entries.find((e) => e.id === b.dataset.entryToggle);
    await updateEntry(book.id, entry.id, { enabled: !entry.enabled });
    renderPhone();
  }));
  els.phoneScreen.querySelectorAll('[data-entry-del]').forEach((b) => b.addEventListener('click', async () => {
    await deleteEntry(book.id, b.dataset.entryDel);
    renderPhone();
  }));
}

/** 新增/編輯世界書條目 modal。 */
function openEntryModal(bookId, entry = null) {
  openModal(`
    <h3>${entry ? '編輯條目' : '新增條目'}</h3>
    <form id="entryForm">
      <label class="field">標題
        <input name="title" required maxlength="60" value="${esc(entry?.title || '')}" placeholder="例如:OFFSET 樂團">
      </label>
      <label class="field">觸發關鍵字(逗號或頓號分隔)
        <input name="keywords" maxlength="300" value="${esc((entry?.keywords || []).join('、'))}" placeholder="例如:OFFSET、樂團、主唱">
      </label>
      <label class="field">次要關鍵字(選填；有填時=上面命中「且」這裡任一也在場才觸發。在場=最近對話出現過，或是本聊天室角色的名字。用來讓「哥哥」「媽媽」這種泛用詞不亂觸發)
        <input name="secondaryKeywords" maxlength="300" value="${esc((entry?.secondaryKeywords || []).join('、'))}" placeholder="例如：莫映里、映宣(留空=照舊)">
      </label>
      <label class="field">內容(被觸發時進入 prompt)
        <textarea name="content" rows="5" maxlength="4000" data-counter>${esc(entry?.content || '')}</textarea>
        <span class="char-count"></span>
      </label>
      <label class="check-field">
        <input type="checkbox" name="alwaysOn" ${entry?.alwaysOn ? 'checked' : ''}> 常駐(不需關鍵字，永遠進入 prompt,較耗 token)
      </label>
      <label class="field">權重(同時觸發搶位子時，數字大的優先；預設 100)
        <input name="priority" type="number" step="10" value="${entry?.priority ?? 100}">
      </label>
      <div class="form-actions"><button type="submit" class="primary-btn slim">${entry ? '儲存' : '新增'}</button></div>
    </form>`, {
    onOpen(root) {
      bindCharCounters(root);
      root.querySelector('#entryForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = {
          title: fd.get('title'),
          keywords: parseKeywords(fd.get('keywords')),
          secondaryKeywords: parseKeywords(fd.get('secondaryKeywords')),
          content: fd.get('content'),
          alwaysOn: !!fd.get('alwaysOn'),
          priority: Number(fd.get('priority')),
        };
        if (entry) await updateEntry(bookId, entry.id, data);
        else await addEntry(bookId, data);
        closeModal();
        renderPhone();
      });
    },
  });
}

/* ---------------- 設定 App ---------------- */

function renderSettings() {
  const state = getState();
  const cfg = getConfig();

  els.phoneScreen.innerHTML = `
    ${appHeader('設定')}
    <div class="phone-list settings">
      <div class="people-heading">外觀</div>
      <label class="setting-row">
        <span class="setting-label">主題</span>
        <select id="selTheme" class="theme-select">
          <option value="dusk" ${state.settings.theme !== 'sage' ? 'selected' : ''}>暮霧(深色)</option>
          <option value="sage" ${state.settings.theme === 'sage' ? 'selected' : ''}>青霧(淺綠護眼)</option>
          <option value="berry" ${state.settings.theme === 'berry' ? 'selected' : ''}>甜莓(粉嫩，配可愛圖示包)</option>
        </select>
      </label>
      <div class="setting-row">
        <span class="setting-label">背景圖片(鎖屏與主畫面)${state.settings.bgImage ? ' ●' : ''}</span>
        <span>
          <input type="file" id="bgFile" accept="image/*" hidden>
          <button class="mini-btn" id="btnBgPick">上傳</button>
          <button class="mini-btn" id="btnBgClear" ${state.settings.bgImage ? '' : 'disabled'}>移除</button>
        </span>
      </div>

      <div class="people-heading">顯示</div>
      <label class="setting-row">
        <span class="setting-label">字體大小<br><span class="setting-hint">調大一點，眼睛不那麼累</span></span>
        <select id="selFontScale" class="theme-select">
          ${[['small', '小'], ['normal', '標準'], ['large', '大'], ['xlarge', '特大']]
            .map(([v, l]) => `<option value="${v}" ${(state.settings.fontScale || 'normal') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <label class="setting-row">
        <span class="setting-label">訊息顯示時間</span>
        <input type="checkbox" id="chkTimestamps" ${state.settings.showTimestamps !== false ? 'checked' : ''}>
      </label>
      <label class="setting-row">
        <span class="setting-label">啟動時顯示鎖定畫面</span>
        <input type="checkbox" id="chkLockScreen" ${state.settings.showLockScreen !== false ? 'checked' : ''}>
      </label>
      <label class="setting-row">
        <span class="setting-label">重新開啟時回到上次聊天室<br>
          <span class="setting-hint">關閉時(預設)每次都先進主畫面</span></span>
        <input type="checkbox" id="chkResume" ${state.settings.resumeLastRoom === true ? 'checked' : ''}>
      </label>

      <div class="people-heading">提示詞</div>
      <label class="field" style="padding:0 2px">全域提示詞(所有對話與模式都套用，位於 prompt 最開頭)
        <textarea id="globalPromptBox" rows="3" maxlength="2000" data-counter placeholder="例如：所有角色使用台灣用語；禁止替玩家角色代言或決定其行動">${esc(state.settings.globalPrompt || '')}</textarea>
        <span class="char-count"></span>
      </label>
      <div class="form-actions"><button class="ghost-btn slim" id="btnSaveGlobalPrompt">儲存全域提示詞</button></div>

      <div class="field-label">風格模組(勾選即生效於所有對話；想漫才就開、不想就關)</div>
      ${state.settings.styleModules.map((m) => `
        <div class="preset-row">
          <input type="checkbox" data-sm-toggle="${esc(m.id)}" ${m.enabled ? 'checked' : ''} aria-label="啟用 ${esc(m.name)}">
          <span class="preset-info" title="${esc(m.content)}">${esc(m.name)}</span>
          <button class="mini-btn" data-sm-edit="${esc(m.id)}">編輯</button>
          <button class="mini-btn danger" data-sm-del="${esc(m.id)}">刪除</button>
        </div>`).join('')}
      <div class="form-actions"><button class="ghost-btn slim" id="btnNewStyleModule">＋ 新增風格模組</button></div>

      <label class="field" style="padding:0 2px">快速回覆按鈕(每行一個；顯示在對話輸入框上方，點了直接送出)
        <textarea id="quickRepliesBox" rows="2" maxlength="500">${esc((state.settings.quickReplies || []).join('\n'))}</textarea>
      </label>
      <div class="form-actions"><button class="ghost-btn slim" id="btnSaveQuickReplies">儲存快速回覆</button></div>

      <div class="field-label">輸出替換規則(對所有 AI 輸出做「找→換」，例如把 *動作* 星號體換成(動作))</div>
      ${state.settings.outputRules.map((r) => `
        <div class="preset-row">
          <input type="checkbox" data-or-toggle="${esc(r.id)}" ${r.enabled ? 'checked' : ''} aria-label="啟用規則">
          <span class="preset-info">${r.regex ? '[regex] ' : ''}${esc(r.find)} → ${esc(r.replace || '(刪除)')}</span>
          <button class="mini-btn danger" data-or-del="${esc(r.id)}">刪除</button>
        </div>`).join('')}
      <div class="form-actions"><button class="ghost-btn slim" id="btnNewOutputRule">＋ 新增規則</button></div>

      <div class="people-heading">正文</div>
      <label class="field" style="padding:0 2px">格式指令(套用於所有正文場景；單一場景可用「備註」覆寫)
        <textarea id="storyFormatBox" rows="3" maxlength="1000" data-counter>${esc(state.settings.storyFormat || '')}</textarea>
        <span class="char-count"></span>
      </label>
      <div class="form-actions"><button class="ghost-btn slim" id="btnSaveStoryFormat">儲存格式指令</button></div>
      <div class="field-label" style="margin-top:8px">App 圖示包(每格丟一張方形圖即換皮；沒圖的維持預設字符)</div>
      <div class="icon-pack-grid">
        ${[...HOME_APPS, ...DOCK_APPS].map((app) => {
    const cur = state.settings.appIcons?.[app.id];
    return `
          <div class="icon-slot">
            <button class="icon-slot-preview ${cur ? 'has-img' : ''}" data-icon-up="${esc(app.id)}" aria-label="上傳 ${esc(app.label)} 圖示">
              ${cur ? `<img src="${cur}" alt="">` : `<span>${app.glyph}</span>`}
            </button>
            <span class="icon-slot-label">${esc(app.label)}</span>
            ${cur ? `<button class="mini-btn danger" data-icon-clear="${esc(app.id)}">清除</button>` : ''}
          </div>`;
  }).join('')}
      </div>
      <div class="form-actions"><button class="ghost-btn slim" id="btnClearAllIcons">全部還原預設圖示</button></div>
      <input type="file" id="iconFile" accept="image/*" hidden>

      <label class="setting-row">
        <span class="setting-label">主畫面角色狀態卡<br><span class="setting-hint">時鐘下方那張「誰在線上」的小卡</span></span>
        <input type="checkbox" id="chkStatusCard" ${state.settings.showStatusCard !== false ? 'checked' : ''}>
      </label>
      <label class="setting-row">
        <span class="setting-label">角色心情小表情<br><span class="setting-hint">DM 標題與好友列顯示他此刻對你的心情(模型每則順手標記)</span></span>
        <input type="checkbox" id="chkMoodEmoji" ${state.settings.moodEmoji !== false ? 'checked' : ''}>
      </label>
      <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">
        <span class="setting-label">🐕 桌面寵物<br><span class="setting-hint">住在主畫面底部，會走來走去；點牠會講話。零 API 純裝飾。建議上傳去背 PNG(站/走/坐最多三張，只給一張全狀態共用)。</span></span>
        <label class="check-field"><input type="checkbox" id="chkPet" ${petSettings().enabled ? 'checked' : ''}> 啟用</label>
        <input id="petName" maxlength="12" value="${esc(petSettings().name || '')}" placeholder="名字(例：豬皮)">
        <div class="pk-type-row">
          <label class="ghost-btn slim">站姿圖<input type="file" id="petImgStand" accept="image/*" hidden></label>
          <label class="ghost-btn slim">走路圖<input type="file" id="petImgWalk" accept="image/*" hidden></label>
          <label class="ghost-btn slim">坐姿圖<input type="file" id="petImgSit" accept="image/*" hidden></label>
          <button class="ghost-btn slim" id="petImgClear">還原預設狗</button>
        </div>
        <textarea id="petLines" rows="3" placeholder="台詞池，一行一句">${esc((petSettings().lines || []).join('\n'))}</textarea>
      </div>
      <label class="setting-row">
        <span class="setting-label">內建正文導演指令<br><span class="setting-hint">場景敘事自動帶導演配方：多人=反應分工不撞戲，單人=內外落差深描；含感官錨點、長度地板(英文注入省 token,輸出仍為繁中)</span></span>
        <input type="checkbox" id="chkStoryDirector" ${state.settings.storyDirector !== false ? 'checked' : ''}>
      </label>
      <label class="setting-row">
        <span class="setting-label">私訊聊天感<br><span class="setting-hint">回覆拆成 1~3 則短訊、口語化、壓掉小說式旁白(匯入卡的旁白腔靠這個治)</span></span>
        <input type="checkbox" id="chkChatFeel" ${state.settings.chatFeel !== false ? 'checked' : ''}>
      </label>
      <label class="setting-row">
        <span class="setting-label">角色會傳語音訊息<br><span class="setting-hint">情緒濃的時刻，他自己決定改用「說的」(聲波條樣式，點了播放；僅支援語音的裝置)</span></span>
        <input type="checkbox" id="chkVoiceTag" ${state.settings.voiceTag !== false ? 'checked' : ''}>
      </label>
      <label class="setting-row">
        <span class="setting-label">正文行動選項<br><span class="setting-hint">說書人結尾給 2~3 個 ▷ 選項按鈕，可點可無視</span></span>
        <input type="checkbox" id="chkStoryChoices" ${state.settings.storyChoices !== false ? 'checked' : ''}>
      </label>

      <div class="people-heading">AI 連線(API / LLM)</div>
      <div class="panel-note">金鑰只存在這台電腦的瀏覽器裡。目前對話仍使用本機假回覆；這裡先把連線設定準備好，串接時即可直接使用。</div>
      ${apiSectionHtml()}

      <div class="people-heading">資料</div>
      <button class="ghost-btn slim" id="btnImportRoom">匯入聊天室備份</button>
      <input type="file" id="roomFile" accept=".json,application/json" hidden>
      <div class="panel-note">所有資料只存在這台電腦的瀏覽器(IndexedDB)裡，不會傳到任何地方。建議定期匯出備份，避免清瀏覽器快取時遺失。<br><strong>備份不包含 API 金鑰；匯入到新裝置後請自行重新輸入。</strong></div>
      ${(() => {
        const at = state.lastBackupAt;
        const days = at ? Math.floor((Date.now() - at) / 86400000) : null;
        if (at && days < 7) return `<div class="panel-note">上次備份:${days === 0 ? '今天' : `${days} 天前`} ✓</div>`;
        return `<div class="backup-warn">⚠ ${at ? `已 ${days} 天沒備份` : '從未備份'}——iOS 有權在空間吃緊時清掉網站資料，備份是唯一保險。</div>`;
      })()}
      <div class="form-actions">
        <button class="primary-btn slim" id="btnExport">匯出全域備份</button>
        <button class="ghost-btn slim" id="btnImport">匯入備份</button>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>
      <button class="danger-btn slim" id="btnClearAll">清除本機資料</button>

      <div class="people-heading">關於</div>
      <div class="about-block">
        <div class="about-name">${esc(cfg.appName)}</div>
        <div class="about-tag">${esc(cfg.tagline || '')}</div>
        <div class="about-ver">本機原型 · v${esc(String(state.appVersion))}</div>
      </div>
    </div>`;

  bindBack();

  els.phoneScreen.querySelector('#chkTimestamps').addEventListener('change', async (e) => {
    state.settings.showTimestamps = e.target.checked;
    await persist();
  });
  const roomFile = els.phoneScreen.querySelector('#roomFile');
  els.phoneScreen.querySelector('#btnImportRoom').addEventListener('click', () => roomFile.click());
  roomFile.addEventListener('change', async () => {
    const file = roomFile.files[0];
    roomFile.value = '';
    if (!file) return;
    try {
      const parsed = parseRoomImport(await file.text());
      openConfirmModal({
        title: `匯入「${parsed.room.title}」？`,
        body: `${parsed.room.type === 'dm' ? '私訊' : parsed.room.type === 'group' ? '群聊' : '正文場景'},${parsed.participants.length} 位角色、${parsed.messages.length} 則訊息。將建立為新副本，不會覆蓋任何既有資料；同名角色${parsed.room.type === 'dm' ? '會另建「(匯入)」新角色' : '將直接沿用'}。`,
        confirmLabel: '匯入',
        onConfirm: async () => {
          const { room } = await importRoom(parsed);
          const { openRoom } = await import('./rooms.js');
          await openRoom(room.id);
          renderAll();
        },
      });
    } catch (err) {
      alert(`匯入失敗:${err.message}(目前資料未被更動)`);
    }
  });
  els.phoneScreen.querySelector('#selFontScale').addEventListener('change', async (e) => {
    state.settings.fontScale = e.target.value;
    await persist();
    renderAll();
  });
  els.phoneScreen.querySelector('#chkLockScreen').addEventListener('change', async (e) => {
    state.settings.showLockScreen = e.target.checked;
    await persist();
  });
  els.phoneScreen.querySelector('#chkResume').addEventListener('change', async (e) => {
    state.settings.resumeLastRoom = e.target.checked;
    await persist();
  });
  bindApiSection();
  bindCharCounters(els.phoneScreen);
  els.phoneScreen.querySelectorAll('[data-sm-toggle]').forEach((cb) => cb.addEventListener('change', async () => {
    const m = state.settings.styleModules.find((x) => x.id === cb.dataset.smToggle);
    if (m) { m.enabled = cb.checked; await persist(); }
  }));
  els.phoneScreen.querySelectorAll('[data-sm-del]').forEach((b2) => b2.addEventListener('click', async () => {
    state.settings.styleModules = state.settings.styleModules.filter((x) => x.id !== b2.dataset.smDel);
    await persist();
    renderPhone();
  }));
  const openStyleModal = (mod = null) => openModal(`
    <h3>${mod ? '編輯' : '新增'}風格模組</h3>
    <form id="smForm">
      <label class="field">名稱
        <input name="name" required maxlength="30" value="${esc(mod?.name || '')}" placeholder="例如：漫才模式">
      </label>
      <label class="field">指令內容(啟用時注入所有對話的 prompt 開頭)
        <textarea name="content" rows="4" maxlength="2000" data-counter required>${esc(mod?.content || '')}</textarea>
        <span class="char-count"></span>
      </label>
      <div class="form-actions"><button type="submit" class="primary-btn slim">${mod ? '儲存' : '建立'}</button></div>
    </form>`, {
    onOpen(root) {
      bindCharCounters(root);
      root.querySelector('#smForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        if (mod) {
          mod.name = String(fd.get('name')).trim() || mod.name;
          mod.content = String(fd.get('content')).trim();
        } else {
          state.settings.styleModules.push({
            id: `sm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            name: String(fd.get('name')).trim() || '未命名模組',
            content: String(fd.get('content')).trim(),
            enabled: true,
          });
        }
        await persist();
        closeModal();
        renderPhone();
      });
    },
  });
  els.phoneScreen.querySelector('#btnNewStyleModule').addEventListener('click', () => openStyleModal());
  els.phoneScreen.querySelectorAll('[data-sm-edit]').forEach((b2) => b2.addEventListener('click', () => {
    openStyleModal(state.settings.styleModules.find((x) => x.id === b2.dataset.smEdit));
  }));

  els.phoneScreen.querySelector('#btnSaveQuickReplies').addEventListener('click', async () => {
    state.settings.quickReplies = els.phoneScreen.querySelector('#quickRepliesBox').value
      .split('\n').map((q) => q.trim()).filter(Boolean).slice(0, 8);
    await persist();
    renderPhone();
  });
  els.phoneScreen.querySelectorAll('[data-or-toggle]').forEach((cb) => cb.addEventListener('change', async () => {
    const r = state.settings.outputRules.find((x) => x.id === cb.dataset.orToggle);
    if (r) { r.enabled = cb.checked; await persist(); }
  }));
  els.phoneScreen.querySelectorAll('[data-or-del]').forEach((b2) => b2.addEventListener('click', async () => {
    state.settings.outputRules = state.settings.outputRules.filter((x) => x.id !== b2.dataset.orDel);
    await persist();
    renderPhone();
  }));
  els.phoneScreen.querySelector('#btnNewOutputRule').addEventListener('click', () => openModal(`
    <h3>新增輸出替換規則</h3>
    <form id="orForm">
      <label class="field">找什麼<input name="find" required maxlength="200" placeholder="例如:*"></label>
      <label class="field">換成什麼(留空=刪除)<input name="replace" maxlength="200" placeholder="例如:(留空即移除)"></label>
      <label class="check-field"><input type="checkbox" name="regex"> 以正則表達式解讀(進階)</label>
      <div class="form-actions"><button type="submit" class="primary-btn slim">建立</button></div>
    </form>`, {
    onOpen(root) {
      root.querySelector('#orForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        state.settings.outputRules.push({
          id: `or_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          find: String(fd.get('find')),
          replace: String(fd.get('replace') || ''),
          regex: !!fd.get('regex'),
          enabled: true,
        });
        await persist();
        closeModal();
        renderPhone();
      });
    },
  }));

  els.phoneScreen.querySelector('#btnSaveGlobalPrompt').addEventListener('click', async () => {
    state.settings.globalPrompt = els.phoneScreen.querySelector('#globalPromptBox').value.trim();
    await persist();
    renderPhone();
  });
  const iconFile = els.phoneScreen.querySelector('#iconFile');
  let pendingIconId = null;
  els.phoneScreen.querySelectorAll('[data-icon-up]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingIconId = btn.dataset.iconUp;
      iconFile.click();
    });
  });
  iconFile.addEventListener('change', async () => {
    const file = iconFile.files[0];
    iconFile.value = '';
    if (!file || !pendingIconId) return;
    try {
      const dataUrl = await compressAvatar(file, 128);
      state.settings.appIcons[pendingIconId] = dataUrl;
      await persist();
      renderPhone();
    } catch {
      alert('圖片讀取失敗，換一張試試');
    }
  });
  els.phoneScreen.querySelectorAll('[data-icon-clear]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      delete state.settings.appIcons[btn.dataset.iconClear];
      await persist();
      renderPhone();
    });
  });
  els.phoneScreen.querySelector('#btnClearAllIcons').addEventListener('click', async () => {
    state.settings.appIcons = {};
    await persist();
    renderPhone();
  });
  els.phoneScreen.querySelector('#chkStatusCard').addEventListener('change', async (e) => {
    state.settings.showStatusCard = e.target.checked;
    await persist();
    renderAll();
  });
  els.phoneScreen.querySelector('#chkMoodEmoji').addEventListener('change', async (e) => {
    state.settings.moodEmoji = e.target.checked;
    await persist();
    renderAll();
  });
  els.phoneScreen.querySelector('#chkPet')?.addEventListener('change', async (e) => {
    petSettings().enabled = e.target.checked;
    await persist();
  });
  els.phoneScreen.querySelector('#petName')?.addEventListener('change', async (e) => {
    petSettings().name = e.target.value.trim();
    await persist();
  });
  els.phoneScreen.querySelector('#petLines')?.addEventListener('change', async (e) => {
    petSettings().lines = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12);
    await persist();
  });
  for (const [inputId, key] of [['petImgStand', 'imgStand'], ['petImgWalk', 'imgWalk'], ['petImgSit', 'imgSit']]) {
    els.phoneScreen.querySelector(`#${inputId}`)?.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const { compressAvatar } = await import('./image.js');
        petSettings()[key] = await compressAvatar(f, 128);
        await persist();
        alert('寵物圖已更新');
      } catch (err) { alert(`圖片處理失敗:${err.message}`); }
    });
  }
  els.phoneScreen.querySelector('#petImgClear')?.addEventListener('click', async () => {
    Object.assign(petSettings(), { imgStand: null, imgWalk: null, imgSit: null });
    await persist();
    alert('已還原內建簡筆狗');
  });
  els.phoneScreen.querySelector('#chkStoryDirector').addEventListener('change', async (e) => {
    state.settings.storyDirector = e.target.checked;
    await persist();
  });
  els.phoneScreen.querySelector('#chkChatFeel').addEventListener('change', async (e) => {
    state.settings.chatFeel = e.target.checked;
    await persist();
  });
  els.phoneScreen.querySelector('#chkVoiceTag').addEventListener('change', async (e) => {
    state.settings.voiceTag = e.target.checked;
    await persist();
  });
  els.phoneScreen.querySelector('#chkStoryChoices').addEventListener('change', async (e) => {
    state.settings.storyChoices = e.target.checked;
    await persist();
  });
  els.phoneScreen.querySelector('#btnSaveStoryFormat').addEventListener('click', async () => {
    state.settings.storyFormat = els.phoneScreen.querySelector('#storyFormatBox').value.trim();
    await persist();
    renderPhone();
  });

  // 外觀：主題與背景圖
  els.phoneScreen.querySelector('#selTheme').addEventListener('change', async (e) => {
    state.settings.theme = e.target.value;
    await persist();
    applyTheme();
    renderAll();
  });
  const bgFile = els.phoneScreen.querySelector('#bgFile');
  els.phoneScreen.querySelector('#btnBgPick').addEventListener('click', () => bgFile.click());
  bgFile.addEventListener('change', async () => {
    const file = bgFile.files[0];
    if (!file) return;
    try {
      state.settings.bgImage = await compressBackground(file);
      await persist();
      renderPhone();
    } catch (err) {
      alert(err.message);
    }
  });
  els.phoneScreen.querySelector('#btnBgClear').addEventListener('click', async () => {
    state.settings.bgImage = null;
    await persist();
    renderPhone();
  });

  // 資料：全域備份匯出/匯入
  els.phoneScreen.querySelector('#btnExport').addEventListener('click', () => {
    const blob = new Blob([exportStateJson()], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `private-signal-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    state.lastBackupAt = Date.now();
    persist().then(() => renderPhone());
  });
  const importFile = els.phoneScreen.querySelector('#importFile');
  els.phoneScreen.querySelector('#btnImport').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    const file = importFile.files[0];
    if (!file) return;
    openConfirmModal({
      title: '匯入這份備份？',
      body: '匯入會「完全覆蓋」目前裝置上的所有資料(角色、對話、社群、記憶、設定)。建議先匯出一份目前的備份再進行。',
      confirmLabel: '覆蓋匯入',
      onConfirm: async () => {
        try {
          const text = await file.text();
          await importStateJson(text);
          location.reload(); // 重新啟動，乾淨載入匯入後的資料
        } catch (err) {
          alert(`匯入失敗:${err.message}(目前資料未被更動)`);
        }
      },
    });
  });
  els.phoneScreen.querySelector('#btnClearAll').addEventListener('click', () => {
    openConfirmModal({
      title: '清空這支手機？',
      body: '所有角色、聊天紀錄、社群貼文、記憶與設定都會被刪除，畫面會回到最初的樣子。這個動作無法復原。',
      confirmLabel: '全部清除',
      onConfirm: async () => {
        await resetAll();
        initNavigation();
        panelTab = 'memory';
        editingMemoryId = null;
        renderAll();
      },
    });
  });
}

/* ---------------- 右側：管理輔助面板(預設收合) ---------------- */

function renderPanel() {
  const tabs = [
    ['memory', '記憶管理'],
    ['dev', '開發資訊'],
  ];
  els.panelTabs.innerHTML = tabs.map(([key, label]) => `
    <button class="tab ${panelTab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`).join('');
  els.panelTabs.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      panelTab = btn.dataset.tab;
      renderPanel();
    });
  });

  if (panelTab === 'memory') renderMemoryPanel();
  else renderDevPanel();
}

function memoryItemHtml(m) {
  if (editingMemoryId === m.id) {
    return `
      <div class="memory-item editing" data-mem="${esc(m.id)}">
        <textarea class="mem-edit" rows="3">${esc(m.content)}</textarea>
        <div class="mem-date-row">
          <label>事件日期 <input type="date" class="mem-event-date" value="${esc(m.eventDate || '')}"></label>
          <label>年年觸發(生日類,MM-DD)<input class="mem-annual-date" maxlength="5" placeholder="例 03-14" value="${esc(m.annualDate || '')}"></label>
        </div>
        <div class="mem-actions">
          <button class="mini-btn" data-mem-save="${esc(m.id)}">儲存</button>
          <button class="mini-btn" data-mem-cancel="${esc(m.id)}">取消</button>
        </div>
      </div>`;
  }
  return `
    <div class="memory-item ${m.pinned ? 'pinned' : ''}" data-mem="${esc(m.id)}">
      <div class="mem-content">${m.pinned ? '📌 ' : ''}${esc(m.content)}</div>
      <div class="mem-actions">
        <button class="mini-btn" data-mem-edit="${esc(m.id)}">編輯</button>
        <button class="mini-btn" data-mem-pin="${esc(m.id)}">${m.pinned ? '取消釘選' : '釘選'}</button>
        <button class="mini-btn danger" data-mem-del="${esc(m.id)}">刪除</button>
      </div>
    </div>`;
}

function renderMemoryPanel() {
  const state = getState();
  const mem = state.memories;

  const privateSections = Object.entries(mem.byCharacterId)
    .filter(([, list]) => list.length)
    .map(([cid, list]) => {
      const c = getCharacter(cid);
      return `
        <details class="mem-group" data-mem-group="c:${esc(cid)}">
          <summary class="mem-subheading">${esc(c ? c.name : '(已離開的角色)')} 的私密記憶(${list.length})</summary>
          ${list.map(memoryItemHtml).join('')}
        </details>`;
    }).join('');

  const roomSections = Object.entries(mem.byRoomId)
    .filter(([, list]) => list.length)
    .map(([rid, list]) => {
      const r = getRoom(rid);
      return `
        <details class="mem-group" data-mem-group="r:${esc(rid)}">
          <summary class="mem-subheading">場景「${esc(r ? r.title : '(已刪除)')}」的記憶(${list.length})</summary>
          ${list.map(memoryItemHtml).join('')}
        </details>`;
    }).join('');

  els.panelBody.innerHTML = `
    <div class="panel-note">這裡是「總倉庫」：不管你現在開著哪個 App,它都列出全站所有記憶(依歸屬分組)。各對話自己的記憶，主要入口是該對話標題列的「記憶」抽屜。</div>
    <div class="panel-note">在聊天訊息或社群貼文上按「記住」，就能把它變成一條可編輯的記憶。DM 的記憶只有該角色本人看得到。</div>
    <div class="mem-heading">共享記憶(所有角色可見，含社群)</div>
    ${mem.shared.length
    ? `<details class="mem-group" data-mem-group="shared">
         <summary class="mem-subheading">全部共享記憶(${mem.shared.length})</summary>
         ${mem.shared.map(memoryItemHtml).join('')}
       </details>`
    : '<div class="panel-empty small">尚無共享記憶</div>'}
    <div class="mem-heading">角色私密記憶(僅本人可見)</div>
    ${privateSections || '<div class="panel-empty small">尚無私密記憶</div>'}
    <div class="mem-heading">場景記憶(僅在場角色可見)</div>
    ${roomSections || '<div class="panel-empty small">尚無場景記憶</div>'}`;

  els.panelBody.querySelectorAll('.mem-group').forEach((d) => {
    if (openMemGroups.has(d.dataset.memGroup)) d.open = true;
    if (editingMemoryId && d.querySelector(`.memory-item[data-mem="${editingMemoryId}"]`)) d.open = true;
    d.addEventListener('toggle', () => {
      if (d.open) openMemGroups.add(d.dataset.memGroup);
      else openMemGroups.delete(d.dataset.memGroup);
    });
  });
  els.panelBody.querySelectorAll('[data-mem-edit]').forEach((b) => b.addEventListener('click', () => {
    editingMemoryId = b.dataset.memEdit;
    renderMemoryPanel();
  }));
  els.panelBody.querySelectorAll('[data-mem-cancel]').forEach((b) => b.addEventListener('click', () => {
    editingMemoryId = null;
    renderMemoryPanel();
  }));
  els.panelBody.querySelectorAll('[data-mem-save]').forEach((b) => b.addEventListener('click', async () => {
    const item = els.panelBody.querySelector(`.memory-item[data-mem="${b.dataset.memSave}"]`);
    const box = item.querySelector('.mem-edit');
    await editMemory(b.dataset.memSave, box.value, {
      eventDate: item.querySelector('.mem-event-date')?.value ?? undefined,
      annualDate: item.querySelector('.mem-annual-date')?.value ?? undefined,
    });
    editingMemoryId = null;
    renderMemoryPanel();
  }));
  els.panelBody.querySelectorAll('[data-mem-pin]').forEach((b) => b.addEventListener('click', async () => {
    await togglePin(b.dataset.memPin);
    renderMemoryPanel();
  }));
  els.panelBody.querySelectorAll('[data-mem-del]').forEach((b) => b.addEventListener('click', async () => {
    await deleteMemory(b.dataset.memDel);
    renderMemoryPanel();
  }));
}

/** 開發資訊：資料概況與目前對話的 buildPrompt 預覽(未來 API 會收到什麼)。 */
function renderDevPanel() {
  const state = getState();
  const room = state.currentRoomId ? getRoom(state.currentRoomId) : null;
  const chars = room ? getRoomCharacters(room) : [];

  let promptPreview = '<div class="panel-empty small">開啟任一對話後，這裡會顯示「實際會送出」的 prompt 預覽(依房型使用對應建構器)。</div>';
  if (room && chars[0]) {
    const p = room.type === 'group' ? buildGroupPrompt({ roomId: room.id })
      : room.type === 'peek' ? buildPeekPrompt({ roomId: room.id })
        : room.type === 'story' ? buildStoryPrompt({ roomId: room.id })
          : buildPrompt({ character: chars[0], roomId: room.id });
    promptPreview = `<pre class="prompt-preview">${esc(p.system)}</pre>`;
  }

  els.panelBody.innerHTML = `
    <div class="panel-note">這一欄是開發/管理輔助區，不屬於手機本體。</div>
    <div class="mem-heading">目前版本:${esc(getConfig()?.version || '(未知)')}</div>
    <div class="panel-note">回報問題時附上這個版本號；若跟最新交付不符=瀏覽器吃到舊快取，請強制重新整理(或 PWA 移除重加)。</div>
    <div class="mem-heading">資料診斷(暫時性)</div>
    <div class="dev-stats">
      database:${esc(diagnostics.dbName)}<br>
      object store:${esc(diagnostics.storeName)}(key:${esc(diagnostics.stateKey)})<br>
      啟動時讀到既有 state:${diagnostics.loaded === null ? '尚未嘗試' : (diagnostics.loaded ? '是' : '否(本次為全新建立)')}
      ${diagnostics.adoptedFrom ? `<br>已從舊資料庫「${esc(diagnostics.adoptedFrom)}」找回資料(來源未被更動)` : ''}
      ${diagnostics.loadError ? `<br>讀取錯誤:${esc(diagnostics.loadError)}` : ''}<br>
      characters:${state.characters.length} · rooms:${state.rooms.length} ·
      有訊息的 room:${Object.keys(state.messagesByRoom || {}).length}
    </div>
    <div class="mem-heading">資料概況</div>
    <div class="dev-stats">
      角色 ${state.characters.length} · 聊天室 ${state.rooms.length} · 貼文 ${(state.posts || []).length}<br>
      共享記憶 ${state.memories.shared.length} 條
    </div>
    <div class="mem-heading">buildPrompt 預覽(目前對話)</div>
    ${promptPreview}`;
}

/* ---------------- Modal ---------------- */

function openModal(innerHtml, { onOpen } = {}) {
  els.modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <button class="modal-close" id="modalClose" aria-label="關閉視窗">✕</button>
        ${innerHtml}
      </div>
    </div>`;
  els.modalRoot.querySelector('#modalClose').addEventListener('click', closeModal);
  els.modalRoot.querySelector('#modalBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modalBackdrop') closeModal();
  });
  if (onOpen) onOpen(els.modalRoot);
  const firstInput = els.modalRoot.querySelector('input, textarea, select, button.primary-btn');
  if (firstInput) firstInput.focus();
}

function closeModal() {
  els.modalRoot.innerHTML = '';
}

function characterFormFields(c = {}) {
  return `
    <label class="field">名稱
      <input name="name" required value="${esc(c.name || '')}" placeholder="角色的名字">
    </label>
    <label class="field">備註標籤(只有你看得到，用來區分同角色的不同世界觀；絕不會進入提示詞)
      <input name="label" maxlength="30" value="${esc(c.label || '')}" placeholder="例如：家教線、民國線、同居哥哥線">
    </label>
    <label class="field">描述(角色設定)
      <textarea name="description" rows="3" maxlength="8000" data-counter placeholder="角色背景、行為、語氣與互動方式">${esc(c.description || '')}</textarea>
      <span class="char-count"></span>
    </label>
    <label class="field">個性
      <textarea name="personality" rows="2" maxlength="4000" data-counter placeholder="說話方式、脾氣、習慣…">${esc(c.personality || '')}</textarea>
      <span class="char-count"></span>
    </label>
    <label class="field">情境
      <textarea name="scenario" rows="2" maxlength="4000" data-counter placeholder="角色目前身處的狀況">${esc(c.scenario || '')}</textarea>
      <span class="char-count"></span>
    </label>
    <label class="field">系統提示(systemPrompt)
      <textarea name="systemPrompt" rows="3" maxlength="8000" data-counter placeholder="給真實 AI 的角色指令：語氣、個性、回覆風格">${esc(c.systemPrompt || '')}</textarea>
      <span class="char-count"></span>
    </label>
    <label class="field">第一則訊息
      <textarea name="firstMessage" rows="2" maxlength="2000" data-counter placeholder="第一次打開私訊時，角色說的話">${esc(c.firstMessage || '')}</textarea>
      <span class="char-count"></span>
    </label>
    <label class="field">備用開場白(每行一句；開新私訊時與第一則訊息隨機挑一)
      <textarea name="alternateGreetings" rows="2" maxlength="4000" data-counter>${esc((c.alternateGreetings || []).join('\n'))}</textarea>
      <span class="char-count"></span>
    </label>
    <label class="field">Emoji 習慣(留空=看模型心情；例：「幾乎不用，用了代表事情大條」「愛用 😂 和 ~」)
      <input name="emojiStyle" maxlength="100" value="${esc(c.emojiStyle || '')}">
    </label>
    ${ttsAvailable() ? `
    <div class="field-label">語音(朗讀這個角色的訊息時用)</div>
    <label class="field">聲音
      <select name="voiceURI" class="theme-select" style="width:100%; margin-top:5px">
        <option value="">(裝置預設 zh-TW)</option>
        ${listChineseVoices().map((v) => `<option value="${esc(v.voiceURI)}" ${c.voice?.voiceURI === v.voiceURI ? 'selected' : ''}>${esc(v.name)}(${esc(v.lang)})</option>`).join('')}
      </select>
    </label>
    <div class="voice-sliders">
      <label class="field">語速 <input name="vrate" type="range" min="0.5" max="1.6" step="0.05" value="${c.voice?.rate ?? 1}"></label>
      <label class="field">音調 <input name="vpitch" type="range" min="0.6" max="1.5" step="0.05" value="${c.voice?.pitch ?? 1}"></label>
      <button type="button" class="mini-btn" data-voice-test>試聽</button>
    </div>` : ''}
    <label class="check-field">
      <input type="checkbox" name="noPhone" ${c.noPhone ? 'checked' : ''}>
      非現代世界角色(不使用手機：不發社群、不留言、不主動傳訊、對話中不看社群動態；日記與正文照常)
    </label>
    <label class="check-field">
      <input type="checkbox" name="socialMute" ${c.socialMute ? 'checked' : ''}>
      🔇 不參與社群自動留言(不會在你的貼文下出現;自己發文、群聊、正文照常。適合不想攻略的圈內角色)
    </label>
    <label class="field">主動程度(他多常主動傳訊給你)
      <select name="proactivity" class="theme-select" style="width:100%; margin-top:5px">
        ${[['off', '不主動(絕不主動傳訊)'], ['low', '低(高冷，偶爾才想到你)'], ['mid', '中(普通朋友的頻率)'], ['high', '高(黏人，常常想找你)']]
          .map(([v, l]) => `<option value="${v}" ${(c.proactivity || 'mid') === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </label>
    <label class="field">這個角色認識的人設(他眼中的「你」)
      <select name="knownPersonaId" class="theme-select" style="width:100%; margin-top:5px">
        ${getPersonas().map((ps) => `<option value="${esc(ps.id)}" ${(c.knownPersonaId || getState().defaultPersonaId) === ps.id ? 'selected' : ''}>${esc(ps.name)}${ps.label ? ` — ${esc(ps.label)}` : ''}</option>`).join('')}
      </select>
    </label>
    <div class="field">頭像圖片
      <div class="avatar-upload">
        <span class="avatar-preview" id="avatarPreview">${c.avatarImage ? `<img src="${c.avatarImage}" alt="">` : '<span>無</span>'}</span>
        <input type="file" id="avatarFile" accept="image/*" hidden>
        <button type="button" class="mini-btn" id="btnAvatarPick">上傳(自動壓縮)</button>
        <button type="button" class="mini-btn" id="btnAvatarClear">移除</button>
      </div>
    </div>
    <div class="field-row">
      <label class="field half">或 emoji 頭像(留空用首字)
        <input name="avatarEmoji" value="${esc(c.avatarEmoji || '')}" placeholder="例如 🜁">
      </label>
      <label class="field half">主題色
        <input type="color" name="themeColor" value="${esc(c.themeColor || '#8ea7ff')}">
      </label>
    </div>`;
}

function readForm(form) {
  const data = {};
  new FormData(form).forEach((v, k) => { data[k] = String(v); });
  return data;
}

/**
 * 新增角色 modal。
 * 入口:1) 角色與玩家 App 的「＋ 新增角色」 2) 聊天 App 好友分頁右上角「＋ 新增角色」
 *      3) 好友列表空狀態按鈕 4) 建立群聊/場景時角色不足的引導。
 */
function openCharacterModal({ openDmAfter = false, stayInPeople = false } = {}) {
  openModal(`
    <h3>新增角色</h3>
    <form id="charCreateForm">
      ${characterFormFields()}
      <div class="form-actions">
        <button type="submit" class="primary-btn slim">建立角色</button>
      </div>
    </form>`, {
    onOpen(root) {
      bindCharCounters(root);
      const getAvatar = bindAvatarUpload(root);
      root.querySelector('#charCreateForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = readForm(e.target);
        if (!data.name || !data.name.trim()) return;
        data.noPhone = data.noPhone === 'on';
        data.socialMute = data.socialMute === 'on';
        data.alternateGreetings = String(data.alternateGreetings || '').split('\n').map((g) => g.trim()).filter(Boolean);
        const av = getAvatar();
        if (av !== undefined) data.avatarImage = av;
        const { character, dmRoom } = await createCharacter(data);
        getState().currentCharacterId = character.id;
        closeModal();
        if (openDmAfter) {
          await openRoom(dmRoom.id);   // 從聊天 App 進來：直接開私訊
        } else if (stayInPeople) {
          await navigate('people');    // 從角色 App 進來：留在列表看到新角色
        }
        await persist();
        renderAll();
      });
    },
  });
}

function characterChecklist(name) {
  const state = getState();
  return state.characters.map((c) => `
    <label class="check-field">
      <input type="checkbox" name="${name}" value="${esc(c.id)}">
      ${avatarHtml(c, 'sm')} ${esc(c.name)}
    </label>`).join('');
}

function openGroupModal() {
  const state = getState();
  if (state.characters.length < 2) {
    openModal(`
      <h3>建立聊天室</h3>
      <p class="panel-note">聊天室至少需要兩個角色。目前只有 ${state.characters.length} 個——再多認識一位吧。</p>
      <div class="form-actions"><button class="primary-btn slim" id="goCreateChar">去新增角色</button></div>`, {
      onOpen(root) {
        root.querySelector('#goCreateChar').addEventListener('click', () => {
          closeModal();
          openCharacterModal();
        });
      },
    });
    return;
  }
  openModal(`
    <h3>建立聊天室</h3>
    <form id="groupForm">
      <label class="field">聊天室名稱
        <input name="title" required placeholder="例如：深夜留言板">
      </label>
      <div class="field-label">選擇角色(至少 2 位)</div>
      <div class="check-list">${characterChecklist('members')}</div>
      <div class="form-error" id="groupError" role="alert"></div>
      <div class="form-actions">
        <button type="submit" class="primary-btn slim">建立聊天室</button>
      </div>
    </form>`, {
    onOpen(root) {
      root.querySelector('#groupForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const ids = [...e.target.querySelectorAll('input[name="members"]:checked')].map((i) => i.value);
        const title = new FormData(e.target).get('title') || '';
        if (ids.length < 2) {
          root.querySelector('#groupError').textContent = '請至少勾選兩個角色。';
          return;
        }
        const room = await createGroup(title, ids);
        closeModal();
        await openRoom(room.id);
        renderAll();
      });
    },
  });
}

function openStoryModal() {
  const state = getState();
  if (!state.characters.length) {
    openModal(`
      <h3>建立場景</h3>
      <p class="panel-note">正文場景需要至少一位角色。先新增角色吧。</p>
      <div class="form-actions"><button class="primary-btn slim" id="goCreateChar">去新增角色</button></div>`, {
      onOpen(root) {
        root.querySelector('#goCreateChar').addEventListener('click', () => {
          closeModal();
          openCharacterModal();
        });
      },
    });
    return;
  }
  openModal(`
    <h3>建立正文場景</h3>
    <form id="storyForm">
      <label class="field">場景名稱
        <input name="title" required placeholder="例如：末班車之後">
      </label>
      <div class="field-label">在場角色(至少 1 位)</div>
      <div class="check-list">${characterChecklist('members')}</div>
      <div class="form-error" id="storyError" role="alert"></div>
      <div class="form-actions">
        <button type="submit" class="primary-btn slim">建立場景</button>
      </div>
    </form>`, {
    onOpen(root) {
      root.querySelector('#storyForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const ids = [...e.target.querySelectorAll('input[name="members"]:checked')].map((i) => i.value);
        const title = new FormData(e.target).get('title') || '';
        if (ids.length < 1) {
          root.querySelector('#storyError').textContent = '請至少勾選一個角色。';
          return;
        }
        const room = await createStory(title, ids);
        closeModal();
        await openRoom(room.id);
        renderAll();
      });
    },
  });
}

/** 人設建立/編輯 modal。 */
function openPersonaModal(persona = null) {
  const state = getState();
  openModal(`
    <h3>${persona ? '編輯人設' : '新增人設'}</h3>
    <form id="personaForm">
      <div class="field">頭像圖片
        <div class="avatar-upload">
          <span class="avatar-preview" id="avatarPreview">${persona?.avatarImage ? `<img src="${persona.avatarImage}" alt="">` : '<span>無</span>'}</span>
          <input type="file" id="avatarFile" accept="image/*" hidden>
          <button type="button" class="mini-btn" id="btnAvatarPick">上傳(自動壓縮)</button>
          <button type="button" class="mini-btn" id="btnAvatarClear">移除</button>
        </div>
      </div>
      <label class="field">名字
        <input name="name" required maxlength="40" value="${esc(persona?.name || '')}" placeholder="這個「你」叫什麼？">
      </label>
      <label class="field">備註標籤(只顯示在你的選單，角色不會讀到——同名人設靠這個分)
        <input name="label" maxlength="30" value="${esc(persona?.label || '')}" placeholder="例：民國線、現代大學線">
      </label>
      <label class="field">描述(角色眼中的你)
        <textarea name="description" rows="4" maxlength="4000" data-counter placeholder="例如:19 歲大學生，短髮，講話直接">${esc(persona?.description || '')}</textarea>
        <span class="char-count"></span>
      </label>
      <div class="form-actions">
        <button type="submit" class="primary-btn slim">${persona ? '儲存' : '建立'}</button>
        ${persona && getPersonas().length > 1 ? '<button type="button" class="danger-btn slim" id="btnDelPersona">刪除人設</button>' : ''}
        ${persona && persona.id !== state.defaultPersonaId ? '<button type="button" class="ghost-btn slim" id="btnSetDefault">設為預設</button>' : ''}
      </div>
    </form>`, {
    onOpen(root) {
      bindCharCounters(root);
      const getAvatar = bindAvatarUpload(root);
      root.querySelector('#personaForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = readForm(e.target);
        if (!data.name.trim()) return;
        const av = getAvatar();
        if (persona) {
          await updatePersona(persona.id, {
            name: data.name, description: data.description, label: data.label,
            ...(av !== undefined ? { avatarImage: av } : {}),
          });
        } else {
          await createPersona({
            name: data.name, description: data.description, label: data.label,
            avatarImage: av !== undefined ? av : null,
          });
        }
        closeModal();
        renderAll();
      });
      const del = root.querySelector('#btnDelPersona');
      if (del) {
        del.addEventListener('click', () => {
          openConfirmModal({
            title: `刪除人設「${persona.name}」？`,
            body: '綁定這個人設的角色、對話與貼文會全部改指向預設人設，內容不會被刪除。這個動作無法復原。',
            confirmLabel: '刪除',
            onConfirm: async () => {
              try { await deletePersona(persona.id); } catch (err) { alert(err.message); }
              renderAll();
            },
          });
        });
      }
      const setDef = root.querySelector('#btnSetDefault');
      if (setDef) {
        setDef.addEventListener('click', async () => {
          state.defaultPersonaId = persona.id;
          syncPlayerMirror();
          await persist();
          closeModal();
          renderAll();
        });
      }
    },
  });
}

/** 人設選擇 modal(對話切換/發文選身分共用)。 */
function openPersonaSelectModal({ title, current, onSelect }) {
  openModal(`
    <h3>${esc(title)}</h3>
    <div class="check-list">
      ${getPersonas().map((ps) => `
        <button class="list-row persona-option ${ps.id === current ? 'active' : ''}" data-pick-persona="${esc(ps.id)}">
          ${personaAvatarHtml(ps)}
          <span class="list-main">
            <span class="list-title">${esc(ps.name)}${ps.label ? ` <span class="persona-label">— ${esc(ps.label)}</span>` : ''}</span>
            <span class="list-preview">${esc(firstLine(ps.description, 24) || '')}</span>
          </span>
          ${ps.id === current ? '<span class="list-chevron">✓</span>' : ''}
        </button>`).join('')}
    </div>`, {
    onOpen(root) {
      root.querySelectorAll('[data-pick-persona]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          closeModal();
          await onSelect(btn.dataset.pickPersona);
        });
      });
    },
  });
}

function openNewPostModal() {
  openModal(`
    <h3>發貼文</h3>
    <p class="panel-note">貼文是公開的：所有角色都看得到，也可能來留言(附圖時角色也看得到圖)。</p>
    <form id="postForm">
      <label class="field">用哪個身分發?
        <select name="personaId" class="theme-select" style="width:100%; margin-top:5px">
          ${getPersonas().map((ps) => `<option value="${esc(ps.id)}" ${(getState().activePersonaId || getState().defaultPersonaId) === ps.id ? 'selected' : ''}>${esc(ps.name)}${ps.label ? ` — ${esc(ps.label)}` : ''}</option>`).join('')}
        </select>
      </label>
      <label class="field">內容
        <textarea name="content" rows="4" placeholder="想說點什麼？"></textarea>
      </label>
      <div class="field">附加圖片(自動壓縮)
        <div class="avatar-upload">
          <span class="avatar-preview" id="postImgPreview"><span>無</span></span>
          <input type="file" id="postImgFile" accept="image/*" hidden>
          <button type="button" class="mini-btn" id="btnPostImgPick">選擇圖片</button>
          <button type="button" class="mini-btn" id="btnPostImgClear">移除</button>
        </div>
      </div>
      <div class="form-actions">
        <button type="submit" class="primary-btn slim">發布</button>
      </div>
    </form>`, {
    onOpen(root) {
      let postImage = null;
      const fileInput = root.querySelector('#postImgFile');
      root.querySelector('#btnPostImgPick').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        if (!f) return;
        try {
          postImage = await compressPhoto(f);
          root.querySelector('#postImgPreview').innerHTML = `<img src="${postImage}" alt="">`;
        } catch (err) { alert(err.message); }
      });
      root.querySelector('#btnPostImgClear').addEventListener('click', () => {
        postImage = null;
        root.querySelector('#postImgPreview').innerHTML = '<span>無</span>';
      });
      root.querySelector('#postForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const content = fd.get('content') || '';
        const personaId = fd.get('personaId') || getState().defaultPersonaId;
        if (!String(content).trim() && !postImage) return;
        getState().activePersonaId = personaId;
        const post = await createPost('player', content, postImage, personaId);
        closeModal();
        await navigate('social-post', { postId: post.id });
        renderAll();
        // 玩家發文後產生角色留言(只有認識這個人設的角色會出面)
        runMockSocialReplies(post, String(content), personaId);
      });
    },
  });
}

function openConfirmModal({ title, body, confirmLabel, onConfirm }) {
  openModal(`
    <h3>${esc(title)}</h3>
    <p class="panel-note">${esc(body)}</p>
    <div class="form-actions">
      <button class="danger-btn slim" id="confirmYes">${esc(confirmLabel)}</button>
      <button class="ghost-btn slim" id="confirmNo">再想想</button>
    </div>`, {
    onOpen(root) {
      root.querySelector('#confirmYes').addEventListener('click', async () => {
        closeModal();
        await onConfirm();
      });
      root.querySelector('#confirmNo').addEventListener('click', closeModal);
    },
  });
}

/** 從聊天訊息建立記憶(依 room 類型決定可見範圍)。 */
function openMemoryCandidateModal(message, roomId) {
  const candidate = createMemoryCandidate(message, roomId);
  if (!candidate) return;

  const scopeLabel = candidate.visibility === 'private'
    ? `${getCharacter(candidate.characterId)?.name || '此角色'} 的私密記憶(其他角色不可見)`
    : candidate.visibility === 'room'
      ? `場景「${getRoom(roomId)?.title || ''}」的記憶(僅在場角色可見)`
      : '共享記憶(所有角色可見)';

  openModal(`
    <h3>記住這件事</h3>
    <p class="panel-note">這是訊息原文的截取，不是自動摘要——儲存前可以改寫成你想讓角色記得的樣子。</p>
    <label class="field">記憶內容
      <textarea id="memCandidate" rows="4">${esc(candidate.content)}</textarea>
    </label>
    <div class="field-label">可見範圍:${esc(scopeLabel)}</div>
    <div class="form-actions">
      <button class="primary-btn slim" id="memSave">存入記憶</button>
    </div>`, {
    onOpen(root) {
      root.querySelector('#memSave').addEventListener('click', async () => {
        candidate.content = root.querySelector('#memCandidate').value;
        await addMemory(candidate);
        closeModal();
        if (panelTab === 'memory') renderMemoryPanel();
      });
    },
  });
}

/** 房間記憶抽屜：這個對話「看得到」的記憶，可直接編輯/釘選/刪除/手動新增。 */
function openRoomMemoryModal(room) {
  const state = getState();
  const chars = getRoomCharacters(room);
  const dmChar = room.type === 'dm' ? chars[0] : null;

  // 這個對話可見的記憶分組(每次重繪重算，新增的記憶即時出現)
  const computeGroups = () => {
    const g2 = [];
    if (dmChar) {
      g2.push({
        key: 'private', label: `${dmChar.name} 的私密記憶(僅本人可見)`,
        list: state.memories.byCharacterId[dmChar.id] || [],
      });
    }
    if (room.type === 'story') {
      g2.push({
        key: 'room', label: '本場景記憶(僅在場角色可見)',
        list: state.memories.byRoomId[room.id] || [],
      });
    }
    g2.push({
      key: 'shared',
      label: '共享記憶(本圈子與全域)',
      list: state.memories.shared.filter((m) => !m.circleId || m.circleId === (personaForRoom(room)?.id)),
    });
    return g2;
  };
  let groups = computeGroups();

  // 手動新增的可選範圍
  const roomPersona = personaForRoom(room);
  const scopeOptions = [
    ...(dmChar ? [['private', `${dmChar.name} 的私密記憶`]] : []),
    ...(room.type === 'story' ? [['room', '本場景記憶']] : []),
    ['shared', `共享記憶(${roomPersona?.name || '本'}圈子)`],
    ['shared-global', '共享記憶(所有角色)'],
  ];

  let editingId = null;

  const itemHtml = (m) => {
    if (editingId === m.id) {
      return `
        <div class="memory-item editing" data-mem="${esc(m.id)}">
          <textarea class="mem-edit" rows="3">${esc(m.content)}</textarea>
          <div class="mem-actions">
            <button class="mini-btn" data-rm-save="${esc(m.id)}">儲存</button>
            <button class="mini-btn" data-rm-cancel="${esc(m.id)}">取消</button>
          </div>
        </div>`;
    }
    return `
      <div class="memory-item ${m.pinned ? 'pinned' : ''}" data-mem="${esc(m.id)}">
        <div class="mem-content">${m.pinned ? '📌 ' : ''}${esc(m.content)}</div>
        <div class="mem-actions">
          <button class="mini-btn" data-rm-edit="${esc(m.id)}">編輯</button>
          <button class="mini-btn" data-rm-pin="${esc(m.id)}">${m.pinned ? '取消釘選' : '釘選'}</button>
          <button class="mini-btn danger" data-rm-del="${esc(m.id)}">刪除</button>
        </div>
      </div>`;
  };

  const bodyHtml = () => groups.map((gp) => `
    <div class="mem-heading">${esc(gp.label)}</div>
    ${gp.list.length ? gp.list.map(itemHtml).join('') : '<div class="panel-empty small">(無)</div>'}`).join('')
    + `
    ${(getState().settings.styleModules || []).length ? `
      <div class="mem-heading">風格模組(僅本對話)</div>
      <div class="panel-note">勾選狀態只影響這個對話；其他對話跟隨設定裡的全域開關。</div>
      ${getState().settings.styleModules.map((sm) => {
    const ov = room.styleOverrides?.[sm.id];
    const eff = ov === undefined ? sm.enabled : ov;
    return `
        <label class="check-field">
          <input type="checkbox" data-room-sm="${esc(sm.id)}" ${eff ? 'checked' : ''}>
          ${esc(sm.name)}${ov === undefined ? '(跟隨全域)' : '(本對話覆寫)'}
        </label>`;
  }).join('')}
      <button class="mini-btn" id="rmStyleReset">還原全部跟隨全域</button>
    ` : ''}
    ${room.type === 'story' ? `
      <div class="mem-heading">章節</div>
      <div class="panel-note">封存=把本章摘要進場景記憶+清空對話重新開始；原文完整保留可回翻，說書人會記得前情。</div>
      ${(room.archivedChapters || []).map((ch) => `
        <button class="list-row" data-open-chapter="${ch.n}">
          <span class="list-main">
            <span class="list-title">${esc(ch.title)}</span>
            <span class="list-preview">${ch.messages.length} 則 · ${fmtTime(ch.archivedAt)}</span>
          </span><span class="list-chevron">›</span>
        </button>`).join('')}
      <button class="ghost-btn slim" id="rmArchiveChapter">✦ 封存本章、開新章</button>
    ` : ''}
    <div class="mem-heading">本聊天室備份</div>
    <div class="panel-note">單獨打包這條故事線(訊息+場景記憶${'$'}{room.type === 'dm' ? '+這位角色的私密記憶' : ''};不含金鑰與其他對話)。匯入入口在設定 → 資料。</div>
    <button class="ghost-btn slim" id="rmExportRoom">匯出此聊天室</button>
    <div class="mem-heading">Prompt 檢視</div>
    <button class="ghost-btn slim" id="rmInspect">🔍 檢視本次會送出的 prompt(含成本估算)</button>
    <div class="mem-heading">對話摘要(長期記憶)</div>
    <div class="panel-note">把上次摘要之後的對話濃縮成幾條記憶，勾選後存入——舊劇情就不會因為超出上下文而蒸發。</div>
    <button class="ghost-btn slim" id="rmSummarize">✦ 摘要至今</button>
    <div id="rmSummaryArea"></div>
    <div class="mem-heading">手動新增記憶</div>
    <textarea id="rmNewContent" rows="2" class="mem-edit" placeholder="直接寫一條你想讓角色記得的事"></textarea>
    <div class="field-row" style="align-items:center; gap:8px; margin-top:6px">
      <select id="rmNewScope" class="theme-select" style="flex:1">
        ${scopeOptions.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
      </select>
      <button class="mini-btn" id="rmNewAdd">新增</button>
    </div>`;

  openModal(`
    <h3>這個對話的記憶</h3>
    <p class="panel-note">只列出「${esc(room.title)}」看得到的記憶，改完直接生效，下一次回覆就會用到。</p>
    <div id="rmBody">${bodyHtml()}</div>`, {
    onOpen(root) {
      const body = root.querySelector('#rmBody');
      const rerender = () => { groups = computeGroups(); body.innerHTML = bodyHtml(); bind(); };
      const bind = () => {
        body.querySelectorAll('[data-rm-edit]').forEach((b2) => b2.addEventListener('click', () => {
          editingId = b2.dataset.rmEdit; rerender();
        }));
        body.querySelectorAll('[data-rm-cancel]').forEach((b2) => b2.addEventListener('click', () => {
          editingId = null; rerender();
        }));
        body.querySelectorAll('[data-rm-save]').forEach((b2) => b2.addEventListener('click', async () => {
          const box = body.querySelector(`.memory-item[data-mem="${b2.dataset.rmSave}"] .mem-edit`);
          await editMemory(b2.dataset.rmSave, box.value);
          editingId = null; rerender();
        }));
        body.querySelectorAll('[data-rm-pin]').forEach((b2) => b2.addEventListener('click', async () => {
          await togglePin(b2.dataset.rmPin); rerender();
        }));
        body.querySelectorAll('[data-rm-del]').forEach((b2) => b2.addEventListener('click', async () => {
          await deleteMemory(b2.dataset.rmDel); rerender();
        }));
        body.querySelectorAll('[data-room-sm]').forEach((cb) => cb.addEventListener('change', async () => {
          if (!room.styleOverrides) room.styleOverrides = {};
          room.styleOverrides[cb.dataset.roomSm] = cb.checked;
          await persist();
          rerender();
        }));
        const styleReset = body.querySelector('#rmStyleReset');
        if (styleReset) {
          styleReset.addEventListener('click', async () => {
            room.styleOverrides = {};
            await persist();
            rerender();
          });
        }
        const archBtn = body.querySelector('#rmArchiveChapter');
        if (archBtn) {
          archBtn.addEventListener('click', async () => {
            archBtn.disabled = true;
            archBtn.textContent = '摘要中…';
            const r = await archiveChapter(room.id);
            if (!r.ok) {
              alert(r.message);
              archBtn.disabled = false;
              archBtn.textContent = '✦ 封存本章、開新章';
              return;
            }
            closeModal();
            renderAll();
          });
        }
        body.querySelectorAll('[data-open-chapter]').forEach((chBtn) => {
          chBtn.addEventListener('click', () => {
            const ch = (room.archivedChapters || []).find((x) => String(x.n) === chBtn.dataset.openChapter);
            if (!ch) return;
            openModal(`
              <h3>${esc(ch.title)}</h3>
              <div class="chapter-scroll">
                ${ch.messages.map((m2) => {
    const who = m2.senderId === 'player' ? '你' : m2.senderId === 'system' ? '' : (getCharacter(m2.senderId)?.name || '旁白');
    return `<div class="chapter-line"><b>${esc(who)}</b>${who ? ':' : ''}${esc(m2.content).replaceAll('\n', '<br>')}</div>`;
  }).join('')}
              </div>`);
          });
        });
        body.querySelector('#rmExportRoom').addEventListener('click', () => {
          const d = new Date();
          const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
          downloadJson(exportRoomJson(room.id), `${room.title}-room-${date}.json`);
        });
        body.querySelector('#rmInspect').addEventListener('click', () => {
          closeModal();
          openPromptInspectModal(room);
        });
        body.querySelector('#rmSummarize').addEventListener('click', async () => {
          const area = body.querySelector('#rmSummaryArea');
          area.innerHTML = '<div class="api-status">整理中…</div>';
          const r = await generateSummaryCandidates(room.id);
          if (!r.ok) { area.innerHTML = `<div class="api-status err">${esc(r.message)}</div>`; return; }
          area.innerHTML = `
            ${r.items.map((it, i) => `
              <label class="check-field summary-item">
                <input type="checkbox" data-sum-check="${i}" checked>
                <textarea class="mem-edit" rows="2" data-sum-text="${i}">${esc(it)}</textarea>
              </label>`).join('')}
            <button class="mini-btn" id="rmSumSave">存入勾選的 ${r.items.length} 條</button>`;
          area.querySelector('#rmSumSave').addEventListener('click', async () => {
            let saved = 0;
            for (const [i] of r.items.entries()) {
              if (!area.querySelector(`[data-sum-check="${i}"]`).checked) continue;
              const content = area.querySelector(`[data-sum-text="${i}"]`).value.trim();
              if (!content) continue;
              await addMemory({
                content,
                visibility: dmChar ? 'private' : (room.type === 'story' ? 'room' : 'shared'),
                characterId: dmChar ? dmChar.id : undefined,
                circleId: dmChar || room.type === 'story' ? null : (personaForRoom(room)?.id || null),
                sourceRoomId: room.type === 'story' ? room.id : null,
              });
              saved += 1;
            }
            await commitSummary(room.id, saved);
            rerender();
          });
        });

        body.querySelector('#rmNewAdd').addEventListener('click', async () => {
          const content = body.querySelector('#rmNewContent').value.trim();
          if (!content) return;
          const scope = body.querySelector('#rmNewScope').value;
          await addMemory({
            content,
            visibility: scope.startsWith('shared') ? 'shared' : scope,
            characterId: scope === 'private' ? dmChar.id : undefined,
            circleId: scope === 'shared' ? (roomPersona?.id || null) : null,
            sourceRoomId: scope === 'room' ? room.id : null,
          });
          rerender();
        });
      };
      bind();
    },
  });
}

/** 分享貼文到聊天室：選一個 DM/群聊，附一句話送出。 */
function openSharePostModal(post) {
  const state = getState();
  const rooms = state.rooms.filter((r) => r.type === 'dm' || r.type === 'group');
  if (!rooms.length) {
    openModal('<h3>分享貼文</h3><p class="panel-note">還沒有可分享的聊天。先新增角色吧。</p>');
    return;
  }
  const who = post.authorId === 'player'
    ? ((getPersona(post.personaId) || defaultPersona())?.name || '你')
    : authorName(post.authorId);
  const excerpt = post.content.length > 60 ? `${post.content.slice(0, 60)}…` : post.content;

  openModal(`
    <h3>分享貼文到聊天</h3>
    <div class="shared-post-card preview">
      <div class="shared-post-head">${esc(who)} 的貼文</div>
      ${post.image ? `<img class="shared-post-img" src="${post.image}" alt="">` : ''}
      <div class="shared-post-body">${esc(excerpt)}</div>
    </div>
    <label class="field">附一句話(可留空)
      <input id="shareMsg" maxlength="500" placeholder="例如：哥你這什麼意思啊">
    </label>
    <div class="field-label">傳到哪裡?</div>
    <div class="check-list">
      ${rooms.map((r) => `
        <button class="list-row" data-share-room="${esc(r.id)}">
          <span class="avatar sm neutral" aria-hidden="true">${r.type === 'group' ? '◍' : '◖◗'}</span>
          <span class="list-main"><span class="list-title">${esc(r.title)}</span></span>
        </button>`).join('')}
    </div>`, {
    onOpen(root) {
      root.querySelectorAll('[data-share-room]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const text = root.querySelector('#shareMsg').value;
          closeModal();
          const sharedPost = {
            postId: post.id,
            authorName: who,
            excerpt,
            image: post.image || null,
          };
          await openRoom(btn.dataset.shareRoom);
          renderAll();
          // 跟平常傳訊息一樣直接觸發角色回覆
          await sendUserMessage(btn.dataset.shareRoom, text, (info) => {
            typingBy = info.typingBy || '';
            if (getState().currentRoomId === btn.dataset.shareRoom) renderMessages();
          }, null, sharedPost);
          typingBy = '';
          if (getState().currentRoomId === btn.dataset.shareRoom) renderMessages();
        });
      });
    },
  });
}

/** Prompt 預覽與成本估算。 */
function openPromptInspectModal(room) {
  const chars = getRoomCharacters(room);
  let built;
  if (room.type === 'group') built = buildGroupPrompt({ roomId: room.id });
  else if (room.type === 'peek') built = buildPeekPrompt({ roomId: room.id });
  else if (room.type === 'story') built = buildStoryPrompt({ roomId: room.id });
  else built = buildPrompt({ character: chars[0], roomId: room.id });

  const histChars = built.messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  const sysChars = built.system.length;
  const inTokens = Math.round((sysChars + histChars) * 1.5);   // 中文粗估 1 字 ≈ 1.5 token
  const outTokens = Math.round((built.meta?.maxReplyChars || 800) * 1.5);
  // 參考價:Flash 級 $0.30/M 輸入、$2.50/M 輸出；台幣 ×32
  const inCost = (inTokens / 1e6) * 0.30 * 32;
  const outCost = (outTokens / 1e6) * 2.50 * 32;

  openModal(`
    <h3>本次 Prompt 預覽</h3>
    <div class="panel-note">
      系統段 ${sysChars} 字 + 歷史 ${built.messages.length} 則(${histChars} 字)≈ <strong>${inTokens.toLocaleString()} tokens 輸入</strong><br>
      粗估成本(Flash 級參考價):輸入約 NT$${inCost.toFixed(2)},輸出滿上限(${built.meta?.maxReplyChars} 字)最多約 NT$${outCost.toFixed(2)}<br>
      <span style="opacity:.7">估算僅供參考，實際依供應商計價；思考模式會另計。</span>
    </div>
    <div class="field-label">系統段內容(世界書/記憶是否進場，一看便知):</div>
    <pre class="prompt-inspect">${esc(built.system)}</pre>`);
}

/** 場景/群聊成員管理：中途加入或移出角色，可附登場/退場敘述。 */
function openRoomMembersModal(room) {
  const state = getState();
  const inIds = room.participantIds.filter((id) => id !== 'player');
  const outChars = state.characters.filter((c) => !inIds.includes(c.id));
  const isStory = room.type === 'story';

  openModal(`
    <h3>成員(${inIds.length})</h3>
    <div class="field-label">目前在場:</div>
    ${inIds.map((id) => {
    const c = getCharacter(id);
    return c ? `
      <div class="list-row" style="cursor:default">
        ${avatarHtml(c, 'sm')}
        <span class="list-main"><span class="list-title">${esc(c.name)}</span></span>
        <button class="mini-btn danger" data-member-out="${esc(c.id)}">移出</button>
      </div>` : '';
  }).join('')}
    <div class="field-label" style="margin-top:10px">加入角色:</div>
    ${outChars.length ? outChars.map((c) => `
      <div class="list-row" style="cursor:default">
        ${avatarHtml(c, 'sm')}
        <span class="list-main"><span class="list-title">${esc(c.name)}</span></span>
        <button class="mini-btn" data-member-in="${esc(c.id)}">加入</button>
      </div>`).join('') : '<div class="panel-empty small">所有角色都在場了</div>'}
    <label class="check-field" style="margin-top:10px">
      <input type="checkbox" id="memberNarr" checked> 加入/移出時插入一句${isStory ? '敘述' : '系統訊息'}(可先改再送)
    </label>`, {
    onOpen(root) {
      const doChange = async (charId, joining) => {
        const c = getCharacter(charId);
        try {
          if (joining) await addRoomMember(room.id, charId);
          else await removeRoomMember(room.id, charId);
        } catch (err) { alert(err.message); return; }
        if (root.querySelector('#memberNarr').checked && c) {
          const preset = joining
            ? (isStory ? `此時,${c.name}來到了這裡。` : `${c.name} 加入了聊天室`)
            : (isStory ? `${c.name}先行離開了。` : `${c.name} 離開了聊天室`);
          const text = prompt(joining ? '登場敘述(可修改):' : '退場敘述(可修改):', preset);
          if (text && text.trim()) {
            const msgs = getState().messagesByRoom[room.id] || (getState().messagesByRoom[room.id] = []);
            msgs.push({
              id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
              role: isStory ? 'narrator' : 'system',
              senderId: 'system',
              content: text.trim(),
              createdAt: Date.now(),
            });
            await persist();
          }
        }
        closeModal();
        renderPhone();
      };
      root.querySelectorAll('[data-member-in]').forEach((b) => b.addEventListener('click', () => doChange(b.dataset.memberIn, true)));
      root.querySelectorAll('[data-member-out]').forEach((b) => b.addEventListener('click', () => doChange(b.dataset.memberOut, false)));
    },
  });
}

/* ---------------- v60. 角色手機 App(K 案收納頁：狀態/快照/日記一站看) ---------------- */

function renderCharPhoneList() {
  const state = getState();
  const chars = state.characters.filter((c) => !c.noPhone);
  const hiddenCount = state.characters.length - chars.length;
  const rows = chars.map((c) => `
    <button class="list-row" data-cp-open="${esc(c.id)}">
      ${avatarHtml(c)}
      <span class="list-main">
        <span class="list-title">${esc(c.name)}${c.label?.trim() ? ` <span class="char-label">${esc(c.label.trim())}</span>` : ''}</span>
        ${c.status?.text ? `<span class="list-preview">♪ ${esc(firstLine(c.status.text, 22))}</span>` : ''}
      </span>
      <span class="list-chevron" aria-hidden="true">›</span>
    </button>`).join('');
  els.phoneScreen.innerHTML = `
    ${appHeader('角色手機')}
    <div class="phone-list">
      <div class="panel-note">選一個人，看看他的手機裡有什麼。他不會知道。</div>
      ${rows || '<div class="list-empty small">還沒有(有手機的)角色。</div>'}
      ${hiddenCount ? `<div class="panel-note">另有 ${hiddenCount} 位沒有手機的角色未列出。</div>` : ''}
    </div>`;
  bindBack();
  els.phoneScreen.querySelectorAll('[data-cp-open]').forEach((b) => b.addEventListener('click', async () => {
    await navigate('char-phone-detail', { characterId: b.dataset.cpOpen });
    renderPhone();
  }));
}

function renderCharPhoneDetail() {
  const state = getState();
  const c = state.currentCharacterId ? getCharacter(state.currentCharacterId) : null;
  if (!c || c.noPhone) { navigate('char-phone').then(renderAll); return; }

  const peeks = phonePeeksFor(c.id);
  const latestOf = (type) => peeks.find((p) => p.type === type) || null;
  const diaries = getDiaries(c.id).slice(0, 2);
  const fmtD = (ts) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const sectionHtml = (type) => {
    const latest = latestOf(type);
    const label = PEEK_TYPES[type]?.label || type;
    return `
      <div class="cp-section">
        <div class="cp-section-head">
          <span>${esc(label)}</span>
          <button class="mini-btn" data-cp-gen="${esc(type)}">${latest ? '↻ 更新快照' : '👀 窺看'}</button>
        </div>
        ${latest ? peekCardHtml(latest) : '<div class="cp-empty">尚未窺看。(一次一則生成，走次要模型)</div>'}
      </div>`;
  };

  els.phoneScreen.innerHTML = `
    ${appHeader(`${c.name} 的手機`, {
      subtitle: c.status?.text ? `♪ ${firstLine(c.status.text, 20)}` : '螢幕沒鎖，你就看了',
      leadingHtml: avatarHtml(c, 'sm'),
    })}
    <div class="phone-list cp-page">
      ${c.status?.text ? `<div class="cp-status-card">狀態:${esc(c.status.text)}<span class="cp-status-time">${esc(fmtD(c.status.at || Date.now()))}</span></div>` : ''}
      ${sectionHtml('playlist')}
      ${sectionHtml('search')}
      ${sectionHtml('draft')}
      <div class="cp-section">
        <div class="cp-section-head">
          <span>日記</span>
          <button class="mini-btn" id="cpOpenDiary">打開日記</button>
        </div>
        ${diaries.length
          ? diaries.map((d) => `<div class="cp-diary-line">📔 ${esc(fmtD(d.createdAt))} ${esc(firstLine(d.content, 34))}</div>`).join('')
          : '<div class="cp-empty">他最近沒寫日記。</div>'}
      </div>
      ${peeks.length ? `<details class="pk-history"><summary>歷史快照(${peeks.length})</summary>${peeks.map(peekCardHtml).join('')}</details>` : ''}
    </div>`;

  bindBack();
  els.phoneScreen.querySelector('#cpOpenDiary')?.addEventListener('click', async () => {
    await navigate('character-diary', { characterId: c.id });
    renderPhone();
  });
  els.phoneScreen.querySelectorAll('[data-cp-gen]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const orig = b.textContent;
    b.textContent = '…窺看中';
    const r = await generatePhonePeek(c.id, b.dataset.cpGen);
    if (!r.ok) { alert(r.message); b.disabled = false; b.textContent = orig; return; }
    renderPhone();
  }));
}

/** 提案 K:快照分型渲染(手機截圖風；全部過 esc)。 */
function peekCardHtml(entry) {
  const lines = String(entry.content || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const when = new Date(entry.createdAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  let body = '';
  if (entry.type === 'draft') {
    body = lines.map((l) => {
      const parts = l.split('||').map((p) => p.trim());
      // v60:三欄「收件人||草稿||原因」；舊二欄「草稿||原因」相容
      const [to, draft, note] = parts.length >= 3 ? parts : [null, parts[0], parts[1]];
      return `<div class="pk-draft">${to ? `<div class="pk-draft-to">To:${esc(to)}</div>` : ''}<div class="pk-draft-bubble">${esc(draft || l)}</div>${note ? `<div class="pk-draft-note">${esc(note)}</div>` : ''}</div>`;
    }).join('');
  } else if (entry.type === 'playlist') {
    body = lines.map((l) => {
      if (/^循環理由[::]/.test(l)) return `<div class="pk-reason">${esc(l)}</div>`;
      return `<div class="pk-song">♪ ${esc(l)}</div>`;
    }).join('');
  } else {
    // v60:搜尋紀錄加程式端時間裝飾(確定性遞減，零鸚鵡風險)
    let t = entry.createdAt;
    body = lines.map((l, i) => {
      t -= (7 + ((i * 37) % 113)) * 60000; // 每條往回 7~119 分鐘，依序遞減
      const d = new Date(t);
      const sameDay = d.toDateString() === new Date(entry.createdAt).toDateString();
      const label = (sameDay ? '' : `${d.getMonth() + 1}/${d.getDate()} `)
        + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `<div class="pk-search">🔍 ${esc(l)}<span class="pk-search-time">${esc(label)}</span></div>`;
    }).join('');
  }
  return `<div class="peek-card"><div class="pk-head">${PEEK_TYPES[entry.type]?.label || entry.type} · ${esc(when)}</div>${body}</div>`;
}

/** 提案 K:偷看手機 modal——三種快照+歷史。 */
export function openPhonePeekModal(character, freshEntry = null) {
  const history = phonePeeksFor(character.id);
  openModal(`
    <h3>👀 偷看${esc(character.name)}的手機</h3>
    <div class="panel-note">選一種快照。他不會知道。(一次一則生成，走次要模型)</div>
    <div class="pk-type-row">
      ${Object.entries(PEEK_TYPES).map(([k, v]) => `<button class="ghost-btn slim" data-pk-type="${k}">${v.label}</button>`).join('')}
    </div>
    <div id="pkResult">${freshEntry ? peekCardHtml(freshEntry) : ''}</div>
    ${history.length ? `<details class="pk-history"${freshEntry ? '' : ' open'}><summary>歷史快照(${history.length})</summary>${history.map(peekCardHtml).join('')}</details>` : ''}`, {
    onOpen(root) {
      root.querySelectorAll('[data-pk-type]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        const orig = b.textContent;
        b.textContent = '…窺看中';
        const r = await generatePhonePeek(character.id, b.dataset.pkType);
        if (!r.ok) { alert(r.message); b.disabled = false; b.textContent = orig; return; }
        closeModal();
        openPhonePeekModal(character, r.entry);
      }));
    },
  });
}

/** 提案 J:旁白訊息的心聲選擇器——這一幕想窺探誰? */
function openInnerVoicePicker(room, msg) {
  const chars = getRoomCharacters(room);
  openModal(`
    <h3>👁 窺探這一幕的心聲</h3>
    <div class="panel-note">選一位角色，看他此刻沒說出口的部分。已生成的免費展開。</div>
    <div class="check-list">
      ${chars.map((c) => `<button class="ghost-btn slim iv-pick" data-iv-pick="${esc(c.id)}">${esc(c.name)}${msg.innerVoices?.[c.id] ? ' ✓' : ''}</button>`).join('')}
    </div>`, {
    onOpen(root) {
      root.querySelectorAll('[data-iv-pick]').forEach((b) => b.addEventListener('click', async () => {
        const cid = b.dataset.ivPick;
        if (msg.innerVoices?.[cid]) {
          closeModal();
          const card = document.getElementById('messages')?.querySelector(`[data-iv-card="${msg.id}:${cid}"]`);
          if (card) card.hidden = !card.hidden;
          return;
        }
        b.disabled = true; b.textContent = '…';
        const r = await generateInnerVoice(room.id, msg.id, cid);
        if (!r.ok) { alert(r.message); b.disabled = false; return; }
        closeModal();
        renderMessages();
        const card = document.getElementById('messages')?.querySelector(`[data-iv-card="${msg.id}:${cid}"]`);
        if (card) card.hidden = false;
      }));
    },
  });
}

/** 提案 O-1:本房心聲紀錄總覽。 */
export function openInnerVoiceLog(room) {
  const msgs = getRoomMessages(room.id) || [];
  const entries = [];
  for (const m of msgs) {
    if (m.innerVoice) {
      const who = m.senderId ? (getCharacter(m.senderId)?.name || '') : (getRoomCharacters(room)[0]?.name || '');
      entries.push({ mid: m.id, key: m.id, who, at: m.createdAt, text: m.innerVoice });
    }
    for (const [cid, txt] of Object.entries(m.innerVoices || {})) {
      entries.push({ mid: m.id, key: `${m.id}:${cid}`, who: getCharacter(cid)?.name || '?', at: m.createdAt, text: txt });
    }
  }
  openModal(`
    <h3>👁 心聲紀錄</h3>
    ${entries.length ? `<div class="iv-log">${entries.map((e) => `
      <button class="iv-log-item" data-iv-jump="${esc(e.mid)}" data-iv-key="${esc(e.key)}">
        <span class="iv-log-head">${esc(e.who)} · ${fmtTime(e.at)}</span>
        <span class="iv-log-body">${esc(firstLine(e.text, 60))}</span>
      </button>`).join('')}</div>` : '<div class="panel-note">還沒有任何心聲。在訊息上按 👁 窺探第一則吧。</div>'}`, {
    onOpen(root) {
      root.querySelectorAll('[data-iv-jump]').forEach((b) => b.addEventListener('click', () => {
        closeModal();
        const wrap = document.getElementById('messages');
        const card = wrap?.querySelector(`[data-iv-card="${b.dataset.ivKey}"]`);
        if (card) card.hidden = false;
        const row = wrap?.querySelector(`[data-msg-branch="${b.dataset.ivJump}"]`)?.closest('.msg-row, .msg-narrator');
        row?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      }));
    },
  });
}

/** 提案 O-2:版本更新彈窗(每版一次)。 */
export function maybeShowChangelog(changelog = []) {
  const state = getState();
  const ver = String(state.appVersion || '');
  if (!ver || state.settings.lastSeenVersion === ver) return false;
  if (!Array.isArray(changelog) || !changelog.length) {
    state.settings.lastSeenVersion = ver;
    persist();
    return false;
  }
  openModal(`
    <h3>🔔 更新到 ${esc(ver)}</h3>
    <ul class="changelog-list">${changelog.map((c) => `<li>${esc(String(c))}</li>`).join('')}</ul>
    <div class="form-actions"><button class="primary-btn slim" id="clOk">知道了</button></div>`, {
    onOpen(root) {
      root.querySelector('#clOk').addEventListener('click', async () => {
        state.settings.lastSeenVersion = ver;
        await persist();
        closeModal();
      });
    },
  });
  return true;
}

/** 作者備註 modal:綁在單一房間、注入 prompt 尾端的導演指令。 */
function openAuthorNoteModal(room) {
  const showStage = room.type === 'dm' || room.type === 'story';
  openModal(`
    <h3>作者備註</h3>
    <p class="panel-note">只作用於「${esc(room.title)}」這個對話，會以最高優先指令注入 prompt 尾端。適合寫節奏、氛圍、尺度等導演指令，例如「維持慢節奏，不要讓劇情自己推進」。留空即停用。</p>
    <label class="field">備註內容
      <textarea id="authorNoteBox" rows="5" maxlength="2000" data-counter placeholder="例如：子勳現在心情很差，但嘴上不承認">${esc(room.authorNote || '')}</textarea>
      <span class="char-count"></span>
    </label>
    ${showStage ? `
    <label class="field">關係階段(選填；例：曖昧中、交往三個月、冷戰中——給模型一個「我們現在到哪了」的錨點)
      <input id="relStageBox" maxlength="50" value="${esc(room.relationshipStage || '')}" placeholder="留空=不注入">
    </label>` : ''}
    <div class="form-actions">
      <button class="primary-btn slim" id="authorNoteSave">儲存</button>
    </div>`, {
    onOpen(root) {
      bindCharCounters(root);
      root.querySelector('#authorNoteSave').addEventListener('click', async () => {
        room.authorNote = root.querySelector('#authorNoteBox').value.trim();
        const stageBox = root.querySelector('#relStageBox');
        if (stageBox) room.relationshipStage = stageBox.value.trim();
        await persist();
        closeModal();
        renderPhone();
      });
    },
  });
}

/** 編輯訊息 modal。 */
function openEditMessageModal(roomId, msg) {
  const roomType = getRoom(roomId)?.type || 'dm';
  const editCap = roomType === 'story' ? 20000 : 2000;
  openModal(`
    <h3>編輯訊息</h3>
    <label class="field">內容
      <textarea id="msgEditBox" rows="5" maxlength="${editCap}" data-counter>${esc(msg.content)}</textarea>
      <span class="char-count"></span>
    </label>
    <div class="form-actions">
      <button class="primary-btn slim" id="msgEditSave">儲存</button>
    </div>`, {
    onOpen(root) {
      bindCharCounters(root);
      root.querySelector('#msgEditSave').addEventListener('click', async () => {
        await editMessage(roomId, msg.id, root.querySelector('#msgEditBox').value);
        closeModal();
        renderMessages();
      });
    },
  });
}

/** 從社群貼文/留言建立「共享」記憶(社群是公開空間，只能進 shared)。 */
function openSharedMemoryModal(text) {
  const raw = String(text || '').trim().replace(/\s+/g, ' ');
  const content = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;

  openModal(`
    <h3>記住這件事</h3>
    <p class="panel-note">這是社群內容的原文截取。社群屬於公開空間，這條記憶會存成「共享記憶」，所有角色可見。</p>
    <label class="field">記憶內容
      <textarea id="memCandidate" rows="4">${esc(content)}</textarea>
    </label>
    <div class="field-label">可見範圍：共享記憶(所有角色可見)</div>
    <div class="form-actions">
      <button class="primary-btn slim" id="memSave">存入記憶</button>
    </div>`, {
    onOpen(root) {
      root.querySelector('#memSave').addEventListener('click', async () => {
        await addMemory({
          content: root.querySelector('#memCandidate').value,
          visibility: 'shared',
          sourceRoomId: null,
        });
        closeModal();
        if (panelTab === 'memory') renderMemoryPanel();
      });
    },
  });
}
