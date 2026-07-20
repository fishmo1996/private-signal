// guard.js — 載入守門員(v91 自 index.html 外移,內容不變)。
// 非 module、一定會執行:ES Modules 只要一檔載入失敗(如快取新舊混雜),
// 整個程式會靜默失敗、畫面全黑。此檔攔截錯誤並顯示指引,不動任何 IndexedDB 資料。
// 外移原因:讓 CSP 的 script-src 'self' 可以上路(行內 script 會被擋)。
    (function () {
      var bootErrors = [];
      window.addEventListener('error', function (e) {
        var msg = e && (e.message || (e.error && e.error.message));
        if (!msg && e && e.target && e.target.src) msg = '資源載入失敗:' + e.target.src;
        if (msg) bootErrors.push(String(msg));
      }, true);
      window.addEventListener('unhandledrejection', function (e) {
        if (e && e.reason) bootErrors.push(String(e.reason.message || e.reason));
      });
      setTimeout(function () {
        var screen = document.getElementById('phoneScreen');
        if (!screen || screen.childElementCount > 0) return; // 已正常渲染
        var detail = bootErrors.length
          ? '<p style="font-size:12px;word-break:break-all">' + bootErrors.slice(0, 3).join('<br>')
              .replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>'
          : '';
        screen.innerHTML =
          '<div class="phone-empty"><h2>畫面沒有啟動</h2>' + detail +
          '<p>最常見原因是瀏覽器快取了新舊混雜的程式檔。' +
          '請按 <strong>Ctrl+F5</strong>(Mac:Cmd+Shift+R)強制重新整理。</p>' +
          '<p>你的本機資料存在 IndexedDB(private-signal-db),' +
          '<strong>沒有被刪除或覆蓋</strong>。</p></div>';
      }, 2500);
    })();
