# HANDOVER.md — 私人訊號 交接文件

> 給未來的維護者(不管是三個月後的 AI 對話視窗、還是任何接手的人):
> 讀完這份,你就能安全地修改這台機。**動手前把「事故史與教訓」讀完,那是血淚。**
> 最後更新:2026-07-05,版本 v43。

---

## 0. 這是什麼、為誰而做

**私人訊號**是一個純前端的「虛擬角色手機」網站:玩家和自己創作的 AI 角色在一支擬真手機介面裡私訊、群聊、跑正文(小說式互動敘事)、看角色發社群、寫日記、被角色們背後八卦(旁觀群)。

**擁有者是唯一使用者**:繁體中文、成年女性玩家、資深角色扮演玩家(App→Risu 一路走來)、只玩自己寫的角色。她的需求哲學:
- **先討論確認、再動工**。給方案讓她選,不要擅自做主
- 一切以**省 token/省錢**與**隱私正確**為底線
- 她會實測回報,截圖是最常見的 bug 報告形式
- 交付物=完整 zip(整包覆蓋部署),每輪交付都要能直接上線

**技術棧刻意極簡**:無框架、無建置步驟、原生 ES Modules、IndexedDB 存檔。部署=把整包丟上 GitHub Pages(repo: fishmo1996)。本機直接開 index.html 旁邊起靜態伺服器也能跑。

---

## 1. 檔案地圖

```
private-signal/
├── index.html          # 唯一入口,PWA meta
├── manifest.json       # PWA(無 service worker——快取問題見部署節)
├── icon.svg
├── style.css           # 全部樣式;三主題 dusk(深)/sage(青霧)/berry(甜莓)
├── app.js              # 開機:initDB→initState→initNavigation→initUI;console 印版本
├── data/config.json    # appName、預設值、**version 版本戳(每版必升)**
├── utils/indexeddb.js  # db=private-signal-db / store=appState / key=state
└── modules/            # 19 模組,職責如下
    ├── state.js        # 單一 state 樹 + migrate(所有新欄位在這補預設)
    ├── rooms.js        # 房間/角色 CRUD:createCharacter/Group/Story/Peek、deleteCharacter
    ├── chat.js         # 訊息流:sendUserMessage、regenerateLastReply、selfChat(群/旁觀自燃)、
    │                   #   refreshChats(主動訊息)、splitChatParts(聊天感拆條)
    ├── prompt.js       # 四型建構器:buildPrompt(DM)/buildGroupPrompt/buildStoryPrompt/buildPeekPrompt
    ├── api.js          # generateReply(gemini/openai/claude)、stripNamePrefix(統一後處理)、
    │                   #   parseGroupReplies、applyOutputRules、TS_PREFIX 時間戳剝除
    ├── memory.js       # 記憶 CRUD、摘要管線 generateSummaryCandidates/commitSummary、
    │                   #   archiveChapter(正文章節封存)
    ├── voice.js        # extractVoiceTag([語音])、extractMoodTag([心情:x])、TTS
    ├── persona.js      # 多人設:createPersona(label=備註標籤,絕不進 prompt)、personaForRoom
    ├── social.js       # 社群:貼文/留言/自動發文(冷卻)、circleOfPost 圈子歸屬
    ├── diary.js        # 角色日記(私密視角)
    ├── album.js        # 相簿:addPhoto,分享照片只進被標註者的 DM
    ├── worldbook.js    # 世界書(關鍵字觸發條目)
    ├── charcard.js     # 角色卡匯入(Risu/ST png/json)
    ├── roombackup.js   # 單房備份 exportRoomJson/importRoom(含章節、statusBar、peek)
    ├── search.js       # 全域搜尋 searchAll
    ├── navigation.js   # 視圖堆疊 navigate/parentView
    ├── home.js         # 主畫面 App 網格
    ├── image.js        # 圖片壓縮
    └── ui.js           # 最大檔:全部渲染與互動(renderAll→renderPhone→各 view)
```

---

## 2. 資料模型(state 樹)

