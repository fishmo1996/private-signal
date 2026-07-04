/**
 * modules/ui.js
 * 所有畫面渲染與互動。
 * 結構:鎖定畫面 → 主畫面(App 網格)→ 各 App 頁面(聊天/社群/正文/角色與玩家/設定)。
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
import { sendUserMessage, isRoomBusy, editMessage, deleteMessage, regenerateLastReply, refreshChats } from './chat.js';
import {
  createMemoryCandidate, addMemory, editMemory, togglePin, deleteMemory,
} from './memory.js';
import {
  getPosts, getPost, getComments, createPost, addComment, toggleLike,
  deletePost, editPost, ensureSeedPosts, generateSocialReplies,
  refreshFeed, refreshCooldownLeft,
} from './social.js';
import {
  initNavigation, isLocked, unlock, getView, navigate, back, parentView,
} from './navigation.js';
import { buildLockScreenHTML, buildHomeHTML, clockString } from './home.js';
import { compressAvatar, compressBackground, compressPhoto } from './image.js';
import { getDiaries, generateDiary, deleteDiary } from './diary.js';
import { exportStateJson, importStateJson } from './state.js';
import {
  getPersonas, getPersona, defaultPersona, personaForRoom,
  createPersona, updatePersona, deletePersona, syncPlayerMirror,
} from './persona.js';
import { buildPrompt } from './prompt.js';
import {
  getWorldbooks, getWorldbook, createWorldbook, updateWorldbook, deleteWorldbook,
  addEntry, updateEntry, deleteEntry, parseKeywords,
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
 * App 頁面共用的標題列:明顯的返回鍵 + 標題 + 右側動作。
 * 返回鍵會標出目的地(例如「← 主畫面」「← 聊天」),不做成看不懂的小圖示。
 */
