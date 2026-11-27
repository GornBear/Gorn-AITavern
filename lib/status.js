// 狀態欄（AI 酒館自己的擴充）：欄位定義的整理與初始值。設計稿：docs/狀態欄設計稿.md
// 欄位定義存在角色卡 extensions.ai_tavern_status：{ char_fields: [...], user_fields: [...] }
// 每個欄位：{ key, name, type: 'text'|'number', max?, hint, initial }
// 狀態的數值存在 assistant 訊息的 swipe_status（和 swipes 一一對應）：[{ char: { key: 值 }, user: { key: 值 }, edited }]
'use strict';

const STATUS_KEY = 'ai_tavern_status';
const LIMITS = { fields: 12, name: 20, hint: 200, initial: 200, key: 32 };
const LISTS = [['char_fields', 'f'], ['user_fields', 'u']];

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
// 名稱會出現在「名稱：值」與 [角色] 這種格式裡：拿掉冒號、方括號與換行，免得模型輸出時對不回欄位
const cleanName = v => str(v).replace(/[:：[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
const isNum = v => /^-?\d+(\.\d+)?$/.test(v);

/** 整理一份欄位清單：沒有名稱的、重複名稱的拿掉，超過上限的截掉；key 不合法或重複時重新編號 */
function cleanFields(list, prefix) {
  const out = [], names = new Set(), keys = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (out.length >= LIMITS.fields) break;
    if (!raw || typeof raw !== 'object') continue;
    const name = cleanName(raw.name);
    if (!name || names.has(name)) continue;
    const type = raw.type === 'number' ? 'number' : 'text';
    const f = { key: '', name, type };
    if (type === 'number') {
      const max = Number(raw.max);
      if (raw.max !== '' && raw.max != null && Number.isFinite(max) && max > 0) f.max = max;
    }
    f.hint = str(raw.hint).trim().slice(0, LIMITS.hint);
    let initial = str(raw.initial).trim().slice(0, LIMITS.initial);
    if (type === 'number' && initial && !isNum(initial)) initial = ''; // 數值欄位的初始值一定要是數字
    f.initial = initial;
    let key = str(raw.key);
    if (!/^[\w-]+$/.test(key) || key.length > LIMITS.key || keys.has(key)) key = '';
    f.key = key;
    names.add(name); if (key) keys.add(key);
    out.push(f);
  }
  // 沒有 key 的補上（避開已經用掉的）：f1、f2…／u1、u2…
  let n = 1;
  for (const f of out) {
    if (f.key) continue;
    while (keys.has(prefix + n)) n++;
    f.key = prefix + n; keys.add(f.key);
  }
  return out;
}

/** 整理欄位定義（存檔、匯入角色卡時都會經過）。兩邊都沒有欄位時回傳 null（卡片上不留這個擴充） */
function cleanStatusDef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const def = {};
  for (const [k, prefix] of LISTS) def[k] = cleanFields(raw[k], prefix);
  return def.char_fields.length || def.user_fields.length ? def : null;
}
/** 卡片上的欄位定義（沒有或格式不對時是兩個空清單） */
const statusDefOf = data => cleanStatusDef(data?.extensions?.[STATUS_KEY]) || { char_fields: [], user_fields: [] };
const hasStatusFields = def => !!(def && (def.char_fields.length || def.user_fields.length));

/** 開新對話時的初始狀態：各欄位的 initial（沒寫初始值的欄位不放） */
function initialStatus(def) {
  const pick = fields => Object.fromEntries(fields.filter(f => f.initial !== '').map(f => [f.key, f.initial]));
  return { char: pick(def.char_fields), user: pick(def.user_fields), edited: false };
}

/**
 * 目前狀態：從最新的訊息往回找，第一則「目前顯示的版本有狀態」的 assistant 訊息（exclude：正在生成的那一則不算）。
 * 都沒有時回傳 null
 */
function currentStatus(messages, exclude = null) {
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === exclude || m?.role !== 'assistant' || !Array.isArray(m.swipe_status)) continue;
    const s = m.swipe_status[m.swipe_id || 0];
    if (s && typeof s === 'object') return s;
  }
  return null;
}
/** 每個欄位目前的值：狀態裡有就用，沒有（舊對話、後來才新增的欄位）就用初始值 */
function statusValues(def, st) {
  const pick = (fields, side) => Object.fromEntries(fields.map(f => [f.key,
    st?.[side] && Object.hasOwn(st[side], f.key) ? String(st[side][f.key] ?? '') : f.initial]));
  return { char: pick(def.char_fields, 'char'), user: pick(def.user_fields, 'user') };
}

