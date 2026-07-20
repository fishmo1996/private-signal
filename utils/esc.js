/**
 * utils/esc.js — 輸出/輸入淨化共用工具(v91)。
 * esc():HTML 五字元轉義。全站唯一實作——ui.js/home.js/bookexport.js 一律 import,
 *   絕不各自複製(三胞胎漂移=不對稱防線)。
 * safeImage():圖片欄位守門。只放行 data:image dataURL 與乾淨 http(s) URL,
 *   擋下含引號/角括號/空白的字串(屬性逃逸原料)。外部匯入(角色卡/單房備份)必過。
 */

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const DATA_IMG = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i;
const HTTP_IMG = /^https?:\/\/[^\s"'<>\\`]+$/i;

/** 合法圖片來源回傳原字串,否則回 null(呼叫端自行退回無圖)。 */
export function safeImage(src) {
  const s = typeof src === 'string' ? src.trim() : '';
  if (!s) return null;
  if (DATA_IMG.test(s) || HTTP_IMG.test(s)) return s;
  return null;
}
