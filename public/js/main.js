'use strict';
// AI 酒館 前端 — 啟動
// 這些檔案依序載入（見 index.html），共用同一個全域範圍；最後由 main.js 啟動
// ===================== 啟動 =====================
(async function init() {
  try {
    const r = await api('GET', '/api/settings');
    state.settings = r.settings; state.keys = r.keys;
    applySavedAppearance();
    if (r.corrupt?.length) showCorruptBanner(r.corrupt);
    await route();
    // 第一次啟動：在首頁顯示引導（按「知道了」以後就不再出現）；不是第一次才用小提示提醒沒填金鑰
    // 設定檔損毀時讀到的是預設值（first_run_done 也是 false）：不要誤顯示第一次啟動的引導
    if (r.corrupt?.length) { /* 上方已有損毀提示 */ }
    else if (!r.settings.first_run_done && !$('#homeView').hidden) openFirstRunGuide();
    else if (r.settings.provider !== 'openai' && !r.keys[r.settings.provider]?.set) toast('尚未設定 API 金鑰，請到「設定」填寫', true);
    // 檢查更新（「設定 → 關於」可以關閉）：有新版本時只顯示小紅點與一則提示，不跳出視窗
    if (r.settings.update_check !== false) {
      api('GET', '/api/update-check').then(u => {
        state.update = u; markUpdateDot();
        if (u.newer) toast(`有新版本 v${u.latest}，可以到「設定 → 關於」查看`, false, 6000);
      }).catch(() => {});
    }
  } catch (e) { fail(e); }
})();

// 生成中關閉視窗：先提醒（關掉的話，伺服器會停下生成並存好已產生的部分）
window.addEventListener('beforeunload', e => { if (state.generating) { e.preventDefault(); e.returnValue = ''; } });