// 模型輸出格式的區塊標題：[角色]、[玩家]（解析時也接受角色名、玩家名與「使用者」）
const CHAR_HEAD = '角色', USER_HEAD = '玩家';
/**
 * 提示詞最後的狀態欄說明＋目前狀態（和後置指令放在一起，不放在系統提示開頭：開頭不變，本機模型才能重用快取）。
 * exprs：這張卡的表情名稱（expressions/ 的檔名）。沒有欄位也沒有表情時回傳空字串（完全不加這段）。
 * 只列出卡片真的有的：沒有表情圖就不要求 <expression>，沒有欄位就不要求 <status>。{{char}}、{{user}} 由呼叫端代換
 */
function statusNote(def, st, exprs = []) {
  const hasF = hasStatusFields(def), hasE = exprs.length > 0;
  if (!hasF && !hasE) return '';
  const vals = statusValues(def, st);
  const sides = [[CHAR_HEAD, def.char_fields, 'char', '{{char}}'], [USER_HEAD, def.user_fields, 'user', '{{user}}']].filter(s => s[1].length);
  const kind = f => (f.type === 'number' ? (f.max ? `數值，最大 ${f.max}` : '數值') : '文字');
  const what = [hasE && '表情', hasF && '狀態'].filter(Boolean).join('與');
  const lines = ['[狀態欄]', `每次回覆都要在正式回覆的最後，用下面的格式寫出這次回覆之後的${what}：`];
  if (hasE) lines.push('<expression>表情名稱</expression>');
  if (hasF) {
    lines.push('<status>');
    for (const [head, fields] of sides) { lines.push(`[${head}]`); for (const f of fields) lines.push(`${f.name}：…`); }
    lines.push('</status>', '欄位說明：');
    for (const [head, fields, , who] of sides) for (const f of fields)
      lines.push(`- [${head}] ${f.name}（${kind(f)}${head === USER_HEAD ? `，${who} 的狀態` : ''}）${f.hint ? '：' + f.hint : ''}`);
  }
  if (hasE) lines.push(`表情名稱只能從這些裡面選一個（照原樣寫，選最符合這次回覆結尾時 {{char}} 情緒的）：${exprs.join('、')}`);
  lines.push('規則：'
    + (hasF ? '只寫上面列出的欄位，一行一個「名稱：值」；數值欄位只寫數字。依照這次回覆的劇情合理更新，沒有變化的欄位照抄目前的值。' : '')
    + `${hasE ? '<expression>' : ''}${hasE && hasF ? '、' : ''}${hasF ? '<status>' : ''} 一定放在回覆的最後面，正文裡不要提到${hasF ? '狀態欄' : '表情'}。`);
  lines.push('', '[目前狀態]');
  if (hasE) lines.push(`表情：${(st?.expression && exprs.find(n => n.toLowerCase() === String(st.expression).toLowerCase())) || '（未定）'}`);
  for (const [head, fields, side] of sides) {
    lines.push(`[${head}]`);
    for (const f of fields) lines.push(`${f.name}：${vals[side][f.key] || '（未定）'}`);
  }
  return lines.join('\n');
}

