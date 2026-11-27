// 角色卡正規化：支援 V1 / V2 (chara_card_v2) / V3 (chara_card_v3) 及部分網站匯出格式
'use strict';
const { STATUS_KEY, cleanStatusDef } = require('./status');
const { cleanName: cleanExprName } = require('./expressions');
const EXPR_KEY = 'ai_tavern_expressions';

const CARD_FIELDS = {
  name: '',
  description: '',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  tags: [],
  creator: '',
  character_version: '',
  extensions: {},
  character_book: null,
};

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = v => (Array.isArray(v) ? v.map(str).filter(s => s !== '') : typeof v === 'string' && v ? v.split(',').map(s => s.trim()).filter(Boolean) : []);

function normalizeBookEntry(e, i) {
  e = e || {};
  const ext = e.extensions && typeof e.extensions === 'object' ? e.extensions : {};
  let position = e.position;
  if (typeof position === 'number') position = ['before_char', 'after_char', 'before_char', 'after_char', 'at_depth'][position] || 'before_char';
  if (ext.position === 4 || position === 'at_depth') position = 'at_depth';
  if (!['before_char', 'after_char', 'at_depth'].includes(position)) position = 'before_char';
  return {
    id: e.id ?? e.uid ?? i,
    comment: str(e.comment ?? e.name ?? ''),
    keys: arr(e.keys ?? e.key),
    secondary_keys: arr(e.secondary_keys ?? e.keysecondary),
    content: str(e.content),
    enabled: e.enabled !== undefined ? !!e.enabled : e.disable !== undefined ? !e.disable : true,
    constant: !!e.constant,
    selective: !!e.selective,
    case_sensitive: !!e.case_sensitive,
    insertion_order: Number(e.insertion_order ?? e.order ?? 100) || 0,
    position,
    depth: Number(e.depth ?? ext.depth ?? 4) || 0,
    // 遞迴設定（SillyTavern 的寫法：excludeRecursion／preventRecursion，或角色卡 extensions 裡的 exclude_recursion／prevent_recursion）
    exclude_recursion: !!(e.exclude_recursion ?? e.excludeRecursion ?? ext.exclude_recursion),
    prevent_recursion: !!(e.prevent_recursion ?? e.preventRecursion ?? ext.prevent_recursion),
  };
}

function normalizeBook(book) {
  if (!book || typeof book !== 'object') return null;
  let entries = book.entries;
  if (entries && !Array.isArray(entries)) entries = Object.values(entries); // SillyTavern 世界書格式
  return {
    name: str(book.name),
    description: str(book.description),
    scan_depth: Number(book.scan_depth ?? 4) || 4,
    token_budget: Number(book.token_budget ?? 2048) || 2048,
    recursive_scanning: !!book.recursive_scanning,
    entries: (entries || []).map(normalizeBookEntry),
    extensions: book.extensions || {},
  };
}

