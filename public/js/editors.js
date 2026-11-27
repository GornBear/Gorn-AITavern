'use strict';
// AI 酒館 前端 — 編輯器：世界書條目、世界書管理、角色卡編輯器
// 這些檔案依序載入（見 index.html），共用同一個全域範圍；最後由 main.js 啟動
// ===================== 世界書條目編輯器（全域世界書與角色內嵌共用） =====================
const WI_MIN_BUDGET = 1024; // 世界書 Token 預算的下限（和 lib/prompt.js 相同）
/** 條目的名稱，與狀態標籤（啟用／停用・常駐・插入位置）：條目編輯器和世界書清單的展開預覽共用 */
const wiTitle = e => e.comment || (e.keys || []).join(', ') || '（未命名條目）';
const wiBadges = e => [
  h('span', { class: 'badge' + (e.enabled ? ' on' : '') }, e.enabled ? '啟用' : '停用'),
  ...(e.constant ? [h('span', { class: 'badge on' }, '常駐')] : []),
  h('span', { class: 'badge' }, { before_char: '角色前', after_char: '角色後', at_depth: `深度 ${e.depth}` }[e.position] || '角色前'),
];
function entriesEditor(book) {
  book.entries = book.entries || [];
  const wrap = h('div', { class: 'form' });
  // Token 預算：最少 WI_MIN_BUDGET（舊資料、匯入的世界書低於下限時，伺服器也照下限計算）
  const budgetOf = () => Math.max(WI_MIN_BUDGET, Number(book.token_budget) || 2048);
  let paintCurTok = () => {};
  const refreshTok = () => paintCurTok();

  // 上方：搜尋欄＋一行可橫向捲動的條目標籤（名稱／啟用・常駐・插入位置）；下方只顯示選中的那一個條目
  let sel = 0, query = '';
  const titleOf = wiTitle, badgesOf = wiBadges;
  const search = h('input', { type: 'search', class: 'wi-search', placeholder: '搜尋條目（名稱、關鍵字、內容）' });
  const strip = h('div', { class: 'wi-strip', role: 'tablist' });
  const editorBox = h('div', { class: 'wi-editor' });
  const chips = new Map(); // 條目 → 標籤按鈕
  const paintChip = e => {
    const c = chips.get(e); if (!c) return;
    c.replaceChildren(h('span', { class: 't' }, titleOf(e)), h('span', { class: 'b' }, ...badgesOf(e)),
      h('button', { type: 'button', class: 'wi-x', title: '刪除這個條目', 'aria-label': '刪除這個條目',
        onclick: ev => { ev.stopPropagation(); deleteEntry(book.entries.indexOf(e)); } }, '×'));
    c.title = titleOf(e); c.classList.toggle('off', !e.enabled);
  };
  const matches = e => !query || [e.comment, ...(e.keys || []), ...(e.secondary_keys || []), e.content].some(s => String(s || '').toLowerCase().includes(query));
  const renderStrip = () => {
    strip.innerHTML = ''; chips.clear();
    book.entries.forEach((e, i) => {
      if (!matches(e)) return;
      // 標籤裡有刪除鈕（按鈕不能包按鈕），所以標籤本身是可以用鍵盤操作的 div
      const c = h('div', { class: 'wi-chip' + (i === sel ? ' on' : '') + (e.enabled ? '' : ' off'), role: 'tab', tabindex: '0', 'aria-selected': String(i === sel),
        onclick: () => { if (i !== sel) select(i); }, onkeydown: ev => { if (ev.target === c && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); select(i); } } });
      chips.set(e, c); paintChip(e); strip.append(c);
    });
    if (query && !chips.size) strip.append(h('span', { class: 'muted wi-none' }, '沒有符合的條目'));
    strip.append(h('button', { type: 'button', class: 'wi-chip wi-add', onclick: addEntry }, ic('plus', '新增條目')));
  };
  const select = (i, scroll = true) => {
    const keep = strip.scrollLeft;
    sel = i; renderStrip(); renderEditor();
    strip.scrollLeft = keep; // 重畫後維持原本的捲動位置
    const c = chips.get(book.entries[sel]);
    if (scroll && c && (c.offsetLeft - strip.offsetLeft < strip.scrollLeft || c.offsetLeft - strip.offsetLeft + c.offsetWidth > strip.scrollLeft + strip.clientWidth - 110)) scrollToSel();
  };
  let entryRO = null; // 目前條目切換鈕的 ResizeObserver
  const renderEditor = () => {
    paintCurTok = () => {};
    entryRO?.disconnect(); entryRO = null;
    const e = book.entries[sel];
    editorBox.replaceChildren(e ? entryEl(e, sel) : h('p', { class: 'muted' }, '沒有條目。按上方的「＋ 新增條目」開始。'));
  };
  function addEntry() {
    book.entries.push({ id: Date.now(), comment: '', keys: [], secondary_keys: [], content: '', enabled: true, constant: false, selective: false, case_sensitive: false, insertion_order: 100, position: 'before_char', depth: 4, exclude_recursion: false, prevent_recursion: false });
    query = ''; search.value = '';
    select(book.entries.length - 1);
    editorBox.querySelector('input')?.focus();
  }
  async function deleteEntry(i) {
    const e = book.entries[i]; if (!e) return;
    if (!await askConfirm(`刪除條目「${titleOf(e)}」？`)) return;
    book.entries.splice(i, 1);
    select(i < sel ? sel - 1 : Math.max(0, Math.min(sel, book.entries.length - 1)), false);
  }
  const scrollToSel = () => { const c = chips.get(book.entries[sel]); if (c) strip.scrollLeft = c.offsetLeft - strip.offsetLeft - 40; };
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderStrip(); scrollToSel(); });
  // 滑鼠滾輪在清單上：改成左右捲動
  strip.addEventListener('wheel', ev => {
    if (strip.scrollWidth <= strip.clientWidth || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
    strip.scrollLeft += ev.deltaY; ev.preventDefault();
  }, { passive: false });

  const entryEl = (e, i) => {
    const paintBadges = () => paintChip(e);
    const bind = (el, key, conv = v => v) => { el.addEventListener('input', () => { e[key] = conv(el.type === 'checkbox' ? el.checked : el.value); paintBadges(); }); el.addEventListener('change', () => { e[key] = conv(el.type === 'checkbox' ? el.checked : el.value); paintBadges(); }); return el; };
    const toList = v => v.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const content = bind(h('textarea', { rows: 5, value: e.content }), 'content');
    // token 數；關鍵字條目比這本書的預算還長時提醒（觸發了也不會被插入）
    const tok = h('div', { class: 'tok' });
    const paintTok = () => {
      const n = estTok(content.value), over = !e.constant && n > budgetOf();
      tok.textContent = `約 ${n} tokens` + (over ? `　⚠ 超過這本世界書的 Token 預算（${budgetOf()}），觸發時也不會被插入；請調大預算、縮短內容，或改成常駐` : '');
      tok.classList.toggle('warn', over);
    };
    paintTok(); paintCurTok = paintTok;
    content.addEventListener('input', paintTok);
    const pos = bind(h('select', {}, h('option', { value: 'before_char' }, '角色設定之前'), h('option', { value: 'after_char' }, '角色設定之後'), h('option', { value: 'at_depth' }, '插入聊天紀錄（指定深度）')), 'position');
    pos.value = e.position;
    // 觸發方式：關鍵字觸發／常駐（永遠插入）。常駐時收起關鍵字欄位（資料保留，切回關鍵字觸發時還在）
    const keyBox = h('div', { class: 'form' },
      h('label', {}, h('span', {}, '關鍵字（最近幾則訊息裡出現其中任何一個，就插入這個條目；多個用半形「,」或全形「，」逗號分隔）'),
        bind(h('input', { type: 'text', value: (e.keys || []).join(', '), placeholder: '例：校園，現代，奇幻，科幻' }), 'keys', toList),
        h('span', { class: 'muted small-note' }, '只要訊息裡「包含」這段文字就算命中（「科幻」也會命中「科幻小說」），英文預設不分大小寫。'
          + '進階：用斜線包起來就是正規表示式，例如 /奇幻|魔法/ 或 /^sci-?fi/i（結尾的 i＝不分大小寫）；正規表示式裡不能有逗號。')),
      h('label', {}, h('span', {}, '次要關鍵字（需勾選下方的「選擇性」才生效：主、次關鍵字都要命中）'), bind(h('input', { type: 'text', value: (e.secondary_keys || []).join(', ') }), 'secondary_keys', toList)),
      h('div', { class: 'row' },
        h('label', { class: 'check' }, bind(h('input', { type: 'checkbox', checked: e.selective }), 'selective'), '選擇性'),
        h('label', { class: 'check' }, bind(h('input', { type: 'checkbox', checked: e.case_sensitive }), 'case_sensitive'), '區分大小寫')));
    const constNote = h('p', { class: 'muted small-note' }, '常駐：每次對話都會插入這個條目，不需要關鍵字，也不受 Token 預算限制。'
      + ((e.keys || []).length ? '原本填的關鍵字會保留，切回「關鍵字觸發」就會恢復。' : ''));
    // 整顆切換鈕是一個按鈕：點到哪裡都會切換（不用剛好點在另一邊的文字上）
    const modeOpts = [['keys', '關鍵字觸發'], ['constant', '常駐（永遠插入）']].map(([v, label]) => h('span', { 'data-v': v }, label));
    // 選中那一邊的底色：切換時滑過去（動畫關閉時直接跳過去）
    const msPill = h('span', { class: 'ms-pill', 'aria-hidden': 'true' });
    const modeSwitch = h('button', { type: 'button', class: 'mode-switch', role: 'switch', title: '點一下切換觸發方式',
      onclick: () => { e.constant = !e.constant; syncMode(true); paintBadges(); } }, msPill, ...modeOpts);
    const placePill = animate => {
      const on = modeOpts.find(o => o.classList.contains('on'));
      if (!on || !on.offsetWidth) return; // 還沒放進畫面：等 ResizeObserver
      msPill.classList.toggle('no-anim', !animate || !motionOn());
      msPill.style.width = on.offsetWidth + 'px';
      msPill.style.transform = `translateX(${on.offsetLeft}px)`;
    };
    entryRO = new ResizeObserver(() => { placePill(false); placeEsPill(false); }); // 換條目時由 renderEditor 停止（callback 在畫面排版後才執行，這時兩個切換鈕都已經建立）
    entryRO.observe(modeSwitch);
    const syncMode = animate => {
      for (const o of modeOpts) o.classList.toggle('on', (o.dataset.v === 'constant') === !!e.constant);
      placePill(!!animate);
      modeSwitch.setAttribute('aria-checked', String(!!e.constant));
      keyBox.hidden = !!e.constant; constNote.hidden = !e.constant;
      paintTok(); // 常駐條目不受預算限制：切換時更新提醒
    };
    syncMode();
    // 停用／啟用：放在觸發方式的同一行靠右；停用時紅色、啟用時綠色，一眼看得出這個條目有沒有在用
    // 停用／啟用：點下時色塊先換成新的顏色（綠／紅）與文字顏色，再滑到另一邊
    const enOpts = [['off', '停用'], ['on', '啟用']].map(([v, label]) => h('span', { 'data-v': v }, label));
    const esPill = h('span', { class: 'es-pill', 'aria-hidden': 'true' });
    const enSwitch = h('button', { type: 'button', class: 'enable-switch', role: 'switch', title: '點一下切換：停用的條目不會被插入',
      onclick: () => { e.enabled = e.enabled === false; syncEnabled(true); paintBadges(); } }, esPill, ...enOpts);
    const enTarget = () => enOpts.find(o => (o.dataset.v === 'on') === (e.enabled !== false));
    const placeEsPill = animate => {
      const t = enTarget();
      if (!t || !t.offsetWidth) return; // 還沒放進畫面：等 ResizeObserver
      esPill.classList.toggle('no-anim', !animate || !motionOn());
      esPill.style.width = t.offsetWidth + 'px';
      esPill.style.transform = `translateX(${t.offsetLeft}px)`;
    };
    const paintEnabled = () => {
      const on = e.enabled !== false;
      for (const o of enOpts) o.classList.toggle('on', o === enTarget());
      enSwitch.classList.toggle('is-off', !on);
    };
    const syncEnabled = animate => {
      enSwitch.setAttribute('aria-checked', String(e.enabled !== false));
      // 先換成新的顏色（狀態一按就看得到），再滑過去；滑動途中不會出現紅綠混合的中間色
      paintEnabled();
      placeEsPill(!!animate);
    };
    syncEnabled();
    entryRO.observe(enSwitch);
    return h('div', { class: 'entry' },
      h('div', { class: 'entry-body form' },
        h('label', {}, h('span', {}, '名稱／備註'), bind(h('input', { type: 'text', value: e.comment }), 'comment')),
        h('div', { class: 'mode-line' }, h('span', {}, '觸發方式'), h('div', { class: 'mode-row' }, modeSwitch, enSwitch)),
        keyBox, constNote,
        h('label', {}, h('span', {}, '內容'), content, tok),
        h('div', { class: 'row' },
          h('label', {}, h('span', {}, '插入位置'), pos),
          h('label', {}, h('span', {}, '深度（插入聊天紀錄時）'), bind(h('input', { type: 'number', min: 0, value: e.depth }), 'depth', Number)),
          h('label', {}, h('span', {}, '排序（數字大者影響較大）'), bind(h('input', { type: 'number', value: e.insertion_order }), 'insertion_order', Number))),
        h('div', { class: 'field-title' }, '遞迴設定'),
        h('div', { class: 'row' },
          h('label', { class: 'check' }, bind(h('input', { type: 'checkbox', checked: !!e.exclude_recursion }), 'exclude_recursion'), '不會被遞迴觸發'),
          h('label', { class: 'check' }, bind(h('input', { type: 'checkbox', checked: !!e.prevent_recursion }), 'prevent_recursion'), '內容不觸發其他條目')),
        h('div', { class: 'muted small-note cs-help' },
          h('p', {}, h('b', {}, '插入位置：'), '條目被觸發後，放在送給 AI 的內容的哪個位置。'),
          h('p', {}, h('b', {}, '・角色設定之前：'), '放在角色卡前面。適合世界觀、地理、歷史這類背景知識。'),
          h('p', {}, h('b', {}, '・角色設定之後：'), '放在角色卡後面。適合和角色有關的補充設定，例如人際關係、近況。'),
          h('p', {}, h('b', {}, '・插入聊天紀錄（指定深度）：'), '放進聊天紀錄裡。深度＝從最新一則往回數，放在第幾則之前（0＝最新一則之後，最靠近 AI 的回覆）。'
            + '越靠近最新的訊息，AI 越容易照做，適合規則、提醒、目前場景的狀態；深度只在選這個位置時有效。'),
          h('p', {}, '大世界的輪流發言模式裡，觸發的條目一律放在最後面（讓每位角色前面的內容都一樣，本機模型才能重用快取）。'),
          h('p', {}, h('b', {}, '排序：'), '同一個插入位置裡，數字大的排在後面、離對話較近，AI 比較會照做；觸發的條目超過 Token 預算時，也先保留數字大的（常駐條目一律保留）。想讓 AI 一定照做的內容，把插入位置改成「插入聊天紀錄（指定深度）」並把深度設小（例如 1～4），效果比調大排序更明顯。'),
          h('p', {}, h('b', {}, '遞迴設定：'), '有世界書開啟「遞迴掃描」時才有作用。'),
          h('p', {}, '不會被遞迴觸發：只有聊天訊息裡出現關鍵字才插入，其他條目的內容提到也不會帶出它。'),
          h('p', {}, '內容不觸發其他條目：這個條目的內容不會再帶出其他條目，適合內容很長、提到很多名詞的條目。')),
        h('div', { style: 'display:flex;gap:6px;justify-content:flex-end' },
          h('button', { class: 'small', type: 'button', onclick: () => { book.entries.splice(i + 1, 0, { ...structuredClone(e), id: Date.now() }); select(i + 1); } }, '複製'),
          h('button', { class: 'small danger', type: 'button', onclick: () => deleteEntry(i) }, '刪除'))));
  };
  wrap.append(
    h('div', { class: 'row' },
      h('label', {}, h('span', {}, '掃描深度（檢查最近幾則訊息）'), (() => { const el = h('input', { type: 'number', min: 1, value: book.scan_depth ?? 4 }); el.oninput = () => (book.scan_depth = +el.value); return el; })()),
      h('label', {}, h('span', {}, 'Token 預算'), (() => {
        const el = h('input', { type: 'number', min: WI_MIN_BUDGET, step: 256, value: budgetOf() });
        el.oninput = () => { book.token_budget = +el.value; refreshTok(); };
        el.onchange = () => { if (!(+el.value >= WI_MIN_BUDGET)) { el.value = book.token_budget = WI_MIN_BUDGET; refreshTok(); } }; // 最少 1024
        return el;
      })()),
      h('label', { class: 'check' }, (() => { const el = h('input', { type: 'checkbox', checked: book.recursive_scanning }); el.onchange = () => (book.recursive_scanning = el.checked); return el; })(), '遞迴掃描（條目內容也可觸發其他條目）')),
    h('details', { class: 'wi-help' }, h('summary', {}, 'ⓘ 這些設定的說明'),
    h('div', { class: 'muted small-note', style: 'display:grid;gap:4px' },
      h('div', {}, h('b', {}, '掃描深度：'), '從最近幾則訊息（含剛送出的那則）找關鍵字。提過一次的話題，會在這幾則之內持續插入對應的條目。建議 3～6（預設 4）；設小比較省 token、不容易誤觸發，但話題一帶過 AI 就看不到設定；設大設定能維持比較久，但 token 用得多，也容易帶出很久以前順口提過的條目。設 1 時，只會讀到最近的一則訊息：按「繼續」生成時，或大世界裡後面發言的角色，可能讀不到你送出的那則，建議至少 2。常駐條目不受影響。'),
      h('div', {}, h('b', {}, 'Token 預算：'), '關鍵字觸發的條目合計最多放多少 token，超過時先保留「排序」數字大的；單一條目比預算還長時不會被插入。最少 1024，建議 1024～4096（預設 2048）；條目多又長可以調大，但每次送出的內容也會變長。常駐條目不受限制。'),
      h('div', {}, h('b', {}, '遞迴掃描：'), '開啟後，這本世界書的條目也可以被「其他已插入條目的內容」觸發（最多再往下連鎖 2 層）。適合條目之間互相關聯的設定，例如「王國」條目提到的城市也一起帶出；但容易一次觸發很多條目。每個條目還可以個別設定「不會被遞迴觸發」或「內容不觸發其他條目」。'),
      h('div', {}, h('b', {}, '多本世界書：'), '同時套用好幾本世界書時（全域、角色連結、角色卡內嵌、大世界專屬），掃描深度與 Token 預算以數字最大的那本為準，大家一起使用；遞迴掃描則各本照自己的設定：沒開啟的世界書，條目只會被聊天訊息觸發。'))),
    search, strip, editorBox);
  select(0, false);
  return wrap;
}

