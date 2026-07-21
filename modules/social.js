/**
 * modules/social.js
 * 本機社群動態：貼文、留言、按讚，以及角色的 mock 留言。
 *
 * 資料存放(皆在 IndexedDB 的同一份 state 中，重新整理後仍存在):
 *   state.posts               貼文陣列 [{id, authorId, content, createdAt, likes, likedByPlayer}]
 *   state.commentsByPostId    留言 { [postId]: [{id, authorId, content, createdAt}] }
 *   authorId 為 'player' 或角色 id。
 *
 * 隱私規則(嚴格遵守):
 * 社群是「公開」空間。角色在社群的 mock 留言只能取用——
 *   1. 角色自己的公開設定(personality / scenario / avatarEmoji)
 *   2. 貼文與留言本身的內容
 *   3. 共享記憶(state.memories.shared)
 * v83 起細分為兩級:
 * A. 多角色共用的「留言包」prompt(buildSocialPrompt,一次呼叫產多人)——
 *    絕不讀取 memories.byCharacterId、byRoomId、任何 messagesByRoom;放進去=在場全員都讀到。
 *    (v83 例外:各自的「關係階段」一句,擁有者核准的軟性資訊,框語不明講。)
 * B. 單人呼叫(buildAutoPostPrompt 發文 / buildSoloSocialReplyPrompt 指名回覆)——
 *    可讀「本人自己的」私密記憶與私訊尾段,並強制「公開版面要含蓄」指令;
 *    絕不讀取其他角色的私密資料(隱私測試把關)。
 * 反向不變：社群互動若要成為記憶，只會寫入 shared。
 */

import { getState, genId, persist, getCharacter } from './state.js';
import { hashStr, pick, echoOf, traitOf, sceneOf } from './chat.js';
import { getApiConfig, generateReply, parseGroupReplies, stripNamePrefix } from './api.js';
import { matchEntries } from './worldbook.js';
import { getPersona, defaultPersona, circleOfPost } from './persona.js';
import { sharedMemoriesFor } from './memory.js';
import { globalPromptSection, fmtMsgTime } from './prompt.js';

/* ---------------- 基本資料操作 ---------------- */

export function getPosts() {
  const state = getState();
  if (!state.posts) state.posts = [];
  return state.posts;
}

export function getPost(postId) {
  return getPosts().find((p) => p.id === postId) || null;
}

export function getComments(postId) {
  const state = getState();
  if (!state.commentsByPostId) state.commentsByPostId = {};
  if (!state.commentsByPostId[postId]) state.commentsByPostId[postId] = [];
  return state.commentsByPostId[postId];
}

/** 建立貼文。authorId 為 'player' 或角色 id。 */
export async function createPost(authorId, content, image = null, personaId = null) {
  const text = String(content || '').trim();
  if (!text && !image) return null;
  const post = {
    id: genId('post'),
    authorId,
    content: text,
    image: image || null,
    personaId: authorId === 'player'
      ? (personaId || getState().activePersonaId || getState().defaultPersonaId)
      // v70:角色貼文記「作者認識的人設」圈——原本存 null 被 recentFeedText 當全域可見,
      // 深海線角色的貼文洩進家教線的旁觀群(跨圈污染,與披薩事件同族)。
      : (getState().characters.find((c) => c.id === authorId)?.knownPersonaId || getState().defaultPersonaId),
    createdAt: Date.now(),
    likes: 0,
    likedByPlayer: false,
  };
  getPosts().unshift(post); // 新貼文在最上面
  await persist();
  return post;
}

/** 玩家按讚/收回讚。 */
export async function toggleLike(postId) {
  const post = getPost(postId);
  if (!post) return;
  post.likedByPlayer = !post.likedByPlayer;
  post.likes = Math.max(0, post.likes + (post.likedByPlayer ? 1 : -1));
  await persist();
}

/** 新增留言。 */
/**
 * v79(a案):FB 式樓中樓歸樓器——共用單一實作(顯示端與 prompt 端同一套,不再各養一份)。
 * 修 v-舊版 renderSocialPost 的 hops<20 保險絲:長樓鏈深超過 20 時爬到一半停住,把半路
 * 留言誤認成樓主 → 整批掛錯根、渲染端只畫真樓主 → 留言無聲消失(擁有者實測約 40 則觸發)。
 * 新版:記憶化+防循環記號,鏈多長都爬得到真根;循環(理論上不會有,匯入壞資料才可能)
 * 走防呆。最後一道保險:孤兒群(根不在樓主清單)平鋪回最外層——寧可排版醜,絕不吞留言。
 */
