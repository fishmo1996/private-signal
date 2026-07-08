/**
 * utils/indexeddb.js
 * IndexedDB 存取層。
 * 整個 app 的狀態以單一 record 存放於 object store "appState" 的 key "state"。
 * localStorage 不作為主要資料庫使用。
 */

export const DB_NAME = 'private-signal-db';
const DB_VERSION = 1;
export const STORE_NAME = 'appState';
export const STATE_KEY = 'state';

let dbPromise = null;

/**
 * 資料診斷(暫時性):只記錄「有沒有讀到、數量多少」,絕不記錄訊息內容。
 * 由 UI 的「開發資訊」面板顯示。
 */
export const diagnostics = {
  dbName: DB_NAME,
  storeName: STORE_NAME,
  stateKey: STATE_KEY,
  loaded: null,        // true=讀到既有 state / false=沒有資料 / null=尚未嘗試
  loadError: null,     // 讀取失敗時的錯誤訊息(讀取失敗絕不會建立空 state 覆蓋)
  adoptedFrom: null,   // 若是從其他舊資料庫名稱找回資料,記錄來源 db 名稱
};

/**
 * 開啟(或建立)資料庫。重複呼叫會回傳同一個 Promise。
 * @returns {Promise<IDBDatabase>}
 */
export function initDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // 若其他分頁觸發版本升級,主動關閉避免卡死。
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('IndexedDB 開啟失敗'));
    };

    request.onblocked = () => {
      // 有其他分頁佔住舊版本連線;不 reject,等待其釋放。
      console.warn('[indexeddb] 資料庫開啟被其他分頁阻擋中…');
    };
  });

  return dbPromise;
}

/**
 * 讀取整份 app state。
 * @returns {Promise<object|null>} 無資料時回傳 null。
 */
export async function loadState() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(STATE_KEY);
    req.onsuccess = () => {
      const result = req.result ?? null;
      diagnostics.loaded = result !== null;
      resolve(result);
    };
    req.onerror = () => {
      diagnostics.loadError = String(req.error || '讀取 state 失敗');
      reject(req.error || new Error('讀取 state 失敗'));
    };
  });
}

/**
 * 保存整份 app state(整份覆寫)。
 * @param {object} state 可被 structured clone 的純資料物件。
 * @returns {Promise<void>}
 */
export async function saveState(state) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(state, STATE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存 state 失敗'));
    tx.onabort = () => reject(tx.error || new Error('保存 state 交易被中止'));
  });
}

/**
 * 清除本網站的所有本機資料(供「清除本機資料」按鈕使用)。
 * @returns {Promise<void>}
 */
export async function clearState() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('清除 state 失敗'));
  });
}


/* ------------------------------------------------------------
 * 自動快照(v75):同一 object store 內的獨立 key,與主 state 互不覆蓋。
 * 輪替 2 份,由 state.js 的開機流程負責寫入與輪替;這裡只做最小存取。
 * 注意:clearState() 是 store.clear(),「清除本機資料」會連快照一併清掉
 * ——這是刻意的:使用者按下全清就是要全清,快照不可變成殘留。
 * 但「匯入備份」只覆蓋主 state key,快照存活——匯錯檔可用快照退回。
 * ------------------------------------------------------------ */

export const SNAPSHOT_KEYS = ['snapshot-a', 'snapshot-b'];

/** 讀取一份快照 record({takenAt, state});不存在回傳 null。 */
export async function readSnapshotRecord(key) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error || new Error('讀取快照失敗'));
  });
}

/** 寫入一份快照 record(整格覆寫)。 */
export async function writeSnapshotRecord(key, record) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存快照失敗'));
    tx.onabort = () => reject(tx.error || new Error('保存快照交易被中止'));
  });
}

/* ------------------------------------------------------------
 * 舊資料救援:安全搜尋其他可能的資料庫名稱。
 * 只「讀取」,絕不刪除或修改來源資料庫。
 * ------------------------------------------------------------ */

/** 歷史上可能用過的資料庫名稱(目前所有版本皆為 private-signal-db)。 */
const LEGACY_DB_CANDIDATES = ['private-signal', 'privateSignal', 'private_signal_db'];

/** 以唯讀方式嘗試從某個 db 名稱讀出 appState/state;失敗回傳 null,絕不寫入。 */
function tryReadStateFrom(dbName) {
  return new Promise((resolve) => {
    let req;
    try {
      // 不帶版本號開啟:沿用該 db 現有版本,不會觸發 upgrade、不會動到內容。
      req = indexedDB.open(dbName);
    } catch {
      resolve(null);
      return;
    }
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => {
      // 名稱不存在才會走到這裡(等於建立新空 db)。立刻中止,避免留下垃圾。
      try { req.transaction.abort(); } catch { /* noop */ }
      resolve(null);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        resolve(null);
        return;
      }
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const get = tx.objectStore(STORE_NAME).get(STATE_KEY);
        get.onsuccess = () => { const v = get.result ?? null; db.close(); resolve(v); };
        get.onerror = () => { db.close(); resolve(null); };
      } catch {
        db.close();
        resolve(null);
      }
    };
    req.onblocked = () => resolve(null);
  });
}

/**
 * 目前資料庫沒有 state 時呼叫:嘗試在其他資料庫名稱裡找回舊資料。
 * 搜尋順序:indexedDB.databases()(若瀏覽器支援)列出的所有 db → 已知候選名稱。
 * 找到就回傳 { sourceName, state };找不到回傳 null。來源資料庫原封不動。
 */
export async function findLegacyState() {
  const names = new Set(LEGACY_DB_CANDIDATES);
  if (typeof indexedDB.databases === 'function') {
    try {
      for (const info of await indexedDB.databases()) {
        if (info && info.name && info.name !== DB_NAME) names.add(info.name);
      }
    } catch { /* 某些瀏覽器不支援;退回候選名單 */ }
  }
  for (const name of names) {
    const state = await tryReadStateFrom(name);
    if (state && typeof state === 'object' && Array.isArray(state.characters)) {
      diagnostics.adoptedFrom = name;
      return { sourceName: name, state };
    }
  }
  return null;
}