// ===================== 世界書管理 =====================
$('#btnWorlds').onclick = openWorlds;
async function openWorlds() {
  const [worlds, st] = await Promise.all([api('GET', '/api/worlds'), api('GET', '/api/settings')]);
  state.worlds = worlds;
  const globalIds = new Set(st.settings.world_ids || []);
  const file = h('input', { type: 'file', accept: '.json,.png', hidden: true, onchange: async e => {
    const fl = e.target.files[0]; if (!fl) return;
    try { const r = await api('POST', '/api/worlds/import', fl, { 'X-Filename': encodeURIComponent(fl.name) }); toast('已匯入世界書'); openWorldEditor(r.id); }
    catch (err) { fail(err); }
  } });
  /** 打勾＝全域啟用（對所有角色、所有對話生效；和「設定 → 提示詞設定 → 全域世界書」是同一個設定） */
  const globalCheck = w => {
    const cb = h('input', { type: 'checkbox', checked: globalIds.has(w.id) });
    cb.onchange = async () => {
      try {
        // 以檔案裡最新的清單為準，只改這一本（不會蓋掉在別處改過的）
        const cur = new Set((await api('GET', '/api/settings')).settings.world_ids || []);
        if (cb.checked) cur.add(w.id); else cur.delete(w.id);
        const r = await api('PUT', '/api/settings', { world_ids: [...cur] });
        state.settings = { ...state.settings, ...r.settings };
        toast(cb.checked ? `已全域啟用「${w.name}」` : `已取消全域啟用「${w.name}」`);
      } catch (e) { cb.checked = !cb.checked; fail(e); }
    };
    return h('label', { class: 'wb-global', title: '勾選＝全域啟用：對所有角色、所有對話生效' }, cb);
  };
  /** 點名稱：展開／收合，預覽裡面的條目（名稱與狀態）；第一次展開時才讀取 */
  const row = w => {
    const arrow = icon('chevron-right', 'wb-arrow');
    const panel = h('div', { class: 'wb-entries', hidden: true });
    let loaded = false;
    const toggle = async () => {
      const open = panel.hidden;
      panel.hidden = !open; item.classList.toggle('open', open);
      if (!open || loaded) return;
      loaded = true;
      panel.replaceChildren(h('p', { class: 'muted small-note' }, '讀取中…'));
      try {
        const book = await api('GET', `/api/worlds/${w.id}`);
        const es = book.entries || [];
        panel.replaceChildren(...(es.length
          ? es.map(e => h('div', { class: 'wb-entry' + (e.enabled ? '' : ' off') }, h('span', { class: 't', title: wiTitle(e) }, wiTitle(e)), h('span', { class: 'b' }, ...wiBadges(e))))
          : [h('p', { class: 'muted small-note' }, '這本世界書還沒有條目。按右邊的「編輯」新增。')]));
      } catch (e) { loaded = false; panel.replaceChildren(h('p', { class: 'muted small-note' }, '無法讀取條目')); fail(e); }
    };
    const item = h('div', { class: 'item' },
      globalCheck(w),
      h('div', { class: 'grow', title: '展開／收合條目', role: 'button', tabindex: '0', onclick: toggle,
        onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } } },
        h('div', { class: 'title' }, arrow, w.name), h('div', { class: 'sub' }, `${w.count} 個條目`)),
      h('button', { class: 'small', title: '編輯', onclick: () => openWorldEditor(w.id) }, ic('pencil', '編輯')),
      h('button', { class: 'small', title: '匯出', onclick: () => exportFile({ kind: 'world', id: w.id }, `/api/worlds/${w.id}/export`) }, icon('export')),
      h('button', { class: 'small', title: '刪除', onclick: async () => {
        if (!await askConfirm(`刪除世界書「${w.name}」？\n會移到垃圾桶，${trashDaysText()}`)) return;
        try { await api('DELETE', `/api/worlds/${w.id}`); await openWorlds(); } catch (e) { fail(e); }
      } }, icon('trash-2')));
    return h('div', { class: 'wb-row' }, item, panel);
  };
  const list = h('div', { class: 'list' }, state.worlds.length ? state.worlds.map(row)
    : h('p', { class: 'muted' }, '還沒有世界書。世界書會在對話中出現關鍵字時，把對應的設定插入提示詞。'));
  const note = state.worlds.length ? h('p', { class: 'muted small-note' }, '打勾＝全域啟用（對所有角色、所有對話生效，和「設定 → 提示詞設定 → 全域世界書」同步）。角色卡或世界連結的世界書不用打勾也會生效；個別對話要停用，請到「對話設定 → 世界書」。點名稱展開條目，按右邊的「編輯」修改。') : null;
  openModal('世界書', h('div', {}, note, list, file), [
    h('button', { onclick: () => file.click() }, ic('import', '匯入（JSON / 角色卡）')),
    h('button', { class: 'primary', onclick: async () => {
      const name = await askText('新增世界書', { note: '世界書的名稱', value: '新世界書', okText: '建立' });
      if (!name) return;
      try { const r = await api('POST', '/api/worlds', { name, entries: [] }); await openWorldEditor(r.id); } catch (e) { fail(e); }
    } }, ic('plus', '新增'))], { esc: true });
}
async function openWorldEditor(id) {
  const w = await api('GET', `/api/worlds/${id}`);
  const name = h('input', { type: 'text', value: w.name });
  const body = h('div', { class: 'form' }, h('label', {}, h('span', {}, '名稱'), name), entriesEditor(w));
  // 還沒儲存的修改：條目編輯器直接改 w，所以比較整份內容
  const snap = () => JSON.stringify([name.value, w]);
  const baseline = snap();
  openModal('編輯世界書', body, [
    h('div', { class: 'left' }, h('button', { onclick: async () => { if (await confirmDiscard()) openWorlds(); } }, '← 返回')), // 返回放在左下角
    h('button', { class: 'primary', onclick: () => saveBook().catch(fail) }, '儲存')], { wide: true, back: openWorlds, dirty: () => snap() !== baseline });
  // 儲存：打開之後在別處改過（card_stale）時，讓你選仍要覆蓋、重新讀取或取消
  async function saveBook() {
    w.name = name.value.trim() || '未命名';
    const { ver, ...book } = w;
    const put = force => api('PUT', `/api/worlds/${id}`, { ...book, base_ver: ver, ...(force ? { force: true } : {}) });
    try { await put(false); } catch (e) {
      if (e.code !== 'card_stale') throw e;
      const pick = await askCardStale('世界書');
      if (pick === 'force') await put(true);
      else { if (pick === 'cancel') { closeModal(); openWorlds(); } else if (pick === 'reload') { closeModal(); openWorldEditor(id).catch(fail); } return; }
    }
    toast('世界書已儲存'); openWorlds();
  }
}