export function groupComments(comments) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootCache = new Map();
  const rootOf = (c0) => {
    if (rootCache.has(c0.id)) return rootCache.get(c0.id);
    const path = [];
    const seen = new Set();
    let cur = c0;
    while (cur.replyTo?.commentId && byId.has(cur.replyTo.commentId)) {
      if (seen.has(cur.id)) break; // 防循環:壞資料也不無窮迴圈
      seen.add(cur.id);
      path.push(cur.id);
      if (rootCache.has(cur.id)) { cur = byId.get(rootCache.get(cur.id)); break; }
      cur = byId.get(cur.replyTo.commentId);
    }
    const rid = rootCache.get(cur.id) || cur.id;
    for (const id of path) rootCache.set(id, rid);
    rootCache.set(c0.id, rid);
    return rid;
  };
  const roots = [];
  const childrenByRoot = new Map();
  for (const c of comments) {
    const rid = rootOf(c);
    if (rid === c.id) { roots.push(c); continue; }
    if (!childrenByRoot.has(rid)) childrenByRoot.set(rid, []);
    childrenByRoot.get(rid).push(c);
  }
  // 孤兒防呆:根不在樓主清單的群,整批平鋪成樓主
  const rootIds = new Set(roots.map((r) => r.id));
  for (const [rid, kids] of [...childrenByRoot.entries()]) {
    if (rootIds.has(rid)) continue;
    for (const k of kids) { roots.push(k); rootIds.add(k.id); }
    childrenByRoot.delete(rid);
  }
  roots.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  return { roots, childrenByRoot };
}

/** v79(c案):取出某留言所屬「那一樓」的完整串(樓主+全部樓中樓,時間序)。 */
export function threadOf(postId, commentId) {
  const comments = getComments(postId);
  const { roots, childrenByRoot } = groupComments(comments);
  for (const root of roots) {
    const kids = childrenByRoot.get(root.id) || [];
    if (root.id === commentId || kids.some((k) => k.id === commentId)) return [root, ...kids];
  }
  return [];
}

export async function addComment(postId, authorId, content, personaId = null, replyTo = null) {
  const text = String(content || '').trim();
  if (!text) return null;
  const comment = {
    id: genId('cmt'),
    authorId,
    content: text,
    ...(replyTo ? { replyTo } : {}),   // {authorId, name}:回覆的是哪一位
    ...(authorId === 'player'
      ? { personaId: personaId || getState().activePersonaId || getState().defaultPersonaId }
      : {}),
    createdAt: Date.now(),
  };
  getComments(postId).push(comment);
  await persist();
  return comment;
}

/** 編輯貼文內容。 */
export async function editPost(postId, content) {
  const post = getPost(postId);
  const text = String(content || '').trim();
  if (!post || !text) return null;
  post.content = text;
  post.editedAt = Date.now();
  await persist();
  return post;
}

/** 刪除貼文(連同留言)。 */
export async function deletePost(postId) {
  const state = getState();
  const idx = getPosts().findIndex((p) => p.id === postId);
  if (idx !== -1) state.posts.splice(idx, 1);
  delete state.commentsByPostId[postId];
  if (state.currentPostId === postId) state.currentPostId = null;
  await persist();
}

/* ---------------- 角色的預設貼文 ---------------- */

/**
 * 為還沒發過「初始貼文」的角色各產生一篇 mock 貼文,
 * 讓社群首頁不會空空的。每個角色只 seed 一次(以 socialSeededCharIds 記錄)。
 */
export async function ensureSeedPosts() {
  const state = getState();
  if (!state.socialSeededCharIds) state.socialSeededCharIds = [];
  let changed = false;

  for (const c of state.characters) {
    if (state.socialSeededCharIds.includes(c.id)) continue;
    const seed = hashStr(c.id);
    const trait = traitOf(c);
    const scene = sceneOf(c);
    const lines = [
      `${scene ? `${scene}。` : ''}今天也在。${c.avatarEmoji || ''}`.trim(),
      `開了帳號。${trait ? `雖然我是${trait}的人,` : ''}但偶爾也想在這裡留下一點什麼。`,
      `${scene ? `最近:${scene}。` : '最近沒什麼大事。'}有事私訊，沒事按個讚。`,
      `第一篇。不知道要寫什麼，先佔個位置。`,
    ];
    state.posts = state.posts || [];
    state.posts.push({
      id: genId('post'),
      authorId: c.id,
      content: pick(lines, seed),
      createdAt: c.createdAt || Date.now(),
      likes: seed % 4,
      likedByPlayer: false,
    });
    state.socialSeededCharIds.push(c.id);
    changed = true;
  }
  if (changed) {
    state.posts.sort((a, b) => b.createdAt - a.createdAt);
    await persist();
  }
  return changed;
}

