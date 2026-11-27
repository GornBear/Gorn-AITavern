// 開發用的預覽伺服器（.claude/launch.json 用）：埠 8123，資料放在 data/preview/，不會動到真正的 userdata/、
// 也不會和平常用的 8000 搶埠。要換位置可以自己設定 PORT、TAVERN_DATA_DIR、TAVERN_CONFIG、TAVERN_WINDOW_FILE
'use strict';
const path = require('path');
const dir = path.join(__dirname, '..', 'data', 'preview');
process.env.PORT ||= '8123';
process.env.TAVERN_DATA_DIR ||= path.join(dir, 'userdata');
process.env.TAVERN_CONFIG ||= path.join(dir, 'config.json');
process.env.TAVERN_WINDOW_FILE ||= path.join(dir, 'window.json');
process.env.TAVERN_DOWNLOAD_DIR ||= path.join(dir, 'downloads'); // 匯出時直接存檔：不寫進真正的下載資料夾
process.env.TAVERN_PROFILE_DIR ||= path.join(dir, 'app-profile'); // 清理快取：不碰真正的 data/app-profile
console.log(`  預覽用的資料：${dir}`);
require('../server');
