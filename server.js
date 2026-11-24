// AI 酒館 — 本機伺服器（只使用 Node 內建模組；Claude 供應商需要 @anthropic-ai/sdk）
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/storage');
const png = require('./lib/png');
const { normalizeCard, normalizeBook, toV2, toV3, cardOpenings, isPlainOpening } = require('./lib/cards');
const { buildPrompt, buildWorldPrompt, substitute, estimateTokens, memoryCutIndex, npcLabel, LANGUAGES, languageNote } = require('./lib/prompt');
const { streamChat, listModels } = require('./lib/providers');
const { NARRATOR, DIRECTOR_MAX_TOKENS, DIRECTOR_TEMPERATURE, cleanSpeakerText, playRound, restorePresent } = require('./lib/turns');
const backup = require('./lib/backup');
const { stripThink, timeStamp } = require('./lib/util');
const WINDOW_FILE = process.env.TAVERN_WINDOW_FILE ? path.resolve(process.env.TAVERN_WINDOW_FILE) : path.join(__dirname, 'data', 'window.json');

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '127.0.0.1'; // 預設只允許本機連線
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 30 * 1024 * 1024;

/**
 * 網頁的內容安全政策（第二道防線）：就算角色卡或 AI 回覆裡的 HTML 有漏網的寫法，
 * 也只能執行酒館自己的程式檔（不能執行內嵌腳本），也只能連線到酒館自己的伺服器，金鑰不會被送到別處
 */
const CSP = [
  "default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'none'", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:",
  "img-src 'self' data: blob: https: http:", "media-src 'self' data: blob: https:",
].join('; ');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

// ---------- 小工具 ----------
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooBig = false;
    req.on('data', c => {
      size += c.length;
      if (size <= max) return chunks.push(c);
      // 太大：先回 413「檔案太大」，剩下的內容讀掉丟棄（直接切斷連線的話，瀏覽器收不到回應，只會看到「Failed to fetch」）
      if (!tooBig) { tooBig = true; chunks.length = 0; reject(Object.assign(new Error(`檔案太大（上限 ${Math.round(max / 1048576)} MB）`), { status: 413 })); }
      if (size > max * 4) req.destroy(); // 大得離譜：不再讀下去
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('JSON 格式錯誤'), { status: 400 }); }
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendFile(res, file, extraHeaders = {}) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const stream = fs.createReadStream(file);
  // 讀檔失敗（檔案剛好被刪掉、被防毒軟體鎖住…）：回傳錯誤，不能讓伺服器當掉
  stream.on('error', err => {
    if (!res.headersSent) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); res.end(); }
    else res.destroy();
  });
  stream.once('open', () => {
    // 圖片網址帶著版本號（?v=修改時間）：內容一改網址就跟著變，所以可以長期快取，不用每次開程式都重新下載；
    // 其他檔案（程式、沒有版本號的）每次都向伺服器確認
    const reqUrl = res.req?.url || '';
    const versioned = reqUrl.startsWith('/api/') && /[?&]v=\d*[1-9]/.test(reqUrl);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': versioned ? 'private, max-age=31536000, immutable' : 'no-cache', ...extraHeaders });
    stream.pipe(res);
  });
  res.once('close', () => stream.destroy()); // 瀏覽器中途斷線：關掉檔案
}
function decodeDataUrl(s) {
  if (!s) return null;
  const m = /^data:[^;]+;base64,(.*)$/s.exec(s);
  const buf = Buffer.from(m ? m[1] : s, 'base64');
  if (!png.isPng(buf)) throw Object.assign(new Error('圖片必須是 PNG'), { status: 400 });
  return buf;
}


/**
 * 對話的擁有者：一般角色（key = 角色 ID），或大世界（key = world-<世界 ID>）。
 * 大世界在這裡才去讀取成員的角色卡，世界卡本身只存角色 ID。
 */
function resolveOwner(key) {
  const settings = store.getSettings();
  // 這段對話停用的世界書（對話設定）；applyChatSettings 填入，組提示詞時略過
  const booksOff = new Set();
  const usable = books => books.filter(b => !booksOff.has(b._key));
  if (typeof key === 'string' && key.startsWith(store.WORLD_PREFIX)) {
    const w = store.getBigWorld(key.slice(store.WORLD_PREFIX.length));
    const members = w.members.filter(m => !m.missing).map(m => {
      try { const ch = store.getCharacter(m.id); return { ...m, ch, card: ch.data }; } catch { return null; }
    }).filter(Boolean);
    // 世界書：全域＋世界專屬（連結的與內嵌的）＋成員角色卡帶來的（依世界卡上的開關）
    // _key：對話設定用來指定停用哪一本（world＝世界專屬、w:<id>＝世界書檔案、emb:<角色 id>＝角色卡內嵌）
    const worldBooks = (chosen) => {
      const books = [];
      if (w.character_book && (w.character_book.entries || []).length) books.push({ name: w.name + '（世界專屬）', ...w.character_book, _key: 'world' });
      const ids = new Set([...(settings.world_ids || []), ...(w.world_ids || [])]);
      for (const id of ids) { try { books.push({ ...store.getWorld(id), _key: 'w:' + id }); } catch { /* 已刪除 */ } }
      // 成員角色卡帶來的世界書：整本可以關，每個條目也可以個別關
      for (const m of chosen) {
        const off = new Set(m.book_off || []);
        const book = m.ch.data.character_book;
        if (m.book_embedded !== false && book) {
          const entries = (book.entries || []).filter(e => !off.has('emb:' + e.id));
          if (entries.length) books.push({ name: m.ch.data.name + '（內嵌）', ...book, entries, _key: 'emb:' + m.id });
        }
        if (m.book_linked !== false && m.ch.world_id && !ids.has(m.ch.world_id)) {
          try {
            const wb = store.getWorld(m.ch.world_id);
            const entries = (wb.entries || []).filter(e => !off.has('lnk:' + e.id));
            if (entries.length) books.push({ ...wb, entries, _key: 'w:' + m.ch.world_id });
          } catch { /* 已刪除 */ }
        }
      }
      return books;
    };
    const books = worldBooks(members);
    const speakerName = id => id === 'narrator' || !id ? '旁白' : members.find(m => m.id === id)?.card.name || '（已離開的角色）';
    return {
      kind: 'world', name: w.name, settings, world: w, members, speakerName,
      // 除了自己以外的所有發言者名稱（用來截掉模型替別人寫的台詞）
      otherNames: id => [...members.filter(m => m.id !== id).map(m => m.card.name), settings.user_name, id === 'narrator' ? '' : '旁白', ...(settings.chat_npcs || [])],
      greetings: [],
      // 開場白：一串訊息，各自有發言者（旁白、玩家或成員角色；已移出世界的角色略過）
      opening: (w.opening || []).filter(o => ['narrator', 'user'].includes(o.speaker) || members.some(m => m.id === o.speaker)),
      ctx: { char: w.name, user: settings.user_name },
      booksOff, allBooks: () => books,
      build: (history, memory, turn) => {
        // 輪到某個角色時，只用全域、世界專屬與他自己的世界書（別人的角色世界書屬於別人的知識）
        const self = turn && turn.speaker && turn.speaker !== 'narrator' ? members.find(m => m.id === turn.speaker) : null;
        return buildWorldPrompt({ world: w, members, history, settings, books: usable(self ? worldBooks([self]) : books), memory, turn, speakerName });
      },
    };
  }
  const ch = store.getCharacter(key);
  return {
    kind: 'char', name: ch.data.name, settings,
    greetings: [ch.data.first_mes, ...(ch.data.alternate_greetings || [])].filter(Boolean),
    openings: cardOpenings(ch.data), // 每個開場白可以是一串訊息（角色、旁白、你）
    ctx: { char: ch.data.name, user: settings.user_name },
    booksOff, allBooks: () => booksFor([ch], settings),
    build: (history, memory) => buildPrompt({ card: ch.data, history, settings, books: usable(booksFor([ch], settings)), memory }),
  };
}

/**
 * 角色卡／世界目前的開場白（新對話、清空聊天時用）。greetingIndex：角色有好幾個開場白時選第幾個
 * 世界：開場白的每一則各自成為一則訊息；角色：一則訊息，主要與備用開場白放在版本（swipes）裡。
 * 角色的開場白有旁白或你的台詞（一串訊息）時：選到的那個開場白每一則各自成為一則訊息（沒有版本可以切換），
 * 第一則記下選的是第幾個（greeting_idx：清空聊天、換名字時用）
 */
function openingMessages(owner, greetingIndex = 0) {
  const messages = [];
  const fill = g => substitute(g.replace(/\{\{world\}\}/gi, () => owner.name || ''), owner.ctx); // 用函式：名稱裡的 $ 照原樣
  const blocks = owner.openings || [];
  if (blocks.length && !blocks.every(isPlainOpening)) {
    const idx = Math.min(Math.max(0, greetingIndex | 0), blocks.length - 1);
    for (const o of blocks[idx]) {
      const content = fill(o.content);
      messages.push(o.speaker === 'user'
        ? { role: 'user', content, time: Date.now(), greeting: true }
        : { role: 'assistant', content, swipes: [content], swipe_id: 0, time: Date.now(), greeting: true, ...(o.speaker === 'narrator' ? { speaker: 'narrator' } : {}) });
    }
    if (messages.length) messages[0].greeting_idx = idx;
  } else if (owner.opening) {
    for (const o of owner.opening) {
      const content = fill(o.content);
      messages.push(o.speaker === 'user'
        ? { role: 'user', content, time: Date.now(), greeting: true }
        : { role: 'assistant', content, swipes: [content], swipe_id: 0, time: Date.now(), speaker: o.speaker, greeting: true });
    }
  } else if (owner.greetings.length) {
    const swipes = owner.greetings.map(fill);
    const idx = Math.min(Math.max(0, greetingIndex | 0), swipes.length - 1);
    messages.push({ role: 'assistant', content: swipes[idx], swipes, swipe_id: idx, time: Date.now(), greeting: true });
  }
  return messages;
}
/** 這段對話用的是第幾個開場白（多則訊息的開場白記在 greeting_idx；一般的開場白是目前顯示的版本） */
const greetingIndexOf = msgs => (msgs[0]?.greeting ? msgs[0].greeting_idx ?? msgs[0].swipe_id ?? 0 : 0);
// ---------- 更換這段對話的你（名字） ----------
/**
 * 開場白依原始模板重新套用名字：開場白沒被改過（內容等於「模板＋舊名字」）才換，
 * 只有模板裡 {{user}} 的位置會變，「你真可愛」這類描述不會被誤改。回傳 { 訊息位置: 新的訊息 }
 */
function greetingRenames(ownerKey, chat, from, to) {
  const owner = resolveOwner(ownerKey);
  const withUser = u => ({ ...owner, ctx: { ...owner.ctx, user: u } });
  const prevIdx = greetingIndexOf(chat.messages);
  const oldOpen = openingMessages(withUser(from), prevIdx), newOpen = openingMessages(withUser(to), prevIdx);
  const out = {};
  chat.messages.forEach((m, i) => {
    if (!m.greeting || !oldOpen[i] || oldOpen[i].role !== m.role) return;
    if (Array.isArray(m.swipes) && Array.isArray(oldOpen[i].swipes)) {
      // 角色卡的開場白：每個版本各自比對（被改過的版本不動）
      const swipes = m.swipes.map((s, k) => (s === oldOpen[i].swipes[k] ? newOpen[i].swipes[k] : s));
      const content = swipes[m.swipe_id || 0] ?? m.content;
      if (swipes.some((s, k) => s !== m.swipes[k])) out[i] = { ...m, swipes, content };
    } else if (m.content === oldOpen[i].content && newOpen[i].content !== m.content) out[i] = { ...m, content: newOpen[i].content };
  });
  return out;
}
/** 文字裡每一處舊名字的位置與前後文 */
function findName(text, from, ctxLen = 16) {
  const out = [];
  if (!from || typeof text !== 'string') return out;
  for (let at = text.indexOf(from); at >= 0; at = text.indexOf(from, at + from.length))
    out.push({ at, before: text.slice(Math.max(0, at - ctxLen), at), after: text.slice(at + from.length, at + from.length + ctxLen) });
  return out;
}
/**
 * 更換名字的預覽：開場白自動處理幾則；記憶與「目前會送給 AI 的聊天紀錄」裡每一處舊名字（給使用者勾選）；
 * 更早的訊息（目前不會送給 AI）裡還有幾處（不改，只告訴使用者）
 */