/* ---------------- Mock 角色留言 ---------------- */

/** 只取「公開」的共享記憶當提示；絕不碰私密與場景記憶。 */
function sharedMemoryHint(seed) {
  const state = getState();
  const pool = (state.memories?.shared || []).filter((m) => m.content);
  if (!pool.length) return '';
  const m = pick(pool, seed);
  return m.content.length > 20 ? m.content.slice(0, 20) + '…' : m.content;
}

/**
 * 玩家發文或留言後，產生自然的角色留言:
 * 一位主要回覆者 + 0~2 位補充，單次最多 3 則；不是每個角色都必定留言。
 * 與群聊 mock 同一套機制(seed 可重現、取角色公開設定接話)。
 *
 * @param {object} opts
 * @param {object} opts.post 貼文
 * @param {string} opts.triggerText 玩家剛送出的內容(貼文或留言)
 * @returns {Array<{characterId:string, content:string, delay:number}>}
 */
export function generateMockSocialReplies({ post, triggerText }) {
  const state = getState();
  const chars = state.characters;
  if (!chars.length) return [];

  const commentCount = getComments(post.id).length;
  const seed = hashStr(triggerText) + commentCount * 19 + hashStr(post.id);
  const echo = echoOf(triggerText);

  // 貼文作者(若是角色)優先出面回覆自己貼文底下的動靜，其他情況輪到誰是誰。
  const author = post.authorId !== 'player' ? getCharacter(post.authorId) : null;
  const main = (author && (seed % 3 !== 0)) ? author : chars[seed % chars.length];
  const mainTrait = traitOf(main);
  const memHint = sharedMemoryHint(seed);

  const mainLines = [
    `在公開版面看到「${echo}」，還是想留個言。`,
    `${mainTrait ? `以我這種${mainTrait}的人來說,` : ''}這篇我得回:${echo},同意一半。`,
    `${memHint ? `這讓我想到之前大家都知道的那件事——${memHint}。` : `${echo}……你就這樣直接發出來喔。`}`,
    `路過。看到「${echo}」，按了讚再走。`,
    `${main.avatarEmoji || ''} 已閱。${echo}這種話放在這裡，大家可都看見了。`.trim(),
  ];

  const replies = [{
    characterId: main.id,
    content: pick(mainLines, seed),
    delay: 800 + (seed % 500),
  }];

  // 0~2 位補充；不強迫每個角色出現。
  const others = chars.filter((c) => c.id !== main.id);
  const extraCount = Math.min(others.length, [0, 1, 0, 2, 1][(seed >> 2) % 5]);

  for (let i = 0; i < extraCount; i += 1) {
    const c = others[(seed + i * 7) % others.length];
    if (replies.some((r) => r.characterId === c.id)) continue;
    const extraLines = [
      `${main.name}都留言了，那我也冒個泡。`,
      `${c.avatarEmoji || '…'}`,
      `+1,「${echo}」這句我先截圖了。`,
      `在公開版面就先不多說，懂的都懂。`,
      `${traitOf(c) ? `身為${traitOf(c)}的人,` : ''}我只說一句：看到了。`,
    ];
    replies.push({
      characterId: c.id,
      content: pick(extraLines, seed + i * 37),
      delay: 1600 + i * 900 + (seed % 400),
    });
  }
  return replies.slice(0, 3);
}

/** 擲骰決定內容長度檔位，回傳塞進 prompt 的指令。kind: post | comment | diary */
export function rollLengthDirective(kind = 'post', rng = Math.random) {
  const roll = rng();
  if (kind === 'comment') {
    if (roll < 0.35) return '這次的留言要非常短：幾個字到一句話，像「+1」「笑死」「哪間？」這種隨手回的等級。';
    if (roll < 0.85) return '這次的留言保持普通長度：一到兩句就好。';
    return '這次的留言可以稍微長一點：兩到四句，有點內容。';
  }
  if (kind === 'diary') {
    if (roll < 0.25) return '今天只想寫一句話：一行以內，點到為止。';
    if (roll < 0.80) return '今天寫個短篇：三到六句，想到什麼寫什麼。';
    return '今天想多寫一點：一小段完整的心情，但不超過 300 字。';
  }
  // post
  if (roll < 0.20) return '這篇是隨手發的廢文：一到兩句(10~40 字),可以沒有重點，像「熱死」「想吃冰」這種等級。';
  if (roll < 0.80) return '這篇是普通日常文：兩到三句，輕鬆自然。';
  return '這篇可以認真寫：一小段有起承轉合的內容，但不要超過 200 字。';
}

