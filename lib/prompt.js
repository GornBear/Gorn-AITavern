// 提示詞組裝：系統提示 → 世界書(角色前) → 角色設定 → 世界書(角色後) → 使用者人設 → 範例對話 → 聊天紀錄(含深度注入) → 後置指令
'use strict';
const { statusDefOf, statusNote, worldStatusNote, memberStatus, hasStatusFields } = require('./status');

/** 粗估 token：中日韓字元約 1 token，其餘約 3.5 字元 1 token */
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[　-鿿가-힯＀-￯]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 3.5) + 4;
}

function substitute(text, ctx) {
  if (!text) return '';
  const now = new Date();
  // 替換值用函式回傳：名字裡有 $&、$$ 這類符號時，字串形式會被當成特殊替換語法
  const val = v => () => String(v ?? '');
  return String(text)
    .replace(/\{\{original\}\}/gi, val(ctx.original))
    .replace(/\{\{char\}\}|<BOT>/gi, val(ctx.char))
    .replace(/\{\{user\}\}|<USER>/gi, val(ctx.user))
    .replace(/\{\{time\}\}/gi, val(now.toLocaleTimeString('zh-TW')))
    .replace(/\{\{date\}\}/gi, val(now.toLocaleDateString('zh-TW')))
    .replace(/\{\{weekday\}\}/gi, val(now.toLocaleDateString('zh-TW', { weekday: 'long' })));
}

/**
 * 世界書的正規表示式關鍵字（/…/）：網路上下載的世界書可能含有會「災難性回溯」的寫法（例如 /^(a+)+$/），
 * 比對時會讓整個伺服器卡住好幾秒到好幾分鐘。所以：
 * - 表示式最長 200 字；巢狀的重複（( … + … )+、( … * … )*、(…|…)+ 之類）與反向參照一律不比對（這個關鍵字不會觸發）
 * - 被比對的文字只取最後 20000 字（掃描深度內的最近訊息，通常遠小於這個長度）
 * - 最後防線：比對放在獨立的執行環境裡、最多跑 50 毫秒（擋不完的寫法很多，例如並排的 .*.*.*、a*a*a*b），
 *   超過就中止，這個關鍵字之後也不再比對。一般的比對每次只多約 0.15 毫秒
 */
