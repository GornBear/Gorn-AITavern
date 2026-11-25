// 執行測試：npm test
// 啟動假的 AI 服務與一個使用暫存資料夾的酒館伺服器，跑完 api.test.js 後全部清掉；不會動到你的 userdata/（存檔與金鑰）
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-test-'));
const children = [];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const start = (args, env, readyText) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  let out = '';
  const timer = setTimeout(() => reject(new Error(`啟動逾時：${args.join(' ')}\n${out}`)), 15000);
  const onData = d => {
    out += d;
    const m = readyText.exec(out);
    if (m) { clearTimeout(timer); resolve(m); }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', d => (out += d));
  p.on('exit', code => { clearTimeout(timer); reject(new Error(`程序提早結束（${code}）：${args.join(' ')}\n${out}`)); });
});
function cleanup() {
  for (const p of children) { try { p.kill(); } catch { } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
}

(async () => {
  const logDir = path.join(tmp, 'mock');
  fs.mkdirSync(logDir);
  const mockPort = Number((await start([path.join(__dirname, 'mock-openai.js')], { MOCK_LOG_DIR: logDir }, /MOCK_READY (\d+)/))[1]);
  const port = await freePort();
  await start(['server.js'], {
    PORT: String(port), HOST: '127.0.0.1',
    TAVERN_DATA_DIR: path.join(tmp, 'data'), TAVERN_CONFIG: path.join(tmp, 'config.json'), TAVERN_WINDOW_FILE: path.join(tmp, 'window.json'), TAVERN_RUNTIME_DIR: path.join(tmp, 'runtime'),
    OPENAI_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '',
    TAVERN_GEMINI_URL: `http://127.0.0.1:${mockPort}/gemini`, // Gemini 原生 API 改連假的服務
    TAVERN_UPDATE_URL: `http://127.0.0.1:${mockPort}/github/releases/latest`, // 檢查更新改連假的服務
  }, /http:\/\/127\.0\.0\.1:\d+/);
  // 伺服器記錄存成檔案：測試可以檢查某些操作不會印出錯誤
  const serverLog = path.join(tmp, 'server.log');
  const srv = children[children.length - 1];
  for (const s of [srv.stdout, srv.stderr]) s.on('data', d => fs.appendFileSync(serverLog, d));

  const code = await new Promise(resolve => {
    const t = spawn(process.execPath, [path.join(__dirname, 'api.test.js')], {
      cwd: ROOT, stdio: 'inherit',
      env: { ...process.env, TEST_BASE: `http://127.0.0.1:${port}`, MOCK_URL: `http://127.0.0.1:${mockPort}`, MOCK_LOG_DIR: logDir, SERVER_LOG: serverLog, TAVERN_DATA_DIR: path.join(tmp, 'data'), TAVERN_CONFIG: path.join(tmp, 'config.json'), TAVERN_WINDOW_FILE: path.join(tmp, 'window.json'), TAVERN_RUNTIME_DIR: path.join(tmp, 'runtime') },
    });
    t.on('exit', resolve);
  });
  cleanup();
  process.exit(code);
})().catch(e => { console.error(e.message || e); cleanup(); process.exit(1); });