// ---------- 解析模型的回覆 ----------
const THINK_RE = /<(think|thinking)>[\s\S]*?(?:<\/\1>|$)/gi; // 和前端 splitThink 相同：思考裡的標籤不算
// 標籤名稱後面只能接空白、> 或 /：<status-bar>、<statusbar> 這種卡片自訂的 HTML 不算
const TAG_RE = /<(status|expression)(?=[\s>/])[^>]*>([\s\S]*?)<\/\1\s*>/gi;
// 沒寫完（被截斷）的標籤：完整的開頭標籤（<status>、<status …>）拿掉到最後；
// 開頭標籤本身也沒寫完時（<status、<expression cl）只認最後面那一小段，免得「<expression 很怪」這種正文被吃掉
const OPEN_TAG_RE = /<(status|expression)(?:(?=[\s>/])[^<>]*>[\s\S]*|[\w\s="'-]*)$/i;
const NUM_RE = /-?\d+(?:\.\d+)?/;

/** 把文字切成「思考」與「正文」段落：只處理正文段落 */
function eachVisible(text, fn) {
  let out = '', last = 0;
  for (const m of text.matchAll(THINK_RE)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}
/**
 * 拿掉回覆裡的 <status>、<expression>（思考區塊裡的不動），回傳 { text, status, expression }：
 * status／expression 是最後一個標籤的內容（沒有就是 null）
 */
function extractTags(text) {
  let status = null, expression = null, changed = false;
  const src = String(text || '');
  const clean = eachVisible(src, seg => {
    const out = seg.replace(TAG_RE, (_, tag, body) => { if (tag.toLowerCase() === 'status') status = body; else expression = body.trim(); return ''; })
      .replace(OPEN_TAG_RE, '');
    if (out !== seg) changed = true;
    return out;
  });
  // 有拿掉標籤時才整理空行（沒有標籤的回覆原封不動）
  return { text: changed ? clean.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : src, status, expression };
}
/**
 * 解析 <status> 的內容：[角色]／[玩家] 分區，一行一個「名稱：值」（全形、半形冒號都可以，名稱前後的空白、條列符號忽略）。
 * 名稱對回欄位的 key；不認得的名稱略過；數值欄位只取數字（有最大值時限制在 0～最大值）。
 * 回傳 { char: {key: 值}, user: {...} }，一個欄位都對不上時回傳 null
 */
function parseStatusBody(body, def, { charName = '', userName = '' } = {}) {
  const out = { char: {}, user: {} };
  const lists = { char: def.char_fields, user: def.user_fields };
  const headOf = name => {
    const n = name.trim();
    if ([CHAR_HEAD, charName].includes(n)) return 'char';
    if ([USER_HEAD, '使用者', userName].includes(n)) return 'user';
    return null;
  };
  let side = null, n = 0;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*・•]\s*)/, '').trim();
    if (!line) continue;
    const h = /^[[【](.+?)[\]】]$/.exec(line);
    if (h) { side = headOf(h[1]) || side; continue; }
    const m = /^([^:：]+?)\s*[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    // 先找目前這一區；還沒有分區、或這區沒有這個名稱時，名稱只在另一區出現也算
    let found = null;
    for (const s of side ? [side, side === 'char' ? 'user' : 'char'] : ['char', 'user']) {
      const f = lists[s].find(x => x.name === name);
      if (f) { found = [s, f]; break; }
    }
    if (!found) continue;
    const [s, f] = found;
    let v = m[2].trim();
    if (f.type === 'number') {
      const num = NUM_RE.exec(v.replace(/,/g, ''));
      if (!num) continue;
      let x = Number(num[0]);
      if (f.max) x = Math.min(f.max, Math.max(0, x));
      v = String(x);
    } else v = v.slice(0, LIMITS.initial);
    if (!v) continue;
    out[s][f.key] = v; n++;
  }
  return n ? out : null;
}
/**
 * 模型回覆完成（或「繼續」接完）：拿掉標籤，解析狀態並和上一份合併（沒寫到的欄位沿用）。
 * 回傳 { text, status }：status 是這個版本要存的狀態，模型漏寫或格式錯時是 null（面板沿用上一份）
 */
