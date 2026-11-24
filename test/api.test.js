// API 端對端測試：由 test/run.js 啟動假的 AI 服務與伺服器後執行（npm test）
const fs = require('fs');
const path = require('path');
const B = process.env.TEST_BASE; // 測試用的酒館伺服器
const MOCK = process.env.MOCK_URL; // 假的 OpenAI 相容 API
const LOGDIR = process.env.MOCK_LOG_DIR; // 假 API 記錄收到的請求
const CARD = path.join(__dirname, 'fixtures', 'sample-card.json');
const PROJ = path.join(__dirname, '..');
const TD = process.env.TAVERN_DATA_DIR;
let pass = 0, failN = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra ?? ''); } };

async function j(method, url, body, headers) {
  const r = await fetch(B + url, { method, headers: { ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
}
async function gen(body, abortAfter) {
  const ac = new AbortController();
  const r = await fetch(B + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
  const events = []; let buf = '', stopped = false;
  try {
    for await (const c of r.body) {
      buf += Buffer.from(c).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        // 停止：呼叫伺服器的停止 API（斷線不再中斷生成）
        if (abortAfter && !stopped && events.filter(e => e.type === 'text').length >= abortAfter) {
          stopped = true;
          await fetch(B + '/api/generate/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ char_id: body.char_id, chat_id: body.chat_id }) });
        }
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  return events;
}
const lastReq = () => JSON.parse(fs.readFileSync(path.join(LOGDIR, 'last-request.json'), 'utf8'));

/** 用 http 模組送請求（fetch 不能自訂 Host 標頭） */
function rawReq(method, url, headers = {}, body) {
  const u = new URL(B + url);
  return new Promise((resolve, reject) => {
    const rq = require('http').request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, res => {
      let t = ''; res.on('data', c => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    rq.on('error', reject);
    rq.end(body);
  });
}

(async () => {
  // ===== 請求來源檢查（S1） =====
  const hostHdr = new URL(B).host;
  let sq = await rawReq('GET', '/api/settings', { Host: 'evil.example:' + new URL(B).port });
  ok(sq.status === 403, 'DNS rebinding：Host 不是本機時拒絕', sq.status);
  sq = await rawReq('POST', '/api/characters', { Host: hostHdr, Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, '{"data":{"name":"x"}}');
  ok(sq.status === 403, '其他網站送來的請求被拒絕', sq.status);
  sq = await rawReq('POST', '/api/characters', { Host: hostHdr, Origin: 'null' }, '{}');
  ok(sq.status === 403, 'Origin: null 也被拒絕', sq.status);
  sq = await rawReq('GET', '/api/settings', { Host: hostHdr, 'Sec-Fetch-Site': 'cross-site' });
  ok(sq.status === 403, 'Sec-Fetch-Site: cross-site 被拒絕', sq.status);
  sq = await rawReq('GET', '/api/settings', { Host: hostHdr, Origin: 'http://' + hostHdr });
  ok(sq.status === 200, '酒館自己的頁面照常使用', sq.status);
  sq = await rawReq('GET', '/', { Host: 'localhost:' + new URL(B).port });
  ok(sq.status === 200, '用 localhost 開啟也可以', sq.status);

  // 第一次啟動的引導：全新安裝時還沒看過
  let r = await j('GET', '/api/settings');
  ok(r.data.settings.first_run_done === false, '全新安裝：第一次啟動的引導還沒看過');
  r = await j('PUT', '/api/settings', { first_run_done: true });
  ok(r.data.settings.first_run_done === true, '按「知道了」後記下來，之後不再出現');

  // 啟動時沒有使用者設定檔：自動建立並套用預設的 User
  r = await j('GET', '/api/personas');
  ok(r.data.personas.length === 1 && r.data.personas[0].id === r.data.active && r.data.personas[0].name === 'User' && r.data.personas[0].user_name === 'User'
    && (await j('GET', '/api/settings')).data.settings.user_name === 'User', '啟動時自動建立並套用預設的 User 使用者設定檔', JSON.stringify(r.data));

  // 設定
  r = await j('PUT', '/api/settings', { provider: 'openai', openai: { base_url: MOCK + '/v1', model: 'mock-a' }, user_name: '旅人', memory_auto: false });
  ok(r.status === 200 && r.data.settings.openai.model === 'mock-a', '儲存設定');
  r = await j('GET', '/api/settings');
  ok(!JSON.stringify(r.data).includes('api_key'), '設定 API 不回傳金鑰');
  r = await j('GET', '/api/models');
  ok(r.data.models && r.data.models[0] === 'mock-a', '取得模型清單', JSON.stringify(r.data));
  // 用畫面上還沒儲存的位址與金鑰取清單：不寫入任何設定（以前會先儲存，新增設定檔時把預設值寫進使用中的設定檔）
  {
    const before = JSON.stringify((await j('GET', '/api/settings')).data.settings);
    r = await j('POST', '/api/models', { provider: 'openai', base_url: MOCK + '/v1', api_key: 'sk-not-saved' });
    const after = JSON.stringify((await j('GET', '/api/settings')).data.settings);
    ok(r.status === 200 && r.data.models[0] === 'mock-a' && before === after, '取得模型清單（畫面上的位址與金鑰）：不會改動任何設定', `${r.status}`);
    r = await j('POST', '/api/models', { provider: 'openai', base_url: 'http://127.0.0.1:1/v1' });
    ok(r.status >= 400 && JSON.stringify((await j('GET', '/api/settings')).data.settings) === before, '取清單失敗時也不會改動設定');
  }

  // 匯入 JSON 角色卡
  r = await j('POST', '/api/characters/import', fs.readFileSync(CARD), { 'X-Filename': 'adina.json' });
  ok(r.status === 200 && r.data.name === '艾迪娜', '匯入 JSON 角色卡', JSON.stringify(r.data));
  const id = r.data.id;
  const ch = (await j('GET', `/api/characters/${id}`)).data;
  ok(ch.data.first_mes.startsWith('在艾迪娜經營的小咖啡館裡'), '從 chat_history 取得開場白');
  ok(ch.data.system_prompt.includes('[保持角色]') && ch.data.tags.includes('占星'), '保留系統提示與標籤');
  ok(ch.data.character_book === null, '空的內嵌世界書轉為 null');

  // 新對話
  r = await j('POST', `/api/characters/${id}/chats`, {});
  const chatId = r.data.id;
  ok(r.data.messages.length === 1 && r.data.messages[0].role === 'assistant', '新對話含開場白');

  // 世界書
  r = await j('POST', '/api/worlds', { name: '測試世界', entries: [] });
  const wid = r.data.id;
  r = await j('PUT', `/api/worlds/${wid}`, { name: '測試世界', scan_depth: 4, token_budget: 2048, entries: [
    { comment: '石榴', keys: ['石榴'], content: 'WI_POMEGRANATE {{char}}', enabled: true, position: 'at_depth', depth: 0, insertion_order: 100 },
    { comment: '常駐', keys: [], content: 'WI_CONST', enabled: true, constant: true, position: 'before_char', insertion_order: 10 },
    { comment: '不會觸發', keys: ['/汽車$/'], content: 'WI_NEVER', enabled: true, position: 'after_char' },
    { comment: '選擇性', keys: ['汽水'], secondary_keys: ['不存在的字'], selective: true, content: 'WI_SELECTIVE', enabled: true, position: 'after_char' },
  ] });
  ok(r.status === 200 && r.data.entries.length === 4, '儲存世界書');
  r = await j('PUT', `/api/characters/${id}`, { world_id: wid });
  ok(r.data.world_id === wid, '角色連結世界書');

  // 生成
  let ev = await gen({ char_id: id, chat_id: chatId, mode: 'normal', user_message: '我想喝石榴汽水' });
  const text = ev.filter(e => e.type === 'text').map(e => e.text).join('');
  const done = ev.find(e => e.type === 'done');
  ok(text === '啊啦……晚上好呀～「要喝點石榴汽水嗎？」 呵呵～', '串流文字完整', text);
  ok(done && done.chat.messages.length === 3, '生成後存檔（3 則）', JSON.stringify(ev.find(e => e.type === 'error')));
  const req = lastReq();
  const all = req.messages.map(m => m.content).join('\n');
  ok(req.stream === true && req.model === 'mock-a' && req.temperature === 0.7, '請求參數（新安裝的預設 Temperature 0.7）');
  ok(!('repetition_penalty' in req), '重複懲罰預設 1：不送出');
  ok(all.includes('WI_POMEGRANATE 艾迪娜') && all.includes('WI_CONST'), '世界書：關鍵字與常駐觸發');
  ok(!all.includes('WI_NEVER') && !all.includes('WI_SELECTIVE'), '世界書：不該觸發的沒有觸發');
  ok(req.messages[0].role === 'system' && req.messages[0].content.includes('[保持角色]') && req.messages[0].content.includes('艾迪娜·薩維奇'), '系統提示含角色卡內容');
  ok(!all.includes('{{user}}') && !all.includes('{{char}}'), '巨集已替換');
  ok(req.messages.filter(m => m.role === 'system').length === 1, '只有開頭一則 system（本機模型相容）');
  const lastM = req.messages.at(-1);
  ok(lastM.role === 'user' && lastM.content.startsWith('我想喝石榴汽水') && lastM.content.indexOf('WI_POMEGRANATE') > 0, '深度 0 注入併在最後的使用者訊息後', lastM.content);
  ok(req.messages.every((m, i) => i < 2 || m.role !== req.messages[i - 1].role), 'user/assistant 交替');

  // 重新生成（順便測重複懲罰）
  await j('PUT', '/api/settings', { repetition_penalty: 1.05 });
  ev = await gen({ char_id: id, chat_id: chatId, mode: 'regenerate' });
  ok(lastReq().repetition_penalty === 1.05, '重複懲罰：設定後送出', JSON.stringify(lastReq().repetition_penalty));
  await j('PUT', '/api/settings', { repetition_penalty: 1 });
  let c = (await j('GET', `/api/characters/${id}/chats/${chatId}`)).data;
  ok(c.messages.length === 3 && c.messages[2].swipes.length === 2 && c.messages[2].swipe_id === 1, '重新生成新增版本');
  ok(!lastReq().messages.some(m => m.role === 'assistant' && m.content === ''), '重新生成不送空白訊息');

  // 繼續
  ev = await gen({ char_id: id, chat_id: chatId, mode: 'continue' });
  c = (await j('GET', `/api/characters/${id}/chats/${chatId}`)).data;
  ok(c.messages.length === 3 && c.messages[2].content.length > 40, '繼續生成接在後面');

  // 中斷
  ev = await gen({ char_id: id, chat_id: chatId, mode: 'normal', user_message: '再一杯' }, 2);
  await new Promise(r => setTimeout(r, 500));
  c = (await j('GET', `/api/characters/${id}/chats/${chatId}`)).data;
  ok(c.messages.length === 5 && c.messages[4].content.startsWith('啊啦……晚上好呀～') && c.messages[4].content.length < 25, '停止時保存部分內容', JSON.stringify(c.messages.at(-1)));

  // 後置指令（中途的 system）不會讓本機模型報錯
  await j('PUT', `/api/characters/${id}`, { data: { ...ch.data, post_history_instructions: '用第三人稱描寫' } });
  ev = await gen({ char_id: id, chat_id: chatId, mode: 'normal', user_message: '後置指令測試' });
  ok(!ev.some(e => e.type === 'error') && lastReq().messages.at(-1).content.includes('[系統備註：用第三人稱描寫]'), '後置指令：本機模型不報錯', JSON.stringify(ev.find(e => e.type === 'error')));

  // 背景生成：離開頁面（斷線）不中斷，可重新接上
  await j('PUT', '/api/settings', { openai: { model: 'slow' } });
  const ac2 = new AbortController();
  const r2 = await fetch(B + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ char_id: id, chat_id: chatId, mode: 'normal', user_message: '背景測試' }), signal: ac2.signal });
  const rd = r2.body.getReader(); await rd.read(); ac2.abort(); // 收到第一段就離開
  await new Promise(r => setTimeout(r, 1000));
  let list = (await j('GET', '/api/chats')).data;
  ok(list.find(x => x.id === chatId).generating === true, '離開後仍在生成（清單標示生成中）');
  r = await j('POST', '/api/generate', { char_id: id, chat_id: chatId, mode: 'normal', user_message: 'x' });
  ok(r.status === 409, '同一段對話不能同時生成兩次');
  const r3 = await fetch(`${B}/api/generate/${id}/${chatId}`);
  let buf3 = ''; for await (const chunk of r3.body) buf3 += Buffer.from(chunk).toString('utf8');
  const ev3 = buf3.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  ok(ev3[0].type === 'start' && ev3[0].text.length > 0 && ev3.at(-1).type === 'done', '重新接上：補上已產生內容並收到完成', buf3.slice(0, 200));
  c = (await j('GET', `/api/characters/${id}/chats/${chatId}`)).data;
  ok(c.messages.at(-1).content === '啊啦……晚上好呀～「要喝點石榴汽水嗎？」 呵呵～' && c.messages.at(-2).content === '背景測試', '背景生成完整存檔');
  list = (await j('GET', '/api/chats')).data;
  ok(list.find(x => x.id === chatId).generating === false, '完成後清單不再標示生成中');
  // 生成中改對話設定：完成存檔時不會被蓋掉；生成中改訊息：拒絕
  const r4 = await fetch(B + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ char_id: id, chat_id: chatId, mode: 'normal', user_message: '生成中改設定' }) });
  const rd4 = r4.body.getReader(); await rd4.read();
  r = await j('PUT', `/api/characters/${id}/chats/${chatId}`, { history_cap: 12345, user_name: 'MID_GEN_NAME' });
  ok(r.status === 200, '生成中可以改對話設定', r.status);
  const curMsgs = (await j('GET', `/api/characters/${id}/chats/${chatId}`)).data.messages;
  r = await j('PUT', `/api/characters/${id}/chats/${chatId}`, { messages: curMsgs });
  ok(r.status === 409, '生成中不能改訊息（避免被生成結果蓋掉）', r.status);
  while (!(await rd4.read()).done) { /* 等生成完成 */ }
  await new Promise(r => setTimeout(r, 300));
  c = (await j('GET', `/api/characters/${id}/chats/${chatId}`)).data;
  ok(c.history_cap === 12345 && c.user_name === 'MID_GEN_NAME' && c.messages.at(-2).content === '生成中改設定', '生成中改的對話設定在完成後保留', JSON.stringify({ h: c.history_cap, u: c.user_name }));
  await j('PUT', `/api/characters/${id}/chats/${chatId}`, { history_cap: null, user_name: '' });
  await j('PUT', '/api/settings', { openai: { model: 'mock-a' } });

  // ===== 記憶 =====
  r = await j('PUT', `/api/characters/${id}/chats/${chatId}`, { memory: 'MEM_MANUAL 手寫的記憶' });
  ok(r.data.memory === 'MEM_MANUAL 手寫的記憶' && r.data.memory_updated > 0, '手動編輯記憶');
  r = await j('POST', '/api/prompt-preview', { char_id: id, chat_id: chatId });
  ok(r.data.messages[0].content.includes('[長期記憶') && r.data.messages[0].content.includes('MEM_MANUAL') && r.data.info.memory_tokens > 0, '記憶放進提示詞');
  ev = await gen({ char_id: id, chat_id: chatId, mode: 'normal', user_message: '記憶測試' });
  ok(lastReq().messages[0].content.includes('MEM_MANUAL'), '生成時送出記憶');
  {
    const lm = lastReq().messages;
    ok(lm.at(-1).content.includes('【語言】正文與思考過程都使用台灣用語的繁體中文') && lm.at(-1).content.trim().endsWith('保留原文。]') && !lm[0].content.includes('【語言】'),
      '語言提醒放在送出內容的最後面（不在系統提示開頭）', lm.at(-1).content.slice(-120));
    ok((await j('PUT', '/api/settings', { reply_language: 'xx' })).status === 400, '對話語言：未知的選項被拒絕');
    await j('PUT', '/api/settings', { reply_language: 'en' });
    const pv = (await j('POST', '/api/prompt-preview', { char_id: id, chat_id: chatId })).data.messages;
    ok(pv.at(-1).content.includes('[Language] Write both your reply and your thinking in English') && !JSON.stringify(pv).includes('【語言】'), '對話語言改成 English：提醒換成英文版', pv.at(-1).content.slice(-80));
    await j('PUT', '/api/settings', { reply_language: 'zh-TW' });
  }
  c = (await j('GET', `/api/characters/${id}/chats/${chatId}`)).data;
  ok(c.memory === 'MEM_MANUAL 手寫的記憶', '生成後記憶沒被覆蓋');
  r = await j('POST', `/api/characters/${id}/chats/${chatId}/memory`, {});
  let mreq = lastReq();
  ok(r.status === 200 && r.data.memory.includes('石榴汽水') && r.data.memory_upto === c.messages.length, 'AI 整理記憶', JSON.stringify(r.data).slice(0, 200));
  ok(mreq.messages[0].content.includes('記錄員') && mreq.messages[1].content.includes('MEM_MANUAL') && mreq.messages[1].content.includes('旅人：記憶測試'), '整理時帶入舊記憶與新訊息');
  ok(mreq.messages[1].content.trim().endsWith('只有人名、地名等專有名詞可以保留原文。'), '整理記憶：語言提醒放在最後');
  r = await j('POST', `/api/characters/${id}/chats/${chatId}/memory`, {});
  ok(r.data.memory_upto === c.messages.length, '沒有新訊息時不重複整理');
  r = await j('POST', `/api/characters/${id}/chats/${chatId}/memory`, { full: true });
  ok(!lastReq().messages[1].content.includes('MEM_MANUAL'), '全部重新整理不帶舊記憶');
  // 自動壓縮：聊天紀錄沒超過門檻時不會整理（詳細測試見「上下文壓縮」）
  await j('PUT', '/api/settings', { memory_auto: true });
  ev = await gen({ char_id: id, chat_id: chatId, mode: 'normal', user_message: '自動1' });
  ok(ev.find(e => e.type === 'done').memory_updating === false && !ev.some(e => e.type === 'compress'), '聊天紀錄還很短時不壓縮');
  await j('PUT', '/api/settings', { memory_auto: false, memory_enabled: false });
  r = await j('POST', '/api/prompt-preview', { char_id: id, chat_id: chatId });
  ok(!r.data.messages[0].content.includes('[長期記憶'), '關閉記憶後不放進提示詞');
  await j('PUT', '/api/settings', { memory_enabled: true });

  // ===== 新對話與清空不會消失；刪除才會 =====
  let n1 = (await j('POST', `/api/characters/${id}/chats`, {})).data;
  let n2 = (await j('POST', `/api/characters/${id}/chats`, {})).data;
  list = (await j('GET', '/api/chats')).data;
  ok(list.some(x => x.id === n1.id) && list.some(x => x.id === n2.id), '還沒說話的新對話也保留並列出');
  ok(n1.title === n2.title && n1.id !== n2.id, '新對話都用角色名稱（同名不加編號，各自是不同的對話）', `${n1.title} / ${n2.title}`);
  await j('PUT', `/api/characters/${id}/chats/${n1.id}`, { messages: n1.messages.slice(0, 1), memory_upto: 0 });
  list = (await j('GET', '/api/chats')).data;
  ok(list.some(x => x.id === n1.id), '清空後的對話仍然存在');
  await j('PUT', `/api/characters/${id}/chats/${n2.id}`, { memory: '要被刪除的記憶' });
  await j('DELETE', `/api/characters/${id}/chats/${n2.id}`);
  list = (await j('GET', '/api/chats')).data;
  r = await j('GET', `/api/characters/${id}/chats/${n2.id}`);
  ok(!list.some(x => x.id === n2.id) && r.status === 404, '刪除後對話與記憶都消失');
  await j('DELETE', `/api/characters/${id}/chats/${n1.id}`);

  // ===== 大世界 =====
  await j('PUT', '/api/settings', { memory_auto: false });
  const card2 = (await j('POST', '/api/characters', { data: { name: '蘿亞', description: 'ROA_DESC 蘿亞是 {{char}}', personality: 'ROA_PERS', scenario: 'ROA_SCENARIO', first_mes: 'ROA_GREETING', system_prompt: 'ROA_SYS 規則', mes_example: '<START>\n{{char}}: ROA_EXAMPLE' } })).data;
  r = await j('POST', '/api/bigworlds', { data: { name: '星之鎮', intro: '介紹', setting: 'WORLD_SETTING 浮空島嶼 {{world}}', system_prompt: 'WORLD_RULES {{world}}', first_mes: '歡迎 {{user}} 來到 {{world}}', turn_mode: 'narrator', members: [{ id }, { id: card2.id, sys_mode: 'none' }] } });
  ok(r.status === 200 && r.data.members.length === 2 && r.data.members[0].name === '艾迪娜', '建立世界（含兩位角色）', JSON.stringify(r.data).slice(0, 200));
  const wid2 = r.data.id, wkey = 'world-' + wid2;
  ok(fs.existsSync(path.join(TD, 'bigworld', `星之鎮-${wid2}`, 'world.json')), '世界存在自己的資料夾（名稱-ID）');
  const wfile = fs.readFileSync(path.join(TD, 'bigworld', `星之鎮-${wid2}`, 'world.json'), 'utf8');
  ok(!wfile.includes('ROA_DESC') && wfile.includes(card2.id), '世界卡只存角色 ID，不複製角色卡內容');
  r = await j('GET', '/api/bigworlds');
  ok(r.data.some(x => x.id === wid2 && x.members.length === 2), '世界清單');
  let wc = (await j('POST', `/api/characters/${wkey}/chats`, {})).data;
  ok(wc.title === '星之鎮' && wc.messages[0].content === '歡迎 旅人 來到 星之鎮', '世界對話：使用自己寫的開場白', JSON.stringify(wc.messages[0]));
  ev = await gen({ char_id: wkey, chat_id: wc.id, mode: 'normal', user_message: '大家好' });
  ok(ev.some(e => e.type === 'done') && !ev.some(e => e.type === 'error'), '世界對話：生成', JSON.stringify(ev.find(e => e.type === 'error')));
  let sys0 = lastReq().messages[0].content;
  ok(sys0.includes('星之鎮') && sys0.includes('WORLD_RULES 星之鎮') && sys0.includes('[角色：艾迪娜]') && sys0.includes('ROA_DESC 蘿亞是 蘿亞') && sys0.includes('ROA_PERS'), '世界提示詞：含世界規則與各角色設定');
  ok(sys0.includes('[世界「星之鎮」的世界設定]\nWORLD_SETTING 浮空島嶼 星之鎮') && sys0.indexOf('WORLD_SETTING') < sys0.indexOf('WORLD_RULES'), '世界設定（世界觀）送給 AI，放在規則前面');
  ok(!sys0.includes('ROA_SCENARIO') && !sys0.includes('ROA_GREETING'), '世界提示詞：不含角色的情境、開場白');
  ok(sys0.includes('蘿亞: ROA_EXAMPLE'), '世界提示詞：含角色的台詞範例（{{char}} 換成該角色）');
  ok(sys0.includes('[保持角色]') && !sys0.includes('ROA_SYS'), '角色卡系統提示：完整套用／不套用');
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'narrator', members: [{ id }, { id: card2.id, sys_mode: 'custom', sys_custom: 'ROA_CUSTOM_RULE' }] } });
  r = await j('POST', '/api/prompt-preview', { char_id: wkey, chat_id: wc.id });
  ok(r.data.messages[0].content.includes('ROA_CUSTOM_RULE') && !r.data.messages[0].content.includes('ROA_SYS'), '角色卡系統提示：自訂');
  list = (await j('GET', '/api/chats')).data;
  ok(list.some(x => x.id === wc.id && x.char.is_world && x.char.id === wkey), '所有對話清單包含世界對話');
  r = await j('POST', `/api/characters/${wkey}/chats/${wc.id}/memory`, {});
  ok(r.status === 200 && r.data.memory && r.data.memory_upto === r.data.messages.length, '世界對話也有記憶', JSON.stringify(r.data).slice(0, 150));
  const covRes = await fetch(`${B}/api/bigworlds/${wid2}/cover`);
  ok(covRes.status === 200 && covRes.headers.get('content-type').includes('svg'), '預設風景封面');
  // ===== 大世界：輪流發言 =====
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', first_mes: '開場', turn_mode: 'turns', max_replies: 3, narrator: 'round', allow_interrupt: false, members: [{ id }, { id: card2.id }] } });
  let tc = (await j('POST', `/api/characters/${wkey}/chats`, {})).data;
  ok(tc.messages[0].speaker === 'narrator' && tc.messages[0].greeting, '舊格式的開場白：由旁白發言');
  r = await j('GET', `/api/bigworlds/${wid2}`);
  ok(r.data.cut_interrupt === true, '輪流發言：插話截斷預設開啟', JSON.stringify({ c: r.data.cut_interrupt }));
  // 多人開場白：旁白、角色、玩家各自一則；已移出的角色略過
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', members: [{ id }, { id: card2.id }], opening: [
    { speaker: 'narrator', content: '夜晚的 {{world}}' }, { speaker: card2.id, content: '{{user}}，你來啦' }, { speaker: 'user', content: '嗯，我來了' },
    { speaker: 'gone-member', content: '不該出現' }, { speaker: id, content: '   ' }] } });
  let oc = (await j('POST', `/api/characters/${wkey}/chats`, {})).data;
  ok(oc.messages.length === 3 && oc.messages[0].speaker === 'narrator' && oc.messages[0].content === '夜晚的 星之鎮'
    && oc.messages[1].speaker === card2.id && oc.messages[1].content === '旅人，你來啦' && oc.messages[2].role === 'user' && oc.messages[2].content === '嗯，我來了'
    && oc.messages.every(m => m.greeting), '多人開場白：各自的發言者、巨集替換、略過已移出的角色與空白', JSON.stringify(oc.messages.map(m => [m.role, m.speaker, m.content])));
  ev = await gen({ char_id: wkey, chat_id: oc.id, mode: 'normal', user_message: '開場後第一句' });
  ok(ev.some(e => e.type === 'done') && !ev.some(e => e.type === 'error') && lastReq().messages.filter(m => m.role === 'system').length === 1, '開場白以玩家訊息結尾時也能正常生成', JSON.stringify(ev.find(e => e.type === 'error')));
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', first_mes: '開場', turn_mode: 'turns', max_replies: 3, allow_interrupt: false, members: [{ id }, { id: card2.id }] } });
  ev = await gen({ char_id: wkey, chat_id: tc.id, mode: 'normal', user_message: '大家晚安' });
  tc = (await j('GET', `/api/characters/${wkey}/chats/${tc.id}`)).data;
  const after = tc.messages.slice(2);
  ok(ev.filter(e => e.type === 'start' || e.type === 'msg_start').length === after.length && ev.some(e => e.type === 'done'), '一次生成多則訊息（每則各有開始事件）', `${after.length} 則`);
  ok(after.length >= 2 && after.every(m => [id, card2.id].includes(m.speaker)), '角色各自發言（輪流發言不安排旁白）', JSON.stringify(after.map(m => m.speaker)));
  ok(after.every((m, i, a) => i === 0 || m.speaker !== a[i - 1].speaker), '同一個角色不會連續發言');
  let lr = lastReq();
  ok(/現在輪到「(艾迪娜|蘿亞)」發言/.test(lr.messages.at(-1).content) && lr.messages.some(m => m.role === 'assistant' && /(艾迪娜|蘿亞)：/.test(m.content)), '聊天紀錄標上發言者，發言指令在最後');
  ev = await gen({ char_id: wkey, chat_id: tc.id, mode: 'normal', user_message: '', speaker: card2.id });
  tc = (await j('GET', `/api/characters/${wkey}/chats/${tc.id}`)).data;
  ok(tc.messages.at(-1).speaker === card2.id && lastReq().messages.at(-1).content.includes('現在輪到「蘿亞」發言'), '指定角色發言（只生成一則）');
  ev = await gen({ char_id: wkey, chat_id: tc.id, mode: 'normal', user_message: '', speaker: id, interrupt: true });
  ok(lastReq().messages.at(-1).content.includes('打斷了 蘿亞'), '插話：提示中說明打斷了誰');
  const nBefore = tc.messages.length + 1;
  ev = await gen({ char_id: wkey, chat_id: tc.id, mode: 'regenerate' });
  tc = (await j('GET', `/api/characters/${wkey}/chats/${tc.id}`)).data;
  ok(tc.messages.length === nBefore && tc.messages.at(-1).speaker === id && tc.messages.at(-1).swipes.length === 2, '重新生成：同一位角色、新增版本');
  let nMsg = tc.messages.length;
  ev = await gen({ char_id: wkey, chat_id: tc.id, mode: 'normal', user_message: '', speaker: 'narrator' });
  tc = (await j('GET', `/api/characters/${wkey}/chats/${tc.id}`)).data;
  ok(tc.messages.length === nMsg + 1 && tc.messages.at(-1).speaker === 'narrator' && lastReq().messages.at(-1).content.includes('以旁白描寫場景'), '輪流發言：玩家可以呼叫旁白');
  await j('PUT', '/api/settings', { openai: { model: 'leaky' } });
  ev = await gen({ char_id: wkey, chat_id: tc.id, mode: 'normal', user_message: '', speaker: card2.id });
  tc = (await j('GET', `/api/characters/${wkey}/chats/${tc.id}`)).data;
  ok(tc.messages.at(-1).content === '我先說', '去掉自己的名字，並截掉替別人寫的台詞', tc.messages.at(-1).content);
  await j('PUT', '/api/settings', { openai: { model: 'mention' } });
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', max_replies: 2, narrator: 'off', allow_interrupt: true, interrupt_rate: 100, cut_interrupt: true, members: [{ id }, { id: card2.id }] } });
  const cnt0 = tc.messages.length;
  ev = await gen({ char_id: wkey, chat_id: tc.id, mode: 'normal', user_message: '你們好' });
  tc = (await j('GET', `/api/characters/${wkey}/chats/${tc.id}`)).data;
  const two = tc.messages.slice(cnt0 + 1);
  ok(two.length === 2 && two[0].interrupted && two[0].content.endsWith('——') && ev.some(e => e.type === 'msg_update'), '插話截斷：上一位的話被切斷', JSON.stringify(two.map(m => m.content.slice(-6))));
  ok(lastReq().messages.at(-1).content.includes('說到一半時打斷了對方'), '截斷插話的提示');
  await j('PUT', '/api/settings', { openai: { model: 'mock-a' } });
  r = await j('POST', `/api/characters/${wkey}/chats/${tc.id}/memory`, { full: true });
  ok(lastReq().messages[1].content.includes('蘿亞：') && lastReq().messages[1].content.includes('旁白：'), '記憶整理時標上各自的名字');
  // ===== 導演規劃＋銜接 =====
  const logFile = path.join(LOGDIR, 'requests.log');
  const logLines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []);
  const reqsSince = n => logLines().slice(n).map(l => JSON.parse(l));
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', max_replies: 3, narrator: 'round', allow_interrupt: false, members: [{ id }, { id: card2.id }] } });
  let dc = (await j('POST', `/api/characters/${wkey}/chats`, {})).data;
  let n0 = logLines().length;
  ev = await gen({ char_id: wkey, chat_id: dc.id, mode: 'normal', user_message: '我推開門走進來' });
  let rs = reqsSince(n0);
  dc = (await j('GET', `/api/characters/${wkey}/chats/${dc.id}`)).data;
  const sps = dc.messages.slice(-2).map(m => m.speaker);
  ok(rs[0].messages.at(-1).content.includes('[導演指示') && ev.some(e => e.type === 'director' && e.plan), '每輪先由導演規劃');
  const allText = q => q.messages.map(m => m.content).join('\n');
  ok(allText(rs[0]).includes('艾迪娜·薩維奇') && allText(rs[0]).includes('ROA_DESC'), '導演知道所有角色');
  ok(rs[0].temperature === 0.75 && rs[1].temperature !== 0.75, '導演固定用 0.75 的溫度，角色照設定', `${rs[0].temperature} / ${rs[1].temperature}`);
  ok(rs.length === 3 && sps[0] === card2.id && sps[1] === id, '依導演安排的順序發言（導演寫了旁白也不安排）', JSON.stringify(sps));
  const roaReq = rs[1].messages.at(-1).content, adiReq = rs[2].messages.at(-1).content;
  ok(roaReq.includes('可以一起寫出配角的動作與台詞') && roaReq.includes('不要每次都用問句把話題丟回給'), '輪到角色發言：可以順手帶出配角，也不要一直用問句丟回給玩家');
  ok(rs[0].messages.at(-1).content.includes('有角色發言時不要安排旁白') && rs[0].messages.at(-1).content.includes('配角不用另外安排'), '導演：配角由發言的角色帶出，不另外安排旁白');
  ok(roaReq.includes('提醒大家小心') && !roaReq.includes('接著回應蘿亞'), '每個角色只看到自己的那一行');
  ok(roaReq.includes('【語言】') && !allText(rs[0]).includes('【語言】'), '大世界：角色有語言提醒，導演沒有');
  ok(roaReq.includes('我推開門走進來') && roaReq.includes('第一位回應') && roaReq.includes('不要重新描寫'), '第一位回應玩家的行動、不要重新描寫場景');
  ok(adiReq.includes('接著回應蘿亞') && adiReq.includes('接續上一則訊息') && !adiReq.includes('打斷'), '後面的角色接續前一位（未開啟插話時不插話）');
  ok(adiReq.includes('在你之前，蘿亞 已經接著發言') && adiReq.includes('以已經發生的事為準') && adiReq.includes('這一輪開始時 旅人 的行動') && !adiReq.includes('旅人 最新的行動')
    && !roaReq.includes('在你之前'), '後面的角色：知道前面誰已經行動、以已發生的事為準，玩家的行動標成這一輪開始時的', adiReq.slice(0, 200));
  // B：同一輪的每次呼叫開頭完全相同（本機模型可以重用快取）
  const lines = q => q.messages.map(m => m.role + '|' + m.content);
  const [dq, s1, s2] = [lines(rs[0]), lines(rs[1]), lines(rs[2])];
  ok(new Set(rs.map(q => q.messages[0].content)).size === 1, 'B：導演、各角色、旁白的系統訊息完全相同');
  ok(dq.length === s1.length && dq.slice(0, -1).every((x, i) => x === s1[i]) && dq.at(-1).startsWith('user|我推開門走進來') && s1.at(-1).startsWith('user|我推開門走進來'), 'B：導演與第一位角色共用整段聊天紀錄');
  ok(s2.slice(0, s1.length - 1).every((x, i) => x === s1[i]) && s2[s1.length - 1] === 'user|我推開門走進來', 'B：第二位角色沿用前一位的開頭，只多了新的訊息');
  ok(!rs[1].messages[0].content.includes('ROA_DESC') && rs[1].messages.at(-1).content.includes('ROA_DESC') && !rs[1].messages.at(-1).content.includes('艾迪娜·薩維奇'), 'B：完整角色卡只在最後一段，而且只有發言者自己的');
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', director: false, max_replies: 2, narrator: 'manual', members: [{ id }, { id: card2.id }] } });
  n0 = logLines().length;
  ev = await gen({ char_id: wkey, chat_id: dc.id, mode: 'normal', user_message: '再一次' });
  rs = reqsSince(n0);
  ok(rs[0].messages.at(-1).content.includes('[導演指示') && ev.some(e => e.type === 'director'), '輪流發言一律使用導演（舊設定 director: false 不再生效）');
  ok(!rs[0].messages.at(-1).content.includes('旁白寫的事已經發生了') && !rs[1].messages.at(-1).content.includes('你剛剛做的事'), '沒有你寫的旁白時，不加旁白的說明');
  // 你寫的旁白描寫角色的動作：導演讓那位角色先發言並延續，角色從那個動作接著演
  n0 = logLines().length;
  await gen({ char_id: wkey, chat_id: dc.id, mode: 'normal', user_message: '蘿亞拿起水晶球，開始占卜。', narration: true });
  rs = reqsSince(n0);
  ok(rs[0].messages.at(-1).content.includes('旁白寫的事已經發生了') && rs[0].messages.at(-1).content.includes('就讓那位角色先發言'), '旁白：導演知道旁白寫的事已經發生，由那位角色延續');
  ok(rs[1].messages.at(-1).content.includes('（旁白，由旅人撰寫）蘿亞拿起水晶球') && rs[1].messages.at(-1).content.includes('那就是你剛剛做的事') && rs[1].messages.at(-1).content.includes('回應 旅人 剛才的行動與旁白'),
    '旁白：發言的角色從旁白寫的動作接著演', rs[1].messages.at(-1).content.slice(0, 400));
  ok(rs[1].messages[0].content.includes('那就是角色剛剛做的事'), '旁白：系統提示也說明旁白寫的動作要延續');

  // ===== 在場角色：導演先判斷誰在場，不在場的不發言 =====
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', director: true, max_replies: 3, narrator: 'off', allow_interrupt: false, members: [{ id }, { id: card2.id }] } });
  let pc = (await j('POST', `/api/characters/${wkey}/chats`, {})).data;
  await j('PUT', '/api/settings', { openai: { model: 'presence' } });
  n0 = logLines().length;
  await gen({ char_id: wkey, chat_id: pc.id, mode: 'normal', user_message: '只有蘿亞在嗎' });
  rs = reqsSince(n0);
  pc = (await j('GET', `/api/characters/${wkey}/chats/${pc.id}`)).data;
  let newMsgs = pc.messages.slice(pc.messages.findIndex(m => m.content === '只有蘿亞在嗎') + 1);
  ok(rs[0].messages.at(-1).content.includes('在場：（此刻在場'), '導演先判斷在場角色');
  ok(newMsgs.length === 1 && newMsgs[0].speaker === card2.id, '不在場的角色不發言（旁白關閉時也不收尾）', JSON.stringify(newMsgs.map(m => m.speaker)));
  ok(JSON.stringify(pc.present) === JSON.stringify([card2.id]), '在場角色存進對話', JSON.stringify(pc.present));
  ok(rs[1].messages.at(-1).content.includes('目前在場：旅人、蘿亞'), '發言的角色知道誰在場');
  await j('PUT', '/api/settings', { openai: { model: 'enter' } });
  n0 = logLines().length;
  await gen({ char_id: wkey, chat_id: pc.id, mode: 'normal', user_message: '叫艾迪娜來' });
  rs = reqsSince(n0);
  pc = (await j('GET', `/api/characters/${wkey}/chats/${pc.id}`)).data;
  newMsgs = pc.messages.slice(pc.messages.findIndex(m => m.content === '叫艾迪娜來') + 1);
  ok(rs[0].messages.at(-1).content.includes('上一輪記錄的在場角色：蘿亞'), '導演參考上一輪的在場角色');
  ok(newMsgs.length === 2 && newMsgs[1].speaker === id && rs[2].messages.at(-1).content.includes('你這一輪才登場'), '標了（登場）的角色才出現', JSON.stringify(newMsgs.map(m => m.speaker)));
  ok(pc.present.length === 2 && pc.present.includes(id), '登場後列入在場');
  // 離場後重新生成：回到那則說話前的在場狀態；刪掉後面的訊息再生成：回到那時候的狀態
  await j('PUT', '/api/settings', { openai: { model: 'leave' } });
  await gen({ char_id: wkey, chat_id: pc.id, mode: 'normal', user_message: '艾迪娜要走了嗎' });
  pc = (await j('GET', `/api/characters/${wkey}/chats/${pc.id}`)).data;
  ok(pc.messages.at(-1).speaker === id && JSON.stringify(pc.present) === JSON.stringify([card2.id]) && pc.messages.at(-1).present_before.includes(id), '離場：說完之後移出在場', JSON.stringify(pc.present));
  await j('PUT', '/api/settings', { openai: { model: 'mock-a' } });
  await gen({ char_id: wkey, chat_id: pc.id, mode: 'regenerate' });
  pc = (await j('GET', `/api/characters/${wkey}/chats/${pc.id}`)).data;
  ok(pc.present.length === 2 && pc.present.includes(id) && pc.messages.at(-1).swipes.length === 2 && pc.messages.at(-1).present_after.includes(id), '重新生成離場的那則：恢復成在場', JSON.stringify(pc.present));
  {
    const cut = pc.messages.findIndex(m => m.content === '艾迪娜要走了嗎');
    const before = pc.messages.slice(0, cut + 1);
    await j('PUT', `/api/characters/${wkey}/chats/${pc.id}`, { messages: before, base_ver: pc.msg_ver, present: [] }); // 刪掉這一輪（在場故意改成空的）
    await j('PUT', '/api/settings', { openai: { model: 'presence' } });
    const n1 = logLines().length;
    await gen({ char_id: wkey, chat_id: pc.id, mode: 'normal' });
    const dr = reqsSince(n1)[0].messages.at(-1).content;
    ok(dr.includes('上一輪記錄的在場角色：蘿亞、艾迪娜') || dr.includes('上一輪記錄的在場角色：艾迪娜、蘿亞'), '刪掉後面的訊息再生成：在場回到最後一則角色訊息當時的狀態', dr.slice(dr.indexOf('上一輪'), dr.indexOf('上一輪') + 30));
    pc = (await j('GET', `/api/characters/${wkey}/chats/${pc.id}`)).data;
  }
  await j('PUT', '/api/settings', { openai: { model: 'nobody' } });
  n0 = logLines().length;
  await gen({ char_id: wkey, chat_id: pc.id, mode: 'normal', user_message: '大家都走了' });
  rs = reqsSince(n0);
  pc = (await j('GET', `/api/characters/${wkey}/chats/${pc.id}`)).data;
  ok(pc.messages.at(-1).speaker === 'narrator' && rs.length === 2 && rs[1].messages.at(-1).content.includes('沒有角色在場') && pc.present.length === 0, '沒有人在場時由旁白描寫');
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', max_replies: 2, members: [{ id }, { id: card2.id }] } });
  await j('PUT', '/api/settings', { openai: { model: 'noplan' } });
  await gen({ char_id: wkey, chat_id: pc.id, mode: 'normal', user_message: '還是沒人' });
  pc = (await j('GET', `/api/characters/${wkey}/chats/${pc.id}`)).data;
  ok(pc.messages.at(-1).speaker === 'narrator' && pc.messages.at(-2).content === '還是沒人', '導演規劃失敗、改用規則時也只從在場角色挑（沒人就旁白）');
  await j('PUT', '/api/settings', { openai: { model: 'mock-a' } });
  await gen({ char_id: wkey, chat_id: pc.id, mode: 'normal', speaker: card2.id });
  pc = (await j('GET', `/api/characters/${wkey}/chats/${pc.id}`)).data;
  ok(pc.present.includes(card2.id) && lastReq().messages.at(-1).content.includes('你原本不在現場'), '指定不在場的角色發言＝讓他登場');
  r = await j('PUT', `/api/characters/${wkey}/chats/${pc.id}`, { present: null });
  ok(r.data.present === null, '清空聊天時重設在場角色');

  // 導演規劃中途重新接上（切換對話後再回來）：start 事件標示導演階段，沒有 info 也不會出錯
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', director: true, max_replies: 1, narrator: 'manual', members: [{ id }, { id: card2.id }] } });
  await j('PUT', '/api/settings', { openai: { model: 'slow' } });
  const acD = new AbortController();
  const rD = await fetch(B + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ char_id: wkey, chat_id: dc.id, mode: 'normal', user_message: '導演中途測試' }), signal: acD.signal });
  const rdD = rD.body.getReader(); await rdD.read(); acD.abort(); // 收到導演開始規劃就離開
  const midChat = (await j('GET', `/api/characters/${wkey}/chats/${dc.id}`)).data;
  ok(midChat.messages.at(-1).content === '導演中途測試', '導演規劃期間，剛送出的訊息已經存檔（切回來看得到）');
  const rAttach = await fetch(`${B}/api/generate/${wkey}/${dc.id}`);
  let bufA = ''; for await (const chunk of rAttach.body) bufA += Buffer.from(chunk).toString('utf8');
  const evA = bufA.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  ok(evA[0].type === 'start' && evA[0].phase === 'director' && evA[0].info === null && evA.some(e => e.type === 'director' && e.plan) && evA.at(-1).type === 'done',
    '導演規劃中重新接上：標示導演階段，之後照常收到分鏡與完成', JSON.stringify(evA[0]).slice(0, 150));
  await j('PUT', '/api/settings', { openai: { model: 'mock-a' } });

  // ===== 角色知識的界線（輪流發言） =====
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', narrator: 'manual', members: [{ id, public_info: 'ADINA_PUBLIC 咖啡館店長' }, { id: card2.id }] } });
  let kc = (await j('POST', `/api/characters/${wkey}/chats`, {})).data;
  await gen({ char_id: wkey, chat_id: kc.id, mode: 'normal', user_message: '石榴汽水好喝嗎', speaker: id });
  let reqA = lastReq();
  ok(allText(reqA).includes('艾迪娜·薩維奇') && allText(reqA).includes('WI_POMEGRANATE'), '艾迪娜發言：有自己的完整角色卡與自己的世界書');
  ok(!allText(reqA).includes('ROA_DESC') && !allText(reqA).includes('ROA_EXAMPLE'), '艾迪娜發言：看不到蘿亞角色卡的內容');
  kc = (await j('GET', `/api/characters/${wkey}/chats/${kc.id}`)).data;
  kc.messages.at(-1).content += '\n<details><summary>【狀態】</summary><p>內心活動：ADINA_SECRET</p></details>';
  await j('PUT', `/api/characters/${wkey}/chats/${kc.id}`, { messages: kc.messages });
  await gen({ char_id: wkey, chat_id: kc.id, mode: 'normal', user_message: '', speaker: card2.id });
  let reqR = lastReq(), allR = reqR.messages.map(m => m.content).join('\n');
  ok(allR.includes('ROA_DESC') && allR.includes('ADINA_PUBLIC') && !allR.includes('艾迪娜·薩維奇'), '蘿亞發言：只看到艾迪娜的公開資訊');
  ok(!allR.includes('ADINA_SECRET') && !allR.includes('WI_POMEGRANATE'), '蘿亞發言：看不到艾迪娜的狀態欄與艾迪娜的世界書');
  ok(reqR.messages[0].content.includes('[角色知識的界線]'), '提示中有角色知識的界線');
  await gen({ char_id: wkey, chat_id: kc.id, mode: 'normal', user_message: '', speaker: 'narrator' });
  let reqN = allText(lastReq());
  ok(reqN.includes('艾迪娜·薩維奇') && reqN.includes('ROA_DESC') && reqN.includes('ADINA_SECRET'), '旁白：知道所有角色，也看得到大家最近的狀態欄');

  // ===== 世界卡的世界書 =====
  const wbEntry = { comment: '世界專屬', keys: ['石榴'], content: 'WORLD_ONLY_BOOK', enabled: true, position: 'before_char', insertion_order: 5 };
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', members: [{ id, book_linked: false }, { id: card2.id }], character_book: { name: '星之鎮', entries: [wbEntry] } } });
  r = await j('GET', `/api/bigworlds/${wid2}`);
  ok(r.data.members[0].book_linked === false && r.data.members[1].book_linked === true && r.data.character_book.entries.length === 1, '儲存成員世界書開關與世界專屬世界書');
  await gen({ char_id: wkey, chat_id: kc.id, mode: 'normal', user_message: '石榴', speaker: id });
  let allW = lastReq().messages.map(m => m.content).join('\n');
  ok(!allW.includes('WI_POMEGRANATE') && allW.includes('WORLD_ONLY_BOOK'), '關掉角色卡的連結世界書；世界專屬的世界書生效');
  await gen({ char_id: wkey, chat_id: kc.id, mode: 'normal', user_message: '石榴', speaker: card2.id });
  ok(lastReq().messages.map(m => m.content).join('\n').includes('WORLD_ONLY_BOOK'), '世界專屬的世界書對每個角色都生效');
  // 個別關掉角色卡世界書的某個條目
  const w0 = (await j('GET', `/api/worlds/${wid}`)).data;
  const pom = w0.entries.find(e => e.comment === '石榴');
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', members: [{ id, book_off: ['lnk:' + pom.id] }, { id: card2.id }] } });
  await gen({ char_id: wkey, chat_id: kc.id, mode: 'normal', user_message: '石榴', speaker: id });
  allW = lastReq().messages.map(m => m.content).join('\n');
  ok(!allW.includes('WI_POMEGRANATE') && allW.includes('WI_CONST'), '角色卡世界書：可以個別關掉某個條目，其他條目照常');
  ok((await j('GET', `/api/bigworlds/${wid2}`)).data.members[0].book_off[0] === 'lnk:' + pom.id, '儲存個別關掉的條目');
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', members: [{ id: card2.id }], world_ids: [wid] } });
  await gen({ char_id: wkey, chat_id: kc.id, mode: 'normal', user_message: '石榴', speaker: card2.id });
  ok(lastReq().messages.map(m => m.content).join('\n').includes('WI_POMEGRANATE'), '世界專屬：連結全域世界書');

  // 每段對話各自的發言模式：建立時決定，之後不變
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', turn_mode: 'turns', members: [{ id }, { id: card2.id }] } });
  let nc = (await j('POST', `/api/characters/${wkey}/chats`, { turn_mode: 'narrator' })).data;
  ok(nc.turn_mode === 'narrator', '開始對話時選擇旁白統一');
  ev = await gen({ char_id: wkey, chat_id: nc.id, mode: 'normal', user_message: '嗨' });
  nc = (await j('GET', `/api/characters/${wkey}/chats/${nc.id}`)).data;
  ok(nc.messages.at(-2).content === '嗨' && nc.messages.at(-1).role === 'assistant' && !nc.messages.at(-1).speaker && ev.filter(e => e.type === 'msg_start').length === 0, '旁白統一的對話：一次一則，不分角色（世界預設是輪流發言）');
  await j('PUT', `/api/characters/${wkey}/chats/${nc.id}`, { turn_mode: 'turns' });
  ok((await j('GET', `/api/characters/${wkey}/chats/${nc.id}`)).data.turn_mode === 'narrator', '開始後不能更改發言模式');
  nc = (await j('POST', `/api/characters/${wkey}/chats`, {})).data;
  ok(nc.turn_mode === 'turns', '沒有選擇時使用世界的預設');
  await j('PUT', `/api/bigworlds/${wid2}`, { data: { name: '星之鎮', members: [{ id }, { id: card2.id }] } });

  await j('DELETE', `/api/characters/${card2.id}`);
  r = await j('GET', `/api/bigworlds/${wid2}`);
  ev = await gen({ char_id: wkey, chat_id: wc.id, mode: 'normal', user_message: '角色被刪了' });
  ok(!ev.some(e => e.type === 'error') && !lastReq().messages[0].content.includes('蘿亞'), '成員角色被刪除後世界仍可對話');
  await j('DELETE', `/api/bigworlds/${wid2}`);
  ok((await j('GET', `/api/characters/${wkey}/chats/${wc.id}`)).status === 404 && (await j('GET', `/api/bigworlds/${wid2}`)).status === 404, '刪除世界連同對話');

  // 提示詞預覽
  r = await j('POST', '/api/prompt-preview', { char_id: id, chat_id: chatId });
  ok(r.data.messages && r.data.info.world_entries.length === 2, '提示詞預覽', JSON.stringify(r.data.info));

  // 匯出 PNG → 再匯入
  let res = await fetch(`${B}/api/characters/${id}/export?format=png`);
  const pngBuf = Buffer.from(await res.arrayBuffer());
  ok(res.status === 200 && pngBuf.subarray(1, 4).toString() === 'PNG', '匯出 PNG');
  const expName = decodeURIComponent((res.headers.get('content-disposition').match(/filename\*=UTF-8''(.+)$/) || [])[1] || '');
  ok(/^艾迪娜-\d{8}-\d{4}\.png$/.test(expName), '匯出的檔名：角色名-年月日-時分（24 小時制）', expName);
  const { readTextChunks, extractCard } = require(path.join(PROJ, 'lib/png.js'));
  const t = readTextChunks(pngBuf);
  ok(t.chara && t.ccv3, 'PNG 含 chara 與 ccv3');
  ok(extractCard(pngBuf).data.name === '艾迪娜', 'PNG 內資料正確');
  r = await j('POST', '/api/characters/import', pngBuf);
  ok(r.data.name === '艾迪娜', '重新匯入 PNG');
  const id2 = r.data.id;
  r = await j('GET', `/api/characters/${id2}`);
  ok(r.data.has_cover && !r.data.has_avatar, '匯入 PNG 後作為封面');
  res = await fetch(`${B}/api/characters/${id2}/avatar`);
  ok(res.status === 200 && res.headers.get('content-type') === 'image/png', '頭像可讀取');

  // 匯出 JSON
  res = await fetch(`${B}/api/characters/${id}/export?format=json`);
  const jc = await res.json();
  ok(jc.spec === 'chara_card_v3' && jc.data.name === '艾迪娜', '匯出 JSON (V3)');
  ok(/^艾迪娜-\d{8}-\d{4}\.json$/.test(decodeURIComponent((res.headers.get('content-disposition').match(/filename\*=UTF-8''(.+)$/) || [])[1] || '')), '匯出 JSON 的檔名也加上日期時間');

  // 建立角色（含頭像與內嵌世界書）
  r = await j('POST', '/api/characters', { data: { name: '測試角色', description: 'desc', first_mes: '嗨 {{user}}', alternate_greetings: ['備用 {{char}}'], character_book: { entries: [{ keys: ['貓'], content: 'EMBED_CAT', position: 'after_char' }] } }, avatar: 'data:image/png;base64,' + pngBuf.toString('base64') });
  const id3 = r.data.id;
  ok(r.status === 200 && id3, '建立新角色', JSON.stringify(r.data));
  r = await j('POST', `/api/characters/${id3}/chats`, { greeting: 1 });
  ok(r.data.messages[0].content === '備用 測試角色' && r.data.messages[0].swipes.length === 2, '選擇備用開場白');
  const chat3 = r.data.id;
  await gen({ char_id: id3, chat_id: chat3, mode: 'normal', user_message: '我養了一隻貓' });
  ok(lastReq().messages.map(m => m.content).join('\n').includes('EMBED_CAT'), '內嵌世界書觸發');
  r = await j('POST', '/api/characters', { data: { name: 'x' }, avatar: 'data:image/jpeg;base64,/9j/4AAQ' });
  ok(r.status === 400, '拒絕非 PNG 頭像');

  // 匯入 SillyTavern 世界書格式
  const st = { entries: { 0: { uid: 0, key: ['龍'], keysecondary: [], comment: '龍', content: 'ST_DRAGON', constant: false, selective: false, order: 100, position: 4, depth: 2, disable: false } } };
  r = await j('POST', '/api/worlds/import', Buffer.from(JSON.stringify(st)), { 'X-Filename': encodeURIComponent('龍之書.json') });
  const w2 = (await j('GET', `/api/worlds/${r.data.id}`)).data;
  ok(w2.name === '龍之書' && w2.entries[0].position === 'at_depth' && w2.entries[0].depth === 2 && w2.entries[0].keys[0] === '龍', '匯入 ST 世界書', JSON.stringify(w2));

  // 錯誤處理
  r = await j('POST', '/api/characters/import', Buffer.from('not a card'));
  ok(r.status === 400, '錯誤檔案回 400');
  // 格式錯誤的角色卡、世界書：回 400（不是伺服器錯誤），也不會建立空的資料
  for (const [what, body] of [['沒有名字的 JSON', JSON.stringify({ description: 'x' })], ['JSON 陣列', '[1,2]'], ['沒有角色資料的 PNG', require(path.join(PROJ, 'lib/png.js')).solidPng(4, 4, [1, 2, 3])]]) {
    r = await j('POST', '/api/characters/import', Buffer.isBuffer(body) ? body : Buffer.from(body));
    ok(r.status === 400 && r.data.error, `角色卡格式錯誤回 400：${what}`, `${r.status} ${r.data.error}`);
  }
  const wbCount = (await j('GET', '/api/worlds')).data.length;
  for (const body of ['[1,2]', '{}', '"text"', JSON.stringify({ entries: [] })]) {
    r = await j('POST', '/api/worlds/import', Buffer.from(body));
    ok(r.status === 400, '世界書沒有任何條目：拒絕匯入 ' + body, r.status);
  }
  ok((await j('GET', '/api/worlds')).data.length === wbCount, '拒絕匯入時不會建立空的世界書');
  r = await j('GET', '/api/characters/..%2F..%2Fconfig');
  ok(r.status === 400 || r.status === 404, '路徑穿越被擋', r.status);
  res = await fetch(`${B}/../config.json`);
  ok(res.status === 404, '靜態檔案不外洩 config', res.status);
  // 格式錯誤的網址不能讓伺服器當掉（任何網頁都能送出這種請求）
  let bad = await rawReq('GET', '/%E0%A4%A');
  ok(bad.status === 400 && (await j('GET', '/api/settings')).status === 200, '格式錯誤的網址回傳 400，伺服器照常運作', bad.status);
  bad = await rawReq('GET', '/api/characters/%E0');
  ok(bad.status === 400 && (await j('GET', '/api/settings')).status === 200, 'API 網址格式錯誤也一樣', bad.status);
  r = await j('POST', '/api/worlds', { name: '格式測試' });
  const bad3 = await j('PUT', `/api/worlds/${r.data.id}`, 'not a book');
  ok(bad3.status === 400, '世界書格式錯誤回傳 400', bad3.status);
  await j('DELETE', `/api/worlds/${r.data.id}`);
  const wbTrash = path.join(TD, 'trash', 'worlds');
  ok(!fs.existsSync(path.join(TD, 'worlds', r.data.id + '.json')) && fs.existsSync(wbTrash) && fs.readdirSync(wbTrash).some(f => f.startsWith(r.data.id) && f.endsWith('.json')), '刪除世界書：移到 userdata/trash/worlds');

  // 刪除
  r = await j('DELETE', `/api/characters/${id2}`);
  ok((await j('GET', `/api/characters/${id2}`)).status === 404, '刪除角色');
  r = await j('GET', '/api/characters');
  ok(r.data.length === 2, '角色列表', r.data.length);

  // Claude 訊息轉換
  const { toClaudeMessages } = require(path.join(PROJ, 'lib/providers.js'));
  const cm = toClaudeMessages([{ role: 'system', content: 'S' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'u' }, { role: 'system', content: 'note' }]);
  ok(cm.system === 'S' && cm.messages[0].role === 'user' && cm.messages.at(-1).role === 'user' && cm.messages.length === 3, 'Claude 訊息轉換', JSON.stringify(cm));
  // Claude 串流：送出一段文字後就停住（不再有任何事件）→ 超過閒置時間自動中斷，已產生的內容保留在錯誤裡的提示中
  {
    const { streamAnthropic } = require(path.join(PROJ, 'lib/providers.js'));
    const sdkPath = require.resolve('@anthropic-ai/sdk', { paths: [path.join(PROJ, 'lib')] });
    const realSdk = require.cache[sdkPath];
    let mode = 'hang';
    const sent = [];
    class FakeSDK {
      constructor() {
        this.messages = { stream: (params, { signal }) => ({
          async *[Symbol.asyncIterator]() {
            sent.push(structuredClone({ thinking: params.thinking, output_config: params.output_config }));
            // 模擬不能關閉思考的模型
            if (mode === 'nodisable' && params.thinking && params.thinking.type !== 'adaptive')
              throw Object.assign(new Error(`"thinking.type.${params.thinking.type}" is not supported for this model`), { status: 400 });
            if (mode === 'think') yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先想想' } };
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '一半' } };
            if (mode !== 'hang') return;
            await new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
          },
          finalMessage: async () => ({ stop_reason: 'end_turn', model: 'fake', usage: { input_tokens: 1, output_tokens: 1 } }),
        }) };
      }
    }
    require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeSDK };
    const oldKey = process.env.ANTHROPIC_API_KEY, oldIdle = process.env.TAVERN_STREAM_IDLE_MS;
    process.env.ANTHROPIC_API_KEY = 'fake'; process.env.TAVERN_STREAM_IDLE_MS = '300';
    const settings = { max_tokens: 100, anthropic: { model: 'fake-model' } };
    let got = '', err = null; const t0 = Date.now();
    try { await streamAnthropic({ settings, messages: [{ role: 'user', content: 'hi' }], onText: t => (got += t) }); } catch (e) { err = e; }
    ok(err && /5 分鐘沒有送出新內容/.test(err.message) && got === '一半' && err.retryable === false && Date.now() - t0 < 5000, 'Claude 串流停住：超過閒置時間自動中斷（已有內容時不重試）', err && err.message);
    const ac = new AbortController(); err = null;
    const p = streamAnthropic({ settings, messages: [{ role: 'user', content: 'hi' }], signal: ac.signal, onText: () => {} }).catch(e => (err = e));
    setTimeout(() => ac.abort(), 50); await p;
    ok(err && err.name === 'AbortError' && !/5 分鐘/.test(err.message), 'Claude 串流：按「停止」照樣中止，不會被當成逾時', err && err.message);
    mode = 'ok';
    const done = await streamAnthropic({ settings, messages: [{ role: 'user', content: 'hi' }], onText: () => {} });
    ok(done.text === '一半' && done.stop_reason === 'end_turn', 'Claude 串流：正常結束不受影響');
    ok(!sent.at(-1).thinking, 'Claude：沒指定思考時不送 thinking（模型預設）');
    // 開啟思考：新模型用 adaptive 並要求顯示思考摘要；思考內容另外回傳
    mode = 'think'; let thought = '';
    const on = await streamAnthropic({ settings: { max_tokens: 8000, anthropic: { model: 'claude-opus-5-5', thinking: 'on', effort: 'high' } },
      messages: [{ role: 'user', content: 'hi' }], onText: () => {}, onReasoning: t => (thought += t) });
    ok(sent.at(-1).thinking?.type === 'adaptive' && sent.at(-1).thinking.display === 'summarized' && sent.at(-1).output_config?.effort === 'high'
      && on.reasoning === '先想想' && thought === '先想想' && on.text === '一半', 'Claude 開啟思考：adaptive＋effort，思考內容會顯示', JSON.stringify(sent.at(-1)));
    // 舊模型：改用思考預算，而且預算一定小於回應上限
    const { claudeThinkPlans } = require(path.join(PROJ, 'lib/providers.js'));
    const old = claudeThinkPlans({ model: 'claude-sonnet-4-5', thinking: 'on', effort: 'high' }, 4096)[0];
    ok(old.thinking.type === 'enabled' && old.thinking.budget_tokens === 3072 && !old.effort, 'Claude 舊模型：用思考預算（小於回應上限）', JSON.stringify(old));
    ok(!claudeThinkPlans({ model: 'claude-sonnet-4-5', thinking: 'on' }, 1500)[0].thinking, 'Claude 舊模型：回應上限太小時不開思考');
    // 關閉思考：模型不接受 disabled／between_tools 時，自動改成不送 thinking、effort 調到最低，並記住
    mode = 'nodisable'; sent.length = 0;
    const offSet = { max_tokens: 4000, anthropic: { model: 'claude-opus-5-5', thinking: 'off', effort: 'high' } };
    const off = await streamAnthropic({ settings: offSet, messages: [{ role: 'user', content: 'hi' }], onText: () => {} });
    ok(off.text === '一半' && sent.length === 3 && sent[0].thinking.type === 'disabled' && sent[1].thinking.type === 'between_tools'
      && !sent[2].thinking && sent[2].output_config.effort === 'low', 'Claude 關閉思考被拒絕：依序換寫法，最後改用最低 effort', JSON.stringify(sent));
    sent.length = 0;
    await streamAnthropic({ settings: offSet, messages: [{ role: 'user', content: 'hi' }], onText: () => {} });
    ok(sent.length === 1 && !sent[0].thinking, 'Claude：記住這個模型能用的寫法，下次不再試錯');
    if (realSdk) require.cache[sdkPath] = realSdk; else delete require.cache[sdkPath];
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
    if (oldIdle === undefined) delete process.env.TAVERN_STREAM_IDLE_MS; else process.env.TAVERN_STREAM_IDLE_MS = oldIdle;
  }

  // ===== 清空聊天：開場白依角色卡目前的內容重新帶入 =====
  {
    const gc = (await j('POST', '/api/characters', { data: { name: '開場白測試', first_mes: '你好 {{user}}', alternate_greetings: ['備用開場 B'] } })).data;
    const gchat = (await j('POST', `/api/characters/${gc.id}/chats`, { greeting: 1 })).data;
    // 在對話裡把開場白改掉、再加幾則訊息
    await j('PUT', `/api/characters/${gc.id}/chats/${gchat.id}`, { messages: [{ ...gchat.messages[0], content: '被改掉的開場白' }, { role: 'user', content: '嗨' }] });
    await j('PUT', `/api/characters/${gc.id}/chats/${gchat.id}`, { user_name: '小明' });
    r = await j('GET', `/api/characters/${gc.id}/chats/${gchat.id}/opening?greeting=1`);
    ok(r.status === 200 && r.data.length === 1 && r.data[0].content === '備用開場 B' && r.data[0].swipe_id === 1 && r.data[0].greeting && r.data[0].swipes[0] === '你好 小明',
      '清空聊天：依角色卡目前的開場白重新帶入（沿用原本選的版本；{{user}} 用這段對話的名字）', JSON.stringify(r.data));
    const gcard = (await j('GET', `/api/characters/${gc.id}`)).data.data;
    await j('PUT', `/api/characters/${gc.id}`, { data: { ...gcard, first_mes: '新的開場白', alternate_greetings: [] } });
    r = await j('GET', `/api/characters/${gc.id}/chats/${gchat.id}/opening?greeting=1`);
    ok(r.data.length === 1 && r.data[0].content === '新的開場白' && r.data[0].swipe_id === 0, '角色卡改過開場白：帶入新的；原本選的版本不在了就用第一個', JSON.stringify(r.data));
    const gchat2 = (await j('POST', `/api/characters/${gc.id}/chats`, {})).data;
    ok(gchat.title === '開場白測試' && gchat2.title === '開場白測試', '同一個角色開新對話：名稱維持角色名稱，不加編號', gchat2.title);
    await j('DELETE', `/api/characters/${gc.id}`);
  }

  // ===== 角色卡的多則開場白：旁白、{{user}} 的台詞（結構存在 extensions，first_mes 存合併後的文字） =====
  {
    const blocks = [
      [{ speaker: 'narrator', content: '霧起了。' }, { speaker: 'char', content: '{{char}}：歡迎' }, { speaker: 'user', content: '我是 {{user}}' }],
      [{ speaker: 'char', content: '備用一則' }],
    ];
    const flat = b => b.map(o => (o.speaker === 'user' ? `{{user}}：${o.content}` : o.content)).join('\n\n');
    const mc = (await j('POST', '/api/characters', { data: { name: '多則開場', first_mes: flat(blocks[0]), alternate_greetings: [flat(blocks[1])], extensions: { ai_tavern_openings: blocks } } })).data;
    const m0 = (await j('POST', `/api/characters/${mc.id}/chats`, { greeting: 0 })).data;
    ok(m0.messages.length === 3 && m0.messages[0].speaker === 'narrator' && m0.messages[0].role === 'assistant' && m0.messages[0].greeting_idx === 0
      && m0.messages[1].content === '多則開場：歡迎' && !m0.messages[1].speaker && m0.messages[2].role === 'user' && m0.messages[2].content === '我是 旅人'
      && m0.messages.every(m => m.greeting), '多則開場白：旁白、角色、你各自一則訊息（巨集替換）', JSON.stringify(m0.messages));
    const m1 = (await j('POST', `/api/characters/${mc.id}/chats`, { greeting: 1 })).data;
    ok(m1.messages.length === 1 && m1.messages[0].content === '備用一則' && m1.messages[0].greeting_idx === 1, '選備用開場白：只帶入那一個，記下是第幾個', JSON.stringify(m1.messages));
    r = await j('GET', `/api/characters/${mc.id}/chats/${m1.id}/opening?greeting=1`);
    ok(r.data.length === 1 && r.data[0].content === '備用一則', '清空聊天：沿用原本選的開場白');
    const exp = await fetch(`${B}/api/characters/${mc.id}/export?format=json`).then(x => x.json());
    ok(exp.data.first_mes === flat(blocks[0]) && exp.data.extensions.ai_tavern_openings.length === 2, '匯出：first_mes 是合併後的文字，結構保留在 extensions');
    // 在別的程式改過開場白（合併後的文字對不上）：忽略結構，改用文字
    const card = (await j('GET', `/api/characters/${mc.id}`)).data.data;
    await j('PUT', `/api/characters/${mc.id}`, { data: { ...card, first_mes: '別的程式改過的開場白' } });
    const m2 = (await j('POST', `/api/characters/${mc.id}/chats`, {})).data;
    ok(m2.messages.length === 1 && m2.messages[0].content === '別的程式改過的開場白' && m2.messages[0].swipes.length === 2, '開場白在別處被改過：改用文字（一般的開場白）', JSON.stringify(m2.messages));
    await j('DELETE', `/api/characters/${mc.id}`);
  }

  // ===== 大世界：整理角色卡規則（AI 把共用規則移到世界提示詞） =====
  {
    const orgChar = (await j('POST', '/api/characters', { data: { name: '規則測試', system_prompt: 'ROA_SYS 規則' } })).data;
    const card2 = { id: orgChar.id };
    const orgBody = (extra = {}) => ({ world_prompt: '世界原本的規則', members: [{ id: card2.id, sys_mode: 'full' }, { id, sys_mode: 'custom', sys_custom: '自訂的規則 B' }, { id: 'nope', sys_mode: 'full' }], ...extra });
    r = await j('POST', '/api/bigworlds/organize-rules', orgBody({ estimate_only: true }));
    ok(r.status === 200 && r.data.problem === '' && r.data.members.length === 2 && r.data.members[0].name === '規則測試' && r.data.input_tokens > 0,
      '整理角色卡規則：預估（本機模型不需要金鑰；不存在的角色略過）', JSON.stringify(r.data));
    const prevProvider = (await j('GET', '/api/settings')).data.settings.provider;
    await j('PUT', '/api/settings', { provider: 'anthropic' });
    r = await j('POST', '/api/bigworlds/organize-rules', orgBody({ estimate_only: true }));
    ok(r.data.problem === '尚未設定 API 金鑰', '整理角色卡規則：沒有金鑰時回報原因（畫面上提醒先設定 API）', JSON.stringify(r.data));
    r = await j('POST', '/api/bigworlds/organize-rules', orgBody());
    ok(r.status === 400 && /API 金鑰/.test(r.data.error), '沒有金鑰時不會呼叫 AI');
    await j('PUT', '/api/settings', { provider: prevProvider });
    r = await j('POST', '/api/bigworlds/organize-rules', orgBody());
    const sent = JSON.parse(fs.readFileSync(path.join(LOGDIR, 'last-request.json'), 'utf8'));
    const sentUser = sent.messages.at(-1).content;
    ok(r.status === 200 && r.data.shared === '不要替 {{user}} 說話或決定行動。' && JSON.stringify(r.data.conflicts) === '["回應長度要求不同"]'
      && r.data.results.length === 2 && r.data.results[0].keep === 'M1_KEEP 說話帶口癖\n第二條規則' && r.data.results[0].original.includes('ROA_SYS')
      && r.data.results[1].keep === null && r.data.results[1].original === '自訂的規則 B',
      '整理角色卡規則：解析 AI 的結果（容許多餘文字；沒回傳的角色保留原本內容）', JSON.stringify(r.data).slice(0, 400));
    ok(sentUser.includes('世界原本的規則') && sentUser.includes('ROA_SYS') && sentUser.includes('自訂的規則 B'), '送出世界提示詞與每位角色目前套用的規則');
    const stNow = (await j('GET', '/api/settings')).data.settings;
    ok(sentUser.includes('[主要系統提示]\n' + stNow.main_prompt.trim()) && sentUser.includes('[大世界系統提示]\n' + stNow.world_prompt.trim()),
      '也送出主要系統提示與大世界系統提示（已經寫在裡面的規則不會重複放）');
    r = await j('POST', '/api/bigworlds/organize-rules', { world_prompt: '', members: [{ id: card2.id, sys_mode: 'none' }] });
    ok(r.status === 400 && /沒有需要整理/.test(r.data.error), '「不套用」的角色不整理；沒有規則時不呼叫 AI');
    await j('PUT', '/api/settings', { openai: { model: 'badjson' } });
    r = await j('POST', '/api/bigworlds/organize-rules', orgBody());
    ok(r.status === 502 && /看不懂/.test(r.data.error), 'AI 回傳看不懂的內容：清楚的錯誤訊息');
    ok(fs.readFileSync(path.join(path.dirname(process.env.TAVERN_WINDOW_FILE), 'organize-last.txt'), 'utf8').includes('我整理不出來'), '最近一次的原始回覆存在 data/organize-last.txt（方便查原因）');
    await j('PUT', '/api/settings', { openai: { model: 'jsonorg' } });
    r = await j('POST', '/api/bigworlds/organize-rules', orgBody());
    ok(r.status === 200 && r.data.shared === '不要替 {{user}} 說話。\n保持角色。' && r.data.results[0].keep === 'M1_JSON\n第二行', '模型回 JSON 且字串裡直接換行：照樣讀得懂', JSON.stringify(r.data).slice(0, 300));
    await j('PUT', '/api/settings', { openai: { model: 'thinkorg' } });
    r = await j('POST', '/api/bigworlds/organize-rules', orgBody());
    ok(r.status === 502 && /只輸出了思考內容/.test(r.data.error), '只想完、沒寫出結果（用完回應長度）：說明原因與調整方式', r.data.error);
    // 使用者關掉預覽（取消請求）：伺服器要中止對 AI 的呼叫，不再白白消耗 token
    await j('PUT', '/api/settings', { openai: { model: 'sloworg' } });
    const slowLog = path.join(LOGDIR, 'sloworg.log');
    const orgAc = new AbortController();
    const orgReq = fetch(B + '/api/bigworlds/organize-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orgBody()), signal: orgAc.signal }).catch(() => null);
    await new Promise(res => setTimeout(res, 800));
    orgAc.abort(); await orgReq;
    await new Promise(res => setTimeout(res, 500));
    const slowNote = fs.existsSync(slowLog) ? fs.readFileSync(slowLog, 'utf8') : '';
    ok(slowNote.includes('aborted') && !slowNote.includes('done'), '取消整理角色卡規則：伺服器立刻中止 AI 呼叫', JSON.stringify(slowNote));
    const srvLog = process.env.SERVER_LOG && fs.existsSync(process.env.SERVER_LOG) ? fs.readFileSync(process.env.SERVER_LOG, 'utf8') : '';
    ok(process.env.SERVER_LOG && !/AbortError|This operation was aborted/.test(srvLog), '取消整理是正常操作：伺服器記錄不印錯誤堆疊', srvLog.slice(-300));
    await j('PUT', '/api/settings', { openai: { model: 'mock-a' } });
    // 世界書的掃描深度與 Token 預算：照填的數字（以前最少固定 4 則／2048，設小沒有效果）
    {
      const { scanWorldInfo } = require(path.join(PROJ, 'lib/prompt.js'));
      const hist = ['提到魔法學院', '其他', '其他', '現在'].map(content => ({ role: 'user', content }));
      const entry = { keys: ['魔法學院'], content: '學院設定' };
      const bookOf = (o = {}) => ({ name: 'B', entries: [entry], ...o });
      ok(scanWorldInfo([bookOf({ scan_depth: 2 })], hist).length === 0 && scanWorldInfo([bookOf({ scan_depth: 4 })], hist).length === 1, '世界書掃描深度設 2：只看最近 2 則（不再固定至少 4 則）');
      ok(scanWorldInfo([bookOf({ scan_depth: 2 }), bookOf({ scan_depth: 5, entries: [] })], hist).length === 1, '好幾本世界書：掃描深度取最大的');
      ok(scanWorldInfo([bookOf({})], hist).length === 1, '沒填掃描深度：預設 4 則');
      const mid = n => ({ keys: ['現在'], content: '中'.repeat(n), insertion_order: 1 }), hi = { keys: ['現在'], content: '短', insertion_order: 9 };
      const lenOf = r => JSON.stringify(r.map(e => e.content.length));
      let got = scanWorldInfo([bookOf({ token_budget: 1500, entries: [mid(1200), hi] })], hist);
      ok(got.length === 2, 'Token 預算 1500：放得下 1200 的條目', lenOf(got));
      got = scanWorldInfo([bookOf({ token_budget: 1100, entries: [mid(1200), hi] })], hist);
      ok(got.length === 1 && got[0].content === hi.content, 'Token 預算照填的數字：超過時保留排序大的、太長的條目略過', lenOf(got));
      got = scanWorldInfo([bookOf({ token_budget: 100, entries: [mid(600), hi] })], hist);
      ok(got.length === 2, 'Token 預算低於 1024（舊資料、匯入）：以 1024 計算，一般條目不會全部失效', lenOf(got));
      // 遞迴：各本照自己的設定，條目可個別排除
      const names = r => r.map(e => e.content).sort().join(',');
      const kingdom = { keys: ['魔法學院'], content: '學院位於王都' }, capital = { keys: ['王都'], content: '王都很大' };
      ok(names(scanWorldInfo([bookOf({ recursive_scanning: true, entries: [kingdom, capital] })], hist)) === '學院位於王都,王都很大', '遞迴掃描：條目內容帶出其他條目');
      ok(names(scanWorldInfo([bookOf({ recursive_scanning: false, entries: [kingdom, capital] })], hist)) === '學院位於王都', '沒開遞迴：只看聊天訊息');
      ok(names(scanWorldInfo([bookOf({ recursive_scanning: true, entries: [kingdom, { ...capital, exclude_recursion: true }] })], hist)) === '學院位於王都', '條目設「不會被遞迴觸發」');
      ok(names(scanWorldInfo([bookOf({ recursive_scanning: true, entries: [{ ...kingdom, prevent_recursion: true }, capital] })], hist)) === '學院位於王都', '條目設「內容不觸發其他條目」');
      ok(names(scanWorldInfo([bookOf({ recursive_scanning: false, entries: [kingdom] }), { name: 'C', recursive_scanning: true, entries: [capital] }], hist)) === '學院位於王都,王都很大'
        && names(scanWorldInfo([bookOf({ recursive_scanning: true, entries: [kingdom] }), { name: 'C', recursive_scanning: false, entries: [capital] }], hist)) === '學院位於王都',
        '多本世界書：遞迴各本照自己的設定（沒開的那本只被聊天訊息觸發）');
      const { normalizeBook, toV2 } = require(path.join(PROJ, 'lib/cards.js'));
      const nb = normalizeBook({ entries: { 0: { key: ['a'], content: 'x', excludeRecursion: true }, 1: { keys: ['b'], content: 'y', extensions: { prevent_recursion: true } } } });
      ok(nb.entries[0].exclude_recursion && !nb.entries[0].prevent_recursion && nb.entries[1].prevent_recursion, '匯入 SillyTavern 的遞迴設定');
      ok(toV2({ name: 'x', character_book: nb }).data.character_book.entries[1].extensions.prevent_recursion === true, '匯出時遞迴設定寫進條目的 extensions');
      // 正規表示式關鍵字：會災難性回溯的寫法不比對（不會卡住伺服器），一般的照常觸發
      const reBook = { name: 'R', entries: [{ keys: ['/^(a+)+$/'], content: 'EVIL' }, { keys: ['/(\\w+\\s?)*$/'], content: 'EVIL2' }, { keys: ['/貓|狗/'], content: 'PET' }, { keys: ['/a{2,}/i'], content: 'AA' }] };
      const t0 = Date.now();
      const reHit = names(scanWorldInfo([reBook], [{ role: 'user', content: 'a'.repeat(40) + '! 有貓 AAA' }]));
      ok(Date.now() - t0 < 500 && reHit.includes('PET') && reHit.includes('AA') && !reHit.includes('EVIL'), '世界書的正規表示式：危險的寫法不比對、不會卡住；一般的照常觸發', `${Date.now() - t0}ms ${reHit}`);
      // 並排的 .*、a*a*a*b 這類擋不完的寫法：最多跑 50 毫秒就中止，之後也不再比對
      const slowBook = { name: 'S', entries: [{ keys: ['/.*.*.*.*z/'], content: 'SLOW1' }, { keys: ['/a*a*a*a*a*b/'], content: 'SLOW2' }, { keys: ['/貓/'], content: 'PET' }] };
      const t1 = Date.now();
      const slowHit = names(scanWorldInfo([slowBook], [{ role: 'user', content: 'a'.repeat(3000) + ' 貓' }]));
      const firstMs = Date.now() - t1, t2 = Date.now();
      scanWorldInfo([slowBook], [{ role: 'user', content: 'a'.repeat(3000) + ' 貓' }]);
      ok(slowHit === 'PET' && firstMs < 1000 && Date.now() - t2 < 50, '跑太久的正規表示式：中止並停用，下次直接略過', `${firstMs}ms / ${Date.now() - t2}ms ${slowHit}`);
      // 名字裡有 $ 符號：照原樣替換（不會被當成特殊替換語法）
      const { substitute } = require(path.join(PROJ, 'lib/prompt.js'));
      ok(substitute('{{char}}對{{user}}說', { char: 'A$&B', user: "$$錢$'" }) === "A$&B對$$錢$'說", '名字裡有 $ 符號時照原樣替換');
      const { buildWorldPrompt } = require(path.join(PROJ, 'lib/prompt.js'));
      const wp = buildWorldPrompt({ world: { name: '世界$&名', setting: '這裡是{{world}}', members: [] }, members: [], history: [{ role: 'user', content: 'hi' }], settings: { user_name: 'U', context_tokens: 8000, max_tokens: 100 }, books: [] });
      ok(JSON.stringify(wp.messages).includes('這裡是世界$&名'), '{{world}}：世界名稱裡有 $ 符號時照原樣替換');
      // 配角：導演標了（配角）的旁白保留一行、放在安排的位置、不佔角色名額；沒標的旁白照舊拿掉
      const { parsePlan, NARRATOR } = require(path.join(PROJ, 'lib/turns.js'));
      const pm = [{ id: 'a', card: { name: '蘿亞' } }, { id: 'b', card: { name: '艾迪娜' } }];
      let pp = parsePlan('在場：蘿亞、艾迪娜\n重點：市集\n1. 旁白：攤販招呼旅人買包子（配角）\n2. 蘿亞：回應攤販\n3. 艾迪娜：吐槽\n4. 旁白：另一個路人經過（配角）', pm, 2);
      ok(pp.steps.map(s => s.speaker).join() === `${NARRATOR},a,b` && pp.steps[0].npc && pp.steps[0].intent === '攤販招呼旅人買包子',
        '導演標了（配角）的旁白：保留一行、放在安排的位置、不佔角色名額（第二行配角旁白拿掉）', JSON.stringify(pp.steps));
      pp = parsePlan('在場：蘿亞\n重點：x\n1. 蘿亞：說話\n2. 旁白：收尾', pm, 2);
      ok(pp.steps.map(s => s.speaker).join() === 'a', '沒標（配角）的旁白：有角色發言時照舊拿掉');
      pp = parsePlan('在場：無\n重點：x\n1. 旁白：描寫空蕩的街道', pm, 2);
      ok(pp.steps.length === 1 && pp.steps[0].speaker === NARRATOR, '沒有角色在場：照舊由旁白描寫場景');
      const { DEFAULT_SETTINGS } = require(path.join(PROJ, 'lib/storage.js'));
      ok(DEFAULT_SETTINGS.world_prompt.includes('【配角】') && DEFAULT_SETTINGS.world_prompt.includes('配角稱呼：「台詞」'), '大世界系統提示的預設值有配角的規則');
      // Temperature 預設改成 0.7：已經有 settings.json、又沒存 temperature 的舊資料，維持原本的 0.9
      {
        const store = require(path.join(PROJ, 'lib/storage.js'));
        const SF = path.join(TD, 'settings.json'), orig = fs.readFileSync(SF, 'utf8');
        // 模擬舊版的資料：沒有 temperature、max_tokens，也還沒處理過
        const raw = JSON.parse(orig); delete raw.temperature; delete raw.max_tokens; delete raw.context_tokens; delete raw.pinned_defaults;
        fs.writeFileSync(SF, JSON.stringify(raw));
        const pinned = store.pinChangedDefaults();
        const after = JSON.parse(fs.readFileSync(SF, 'utf8'));
        ok(DEFAULT_SETTINGS.temperature === 0.7 && DEFAULT_SETTINGS.max_tokens === 8192 && pinned.includes('temperature') && pinned.includes('max_tokens')
          && after.temperature === 0.9 && after.max_tokens === 4096, '預設 Temperature 0.7、最大回應 8192；舊資料沒存這些值時保留原本的 0.9、4096', JSON.stringify(after.pinned_defaults));
        ok(DEFAULT_SETTINGS.context_tokens === 64000 && pinned.includes('context_tokens') && after.context_tokens === 32000, '預設上下文長度 64000；舊資料沒存時保留原本的 32000');
        ok(store.pinChangedDefaults().length === 0, '已經處理過就不再改動');
        // 之後自己改回新的預設（不會存進設定檔）：下次啟動不會又被改回舊值
        const reset = JSON.parse(fs.readFileSync(SF, 'utf8')); delete reset.temperature;
        fs.writeFileSync(SF, JSON.stringify(reset));
        ok(store.pinChangedDefaults().length === 0 && !('temperature' in JSON.parse(fs.readFileSync(SF, 'utf8'))), '自己改回新的預設後，不會又被改回舊值');
        fs.writeFileSync(SF, orig);
      }
    }
    // 分段格式的各種寫法
    const { parseResult } = require(path.join(PROJ, 'lib/organize.js'));
    const pr = parseResult('### [共用規則]\n（無）\n**【M1】** 只有一行\n[M2]\n- A\n- B\n【衝突】\n（無）', ['M1', 'M2']);
    ok(pr.shared === '' && pr.keep.M1 === '只有一行' && pr.keep.M2 === '- A\n- B' && pr.conflicts.length === 0, '分段格式：容許 [ ]、###、粗體、同一行內文與「（無）」', JSON.stringify(pr));
  }

  // ===== 模型設定檔 =====
  const authLog = () => fs.readFileSync(path.join(LOGDIR, 'last-auth.txt'), 'utf8');
  // 一定有一個使用中的設定檔：啟動時自動用目前的設定建立；設定 API 不能改成「不使用設定檔」
  ok(!!(await j('GET', '/api/profiles')).data.active, '一開始就有使用中的模型設定檔');
  await j('PUT', '/api/settings', { active_profile: null });
  ok(!!(await j('GET', '/api/profiles')).data.active, '設定 API 不能改成不使用設定檔');
  await j('PUT', '/api/settings', { provider: 'openai', openai: { base_url: MOCK + '/v1', model: 'mock-a' }, temperature: 0.9 });
  await j('PUT', '/api/keys', { provider: 'openai', api_key: 'KEY_PROFILE_A' });
  r = await j('POST', '/api/profiles', { name: '平台A' });
  const pA = r.data.id;
  ok(r.data.active === pA && r.data.profiles.some(p => p.id === pA && p.name === '平台A' && p.model === 'mock-a' && p.has_key), '另存新設定檔（含金鑰）並設為使用中', JSON.stringify(r.data));
  // 用畫面上還沒儲存的內容另存新設定檔：直接放進新設定檔，原本的平台A不會被改到
  r = await j('POST', '/api/profiles', { name: '平台B', fields: { openai: { model: 'mock-b' }, context_tokens: 16000 }, key: 'KEY_PROFILE_B' });
  const pB = r.data.id;
  ok(r.data.active === pB && r.data.profiles.find(p => p.id === pA).model === 'mock-a' && r.data.profiles.find(p => p.id === pB).model === 'mock-b', '另存新設定檔（畫面上的內容）：切換過去，原本的設定檔不變', JSON.stringify(r.data.profiles.map(p => [p.name, p.model])));
  r = await j('POST', '/api/profiles', { name: 'bad', fields: { temperature: 9 } });
  ok(r.status === 400, '新設定檔的參數超出範圍：拒絕');
  r = await j('POST', '/api/profiles', { name: 'bad', fields: { retry_max: 2.5 } });
  ok(r.status === 400, '新設定檔的整數欄位是小數：拒絕（和設定 API 一致）', r.status);
  r = await j('POST', `/api/profiles/${pA}/apply`);
  ok(r.data.settings.openai.model === 'mock-a' && r.data.settings.context_tokens === 64000 && r.data.active === pA, '切換設定檔：模型與生成參數一起切換', JSON.stringify({ m: r.data.settings.openai.model, c: r.data.settings.context_tokens }));
  await j('GET', '/api/models');
  ok(authLog().endsWith('Bearer KEY_PROFILE_A'), '切換設定檔：金鑰也換成它存的那一把');
  await j('PUT', '/api/settings', { temperature: 0.55 }); // 使用中的設定檔跟著更新
  await j('PUT', '/api/keys', { provider: 'openai', api_key: 'KEY_PROFILE_A2' });
  await j('POST', `/api/profiles/${pB}/apply`);
  await j('GET', '/api/models');
  ok(authLog().endsWith('Bearer KEY_PROFILE_B'), '切到另一個設定檔用它自己的金鑰');
  r = await j('POST', `/api/profiles/${pA}/apply`);
  await j('GET', '/api/models');
  ok(r.data.settings.temperature === 0.55 && authLog().endsWith('Bearer KEY_PROFILE_A2'), '使用中的設定檔在儲存設定、更新金鑰時一起更新');
  const pubText = JSON.stringify((await j('GET', '/api/settings')).data) + JSON.stringify((await j('GET', '/api/profiles')).data);
  ok(!pubText.includes('KEY_PROFILE'), '設定檔的金鑰不會回傳給瀏覽器');
  ok(!fs.readFileSync(path.join(TD, 'settings.json'), 'utf8').includes('KEY_PROFILE'), '金鑰不寫進 settings.json');
  r = await j('PUT', `/api/profiles/${pB}`, { name: '平台B改名' });
  ok(r.data.profiles.find(p => p.id === pB).name === '平台B改名', '設定檔重新命名');
  r = await j('DELETE', `/api/profiles/${pA}`);
  const nextActive = r.data.profiles.find(p => p.id === r.data.active);
  ok(r.data.active && r.data.active !== pA && nextActive && (await j('GET', '/api/settings')).data.settings.openai.model === nextActive.model, '刪除使用中的設定檔：切換到清單裡的另一個', JSON.stringify(r.data.active));
  // 刪到一個都不剩：用目前的設定重新建立一個
  for (const p of r.data.profiles) await j('DELETE', `/api/profiles/${p.id}`);
  r = await j('GET', '/api/profiles');
  ok(r.data.profiles.length === 1 && r.data.active === r.data.profiles[0].id, '設定檔刪光時，自動用目前的設定建立一個', JSON.stringify(r.data));
  r = await j('POST', '/api/profiles/nope/apply');
  ok(r.status === 404, '套用不存在的設定檔回傳 404');
  await j('PUT', '/api/settings', { openai: { model: 'mock-a' }, temperature: 0.9, context_tokens: 32000 });
  await j('PUT', '/api/keys', { provider: 'openai', api_key: '' });

  // ===== 金鑰：設定頁按「顯示」時才讀取 =====
  await j('PUT', '/api/keys', { provider: 'openai', api_key: 'SHOW_ME_KEY' });
  r = await j('GET', '/api/keys/openai');
  ok(r.status === 200 && r.data.key === 'SHOW_ME_KEY' && r.data.source === 'config', '顯示金鑰：讀得到已儲存的金鑰', JSON.stringify(r.data));
  ok((await j('GET', '/api/keys/nope')).status === 400, '顯示金鑰：未知的供應商回傳 400');
  sq = await rawReq('GET', '/api/keys/openai', { Host: hostHdr, 'Sec-Fetch-Site': 'cross-site' });
  ok(sq.status === 403 && !sq.text.includes('SHOW_ME_KEY'), '顯示金鑰：其他網站讀不到', sq.status);
  sq = await rawReq('GET', '/api/keys/openai', { Host: 'evil.example:' + new URL(B).port });
  ok(sq.status === 403, '顯示金鑰：DNS rebinding 讀不到', sq.status);
  await j('PUT', '/api/keys', { provider: 'openai', api_key: '' });
  r = await j('GET', '/api/keys/openai');
  ok(r.data.key === '' && r.data.source === 'none', '沒有金鑰時回傳空白');

  // ===== Gemini 原生 API：安全審查只把色情類別設為 OFF =====
  {
    await j('PUT', '/api/settings', { provider: 'gemini', gemini: { model: 'gemini-mock', reasoning_effort: '' }, active_profile: null });
    await j('PUT', '/api/keys', { provider: 'gemini', api_key: 'GM_TEST_KEY' });
    r = await j('GET', '/api/models');
    ok(JSON.stringify(r.data.models) === '["gemini-mock"]', 'Gemini：用原生 API 取得模型清單（只留可對話的）', JSON.stringify(r.data));
    const gchat = (await j('POST', `/api/characters/${id}/chats`, {})).data.id;
    const gLast = () => JSON.parse(fs.readFileSync(path.join(LOGDIR, 'gemini-request.json'), 'utf8'));
    let gev = await gen({ char_id: id, chat_id: gchat, mode: 'normal', user_message: '你好' });
    let gdone = gev.find(e => e.type === 'done');
    const greq = gLast();
    ok(gev.filter(e => e.type === 'text').map(e => e.text).join('') === '雙子星回覆', 'Gemini：串流文字完整', JSON.stringify(gev.find(e => e.type === 'error')));
    const cats = greq.body.safetySettings.map(s => s.category).sort().join();
    ok(cats === 'HARM_CATEGORY_CIVIC_INTEGRITY,HARM_CATEGORY_DANGEROUS_CONTENT,HARM_CATEGORY_HARASSMENT,HARM_CATEGORY_HATE_SPEECH,HARM_CATEGORY_SEXUALLY_EXPLICIT'
      && greq.body.safetySettings.every(s => s.threshold === 'OFF'), 'Gemini：五個安全審查類別都設為 OFF', JSON.stringify(greq.body.safetySettings));
    ok(greq.key === 'GM_TEST_KEY' && !greq.url.includes('GM_TEST_KEY'), 'Gemini：金鑰放在標頭，不放網址');
    ok(greq.body.systemInstruction?.parts[0].text.includes('艾迪娜') && greq.body.contents[0].role === 'user' && greq.body.contents.some(c => c.role === 'model')
      && greq.body.contents.at(-1).parts[0].text.includes('你好'), 'Gemini：系統提示放在 systemInstruction，對話用 user／model', JSON.stringify(greq.body.contents.map(c => c.role)));
    ok(greq.body.generationConfig.maxOutputTokens > 0 && greq.body.generationConfig.thinkingConfig?.includeThoughts === true && !('thinkingLevel' in greq.body.generationConfig.thinkingConfig),
      'Gemini：生成參數與思考設定（沒指定思考程度就不送）', JSON.stringify(greq.body.generationConfig));
    const gmsg = gdone?.chat.messages.at(-1);
    ok(gmsg?.reasoning === 'GEM_THOUGHT' && gmsg.content === '雙子星回覆', 'Gemini：思考內容另外存，不混進回覆', JSON.stringify(gmsg));
    // 思考程度：Gemini 3 以後用 thinkingLevel；不支援思考的模型自動拿掉思考設定重試
    await j('PUT', '/api/settings', { gemini: { model: 'gemini-mock', reasoning_effort: 'high' } });
    await gen({ char_id: id, chat_id: gchat, mode: 'normal', user_message: '思考一下' });
    ok(gLast().body.generationConfig.thinkingConfig?.thinkingLevel === 'high', 'Gemini：思考程度送 thinkingLevel');
    await j('PUT', '/api/settings', { gemini: { model: 'gemini-nothink', reasoning_effort: 'high' } });
    gev = await gen({ char_id: id, chat_id: gchat, mode: 'normal', user_message: '不會思考' });
    ok(gev.some(e => e.type === 'done') && !gLast().body.generationConfig.thinkingConfig, 'Gemini：模型不支援思考時自動拿掉思考設定重試', JSON.stringify(gev.find(e => e.type === 'error')));
    // 被擋下：顯示是哪一類
    await j('PUT', '/api/settings', { gemini: { model: 'gemini-blocked', reasoning_effort: '' } });
    gev = await gen({ char_id: id, chat_id: gchat, mode: 'normal', user_message: '被擋' });
    const gerr = gev.find(e => e.type === 'error');
    ok(gerr && gerr.error.includes('安全審查') && gerr.error.includes('騷擾') && gerr.error.includes('送出的內容'), 'Gemini：被擋下時說明是哪一類、是輸入觸發的', JSON.stringify(gerr));
    await j('PUT', '/api/settings', { gemini: { model: 'gemini-prohibited', reasoning_effort: '' } });
    gev = await gen({ char_id: id, chat_id: gchat, mode: 'normal', user_message: '政策' });
    const perr = gev.find(e => e.type === 'error');
    ok(perr && perr.error.includes('PROHIBITED_CONTENT') && perr.error.includes('無法用安全設定關閉'), 'Gemini：PROHIBITED_CONTENT 說明無法用安全設定關閉', JSON.stringify(perr));
    await j('PUT', '/api/settings', { gemini: { model: 'gemini-nocivic', reasoning_effort: '' } });
    gev = await gen({ char_id: id, chat_id: gchat, mode: 'normal', user_message: '公民' });
    ok(gev.some(e => e.type === 'done') && gLast().body.safetySettings.length === 4, 'Gemini：模型不接受公民誠信類別時拿掉後重試', JSON.stringify(gev.find(e => e.type === 'error')));
    await j('PUT', '/api/settings', { gemini: { model: 'gemini-cut', reasoning_effort: '' } });
    gev = await gen({ char_id: id, chat_id: gchat, mode: 'normal', user_message: '寫一半' });
    const gtext = gev.filter(e => e.type === 'text').map(e => e.text).join('');
    ok(gtext.startsWith('寫到一半') && gtext.includes('危險內容') && gev.some(e => e.type === 'done'), 'Gemini：寫到一半被擋下時保留內容並註明原因', gtext);
    await j('PUT', '/api/settings', { provider: 'openai', gemini: { model: '', reasoning_effort: '' } });
    await j('PUT', '/api/keys', { provider: 'gemini', api_key: '' });
  }

  // ===== 上下文壓縮：聊天紀錄超過門檻時，把較舊的對話整理進記憶，再從提示詞移除 =====
  // 40 則、每則約 64 tokens（約 2600）；上下文 4000、回應 500，留給聊天紀錄的空間約 3000 → 超過 70% 門檻
  await j('PUT', '/api/settings', { openai: { model: 'mock-a' }, memory_enabled: true, memory_auto: true, compress_threshold: 70, compress_keep: 35, context_tokens: 4000, max_tokens: 500, retry_max: 2 });
  const tcid = (await j('POST', `/api/characters/${id}/chats`, {})).data.id;
  const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i}則 MSG_${i} ` + '字'.repeat(56) }));
  await j('PUT', `/api/characters/${id}/chats/${tcid}`, { messages: many, memory: '前情提要 MEMTOKEN', memory_upto: 0 });
  let rq0 = logLines().length;
  ev = await gen({ char_id: id, chat_id: tcid, mode: 'normal', user_message: '繼續吧' });
  let reqs = reqsSince(rq0);
  let tc2 = (await j('GET', `/api/characters/${id}/chats/${tcid}`)).data;
  ok(ev.some(e => e.type === 'compress' && e.status === 'start') && reqs.length === 2 && reqs[0].messages[0].content.includes('記錄員') && JSON.stringify(reqs[0]).includes('MSG_0'),
    '超過門檻：送出前先把舊對話整理進記憶', `${reqs.length} 個請求`);
  const cutAt = tc2.memory_cut;
  ok(cutAt > 0 && tc2.memory_upto >= cutAt && tc2.messages[cutAt].role === 'user', '切點在「你的發言」前面，而且記憶已經整理到切點', `cut=${cutAt} upto=${tc2.memory_upto}`);
  let sent = lastReq().messages.map(m => m.content).join('\n');
  ok(!sent.includes(`MSG_${cutAt - 1} `) && sent.includes(`MSG_${cutAt} `) && sent.includes('MSG_39') && sent.includes('[長期記憶'), '壓縮後：切點之前的原文不再送出，最近的原文與記憶照常送出');
  ok(ev.find(e => e.type === 'start').info.memory_cut === cutAt, '狀態列知道有幾則交給記憶');
  ok(tc2.token_ratio > 0, '用 API 回報的實際用量校正 token 估算', String(tc2.token_ratio));
  r = await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid });
  ok(r.data.info.memory_cut === cutAt && !r.data.messages.some(m => m.content.includes(`MSG_${cutAt - 1} `)) && !('history_tokens' in r.data.info), '提示詞預覽和實際送出的一致');
  rq0 = logLines().length;
  await gen({ char_id: id, chat_id: tcid, mode: 'regenerate' });
  ok(reqsSince(rq0).length === 1 && (await j('GET', `/api/characters/${id}/chats/${tcid}`)).data.memory_cut === cutAt, '壓縮完之後：沒超過門檻就不再壓縮，切點不變（提示詞開頭不變）');
  await j('PUT', '/api/settings', { memory_enabled: false });
  await gen({ char_id: id, chat_id: tcid, mode: 'regenerate' });
  ok(lastReq().messages.some(m => m.content.includes('MSG_39')) && !lastReq().messages[0].content.includes('[長期記憶'), '關閉記憶時不使用切點與記憶');
  // 關閉自動壓縮：照舊依上下文長度裁掉最舊的
  await j('PUT', '/api/settings', { memory_enabled: true, memory_auto: false });
  const tcid2 = (await j('POST', `/api/characters/${id}/chats`, {})).data.id;
  await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { messages: many });
  ev = await gen({ char_id: id, chat_id: tcid2, mode: 'normal', user_message: '繼續吧' });
  ok(!ev.some(e => e.type === 'compress') && !(await j('GET', `/api/characters/${id}/chats/${tcid2}`)).data.memory_cut, '關閉自動壓縮時不壓縮');
  // 清空聊天時切點歸零
  r = await j('PUT', `/api/characters/${id}/chats/${tcid}`, { memory_cut: 0 });
  ok(r.data.memory_cut === 0, '可以重設切點（清空聊天時）');
  await j('PUT', `/api/characters/${id}/chats/${tcid}`, { memory_cut: cutAt });
  // 回應完成後在背景壓縮：這次送出時還沒超過門檻；回應後依實際用量校正（這個假模型回報的用量特別大），超過門檻就在背景先壓縮
  await j('PUT', '/api/settings', { openai: { model: 'bigusage' }, memory_auto: true });
  const tcid3 = (await j('POST', `/api/characters/${id}/chats`, {})).data.id;
  await j('PUT', `/api/characters/${id}/chats/${tcid3}`, { messages: many.slice(0, 20) });
  ev = await gen({ char_id: id, chat_id: tcid3, mode: 'normal', user_message: '繼續吧' });
  ok(!ev.some(e => e.type === 'compress') && ev.find(e => e.type === 'done').memory_updating === true, '送出時沒超過門檻；回應完成後發現超過，在背景壓縮');
  for (let k = 0; k < 40 && (await j('GET', '/api/chats')).data.find(x => x.id === tcid3)?.memory_updating; k++) await new Promise(r => setTimeout(r, 100));
  const bg = (await j('GET', `/api/characters/${id}/chats/${tcid3}`)).data;
  ok(bg.memory_cut > 0 && bg.memory_upto >= bg.memory_cut && bg.memory.trim() && bg.messages[bg.memory_cut].role === 'user', '背景壓縮完成：記憶與切點都存好了', `cut=${bg.memory_cut}`);
  await j('PUT', '/api/settings', { openai: { model: 'mock-a' }, memory_auto: false, context_tokens: 32000, max_tokens: 4096 });

  // 埠被佔用時，用 /api/ping 認出另一個 AI 酒館（不是的話換下一個埠）
  r = await j('GET', '/api/ping');
  ok(r.status === 200 && r.data.app === 'ai-tavern', '/api/ping：讓新啟動的酒館認出這個埠上的是 AI 酒館');
  // ===== 自訂順序 ID：存在資料夾的 order.json，不改角色卡、不改資料夾名稱 =====
  {
    const oc = (await j('POST', '/api/characters', { data: { name: '順序測試' } })).data.id;
    const odir = () => fs.readdirSync(path.join(TD, 'char')).find(n => n.endsWith('-' + oc));
    r = await j('PUT', `/api/characters/${oc}/order`, { order: 12 });
    const card0 = JSON.parse(fs.readFileSync(path.join(TD, 'char', odir(), 'card.json'), 'utf8'));
    ok(r.status === 200 && r.data.order === 12 && JSON.parse(fs.readFileSync(path.join(TD, 'char', odir(), 'order.json'), 'utf8')).order === 12 && !('order' in card0),
      '順序 ID 存在資料夾的 order.json（角色卡不變）');
    ok((await j('GET', '/api/characters')).data.find(c => c.id === oc).order === 12 && (await j('GET', `/api/characters/${oc}`)).data.order === 12, '角色清單與詳情都帶著順序 ID');
    await j('PUT', `/api/characters/${oc}`, { data: { name: '順序測試改名' } });
    ok(odir().startsWith('順序測試改名-') && (await j('GET', `/api/characters/${oc}`)).data.order === 12, '改名（資料夾改名）後順序 ID 照樣保留');
    for (const bad of [1.5, 'abc', 10000, -1]) {
      r = await j('PUT', `/api/characters/${oc}/order`, { order: bad });
      ok(r.status === 400, '順序 ID 要是整數 ' + JSON.stringify(bad));
    }
    // 手動改 order.json：超出範圍的值收進 0～9999；文字數字、只寫一個數字也接受；看不懂的當成沒指定
    const ofile = () => path.join(TD, 'char', odir(), 'order.json');
    const readBack = async () => (await j('GET', `/api/characters/${oc}`)).data.order;
    const cases = [['{"order": 123456}', 9999], ['{"order": -50}', 0], ['{"order": 7.6}', 8], ['{"order": "42"}', 42], ['15', 15], ['{"order": "abc"}', null], ['{ broken', null]];
    for (const [text, want] of cases) {
      fs.writeFileSync(ofile(), text);
      const got = await readBack();
      ok(got === want && (await j('GET', '/api/characters')).data.find(c => c.id === oc).order === want, `手動改 order.json：${text} → ${want}`, String(got));
    }
    r = await j('PUT', `/api/characters/${oc}/order`, { order: null });
    ok(r.data.order === null && !fs.existsSync(path.join(TD, 'char', odir(), 'order.json')) && (await j('GET', `/api/characters/${oc}`)).data.order === null, '留空＝不指定（刪掉 order.json）');
    const wo = (await j('POST', '/api/bigworlds', { data: { name: '順序世界', members: [] } })).data;
    r = await j('PUT', `/api/bigworlds/${wo.id}/order`, { order: 3 });
    ok(r.data.order === 3 && (await j('GET', '/api/bigworlds')).data.find(w => w.id === wo.id).order === 3, '世界也可以設定順序 ID');
    ok((await j('PUT', '/api/characters/nope123/order', { order: 1 })).status === 404, '找不到角色：404');
    await j('DELETE', `/api/bigworlds/${wo.id}`);
    await j('DELETE', `/api/characters/${oc}`);
  }

  // ===== 聊天紀錄上限（預設：角色 16k、大世界 32k；每段對話可以另外指定） =====
  r = await j('GET', '/api/settings');
  ok(r.data.settings.history_cap_char === 16000 && r.data.settings.history_cap_world === 32000, '聊天紀錄上限的預設：角色 16k、大世界 32k');
  await j('PUT', '/api/settings', { memory_enabled: false });
  r = await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid2 });
  ok(r.data.info.history_cap === 16000 && r.data.info.history_used === r.data.info.history_total, '角色對話套用預設上限（短對話全部送出）', JSON.stringify(r.data.info.history_cap));
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { history_cap: 300 });
  ok(r.data.history_cap === 300, '對話設定：這段對話自己指定上限');
  r = await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid2 });
  const capSent = r.data.messages.map(m => m.content).join('\n');
  ok(r.data.info.history_cap === 300 && r.data.info.history_used < r.data.info.history_total && capSent.includes('MSG_39') && !capSent.includes('MSG_0 '), '上限生效：只送最近、放得下的聊天紀錄', `${r.data.info.history_used}/${r.data.info.history_total}`);
  ev = await gen({ char_id: id, chat_id: tcid2, mode: 'regenerate' });
  ok(!lastReq().messages.some(m => m.content.includes('MSG_0 ')), '實際送出時也套用這段對話的上限');
  r = await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid });
  ok(r.data.info.history_cap === 16000, '只對那段對話有效，其他對話不受影響');
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { history_cap: null });
  ok(!('history_cap' in r.data), '改回「跟隨預設」');
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { history_cap: 0 });
  ok(r.data.history_cap === 0 && (await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid2 })).data.info.history_cap === 0, '可以設成「不限」');
  await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { history_cap: null });
  // 對話設定：這段對話自己的上下文長度、Temperature、回覆長度
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { context_tokens: 9000, temperature: 0.425, max_tokens: 777.4 });
  ok(r.data.context_tokens === 9000 && r.data.temperature === 0.43 && r.data.max_tokens === 777, '對話設定：存下這段對話的上下文長度、Temperature、回覆長度', JSON.stringify(r.data));
  ok((await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid2 })).data.info.context_tokens === 9000, '組提示詞時用這段對話的上下文長度');
  await gen({ char_id: id, chat_id: tcid2, mode: 'normal', user_message: '對話專屬參數' });
  ok(lastReq().temperature === 0.43 && lastReq().max_tokens === 777, '實際送出時用這段對話的 Temperature 與回覆長度', JSON.stringify({ t: lastReq().temperature, m: lastReq().max_tokens }));
  const genOther = (await j('POST', `/api/characters/${id}/chats`, {})).data.id; // 另開一段（不影響後面計算用量的那段對話）
  await gen({ char_id: id, chat_id: genOther, mode: 'normal', user_message: '其他對話' });
  ok(lastReq().temperature === 0.9 && lastReq().max_tokens === 4096, '其他對話照樣用模型設定的參數', JSON.stringify({ t: lastReq().temperature, m: lastReq().max_tokens }));
  await j('DELETE', `/api/characters/${id}/chats/${genOther}`);
  for (const bad of [{ temperature: 3 }, { max_tokens: 0 }, { context_tokens: 'abc' }]) {
    r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, bad);
    ok(r.status === 400, '對話設定：超出範圍的參數被拒絕 ' + JSON.stringify(bad));
  }
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { context_tokens: null, temperature: null, max_tokens: null });
  ok(!('context_tokens' in r.data) && !('temperature' in r.data) && !('max_tokens' in r.data), '對話設定：改回跟隨模型設定');
  // 對話設定：這段對話的思考檔位（送出前換成各供應商的參數）
  const thinkChat = (await j('POST', `/api/characters/${id}/chats`, {})).data.id;
  r = await j('PUT', `/api/characters/${id}/chats/${thinkChat}`, { think: 'high' });
  ok(r.data.think === 'high', '對話設定：存下這段對話的思考檔位');
  await gen({ char_id: id, chat_id: thinkChat, mode: 'normal', user_message: '想深一點' });
  ok(lastReq().reasoning_effort === 'high', 'OpenAI 相容：送出這段對話的思考程度', JSON.stringify(lastReq().reasoning_effort));
  await j('PUT', `/api/characters/${id}/chats/${thinkChat}`, { think: 'off' });
  await gen({ char_id: id, chat_id: thinkChat, mode: 'normal', user_message: '不用想' });
  ok(lastReq().reasoning_effort === 'none', '「關閉」送出 none');
  const thinkOther = (await j('POST', `/api/characters/${id}/chats`, {})).data.id;
  await gen({ char_id: id, chat_id: thinkOther, mode: 'normal', user_message: '其他對話' });
  ok(!('reasoning_effort' in lastReq()), '其他對話照樣跟隨模型設定（沒指定就不送）');
  // 模擬思考：關閉原生思考（送 none），提示詞最後要求先在 <thinking> 裡規劃；之前回覆裡的思考不會再送出
  await j('PUT', '/api/settings', { openai: { reasoning_effort: 'high' } });
  await j('PUT', `/api/characters/${id}/chats/${thinkChat}`, { think: 'sim' });
  const simChat = (await j('GET', `/api/characters/${id}/chats/${thinkChat}`)).data;
  simChat.messages.push({ role: 'user', content: '問題', time: Date.now() }, { role: 'assistant', content: '<thinking>舊的思考SECRET</thinking>舊的回覆', time: Date.now() + 1 },
    { role: 'user', content: '再問', time: Date.now() + 2 }, { role: 'assistant', content: '<think>原生SECRET2</think>第二則回覆', time: Date.now() + 3 });
  await j('PUT', `/api/characters/${id}/chats/${thinkChat}`, { messages: simChat.messages });
  await gen({ char_id: id, chat_id: thinkChat, mode: 'normal', user_message: '模擬一下' });
  const simReq = lastReq(), simAll = simReq.messages.map(m => m.content).join('\n');
  ok(simReq.reasoning_effort === 'none' && /\[回覆前先思考\][\s\S]*<\/thinking>/.test(simReq.messages.at(-1).content + simReq.messages.at(-2).content)
    && !simAll.includes('SECRET') && simAll.includes('舊的回覆') && simAll.includes('第二則回覆'), '模擬思考：關閉原生思考（模型設定檔是 high 也一樣）、提示詞要求先思考、舊的思考不再送出', JSON.stringify({ effort: simReq.reasoning_effort, tail: simReq.messages.slice(-2) }));
  // 不認得 reasoning_effort 的模型：被拒絕後拿掉參數重送，並記住（之後一開始就不送）
  {
    const nrLog = path.join(LOGDIR, 'noreason.log');
    try { fs.unlinkSync(nrLog); } catch {}
    await j('PUT', '/api/settings', { openai: { model: 'noreason' } });
    r = await gen({ char_id: id, chat_id: thinkChat, mode: 'normal', user_message: '不會思考的模型' });
    const first = fs.readFileSync(nrLog, 'utf8').split('\n').filter(Boolean);
    await gen({ char_id: id, chat_id: thinkChat, mode: 'normal', user_message: '再一次' });
    const all = fs.readFileSync(nrLog, 'utf8').split('\n').filter(Boolean);
    ok(first.join('') === 'R-' && all.join('') === 'R--' && !('reasoning_effort' in lastReq()),
      '不認得 reasoning_effort 的模型：被拒絕後拿掉重送、之後不再送', JSON.stringify(all));
    await j('PUT', '/api/settings', { openai: { model: 'mock-a' } });
  }
  await j('PUT', '/api/settings', { openai: { reasoning_effort: '' } });
  r = await j('PUT', `/api/characters/${id}/chats/${thinkChat}`, { think: 'max' });
  ok(r.status === 400, '對話設定：不認得的思考檔位被拒絕');
  r = await j('PUT', `/api/characters/${id}/chats/${thinkChat}`, { think: null });
  ok(!('think' in r.data), '思考檔位改回跟隨模型設定');
  for (const c of [thinkChat, thinkOther]) await j('DELETE', `/api/characters/${id}/chats/${c}`);
  // 兩個視窗開著同一段對話：舊畫面整份送回訊息時，不能把另一個視窗剛產生的訊息蓋掉
  {
    const vc = (await j('POST', `/api/characters/${id}/chats`, {})).data.id;
    const url = `/api/characters/${id}/chats/${vc}`;
    const oldView = (await j('GET', url)).data; // 視窗 A 讀到的
    ok(typeof oldView.msg_ver === 'string', '讀取對話時附上訊息的版本');
    await gen({ char_id: id, chat_id: vc, mode: 'normal', user_message: '視窗 B 的新訊息' }); // 視窗 B 產生新訊息
    const edited = oldView.messages.map(m => ({ ...m, content: m.content + '（A 改的）' }));
    r = await j('PUT', url, { messages: edited, base_ver: oldView.msg_ver });
    const now = (await j('GET', url)).data;
    ok(r.status === 409 && now.messages.some(m => m.content.includes('視窗 B 的新訊息')), '舊畫面存檔：版本對不上就拒絕，不會蓋掉新訊息', r.status);
    r = await j('PUT', url, { messages: now.messages.map(m => ({ ...m })), base_ver: now.msg_ver });
    ok(r.status === 200 && r.data.msg_ver === now.msg_ver, '版本對得上就照常存檔');
    r = await j('PUT', url, { title: '只改名稱' });
    ok(r.status === 200 && r.data.msg_ver === now.msg_ver, '只改名稱、記憶等：訊息版本不變（不會害另一個視窗存不了檔）');
    // 一次刪掉好幾則：刪除前的完整對話留一份在垃圾桶
    const trash0 = (await j('GET', '/api/trash')).data.items.filter(t => t.kind === 'chats').length;
    r = await j('PUT', url, { messages: now.messages.slice(0, 1), base_ver: now.msg_ver, snapshot: 'delete' });
    const trash1 = (await j('GET', '/api/trash')).data.items.filter(t => t.kind === 'chats');
    ok(r.status === 200 && trash1.length === trash0 + 1 && trash1.some(t => /刪除訊息前/.test(t.title)), '刪除此則及之後：刪除前的完整對話留一份在垃圾桶', JSON.stringify(trash1.map(t => t.title)));
    await j('DELETE', url);
  }
  // 對話設定：這段對話的你（名字與人設）
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { user_name: '  阿明  ', user_persona: 'CHAT_PERSONA 這段對話的身分' });
  ok(r.data.user_name === '阿明' && r.data.user_persona.startsWith('CHAT_PERSONA'), '對話設定：這段對話的名字與人設');
  r = await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid2 });
  ok(r.data.messages[0].content.includes('[阿明 的人設]\nCHAT_PERSONA'), '這段對話的名字與人設放進提示詞（取代設定頁的）');
  ok(!(await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid })).data.messages[0].content.includes('CHAT_PERSONA'), '其他對話照樣用設定頁的');
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { user_name: '', user_persona: ' ' });
  ok(!('user_name' in r.data) && !('user_persona' in r.data), '清空＝改回用設定頁的');
  // 對話設定：這段對話停用某本世界書（角色連結的世界書有常駐條目 WI_CONST）
  r = await j('GET', `/api/characters/${id}/chats/${tcid2}/books`);
  ok(r.data.some(b => b.key === 'w:' + wid && b.source === '連結' && b.count === 4 && !b.off), '對話設定：列出這段對話會用到的世界書', JSON.stringify(r.data));
  ok(JSON.stringify((await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid2 })).data.messages).includes('WI_CONST'), '世界書預設啟用');
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { books_off: ['w:' + wid, '../壞掉的'] });
  ok(JSON.stringify(r.data.books_off) === JSON.stringify(['w:' + wid]), '停用世界書（不合法的 key 會被忽略）');
  ok(!JSON.stringify((await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid2 })).data.messages).includes('WI_CONST')
    && (await j('GET', `/api/characters/${id}/chats/${tcid2}/books`)).data.find(b => b.key === 'w:' + wid).off, '停用後這段對話不再送出那本世界書');
  ok(JSON.stringify((await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid })).data.messages).includes('WI_CONST'), '只影響這段對話');
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { books_off: [] });
  ok(!('books_off' in r.data), '全部重新啟用');
  // ===== 使用者設定檔（名字、人設與頭像） =====
  r = await j('GET', '/api/personas');
  const psDef = r.data.active;
  ok(r.data.personas.length === 1 && r.data.personas[0].user_name === '旅人', '改名字時，使用中的預設設定檔一起更新', JSON.stringify(r.data));
  r = await j('PUT', '/api/settings', { user_name: '   ' });
  ok(r.status === 400 && (await j('GET', '/api/settings')).data.settings.user_name === '旅人', '使用者名稱不能空白');
  r = await j('POST', '/api/personas', { name: '空白', user_name: '' });
  ok(r.status === 400 && (await j('GET', '/api/personas')).data.personas.length === 1, '新增使用者設定檔：名字空白時拒絕');
  await j('PUT', '/api/settings', { active_persona: null });
  ok((await j('GET', '/api/personas')).data.active === psDef, '設定 API 不能取消使用中的設定檔');
  await j('PUT', '/api/settings', { user_name: '騎士', user_persona: 'PERSONA_KNIGHT' });
  await j('PUT', '/api/user/avatar', { image: 'data:image/png;base64,' + pngBuf.toString('base64') });
  r = await j('POST', '/api/personas', { name: '冒險者' });
  const psA = r.data.id;
  ok(r.data.active === psA && r.data.personas.some(p => p.id === psA && p.user_name === '騎士' && p.user_persona === 'PERSONA_KNIGHT' && p.avatar_ver > 0), '把目前的名字、人設與頭像存成使用者設定檔', JSON.stringify(r.data));
  ok(fs.existsSync(path.join(TD, 'personas', psA + '.png')), '使用者設定檔的頭像另外存一份');
  ok(!fs.existsSync(path.join(TD, 'user-avatar.png')) && fs.existsSync(path.join(TD, 'personas', psDef + '.png')) && (await fetch(B + '/api/user/avatar')).status === 200,
    '你的頭像就是使用中設定檔的頭像：不再另外存 user-avatar.png');
  await j('PUT', '/api/settings', { user_persona: 'PERSONA_KNIGHT2' });
  ok((await j('GET', '/api/personas')).data.personas.find(p => p.id === psA).user_persona === 'PERSONA_KNIGHT2', '使用中時，改了人設會一起更新設定檔');
  r = await j('POST', '/api/personas', { name: '旅人本人', user_name: ' 旅人 ', user_persona: '' });
  const psB = r.data.id;
  ok(r.data.active === psB && r.data.personas.find(p => p.id === psB).user_name === '旅人'
    && r.data.personas.find(p => p.id === psA).user_name === '騎士', '用指定的名字與人設建立新設定檔：原本使用中的不會被改到');
  r = await j('POST', `/api/personas/${psA}/apply`);
  ok(r.status === 200 && r.data.settings.user_name === '騎士' && r.data.settings.user_persona === 'PERSONA_KNIGHT2' && r.data.active === psA, '切換使用者設定檔：名字與人設換成它的');
  r = await j('PUT', `/api/personas/${psA}`, { name: '冒險者二號' });
  ok(r.data.personas.find(p => p.id === psA).name === '冒險者二號', '重新命名使用者設定檔');
  await j('POST', `/api/personas/${psB}/apply`);
  ok((await j('GET', '/api/settings')).data.settings.user_name === '旅人', '切回另一個設定檔');
  // 對話設定：這段對話用某個使用者設定檔
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { persona_id: psA });
  ok(r.data.persona_id === psA, '對話設定：這段對話指定使用者設定檔');
  r = await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid2 });
  ok(r.data.messages[0].content.includes('[騎士 的人設]\nPERSONA_KNIGHT2'), '這段對話用那個設定檔的名字與人設');
  ok(!(await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid })).data.messages[0].content.includes('PERSONA_KNIGHT'), '其他對話照樣用設定頁的');
  r = await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { persona_id: 'nope' });
  ok(r.status === 404, '指定不存在的使用者設定檔：拒絕');
  r = await j('PUT', '/api/settings', { personas: [] });
  ok(r.data.settings.personas.length === 3, '設定 API 不能直接覆寫使用者設定檔清單');
  r = await j('DELETE', `/api/personas/${psA}`);
  ok(!r.data.personas.some(p => p.id === psA) && !fs.existsSync(path.join(TD, 'personas', psA + '.png')), '刪除使用者設定檔（連同頭像）');
  ok(!(await j('POST', '/api/prompt-preview', { char_id: id, chat_id: tcid2 })).data.messages[0].content.includes('PERSONA_KNIGHT'), '設定檔刪掉後，指定它的對話改回用設定頁的');
  // 新增使用者設定檔時另外選頭像：存成它自己的頭像（也成為目前的頭像）；選「移除」就沒有頭像
  r = await j('POST', '/api/personas', { name: '新頭像', avatar: 'data:image/png;base64,' + pngBuf.toString('base64') });
  const psC = r.data.id;
  ok(r.data.personas.find(p => p.id === psC).avatar_ver > 0 && (await j('GET', '/api/settings')).data.settings.user_avatar > 0, '新增時選的頭像存成那個設定檔的頭像');
  r = await j('POST', '/api/personas', { name: '沒頭像', avatar: null });
  const psD = r.data.id;
  ok(r.data.personas.find(p => p.id === psD).avatar_ver === 0 && r.data.personas.find(p => p.id === psC).avatar_ver > 0
    && (await j('GET', '/api/settings')).data.settings.user_avatar === 0, '新增時選「移除」：這個設定檔沒有頭像，其他設定檔的頭像不受影響');
  await j('POST', `/api/personas/${psC}/apply`);
  ok((await j('GET', '/api/settings')).data.settings.user_avatar > 0, '切回有頭像的設定檔：頭像跟著換回來');
  await j('DELETE', `/api/personas/${psC}`); await j('DELETE', `/api/personas/${psD}`);
  await j('PUT', `/api/characters/${id}/chats/${tcid2}`, { persona_id: null });
  r = await j('DELETE', `/api/personas/${psB}`);
  ok(r.data.active === psDef && (await j('GET', '/api/settings')).data.settings.user_name === '騎士', '刪掉使用中的設定檔：改用剩下的第一個');
  await j('PUT', '/api/user/avatar', { image: 'data:image/png;base64,' + pngBuf.toString('base64') });
  r = await j('DELETE', `/api/personas/${psDef}`);
  const stDef = (await j('GET', '/api/settings')).data.settings;
  ok(r.data.personas.length === 1 && r.data.active !== psDef && r.data.personas[0].name === 'User' && r.data.personas[0].avatar_ver === 0
    && stDef.user_name === 'User' && stDef.user_persona === '' && stDef.user_avatar === 0, '設定檔全部刪光：自動還原並套用預設的 User', JSON.stringify(r.data));
  await j('PUT', '/api/settings', { user_name: '旅人' }); // 後面的測試用這個名字
  await j('PUT', '/api/settings', { memory_enabled: true });

  // ===== 搜尋訊息內容（U1） =====
  r = await j('GET', '/api/search?q=' + encodeURIComponent('msg_31'));
  ok(r.data.some(x => x.chat === tcid && x.owner === id && x.index === 31 && x.snippet.includes('MSG_31')), '搜尋所有對話的訊息內容（不分大小寫，附上第幾則）', JSON.stringify(r.data).slice(0, 200));
  r = await j('GET', '/api/search?q=' + encodeURIComponent('第'));
  ok(Array.isArray(r.data) && r.data.length === 0, '少於兩個字不搜尋');

  // ===== 實際用量（T3） =====
  let uc = (await j('GET', `/api/characters/${id}/chats/${tcid}`)).data;
  // 這段對話：壓縮時整理記憶 1 次＋生成 3 次
  ok(uc.usage && uc.usage.input === 1234 * 4 && uc.usage.output === 56 * 4 && uc.usage.calls === 4 && uc.messages.at(-1).usage?.cached === 1000, 'T3：記錄每則與整段對話實際用掉的 token（含整理記憶）', JSON.stringify(uc.usage));
  ok(lastReq().stream_options?.include_usage === true, 'T3：請 API 回報用量');
  await j('PUT', '/api/settings', { openai: { model: 'nousage' } });
  ev = await gen({ char_id: id, chat_id: tcid, mode: 'regenerate' });
  ok(!ev.some(e => e.type === 'error') && !lastReq().stream_options, 'T3：平台不支援回報用量時自動改不要', JSON.stringify(ev.find(e => e.type === 'error')));

  // ===== 自動重試（R1） =====
  await j('PUT', '/api/settings', { openai: { model: 'flaky' }, retry_max: 1 });
  ev = await gen({ char_id: id, chat_id: tcid, mode: 'regenerate' });
  ok(ev.some(e => e.type === 'retry' && e.attempt === 1 && e.max === 1) && ev.some(e => e.type === 'done') && !ev.some(e => e.type === 'error'), 'R1：暫時失敗時自動重試，成功後照常完成');
  await j('PUT', '/api/settings', { openai: { model: 'down' } });
  ev = await gen({ char_id: id, chat_id: tcid, mode: 'regenerate' });
  const rErr = ev.find(e => e.type === 'error');
  ok(ev.filter(e => e.type === 'retry').length === 1 && rErr && rErr.error.includes('已自動重試 1 次'), 'R1：重試次數有上限，用完才顯示錯誤', JSON.stringify(rErr));
  await j('PUT', '/api/settings', { openai: { model: 'down' }, retry_max: 0 });
  ev = await gen({ char_id: id, chat_id: tcid, mode: 'regenerate' });
  ok(!ev.some(e => e.type === 'retry') && ev.some(e => e.type === 'error'), 'R1：重試次數設 0 就不重試');
  // AI 什麼都沒回：不再默默存成空訊息；沒有結束原因時自動重試，最後顯示原因
  await j('PUT', '/api/settings', { openai: { model: 'empty' }, retry_max: 1 });
  ev = await gen({ char_id: id, chat_id: tcid, mode: 'regenerate' });
  const eErr = ev.find(e => e.type === 'error');
  ok(ev.filter(e => e.type === 'retry').length === 1 && eErr && /沒有回傳任何內容/.test(eErr.error) && eErr.error.includes('已自動重試 1 次'), '空回應：自動重試一次，還是空的就顯示錯誤（不會默默存成空訊息）', JSON.stringify(eErr));
  await j('PUT', '/api/settings', { openai: { model: 'blocked' } });
  ev = await gen({ char_id: id, chat_id: tcid, mode: 'regenerate' });
  const bErr = ev.find(e => e.type === 'error');
  ok(!ev.some(e => e.type === 'retry') && bErr && /安全過濾/.test(bErr.error) && bErr.error.includes('content_filter'), '被安全過濾擋下：直接說明原因（重試也沒用，不重試）', JSON.stringify(bErr));
  await j('PUT', '/api/settings', { openai: { model: 'mock-a' }, retry_max: 2 });

  // ===== 導演只讀最近幾則（T2） =====
  const wkey3 = 'world-' + (await j('POST', '/api/bigworlds', { data: { name: '導演測試鎮', turn_mode: 'turns', max_replies: 1, members: [{ id }, { id: card2.id }] } })).data.id;
  const dch = (await j('POST', `/api/characters/${wkey3}/chats`, {})).data;
  const wmany = Array.from({ length: 30 }, (_, i) => (i % 2 ? { role: 'assistant', speaker: card2.id, content: `W_${i}號` } : { role: 'user', content: `W_${i}號` }));
  await j('PUT', `/api/characters/${wkey3}/chats/${dch.id}`, { messages: wmany });
  await j('PUT', '/api/settings', { director_history: 6 });
  let dn0 = logLines().length;
  await gen({ char_id: wkey3, chat_id: dch.id, mode: 'normal', user_message: '導演看幾則' });
  let drs = reqsSince(dn0);
  const dText = q => q.messages.map(m => m.content).join('\n');
  ok(dText(drs[0]).includes('[導演指示') && dText(drs[0]).includes('W_25號') && !dText(drs[0]).includes('W_24號') && dText(drs[1]).includes('W_0號'), 'T2：導演只讀最近 6 則，角色照常讀完整的聊天紀錄');
  await j('PUT', '/api/settings', { director_history: 0 });
  dn0 = logLines().length;
  await gen({ char_id: wkey3, chat_id: dch.id, mode: 'normal', user_message: '導演看全部' });
  drs = reqsSince(dn0);
  ok(dText(drs[0]).includes('W_0號'), 'T2：設成「全部」時導演和角色讀一樣的聊天紀錄');
  await j('PUT', '/api/settings', { director_history: 20 });

  // ===== 你扮演的 NPC、你寫的旁白 =====
  const nc0 = (await j('POST', `/api/characters/${id}/chats`, {})).data.id;
  r = await j('POST', `/api/characters/${id}/chats/${nc0}/messages`, { content: '我推門走進酒館。' });
  ok(r.status === 200 && r.data.messages.at(-1).role === 'user' && !r.data.messages.at(-1).npc, '只加入、不回應：你的角色');
  r = await j('POST', `/api/characters/${id}/chats/${nc0}/messages`, { content: '「歡迎光臨，今晚只剩一間房。」', npc: '  酒館老闆 ' });
  ok(r.data.messages.at(-1).npc === '酒館老闆' && r.data.messages.at(-1).role === 'user' && JSON.stringify(r.data.npcs) === '["酒館老闆"]', '只加入、不回應：用 NPC 的身分（自動加進 NPC 名單）');
  ok((await j('POST', `/api/characters/${id}/chats/${nc0}/messages`, { content: '  ' })).status === 400, '空白訊息不能加入');
  ev = await gen({ char_id: id, chat_id: nc0, mode: 'normal', user_message: '' });
  let nreq = lastReq();
  const roles = nreq.messages.map(m => m.role);
  const lastUserMsg = nreq.messages.filter(m => m.role === 'user').at(-1).content;
  ok(!roles.some((ro, k) => ro === 'user' && roles[k + 1] === 'user'), '連續的你這一側發言合併成一則（不會有兩則連續的使用者訊息）', roles.join(','));
  ok(lastUserMsg.includes('旅人：我推門走進酒館。') && lastUserMsg.includes('酒館老闆（NPC，由旅人扮演）：「歡迎光臨'), '合併時各自標上身分', lastUserMsg);
  ok(nreq.messages[0].content.includes('[由 旅人 扮演的 NPC]\n酒館老闆') && nreq.messages[0].content.includes('可以和他們互動、對他們說話，但不要替他們說話')
    && !nreq.messages[0].content.includes('不是這個世界的登場角色'), '提示詞說明哪些是你扮演的 NPC（角色對話不提「世界」）');
  ev = await gen({ char_id: id, chat_id: nc0, mode: 'normal', user_message: '夜色漸深，雨開始下了。', narration: true });
  nreq = lastReq();
  ok(nreq.messages.filter(m => m.role === 'user').at(-1).content.startsWith('（旁白，由旅人撰寫）夜色漸深') && nreq.messages[0].content.includes('[旅人 撰寫的旁白]'), '你寫的旁白：標上身分並說明');
  let nchat = (await j('GET', `/api/characters/${id}/chats/${nc0}`)).data;
  ok(nchat.messages.at(-2).narration === true && nchat.messages.at(-2).role === 'user', '你寫的旁白存成你這一側的訊息');
  await gen({ char_id: id, chat_id: nc0, mode: 'regenerate' });
  nchat = (await j('GET', `/api/characters/${id}/chats/${nc0}`)).data;
  ok(nchat.messages.at(-2).narration === true && nchat.messages.at(-2).content.startsWith('夜色漸深') && nchat.messages.filter(m => m.npc === '酒館老闆').length === 1, '重新生成只重寫 AI 的回應，不會動到你寫的 NPC 台詞與旁白');
  await j('PUT', '/api/settings', { memory_enabled: true });
  await j('POST', `/api/characters/${id}/chats/${nc0}/memory`, { full: true });
  const mreq2 = lastReq().messages[1].content;
  ok(mreq2.includes('酒館老闆（NPC，由旅人扮演）：「歡迎光臨') && mreq2.includes('不是 旅人 本人說的'), '整理記憶時標上 NPC 身分並提醒記錄員');
  r = await j('PUT', `/api/characters/${id}/chats/${nc0}`, { npcs: ['酒館老闆', '守衛', '守衛', '', 5] });
  ok(JSON.stringify(r.data.npcs) === '["酒館老闆","守衛"]', 'NPC 名單：去掉重複與不合法的');
  r = await j('GET', '/api/settings');
  ok(!/NPC|旁白，由/.test(r.data.settings.main_prompt) && !/NPC/.test(r.data.settings.world_prompt) && r.data.settings.memory_prompt.includes('（NPC，由{{user}}扮演）'),
    '主要／大世界提示詞不寫 NPC 規則（用到時才自動加說明，不重複）；記憶整理的提示詞照樣有');

  // ===== 對話設定：大世界每輪最多幾位角色接話（這個世界設定 1 位） =====
  await j('PUT', '/api/settings', { director_history: 20 });
  r = await j('PUT', `/api/characters/${wkey3}/chats/${dch.id}`, { max_replies: 3 });
  ok(r.data.max_replies === 3, '對話設定：這段對話每輪最多 3 位接話');
  let mr0 = logLines().length;
  await gen({ char_id: wkey3, chat_id: dch.id, mode: 'normal', user_message: '大家好' });
  ok(dText(reqsSince(mr0)[0]).includes('發言的角色最多 3 位'), '導演依這段對話的設定安排人數');
  r = await j('PUT', `/api/characters/${wkey3}/chats/${dch.id}`, { max_replies: null });
  mr0 = logLines().length;
  await gen({ char_id: wkey3, chat_id: dch.id, mode: 'normal', user_message: '再一次' });
  ok(!('max_replies' in r.data) && dText(reqsSince(mr0)[0]).includes('發言的角色最多 1 位'), '改回跟隨世界設定');
  // 大世界：你扮演的 NPC 說話後，導演知道那是 NPC（不是你的角色）
  mr0 = logLines().length;
  await gen({ char_id: wkey3, chat_id: dch.id, mode: 'normal', user_message: '「站住！出示通行證。」', npc: '城門守衛' });
  const npcDir = dText(reqsSince(mr0)[0]);
  ok(npcDir.includes('城門守衛（NPC，由旅人扮演）：「站住') && npcDir.includes('[由 旅人 扮演的 NPC]'), '大世界：導演知道這句是你扮演的 NPC 說的');
  ok(reqsSince(mr0).slice(1).some(q => JSON.stringify(q.messages).includes('他們不是這個世界的登場角色')), '大世界：NPC 說明加上「不是這個世界的登場角色」');

  // ===== 外觀設定 =====
  r = await j('GET', '/api/settings');
  ok(r.data.settings.appearance.motion === 'on' && r.data.settings.appearance.background === 'stars' && r.data.settings.bg_ver === 0, '外觀預設：開啟動畫、星空背景、沒有背景圖');
  r = await j('PUT', '/api/settings', { appearance: { motion: 'off', background: 'image', bg_dim: 0.4, accent: '#ff8fb8', font_size: 17 } });
  ok(r.data.settings.appearance.motion === 'off' && r.data.settings.appearance.accent === '#ff8fb8' && r.data.settings.appearance.font_size === 17, '儲存外觀設定');
  r = await j('PUT', '/api/appearance/background', { image: 'data:image/png;base64,' + pngBuf.toString('base64') });
  const bgRes = await fetch(`${B}/api/appearance/background`);
  ok(r.data.bg_ver > 0 && bgRes.status === 200 && (await j('GET', '/api/settings')).data.settings.bg_ver === r.data.bg_ver, '上傳自訂背景圖');
  r = await j('PUT', '/api/appearance/background', { image: 'data:image/jpeg;base64,/9j/4AAQ' });
  ok(r.status === 400, '背景圖只接受 PNG');
  r = await j('PUT', '/api/appearance/background', { image: null });
  ok(r.data.bg_ver === 0 && (await fetch(`${B}/api/appearance/background`)).status === 404, '移除背景圖');
  await j('PUT', '/api/settings', { appearance: { motion: 'system', background: 'stars', bg_dim: 0.55, accent: '', font_size: 15 } });
  ok((await j('GET', '/api/settings')).data.settings.appearance.motion === 'on', '舊版的「跟隨系統」動畫視為開啟');

  // 對話清單快取：對話檔變動後，清單要立刻反映
  const anyChat = (await j('GET', '/api/chats')).data[0];
  const full = (await j('GET', `/api/characters/${anyChat.char.id}/chats/${anyChat.id}`)).data;
  await j('PUT', `/api/characters/${anyChat.char.id}/chats/${anyChat.id}`, { messages: [...full.messages, { role: 'user', content: '快取測試' }], title: '快取測試標題' });
  const after2 = (await j('GET', '/api/chats')).data.find(c => c.id === anyChat.id);
  ok(after2.count === full.messages.length + 1 && after2.title === '快取測試標題', '對話清單快取會跟著檔案更新');

  // 聊天紀錄的狀態欄只保留最近幾則
  const { trimOldDetails } = require(path.join(PROJ, 'lib/prompt.js'));
  const hist = Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', content: `台詞${i}\n<details><summary>狀態</summary>S${i}</details>` }));
  const kept = trimOldDetails(hist, 3);
  ok(kept.filter(m => m.content.includes('<details')).length === 3 && kept[5].content.includes('S5') && !kept[0].content.includes('S0') && kept[0].content === '台詞0', '狀態欄只保留最近 3 則（台詞保留）');
  ok(trimOldDetails(hist, 1).filter(m => m.content.includes('<details')).length === 3, '狀態欄保留則數最少 3');
  // 聊天紀錄放不下時，舊訊息以 8 則為單位捨棄
  const { buildPrompt } = require(path.join(PROJ, 'lib/prompt.js'));
  const longHist = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '訊息'.repeat(40) + i }));
  {
    // 聊天紀錄實際的空間：上下文長度扣掉固定部分後剩下的（還沒套用上限）；上限比它大時送不滿
    const big = 'x'.repeat(4000);
    const a = buildPrompt({ card: { name: 'A', description: big }, history: [{ role: 'user', content: 'hi' }], settings: { context_tokens: 8000, max_tokens: 1000, history_cap: 32000, user_name: 'U' }, books: [] }).info;
    const b = buildPrompt({ card: { name: 'A' }, history: [{ role: 'user', content: 'hi' }], settings: { context_tokens: 8000, max_tokens: 1000, history_cap: 32000, user_name: 'U' }, books: [] }).info;
    ok(a.history_room > 0 && a.history_room < b.history_room && b.history_room <= 7000 && a.history_room >= a.history_budget, '回報聊天紀錄實際的空間（角色設定越長越少）', JSON.stringify({ a: a.history_room, b: b.history_room }));
  }
  const used = n => buildPrompt({ card: { name: 'A' }, history: longHist.slice(0, n), settings: { context_tokens: 2000, max_tokens: 200, user_name: 'U' }, books: [] }).info.history_used;
  const u1 = used(40), u2 = used(41);
  ok((40 - u1) % 8 === 0 && (41 - u2) % 8 === 0 && u1 > 0, '聊天紀錄以 8 則為單位捨棄', `${u1} / ${u2}`);

  // ===== 備份（R2）、匯出與匯入（U5） =====
  const zlib = require('zlib');
  await j('PUT', '/api/settings', { backup_keep: 2 });
  r = await j('POST', '/api/backups');
  ok(r.status === 200 && /^backup-\d{8}-\d{6}/.test(r.data.name) && r.data.images_size > 0, '立即備份（圖片另外存一份、多份共用）', JSON.stringify(r.data).slice(0, 200));
  const b1 = r.data.name;
  const bk = require(path.join(PROJ, 'lib/backup.js'));
  ok(/-manual\.tavern$/.test(b1) && r.data.items.find(b => b.name === b1)?.kind === 'manual', '手動備份標成「手動」');
  ok(typeof bk.startupBackup(2) === 'string' && bk.startupBackup(2) === null, '資料沒有變動時，啟動備份不會重複建立（和最新一份自動備份比）');
  await j('POST', '/api/characters', { data: { name: 'BACKUP_MARK 角色' } });
  ok(typeof bk.startupBackup(2) === 'string', '資料有變動就建立新備份');
  await j('POST', '/api/characters', { data: { name: 'BACKUP_MARK2 角色' } });
  bk.startupBackup(2);
  let bkItems = (await j('GET', '/api/backups')).data.items;
  ok(bkItems.filter(b => b.kind === 'auto').length === 2 && bkItems.some(b => b.name === b1), '超過保留份數的自動備份會刪掉；手動備份不參與輪替', JSON.stringify(bkItems.map(b => b.name)));
  // 自動備份關閉（0 份）時按「立即備份」：不會刪掉其他備份
  await j('PUT', '/api/settings', { backup_keep: 0 });
  const before0 = bkItems.length;
  r = await j('POST', '/api/backups');
  ok(r.status === 200 && r.data.items.length === before0 + 1, '自動備份關閉時，立即備份不會刪掉其他備份', `${before0} → ${r.data.items.length}`);
  await j('DELETE', `/api/backups/${r.data.name}`);
  await j('PUT', '/api/settings', { backup_keep: 2 });
  // 分層保留：最近幾份＋最近幾天每天一份（一天重開好幾次，也不會把前幾天的備份輪替掉）
  {
    const BKD0 = path.join(TD, 'backups');
    const fake = ['20260101-090000', '20260102-090000', '20260103-080000', '20260103-090000', '20260104-090000'].map(t => `backup-${t}.tavern`);
    const src = fs.readFileSync(path.join(BKD0, bkItems.find(b => b.kind === 'auto').name));
    for (const n of fake) fs.writeFileSync(path.join(BKD0, n), src);
    bk.pruneBackups(2);
    const left = bk.backupStatus().items.map(b => b.name);
    // 最近 2 份（今天的兩份自動備份）＋最近 2 天每天最後一份（今天、01/04）；01/01～01/03 刪掉
    ok(left.includes('backup-20260104-090000.tavern') && !left.includes('backup-20260103-090000.tavern') && !left.includes('backup-20260101-090000.tavern') && left.includes(b1),
      '分層保留：最近 2 份＋最近 2 天各一份；手動備份不刪', JSON.stringify(left));
    for (const n of fake) fs.rmSync(path.join(BKD0, n), { force: true });
    ok(fs.existsSync(path.join(BKD0, 'index.json')) && JSON.parse(fs.readFileSync(path.join(BKD0, 'index.json'), 'utf8'))[b1], '備份的圖片索引：記下每份備份用到哪些圖片');
  }
  const blobFiles = () => fs.readdirSync(path.join(TD, 'backups', 'blobs'));
  const blobCount = blobFiles().length;
  const exp = await fetch(B + '/api/export');
  const expBuf = Buffer.from(await exp.arrayBuffer());
  const expBundle = JSON.parse(zlib.gunzipSync(expBuf).toString('utf8'));
  ok(exp.headers.get('content-disposition').includes('attachment') && Object.entries(expBundle.files).some(([k, v]) => k.endsWith('.png') && v.b) && !JSON.stringify(expBundle).includes('api_key'), '匯出全部資料：圖片包含在檔案裡、不含 API 金鑰');
  ok(Object.keys(expBundle.files).some(k => /^char\/[^/]+\/chats\/[^/]+\.json$/.test(k)) && expBundle.files['settings.json'], '匯出包含對話與設定');
  const charsBefore = (await j('GET', '/api/characters')).data.length;
  await j('POST', '/api/characters', { data: { name: 'AFTER_EXPORT 角色' } });
  r = await j('POST', '/api/import', expBuf, { 'Content-Type': 'application/octet-stream' });
  let names = (await j('GET', '/api/characters')).data.map(c => c.name);
  ok(r.status === 200 && r.data.safety && !names.includes('AFTER_EXPORT 角色') && names.includes('BACKUP_MARK 角色') && names.length === charsBefore, '匯入：資料換成匯出時的樣子', JSON.stringify(r.data));
  r = await j('POST', `/api/backups/${r.data.safety}/restore`);
  names = (await j('GET', '/api/characters')).data.map(c => c.name);
  ok(r.status === 200 && names.includes('AFTER_EXPORT 角色'), '匯入前會自動備份，可以還原回去');
  r = await j('POST', '/api/import', Buffer.from('not a backup'), { 'Content-Type': 'application/octet-stream' });
  ok(r.status === 400, '匯入不是備份的檔案：拒絕');
  const evil = zlib.gzipSync(JSON.stringify({ app: 'ai-tavern', version: 1, files: { 'settings.json': { t: '{}' }, '../evil.json': { t: 'x' }, 'char/../../evil2.json': { t: 'x' } } }));
  r = await j('POST', '/api/import', evil, { 'Content-Type': 'application/octet-stream' });
  ok(r.status === 200 && !fs.existsSync(path.join(TD, '..', 'evil.json')) && !fs.existsSync(path.join(TD, '..', 'evil2.json')), '匯入時不會寫到資料夾以外');
  await j('POST', `/api/backups/${r.data.safety}/restore`);
  // 用一開始的手動備份檢查（有圖片）；最新的那份是剛才匯入的只有設定檔的狀態，沒有圖片可以補
  const dl = await fetch(`${B}/api/backups/${b1}/download`);
  const dlBundle = JSON.parse(zlib.gunzipSync(Buffer.from(await dl.arrayBuffer())).toString('utf8'));
  ok(dl.status === 200 && Object.values(dlBundle.files).some(v => v.b) && !Object.values(dlBundle.files).some(v => v.h), '下載備份：補上共用的圖片，變成完整的檔案', b1);
  r = await j('GET', '/api/backups');
  ok(r.data.items.length >= 1 && r.data.total_size > 0 && blobCount > 0, '備份清單與佔用空間');
  r = await j('DELETE', `/api/backups/${r.data.items.at(-1).name}`);
  ok(r.status === 200, '刪除備份');
  r = await j('GET', '/api/backups/..%2Fsettings.json/download');
  ok(r.status === 400 || r.status === 404, '備份名稱不能指到別的檔案', r.status);
  // 匯入別人的檔案：連線設定沿用目前的（金鑰不會被送到檔案裡的 API 位址）；檔案裡的模型設定檔匯入但不沿用金鑰
  {
    const curUrl = (await j('GET', '/api/settings')).data.settings.openai.base_url;
    const foreign = JSON.parse(zlib.gunzipSync(expBuf).toString('utf8'));
    const fs0 = JSON.parse(foreign.files['settings.json'].t);
    fs0.openai = { ...(fs0.openai || {}), base_url: 'https://evil.example/v1', model: 'stolen' };
    fs0.profiles = [...(fs0.profiles || []), { id: 'foreignprof', name: '別人的', provider: 'openai', openai: { base_url: 'https://evil.example/v1', model: 'x' } }];
    foreign.files['settings.json'] = { t: JSON.stringify(fs0) };
    r = await j('POST', '/api/import', zlib.gzipSync(JSON.stringify(foreign)), { 'Content-Type': 'application/octet-stream' });
    const after = (await j('GET', '/api/settings')).data.settings;
    const cfgNow = JSON.parse(fs.readFileSync(process.env.TAVERN_CONFIG, 'utf8'));
    ok(r.status === 200 && r.data.connection_kept && after.openai.base_url === curUrl && after.profiles.some(p => p.id === 'foreignprof')
      && cfgNow.profile_keys?.foreignprof === '', '匯入：API 位址沿用目前的；別人的模型設定檔沒有金鑰', JSON.stringify({ url: after.openai.base_url, k: cfgNow.profile_keys }));
    ok(bk.backupStatus().items.find(b => b.name === r.data.safety)?.kind === 'restore', '匯入前的備份標成「還原前」，不參與輪替');
    // 切換到匯入的設定檔（沒有金鑰）：目前的金鑰先存好，切回來拿得回來，不會就此消失
    const safetyName = r.data.safety;
    await j('PUT', '/api/keys', { provider: 'openai', api_key: 'sk-ORIGINAL-KEY' });
    const prof0 = (await j('GET', '/api/profiles')).data;
    r = await j('POST', '/api/profiles/foreignprof/apply');
    const cfgAfter = JSON.parse(fs.readFileSync(process.env.TAVERN_CONFIG, 'utf8'));
    const backTo = prof0.active || r.data.profiles.find(p => p.name === '原本的設定')?.id;
    ok(r.status === 200 && !cfgAfter.openai?.api_key && backTo && cfgAfter.profile_keys[backTo] === 'sk-ORIGINAL-KEY',
      '切到沒有金鑰的設定檔：不沿用目前的金鑰，但目前的金鑰先存回原本的設定檔', JSON.stringify({ active: prof0.active, backTo }));
    r = await j('POST', `/api/profiles/${backTo}/apply`);
    ok(JSON.parse(fs.readFileSync(process.env.TAVERN_CONFIG, 'utf8')).openai.api_key === 'sk-ORIGINAL-KEY', '切回原本的設定檔：金鑰回來了');
    r = { data: { safety: safetyName } };
    await j('POST', `/api/backups/${r.data.safety}/restore`);
  }
  // 還原一次完成：寫入途中出錯時，目前的資料完全不動
  {
    const marker = (await j('POST', '/api/characters', { data: { name: 'ATOMIC_MARK' } })).data.id;
    const bad = JSON.parse(zlib.gunzipSync(expBuf).toString('utf8'));
    bad.files['char/x-y/aaa.json'] = { t: '{}' };
    const origWrite = fs.writeFileSync;
    let n = 0;
    fs.writeFileSync = function (p, ...rest) { if (String(p).includes('.restore-new-') && ++n === 3) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return origWrite.call(this, p, ...rest); };
    let err = null;
    try { bk.restore(Buffer.from(zlib.gzipSync(JSON.stringify(bad)))); } catch (e) { err = e; } finally { fs.writeFileSync = origWrite; }
    ok(err && /沒有任何改變/.test(err.message) && (await j('GET', `/api/characters/${marker}`)).status === 200
      && !fs.readdirSync(TD).some(n => n.startsWith('.restore-')), '還原寫到一半失敗：目前的資料完全不動，暫存資料夾清掉', err && err.message);
    await j('DELETE', `/api/characters/${marker}`);
  }
  // 備份清單的時間從檔名讀（複製 userdata 搬家後，檔案修改時間會全部變成複製當下）
  {
    const one = bk.backupStatus().items[0];
    const f0 = path.join(TD, 'backups', one.name);
    fs.utimesSync(f0, new Date(2000, 0, 1), new Date(2000, 0, 1));
    const again = bk.backupStatus().items.find(b => b.name === one.name);
    const m = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(one.name);
    ok(again.created === new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), '備份時間從檔名讀，不受檔案修改時間影響', `${again.created}`);
  }
  // 還原留下的暫存資料夾：啟動時清掉
  fs.mkdirSync(path.join(TD, '.restore-old-99999', 'char'), { recursive: true });
  fs.mkdirSync(path.join(TD, '.restore-new-88888'), { recursive: true });
  bk.startupBackup(20);
  ok(!fs.readdirSync(TD).some(n => n.startsWith('.restore-')), '啟動時清掉還原留下的暫存資料夾');
  // 手動改壞的 card.json（少了 data）：略過這一張，首頁與對話清單照常
  {
    const broken = path.join(TD, 'char', '壞掉的卡-brokencard1');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'card.json'), JSON.stringify({ created: 1, updated: 1 }));
    const lc = await j('GET', '/api/characters'), la = await j('GET', '/api/chats');
    ok(lc.status === 200 && !lc.data.some(c => c.id === 'brokencard1') && la.status === 200, 'card.json 少了 data：略過這一張，首頁與對話清單照常', `${lc.status}/${la.status}`);
    ok((await j('GET', '/api/characters/brokencard1')).status === 404, '讀不懂的角色卡：回 404，不是伺服器錯誤');
    fs.rmSync(broken, { recursive: true, force: true });
  }
  // 設定：下拉選單的值一定要是範圍內的整數
  for (const bad of [{ backup_keep: -1 }, { trash_days: 'abc' }, { compress_threshold: 70.5 }, { chat_render: -5 }, { external_images: 'yes' }]) {
    r = await j('PUT', '/api/settings', bad);
    ok(r.status === 400, '設定：不合法的值被拒絕 ' + JSON.stringify(bad));
  }

  // ---------- 每個角色／世界一個資料夾 ----------
  const fc = (await j('POST', '/api/characters', { data: { name: '資料夾 測試' } })).data;
  const fdir = n => path.join(TD, 'char', `${n}-${fc.id}`);
  const fchat = (await j('POST', `/api/characters/${fc.id}/chats`, {})).data;
  ok(fs.existsSync(path.join(fdir('資料夾 測試'), 'card.json')) && fs.existsSync(path.join(fdir('資料夾 測試'), 'chats', fchat.id + '.json')), '角色存在「名稱-ID」資料夾，對話在裡面的 chats/');
  r = await j('PUT', `/api/characters/${fc.id}`, { data: { name: '改名:後*的?角色' } });
  ok(r.status === 200 && fs.existsSync(path.join(fdir('改名_後_的_角色'), 'chats', fchat.id + '.json')) && !fs.existsSync(fdir('資料夾 測試')), '改名時資料夾跟著改名（不能用的字元換成 _），對話一起帶走');
  ok((await j('GET', `/api/characters/${fc.id}/chats/${fchat.id}`)).status === 200, '改名後照樣讀得到對話');
  fs.renameSync(fdir('改名_後_的_角色'), fdir('手動改的名字'));
  ok((await j('GET', `/api/characters/${fc.id}`)).data.data.name === '改名:後*的?角色', '在檔案總管手動改資料夾名稱也找得到（用 ID 找）');
  await j('DELETE', `/api/characters/${fc.id}`);
  ok(!fs.readdirSync(path.join(TD, 'char')).some(f => f.endsWith(fc.id)), '刪除角色：整個資料夾（含對話）一起刪掉');
  const trashHit = fs.existsSync(path.join(TD, 'trash')) && fs.readdirSync(path.join(TD, 'trash'), { recursive: true }).some(f => String(f).includes(fc.id) && fs.existsSync(path.join(TD, 'trash', String(f), 'chats', fchat.id + '.json')));
  ok(trashHit, '刪除角色：資料夾移到 userdata/trash（含對話），30 天內可找回');
  // 設定檔損毀：拒絕寫入並另存損毀的檔案，不會把設定檔清空
  const SF = path.join(TD, 'settings.json'), sfOrig = fs.readFileSync(SF, 'utf8');
  fs.writeFileSync(SF, '{ "broken": ');
  r = await j('PUT', '/api/settings', { temperature: 0.5 });
  const corrupt = fs.readdirSync(TD).filter(f => f.startsWith('settings.json.corrupt-'));
  ok(r.status === 409 && fs.readFileSync(SF, 'utf8') === '{ "broken": ' && corrupt.length > 0, '設定檔損毀：拒絕儲存、保留原檔並另存 .corrupt', r.status + ' ' + JSON.stringify(r.data));
  r = await j('GET', '/api/settings');
  ok(r.status === 200 && JSON.stringify(r.data.corrupt) === '["settings.json"]', '設定檔損毀：讀取設定時回報哪個檔案損毀（畫面上提示從備份還原）', JSON.stringify(r.data.corrupt));
  const bkCount = bk.backupStatus().items.length;
  ok(bk.startupBackup(7) === null && bk.backupStatus().items.length === bkCount, '設定檔損毀：不自動備份（好的舊備份不會被輪替掉）');
  fs.writeFileSync(SF, sfOrig);
  ok(JSON.stringify((await j('GET', '/api/settings')).data.corrupt) === '[]', '設定檔正常時不回報損毀');
  // 備份寫到一半被中斷：只會留下 .tmp，不會出現在清單裡，下次備份時清掉
  const BKD = path.join(TD, 'backups');
  fs.writeFileSync(path.join(BKD, 'backup-20260101-000000.tavern.123.tmp'), 'half');
  fs.writeFileSync(path.join(BKD, 'blobs', 'deadbeef.123.tmp'), 'half');
  ok(!bk.backupStatus().items.some(b => b.name.endsWith('.tmp')), '中斷留下的暫存檔不會出現在備份清單');
  bk.startupBackup(20);
  ok(!fs.readdirSync(BKD).some(n => n.endsWith('.tmp')) && !fs.readdirSync(path.join(BKD, 'blobs')).some(n => n.endsWith('.tmp')), '備份時清掉中斷留下的暫存檔');
  ok(bk.backupStatus().items.every(b => { try { bk.readBackup(b.name); return true; } catch { return false; } }), '每一份備份都讀得出來');
  for (const f of corrupt) fs.rmSync(path.join(TD, f));
  // ---------- 內附的 Node.js（測試用暫存的 runtime 資料夾，不會動到專案真正的 runtime/） ----------
  {
    const RTD = process.env.TAVERN_RUNTIME_DIR;
    let rt = (await j('GET', '/api/runtime')).data;
    ok(rt.windows === (process.platform === 'win32') && rt.using_bundled === false && rt.bundled === false && rt.installed_version === process.version, '內附的 Node.js：狀態（測試環境一開始沒有內附版本）', JSON.stringify(rt));
    if (process.platform === 'win32') {
      rt = (await j('POST', '/api/runtime')).data;
      ok(rt.bundled && rt.size === fs.statSync(process.execPath).size && fs.readFileSync(path.join(RTD, 'README.txt'), 'utf8').includes(process.version), '重新建立：從安裝的 Node.js 複製一份並寫 README', JSON.stringify(rt));
      rt = (await j('DELETE', '/api/runtime')).data;
      ok(!rt.bundled && !fs.existsSync(path.join(RTD, 'node.exe')) && fs.existsSync(path.join(RTD, 'README.txt')), '刪除內附的 Node.js（README 留著）', JSON.stringify(rt));
      r = await j('DELETE', '/api/runtime');
      ok(r.status === 200 && !r.data.bundled, '已經刪掉時再刪一次：不會出錯');
    }
  }
  // ---------- 垃圾桶管理 ----------
  let tr = (await j('GET', '/api/trash')).data;
  ok(tr.days === 7, '垃圾桶預設保留 7 天', tr.days);
  let trC = tr.items.find(i => i.kind === 'char' && i.id === fc.id);
  ok(trC && trC.title === '改名:後*的?角色' && trC.chats === 1 && trC.expires - trC.deleted === 7 * 86400000, '垃圾桶清單：角色名稱、對話數與到期時間', JSON.stringify(trC));
  r = await j('POST', `/api/trash/char/${encodeURIComponent(trC.name)}/restore`);
  ok(r.status === 200 && (await j('GET', `/api/characters/${fc.id}`)).status === 200 && (await j('GET', `/api/characters/${fc.id}/chats/${fchat.id}`)).status === 200, '還原角色：角色與對話都回來了', r.status);
  ok(!(await j('GET', '/api/trash')).data.items.some(i => i.id === fc.id), '還原後從垃圾桶移除');
  await j('DELETE', `/api/characters/${fc.id}/chats/${fchat.id}`);
  tr = (await j('GET', '/api/trash')).data;
  const tchat = tr.items.find(i => i.kind === 'chats' && i.id === fchat.id);
  ok(tchat && tchat.owner === fc.id && tchat.owner_name === '改名_後_的_角色' && (await j('GET', `/api/characters/${fc.id}/chats/${fchat.id}`)).status === 404, '刪除單一對話：移到垃圾桶並記下屬於哪個角色', JSON.stringify(tchat));
  await j('DELETE', `/api/characters/${fc.id}`);
  r = await j('POST', `/api/trash/chats/${encodeURIComponent(tchat.name)}/restore`);
  ok(r.status === 409 && /已經不在/.test(r.data.error), '角色也被刪了：還原對話會提示先還原角色', JSON.stringify(r.data));
  trC = (await j('GET', '/api/trash')).data.items.find(i => i.kind === 'char' && i.id === fc.id);
  await j('POST', `/api/trash/char/${encodeURIComponent(trC.name)}/restore`);
  r = await j('POST', `/api/trash/chats/${encodeURIComponent(tchat.name)}/restore`);
  ok(r.status === 200 && (await j('GET', `/api/characters/${fc.id}/chats/${fchat.id}`)).status === 200, '先還原角色，再還原對話');
  r = await j('POST', '/api/trash/char/..%2F..%2Fsettings.json/restore');
  ok(r.status === 404, '垃圾桶：不能用路徑跳出垃圾桶', r.status);
  // 永久刪除單一項目
  await j('DELETE', `/api/characters/${fc.id}`);
  trC = (await j('GET', '/api/trash')).data.items.find(i => i.kind === 'char' && i.id === fc.id);
  r = await j('DELETE', `/api/trash/char/${encodeURIComponent(trC.name)}`);
  ok(r.status === 200 && !r.data.items.some(i => i.id === fc.id) && !fs.existsSync(path.join(TD, 'trash', 'char', trC.name)), '永久刪除垃圾桶裡的一項');
  // 縮短保留天數：超過天數的馬上清掉
  const oldC = (await j('POST', '/api/characters', { data: { name: '過期角色' } })).data;
  await j('DELETE', `/api/characters/${oldC.id}`);
  const oldItem = (await j('GET', '/api/trash')).data.items.find(i => i.id === oldC.id);
  const metaF = path.join(TD, 'trash', 'char', oldItem.name + '.trash.json');
  fs.writeFileSync(metaF, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaF, 'utf8')), deleted: Date.now() - 5 * 86400000 }));
  ok((await j('GET', '/api/trash')).data.items.some(i => i.id === oldC.id), '5 天前刪的：保留 7 天時還在');
  await j('PUT', '/api/settings', { trash_days: 3 });
  ok(!fs.existsSync(path.join(TD, 'trash', 'char', oldItem.name)) && !fs.existsSync(metaF), '改成保留 3 天：5 天前刪的馬上清掉');
  await j('PUT', '/api/settings', { trash_days: 7 });
  // 清空垃圾桶
  r = await j('DELETE', '/api/trash');
  ok(r.status === 200 && r.data.removed > 0 && r.data.items.length === 0, '清空垃圾桶', JSON.stringify({ removed: r.data.removed, left: r.data.items?.length }));
  // 舊版結構的備份：匯入後自動整理成新結構
  const oldCard = JSON.stringify({ data: { name: '舊版角色', tags: [] }, created: 1, updated: 1 });
  const oldChat = id => JSON.stringify({ id, title: '舊對話', messages: [{ role: 'assistant', content: 'OLD_LAYOUT_MSG' }], created: 1, updated: 1 });
  const oldBundle = zlib.gzipSync(JSON.stringify({ app: 'ai-tavern', version: 1, files: {
    'settings.json': { t: '{}' }, 'char/oldchar1.json': { t: oldCard }, 'char/oldchar1.png': { b: pngBuf.toString('base64') },
    'chats/oldchar1/oldc1.json': { t: oldChat('oldc1') },
    'bigworld/oldw1.json': { t: JSON.stringify({ name: '舊世界', members: [{ id: 'oldchar1' }] }) }, 'chats/world-oldw1/oldc2.json': { t: oldChat('oldc2') },
  } }));
  r = await j('POST', '/api/import', oldBundle, { 'Content-Type': 'application/octet-stream' });
  const oldSafety = r.data.safety;
  ok(r.status === 200 && fs.existsSync(path.join(TD, 'char', '舊版角色-oldchar1', 'card.json')) && fs.existsSync(path.join(TD, 'char', '舊版角色-oldchar1', 'cover.png'))
    && fs.existsSync(path.join(TD, 'bigworld', '舊世界-oldw1', 'chats', 'oldc2.json')) && !fs.existsSync(path.join(TD, 'chats')), '匯入舊版結構的備份：自動整理成各自的資料夾', JSON.stringify(r.data));
  r = await j('GET', '/api/characters/oldchar1/chats/oldc1');
  ok(r.status === 200 && r.data.messages[0].content === 'OLD_LAYOUT_MSG' && (await j('GET', '/api/bigworlds')).data.some(w => w.id === 'oldw1' && w.members.length === 1), '整理後角色、世界與對話都讀得到');
  await j('POST', `/api/backups/${oldSafety}/restore`);
  ok((await j('GET', '/api/characters')).data.some(c => c.name === 'AFTER_EXPORT 角色'), '還原新結構的備份');

  // ===== 深度檢查報告的修正 =====
  {
    const rc = (await j('POST', '/api/characters', { data: { name: '名字測試', first_mes: '{{user}}，歡迎回來。你真可愛。' } })).data;
    const rcId = rc.id;
    let rch = (await j('POST', `/api/characters/${rcId}/chats`, {})).data;
    const curName = (await j('GET', '/api/settings')).data.settings.user_name;
    const chUrl = `/api/characters/${rcId}/chats/${rch.id}`;
    ok(rch.messages[0].content === `${curName}，歡迎回來。你真可愛。`, '開場白建立時把 {{user}} 換成當時的名字');
    // 換名字：開場白依模板自動換（只有 {{user}} 的位置）
    r = await j('PUT', chUrl, { user_name: '可愛', rename_user: { from: curName, to: '可愛', edits: [] } });
    ok(r.status === 200 && r.data.messages[0].content === '可愛，歡迎回來。你真可愛。' && r.data.messages[0].swipes[0] === r.data.messages[0].content, '更換名字：開場白依模板換成新名字', JSON.stringify(r.data.messages[0]));
    // 名字是有意義的詞（可愛）：預覽列出記憶與送給 AI 的訊息裡每一處，開場白自動處理、不會誤改「你真可愛」
    await j('PUT', chUrl, { messages: [...r.data.messages, { role: 'user', content: '我是可愛' }, { role: 'assistant', content: '可愛你好，你真可愛', swipes: ['可愛你好，你真可愛'], swipe_id: 0 }], memory: '可愛來到店裡。' });
    r = await j('POST', `${chUrl}/rename-preview`, { from: '可愛', to: '可憐' });
    ok(r.status === 200 && r.data.greetings === 1 && r.data.items.length === 4 && r.data.older === 0 && r.data.items.some(x => x.i === -1),
      '更換名字的預覽：開場白自動處理，其餘列出每一處（含記憶）', JSON.stringify(r.data));
    const pick = r.data.items.filter(x => !(x.i === 2 && x.before.endsWith('真'))); // 「你真可愛」不是名字：不勾
    r = await j('PUT', chUrl, { user_name: '可憐', rename_user: { from: '可愛', to: '可憐', edits: pick.map(x => ({ i: x.i, at: x.at })) } });
    ok(r.data.messages[0].content === '可憐，歡迎回來。你真可愛。' && r.data.messages[1].content === '我是可憐' && r.data.messages[2].content === '可憐你好，你真可愛'
      && r.data.messages[2].swipes[0] === '可憐你好，你真可愛' && r.data.memory === '可憐來到店裡。', '只改勾選的位置：形容詞「可愛」保留', JSON.stringify(r.data.messages.map(m => m.content)));
    // 更早、已經不送給 AI 的訊息：不列出、不改，只回報數量
    await j('PUT', chUrl, { memory_upto: 2, memory_cut: 2 });
    r = await j('POST', `${chUrl}/rename-preview`, { from: '可憐', to: '小華' });
    ok(r.data.older === 1 && r.data.items.every(x => x.i === -1 || x.i >= 2), '更早的訊息（壓縮進記憶、不送給 AI）不列出，只回報還有幾處', JSON.stringify(r.data));
    await j('PUT', chUrl, { memory_upto: 0, memory_cut: 0 });
    // 訊息變少：記憶進度與壓縮切點不能超過訊息數
    await j('PUT', `/api/characters/${rcId}/chats/${rch.id}`, { memory_upto: 3, memory_cut: 3 });
    r = await j('PUT', `/api/characters/${rcId}/chats/${rch.id}`, { messages: (await j('GET', chUrl)).data.messages.slice(0, 1) });
    ok(r.data.memory_upto === 1 && r.data.memory_cut === 1, '刪掉訊息後，記憶進度與切點自動限制在訊息數以內', `${r.data.memory_upto}/${r.data.memory_cut}`);
    r = await j('PUT', `/api/characters/${rcId}/chats/${rch.id}`, { messages: [], memory_upto: 0, memory_cut: 0, memory: '' });
    ok(r.status === 200 && r.data.memory_upto === 0 && r.data.messages.length === 0, '訊息與記憶進度可以一次存好（清空聊天、刪除訊息不再分兩次存）');
    // 背景整理記憶時，不能手動改記憶（整理完會蓋掉）
    await j('PUT', `/api/characters/${rcId}/chats/${rch.id}`, { messages: [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }, { role: 'user', content: 'C' }] });
    const prevModel = (await j('GET', '/api/settings')).data.settings.openai.model;
    await j('PUT', '/api/settings', { openai: { model: 'slowstart' } });
    const memRun = j('POST', `/api/characters/${rcId}/chats/${rch.id}/memory`, { full: true });
    await new Promise(res => setTimeout(res, 400));
    r = await j('PUT', `/api/characters/${rcId}/chats/${rch.id}`, { memory: '手動的修改' });
    ok(r.status === 409 && /背景整理/.test(r.data.error), '背景整理記憶時手動改記憶：先擋下並說明', r.status + ' ' + r.data.error);
    await memRun;
    // OpenAI 推理型模型：自動改用 max_completion_tokens、不送 temperature
    const rlog = path.join(LOGDIR, 'reasoner.log');
    await j('PUT', '/api/settings', { openai: { model: 'reasoner' } });
    rch = (await j('POST', `/api/characters/${rcId}/chats`, {})).data;
    let evs = await gen({ char_id: rcId, chat_id: rch.id, mode: 'normal', user_message: '哈囉' });
    const rl = fs.readFileSync(rlog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    ok(!evs.some(e => e.type === 'error') && rl.length === 3 && rl[2].mct > 0 && rl[2].max_tokens === undefined && rl[2].temperature === undefined,
      '推理型模型拒絕 max_tokens／temperature：自動調整參數後重試成功', JSON.stringify(rl));
    evs = await gen({ char_id: rcId, chat_id: rch.id, mode: 'normal', user_message: '再一次' });
    const rl2 = fs.readFileSync(rlog, 'utf8').trim().split('\n');
    ok(!evs.some(e => e.type === 'error') && rl2.length === 4, '記住調整過的參數：之後第一次就送對', rl2.length);
    await j('PUT', '/api/settings', { openai: { model: prevModel } });
    // 設定的數值要在範圍內
    r = await j('PUT', '/api/settings', { temperature: 'abc' });
    ok(r.status === 400 && /Temperature/.test(r.data.error), '設定值檢查：temperature 不是數字時拒絕', r.status);
    r = await j('PUT', '/api/settings', { max_tokens: -5 });
    ok(r.status === 400, '設定值檢查：max_tokens 是負數時拒絕', r.status);
    ok((await j('GET', '/api/settings')).data.settings.temperature !== 'abc', '被拒絕的設定沒有存進去');
    // 檔案太大：回 413 與看得懂的訊息（不是連線被切斷）
    const big = await fetch(B + '/api/characters/import', { method: 'POST', headers: { 'X-Filename': 'big.png' }, body: Buffer.alloc(31 * 1024 * 1024) }).then(async x => ({ status: x.status, data: await x.json() })).catch(e => ({ status: 0, data: { error: String(e.cause?.code || e.message) } }));
    ok(big.status === 413 && /檔案太大/.test(big.data.error), '檔案超過上限：回應「檔案太大」而不是切斷連線', JSON.stringify(big));
    // 世界書匯入的檔名格式錯誤：用預設名稱，不會 500
    r = await j('POST', '/api/worlds/import', Buffer.from(JSON.stringify({ entries: [{ keys: ['a'], content: 'b' }] })), { 'X-Filename': '%E0%A4%A' });
    ok(r.status === 200, '世界書匯入：檔名格式錯誤時改用預設名稱', r.status + ' ' + JSON.stringify(r.data));
    // 分支：伺服器一次複製訊息、對話設定、發言模式與記憶
    rch = (await j('POST', `/api/characters/${rcId}/chats`, {})).data;
    await j('PUT', `/api/characters/${rcId}/chats/${rch.id}`, { messages: [{ role: 'assistant', content: 'A' }, { role: 'user', content: 'B' }, { role: 'assistant', content: 'C' }], user_name: '分支名', history_cap: 4000, memory: '記憶 M', memory_upto: 2 });
    r = await j('POST', `/api/characters/${rcId}/chats`, { branch_from: rch.id, upto: 1 });
    ok(r.status === 200 && r.data.title === '名字測試（分支）' && r.data.messages.length === 2 && r.data.messages[1].content === 'B' && r.data.user_name === '分支名' && r.data.history_cap === 4000 && r.data.memory === '記憶 M',
      '開分支：複製到那一則為止的訊息、對話設定與記憶', JSON.stringify(r.data).slice(0, 300));
    r = await j('POST', `/api/characters/${rcId}/chats`, { branch_from: rch.id, upto: 0 });
    ok(r.data.messages.length === 1 && !r.data.memory, '分支點在記憶涵蓋的範圍之前：記憶不帶過去');
    // 記憶換回上一版
    r = await j('PUT', `/api/characters/${rcId}/chats/${rch.id}`, { memory: '記憶 N' });
    ok(r.data.memory_prev?.text === '記憶 M', '手動修改記憶：留下上一版');
    r = await j('PUT', `/api/characters/${rcId}/chats/${rch.id}`, { memory_restore_prev: true });
    ok(r.data.memory === '記憶 M' && r.data.memory_prev.text === '記憶 N', '換回上一版：和目前的互換（再按一次就換回來）');
    // 清空聊天：原本的對話留一份在垃圾桶
    r = await j('PUT', `/api/characters/${rcId}/chats/${rch.id}`, { messages: [], memory_upto: 0, memory_cut: 0, snapshot: 'clear' });
    const trashNow = (await j('GET', '/api/trash')).data.items;
    ok(r.status === 200 && r.data.messages.length === 0 && trashNow.some(t => t.kind === 'chats' && t.title === '名字測試（清空前）' && t.messages === 3), '清空聊天前，原本的對話完整放進垃圾桶（可以還原）', JSON.stringify(trashNow.map(t => t.title)));
    // 搜尋結果用這段對話自己的名字
    await j('PUT', `/api/characters/${rcId}/chats/${rch.id}`, { messages: [{ role: 'user', content: '搜尋名字測試ZQ' }] });
    r = await j('GET', '/api/search?q=' + encodeURIComponent('搜尋名字測試ZQ'));
    ok(r.data.length === 1 && r.data[0].user_name === '分支名', '搜尋結果：你的訊息顯示這段對話自己的名字', JSON.stringify(r.data));
    // 提示詞太長：固定的部分就超過上下文長度時回報
    const stBefore = (await j('GET', '/api/settings')).data.settings;
    await j('PUT', '/api/settings', { context_tokens: 300, max_tokens: 250 });
    r = await j('POST', '/api/prompt-preview', { char_id: rcId, chat_id: rch.id });
    ok(r.data.info.overflow > 0 && r.data.info.context_tokens === 300, '提示詞太長：回報超過多少（預覽與生成時提醒）', JSON.stringify({ overflow: r.data.info.overflow }));
    await j('PUT', '/api/settings', { context_tokens: stBefore.context_tokens, max_tokens: stBefore.max_tokens });
    r = await j('POST', '/api/prompt-preview', { char_id: rcId, chat_id: rch.id });
    ok(r.data.info.overflow === 0, '上下文足夠時不提醒');
    // 導演：有設定思考程度時用「低」、上限 6000
    const dw = (await j('POST', '/api/bigworlds', { data: { name: '導演測試', turn_mode: 'turns', max_replies: 1, members: [{ id: rcId }] } })).data;
    const dkey = 'world-' + dw.id;
    const dchat = (await j('POST', `/api/characters/${dkey}/chats`, {})).data;
    await j('PUT', '/api/settings', { openai: { reasoning_effort: 'high' } });
    const dn0 = logLines().length;
    await gen({ char_id: dkey, chat_id: dchat.id, mode: 'normal', user_message: '開始' });
    const dReq = reqsSince(dn0).find(q => String(q.messages.at(-1).content).includes('[導演指示'));
    const sReq = reqsSince(dn0).find(q => !String(q.messages.at(-1).content).includes('[導演指示'));
    ok(dReq && dReq.reasoning_effort === 'low' && dReq.max_tokens === 6000 && sReq?.reasoning_effort === 'high', '導演：思考型模型改用低思考程度、上限 6000（角色照設定）', JSON.stringify({ d: dReq && [dReq.reasoning_effort, dReq.max_tokens], s: sReq?.reasoning_effort }));
    await j('PUT', '/api/settings', { openai: { reasoning_effort: '' } });
    await j('DELETE', `/api/bigworlds/${dw.id}`);
    // 設定檔只存改過的欄位
    const rawSettings = JSON.parse(fs.readFileSync(path.join(process.env.TAVERN_DATA_DIR, 'settings.json'), 'utf8'));
    ok(!('main_prompt' in rawSettings) && !('memory_prompt' in rawSettings) && 'first_run_done' in rawSettings && 'profiles' in rawSettings,
      'settings.json 只存改過的欄位（沒改過的提示詞跟隨預設）', Object.keys(rawSettings).join(','));
    await j('PUT', '/api/settings', { main_prompt: '自訂的主要提示' });
    const raw2 = JSON.parse(fs.readFileSync(path.join(process.env.TAVERN_DATA_DIR, 'settings.json'), 'utf8'));
    ok(raw2.main_prompt === '自訂的主要提示' && (await j('GET', '/api/settings')).data.settings.memory_prompt.length > 50, '改過的欄位照樣保留；讀取時沒存的欄位用預設');
    await j('PUT', '/api/settings', { main_prompt: (await j('GET', '/api/settings/defaults')).data.main_prompt });
    ok(!('main_prompt' in JSON.parse(fs.readFileSync(path.join(process.env.TAVERN_DATA_DIR, 'settings.json'), 'utf8'))), '改回預設的內容：又變成跟隨預設');
    // 思考過程跟著各自的版本：先用思考型模型生成，再換成不會思考的模型重新生成，舊的思考不會殘留
    {
      const tc = (await j('POST', `/api/characters/${rcId}/chats`, {})).data;
      const tUrl = `/api/characters/${rcId}/chats/${tc.id}`;
      const prevM = (await j('GET', '/api/settings')).data.settings.openai.model;
      await j('PUT', '/api/settings', { openai: { model: 'thinker' } });
      await gen({ char_id: rcId, chat_id: tc.id, mode: 'normal', user_message: '想一想' });
      let tm = (await j('GET', tUrl)).data.messages.at(-1);
      ok(tm.reasoning === 'THINKER_THOUGHT', '思考型模型：記下思考過程', JSON.stringify(tm));
      const t1 = tm.timing;
      ok(t1 && Number.isInteger(t1.first) && Number.isInteger(t1.total) && t1.first >= 0 && t1.total >= t1.first,
        '回應耗時：記下第一個字與總共的毫秒數', JSON.stringify(t1));
      await j('PUT', '/api/settings', { openai: { model: 'mock-a' } });
      await gen({ char_id: rcId, chat_id: tc.id, mode: 'regenerate' });
      tm = (await j('GET', tUrl)).data.messages.at(-1);
      ok(!tm.reasoning && tm.swipes.length === 2 && JSON.stringify(tm.swipe_reasoning) === JSON.stringify(['THINKER_THOUGHT', '']),
        '換成不會思考的模型重新生成：新版本沒有思考過程，舊版本的思考留在舊版本', JSON.stringify(tm));
      ok(tm.timing && tm.swipe_timing?.length === 2 && JSON.stringify(tm.swipe_timing[0]) === JSON.stringify(t1) && JSON.stringify(tm.swipe_timing[1]) === JSON.stringify(tm.timing),
        '回應耗時跟著各自的版本', JSON.stringify(tm.swipe_timing));
      const t2 = tm.timing;
      await gen({ char_id: rcId, chat_id: tc.id, mode: 'continue' });
      tm = (await j('GET', tUrl)).data.messages.at(-1);
      ok(tm.timing.first === t2.first && tm.timing.total >= t2.total && tm.swipe_timing[1].total === tm.timing.total,
        '「繼續」：耗時累加在原本的版本上', JSON.stringify(tm.timing));
      await j('PUT', '/api/settings', { openai: { model: prevM } });
    }
    await j('DELETE', `/api/characters/${rcId}`);
  }

  // ---------- 記住視窗位置與大小 ----------
  r = await j('PUT', '/api/window', { x: 150, y: 120, w: 1000, h: 700, max: false });
  ok(r.status === 200 && r.data.saved, '記住視窗位置');
  r = await j('PUT', '/api/window', { x: 150, y: 120, w: 1002, h: 701, max: false });
  ok(r.status === 200 && !r.data.saved, '差 1～2 像素不更新（避免縮放時每次開都變大）');
  r = await j('PUT', '/api/window', { x: 150, y: 120, w: 1000, h: 700, max: true });
  ok(r.status === 200 && r.data.saved, '最大化會記下來');
  r = await j('PUT', '/api/window', { max: false });
  ok(r.status === 400, '沒有位置又不是最大化：拒絕', r.status);
  r = await j('PUT', '/api/window', { max: true });
  ok(r.status === 200, '只送「最大化」：沿用上次的位置與大小');
  ok(JSON.parse(fs.readFileSync(path.join(path.dirname(TD), 'window.json'), 'utf8')).w === 1000, '最大化時保留原本的大小');
  r = await j('PUT', '/api/window', { x: 'a', y: 0, w: 50, h: 700 });
  ok(r.status === 400, '無效的視窗位置：拒絕', r.status);

  // ===== 背景整理記憶時清空或修改訊息：記憶進度不能被寫回舊的數字 =====
  {
    const prevModel = (await j('GET', '/api/settings')).data.settings.openai.model;
    await j('PUT', '/api/settings', { provider: 'openai', openai: { model: 'slow' }, memory_enabled: true, memory_auto: false });
    const mk = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `記憶競態 ${i}`, time: 1000 + i }));
    const mc = (await j('POST', `/api/characters/${id}/chats`, {})).data.id;
    const url = `/api/characters/${id}/chats/${mc}`;
    await j('PUT', url, { messages: mk(10), memory: '', memory_upto: 0 });
    // 1. 整理中清空聊天（保留記憶）：整理被中止，記憶進度不超過剩下的訊息
    let memP = j('POST', url + '/memory', {});
    await new Promise(res => setTimeout(res, 400));
    const t0 = Date.now();
    r = await j('PUT', url, { messages: mk(1), memory_cut: 0, snapshot: 'clear' });
    const quick = Date.now() - t0 < 2500;
    let mr = await memP;
    let after = (await j('GET', url)).data;
    ok(r.status === 200 && quick && mr.status === 409 && after.messages.length === 1 && (after.memory_upto || 0) <= 1,
      '整理記憶中清空聊天：中止整理，記憶進度不會被寫回舊的數字', JSON.stringify({ put: r.status, quick, mem: mr.status, upto: after.memory_upto }));
    // 2. 整理中修改了要整理的訊息（訊息數不變，不會中止）：存檔前發現對不上，放棄這次結果
    const msgs = mk(10);
    await j('PUT', url, { messages: msgs, memory: 'OLD_MEM', memory_upto: 0 });
    memP = j('POST', url + '/memory', {});
    await new Promise(res => setTimeout(res, 400));
    msgs[9] = { ...msgs[9], content: '改過的內容' };
    await j('PUT', url, { messages: msgs });
    mr = await memP;
    after = (await j('GET', url)).data;
    ok(mr.status === 409 && after.memory === 'OLD_MEM' && (after.memory_upto || 0) === 0, '整理記憶中修改訊息：放棄對不上的整理結果', JSON.stringify({ mem: mr.status, memory: after.memory, upto: after.memory_upto }));
    // 2b. 改的是這一段中間的訊息（最後一則沒變）：一樣放棄
    msgs[9] = { ...msgs[9], content: 'm9' };
    await j('PUT', url, { messages: msgs, memory: 'OLD_MEM', memory_upto: 0 });
    memP = j('POST', url + '/memory', {});
    await new Promise(res => setTimeout(res, 400));
    msgs[4] = { ...msgs[4], content: '改過中間這則' };
    await j('PUT', url, { messages: msgs });
    mr = await memP;
    after = (await j('GET', url)).data;
    ok(mr.status === 409 && after.memory === 'OLD_MEM', '整理記憶中修改中間的訊息：一樣放棄', JSON.stringify({ mem: mr.status, memory: after.memory }));
    // 3. 沒有變動：照常存檔
    mr = await j('POST', url + '/memory', {});
    ok(mr.status === 200 && mr.data.memory_upto === 10, '沒有變動時照常整理到最後', JSON.stringify({ s: mr.status, upto: mr.data.memory_upto }));
    // 4. 整理中更換名字（會改到記憶）：先擋下
    memP = j('POST', url + '/memory', { full: true });
    await new Promise(res => setTimeout(res, 300));
    r = await j('PUT', url, { rename_user: { from: '旅人', to: '新名字', edits: [] } });
    await memP;
    ok(r.status === 409, '整理記憶中更換名字：先擋下', r.status);
    await j('DELETE', url);
    await j('PUT', '/api/settings', { openai: { model: prevModel } });
  }

  console.log(`\n${pass} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
