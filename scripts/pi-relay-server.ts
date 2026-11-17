#!/usr/bin/env node
/**
 * pi-relay-server ECS 侧薄 CLI：init/start/renew-cert/export-state/import-state。
 * init 生成自签 CA/叶证书与 agentToken（唯一凭据事实源），打印注入材料供用户粘贴进本机 settings.local.json。
 * state 导出/导入用于中继迁移：CA/token 原样搬迁 → 手机免重信任/免重配对，Mac 免重注入。
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { caFingerprint, ensureCa, issueLeaf } from "../src/certs.ts";
import { MAX_AGENTS } from "../src/protocol.ts";
import { loadServerConfig, saveServerConfig, serverConfigPath, validateServerConfig, type AgentEntry, type RelayServerConfig } from "../src/server-config.ts";
import { startRelayServer } from "../src/server.ts";

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function flagAll(name: string): string[] {
  const result: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) result.push(process.argv[i + 1]!);
  }
  return result;
}

function detectedIps(): string[] {
  const result: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) result.push(net.address);
    }
  }
  return result;
}

async function init(): Promise<void> {
  const rotate = process.argv.includes("--rotate-tokens");
  const addAgent = process.argv.includes("--add-agent");
  const label = flag("--label");
  if (label !== undefined && (label.length === 0 || label.length > 40 || /[\u0000-\u001f\u007f]/.test(label))) {
    throw new Error("--label 必须是 1-40 字符且不含控制字符");
  }
  let existing: RelayServerConfig | null = null;
  try {
    existing = await loadServerConfig(root);
  } catch {
    // 首次 init
  }
  if (addAgent && !existing) throw new Error("--add-agent 需要已有配置：请先运行一次普通 init");
  if (addAgent && rotate) throw new Error("--add-agent 与 --rotate-tokens 不能同时使用");
  const listen = flag("--listen") ?? existing?.listen ?? "0.0.0.0";
  const port = Number(flag("--port") ?? existing?.port ?? 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port 必须是 1-65535 整数");
  const explicitIps = flagAll("--ip");
  const sanIps = [...new Set([...(explicitIps.length > 0 ? explicitIps : existing?.sanIps ?? detectedIps()), "127.0.0.1"])];

  let agents: AgentEntry[];
  if (!existing) {
    agents = [{ id: randomBytes(4).toString("hex"), token: randomBytes(32).toString("base64url"), ...(label !== undefined ? { label } : {}) }];
  } else if (addAgent) {
    if (existing.agents.length >= MAX_AGENTS) throw new Error(`agent 数量已达上限 ${MAX_AGENTS}`);
    agents = [...existing.agents, { id: randomBytes(4).toString("hex"), token: randomBytes(32).toString("base64url"), ...(label !== undefined ? { label } : {}) }];
  } else if (rotate) {
    agents = existing.agents.map((a) => ({ ...a, token: randomBytes(32).toString("base64url") }));
  } else {
    agents = existing.agents;
  }

  await ensureCa(root);
  await issueLeaf(root, sanIps);
  await saveServerConfig(root, { listen, port, agents, sanIps });
  const fingerprint = await caFingerprint(root);
  const publicIp = sanIps.find((ip) => ip !== "127.0.0.1") ?? "127.0.0.1";
  const url = `wss://${publicIp}${port === 443 ? "" : `:${port}`}`;

  // 打印范围：首次/rotate → 全部 agent；add-agent → 仅新增；普通重跑 → 全部（幂等保留）
  const printed = addAgent ? agents.slice(-1) : agents;
  console.log(addAgent ? "已新增 agent。请把以下材料注入新 Mac 的 pi/settings.local.json（gitignored）：" : "初始化完成。请把以下材料注入本机 pi/settings.local.json（gitignored）：");
  for (const agent of printed) {
    if (printed.length > 1) console.log(`--- agent ${agent.id}${agent.label ? `（${agent.label}）` : ""} ---`);
    console.log(JSON.stringify({ webExposure: "public", webRelay: { url, agentToken: agent.token, caFingerprint: `SHA256:${fingerprint}` } }, null, 2));
  }
  console.log("");
  console.log("随后在对应 Mac 运行：node scripts/pi-relay.ts fetch-ca && node scripts/pi-relay.ts ensure");
  if (rotate) console.log("注意：--rotate-tokens 轮换了全部 agent token，每台 Mac 都需更新注入值；重启中继后旧 token 的 agent 会收 4001 退出。");
  if (addAgent || rotate) console.log("配置在 start 时加载一次：请重启中继进程使变更生效。");
  console.log(`手机信任 CA：浏览器访问 https://${publicIp}${port === 443 ? "" : `:${port}`}/ca.crt 下载并核对指纹后安装；`);
  console.log("iOS 需在 设置→通用→关于本机→证书信任设置 开启完全信任；鸿蒙把 .crt 改后缀 .cer 后从 加密和凭据 安装 CA 证书。信任该根 CA 后本机被攻破可对手机做任意域名 MITM，不用时请删除描述文件。");
  console.log(`启动中继：node scripts/pi-relay-server.ts start（守护方式见本仓 README.md）`);
}

/** state 白名单：CA/叶证书私钥与配置（迁移核心）；ca.srl 为 -CAcreateserial 产物，缺失可重建 */
const STATE_FILES = ["ca.key", "ca.crt", "server.key", "server.crt", "server-config.json"];
const STATE_OPTIONAL = ["ca.srl"];

