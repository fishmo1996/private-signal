/**
 * tests/run.mjs — 常駐不變式測試的執行器。
 * 每個 *.test.mjs 以獨立 node process 執行(state.js 是模組單例,同 process 跑多份會互相污染)。
 * 用法:node tests/run.mjs   (專案根目錄;需先 npm i --no-save jsdom fake-indexeddb)
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();

let failed = 0;
for (const f of files) {
  console.log(`\n▶ ${f}`);
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: 'inherit', cwd: join(dir, '..') });
  if (r.status !== 0) failed += 1;
}
console.log(`\n═══ 不變式測試:${files.length - failed}/${files.length} 檔全綠${failed ? ' ← 有失敗!' : ''}`);
process.exit(failed ? 1 : 0);
