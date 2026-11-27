#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js，請先安裝 Node.js 22 以上版本：https://nodejs.org/"
  exit 1
fi
if ! node -e "process.exit(+process.versions.node.split('.')[0] < 22 ? 1 : 0)"; then
  echo "Node.js $(node -v) 太舊了，AI 酒館需要 22 以上的版本：https://nodejs.org/"
  exit 1
fi
[ -d node_modules/@anthropic-ai/sdk ] || npm install --no-fund --no-audit
exec node launch.js