const REGEX_MAX = 200, REGEX_TEXT_MAX = 20000, REGEX_TIMEOUT = 50;
const vm = require('vm');
const regexSandbox = vm.createContext(Object.create(null));
/** 有時間上限的 re.test(text)：回傳 true／false，超過時間回傳 null */
function timedTest(re, text) {
  regexSandbox.re = re; regexSandbox.s = text;
  try { return !!vm.runInContext('re.test(s)', regexSandbox, { timeout: REGEX_TIMEOUT }); }
  catch (e) { return e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? null : false; }
  finally { regexSandbox.re = null; regexSandbox.s = null; }
}
const NESTED_QUANT = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]|\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[+*{]/;
const BACKREF = /\\[1-9]|\\k</;
const regexCache = new Map();
function safeRegex(src, flags) {
  const k = flags + '/' + src;
  if (regexCache.has(k)) return regexCache.get(k);
  let re = null;
  if (src.length <= REGEX_MAX && !NESTED_QUANT.test(src) && !BACKREF.test(src)) {
    try { re = new RegExp(src, flags.replace(/[gy]/g, '')); } catch { re = null; }
  }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(k, re);
  return re;
}
function keyMatches(key, text, caseSensitive) {
  key = key.trim();
  if (!key) return false;
  const m = key.match(/^\/(.+)\/([gimsuy]*)$/);
  if (m) {
    const re = safeRegex(m[1], m[2]);
    if (!re) return false; // 不安全或寫錯的正規表示式：不觸發
    const hit = timedTest(re, text.length > REGEX_TEXT_MAX ? text.slice(-REGEX_TEXT_MAX) : text);
    if (hit === null) { // 跑太久：記下來，之後不再比對這個關鍵字
      regexCache.set(m[2] + '/' + m[1], null);
      console.warn(`[世界書] 正規表示式關鍵字 /${m[1].slice(0, 60)}/ 比對超過 ${REGEX_TIMEOUT} 毫秒，已停用（這個關鍵字不會觸發）`);
      return false;
    }
    return hit;
  }
  return caseSensitive ? text.includes(key) : lower(text).includes(key.toLowerCase());
}
// 同一段文字只轉一次小寫（每個條目、每個關鍵字都要比對同一段聊天紀錄）
let lowerSrc = null, lowerOut = '';
const lower = t => { if (t !== lowerSrc) { lowerSrc = t; lowerOut = t.toLowerCase(); } return lowerOut; };

const WI_MIN_BUDGET = 1024; // 世界書 Token 預算的下限（畫面上的最小值也是這個）

/** 依關鍵字掃描世界書，回傳被觸發的條目 */
function scanWorldInfo(books, history) {
  const entries = [];
  // 照每本世界書填的數字（沒填用預設 4 則／2048）；同時用好幾本時取最大的，一起掃描、一起算預算
  // Token 預算最少 WI_MIN_BUDGET：太小時一般條目單獨就超過，會全部無聲無息地被略過（匯入的舊資料也照這個下限）
  // 遞迴各本照自己的設定：開啟遞迴掃描的世界書，條目才能被「其他已插入條目的內容」觸發；
  // 條目層級：exclude_recursion＝不會被遞迴觸發，prevent_recursion＝內容不觸發其他條目
  let scanDepth = 0, budget = 0;
  for (const b of books) {
    if (!b) continue;
    scanDepth = Math.max(scanDepth, Number(b.scan_depth) > 0 ? Number(b.scan_depth) : 4);
    budget = Math.max(budget, WI_MIN_BUDGET, Number(b.token_budget) > 0 ? Number(b.token_budget) : 2048);
    for (const e of b.entries || []) if (e.enabled !== false && e.content) entries.push({ ...e, _book: b.name || '', _recursive: !!b.recursive_scanning });
  }
  if (!entries.length) return [];

  const chatText = history.slice(-scanDepth).map(m => m.content).join('\n');
  let recText = ''; // 已插入條目的內容（可以觸發遞迴）
  const active = new Set();
  const hit = (e, text) => {
    if (!(e.keys || []).some(k => keyMatches(k, text, e.case_sensitive))) return false;
    if (e.selective && (e.secondary_keys || []).length) return e.secondary_keys.some(k => keyMatches(k, text, e.case_sensitive));
    return true;
  };
  const check = (e, pass) => {
    if (active.has(e)) return false;
    if (e.constant) return true;
    if (pass === 0) return hit(e, chatText);
    return e._recursive && !e.exclude_recursion && hit(e, chatText + '\n' + recText);
  };
  const anyRecursive = entries.some(e => e._recursive);
  for (let pass = 0; pass < (anyRecursive ? 3 : 1); pass++) {
    const added = entries.filter(e => check(e, pass));
    if (!added.length) break;
    added.forEach(e => active.add(e));
    const more = added.filter(e => !e.prevent_recursion).map(e => e.content).join('\n');
    if (!more) break;
    recText += '\n' + more;
  }

  const sorted = [...active].sort((a, b) => (b.insertion_order || 0) - (a.insertion_order || 0));
  const out = [];
  let used = 0;
  for (const e of sorted) {
    const t = estimateTokens(e.content);
    if (used + t > budget && !e.constant) continue;
    used += t;
    out.push(e);
  }
  return out.sort((a, b) => (a.insertion_order || 0) - (b.insertion_order || 0));
}

/** 解析 mes_example（以 <START> 分段） */
function parseExamples(text) {
  if (!text || !text.trim()) return [];
  return text.split(/<START>/i).map(s => s.trim()).filter(Boolean);
}

/**
 * 共用的組裝流程：系統提示 → 世界書(前) → 角色區塊 → 世界書(後) → 使用者人設 → 範例 → 長期記憶 → 聊天紀錄(含深度注入) → 後置指令
 * @returns {{ messages: {role:'system'|'user'|'assistant', content:string}[], info: object }}
 */
/**
 * 聊天紀錄裡的 <details> 區塊（狀態欄等）只保留最近 keep 則，更早的在送出前移除。
 * 模型只需要最近的狀態就能延續，舊的狀態欄很佔 token；畫面與存檔不受影響。
 */
const DETAILS_RE = /<details[\s\S]*?<\/details>/gi;
function trimOldDetails(history, keep) {
  keep = Math.max(3, Number(keep) || 3);
  let seen = 0;
  const out = history.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (!/<details/i.test(out[i].content || '')) continue;
    if (++seen > keep) out[i] = { ...out[i], content: out[i].content.replace(DETAILS_RE, '').replace(/\n{3,}/g, '\n\n').trim() };
  }
  return out;
}

