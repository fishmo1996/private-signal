/**
 * modules/navigation.js
 * 手機的頁面導覽:目前頁面、返回行為與鎖定畫面。
 *
 * 頁面(phoneView)一覽:
 *   home             主畫面(App 圖示網格)
 *   chat-friends     聊天 App:好友分頁(DM 列表)
 *   chat-rooms       聊天 App:聊天室分頁(群聊列表)
 *   chat-room        聊天 App:對話詳情(DM 或群聊,依 currentRoomId)
 *   social-feed      社群 App:貼文列表
 *   social-post      社群 App:貼文詳情(依 currentPostId)
 *   story-list       正文 App:場景列表
 *   story-room       正文 App:敘事頁(依 currentRoomId)
 *   people           角色與玩家 App:列表
 *   people-character 角色詳情/編輯(依 currentCharacterId)
 *   settings         設定 App
 *
 * 鎖定畫面(lock)不寫入 state.phoneView:
 * 它只是每次「啟動」的沉浸感入口,解鎖與否僅存在於本次瀏覽階段。
 */

import { getState, persist, getRoom } from './state.js';

let locked = false; // 本次瀏覽階段是否停在鎖屏

/** 啟動時呼叫:依設定決定是否先顯示鎖屏。 */
export function initNavigation() {
  const state = getState();
  locked = state.settings.showLockScreen !== false;
}

export function isLocked() {
  return locked;
}

/** 解鎖(點擊或向上滑鎖屏)。不需要真的驗證。 */
export function unlock() {
  locked = false;
}

/** 取得目前應顯示的頁面。 */
export function getView() {
  if (locked) return 'lock';
  const state = getState();
  return state.phoneView || 'home';
}

/**
 * 前往某個頁面。
 * @param {string} view
 * @param {{roomId?:string, postId?:string, characterId?:string}} [params]
 */
export async function navigate(view, params = {}) {
  const state = getState();
  state.phoneView = view;
  if ('roomId' in params) state.currentRoomId = params.roomId ?? null;
  if ('postId' in params) state.currentPostId = params.postId ?? null;
  if ('characterId' in params) state.currentCharacterId = params.characterId ?? null;
  if ('worldbookId' in params) state.currentWorldbookId = params.worldbookId ?? null;
  // 離開對話/貼文頁時清掉對應指標,避免殘留
  if (view !== 'chat-room' && view !== 'story-room') state.currentRoomId = null;
  if (view !== 'social-post') state.currentPostId = null;
  await persist();
}

/** 依目前頁面推得「返回」應到哪一頁。 */
export function parentView() {
  const state = getState();
  const view = getView();
  switch (view) {
    case 'chat-room': {
      const room = state.currentRoomId ? getRoom(state.currentRoomId) : null;
      return room && room.type === 'group' ? 'chat-rooms' : 'chat-friends';
    }
    case 'story-room': return 'story-list';
    case 'social-post': return 'social-feed';
    case 'people-character': return 'people';
    case 'worldbook-detail': return 'worldbook';
    case 'character-diary': return 'people-character';
    case 'chat-friends':
    case 'chat-rooms':
    case 'social-feed':
    case 'story-list':
    case 'people':
    case 'player':
    case 'settings':
    case 'worldbook':
      return 'home';
    default:
      return 'home';
  }
}

/** 返回上一層。 */
export async function back() {
  await navigate(parentView());
}