function renameScan(ownerKey, chat, from, to) {
  const owner = resolveOwner(ownerKey);
  applyChatSettings(owner, chat);
  const greet = greetingRenames(ownerKey, chat, from, to);
  // 目前送給 AI 的範圍：壓縮切點之後、而且沒有因為上下文長度被裁掉的
  const turns = owner.kind === 'world' && (chat.turn_mode || owner.world.turn_mode) === 'turns' && owner.members.length;
  const cut = memoryCutIndex(chat, owner.settings);
  const built = owner.build(historyFor(chat, owner.settings), chat.memory, turns ? { speaker: owner.members[0].id } : null);
  const start = cut + (built.info.history_from || 0);
  const items = [];
  let older = 0;
  chat.messages.forEach((m, i) => {
    if (greet[i]) return; // 開場白已經自動處理
    const hits = findName(m.content, from);
    if (i < start) { older += hits.length; return; }
    for (const h of hits) items.push({ i, ...h });
  });
  for (const h of findName(chat.memory, from)) items.push({ i: -1, ...h }); // i = -1：記憶
  return { greetings: Object.keys(greet).length, items, older, start };
}
/** 套用：開場白依模板換；edits = [{ i, at }]（i = -1 是記憶）只換這些位置（位置上的字確實是舊名字才換） */
function applyRename(ownerKey, chat, { from, to, edits = [] }) {
  if (!from.trim() || !to.trim() || from === to) return;
  const greet = greetingRenames(ownerKey, chat, from, to);
  for (const [i, m] of Object.entries(greet)) chat.messages[i] = m;
  const byTarget = new Map();
  for (const e of Array.isArray(edits) ? edits : []) {
    if (!Number.isInteger(e?.i) || !Number.isInteger(e?.at) || greet[e.i]) continue;
    if (!byTarget.has(e.i)) byTarget.set(e.i, new Set());
    byTarget.get(e.i).add(e.at);
  }
  const rep = (text, ats) => {
    let t = String(text);
    for (const at of [...ats].sort((a, b) => b - a)) if (t.slice(at, at + from.length) === from) t = t.slice(0, at) + to + t.slice(at + from.length);
    return t;
  };
  for (const [i, ats] of byTarget) {
    if (i === -1) { if (chat.memory) chat.memory = rep(chat.memory, ats); continue; }
    const m = chat.messages[i]; if (!m) continue;
    m.content = rep(m.content, ats);
    if (Array.isArray(m.swipes)) m.swipes[m.swipe_id || 0] = m.content; // 只改目前顯示的版本
  }
}

/**
 * 從某則訊息開分支：複製到那一則為止的訊息、對話設定（CHAT_SETTING_KEYS）與發言模式；
 * 記憶只涵蓋分支點之前的內容時才一起帶過去。名稱是「角色名稱（分支）」（從分支再開分支也不會疊成（分支）（分支））
 */
function branchChat(ownerKey, fromId, upto) {
  const owner = resolveOwner(ownerKey);
  const src = store.getChat(ownerKey, fromId);
  const n = Math.min(src.messages.length, Math.max(1, (Number.isInteger(upto) ? upto : src.messages.length - 1) + 1));
  const chat = { title: owner.name + '（分支）', messages: structuredClone(src.messages.slice(0, n)) };
  if (src.turn_mode) chat.turn_mode = src.turn_mode;
  for (const k of CHAT_SETTING_KEYS) if (src[k] !== undefined) chat[k] = structuredClone(src[k]);
  if ((src.memory_upto || 0) <= n && src.memory) {
    chat.memory = src.memory; chat.memory_upto = src.memory_upto || 0; chat.memory_cut = src.memory_cut || 0; chat.memory_updated = src.memory_updated;
  }
  return store.saveChat(ownerKey, chat);
}
function newChatFor(ownerKey, greetingIndex = 0, turnMode) {
  const owner = resolveOwner(ownerKey);
  const messages = openingMessages(owner, greetingIndex);
  // 一律以角色／世界名稱命名，同名也不加編號（對話清單用時間區分；之後可以改名）
  const chat = { title: owner.name, messages };
  // 固定這段對話的使用者設定檔：之後在設定頁切換，這段對話的名字（開場白已經寫進去了）也不會前後不一致
  const pid = store.activePersonaId();
  if (pid && store.getPersona(pid)) chat.persona_id = pid;
  if (owner.kind === 'world') chat.turn_mode = ['turns', 'narrator'].includes(turnMode) ? turnMode : owner.world.turn_mode;
  return store.saveChat(ownerKey, chat);
}

/** 世界書：全域啟用的＋各角色內嵌的＋各角色連結的（大世界會合併所有成員的） */
function booksFor(chars, settings) {
  const books = [];
  const ids = new Set(settings.world_ids || []);
  for (const ch of chars) {
    if (ch.data.character_book) books.push({ name: ch.data.name + '（內嵌）', ...ch.data.character_book, _key: 'emb:' + ch.id });
    if (ch.world_id) ids.add(ch.world_id);
  }
  for (const id of ids) { try { books.push({ ...store.getWorld(id), _key: 'w:' + id }); } catch { /* 已刪除 */ } }
  return books;
}

// ---------- 生成（SSE 串流） ----------
const jobs = new Map(); // 進行中的生成，key = 角色/對話
const jobKey = (charId, chatId) => `${charId}/${chatId}`;
function attachListener(job, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  job.listeners.add(res);
  res.on('close', () => job.listeners.delete(res)); // 只是離開頁面，不中斷生成
}
function stopJobs(pred) {
  for (const job of jobs.values()) if (pred(job)) { job.deleted = true; job.ac.abort(); }
}

/**
 * 送給 AI 的聊天紀錄：壓縮切點（memory_cut）之前的舊對話已經整理進記憶，不再送出原文；
 * limit > 0 時只取最近 limit 則（導演用）；exclude：正在生成的那一則
 */
function historyFor(chat, settings, { exclude = null, limit = 0 } = {}) {
  let list = chat.messages.slice(memoryCutIndex(chat, settings)).filter(m => m !== exclude);
  if (limit > 0) list = list.slice(-limit);
  return list.map(m => ({ role: m.role, content: stripThinkText(m.content), speaker: m.speaker, npc: m.npc, narration: m.narration }));
}
/**
 * 你這一側的一則訊息：一般（你的角色）、你扮演的 NPC（npc：名字）、或你寫的旁白（narration）。
 * 用到新的 NPC 名字時，順便加進這段對話的 NPC 名單
 */
function userMessage(chat, content, { npc, narration } = {}) {
  const m = { role: 'user', content, time: Date.now() };
  const name = cleanNpc(npc);
  if (name) {
    m.npc = name;
    if (!(chat.npcs || []).includes(name)) chat.npcs = [...(chat.npcs || []), name];
  } else if (narration) m.narration = true;
  return m;
}
/**
 * 每個版本各自的思考過程（和 swipes 一一對應）。舊訊息沒有這個欄位：原本的思考算在當時顯示的那個版本上
 */
function swipeReasoning(m) {
  const n = Array.isArray(m.swipes) ? m.swipes.length : 1;
  if (Array.isArray(m.swipe_reasoning)) return Array.from({ length: n }, (_, k) => m.swipe_reasoning[k] || '');
  return Array.from({ length: n }, (_, k) => (k === (m.swipe_id || 0) ? m.reasoning || '' : ''));
}
/**
 * 生成完成：這次的思考過程記在目前的版本上。這次沒有思考（例如換成不會思考的模型）就清掉；
 * 「繼續」時（prefix）前半段已經有思考，這次沒有就保留原本的
 */
function setReasoning(m, reasoning, prefix) {
  if (reasoning) m.reasoning = prefix && m.reasoning ? `${m.reasoning}\n${reasoning}` : reasoning;
  else if (!prefix) delete m.reasoning;
  if (Array.isArray(m.swipe_reasoning)) m.swipe_reasoning[m.swipe_id || 0] = m.reasoning || '';
}
/** 每個版本各自的回應耗時（和 swipes 一一對應）。舊訊息沒有這個欄位：原本的耗時算在當時顯示的那個版本上 */
function swipeTiming(m) {
  const n = Array.isArray(m.swipes) ? m.swipes.length : 1;
  if (Array.isArray(m.swipe_timing)) return Array.from({ length: n }, (_, k) => m.swipe_timing[k] || null);
  return Array.from({ length: n }, (_, k) => (k === (m.swipe_id || 0) ? m.timing || null : null));
}
/**
 * 回應耗時（毫秒）記在目前的版本上：first＝送出到第一個字（含思考）、total＝到回應結束、
 * director＝這一輪導演規劃花的時間、tps＝輸出速度（tokens／秒，供應商有回報輸出量時）。
 * 「繼續」時累加在原本的耗時上
 */
function setTiming(m, t, prefix) {
  if (prefix && m.timing) t = { ...m.timing, total: (m.timing.total || 0) + t.total, ...(t.tps ? { tps: t.tps } : {}) };
  m.timing = t;
  if (Array.isArray(m.swipe_timing)) m.swipe_timing[m.swipe_id || 0] = t;
}
/** 你扮演的 NPC 名稱：只留可以用的名字（太長截斷、去掉換行） */
const cleanNpc = n => (typeof n === 'string' ? n.replace(/[\r\n]+/g, ' ').trim().slice(0, 40) : '');
/** 這段對話裡你扮演的 NPC：對話設定的名單＋訊息裡用過的 */
const chatNpcs = chat => [...new Set([...(chat.npcs || []), ...chat.messages.map(m => m.npc)].map(cleanNpc).filter(Boolean))];
/**
 * 累加實際用掉的 token（供應商有回報時）。b 是一次呼叫的用量（沒有 calls，算 1 次），
 * 或是已經累計過的用量（有 calls）
 */
const sumUsage = (a, b) => ({ input: (a?.input || 0) + (b?.input || 0), output: (a?.output || 0) + (b?.output || 0), calls: (a?.calls || 0) + (b?.calls ?? 1) });