/** 將任意格式的角色卡物件轉為內部 data 物件 */
function normalizeCard(input) {
  if (!input || typeof input !== 'object') throw Object.assign(new Error('角色卡格式錯誤'), { status: 400 });
  let src = input;
  if (input.data && typeof input.data === 'object' && (input.spec || input.data.name)) src = input.data;
  if (!src.name && src.char_name) src = { ...src, name: src.char_name };
  if (!src.name) throw Object.assign(new Error('角色卡缺少名稱（name）'), { status: 400 });

  const data = {};
  for (const [k, def] of Object.entries(CARD_FIELDS)) {
    const v = src[k];
    if (Array.isArray(def)) data[k] = arr(v);
    else if (k === 'extensions') data[k] = v && typeof v === 'object' ? v : {};
    else if (k === 'character_book') data[k] = normalizeBook(v);
    else data[k] = str(v ?? def);
  }

  // V1 舊欄位
  if (!data.first_mes && src.char_greeting) data.first_mes = str(src.char_greeting);
  if (!data.mes_example && src.example_dialogue) data.mes_example = str(src.example_dialogue);
  if (!data.personality && src.char_persona) data.personality = str(src.char_persona);
  if (!data.scenario && src.world_scenario) data.scenario = str(src.world_scenario);

  // 部分網站匯出格式：開場白放在 chat_history[].messages[]
  if (!data.first_mes && Array.isArray(src.chat_history)) {
    const greetings = [];
    for (const h of src.chat_history) {
      const m = (h.messages || []).find(x => x.role === 'assistant' && x.content);
      if (m) greetings.push(str(m.content));
    }
    if (greetings.length) {
      data.first_mes = greetings[0];
      data.alternate_greetings = [...data.alternate_greetings, ...greetings.slice(1)];
    }
  }
  if (data.character_book && !data.character_book.entries.length) data.character_book = null;
  // 表情圖的設定：{ default: 預設表情的名稱 }（圖片本身在角色資料夾的 expressions/，不在卡片裡）
  if (EXPR_KEY in data.extensions) {
    const def = cleanExprName(data.extensions[EXPR_KEY]?.default);
    data.extensions = { ...data.extensions };
    if (def) data.extensions[EXPR_KEY] = { default: def }; else delete data.extensions[EXPR_KEY];
  }
  // 狀態欄的欄位定義：整理過才存（名稱長度、欄位數量上限、重複名稱）；沒有欄位就拿掉
  if (STATUS_KEY in data.extensions) {
    const def = cleanStatusDef(data.extensions[STATUS_KEY]);
    data.extensions = { ...data.extensions };
    if (def) data.extensions[STATUS_KEY] = def; else delete data.extensions[STATUS_KEY];
  }
  return data;
}

/** 匯出時，遞迴設定也寫進條目的 extensions（SillyTavern 從這裡讀） */
function exportBook(book) {
  if (!book || !Array.isArray(book.entries)) return book;
  return { ...book, entries: book.entries.map(e => (e.exclude_recursion || e.prevent_recursion
    ? { ...e, extensions: { ...(e.extensions || {}), exclude_recursion: !!e.exclude_recursion, prevent_recursion: !!e.prevent_recursion } } : e)) };
}
/** 匯出為 V2 / V3 物件 */
function toV2(data) {
  return { spec: 'chara_card_v2', spec_version: '2.0', data: { ...data, character_book: exportBook(data.character_book) } };
}
function toV3(data) {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { ...data, character_book: exportBook(data.character_book), group_only_greetings: [], creation_date: Math.floor(Date.now() / 1000), modification_date: Math.floor(Date.now() / 1000) },
  };
}

// ---------- 多則開場白（AI 酒館自己的擴充） ----------
// 角色卡的每個開場白（主要＋備用）可以是一串訊息：角色、旁白或 {{user}} 說的。
// 結構存在 extensions.ai_tavern_openings（和 [first_mes, ...alternate_greetings] 一一對應）；
// first_mes／alternate_greetings 仍然存合併後的文字（flattenOpening），其他程式讀得懂。
// 卡片在別的程式裡改過開場白（合併後的文字對不上）時，忽略這份結構、改用文字
const OPENINGS_KEY = 'ai_tavern_openings';
const OPEN_SPEAKERS = ['char', 'narrator', 'user'];
const flattenOpening = block => block.map(o => (o.speaker === 'user' ? `{{user}}：${o.content}` : o.content)).join('\n\n');
const cleanOpening = b => (Array.isArray(b) ? b : [])
  .filter(o => o && OPEN_SPEAKERS.includes(o.speaker))
  .map(o => ({ speaker: o.speaker, content: str(o.content) }))
  .filter(o => o.content.trim());
/** 只有一則角色說的話＝一般的開場白 */
const isPlainOpening = b => b.length === 1 && b[0].speaker === 'char';
/** 角色卡的開場白：[[{ speaker, content }]]，第一個是主要開場白 */
function cardOpenings(data) {
  const texts = [data.first_mes, ...(data.alternate_greetings || [])].filter(Boolean).map(str);
  const raw = data.extensions?.[OPENINGS_KEY];
  if (Array.isArray(raw)) {
    const blocks = raw.map(cleanOpening).filter(b => b.length);
    if (blocks.length === texts.length && blocks.every((b, i) => flattenOpening(b) === texts[i])) return blocks;
  }
  return texts.map(t => [{ speaker: 'char', content: t }]);
}

module.exports = { EXPR_KEY, normalizeCard, normalizeBook, toV2, toV3, cardOpenings, isPlainOpening };