/**
 * wiInTail：觸發的世界書條目全部放到最後（聊天紀錄之後），讓前面的內容在同一輪中保持不變，本機模型才能重用快取
 * tailReserve：計算聊天紀錄能放多少時，最後一段至少預留這麼多 token（讓不同發言者裁出一樣的聊天紀錄）
 */
/** 你這一側訊息的身分標註：你扮演的 NPC、你寫的旁白（一般的訊息沒有標註） */
const npcLabel = (m, user) => (m.npc ? `${m.npc}（NPC，由${user}扮演）：` : m.narration ? `（旁白，由${user}撰寫）` : '');
/**
 * 模擬思考（對話設定的思考選「模擬」）：要求不會思考的模型先在 <thinking> 裡簡短規劃再回覆。
 * 用 <thinking> 而不是 <think>：有些模型（例如 Qwen 系列）把 <think> 當成特殊符號，平台輸出時會濾掉標籤，思考就混進正文。
 * 放在最後面，模型最容易照做；思考內容在畫面上收進思考區塊，之後送出的聊天紀錄會拿掉（不會越積越長）
 */
const simThinkNote = (ctx, isWorld) => '[回覆前先思考]\n'
  + '正式回覆之前，先在 <thinking> 與 </thinking> 之間簡短思考（約 100～300 字，條列即可）：\n'
  + `- 目前的情境，以及 ${ctx.user} 這次的意圖\n`
  + `- 相關的角色設定、${isWorld ? '世界觀、各角色的立場與知識界線' : '世界觀與角色的知識界線'}\n`
  + '- 劇情和前面有沒有矛盾、有沒有該延續的伏筆\n'
  + '- 這次回應要寫什麼、用什麼語氣（保持角色，不要 OOC）\n'
  + `寫完一定要加上 </thinking>，再接著寫正式回覆。正式回覆裡不要提到思考的內容，也不要替 ${ctx.user} 說話或決定行動。`;
/**
 * 對話語言（設定頁「提示詞設定」最上方）：每個選項的語言提醒，用該語言寫，模型比較容易照做。
 * 放在送出內容的最後面：只寫在系統提示開頭時，思考型模型把思考預算調低後常會漏掉，被其他語言的角色卡帶著走
 */
const LANGUAGES = {
  'zh-TW': '【語言】正文與思考過程都使用台灣用語的繁體中文。角色卡、世界書或聊天紀錄裡出現英文或其他語言時也一樣；只有人名、地名等專有名詞可以保留原文。',
  'zh-CN': '【语言】正文与思考过程都使用简体中文。角色卡、世界书或聊天记录里出现英文或其他语言时也一样；只有人名、地名等专有名词可以保留原文。',
  en: '[Language] Write both your reply and your thinking in English, even when the character cards, lorebooks, or chat history are in another language. Only proper nouns such as personal names and place names may stay in their original form.',
  ja: '【言語】本文も思考過程もすべて日本語で書いてください。キャラクターカード、ワールドブック、チャット履歴に他の言語が含まれていても同様です。人名・地名などの固有名詞のみ原文のままで構いません。',
};
/** 語言提醒：選了「自訂」（custom）時用你在設定頁改寫的文字（language_custom），其他用 LANGUAGES 的預設文字 */
const languageNote = settings => settings.reply_language === 'custom'
  ? String(settings.language_custom || '').trim()
  : LANGUAGES[settings.reply_language] || '';