async function handleGenerate(req, res) {
  const body = await readJsonBody(req);
  const { char_id, chat_id, mode = 'normal', user_message, speaker: forced, interrupt, npc, narration } = body;
  if (jobs.has(jobKey(char_id, chat_id))) throw Object.assign(new Error('這段對話還在生成中，請等它完成或按「停止」'), { status: 409 });
  const owner = resolveOwner(char_id); // char_id 也可以是大世界的 world-<id>
  const chat = store.getChat(char_id, chat_id);
  const settings = owner.settings;
  applyChatSettings(owner, chat); // 這段對話專屬的設定（聊天紀錄上限、玩家名字與人設、停用的世界書…）
  const world = chatWorld(owner, chat);
  // 大世界的「輪流發言」模式：每段對話可以各自設定，沒設定就跟隨世界
  const turns = !!world && (chat.turn_mode || world.turn_mode) === 'turns';

  const addedNpcs = new Set(); // 這次送出時新加進名單的 NPC
  if (mode === 'normal' && user_message && user_message.trim()) {
    const before = new Set(chat.npcs || []);
    chat.messages.push(userMessage(chat, user_message, { npc, narration })); // 也可以用你扮演的 NPC、或你寫的旁白的身分
    for (const n of chat.npcs || []) if (!before.has(n)) addedNpcs.add(n);
    applyChatSettings(owner, chat); // 新的 NPC 也要放進提示詞的說明
  }

  // 生成在背景進行：瀏覽器離開這段對話（切到首頁、設定、其他對話）不會中斷，
  // 只有按「停止」或刪除對話才會中斷；回到這段對話時可以重新接上串流
  const job = { char_id, chat_id, info: null, message_index: -1, speaker: null, prefix: '', text: '', reasoning: '', listeners: new Set(), ac: new AbortController(), deleted: false };
  job.done = new Promise(r => { job.resolveDone = r; }); // 結束伺服器前要等它存完
  jobs.set(jobKey(char_id, chat_id), job);
  const emit = obj => { for (const r of job.listeners) r.write(`data: ${JSON.stringify(obj)}\n\n`); };
  try { attachListener(job, res); } catch (e) { jobs.delete(jobKey(char_id, chat_id)); throw e; }

  // 存檔：保留生成期間改過的名稱、記憶與對話設定（生成中也可以在「對話設定」修改，不能被生成蓋回舊的）
  const save = () => {
    if (job.deleted) return false;
    let fresh;
    try { fresh = store.getChat(char_id, chat_id); } catch { return false; } // 對話已被刪除
    chat.title = fresh.title;
    for (const k of MEMORY_KEYS) chat[k] = fresh[k];
    for (const k of CHAT_SETTING_KEYS) { if (k in fresh) chat[k] = fresh[k]; else delete chat[k]; }
    // 這次送出時用到的新 NPC 名字要留著（上面讀回的名單可能還沒有它）
    if (addedNpcs.size) chat.npcs = [...new Set([...(chat.npcs || []), ...addedNpcs])];
    // 用量：以檔案裡的為準（背景整理記憶也會累加），再加上這次還沒存的部分
    chat.usage = pendingUsage ? sumUsage(fresh.usage, pendingUsage) : fresh.usage;
    pendingUsage = null;
    store.saveChat(char_id, chat);
    return true;
  };
  let pendingUsage = null;
  const finalize = (target, prefix, text) => {
    target.content = prefix + text;
    if (target.swipes) target.swipes[target.swipe_id ?? 0] = target.content;
    target.time = Date.now();
    if (!target.content.trim() && !prefix) {
      // 沒產生任何內容：撤銷這次的空白訊息
      if (target.swipes && target.swipes.length > 1) { target.swipes.pop(); target.swipe_id = target.swipes.length - 1; target.content = target.swipes[target.swipe_id]; }
      else chat.messages.splice(chat.messages.indexOf(target), 1);
    }
  };

  /** 呼叫 AI：連線失敗會自動重試（通知畫面），並累計這段對話實際用掉的 token */
  const callAI = async opts => {
    const r = await streamChat({ signal: job.ac.signal, onRetry: info => { job.retry = info; emit({ type: 'retry', ...info }); }, ...opts });
    job.retry = null;
    if (r.usage) pendingUsage = sumUsage(pendingUsage, r.usage);
    return r;
  };

  /** 記下這次呼叫的耗時（中斷時也記：到按下停止為止）；導演規劃的時間算在這一輪第一位發言的角色上 */
  let directorMs = 0;
  const recordTiming = (target, prefix, usage) => {
    if (job.t0 == null) return;
    const end = performance.now();
    const t = { first: Math.round((job.tFirst ?? end) - job.t0), total: Math.round(end - job.t0) };
    const gen = (end - (job.tFirst ?? end)) / 1000;
    if (usage?.output > 0 && gen >= 0.2) t.tps = Math.round(usage.output / gen * 10) / 10;
    if (directorMs) { t.director = directorMs; directorMs = 0; }
    setTiming(target, t, prefix);
    job.t0 = null;
  };
  let first = true, lastResult = null, current = null;
  /** 生成一則訊息到 target（speaker：大世界輪流發言時由誰說；note：插話之類的額外指示） */
  const generateInto = async (target, prefix, speaker, note) => {
    current = { target, prefix };
    const history = historyFor(chat, settings, { exclude: prefix ? null : target });
    const { messages, info } = owner.build(history, chat.memory, turns || speaker ? { speaker, note } : null);
    delete info.history_tokens; // 只有壓縮時用得到，不用送給畫面
    info.memory_cut = memoryCutIndex(chat, settings); // 已經整理進記憶、這次沒有送出的舊訊息數
    const estimated = messages.reduce((s, m) => s + estimateTokens(m.content), 0);
    if (prefix) messages.push({ role: 'user', content: '[請直接從上一則回應中斷的地方接著寫下去，不要重複已經寫過的內容，也不要加任何說明]' });
    Object.assign(job, { info, message_index: chat.messages.indexOf(target), speaker: speaker || null, prefix, text: '', reasoning: '' });
    emit({ type: first ? 'start' : 'msg_start', info, message_index: job.message_index, speaker: job.speaker, message: target });
    first = false;
    job.t0 = performance.now(); job.tFirst = null;
    const mark = () => { if (job.tFirst == null) job.tFirst = performance.now(); };
    const result = await callAI({
      settings, messages,
      onText: t => { mark(); job.text += t; emit({ type: 'text', text: t }); },
      onReasoning: t => { mark(); job.reasoning += t; emit({ type: 'reasoning', text: t }); },
    });
    recordTiming(target, prefix, result.usage);
    if (result.usage) {
      target.usage = result.usage;
      // 校正 token 估算：記下「實際輸入 ÷ 估算值」（逐次平滑，避免單次異常值影響太大）
      if (result.usage.input > 0 && estimated > 200) {
        const r = Math.min(4, Math.max(0.25, result.usage.input / estimated));
        chat.token_ratio = Math.round((chat.token_ratio > 0 ? chat.token_ratio * 0.6 + r * 0.4 : r) * 1000) / 1000;
      }
    }
    setReasoning(target, result.reasoning, prefix);
    let text = job.text;
    if (turns && speaker) text = cleanSpeakerText(text, owner.speakerName(speaker), owner.otherNames(speaker));
    finalize(target, prefix, text);
    save();
    current = null;
    emit({ type: 'msg_end', message_index: chat.messages.indexOf(target), message: target });
    lastResult = result;
    return result;
  };

  try {
    save(); // 先存下你剛送出的訊息：導演規劃期間切走再回來時，畫面上也看得到
    // 上下文壓縮：聊天紀錄超過門檻時，先把較舊的對話整理進記憶（通常生成完就已經在背景做好，這裡只是保險）
    const cut = planCompress(chat, owner);
    if (cut) {
      job.phase = 'compress';
      emit({ type: 'compress', status: 'start' });
      try {
        const fresh = await compressChat(char_id, chat_id, cut);
        for (const k of MEMORY_KEYS) chat[k] = fresh[k];
        if (fresh.usage) chat.usage = fresh.usage;
      } catch (e) { console.warn('[compress]', e.message || e); } // 壓縮失敗：照舊送出（舊訊息依上下文長度裁掉）
      finally { job.phase = null; emit({ type: 'compress', status: 'done' }); }
    }
    const last = chat.messages[chat.messages.length - 1];
    // 大世界：在場角色對回目前的訊息（重新生成原本離場的那則時，他回到在場；刪掉後面的訊息時，回到那時候的狀態）
    if (turns) restorePresent(chat, mode === 'regenerate');
    if (mode === 'regenerate' && last && last.role === 'assistant') {
      // 重新生成：同一位發言者再說一次（新增一個版本）
      last.swipes = last.swipes && last.swipes.length ? last.swipes : [last.content];
      // 思考過程跟著各自的版本（換成不會思考的模型重新生成時，舊版本的思考不會殘留在新版本上）
      last.swipe_reasoning = swipeReasoning(last);
      last.swipe_timing = swipeTiming(last);
      last.swipes.push(''); last.swipe_reasoning.push(''); last.swipe_timing.push(null); last.swipe_id = last.swipes.length - 1; last.content = ''; delete last.reasoning; delete last.timing;
      save();
      await generateInto(last, '', turns ? last.speaker || NARRATOR : null);
      if (turns && 'present_before' in last) { last.present_after = Array.isArray(chat.present) ? [...chat.present] : null; save(); } // 新版本沒有離場
    } else if (mode === 'continue' && last && last.role === 'assistant') {
      save();
      await generateInto(last, last.content, turns ? last.speaker || NARRATOR : null);
    } else if (!turns) {
      const target = { role: 'assistant', content: '', swipes: [''], swipe_id: 0, time: Date.now() };
      chat.messages.push(target); save();
      await generateInto(target, '', null);
    } else {
      // 輪流發言：先由「導演」規劃這一輪的方向與順序，再由角色一位一位依照自己的意圖演出（流程在 lib/turns.js）
      // 你這一側最近的發言（可能是你的角色、你扮演的 NPC、你寫的旁白，好幾則連在一起）：標上身分交給導演
      const msgs = chat.messages;
      let from = msgs.length;
      while (from > 0 && msgs[from - 1].role === 'user') from--;
      const recent = from < msgs.length ? msgs.slice(from) : [[...msgs].reverse().find(m => m.role === 'user')].filter(Boolean);
      const user = settings.user_name || 'User';
      const userAction = recent.map(m => (npcLabel(m, user) || (recent.length > 1 ? `${user}：` : '')) + stripThinkText(m.content)).join('\n').slice(0, 600);
      await playRound({
        chat, owner, world, forced, interrupt, save, emit,
        user, userAction, narration: recent.some(m => m.narration),
        aborted: () => job.ac.signal.aborted,
        speak: async (sp, note) => {
          // present_before：說話前誰在場（重新生成這則時回到這個狀態）
          const target = { role: 'assistant', content: '', swipes: [''], swipe_id: 0, time: Date.now(), speaker: sp, present_before: Array.isArray(chat.present) ? [...chat.present] : null };
          chat.messages.push(target); save();
          await generateInto(target, '', sp, note);
          return target;
        },
        // 導演：知道所有角色，只輸出這一輪的重點與「誰、依序、要做什麼」，不寫台詞；回應上限壓低，思考型模型不會想太久
        direct: async instr => {
          job.phase = 'director';
          emit({ type: 'director', status: 'planning' });
          // 導演讀取的聊天紀錄：可以只讀最近幾則（省 token），或和角色們完全相同（本機模型可以共用快取）
          const { messages } = owner.build(historyFor(chat, settings, { limit: Number(settings.director_history) || 0 }), chat.memory, { speaker: null, director: true });
          messages.push({ role: 'user', content: instr });
          let out = '';
          const t0 = performance.now();
          try {
            await callAI({ settings: directorSettings(settings), messages, onText: t => { out += t; } });
          } finally { job.phase = null; directorMs += Math.round(performance.now() - t0); }
          const raw = stripThinkText(out);
          job.plan = raw;
          emit({ type: 'director', status: 'done', plan: raw });
          return raw;
        },
      });
    }

    const result = lastResult || {};
    const truncated = ['length', 'max_tokens'].includes(result.stop_reason);
    let notice = null;
    // 這段對話自己設定了回覆長度時，要到「對話設定」調整
    const where = Number.isFinite(chat.max_tokens) ? '「對話設定」把「回覆長度」' : '「設定」把「最大回應 tokens」';
    if (truncated && !job.text.trim()) {
      notice = result.reasoning
        ? `模型把 ${settings.max_tokens} tokens 全花在「思考」上，還沒開始回答就到上限了。請到${where}調高（建議 8192 以上），或把「思考程度」設低／關閉。`
        : `回應長度上限（${settings.max_tokens} tokens）太小，或本機模型載入時的上下文長度不足。請到${where}調高，並把「上下文長度」設成不超過模型實際載入的長度。`;
    } else if (truncated) notice = `回應達到長度上限，可按「繼續」接著寫，或到${where}調高。`;
    const memory_updating = maybeAutoCompress(char_id, chat_id, chat, owner);
    finish({ type: 'done', stop_reason: result.stop_reason, model: result.model, notice, chat: withVer(chat), memory_updating });
  } catch (err) {
    // 中斷或錯誤：保留已經產生的部分
    let saveErr = null;
    try {
      if (current) {
        if (job.reasoning && !current.target.reasoning) setReasoning(current.target, job.reasoning, current.prefix);
        if (job.text || job.reasoning) recordTiming(current.target, current.prefix, null);
        finalize(current.target, current.prefix, job.text);
        save();
      } else if (pendingUsage) save(); // 例如導演規劃完才出錯：用量照樣記下來
    } catch (e) { saveErr = e; console.warn('[generate] 存檔失敗：', e.message || e); } // 存檔失敗也一定要結束這次生成，不然這段對話會一直卡在「生成中」
    if (job.ac.signal.aborted && !saveErr) finish({ type: 'done', stopped: true, chat: withVer(chat) });
    else {
      const msg = saveErr ? `存檔失敗（${saveErr.message || saveErr}），已產生的內容可能沒有存到；檔案可能被防毒軟體或雲端同步鎖住，請稍後再試` : err.message || String(err);
      if (!saveErr) console.warn('[generate]', msg);
      finish({ type: 'error', error: msg, chat: withVer(chat) });
    }
  }

  function finish(obj) {
    jobs.delete(jobKey(char_id, chat_id));
    try { emit(obj); for (const r of job.listeners) r.end(); } catch { /* 瀏覽器已經斷線 */ }
    job.listeners.clear();
    job.resolveDone();
  }
}

// ---------- 記憶（每段對話的劇情摘要＋重點） ----------
const MEMORY_KEYS = ['memory', 'memory_upto', 'memory_updated', 'memory_cut', 'memory_prev'];
// 對話設定（只對這段對話有效）：生成中也可以修改，生成存檔時以檔案裡的為準
// 這段對話自己的生成參數（沒設定＝跟隨目前的模型設定）：上下文長度、創意發散度（Temperature）、回覆長度
const CHAT_GEN_KEYS = ['context_tokens', 'temperature', 'max_tokens'];
const CHAT_SETTING_KEYS = ['history_cap', 'persona_id', 'user_name', 'user_persona', 'books_off', 'max_replies', 'npcs', 'think', ...CHAT_GEN_KEYS];
// 這段對話的思考檔位（沒有＝跟隨模型設定）；送出前依供應商換成各自的參數
// sim＝模擬思考：在提示詞最後要求先在 <thinking> 裡規劃再回覆，並主動關閉原生思考（避免兩種思考疊在一起）。
// 只「不指定」不夠：預設就會思考的模型（新版 Claude、Gemini 3、推理模型）照樣會思考。
// 關不掉的模型由各供應商的退回機制處理（Claude 改用最低 Effort；Gemini、OpenAI 相容被拒絕就拿掉參數）
const CHAT_THINK = ['off', 'low', 'medium', 'high', 'sim'];
function applyThink(s, lvl) {
  if (!CHAT_THINK.includes(lvl)) return;
  const p = s.provider;
  if (lvl === 'sim') {
    s.sim_think = true;
    if (p === 'anthropic') s.anthropic = { ...s.anthropic, thinking: 'off' };
    else s[p] = { ...s[p], reasoning_effort: 'none' };
    return;
  }
  if (p === 'anthropic') s.anthropic = { ...s.anthropic, ...(lvl === 'off' ? { thinking: 'off' } : { thinking: 'on', effort: lvl }) };
  else s[p] = { ...s[p], reasoning_effort: lvl === 'off' ? 'none' : lvl };
}
const memJobs = new Map(); // 正在整理記憶的對話
const stripThinkText = s => stripThink(s).trim();

/**
 * 請 AI 把「目前的記憶」和尚未整理的訊息合併成新的記憶。
 * full = true 時從頭重新整理。訊息太多時會分段處理，每段完成就存檔。
 */