所有欄位的權威定義=`state.js` 的 migrate 區(新欄位一律在那補預設,舊資料自動升級)。速查:

```
state
├── characters[]        # {id,name,description,personality,systemPrompt,avatarImage,emoji,color,
│                       #  emojiStyle,noPhone,proactivity,knownPersonaId,relationships:{charId:文字},
│                       #  voice:{voiceURI,rate,pitch}}
├── personas[]          # {id,name,description,avatarImage,label} label=選單備註,絕不進 prompt
├── defaultPersonaId / activePersonaId
├── rooms[]             # {id,type:'dm'|'group'|'story'|'peek',title,participantIds,personaId,
│                       #  authorNote,statusBar,styleOverrides,mood:{emoji,at},unread,
│                       #  story 專屬: initialized,archivedChapters[],chapterCount,summarizedUpTo}
├── messagesByRoom{}    # roomId→[{id,role:'user'|'character'|'narrator'|'system',senderId,content,
│                       #  createdAt,image,voice,choices[]}]
├── memories            # {shared[](circleId=人設圈),byCharacterId{}(私密),byRoomId{}(場景)}
├── posts[] / commentsByPostId{}   # 社群;post.personaId=圈子
├── diariesByCharacterId{}
├── photos[]            # 相簿 {image,caption,characterIds[]}
├── worldbooks[]
├── apiConfig           # {provider,apiKey,model,temperature,topP,maxReplyChars:{dm,group,story},
│                       #  contextBudget,useRealApi,...} 金鑰只在 IndexedDB,絕不進備份/匯出
├── settings            # theme,fontScale,showTimestamps,showStatusCard,storyChoices,storyFormat,
│                       #  chatFeel,moodEmoji,voiceTag,quickReplies[],outputRules[],styleModules[],
│                       #  globalPrompt,autoPostCooldownMin,appIcons{},bgImage,ttsProvider
└── *LastRefresh        # social/chat/diary/selfChat 冷卻時間戳
```

**字數上限**:編輯訊息 story 20000/其他 2000;maxReplyChars 預設 dm 800/group 1200/story 4000。

---

## 3. 隱私鐵律(改任何 prompt 相關程式前先背)

1. **DM 內容與私密記憶只進本人**的 DM prompt。任何其他建構器(群/正文/社群/日記/旁觀)都不得引用
2. **共享記憶按圈子**(personaId)隔離:角色只看得到自己綁定人設圈的共享記憶+全域共享
3. **群聊/正文/自燃/旁觀**的素材=公開資訊(人設公開描述、公開社群、彼此關係欄、該房歷史、共享記憶)
4. **相簿照片**只進「被標註角色」的 DM
5. **旁觀群(peek)**:玩家不在 participantIds、UI 無輸入框、`sendUserMessage` 底層直接 return——三層防呆
6. **API 金鑰**只存 IndexedDB 的 apiConfig,絕不寫進任何備份、匯出、prompt
7. 測試慣例:用「祕密代號」(如 K9、H7)塞進私密資料,然後斷言其他建構器的輸出**不含代號**

## 4. Prompt 建構器與輸出後處理

**四型建構器**(prompt.js),按房型嚴格分流:
- `buildPrompt`(DM):人設+角色+私密/共享記憶+世界書+時間+聊天感指令+心情/語音標記指令
- `buildGroupPrompt`:全員公開資訊+關係(雙方同場才注入)+共享記憶;輸出=JSON 陣列 [{name,content}]
- `buildStoryPrompt`:說書人模式+statusBar+章節前情(【第N章|前情】記憶)+選項指令(▷)
- `buildPeekPrompt`:同群聊素材+【關於玩家你們知道的】=人設公開描述+反腦補條款(可猜測、不可編造具體事件)+背著本人八卦指令

**開發資訊/檢視 prompt 的預覽必須按房型選建構器**(v40 修過拿錯建構器產生 undefined 的事故)。

