'use strict';
// AI 酒館 前端 — 設定頁：API 設定（模型設定檔、供應商、生成參數）、提示詞設定、外觀、資料（備份與搬家）、使用者
// 這些檔案依序載入（見 index.html），共用同一個全域範圍；最後由 main.js 啟動
// ===================== 設定 =====================
$('#btnWorlds2').onclick = () => openWorlds().catch(fail);
const KEY_MASK = '●'.repeat(16); // 已儲存金鑰的遮罩（只用來顯示，永遠不會被當成金鑰送出）
// 整串都是遮罩符號（含不小心刪掉或多打幾個）：當成「沒有改」，不會把遮罩符號存成金鑰
const isMask = v => /^●+$/.test(v);
// 模型設定檔包含的欄位（和伺服器 lib/storage.js 的 PROFILE_FIELDS 相同）；綠色「儲存」只存這些
const PROFILE_FIELDS = ['provider', 'openai', 'gemini', 'anthropic', 'max_tokens', 'context_tokens', 'temperature', 'top_p', 'repetition_penalty',
  'retry_max', 'director_history'];

async function openSettings() {
  const { settings: s, keys, version, languages = {} } = await api('GET', '/api/settings');
  state.worlds = await api('GET', '/api/worlds');
  const prof = await api('GET', '/api/profiles');
  const f = {};
  const inp = (key, attrs = {}) => (f[key] = h('input', { type: 'text', ...attrs }));
  // API 金鑰欄：用一般文字欄位加上遮罩樣式，而不是 type=password，瀏覽器就不會跳出「儲存密碼」
  // 已經存過金鑰時顯示一串遮罩符號（不是真的金鑰），和「沒有金鑰」一眼就能分開；直接輸入新的就會取代。
  // 右邊的按鈕切換顯示／隱藏：顯示時才向伺服器讀取已儲存的金鑰（data-orig 記住原本的值，沒改就不重新儲存），可以直接檢查、修改
  const keyInput = (key, placeholder, p) => {
    const saved = keys[p].source === 'config';
    const el = inp(key, {
      class: 'secret', placeholder: keys[p].source === 'env' ? '已由環境變數提供' : placeholder, value: saved ? KEY_MASK : '',
      autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
      name: 'k' + Math.random().toString(36).slice(2), 'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-form-type': 'other',
      onfocus: () => { if (el.value === KEY_MASK) el.select(); },
    });
    const btn = h('button', { type: 'button', class: 'key-toggle' });
    const paint = () => {
      const shown = !el.classList.contains('secret');
      btn.replaceChildren(icon(shown ? 'eye-off' : 'eye'));
      btn.title = shown ? '隱藏金鑰' : '顯示金鑰';
      btn.setAttribute('aria-label', btn.title);
    };
    btn.onclick = async () => {
      try {
        if (el.classList.contains('secret') && isMask(el.value)) {
          const r = await api('GET', '/api/keys/' + p);
          if (r.source === 'config') { el.value = el.dataset.orig = r.key; }
        }
        el.classList.toggle('secret');
        paint();
      } catch (e) { fail(e); }
    };
    paint();
    return keys[p].source === 'env' ? el : h('div', { class: 'key-field' }, el, btn);
  };
  const keyLabel = p => keys[p].source === 'env' ? '（已由環境變數提供）' : keys[p].set ? '（已儲存；按右邊的眼睛可以顯示、檢查）' : '（尚未設定）';
  const steps = (...items) => h('ol', { class: 'setup-steps' }, items.map(t => h('li', {}, t)));

  const provider = f.provider = h('select', {}, h('option', { value: 'openai' }, 'OpenAI 相容 API（OpenAI / OpenRouter / DeepSeek / LM Studio / Ollama…）'), h('option', { value: 'gemini' }, 'Google Gemini'), h('option', { value: 'anthropic' }, 'Anthropic Claude'));
  provider.value = s.provider;
  // 模型欄位：可手動輸入，按「取得模型清單」後出現下拉選單
  const pickers = {};
  const modelField = (p, key, value) => {
    const input = inp(key, { value, placeholder: '輸入模型名稱，或按「取得模型清單」' });
    const sel = h('select', { hidden: true, onchange: () => { if (sel.value) input.value = sel.value; showCtxNote(); } });
    input.addEventListener('input', () => showCtxNote());
    pickers[p] = { input, sel };
    return h('label', {}, h('span', {}, '模型'),
      h('div', { style: 'display:flex;gap:6px' }, input, h('button', { type: 'button', onclick: () => fetchModels(p) }, '取得模型清單')), sel);
  };
  const thinkSel = (key, value) => {
    const el = f[key] = h('select', {},
      [['', '不指定（模型預設）'], ['none', '關閉思考'], ['low', '低'], ['medium', '中'], ['high', '高']].map(([v, t]) => h('option', { value: v }, t)));
    el.value = value || '';
    return h('label', {}, h('span', {}, '思考程度（只對思考型模型有效；思考也會佔用「最大回應 tokens」）'), el);
  };
  const saveStep = '按最下方的「儲存設定」。想把這組設定保存起來、以後一鍵切換，再按上方的「另存新設定檔」。';
  const oaBox = h('fieldset', {}, h('legend', {}, 'OpenAI 相容 API'),
    steps('填「API 位址」：使用的平台會在 API 文件裡提供，通常以 /v1 結尾（例如 OpenRouter 是 https://openrouter.ai/api/v1）。',
      '填「API 金鑰」：在平台的帳號或 API 頁面建立；本機模型（LM Studio、Ollama）可以留空。',
      '按「取得模型清單」，從出現的下拉選單選擇模型（平台不提供清單時，也可以直接輸入模型名稱）。',
      saveStep),
    h('label', {}, h('span', {}, 'API 位址（Base URL）'), inp('oa_url', { value: s.openai.base_url, placeholder: 'https://api.openai.com/v1' })),
    h('p', { class: 'muted' }, '本機：LM Studio 預設 http://127.0.0.1:1234/v1，Ollama 預設 http://127.0.0.1:11434/v1'),
    h('label', {}, h('span', {}, 'API 金鑰 ' + keyLabel('openai') + '（本機模型可留空）'), keyInput('oa_key', 'sk-…', 'openai')),
    modelField('openai', 'oa_model', s.openai.model),
    thinkSel('oa_think', s.openai.reasoning_effort));
  const gmBox = h('fieldset', {}, h('legend', {}, 'Google Gemini'),
    steps('到 Google AI Studio（aistudio.google.com）登入後建立 API 金鑰，貼到下方「API 金鑰」。',
      '按「取得模型清單」，從出現的下拉選單選擇模型。',
      saveStep),
    h('label', {}, h('span', {}, 'API 金鑰 ' + keyLabel('gemini')), keyInput('gm_key', 'AIza…', 'gemini')),
    modelField('gemini', 'gm_model', s.gemini.model),
    thinkSel('gm_think', s.gemini.reasoning_effort));
  const anBox = h('fieldset', {}, h('legend', {}, 'Anthropic Claude'),
    steps('到 Claude Console（console.anthropic.com）建立 API 金鑰，貼到下方「API 金鑰」。',
      '模型可以保留預設，或按「取得模型清單」從下拉選單選擇。',
      saveStep),
    h('label', {}, h('span', {}, 'API 金鑰 ' + keyLabel('anthropic')), keyInput('an_key', 'sk-ant-…', 'anthropic')),
    modelField('anthropic', 'an_model', s.anthropic.model),
    h('label', {}, h('span', {}, '思考（開啟時會顯示思考過程；思考也會佔用「最大回應 tokens」）'), f.an_think = h('select', {},
      [['', '不指定（模型預設）'], ['on', '開啟'], ['off', '關閉']].map(([v, t]) => h('option', { value: v }, t)))),
    h('p', { class: 'muted small-note' }, '新版 Claude（例如 Opus 5.5）不指定時也會自己思考，只是不顯示過程；有些模型無法完全關閉思考，選「關閉」時會改用最低的 Effort。'),
    h('label', {}, h('span', {}, 'Effort（思考深度，越高越慢越貴）'), f.an_effort = h('select', {}, ['', 'low', 'medium', 'high', 'xhigh', 'max'].map(v => h('option', { value: v }, v || '（不指定）')))),
    h('label', { class: 'check' }, f.an_fb = h('input', { type: 'checkbox', checked: s.anthropic.fallbacks }), '模型拒答時自動改用備援模型（server-side fallback）'),
    h('p', { class: 'muted' }, '注意：新版 Claude 模型不接受 temperature / top_p，這兩項只套用在 OpenAI 相容 API。'));
  f.an_effort.value = s.anthropic.effort || '';
  f.an_think.value = s.anthropic.thinking || '';
  const sync = () => { oaBox.hidden = provider.value !== 'openai'; gmBox.hidden = provider.value !== 'gemini'; anBox.hidden = provider.value !== 'anthropic'; };
  provider.onchange = () => { sync(); showCtxNote(); }; sync();

  async function fetchModels(p) {
    try {
      // 用畫面上填的位址與金鑰取清單，不先儲存（以前會先存，新增設定檔時會把預設值寫進目前使用中的設定檔）。
      // 金鑰欄沒改（遮罩）就用存好的；新增設定檔時金鑰欄是空的＝不用金鑰
      const keyEl = { openai: f.oa_key, gemini: f.gm_key, anthropic: f.an_key }[p];
      const kv = keyEl.value.trim();
      const body = { provider: p, ...(p === 'openai' ? { base_url: f.oa_url.value.trim() } : {}) };
      if (kv && !isMask(kv)) body.api_key = kv; else if (modelNew && !kv) body.api_key = '';
      const { models, context } = await api('POST', '/api/models', body);
      modelCtx[p] = context || {};
      const { input, sel } = pickers[p];
      if (!models.length) return toast('沒有取得任何模型。本機模型請確認已在 LM Studio / Ollama 載入模型', true);
      sel.innerHTML = '';
      sel.append(h('option', { value: '' }, `— 從清單選擇模型（共 ${models.length} 個）—`), ...models.map(m => h('option', { value: m }, m)));
      sel.hidden = false;
      if (models.includes(input.value)) { sel.value = input.value; toast(`取得 ${models.length} 個模型`); }
      else {
        // 目前填的模型不在清單裡（例如預設值），自動選第一個，避免送出不存在的模型
        // Gemini：優先選 gemini-flash-latest（Google 維護的穩定版別名，會跟著換成新的正式版）；
        // 沒有的話選版本號最新的 flash。剛推出的最新版常常太忙碌（503、等很久才開始回應），舊型號又可能不開放給新使用者
        const ver = m => { const x = /^gemini-(\d+(?:\.\d+)?)-flash$/.exec(m); return x ? parseFloat(x[1]) : -1; };
        const newestFlash = models.filter(m => ver(m) >= 0).sort((a, b) => ver(b) - ver(a))[0];
        const pick = models.find(m => m === 'gemini-flash-latest') || newestFlash
          || models.find(m => !/preview|exp|lite|live|computer|tts|transcribe|embed/.test(m)) || models[0];
        input.value = sel.value = pick;
        toast(`取得 ${models.length} 個模型，已自動選擇「${pick}」，可從下拉選單更換`);
      }
      sel.focus();
      showCtxNote();
    } catch (e) { fail(e); }
  }
  // 模型的上下文長度（取得模型清單時平台有提供的：OpenRouter、Gemini、LM Studio 等）：顯示在「上下文長度」下面，
  // 設定超過時提醒，可以一鍵改成模型的長度。LM Studio 以目前載入時設定的長度為準
  const modelCtx = {}; // 供應商 → { 模型 id: { max, loaded? } }
  const ctxNote = h('p', { class: 'small-note ctx-model', hidden: true });
  const fmtN = n => Number(n).toLocaleString('en-US');
  function showCtxNote() {
    const p = provider.value, id = pickers[p]?.input.value.trim();
    const info = id && modelCtx[p]?.[id];
    ctxNote.hidden = !info;
    if (!info || !f.context_tokens) return;
    const limit = info.loaded || info.max;
    const cur = +f.context_tokens.value || 0;
    const over = cur > limit;
    ctxNote.classList.toggle('warn', over);
    ctxNote.innerHTML = '';
    // Ollama 沒在 Modelfile 寫 num_ctx 時，實際載入的長度看它自己的設定（通常比模型上限小很多），不提供一鍵套用上限
    const ollamaUnknown = info.ollama && !info.loaded;
    ctxNote.append(info.ollama
      ? (info.loaded
        ? `「${id}」在 Ollama 設定的上下文長度（num_ctx）是 ${fmtN(info.loaded)}（模型最多支援 ${fmtN(info.max)}）。`
        : `「${id}」最多支援 ${fmtN(info.max)}。Ollama 實際用的長度看它的設定（Modelfile 的 num_ctx，或環境變數 OLLAMA_CONTEXT_LENGTH），沒有特別設定時通常小很多，上下文長度請設成不超過 Ollama 實際載入的長度。`)
      : info.loaded
        ? `「${id}」在 LM Studio 目前載入的上下文長度是 ${fmtN(info.loaded)}（模型最多支援 ${fmtN(info.max || info.loaded)}）。`
        : `「${id}」的上下文長度上限是 ${fmtN(info.max)}。`,
      over ? `目前設定的 ${fmtN(cur)} 超過了，可能會出錯或回應被截斷。` : '');
    const want = Math.max(512, Math.floor(limit / 512) * 512);
    if (cur !== want && !ollamaUnknown) ctxNote.append(' ', h('button', { type: 'button', class: 'small', onclick: () => { f.context_tokens.value = want; showCtxNote(); } }, `設成 ${fmtN(want)}`));
  }

  const num = (key, v, attrs) => (f[key] = h('input', { type: 'number', value: v, ...attrs }));
  /** 頁面底部左側的紅色「恢復預設」按鈕（只恢復那一頁） */
  const resetRow = run => h('div', { class: 'reset-row' },
    h('button', { type: 'button', class: 'danger', onclick: () => run().catch(fail) }, ic('list-restart', '恢復預設')));
  /** 下拉選單：選項是 [值, 文字]；目前的值不在選項裡時，補一個「自訂」選項 */
  const optSel = (value, opts) => {
    const el = h('select', {}, opts.map(([v, t]) => h('option', { value: String(v) }, t)));
    if (!opts.some(([v]) => String(v) === String(value))) el.append(h('option', { value: String(value) }, `自訂：${value}`));
    el.value = String(value);
    return el;
  };
  // 對話語言的選單與提醒文字（見提示詞設定頁）
  const LANG_OPTS = [['zh-TW', '繁體中文'], ['zh-CN', '简体中文'], ['en', 'English'], ['ja', '日本語']];
  const langSel = h('select', { class: 'lang-sel' }, LANG_OPTS.map(([v, t]) => h('option', { value: v }, t)),
    h('option', { value: 'custom', class: 'opt-custom' }, '（自訂）'));
  const langNote = h('textarea', { rows: 3 });
  /** 切換成某個語言（帶入預設文字），或 'custom'（帶入自訂的文字） */
  const setLang = v => {
    langSel.value = v === 'custom' || Object.hasOwn(languages, v) ? v : 'zh-TW';
    langNote.value = langSel.value === 'custom' ? s.language_custom || '' : languages[langSel.value] || '';
    langSel.classList.toggle('custom', langSel.value === 'custom');
  };
  setLang(s.reply_language || 'zh-TW');
  // 選語言：換成那個語言的預設文字；選「（自訂）」：輸入框的文字不動，直接當成自訂的內容送出
  langSel.onchange = () => {
    const custom = langSel.value === 'custom';
    if (!custom) langNote.value = languages[langSel.value] || '';
    langSel.classList.toggle('custom', custom);
  };
  langNote.addEventListener('input', () => {
    // 改回和某個語言的預設文字一模一樣：當成選了那個語言
    const same = LANG_OPTS.find(([v]) => languages[v] === langNote.value);
    langSel.value = same ? same[0] : 'custom';
    langSel.classList.toggle('custom', !same);
  });
  const worldChecks = state.worlds.map(w => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: w.id, checked: (s.world_ids || []).includes(w.id) }), w.name));

  // 使用者頭像：選好圖片就直接上傳（使用中的使用者設定檔的頭像也一起更新）。
  // 正在「新增使用者設定檔」時先不上傳，只預覽（pendingAvatar），按「儲存」建立設定檔時才存成那個設定檔的頭像
  let pendingAvatar; // undefined＝沿用目前的頭像；字串＝新選的圖片；null＝不要頭像
  const avSlot = h('div', { class: 'user-av-slot' });
  const renderAv = () => {
    avSlot.innerHTML = '';
    const pickAv = async () => {
      const cropped = await pickImage(1600, { crop: {} });
      if (!cropped) return;
      if (personaNew) { pendingAvatar = cropped; renderAv(); markPersonaDirty(); return; }
      try {
        await api('PUT', '/api/user/avatar', { image: cropped });
        await refreshAvatarState(); renderAv(); toast('頭像已更新');
      } catch (err) { fail(err); }
    };
    const removeAv = async () => {
      if (personaNew) { pendingAvatar = null; renderAv(); markPersonaDirty(); return; }
      await api('PUT', '/api/user/avatar', { image: null }).catch(fail);
      await refreshAvatarState(); renderAv(); toast('已移除頭像');
    };
    const name = f.user_name?.value || s.user_name;
    const preview = personaNew && pendingAvatar !== undefined
      ? (pendingAvatar ? h('img', { src: pendingAvatar, class: 'user-av-prev', alt: '' }) : defaultUserAv('user-av-prev'))
      : userAvatarEl('user-av-prev', { global: true });
    const hasAv = personaNew && pendingAvatar !== undefined ? !!pendingAvatar : !!state.settings?.user_avatar;
    avSlot.append(preview,
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'small', onclick: pickAv }, '更換頭像'),
        hasAv ? h('button', { type: 'button', class: 'small', onclick: removeAv }, '移除') : null));
  };
  /** 頭像改了：重新讀取頭像版本號（使用中的使用者設定檔的頭像也會一起更新） */
  const refreshAvatarState = async () => {
    const r = await api('GET', '/api/settings');
    state.settings = { ...(state.settings || s), user_avatar: r.settings.user_avatar, personas: r.settings.personas };
  };
  state.settings = { ...(state.settings || {}), ...s };

  // 「（新增設定檔）」：欄位清空、填入預設值，按「儲存」才建立設定檔（用預設的名稱）；沒儲存就離開不會有任何改變
  let modelNew = false, personaNew = false;
  let defaults = null;
  const getDefaults = async () => (defaults ||= await api('GET', '/api/settings/defaults'));
  /** 把模型設定檔的欄位（連線設定、生成參數）填回預設值；keys：連金鑰欄也清空 */
  const fillModelDefaults = (d, { keys = false } = {}) => {
    provider.value = d.provider; sync();
    f.oa_url.value = d.openai.base_url || ''; f.oa_model.value = d.openai.model || ''; f.oa_think.value = d.openai.reasoning_effort || '';
    f.gm_model.value = d.gemini.model || ''; f.gm_think.value = d.gemini.reasoning_effort || '';
    f.an_model.value = d.anthropic.model || ''; f.an_effort.value = d.anthropic.effort || ''; f.an_think.value = d.anthropic.thinking || ''; f.an_fb.checked = !!d.anthropic.fallbacks;
    for (const k of ['max_tokens', 'context_tokens', 'temperature', 'top_p', 'repetition_penalty']) f[k].value = d[k];
    f.retry_max.value = String(d.retry_max); f.director_history.value = String(d.director_history);
    for (const p of Object.values(pickers)) p.sel.hidden = true;
    if (keys) for (const el of [f.oa_key, f.gm_key, f.an_key]) el.value = '';
  };

  // 模型設定檔：把整組連線設定（含金鑰）存起來，之後一鍵切換
  const profSel = h('select', {}, h('option', { value: '', class: 'opt-new' }, '（新增設定檔）'),
    prof.profiles.map(p => h('option', { value: p.id }, `${p.name}｜${p.model || '未選模型'}`)));
  profSel.value = prof.active; // 一定有一個使用中的設定檔（伺服器保證）
  profSel.onchange = async () => {
    try {
      if (!profSel.value) return enterModelNew();
      const r = await api('POST', `/api/profiles/${profSel.value}/apply`); state.settings = r.settings;
      toast(profSel.value === prof.active ? '已載回設定檔存的內容（捨棄修改）' : '已切換設定檔');
      openSettings().catch(fail);
    } catch (e) { fail(e); }
  };
  async function enterModelNew() {
    fillModelDefaults(await getDefaults(), { keys: true });
    modelNew = true;
    profSel.classList.remove('dirty'); profSel.querySelector('option[value="__dirty"]')?.remove(); profSel.value = '';
    for (const b of profBox.querySelectorAll('.prof-active')) b.hidden = true;
    profNewSave.hidden = false;
    profNote.textContent = '新增設定檔：欄位已清空並填入預設值。填好供應商、金鑰與模型後，按右方的「儲存」可以自己取名建立；按最下方的「儲存設定」會直接用模型名稱建立。沒有儲存就離開，不會建立也不會改變任何設定。';
    toast('已帶入預設值：按「儲存」或「儲存設定」才會建立設定檔', false, 5000);
  }
  /**
   * 用畫面上目前填的模型設定建立新的設定檔，並切換過去（name 留空＝用模型名稱）。
   * 內容直接放進新設定檔，原本使用中的設定檔不會被改到。
   * 金鑰：畫面上新填的就用它；新增模式下金鑰欄空白＝不帶金鑰；沒改（遮罩）＝沿用目前存好的
   */
  async function createModelProfile(name = '') {
    const keyEl = { openai: f.oa_key, gemini: f.gm_key, anthropic: f.an_key }[provider.value];
    const kv = (keyEl?.value || '').trim();
    const body = { name, fields: modelFields() };
    if (kv && !isMask(kv)) body.key = kv; else if (modelNew && !kv) body.key = '';
    const r = await api('POST', '/api/profiles', body);
    return r.profiles.find(p => p.id === r.id)?.name;
  }
  const currentModel = () => (f[{ openai: 'oa_model', gemini: 'gm_model', anthropic: 'an_model' }[provider.value]]?.value || '').trim();
  const activeName = prof.profiles.find(p => p.id === prof.active)?.name;
  let profNote;
  const profNewSave = h('button', { type: 'button', class: 'success', hidden: true, title: '用目前填的內容建立新的模型設定檔', onclick: async () => {
    const asked = await askText('新增模型設定檔', { note: '設定檔的名稱（之後可以重新命名）', value: currentModel(), okText: '建立' }); if (asked == null) return;
    try { const name = await createModelProfile(asked); toast(`已建立設定檔「${name}」`); openSettings().catch(fail); } catch (e) { fail(e); }
  } }, ic('save', '儲存'));
  const profBox = h('fieldset', {}, h('legend', {}, '模型設定檔'),
    h('div', { class: 'prof-row' }, profSel, profNewSave,
      h('button', { type: 'button', title: '把下面目前填的設定（含金鑰）存成新的設定檔，並切換過去；原本的設定檔不會被改到', onclick: async () => {
        const name = await askText('另存新的模型設定檔', { note: '把目前填的設定（含金鑰）存成新的設定檔；請輸入名稱', value: currentModel(), okText: '另存' });
        if (name == null) return;
        try { await createModelProfile(name); toast('已存成新的設定檔'); openSettings().catch(fail); } catch (e) { fail(e); }
      } }, ic('plus', '另存新設定檔')),
      h('button', { type: 'button', class: 'prof-active', onclick: async () => {
        const name = await askText('重新命名模型設定檔', { value: activeName || '', okText: '改名' }); if (name == null) return;
        await api('PUT', `/api/profiles/${prof.active}`, { name }).catch(fail); openSettings().catch(fail);
      } }, ic('pencil', '重新命名')),
      h('button', { type: 'button', class: 'success prof-active', title: `只把連線設定、生成參數與金鑰存進「${activeName}」`, onclick: async () => {
        try { await saveAll(false, 'model'); toast(`已儲存到設定檔「${activeName}」`); openSettings().catch(fail); } catch (e) { fail(e); }
      } }, ic('save', '儲存')),
      h('button', { type: 'button', class: 'danger prof-active', onclick: async () => {
        const last = prof.profiles.length <= 1;
        if (!await askConfirm(`刪除設定檔「${activeName}」？\n` + (last
          ? '這是最後一個設定檔：刪除後會用目前的設定重新建立一個（一定要有一個在使用中）。'
          : `刪除後會切換到「${prof.profiles.find(p => p.id !== prof.active)?.name}」，這組設定與它的金鑰不再保存。`))) return;
        await api('DELETE', `/api/profiles/${prof.active}`).catch(fail); openSettings().catch(fail);
      } }, ic('trash-2', '刪除'))),
    profNote = h('p', { class: 'muted small-note' },
      `目前使用「${activeName}」：按右方的「儲存」只儲存這一區的模型設定（連線設定、生成參數與金鑰），並更新這個設定檔；其他分頁還沒儲存的修改不受影響。按最下方的「儲存設定」會儲存所有分頁的設定，這個設定檔也會一起更新。`),
    Object.values(keys).some(k => k.source === 'env') ? h('p', { class: 'muted small-note' }, '注意：有供應商的金鑰是由環境變數提供的，環境變數會優先於設定檔存的金鑰。') : null);

  // 資料備份與搬家：每次啟動自動備份；可以下載、還原、匯出全部資料到別台電腦
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const bkInfo = h('p', { class: 'muted small-note' });
  const bkList = h('div', { class: 'list backup-list' });
  const BK_KIND = { manual: '手動', restore: '還原前' };
  async function renderBackups() {
    const st = await api('GET', '/api/backups');
    bkInfo.textContent = `目前有 ${st.items.length} 份備份，共佔用 ${fmtSize(st.total_size)}（其中圖片 ${fmtSize(st.images_size)}：同一張圖只存一次，多份備份共用，所以角色變多時也不會成倍增加）。`;
    bkList.innerHTML = '';
    if (!st.items.length) bkList.append(h('p', { class: 'muted' }, '還沒有備份。'));
    for (const b of st.items) {
      bkList.append(h('div', { class: 'item' },
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, new Date(b.created).toLocaleString('zh-TW', { hour12: false }),
            b.kind !== 'auto' ? h('span', { class: 'tag bk-kind' }, BK_KIND[b.kind]) : null),
          h('div', { class: 'sub' }, `${fmtSize(b.size)}（文字資料）`)),
        h('button', { type: 'button', class: 'small', title: '把資料換成這份備份的內容（目前的資料會先自動備份）', onclick: async () => {
          if (!await askConfirm(`還原到 ${new Date(b.created).toLocaleString('zh-TW', { hour12: false })} 的備份？\n目前的資料會先自動備份一份，再換成這份備份的內容（API 金鑰不受影響）。`)) return;
          try { await api('POST', `/api/backups/${b.name}/restore`); toast('已還原，重新載入中…'); setTimeout(() => location.reload(), 600); } catch (e) { fail(e); }
        } }, ic('list-restart', '還原')),
        h('button', { type: 'button', class: 'small', title: '下載成一個完整的檔案（含圖片）', onclick: () => exportFile({ kind: 'backup', id: b.name }, `/api/backups/${b.name}/download`) }, ic('save', '下載')),
        h('button', { type: 'button', class: 'small icon', title: '刪除這份備份', onclick: async () => {
          if (!await askConfirm('刪除這份備份？')) return;
          await api('DELETE', `/api/backups/${b.name}`).catch(fail); renderBackups().catch(fail);
        } }, icon('trash-2'))));
    }
  }
  renderBackups().catch(() => {});
  const importInput = h('input', { type: 'file', accept: '.tavern,.gz', hidden: true, onchange: async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    // 大檔案：匯入時伺服器要把整個檔案讀進記憶體，太大會很慢或失敗；建議改成直接複製 userdata 資料夾
    const MB = 1048576, copyTip = '資料很多時，建議改用直接複製資料夾：先關掉兩台電腦的酒館，把舊電腦 AI 酒館資料夾裡的 userdata 資料夾整個複製到新電腦的 AI 酒館資料夾（取代原本的 userdata），再開啟酒館即可（API 金鑰也會一起帶過去）。';
    if (file.size > 1024 * MB) return askConfirm(`「${file.name}」有 ${fmtSize(file.size)}，超過匯入的上限（1 GB）。\n\n${copyTip}`, { okOnly: true }).catch(() => {});
    if (file.size > 300 * MB && !await askConfirm(`「${file.name}」有 ${fmtSize(file.size)}。匯入時要把整個檔案讀進記憶體，可能要等很久，記憶體不夠時也可能失敗。\n\n${copyTip}\n\n仍要用匯入的方式嗎？`)) return;
    if (!await askConfirm(`匯入「${file.name}」？\n目前的角色、對話、世界、世界書與設定會換成檔案裡的內容（目前的資料會先自動備份一份；API 金鑰與連線設定不受影響）。`)) return;
    try {
      toast('匯入中…');
      const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '匯入失敗');
      toast(`已匯入 ${j.restored} 個檔案。API 連線設定沿用這台電腦目前的；檔案裡的模型設定檔也已匯入，切換過去時要重新輸入金鑰。重新載入中…`, false, 6000); setTimeout(() => location.reload(), 2500);
    } catch (err) { fail(err); }
  } });
  const backupBox = h('fieldset', {}, h('legend', {}, '資料備份與搬家'),
    h('div', { class: 'row' },
      h('label', {}, h('span', {}, '每次啟動時自動備份'), f.backup_keep = optSel(s.backup_keep ?? 7,
        [[0, '關閉'], [3, '保留最近 3 份'], [5, '保留最近 5 份'], [7, '保留最近 7 份（建議）'], [10, '保留最近 10 份'], [20, '保留最近 20 份']]))),
    h('p', { class: 'muted small-note' }, '除了最近幾份，也會替最近幾天各留一份（例如保留 7 份＝最近 7 次＋最近 7 天每天最後一份），一天重開好幾次也能回到前幾天的狀態。按「立即備份」的手動備份、還原或匯入前自動留的備份不會被輪替刪掉，不需要時在清單裡自己刪。'),
    bkInfo,
    h('div', { class: 'prof-row' },
      h('button', { type: 'button', onclick: async () => { try { await api('POST', '/api/backups'); toast('已備份'); renderBackups(); } catch (e) { fail(e); } } }, ic('save', '立即備份')),
      h('button', { type: 'button', title: '所有角色、對話、世界、世界書、設定與圖片打包成一個檔案，可以帶到別台電腦', onclick: () => exportFile({ kind: 'all' }, '/api/export') }, ic('export', '匯出全部資料')),
      h('button', { type: 'button', onclick: () => importInput.click() }, ic('import', '匯入資料…')), importInput),
    bkList,
    h('p', { class: 'muted small-note' }, '備份存在 userdata/backups，和上一份完全相同時不會重複建立；超過保留份數時，重新啟動會刪掉最舊的。備份與匯出都不包含 API 金鑰（config.json），換電腦後請重新填寫。'),
    h('p', { class: 'muted small-note' }, '搬到另一台電腦也可以不用匯出、匯入：關掉兩邊的酒館，把 AI 酒館資料夾裡的 userdata 資料夾整個複製過去（取代新電腦原本的 userdata），再開啟酒館即可。資料很多（例如好幾百 MB）時建議用這個方法，API 金鑰也會一起帶過去。'));

  const systemPane = h('div', { class: 'form' },
    profBox,
    keyWarning(), // API 金鑰保護警告：放在模型設定檔下面、填供應商與金鑰之前
    h('label', {}, h('span', {}, 'API 供應商'), provider), oaBox, gmBox, anBox,
    h('fieldset', {}, h('legend', {}, '生成參數'),
      h('div', { class: 'row' },
        h('label', {}, h('span', {}, '上下文長度 tokens'), num('context_tokens', s.context_tokens, { min: 512, step: 512, oninput: () => showCtxNote() })),
        h('label', {}, h('span', {}, '最大回應 tokens'), num('max_tokens', s.max_tokens, { min: 16, step: 16 })),
        h('label', {}, h('span', {}, 'Temperature'), num('temperature', s.temperature, { min: 0, max: 2, step: 0.05 })),
        h('label', {}, h('span', {}, 'Top P'), num('top_p', s.top_p, { min: 0, max: 1, step: 0.05 })),
        h('label', {}, h('span', {}, '重複懲罰（1 = 關閉）'), num('repetition_penalty', s.repetition_penalty ?? 1, { min: 1, max: 2, step: 0.01 })),
        h('label', {}, h('span', {}, '連線失敗時自動重試'), f.retry_max = optSel(s.retry_max ?? 2, [[0, '不重試'], [1, '1 次'], [2, '2 次'], [3, '3 次'], [5, '5 次']]))),
      ctxNote,
      // 各參數的用途：整理在底下逐條列出
      h('ol', { class: 'param-notes' }, [
        ['上下文長度', '每次送給 AI 的內容總共最多多長（含系統提示、角色設定、世界書、記憶、聊天紀錄與回應）。預設 64000。不要超過模型支援的長度；本機小模型（LM Studio、Ollama 等）請設成不超過載入時的長度，出錯、變得很慢或回應被截斷時請調小。角色多的大世界提示詞比較長，聊天紀錄的空間不夠時，「對話設定」會提醒要調到多少。'],
        ['最大回應 tokens', 'AI 每次回應最多寫多長。太小會寫到一半被切斷；思考型模型的思考也算在裡面，建議 4096 以上（思考型 8192 以上）。'],
        ['Temperature', '隨機程度：越高越有創意、變化多，但也越容易離題；越低越穩定、可預測。角色扮演常用 0.7～1.0。大世界的導演規劃固定用 0.75，不受這裡影響。'],
        ['Top P', '只從機率最高、加總到這個比例的候選字裡挑。1 = 不限制，調低會讓用詞更保守；通常保持 1，只調 Temperature 即可。'],
        ['重複懲罰', '減少 AI 重複同樣的詞句，常見值 1.05～1.15。只送給 OpenAI 相容 API，而且要平台支援（例如 LM Studio、vLLM、部分角色扮演平台）；OpenAI 官方不支援請保持 1，Gemini 與 Claude 不會送出。'],
        ['自動重試', '遇到連線失敗、請求太頻繁（429）或伺服器忙碌時，等 2、4、8… 秒再試；已經開始輸出文字後才出錯就不重試，保留已寫出的部分。'],
      ].map(([k, v]) => h('li', {}, h('b', {}, k), '：' + v)))),
    h('fieldset', {}, h('legend', {}, '省 token（每次送出的聊天紀錄）'),
      h('div', { class: 'row' },
        h('label', {}, h('span', {}, '大世界：導演讀取的聊天紀錄'), f.director_history = optSel(s.director_history ?? 20,
          [[0, '全部（和角色相同）'], [10, '最近 10 則'], [20, '最近 20 則'], [30, '最近 30 則'], [50, '最近 50 則']]))),
      h('p', { class: 'muted small-note' }, '導演只負責規劃方向，讀最近幾則通常就夠；用本機模型（LM Studio 等）時選「全部」，導演和角色開頭相同，可以重用快取、反而更快。聊天紀錄太長時的處理方式，請見「提示詞設定 → 記憶與上下文壓縮」。')),
    resetRow(async () => {
      if (!await askConfirm('把「API 設定」這一頁填回程式的預設值？\n\n會填回預設的：供應商、API 位址、模型、思考程度、生成參數（最大回應、上下文長度、Temperature、Top P、重複懲罰、自動重試）與導演讀取的則數。API 金鑰與模型設定檔不會改變。\n\n只是填進畫面，按「儲存設定」才會保存；按「還原」或離開設定頁就維持原本的設定。')) return;
      fillModelDefaults(await getDefaults());
      markModelDirty(); // 看得出畫面上的已經不是設定檔存的內容
      toast('已填入預設值：按「儲存設定」才會保存，按「還原」可以取消', false, 6000);
    }));
  // 垃圾桶：刪除的角色、大世界、世界書與對話，保留天數內可以還原
  const KIND_LABEL = { char: '角色', bigworld: '大世界', worlds: '世界書', chats: '對話' };
  const trashInfo = h('p', { class: 'muted small-note' });
  const trashList = h('div', { class: 'list backup-list' });
  const emptyBtn = h('button', { type: 'button', class: 'danger', onclick: async () => {
    if (!await askConfirm('清空垃圾桶？\n裡面所有的角色、大世界、世界書與對話都會永久刪除，無法復原。')) return;
    try { const r = await api('DELETE', '/api/trash'); toast(`已永久刪除 ${r.removed} 項`); renderTrash(r); } catch (e) { fail(e); }
  } }, ic('trash-2', '清空垃圾桶'));
  function renderTrash(st) {
    const total = st.items.reduce((n, i) => n + i.size, 0);
    trashInfo.textContent = st.items.length ? `垃圾桶裡有 ${st.items.length} 項，共佔用 ${fmtSize(total)}。` : '';
    emptyBtn.disabled = !st.items.length;
    trashList.innerHTML = '';
    if (!st.items.length) trashList.append(h('p', { class: 'muted' }, '垃圾桶是空的。'));
    for (const it of st.items) {
      const left = Math.max(0, Math.ceil((it.expires - Date.now()) / 86400000));
      const detail = it.kind === 'chats' ? `${it.owner_name ? `屬於「${it.owner_name}」・` : ''}${it.messages} 則訊息`
        : it.kind === 'worlds' ? '' : `${it.chats} 段對話`;
      trashList.append(h('div', { class: 'item' },
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, `${KIND_LABEL[it.kind] || it.kind}：${it.title}`),
          h('div', { class: 'sub' }, [`刪除於 ${new Date(it.deleted).toLocaleString('zh-TW', { hour12: false })}`, detail, fmtSize(it.size), left > 1 ? `還剩 ${left} 天` : '明天前清除'].filter(Boolean).join('・'))),
        h('button', { type: 'button', class: 'small', title: '放回原本的位置', onclick: async () => {
          try {
            await api('POST', `/api/trash/${it.kind}/${encodeURIComponent(it.name)}/restore`);
            toast(`已還原${KIND_LABEL[it.kind]}「${it.title}」`);
            renderTrash(await api('GET', '/api/trash'));
          } catch (e) { fail(e); }
        } }, ic('list-restart', '還原')),
        h('button', { type: 'button', class: 'small icon', title: '永久刪除', onclick: async () => {
          if (!await askConfirm(`永久刪除${KIND_LABEL[it.kind]}「${it.title}」？\n刪除後無法復原。`)) return;
          try { renderTrash(await api('DELETE', `/api/trash/${it.kind}/${encodeURIComponent(it.name)}`)); } catch (e) { fail(e); }
        } }, icon('trash-2'))));
    }
  }
  api('GET', '/api/trash').then(renderTrash).catch(() => {});
  const trashBox = h('fieldset', {}, h('legend', {}, '垃圾桶'),
    h('div', { class: 'row' },
      h('label', {}, h('span', {}, '刪除的項目保留幾天'), f.trash_days = optSel(s.trash_days ?? 7,
        [[1, '1 天'], [3, '3 天'], [7, '7 天（預設）'], [14, '14 天'], [30, '30 天']]))),
    trashInfo,
    trashList,
    h('div', { class: 'prof-row' }, emptyBtn),
    h('p', { class: 'muted small-note' }, '刪除的角色（連同對話）、大世界、世界書與單一對話會先放進垃圾桶（userdata/trash），超過保留天數後自動清除。改了保留天數要按「儲存設定」，縮短時超過天數的項目會馬上清掉。還原對話前，它原本所屬的角色或大世界要還在。'));
  // 內附的 Node.js（runtime/node.exe）：電腦上有安裝 Node.js 時用不到，可以刪掉省空間；打包時會改從安裝的版本複製
  const rtInfo = h('p', { class: 'muted small-note' }, '讀取中…');
  const rtBtns = h('div', { class: 'prof-row' });
  function renderRuntime(st) {
    rtBtns.innerHTML = '';
    if (!st.windows) { rtInfo.textContent = '內附的 Node.js 只用在 Windows，這台電腦用不到。'; return; }
    if (st.using_bundled) {
      rtInfo.textContent = `酒館現在就是用內附的 Node.js 在執行（這台電腦沒有安裝 Node.js），需要保留。`;
      return;
    }
    if (st.bundled) {
      rtInfo.textContent = `有內附的 Node.js（runtime/node.exe，${fmtSize(st.size)}）。這台電腦已經安裝 Node.js ${st.installed_version}，酒館一律用安裝的版本，所以內附的用不到，可以刪掉省空間。`;
      rtBtns.append(h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!await askConfirm(`刪除內附的 Node.js（runtime/node.exe，${fmtSize(st.size)}）？\n這台電腦用的是安裝的 Node.js ${st.installed_version}，刪掉不影響酒館執行。\n之後想把整個資料夾直接複製給沒有安裝 Node.js 的電腦時，可以在這裡按「重新建立」放回來。\n注意：解除安裝 Node.js 之前要先放回來，不然酒館會沒有 Node.js 可以執行。`)) return;
        try { renderRuntime(await api('DELETE', '/api/runtime')); toast('已刪除內附的 Node.js'); } catch (e) { fail(e); }
      } }, ic('trash-2', '刪除內附的 Node.js')));
    } else {
      rtInfo.textContent = `沒有內附的 Node.js（已刪除）。這台電腦用的是安裝的 Node.js ${st.installed_version}。`
        + '想把內附版本放回這個資料夾（例如之後要直接把整個資料夾複製給沒有安裝 Node.js 的電腦），可以按「重新建立」。';
      rtBtns.append(h('button', { type: 'button', onclick: async () => {
        try { toast('複製中…'); renderRuntime(await api('POST', '/api/runtime')); toast('已重新建立內附的 Node.js'); } catch (e) { fail(e); }
      } }, ic('list-restart', '重新建立')));
    }
  }
  api('GET', '/api/runtime').then(renderRuntime).catch(() => { rtInfo.textContent = '讀取失敗。'; });
  const runtimeBox = h('fieldset', {}, h('legend', {}, '內附的 Node.js'), rtInfo, rtBtns);

  // 應用程式視窗的快取（data/app-profile）：網頁、程式碼與繪圖的快取，清掉不影響資料，只是下次開啟時重新建立
  const cacheInfo = h('p', { class: 'muted small-note' }, '讀取中…');
  const renderCache = st => {
    cacheInfo.textContent = !st.exists ? '這台電腦還沒有用應用程式視窗開過酒館，沒有快取。'
      : `應用程式視窗的資料（data/app-profile）共 ${fmtSize(st.size)}，其中可以清掉的快取約 ${fmtSize(st.cache)}。`
        + (st.pending ? '有一部分正在使用中，會在下次開啟酒館時清掉。' : '');
  };
  api('GET', '/api/app-cache').then(renderCache).catch(() => { cacheInfo.textContent = '讀取失敗。'; });
  const cacheBox = h('fieldset', {}, h('legend', {}, '應用程式視窗的快取'),
    cacheInfo,
    h('div', { class: 'prof-row' }, h('button', { type: 'button', onclick: async () => {
      try {
        const r = await api('POST', '/api/app-cache/clear');
        renderCache(r);
        toast(`已清掉 ${fmtSize(r.freed)}` + (r.pending ? '；正在使用中的部分會在下次開啟酒館時清掉' : ''));
      } catch (e) { fail(e); }
    } }, ic('eraser', '清理快取'))),
    h('p', { class: 'muted small-note' }, '只清網頁、程式碼與繪圖的快取（下次開啟時會重新建立，第一次可能稍慢），不會動到角色、對話、設定，也不會清掉輸入框的草稿。'));

  const dataPane = h('div', { class: 'form' }, keyWarning(), backupBox, trashBox, runtimeBox, cacheBox);

  const promptPane = h('div', { class: 'form' },
    // 對話語言：伺服器依選擇，在每次送出內容的最後加上該語言寫的提醒（lib/prompt.js 的 LANGUAGES）。
    // 選語言時把那個語言的提醒帶進下面的輸入框；改了輸入框，選單就變成灰色的「（自訂）」，送出的是輸入框的內容
    h('fieldset', {}, h('legend', {}, '對話語言'),
      h('label', {}, h('span', {}, '要求模型使用的語言（回覆、思考過程與整理的記憶）'), f.reply_language = langSel),
      h('label', {}, h('span', {}, '語言提醒（送給模型的文字，可以修改；改過之後選單會顯示「（自訂）」）'), f.language_note = langNote),
      h('p', { class: 'muted small-note' }, '這段提醒會放在每次送給模型的內容最後面（模型最容易注意到的位置），角色、旁白與整理記憶都會帶上。角色卡、世界書或聊天紀錄是其他語言時，或思考型模型把思考預算調低時，比較不會被帶著換成其他語言。重新選一次語言，就會換回那個語言的預設文字；清空輸入框就不送語言提醒。'),
      h('p', { class: 'note-warn' }, h('b', {}, '注意：'), '這只是對模型的要求，並非對所有模型都有效。小型或本機模型、部分思考型模型仍可能夾雜其他語言；聊天紀錄裡已經有一大段其他語言時，也容易被帶著走，這時可以刪掉或重新生成那幾則，或開一段新對話。主要系統提示等提示詞本身是中文，選其他語言時不用改它們。')),
    h('fieldset', {}, h('legend', {}, '系統提示詞'),
      h('label', {}, h('span', {}, '主要系統提示（每次都會送出；角色卡的系統提示接在後面）'), f.main_prompt = h('textarea', { rows: 8, value: s.main_prompt })),
      h('label', { class: 'check' }, f.use_card_sys = h('input', { type: 'checkbox', checked: s.use_card_system_prompt }), '同時注入角色卡的系統提示（接在主要系統提示後面）'),
      h('label', {}, h('span', {}, '聊天紀錄中保留狀態欄的則數（至少 3；更早訊息裡的 <details> 狀態欄不送給 AI，畫面與存檔不受影響）'),
        num('keep_status', s.keep_status ?? 3, { min: 3, max: 50, step: 1 }))),
    h('fieldset', {}, h('legend', {}, '大世界系統提示詞'),
      h('label', {}, h('span', {}, '大世界對話時，接在主要系統提示後面（{{world}} = 世界名稱，{{user}} 可用）'), f.world_prompt = h('textarea', { rows: 7, value: s.world_prompt })),
      h('p', { class: 'muted small-note' }, '每個世界還可以在「世界設定 → 提示詞」加上自己的規則；各角色卡的系統提示可以在世界設定裡逐一選擇完整套用、不套用或自訂。')),
    h('fieldset', {}, h('legend', {}, '記憶與上下文壓縮'),
      h('p', { class: 'muted small-note' }, '每段對話各自保存劇情摘要與重點，世界的對話也一樣。'),
      h('label', { class: 'check' }, f.mem_on = h('input', { type: 'checkbox', checked: s.memory_enabled }), '把記憶放進提示詞（在聊天紀錄之前）'),
      h('div', { class: 'field-title' }, '聊天紀錄最多送多少 tokens：'),
      h('div', { class: 'row' },
        h('label', {}, h('span', {}, '角色對話'), f.history_cap_char = optSel(s.history_cap_char ?? 16000, HISTORY_CAP_OPTS)),
        h('label', {}, h('span', {}, '大世界對話'), f.history_cap_world = optSel(s.history_cap_world ?? 32000, HISTORY_CAP_OPTS))),
      h('p', { class: 'muted small-note' }, '上下文長度設得很大時，聊天紀錄也不會跟著送很多，省 token；角色設定、世界書、記憶不受這個上限影響。每段對話可以在對話頁右上角的「對話設定」另外指定。'),
      h('label', { class: 'check' }, f.mem_auto = h('input', { type: 'checkbox', checked: s.memory_auto }), '自動壓縮：聊天紀錄快滿時，自動把較舊的對話整理進記憶'),
      h('div', { class: 'row' },
        h('label', {}, h('span', {}, '聊天紀錄佔可用空間多少時壓縮'), f.compress_threshold = optSel(s.compress_threshold ?? 70,
          [[50, '50%'], [60, '60%'], [70, '70%（建議）'], [80, '80%'], [90, '90%']])),
        h('label', {}, h('span', {}, '壓縮後保留多少原文'), f.compress_keep = optSel(s.compress_keep ?? 35,
          [[20, '20%'], [30, '30%'], [35, '35%（建議）'], [40, '40%'], [50, '50%']]))),
      h('p', { class: 'muted small-note' }, '「可用空間」是上下文長度扣掉回應、系統提示、角色設定與記憶之後，留給聊天紀錄的部分。超過門檻時，較舊的對話會整理進記憶，然後不再送出原文，只保留最近一段（切在你的發言前面，不會把一組問答拆開）；被移出的對話一定已經在記憶裡。一次壓一大批，之後好一陣子提示詞開頭都不變，快取可以重用。壓縮會另外呼叫 AI（使用目前的模型），通常在回應完成後於背景進行；存檔裡的原文都會保留。token 估算會用 API 回報的實際用量自動校正。'),
      h('label', {}, h('span', {}, '整理記憶用的指令（{{char}}、{{user}} 可用）'), f.mem_prompt = h('textarea', { rows: 8, value: s.memory_prompt })),
      h('p', { class: 'muted small-note' }, '在對話頁按「記憶」可以檢視、手動修改或立即整理。關閉自動壓縮時，聊天紀錄太長就只會依上下文長度裁掉最舊的部分。')),
    h('fieldset', {}, h('legend', {}, '全域世界書（對所有角色生效）'),
      worldChecks.length ? worldChecks : h('p', { class: 'muted' }, '尚無世界書，可在「世界書」中建立或匯入。')),
    resetRow(async () => {
      if (!await askConfirm('把「提示詞設定」這一頁填回程式的預設值？\n\n會填回預設的：對話語言（繁體中文）、主要系統提示、大世界系統提示、狀態欄保留則數、記憶與上下文壓縮的設定、聊天紀錄上限（角色 16k、大世界 32k）、整理記憶的指令，並取消勾選所有全域世界書。\n\n只是填進畫面，按「儲存設定」才會保存；按「還原」或離開設定頁就維持原本的設定。')) return;
      const d = await api('GET', '/api/settings/defaults');
      setLang(d.reply_language);
      f.main_prompt.value = d.main_prompt; f.use_card_sys.checked = d.use_card_system_prompt; f.keep_status.value = d.keep_status;
      f.world_prompt.value = d.world_prompt; f.mem_on.checked = d.memory_enabled; f.mem_auto.checked = d.memory_auto;
      f.history_cap_char.value = String(d.history_cap_char); f.history_cap_world.value = String(d.history_cap_world);
      f.compress_threshold.value = String(d.compress_threshold); f.compress_keep.value = String(d.compress_keep);
      f.mem_prompt.value = d.memory_prompt;
      for (const l of worldChecks) $('input', l).checked = false;
      toast('已填入預設值：按「儲存設定」才會保存，按「還原」可以取消', false, 6000);
    }));

  // 外觀：改了立刻預覽，按「儲存設定」才保存；沒儲存就離開設定頁會還原
  applyAppearance(s.appearance, s.bg_ver); // 打開設定頁（含「還原」）時，以已儲存的為準
  const ap = { ...APPEARANCE_DEFAULT, ...(s.appearance || {}) };
  let bgVer = s.bg_ver || 0;
  const preview = () => { applyAppearance(ap, bgVer, false); imgBox.hidden = ap.background !== 'image'; };
  const apEls = {}; // 外觀的下拉選單（恢復預設時要把畫面上的值也改回來）
  const apSel = (key, opts, cast = String) => {
    const el = apEls[key] = h('select', { onchange: () => { ap[key] = cast(el.value); preview(); } }, opts.map(([v, t]) => h('option', { value: v }, t)));
    el.value = String(ap[key]);
    return el;
  };
  const bgThumb = h('div', { class: 'bg-thumb' });
  const renderThumb = () => {
    bgThumb.style.backgroundImage = bgVer ? `url("/api/appearance/background?v=${bgVer}")` : '';
    bgThumb.textContent = bgVer ? '' : '尚未選擇圖片';
  };
  const dimLabel = h('span', {}, '');
  const dim = h('input', { type: 'range', min: 0, max: 0.9, step: 0.05, value: ap.bg_dim, oninput: () => { ap.bg_dim = +dim.value; dimLabel.textContent = Math.round(ap.bg_dim * 100) + '%'; preview(); } });
  dimLabel.textContent = Math.round(ap.bg_dim * 100) + '%';
  const imgBox = h('div', { class: 'bg-image-box' }, bgThumb,
    h('div', { class: 'form grow' },
      h('div', { class: 'btns' },
        h('button', { type: 'button', onclick: async () => {
          const url = await pickImage(2560);
          if (!url) return;
          try {
            const r = await api('PUT', '/api/appearance/background', { image: url });
            bgVer = r.bg_ver; state.settings = { ...state.settings, bg_ver: bgVer };
            renderThumb(); preview(); toast('背景圖已上傳');
          } catch (err) { fail(err); }
        } }, ic('image', '選擇圖片')),
        h('button', { type: 'button', onclick: async () => {
          await api('PUT', '/api/appearance/background', { image: null }).catch(fail);
          bgVer = 0; state.settings = { ...state.settings, bg_ver: 0 }; renderThumb(); preview();
        } }, '移除圖片')),
      h('label', {}, h('span', {}, '背景變暗（圖片太亮時調高，文字比較好讀）'), h('div', { class: 'range-row' }, dim, dimLabel))));
  renderThumb();
  // 主題色：預設幾組＋自選
  const ACCENTS = [['', '星光藍'], ['#b18cff', '紫羅蘭'], ['#4fd1c5', '青綠'], ['#ff8fb8', '櫻粉'], ['#ffb648', '琥珀'], ['#7fd67a', '新葉']];
  // 只建立一次，之後只切換「選中」的樣式：取色器的 input 一旦被移出畫面，瀏覽器會立刻關掉取色視窗
  const colorIn = h('input', { type: 'color', class: 'accent-pick', title: '自選顏色', value: ap.accent || '#79a8ff',
    oninput: () => { ap.accent = colorIn.value; renderSwatches(); preview(); } });
  const swatchBtns = ACCENTS.map(([v, t]) => h('button', { type: 'button', class: 'swatch', title: t, style: `--c:${v || '#79a8ff'}`,
    onclick: () => { ap.accent = v; colorIn.value = v || '#79a8ff'; renderSwatches(); preview(); } }, h('span', {}), t));
  const swatches = h('div', { class: 'swatches' }, ...swatchBtns, colorIn);
  const renderSwatches = () => swatchBtns.forEach((b, i) => b.classList.toggle('on', (ap.accent || '') === ACCENTS[i][0]));
  renderSwatches();
  const appearancePane = h('div', { class: 'form' },
    h('fieldset', {}, h('legend', {}, '動畫'),
      h('label', {}, h('span', {}, '星星閃爍、卡片浮起、分頁切換與收合的轉場等動畫'), apSel('motion', [['on', '開啟'], ['off', '關閉']]))),
    h('fieldset', {}, h('legend', {}, '背景'),
      h('label', {}, h('span', {}, '背景樣式'), apSel('background', [['stars', '星空（預設）'], ['night', '夜空漸層'], ['plain', '純色深藍'], ['image', '自訂圖片']])),
      imgBox),
    h('fieldset', {}, h('legend', {}, '主題色（按鈕、名稱、選中的分頁等）'), swatches),
    h('fieldset', {}, h('legend', {}, '文字'),
      h('label', {}, h('span', {}, '字級（對話內容與一般文字）'), apSel('font_size', [['14', '小'], ['15', '標準'], ['17', '大'], ['19', '特大']], Number))),
    h('fieldset', {}, h('legend', {}, '對話頁'),
      h('label', {}, h('span', {}, '打開對話時先顯示最近幾則訊息（往上捲到頂端可以載入更早的）'), f.chat_render = optSel(s.chat_render ?? 100,
        [[50, '50 則'], [100, '100 則（預設）'], [200, '200 則'], [500, '500 則'], [0, '全部顯示']])),
      h('p', { class: 'muted small-note' }, '很長的對話一次全部畫出來會比較慢；只顯示最近的訊息，打開對話與切換都比較快。這只影響畫面，送給 AI 的內容不變。'),
      h('label', { class: 'check' }, f.ext_img = h('input', { type: 'checkbox', checked: !!s.external_images }), '自動載入訊息與角色介紹裡的外部圖片'),
      h('p', { class: 'muted small-note' }, '關閉時（預設），網路上的圖片要點一下才會載入：圖片網址可能是別人設的，一載入對方就會知道你的 IP，也可能被拿來把對話內容夾帶在網址裡送出去。只用自己信任的角色卡時可以打開。')),
    h('p', { class: 'muted small-note' }, '改動會立刻預覽，按「儲存設定」才會保存；沒有儲存就離開設定頁會還原。背景圖選好就會上傳。'),
    resetRow(async () => {
      if (!await askConfirm('把「外觀」這一頁填回程式的預設值？\n\n會填回預設的：動畫（開啟）、背景（星空）、背景變暗程度、主題色（星光藍）、字級（標準）、打開對話時顯示的則數（100 則）。已上傳的背景圖檔案會保留。\n\n會先預覽，按「儲存設定」才會保存；按「還原」或離開設定頁就維持原本的設定。')) return;
      const d = await api('GET', '/api/settings/defaults');
      Object.assign(ap, d.appearance);
      for (const [k, el] of Object.entries(apEls)) el.value = String(ap[k]);
      dim.value = ap.bg_dim; dimLabel.textContent = Math.round(ap.bg_dim * 100) + '%';
      colorIn.value = ap.accent || '#79a8ff'; renderSwatches();
      f.chat_render.value = String(d.chat_render); f.ext_img.checked = !!d.external_images;
      preview(); // 只預覽：沒儲存就離開設定頁會自動還原
      toast('已套用預設值預覽：按「儲存設定」才會保存，按「還原」可以取消', false, 6000);
    }));
  imgBox.hidden = ap.background !== 'image';

  // 使用者設定檔：把名字、人設與頭像存起來，之後一鍵切換；每段對話也可以在「對話設定」指定用哪一個
  const personas = s.personas || [];
  // 一定有一個使用中的設定檔（伺服器會自動補上預設的 User）
  const activePersona = personas.find(p => p.id === s.active_persona) || personas[0] || { id: '', name: s.user_name, user_name: s.user_name };
  const perSel = h('select', {}, h('option', { value: '', class: 'opt-new' }, '（新增設定檔）'),
    personas.map(p => h('option', { value: p.id }, `${p.name}｜${p.user_name}`)));
  perSel.value = activePersona.id;
  perSel.onchange = async () => {
    try {
      if (!perSel.value) return enterPersonaNew();
      const r = await api('POST', `/api/personas/${perSel.value}/apply`); state.settings = r.settings;
      toast(perSel.value === activePersona.id ?'已載回使用者設定檔存的內容（捨棄修改）' : '已切換使用者設定檔');
      openSettings().catch(fail);
    } catch (e) { fail(e); }
  };
  /** 「（新增設定檔）」：名字與人設填回預設值，按「儲存」才建立；頭像先沿用目前的，建立後可以更換 */
  async function enterPersonaNew() {
    const d = await getDefaults();
    f.user_name.value = d.user_name; f.user_persona.value = d.user_persona || '';
    personaNew = true;
    pendingAvatar = undefined; // 頭像先沿用目前的，可以在建立前更換或移除
    perSel.classList.remove('dirty'); perSel.querySelector('option[value="__dirty"]')?.remove(); perSel.value = '';
    for (const b of personaBox.querySelectorAll('.persona-active')) b.hidden = true;
    perNewSave.hidden = false;
    renderAv();
    perNote.textContent = '新增設定檔：名字與人設已填回預設值，頭像先沿用目前的，也可以現在更換或移除（建立時才會存成這個設定檔的頭像）。按右方的「儲存」可以自己取名建立；按最下方的「儲存設定」會直接用名字建立。沒有儲存就離開，不會建立也不會改變任何設定。';
    toast('已帶入預設值：按「儲存」或「儲存設定」才會建立設定檔', false, 5000);
  }
  /** 畫面上的名字與人設（名字不能空白） */
  const userFields = () => {
    const user_name = f.user_name.value.trim();
    if (!user_name) { f.user_name.focus(); throw new Error('「使用者」分頁的名字不能空白，請先填寫'); }
    return { user_name, user_persona: f.user_persona.value };
  };
  /**
   * 用畫面上的名字、人設建立新的使用者設定檔並設為使用中（name 留空＝用你的名字當設定檔名稱）；
   * 直接把內容交給伺服器建立，原本使用中的設定檔不會被改到
   */
  async function createPersona(name = '') {
    const r = await api('POST', '/api/personas', { name, ...userFields(), ...newPersonaAvatar() });
    return r.personas.find(p => p.id === r.id)?.name;
  }
  /** 新增時選的頭像（沒改就不送，沿用目前的） */
  const newPersonaAvatar = () => (pendingAvatar !== undefined ? { avatar: pendingAvatar } : {});
  const perNewSave = h('button', { type: 'button', class: 'success', hidden: true, title: '用目前的名字、人設與頭像建立新的使用者設定檔', onclick: async () => {
    const asked = await askText('新增使用者設定檔', { note: '設定檔的名稱（之後可以重新命名）', value: f.user_name.value.trim(), okText: '建立' }); if (asked == null) return;
    try { const name = await createPersona(asked); toast(`已建立使用者設定檔「${name}」`); openSettings().catch(fail); } catch (e) { fail(e); }
  } }, ic('save', '儲存'));
  let perNote;
  const personaBox = h('fieldset', {}, h('legend', {}, '使用者設定檔'),
    h('div', { class: 'prof-row' }, perSel, perNewSave,
      h('button', { type: 'button', title: '把下面目前的名字、人設與頭像存成新的使用者設定檔', onclick: async () => {
        const name = await askText('另存新的使用者設定檔', { note: '把目前的名字、人設與頭像存成新的設定檔；請輸入名稱', value: f.user_name.value.trim(), okText: '另存' }); if (name == null) return;
        try {
          // 直接用畫面上的內容建立，原本那個設定檔維持它存的內容
          await createPersona(name);
          toast('已存成新的使用者設定檔'); openSettings().catch(fail);
        } catch (e) { fail(e); }
      } }, ic('plus', '另存新設定檔')),
      activePersona ? h('button', { type: 'button', class: 'persona-active', onclick: async () => {
        const name = await askText('重新命名使用者設定檔', { value: activePersona.name, okText: '改名' }); if (name == null) return;
        await api('PUT', `/api/personas/${activePersona.id}`, { name }).catch(fail); openSettings().catch(fail);
      } }, ic('pencil', '重新命名')) : null,
      activePersona ? h('button', { type: 'button', class: 'success persona-active', title: `把名字與人設存進「${activePersona.name}」`, onclick: async () => {
        try { await saveAll(false, 'user'); toast(`已儲存到使用者設定檔「${activePersona.name}」`); openSettings().catch(fail); } catch (e) { fail(e); }
      } }, ic('save', '儲存')) : null,
      activePersona ? h('button', { type: 'button', class: 'danger persona-active', onclick: async () => {
        const last = personas.length <= 1;
        if (!await askConfirm(`刪除使用者設定檔「${activePersona.name}」？\n` + (last
          ? '這是最後一個設定檔：刪除後會自動建立並套用預設的「User」設定檔（名字 User、沒有人設與頭像）。'
          : `刪除後改用「${personas.find(p => p.id !== activePersona.id).name}」。`) + '\n指定這個設定檔的對話會改回跟隨設定頁。')) return;
        try {
          await api('DELETE', `/api/personas/${activePersona.id}`);
          const r = await api('GET', '/api/settings'); state.settings = r.settings;
          toast(last ? '已刪除，並還原預設的 User 設定檔' : '已刪除使用者設定檔');
        } catch (e) { fail(e); }
        openSettings().catch(fail);
      } }, ic('trash-2', '刪除')) : null),
    perNote = h('p', { class: 'muted small-note' },
      `目前使用「${activePersona.name}」：換頭像會直接更新這個設定檔；改了名字或人設，按右方的「儲存」或最下方的「儲存設定」都會一起更新。改過還沒儲存時，選單會顯示「已修改」；再選一次這個設定檔就會載回它存的內容。名字不能空白；設定檔全部刪光時，會自動還原預設的「User」。`),
    h('p', { class: 'small-note persona-tip' }, '新對話開始時會固定使用當時的使用者設定檔：之後在這裡切換，不會影響已經開始的對話（要換請到那段對話的「對話設定」，名字會一起改好）。'
      + '設定檔裡的名字不建議經常更改：開場白與舊訊息裡已經寫好的名字不會跟著變，用這個設定檔的對話會出現前後不同的名字；想換身分時建議另存一個新的設定檔。'));

  const userPane = h('div', { class: 'form' },
    personaBox,
    h('div', { class: 'user-top' }, avSlot,
      h('div', { class: 'form grow' },
        h('label', {}, h('span', {}, '你的名字（{{user}}）'), inp('user_name', { value: s.user_name, maxlength: 60, required: true, placeholder: '必填，例如 User' })),
        h('p', { class: 'muted small-note' }, '頭像會顯示在對話中你的訊息旁邊；選好圖片就會直接儲存。'))),
    h('label', {}, h('span', {}, '你的人設（會加入提示詞）'), f.user_persona = h('textarea', { rows: 6, value: s.user_persona })));
  renderAv();

  // 使用中的設定檔被改過（還沒儲存）：下拉選單改成顯示「已修改，尚未儲存」，看得出畫面上的不是設定檔存的內容；
  // 這時再點一次那個設定檔，就會載回它存的內容（捨棄修改）
  // 「（新增設定檔）」也一樣：改過之後選單顯示「新增設定檔（已修改，尚未儲存）」，再選一次「（新增設定檔）」就重新帶入預設值
  const markDirty = (sel, name, isNew) => {
    if (!name || sel.querySelector('option[value="__dirty"]')) return;
    const o = h('option', { value: '__dirty', disabled: true }, `${name}（已修改，尚未儲存）`);
    sel.insertBefore(o, sel.options[1] || null);
    sel.value = '__dirty';
    sel.classList.add('dirty');
    sel.title = isNew ? '再選一次「（新增設定檔）」，就會重新帶入預設值（捨棄目前的修改）' : '再選一次設定檔，就會載回它存的內容（捨棄目前的修改）';
  };
  function markModelDirty() {
    const isNew = modelNew;
    markDirty(profSel, isNew ? '新增設定檔' : activeName, isNew);
  }
  function markPersonaDirty() {
    const isNew = personaNew;
    markDirty(perSel, isNew ? '新增設定檔' : activePersona.name, isNew);
  }
  const onModelEdit = e => { if (e.target !== profSel && e.target.closest('label, fieldset')) markModelDirty(); };
  systemPane.addEventListener('input', onModelEdit);
  systemPane.addEventListener('change', onModelEdit);
  for (const el of [f.user_name, f.user_persona]) el.addEventListener('input', markPersonaDirty);

  // 關於：程式名稱與版本、檢查更新、GitHub 連結、授權
  const REPO = 'https://github.com/GornBear/Gorn-AITavern';
  const link = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
  const updStatus = h('div', { class: 'update-status' });
  const updBtn = h('button', { type: 'button', onclick: () => runUpdateCheck(true) }, ic('refresh-cw', '立即檢查'));
  const updAuto = h('input', { type: 'checkbox', checked: s.update_check !== false });
  updAuto.onchange = async () => {
    try {
      const r = await api('PUT', '/api/settings', { update_check: updAuto.checked }); state.settings = r.settings;
      toast(updAuto.checked ? '每次啟動時會檢查新版本' : '已關閉自動檢查（還是可以按「立即檢查」）');
    } catch (e) { updAuto.checked = !updAuto.checked; fail(e); }
  };
  const renderUpdate = (u, busy = false) => {
    updStatus.replaceChildren();
    updStatus.className = 'update-status' + (u?.newer ? ' newer' : '');
    if (busy) return updStatus.append(h('p', { class: 'muted' }, '檢查中…'));
    if (!u) return updStatus.append(h('p', { class: 'muted' }, '還沒有檢查過。按「立即檢查」看看有沒有新版本。'));
    const when = u.checked ? new Date(u.checked).toLocaleString() : '';
    if (u.error) return updStatus.append(h('p', {}, `無法檢查更新：${u.error}`), h('p', { class: 'muted small-note' }, '可以稍後再試，或直接到 ', link(u.page || REPO + '/releases/latest', 'GitHub Releases'), ' 看看。'));
    if (!u.newer) return updStatus.append(h('p', {}, ic('check', `已經是最新版本（v${u.current}）`)), h('p', { class: 'muted small-note' }, `GitHub 上最新的是 v${u.latest}｜檢查時間 ${when}`));
    updStatus.append(
      h('p', { class: 'update-new' }, `有新版本：v${u.latest}（目前 v${u.current}）`),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'success', title: u.url, onclick: () => window.open(u.url, '_blank', 'noopener') }, ic('download', '前往下載'))),
      u.notes ? h('details', { class: 'update-notes' }, h('summary', {}, '這一版的更新內容'), h('div', { class: 'update-notes-body' }, u.notes)) : null,
      h('p', { class: 'muted small-note' }, '更新方式：下載新版解壓縮到新的資料夾，再把舊資料夾裡的 userdata/ 整個複製過去（角色卡、對話、設定與金鑰都在裡面）。'));
  };
  async function runUpdateCheck(force) {
    renderUpdate(null, true); updBtn.disabled = true;
    try { state.update = await api('GET', '/api/update-check' + (force ? '?force=1' : '')); markUpdateDot(); }
    catch (e) { state.update = { error: e.message }; }
    finally { updBtn.disabled = false; renderUpdate(state.update); }
  }
  // 啟動時的檢查還沒回來（或一打開就是設定頁）：直接拿一次（伺服器有暫存，不會重複連線）
  if (state.update) renderUpdate(state.update);
  else if (s.update_check !== false) runUpdateCheck(false);
  else renderUpdate(null);
  const aboutPane = h('div', { class: 'form about-pane' },
    h('div', { class: 'about-head' }, h('img', { src: '/icon.png', alt: '', class: 'about-icon' }),
      h('div', {}, h('h2', {}, 'AI 酒館'), h('p', { class: 'muted' }, (version ? `版本 ${version}｜` : '') + 'Made by 葛恩 with Claude（使用 Claude Code 開發）'))),
    h('fieldset', {}, h('legend', {}, '檢查更新'),
      updStatus,
      h('div', { class: 'btns' }, updBtn),
      h('label', { class: 'check' }, updAuto, '每次啟動時自動檢查新版本'),
      h('p', { class: 'muted small-note' }, '只會連到 GitHub 查詢最新的版本號，不會送出你的任何資料，也不會自動下載或安裝；有新版本時，底部的「設定」與這個分頁會出現小紅點。')),
    h('fieldset', {}, h('legend', {}, '連結'),
      h('ul', { class: 'about-links' },
        h('li', {}, link(REPO, 'GitHub 專案頁面'), h('span', { class: 'muted' }, '：原始碼與說明')),
        h('li', {}, link(REPO + '/releases', '所有版本（Releases）'), h('span', { class: 'muted' }, '：下載與各版本的更新內容')),
        h('li', {}, link(REPO + '/issues', '回報問題（Issues）'), h('span', { class: 'muted' }, '：需要 GitHub 帳號')))),
    h('fieldset', {}, h('legend', {}, '授權'),
      h('p', {}, 'AI 酒館以 MIT 授權發布：可以自由使用、修改與散布，只要保留版權聲明。'),
      h('p', { class: 'muted small-note' }, '介面圖示來自 Lucide（ISC 授權）；連線 Claude 使用 Anthropic 的官方 SDK（Apache 2.0）；分享版附的 Node.js 以 MIT 授權發布。詳見程式資料夾裡的 LICENSE 與 THIRD_PARTY_NOTICES.md。')));

  // 分頁順序：API 設定 > 提示詞設定 > 資料 > 外觀 > 使用者 > 關於（關於固定在最右邊）
  const panes = { system: systemPane, prompt: promptPane, data: dataPane, appearance: appearancePane, user: userPane, about: aboutPane };
  const tabKeys = Object.keys(panes);
  const { bar: tabBar } = tabsUI([
    [ic('plug', 'API 設定'), systemPane],
    [ic('scroll-text', '提示詞設定'), promptPane],
    [ic('database', '資料'), dataPane],
    [ic('sparkles', '外觀'), appearancePane],
    [ic('user', '使用者'), userPane],
    [ic('info', '關於'), aboutPane],
  ], Math.max(0, tabKeys.indexOf(state.settingsTab)), i => (state.settingsTab = tabKeys[i]));
  const aboutBtn = tabBar.querySelectorAll('button')[tabKeys.indexOf('about')];
  aboutBtn?.classList.add('about-tab');
  aboutBtn?.classList.toggle('has-dot', !!state.update?.newer); // 分頁列還沒放進畫面：直接設定（之後的變化由 markUpdateDot 處理）
  const body = h('div', {}, tabBar, systemPane, promptPane, dataPane, appearancePane, userPane, aboutPane);

  /**
   * 儲存設定。only：只存一部分，其他分頁的變更不動
   *   'model'：模型設定檔包含的欄位（連線設定、生成參數）與金鑰；'user'：名字與人設（使用者設定檔）
   */
  /** 畫面上「模型設定檔」管的那些欄位：連線設定與生成參數（儲存、建立設定檔共用） */
  function modelFields() {
    return {
      provider: provider.value,
      openai: { base_url: f.oa_url.value.trim(), model: f.oa_model.value.trim(), reasoning_effort: f.oa_think.value },
      gemini: { model: f.gm_model.value.trim(), reasoning_effort: f.gm_think.value },
      anthropic: { model: f.an_model.value.trim(), effort: f.an_effort.value, thinking: f.an_think.value, fallbacks: f.an_fb.checked },
      max_tokens: +f.max_tokens.value, context_tokens: +f.context_tokens.value,
      temperature: +f.temperature.value, top_p: +f.top_p.value,
      repetition_penalty: Math.max(1, +f.repetition_penalty.value || 1),
      retry_max: +f.retry_max.value, director_history: +f.director_history.value,
    };
  }
  async function saveAll(close = true, only = null, { skipUser = false } = {}) {
    const user = skipUser || only === 'model' ? {} : userFields(); // 名字空白時停下來，不儲存
    let patch = {
      ...modelFields(),
      history_cap_char: +f.history_cap_char.value, history_cap_world: +f.history_cap_world.value,
      compress_threshold: +f.compress_threshold.value, compress_keep: Math.min(+f.compress_keep.value, +f.compress_threshold.value - 10),
      backup_keep: +f.backup_keep.value, trash_days: +f.trash_days.value, chat_render: +f.chat_render.value, external_images: f.ext_img.checked,
      ...user,
      reply_language: f.reply_language.value,
      language_custom: f.reply_language.value === 'custom' ? f.language_note.value : '',
      main_prompt: f.main_prompt.value, use_card_system_prompt: f.use_card_sys.checked, world_prompt: f.world_prompt.value,
      keep_status: Math.max(3, +f.keep_status.value || 3),
      memory_enabled: f.mem_on.checked, memory_auto: f.mem_auto.checked,
      memory_prompt: f.mem_prompt.value,
      world_ids: worldChecks.map(l => $('input', l)).filter(i => i.checked).map(i => i.value),
      appearance: { ...ap },
    };
    // 改了使用中設定檔的名字：用它的對話裡，開場白與舊訊息寫的還是舊名字，先提醒
    if (user.user_name && !personaNew && activePersona.id && user.user_name !== activePersona.user_name) {
      const used = (await api('GET', '/api/chats').catch(() => [])).filter(c => c.persona_id === activePersona.id).length;
      if (used && !await askConfirm(`把使用者設定檔「${activePersona.name}」的名字從「${activePersona.user_name}」改成「${user.user_name}」？\n\n`
        + `有 ${used} 段對話使用這個設定檔：它們之後會用新名字，但開場白、舊訊息與記憶裡寫的還是「${activePersona.user_name}」，對話中會出現前後不同的名字。\n\n`
        + '只是想用另一個身分的話，建議改按「另存新設定檔」。')) throw Object.assign(new Error('已取消：名字沒有改'), { cancelled: true });
    }
    if (only === 'model') patch = Object.fromEntries(PROFILE_FIELDS.map(k => [k, patch[k]]));
    else if (only === 'user') patch = { user_name: patch.user_name, user_persona: patch.user_persona };
    const r = await api('PUT', '/api/settings', patch);
    state.settings = r.settings;
    if ('trash_days' in patch) api('GET', '/api/trash').then(renderTrash).catch(() => {}); // 縮短保留天數時已清掉過期的
    if (!only) {
      applySavedAppearance();
      if (state.chat && !$('#chatView').hidden) renderMessages();
    }
    // 金鑰欄還是遮罩符號（沒改）或空白時不送出，保留原本的金鑰
    if (only !== 'user') for (const [p, el] of [['openai', f.oa_key], ['gemini', f.gm_key], ['anthropic', f.an_key]]) {
      const v = el.value.trim();
      // 新增模型設定檔時，目前供應商的金鑰欄是空的：新設定檔就不帶金鑰（不沿用原本設定檔的）
      if (modelNew && !v && p === provider.value) { await api('PUT', '/api/keys', { provider: p, api_key: '' }); continue; }
      if (!v || isMask(v) || v === el.dataset.orig) continue; // 沒有改（顯示出來檢查過但沒動也一樣）
      await api('PUT', '/api/keys', { provider: p, api_key: v });
      // 隱藏中：換回遮罩；顯示中：繼續顯示剛存的金鑰
      if (el.classList.contains('secret')) { el.value = KEY_MASK; delete el.dataset.orig; } else el.dataset.orig = v;
    }
    if (close) { toast('設定已儲存'); openSettings().catch(fail); }
  }
  // 設定是獨立頁面（底部切換欄的「設定」），不是彈出視窗
  $('#settingsBody').innerHTML = ''; $('#settingsBody').append(body);
  // 還沒儲存的修改：第一次點或按鍵時記下當下的內容（那時非同步載入的欄位都已經好了），離開設定頁時比較
  const ctrls = () => [...body.querySelectorAll('input:not([type=file]), select, textarea')];
  // 金鑰欄：顯示出來的已儲存金鑰（data-orig）、遮罩符號都算「沒有改」
  const snap = () => JSON.stringify(ctrls().map(el => (el.type === 'checkbox' || el.type === 'radio' ? el.checked
    : 'orig' in el.dataset && el.value === el.dataset.orig ? KEY_MASK : el.classList.contains('secret') && isMask(el.value) ? KEY_MASK : el.value)));
  let base = null;
  const mark = () => { if (base === null) base = snap(); };
  for (const ev of ['pointerdown', 'keydown', 'focusin']) body.addEventListener(ev, mark, true);
  state.settingsDirty = () => base !== null && snap() !== base;
  $('#settingsFoot').innerHTML = '';
  $('#settingsFoot').append(
    h('button', { title: '放棄尚未儲存的變更', onclick: () => openSettings().catch(fail) }, '還原'),
    h('button', { class: 'primary', onclick: () => saveFromFooter().catch(fail) }, '儲存設定'));

  /**
   * 最下方的「儲存設定」：儲存全部設定。正在「新增設定檔」時，用畫面上的內容建立新的設定檔並切換過去
   * （原本的設定檔不會被改到），再儲存其他設定（模型設定檔＝模型名稱、使用者設定檔＝你的名字）
   */
  async function saveFromFooter() {
    if (!modelNew && !personaNew) return saveAll();
    if (personaNew) userFields(); // 名字空白時先停下來，什麼都不存
    const made = [];
    if (modelNew) made.push(`模型設定檔「${await createModelProfile('')}」`);
    // 新增使用者設定檔時，名字與人設不存進原本的設定檔，改用它們建立新的設定檔
    await saveAll(false, null, { skipUser: personaNew });
    if (personaNew) made.push(`使用者設定檔「${await createPersona()}」`);
    toast(`設定已儲存，並建立${made.join('、')}`);
    openSettings().catch(fail);
  }
}