async function summarizeChat(charId, chatId, { full = false, until = Infinity } = {}) {
  const key = jobKey(charId, chatId);
  const running = memJobs.get(key);
  if (running) {
    // 已經在整理：涵蓋得到這次要的範圍就直接用它的結果；否則（例如背景壓縮只整理到切點，你按了「全部重新整理」）等它做完再整理一次
    if (running.full || (!full && until <= running.until)) return running.promise;
    return running.promise.catch(() => {}).then(() => summarizeChat(charId, chatId, { full, until }));
  }
  const ac = new AbortController(); // 還原備份、刪除對話時中止，避免把舊記憶寫回去
  const run = (async () => {
    const owner = resolveOwner(charId); // 角色或大世界都有自己的對話記憶
    const settings = owner.settings;
    let chat = store.getChat(charId, chatId);
    applyChatSettings(owner, chat); // 這段對話自己的玩家名字
    const ctx = { char: owner.name, user: settings.user_name || 'User' };
    const msgs = chat.messages;
    let upto = full ? 0 : Math.min(chat.memory_upto || 0, msgs.length);
    let memory = full ? '' : chat.memory || '';
    const stop = full ? msgs.length : Math.min(until, msgs.length); // 壓縮時只需要整理到切點
    if (upto >= stop) return chat;
    // 全部重新整理會取代目前的記憶：先留一版，可以「換回上一版」
    const before = full && chat.memory?.trim() ? { text: chat.memory, upto: chat.memory_upto || 0, cut: chat.memory_cut || 0, time: chat.memory_updated || Date.now() } : null;

    const system = substitute(settings.memory_prompt || store.DEFAULT_SETTINGS.memory_prompt, ctx);
    // 每段送出的對話量：上下文長度扣掉回應、記憶與指令
    const chunkBudget = Math.max(1500, (settings.context_tokens || 8000) - (settings.max_tokens || 1024) - estimateTokens(memory) - estimateTokens(system) - 800);
    while (upto < stop) {
      const lines = [];
      let used = 0, end = upto;
      for (; end < stop; end++) {
        const m = msgs[end];
        // 大世界輪流發言時標上各自的名字
        // 你扮演的 NPC、你寫的旁白：標上身分，記錄員才不會把 NPC 的話記成 {{user}} 的
        const lbl = m.role === 'user' ? npcLabel(m, ctx.user) : '';
        const who = m.role === 'user' ? ctx.user : m.speaker && owner.speakerName ? owner.speakerName(m.speaker) : ctx.char;
        const line = lbl ? `${lbl}${stripThinkText(m.content)}` : `${who}：${stripThinkText(m.content)}`;
        const t = estimateTokens(line);
        if (used + t > chunkBudget && lines.length) break;
        used += t; lines.push(line);
      }
      const npcNote = settings.chat_npcs.length || settings.chat_narration
        ? `\n\n註：標註「（NPC，由${ctx.user}扮演）」的發言屬於那位 NPC，不是 ${ctx.user} 本人說的，相關資訊請歸到角色與關係，不要寫進 ${ctx.user} 的設定；標註「（旁白，由${ctx.user}撰寫）」的是場景描述。` : '';
      const user = `[目前的記憶]\n${memory.trim() || '（尚無）'}\n\n[新的對話內容]\n${lines.join('\n\n')}${npcNote}\n\n請輸出整合後的完整記憶。`
        + (languageNote(settings) ? '\n\n' + languageNote(settings) : ''); // 對話語言的提醒放在最後
      let out = '';
      const aborted = () => Object.assign(new Error('已中止整理記憶（對話被清空、刪除訊息、刪除或還原）'), { status: 409 });
      const r = await streamChat({ signal: ac.signal, settings: { ...settings, temperature: 0.3 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], onText: t => { out += t; } })
        .catch(e => { throw ac.signal.aborted ? aborted() : e; });
      if (ac.signal.aborted) throw aborted();
      out = stripThinkText(out);
      if (!out) throw new Error('AI 沒有回傳記憶內容，請稍後再試，或檢查「最大回應 tokens」是否太小');
      // 只更新記憶欄位與用量，不動到訊息（生成或編輯可能同時進行）
      chat = store.getChat(charId, chatId);
      // 整理期間這一段的訊息被清空、刪除或改動（任何一則對不上，包括中間的）：這次的結果對不上，放棄不存
      const changed = (a, b) => !b || a.time !== b.time || a.content !== b.content;
      if (msgs.slice(upto, end).some((m, k) => changed(m, chat.messages[upto + k])))
        throw Object.assign(new Error('整理記憶期間對話內容有變動（清空、刪除或修改訊息），這次的整理結果已放棄，請重新整理'), { status: 409 });
      memory = out; upto = end;
      if (before) chat.memory_prev = before; // 每段都一樣：整理到一半中斷也留得住
      chat.memory = memory; chat.memory_upto = upto; chat.memory_updated = Date.now();
      if (r.usage) chat.usage = sumUsage(chat.usage, r.usage);
      chat = store.saveChat(charId, chat);
    }
    return chat;
  })().finally(() => memJobs.delete(key));
  memJobs.set(key, { promise: run, ac, full, until: full ? Infinity : until });
  return run;
}
/**
 * 導演呼叫 AI 用的設定：固定溫度；回應上限壓低（只寫規劃）。
 * 有設定思考程度時（思考型模型），思考也算在上限裡：改用「低」思考程度、上限放寬到 6000，
 * 比較不會只想完就被截斷（規劃看不懂就只能改用規則挑選），思考的 token 也比較省
 */
const DIRECTOR_MAX_TOKENS_THINKING = 6000;
function directorSettings(settings) {
  const p = settings.provider;
  const key = p === 'anthropic' ? 'effort' : 'reasoning_effort';
  const cur = (settings[p] || {})[key];
  const thinking = !!cur && !['none', 'minimal'].includes(cur) && !(p === 'anthropic' && settings.anthropic?.thinking === 'off');
  const s = { ...settings, sim_think: false, temperature: DIRECTOR_TEMPERATURE, // 導演只寫規劃，不用模擬思考
    max_tokens: thinking ? DIRECTOR_MAX_TOKENS_THINKING : Math.min(settings.max_tokens || DIRECTOR_MAX_TOKENS, DIRECTOR_MAX_TOKENS) };
  if (thinking && cur !== 'low') s[p] = { ...settings[p], [key]: 'low' };
  return s;
}
/** 記憶被取代前留一版（手動編輯、全部重新整理）；記憶是空的就不留 */
function keepMemoryPrev(chat) {
  if (chat.memory?.trim()) chat.memory_prev = { text: chat.memory, upto: chat.memory_upto || 0, cut: chat.memory_cut || 0, time: chat.memory_updated || Date.now() };
}
/** 中止背景整理記憶／壓縮，並等它們真的結束（還原備份、匯入、刪除對話前） */
async function stopMemoryJobs(pred = () => true) {
  const waits = [];
  for (const [key, job] of memJobs) if (pred(key)) { job.ac.abort(); waits.push(job.promise); }
  for (const [key, p] of compressJobs) if (pred(key)) waits.push(p);
  await Promise.allSettled(waits);
}
// ---------- 上下文壓縮：聊天紀錄快滿時，把較舊的一大批對話整理進記憶，再從提示詞移除 ----------
// 壓縮＝「整理記憶」＋「移動切點（memory_cut）」，一定一起發生：被移出的對話一定已經在記憶裡。
// 一次壓一大批（超過門檻才壓，壓到只剩保留比例），之後好一陣子提示詞開頭都不變，快取可以重用。
/** 這段對話的「實際用量 ÷ 估算值」比例，用來把上下文長度換算成估算值（沒有實際用量時是 1） */
const tokenScale = chat => (Number(chat.token_ratio) > 0 ? Number(chat.token_ratio) : 1);
/** 這段對話的聊天紀錄上限：對話設定有指定就用它（0 = 不限），否則用設定頁的預設（角色／大世界各自一個） */
function historyCap(owner, chat) {
  if (Number.isFinite(chat.history_cap) && chat.history_cap >= 0) return chat.history_cap;
  const key = owner.kind === 'world' ? 'history_cap_world' : 'history_cap_char';
  const v = Number(owner.settings[key] ?? store.DEFAULT_SETTINGS[key]);
  return v >= 0 ? v : 0;
}
/**
 * 組提示詞前套用這段對話專屬的設定（對話設定）：token 校正比例、聊天紀錄上限、
 * 這段對話的玩家名字與人設（沒填就用設定頁的）、停用的世界書
 */
function applyChatSettings(owner, chat) {
  const s = owner.settings;
  for (const k of CHAT_GEN_KEYS) if (Number.isFinite(chat[k])) s[k] = chat[k];
  applyThink(s, chat.think);
  s.token_scale = tokenScale(chat);
  s.history_cap = historyCap(owner, chat);
  // 這段對話的你：指定了使用者設定檔就用它；否則用這段對話自訂的名字／人設；都沒有就用設定頁的
  const persona = chat.persona_id ? (s.personas || []).find(p => p.id === chat.persona_id) : null;
  if (persona) {
    s.user_name = owner.ctx.user = persona.user_name || s.user_name;
    s.user_persona = persona.user_persona || '';
  } else {
    if (typeof chat.user_name === 'string' && chat.user_name.trim()) s.user_name = owner.ctx.user = chat.user_name.trim();
    if (typeof chat.user_persona === 'string' && chat.user_persona.trim()) s.user_persona = chat.user_persona;
  }
  owner.booksOff.clear();
  for (const k of chat.books_off || []) owner.booksOff.add(k);
  // 你扮演的 NPC 與你寫的旁白（提示詞裡會加上說明，模型才不會替 NPC 說話、也不會當成你的角色說的）
  s.chat_npcs = chatNpcs(chat);
  s.chat_narration = chat.messages.some(m => m.role === 'user' && m.narration);
}
/** 大世界：這段對話的發言設定（對話設定可以另外指定每輪最多幾位角色接話） */
const chatWorld = (owner, chat) => (owner.kind !== 'world' ? null
  : Number.isInteger(chat.max_replies) ? { ...owner.world, max_replies: chat.max_replies } : owner.world);
/**
 * 需要壓縮時回傳新的切點（訊息索引），不需要時回傳 0。
 * 門檻一定低於 100%，所以聊天紀錄在被上下文裁掉之前就會先壓縮：被移出的對話一定已經整理進記憶
 */
function planCompress(chat, owner) {
  const settings = owner.settings;
  if (!settings.memory_enabled || !settings.memory_auto) return 0;
  applyChatSettings(owner, chat);
  const cut = memoryCutIndex(chat, settings);
  const msgs = chat.messages;
  if (msgs.length - cut < 4) return 0;
  const history = msgs.slice(cut).map(m => ({ role: m.role, content: stripThinkText(m.content), speaker: m.speaker }));
  const turns = owner.kind === 'world' && (chat.turn_mode || owner.world.turn_mode) === 'turns' && owner.members.length;
  const { info } = owner.build(history, chat.memory, turns ? { speaker: owner.members[0].id } : null);
  const budget = info.history_budget, tokens = info.history_tokens;
  const total = tokens.reduce((s, t) => s + t, 0);
  const threshold = Math.min(95, Math.max(30, Number(settings.compress_threshold) || 70)) / 100;
  const keepRatio = Math.min(threshold - 0.1, Math.max(0.1, (Number(settings.compress_keep) || 35) / 100));
  if (!budget || total <= budget * threshold) return 0;
  // 從最新往回保留到「保留比例」為止，其餘的交給記憶；至少保留最後 2 則原文
  let i = tokens.length, acc = 0;
  while (i > 0 && acc + tokens[i - 1] <= budget * keepRatio) acc += tokens[--i];
  let target = cut + Math.min(i, tokens.length - 2);
  if (target <= cut) return 0;
  // 切在「你的發言」前面：不把一組你的發言和回應（大世界：一整輪的接話）拆開
  let aligned = 0;
  for (let k = target; k > cut; k--) if (msgs[k].role === 'user') { aligned = k; break; }
  if (!aligned) for (let k = target + 1; k < msgs.length - 1; k++) if (msgs[k].role === 'user') { aligned = k; break; }
  return aligned || target;
}
const compressJobs = new Map();
/** 壓縮到 newCut：還沒整理進記憶的部分先整理，再移動切點。回傳更新後的對話 */
function compressChat(charId, chatId, newCut) {
  const key = jobKey(charId, chatId);
  if (compressJobs.has(key)) return compressJobs.get(key);
  const run = (async () => {
    let chat = store.getChat(charId, chatId);
    if ((chat.memory_upto || 0) < newCut) chat = await summarizeChat(charId, chatId, { until: newCut });
    chat = store.getChat(charId, chatId); // 只改切點，不動到訊息（生成可能同時進行）
    if ((chat.memory_upto || 0) >= newCut && newCut > (chat.memory_cut || 0)) {
      chat.memory_cut = newCut;
      chat = store.saveChat(charId, chat);
    }
    return chat;
  })().finally(() => compressJobs.delete(key));
  compressJobs.set(key, run);
  return run;
}
/** 生成完成後：聊天紀錄已經超過門檻就先在背景壓縮，下一次送出時就不用等 */
function maybeAutoCompress(charId, chatId, chat, owner) {
  let cut = 0;
  try { cut = planCompress(chat, owner); } catch (e) { console.warn('[compress]', e.message || e); }
  if (!cut) return false;
  compressChat(charId, chatId, cut).catch(e => console.warn('[compress]', e.message || e));
  return true;
}

// ---------- 路由 ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

