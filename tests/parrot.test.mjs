/**
 * tests/parrot.test.mjs — 鸚鵡防範不變式(HANDOVER §5,血淚清單):
 * TS_PREFIX 寬容版(v60)、名字↔時間戳雙向剝除(v64)、防誤剝、
 * 尾部標記收割器(v71:亂序/山寨標記/正文括號不誤吃)、
 * 拆條三形態(v62 行首/v64 行內 dash/v70 無 dash 黏合)、破折號不誤傷。
 */
import { t, summary, freshState } from './_env.mjs';

await freshState(); // applyOutputRules 會讀 state.settings.outputRules,先建乾淨 state
const { stripTsPrefix, stripNamePrefix } = await import('../modules/api.js');
const { harvestTailTags } = await import('../modules/voice.js');
const { splitChatParts } = await import('../modules/chat.js');

// --- 時間戳剝除 ---
t(stripTsPrefix('(7/5(週日) 14:22) 嗨') === '嗨', 'TS 行首時間戳剝除');
t(stripTsPrefix('(7/5(週日) 14:22)嗨').trim() === '嗨', 'TS 無空格也剝');
t(stripNamePrefix('(7/5(週日) 14:22)甲:嗨', ['甲']) === '嗨', 'v62「(時間戳)名字:」剝除');
t(stripNamePrefix('甲:(7/5(週日) 14:22)嗨', ['甲']) === '嗨', 'v64 反向「名字:(時間戳)」剝除');
t(stripNamePrefix('(晚上8:30見)再說', []) === '(晚上8:30見)再說', '防誤剝:內文合法時間不剝(時分後有字)');
t(stripNamePrefix('甲:甲:嗨', ['甲']) === '嗨', '「名字:名字:」怪輸出刮兩次');
t(stripNamePrefix('約好了(約 3 天前)見面', []) === '約好了見面', 'REL_TIME_ECHO 相對時間附註剝除');

// --- 尾部標記收割器(v71) ---
const h1 = harvestTailTags('嗨\n[狀態:聽歌]\n[心情:🔥]');
t(h1.content === '嗨' && h1.mood === '🔥' && h1.status === '聽歌', '收割器:亂序(心情在狀態後)仍各就各位');
const h2 = harvestTailTags('嗨\n[心情:🔥]\n[好感度:87]');
t(h2.content === '嗨' && h2.mood === '🔥' && !String(h2.content).includes('好感度'), '收割器:山寨標記丟棄不裸露');
const h3 = harvestTailTags('中括號[不是標記]在正文裡\n真的');
t(h3.content === '中括號[不是標記]在正文裡\n真的' && !h3.mood && !h3.status, '收割器:遇非標記行即停,正文括號不誤吃');
const h4 = harvestTailTags('嗨\n【狀態：全形也認】');
t(h4.status === '全形也認', '收割器:全形括號/冒號皆認');
const h5 = harvestTailTags('嗨\n[狀態:這句話遠遠超過十五個字所以應該被丟棄掉才對喔]');
t(h5.status === null && h5.content === '嗨', '收割器:>15 字狀態丟棄但標記仍剝除');

// --- 拆條三形態 ---
const s1 = splitChatParts('第一則\n---\n第二則');
t(s1.length === 2 && s1[1] === '第二則', '拆條:標準行首 ---');
const s2 = splitChatParts('第一則。---甲: 第二則', ['甲']);
t(s2.length === 2 && s2[1] === '第二則', 'v64 行內「---名字:」轉分隔');
const s3 = splitChatParts('第一則。---(7/5(週日) 14:22)第二則');
t(s3.length === 2 && s3[1] === '第二則', 'v64 行內「---(時間戳)」轉分隔+拆後再剝 TS');
const s4 = splitChatParts('第一則。甲:(7/5(週日) 14:22)第二則', ['甲']);
t(s4.length === 2 && s4[1] === '第二則', 'v70 無 dash 黏合「名字:(時間戳)」切分');
const s5 = splitChatParts('他說甲:你好,我笑了', ['甲']);
t(s5.length === 1, 'v70 防誤傷:一般轉述「名字:你好」不切');
const s6 = splitChatParts('這是——破折號的內文——不該被拆');
t(s6.length === 1, '破折號「——」內文不誤拆');
const s7 = splitChatParts('一\n---\n二\n---\n三\n---\n四');
t(s7.length === 3, '拆條上限 3 則');

