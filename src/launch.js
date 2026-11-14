#!/usr/bin/env node
/**
 * 一键启动：先等 QQ 真正上线，再启动桥。
 *
 * 为什么不能"看端口开了就起桥"：
 *   3001 端口只在 NapCat 登录成功之后才监听，端口通 ≠ QQ 在线。
 *   反过来，端口通也可能是上一个会话的残留。唯一可信的判据是
 *   完成 WS 握手后调 get_login_info 拿到 user_id。
 *
 * 为什么不能"直接双击 napiLoader.bat"：
 *   napimain.exe 从 stdin 读"按任意键"，stdin 一 EOF 它就退出，
 *   并把注入的 QQ 一起带走（表现为 QQ 闪退）。所以这里 spawn 时
 *   必须给它一个保持打开 stdin（stdio[0] = 'pipe' 且从不 end）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { WsClient } from './wsclient.js';
import { Socket } from 'node:net';

const NAPCAT_ROOTS = [
  'D:/NapCat/NapCat.Framework',
  'C:/NapCat/NapCat.Framework',
];
const QQ_EXES = [
  'C:/Program Files/Tencent/QQNT/QQ.exe',
  'C:/Program Files (x86)/Tencent/QQNT/QQ.exe',
];

const DEFAULT_TIMEOUT_MS = 1_200_000;  // 等扫码；别太小气，超时会把 QQ 一起关掉
const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_PROBE_MS = 8_000;

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * 把探测失败的原因翻译成能直接照做的话。
 * @param {unknown} input Error 或字符串
 */
export function explainProbeFailure(input) {
  const msg = String(input?.message ?? input ?? '');
  if (/ECONNREFUSED/i.test(msg)) {
    return { kind: 'not-running', hint: 'NapCat 没启动，或起了但还没登录 QQ' };
  }
  if (/HTTP\s*(401|403)/i.test(msg)) {
    return { kind: 'auth', hint: 'accessToken 与 NapCat WebUI 里配的那个对不上' };
  }
  if (/超时|timeout/i.test(msg)) {
    return { kind: 'timeout', hint: '端口无响应：可能被别的进程占用，或被防火墙拦了' };
  }
  if (/ECONNRESET|socket hang up/i.test(msg)) {
    return { kind: 'reset', hint: '连接被对端掐断，NapCat 可能正在重启' };
  }
  if (/Sec-WebSocket-Accept/i.test(msg)) {
    return { kind: 'handshake', hint: '握手校验失败：对端不是 OneBot WS 服务' };
  }
  return { kind: 'unknown', hint: msg || '未知错误' };
}

/** 从 config.onebot 解析出要探测的地址与 token（目前只支持 forward 模式）。 */
export function resolveEndpoint(onebot = {}) {
  if ((onebot.mode ?? 'forward') !== 'forward') {
    return { ok: false, message: '一键启动只支持 onebot.mode = "forward"（桥主动连 NapCat）' };
  }
  const url = onebot.forwardUrl ?? 'ws://127.0.0.1:3001';
  let port = null;
  try { port = Number(new URL(url).port) || null; } catch { /* 非法 URL 就留空 */ }
  return { ok: true, url, token: onebot.accessToken ?? null, port };
}

/**
 * 找出"应该登录哪个号"。
 *
 * NapCat 每个号各有一份 onebot11_<号>.json。机器上登录过多个号时，
 * 光看文件名分不出来——真正的判据是：哪一份配置里启用了监听 forwardUrl
 * 那个端口的 WebSocket 服务器。带着 3001 的那份，才是桥要连的号。
 *
 * 优先级：显式指定 → 按端口匹配 → 唯一的 onebot11_* → null（不校验）。
 * @param {{configDir?: string, explicit?: string|null, port?: number|null}} opts
 */
/**
 * 判定「探测失败」之后到底该干什么。
 * 关键点：QQ 进程存在 ≠ 需要 kill。NapCat 注入的 QQ 也是 QQ.exe，
 * 判定必须看「NapCat 本身活没活」（WebUI 端口 / napimain 进程），
 * 否则会把已注入的 QQ 误判成裸进程，让用户白杀一遍。
 * @returns {{action:'none'|'fix-token'|'report-ws-missing'|'bare-qq'|'launch', message?:string}}}
 */
