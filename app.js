/**
 * app.js
 * 進入點：載入 config.json → 初始化 IndexedDB 與 state → 還原上次所在位置
 *        → 決定是否顯示鎖定畫面 → 渲染 UI。
 */

import { initDB, diagnostics } from './utils/indexeddb.js';
import { initState, getState, persist } from './modules/state.js';
import { ensureRoomInitialized } from './modules/rooms.js';
import { initNavigation } from './modules/navigation.js';
import { initUI, maybeShowChangelog } from './modules/ui.js';

async function boot() {
  try {
    // 1. 載入預設設定(相對路徑,GitHub Pages 子路徑下也可正常運作)
    const res = await fetch('./data/config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`無法載入 data/config.json(HTTP ${res.status})`);
    const config = await res.json();
  console.log(`[私人訊號] 版本:${config.version || '(未知)'}`);

    document.title = config.appName || '私人訊號';

    // 2. 初始化資料庫與 state(IndexedDB 沒資料時依 config 建立初始 state)
    await initDB();
    await initState(config);

    // v86(n1):向瀏覽器請求「持久儲存」——未允諾時 iOS/桌面瀏覽器有權在空間吃緊時
    // 清掉整個 IndexedDB(全部心血)。允諾後被清的機率大幅下降;結果印在 console,
    // 設定頁的備份區也會顯示。失敗靜默,不影響開機。
    try {
      if (navigator.storage?.persist) {
        navigator.storage.persist().then((granted) => {
          console.log(`[私人訊號] 持久儲存:${granted ? '已允諾 ✓' : '未允諾(定期備份更重要了)'}`);
        });
      }
    } catch { /* 舊瀏覽器沒這 API,略過 */ }

    // 3. 決定啟動頁面:
    //    預設一律先進主畫面(home),避免被困在上次的聊天頁;
    //    只有在設定開啟「重新開啟時回到上次聊天室」且該 room 仍存在時才還原。
    //    這裡只調整頁面指標，絕不動任何角色/訊息資料。
    const state = getState();
    const roomExists = state.currentRoomId
      && state.rooms.some((r) => r.id === state.currentRoomId);

    if (state.settings.resumeLastRoom === true && roomExists) {
      await ensureRoomInitialized(state.currentRoomId);
      // phoneView 已由 migrate/上次狀態指向 chat-room / story-room
    } else {
      state.currentRoomId = null;
      state.currentPostId = null;
      state.phoneView = 'home';
      await persist();
    }

    // 4. 依設定決定是否先停在鎖定畫面(只是沉浸感入口，不做真實驗證)
    initNavigation();

    // 5. 渲染
    initUI();
    maybeShowChangelog(config.changelog || []); // O-2:每版一次的更新摘要
  } catch (err) {
    console.error(err);
    const stage = document.getElementById('phoneScreen');
    if (stage) {
      const esc = (t) => String(t ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      stage.innerHTML = `
        <div class="phone-empty">
          <h2>載入失敗</h2>
          <p>錯誤:${esc(err && err.message ? err.message : err)}</p>
          <p style="font-size:12px">
            資料庫:${esc(diagnostics.dbName)} / ${esc(diagnostics.storeName)}<br>
            讀到既有資料:${diagnostics.loaded === null ? '尚未嘗試' : (diagnostics.loaded ? '是' : '否')}
            ${diagnostics.loadError ? `<br>讀取錯誤:${esc(diagnostics.loadError)}` : ''}
          </p>
          <p>你的本機資料<strong>沒有被刪除或覆蓋</strong>。請先按 <strong>Ctrl+F5</strong>(Mac:Cmd+Shift+R)強制重新整理;
          若仍失敗，請確認是以本機伺服器開啟(例如 python -m http.server 8000),而不是直接雙擊 index.html。</p>
        </div>`;
    }
  }
}

boot();
