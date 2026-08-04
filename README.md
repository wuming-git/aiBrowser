# aiBrowser

AI 指纹浏览器桌面客户端（Electron + Vue3）。

## 运行

先启动后端 `aiBrowserService`，再：

```bash
cd D:\code\js\aiBrowser
npm install
npm run dev
```

需本机安装 Google Chrome。扩展目录：项目内 `chrome-extension/`。

API 地址见环境变量 `VITE_API_BASE`：

- 本地开发：`.env` / `.env.development` → `http://127.0.0.1:8080`
- 线上打包：`.env.production` → `https://browser168.com`（不要加 `/api`）

```bash
# 本地
npm run dev

# 仅构建渲染进程 + Electron 主进程
npm run build

# Windows 安装包（NSIS 全量包，产物在 release/）
npm run build:prod
```

桌面 Agent 还会连 `wss://域名/ws/desktop`，Nginx 需反代该 WebSocket。

发送消息前会走本地规则敏感词 / 内容安全分（不依赖本地 LLM）。

## 版本与自动更新

- 侧栏品牌区显示当前版本（如 `v0.1.0`），点击可手动检查更新。
- 已安装的打包客户端启动后会自动检查更新（开发模式跳过）。
- 更新源默认：`https://browser168.com/releases`（可用环境变量 `UPDATE_FEED_URL` 覆盖）。
- 更新形态：下载完整 NSIS 安装包后重启安装（全量更新）。

发布新版本：

1. 修改 `package.json` 的 `version`
2. 执行 `npm run build:prod`
3. 将 `release/` 中的 `latest.yml`、`browser168-Setup-x.y.z.exe`（及 `.blockmap` 若有）上传到服务器的 `/releases/` 目录，保证可通过：
   - `https://browser168.com/releases/latest.yml`
   - `https://browser168.com/releases/browser168-Setup-x.y.z.exe`
   访问

## 关联项目

- 后端：`D:\code\python\browser-agent`（或旧 `aiBrowserService`）
- 管理端：`D:\code\js\aiAdminWeb`
