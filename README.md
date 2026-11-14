# 暴力迪吧联合计划 · 网页联机测试包

基于 Ruffle 在浏览器运行 SWF 游戏，提供两人局域网 PVP 房间。游戏文件与 Ruffle WASM 资源单个约 14–15 MB，均低于 GitHub 100 MiB 单文件限制。若网页提示超过 25 MB，那是网页上传提示；请用 Git 命令推送整个仓库。

## 启动

需要 Node.js 18 或更高版本。

```sh
npm install
npm start
```

浏览器打开终端显示的 `http://localhost:8787`。局域网玩家访问主机显示的局域网 IP 地址，并选择相同房间代码。房主在两位玩家都加入后开始游戏。Windows 用户也可双击 `start.bat`。

## 测试

```sh
npm test
```

## 联机模式

- 局域网模式通过 Node.js WebSocket 服务转发房间状态、命中和玩家事件。
- 网页中预留了 P2P 模式界面；公网 P2P 需要可用的 WebRTC 信令服务。当前 `public/p2p.js` 中的信令端点为占位地址，尚未部署，因此公网 P2P 暂不可用。

## 文件说明

- `public/game.swf`：游戏文件。
- `public/ruffle/`：本地 Flash 运行时。
- `server.js`：静态网页与局域网房间服务。
- `public/client.js`：浏览器端游戏和房间客户端。
- `public/p2p.js`：WebRTC 客户端原型。

`node_modules/` 不提交到仓库，克隆后运行 `npm install` 安装依赖。