/* ---------------- 真實 AI 角色留言 ---------------- */

/**
 * 社群 prompt:公開空間，只含公開資訊——
 * 所有角色的公開設定、共享記憶、世界書、貼文與留言本身。
 * 絕不含任何角色的 DM 私密記憶或場景記憶。
 */
export function buildSocialPrompt({ post, triggerText, replyToName = null, replyToCommentId = null, banter = false, rng = Math.random }) {
  const state = getState();
  const circle = circleOfPost(post, getCharacter);
  // 方案一：只有「認識這個人設」的角色會出面
  const chars = state.characters.filter((c) => (c.knownPersonaId || state.defaultPersonaId) === circle && !c.noPhone && !c.socialMute);
  const persona = getPersona(circle) || defaultPersona();
  const cap = state.apiConfig?.maxReplyChars?.group ?? 1200;

  const profiles = chars.map((c) => [
    `- ${c.name}:${c.description || '(無描述)'}`,
    `  個性:${c.personality || '(未提供)'}`,
    c.emojiStyle?.trim() ? `  Emoji 習慣:${c.emojiStyle.trim()}` : '',
    c.scenario ? `  情境:${c.scenario}` : '',
  ].filter(Boolean).join('\n')).join('\n');

  // v83(h1):各自對玩家的關係階段——擁有者核准的軟性注入(留言語氣不再像陌生人)。
  // 注意這是多角色共用 prompt:階段彼此可見(旁人「感覺得出氛圍」是自然的),
  // 但框語壓住輸出:不明講、不朗讀。祕密級內容不該寫在階段欄。
  const stageLines = chars.map((c) => {
    const r = state.rooms.find((rr) => rr.type === 'dm' && !rr.branchedFrom && rr.participantIds.includes(c.id));
    const st = r?.relationshipStage?.trim();
    return st ? `- ${c.name}:${st}` : '';
  }).filter(Boolean);

  const shared = sharedMemoriesFor(circle)
    .map((m) => `- ${m.content}`).join('\n') || '(無)';

  // v79(c案):長樓接話斷片修——舊版只帶「尾端 8 則」,40+ 則的長樓角色看不到前面 32 則。
  // 有指名回覆時改帶「被回覆那一樓的完整串(超長截尾 20 則、每則截 80 字)+其他最新 4 則」;
  // 沒指名(頂層留言/banter)維持尾端 8 則。
  const fmtCm = (cm) => {
    const who = cm.authorId === 'player' ? (getPersona(cm.personaId)?.name || '玩家') : (getCharacter(cm.authorId)?.name || '?');
    const target = cm.replyTo?.name ? `(回覆 ${cm.replyTo.name})` : '';
    const body = cm.content.length > 80 ? `${cm.content.slice(0, 80)}…` : cm.content;
    return `${who}${target}:${body}`;
  };
  const allCm = getComments(post.id);
  let commentSection;
  const thread = replyToCommentId ? threadOf(post.id, replyToCommentId) : [];
  if (thread.length) {
    const cut = thread.slice(-20);
    const inThread = new Set(cut.map((c) => c.id));
    const others = allCm.filter((c) => !inThread.has(c.id)).slice(-4);
    commentSection = `【這一樓的完整對話串(剛剛的留言屬於這串)】\n${cut.map(fmtCm).join('\n')}`
      + (others.length ? `\n\n【貼文下其他最新留言】\n${others.map(fmtCm).join('\n')}` : '');
  } else {
    commentSection = `【既有留言】\n${allCm.slice(-8).map(fmtCm).join('\n') || '(尚無留言)'}`;
  }

  const recentText = `${post.content}\n${triggerText}`;
  const seen = new Set(); const lore = [];
  for (const c of chars) {
    for (const e of matchEntries({ characterId: c.id, recentText, presentNames: [c.name] })) {
      if (!seen.has(e.id)) { seen.add(e.id); lore.push(e); }
    }
  }
  const loreText = lore.length
    ? lore.map((e) => `- (${e.bookName}/${e.title}) ${e.content}`).join('\n')
    : '(無)';

  const authorName = post.authorId === 'player'
    ? (getPersona(post.personaId)?.name || '玩家')
    : (getCharacter(post.authorId)?.name || '?');

  const system = [
    ...globalPromptSection(),
    '你要扮演一個公開社群動態底下留言的多位角色。這是公開版面，角色只知道公開資訊。',
    `【角色公開資料】\n${profiles}`,
    ...(stageLines.length ? [`【各自對「${persona?.name || '這個人'}」目前的關係階段(各自心裡的立場;會影響各自留言的語氣與距離感,但不要明講階段、不要朗讀這一欄)】\n${stageLines.join('\n')}`] : []),
    `【玩家(這個圈子認識的)】${persona?.name || '(未命名玩家)'}:${persona?.description || '(未提供)'}`,
    `【共享記憶(公開)】\n${shared}`,
    `【世界書】\n${loreText}`,
    `【貼文】${authorName}:${post.content}`,
    commentSection,
    ...(replyToName ? [`【剛剛的留言是指名回覆「${replyToName}」的：他應該優先出面回應；其他角色可補充也可以不出聲。`] : []),
    ...(banter ? ['【互聊指令】這次不是回覆誰:是你們這群人自己在這篇貼文底下留言互動起來——可以互虧、接話、嗆發文的人、歪樓。'
      + '依成員的年齡與熟度說話;若是台灣年輕人,用真實打字習慣:句短口語、語助詞和輕度髒話自然出現(幹、靠、笑死、==、好了啦),'
      + '嗆人不用鋪陳,同一人可連發多則(輸出多個同名物件)。'] : []),
    `【現在時間】現在是 ${fmtMsgTime(Date.now())}。`,
    '【輸出格式】只輸出 JSON 陣列，不要其他文字:[{"name":"角色名","content":"留言"}]。'
      + (banter ? '2 到 4 則；' : `0 到 3 則；像真實社群一樣，不必每個角色都留言，可以只有一人回或沒人回;`)
      + `留言是社群口吻，單則不超過 ${cap} 字，不要加名字前綴。`
      + `每位角色的留言長度各自不同：有人只回幾個字，有人寫一兩句，不要每個人都寫一樣長。${rollLengthDirective('comment', rng)}`,
  ].join('\n\n');

  // 注意:messages 不可為空(Gemini 會回 400 contents is not specified)
  const trigger = banter
    ? '(這篇貼文掛在版上一陣子了，你們之中有人想留言互動。)'
    : triggerText === post.content
      ? `我剛發布了這篇貼文:${post.content}`
      : `我剛在這篇貼文底下留言:${triggerText}`;

  return {
    system,
    messages: [{ role: 'user', content: trigger, ...(post.image ? { image: post.image } : {}) }],
    meta: { maxReplyChars: cap, roomType: 'social' },
  };
}

