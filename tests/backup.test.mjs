/**
 * tests/backup.test.mjs — 備份不變式(HANDOVER §5.6):
 * 1) exportStateJson 深拷貝後清空主金鑰與 presets 金鑰、打 secretsExcluded: true
 * 2) 匯出不動到執行中的 state(金鑰仍在)
 * 3) importStateJson 保留本機已輸入的金鑰(備份不含機密,匯入不得清空 key)
 */
import { t, summary, freshState } from './_env.mjs';

const state = await freshState();
const { exportStateJson, importStateJson } = await import('../modules/state.js');
const { saveApiConfig } = await import('../modules/api.js');
const { createCharacter } = await import('../modules/rooms.js');

await createCharacter({ name: '甲' });
await saveApiConfig({ provider: 'gemini', apiKey: '祕密金鑰XYZ', model: 'm', useRealApi: true });
state.apiConfig.presets[0] = { provider: 'openai', apiKey: '祕密金鑰PRESET', model: 'p' };

// 1) 匯出檔:零金鑰、有 secretsExcluded 旗標
const json = exportStateJson();
t(!json.includes('祕密金鑰XYZ'), '備份不含主金鑰');
t(!json.includes('祕密金鑰PRESET'), '備份不含 preset 金鑰');
const parsed = JSON.parse(json);
t(parsed.secretsExcluded === true, 'secretsExcluded 旗標存在');
t(parsed.app === 'private-signal', 'app 識別欄存在');
t(parsed.state.characters.length === 1, '備份含角色資料');

// 2) 匯出是深拷貝:執行中 state 的金鑰不受影響
t(state.apiConfig.apiKey === '祕密金鑰XYZ', '匯出後本機主金鑰仍在');
t(state.apiConfig.presets[0].apiKey === '祕密金鑰PRESET', '匯出後 preset 金鑰仍在');

// 3) 匯入無金鑰備份:本機金鑰保留、資料被覆蓋
const after = await importStateJson(json);
t(after.apiConfig.apiKey === '祕密金鑰XYZ', '匯入後主金鑰沿用本機');
t(after.apiConfig.presets[0]?.apiKey === '祕密金鑰PRESET', '匯入後 preset 金鑰沿用本機');
t(after.characters.length === 1 && after.characters[0].name === '甲', '匯入後資料正確');

// 4) 壞檔不動資料
let threw = false;
try { await importStateJson('{"app":"別的東西"}'); } catch { threw = true; }
t(threw, '結構不符的備份被拒絕');
t(after.characters.length === 1, '拒絕後資料未被更動');

summary('備份鐵律');