function applyReplyStatus(content, def, prev, names, exprs = []) {
  const { text, status: body, expression } = extractTags(content);
  const got = hasStatusFields(def) && body != null ? parseStatusBody(body, def, names) : null;
  // 表情要是清單裡的名稱（不分大小寫，前後的引號、括號忽略）；不在清單裡的忽略（沿用上一次）
  const want = String(expression ?? '').replace(/^[\s「『"'(（[]+|[\s」』"')）\]]+$/g, '').toLowerCase();
  const ex = want ? exprs.find(n => n.toLowerCase() === want) || null : null;
  if (!got && !ex) return { text, status: null };
  const base = prev || initialStatus(def);
  const status = { char: { ...(base.char || {}), ...(got?.char || {}) }, user: { ...(base.user || {}), ...(got?.user || {}) }, edited: false };
  if (ex || base.expression) status.expression = ex || base.expression;
  return { text, status };
}
/** swipe_status 對齊 swipes 的長度（舊訊息沒有這個欄位時全部是 null） */
function swipeStatus(m) {
  const n = Array.isArray(m.swipes) ? m.swipes.length : 1;
  return Array.from({ length: n }, (_, k) => (Array.isArray(m.swipe_status) ? m.swipe_status[k] || null : null));
}

// ---------- 面板上手動編輯 ----------
const bad = msg => Object.assign(new Error(msg), { status: 400 });
/**
 * 檢查手動編輯送來的值：{ char: { key: 值 }, user: {...} }。不認得的 key 略過；文字最多 200 字；
 * 數值欄位要是數字（可以留空），有最大值時要在 0～最大值之間（超出時回 400，不偷偷改掉）
 */
function cleanManualEdit(def, body) {
  const out = { char: {}, user: {} };
  for (const [side, fields] of [['char', def.char_fields], ['user', def.user_fields]]) {
    const src = body?.[side];
    if (!src || typeof src !== 'object') continue;
    for (const [key, raw] of Object.entries(src)) {
      const f = fields.find(x => x.key === key);
      if (!f) continue;
      let v = str(raw).trim();
      if (f.type === 'number' && v) {
        if (!isNum(v)) throw bad(`「${f.name}」要是數字`);
        const n = Number(v);
        if (f.max && (n < 0 || n > f.max)) throw bad(`「${f.name}」要在 0～${f.max} 之間`);
        v = String(n);
      } else v = v.slice(0, LIMITS.initial);
      out[side][key] = v;
    }
  }
  return out;
}
/**
 * 把手動編輯的值寫進「目前狀態」所在的那則訊息、那個版本，標 edited: true（沒改到的欄位沿用）。
 * 還沒有任何狀態（舊對話）時寫到最後一則 assistant 訊息上。回傳寫入的訊息位置；沒有 assistant 訊息時回 400
 */
function applyManualStatus(messages, def, vals) {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0 && idx < 0; i--) {
    const m = messages[i];
    if (m?.role === 'assistant' && Array.isArray(m.swipe_status) && m.swipe_status[m.swipe_id || 0]) idx = i;
  }
  if (idx < 0) idx = messages.findLastIndex(m => m?.role === 'assistant');
  if (idx < 0) throw bad('還沒有角色的訊息，沒有地方可以存狀態');
  const m = messages[idx], k = m.swipe_id || 0;
  const arr = swipeStatus(m);
  const base = arr[k] || initialStatus(def);
  arr[k] = { ...base, char: { ...(base.char || {}), ...vals.char }, user: { ...(base.user || {}), ...vals.user }, edited: true };
  m.swipe_status = arr;
  return idx;
}

// ---------- 大世界（設計稿第八節） ----------
// 欄位定義在世界卡上（world.status，格式和角色卡相同）：char_fields 所有成員共用，user_fields 只有一份。
// 每則訊息的 swipe_status[k]（大世界）：{ chars: { 成員 id: { key: 值 } }, exprs: { 成員 id: 表情 }, user?: {...}, focus?: 成員 id, edited }
// 只記這則訊息寫到的角色；「目前狀態」由每個角色各自往回找自己最近的一份（玩家狀態也是）
const worldDefOf = w => cleanStatusDef(w?.status) || { char_fields: [], user_fields: [] };
/** 開場白的初始狀態：每個成員一份角色欄位的初始值＋玩家的 */
function worldInitialStatus(def, ids) {
  const init = initialStatus(def);
  return { chars: Object.fromEntries(ids.map(id => [id, { ...init.char }])), exprs: {}, user: init.user, edited: false };
}
const statusOfSwipe = m => (m?.role === 'assistant' && Array.isArray(m.swipe_status) ? m.swipe_status[m.swipe_id || 0] : null);
/**
 * 大世界的目前狀態：從最新的訊息往回找，每個角色、表情、玩家狀態各自取最近的一份（exclude：正在生成的那一則不算；
 * upto：只看前 upto 則）。at／userAt：各自出自第幾則訊息（手動編輯寫回那裡）
 */
function worldCurrentStatus(messages, exclude = null, upto = messages?.length || 0) {
  const out = { chars: {}, exprs: {}, user: null, at: {}, userAt: -1 };
  for (let i = Math.min(upto, messages?.length || 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === exclude) continue;
    const s = statusOfSwipe(m);
    if (!s || typeof s !== 'object') continue;
    for (const [id, v] of Object.entries(s.chars || {})) if (!(id in out.chars) && v && typeof v === 'object') { out.chars[id] = v; out.at[id] = i; }
    for (const [id, v] of Object.entries(s.exprs || {})) if (!(id in out.exprs) && typeof v === 'string') out.exprs[id] = v;
    if (!out.user && s.user && typeof s.user === 'object') { out.user = s.user; out.userAt = i; }
  }
  return out;
}
/** 一個成員的狀態（statusNote 的格式）：{ char, user, expression } */
const memberStatus = (cur, id) => ({ char: cur?.chars?.[id] || null, user: cur?.user || null, expression: cur?.exprs?.[id] || null });

/**
 * 旁白（輪流發言的旁白、旁白統一模式）用的狀態欄說明：可以一次寫好幾個角色，用角色名當分區標題。
 * members：[{ id, name, exprs }]（要列出目前狀態的角色）；{{user}} 由呼叫端代換，欄位說明裡的 {{char}} 換成「該角色」
 */
function worldStatusNote(def, cur, members, { director = false } = {}) {
  const hasF = hasStatusFields(def), withE = members.filter(m => m.exprs?.length);
  if ((!hasF && !withE.length) || !members.length) return '';
  const each = t => String(t).replace(/\{\{char\}\}\s?/gi, '該角色'); // 「{{char}} 的情緒」→「該角色的情緒」
  const kind = f => (f.type === 'number' ? (f.max ? `數值，最大 ${f.max}` : '數值') : '文字');
  const lines = [];
  if (!director) {
    const what = [withE.length && '表情', hasF && '狀態'].filter(Boolean).join('與');
    const sample = members.slice(0, 2).map(m => m.name);
    lines.push('[狀態欄]', `每次回覆都要在正式回覆的最後，用下面的格式寫出這次回覆之後各角色的${what}（只寫這次有出場、有變化的角色；每個角色一個分區，分區標題是角色名）：`);
    if (withE.length) lines.push('<expression>', ...withE.slice(0, 2).map(m => `${m.name}：表情名稱`), '</expression>');
    if (hasF) {
      lines.push('<status>');
      for (const n of sample) { lines.push(`[${n}]`); for (const f of def.char_fields) lines.push(`${f.name}：…`); }
      if (def.user_fields.length) { lines.push(`[${USER_HEAD}]`); for (const f of def.user_fields) lines.push(`${f.name}：…`); }
      lines.push('</status>', '欄位說明：');
      for (const f of def.char_fields) lines.push(`- [角色名] ${f.name}（${kind(f)}，每個角色各自一份）${f.hint ? '：' + each(f.hint) : ''}`);
      for (const f of def.user_fields) lines.push(`- [${USER_HEAD}] ${f.name}（${kind(f)}，{{user}} 的狀態）${f.hint ? '：' + each(f.hint) : ''}`);
    }
    if (withE.length) {
      lines.push('各角色可以用的表情（只能從該角色自己的清單裡選一個，照原樣寫，選最符合這次回覆結尾時他的情緒的）：');
      for (const m of withE) lines.push(`- ${m.name}：${m.exprs.join('、')}`);
    }
    lines.push('規則：'
      + (hasF ? '只寫上面列出的欄位，一行一個「名稱：值」；數值欄位只寫數字。依照這次回覆的劇情合理更新，沒寫到的角色與欄位維持原本的值。' : '')
      + `${withE.length ? '<expression>' : ''}${withE.length && hasF ? '、' : ''}${hasF ? '<status>' : ''} 一定放在回覆的最後面，正文裡不要提到${hasF ? '狀態欄' : '表情'}。`, '');
  }
  lines.push(director ? '[目前狀態（參考，只用來規劃）]' : '[目前狀態]');
  for (const m of members) {
    lines.push(`[${m.name}]`);
    if (m.exprs?.length) lines.push(`表情：${(cur?.exprs?.[m.id] && m.exprs.find(n => n.toLowerCase() === String(cur.exprs[m.id]).toLowerCase())) || '（未定）'}`);
    const v = statusValues(def, memberStatus(cur, m.id)).char;
    for (const f of def.char_fields) lines.push(`${f.name}：${v[f.key] || '（未定）'}`);
  }
  if (def.user_fields.length) {
    const v = statusValues(def, { user: cur?.user }).user;
    lines.push(`[${USER_HEAD}]`);
    for (const f of def.user_fields) lines.push(`${f.name}：${v[f.key] || '（未定）'}`);
  }
  return lines.join('\n');
}

/** 一個「名稱：值」對回欄位：數值只取數字（有最大值時限制在 0～最大值）。對不上時回傳 null */
function fieldValue(f, raw) {
  let v = String(raw).trim();
  if (f.type === 'number') {
    const num = NUM_RE.exec(v.replace(/,/g, ''));
    if (!num) return null;
    let x = Number(num[0]);
    if (f.max) x = Math.min(f.max, Math.max(0, x));
    v = String(x);
  } else v = v.slice(0, LIMITS.initial);
  return v || null;
}
/**
 * 解析大世界的 <status>：分區標題是角色名（或 [角色]＝發言的角色自己）、[玩家]。
 * self：發言的角色（只收他自己的分區＋玩家；寫到別人的分區略過）；沒有 self＝旁白，所有成員都收。
 * 回傳 { chars: { id: { key: 值 } }, user: {...}, order: [id...] }，一個欄位都對不上時回傳 null
 */
function parseWorldStatusBody(body, def, { members = [], self = null, userName = '' } = {}) {
  const out = { chars: {}, user: {}, order: [] };
  const headOf = name => {
    const n = name.trim();
    if ([USER_HEAD, '使用者', userName].filter(Boolean).includes(n)) return 'user';
    if (n === CHAR_HEAD && self) return self;
    return members.find(m => m.name === n)?.id ?? null;
  };
  let side, n = 0; // undefined：還沒有分區；null：不認得的分區（略過裡面的行）
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*・•]\s*)/, '').trim();
    if (!line) continue;
    const h = /^[[【](.+?)[\]】]$/.exec(line);
    if (h) { side = headOf(h[1]); if (side && side !== 'user' && self && side !== self) side = null; continue; }
    if (side === null) continue;
    const m = /^([^:：]+?)\s*[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    const charSide = side && side !== 'user' ? side : self; // 角色欄位要記在誰身上
    let hit = null;
    const tryChar = () => { const f = charSide && def.char_fields.find(x => x.name === name); if (f) hit = [charSide, f]; return hit; };
    const tryUser = () => { const f = def.user_fields.find(x => x.name === name); if (f) hit = ['user', f]; return hit; };
    if (side === 'user') tryUser() || tryChar(); else tryChar() || tryUser();
    if (!hit) continue;
    const [who, f] = hit;
    const v = fieldValue(f, m[2]);
    if (v == null) continue;
    if (who === 'user') out.user[f.key] = v;
    else { (out.chars[who] ||= {})[f.key] = v; if (!out.order.includes(who)) out.order.push(who); }
    n++;
  }
  return n ? out : null;
}
const cleanExprWord = s => String(s ?? '').replace(/^[\s「『"'(（[]+|[\s」』"')）\]]+$/g, '').toLowerCase();
/**
 * 解析大世界的 <expression>：發言的角色寫一個表情名稱；旁白一行一個「角色名：表情」。
 * 表情要在那個角色自己的清單裡（不分大小寫）。回傳 { exprs: { id: 表情 }, order: [id...] }
 */
function parseWorldExpr(body, { members = [], self = null } = {}) {
  const exprs = {}, order = [];
  if (body == null) return { exprs, order };
  const pick = (m, word) => {
    const w = cleanExprWord(word);
    const hit = w && (m.exprs || []).find(x => x.toLowerCase() === w);
    if (!hit) return;
    exprs[m.id] = hit;
    const i = order.indexOf(m.id);
    if (i >= 0) order.splice(i, 1);
    order.push(m.id); // 最後寫到的角色排最後（面板顯示他的圖）
  };
  for (const raw of String(body).split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*・•]\s*)/, '').trim();
    if (!line) continue;
    const kv = /^([^:：]+?)\s*[:：]\s*(.+)$/.exec(line);
    const who = kv ? members.find(m => m.name === kv[1].trim()) : null;
    if (self) {
      const me = members.find(m => m.id === self);
      if (me && (!kv || who?.id === self || kv[1].trim() === CHAR_HEAD)) pick(me, kv ? kv[2] : line);
    } else if (who) pick(who, kv[2]);
  }
  return { exprs, order };
}
/**
 * 大世界的回覆完成：拿掉標籤，解析出這則寫到的角色與玩家狀態，各自和那個角色（玩家）目前的狀態合併。
 * ctx = { members: [{ id, name, exprs }], self, userName }。回傳 { text, status }（status 為 null＝什麼都沒寫到）。
 * focus：面板要顯示誰的圖（旁白寫的：表情區塊最後一個角色，沒寫表情就是狀態最後一個角色；角色發言就是他自己）
 */