// user_avatar：使用者頭像的版本號（0 = 沒有頭像），不會存進設定檔
// bg_ver：自訂背景圖的版本號（0 = 沒有）
// personas：使用者設定檔附上頭像版本號（avatar_ver，0 = 沒有頭像）
const withAvatar = s => ({ ...s, user_avatar: store.userAvatarVer(), bg_ver: store.backgroundVer(),
  personas: (s.personas || []).map(p => ({ ...p, avatar_ver: store.personaAvatarVer(p.id) })) });
// 程式的預設設定（設定頁「恢復預設」用；不含任何金鑰）
route('GET', '/api/settings/defaults', (req, res) => send(res, 200, store.DEFAULT_SETTINGS));
// 設定的數值欄位：允許的範圍（[最小, 最大, 名稱]）
const SETTING_RANGES = {
  max_tokens: [1, 1e6, '最大回應長度'], context_tokens: [256, 1e8, '上下文長度'], temperature: [0, 2, 'Temperature'], top_p: [0, 1, 'Top P'],
  repetition_penalty: [0, 3, '重複懲罰'], retry_max: [0, 5, '自動重試次數'], director_history: [0, 10000, '導演讀取的則數'],
  keep_status: [0, 1000, '保留狀態欄的則數'], history_cap_char: [0, 1e8, '角色對話的聊天紀錄上限'], history_cap_world: [0, 1e8, '大世界的聊天紀錄上限'],
  backup_keep: [0, 100, '自動備份保留份數'], trash_days: [1, 365, '垃圾桶保留天數'], compress_threshold: [20, 95, '壓縮門檻'],
  compress_keep: [5, 90, '壓縮後保留的原文'], chat_render: [0, 100000, '一開始顯示的訊息數'],
};
// 這些欄位要是整數（下拉選單的值；手動送出的小數、字串一律拒絕）
const INT_SETTINGS = new Set(['backup_keep', 'trash_days', 'compress_threshold', 'compress_keep', 'chat_render', 'retry_max', 'director_history', 'keep_status']);
/** 數值欄位要是範圍內的數字（畫面上有擋，這裡再檢查一次，避免存進 "abc"、負數或小數，生成時送出錯誤的參數） */
function checkRanges(obj) {
  for (const [k, [lo, hi, label]] of Object.entries(SETTING_RANGES)) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (INT_SETTINGS.has(k) && !Number.isInteger(v)))
      throw Object.assign(new Error(`「${label}」要是 ${lo}～${hi} 之間的${INT_SETTINGS.has(k) ? '整數' : '數字'}`), { status: 400 });
  }
}
/**
 * 開放區網（HOST=0.0.0.0）時，區網裡的其他裝置不能改 API 位址：
 * 不然可以把位址改成自己架的伺服器，酒館就會帶著這台電腦存的金鑰連過去（等於拿到金鑰）。
 * patch：{ openai: { base_url }, gemini: { base_url }, ... }；位址和目前存的一樣就放行（儲存設定時整份送出）
 */