**輸出後處理鏈**(順序重要,都在 chat.js 的接收點):
```
原始輸出
→ stripNamePrefix(api.js):①剝行首時間戳 TS_PREFIX ②刮「名字:」前綴 ③applyOutputRules 替換規則
→ extractMoodTag:尾行 [心情:x] → room.mood,標記剝離
→ extractVoiceTag:開頭 [語音] → voice:true,標記剝離
→ chatFeel 拆條 splitChatParts:「---」分隔 1~3 則,語音訊息不拆
→ (正文)extractStoryChoices:▷ 行 → choices[]
```
新增任何「注入格式」或「輸出標記」時,**兩端都要做**:prompt 端講清楚規則、輸出端做剝除/解析,並加防鸚鵡(見下節)。

## 5. 鸚鵡防範清單(血淚,新功能必讀)

模型會**照抄 prompt 裡的示範和注入格式**。已踩過的坑:
1. **「(揉眼睛)」事件**:聊天感指令舉例用了具體動作,模型當口頭禪每句都揉 → 教訓:指令裡**不給可抄的具體例子**,用抽象描述(「不要固定口頭禪式的重複動作」)
2. **時間戳鸚鵡**:歷史訊息注入「(7/5(週日) 14:22)」,模型照格式輸出,還把 [語音] 擠離行首害解析失敗 → 修:輸出端 TS_PREFIX 剝除(放在 stripNamePrefix **最前面**,順序關鍵)+prompt 明講「系統附註勿輸出」
3. **▷ 選項符號**:正文選項用 ▷ 標記,曾被模型在非選項處濫用 → 解析端只認行首格式
4. **匯入卡的開場白**=最強模仿樣本(小說腔 DM 就是這麼來的),聊天感指令+拆條格式要求可壓制

**通則**:凡注入格式,問自己三題——模型會不會抄?抄了輸出端擋得住嗎?標記被擠位/變形還認得出嗎?

## 6. 事故史與工程教訓

1. **import 行被蓋掉事故(最大)**:某輪 python str replace 用了舊版字串當錨,把 ui.js 的 chat.js import 行蓋回舊版 → `selfChat`/`archiveChapter` 變未定義 → **點擊無聲炸**(async handler 沒 catch,錯誤只進 console)。教訓:
   - python heredoc 改字串後**必 grep 驗證**落地(曾兩次「改了沒寫檔」)
   - `node --check` 和模組動態 import **抓不到**這種錯(名字不在 import 清單=執行期才炸)
   - → 防身武器①②(下節)因此而生
2. **綁定死按鈕事故**:選項/朗讀按鈕綁在 renderRoomView,但 renderMessages 每次重寫 innerHTML → 第二次渲染起按鈕全死。教訓:**訊息區內的按鈕必須綁在 renderMessages 內**(重繪即重綁),或用事件委派(操作列浮出就是委派做的,`wrap.dataset.tapBound` 防重綁)
3. **peek 房 input.focus() 無守門**:旁觀房沒輸入框,renderRoomView 尾端 `input.focus()` 直接炸掉整個渲染尾段。教訓:**房型差異化之後,所有 composer 相關存取都要 null-safe**
4. **?? 優先序**:`{...}[key] ?? 'default' + suffix` 會解析成 `a ?? (b+c)`,吃掉 suffix → 必加括號
5. **bash 陷阱**:echo/註解含全形括號會炸 shell → 長訊息分步執行;每輪清理 `_t*.mjs node_modules package*.json` 再打包
6. **冷卻設計**:selfChat 冷卻**成功才消耗**(失敗不燒)、空房第一把免冷卻、失敗寫**房內系統訊息**(不只 alert,手機上 alert 會被忽略)

## 7. 測試方法(兩把防身武器+慣例)

**武器① 跨模組 import 完整性掃描器**(python):蒐集全專案 export 名 → 每檔比對「有呼叫、非本檔宣告、不在 import 清單」→ 揪出無聲 ReferenceError。誤報來源:動態 import、函式參數同名——逐筆查證即可。