function applyWorldReplyStatus(content, def, cur, ctx) {
  const { text, status: body, expression } = extractTags(content);
  const got = hasStatusFields(def) && body != null ? parseWorldStatusBody(body, def, ctx) : null;
  const ex = parseWorldExpr(expression, ctx);
  if (!got && !ex.order.length) return { text, status: null };
  const init = initialStatus(def);
  const status = { chars: {}, exprs: ex.exprs, edited: false };
  for (const [id, vals] of Object.entries(got?.chars || {})) status.chars[id] = { ...(cur?.chars?.[id] || init.char), ...vals };
  if (got && Object.keys(got.user).length) status.user = { ...(cur?.user || init.user), ...got.user };
  const focus = ctx.self || ex.order[ex.order.length - 1] || got?.order[got.order.length - 1];
  if (focus) status.focus = focus;
  return { text, status };
}
/**
 * 大世界的手動編輯：角色欄位寫進那個角色目前狀態所在的訊息，玩家欄位寫進玩家目前狀態所在的訊息（各自的那個版本），標 edited。
 * 還沒有的寫到最後一則 assistant 訊息上。memberId 為 null 時只改玩家
 */
function applyWorldManualStatus(messages, def, memberId, vals) {
  const lastIdx = messages.findLastIndex(m => m?.role === 'assistant');
  if (lastIdx < 0) throw bad('還沒有角色的訊息，沒有地方可以存狀態');
  const cur = worldCurrentStatus(messages);
  const init = initialStatus(def);
  const write = (idx, fn) => {
    const m = messages[idx], k = m.swipe_id || 0;
    const arr = swipeStatus(m);
    const base = arr[k] && typeof arr[k] === 'object' ? arr[k] : { chars: {}, exprs: {}, edited: false };
    arr[k] = fn({ ...base, chars: { ...(base.chars || {}) }, exprs: { ...(base.exprs || {}) } });
    arr[k].edited = true;
    m.swipe_status = arr;
  };
  if (memberId && Object.keys(vals.char).length) {
    const idx = cur.at[memberId] ?? lastIdx;
    write(idx, s => { s.chars[memberId] = { ...(cur.chars[memberId] || init.char), ...vals.char }; return s; });
  }
  if (Object.keys(vals.user).length) {
    const idx = cur.userAt >= 0 ? cur.userAt : lastIdx;
    write(idx, s => { s.user = { ...(cur.user || init.user), ...vals.user }; return s; });
  }
}

module.exports = { STATUS_KEY, cleanStatusDef, statusDefOf, hasStatusFields, initialStatus, currentStatus, statusNote,
  extractTags, parseStatusBody, applyReplyStatus, swipeStatus, cleanManualEdit, applyManualStatus,
  worldDefOf, worldInitialStatus, worldCurrentStatus, memberStatus, worldStatusNote, parseWorldStatusBody, applyWorldReplyStatus, applyWorldManualStatus };