// ===================== 角色卡編輯器 =====================

/** back：按上一頁時回到哪個視窗（從角色介紹打開時回到介紹） */
// ===================== 狀態欄的欄位編輯器（角色編輯頁「狀態欄」分頁） =====================
// 欄位定義存在角色卡 extensions.ai_tavern_status（server 的 lib/status.js 會再整理一次）。設計稿：docs/狀態欄設計稿.md
const STATUS_EXT = 'ai_tavern_status';
const STATUS_LIMITS = { fields: 12, name: 20, hint: 200, initial: 200 }; // 和 lib/status.js 相同
// 預設範本：套用後就是一般欄位，可以再改，不會再跟範本連動
const STATUS_TEMPLATES = [
  { id: 'daily', name: '戀愛／日常', char: [
    { name: '心情', type: 'text', hint: '一兩個詞描述當下情緒', initial: '平靜' },
    { name: '好感度', type: 'number', max: 100, hint: '對 {{user}} 的好感，0～100，依互動合理變化，每次變化不超過 5', initial: '30' },
    { name: '服裝', type: 'text', hint: '目前的穿著，簡短描述', initial: '' },
    { name: '位置', type: 'text', hint: '目前所在的地點', initial: '' },
    { name: '內心想法', type: 'text', hint: '此刻沒說出口的想法，一句話', initial: '' }], user: [] },
  { id: 'rpg', name: '冒險／RPG', char: [
    { name: 'HP', type: 'number', max: 100, hint: '生命值，受傷減少、治療恢復', initial: '100' },
    { name: 'MP', type: 'number', max: 100, hint: '魔力，使用法術時減少、休息恢復', initial: '100' },
    { name: '狀態異常', type: 'text', hint: '中毒、疲勞等；沒有就寫「無」', initial: '無' },
    { name: '裝備', type: 'text', hint: '目前的武器與防具', initial: '' }], user: [
    { name: 'HP', type: 'number', max: 100, hint: '{{user}} 的生命值，受傷減少、治療恢復', initial: '100' },
    { name: 'MP', type: 'number', max: 100, hint: '{{user}} 的魔力，使用法術時減少、休息恢復', initial: '100' },
    { name: '持有金錢', type: 'number', hint: '金幣數量，買賣時增減', initial: '100' },
    { name: '物品', type: 'text', hint: '身上的重要物品，用頓號分隔', initial: '' }] },
  { id: 'simple', name: '簡易', char: [
    { name: '心情', type: 'text', hint: '一兩個詞描述當下情緒', initial: '平靜' },
    { name: '位置', type: 'text', hint: '目前所在的地點', initial: '' }], user: [] },
  { id: 'blank', name: '空白', char: [], user: [] },
];
/**
 * 狀態欄位編輯器。lists = { char_fields: [...], user_fields: [...] }（直接修改這個物件）。world：大世界用（角色欄位所有成員共用）。
 * 回傳 { el, check }：check() 在存檔前檢查名稱，有問題回傳錯誤訊息
 */
