# pi-relay-server：pi 远程控制公网中继

自有 ECS（仅公网 IP、无域名）上的中继服务端，让手机在公网安全访问多台 Mac 上的 pi 会话。拓扑与 Codex/Claude Code 远程控制同款：**各 Mac 出站加密长连接 → 本中继 → 手机浏览器**；家里零入站端口，数据面不使用 SSH 隧道。

本机侧（agent / 三态开关 / 设备批准 CLI / pi-shell 集成）在 [pi-config](https://github.com/mhbzhy-lost/pi-config) 仓 `src/pi-relay/`；本仓是 **server 侧与协议的事实源**，pi-config 经 pinned tag 的 git 依赖消费 `pi-relay-server/protocol` 编译产物。

```
手机浏览器 ──HTTPS/WSS(TLS)──▶ 本中继（字节透明反向代理 + 设备批准制）
                              ▲  ▲ 出站 WSS（pinned CA，逐 Mac 独立 agentToken）
                          Mac-A  Mac-B …（≤16 台）
```

## 核心机制

- **字节透明代理**：终止手机侧 TLS 后，按连接做设备鉴权，随后原始 HTTP 字节经 WSS 数据通道直通 Mac 的 pi-web（keep-alive/WS/body 全部原生处理）。
- **设备批准制（零 token）**：手机首连 → `/pair` 配对页 6 位码 → 在对应 Mac 上 `node scripts/pi-relay.ts approve <码>` → HttpOnly Secure Cookie（1 年）。可信设备列表权威在**各 Mac 本机**，中继不落盘设备凭据；吊销即时切断。
- **多主机拍平列表**：中继聚合各在线 Mac 的 `/api/sessions`，手机单入口直接看全部会话（主机名徽章）；`/ws?host=` 精确路由；逐主机批准/吊销互不影响。
- **同局域网直连**：浏览器来源 IP 与某 Mac 的 NAT 出口 IP 相同且该 Mac 有 192.168 地址时，其会话条目携带 LAN 直连 URL，点击整页跳转（`?stay=1` 全路径抑制）。
- **协议版本握手**：`PROTOCOL_VERSION`（当前 2）；agent hello 携带版本，缺省视为 legacy 兼容，不匹配 close 4003。协议演进：本仓发 tag → pi-config bump 依赖 → 两侧部署。

## 部署（ECS）

前置：Node ≥ 22.19（nodejs.org 官方二进制）、系统 openssl/tar/git；安全组仅放行中继端口（默认 443，被占用时换端口并同步 url/安全组）。

```bash
git clone git@github.com:mhbzhy-lost/pi-relay-server.git ~/pi-relay-server
cd ~/pi-relay-server && npm ci          # 官方源；prepare 编译 dist（对外依赖产物）
node scripts/pi-relay-server.ts init --ip <ECS公网IP> [--port <端口>]
node scripts/pi-relay-server.ts start   # 前台；守护见下
```

init 生成 CA（10 年）/叶证书（398 天，IP SAN）/agentToken，打印注入材料——**由用户本人**粘贴进对应 Mac 的 `pi/settings.local.json`（gitignored）：

```json
{ "webExposure": "public", "webRelay": { "url": "wss://<IP>:<端口>", "agentToken": "…", "caFingerprint": "SHA256:…" } }
```

随后在该 Mac（pi-config 仓）：`node scripts/pi-relay.ts fetch-ca && node scripts/pi-relay.ts ensure`。

守护（二选一）：

```ini
# /etc/systemd/system/pi-relay.service
[Unit]
Description=pi-relay-server
After=network.target
[Service]
WorkingDirectory=/home/<user>/pi-relay-server
ExecStart=/usr/local/bin/node scripts/pi-relay-server.ts start
Restart=always
[Install]
WantedBy=multi-user.target
```

或 `nohup node scripts/pi-relay-server.ts start >>var/pi-relay/server.log 2>&1 &`。

**进程匹配一律用全路径**（如 `pgrep -f "pi-relay-server/scripts/pi-relay-server.ts"`）：迁移共存期新旧目录脚本同名，短模式会双杀。

## 多主机接入

```bash
node scripts/pi-relay-server.ts init --add-agent [--label <名称>]   # 保留 CA/既有 agent，仅打印新增注入材料
# 重启中继进程（配置 start 时加载一次，不热加载）
# 新 Mac：pi-config 仓 node scripts/pi-relay-join.ts（交互式：ssh 取回/粘贴 → 合并配置 → fetch-ca → ensure）
```

- CA 相同：手机无需再装证书；已批准手机（含 v1 Cookie）免重新配对。
- 手机对每台 Mac 各批准一次（列表页「添加主机」）；凭据合并进同一 Cookie（按主机键控，≤16）。
- `init --rotate-tokens`：轮换全部 agent token（保留 CA/id），逐份打印；重启中继后旧 token agent 收 4001 退出，各 Mac 更新注入后 ensure。

## 迁移（state 导出/导入）

代码经 git 走，**state 是迁移核心**（CA 私钥/叶证书/agent tokens）：

```bash
# 旧中继目录（本仓 CLI）
node scripts/pi-relay-server.ts export-state --out /tmp/pi-relay-state.tar.gz   # 0600
# 可信通道传输（用户 pem scp；不经聊天/公网明文），用后删除
# 新目录
node scripts/pi-relay-server.ts import-state /tmp/pi-relay-state.tar.gz [--force]
node scripts/pi-relay-server.ts start
```

- 白名单：`ca.key ca.crt server.key server.crt server-config.json`（+可选 `ca.srl`）；导入校验清单/路径穿越/配置形状/证书可读；目标已存在无 `--force` 拒绝。
- state 不变 → **手机免重信任/免重配对，Mac 免重注入**。
- 旧式 bundle 目录（无本 CLI）迁移：直接按白名单 tar 旧 `var/pi-relay/` 文件，新目录 import-state。
- 冷迁移（无 state）：重新 init → 新 CA/token → 手机重装 CA + 全员重配对 + 各 Mac 重注入。
- 回滚：停新进程（全路径匹配）→ 旧目录 start（state 未动）→ 即刻恢复。
- **警示**：state tarball 含 CA 私钥，泄露 = 中继完全失守（可对信任该 CA 的手机做任意域名 MITM）。

## 手机信任 CA（一次性）

浏览器访问 `https://<IP>:<端口>/ca.crt`，**核对指纹与 init 输出一致**后安装：iOS 设置→通用→关于本机→证书信任设置开启完全信任；Android 设置→安全→加密与凭据→CA 证书；鸿蒙把 `.crt` 改后缀 `.cer`/`.pem` 后从 加密和凭据→从存储设备安装。信任根 CA 的爆炸半径见上。

## 运维命令

```bash
node scripts/pi-relay-server.ts renew-cert [--ip …]   # 叶证书续签（保留 CA，手机无感），重启生效
curl -s https://<IP>:<端口>/relay-status              # {agentOnline, agents:[{id,name,online}], waitingPairs}
```

日志纪律：中继日志只含事件类别与 channel id，**不含 URL/query/Cookie/token/配对码/hello 内容**。

## 排障

| 现象 | 处理 |
|---|---|
| agent 收 4001 退出 | agentToken 与中继不一致：核对注入值与 init 输出；rotate 后两侧同步 |
| agent 收 4003 退出 | 协议版本不匹配：pi-config bump pi-relay-server 依赖或者中继升级到对应 tag |
| 浏览器 503「本机离线」 | 对应 Mac 的 agent 未连接：Mac 侧 `status`/`ensure`，查其 var/pi-relay/agent.log |
| 手机 -324 ERR_EMPTY_RESPONSE | 用了 http:// 访问 TLS 端口，或漏写 :端口 落到既有服务 |
| 启动 EADDRINUSE | `ss -tln` 查占用（含 127.0.0.1 监听）；换端口重跑 init（保留凭据）再启动 |
| 验证监听 | 三要素：ss 有 0.0.0.0:<端口>、全路径 pgrep 存活、日志「中继已启动」；仅 grep 端口会误判别人的回环监听 |

## 安全边界与残余风险

- 未批准设备零能力（边缘拒绝，字节不到 Mac）；批准人在回路（approve 只在 Mac 本机 CLI）。
- 凭据最小化：手机持 secret，Mac 持哈希，中继仅配对期内存短暂持 secret；磁盘无设备凭据。
- 主机名暴露面：/pair 选择页与 /relay-status 对未鉴权请求可见主机名/在线态（无会话名）；私有部署可接受。
- 残余：已批准设备 = 完全终端控制权（丢失须在对应 Mac revoke）；ECS 被攻破可 MITM 已信任 CA 的手机并截取会话明文（中继终止 TLS，非端到端加密）；agentToken 泄露仅影响该 Mac 接入（可单独重建槽位）。

## 开发

```bash
npm ci && npm run typecheck   # 不新增测试（未授权）；typecheck 覆盖 src+scripts
npm run prepare               # 编译 dist（git 依赖安装时自动跑）
```

源码相对 import 保持 `.ts` 扩展名（ECS 直跑 Node type-stripping）；build 经 `rewriteRelativeImportExtensions` 重写产物 import——**不要改源码 import 为 .js**。`files` 白名单确保 dist 进 npm pack（.gitignore 排除 dist 但 pack 需要它）。