function guardApiUrl(req, patch) {
  if (isLoopback(req) || !patch || typeof patch !== 'object') return;
  const cur = store.getSettings();
  for (const p of ['openai', 'gemini', 'anthropic']) {
    const v = patch[p];
    if (!v || typeof v !== 'object' || !('base_url' in v)) continue;
    if (String(v.base_url ?? '').trim() !== String((cur[p] || {}).base_url ?? '').trim())
      throw Object.assign(new Error('只有執行酒館的這台電腦可以修改 API 位址'), { status: 403 });
  }
}
// 程式版本：以 package.json 為準（exe 的版本資訊、打包的分享版也用同一個版本號）
const APP_VERSION = (() => { try { return require('./package.json').version || ''; } catch { return ''; } })();
// corrupt：損毀、讀不懂的設定檔（這時設定與金鑰會以預設值顯示，畫面上提示從備份還原）
route('GET', '/api/settings', (req, res) => send(res, 200, { settings: withAvatar(store.getSettings()), keys: store.keyStatus(), version: APP_VERSION, corrupt: store.corruptFiles() }));
route('PUT', '/api/settings', async (req, res) => {
  // 使用者設定檔（清單與使用中的是哪一個）只能透過 /api/personas 修改，一定有一個在使用中
  // 模型設定檔（清單與使用中的是哪一個）只能透過 /api/profiles 修改：一定有一個在使用中，不能從這裡改成「不使用」
  const { user_avatar, bg_ver, personas: _personas, active_persona: _active, profiles: _profiles, active_profile: _activeProfile, ...patch } = await readJsonBody(req);
  checkRanges(patch);
  guardApiUrl(req, patch);
  if ('external_images' in patch && typeof patch.external_images !== 'boolean') throw Object.assign(new Error('external_images 要是 true 或 false'), { status: 400 });
  if ('reply_language' in patch && !Object.hasOwn(LANGUAGES, patch.reply_language)) throw Object.assign(new Error('未知的對話語言'), { status: 400 });
  const saved = store.saveSettings(patch);
  if ('trash_days' in patch) { try { store.purgeTrash(); } catch { /* 下次再清 */ } } // 保留天數縮短：馬上清掉過期的
  send(res, 200, { settings: withAvatar(saved) });
});
route('GET', '/api/user/avatar', (req, res) => {
  const f = store.getUserAvatarPath();
  if (!f) { res.writeHead(404); return res.end(); }
  sendFile(res, f);
});
route('PUT', '/api/user/avatar', async (req, res) => {
  const { image } = await readJsonBody(req);
  store.setUserAvatar(image ? decodeDataUrl(image) : null);
  send(res, 200, { user_avatar: store.userAvatarVer() });
});
route('GET', '/api/appearance/background', (req, res) => {
  const f = store.getBackgroundPath();
  if (!f) { res.writeHead(404); return res.end(); }
  sendFile(res, f);
});
route('PUT', '/api/appearance/background', async (req, res) => {
  const { image } = await readJsonBody(req);
  store.setBackground(image ? decodeDataUrl(image) : null);
  send(res, 200, { bg_ver: store.backgroundVer() });
});
// 應用程式視窗每 10 秒送一次「還開著」的訊號；launch.js 沒辦法追蹤視窗時（視窗交給既有的瀏覽器程序），用它判斷何時結束伺服器
let lastBeat = 0;
route('POST', '/api/heartbeat', (req, res) => { lastBeat = Date.now(); send(res, 200, { ok: true }); });
// 應用程式視窗的位置與大小（launch.js 下次開視窗時用）；是本機的顯示狀態，不是玩家存檔，所以放在 data/
route('PUT', '/api/window', async (req, res) => {
  const b = await readJsonBody(req);
  let old = null;
  try { old = JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8')); } catch { /* 第一次 */ }
  // 只送 { max: true }（一開就是最大化）：沿用上次記下的位置與大小
  const src = b.max && b.x === undefined && old ? { ...old, max: true } : b;
  const int = (v, lo, hi) => (v !== null && v !== '' && Number.isFinite(+v) && +v >= lo && +v <= hi ? Math.round(+v) : null);
  const win = { x: int(src.x, -20000, 20000), y: int(src.y, -20000, 20000), w: int(src.w, 300, 20000), h: int(src.h, 200, 20000), max: !!src.max };
  if (Object.values(win).includes(null)) return send(res, 400, { error: '無效的視窗位置' });
  // 螢幕縮放（例如 125%）時，開出來的視窗常比指定的大 1～2 像素；差這麼一點就不更新，免得每次開都慢慢變大
  const same = old && old.max === win.max && ['x', 'y', 'w', 'h'].every(k => Math.abs(old[k] - win[k]) <= 3);
  if (!same) {
    fs.mkdirSync(path.dirname(WINDOW_FILE), { recursive: true });
    store.writeFileAtomic(WINDOW_FILE, JSON.stringify(win)); // 先寫暫存檔再換名字：寫到一半中斷也不會壞掉
  }
  send(res, 200, { ok: true, saved: !same });
});
route('PUT', '/api/keys', async (req, res) => {
  // 開放區網時，只有這台電腦可以改金鑰（避免區網裡的其他裝置換掉或清掉你的金鑰）
  if (!isLoopback(req)) return send(res, 403, { error: '只有執行酒館的這台電腦可以修改 API 金鑰' });
  const { provider, api_key } = await readJsonBody(req);
  store.setApiKey(provider, api_key);
  send(res, 200, { keys: store.keyStatus() });
});
// 設定頁按「顯示」時才讀取已儲存的金鑰，讓使用者檢查有沒有打錯（只回傳存在 config.json 的；環境變數提供的不回傳）。
// 一般的設定 API 仍然不帶金鑰；其他網站的請求已由上方的來源檢查擋下
route('GET', '/api/keys/:provider', (req, res, p) => {
  // 開放區網（HOST=0.0.0.0）時，只有這台電腦自己可以讀金鑰明文（區網裡的其他裝置照樣可以用酒館，但讀不到金鑰）
  if (!isLoopback(req)) return send(res, 403, { error: '只有執行酒館的這台電腦可以查看已儲存的金鑰' });
  if (!['openai', 'gemini', 'anthropic'].includes(p.provider)) return send(res, 400, { error: '未知的 provider' });
  const st = store.keyStatus()[p.provider];
  send(res, 200, { source: st.source, key: st.source === 'config' ? store.getApiKey(p.provider) : '' });
});
route('GET', '/api/models', async (req, res) => send(res, 200, { models: await listModels(store.getSettings()) }));
/**
 * 用畫面上「還沒儲存」的連線設定取得模型清單：不寫入任何設定。
 * 以前會先儲存再取清單，新增設定檔時（欄位是預設值）按「取得模型清單」，會把預設值寫進目前使用中的設定檔。
 * body：{ provider, base_url?（OpenAI 相容）, api_key?（畫面上新填的金鑰；沒給＝用已經存好的） }
 */
route('POST', '/api/models', async (req, res) => {
  const body = await readJsonBody(req);
  const cur = store.getSettings();
  const p = ['openai', 'gemini', 'anthropic'].includes(body.provider) ? body.provider : cur.provider;
  const s = { ...cur, provider: p, [p]: { ...cur[p] } };
  if (p === 'openai' && typeof body.base_url === 'string') {
    guardApiUrl(req, { openai: { base_url: body.base_url } }); // 區網裝置不能用存好的金鑰連自訂的位址
    s.openai.base_url = body.base_url.trim();
  }
  if (typeof body.api_key === 'string') s._key = body.api_key.trim();
  send(res, 200, { models: await listModels(s) });
});
// 全文搜尋：所有對話的訊息內容
route('GET', '/api/search', (req, res, p, query) => send(res, 200, store.searchMessages(query.get('q') || '')));

// 備份、匯出與匯入（API 金鑰不會被打包）
const sendDownload = (res, buf, filename) => {
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': buf.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
  res.end(buf);
};
const today = () => new Date().toLocaleDateString('sv-SE'); // 2026-11-17
// 垃圾桶：刪除的角色、大世界、世界書與對話（超過保留天數自動清掉）
route('GET', '/api/trash', (req, res) => send(res, 200, store.listTrash()));
route('POST', '/api/trash/:kind/:name/restore', (req, res, p) => send(res, 200, { restored: store.restoreTrashItem(p.kind, p.name) }));
route('DELETE', '/api/trash/:kind/:name', (req, res, p) => { store.deleteTrashItem(p.kind, p.name); send(res, 200, store.listTrash()); });
route('DELETE', '/api/trash', (req, res) => send(res, 200, { removed: store.emptyTrash(), ...store.listTrash() }));
route('GET', '/api/backups',(req, res) => send(res, 200, { keep: store.getSettings().backup_keep, ...backup.backupStatus() }));
route('POST', '/api/backups', (req, res) => {
  // 手動備份：不參與自動輪替，也不會刪掉其他備份（自動備份關閉時也一樣）；不需要時在清單裡自己刪
  const name = backup.createBackup({ force: true, kind: 'manual' });
  send(res, 200, { name, ...backup.backupStatus() });
});
route('DELETE', '/api/backups/:name', (req, res, p) => { backup.deleteBackup(p.name); send(res, 200, backup.backupStatus()); });
route('GET', '/api/backups/:name/download', (req, res, p) => sendDownload(res, backup.exportBackup(p.name), `AI酒館-${p.name}`));
route('POST', '/api/backups/:name/restore', async (req, res, p) => {
  const bundle = backup.readBackup(p.name); // 先確認備份讀得到，再停下進行中的工作
  stopJobs(() => true); // 進行中的生成、整理記憶先停下來，避免把舊資料寫回去
  await stopMemoryJobs();
  send(res, 200, backup.restore(bundle));
});
route('GET', '/api/export', (req, res) => sendDownload(res, backup.exportAll(), `AI酒館-全部資料-${today()}.tavern`));
route('POST', '/api/import', async (req, res) => {
  const buf = await readBody(req, 1024 * 1024 * 1024); // 圖片多的時候可能很大：上限 1GB
  stopJobs(() => true);
  await stopMemoryJobs();
  // 匯入的可能是別人的檔案：連線設定沿用目前的（不然你的金鑰會被送到檔案裡設定的 API 位址）
  send(res, 200, backup.restore(buf, { keepConnection: true }));
});

// 內附的 Node.js（runtime/node.exe，約 95 MB）：電腦上有安裝 Node.js 時用不到，可以在設定頁刪掉省空間；
// 打包分享版時會改從安裝的 Node.js 複製一份，不影響打包
const runtimeNode = require('./tools/runtime-node');
const runtimeStatus = () => {
  let size = 0;
  try { size = fs.statSync(runtimeNode.EXE).size; } catch { /* 沒有內附版本 */ }
  return { bundled: size > 0, size, using_bundled: runtimeNode.runningBundled(), installed_version: runtimeNode.runningBundled() ? '' : process.version, windows: process.platform === 'win32' };
};
route('GET', '/api/runtime', (req, res) => send(res, 200, runtimeStatus()));
route('DELETE', '/api/runtime', (req, res) => {
  if (runtimeNode.runningBundled()) return send(res, 409, { error: '酒館現在就是用內附的 Node.js 在執行（這台電腦沒有安裝 Node.js），不能刪除' });
  try { fs.rmSync(runtimeNode.EXE, { force: true }); } // README.txt 留著：打包時會換成實際複製的版本
  catch (e) { return send(res, 500, { error: `刪除失敗：${e.message}` }); }
  send(res, 200, runtimeStatus());
});
route('POST', '/api/runtime', (req, res) => {
  if (process.platform !== 'win32') return send(res, 400, { error: '內附版本只支援 Windows' });
  if (runtimeNode.runningBundled()) return send(res, 409, { error: '酒館正在用內附的 Node.js 執行，不需要重新建立' });
  runtimeNode.copyInstalledNode();
  send(res, 200, runtimeStatus());
});

// 模型設定檔（金鑰只存在 config.json，不會回傳給瀏覽器）
route('GET', '/api/profiles', (req, res) => send(res, 200, store.listProfiles()));
// 新增模型設定檔並切換過去。fields：畫面上還沒儲存的連線設定與生成參數（沒給＝用目前的設定）；
// key：這個設定檔的金鑰（沒給＝用目前存好的）。原本使用中的設定檔不會被改到
route('POST', '/api/profiles', async (req, res) => {
  const { name, fields, key } = await readJsonBody(req);
  const clean = fields && typeof fields === 'object' ? Object.fromEntries(store.PROFILE_FIELDS.filter(k => k in fields).map(k => [k, fields[k]])) : null;
  if (clean) { checkRanges(clean); guardApiUrl(req, clean); }
  // 區網裝置也不能改金鑰（和 PUT /api/keys 一樣）
  if (typeof key === 'string' && key.trim() && !isLoopback(req)) return send(res, 403, { error: '只有執行酒館的這台電腦可以修改 API 金鑰' });
  if (clean && 'provider' in clean && !['openai', 'gemini', 'anthropic'].includes(clean.provider)) throw Object.assign(new Error('未知的供應商'), { status: 400 });
  const p = store.createProfile(name, { fields: clean, key: typeof key === 'string' ? key.trim() : undefined });
  send(res, 200, { id: p.id, ...store.listProfiles() });
});
route('PUT', '/api/profiles/:id', async (req, res, p) => {
  const { name } = await readJsonBody(req);
  store.renameProfile(p.id, name);
  send(res, 200, store.listProfiles());
});
route('DELETE', '/api/profiles/:id', (req, res, p) => { store.deleteProfile(p.id); send(res, 200, store.listProfiles()); });
route('POST', '/api/profiles/:id/apply', (req, res, p) => {
  const settings = store.applyProfile(p.id);
  send(res, 200, { settings: withAvatar(settings), keys: store.keyStatus(), ...store.listProfiles() });
});

// 使用者設定檔（名字、人設與頭像）
route('GET', '/api/personas', (req, res) => send(res, 200, store.listPersonas()));
route('POST', '/api/personas', async (req, res) => {
  const body = await readJsonBody(req);
  // avatar：新增時另外選的頭像（PNG data URL；null＝不要頭像；沒給＝沿用目前的頭像）
  const avatar = !('avatar' in body) ? undefined : body.avatar ? decodeDataUrl(body.avatar) : null;
  // user_name、user_persona：新設定檔的名字與人設（沒給＝沿用目前的）
  const p = store.createPersona(body.name, { avatar, user_name: body.user_name, user_persona: body.user_persona });
  send(res, 200, { id: p.id, ...store.listPersonas() });
});
route('PUT', '/api/personas/:id', async (req, res, p) => {
  const { name } = await readJsonBody(req);
  store.renamePersona(p.id, name);
  send(res, 200, store.listPersonas());
});
route('DELETE', '/api/personas/:id', (req, res, p) => { store.deletePersona(p.id); send(res, 200, store.listPersonas()); });
route('POST', '/api/personas/:id/apply', (req, res, p) => {
  const settings = store.applyPersona(p.id);
  send(res, 200, { settings: withAvatar(settings), ...store.listPersonas() });
});
route('GET', '/api/personas/:id/avatar', (req, res, p) => {
  const f = store.getPersonaAvatarPath(p.id);
  if (!f) { res.writeHead(404); return res.end(); }
  sendFile(res, f);
});

// 角色
route('GET', '/api/characters', (req, res) => send(res, 200, store.listCharacters()));
// 圖片欄位：cover = 封面（角色卡圖），avatar = 對話頭像；remove_avatar = 移除頭像（改用封面）
const imagesFrom = body => {
  const images = {};
  if (body.cover) images.cover = decodeDataUrl(body.cover);
  if (body.avatar) images.avatar = decodeDataUrl(body.avatar);
  else if (body.remove_avatar) images.avatar = null;
  return images;
};
route('POST', '/api/characters', async (req, res) => {
  const body = await readJsonBody(req);
  const id = store.saveCharacter(null, normalizeCard(body.data), imagesFrom(body));
  send(res, 200, { id });
});
route('POST', '/api/characters/import', async (req, res) => {
  const buf = await readBody(req);
  let card, cover = null;
  if (png.isPng(buf)) { card = png.extractCard(buf); cover = buf; }
  else {
    try { card = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); }
    catch { throw Object.assign(new Error('無法辨識的檔案：請使用 PNG 或 JSON 角色卡'), { status: 400 }); }
  }
  // 格式不對的角色卡（沒有名字、PNG 裡沒有角色資料）回 400，不要變成伺服器錯誤
  let data;
  try { data = card && typeof card === 'object' ? normalizeCard(card) : null; } catch { data = null; }
  if (!data || typeof data.name !== 'string' || !data.name.trim())
    throw Object.assign(new Error(png.isPng(buf) ? '這張圖片裡沒有角色卡資料' : '檔案裡沒有角色卡資料（找不到角色名稱）'), { status: 400 });
  const id = store.saveCharacter(null, data, { cover });
  send(res, 200, { id, name: data.name });
});
route('GET', '/api/characters/:id', (req, res, p) => send(res, 200, store.getCharacter(p.id)));
// 順序 ID（首頁「自訂ID排序」用）：order 是整數，null＝不指定。存在資料夾裡的 order.json，不改角色卡
route('PUT', '/api/characters/:id/order', async (req, res, p) => send(res, 200, { order: store.setOrder('char', p.id, (await readJsonBody(req)).order ?? null) }));
route('PUT', '/api/bigworlds/:id/order', async (req, res, p) => send(res, 200, { order: store.setOrder('bigworld', p.id, (await readJsonBody(req)).order ?? null) }));
route('PUT', '/api/characters/:id', async (req, res, p) => {
  const body = await readJsonBody(req);
  const cur = store.getCharacter(p.id);
  const images = imagesFrom(body);
  if (body.data || Object.keys(images).length) store.saveCharacter(p.id, body.data ? normalizeCard(body.data) : cur.data, images);
  if (body.world_id !== undefined) store.setCharacterWorld(p.id, body.world_id);
  send(res, 200, store.getCharacter(p.id));
});
route('DELETE', '/api/characters/:id', async (req, res, p) => {
  stopJobs(j => j.char_id === p.id);
  await stopMemoryJobs(key => key.startsWith(p.id + '/'));
  store.deleteCharacter(p.id); send(res, 200, { ok: true });
});
for (const [kind, getter] of [['avatar', store.getAvatarPath], ['cover', store.getCoverPath]]) {
  route('GET', `/api/characters/:id/${kind}`, (req, res, p) => {
    const f = getter(p.id);
    if (!f) { res.writeHead(404); return res.end(); }
    sendFile(res, f);
  });
}
route('GET', '/api/characters/:id/export', (req, res, p, q) => {
  const ch = store.getCharacter(p.id);
  // 檔名：角色名-年月日-時分（24 小時制），例如 艾迪娜-20261119-0853（和備份、垃圾桶的時間格式一致，只到分鐘）；
  // 同一分鐘內再匯出時，瀏覽器會自己在後面加 (1)、(2)
  const fname = encodeURIComponent(`${ch.data.name}-${timeStamp().slice(0, 13)}`);
  if (q.get('format') === 'json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${fname}.json` });
    return res.end(JSON.stringify(toV3(ch.data), null, 2));
  }
  const f = store.getCoverPath(p.id) || store.getAvatarPath(p.id);
  const base = f ? fs.readFileSync(f) : png.solidPng(400, 600, [40, 44, 70]);
  const out = png.embedCard(base, toV2(ch.data), toV3(ch.data));
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename*=UTF-8''${fname}.png` });
  res.end(out);
});

// 聊天
route('GET', '/api/chats', (req, res) => send(res, 200, store.listAllChats().map(c => ({ ...c, generating: jobs.has(jobKey(c.char.id, c.id)), memory_updating: memJobs.has(jobKey(c.char.id, c.id)) || compressJobs.has(jobKey(c.char.id, c.id)) }))));
route('POST', '/api/characters/:id/chats', async (req, res, p) => {
  const { greeting = 0, turn_mode, branch_from, upto } = await readJsonBody(req);
  if (typeof branch_from === 'string') return send(res, 200, branchChat(p.id, branch_from, upto));
  send(res, 200, newChatFor(p.id, greeting, turn_mode));
});
/**
 * 訊息的版本（訊息內容的雜湊）：前端整份送回訊息時帶上它讀到的版本，和伺服器上的不一樣就拒絕，
 * 避免同一段對話開在兩個視窗時，舊畫面把另一個視窗剛產生的訊息蓋掉。只看訊息：改名、記憶整理不影響
 */
const msgVer = c => crypto.createHash('sha1').update(JSON.stringify(c.messages || [])).digest('hex').slice(0, 16);
const withVer = c => (c && Array.isArray(c.messages) ? { ...c, msg_ver: msgVer(c) } : c);
route('GET', '/api/characters/:id/chats/:chat', (req, res, p) => send(res, 200, withVer(store.getChat(p.id, p.chat))));
// 清空聊天用：角色卡／世界「目前」的開場白（改過或刪掉的開場白會重新帶入）；{{user}} 用這段對話自己的名字
route('GET', '/api/characters/:id/chats/:chat/opening', (req, res, p, query) => {
  const owner = resolveOwner(p.id);
  applyChatSettings(owner, store.getChat(p.id, p.chat));
  send(res, 200, openingMessages(owner, Number(query.get('greeting')) || 0));
});
// 更換名字前的預覽（不修改任何東西）
route('POST', '/api/characters/:id/chats/:chat/rename-preview', async (req, res, p) => {
  const { from, to } = await readJsonBody(req);
  if (typeof from !== 'string' || typeof to !== 'string' || !from.trim()) throw Object.assign(new Error('缺少名字'), { status: 400 });
  send(res, 200, renameScan(p.id, store.getChat(p.id, p.chat), from, to));
});
route('PUT', '/api/characters/:id/chats/:chat', async (req, res, p) => {
  const body = await readJsonBody(req);
  let chat = store.getChat(p.id, p.chat);
  // 生成中不能整份換掉訊息（生成存檔時會把它蓋回去）；名稱、記憶與對話設定照樣可以改
  if (Array.isArray(body.messages) && jobs.has(jobKey(p.id, p.chat)))
    throw Object.assign(new Error('這段對話還在生成中，請等它完成或按「停止」再修改訊息'), { status: 409 });
  // 訊息變少（清空聊天、刪除訊息）時，背景正在整理的記憶已經對不上：先中止並等它結束，再讀一次對話
  if (Array.isArray(body.messages) && body.messages.length < chat.messages.length
    && (memJobs.has(jobKey(p.id, p.chat)) || compressJobs.has(jobKey(p.id, p.chat)))) {
    await stopMemoryJobs(key => key === jobKey(p.id, p.chat));
    chat = store.getChat(p.id, p.chat);
  }
  // 前端讀到之後，這段對話的訊息已經被改過（例如另一個視窗剛產生了新訊息）：不覆蓋，請前端重新讀取
  if (Array.isArray(body.messages) && typeof body.base_ver === 'string' && body.base_ver !== msgVer(chat))
    throw Object.assign(new Error('這段對話在其他視窗有新的變動，為了不覆蓋掉它，這次的修改沒有存檔。已重新讀取最新內容，請再操作一次'), { status: 409, code: 'stale' });
  // 背景正在整理記憶時手動改記憶：整理完會用舊的記憶加新內容蓋回去，手動的修改會不見，所以先擋下
  // 更換名字也會改到記憶，一樣先擋下
  if ((typeof body.memory === 'string' || body.rename_user) && (memJobs.has(jobKey(p.id, p.chat)) || compressJobs.has(jobKey(p.id, p.chat))))
    throw Object.assign(new Error('記憶正在背景整理中，請等整理完成再編輯記憶'), { status: 409 });
  // 更換這段對話的你：開場白依模板重新套用新名字；記憶與送給 AI 的那段聊天紀錄，只改使用者勾選的位置
  if (body.rename_user && typeof body.rename_user.from === 'string' && typeof body.rename_user.to === 'string') {
    if (jobs.has(jobKey(p.id, p.chat))) throw Object.assign(new Error('這段對話還在生成中，請等它完成或按「停止」再更換名字'), { status: 409 });
    applyRename(p.id, chat, body.rename_user);
  }
  // 清空聊天、一次刪掉好幾則訊息：先把原本的對話完整留一份在垃圾桶（清錯、刪錯了可以還原）
  if (body.snapshot === 'clear' && chat.messages.length) store.snapshotChatToTrash(p.id, chat);
  else if (body.snapshot === 'delete' && Array.isArray(body.messages) && body.messages.length < chat.messages.length) store.snapshotChatToTrash(p.id, chat, '（刪除訊息前）');
  if (Array.isArray(body.messages)) chat.messages = body.messages;
  if (typeof body.title === 'string') chat.title = body.title;
  // 手動編輯記憶：改之前的內容留一版，可以「換回上一版」
  if (typeof body.memory === 'string') {
    if (body.memory !== (chat.memory || '')) keepMemoryPrev(chat);
    chat.memory = body.memory; chat.memory_updated = Date.now();
  }
  // 換回上一版記憶（和目前的互換，再按一次就換回來）
  if (body.memory_restore_prev === true) {
    if (!chat.memory_prev) throw Object.assign(new Error('沒有上一版的記憶'), { status: 404 });
    if (memJobs.has(jobKey(p.id, p.chat)) || compressJobs.has(jobKey(p.id, p.chat)))
      throw Object.assign(new Error('記憶正在背景整理中，請等整理完成再換回上一版'), { status: 409 });
    const prev = chat.memory_prev;
    chat.memory_prev = { text: chat.memory || '', upto: chat.memory_upto || 0, cut: chat.memory_cut || 0, time: chat.memory_updated || Date.now() };
    chat.memory = prev.text; chat.memory_upto = Math.min(prev.upto || 0, chat.messages.length); chat.memory_cut = Math.min(prev.cut || 0, chat.messages.length);
    chat.memory_updated = Date.now();
  }
  if (Number.isInteger(body.memory_upto)) chat.memory_upto = Math.max(0, body.memory_upto);
  if (Number.isInteger(body.memory_cut)) chat.memory_cut = Math.max(0, body.memory_cut); // 清空聊天、分支時重設壓縮的切點
  // 訊息變少（刪除訊息、清空聊天）：記憶進度與壓縮切點不能超過訊息數，不然之後的新訊息會被當成「已整理」而不送給 AI
  const n = chat.messages.length;
  if ((chat.memory_upto || 0) > n) chat.memory_upto = n;
  if ((chat.memory_cut || 0) > n) chat.memory_cut = n;
  // 對話設定：聊天紀錄上限（null = 跟隨預設，0 = 不限）
  if (body.history_cap === null) delete chat.history_cap;
  else if (Number.isInteger(body.history_cap) && body.history_cap >= 0) chat.history_cap = body.history_cap;
  // 這段對話的上下文長度、Temperature、回覆長度（null＝跟隨目前的模型設定）
  for (const k of CHAT_GEN_KEYS) {
    if (!(k in body)) continue;
    if (body[k] === null) { delete chat[k]; continue; }
    const [lo, hi, label] = SETTING_RANGES[k], v = body[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
      throw Object.assign(new Error(`「${label}」要是 ${lo}～${hi} 之間的數字`), { status: 400 });
    chat[k] = k === 'temperature' ? Math.round(v * 100) / 100 : Math.round(v);
  }
  // 這段對話的思考檔位（null＝跟隨目前的模型設定）
  if ('think' in body) {
    if (body.think === null) delete chat.think;
    else if (CHAT_THINK.includes(body.think)) chat.think = body.think;
    else throw Object.assign(new Error('思考檔位只能是 off、low、medium、high、sim（或 null＝跟隨模型設定）'), { status: 400 });
  }
  // 這段對話用哪個使用者設定檔（null＝不指定）
  if (body.persona_id === null) delete chat.persona_id;
  else if (typeof body.persona_id === 'string') {
    if (!store.getPersona(body.persona_id)) throw Object.assign(new Error('找不到這個使用者設定檔'), { status: 404 });
    chat.persona_id = body.persona_id;
  }
  // 這段對話的玩家名字與人設（空白＝用設定頁的）
  for (const k of ['user_name', 'user_persona']) {
    if (typeof body[k] !== 'string') continue;
    const v = k === 'user_name' ? body[k].trim().slice(0, 60) : body[k];
    if (v.trim()) chat[k] = v; else delete chat[k];
  }
  // 自訂了這段對話的名字或人設、又沒有同時指定設定檔：改用自訂的（不然固定的使用者設定檔會蓋過自訂的內容）
  if (!('persona_id' in body) && ['user_name', 'user_persona'].some(k => typeof body[k] === 'string' && body[k].trim())) delete chat.persona_id;
  // 這段對話停用的世界書（key 見 resolveOwner）
  if (Array.isArray(body.books_off)) {
    const off = [...new Set(body.books_off.filter(k => typeof k === 'string' && /^(world|w:[\w-]{1,80}|emb:[\w-]{1,80})$/.test(k)))];
    if (off.length) chat.books_off = off; else delete chat.books_off;
  }
  // 你扮演的 NPC 名單（只存名字）
  if (Array.isArray(body.npcs)) {
    const list = [...new Set(body.npcs.map(cleanNpc).filter(Boolean))].slice(0, 30);
    if (list.length) chat.npcs = list; else delete chat.npcs;
  }
  // 大世界：每輪最多幾位角色接話（null＝跟隨世界）
  if (body.max_replies === null) delete chat.max_replies;
  else if (Number.isInteger(body.max_replies)) chat.max_replies = Math.min(5, Math.max(1, body.max_replies));
  if ('present' in body) chat.present = Array.isArray(body.present) ? body.present : null; // 清空聊天時重設在場角色
  send(res, 200, withVer(store.saveChat(p.id, chat)));
});
// 只加入一則你這一側的訊息、不讓 AI 回應（例如你的角色說完，再用 NPC 補一句，最後才讓 AI 接話）
route('POST', '/api/characters/:id/chats/:chat/messages', async (req, res, p) => {
  if (jobs.has(jobKey(p.id, p.chat))) throw Object.assign(new Error('這段對話還在生成中，請等它完成或按「停止」'), { status: 409 });
  const { content, npc, narration } = await readJsonBody(req);
  if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('訊息是空的'), { status: 400 });
  const chat = store.getChat(p.id, p.chat);
  chat.messages.push(userMessage(chat, content, { npc, narration }));
  send(res, 200, withVer(store.saveChat(p.id, chat)));
});
// 對話設定：這段對話會用到的世界書（off＝這段對話停用）
route('GET', '/api/characters/:id/chats/:chat/books', (req, res, p) => {
  const chat = store.getChat(p.id, p.chat);
  const owner = resolveOwner(p.id);
  const off = new Set(chat.books_off || []);
  const global = new Set(owner.settings.world_ids || []);
  send(res, 200, owner.allBooks().map(b => ({
    key: b._key, name: b.name || '未命名世界書', count: (b.entries || []).length, off: off.has(b._key),
    source: b._key === 'world' ? '世界專屬' : b._key.startsWith('emb:') ? '角色卡內嵌' : global.has(b._key.slice(2)) ? '全域' : '連結',
  })));
});
// 請 AI 整理記憶（full = 從頭重新整理）
route('POST', '/api/characters/:id/chats/:chat/memory', async (req, res, p) => {
  const { full } = await readJsonBody(req);
  send(res, 200, await summarizeChat(p.id, p.chat, { full: !!full }));
});
route('DELETE', '/api/characters/:id/chats/:chat', async (req, res, p) => {
  stopJobs(j => j.char_id === p.id && j.chat_id === p.chat);
  await stopMemoryJobs(key => key === jobKey(p.id, p.chat));
  store.deleteChat(p.id, p.chat); send(res, 200, { ok: true });
});

route('POST', '/api/generate', handleGenerate);
// 重新接上進行中的生成：先送出目前為止的內容，之後繼續串流
route('GET', '/api/generate/:id/:chat', (req, res, p) => {
  const job = jobs.get(jobKey(p.id, p.chat));
  if (!job) return send(res, 404, { error: '沒有進行中的生成' });
  attachListener(job, res);
  // info 可能是 null：導演還在規劃、還沒開始任何一則訊息（phase = 'director'）
  res.write(`data: ${JSON.stringify({ type: 'start', info: job.info, phase: job.phase || null, message_index: job.message_index, text: job.text, reasoning: job.reasoning })}\n\n`);
  if (job.plan) res.write(`data: ${JSON.stringify({ type: 'director', status: 'done', plan: job.plan })}\n\n`);
});
route('POST', '/api/generate/stop', async (req, res) => {
  const { char_id, chat_id } = await readJsonBody(req);
  const job = jobs.get(jobKey(char_id, chat_id));
  if (job) job.ac.abort();
  send(res, 200, { ok: !!job });
});
route('POST', '/api/prompt-preview', async (req, res) => {
  const { char_id, chat_id } = await readJsonBody(req);
  const chat = store.getChat(char_id, chat_id);
  const owner = resolveOwner(char_id);
  applyChatSettings(owner, chat);
  // 大世界輪流發言：顯示第一位角色實際收到的樣子（共用的開頭＋他專用的最後一段）
  const turns = owner.kind === 'world' && (chat.turn_mode || owner.world.turn_mode) === 'turns' && owner.members.length;
  const r = owner.build(historyFor(chat, owner.settings), chat.memory, turns ? { speaker: owner.members[0].id } : null);
  delete r.info.history_tokens;
  r.info.memory_cut = memoryCutIndex(chat, owner.settings);
  r.info.history_cap = owner.settings.history_cap; // 這段對話實際套用的聊天紀錄上限（0 = 不限）
  if (turns) r.info.preview_note = `輪流發言：以下是輪到「${owner.members[0].card.name}」時送出的內容；其他角色只有最後一段不同。`;
  send(res, 200, r);
});

// 大世界
route('GET', '/api/bigworlds', (req, res) => send(res, 200, store.listBigWorlds()));
route('POST', '/api/bigworlds', async (req, res) => {
  const body = await readJsonBody(req);
  const id = store.saveBigWorld(null, body.data, body.cover ? decodeDataUrl(body.cover) : undefined);
  send(res, 200, store.getBigWorld(id));
});
route('GET', '/api/bigworlds/:id', (req, res, p) => send(res, 200, store.getBigWorld(p.id)));
route('PUT', '/api/bigworlds/:id', async (req, res, p) => {
  const body = await readJsonBody(req);
  store.getBigWorld(p.id);
  // cover：新圖片；remove_cover：改回預設封面
  store.saveBigWorld(p.id, body.data, body.cover ? decodeDataUrl(body.cover) : body.remove_cover ? null : undefined);
  send(res, 200, store.getBigWorld(p.id));
});
route('DELETE', '/api/bigworlds/:id', async (req, res, p) => {
  stopJobs(j => j.char_id === store.WORLD_PREFIX + p.id);
  await stopMemoryJobs(key => key.startsWith(store.WORLD_PREFIX + p.id + '/'));
  store.deleteBigWorld(p.id); send(res, 200, { ok: true });
});
// 整理角色卡規則（世界設定 → 提示詞）：用世界編輯器目前（還沒存檔）的內容，請 AI 把共用規則挑出來。
// body：{ world_prompt, members: [{ id, sys_mode, sys_custom }], estimate_only }
// estimate_only：只回傳 API 是否設定好、使用的模型與預估用量，不呼叫 AI
const organize = require('./lib/organize');
/** API 有沒有設定好（沒有金鑰、沒有選模型時回傳原因；本機模型不需要金鑰） */
function apiProblem(s) {
  const model = ((s[s.provider] || {}).model || '').trim();
  const local = s.provider === 'openai' && /\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(s.openai?.base_url || '');
  if (!local && !store.keyStatus()[s.provider]?.set) return '尚未設定 API 金鑰';
  if (!model) return '尚未選擇模型';
  return '';
}
route('POST', '/api/bigworlds/organize-rules', async (req, res) => {
  const body = await readJsonBody(req);
  const settings = store.getSettings();
  const members = [];
  for (const m of Array.isArray(body.members) ? body.members : []) {
    if (!m || m.sys_mode === 'none') continue; // 不套用的角色沒有規則要整理
    let ch;
    try { ch = store.getCharacter(String(m.id)); } catch { continue; }
    const rules = m.sys_mode === 'custom' ? String(m.sys_custom || '') : ch.data.system_prompt || '';
    if (rules.trim()) members.push({ ref: `M${members.length + 1}`, id: ch.id, name: ch.data.name, rules });
  }
  const messages = organize.buildMessages(body.world_prompt, members, { main: settings.main_prompt, world: settings.world_prompt });
  const info = {
    problem: apiProblem(settings), provider: settings.provider, model: (settings[settings.provider] || {}).model || '',
    members: members.map(m => ({ id: m.id, name: m.name })), input_tokens: organize.estimate(messages),
  };
  if (body.estimate_only) return send(res, 200, info);
  if (info.problem) return send(res, 400, { error: `${info.problem}，請先到「設定 → API 設定」設定好再整理` });
  if (!members.length) return send(res, 400, { error: '沒有需要整理的角色規則（角色卡沒有系統提示，或都設成「不套用」）' });
  let out = '', reasoning = '';
  const ac = new AbortController();
  // 關掉預覽或視窗：停止生成。要聽 res 的 close：新版 Node 讀完請求內容時 req 就已經觸發過 close，之後取消不會再通知
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  // 回應上限至少 8192：思考型模型的思考也算在裡面，太小會只想完、沒寫出結果
  let r;
  try {
    r = await streamChat({ signal: ac.signal, settings: { ...settings, temperature: 0.2, max_tokens: Math.max(settings.max_tokens || 0, 8192) },
      messages, onText: t => { out += t; }, onReasoning: t => { reasoning += t; } });
  } catch (err) {
    if (ac.signal.aborted) return; // 使用者取消（關掉預覽）：正常結束，畫面那邊已經不在等回應
    throw err;
  }
  // 最近一次的原始回覆存在 data/organize-last.txt（只是暫存，整理失敗時用來查原因；下次整理會覆蓋）
  try {
    fs.writeFileSync(path.join(path.dirname(WINDOW_FILE), 'organize-last.txt'),
      `時間：${new Date().toLocaleString('zh-TW', { hour12: false })}\n模型：${info.model}\n結束原因：${r.stop_reason || '（未提供）'}\n\n===== 回覆 =====\n${out}\n\n===== 思考內容 =====\n${reasoning || '（無）'}\n`);
  } catch { /* 存不了不影響整理 */ }
  const parsed = organize.parseResult(out, members.map(m => m.ref), { stopReason: r.stop_reason, reasoning });
  send(res, 200, {
    ...info, usage: r.usage || null, shared: parsed.shared, conflicts: parsed.conflicts,
    // keep 為 null：AI 沒有回傳這位角色的結果（套用時保留原本的內容）
    results: members.map(m => ({ id: m.id, name: m.name, original: m.rules, keep: m.ref in parsed.keep ? parsed.keep[m.ref] : null })),
  });
});
route('GET', '/api/bigworlds/:id/cover', (req, res, p) => {
  sendFile(res, store.getBigWorldCoverPath(p.id) || path.join(PUBLIC, 'world-cover.svg'));
});

// 世界書
route('GET', '/api/worlds', (req, res) => send(res, 200, store.listWorlds()));
route('POST', '/api/worlds', async (req, res) => {
  const body = await readJsonBody(req);
  const book = normalizeBook(body.entries || body.name ? body : { entries: [] }) || { entries: [] };
  book.name = body.name || book.name || '新世界書';
  send(res, 200, { id: store.saveWorld(null, book) });
});
route('POST', '/api/worlds/import', async (req, res) => {
  const buf = await readBody(req);
  let obj;
  if (png.isPng(buf)) obj = normalizeCard(png.extractCard(buf)).character_book;
  else {
    try { obj = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw Object.assign(new Error('JSON 格式錯誤'), { status: 400 }); }
    if (obj.data && obj.data.character_book) obj = obj.data.character_book; // 從角色卡取出內嵌世界書
  }
  let book;
  try { book = obj && typeof obj === 'object' ? normalizeBook(obj) : null; } catch { book = null; }
  if (!book || !Object.keys(book.entries || {}).length) throw Object.assign(new Error('檔案中沒有世界書資料（找不到任何條目）'), { status: 400 });
  let fname = '匯入的世界書';
  try { fname = decodeURIComponent(req.headers['x-filename'] || fname); } catch { /* 檔名格式錯誤：用預設名稱 */ }
  book.name = book.name || fname.replace(/\.(json|png)$/i, '');
  send(res, 200, { id: store.saveWorld(null, book) });
});
route('GET', '/api/worlds/:id', (req, res, p) => send(res, 200, store.getWorld(p.id)));
route('PUT', '/api/worlds/:id', async (req, res, p) => {
  store.getWorld(p.id);
  const body = await readJsonBody(req);
  const book = normalizeBook(body);
  if (!book) throw Object.assign(new Error('世界書格式錯誤'), { status: 400 });
  book.name = body.name || '未命名';
  store.saveWorld(p.id, book);
  send(res, 200, store.getWorld(p.id));
});
route('DELETE', '/api/worlds/:id', (req, res, p) => { store.deleteWorld(p.id); send(res, 200, { ok: true }); });
route('GET', '/api/worlds/:id/export', (req, res, p) => {
  const w = store.getWorld(p.id);
  const { id, ...book } = w;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(w.name)}.json` });
  res.end(JSON.stringify(book, null, 2));
});

