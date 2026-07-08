/**
 * tests/_env.mjs — 測試共用環境:jsdom + fake-indexeddb(與 tools/smoke.mjs 同款)。
 * 每個測試檔第一行 import 它;測試以獨立 process 執行(tests/run.mjs 逐檔 spawn),
 * 避免 state.js 單例在測試之間互相污染。
 * 依賴安裝:npm i --no-save jsdom fake-indexeddb(專案根目錄;preflight 會自動處理)。
 */
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.FormData = dom.window.FormData;
globalThis.alert = () => {};

/** 極簡斷言器:t(條件, 名稱);summary() 印結果並以失敗數當 exit code。 */
let pass = 0; let fail = 0; const fails = [];
export function t(cond, name) {
  if (cond) { pass += 1; } else { fail += 1; fails.push(name); console.log('  FAIL', name); }
}
export function summary(title) {
  console.log(`${title}:${pass} 通過, ${fail} 失敗${fail ? ' → ' + fails.join(' | ') : ''}`);
  process.exit(fail ? 1 : 0);
}

/** 初始化乾淨 state(fake-indexeddb 每 process 全新,無需 clear)。 */
export async function freshState() {
  const { initDB } = await import('../utils/indexeddb.js');
  const { initState } = await import('../modules/state.js');
  await initDB();
  return initState({ appName: '測試', defaultPlayer: { playerName: '玩家' }, defaultSettings: {} });
}