const TRIM_STEP = 8; // 聊天紀錄太長時，舊訊息一次捨棄 8 則（開頭比較少變動，快取比較容易重用）
function assemble({ ctx, system, charBlocks, examples = [], post = [], history, settings, books, memory, wiInTail = false, tailReserve = 0, isWorld = false, language = true }) {
  const sub = t => substitute(t, ctx);
  // 你扮演的 NPC、你寫的旁白：在你這一側的訊息前標上身分，模型才不會當成你的角色說的（畫面與存檔不變）
  history = trimOldDetails(history, settings.keep_status).map(m => {
    const lbl = m.role === 'user' ? npcLabel(m, ctx.user) : '';
    return lbl ? { ...m, content: lbl + m.content, _lbl: true } : m;
  });
  const wi = scanWorldInfo(books, history);
  const wiBefore = wi.filter(e => e.position === 'before_char').map(e => sub(e.content));
  const wiAfter = wi.filter(e => e.position === 'after_char').map(e => sub(e.content));
  const wiDepth = wiInTail ? [] : wi.filter(e => e.position === 'at_depth');
  const wiTail = wiInTail ? wi.map(e => sub(e.content)) : [];

  const blocks = [system];
  if (!wiInTail && wiBefore.length) blocks.push('[世界資訊]\n' + wiBefore.join('\n'));
  blocks.push(...charBlocks);
  if (!wiInTail && wiAfter.length) blocks.push('[世界資訊]\n' + wiAfter.join('\n'));
  if (settings.user_persona) blocks.push(`[${ctx.user} 的人設]\n` + sub(settings.user_persona));
  // 這段對話有你扮演的 NPC、或你寫的旁白時才加的說明（applyChatSettings 填入 chat_npcs / chat_narration）。
  // 主要系統提示與大世界提示不再寫 NPC 規則：只在真的用到時說一次，而且列出實際的名字
  const npcs = (settings.chat_npcs || []).filter(Boolean);
  if (npcs.length) blocks.push(`[由 ${ctx.user} 扮演的 NPC]\n${npcs.join('、')}\n`
    + `這些 NPC 的台詞與行動由 ${ctx.user} 決定，聊天紀錄中標註為「（NPC，由${ctx.user}扮演）」。`
    + (isWorld ? '他們不是這個世界的登場角色（不在登場角色名單裡）。' : '')
    + `可以和他們互動、對他們說話，但不要替他們說話或決定行動，也不要把他們說的話當成 ${ctx.user} 本人說的。`);
  if (settings.chat_narration) blocks.push(`[${ctx.user} 撰寫的旁白]\n聊天紀錄中標註「（旁白，由${ctx.user}撰寫）」的段落是 ${ctx.user} 寫的場景描述，請視為已經發生的事，接著演下去；不是 ${ctx.user} 的角色說的話。旁白寫到角色的動作、處境或感受時，那就是角色剛剛做的事、現在的狀態，要從那裡延續（演出接下來的發展與反應），不要忽略、推翻或重做一遍。`);
  if (examples.length) blocks.push('[對話範例，僅供參考語氣與風格]\n' + examples.join('\n---\n'));
  // 長期記憶：放在角色設定最後、緊接聊天紀錄之前
  const mem = settings.memory_enabled !== false && memory && memory.trim() ? memory.trim() : '';
  if (mem) blocks.push('[長期記憶：這段對話到目前為止的劇情摘要與重點，請保持前後一致]\n' + mem);

  const head = [{ role: 'system', content: blocks.filter(Boolean).join('\n\n') }];
  const tail = [...(wiTail.length ? ['[世界資訊]\n' + wiTail.join('\n')] : []), ...post.filter(Boolean),
    ...(settings.sim_think ? [simThinkNote(ctx, isWorld)] : []),
    // 語言提醒放在最後面：模型最先注意到（只寫在系統提示開頭時，思考很短的模型容易漏掉）
    ...(language && languageNote(settings) ? [languageNote(settings)] : [])]
    .map(t => ({ role: 'system', content: t }));

  // 聊天紀錄：從最新往回塞，直到超過上下文預算
  // token_scale：這段對話「實際用量 ÷ 估算值」的比例（由 API 回傳的用量校正）；把上下文長度換算成估算值的單位
  const scale = Number(settings.token_scale) > 0 ? Number(settings.token_scale) : 1;
  const reserve = (settings.max_tokens || 1024);
  const tailTokens = tail.reduce((s, m) => s + estimateTokens(m.content), 0);
  let budget = ((settings.context_tokens || 8000) - reserve) / scale
    - head.reduce((s, m) => s + estimateTokens(m.content), 0)
    - Math.max(tailTokens, tailReserve)
    - wiDepth.reduce((s, e) => s + estimateTokens(e.content), 0);
  // 固定的部分（系統提示、角色設定、世界書、記憶＋預留的回應）就已經超過上下文長度：多出多少（實際 tokens，約略）
  const overflow = budget < 0 ? Math.ceil(-budget * scale) : 0;
  // 扣掉固定部分後，上下文長度還留給聊天紀錄多少（實際 tokens，約略；還沒套用聊天紀錄上限）：用來提醒「上限送不滿」
  const historyRoom = Math.max(0, Math.floor(budget * scale));
  // 聊天紀錄上限（history_cap，實際 tokens；0 = 不限）：上下文長度設很大時，聊天紀錄也不會跟著送很多
  if (Number(settings.history_cap) > 0) budget = Math.min(budget, Number(settings.history_cap) / scale);
  const historyBudget = Math.max(0, Math.floor(budget));
  const historyTokens = history.map(m => estimateTokens(m.content));
  let kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const t = historyTokens[i];
    if (budget - t < 0 && kept.length) break;
    budget -= t;
    kept.unshift({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content, lbl: !!m._lbl });
  }
  // 放不下時，捨棄的舊訊息數湊成 TRIM_STEP 的倍數：聊天紀錄的開頭不會每多一則就跟著移動
  const dropped = history.length - kept.length;
  if (dropped > 0) {
    const drop = Math.min(history.length - 1, Math.ceil(dropped / TRIM_STEP) * TRIM_STEP);
    kept = kept.slice(drop - dropped);
  }
  const historyFrom = history.length - kept.length; // 實際送出的第一則在 history 裡的位置（更早的被裁掉）
  // 連續好幾則你這一側的訊息（例如你的角色說一句、NPC 再說一句）合併成一則：
  // 有些模型要求「使用者／AI」一定要輪流，連續兩則使用者訊息會出錯。混著 NPC 或旁白時，你自己的那句也標上名字
  const joined = [];
  for (const m of kept) {
    const prev = joined[joined.length - 1];
    if (prev && prev.role === 'user' && m.role === 'user') prev.group.push(m);
    else joined.push(m.role === 'user' ? { role: 'user', group: [m] } : m);
  }
  kept = joined.map(m => {
    if (!m.group) return { role: m.role, content: m.content };
    const any = m.group.some(x => x.lbl);
    return { role: 'user', content: m.group.map(x => (any && !x.lbl ? `${ctx.user}：${x.content}` : x.content)).join('\n\n') };
  });

  // 深度注入（depth 0 = 最後一則訊息之後）
  for (const e of wiDepth.sort((a, b) => b.depth - a.depth)) {
    const idx = Math.max(0, kept.length - (e.depth || 0));
    kept.splice(idx, 0, { role: 'system', content: sub(e.content) });
  }

  const messages = [...head, ...kept, ...tail];
  return {
    messages,
    info: {
      tokens: messages.reduce((s, m) => s + estimateTokens(m.content), 0),
      history_used: kept.filter(m => m.role !== 'system').length,
      history_total: history.length,
      history_from: historyFrom,
      memory_tokens: mem ? estimateTokens(mem) : 0,
      history_budget: historyBudget, // 聊天紀錄可以用的空間（估算值）
      history_room: historyRoom,
      overflow, // > 0：固定的部分已經超過上下文長度（只會送出最後一則訊息，API 也可能報錯）
      context_tokens: settings.context_tokens || 8000,
      history_tokens: historyTokens, // 每則聊天紀錄的估算 token（和傳進來的 history 一一對應；壓縮時用來決定切點）
      world_entries: wi.map(e => ({ book: e._book, comment: e.comment || (e.keys || []).join(', '), position: e.position })),
    },
  };
}