**武器② jsdom 真渲染真點擊煙霧測**:`npm i jsdom fake-indexeddb --no-save`,載入 index.html,真的 initUI、navigate 十二個頁面、dispatchEvent 點關鍵按鈕(↻/選項/封存/⋯選單),收集 unhandledRejection。**這是唯一能抓到 UI 層無聲炸的方法**,大改 ui.js 後必跑。

**慣例**:
- 資料層測試:fake-indexeddb + mock `globalThis.fetch`(gemini 格式:`{candidates:[{content:{parts:[{text}]}}]}`)
- 每輪交付前:`node --check` 全檔+19 模組動態 import+相關功能驗收測
- 隱私測試用祕密代號斷言不外洩
- 測後清理:`rm -rf _t*.mjs node_modules package.json package-lock.json`
- 打包:`cd /home/claude && rm -f /mnt/user-data/outputs/private-signal.zip && zip -rq ...`
- **每版必升 data/config.json 的 version**,回報問題先對版本號

## 8. 部署 SOP 與快取疑難

- 部署=整包上傳 GitHub Pages(她的流程是網頁 upload,GitHub 只對「內容有變」的檔案記新時間——時間戳不齊是正常的)
- Pages 生效 1~10 分鐘;Actions 出現「Deployment failed, try again later」=GitHub 暫時故障 → Re-run;排隊卡死 → 改 README 觸發新 run(新 commit 永遠優先,舊 run 不會覆蓋)
- **驗證部署一律看版本戳**:管理 › 開發資訊 →「目前版本:vXX」;不符=快取
- iOS PWA 快取極頑固:Safari 加 `?v=XX` 繞過;PWA 刪掉重加(**IndexedDB 資料與 PWA 圖示無關,不會掉**,但動手前先匯出備份)
- 本機測試:任何靜態伺服器即可;**記得關掉舊版的終端**(踩過:以為部署壞了其實在跑本機舊版)

## 9. 功能清單(玩家視角速查)

- **聊天 App**:好友(DM,心情表情/語音訊息/聊天感拆條/主動訊息)、聊天室(群聊+↻自燃)、👁旁觀(角色背後八卦你,你插不了話)
- **正文 App**:說書人敘事、▷選項、狀態列卡、章節封存(摘要進記憶+原文回翻)、書頁閱讀版式
- **社群 App**:角色自動發文(帶圖)、留言互動、按人設圈子隔離
- **角色與玩家**:角色 CRUD、關係欄、語音、匯入卡(Risu/ST)、日記;多人設+備註標籤
- **記憶體系**:記住按鈕→候選→入庫;摘要至今;私密/共享(圈子)/場景三層;世界書
- **其他**:相簿(分享進 DM)、全域搜尋、單房備份、全域備份、輸出替換規則、樣式模組、三主題、自訂 App 圖示、TTS 朗讀
- **管理面板**(手機外):記憶管理、開發資訊(版本戳/資料診斷/prompt 預覽——按房型)

## 10. 待辦架(未做,依她點菜)

- D 輸入區減層(簡潔化四件套被砍的那件)
- 多世界觀角色複用:方案 A 場景記憶隔離 vs 方案 B 每世界觀複製角色+各自圈子——**她尚未選**,民國線(霧港三人)vs 現代線(OFFSET)就是這個需求
- 霧港三人卡拆裝(指南已給她,她自己操作)
- 任何她實測回報的體感調整(書頁版式行距/字級是主觀項)

## 11. 給接手 AI 的相處指南

- 語氣:朋友、繁體中文、可以玩梗;她罵髒話=情緒強度不是敵意
- **先提方案討論,她點頭才動工**;她說「你自己斟酌」時才自主
- 她的截圖 bug 報告資訊量很高,先讀圖再猜
- 她在乎:錢(token)、隱私正確、體感(她會說「詭異」「很怪」——追問具體處)
- 交付格式:zip + present_files + 繁中總結(改了什麼/為什麼/怎麼驗)
- 額度有限:她會報剩餘 %,自己配速,重要的先做
