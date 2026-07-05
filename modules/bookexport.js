/**
 * modules/bookexport.js — 提案 B:正文匯出成書。
 * 把已封存章節+目前章節匯出為單一自包含 HTML(離線可讀、書頁版式、目錄跳章)。
 * 全程零 API 呼叫:純本地複製+轉義+拼裝,不經模型、無任何內容過濾。
 * 內容規則(擁有者拍板):只收 narrator 與 character;user(玩家輸入)與 system 不進書。
 */

import { getState, getCharacter } from './state.js';

/** esc() 等價轉義:書檔同為 innerHTML 語意,XSS 防線不可繞過。 */
function escB(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function paragraphsOf(messages) {
  return messages
    .filter((m) => m.role === 'narrator' || m.role === 'character')
    .map((m) => {
      const body = escB(m.content).replaceAll('\n', '<br>');
      if (m.role === 'character') {
        const who = m.senderId && m.senderId !== 'system' ? (getCharacter(m.senderId)?.name || '') : '';
        return `<p class="line">${who ? `<b>${escB(who)}</b>:` : ''}${body}</p>`;
      }
      return `<p>${body}</p>`;
    })
    .join('\n');
}

/**
 * 產生書檔。回傳 { filename, html };房不存在或非 story 回傳 null。
 */
export function exportStoryBook(roomId) {
  const state = getState();
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room || room.type !== 'story') return null;

  const chapters = [
    ...(room.archivedChapters || []).map((ch) => ({ title: ch.title, messages: ch.messages })),
  ];
  const current = (state.messagesByRoom[roomId] || []);
  if (current.some((m) => m.role === 'narrator' || m.role === 'character')) {
    chapters.push({ title: `第 ${(room.chapterCount || 0) + 1} 章(進行中)`, messages: current });
  }

  const toc = chapters.map((ch, i) => `<li><a href="#ch${i + 1}">${escB(ch.title)}</a></li>`).join('\n');
  const body = chapters.map((ch, i) => `
    <section id="ch${i + 1}">
      <h2>${escB(ch.title)}</h2>
      ${paragraphsOf(ch.messages)}
    </section>`).join('\n');

  const d = new Date();
  const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escB(room.title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #faf6f2; color: #3a3330; font-family: "Noto Serif TC", "PingFang TC", serif; }
  .book { max-width: 640px; margin: 0 auto; padding: 40px 22px 80px; }
  h1 { font-size: 26px; letter-spacing: .06em; margin: 0 0 6px; }
  .meta { font-size: 12px; color: #9a8f88; margin-bottom: 28px; }
  nav { background: #f2eae3; border-radius: 12px; padding: 14px 18px; margin-bottom: 36px; }
  nav h3 { margin: 0 0 8px; font-size: 14px; }
  nav ol { margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.9; }
  nav a { color: #7a5c52; text-decoration: none; }
  section { margin-bottom: 48px; }
  h2 { font-size: 19px; border-bottom: 1px solid #e5dad2; padding-bottom: 8px; letter-spacing: .05em; }
  p { font-size: 15.5px; line-height: 2.05; letter-spacing: .02em; margin: 0 0 1.2em; text-align: justify; }
  p.line b { color: #7a5c52; font-weight: 600; }
</style>
</head>
<body>
<div class="book">
  <h1>${escB(room.title)}</h1>
  <div class="meta">私人訊號 · 匯出於 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} · 共 ${chapters.length} 章</div>
  <nav><h3>目錄</h3><ol>${toc}</ol></nav>
  ${body}
</div>
</body>
</html>`;

  return { filename: `${room.title}-${dateStr}.html`, html };
}
