# 暴力迪吧多人联机

基于 Ruffle 在浏览器运行 SWF 游戏，提供最多 5 人房间和两种联机方式：

- **P2P 公网联机**：Node.js 后端的 `/signal` WebSocket 路径负责交换 WebRTC 信令，游戏数据通过玩家之间的 WebRTC DataChannel 传输。
- **局域网 / 本机联机**：Node.js 后端的 `/ws` WebSocket 路径转发房间状态与游戏事件。

> 注意：P2P 当前仅配置 Google 公共 STUN（`stun:stun.l.google.com:19302`），没有配置 TURN。部分严格 NAT 或受限网络可能无法建立点对点连接。5 人公网联机仍需在不同网络环境下实际测试；信令连接成功不代表游戏同步已经完全验证。

## 环境要求

- Node.js 20 或更高版本（建议 Ubuntu 24.04 LTS）。
- npm。

## 本地启动

在项目根目录执行：

```bash
npm install
npm start
```

默认监听 `0.0.0.0:8787`。本机浏览器访问 `http://localhost:8787`。局域网内其他设备访问服务器的局域网 IP 和相同端口。

## Ubuntu 服务器部署

```bash
git clone https://github.com/guiwow911/madness-multiplayer.git
cd madness-multiplayer
npm install
npm start
```

生产环境建议使用 systemd 或进程管理器保持服务运行，并配置 HTTPS/WSS 反向代理。反向代理需支持 WebSocket Upgrade，并将 `/signal` 与 `/ws` 路径转发到 Node.js 服务。

默认端口为 `8787`，可通过环境变量 `PORT` 修改；监听地址可通过 `HOST` 修改。

## 测试

```bash
npm test
```

`test-lan.js` 会启动本地测试服务器，并检查静态资源、局域网 WebSocket 房间、开局、命中和状态同步等基本流程。

## 主要文件

- `server.js`：HTTP 静态文件服务、局域网 `/ws` 和 WebRTC 信令 `/signal`。
- `package.json` / `package-lock.json`：Node.js 项目配置与依赖锁定。
- `public/index.html`：网页入口和游戏界面。
- `public/client.js`：浏览器端大厅、游戏通信与 SWF 桥接。
- `public/p2p.js`：WebRTC Mesh 公网联机客户端。
- `public/style.css`：网页样式。
- `public/game.swf`：游戏 SWF 文件。
- `public/ruffle/`：本地 Ruffle Flash 兼容运行时及其 JS/WASM 资源。
- `test-lan.js`：局域网服务自动化测试。

`node_modules/` 不应提交到 GitHub；克隆后通过 `npm install` 安装依赖。