function statusFieldsEditor(lists, { world = false } = {}) {
  const charTitle = world ? '每位角色的狀態（所有角色共用這些欄位）' : '角色的狀態';
  const wrap = h('div', { class: 'form' });
  // 新欄位的 key：f1、f2…／u1、u2…（避開已經用過的）。key 不會跟著名稱變，改名後已存的數值照樣對得上
  const newKey = (list, prefix) => { let n = 1; while (list.some(f => f.key === prefix + n)) n++; return prefix + n; };
  const tplSel = h('select', { class: 'sf-tpl' }, h('option', { value: '' }, '套用範本…'), STATUS_TEMPLATES.map(t => h('option', { value: t.id }, t.name)));
  tplSel.onchange = async () => {
    const t = STATUS_TEMPLATES.find(x => x.id === tplSel.value);
    tplSel.value = '';
    if (!t) return;
    if ((lists.char_fields.length || lists.user_fields.length) && !await askConfirm(`套用範本「${t.name}」？\n目前的狀態欄位會被取代。`, { okText: '取代' })) return;
    for (const [k, src, prefix] of [['char_fields', t.char, 'f'], ['user_fields', t.user, 'u']]) {
      lists[k] = [];
      for (const f of src) lists[k].push({ ...structuredClone(f), key: newKey(lists[k], prefix) });
    }
    render();
  };
  const body = h('div', { class: 'form' });
  function listEditor(k, title, prefix, emptyText) {
    const list = lists[k];
    const rows = list.map((f, i) => {
      const num = f.type === 'number';
      const inp = (prop, attrs) => {
        const el = h('input', { value: f[prop] ?? '', ...attrs });
        el.oninput = () => { f[prop] = prop === 'max' ? (el.value === '' ? '' : Number(el.value)) : el.value; updTok(); }; // 初始值一律存文字
        return el;
      };
      const type = h('select', { title: '類型' }, h('option', { value: 'text' }, '文字'), h('option', { value: 'number' }, '數值'));
      type.value = num ? 'number' : 'text';
      type.onchange = () => { f.type = type.value; if (f.type !== 'number') delete f.max; else if (f.initial && !/^-?\d+(\.\d+)?$/.test(String(f.initial).trim())) f.initial = ''; render(); };
      const move = dir => { const j = i + dir; [list[i], list[j]] = [list[j], list[i]]; render(); };
      return h('div', { class: 'sf-row' },
        h('div', { class: 'sf-main' },
          inp('name', { type: 'text', class: 'sf-name', placeholder: '名稱', maxlength: STATUS_LIMITS.name, title: '欄位名稱（最多 20 字）' }),
          type,
          // 初始在前、最大在後；數值欄位的兩個輸入框是固定的小寬度
          h('label', { class: 'sf-lab sf-init' + (num ? ' sf-num' : '') }, h('span', {}, '初始'), inp('initial', { type: num ? 'number' : 'text', placeholder: '選填', maxlength: STATUS_LIMITS.initial, title: '開新對話時的值（選填）' })),
          num ? h('label', { class: 'sf-lab sf-max sf-num' }, h('span', {}, '最大'), inp('max', { type: 'number', min: 1, placeholder: '選填', title: '最大值（選填）：有填時面板會畫進度條' })) : null,
          h('div', { class: 'sf-btns' },
            h('button', { type: 'button', class: 'icon', title: '上移', disabled: i === 0, onclick: () => move(-1) }, icon('chevron-up')),
            h('button', { type: 'button', class: 'icon', title: '下移', disabled: i === list.length - 1, onclick: () => move(1) }, icon('chevron-down')),
            h('button', { type: 'button', class: 'icon', title: '刪除這個欄位', onclick: () => { list.splice(i, 1); render(); } }, icon('trash-2')))),
        inp('hint', { type: 'text', class: 'sf-hint', maxlength: STATUS_LIMITS.hint, placeholder: '說明（給 AI 看的填寫規則，例如「0～100，每次變化不超過 5」）', title: '說明（最多 200 字）：沒寫時 AI 比較容易亂填' }));
    });
    const full = list.length >= STATUS_LIMITS.fields;
    return h('fieldset', {}, h('legend', {}, title),
      rows.length ? rows : h('p', { class: 'muted small-note' }, emptyText),
      h('div', {}, h('button', { type: 'button', class: 'small', disabled: full, title: full ? `最多 ${STATUS_LIMITS.fields} 個欄位` : '',
        onclick: () => { list.push({ key: newKey(list, prefix), name: '', type: 'text', hint: '', initial: '' }); render(); body.querySelectorAll(`.sf-list-${k} .sf-name`)[list.length - 1]?.focus(); } },
      ic('plus', '新增欄位'))));
  }
  function render() {
    const a = listEditor('char_fields', charTitle, 'f', '沒有角色狀態欄位。'), b = listEditor('user_fields', '玩家的狀態', 'u', '沒有玩家狀態欄位。');
    a.classList.add('sf-list-char_fields'); b.classList.add('sf-list-user_fields');
    body.replaceChildren(a, b);
    updTok();
  }
  // 送給 AI 的狀態欄說明大約多少 token（說明文字由伺服器產生：lib/status.js 的 statusNote；打字時等一下再問）
  const tok = h('div', { class: 'tok' });
  let tokTimer = null, tokSeq = 0;
  function updTok() {
    clearTimeout(tokTimer);
    tokTimer = setTimeout(async () => {
      const seq = ++tokSeq;
      try {
        const r = await api('POST', '/api/status-note', { def: lists });
        if (seq === tokSeq) tok.textContent = r.tokens ? (world ? `角色發言時，狀態欄說明與目前狀態約佔 ${r.tokens} tokens（旁白、導演會看到所有在場角色的狀態，會再多一些）` : `每次送出時，狀態欄說明與目前狀態約佔 ${r.tokens} tokens`) : '';
      } catch { /* 算不出來就不顯示 */ }
    }, 400);
  }
  render();
  wrap.append(
    h('p', { class: 'muted small-note' }, world
      ? '對話頁右側的狀態欄會顯示這些欄位：每位角色各自一份「角色的狀態」，玩家的狀態只有一份。角色發言時只更新自己的狀態，旁白可以一次更新好幾位；你也可以在面板上手動修改。表情圖用各角色卡自己的。'
      : '對話頁右側的狀態欄會顯示這些欄位。AI 每次回覆時會依照「說明」更新數值，你也可以在面板上手動修改。數值欄位填了最大值時會畫進度條。'),
    h('div', { class: 'sf-top' }, tplSel, h('span', { class: 'muted small-note' }, '套用後可以再修改，不會再跟範本連動。')),
    body, tok);
  const check = () => {
    for (const [k, label] of [['char_fields', '角色的狀態'], ['user_fields', '玩家的狀態']]) {
      const names = lists[k].map(f => String(f.name || '').trim());
      if (names.some(n => !n)) return `「${label}」有欄位沒有名稱`;
      const bad = names.find(n => /[:：[\]]/.test(n));
      if (bad) return `欄位名稱「${bad}」不能有冒號或方括號`;
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) return `「${label}」有兩個欄位都叫「${dup}」`;
    }
    return null;
  };
  return { el: wrap, check };
}

