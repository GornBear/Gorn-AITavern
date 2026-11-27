// 測試用的假 OpenAI 相容 API：串流固定回覆，並把收到的請求記錄到 MOCK_LOG_DIR
const http = require('http');
const fs = require('fs');
const path = require('path');
const DIR = process.env.MOCK_LOG_DIR || __dirname;
const LOG = path.join(DIR, 'last-request.json');
let flaky = 0;
http.createServer((req, res) => {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    // LM Studio 的 /api/v0/models 不帶金鑰：不記，免得蓋掉前一個 /models 請求帶的金鑰
    if (!['/api/v0/models', '/api/version', '/api/show'].includes(req.url)) fs.writeFileSync(path.join(DIR, 'last-auth.txt'), req.url + ' ' + (req.headers.authorization || ''));
    if (req.headers.authorization === 'Bearer bad') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify([{ error: { code: 401, message: 'API key not valid. Please pass a valid API key.' } }])); }
    // Gemini 原生 API（TAVERN_GEMINI_URL 指到 /gemini）
    if (req.url.startsWith('/gemini/')) {
      const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith('/gemini/models?')) return json(200, { models: [
        { name: 'models/gemini-mock', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-x', supportedGenerationMethods: ['embedContent'] }] });
      const m = /^\/gemini\/models\/([^:]+):streamGenerateContent\?alt=sse$/.exec(req.url);
      if (!m) return json(404, { error: { code: 404, message: 'not found' } });
      const model = decodeURIComponent(m[1]);
      const gb = JSON.parse(b || '{}');
      fs.writeFileSync(path.join(DIR, 'gemini-request.json'), JSON.stringify({ url: req.url, key: req.headers['x-goog-api-key'], body: gb }, null, 2));
      // 不會思考的模型：送了思考設定就拒絕
      if (model === 'gemini-nothink' && gb.generationConfig?.thinkingConfig) return json(400, { error: { code: 400, message: 'Thinking is not supported for this model.', status: 'INVALID_ARGUMENT' } });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = o => res.write(`data: ${JSON.stringify(o)}\r\n\r\n`);
      if (model === 'gemini-prohibited') { // Google 不開放調整的政策過濾
        ev({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
        return res.end();
      }
      if (model === 'gemini-blocked') { // 輸入就被擋下
        ev({ promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'HIGH', blocked: true }] } });
        return res.end();
      }
      if (model === 'gemini-cut') { // 寫到一半被擋下
        ev({ candidates: [{ content: { role: 'model', parts: [{ text: '寫到一半' }] } }] });
        ev({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }] }] });
        return res.end();
      }
      if (model !== 'gemini-nothink') ev({ candidates: [{ content: { role: 'model', parts: [{ text: 'GEM_THOUGHT', thought: true }] } }] });
      ev({ candidates: [{ content: { role: 'model', parts: [{ text: '雙子' }] } }] });
      ev({ candidates: [{ content: { role: 'model', parts: [{ text: '星回覆' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 12, thoughtsTokenCount: 8 } });
      return res.end();
    }
    // 檢查更新：假的 GitHub Releases（最新版本 99.0.0；連結故意指到別的網站，伺服器要換回儲存庫的頁面）
    if (req.url === '/github/releases/latest') return res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify({ tag_name: 'v99.0.0', name: 'AI 酒館 v99.0.0', html_url: 'https://evil.example.com/x', body: '## 更新內容\n- 測試', published_at: '2026-11-25T00:00:00Z' }));
    if (req.url.startsWith('/gem/') && req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'models/gemini-z' }, { id: 'models/gemini-a' }] })); }
    // 上下文長度：LM Studio 自己的 API（目前載入的長度）、OpenRouter 風格的清單（context_length）
    if (req.url === '/api/v0/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-a', max_context_length: 131072, loaded_context_length: 32768 }, { id: 'not-in-list', max_context_length: 4096 }] })); }
    // 假的 Ollama：/ollama/v1/models 的模型，上下文長度要問 /api/version、/api/show
    if (req.url === '/ollama/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'llama3:8b' }, { id: 'qwen:7b' }] })); }
    if (req.url === '/api/version') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ version: '0.9.0' })); }
    if (req.url === '/api/show') {
      const want = JSON.parse(b || '{}').model;
      const info = { 'llama3:8b': { model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 }, parameters: 'num_ctx 8192\nstop "<|eot_id|>"' },
        'qwen:7b': { model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 } } }[want];
      res.writeHead(info ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(info || { error: 'not found' }));
    }
    if (req.url === '/ctx/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'or-model', context_length: 200000 }, { id: 'or-small', top_provider: { context_length: 8192 } }, { id: 'or-none' }] })); }
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-b' }, { id: 'mock-a' }] })); }
    const body = JSON.parse(b || '{}');
    fs.writeFileSync(LOG, JSON.stringify(body, null, 2));
    // 模擬 LM Studio 的 Jinja 模板：system 只能在最前面
    if ((body.messages || []).some((m, i) => m.role === 'system' && i > 0)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 500, message: 'Error: Jinja Exception: System message must be at the beginning.', type: 'server_error' } }));
    }
    // 不認得 stream_options 的平台
    if (body.model === 'nousage' && body.stream_options) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
    }
    // 不會思考、不認得 reasoning_effort 的模型（每次請求都記下有沒有帶這個參數）
    if (body.model === 'noreason') {
      fs.appendFileSync(path.join(DIR, 'noreason.log'), ('reasoning_effort' in body ? 'R' : '-') + '\n');
      if ('reasoning_effort' in body) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } })); }
    }
    // 時好時壞：每兩次請求失敗一次（503）
    if (body.model === 'flaky' && (flaky++ % 2 === 0)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'The model is overloaded' } }));
    }
    // 像 OpenAI 的推理型模型：不接受 max_tokens（要用 max_completion_tokens），temperature 只能是預設值
    if (body.model === 'reasoner') {
      fs.appendFileSync(path.join(DIR, 'reasoner.log'), JSON.stringify({ max_tokens: body.max_tokens, mct: body.max_completion_tokens, temperature: body.temperature, top_p: body.top_p }) + '\n');
      if ('max_tokens' in body) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error', param: 'max_tokens' } })); }
      if ('temperature' in body && body.temperature !== 1) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.9 with this model. Only the default (1) value is supported.", type: 'invalid_request_error', param: 'temperature' } })); }
    }
    if (body.model === 'down') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"down"}}'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sse = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    // 有要求時，最後回報用量（和 OpenAI 一樣：choices 是空的 chunk）
    const usageChunk = () => { if (body.stream_options?.include_usage) sse({ choices: [], usage: { prompt_tokens: body.model === 'bigusage' ? 100000 : 1234, completion_tokens: 56, prompt_tokens_details: { cached_tokens: 1000 } } }); };
    if (body.model === 'think-only') { // 思考用光 token
      sse({ choices: [{ delta: { reasoning_content: '讓我想想……' } }] });
      sse({ choices: [{ delta: { reasoning_content: '要怎麼回答呢' } }] });
      sse({ choices: [{ delta: {}, finish_reason: 'length' }] }); res.write('data: [DONE]\n\n'); return res.end();
    }
    if (body.model === 'empty' || body.model === 'blocked') { // 什麼都沒回：empty 連結束原因都沒有（像 Gemini 3.8）；blocked 被安全過濾擋下
      fs.appendFileSync(path.join(DIR, 'empty.log'), body.model + '\n');
      if (body.model === 'blocked') sse({ choices: [{ delta: {}, finish_reason: 'content_filter' }] });
      res.write('data: [DONE]\n\n'); return res.end();
    }
    if (body.model === 'thinker') { // 思考型模型：先思考再回答
      sse({ choices: [{ delta: { reasoning_content: 'THINKER_THOUGHT' } }] });
      sse({ choices: [{ delta: { content: '思考後的回答' } }] });
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }); res.write('data: [DONE]\n\n'); return res.end();
    }
    if (body.model === 'think-tags') { // 內嵌 <think>
      sse({ choices: [{ delta: { content: '<think>內部思考' } }] });
      sse({ choices: [{ delta: { content: '</think>\n石榴汽水來囉～' } }] });
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }); res.write('data: [DONE]\n\n'); return res.end();
    }
    fs.appendFileSync(path.join(DIR, 'requests.log'), JSON.stringify(body) + '\n');
    // 導演規劃的請求：回傳固定的分鏡
    const lastMsg = String((body.messages || []).at(-1)?.content || '');
    if (lastMsg.includes('[導演指示')) {
      const plans = { // 在場判斷的各種情況
        presence: '在場：蘿亞\n重點：只有蘿亞在\n1. 蘿亞：回應旅人\n2. 艾迪娜：也想說話\n3. 旁白：收尾',
        enter: '在場：蘿亞\n重點：艾迪娜趕來\n1. 蘿亞：大聲叫艾迪娜\n2. 艾迪娜：聽到呼喚趕來（登場）',
        nobody: '在場：無\n重點：四下無人',
        leave: '在場：蘿亞、艾迪娜\n重點：艾迪娜先走\n1. 蘿亞：道別\n2. 艾迪娜：說要先回去了（離場）',
        noplan: '（想不出來）', // 看不懂的規劃：改用規則挑選
      };
      const plan = plans[body.model] || '重點：測試劇情\n1. 蘿亞：提醒大家小心\n2. 艾迪娜：接著回應蘿亞（插話）\n3. 旁白：收尾';
      const send = () => { sse({ choices: [{ delta: { content: plan } }] }); sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }); res.write('data: [DONE]\n\n'); res.end(); };
      if (body.model === 'slow') return setTimeout(send, 1500); // 慢速模型：導演也想得比較久
      return send();
    }
    // 整理角色卡規則：分段格式（前面故意多一段說明文字，測試容錯解析）；其他模型名稱測試各種壞掉的情況
    if (lastMsg.includes('[角色卡規則清單]')) {
      const outs = {
        badjson: '我整理不出來',
        // 舊的 JSON 格式，而且字串裡直接換行（模型常犯的錯）
        jsonorg: '```json\n{"shared": "不要替 {{user}} 說話。\n保持角色。", "members": [{"ref": "M1", "keep": "M1_JSON\n第二行"}], "conflicts": []}\n```',
      };
      const out = outs[body.model] ?? '好的，以下是整理結果：\n【共用規則】\n不要替 {{user}} 說話或決定行動。\n\n【M1（規則測試）】\nM1_KEEP 說話帶口癖\n第二條規則\n【M9】\n不存在的角色\n【衝突】\n- 回應長度要求不同\n';
      if (body.model === 'sloworg') { // 慢慢想：約 3 秒才回；中途被取消時記下來（測試取消後有沒有真的停）
        const t = setTimeout(() => { fs.appendFileSync(path.join(DIR, 'sloworg.log'), 'done\n'); sse({ choices: [{ delta: { content: out } }] }); sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }); res.write('data: [DONE]\n\n'); res.end(); }, 3000);
        res.on('close', () => { if (!res.writableEnded) { clearTimeout(t); fs.appendFileSync(path.join(DIR, 'sloworg.log'), 'aborted\n'); } });
        return;
      }
      if (body.model === 'thinkorg') sse({ choices: [{ delta: { reasoning_content: '想了很久……' } }] });
      else sse({ choices: [{ delta: { content: out } }] });
      sse({ choices: [{ delta: {}, finish_reason: body.model === 'thinkorg' ? 'length' : 'stop' }] }); usageChunk(); res.write('data: [DONE]\n\n'); return res.end();
    }
    // 狀態欄：思考裡的假標籤＋正文最後的狀態（標籤拆在兩段送出）；只寫部分欄位；寫到一半被截斷
    const STATUS_PARTS = {
      status: ['<thinking>想一下 <status>[角色]\n心情：假的</status></thinking>', '好的，我們出發吧。', '\n<sta', 'tus>\n[角色]\n心情： 緊張但期待\n好感度：35\n[玩家]\n- HP:92\n不存在的欄位：x\n</status>'],
      'status-partial': ['嗯。', '\n<status>\n好感度：140\n</status>'],
      'status-trunc': ['寫到一半', '\n<status>\n心情：'],
      expr: ['嗯……', '\n<expression>「SAD」</expression>\n<status>\n心情：低落\n</status>'], // 表情：大小寫、括號不同也認得
      'expr-bad': ['好。', '\n<expression>不存在的表情</expression>'], // 不在清單裡的表情：忽略
      // 大世界：角色發言（只收自己的分區＋玩家；寫到別人的略過）
      'wstatus-char': ['我有點不好意思。', '\n<expression>shy</expression>\n<status>\n[角色]\n心情：害羞\n[狀乙]\n心情：替別人亂寫\n[玩家]\nHP：70\n</status>'],
      // 大世界：旁白一次寫好幾個角色（表情一行一個「角色名：表情」，不能被當成替別人寫的台詞截掉）
      'wstatus-narr': ['兩人相視一笑。', '\n<expression>\n狀甲：joy\n狀乙：sad\n</expression>\n<status>\n[狀甲]\n心情：開心\n[狀乙]\n心情：難過\n[玩家]\nHP：50\n</status>'],
    };
    const parts = STATUS_PARTS[body.model] ? STATUS_PARTS[body.model]
      : body.model === 'leaky' ? ['蘿亞：我先說', '\n艾迪娜：我也要說', '\n旅人：好'] // 會替別人寫台詞
      : body.model === 'mention' ? ['艾迪娜你覺得呢。', '蘿亞也想聽聽看。', '今天的天氣很好。', '我們去散步吧。', '順便買點東西。', '最後回家休息。'] // 點名其他角色
      : ['啊啦……', '晚上好呀～', '「要喝點', '石榴汽水嗎？」', ' 呵呵～'];
    let i = 0;
    if (body.model === 'slowstart') { i = -100; } // 模擬忙碌：等約 6 秒才開始回應（i 從負數數到 0 之前不送內容）
    const t = setInterval(() => {
      if (i < 0) { i++; return; }
      if (i < parts.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
      else { res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`); usageChunk(); res.write('data: [DONE]\n\n'); clearInterval(t); res.end(); }
    }, body.model === 'slow' ? 700 : 60);
  });
}).listen(Number(process.env.MOCK_PORT) || 0, '127.0.0.1', function () { console.log('MOCK_READY ' + this.address().port); });
