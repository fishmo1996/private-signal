/**
 * modules/album.js
 * 回憶相簿：照片本體只存在本機、只在你主動分享時才送給模型看;
 * 平常進 prompt 的是每張照片的一行「回憶描述」(超省 token)。
 */

import { getState, genId, persist } from './state.js';

export function getPhotos() {
  const state = getState();
  if (!Array.isArray(state.photos)) state.photos = [];
  return state.photos;
}

/**
 * @param {{image:string, caption:string, dateText?:string, characterIds?:string[]}} data
 */
export async function addPhoto(data) {
  const photo = {
    id: genId('pho'),
    image: data.image,
    caption: String(data.caption || '').trim(),
    dateText: String(data.dateText || '').trim(),   // 自由文字:'2026/8/12' 或 '八月的海邊'
    characterIds: Array.isArray(data.characterIds) ? data.characterIds : [],
    createdAt: Date.now(),
  };
  getPhotos().unshift(photo);
  await persist();
  return photo;
}

export async function updatePhoto(id, patch) {
  const p = getPhotos().find((x) => x.id === id);
  if (!p) return null;
  if (patch.caption !== undefined) p.caption = String(patch.caption).trim();
  if (patch.dateText !== undefined) p.dateText = String(patch.dateText).trim();
  if (patch.characterIds !== undefined) p.characterIds = patch.characterIds;
  await persist();
  return p;
}

export async function deletePhoto(id) {
  const list = getPhotos();
  const idx = list.findIndex((x) => x.id === id);
  if (idx !== -1) list.splice(idx, 1);
  await persist();
}

/**
 * 某角色「共同的回憶」文字(他有被標註在場的照片；最近 6 張)。
 * 沒有任何回憶時回傳 ''。
 */
export function albumTextFor(characterId, limit = 6) {
  const mine = getPhotos().filter((p) => p.characterIds.includes(characterId) && p.caption);
  if (!mine.length) return '';
  return mine.slice(0, limit)
    .map((p) => `- ${p.dateText ? `${p.dateText},` : ''}${p.caption}`)
    .join('\n');
}

/**
 * 紀念日偵測:dateText 含「YYYY/M/D」或「M/D」且月日=今天 → 回傳提示句。
 * 給某角色的 DM prompt 用；沒有就 ''。
 */
export function anniversaryTextFor(characterId) {
  const today = new Date();
  const tm = today.getMonth() + 1;
  const td = today.getDate();
  const hits = [];
  for (const p of getPhotos()) {
    if (!p.characterIds.includes(characterId) || !p.dateText) continue;
    const m = p.dateText.match(/(?:(\d{4})[\/.年-])?(\d{1,2})[\/.月-](\d{1,2})/);
    if (!m) continue;
    const [, y, mo, d] = m;
    if (Number(mo) === tm && Number(d) === td) {
      const years = y ? today.getFullYear() - Number(y) : null;
      hits.push(`今天是「${p.caption}」的日子${years ? `(${years} 週年)` : '(同月同日)'}`);
    }
  }
  return hits.slice(0, 2).join(';');
}