/**
 * 產生角色留言：開啟真實 AI 時走單次 API 呼叫，否則走既有 mock。
 * 回傳 {ok, replies:[{characterId, content, delay}]} 或 {ok:false, message}。
 */
export async function generateSocialReplies({ post, triggerText, triggerPersonaId = null, replyToName = null, replyToCommentId = null, banter = false }) {
  const state = getState();
  const circle = circleOfPost(post, getCharacter);
  const circleChars = state.characters.filter((c) => (c.knownPersonaId || state.defaultPersonaId) === circle && !c.noPhone && !c.socialMute);

  // 方案一：留言的人設若不屬於這個圈子，圈內角色不認識他，選擇無視
  const trigger = triggerPersonaId || state.activePersonaId || state.defaultPersonaId;
  if (!circleChars.length || (!banter && trigger && trigger !== circle)) {
    return { ok: true, replies: [] };
  }

  const cfg = getApiConfig();
  if (!(cfg.useRealApi && cfg.apiKey && cfg.model)) {
    let mock = generateMockSocialReplies({ post, triggerText: triggerText || post.content })
      .filter((m) => circleChars.some((c) => c.id === m.characterId));
    const named = replyToName ? circleChars.find((c) => c.name === replyToName) : null;
    if (named) {
      const idx = mock.findIndex((m) => m.characterId === named.id);
      if (idx > 0) {
        const [hit] = mock.splice(idx, 1);
        mock.unshift(hit);
      } else if (idx === -1) {
        mock = [{ characterId: named.id, content: `你點我？「${triggerText.slice(0, 12)}」……收到。`, delay: 700 }, ...mock].slice(0, 3);
      }
    }
    return { ok: true, replies: mock };
  }
  // v83(h4):玩家指名回覆「某角色的留言」→ 單人呼叫(DM 等級認知);
  // 失敗或空回覆 → 落回原本的群呼叫,不白費這次互動。banter 不走單人。
  const tier = { tier: getState().settings.secondaryForSocialDiary ? 'secondary' : 'primary' };
  if (replyToCommentId && !banter) {
    const target = getComments(post.id).find((c2) => c2.id === replyToCommentId);
    const soloChar = target && target.authorId !== 'player'
      ? circleChars.find((c2) => c2.id === target.authorId) : null;
    if (soloChar) {
      const rs = await generateReply(cfg, buildSoloSocialReplyPrompt({ post, character: soloChar, triggerText, replyToCommentId }), tier);
      if (rs.ok) {
        const content = stripNamePrefix(rs.text, [soloChar.name]).trim();
        if (content) return { ok: true, replies: [{ characterId: soloChar.id, content, delay: 800 }] };
      } else if (rs.blocked) {
        return { ok: false, message: rs.message }; // 安全攔截給真實原因,不落回(群呼叫也會被咬)
      }
    }
  }
  const r = await generateReply(cfg, buildSocialPrompt({ post, triggerText, replyToName, replyToCommentId, banter }), tier);
  if (!r.ok) return { ok: false, message: r.message };
  const replies = parseGroupReplies(r.text, circleChars)
    .map((p, i) => ({ ...p, delay: 800 + i * 900 }));
  return { ok: true, replies };
}