// --- v76:心聲截尾器(時間戳鸚鵡第四形態,擁有者截圖案) ---
const { cutInlineTsRecitation } = await import('../modules/api.js');
const iv1 = cutInlineTsRecitation('老實說,我其實很喜歡被妳依賴的感覺。陳以彥: (7/8(週三) 14:57)就算要我抱著妳一整天。', ['陳以彥']);
t(iv1 === '老實說,我其實很喜歡被妳依賴的感覺。', '心聲:行內「名字:(時間戳)」從名字處截尾');
t(cutInlineTsRecitation('約好了(7/8(週三) 14:57)見面', []) === '約好了見面', '心聲:孤立行內時間戳剝除');
t(cutInlineTsRecitation('(晚上8:30見)再說', ['甲']) === '(晚上8:30見)再說', '心聲:防誤剝(時分後有字不剝,v60 規格)');
t(cutInlineTsRecitation('他心裡想著甲:你好', ['甲']) === '他心裡想著甲:你好', '心聲:「名字:」後無時間戳不截(一般轉述不誤傷)');

// --- v77(根源一):全域標籤收割+行內通用切分 ---
const { harvestTags } = await import('../modules/voice.js');
const g1 = harvestTags('A。---B[心情:🔥]');
t(g1.mood === '🔥' && !g1.content.includes('心情'), 'v77 收割:埋在行內的 [心情:🔥] 全域抽走');
const g1s = splitChatParts(g1.content, ['甲']);
t(g1s.length === 2 && g1s[0] === 'A。' && g1s[1] === 'B', 'v77 驗收:「A。---B[心情:🔥]」→ 兩則氣泡+無標籤殘留');
const g2 = harvestTags('聊到一半[狀態:在練團]還沒完\n[心情:🔥]');
t(g2.status === '在練團' && g2.mood === '🔥' && g2.content === '聊到一半還沒完', 'v77 收割:行中 [狀態] 也抽走,尾部心情照收');
const g3 = harvestTags('中括號[不是標記]在正文裡\n[好感度:87]');
t(g3.content === '中括號[不是標記]在正文裡' && !g3.mood && !g3.status, 'v77 收割:正文一般中括號不誤吃、尾部山寨標記照丟');
const s8 = splitChatParts('真的要我抱著妳一起嗎?---少在那邊裝傻。');
t(s8.length === 2 && s8[1] === '少在那邊裝傻。', 'v77 行內通用切分:句末標點後的 ---(不跟名字不跟時間戳)也切');
t(splitChatParts('型號A---B不該被拆').length === 1, 'v77 防誤切:非句末標點後的行內 --- 不切');
t(splitChatParts('這是——破折號的內文——不該被拆。').length === 1, 'v77 防誤切:破折號「——」迴歸不誤傷');

// --- v77(根源三):拆條後行首名字前綴補剝(拆條改變行首,行首錨定剝除器要再跑一次) ---
const s10 = splitChatParts('第一則\n---\n甲:第二則', ['甲']);
t(s10.length === 2 && s10[1] === '第二則', 'v77 拆條後每則行首「名字:」補剝(不要求後跟時間戳)');
t(splitChatParts('他說甲:你好,我笑了', ['甲'])[0] === '他說甲:你好,我笑了', 'v77 防誤傷:句中轉述「名字:」不剝(僅則首)');