// ===================== 表情圖編輯（角色編輯頁「表情圖」分頁） =====================
// 圖片放在角色資料夾的 expressions/，新增、改名、刪除、匯入當下就存（不用按「儲存」）；
// 「預設表情」存在角色卡上（extensions.ai_tavern_expressions），跟著「儲存」一起存。設計稿 6.3 節
/** 表情名稱（和 lib/expressions.js 的 cleanName 同樣規則的簡化版：只用來事先檢查同名） */
const EXPR_ALIASES = { embarrassment: 'shy', nervousness: 'nervous' }; // 和 lib/expressions.js 的 ALIASES 相同
const exprNameOf = file => {
  const n = String(file).split(/[\\/]/).pop().replace(/\.[^.]*$/, '').replace(/[:*?"<>|]/g, '').trim().slice(0, 40);
  return EXPR_ALIASES[n.toLowerCase()] || n;
};
const pickFiles = accept => new Promise(resolve => {
  const input = h('input', { type: 'file', accept, multiple: true, hidden: true });
  const done = v => { input.remove(); resolve(v); };
  input.addEventListener('cancel', () => done([]));
  input.addEventListener('change', () => done([...input.files]));
  document.body.append(input); input.click();
});
/**
 * getId：目前的角色 ID（新角色還沒儲存時是 null）；ex = { list: [{ name, ver }], default }（直接修改）；
 * onChange：表情有變動時通知（對話頁的面板跟著換圖）
 */
function expressionEditor(getId, ex, onChange) {
  const wrap = h('div', { class: 'form' });
  const sync = (r, info) => { ex.list = r.expressions; ex.default = r.default; if (r.card_ver) ex.card_ver = r.card_ver; render(); onChange?.(info); };
  const has = name => ex.list.some(e => e.name.toLowerCase() === name.toLowerCase());
  async function addImages() {
    const files = await pickFiles('image/png,image/webp,image/gif,image/jpeg');
    if (!files.length) return;
    const dup = files.map(f => exprNameOf(f.name)).filter(has);
    let replace = false;
    if (dup.length) replace = await askConfirm(`已經有同名的表情：${dup.join('、')}\n要用新的圖片取代嗎？選「略過」的話這幾張不會加入。`, { okText: '取代', cancelText: '略過' });
    const errs = [];
    let n = 0, last = null;
    for (const fl of files) {
      const name = exprNameOf(fl.name);
      if (has(name) && !replace) continue;
      try {
        last = await api('POST', `/api/characters/${getId()}/expressions?name=${encodeURIComponent(name)}&replace=${replace ? 1 : 0}`, fl, true);
        n++;
      } catch (e) { errs.push(`${fl.name}：${e.message}`); }
    }
    if (last) sync(last);
    if (n) toast(`已加入 ${n} 張表情圖`);
    if (errs.length) toast(`有 ${errs.length} 張沒有加入：\n${errs.slice(0, 5).join('\n')}${errs.length > 5 ? '\n…' : ''}`, true, 9000);
  }
  async function importZip() {
    const [fl] = await pickFiles('.zip,application/zip');
    if (!fl) return;
    const url = mode => `/api/characters/${getId()}/expressions/zip?on_conflict=${mode}`;
    try {
      let r = await api('POST', url('ask'), fl, true);
      if (r.conflicts?.length) {
        const rep = await askConfirm(`表情包裡有 ${r.conflicts.length} 個和現有表情同名：${r.conflicts.slice(0, 8).join('、')}${r.conflicts.length > 8 ? '…' : ''}\n要用表情包的圖片取代嗎？選「略過」的話只加入不同名的。`, { okText: '取代', cancelText: '略過' });
        r = await api('POST', url(rep ? 'replace' : 'skip'), fl, true);
      }
      sync(r);
      toast(`已從表情包加入 ${r.added.length} 張表情圖`);
      if (r.skipped.length) toast(`略過了 ${r.skipped.length} 個檔案：\n${r.skipped.slice(0, 6).map(s => `${s.file}（${s.reason}）`).join('\n')}${r.skipped.length > 6 ? '\n…' : ''}`, false, 10000);
    } catch (e) { fail(e); }
  }
  /** 預設表情的格子：選一張圖，存成格子的名稱（joy.png…，原本的檔名不管），已經有圖就換掉 */
  async function uploadToSlot(p) {
    const [fl] = await pickFiles('image/png,image/webp,image/gif,image/jpeg');
    if (!fl) return;
    try {
      sync(await api('POST', `/api/characters/${getId()}/expressions?name=${encodeURIComponent(p.name)}&replace=1`, fl, true));
      toast(`已上傳「${p.zh}（${p.name}）」`);
    } catch (e) { fail(e); }
  }
  async function renameExpr(e) {
    const to = await askText('表情改名', { value: e.name, note: '表情名稱就是檔名，模型會用這個名稱選表情。最多 40 字。', okText: '改名' });
    if (to == null || !to.trim() || to.trim() === e.name) return;
    try { sync(await api('PUT', `/api/characters/${getId()}/expressions/rename`, { from: e.name, to: to.trim() }), { renamed: true }); } catch (err) { fail(err); }
  }
  async function deleteExpr(e) {
    if (!await askConfirm(`刪除表情「${exprLabel(e.name)}」？\n圖片會直接刪除，無法復原。`)) return;
    try { sync(await api('DELETE', `/api/characters/${getId()}/expressions?name=${encodeURIComponent(e.name)}`)); } catch (err) { fail(err); }
  }
  function render() {
    const id = getId();
    if (!id) { wrap.replaceChildren(h('p', { class: 'muted small-note' }, '先按「儲存」建立角色，才能加入表情圖。')); return; }
    const defSel = h('select', { class: 'ex-default' }, h('option', { value: '' }, '（不指定：顯示封面）'), ex.list.map(e => h('option', { value: e.name }, exprLabel(e.name))));
    defSel.value = ex.list.some(e => e.name === ex.default) ? ex.default : '';
    defSel.onchange = () => { ex.default = defSel.value || null; };
    // 一張已經有的表情圖：預設表情可以「更換」（名稱固定），自訂的可以改名
    const card = (e, preset) => h('div', { class: 'ex-item' + (e.name === ex.default ? ' is-default' : '') },
      zoomable(h('img', { src: exprUrl(id, e), alt: e.name, loading: 'lazy' })),
      h('div', { class: 'ex-name', title: e.name }, exprLabel(e.name)),
      h('div', { class: 'ex-btns' },
        preset ? h('button', { type: 'button', class: 'icon', title: '換一張圖', onclick: () => uploadToSlot(preset) }, icon('refresh-cw'))
          : h('button', { type: 'button', class: 'icon', title: '改名', onclick: () => renameExpr(e) }, icon('pencil')),
        h('button', { type: 'button', class: 'icon', title: '刪除', onclick: () => deleteExpr(e) }, icon('trash-2'))));
    // 預設表情：固定 8 格，還沒上傳的是虛線的空格（不會送給 AI）
    const presetCells = EXPR_PRESETS.map(p => {
      const e = ex.list.find(x => x.name.toLowerCase() === p.name);
      return e ? card(e, p) : h('button', { type: 'button', class: 'ex-item ex-empty', title: `上傳「${p.zh}（${p.name}）」的圖片`, onclick: () => uploadToSlot(p) },
        h('div', { class: 'ex-ph' }, icon('plus')), h('div', { class: 'ex-name' }, `${p.zh}（${p.name}）`), h('div', { class: 'ex-up muted' }, '上傳'));
    });
    const customs = ex.list.filter(e => !exprPreset(e.name));
    // replaceChildren 會把 null 變成「null」文字：沒有的項目先濾掉
    wrap.replaceChildren(...[
      h('p', { class: 'muted small-note' }, '對話頁的狀態欄會依照 AI 選的表情換圖。送給 AI 的是檔名（表情名稱），預設表情以英文為主。支援 PNG、WebP、GIF、JPEG，單張最多 5 MB。新增、更換、刪除當下就會存。'),
      h('div', { class: 'ex-tools' },
        h('button', { type: 'button', onclick: () => importZip() }, ic('import', '匯入表情包（ZIP）')),
        h('label', { class: 'ex-def-lab' }, h('span', {}, '預設表情'), defSel)),
      h('div', { class: 'field-title' }, '預設表情'),
      h('p', { class: 'muted small-note' }, '點空格上傳，檔名會自動用格子的名稱（例如 joy.png）。SillyTavern 的表情包（ZIP，圖片放在第一層）匯入後，同名的圖會自動填進格子。'),
      h('div', { class: 'ex-grid' }, presetCells),
      h('div', { class: 'field-title' }, '其他表情'),
      h('p', { class: 'muted small-note' }, '自己取名的表情：檔名就是表情名稱（例如 喝醉.png），AI 會用這個名稱選表情。'),
      // 第一格固定是虛線的「新增表情」（和預設表情的空格同一種樣子），後面是已經有的自訂表情
      h('div', { class: 'ex-grid' },
        h('button', { type: 'button', class: 'ex-item ex-empty', title: '新增自己取名的表情（可以一次選多張，檔名就是表情名稱）', onclick: () => addImages().catch(fail) },
          h('div', { class: 'ex-ph' }, icon('plus')), h('div', { class: 'ex-name' }, '新增表情'), h('div', { class: 'ex-up muted' }, '可以一次選多張')),
        customs.map(e => card(e, null)))].filter(Boolean));
  }
  render();
  return { el: wrap, render };
}

async function openCharEditor(ch, { back } = {}) {
  const isNew = !ch;
  const d = structuredClone(ch ? ch.data : { name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {}, character_book: null });
  const worlds = await api('GET', '/api/worlds').catch(() => []);
  const img = { cover: null, avatar: null, removeAvatar: false }; // 新選的圖片（data URL）
  const f = {};
  const field = fieldMaker(f, d);

  // 封面與頭像
  const ph = (cls, t) => h('div', { class: 'avatar-ph ' + cls }, t);
  let coverPrev = ch?.has_cover ? h('img', { class: 'cover-prev', src: imgUrl(ch, 'cover'), alt: '' }) : ph('cover-prev', icon('image'));
  let avatarPrev = ch?.has_avatar ? h('img', { class: 'avatar-prev', src: imgUrl(ch, 'avatar'), alt: '' })
    : ch?.has_cover ? h('img', { class: 'avatar-prev', src: imgUrl(ch, 'cover'), alt: '' }) : ph('avatar-prev', icon('user'));
  const avatarNote = h('span', {}, ch?.has_avatar ? '對話頭像' : '對話頭像（目前使用封面）');
  const swap = (oldEl, newEl) => { oldEl.replaceWith(newEl); return newEl; };
  const setAvatar = url => {
    img.avatar = url; img.removeAvatar = false;
    avatarPrev = swap(avatarPrev, h('img', { class: 'avatar-prev', src: url, alt: '' }));
    avatarNote.textContent = '對話頭像';
  };
  const imgBox = h('div', { class: 'img-edit' },
    h('div', { class: 'img-slot' }, coverPrev, h('span', {}, '封面（角色卡圖片）'),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'small', onclick: async () => {
        const url = await pickImage(900); if (!url) return;
        img.cover = url;
        coverPrev = swap(coverPrev, h('img', { class: 'cover-prev', src: url, alt: '' }));
        if (!img.avatar && (img.removeAvatar || !ch?.has_avatar)) avatarPrev = swap(avatarPrev, h('img', { class: 'avatar-prev', src: url, alt: '' }));
      } }, '更換封面'))),
    h('div', { class: 'img-slot' }, avatarPrev, avatarNote,
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'small', title: '從封面圈選頭像範圍', onclick: async () => {
          const src = img.cover || (ch?.has_cover ? imgUrl(ch, 'cover') : null);
          if (!src) return toast('還沒有封面，請先「更換封面」或直接「更換頭像」');
          const url = await cropImage(src, { title: '從封面擷取頭像' });
          if (url) setAvatar(url);
        } }, '使用封面'),
        h('button', { type: 'button', class: 'small', onclick: async () => {
          const cropped = await pickImage(1600, { crop: {} });
          if (cropped) setAvatar(cropped);
        } }, '更換頭像'))));

  // 開場白：和世界設定的開場白一樣，用對話頁的排版直接編輯。每個開場白是一個區塊，
  // 區塊裡可以有好幾則訊息：角色、旁白或你說的（第一個區塊是主要開場白，其餘是備用開場白，開新對話時選一個）。
  // 存檔時 first_mes／alternate_greetings 存合併後的文字（其他程式讀得懂），結構存在 extensions（見 lib/cards.js）
  const OPEN_KEY = 'ai_tavern_openings';
  const flatten = b => b.map(o => (o.speaker === 'user' ? `{{user}}：${o.content}` : o.content)).join('\n\n');
  const blocks = (() => {
    const texts = [d.first_mes, ...(d.alternate_greetings || [])].filter(Boolean);
    const raw = d.extensions?.[OPEN_KEY];
    if (Array.isArray(raw)) {
      const bs = raw.map(b => (Array.isArray(b) ? b : []).filter(o => o && ['char', 'narrator', 'user'].includes(o.speaker) && String(o.content || '').trim())
        .map(o => ({ speaker: o.speaker, content: String(o.content) }))).filter(b => b.length);
      if (bs.length === texts.length && bs.every((b, i) => flatten(b) === texts[i])) return bs;
    }
    return texts.map(t => [{ speaker: 'char', content: t }]);
  })();
  /** 存檔用：拿掉空白的訊息與區塊 */
  const cleanBlocks = () => blocks.map(b => b.filter(o => o.content.trim()).map(o => ({ ...o }))).filter(b => b.length);
  f.first_mes = { get value() { const b = cleanBlocks()[0]; return b ? flatten(b) : ''; } }; // 儲存與「還沒儲存的修改」照樣讀 f.first_mes
  const greetBox = h('div', { class: 'greet-blocks' });
  const charAv = cls => (ch ? avatarEl(ch, cls) : h('div', { class: 'avatar-ph ' + cls }, icon('user')));
  const charName = () => f.name?.value.trim() || '角色';
  const myName = () => state.settings?.user_name || 'User';
  const speakerOpts = () => [['char', charName()], ['narrator', '旁白'], ['user', `${myName()}（你）`]];
  const speakerAv = (sp, cls) => sp === 'narrator' ? h('div', { class: 'avatar-ph narrator-av ' + cls }, icon('book-open'))
    : sp === 'user' ? userAvatarEl(cls, { global: true }) : charAv(cls);
  const autoSize = CSS.supports?.('field-sizing', 'content');
  const grow = ta => { if (autoSize || !ta.offsetParent) return; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
  const btn = (label, title, fn, disabled) => h('button', { type: 'button', title, disabled, onclick: fn }, label);
  const focusLast = el => { const last = [...el.querySelectorAll('textarea')].at(-1); last?.focus(); last?.scrollIntoView({ block: 'nearest' }); };
  function renderGreets() {
    greetBox.innerHTML = '';
    if (!blocks.length) greetBox.append(h('div', { class: 'empty muted' }, '還沒有開場白。按下面的「新增主要開場白」開始。'));
    blocks.forEach((block, bi) => {
      const list = h('div', { class: 'opening-list' });
      const opts = speakerOpts();
      if (!block.length) list.append(h('div', { class: 'empty muted' }, '這個開場白還沒有內容，點下面的頭像加入一則。'));
      block.forEach((o, i) => {
        const isUser = o.speaker === 'user', isNar = o.speaker === 'narrator';
        const sel = h('select', { class: 'op-who', title: '改成由誰說', onchange: e => { o.speaker = e.target.value; renderGreets(); } }, opts.map(([v, t]) => h('option', { value: v }, t)));
        sel.value = o.speaker;
        const ta = h('textarea', { class: 'op-text', rows: 1, value: o.content,
          placeholder: isNar ? '場景描寫、事件經過…' : isUser ? '你的行動或台詞…' : `${charName()} 的台詞與動作…（可使用 {{char}}、{{user}}）` });
        ta.oninput = () => { o.content = ta.value; grow(ta); };
        ta.onfocus = () => grow(ta);
        const move = dir => { const j = i + dir; [block[i], block[j]] = [block[j], block[i]]; renderGreets(); };
        list.append(h('div', { class: 'msg op-msg ' + (isUser ? 'user' : 'bot') + (isNar ? ' narrator' : '') },
          speakerAv(o.speaker, 'mav'),
          h('div', { class: 'mcol' },
            h('div', { class: 'mhead' }, h('span', { class: 'mname' }, sel)),
            h('div', { class: 'mbody', onclick: () => ta.focus() }, ta),
            h('div', { class: 'mactions' },
              btn(icon('chevron-up'), '上移', () => move(-1), i === 0),
              btn(icon('chevron-down'), '下移', () => move(1), i === block.length - 1),
              h('span', { class: 'sep' }),
              btn(ic('trash-2', '刪除'), '刪除這則', () => { block.splice(i, 1); renderGreets(); })))));
        setTimeout(() => grow(ta), 0);
      });
      const add = h('div', { class: 'opening-add' }, h('span', { class: 'sb-label' }, '加入一則'),
        ...opts.map(([v, t]) => h('button', { type: 'button', class: 'sb-btn', onclick: () => { block.push({ speaker: v, content: '' }); renderGreets(); focusLast(greetBox.children[bi]); } },
          speakerAv(v, 'sb-av'), h('span', {}, t))));
      const moveBlock = dir => { const j = bi + dir; [blocks[bi], blocks[j]] = [blocks[j], blocks[bi]]; renderGreets(); };
      greetBox.append(h('div', { class: 'greet-block' + (bi === 0 ? ' main' : '') },
        h('div', { class: 'greet-head' },
          h('span', { class: 'greet-title' }, bi === 0 ? '主要開場白' : `備用開場白 ${bi}`),
          h('span', { class: 'grow' }),
          btn(icon('chevron-up'), bi === 1 ? '上移（改成主要開場白）' : '整個開場白上移', () => moveBlock(-1), bi === 0),
          btn(icon('chevron-down'), '整個開場白下移', () => moveBlock(1), bi === blocks.length - 1),
          btn(ic('trash-2', '刪除'), '刪除這個開場白', async () => {
            if (block.some(o => o.content.trim()) && !await askConfirm(`刪除「${bi === 0 ? '主要開場白' : '備用開場白 ' + bi}」？`)) return;
            blocks.splice(bi, 1); renderGreets();
          })),
        h('div', { class: 'opening-chat' }, list, add)));
    });
    greetBox.append(h('div', {}, btn(ic('plus', blocks.length ? '新增備用開場白' : '新增主要開場白'), '新增一個開場白區塊（開新對話時可以選）', () => {
      blocks.push([{ speaker: 'char', content: '' }]); renderGreets(); focusLast(greetBox.children[blocks.length - 1]);
    })));
  }

  // 內嵌世界書
  const book = d.character_book || { name: '', entries: [], scan_depth: 4, token_budget: 2048, recursive_scanning: false };
  const worldSel = h('select', {}, h('option', { value: '' }, '（不連結）'), worlds.map(w => h('option', { value: w.id }, w.name)));
  worldSel.value = ch?.world_id || '';

  // 狀態欄的欄位
  const rawStatus = d.extensions?.[STATUS_EXT];
  const statusLists = {
    char_fields: structuredClone(Array.isArray(rawStatus?.char_fields) ? rawStatus.char_fields : []),
    user_fields: structuredClone(Array.isArray(rawStatus?.user_fields) ? rawStatus.user_fields : []),
  };
  const statusEd = statusFieldsEditor(statusLists);
  let savedId = ch?.id || null; // 新角色第一次只儲存後，之後再存就是更新同一張卡
  const ver = { base: ch?.ver ?? null }; // 打開編輯時卡片的版本：存檔時帶回去，被別處改過就提醒（見 askCardStale）
  // 表情圖：當下就存；預設表情跟著「儲存」存進角色卡
  const exprState = { list: ch?.expressions || [], default: defaultExpr(ch) };
  const exprEd = expressionEditor(() => savedId, exprState, async info => {
    // 改名、刪除表情時伺服器可能順便改了卡片上的預設表情：用新的版本，存檔時才不會誤判成被別處改過
    if (exprState.card_ver) { ver.base = exprState.card_ver; delete exprState.card_ver; }
    if ($('#chatView').hidden || state.char?.id !== savedId) return;
    state.char.expressions = exprState.list;
    // 改名時伺服器也改了對話裡記著的表情名稱：把狀態與訊息版本換成新的（不整份換掉 state.chat）
    if (info?.renamed && state.chat) {
      const chatId = state.chatId;
      try {
        const r = await api('GET', `/api/characters/${savedId}/chats/${chatId}`);
        if (state.chatId === chatId) { r.messages.forEach((m, i) => { const cur = state.chat.messages[i]; if (cur && m.swipe_status) cur.swipe_status = m.swipe_status; }); state.chat.msg_ver = r.msg_ver; }
      } catch { /* 讀不到就維持原樣 */ }
    }
    renderStatusPanel();
  });

  const tabsDef = [
    ['基本', h('div', { class: 'form' },
      h('div', { class: 'editor-top' }, imgBox, h('div', { class: 'form' },
        field('name', '角色名稱 *'),
        field('tags', '標籤（逗號分隔，只用來分類與搜尋，不會送給 AI）'),
        h('div', { class: 'row' }, field('creator', '作者'), field('character_version', '版本')))),
      field('description', '角色描述（外觀、背景、設定；可使用 {{char}}、{{user}} 代稱）', 10),
      field('personality', '個性（性格、說話方式與習慣；可使用 {{char}}、{{user}} 代稱）', 6),
      field('scenario', '情境（故事開始時的時間、地點與狀況；只用在和這個角色單獨對話，大世界不會送出）', 4),
      field('creator_notes', '角色介紹（顯示在角色詳情，不會送給 AI）', 5))],
    ['進階提示', h('div', { class: 'form' },
      field('system_prompt', '系統提示（接在主要系統提示後面一起送出；寫 {{original}} 可自訂主要系統提示放的位置）', 10),
      field('post_history_instructions', '後置指令（放在聊天紀錄之後，常用於提醒格式或規則）', 5),
      field('mes_example', '對話範例', 8, '每段以 <START> 開頭，下一行起寫「{{user}}: …」「{{char}}: …」'))],
    ['開場白', h('div', { class: 'form' },
      h('p', { class: 'muted small-note' }, '新對話開始時出現的訊息。每個開場白可以有好幾則：角色、旁白或你說的（點名字可以改成別人說）。有備用開場白時，開新對話會先讓你選一個；把備用開場白整個上移到第一個，就變成主要開場白。匯出給其他程式時，旁白與你的台詞會合併成一段文字。'),
      greetBox)],
    ['狀態欄', statusEd.el],
    ['表情圖', exprEd.el],
    ['世界書', h('div', { class: 'form' },
      h('label', {}, h('span', {}, '連結全域世界書（只對此角色生效）'), worldSel),
      h('fieldset', {}, h('legend', {}, '角色內嵌世界書'), entriesEditor(book)))],
  ];
  f.tags.value = (d.tags || []).join(', ');
  renderGreets();
  // 改名字時，開場白發言者選單裡的角色名稱跟著更新
  f.name.addEventListener('input', () => greetBox.querySelectorAll('.op-who option[value="char"]').forEach(el => (el.textContent = charName())));

  const { bar: tabBar, panes } = tabsUI(tabsDef);

  // 儲存：close＝true 時存完關閉視窗（「儲存並關閉」）；false 時只儲存，繼續編輯（綠色的「儲存」）
  let saving = false;
  let markSaved = () => {}; // 存好後把目前內容當成「已儲存」（下面設定）
  const save = async (close = true) => {
    if (saving) return;
    for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version']) d[k] = f[k].value;
    d.name = d.name.trim();
    if (!d.name) return toast('請輸入角色名稱', true);
    const statusErr = statusEd.check();
    if (statusErr) return toast(statusErr + '（在「狀態欄」分頁）', true);
    d.tags = f.tags.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const bs = cleanBlocks();
    d.alternate_greetings = bs.slice(1).map(flatten);
    // 只有一般的開場白（每個都是一則角色說的話）時不用存結構
    const ext = { ...(d.extensions || {}) };
    if (bs.every(b => b.length === 1 && b[0].speaker === 'char')) delete ext[OPEN_KEY]; else ext[OPEN_KEY] = bs;
    // 狀態欄：沒有欄位就不存（伺服器也會拿掉）
    if (statusLists.char_fields.length || statusLists.user_fields.length) ext[STATUS_EXT] = structuredClone(statusLists); else delete ext[STATUS_EXT];
    if (exprState.default) ext.ai_tavern_expressions = { default: exprState.default }; else delete ext.ai_tavern_expressions; // 預設表情
    d.extensions = ext;
    d.character_book = book.entries.length ? { ...book, name: book.name || d.name } : null;
    const payload = { data: d, cover: img.cover || undefined, avatar: img.avatar || undefined, remove_avatar: img.removeAvatar || undefined, world_id: worldSel.value || null };
    saving = true;
    try {
      let id;
      if (!savedId) {
        id = (await api('POST', '/api/characters', payload)).id;
        ver.base = (await api('PUT', `/api/characters/${id}`, worldSel.value ? { world_id: worldSel.value } : {})).ver;
      } else {
        id = savedId;
        const put = force => api('PUT', `/api/characters/${id}`, { ...payload, base_ver: ver.base ?? undefined, ...(force ? { force: true } : {}) });
        let r;
        try { r = await put(false); } catch (e) {
          if (e.code !== 'card_stale') throw e;
          const pick = await askCardStale('角色卡');
          if (pick === 'force') r = await put(true);
          else {
            if (pick === 'cancel') closeModal();
            else if (pick === 'reload') { const fresh = await api('GET', `/api/characters/${id}`); closeModal(); openCharEditor(fresh, { back }).catch(fail); }
            return;
          }
        }
        ver.base = r.ver;
      }
      const isFirst = !savedId;
      savedId = id;
      if (isFirst) exprEd.render(); // 新角色第一次儲存後才能加表情圖
      // 圖片已經存好：之後只儲存時不用再送一次
      img.cover = null; img.avatar = null; img.removeAvatar = false;
      markSaved();
      if (close) closeModal();
      toast('角色已儲存');
      if (!$('#chatView').hidden && state.char?.id === id) {
        state.char = await api('GET', `/api/characters/${id}`);
        renderSide(); renderMessages(); renderStatusPanel(); // 封面可能換了
      } else await loadChars();
    } catch (e) { fail(e); }
    finally { saving = false; }
  };

  const foot = [];
  if (!isNew) foot.push(h('div', { class: 'left' },
    h('button', { onclick: () => exportCharFile(ch.id, 'png') }, ic('export', '匯出 PNG')),
    h('button', { onclick: () => exportCharFile(ch.id, 'json') }, ic('export', '匯出 JSON')),
    // .charx：連同封面與表情圖一起帶走（PNG、JSON 只有角色資料）
    h('button', { title: '角色卡 V3 的 ZIP 格式：連同封面與所有表情圖一起匯出', onclick: () => exportCharFile(ch.id, 'charx') }, ic('export', '匯出 .charx')),
    h('button', { class: 'danger', onclick: async () => {
      if (!await askConfirm(`確定刪除角色「${ch.data.name}」以及所有聊天紀錄？\n角色連同所有對話會移到垃圾桶，${trashDaysText()}`)) return;
      try { await api('DELETE', `/api/characters/${ch.id}`); } catch (e) { return fail(e); } // 刪除失敗：視窗留著，不顯示成功
      closeModal(); toast('已刪除角色');
      if ($('#homeView').hidden) go('#/'); else loadChars();
    } }, '刪除角色')));
  // 右邊三顆按鈕放在同一組：視窗窄時左邊那組換行，這三顆不會被拆開
  foot.push(h('div', { class: 'right' },
    h('button', { onclick: tryCloseModal }, '取消'),
    h('button', { class: 'success', title: '儲存目前的內容，繼續編輯', onclick: () => save(false) }, '儲存'),
    h('button', { class: 'primary', onclick: () => save(true) }, '儲存並關閉')));
  // 還沒儲存的修改：和打開時（或上次儲存時）的內容比較
  const TEXT_KEYS = ['name', 'tags', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version'];
  const snap = () => JSON.stringify([TEXT_KEYS.map(k => f[k].value), blocks, book, worldSel.value, img.cover, img.avatar, img.removeAvatar, statusLists, exprState.default]);
  let baseline = snap();
  markSaved = () => { baseline = snap(); };
  openModal(isNew ? '建立新角色' : `角色設定：${ch.data.name}`, h('div', {}, tabBar, ...panes), foot, { wide: true, fixed: true, back, dirty: () => snap() !== baseline });
}