async function exportState(): Promise<void> {
  const dir = path.join(root, "var", "pi-relay");
  const present: string[] = [];
  for (const name of STATE_FILES) {
    try {
      await stat(path.join(dir, name));
      present.push(name);
    } catch {
      throw new Error(`缺少 state 文件 ${name}：请先运行 init`);
    }
  }
  for (const name of STATE_OPTIONAL) {
    try {
      await stat(path.join(dir, name));
      present.push(name);
    } catch {
      // 可选
    }
  }
  const out = path.resolve(flag("--out") ?? `pi-relay-state-${Date.now()}.tar.gz`);
  await execFileAsync("tar", ["-czf", out, "-C", dir, ...present]);
  await chmod(out, 0o600);
  console.log(`state 已导出：${out}（0600）`);
  console.log("警示：含 CA 私钥与 agent token，仅经可信通道传输（如 pem scp），用后删除；泄露 = 中继完全失守。");
}

async function importState(): Promise<void> {
  const file = process.argv[3];
  if (!file || file.startsWith("--")) throw new Error("用法：import-state <tarball> [--force]");
  const force = process.argv.includes("--force");
  const dir = path.join(root, "var", "pi-relay");
  // 清单校验：仅白名单平坦文件名，拒绝路径穿越/目录/符号链接形态
  const { stdout: listing } = await execFileAsync("tar", ["-tzf", file]);
  const entries = listing.split("\n").filter((l) => l.trim().length > 0);
  const allowed = new Set([...STATE_FILES, ...STATE_OPTIONAL]);
  for (const entry of entries) {
    if (!allowed.has(entry)) throw new Error(`tarball 含非白名单条目：${entry}（拒绝导入）`);
  }
  if (!entries.includes("server-config.json")) throw new Error("tarball 缺少 server-config.json");
  // 目标存在性：任一白名单文件已在 → 无 --force 拒绝
  for (const name of [...STATE_FILES, ...STATE_OPTIONAL]) {
    try {
      await stat(path.join(dir, name));
      if (!force) throw new Error(`目标已存在 ${name}：确认覆盖请加 --force`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  // 解到临时目录先校验（配置形状 + 证书可解析），再落目标
  const tmp = await mkdtemp(joinTmp());
  try {
    await execFileAsync("tar", ["-xzf", path.resolve(file), "-C", tmp]);
    const raw = JSON.parse(await readFile(path.join(tmp, "server-config.json"), "utf8")) as unknown;
    validateServerConfig(raw);
    await readFile(path.join(tmp, "ca.crt"), "utf8");
    await readFile(path.join(tmp, "server.crt"), "utf8");
    await readFile(path.join(tmp, "ca.key"), "utf8");
    await readFile(path.join(tmp, "server.key"), "utf8");
    await mkdir(dir, { recursive: true });
    for (const entry of entries) {
      await copyFile(path.join(tmp, entry), path.join(dir, entry));
      await chmod(path.join(dir, entry), 0o600);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  console.log("state 已导入并校验（配置形状/证书可读）；启动中继后 CA/token 与导出侧一致，手机/Mac 免重新配对/注入。");
}

function joinTmp(): string {
  return path.join(tmpdir(), "pi-relay-import-");
}

async function renewCert(): Promise<void> {
  const config = await loadServerConfig(root);
  const explicitIps = flagAll("--ip");
  const sanIps = [...new Set([...(explicitIps.length > 0 ? explicitIps : config.sanIps ?? detectedIps()), "127.0.0.1"])];
  await ensureCa(root);
  await issueLeaf(root, sanIps);
  if (explicitIps.length > 0) await saveServerConfig(root, { ...config, sanIps });
  console.log("叶证书已用既有 CA 续签（398 天），重启中继进程生效；手机无需重新信任。");
}

const command = process.argv[2];
try {
  if (command === "init") {
    await init();
  } else if (command === "start") {
    const { close } = await startRelayServer(root);
    const shutdown = (): void => {
      void close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else if (command === "renew-cert") {
    await renewCert();
  } else if (command === "export-state") {
    await exportState();
  } else if (command === "import-state") {
    await importState();
  } else {
    console.error("用法：node scripts/pi-relay-server.ts <init [--listen 地址] [--port 端口] [--ip 公网IP]… [--add-agent [--label 名称]] [--rotate-tokens] | start | renew-cert [--ip 公网IP]… | export-state [--out 路径] | import-state <tarball> [--force]>");
    console.error(`配置文件：${serverConfigPath(root)}`);
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}