/** 單一角色的提示詞 */
function buildPrompt({ card, history, settings, books, memory, status = null, expressions = [] }) {
  const ctx = { char: card.name, user: settings.user_name || 'User' };
  const sub = t => substitute(t, ctx);

  // 系統提示：主要系統提示 + 角色卡系統提示一起送出
  // 角色卡的系統提示若含 {{original}}，主要系統提示就放在那個位置（不重複）
  const mainPrompt = sub(settings.main_prompt || '').trim();
  let system = mainPrompt;
  const cardSys = (card.system_prompt || '').trim();
  if (settings.use_card_system_prompt && cardSys) {
    const cardText = substitute(cardSys, { ...ctx, original: mainPrompt }).trim();
    system = /\{\{original\}\}/i.test(cardSys) ? cardText
      : [mainPrompt, `[${ctx.char} 的角色卡系統提示]\n${cardText}`].filter(Boolean).join('\n\n');
  }

  const charBlocks = [];
  if (card.description) charBlocks.push(`[${ctx.char} 的角色設定]\n` + sub(card.description));
  if (card.personality) charBlocks.push(`[${ctx.char} 的個性]\n` + sub(card.personality));
  if (card.scenario) charBlocks.push('[情境]\n' + sub(card.scenario));

  return assemble({
    ctx, system, charBlocks,
    examples: parseExamples(card.mes_example).map(sub),
    // 狀態欄（角色卡有設定欄位時）：輸出格式說明＋目前狀態，和後置指令放在一起（聊天紀錄之後；算進 tail 的 token）
    // status：目前狀態（currentStatus 找到的那一份，沒有就是 null＝用初始值）；expressions：表情名稱（有表情圖時要求 <expression>）
    post: [card.post_history_instructions ? sub(card.post_history_instructions) : '', sub(statusNote(statusDefOf(card), status, expressions))],
    history, settings, books, memory,
  });
}