export function classifyStartState({ probeKind, qqPidCount = 0, napcatAlive = false, wsPortListening = false }) {
  if (probeKind === 'ok') return { action: 'none' };
  if (probeKind === 'auth') return { action: 'fix-token' };

  // NapCat 活着但 WS 端口没起：是配置问题，不是 QQ 的问题
  if (napcatAlive && !wsPortListening) {
    return {
      action: 'report-ws-missing',
      message: 'NapCat 已在运行，但 WS 服务器端口没监听。'
        + '通常是当前登录的号没有配 WS 服务器：去 WebUI 网络配置里给它加一个，'
        + '或换成已经配好的那个号。不要杀 QQ。',
    };
  }

  // NapCat 没活、却有 QQ 在跑：这些 QQ 没被注入，得重启它们
  if (!napcatAlive && qqPidCount > 0) {
    return { action: 'bare-qq', message: `检测到 ${qqPidCount} 个未被注入的 QQ 进程` };
  }

  return { action: 'launch' };
}

/** 探测 NapCat 本身活没活：WebUI 端口打开，或 napimain 进程在。 */
export async function isNapCatAlive({ webuiPort = 6099 } = {}) {
  const hasNapimain = await new Promise((resolve) => {
    const c = spawn('tasklist', ['/FI', 'IMAGENAME eq napimain.exe', '/FO', 'CSV', '/NH'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString('utf8'); });
    c.on('error', () => resolve(false));
    c.on('close', () => resolve(/napimain\.exe/i.test(out)));
  });
  if (hasNapimain) return true;
  // 再看 WebUI 端口
  return new Promise((resolve) => {
    const sock = new Socket();
    sock.setTimeout(1200);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
    sock.connect(webuiPort, '127.0.0.1');
  });
}

export function detectExpectedAccount({ configDir, explicit = null, port = null } = {}) {
  if (explicit) return String(explicit);
  if (!configDir || !existsSync(configDir)) return null;

  let names;
  try {
    names = readdirSync(configDir);
  } catch {
    return null;
  }

  const accounts = names
    .map((n) => /^onebot11_(\d{5,})\.json$/.exec(n))
    .filter(Boolean)
    .map((m) => ({ account: m[1], file: join(configDir, m[0]) }));
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0].account;

  // 多个号：按端口找。带该端口 WS 服务器的那份就是答案。
  if (port != null) {
    const hits = [];
    for (const a of accounts) {
      const servers = readWsServers(a.file);
      if (servers.some((s) => s.enable !== false && Number(s.port) === Number(port))) {
        hits.push(a.account);
      }
    }
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/** 读一份 onebot11 配置里的 websocketServers（读不到就当空）。 */
function readWsServers(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const list = j?.network?.websocketServers;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 在候选目录里找可用的 NapCat 根目录（必须有 napimain.exe）。 */
export function findNapCatRoot(explicit) {
  const list = explicit ? [explicit, ...NAPCAT_ROOTS] : NAPCAT_ROOTS;
  for (const p of list) if (p && existsSync(join(p, 'napimain.exe'))) return p;
  return null;
}

/** NapCat 的 config 目录：优先显式，其次从根目录推导；推导不出来返回 null。 */
export function defaultNapcatConfigDir(napcatRoot) {
  const root = findNapCatRoot(napcatRoot ?? null);
  if (!root) return null;
  const dir = join(root, 'config');
  return existsSync(dir) ? dir : null;
}

/** 找 QQ 可执行文件。 */
export function findQqExe(explicit) {
  const list = explicit ? [explicit, ...QQ_EXES] : QQ_EXES;
  for (const p of list) if (p && existsSync(p)) return p;
  return null;
}

/** 拼 napimain.exe 的命令行参数（顺序固定：QQ、注入 dll、引导脚本）。 */
export function buildNapCatArgs({ root, qqExe }) {
  return [qqExe, join(root, 'napiloader.dll'), join(root, 'nativeLoader.cjs')];
}

/** 探测当前正在跑的 QQ 进程号（只支持 Windows；其它平台返回空）。 */
export async function listQqPids() {
  if (process.platform !== 'win32') return [];
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const pids = [];
      for (const line of out.split(/\r?\n/)) {
        const m = /^"[^"]+","(\d+)"/.exec(line.trim());
        if (m) pids.push(m[1]);
      }
      resolve(pids);
    });
  });
}

/**
 * 探测一次：WS 握手 + get_login_info。
 * @returns {Promise<{ok:boolean, kind:string, userId?:string|null, nickname?:string|null, message?:string, hint?:string}>}
 */