// --- v86.1:播放清單格式閘門(三快照最後一塊;擁有者截圖:整包只剩一句台詞) ---
const { sanitizePlaylistSnapshot } = await import('../modules/phonepeek.js');
const plGood = '夜空中最亮的星 — 逃跑計劃\n倒數 — 鄧紫棋\n循環理由:想到等等要見到她。';
t(sanitizePlaylistSnapshot(plGood) === plGood, 'v86.1 合法清單原樣通過(含循環理由)');
const plMixed = '我馬上就到,別亂跑,今晚我們就膩在一起。\n倒數 — 鄧紫棋\n循環理由:想她。';
const plOut = sanitizePlaylistSnapshot(plMixed);
t(!plOut.includes('別亂跑') && plOut.includes('倒數'), 'v86.1 台詞行丟棄、歌曲行保留');
t(sanitizePlaylistSnapshot('♪ 我馬上就到,別亂跑,誰也不准分開。') === '', 'v86.1 整包台詞=全滅攔下(回空讓上層教重按)');
t(sanitizePlaylistSnapshot('Blinding Lights by The Weeknd\n循環理由:練歌。').includes('Blinding'), 'v86.1 英文 by 格式也認');

// --- v84.3:草稿收件人守門(模型把「誰寫給誰」搞混,吐出寄給自己的草稿) ---
const { sanitizeDraftSnapshot: sds843 } = await import('../modules/phonepeek.js');
const draftRaw = 'To:莫映里||今晚去你家||好想見他\nTo:謝子勳||帶妳吃熱炒||想炫耀\n鄭翰元||留空檔||尷尬';
const draftOut = sds843(draftRaw, '謝子勳');
t(!draftOut.includes('熱炒') && draftOut.includes('莫映里') && draftOut.includes('鄭翰元'), 'v84.3 自寄草稿丟棄,合法收件人保留');
t(sds843('子勳||嗨||怪', '謝子勳') === '', 'v84.3 簡稱自寄也擋(模糊互含)');
t(sds843(draftRaw).split('\n').length === 3, 'v84.3 未帶角色名=不誤丟(向後相容)');

// --- v81:走鐘偵測器+卡片體檢(f1/e3/f2 共用;只偵測不硬剝) ---
const { assessDmDrift, auditCharacterCard } = await import('../modules/quality.js');
const novel = '陳以彥:(他放下手中的小泡芙,看著她那張因為不高興而微微撅起的嘴,沉默了兩秒,最終還是無奈地嘆了口氣,隨手將手機擱在桌面上。)\n\n「抱歉。」(他伸手揉了揉她的頭髮,視線卻忍不住掃過她纖細的頸項,聲音變得低沉。)';
t(assessDmDrift(novel).drifted === true, 'v81 偵測:整坨小說腔(前綴+長括號旁白+無拆條)命中');
t(assessDmDrift('早安。\n---\n吃飯了嗎?').drifted === false, 'v81 偵測:正常拆條訊息不誤判');
t(assessDmDrift('(嘆氣)好啦知道了').drifted === false, 'v81 偵測:單一短括號註不誤判(單特徵放行)');
t(assessDmDrift('嗯。').drifted === false, 'v81 偵測:極短回覆不誤判');
const aud1 = auditCharacterCard({ name: '陳以彥', systemPrompt: '對話範例:\n陳以彥:(嘆了口氣)「妳又來了。」' });
t(aud1.some((f) => f.level === 'warn' && f.field === 'systemPrompt'), 'v81 體檢:劇本格式範例掃得出來');
t(auditCharacterCard({ name: '小安', systemPrompt: '個性直爽,講話簡短。' }).length === 0, 'v81 體檢:乾淨卡片零誤報');
t(auditCharacterCard({ name: '小安', systemPrompt: '請以第三人稱旁白描寫他的動作神態' }).some((f) => f.level === 'warn'), 'v81 體檢:旁白教學字眼掃得出來');