/* ---------------- 角色自主發文(刷新觸發) ---------------- */

import { getRoomMessages } from './state.js';

/** 冷卻檢查：回傳剩餘秒數(0 = 可以刷新)。 */
export function refreshCooldownLeft() {
  const state = getState();
  const cooldownMs = (state.settings.autoPostCooldownMin ?? 10) * 60000;
  return Math.max(0, Math.ceil((state.socialLastRefresh + cooldownMs - Date.now()) / 1000));
}

/** 找到角色自己的 DM room id。 */
function dmRoomIdOf(characterId) {
  const state = getState();
  const room = state.rooms.find((r) => r.type === 'dm' && r.participantIds.includes(characterId));
  return room ? room.id : null;
}

/**
 * 單一角色的自主發文 prompt(方案 B):
 * 除公開資訊外，「只」加入這位角色自己與玩家的 DM 最近幾句——
 * 一次呼叫只為一位角色發文，絕不把其他角色的私訊混進來。
 */
/**
 * v83(h4):指名回覆的「單人呼叫」prompt——玩家回覆某角色的留言時,只為他一人生成,
 * 帶 DM 等級的認知(本人私密記憶/關係階段/最近私訊心情),其他角色零讀取。
 * 「他回你留言終於像你們的關係,而別人依然什麼都不知道。」
 * 繼承 DM 主線房的 globalPromptSection(成人框架/稱謂說明等模組全跟上)。
 */
export function buildSoloSocialReplyPrompt({ post, character, triggerText, replyToCommentId = null }) {
  const state = getState();
  const persona = getPersona(character.knownPersonaId) || defaultPersona();
  const dmId = dmRoomIdOf(character.id);
  const dmRoom = dmId ? state.rooms.find((r) => r.id === dmId) : null;
  const privates = (state.memories.byCharacterId?.[character.id] || []).slice(0, 12)
    .map((m) => `- ${m.content}`).join('\n');
  const shared = sharedMemoriesFor(character.knownPersonaId || state.defaultPersonaId)
    .map((m) => `- ${m.content}`).join('\n') || '(無)';
  const dmLines = dmId
    ? getRoomMessages(dmId).slice(-6)
      .map((m) => `${m.role === 'user' ? (persona?.name || '玩家') : character.name}:${String(m.content).slice(0, 60)}`)
      .join('\n')
    : '';
  const fmtCm = (cm) => {
    const who = cm.authorId === 'player' ? (getPersona(cm.personaId)?.name || '玩家') : (getCharacter(cm.authorId)?.name || '?');
    const target = cm.replyTo?.name ? `(回覆 ${cm.replyTo.name})` : '';
    return `${who}${target}:${String(cm.content).slice(0, 80)}`;
  };
  const thread = replyToCommentId ? threadOf(post.id, replyToCommentId).slice(-20) : getComments(post.id).slice(-8);
  const authorName = post.authorId === 'player' ? (getPersona(post.personaId)?.name || '玩家') : (getCharacter(post.authorId)?.name || '?');
  const lore = matchEntries({ characterId: character.id, recentText: `${triggerText}\n${dmLines}`, presentNames: [character.name] });

  const system = [
    ...globalPromptSection(dmId), // 繼承 DM 房的全域指令+模組覆寫
    `你是「${character.name}」。玩家「${persona?.name || '(未命名)'}」剛在公開社群的貼文下回覆了你的留言,你要回覆他。`,
    `【你的公開資料】${character.description || '(無)'};個性:${character.personality || '(未提供)'}${character.emojiStyle?.trim() ? `;Emoji 習慣:${character.emojiStyle.trim()}` : ''}`,
    ...(privates ? [`【你的私密記憶(只有你自己知道)】\n${privates}`] : []),
    `【共享記憶(公開)】\n${shared}`,
    ...(dmRoom?.relationshipStage?.trim() ? [`【你們目前的關係階段】${dmRoom.relationshipStage.trim()}(背景理解,不要複述)`] : []),
    ...(dmLines ? [`【你們最近的私訊(只有你自己知道,別人看不到)】\n${dmLines}`] : []),
    ...(lore.length ? [`【世界書】\n${lore.map((e) => `- ${e.content}`).join('\n')}`] : []),
    `【貼文】${authorName}:${post.content}`,
    `【這一樓的對話串】\n${thread.map(fmtCm).join('\n') || '(無)'}`,
    '【輸出】只輸出一則留言內容本身(不要名字前綴、不要 JSON、不要引號包裹)。'
      + '語氣要有你們真實關係的溫度與距離感——這不是對陌生人說話。'
      + '但這是公開版面,其他人都看得到:涉及兩人私事要像真人一樣含蓄,不點破、不貼私訊原文、不寫明私密細節。'
      + '長度像真實留言,一兩句即可。',
  ].join('\n\n');

  return {
    system,
    messages: [{ role: 'user', content: triggerText || '(玩家回覆了你的留言)' }],
    meta: { maxReplyChars: 300, mode: 'social-solo', roomId: dmId },
  };
}