export function probeQq({ url, token, timeoutMs = DEFAULT_PROBE_MS } = {}) {
  return new Promise((resolve) => {
    const ws = new WsClient();
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.close(); } catch { /* 已断开 */ }
      resolve(result);
    };

    timer = setTimeout(() => {
      finish({ ok: false, kind: 'timeout', message: '探测超时', hint: '端口无响应' });
    }, timeoutMs);
    timer.unref?.();

    ws.on('open', () => {
      // 握手成功不等于登录成功；必须问一次账号信息
      const echo = `probe-${Date.now()}`;
      const onMessage = (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg?.echo !== echo) return;         // 事件推送，忽略
        ws.off?.('message', onMessage);
        if (msg.status === 'failed' || msg.retcode !== 0) {
          finish({ ok: false, kind: 'api', message: `get_login_info 失败：${msg.message ?? msg.wording ?? msg.retcode}` });
          return;
        }
        const userId = msg.data?.user_id != null ? String(msg.data.user_id) : null;
        finish({
          ok: Boolean(userId),
          kind: userId ? 'online' : 'not-logged-in',
          userId,
          nickname: msg.data?.nickname ?? null,
          message: userId ? '已登录' : 'WS 通了但没有登录账号',
        });
      };
      ws.on('message', onMessage);
      try {
        ws.sendJson({ action: 'get_login_info', params: {}, echo });
      } catch (err) {
        finish({ ok: false, kind: 'api', message: err.message });
      }
    });

    ws.on('error', (err) => {
      const e = explainProbeFailure(err);
      finish({ ok: false, ...e, message: err.message });
    });

    try {
      ws.connect(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, timeoutMs });
    } catch (err) {
      const e = explainProbeFailure(err);
      finish({ ok: false, ...e, message: err.message });
    }
  });
}

/**
 * 轮询直到 QQ 上线。
 * @param {object} opts
 * @param {() => Promise<object>} opts.probe        注入探测函数（测试用）
 * @param {string|null} [opts.expectedAccount]      期望登录的 QQ 号，不符则直接失败
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.intervalMs]
 * @param {(s:{waitedMs:number,result:object}) => void} [opts.onTick]
 * @param {() => number} [opts.now]                 注入时钟（测试用）
 * @param {(ms:number) => Promise<void>} [opts.sleep]
 */
export async function waitForQqOnline(opts = {}) {
  const {
    probe,
    expectedAccount = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    onTick = () => {},
    now = Date.now,
    sleep: sleepFn = sleep,
  } = opts;

  if (typeof probe !== 'function') throw new Error('waitForQqOnline 需要 probe 函数');
  const t0 = now();
  let last = null;

  for (;;) {
    const result = await probe();
    last = result;

    if (result?.ok) {
      if (expectedAccount && String(result.userId) !== String(expectedAccount)) {
        return {
          ok: false,
          kind: 'wrong-account',
          result,
          expectedAccount,
          waitedMs: now() - t0,
          message: `当前登录的是 ${result.userId}（${result.nickname ?? '?'}），但配置对应 ${expectedAccount}`,
        };
      }
      return { ok: true, result, waitedMs: now() - t0, message: result.message ?? '已登录' };
    }

    const waitedMs = now() - t0;
    if (waitedMs >= timeoutMs) {
      return {
        ok: false,
        kind: 'timeout',
        result: last,
        waitedMs,
        message: `等了 ${Math.round(waitedMs / 1000)}s 仍未就绪：${last?.hint ?? last?.message ?? ''}`,
      };
    }

    onTick({ waitedMs, result: last });
    await sleepFn(intervalMs);
  }
}

/**
 * 拉起 NapCat（注入模式下启动 QQ）。
 * stdin 用 pipe 且永不 end —— napimain.exe 见到 EOF 会退出并带走 QQ。
 */
