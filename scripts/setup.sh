#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ -x /opt/homebrew/opt/node@22/bin/node ]; then
  NODE_BIN=/opt/homebrew/opt/node@22/bin/node
fi
if [ -z "$NODE_BIN" ]; then
  echo "未找到 node。brew install node@22"; exit 1
fi
echo "node: $("$NODE_BIN" --version) ($NODE_BIN)"

"$NODE_BIN" "$(command -v npm)" install --no-audit --no-fund
PATH="$(dirname "$NODE_BIN"):$PATH" "$NODE_BIN" node_modules/.bin/playwright install chromium

# CLI 单文件二进制（bun 只做打包器）
if command -v bun >/dev/null; then
  bun build --compile --minify bin/actpipe.js --outfile actpipe
  echo "CLI 已编译: $(pwd)/actpipe  （可拷入 PATH，如 /usr/local/bin/）"
else
  echo "未找到 bun，跳过 CLI 编译（brew install bun）。开发期可用: node bin/actpipe.js"
fi

echo
echo "== pm2 常驻 =="
echo "  $NODE_BIN $(command -v pm2 || echo 'pm2（npm i -g pm2）') start ecosystem.config.cjs"
echo "  pm2 startup launchd   # 登录自启"
echo "  pm2 save"
echo
echo "== 手动验证 =="
echo "  $NODE_BIN bin/actpipe.js watch        # 前台调试"
echo "  $NODE_BIN bin/actpipe.js status"
