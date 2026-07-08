/**
 * tests/snapshot.test.mjs — 自動快照不變式(v75):
 * 1) 首次開機(無既有資料)不建快照;有資料的開機才建
 * 2) 6 小時內不重複;超過間隔時覆蓋「最舊」那格;最多 2 份
 * 3) 快照不含 API 金鑰(比照備份鐵律)
 * 4) restoreSnapshot 覆蓋資料、沿用本機金鑰;壞 key 丟錯不動資料
 */
import { t, summary } from './_env.mjs';

const { initDB, SNAPSHOT_KEYS, readSnapshotRecord, writeSnapshotRecord } = await import('../utils/indexeddb.js');
const stateMod = await import('../modules/state.js');
const { initState, getState, persist, listStateSnapshots, restoreSnapshot } = stateMod;
const cfg = { appName: '測試', defaultPlayer: { playerName: '玩家' }, defaultSettings: {} };

await initDB();

// 1) 首次開機:全新資料庫,不該生出快照
await initState(cfg);
t((await listStateSnapshots()).length === 0, '首次開機(無既有資料)不建快照');

// 佈景:加一個角色+金鑰,persist 讓下次開機讀得到
const { createCharacter } = await import('../modules/rooms.js');
const { saveApiConfig } = await import('../modules/api.js');
await createCharacter({ name: '甲' });
await saveApiConfig({ provider: 'gemini', apiKey: '祕密金鑰SNAP', model: 'm' });
await persist();

// 2) 第二次開機:讀到既有資料 → 建第一份快照
await initState(cfg);
let snaps = await listStateSnapshots();
t(snaps.length === 1, '有資料的開機建立第一份快照');
t(snaps[0].characters === 1, '快照摘要:角色數正確');

// 3) 立刻再開機:6 小時節流,不新增
await initState(cfg);
t((await listStateSnapshots()).length === 1, '6 小時內開機不重複建快照');

// 4) 快照不含金鑰
const rec1 = await readSnapshotRecord(snaps[0].key);
t(!JSON.stringify(rec1).includes('祕密金鑰SNAP'), '快照不含 API 金鑰');
t(rec1.state.characters.length === 1, '快照含完整資料');

// 5) 把現有快照時間改舊 → 下次開機寫進另一格(共 2 份)
await writeSnapshotRecord(snaps[0].key, { ...rec1, takenAt: Date.now() - 7 * 3600 * 1000 });
await createCharacter({ name: '乙' });
await persist();
await initState(cfg);
snaps = await listStateSnapshots();
t(snaps.length === 2, '超過間隔後寫入第二格(共 2 份)');
t(snaps[0].characters === 2 && snaps[1].characters === 1, '兩份快照各自對應不同時點');

// 6) 兩格都改舊 → 覆蓋最舊那格,仍是 2 份
for (const k of SNAPSHOT_KEYS) {
  const r = await readSnapshotRecord(k);
  if (r) await writeSnapshotRecord(k, { ...r, takenAt: r.takenAt - 24 * 3600 * 1000 });
}
const before = await listStateSnapshots();
const oldestKey = before[before.length - 1].key;
await createCharacter({ name: '丙' });
await persist();
await initState(cfg);
snaps = await listStateSnapshots();
t(snaps.length === 2, '輪替後仍維持 2 份上限');
t(snaps[0].key === oldestKey && snaps[0].characters === 3, '覆蓋的是最舊那格');

// 7) 還原:資料退回、金鑰沿用本機
const target = snaps.find((s) => s.characters === 2); // 退回「乙還在、丙不在」那份
await restoreSnapshot(target.key);
const st = getState();
t(st.characters.length === 2, '還原後角色數退回快照時點');
t(st.apiConfig.apiKey === '祕密金鑰SNAP', '還原後金鑰沿用本機(不用重填)');

// 8) 壞 key 丟錯、不動資料
let threw = false;
try { await restoreSnapshot('snapshot-不存在'); } catch { threw = true; }
t(threw, '不存在的快照被拒絕');
t(getState().characters.length === 2, '拒絕後資料未被更動');

summary('自動快照');
