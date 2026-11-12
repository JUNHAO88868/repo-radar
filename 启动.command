#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。先装：https://nodejs.org（选 macOS 安装包）"
  read -r -p "按回车关闭…" _
  exit 1
fi
echo "正在启动 Repo Radar…"
(sleep 1.5 && open "http://127.0.0.1:4321") &
node server.mjs