// ---------- 請求來源檢查 ----------
// 1. Host 必須是本機：擋掉 DNS rebinding（惡意網域把自己解析成 127.0.0.1，假裝是同一個網站）
// 2. 瀏覽器帶來的 Origin 必須是酒館自己：擋掉你瀏覽其他網站時，那個網頁偷偷對酒館送出請求
// 設成 HOST=0.0.0.0 開放區網時，Host 會是電腦的區網位址，只檢查 Origin
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** 這個請求是不是從這台電腦自己發出的（看連線的來源位址，不看可以偽造的標頭） */
function isLoopback(req) { return /^(127\.|::1$|::ffff:127\.)/.test(req.socket?.remoteAddress || ''); }
const hostName = h => String(h || '').toLowerCase().replace(/:\d+$/, '');
function requestAllowed(req, isApi) {
  if (['127.0.0.1', 'localhost', '::1'].includes(HOST) && !LOCAL_HOSTS.has(hostName(req.headers.host))) return false;
  if (!isApi) return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // 非瀏覽器的工具（例如 curl）或同源的 GET 不帶 Origin
  try { return new URL(origin).host === String(req.headers.host || '').toLowerCase(); } catch { return false; } // 包含 Origin: null
}

// ---------- 伺服器 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // 格式錯誤的網址（例如 /%E0）：回傳 400，不能讓伺服器當掉（任何網頁都能送出這種請求）
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: '網址格式錯誤' }); }
    if (!requestAllowed(req, pathname.startsWith('/api/'))) {
      console.warn(`[安全] 已拒絕來源不明的請求：${req.method} ${pathname}（Host: ${req.headers.host || '-'}，Origin: ${req.headers.origin || '-'}）`);
      return send(res, 403, { error: '拒絕來自其他網站的請求' });
    }
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        return await r.handler(req, res, params, url.searchParams);
      }
      return send(res, 404, { error: '找不到 API' });
    }
    // 靜態檔案
    const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
    sendFile(res, file, file.endsWith('.html') ? { 'Content-Security-Policy': CSP } : {});
  } catch (err) {
    if (err.status === 502) console.warn('[API] ' + err.message);
    else if (!err.status || err.status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    send(res, err.status || 500, { error: err.message || String(err) });
  }
});