function appHeader(title, { rightHtml = '', subtitle = '', leadingHtml = '' } = {}) {
  const BACK_LABELS = {
    home: '主畫面',
    'chat-friends': '聊天',
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
}

export function initUI() {
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

  // 鎖屏與主畫面的時鐘,每 20 秒對時一次
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

  switch (view) {
    case 'lock': renderLockScreen(); break;
    case 'home': renderHome(); break;
    case 'chat-friends': renderChatApp('friends'); break;
    case 'chat-rooms': renderChatApp('rooms'); break;
    case 'chat-room': renderRoomView(); break;
    case 'social-feed': renderSocialFeed(); break;
    case 'social-post': renderSocialPost(); break;
    case 'story-list': renderStoryList(); break;
    case 'story-room': renderRoomView(); break;
    case 'people': renderPeople(); break;
    case 'player': renderPlayer(); break;
    case 'people-character': renderCharacterDetail(); break;
    case 'character-diary': renderCharacterDiary(); break;
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

/** 聊天 App:好友(DM)與聊天室(群聊)兩個分頁,底部可切換。 */
function renderChatApp(tab) {
  const state = getState();

  const rightHtml = tab === 'friends'
    ? '<button class="header-action" id="btnChatRefresh">↻</button>'
      + '<button class="header-action" id="btnHeaderAdd">＋ 新增角色</button>'
    : '<button class="header-action" id="btnHeaderAdd">＋ 建立聊天室</button>';

  const listHtml = tab === 'friends' ? friendRowsHtml() : groupRowsHtml();

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
    else openGroupModal();
  });
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

/** 好友分頁:每位角色一列(頭像、名字、最近訊息預覽、時間)。 */
function friendRowsHtml() {
  const state = getState();
  if (!state.characters.length) {
    return `
      <div class="list-empty">
        還沒有好友。<br>新增角色後,每位角色都會有一間專屬私訊。
        <button class="primary-btn slim" id="btnEmptyAdd">＋ 新增角色</button>
      </div>`;
  }
  return state.characters.map((c) => {
    const dm = findDmRoom(c.id);
    if (!dm) return '';
    const msgs = state.messagesByRoom[dm.id] || [];
    const last = msgs[msgs.length - 1];
    const preview = last
      ? firstLine(last.content, 20)
      : (c.firstMessage ? firstLine(c.firstMessage, 20) : '開始聊天吧');
    return `
      <button class="list-row" data-open-room="${esc(dm.id)}">
        ${avatarHtml(c)}
        <span class="list-main">
          <span class="list-title">${esc(c.name)}${dm.unread ? ' <span class="unread-dot" aria-label="未讀"></span>' : ''}</span>
          <span class="list-preview">${esc(preview)}</span>
        </span>
        ${last ? `<span class="list-time">${fmtTime(last.createdAt)}</span>` : ''}
      </button>`;
  }).join('');
}

/** 聊天室分頁:群聊列表。 */
function groupRowsHtml() {
  const state = getState();
  const groups = state.rooms.filter((r) => r.type === 'group');
  if (!groups.length) {
    return `
      <div class="list-empty">
        還沒有聊天室。<br>把兩位以上的角色拉進同一個房間,看他們怎麼接話。
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
    ? (chars[0]?.scenario ? firstLine(chars[0].scenario, 20) : '在線上')
    : room.type === 'group'
      ? `${chars.length} 位角色`
      : `場景 · ${chars.map((c) => c.name).join('、') || '無人在場'}`;

  const deletable = room.type !== 'dm';

  els.phoneScreen.innerHTML = `
    ${appHeader(room.title, {
      subtitle: statusText,
      leadingHtml: isStory ? '<span class="avatar sm neutral" aria-hidden="true">❖</span>' : avatarHtml(chars[0], 'sm'),
      rightHtml: (room.type === 'dm' ? '<button class="header-action" id="btnRoomDiary">日記</button>' : '')
        + `<button class="header-action" id="btnRoomMemory">記憶</button>`
        + `<button class="header-action" id="btnAuthorNote">備註${room.authorNote?.trim() ? '●' : ''}</button>`
        + (deletable ? '<button class="icon-btn" id="btnDeleteRoom" aria-label="刪除">✕</button>' : ''),
    })}
    <div class="messages ${isStory ? 'story-mode' : ''}" id="messages" aria-live="polite"></div>
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
    </div>`;

  bindBack();
  els.phoneScreen.querySelector('#btnAuthorNote').addEventListener('click', () => openAuthorNoteModal(room));
  els.phoneScreen.querySelector('#btnRoomMemory').addEventListener('click', () => openRoomMemoryModal(room));
  const diaryBtn = els.phoneScreen.querySelector('#btnRoomDiary');
  if (diaryBtn) {
    diaryBtn.addEventListener('click', async () => {
      const dmChar = getRoomCharacters(room)[0];
      if (!dmChar) return;
      await navigate('character-diary', { characterId: dmChar.id });
      renderAll();
    });
  }

  if (deletable) {
    els.phoneScreen.querySelector('#btnDeleteRoom').addEventListener('click', () => {
      openConfirmModal({
        title: room.type === 'group' ? '刪除這個聊天室?' : '刪除這個場景?',
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

  els.phoneScreen.querySelector('#btnRoomPersona').addEventListener('click', () => {
    openPersonaSelectModal({
      title: `這個對話中,你是誰?`,
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
  els.phoneScreen.querySelector('#btnAttach').addEventListener('click', () => attachFile.click());
  attachFile.addEventListener('change', async () => {
    const file = attachFile.files[0];
    if (!file) return;
    try {
      pendingImage = await compressPhoto(file);
      attachPreview.hidden = false;
      els.phoneScreen.querySelector('#attachImg').src = pendingImage;
    } catch (err) { alert(err.message); }
    attachFile.value = '';
  });
  els.phoneScreen.querySelector('#btnAttachClear').addEventListener('click', () => {
    pendingImage = null;
    attachPreview.hidden = true;
  });

  const doSend = async () => {
    const text = input.value;
    if ((!text.trim() && !pendingImage) || isRoomBusy(room.id)) return;
    const image = pendingImage;
    pendingImage = null;
    attachPreview.hidden = true;
    input.value = '';
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

  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });
  input.focus();

  renderMessages();
}

function renderMessages() {
  const state = getState();
  const wrap = document.getElementById('messages');
  if (!wrap || !state.currentRoomId) return;
  const room = getRoom(state.currentRoomId);
  if (!room) return;
  const msgs = getRoomMessages(room.id);
  const showTime = state.settings.showTimestamps !== false;

  const html = msgs.map((m) => {
    const time = showTime ? `<span class="msg-time">${fmtTime(m.createdAt)}</span>` : '';
    const rememberBtn = `<button class="remember-btn" data-remember="${esc(m.id)}" aria-label="記住這件事">記住</button>`
      + `<button class="remember-btn" data-msg-edit="${esc(m.id)}" aria-label="編輯訊息">編輯</button>`
      + `<button class="remember-btn danger" data-msg-del="${esc(m.id)}" aria-label="刪除訊息">刪除</button>`;

    if (m.role === 'system') {
      return `<div class="msg-system">${esc(m.content)}
        <button class="remember-btn danger" data-msg-del="${esc(m.id)}" aria-label="刪除訊息">刪除</button></div>`;
    }
    if (m.role === 'narrator') {
      return `
        <div class="msg-narrator">
          <div class="narrator-body">${esc(m.content).replaceAll('\n', '<br>')}</div>
          <div class="msg-meta">${time}${rememberBtn}</div>
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
          <div class="msg-meta">${time}${rememberBtn}</div>
        </div>`;
    }
    const c = getCharacter(m.senderId);
    const nameLine = room.type === 'dm' ? '' : `<div class="msg-sender">${esc(c ? c.name : '角色')}</div>`;
    return `
      <div class="msg-row character">
        ${avatarHtml(c, 'sm')}
        <div class="msg-col">
          ${nameLine}
          <div class="bubble char-bubble" style="--c:${esc(c ? c.themeColor : '#6b7280')}">${imgHtml}${esc(m.content).replaceAll('\n', '<br>')}</div>
          <div class="msg-meta">${time}${rememberBtn}</div>
        </div>
      </div>`;
  }).join('');

  const typing = typingBy
    ? `<div class="msg-typing">${esc(typingBy)} 正在輸入<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`
    : '';

  const canRegen = !typingBy
    && msgs.some((m) => m.role === 'user')
    && msgs.length && msgs[msgs.length - 1].role !== 'user'
    && !isRoomBusy(room.id);
  const regenBtn = canRegen
    ? '<div class="regen-wrap"><button class="regen-btn" id="btnRegen">↻ 重新生成</button></div>'
    : '';

  wrap.innerHTML = html + typing + regenBtn;
  wrap.scrollTop = wrap.scrollHeight;

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

  wrap.querySelectorAll('[data-remember]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const msg = msgs.find((m) => m.id === btn.dataset.remember);
      if (msg) openMemoryCandidateModal(msg, room.id);
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
        title: '刪除這則訊息?',
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
      leadingHtml: `<button class="persona-chip" id="btnFeedPersona" title="目前身分,點擊切換">${personaAvatarHtml(getPersona(getState().activePersonaId) || defaultPersona(), 'sm')}</button>`,
      rightHtml: '<button class="header-action" id="btnRefreshFeed">↻ 動態</button>'
        + '<button class="header-action" id="btnNewPost">＋ 發貼文</button>',
    })}
    <div class="api-status" id="feedStatus" role="status" style="padding:0 16px"></div>
    <div class="phone-list feed">
      ${cards || `
        <div class="list-empty">
          這裡還沒有任何動態。<br>發第一篇貼文,或先去新增角色——他們也會發文。
        </div>`}
    </div>`;

  bindBack();
  els.phoneScreen.querySelector('#btnNewPost').addEventListener('click', openNewPostModal);
  els.phoneScreen.querySelector('#btnFeedPersona').addEventListener('click', () => {
    openPersonaSelectModal({
      title: '在社群裡,你現在是誰?',
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

  // FB 式巢狀:依 replyTo.commentId 找出每則留言所屬的討論串根
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
      <div class="comment-heading">留言 ${comments.length ? `(${comments.length})` : ''}</div>
      ${commentHtml || '<div class="list-empty small">還沒有留言。</div>'}
      ${typing}
      ${errorBanner}
    </div>
    <div class="composer">
      <textarea id="commentInput" rows="1" placeholder="留個言…(公開,所有角色都看得到)" aria-label="留言輸入框"></textarea>
      <button class="send-btn" id="btnComment" aria-label="送出留言">送出</button>
    </div>`;

  bindBack();
  bindFeedEvents(els.phoneScreen);

  els.phoneScreen.querySelector('#btnDeletePost').addEventListener('click', () => {
    openConfirmModal({
      title: '刪除這篇貼文?',
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doComment();
    }
  });
  input.focus();

  const detail = els.phoneScreen.querySelector('#postDetail');
  detail.scrollTop = detail.scrollHeight;
}

/**
 * 玩家發文/留言後,依 mock 機制產生角色留言(1 位主回覆 + 0~2 位補充)。
 * 僅使用公開資訊(角色公開設定、貼文內容、共享記憶)。
 */
async function runMockSocialReplies(post, triggerText, triggerPersonaId = null, replyToName = null, threadReplyTo = null) {
  const result = await generateSocialReplies({ post, triggerText, triggerPersonaId, replyToName });
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

/** 玩家 App:人設管理(多個「你」)。 */
function renderPlayer() {
  const state = getState();
  els.phoneScreen.innerHTML = `
    ${appHeader('玩家', { rightHtml: '<button class="header-action" id="btnNewPersona">＋ 新增人設</button>' })}
    <div class="phone-list">
      <div class="panel-note" style="margin:0 2px 10px">你可以有多個「你」:每個角色認識其中一個,對話與發文都能切換身分。</div>
      ${getPersonas().map((ps) => `
        <button class="profile-card" data-edit-persona="${esc(ps.id)}" aria-label="編輯人設 ${esc(ps.name)}">
          ${personaAvatarHtml(ps)}
          <span class="list-main">
            <span class="list-title">${esc(ps.name)}${ps.id === state.defaultPersonaId ? '(預設)' : ''}</span>
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
        <span class="list-title">${esc(c.name)}</span>
        <span class="list-preview">${esc(firstLine(c.description || c.personality, 22) || '尚未填寫描述')}</span>
      </span>
      <span class="list-chevron" aria-hidden="true">›</span>
    </button>`).join('');

  els.phoneScreen.innerHTML = `
    ${appHeader('聯絡人')}
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
}

function renderCharacterDetail() {
  const state = getState();
  const c = state.currentCharacterId ? getCharacter(state.currentCharacterId) : null;
  if (!c) { navigate('people').then(renderAll); return; }

  els.phoneScreen.innerHTML = `
    ${appHeader(c.name, {
      subtitle: '角色資料',
      leadingHtml: avatarHtml(c, 'sm'),
      rightHtml: '<button class="header-action" id="btnCharDiary">日記</button>',
    })}
    <div class="phone-list profile-detail">
      <form id="charEditForm">
        ${characterFormFields(c)}
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
  els.phoneScreen.querySelector('#btnCharDiary').addEventListener('click', async () => {
    await navigate('character-diary', { characterId: c.id });
    renderAll();
  });
  els.phoneScreen.querySelector('#charEditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = readForm(e.target);
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
      title: `讓「${c.name}」離開這支手機?`,
      body: '這個角色、他的私訊、私密記憶、社群貼文,以及只剩他撐著的聊天室都會被移除。這個動作無法復原。',
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
      <label class="check-field api-toggle">
        <input type="checkbox" id="chkUseRealApi" ${cfg.useRealApi ? 'checked' : ''}>
        使用真實 AI 回覆(私訊/群聊/正文全模式;群聊為單次呼叫產多角色訊息)
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
      <div class="panel-note">溫度:創作建議 0.9~1.2。思考預算(Gemini 2.5+):0=關閉思考最省額度;留空用模型預設;數字越大推理越深但更貴更慢。</div>
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

  // 下拉選單選了什麼,就同步進手動輸入欄(儲存以輸入欄為準)
  els.phoneScreen.querySelector('#apiModelSelect').addEventListener('change', (e) => {
    if (e.target.value) els.phoneScreen.querySelector('#apiModel').value = e.target.value;
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
    ${appHeader('世界書', { rightHtml: '<button class="header-action" id="btnNewBook">＋ 新增世界書</button>' })}
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
        <span class="wb-entry-keys">${e.alwaysOn ? '常駐' : esc((e.keywords || []).join('、') || '(無關鍵字)')}</span>
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
      rightHtml: '<button class="header-action" id="btnNewEntry">＋ 新增條目</button>',
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
        <div class="form-actions">
          <button type="submit" class="primary-btn slim">儲存設定</button>
          <button type="button" class="danger-btn slim" id="btnDelBook">刪除世界書</button>
        </div>
      </form>
      <div class="people-heading">條目(${book.entries.length})</div>
      ${entries || '<div class="list-empty small">還沒有條目。條目=一段設定+它的觸發關鍵字。</div>'}
    </div>`;

  bindBack();

  // 全域勾選時,即時停用角色勾選框
  const metaForm = els.phoneScreen.querySelector('#wbMetaForm');
  metaForm.querySelector('input[name="global"]').addEventListener('change', (e) => {
    metaForm.querySelectorAll('input[name="bindChar"]').forEach((cb) => { cb.disabled = e.target.checked; });
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
      },
    });
    renderAll();
  });

  els.phoneScreen.querySelector('#btnDelBook').addEventListener('click', () => {
    openConfirmModal({
      title: `刪除「${book.name}」?`,
      body: '這本世界書與其中所有條目都會被移除。角色與聊天資料不受影響。',
      confirmLabel: '刪除',
      onConfirm: async () => {
        await deleteWorldbook(book.id);
        await navigate('worldbook');
        renderAll();
      },
    });
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
      <label class="field">內容(被觸發時進入 prompt)
        <textarea name="content" rows="5" maxlength="4000" data-counter>${esc(entry?.content || '')}</textarea>
        <span class="char-count"></span>
      </label>
      <label class="check-field">
        <input type="checkbox" name="alwaysOn" ${entry?.alwaysOn ? 'checked' : ''}> 常駐(不需關鍵字,永遠進入 prompt,較耗 token)
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
          content: fd.get('content'),
          alwaysOn: !!fd.get('alwaysOn'),
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

      <div class="people-heading">正文</div>
      <label class="field" style="padding:0 2px">格式指令(套用於所有正文場景;單一場景可用「備註」覆寫)
        <textarea id="storyFormatBox" rows="3" maxlength="1000" data-counter>${esc(state.settings.storyFormat || '')}</textarea>
        <span class="char-count"></span>
      </label>
      <div class="form-actions"><button class="ghost-btn slim" id="btnSaveStoryFormat">儲存格式指令</button></div>

      <div class="people-heading">AI 連線(API / LLM)</div>
      <div class="panel-note">金鑰只存在這台電腦的瀏覽器裡。目前對話仍使用本機假回覆;這裡先把連線設定準備好,串接時即可直接使用。</div>
      ${apiSectionHtml()}

      <div class="people-heading">資料</div>
      <div class="panel-note">所有資料只存在這台電腦的瀏覽器(IndexedDB)裡,不會傳到任何地方。建議定期匯出備份,避免清瀏覽器快取時遺失。<br><strong>備份不包含 API 金鑰;匯入到新裝置後請自行重新輸入。</strong></div>
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
  els.phoneScreen.querySelector('#btnSaveStoryFormat').addEventListener('click', async () => {
    state.settings.storyFormat = els.phoneScreen.querySelector('#storyFormatBox').value.trim();
    await persist();
    renderPhone();
  });

  // 外觀:主題與背景圖
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

  // 資料:全域備份匯出/匯入
  els.phoneScreen.querySelector('#btnExport').addEventListener('click', () => {
    const blob = new Blob([exportStateJson()], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `private-signal-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  const importFile = els.phoneScreen.querySelector('#importFile');
  els.phoneScreen.querySelector('#btnImport').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    const file = importFile.files[0];
    if (!file) return;
    openConfirmModal({
      title: '匯入這份備份?',
      body: '匯入會「完全覆蓋」目前裝置上的所有資料(角色、對話、社群、記憶、設定)。建議先匯出一份目前的備份再進行。',
      confirmLabel: '覆蓋匯入',
      onConfirm: async () => {
        try {
          const text = await file.text();
          await importStateJson(text);
          location.reload(); // 重新啟動,乾淨載入匯入後的資料
        } catch (err) {
          alert(`匯入失敗:${err.message}(目前資料未被更動)`);
        }
      },
    });
  });
  els.phoneScreen.querySelector('#btnClearAll').addEventListener('click', () => {
    openConfirmModal({
      title: '清空這支手機?',
      body: '所有角色、聊天紀錄、社群貼文、記憶與設定都會被刪除,畫面會回到最初的樣子。這個動作無法復原。',
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

/* ---------------- 右側:管理輔助面板(預設收合) ---------------- */

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
        <div class="mem-subheading">${esc(c ? c.name : '(已離開的角色)')} 的私密記憶</div>
        ${list.map(memoryItemHtml).join('')}`;
    }).join('');

  const roomSections = Object.entries(mem.byRoomId)
    .filter(([, list]) => list.length)
    .map(([rid, list]) => {
      const r = getRoom(rid);
      return `
        <div class="mem-subheading">場景「${esc(r ? r.title : '(已刪除)')}」的記憶</div>
        ${list.map(memoryItemHtml).join('')}`;
    }).join('');

  els.panelBody.innerHTML = `
    <div class="panel-note">在聊天訊息或社群貼文上按「記住」,就能把它變成一條可編輯的記憶。DM 的記憶只有該角色本人看得到。</div>
    <div class="mem-heading">共享記憶(所有角色可見,含社群)</div>
    ${mem.shared.length ? mem.shared.map(memoryItemHtml).join('') : '<div class="panel-empty small">尚無共享記憶</div>'}
    <div class="mem-heading">角色私密記憶(僅本人可見)</div>
    ${privateSections || '<div class="panel-empty small">尚無私密記憶</div>'}
    <div class="mem-heading">場景記憶(僅在場角色可見)</div>
    ${roomSections || '<div class="panel-empty small">尚無場景記憶</div>'}`;

  els.panelBody.querySelectorAll('[data-mem-edit]').forEach((b) => b.addEventListener('click', () => {
    editingMemoryId = b.dataset.memEdit;
    renderMemoryPanel();
  }));
  els.panelBody.querySelectorAll('[data-mem-cancel]').forEach((b) => b.addEventListener('click', () => {
    editingMemoryId = null;
    renderMemoryPanel();
  }));
  els.panelBody.querySelectorAll('[data-mem-save]').forEach((b) => b.addEventListener('click', async () => {
    const box = els.panelBody.querySelector(`.memory-item[data-mem="${b.dataset.memSave}"] .mem-edit`);
    await editMemory(b.dataset.memSave, box.value);
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

/** 開發資訊:資料概況與目前對話的 buildPrompt 預覽(未來 API 會收到什麼)。 */
function renderDevPanel() {
  const state = getState();
  const room = state.currentRoomId ? getRoom(state.currentRoomId) : null;
  const chars = room ? getRoomCharacters(room) : [];

  let promptPreview = '<div class="panel-empty small">開啟任一對話後,這裡會顯示該角色的 buildPrompt 結果預覽。</div>';
  if (room && chars[0]) {
    const p = buildPrompt({ character: chars[0], roomId: room.id });
    promptPreview = `<pre class="prompt-preview">${esc(p.system)}</pre>`;
  }

  els.panelBody.innerHTML = `
    <div class="panel-note">這一欄是開發/管理輔助區,不屬於手機本體。</div>
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
      <textarea name="systemPrompt" rows="3" maxlength="8000" data-counter placeholder="給真實 AI 的角色指令:語氣、個性、回覆風格">${esc(c.systemPrompt || '')}</textarea>
      <span class="char-count"></span>
    </label>
    <label class="field">第一則訊息
      <textarea name="firstMessage" rows="2" maxlength="2000" data-counter placeholder="第一次打開私訊時,角色說的話">${esc(c.firstMessage || '')}</textarea>
      <span class="char-count"></span>
    </label>
    <label class="field">主動程度(他多常主動傳訊給你)
      <select name="proactivity" class="theme-select" style="width:100%; margin-top:5px">
        ${[['off', '不主動(絕不主動傳訊)'], ['low', '低(高冷,偶爾才想到你)'], ['mid', '中(普通朋友的頻率)'], ['high', '高(黏人,常常想找你)']]
          .map(([v, l]) => `<option value="${v}" ${(c.proactivity || 'mid') === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </label>
    <label class="field">這個角色認識的人設(他眼中的「你」)
      <select name="knownPersonaId" class="theme-select" style="width:100%; margin-top:5px">
        ${getPersonas().map((ps) => `<option value="${esc(ps.id)}" ${(c.knownPersonaId || getState().defaultPersonaId) === ps.id ? 'selected' : ''}>${esc(ps.name)}</option>`).join('')}
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
        const av = getAvatar();
        if (av !== undefined) data.avatarImage = av;
        const { character, dmRoom } = await createCharacter(data);
        getState().currentCharacterId = character.id;
        closeModal();
        if (openDmAfter) {
          await openRoom(dmRoom.id);   // 從聊天 App 進來:直接開私訊
        } else if (stayInPeople) {
          await navigate('people');    // 從角色 App 進來:留在列表看到新角色
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
        <input name="title" required placeholder="例如:深夜留言板">
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
        <input name="title" required placeholder="例如:末班車之後">
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
        <input name="name" required maxlength="40" value="${esc(persona?.name || '')}" placeholder="這個「你」叫什麼?">
      </label>
      <label class="field">描述(角色眼中的你)
        <textarea name="description" rows="4" maxlength="4000" data-counter placeholder="例如:19 歲大學生,短髮,講話直接">${esc(persona?.description || '')}</textarea>
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
            name: data.name, description: data.description,
            ...(av !== undefined ? { avatarImage: av } : {}),
          });
        } else {
          await createPersona({
            name: data.name, description: data.description,
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
            title: `刪除人設「${persona.name}」?`,
            body: '綁定這個人設的角色、對話與貼文會全部改指向預設人設,內容不會被刪除。這個動作無法復原。',
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
            <span class="list-title">${esc(ps.name)}</span>
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
    <p class="panel-note">貼文是公開的:所有角色都看得到,也可能來留言(附圖時角色也看得到圖)。</p>
    <form id="postForm">
      <label class="field">用哪個身分發?
        <select name="personaId" class="theme-select" style="width:100%; margin-top:5px">
          ${getPersonas().map((ps) => `<option value="${esc(ps.id)}" ${(getState().activePersonaId || getState().defaultPersonaId) === ps.id ? 'selected' : ''}>${esc(ps.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field">內容
        <textarea name="content" rows="4" placeholder="想說點什麼?"></textarea>
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
    <p class="panel-note">這是訊息原文的截取,不是自動摘要——儲存前可以改寫成你想讓角色記得的樣子。</p>
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

/** 房間記憶抽屜:這個對話「看得到」的記憶,可直接編輯/釘選/刪除/手動新增。 */
function openRoomMemoryModal(room) {
  const state = getState();
  const chars = getRoomCharacters(room);
  const dmChar = room.type === 'dm' ? chars[0] : null;

  // 這個對話可見的記憶分組
  const groups = [];
  if (dmChar) {
    groups.push({
      key: 'private', label: `${dmChar.name} 的私密記憶(僅本人可見)`,
      list: state.memories.byCharacterId[dmChar.id] || [],
    });
  }
  if (room.type === 'story') {
    groups.push({
      key: 'room', label: '本場景記憶(僅在場角色可見)',
      list: state.memories.byRoomId[room.id] || [],
    });
  }
  groups.push({ key: 'shared', label: '共享記憶(所有角色可見)', list: state.memories.shared });

  // 手動新增的可選範圍
  const scopeOptions = [
    ...(dmChar ? [['private', `${dmChar.name} 的私密記憶`]] : []),
    ...(room.type === 'story' ? [['room', '本場景記憶']] : []),
    ['shared', '共享記憶'],
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
    <p class="panel-note">只列出「${esc(room.title)}」看得到的記憶,改完直接生效,下一次回覆就會用到。</p>
    <div id="rmBody">${bodyHtml()}</div>`, {
    onOpen(root) {
      const body = root.querySelector('#rmBody');
      const rerender = () => { body.innerHTML = bodyHtml(); bind(); };
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
        body.querySelector('#rmNewAdd').addEventListener('click', async () => {
          const content = body.querySelector('#rmNewContent').value.trim();
          if (!content) return;
          const scope = body.querySelector('#rmNewScope').value;
          await addMemory({
            content,
            visibility: scope,
            characterId: scope === 'private' ? dmChar.id : undefined,
            sourceRoomId: scope === 'room' ? room.id : null,
          });
          rerender();
        });
      };
      bind();
    },
  });
}

/** 分享貼文到聊天室:選一個 DM/群聊,附一句話送出。 */
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
      <input id="shareMsg" maxlength="500" placeholder="例如:哥你這什麼意思啊">
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

/** 作者備註 modal:綁在單一房間、注入 prompt 尾端的導演指令。 */
function openAuthorNoteModal(room) {
  openModal(`
    <h3>作者備註</h3>
    <p class="panel-note">只作用於「${esc(room.title)}」這個對話,會以最高優先指令注入 prompt 尾端。適合寫節奏、氛圍、尺度等導演指令,例如「維持慢節奏,不要讓劇情自己推進」。留空即停用。</p>
    <label class="field">備註內容
      <textarea id="authorNoteBox" rows="5" maxlength="2000" data-counter placeholder="例如:子勳現在心情很差,但嘴上不承認">${esc(room.authorNote || '')}</textarea>
      <span class="char-count"></span>
    </label>
    <div class="form-actions">
      <button class="primary-btn slim" id="authorNoteSave">儲存</button>
    </div>`, {
    onOpen(root) {
      bindCharCounters(root);
      root.querySelector('#authorNoteSave').addEventListener('click', async () => {
        room.authorNote = root.querySelector('#authorNoteBox').value.trim();
        await persist();
        closeModal();
        renderPhone();
      });
    },
  });
}

/** 編輯訊息 modal。 */
function openEditMessageModal(roomId, msg) {
  openModal(`
    <h3>編輯訊息</h3>
    <label class="field">內容
      <textarea id="msgEditBox" rows="5" maxlength="20000" data-counter>${esc(msg.content)}</textarea>
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

/** 從社群貼文/留言建立「共享」記憶(社群是公開空間,只能進 shared)。 */
function openSharedMemoryModal(text) {
  const raw = String(text || '').trim().replace(/\s+/g, ' ');
  const content = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;

  openModal(`
    <h3>記住這件事</h3>
    <p class="panel-note">這是社群內容的原文截取。社群屬於公開空間,這條記憶會存成「共享記憶」,所有角色可見。</p>
    <label class="field">記憶內容
      <textarea id="memCandidate" rows="4">${esc(content)}</textarea>
    </label>
    <div class="field-label">可見範圍:共享記憶(所有角色可見)</div>
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