export function spawnNapCat({ root, qqExe, log = () => {} }) {
  const args = buildNapCatArgs({ root, qqExe });
  log(`拉起 NapCat：${join(root, 'napimain.exe')}`);
  const child = spawn(join(root, 'napimain.exe'), args, {
    cwd: root,
    // 三个管道缺一不可：
    //   stdin  —— napimain 读「按任意键」，EOF 就退出并带走 QQ；这里永不 end()
    //   stdout / stderr —— 也必须接管道并有消费者。实测给 'ignore' 时
    //                      napimain 写日志会 EPIPE，QQ 跟着闪退。
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // 把 NapCat 的关键日志转到自己的输出，刷屏的 hook 调试行丢掉
  const KEEP = /\[NapCat\]|WebUi|二维码|QRCode|登录|Login|error|Error|失败/i;
  let buf = '';
  const relay = (stream) => {
    if (!stream) return;
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (KEEP.test(line)) log(`  [napcat] ${line.replace(/\x1b\[[0-9;]*m/g, '').trim()}`);
      }
    });
    stream.on('error', () => {});
  };
  relay(child.stdout);
  relay(child.stderr);

  child.on('error', (err) => log(`NapCat 启动失败：${err.message}`));
  return child;
}

/** 从 QQNT 注册表项拿 QQ 路径（findQqExe 的兜底）。 */
export async function detectQqExeFromRegistry() {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    const child = spawn('reg', [
      'query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
      '/v', 'UninstallString',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = /UninstallString\s+REG_SZ\s+(.+)/i.exec(out);
      if (!m) return resolve(null);
      const dir = m[1].trim().replace(/[\\/][^\\/]+$/, '');
      const exe = join(dir.replace(/\\/g, '/'), 'QQ.exe');
      resolve(existsSync(exe) ? exe : null);
    });
  });
}

// ---------------- CLI ----------------

function parseArgs(argv) {
  const opts = {
    configPath: './bridge.config.json',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    noNapcat: false,
    killQq: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-napcat') opts.noNapcat = true;
    else if (a === '--kill-qq') opts.killQq = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--interval') opts.intervalMs = Number(argv[++i]) * 1000;
    else if (!a.startsWith('-')) opts.configPath = a;
  }
  return opts;
}

