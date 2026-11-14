// 配置加载：文件缺失时写一份默认配置并提示用户填白名单。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_CONFIG = {
  tianshu: {
    // 天枢桌面端运行时会写这个文件，含 port / token / pid。
    // 留空则由 findServerInfo() 探测常见安装位置；探测不到请在配置里显式填写。
    serverInfoPath: '',
    timeoutMs: 15000,
  },
  onebot: {
    // forward: 桥接器主动连 NapCat 的 WS 服务端（NapCat 里叫「WebSocket 服务器」）
    // reverse: 桥接器自己起 WS 服务端，等 NapCat 连进来（NapCat 里叫「WebSocket 客户端」）
    mode: 'forward',
    forwardUrl: 'ws://127.0.0.1:3001',
    reversePort: 6700,
    reverseHost: '127.0.0.1',
    path: '/onebot',
    accessToken: null,
    // 一键启动（launch.js）用：NapCat 根目录（含 napimain.exe）与 QQ 可执行文件。
    // 留空则自动探测常见安装位置。
    napcatRoot: '',
    qqPath: '',
    // NapCat 的 config 目录，用来反推「哪个号对应这个转发端口」。留空自动推导。
    napcatConfigDir: '',
  },
  qq: {
    // 必填：留空则拒绝所有消息（fail-closed）
    allowUsers: [],
    allowGroups: [],
    // 机器人自己的 QQ 号。留空则由 launch.js 从 NapCat 配置里按转发端口反推，
    // 用来校验「登录的号是不是桥要连的那个」。
    botAccount: null,
  },
  push: {
    level: 'final',             // final：只推回合最终结果 | normal：流式过程 | quiet：最简
    maxChars: 900,
    includeToolCalls: true,
    includeThinking: false,
    idleFlushMs: 15000,   // final 模式的静默判定：实测相邻 turn 最小间隔 5.5s，取 15s 能跨过工具轮间隙
    // true：没有显式 /watch 时，也把会话动静推给所有聊过天的聊天
    autoForward: true,
    // 多久复查一次新开的会话（启动后才开跑的也能跟上）
    scanIntervalMs: 20000,
    // 图片附件：本地文件读不到时是否回退到 URL 下载
    imageUrlFallback: true,
    // NapCat 的图片缓存目录（只给文件名时去这里找）
    imageCacheDirs: [],
    // 把 Markdown 渲染成图片再发（QQ 不渲染 Markdown，渲染后观感接近天枢）
    renderMarkdown: true,
    chromePath: '',        // 留空自动探测系统 Chrome/Edge
    renderWidth: 760,
    renderDark: false,
  },
  statePath: './state.json',
};

/**
 * 探测天枢写的 server-info.json。天枢桌面端的数据目录位置随平台变化，
 * 这里只列常见位置；换机器或自定义安装目录时请在配置里显式指定。
 * @returns {string|null} 找到的路径，找不到返回 null
 */
export function findServerInfo() {
  const rel = 'TianshuData/.rivet/server-info.json';
  const home = homedir();
  const candidates = [
    process.env.TIANSHU_SERVER_INFO,
    `D:/tianshu/${rel}`,
    `C:/tianshu/${rel}`,
    `D:/Tianshu/${rel}`,
    `C:/Tianshu/${rel}`,
    resolve(`../tianshu/${rel}`),
    resolve(rel),
    `${home}/Library/Application Support/Tianshu/${rel}`,
    `${home}/Library/Application Support/tianshu/${rel}`,
    `${home}/.config/tianshu/${rel}`,
    `${home}/.local/share/tianshu/${rel}`,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return resolve(p);
    } catch { /* 试下一个 */ }
  }
  return null;
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra) || typeof base !== 'object' || typeof extra !== 'object' || !base || !extra) {
    return extra === undefined ? base : extra;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = deepMerge(base[k], v);
  return out;
}

export function loadConfig(path = './bridge.config.json') {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log(`[config] 已生成默认配置：${abs}`);
    console.log('[config] 必须填写 qq.allowUsers（你的 QQ 号），否则桥会拒绝处理所有消息。');
    const auto = findServerInfo();
    const cfg = structuredClone(DEFAULT_CONFIG);
    if (auto) cfg.tianshu.serverInfoPath = auto;
    return cfg;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON：${abs}（${err.message}）`);
  }
  const merged = deepMerge(DEFAULT_CONFIG, parsed);
  merged.statePath = resolve(dirname(abs), merged.statePath ?? './state.json');
  if (!merged.tianshu.serverInfoPath) {
    const auto = findServerInfo();
    if (auto) {
      merged.tianshu.serverInfoPath = auto;
    } else {
      console.warn('[config] 没找到天枢的 server-info.json。'
        + '请在 bridge.config.json 里显式设置 tianshu.serverInfoPath（天枢桌面端运行后会生成该文件）。');
    }
  }
  return merged;
}