// --- v80:冒號變體+【】括號補洞、名字模糊剝除(陳以彥實案:v79 仍見「名字:(旁白)」) ---
for (const colon of [':', ':', '\uFE30', '\uFE55', '\u2236']) {
  t(!stripNamePrefix(`陳以彥${colon}(他放下手機)`, ['陳以彥']).includes('陳以彥'), `v80 冒號變體 ${JSON.stringify(colon)} 剝掉`);
}
t(!stripNamePrefix('【陳以彥】:內容', ['陳以彥']).includes('陳以彥'), 'v80 【】包名剝掉');
t(!stripNamePrefix('陳以彥。:內容', ['陳以彥']).includes('陳以彥'), 'v80 「名字。:」剝掉');
t(!stripNamePrefix('以彥:內容', ['陳以彥']).includes('以彥:'), 'v80 模糊:簡稱前綴剝掉');
t(!stripNamePrefix('陳以彥:內容', ['陳以彥🔥']).includes('陳以彥:'), 'v80 模糊:卡名帶表符也剝');
t(!stripNamePrefix('陳以彥說:內容', ['陳以彥']).startsWith('陳以彥'), 'v80 模糊:「名字說:」剝掉');
t(stripNamePrefix('他說陳以彥:你好', ['陳以彥']).startsWith('他說'), 'v80 防誤傷:轉述「他說名字:」保留');
t(stripNamePrefix('陳媽媽:吃飯了', ['陳以彥']).startsWith('陳媽媽'), 'v80 防誤傷:別人的名字不剝');
t(stripNamePrefix('10:30 見', ['陳以彥']).startsWith('10:30'), 'v80 防誤傷:時間不剝');
const v80m = harvestTags('嗨[心情\uFE30🔥]');
t(v80m.mood === '🔥' && v80m.content === '嗨', 'v80 收割:變體冒號的心情標籤也認');

// --- v76:搜尋快照下限閘門+UI 動詞前綴剝除 ---
const { sanitizeSearchSnapshot, sanitizeDraftSnapshot } = await import('../modules/phonepeek.js');
const okSearch = '女友一直撒嬌怎麼辦\n如何控制自己的慾望\nF罩杯內衣尺寸表\n台北 巧克力奶昔\n怎麼緩解想念一個人的焦慮感';
t(sanitizeSearchSnapshot(okSearch).split('\n').length === 5, '搜尋:五條正常關鍵字原樣通過');
t(sanitizeSearchSnapshot('送出如何讓女朋友停止撒嬌\n' + okSearch).startsWith('如何讓女朋友停止撒嬌'), '搜尋:「送出」前綴剝除、關鍵字保留');
t(sanitizeSearchSnapshot('搜尋不到朋友的IG\n' + okSearch).includes('搜尋不到朋友的IG'), '搜尋:「搜尋」無冒號=內容本身,不誤剝');
t(sanitizeSearchSnapshot('搜尋:天氣\n' + okSearch).includes('天氣'), '搜尋:「搜尋:」帶冒號=標籤,剝前綴');
t(sanitizeSearchSnapshot('準備好迎接我了嗎?\n(揉了揉眼睛)\n---\n請輸出你的搜尋紀錄') === '', '搜尋:清潔後剩不到 3 條=整包失格回空(下限閘門)');
t(sanitizeSearchSnapshot('') === '', '搜尋:空輸入回空');

// --- v76:草稿欄位守門 ---
t(sanitizeDraftSnapshot('莫映里||其實今天一直在想妳||太黏了,刪掉') !== '', '草稿:三欄合法保留');
t(sanitizeDraftSnapshot('其實今天一直在想妳||太黏了,刪掉') !== '', '草稿:二欄舊格式相容保留');
t(sanitizeDraftSnapshot('這一晚妳別想睡了,我會讓妳深刻記住。') === '', '草稿:無 || 裸句=走鐘丟棄(擁有者截圖案)');
t(sanitizeDraftSnapshot('||只剩內心註記') === '', '草稿:||開頭缺首欄仍丟(v70 迴歸)');
const dMix = sanitizeDraftSnapshot('裸句台詞充當草稿。\n莫映里||想妳||刪掉\n---');
t(dMix === '莫映里||想妳||刪掉', '草稿:混合輸入只留合法行');

summary('鸚鵡防範');