// 右鍵：應用程式視窗裡只在用得到的地方出現瀏覽器的選單（輸入框、選取了文字時，可以複製貼上），
// 其他地方（空白處、按鈕、卡片、圖片）不出現，免得誤按「重新載入」「翻譯」「列印」；
// 按住 Shift 再按右鍵可以叫出原本的選單（除錯用）。一般瀏覽器分頁開的不受影響
if (new URLSearchParams(location.search).has('app')) {
  document.addEventListener('contextmenu', e => {
    if (e.shiftKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    e.preventDefault();
  });
}

// 看不到視窗時（縮小、被擋住、切到別的分頁）暫停背景的星星動畫，省 CPU／GPU
document.addEventListener('visibilitychange', () => { document.documentElement.toggleAttribute('data-hidden', document.hidden); });

// ===================== 設定檔損毀的提示 =====================
// settings.json／config.json 讀不懂時，設定與金鑰會以預設值顯示（存檔會被擋下，不會蓋掉原檔）；
// 一直顯示在畫面上方，直到按「×」關掉，避免誤以為設定被清空
function showCorruptBanner(files) {
  if ($('#corruptBanner')) return;
  const hasSettings = files.includes('settings.json');
  const bar = h('div', { id: 'corruptBanner', class: 'corrupt-banner', role: 'alert' },
    h('div', { class: 'grow' },
      h('b', {}, `⚠ 設定檔損毀：${files.join('、')}`),
      h('p', {}, (hasSettings
        ? '目前畫面上的設定是預設值，不是你原本的設定（模型設定檔、使用者設定檔也看不到），生成也會用預設的供應商與模型；為了不蓋掉原檔，這時儲存設定會被擋下。'
        : '目前讀不到你存的 API 金鑰；為了不蓋掉原檔，這時儲存金鑰會被擋下。')
        + (hasSettings ? '請到「設定 → 資料」從備份還原（損毀期間不會自動備份，好的舊備份都還在）。' : '請自行修正或刪除 userdata/config.json 後重新填寫金鑰。')),
      hasSettings ? h('button', { type: 'button', class: 'small', onclick: () => { state.settingsTab = 'data'; go('#/settings'); } }, '前往備份還原') : null),
    h('button', { type: 'button', class: 'small icon', title: '關閉這個提示', onclick: () => bar.remove() }, icon('x')));
  document.body.append(bar);
}

// ===================== 第一次啟動的引導 =====================
// 只提醒、不自動跳轉：每一步有「前往」按鈕；綠色「知道了」關掉並留在首頁，之後不再出現。
// 按「前往」只是去那一頁看看，引導下次啟動還會出現（直到按「知道了」）
function openFirstRunGuide() {
  const s = state.settings || {}, keys = state.keys || {};
  const local = s.provider === 'openai' && /127\.0\.0\.1|localhost/.test(s.openai?.base_url || '');
  const apiDone = !!(keys[s.provider]?.set || local) && !!(s[s.provider]?.model || '').trim();
  const nameDone = !!s.user_name && s.user_name !== 'User'; // User＝預設設定檔的名字，還沒改過
  const runtimeTip = h('p', { class: 'muted small-note', hidden: true });
  const goTo = tab => () => { state.settingsTab = tab; closeModal(); go('#/settings'); };
  const step = (n, title, desc, done, btnText, tab) => h('div', { class: 'guide-step' + (done ? ' done' : '') },
    h('div', { class: 'guide-num' }, done ? icon('check') : String(n)),
    h('div', { class: 'grow' },
      h('div', { class: 'guide-title' }, title, done ? h('span', { class: 'guide-ok' }, '已完成') : null),
      h('p', { class: 'muted small-note' }, desc)),
    h('button', { type: 'button', class: 'small', onclick: goTo(tab) }, btnText));
  const body = h('div', { class: 'first-run' },
    h('p', {}, '歡迎來到 AI 酒館！開始和角色聊天之前，建議先完成下面兩件事。設定都在下方工具列的「設定」裡，之後隨時可以修改。'),
    step(1, '先設定 API（必要）', '到「設定 → API 設定」選擇供應商、填入 API 金鑰，再按「取得模型清單」選模型。本機模型（LM Studio、Ollama）不需要金鑰。',
      apiDone, '前往 API 設定', 'system'),
    step(2, '設定你的名字（建議）', '到「設定 → 使用者」把預設的名字「User」改成你的名字（角色會這樣稱呼你，也就是提示詞裡的 {{user}}），也可以設定頭像與人設。',
      nameDone, '前往使用者設定', 'user'),
    keyWarning(),
    h('p', { class: 'muted small-note' }, '準備好之後，在首頁按「匯入」載入角色卡（PNG／JSON，也可以直接拖進視窗），或按「創建角色」自己建立。'),
    runtimeTip);
  // 已經安裝 Node.js、資料夾裡還留著內附的 Node.js：提醒可以刪掉省空間
  api('GET', '/api/runtime').then(st => {
    if (!st.bundled || st.using_bundled) return;
    runtimeTip.hidden = false;
    runtimeTip.append(h('b', {}, '小提醒：'), `這台電腦已經安裝 Node.js ${st.installed_version}，資料夾裡內附的 Node.js（約 ${Math.round(st.size / 1048576)} MB）用不到了，可以到「設定 → 資料 → 內附的 Node.js」刪除。`);
  }).catch(() => {});
  openModal('第一次使用 AI 酒館', body, [
    h('button', { class: 'success', onclick: async () => {
      closeModal();
      try { const r = await api('PUT', '/api/settings', { first_run_done: true }); state.settings = { ...state.settings, ...r.settings }; } catch (e) { fail(e); }
    } }, '知道了')]);
}

// ===================== 記住視窗位置與大小 =====================
// 只在 launch.js 開的應用程式視窗（網址帶 ?app=1）裡回報；每 2 秒看一次，有變動才送出
// 最大化時只記「最大化」，保留最大化之前的位置與大小，取消最大化時才回得去
if (new URLSearchParams(location.search).has('app')) {
  let last = '', normal = null;
  const report = () => {
    const max = outerWidth >= screen.availWidth && outerHeight >= screen.availHeight;
    if (!max) normal = { x: screenX, y: screenY, w: outerWidth, h: outerHeight };
    // 一開就是最大化時還不知道原本的大小：只送「最大化」，伺服器保留上次記下的位置與大小
    const win = normal ? { ...normal, max } : { max };
    const key = JSON.stringify(win);
    if (key === last) return;
    last = key;
    fetch('/api/window', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: key, keepalive: true }).catch(() => { last = ''; });
  };
  setInterval(report, 2000);
  // 「視窗還開著」的訊號（見 launch.js：視窗交給既有的瀏覽器程序時，靠它判斷何時結束伺服器）
  const beat = () => fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
  beat(); setInterval(beat, 10000);
  window.addEventListener('resize', () => { clearTimeout(report.t); report.t = setTimeout(report, 400); });
  window.addEventListener('pagehide', report);
}
