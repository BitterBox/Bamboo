#!/bin/bash

# 启动 Vite 开发服务器
pnpm dev &
VITE_PID=$!

# 等待 Vite 启动
sleep 3

# 启动 Electron
NODE_ENV=development pnpm exec electron .

# 清理：当 Electron 关闭时，也关闭 Vite
kill $VITE_PID
