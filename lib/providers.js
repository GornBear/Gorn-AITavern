// AI 供應商：OpenAI 相容 API（OpenAI、OpenRouter、DeepSeek、本機 LM Studio / Ollama 等）、Google Gemini 原生 API 與 Anthropic Claude
'use strict';

const { getApiKey } = require('./storage');

// Google Gemini 原生 API（可設定安全審查）；測試時可用環境變數換成假的服務
const GEMINI_NATIVE = (process.env.TAVERN_GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
// Google Gemini 的 OpenAI 相容端點（只在「設定」填了自訂位址時使用，例如走代理）
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
// Gemini 安全審查：可以調整的類別全部設為不封鎖（OFF）。
// 這只是 API 參數，Google 一律封鎖的內容（結束原因 PROHIBITED_CONTENT，例如涉及未成年）不受影響
const GEMINI_SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_CIVIC_INTEGRITY'].map(category => ({ category, threshold: 'OFF' }));
// 不接受「公民誠信」類別的模型（key = 模型；第一次被拒絕後記住，之後不送）
const NO_CIVIC = new Set();
const HARM_NAMES = {
  HARM_CATEGORY_HARASSMENT: '騷擾', HARM_CATEGORY_HATE_SPEECH: '仇恨言論', HARM_CATEGORY_SEXUALLY_EXPLICIT: '色情內容',
  HARM_CATEGORY_DANGEROUS_CONTENT: '危險內容', HARM_CATEGORY_CIVIC_INTEGRITY: '公民誠信',
};
/** 不使用 OpenAI 相容端點、改走 Gemini 原生 API */
const useGeminiNative = settings => settings.provider === 'gemini' && !(settings.gemini || {}).base_url;
const PROVIDER_NAMES = { openai: 'OpenAI 相容 API', gemini: 'Google Gemini', anthropic: 'Anthropic' };

/** OpenAI 相容端點的位址、模型與金鑰（openai / gemini 共用） */
function compatTarget(settings) {
  const p = settings.provider === 'gemini' ? 'gemini' : 'openai';
  const cfg = settings[p] || {};
  // settings._key：取得模型清單時用畫面上填的金鑰（還沒儲存），沒有給就用存好的
  return { provider: p, base: (cfg.base_url || (p === 'gemini' ? GEMINI_URL : '')).replace(/\/+$/, ''), model: cfg.model, key: typeof settings._key === 'string' ? settings._key : getApiKey(p) };
}

/** 把 API 錯誤轉成看得懂的訊息 */
async function apiError(res, provider, what) {
  const body = await res.text().catch(() => '');
  let detail = body;
  try { const j = JSON.parse(body); detail = (Array.isArray(j) ? j[0] : j).error?.message || detail; } catch { }
  const hint = res.status === 401 || res.status === 403
    ? `（${PROVIDER_NAMES[provider]} 的 API 金鑰無效或未設定，請確認「設定」中選的供應商與金鑰相符）`
    : res.status === 404 ? '（找不到端點或模型，請確認 API 位址與模型名稱）'
    : res.status === 429 ? '（請求太頻繁或額度已用完；有些模型沒有免費額度，可換一個模型試試）'
    : res.status === 503 ? '（模型目前太忙碌，請稍後再試，或換一個模型）' : '';
  return Object.assign(new Error(`${what}失敗 ${res.status}${hint}：${String(detail).slice(0, 300)}`), { status: 502, retryable: RETRY_STATUS.has(res.status), body });
}
/**
 * Claude 官方 SDK 的錯誤是英文的：依狀態碼加上中文說明（原文附在後面方便查）。
 * 直接改同一個錯誤物件的訊息，不影響是否自動重試（看的是狀態碼與錯誤類型）
 */
function localizeClaudeError(e, what) {
  if (!e || e.name === 'AbortError' || /失敗|中斷|拒絕|尚未/.test(e.message || '')) return e;
  const s = e.status;
  const conn = /APIConnection|Timeout/i.test(e.constructor?.name || e.name || '');
  const hint = s === 401 ? 'Anthropic 的 API 金鑰無效或未設定，請到「設定 → API 設定」確認金鑰'
    : s === 403 ? '這把金鑰沒有權限使用這個功能或模型'
    : s === 404 ? '找不到這個模型，請確認模型名稱，或按「取得模型清單」重新選擇'
    : s === 400 ? '請求內容被拒絕（參數或內容不符合這個模型的要求）'
    : s === 413 ? '送出的內容太大，請調低上下文長度'
    : s === 429 ? '請求太頻繁或額度已用完，請稍後再試'
    : s === 529 || s === 503 ? 'Anthropic 目前太忙碌，請稍後再試'
    : s >= 500 ? 'Anthropic 伺服器暫時出錯，請稍後再試'
    : conn ? '連不上 Anthropic，請確認網路連線' : '';
  if (hint) e.message = `${what}失敗${s ? ` ${s}` : ''}（${hint}）：${String(e.error?.error?.message || e.message || '').slice(0, 300)}`;
  return e;
}
// 這些狀態碼通常是暫時的，可以等一下再試：逾時、太頻繁、伺服器錯誤、忙碌
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
// 不支援 stream_options（回報用量）的 API 位址：第一次被拒絕後記住，之後不再送
const NO_USAGE_OPTION = new Set();
// OpenAI 推理型模型：max_tokens 要改名 max_completion_tokens、不接受自訂 temperature／top_p（key = 位址|模型；第一次被拒絕後記住）
const USE_MAX_COMPLETION = new Set();
const NO_SAMPLING = new Set();
// 不認得 reasoning_effort（或不接受這個值）的模型：拿掉後重送（key = 位址|模型；第一次被拒絕後記住）
const NO_REASONING = new Set();

// ---------- OpenAI 相容（SSE 串流） ----------
async function streamOpenAI({ settings, messages, signal, onText, onReasoning = () => {} }) {
  const t = compatTarget(settings);
  if (t.provider === 'gemini' && !t.key) throw new Error('尚未設定 Gemini API 金鑰（環境變數 GEMINI_API_KEY 或「設定」頁）');
  if (!t.model) throw new Error('尚未選擇模型，請到「設定」按「取得模型清單」選一個模型');
  const url = t.base + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (t.key) headers.Authorization = 'Bearer ' + t.key;

  const body = {
    model: t.model,
    messages: toCompatMessages(messages),
    stream: true,
    temperature: Number(settings.temperature),
    top_p: Number(settings.top_p),
    max_tokens: Number(settings.max_tokens),
  };
  const effort = (settings[t.provider] || {}).reasoning_effort;
  if (effort) body.reasoning_effort = effort; // 思考型模型的思考程度（none / low / medium / high）
  // 重複懲罰：1 代表關閉，不送出（OpenAI 官方與 Gemini 不認得這個參數，送了會報錯）
  const rep = Number(settings.repetition_penalty);
  if (t.provider !== 'gemini' && rep > 0 && rep !== 1) body.repetition_penalty = rep;

  // 請 API 在最後回報實際用掉的 token（不支援的平台會拒絕，之後就不再送）
  if (!NO_USAGE_OPTION.has(t.base)) body.stream_options = { include_usage: true };

  // 等待第一個回應最多 90 秒，避免伺服器沒回應時永遠卡住；
  // 開始串流後，超過 5 分鐘沒有任何新內容也視為連線中斷（思考型模型可能安靜思考好幾分鐘，所以留寬一點）
  const send = () => connect(url, headers, body, signal, `無法連線到 ${t.base}`, '（本機模型請確認 LM Studio / Ollama 已啟動伺服器）');
  // 之前被這個模型拒絕過的參數：一開始就換掉
  const mkey = t.base + '|' + t.model;
  if (USE_MAX_COMPLETION.has(mkey)) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
  if (NO_SAMPLING.has(mkey)) { delete body.temperature; delete body.top_p; }
  if (NO_REASONING.has(mkey)) delete body.reasoning_effort;
  let conn = await send();
  // 參數被拒絕（400）時自動調整後重試，並記住，之後不再送：
  // 不支援 stream_options 的平台；OpenAI 推理型模型（o 系列、GPT-5 等）要用 max_completion_tokens、不接受自訂 temperature／top_p；
  // 不會思考的模型不認得 reasoning_effort（例如模擬思考時送出的 none）
  for (let tries = 0; tries < 4 && !conn.res.ok && conn.res.status === 400; tries++) {
    const err = await apiError(conn.res, t.provider, '生成');
    conn.release();
    const b = err.body || '';
    if (body.stream_options && /stream_options|include_usage/i.test(b)) { NO_USAGE_OPTION.add(t.base); delete body.stream_options; }
    else if ('max_tokens' in body && /max_completion_tokens/i.test(b)) { USE_MAX_COMPLETION.add(mkey); body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
    else if (('temperature' in body || 'top_p' in body) && /temperature|top_p/i.test(b)) { NO_SAMPLING.add(mkey); delete body.temperature; delete body.top_p; }
    else if ('reasoning_effort' in body && /reasoning/i.test(b)) { NO_REASONING.add(mkey); delete body.reasoning_effort; }
    else throw err;
    conn = await send();
  }
  const { res, ac, release } = conn;
  if (!res.ok) { release(); throw await apiError(res, t.provider, '生成'); }

  const decoder = new TextDecoder();
  let buf = '', full = '', reasoning = '', stop = null, usage = null;
  let idle = false, idleTimer = null;
  const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { idle = true; ac.abort(); }, idleMs()); };
  bump();
  try {
  // 一行一行處理；最後一行沒有換行就結束時（有的平台會這樣送用量），串流結束後補一個換行再處理一次，不會被丟掉
  const chunks = (async function* () { for await (const c of res.body) yield decoder.decode(c, { stream: true }); yield decoder.decode() + '\n'; })();
  for await (const text of chunks) {
    bump();
    buf += text;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        // 用量：通常在最後一個 chunk（choices 是空的）
        if (j.usage && (j.usage.prompt_tokens || j.usage.completion_tokens)) {
          usage = { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
          const cached = j.usage.prompt_tokens_details?.cached_tokens;
          if (cached) usage.cached = cached;
        }
        const ch = j.choices && j.choices[0];
        const delta = (ch && ch.delta) || {};
        // 思考型模型（DeepSeek R1、Qwen3、Gemini 2.5+ 等）把思考過程放在 reasoning_content / reasoning
        const r = delta.reasoning_content || delta.reasoning;
        if (typeof r === 'string' && r) { reasoning += r; onReasoning(r); }
        if (delta.content) { full += delta.content; onText(delta.content); }
        if (ch && ch.finish_reason) stop = ch.finish_reason;
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  } catch (e) {
    if (idle) throw Object.assign(new Error('API 超過 5 分鐘沒有送出新內容，連線可能已經中斷；已經產生的內容會保留，可以按「繼續」接著寫'), { retryable: !full && !reasoning });
    throw e;
  } finally { clearTimeout(idleTimer); release(); }
  // 什麼都沒回（不是用完長度）：以前會默默存成空訊息、畫面沒有任何提示。
  // 有些模型（例如 Gemini 3.8）的串流不送結束原因，被安全過濾擋下或暫時出狀況時就只是空的。
  // 還沒產生任何內容，所以可以自動重試；重試後還是空的就顯示原因
  if (!full.trim() && !['length', 'max_tokens'].includes(stop)) {
    const blocked = /content_filter|safety|prohibited|blocklist|recitation/i.test(String(stop || ''));
    throw Object.assign(new Error(blocked
      ? `回應被模型的安全過濾擋下了（結束原因：${stop}）。可以修改最後一則訊息後重試，或換一個模型`
      : `AI 沒有回傳任何內容${stop ? `（結束原因：${stop}）` : ''}。模型可能暫時不穩定或太忙碌，請再試一次，或到「設定」換一個模型`), { retryable: !blocked && !reasoning });
  }
  return { text: full, reasoning, stop_reason: stop, usage };
}

// 串流開始後，超過這麼久沒有任何新內容就視為連線中斷（所有供應商共用；測試可以用環境變數縮短）
const idleMs = () => Number(process.env.TAVERN_STREAM_IDLE_MS) || 5 * 60 * 1000;

/** 送出串流請求：等待第一個回應最多 90 秒；按「停止」經由 signal 中止。回傳 { res, ac, release } */
async function connect(url, headers, body, signal, failMsg, failHint = '') {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  const release = () => { if (signal) signal.removeEventListener('abort', onAbort); };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, 90000);
  try {
    return { res: await fetch(url, { method: 'POST', headers, signal: ac.signal, body: JSON.stringify(body) }), ac, release };
  } catch (e) {
    release();
    if (timedOut) throw Object.assign(new Error('API 超過 90 秒沒有回應（模型可能太忙碌），請稍後再試或換一個模型'), { retryable: true });
    if (e.name !== 'AbortError') throw Object.assign(new Error(`${failMsg}：${e.cause?.code || e.message}${failHint}`), { retryable: true });
    throw e;
  } finally { clearTimeout(timer); }
}

// ---------- Google Gemini 原生 API（SSE 串流） ----------
// 思考設定被模型拒絕過（key = 模型）：'level' = 不送思考程度；'all' = 整個思考設定都不送（例如不會思考的 Gemma）
const GEMINI_THINK_FALLBACK = new Map();
// Gemini 2.x 用思考預算（tokens），3 以後用思考程度
const GEMINI_BUDGET = { none: 0, low: 1024, medium: 8192, high: 24576 };

async function streamGemini({ settings, messages, signal, onText, onReasoning = () => {} }) {
  const key = getApiKey('gemini');
  const model = String((settings.gemini || {}).model || '').replace(/^models\//, '');
  if (!key) throw new Error('尚未設定 Gemini API 金鑰（環境變數 GEMINI_API_KEY 或「設定」頁）');
  if (!model) throw new Error('尚未選擇模型，請到「設定」按「取得模型清單」選一個模型');
  const url = `${GEMINI_NATIVE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key }; // 金鑰放在標頭，不放網址

  const { system, messages: msgs } = normalizeMessages(messages);
  const body = {
    contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    safetySettings: NO_CIVIC.has(model) ? GEMINI_SAFETY.filter(s => !s.category.includes('CIVIC')) : GEMINI_SAFETY,
    generationConfig: { temperature: Number(settings.temperature), topP: Number(settings.top_p), maxOutputTokens: Number(settings.max_tokens) },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  // 思考：顯示思考過程；有指定思考程度時一起送出
  const think = { includeThoughts: true };
  const effort = (settings.gemini || {}).reasoning_effort;
  if (effort) {
    if (/^gemini-2\./.test(model)) think.thinkingBudget = GEMINI_BUDGET[effort];
    else think.thinkingLevel = effort === 'none' ? 'minimal' : effort;
  }
  const fb = GEMINI_THINK_FALLBACK.get(model);
  if (fb === 'level') { delete think.thinkingBudget; delete think.thinkingLevel; }
  if (fb !== 'all') body.generationConfig.thinkingConfig = think;

  const send = () => connect(url, headers, body, signal, '無法連線到 Google Gemini');
  let conn = await send();
  // 參數被拒絕（400）時調整後重試，並記住：不接受「公民誠信」類別的模型；思考設定先拿掉思考程度、再整個拿掉
  for (let tries = 0; tries < 3 && conn.res.status === 400; tries++) {
    const err = await apiError(conn.res, 'gemini', '生成');
    conn.release();
    const tc = body.generationConfig.thinkingConfig;
    const civic = body.safetySettings.some(s => s.category.includes('CIVIC'));
    if (civic && /CIVIC/i.test(err.body || '')) { NO_CIVIC.add(model); body.safetySettings = body.safetySettings.filter(s => !s.category.includes('CIVIC')); }
    else if (!tc || !/think/i.test(err.body || '')) throw err;
    else if ('thinkingLevel' in tc || 'thinkingBudget' in tc) { delete tc.thinkingLevel; delete tc.thinkingBudget; GEMINI_THINK_FALLBACK.set(model, 'level'); }
    else { delete body.generationConfig.thinkingConfig; GEMINI_THINK_FALLBACK.set(model, 'all'); }
    conn = await send();
  }
  const { res, ac, release } = conn;
  if (!res.ok) { release(); throw await apiError(res, 'gemini', '生成'); }

  const decoder = new TextDecoder();
  let buf = '', full = '', reasoning = '', stop = null, usage = null, blockReason = null;
  const blockedCats = new Set();
  let idle = false, idleTimer = null;
  const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { idle = true; ac.abort(); }, idleMs()); };
  bump();
  try {
    // 和 OpenAI 相容一樣：最後一行沒有換行就結束時，補一個換行再處理一次，不會被丟掉
    const chunks = (async function* () { for await (const c of res.body) yield decoder.decode(c, { stream: true }); yield decoder.decode() + '\n'; })();
    for await (const text of chunks) {
      bump();
      buf += text;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let j;
        try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        const um = j.usageMetadata;
        if (um && (um.promptTokenCount || um.candidatesTokenCount)) {
          usage = { input: um.promptTokenCount || 0, output: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0) };
          if (um.cachedContentTokenCount) usage.cached = um.cachedContentTokenCount;
        }
        // 輸入就被擋下：沒有 candidates，只有 promptFeedback
        if (j.promptFeedback?.blockReason) blockReason = j.promptFeedback.blockReason;
        for (const r of j.promptFeedback?.safetyRatings || []) if (r.blocked) blockedCats.add(r.category);
        const c = (j.candidates || [])[0];
        if (!c) continue;
        for (const p of c.content?.parts || []) {
          if (typeof p.text !== 'string' || !p.text) continue;
          if (p.thought) { reasoning += p.text; onReasoning(p.text); }
          else { full += p.text; onText(p.text); }
        }
        for (const r of c.safetyRatings || []) if (r.blocked) blockedCats.add(r.category);
        if (c.finishReason) stop = c.finishReason;
      }
    }
  } catch (e) {
    if (idle) throw Object.assign(new Error('API 超過 5 分鐘沒有送出新內容，連線可能已經中斷；已經產生的內容會保留，可以按「繼續」接著寫'), { retryable: !full && !reasoning });
    throw e;
  } finally { clearTimeout(idleTimer); release(); }

  // 結束原因換成和其他供應商一致的寫法（用完長度＝length）
  const reason = blockReason || stop;
  const stopReason = !reason ? null : reason === 'STOP' ? 'stop' : reason === 'MAX_TOKENS' ? 'length' : String(reason).toLowerCase();
  const blocked = !!blockReason || /safety|prohibited|blocklist|recitation|spii/i.test(String(stop || ''));
  const cats = [...blockedCats].map(c => HARM_NAMES[c] || c).join('、');
  // PROHIBITED_CONTENT、BLOCKLIST、SPII 是 Google 不開放調整的政策過濾，安全設定關不掉
  const fixed = /prohibited|blocklist|spii/i.test(String(reason || ''));
  const why = fixed
    ? `Google 不開放調整的內容政策擋下（結束原因：${reason}；這一類無法用安全設定關閉）`
    : `Gemini 的安全審查擋下${cats ? `（類別：${cats}）` : ''}（結束原因：${reason}）`;
  // 輸入就被擋下（promptFeedback）：是送出去的內容觸發的；否則是 AI 寫的回覆觸發的
  const where = blockReason
    ? '是送出的內容觸發的（角色卡、世界書、記憶、聊天紀錄或你的訊息，不一定是最後一則），重新生成也會一樣；請找出並修改觸發的描述'
    : '是 AI 寫的回覆觸發的；每次生成的內容不同，可以再試一次，或修改最後一則訊息、換一個模型';
  if (!full.trim() && stopReason !== 'length') {
    throw Object.assign(new Error(blocked
      ? `回應被${why}。${where}`
      : `AI 沒有回傳任何內容${reason ? `（結束原因：${reason}）` : ''}。模型可能暫時不穩定或太忙碌，請再試一次，或到「設定」換一個模型`), { retryable: !blocked && !reasoning });
  }
  // 寫到一半被擋下：保留已經寫出來的部分，並註明原因
  if (blocked) { const note = `\n\n（回應被${why}，在這裡中斷）`; full += note; onText(note); }  return { text: full, reasoning, stop_reason: stopReason, usage };
}

// ---------- Anthropic Claude（官方 SDK） ----------
let Anthropic = null;
function getAnthropicSDK() {
  if (!Anthropic) {
    try { Anthropic = require('@anthropic-ai/sdk'); }
    catch { throw new Error('尚未安裝 @anthropic-ai/sdk，請執行 npm install'); }
    Anthropic = Anthropic.default || Anthropic;
  }
  return Anthropic;
}

// 支援伺服器端拒答備援（server-side fallback）的模型
const FALLBACK_MODELS = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
// 不支援 effort 參數的舊模型
const NO_EFFORT = ['claude-haiku-4-5', 'claude-sonnet-4-5'];
// 要用思考預算（budget_tokens）的舊模型（4.5 以前）；4.6 以後用 adaptive：模型自己決定想多少，深度由 effort 控制
const BUDGET_THINK_RE = /^claude-(?:3|(?:opus|sonnet|haiku)-4(?:-[0-5])?(?:-\d{8})?$)/;
const CLAUDE_BUDGET = { low: 2048, medium: 6144, high: 12288, xhigh: 16384, max: 24576 };
// 思考設定被模型拒絕過（key＝模型與設定）：記住改用第幾種寫法，下次直接用
const CLAUDE_THINK_FALLBACK = new Map();
/**
 * Claude 的思考設定依序可以用的寫法（第一種被拒絕就換下一種）。cfg.thinking：'on' 開啟／'off' 關閉／'' 不指定（模型預設）。
 * 各模型能接受的寫法不同：新模型的思考預設開著，有的不能 disabled（要用 between_tools，或只能把 effort 調到最低）
 */
function claudeThinkPlans(cfg, maxTokens) {
  const canEffort = !NO_EFFORT.includes(cfg.model);
  const effort = canEffort && cfg.effort ? cfg.effort : null;
  const budget = () => {
    const b = Math.min(CLAUDE_BUDGET[cfg.effort] || CLAUDE_BUDGET.medium, maxTokens - 1024);
    return b >= 1024 ? { type: 'enabled', budget_tokens: b } : null; // 回應上限太小就不開（思考預算一定要小於上限）
  };
  if (cfg.thinking === 'on') return BUDGET_THINK_RE.test(cfg.model) ? [{ thinking: budget(), effort }]
    : [{ thinking: { type: 'adaptive', display: 'summarized' }, effort }, { thinking: { type: 'adaptive' }, effort }, { thinking: budget(), effort }];
  if (cfg.thinking === 'off') return [
    { thinking: { type: 'disabled' }, effort },
    { thinking: { type: 'between_tools' }, effort: ['xhigh', 'max'].includes(effort) ? 'high' : effort },
    { thinking: null, effort: canEffort ? 'low' : null }, // 關不掉思考的模型：改用最低的 effort
  ];
  return [{ thinking: null, effort }];
}
/** 這個錯誤是不是思考設定被拒絕（換一種寫法再試） */
const isThinkReject = e => e?.status === 400 && /thinking|effort|budget|display|between_tools/i.test(String(e.message || ''));

/**
 * 整理訊息：開頭的 system 合併成一則，中途的 system（後置指令、深度注入的世界書）改成使用者端的系統備註，
 * 並合併相鄰的同角色訊息，第一則非 system 一定是 user。
 * 很多本機模型的對話模板只允許 system 出現在最前面、而且 user/assistant 必須交替，否則會報錯。
 */
function normalizeMessages(messages) {
  const systemParts = [];
  let i = 0;
  while (i < messages.length && messages[i].role === 'system') systemParts.push(messages[i++].content);
  const out = [];
  for (; i < messages.length; i++) {
    let { role, content } = messages[i];
    if (role === 'system') { role = 'user'; content = `[系統備註：${content}]`; }
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n\n' + content;
    else out.push({ role, content });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: '[對話開始]' });
  return { system: systemParts.filter(Boolean).join('\n\n'), messages: out };
}
/** 轉成 Claude 格式：system 放在 system 參數 */
function toClaudeMessages(messages) {
  const { system, messages: out } = normalizeMessages(messages);
  // 新模型不支援 assistant 預填，最後一則必須是 user
  if (out[out.length - 1].role === 'assistant') out.push({ role: 'user', content: '[請接續上一則回應繼續寫下去]' });
  return { system, messages: out };
}
/** OpenAI 相容格式：system 只放在第一則 */
function toCompatMessages(messages) {
  const { system, messages: out } = normalizeMessages(messages);
  return system ? [{ role: 'system', content: system }, ...out] : out;
}

async function streamAnthropic({ settings, messages, signal, onText, onReasoning = () => {} }) {
  const SDK = getAnthropicSDK();
  const apiKey = getApiKey('anthropic');
  if (!apiKey) throw new Error('尚未設定 Anthropic API 金鑰（環境變數 ANTHROPIC_API_KEY 或 userdata/config.json）');
  const client = new SDK({ apiKey, maxRetries: 0 }); // 重試由 streamChat 統一處理（次數跟著設定）
  const cfg = settings.anthropic;
  const { system, messages: msgs } = toClaudeMessages(messages);

  const params = {
    model: cfg.model,
    max_tokens: Number(settings.max_tokens) || 4096,
    system,
    messages: msgs,
    cache_control: { type: 'ephemeral' }, // 自動提示快取：長對話可大幅降低成本
  };
  const plans = claudeThinkPlans(cfg, params.max_tokens);
  const planKey = `${cfg.model}|${cfg.thinking || ''}|${cfg.effort || ''}|${params.max_tokens}`;
  let planIdx = Math.min(CLAUDE_THINK_FALLBACK.get(planKey) || 0, plans.length - 1);
  const usePlan = () => {
    const { thinking, effort } = plans[planIdx];
    if (thinking) params.thinking = thinking; else delete params.thinking;
    if (effort) params.output_config = { effort }; else delete params.output_config;
  };
  usePlan();

  // 和 OpenAI 相容／Gemini 一樣：超過 5 分鐘沒有任何新事件（含 ping、思考內容）就視為連線中斷。
  // SDK 的逾時只管連線階段，開始串流後對方停住就會一直等；按「停止」照樣經由 signal 中止
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort); }
  let idle = false, idleTimer = null;
  const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { idle = true; ac.abort(); }, idleMs()); };

  const useFallback = cfg.fallbacks && FALLBACK_MODELS.includes(cfg.model);
  let full = '', reasoning = '', final;
  bump();
  try {
    for (;;) {
      try {
        const stream = useFallback
          ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal: ac.signal })
          : client.messages.stream(params, { signal: ac.signal });
        for await (const event of stream) {
          bump();
          if (event.type !== 'content_block_delta') continue;
          if (event.delta.type === 'text_delta') { full += event.delta.text; onText(event.delta.text); }
          else if (event.delta.type === 'thinking_delta' && event.delta.thinking) { reasoning += event.delta.thinking; onReasoning(event.delta.thinking); }
        }
        final = await stream.finalMessage();
        break;
      } catch (e) {
        // 這個模型不接受這種思考設定：還沒輸出任何內容時換下一種寫法，並記住
        if (!idle && !full && !reasoning && planIdx < plans.length - 1 && isThinkReject(e)) {
          planIdx++; CLAUDE_THINK_FALLBACK.set(planKey, planIdx); usePlan(); bump();
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    if (idle) throw Object.assign(new Error('API 超過 5 分鐘沒有送出新內容，連線可能已經中斷；已經產生的內容會保留，可以按「繼續」接著寫'), { retryable: !full && !reasoning });
    throw localizeClaudeError(e, '生成');
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (final.stop_reason === 'refusal') {
    const note = '\n\n（模型拒絕回應此請求' + (final.stop_details && final.stop_details.category ? `：${final.stop_details.category}` : '') + '）';
    full += note;
    onText(note);
  }
  const u = final.usage || {};
  const usage = { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0 };
  if (u.cache_read_input_tokens) usage.cached = u.cache_read_input_tokens;
  return { text: full, reasoning, stop_reason: final.stop_reason, model: final.model, usage };
}

/** 這個錯誤是不是暫時的（可以重試） */
function isRetryable(e) {
  if (e.retryable) return true;
  // Anthropic SDK 的錯誤：連線失敗、逾時，或暫時性的狀態碼
  if (/APIConnection|Timeout/i.test(e.constructor?.name || e.name || '')) return true;
  return typeof e.status === 'number' && e.status !== 502 && RETRY_STATUS.has(e.status);
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
  const t = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
  function onAbort() { clearTimeout(t); reject(Object.assign(new Error('已停止'), { name: 'AbortError' })); }
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * 串流生成。連線失敗、太頻繁（429）、伺服器錯誤時自動重試（最多 settings.retry_max 次，間隔 2、4、8… 秒）；
 * 已經開始輸出文字後才出錯就不重試（保留已經寫出來的部分）。onRetry({ attempt, max, wait, error }) 通知畫面。
 */
async function streamChat(opts) {
  const max = Math.min(5, Math.max(0, Math.floor(Number(opts.settings.retry_max ?? 2)) || 0));
  const impl = opts.settings.provider === 'anthropic' ? streamAnthropic : useGeminiNative(opts.settings) ? streamGemini : streamOpenAI;
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      return await impl({
        ...opts,
        onText: t => { started = true; opts.onText(t); },
        onReasoning: t => { started = true; (opts.onReasoning || (() => {}))(t); },
      });
    } catch (e) {
      if (started || attempt >= max || opts.signal?.aborted || e.name === 'AbortError' || !isRetryable(e)) {
        if (attempt > 0 && !started) e.message += `（已自動重試 ${attempt} 次）`;
        throw e;
      }
      const wait = Math.min(15000, 2000 * 2 ** attempt);
      opts.onRetry?.({ attempt: attempt + 1, max, wait, error: String(e.message || e).slice(0, 200) });
      await sleep(wait, opts.signal);
    }
  }
}

/** 取得模型清單（OpenAI 相容 /models；Claude 用 SDK） */
/** 取得模型清單最多等 20 秒（平台沒回應時不會一直卡住） */
const LIST_TIMEOUT = 20000;
async function timedFetch(url, opts) {
  try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(LIST_TIMEOUT) }); }
  catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`取得模型清單超過 ${LIST_TIMEOUT / 1000} 秒沒有回應，請確認 API 位址是否正確、平台是否正常`);
    throw new Error(`無法連線到 ${url.replace(/\?.*$/, '')}：${e.cause?.code || e.message}`);
  }
}
async function listModels(settings) {
  if (settings.provider === 'anthropic') {
    const SDK = getAnthropicSDK();
    const key = typeof settings._key === 'string' ? settings._key : getApiKey('anthropic');
    if (!key) throw new Error('請先填入 Anthropic API 金鑰');
    const client = new SDK({ apiKey: key, timeout: LIST_TIMEOUT, maxRetries: 0 });
    const ids = [];
    try { for await (const m of client.models.list()) ids.push(m.id); }
    catch (e) { throw localizeClaudeError(e, '取得模型清單'); }
    return ids;
  }
  const t = compatTarget(settings);
  if (useGeminiNative(settings)) {
    // 用 Gemini 原生 API 列出可對話的模型（金鑰放在標頭，不放網址）
    if (!t.key) throw new Error('請先填入 Gemini API 金鑰並儲存');
    const gres = await timedFetch(GEMINI_NATIVE + '/models?pageSize=1000', { headers: { 'x-goog-api-key': t.key } });
    if (!gres.ok) throw await apiError(gres, 'gemini', '取得模型清單');
    const gj = await gres.json();
    return (gj.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name).replace(/^models\//, ''))
      .filter(id => /gemini|gemma/i.test(id) && !/embedding|aqa|tts|image|veo|imagen/i.test(id))
      .sort();
  }
  const res = await timedFetch(t.base + '/models', {
    headers: t.key ? { Authorization: 'Bearer ' + t.key } : {},
  });
  if (!res.ok) throw await apiError(res, t.provider, '取得模型清單');
  const j = await res.json();
  // Gemini 回傳的 id 形如 models/gemini-…，聊天時用不含前綴的名稱
  return [...new Set((j.data || []).map(m => String(m.id).replace(/^models\//, '')))].sort();
}

module.exports = { streamChat, listModels, toClaudeMessages, streamAnthropic, claudeThinkPlans };