/**
 * 大世界（多角色）的提示詞。
 * 每個成員讀取「角色設定、個性、台詞範例」與（依設定）角色卡的系統提示；不放入各角色的開場白與情境。
 * members: [{ id, sys_mode, sys_custom, public_info, card }]，card 是需要時才讀取的角色卡資料
 *
 * 旁白統一（turn 為 null）：所有角色的完整設定放在系統訊息裡，一次寫出整個場景。
 *
 * 輪流發言（turn 有值）：為了讓同一輪的每次呼叫「開頭完全相同」，本機模型可以重用快取，結構是
 *   ［共用］系統提示 → 世界規則 → 所有角色的公開資訊 → 人設 → 長期記憶 → 聊天紀錄（不含狀態欄）
 *   ［這次專用，放在最後］世界書條目 → 後置指令 → 發言者的完整角色卡、知識界線、上一次的狀態欄、這一輪的指示
 * 發言的角色只拿到自己的完整角色卡；旁白與導演拿到所有人的（他們本來就知道全部）。
 */
function buildWorldPrompt({ world, members, history, settings, books, memory, turn, speakerName, status = null, current = null, present = null }) {
  const user = settings.user_name || 'User';
  const names = members.map(m => m.card.name);
  // 世界層級的文字：{{char}} 代表世界名稱，{{world}} 也可以用
  const ctx = { char: world.name, user };
  const wsub = t => substitute(String(t || '').replace(/\{\{world\}\}/gi, () => world.name || ''), ctx); // 用函式：名稱裡的 $ 照原樣
  const nameOf = id => (speakerName ? speakerName(id) : '旁白');

  /** 一個角色的完整設定（成員自己的 {{char}} 代表該角色） */
  const fullBlock = m => {
    const c = m.card;
    const csub = t => substitute(t, { char: c.name, user });
    const parts = [`[角色：${c.name}]`];
    if (c.description) parts.push('設定：\n' + csub(c.description));
    if (c.personality) parts.push('個性：\n' + csub(c.personality));
    // 台詞範例：決定角色的說話方式，對角色扮演很重要
    const ex = parseExamples(c.mes_example);
    if (ex.length) parts.push(`台詞範例（僅供參考 ${c.name} 的語氣與風格）：\n` + ex.map(csub).join('\n---\n'));
    // 角色卡的系統提示：完整套用／不套用／自訂（只留下影響角色扮演的規則）
    const rules = m.sys_mode === 'none' ? '' : m.sys_mode === 'custom' ? m.sys_custom : c.system_prompt;
    if (rules && rules.trim()) parts.push(`${c.name} 的角色卡規則（只適用於 ${c.name}）：\n` + csub(rules.replace(/\{\{original\}\}/gi, '')).trim());
    return parts.join('\n');
  };
  const worldHead = [
    wsub(settings.main_prompt || ''),
    wsub(settings.world_prompt || ''),
    // 世界設定（世界觀）放在共用的開頭：角色、旁白、導演都看得到，而且每次呼叫都相同，可以重用快取
    (world.setting || '').trim() ? `[世界「${world.name}」的世界設定]\n` + wsub(world.setting).trim() : '',
    world.system_prompt ? `[世界「${world.name}」的規則與文風]\n` + wsub(world.system_prompt) : '',
    names.length ? `[登場角色]\n${names.join('、')}` : '',
  ];
  const postHistory = world.post_history_instructions ? wsub(world.post_history_instructions) : '';

  // 狀態欄（世界卡有欄位、或成員有表情圖時）：說明＋目前狀態放在最後一段，共用的開頭不變。
  // 發言的角色只看到自己的狀態與玩家狀態；旁白、導演看到在場的所有角色（沒有在場紀錄時是全部）
  const sdef = status || { char_fields: [], user_fields: [] };
  const exprsOf = m => m.exprs || [];
  const hasStatus = hasStatusFields(sdef) || members.some(m => exprsOf(m).length);
  const brief = m => ({ id: m.id, name: m.card.name, exprs: exprsOf(m) });
  const here = Array.isArray(present) ? members.filter(m => present.includes(m.id)) : [];
  const shown = here.length ? here : members;
  const narratorNote = (list, opts) => (hasStatus ? substitute(worldStatusNote(sdef, current, list.map(brief), opts), { char: world.name, user }) : '');
  const selfNote = m => (hasStatus ? substitute(statusNote(sdef, memberStatus(current, m.id), exprsOf(m)), { char: m.card.name, user }) : '');

  // ---------- 旁白統一：一次寫出所有角色 ----------
  if (!turn) {
    const system = [...worldHead,
      `[角色知識的界線]\n每個角色只知道自己的設定，以及在劇情中親眼看到、親耳聽到、或被告知的事。不要讓角色知道其他角色的身世、秘密、能力或內心想法，除非劇情中已經說出口或表現出來。`,
    ].map(s => s.trim()).filter(Boolean).join('\n\n');
    return assemble({ ctx, system, charBlocks: members.map(fullBlock), post: [postHistory, narratorNote(members)], history, settings, books, memory, isWorld: true });
  }

  // ---------- 輪流發言 ----------
  const self = turn.speaker && turn.speaker !== 'narrator' ? members.find(m => m.id === turn.speaker) : null;
  const system = [...worldHead,
    `[角色知識的界線]\n每個角色只知道自己的設定，以及在劇情中親眼看到、親耳聽到、或被告知的事；其他角色的身世、秘密、能力與內心想法一概不知道，除非劇情中已經說出口或表現出來。聊天紀錄與長期記憶是作者視角的紀錄，角色只記得自己在場經歷的部分。輪到某個角色發言時，最後會附上只有他自己知道的完整設定。`,
  ].map(s => s.trim()).filter(Boolean).join('\n\n');
  // 共用區只放公開資訊（所有發言者看到的都一樣）
  const publicBlocks = members.map(m => {
    const pub = (m.public_info || '').trim();
    return `[角色：${m.card.name}]\n` + (pub ? `公開資訊：\n${substitute(pub, { char: m.card.name, user })}` : '公開資訊：只有名字與劇情中看到的言行。');
  });

  // 聊天紀錄標上發言者；<details>（狀態欄、內心活動）一律不放在共用區，改在最後只給該看的人
  const DETAILS = DETAILS_RE; // 和 trimOldDetails 同一個（只用在 replace／match，不受 lastIndex 影響）
  const hist = history.map(m => m.role === 'assistant'
    ? { ...m, content: `${nameOf(m.speaker)}：${String(m.content).replace(DETAILS, '').replace(/\n{3,}/g, '\n\n').trim()}` } : m);
  const lastDetails = id => {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role !== 'assistant' || (m.speaker || 'narrator') !== id) continue;
      const blocks = String(m.content).match(DETAILS);
      if (blocks) return blocks.join('\n');
    }
    return '';
  };

  // 這次專用的最後一段
  const name = nameOf(turn.speaker);
  const others = names.filter(n => n !== name);
  const tailParts = [];
  if (turn.director) {
    tailParts.push('[導演參考：所有角色的完整設定（只用來規劃，不會給角色看到）]\n' + members.map(fullBlock).join('\n\n'));
  } else if (!self) {
    // 旁白：知道所有角色，也看得到每個人最近的狀態欄
    tailParts.push('[旁白參考：所有角色的完整設定]\n' + members.map(fullBlock).join('\n\n'));
    const st = [...members.map(m => [m.card.name, lastDetails(m.id)]), ['旁白', lastDetails('narrator')]].filter(x => x[1]);
    if (st.length) tailParts.push('[最近的狀態欄]\n' + st.map(([n, d]) => `${n}：\n${d}`).join('\n'));
    tailParts.push(`現在由「旁白」發言：以第三人稱描寫並統整剛才的場景、角色們的動作與氣氛，必要時推進劇情；只描寫看得到、聽得到的事，不要揭露角色尚未說出口的秘密或身世。`
      + `可以替配角（不是這個世界角色的人，例如攤販、路人、家人朋友）寫動作與台詞，格式為 配角稱呼：「台詞」。`
      + `不要替這個世界的角色說新的台詞，也不要替 ${user} 說話或行動。開頭不要寫「旁白：」。`);
  } else {
    tailParts.push(`[現在輪到「${name}」發言。以下是只有 ${name} 自己知道的完整設定]\n` + fullBlock(self));
    tailParts.push(`${name} 只知道上面的設定，以及在劇情中親眼看到、親耳聽到、或被告知的事；不要讓 ${name} 說出或暗示其他角色才知道的秘密。`);
    const st = lastDetails(self.id);
    if (st) tailParts.push(`[${name} 上一次的狀態欄]\n${st}`);
    // 配角（攤販、路人、家人朋友等）由發言的角色順手帶出來：不然只能靠導演另外安排旁白，配角幾乎不會出現
    tailParts.push(`寫 ${name} 這一次的台詞、動作與神情，用 ${name} 自己的口吻。`
      + `場景裡的配角（攤販、店員、路人、家人朋友等不是這個世界角色的人）和 ${name} 互動時，可以一起寫出配角的動作與台詞，格式為 配角稱呼：「台詞」。`
      + (others.length ? `不要替${others.join('、')}或 ${user} 說話、行動或決定任何事；` : `不要替 ${user} 說話、行動或決定任何事；`)
      + `開頭不要寫「${name}：」。`
      + `\n不要每次都用問句把話題丟回給 ${user}；可以主動行動、做決定、推進眼前的事，在真的需要 ${user} 回應時才停下。`);
  }
  if (turn.note) tailParts.push(turn.note);
  // 狀態欄：導演只看目前狀態（規劃用，不寫狀態）；旁白可以寫好幾個角色；角色只寫自己的
  tailParts.push(turn.director ? narratorNote(shown, { director: true }) : !self ? narratorNote(shown) : selfNote(self));

  // 預留最後一段的空間：以「所有角色完整設定＋所有角色的狀態欄」估計，讓每位發言者裁出的聊天紀錄都一樣
  const tailReserve = estimateTokens(members.map(fullBlock).join('\n\n')) + estimateTokens(narratorNote(members)) + 1500;
  return assemble({
    ctx, system, charBlocks: publicBlocks,
    post: [turn.director ? '' : postHistory, tailParts.filter(Boolean).join('\n\n')],
    history: hist, settings, books, memory, wiInTail: true, tailReserve, isWorld: true,
    language: !turn.director, // 導演只寫規劃（格式本身就是中文），不加語言提醒
  });
}

/**
 * 聊天紀錄要從第幾則開始送：之前的舊對話已經「壓縮」進記憶（memory_cut，只在壓縮時移動，提示詞開頭才不會一直變）。
 * 一定不超過記憶實際整理到的地方（memory_upto）；關閉記憶、還沒有記憶時從頭送。
 */
function memoryCutIndex(chat, settings) {
  if (!settings.memory_enabled || !String(chat.memory || '').trim()) return 0;
  return Math.max(0, Math.min(chat.memory_cut || 0, chat.memory_upto || 0, chat.messages.length));
}

module.exports = { buildPrompt, buildWorldPrompt, scanWorldInfo, estimateTokens, substitute, trimOldDetails, memoryCutIndex, npcLabel, LANGUAGES, languageNote };
