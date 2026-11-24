// 大世界「整理角色卡規則」：請 AI 把各角色卡系統提示裡共用的扮演／寫作規則挑出來移到世界提示詞，
// 每位角色只保留和自己有關的內容。只回傳建議，由使用者在預覽裡確認、修改後才套用（不會自動存檔）
//
// 回覆格式用「【標題】＋內文」分段，不用 JSON：規則內文常有換行、引號，模型輸出 JSON 時很容易沒跳脫而解析失敗；
// 分段格式就算多了說明文字或程式碼區塊標記也讀得懂。模型還是回了 JSON 時也照樣接受
'use strict';
const { stripThink } = require('./util');

const { estimateTokens } = require('./prompt');

const SYSTEM = [
  '你是角色扮演提示詞的整理助手。使用者有一個多角色的「大世界」，每位角色都帶著自己角色卡的系統提示（規則）。',
  '這些規則常常混著兩種內容：',
  '- 共用規則：好幾位角色的卡裡都寫了的通用扮演或寫作規則，例如「保持角色身分」「不要替玩家說話、決定行動」「劇情推進方式」「回應長度與文風」「避免重複」。',
  '- 角色專屬規則：只和這位角色有關的內容，例如性格表現、口癖、說話方式、禁忌、專業領域、與其他人的關係、專屬的行為準則。',
  '',
  '每次對話送給 AI 的系統提示，依序是：[主要系統提示] → [大世界系統提示] → [目前的世界提示詞] → 各角色的規則。前三段所有角色都會收到。',
  '',
  '請完成：',
  '1. 共用規則只收「兩位以上角色都有、意思相同」的規則，合併、去除重複後寫成一份。只出現在一位角色裡的規則，就算看起來很通用，也一律留在那位角色（移出去會影響其他角色的行為）。',
  '2. 每位角色只保留這位角色的專屬規則，沿用原文：保留原本的標籤（例如 [專業深度]、[扮演規則]）與段落、換行結構，只整條刪掉已經移到共用規則的規則；不要改寫意思，也不要新增原文沒有的內容。某個標籤底下的規則全部移走了，就連標籤一起刪掉。',
  '   共用規則也保留原本的標籤（例如 [保持角色]）。',
  '3. 不同角色對同一件事要求不同（例如回應長度、人稱、格式不同）時，不要放進共用規則，留在各自的角色裡，並在【衝突】用一句話說明。',
  '4. 共用規則是給所有角色的，不能寫特定角色的名字；原文的 {{char}} 在共用規則裡改寫成「每個角色」或「角色」。{{user}} 保持原樣。各角色保留的內容裡 {{char}}、{{user}} 保持原樣。',
  '5. 最後逐條檢查共用規則（這一步一定要做）：',
  '   (a) 和 [主要系統提示]、[大世界系統提示] 或 [目前的世界提示詞] 意思相同的部分刪掉（所有角色本來就會收到）；規則比它們更具體時保留，只刪掉重複的那半句。例如主要系統提示已經有「不要替 {{user}} 說話、決定行動」，共用規則就不必再寫這一句。',
  '   (b) 不適合大世界的寫法要改寫：大世界有旁白、有好幾位角色輪流發言。例如「不改用旁白或助手口吻」會和旁白衝突，要改成「不改用助手口吻」；「只扮演一位角色」「只用第一人稱」這類也要改成多角色適用的說法。',
  '   (a)、(b) 每改一處，都在【衝突】用一句話說明改了什麼、為什麼。',
  '6. 沒有內容的段落寫「（無）」。',
  '',
  '只輸出下面這些段落，每個標題單獨一行、照抄標題（【M1】【M2】…對應角色清單的代號），不要加其他說明、不要用 JSON 或程式碼區塊：',
  '【共用規則】',
  '（合併後的共用規則）',
  '【M1】',
  '（M1 保留的規則）',
  '【M2】',
  '（M2 保留的規則，依此類推，每位角色都要有一段）',
  '【衝突】',
  '- （每行一條衝突說明；沒有就寫「（無）」）',
].join('\n');

/**
 * 要送出的內容。members：[{ ref, name, rules }]（rules 是這位角色目前套用的系統提示）
 * globals：{ main, world }＝設定裡的主要系統提示與大世界系統提示（所有角色都會收到，讓 AI 不要重複放）
 */