export function buildAutoPostPrompt(character, rng = Math.random) {
  const state = getState();
  const shared = sharedMemoriesFor(character.knownPersonaId || state.defaultPersonaId).map((m) => `- ${m.content}`).join('\n') || '(無)';
  // v94.4:近況貼文補圈子過濾——舊版 getPosts().slice(0,5) 拿全站最新五篇,
  // A 世界的貼文原文餵進 B 世界角色的發文素材(還混進世界書觸發文字,雙重污染;
  // 擁有者實案:「不同世界觀的發文感覺互相污染」)。過濾語意與 recentFeedText 完全一致:
  // 貼文圈=personaId>作者的 knownPersonaId;無圈(null)=全圈可見。
  const myCircle = character.knownPersonaId || state.defaultPersonaId;
  const circleOfP = (p) => p.personaId
    || (p.authorId !== 'player' ? (getCharacter(p.authorId)?.knownPersonaId || state.defaultPersonaId) : null);
  const recentPosts = getPosts()
    .filter((p) => { const cir = circleOfP(p); return !cir || cir === myCircle; })
    .slice(0, 5)
    .map((p) => `- ${p.authorId === 'player' ? (getPersona(p.personaId)?.name || '玩家') : (getCharacter(p.authorId)?.name || '?')}:${p.content.slice(0, 40)}`)
    .join('\n') || '(無)';

  const knownPersona = getPersona(character.knownPersonaId) || defaultPersona();
  const dmId = dmRoomIdOf(character.id);
  const dmLines = dmId
    ? getRoomMessages(dmId).slice(-6)
      .map((m) => `${m.role === 'user' ? (knownPersona?.name || '玩家') : character.name}:${m.content}`)
      .join('\n')
    : '';

  const recentText = `${dmLines}\n${recentPosts}`;
  const lore = matchEntries({ characterId: character.id, recentText, presentNames: [character.name] });
  const loreText = lore.length
    ? lore.map((e) => `- (${e.bookName}/${e.title}) ${e.content}`).join('\n')
    : '(無)';

  const cap = state.apiConfig?.maxReplyChars?.group ?? 1200;
  const system = [
    ...globalPromptSection(),
    `你是「${character.name}」，正要在公開社群發一篇貼文。`,
    `【你的公開資料】${character.description || '(無)'};個性:${character.personality || '(未提供)'}${character.scenario ? `;情境:${character.scenario}` : ''}${character.emojiStyle?.trim() ? `;Emoji 習慣:${character.emojiStyle.trim()}` : ''}`,
    `【共享記憶(公開)】\n${shared}`,
    ...(() => { // v83(h2):發文是單人呼叫,帶「本人自己的」私密記憶——發文終於有你們的影子
      const privates = (state.memories.byCharacterId?.[character.id] || []).slice(0, 12)
        .map((m) => `- ${m.content}`).join('\n');
      return privates ? [`【你的私密記憶(只有你自己知道)】\n${privates}\n發文可以被這些事觸動,但這是公開版面——像真人一樣含蓄:不點名、不寫明細節、不把私事攤開。`] : [];
    })(),
    `【世界書】\n${loreText}`,
    `【最近的社群動態】\n${recentPosts}`,
    ...(() => {
      const own = state.posts.filter((po) => po.authorId === character.id)
        .slice(0, 4).map((po) => `- ${String(po.content).slice(0, 60)}`).join('\n'); // posts 新在前
      return own ? [`【你自己最近發過的貼文(以下的話題、物件、句式這次都不要再用)】\n${own}\n`
        + '這次換一個完全不同的生活切面：別的食物、路上看到的東西、天氣、工作、無聊的觀察、突然想起的回憶……開頭句式也要不一樣。'] : [];
    })(),
    dmLines
      ? `【你和玩家最近的私訊(只有你自己知道，別人看不到)】\n${dmLines}\n`
        + '貼文可以受這些對話的心情或話題啟發，但這是公開版面——像真人一樣含蓄，不要把私訊內容原文貼出來或全盤托出。'
      : '',
    `【現在時間】現在是 ${fmtMsgTime(Date.now())}。`,
    `【輸出】只輸出貼文內容本身，口吻像真人發社群動態，不要加名字前綴、不要 JSON、不要引號包裹。${rollLengthDirective('post', rng)}`,
  ].filter(Boolean).join('\n\n');

  return {
    system,
    messages: [{ role: 'user', content: '(你打開了社群，想發點什麼)' }],
    meta: { maxReplyChars: Math.min(400, cap), roomType: 'social-auto' },
  };
}