const urlFor = port => `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${port}`;
// 認出「這個埠上的是不是 AI 酒館」用（埠被佔用時，問一下是不是另一個酒館在執行）
route('GET', '/api/ping', (req, res) => send(res, 200, { app: 'ai-tavern' }));
/**
 * 這個埠上的是不是 AI 酒館：問 /api/ping（舊版沒有這個 API，再看 /api/settings 的格式）。
 * 等最多 1.5 秒；連不上、回應不對都當成別的程式
 */
async function isTavernAt(port) {
  const get = async p => {
    const res = await fetch(urlFor(port) + p, { signal: AbortSignal.timeout(1500) });
    return res.ok ? res.json() : null;
  };
  try { if ((await get('/api/ping'))?.app === 'ai-tavern') return true; } catch { /* 繼續試舊版的判斷 */ }
  try { const j = await get('/api/settings'); return !!(j && j.settings && typeof j.settings === 'object' && 'personas' in j.settings && 'backup_keep' in j.settings); }
  catch { return false; }
}
/** 試著在這個埠啟動：成功回傳 true，埠被佔用回傳 false，其他錯誤丟出 */
const tryListen = port => new Promise((resolve, reject) => {
  const onErr = err => { server.off('listening', onOk); err.code === 'EADDRINUSE' ? resolve(false) : reject(err); };
  const onOk = () => { server.off('error', onErr); resolve(true); };
  server.once('error', onErr);
  server.once('listening', onOk);
  server.listen(port, HOST);
});
const PORT_TRIES = 20; // 8000 被別的程式佔用時，往後找 8001～8019
/**
 * resolve({ url, existing })：existing = true 表示已有另一個 AI 酒館在執行（直接打開它的視窗）。
 * 埠被佔用時先確認是不是酒館：是就打開它；不是（例如 SillyTavern 預設也用 8000、或其他開發工具）就改用下一個空的埠
 */
const ready = (async () => {
  let port = PORT;
  for (let i = 0; ; i++) {
    if (await tryListen(port)) break;
    if (await isTavernAt(port)) {
      console.log(`\n  埠 ${port} 上已經有 AI 酒館在執行，直接開啟它的視窗。\n`);
      return { url: urlFor(port), existing: true };
    }
    if (i + 1 >= PORT_TRIES) throw new Error(`埠 ${PORT}～${port} 都被其他程式佔用，請關掉其中一些程式，或用環境變數 PORT 指定別的埠`);
    console.log(`  埠 ${port} 被其他程式佔用（不是 AI 酒館），改用 ${port + 1}…`);
    port++;
  }
  const URL_BASE = urlFor(port);
  {
    if (port !== PORT) console.log(`\n  注意：埠 ${PORT} 被其他程式佔用，這次改用 ${port}。在瀏覽器打開時請用下面的網址。`);
    console.log(`\n  AI 酒館已啟動： ${URL_BASE}\n`);
    // 備份實際存放的位置（資料用 TAVERN_DATA_DIR 放在別處時也正確）：在程式資料夾裡就顯示相對路徑
    const backupPath = name => {
      const p = path.join(backup.BACKUP_DIR, name), rel = path.relative(__dirname, p);
      return rel.startsWith('..') || path.isAbsolute(rel) ? p : rel.replace(/\\/g, '/');
    };
    // 舊版的資料結構：整理成每個角色／世界一個資料夾（在處理任何請求之前同步完成）
    try {
      const n = store.migrateLayout();
      if (n) console.log(`  已把 ${n} 個角色／世界整理成各自的資料夾（對話一起搬進去；舊資料的原樣複本在 ${backupPath('before-folder-layout-*')}）`);
    } catch (e) { console.warn('[整理資料夾] 失敗：', e.message); }
    // 程式預設值改過的欄位：舊資料維持原本的值（例如 Temperature 0.9），不要在不知不覺中跟著變
    try { const p = store.pinChangedDefaults(); if (p.length) console.log(`  已保留原本的設定值：${p.join('、')}（程式的預設值改了，但你的設定維持不變）`); }
    catch (e) { console.warn('[設定] 保留原本的設定值失敗：', e.message); }
    // 舊版的對話沒有固定使用者設定檔（一律跟著設定頁）：一次性地固定到目前使用中的
    try { store.ensurePersonas(); const n = store.pinChatPersonas(); if (n) console.log(`  已把 ${n} 段對話固定使用目前的使用者設定檔（之後在設定頁切換不會影響它們）`); }
    catch (e) { console.warn('[設定] 固定對話的使用者設定檔失敗：', e.message); }
    // 一定有一個使用中的模型設定檔：舊資料沒有的話，用目前的設定（含金鑰）建立一個
    try { const p = store.ensureProfile(); if (p) console.log(`  已用目前的設定建立模型設定檔「${p.name}」`); }
    catch (e) { console.warn('[設定] 建立模型設定檔失敗：', e.message); }
    // 每次啟動自動備份一次（和上一份完全相同時略過），並刪掉超過保留份數的舊備份
    setImmediate(() => {
      try {
        const name = backup.startupBackup(store.getSettings().backup_keep);
        if (name) console.log(`  已自動備份：${backupPath(name)}`);
      } catch (e) { console.warn('[備份] 自動備份失敗：', e.message || e); }
    });
  }
  return { url: URL_BASE, existing: false };
})();

/**
 * 結束伺服器前的收尾（關閉視窗時由 launch.js 呼叫）：
 * 1. 停下所有生成，已經產生的內容照樣存檔（每段最多等 5 秒）
 * 2. 中止背景整理記憶
 * 3. 再備份一次（程式開著好幾天時，關閉前的資料也有備份；和上一份相同時略過）
 */
async function shutdown() {
  const timeout = ms => new Promise(r => setTimeout(r, ms));
  const running = [...jobs.values()];
  for (const job of running) job.ac.abort();
  await Promise.race([Promise.allSettled(running.map(j => j.done)), timeout(5000)]);
  await Promise.race([stopMemoryJobs(), timeout(3000)]);
  try {
    const keep = store.getSettings().backup_keep;
    if (keep > 0) { const name = backup.startupBackup(keep); if (name) console.log(`  結束前已備份：${path.join(backup.BACKUP_DIR, name)}`); }
  } catch (e) { console.warn('[備份] 結束前備份失敗：', e.message || e); }
}

module.exports = { server, ready, WINDOW_FILE, lastHeartbeat: () => lastBeat, shutdown };