const HELP = `用法：node src/launch.js [配置路径] [选项]

等 QQ 上线后再启动桥。选项：
  --timeout <秒>   等 QQ 上线的上限，默认 1200
  --interval <秒>  轮询间隔，默认 3
  --no-napcat      不自动拉起 NapCat（只等待，NapCat 自己起）
  --kill-qq        检测到裸 QQ 进程（没注入 NapCat）时先结束它再拉 NapCat
  -h, --help       显示本帮助
`;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const log = (msg) => console.log(`${stamp()} ${msg}`);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  const config = loadConfig(opts.configPath);
  const ep = resolveEndpoint(config.onebot);
  if (!ep.ok) { log(`✗ ${ep.message}`); return 2; }

  const expected = detectExpectedAccount({
    configDir: config.onebot.napcatConfigDir || defaultNapcatConfigDir(config.onebot.napcatRoot),
    explicit: config.qq?.botAccount ?? null,
    port: ep.port,
  });

  log('天枢 ⇄ QQ 桥 · 一键启动');
  log(`探测地址：${ep.url}${ep.token ? '（带 token）' : '（无 token）'}`);
  log(expected ? `期望账号：${expected}（来自 NapCat 配置）` : '期望账号：未指定（只报告实际登录的号）');

  // 1. 先探一次：可能已经就绪，直接跳过去
  let probe = await probeQq({ url: ep.url, token: ep.token });
  if (probe.ok) {
    log(`✓ QQ 已在线：${probe.nickname ?? '?'}（${probe.userId}）`);
  } else if (probe.kind === 'auth') {
    log(`✗ token 不对：${probe.hint}`);
    log('  修 bridge.config.json 的 onebot.accessToken（值在 NapCat WebUI 的网络配置里）');
    return 2;
  } else {
    log(`· 尚未就绪：${probe.hint ?? probe.message}`);

    // 2. 没起来：先判清「是谁的问题」再动手——不能只看有没有 QQ 进程
    if (probe.kind === 'not-running') {
      const pids = await listQqPids();
      const napcatAlive = await isNapCatAlive();
      const state = classifyStartState({
        probeKind: probe.kind,
        qqPidCount: pids.length,
        napcatAlive,
        wsPortListening: false,     // 走到这里说明端口没探通
      });

      if (state.action === 'report-ws-missing') {
        log(`✗ ${state.message}`);
        log(`  排查：WebUI http://127.0.0.1:6099 → 网络配置 → 看当前登录号有没有 WebSocket服务器`);
        return 5;
      }

      if (state.action === 'bare-qq' && !opts.killQq) {
        log(`✗ 检测到 ${pids.length} 个裸 QQ 进程（${pids.join(', ')}），NapCat 没注入。`);
        log('  注入需要 QQ 由 NapCat 启动器拉起，请二选一：');
        log('    a) 手动关掉 QQ，然后重跑本脚本');
        log('    b) 加 --kill-qq，让脚本替你结束并重新拉起');
        return 3;
      }

      if (opts.killQq && pids.length > 0) {
        log(`结束裸 QQ 进程：${pids.join(', ')}`);
        for (const pid of pids) {
          await new Promise((res) => {
            const k = spawn('taskkill', ['/F', '/PID', pid], { windowsHide: true, stdio: 'ignore' });
            k.on('close', res); k.on('error', res);
          });
        }
        await sleep(2000);
      }

      if (opts.noNapcat) {
        log('· --no-napcat：只等待，不自动拉起 NapCat');
      } else {
        const root = findNapCatRoot(config.onebot.napcatRoot ?? null);
        const qqExe = findQqExe(config.onebot.qqPath ?? null) ?? (await detectQqExeFromRegistry());
        if (!root) {
          log('✗ 找不到 NapCat 目录（需要含 napimain.exe）');
          log(`  查过：${NAPCAT_ROOTS.join(' , ')}`);
          log('  可在 bridge.config.json 里设 onebot.napcatRoot 指定');
          return 4;
        }
        if (!qqExe) {
          log('✗ 找不到 QQ.exe，可在 bridge.config.json 里设 onebot.qqPath');
          return 4;
        }
        log(`QQ 路径：${qqExe}`);
        spawnNapCat({ root, qqExe, log });
        log('NapCat 已拉起。若弹出登录界面，请用手机扫码登录。');
        log('⚠ 本窗口关闭会连带关闭 NapCat / QQ（启动器的 stdin 会断开）');
      }
    }
  }

  // 3. 等 QQ 真正上线
  if (!probe.ok) {
    log(`等待 QQ 上线（最多 ${Math.round(opts.timeoutMs / 1000)}s，Ctrl+C 可以退出）…`);
    let lastTick = 0;
    const wait = await waitForQqOnline({
      probe: () => probeQq({ url: ep.url, token: ep.token }),
      expectedAccount: expected,
      timeoutMs: opts.timeoutMs,
      intervalMs: opts.intervalMs,
      onTick: ({ waitedMs, result }) => {
        if (waitedMs - lastTick < 15_000) return;   // 15s 报一次，别刷屏
        lastTick = waitedMs;
        // 刚拉起 NapCat 时，「WS 没通」的真实含义是「还没登录」——
        // 直接甩 ECONNREFUSED 会让人以为拉不起来、白等。
        const duringLogin = /ECONNREFUSED/i.test(result?.message ?? '')
          ? '等登录：NapCat 已拉起，端口登录成功后才监听'
          : (result?.hint ?? result?.message ?? '…');
        log(`  等待 ${Math.round(waitedMs / 1000)}s：${duringLogin}`);
      },
    });

    if (!wait.ok) {
      log(`✗ ${wait.message}`);
      if (wait.kind === 'wrong-account') {
        log('  两个办法：a) 退出当前号，登录配置对应的那个号；');
        log('           b) 接受这个号，把 bridge.config.json 的 onebot.accessToken');
        log('              换成 NapCat 里该号对应的 WS 配置 token');
      }
      return 5;
    }
    log(`✓ QQ 已在线：${wait.result.nickname ?? '?'}（${wait.result.userId}），等了 ${Math.round(wait.waitedMs / 1000)}s`);
  }

  // 4. 起桥（子进程，stdio 直通）
  log('启动桥…');
  const bridge = spawn(process.execPath, ['src/index.js', opts.configPath], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });

  const forward = (sig) => { try { bridge.kill(sig); } catch { /* 已退出 */ } };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  const code = await new Promise((resolve) => {
    bridge.on('close', (c) => resolve(c ?? 0));
    bridge.on('error', (err) => { log(`桥启动失败：${err.message}`); resolve(1); });
  });
  log(`桥已退出（code=${code}）`);
  return code;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain || /launch\.js$/.test(process.argv[1] ?? '')) {
  main().then((code) => process.exit(code)).catch((err) => {
    log(`✗ 启动失败：${err?.stack ?? err}`);
    process.exit(1);
  });
}