/**
 * 刷新動態:0~2 位角色各發一篇(每位一次呼叫，保持私訊隔離)。
 * 有冷卻節流;mock 模式下也能用(走既有 seed 貼文句庫)。
 * @param {{force?:boolean, rng?:()=>number}} [opts] force 跳過冷卻(測試用)
 * @returns {{ok:boolean, posted:number, message?:string}}
 */
export async function refreshFeed(opts = {}) {
  const state = getState();
  const rng = opts.rng || Math.random;
  if (!opts.force) {
    const left = refreshCooldownLeft();
    if (left > 0) return { ok: false, posted: 0, message: `再等 ${Math.ceil(left / 60)} 分鐘可以再刷新` };
  }
  state.socialLastRefresh = Date.now();
  await persist();

  const PER_CHAR_POST_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 單角色發文冷卻:3 小時內發過的不再發
  const lastPostAt = {};
  for (const post of state.posts) {
    if (post.authorId !== 'player') {
      lastPostAt[post.authorId] = Math.max(lastPostAt[post.authorId] || 0, post.createdAt || 0);
    }
  }
  const chars = state.characters.filter((c) => !c.noPhone
    && (Date.now() - (lastPostAt[c.id] || 0)) > PER_CHAR_POST_COOLDOWN_MS);
  if (!chars.length) return { ok: true, posted: 0 };

  // 0~2 位:25% 沒人發、50% 一位、25% 兩位(受角色數限制)
  const roll = rng();
  const count = Math.min(chars.length, roll < 0.25 ? 0 : roll < 0.75 ? 1 : 2);
  if (!count) return { ok: true, posted: 0 };

  // 隨機挑不重複角色
  const pool = [...chars];
  const pickedChars = [];
  for (let i = 0; i < count; i += 1) {
    pickedChars.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }

  const cfg = getApiConfig();
  let posted = 0;
  for (const c of pickedChars) {
    if (cfg.useRealApi && cfg.apiKey && cfg.model) {
      const r = await generateReply(cfg, buildAutoPostPrompt(c, rng),
        { tier: getState().settings.secondaryForSocialDiary ? 'secondary' : 'primary' });
      if (!r.ok) return { ok: false, posted, message: r.message };
      const content = stripNamePrefix(r.text, [c.name]);
      if (content) { await createPost(c.id, content); posted += 1; }
    } else {
      // mock:重用 seed 句庫，加上時間變化
      const seed = hashStr(c.id) + Math.floor(Date.now() / 60000);
      const lines = [
        `${sceneOf(c) ? `${sceneOf(c)}。` : ''}突然想發個動態。`,
        `${traitOf(c) ? `${traitOf(c)}的人` : '我'}也是會想曬一下日常的。`,
        `今天沒什麼事，就是想冒個泡。${c.avatarEmoji || ''}`.trim(),
        `路過自己的版面，留一句。`,
      ];
      await createPost(c.id, pick(lines, seed));
      posted += 1;
    }
  }
  return { ok: true, posted };
}