function buildMessages(worldPrompt, members, globals = {}) {
  const list = members.map(m => `### ${m.ref}（${m.name}）\n${m.rules.trim()}`).join('\n\n');
  const blank = t => String(t || '').trim() || '（空白）';
  const user = `[主要系統提示]\n${blank(globals.main)}\n\n[大世界系統提示]\n${blank(globals.world)}\n\n`
    + `[目前的世界提示詞]\n${blank(worldPrompt)}\n\n[角色卡規則清單]\n${list}\n\n`
    + `請依照指示，用【共用規則】${members.map(m => `【${m.ref}】`).join('')}【衝突】這些段落輸出。`;
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

const estimate = messages => messages.reduce((s, m) => s + estimateTokens(m.content), 0);

const EMPTY_RE = /^[（(]?\s*(無|没有|沒有|none|n\/a)\s*[)）]?[。.]?$/i;
const clean = v => {
  const s = String(v ?? '').replace(/^\s*```[a-z]*\s*$/gim, '').trim(); // 去掉殘留的 ``` 行
  return EMPTY_RE.test(s) ? '' : s;
};

/** 分段格式：【共用規則】【M1】…【衝突】。找不到任何段落時回傳 null */
function parseSections(s, refs) {
  // 標題可能寫成【M1】、【M1（角色名稱）】、[M1]、### 【M1】；標題後面同一行如果只是（角色名稱）就略過
  const re = /^[ \t]*(?:#+\s*)?(?:\*\*)?[【\[]\s*(共用規則|衝突|冲突|M\d+)\s*(?:[（(][^）)\n]*[）)])?\s*[】\]](?:\*\*)?[ \t]*(.*)$/gm;
  const marks = [];
  let mt;
  while ((mt = re.exec(s))) {
    const inline = /^[（(][^）)]*[）)]$/.test(mt[2].trim()) ? '' : mt[2];
    marks.push({ key: mt[1].replace('冲突', '衝突'), start: mt.index, bodyStart: mt.index + mt[0].length, inline });
  }
  if (!marks.some(m => m.key === '共用規則' || refs.includes(m.key))) return null;
  const out = { shared: '', keep: {}, conflicts: [] };
  marks.forEach((m, i) => {
    const body = clean((m.inline ? m.inline + '\n' : '') + s.slice(m.bodyStart, i + 1 < marks.length ? marks[i + 1].start : s.length));
    if (m.key === '共用規則') out.shared = body;
    else if (m.key === '衝突') out.conflicts = body.split('\n').map(l => clean(l.replace(/^\s*[-•*・\d.、)）]+\s*/, ''))).filter(Boolean);
    else if (refs.includes(m.key)) out.keep[m.key] = body;
  });
  return out;
}

/** JSON 格式（舊格式或模型自作主張）：容許前後多了文字、字串裡有沒跳脫的換行 */
function parseJson(s, refs) {
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const raw = s.slice(start, end + 1);
  let j = null;
  for (const text of [raw, escapeNewlinesInStrings(raw)]) { try { j = JSON.parse(text); break; } catch { /* 試下一種 */ } }
  if (!j || typeof j !== 'object') return null;
  const keep = {};
  for (const m of Array.isArray(j.members) ? j.members : []) if (m && refs.includes(m.ref)) keep[m.ref] = clean(m.keep);
  return { shared: clean(j.shared), keep, conflicts: (Array.isArray(j.conflicts) ? j.conflicts : []).map(clean).filter(Boolean) };
}
/** 把 JSON 字串值裡直接換行的地方改成 \n（模型常犯的錯） */
function escapeNewlinesInStrings(t) {
  let out = '', inStr = false, esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      else if (ch === '\n') { out += '\\n'; continue; }
      else if (ch === '\r') continue;
      else if (ch === '\t') { out += '\\t'; continue; }
    } else if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/**
 * 解析 AI 的回覆。refs：送出的 M1、M2…，對不上的忽略。
 * 看不懂時丟出錯誤；stop_reason 是 length 時說明是回覆被截斷
 */
function parseResult(text, refs, { stopReason, reasoning } = {}) {
  const s = stripThink(text).trim();
  const r = parseSections(s, refs) || parseJson(s, refs);
  if (r) return r;
  const truncated = ['length', 'max_tokens', 'MAX_TOKENS'].includes(stopReason);
  const msg = !s && (reasoning || truncated)
    ? 'AI 只輸出了思考內容就用完回應長度，沒有寫出整理結果。請到「設定 → API 設定」把思考程度調低，或把「最大回應 tokens」調高後再試'
    : truncated ? 'AI 的回覆太長被截斷了。請把「設定 → API 設定」的「最大回應 tokens」調高，或把思考程度調低後再試'
      : 'AI 回傳的內容看不懂（沒有照格式分段），請再試一次或換一個模型';
  throw Object.assign(new Error(msg), { status: 502 });
}

module.exports = { buildMessages, estimate, parseResult };
