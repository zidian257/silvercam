// pm2 fork 模式入口：pm2 用 require() 包装脚本，ESM 的 isMain 判断不成立，
// 这里无条件启动 server。直接 node 运行等效于 `node src/server/index.js`。
const path = require('node:path');
const { pathToFileURL } = require('node:url');

process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandledRejection:', e);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaughtException:', e);
  process.exit(1);
});

import(pathToFileURL(path.join(__dirname, 'index.ts')).href)
  .then((m) => m.startServer())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
