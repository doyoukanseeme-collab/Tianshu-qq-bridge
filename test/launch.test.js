// launch.js：等 QQ 上线再起桥的判定逻辑。
// 重点不在"能不能跑起来"，而在"能不能分清没登录 / token 错 / 号不对"——
// 这三种情况给用户的处置方式完全不同，混淆了就等于没提示。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  explainProbeFailure,
  resolveEndpoint,
  detectExpectedAccount,
  waitForQqOnline,
  buildNapCatArgs,
  findNapCatRoot,
  findQqExe,
  defaultNapcatConfigDir,
  classifyStartState,
} from '../src/launch.js';

describe('explainProbeFailure：把底层错误翻成能照做的提示', () => {
  test('端口没人听 → not-running', () => {
    const r = explainProbeFailure(new Error('connect ECONNREFUSED 127.0.0.1:3001'));
    assert.equal(r.kind, 'not-running');
    assert.match(r.hint, /没启动|还没登录/);
  });

  test('握手 401 → auth（token 不对，而不是没登录）', () => {
    const r = explainProbeFailure(new Error('WebSocket 握手被拒：HTTP 401 Unauthorized'));
    assert.equal(r.kind, 'auth');
    assert.match(r.hint, /token/i);
  });

  test('超时 → timeout', () => {
    assert.equal(explainProbeFailure(new Error('WebSocket 连接超时')).kind, 'timeout');
  });

  test('对端不是 WS 服务 → handshake', () => {
    const r = explainProbeFailure(new Error('WebSocket 握手失败：Sec-WebSocket-Accept 不匹配'));
    assert.equal(r.kind, 'handshake');
  });

  test('认不出来的错误不吞掉原文', () => {
    const r = explainProbeFailure(new Error('奇怪的错误 EWEIRD'));
    assert.equal(r.kind, 'unknown');
    assert.match(r.hint, /EWEIRD/);
  });
});

describe('resolveEndpoint', () => {
  test('forward 模式解析出 url / token / port', () => {
    const r = resolveEndpoint({ mode: 'forward', forwardUrl: 'ws://127.0.0.1:3001', accessToken: 'tk' });
    assert.equal(r.ok, true);
    assert.equal(r.url, 'ws://127.0.0.1:3001');
    assert.equal(r.token, 'tk');
    assert.equal(r.port, 3001, '端口要能取出来——后面按端口反推是哪个号');
  });

  test('reverse 模式明确拒绝，而不是静默走错路', () => {
    const r = resolveEndpoint({ mode: 'reverse' });
    assert.equal(r.ok, false);
    assert.match(r.message, /forward/);
  });

  test('缺省值也能用（没配 forwardUrl 时退到默认 3001）', () => {
    const r = resolveEndpoint({});
    assert.equal(r.ok, true);
    assert.equal(r.port, 3001);
  });
});

describe('detectExpectedAccount：靠端口匹配，不靠文件名猜', () => {
  function makeConfigDir(files) {
    const dir = mkdtempSync(join(tmpdir(), 'napcat-cfg-'));
    for (const [name, obj] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(obj, null, 2));
    }
    return dir;
  }

  const withWs = (port, enable = true) => ({
    network: { websocketServers: [{ enable, name: 'tianshu-bridge', host: '127.0.0.1', port }] },
  });

  test('只有一个号：直接用它', () => {
    const dir = makeConfigDir({ 'onebot11_123456789.json': withWs(3001) });
    try {
      assert.equal(detectExpectedAccount({ configDir: dir }), '123456789');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('两个号都有配置时，按转发端口定位到带 3001 的那个', () => {
    // 真实场景：机器上登录过两个号，各自的 onebot11_*.json 都在。
    // 桥连的是 3001，所以答案是 123456789，不是 987654321。
    const dir = makeConfigDir({
      'onebot11_123456789.json': withWs(3001),
      'onebot11_987654321.json': withWs(3002),
    });
    try {
      assert.equal(detectExpectedAccount({ configDir: dir, port: 3001 }), '123456789');
      assert.equal(detectExpectedAccount({ configDir: dir, port: 3002 }), '987654321');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('port 为 null 且多个号 → 返回 null（不瞎猜）', () => {
    const dir = makeConfigDir({
      'onebot11_111111111.json': withWs(3001),
      'onebot11_222222222.json': withWs(3002),
    });
    try {
      assert.equal(detectExpectedAccount({ configDir: dir }), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('已禁用的 WS 服务器不算数', () => {
    const dir = makeConfigDir({
      'onebot11_123456789.json': withWs(3001, false),
      'onebot11_987654321.json': withWs(3001, true),
    });
    try {
      assert.equal(detectExpectedAccount({ configDir: dir, port: 3001 }), '987654321');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('显式指定的号优先于一切探测', () => {
    const dir = makeConfigDir({ 'onebot11_123456789.json': withWs(3001) });
    try {
      assert.equal(detectExpectedAccount({ configDir: dir, explicit: '999999999', port: 3001 }), '999999999');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('目录不存在 → null，不抛错', () => {
    assert.equal(detectExpectedAccount({ configDir: 'D:/绝对不存在的路径/x' }), null);
  });
});

describe('waitForQqOnline：轮询到真上线才返回', () => {
  const noSleep = async () => {};
  let clock = 0;
  const now = () => clock;
  const bump = (ms) => { clock += ms; };

  test('第一次就上线 → 立即成功', async () => {
    const r = await waitForQqOnline({
      probe: async () => ({ ok: true, userId: '123456789', nickname: 'C' }),
      sleep: noSleep, now,
    });
    assert.equal(r.ok, true);
    assert.equal(r.result.userId, '123456789');
  });

  test('前两次没登录、第三次上线 → 成功且带等待时长', async () => {
    clock = 0;
    const seq = [
      { ok: false, kind: 'not-running', hint: 'NapCat 没启动' },
      { ok: false, kind: 'not-logged-in', hint: 'WS 通了但没登录' },
      { ok: true, userId: '123456789', nickname: 'C' },
    ];
    let i = 0;
    const r = await waitForQqOnline({
      probe: async () => { bump(3000); return seq[i++]; },
      intervalMs: 3000, sleep: noSleep, now,
    });
    assert.equal(r.ok, true);
    assert.equal(i, 3);
    assert.equal(r.waitedMs, 9000);
  });

  test('一直不上线 → 超时，且把最后一次原因带出来', async () => {
    clock = 0;
    const r = await waitForQqOnline({
      timeoutMs: 10000,
      probe: async () => { bump(4000); return { ok: false, kind: 'not-running', hint: 'NapCat 没启动' }; },
      intervalMs: 1000, sleep: noSleep, now,
    });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'timeout');
    assert.match(r.message, /NapCat 没启动/, '超时也要说清卡在哪一步');
  });

  test('登录了但号不对 → wrong-account，立刻停（不傻等）', async () => {
    clock = 0;
    let calls = 0;
    const r = await waitForQqOnline({
      expectedAccount: '123456789',
      probe: async () => { calls++; return { ok: true, userId: '987654321', nickname: '某昵称' }; },
      timeoutMs: 600000, sleep: noSleep, now,
    });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'wrong-account');
    assert.equal(calls, 1, '号不对就不该继续轮询');
    assert.match(r.message, /987654321/);
    assert.match(r.message, /123456789/);
  });

  test('号对得上 → 成功', async () => {
    const r = await waitForQqOnline({
      expectedAccount: '123456789',
      probe: async () => ({ ok: true, userId: '123456789', nickname: 'C' }),
      sleep: noSleep, now,
    });
    assert.equal(r.ok, true);
  });

  test('数字型 userId 与字符串 expectedAccount 也判定为一致', async () => {
    const r = await waitForQqOnline({
      expectedAccount: '123456789',
      probe: async () => ({ ok: true, userId: 123456789, nickname: 'C' }),
      sleep: noSleep, now,
    });
    assert.equal(r.ok, true, '类型不同不该造成误报');
  });

  test('没给 probe 直接抛错（这是调用方 bug，不是运行时状况）', async () => {
    await assert.rejects(() => waitForQqOnline({}), /probe/);
  });

  test('轮询回调按实际等待时长上报', async () => {
    clock = 0;
    const ticks = [];
    let n = 0;
    await waitForQqOnline({
      timeoutMs: 20000,
      probe: async () => { bump(2000); return n++ < 2 ? { ok: false, kind: 'not-running' } : { ok: true, userId: '1' }; },
      intervalMs: 2000, sleep: noSleep, now,
      onTick: (t) => ticks.push(t.waitedMs),
    });
    assert.ok(ticks.length >= 2);
    assert.ok(ticks.every((v, i, a) => i === 0 || v > a[i - 1]), '等待时长应递增');
  });
});

describe('路径探测', () => {
  test('buildNapCatArgs 参数顺序固定：QQ → 注入 dll → 引导脚本', () => {
    const args = buildNapCatArgs({ root: 'R', qqExe: 'Q.exe' });
    assert.equal(args[0], 'Q.exe');
    assert.match(args[1], /napiloader\.dll$/);
    assert.match(args[2], /nativeLoader\.cjs$/);
  });

  test('路径探测绝不编造不存在的路径', () => {
    // 保障的不变量是「不编造路径」，不是「必须返回 null」：
    // 传一个不存在的显式路径时，函数会回落到自动探测；
    // 本机装了 NapCat/QQ 就会探到真的，没装才是 null。
    // 两者都合法，唯一不允许的是返回一个磁盘上不存在的路径。
    for (const fn of [findNapCatRoot, findQqExe, defaultNapcatConfigDir]) {
      const got = fn('D:/绝对不存在');
      assert.ok(got === null || existsSync(got), `${fn.name} 返回了不存在的路径：${got}`);
    }
  });
});

describe('注入判定：不能只看"有没有 QQ 进程"', () => {
  test('NapCat 已注入但 WS 未起时，不该被当成裸 QQ 去 kill', () => {
    // 真实场景：6099（WebUI）在监听 = NapCat 注入成功；
    // 但登录的号没配 WS 服务器，所以 3001 不在。
    const r = classifyStartState({
      probeKind: 'not-running',
      qqPidCount: 10,
      napcatAlive: true,     // 6099 在监听 / napimain 在
      wsPortListening: false,
    });
    assert.equal(r.action, 'report-ws-missing');
    assert.match(r.message, /WS|3001/, '应提示是 WS 服务器没起，而不是让人杀 QQ');
  });

  test('NapCat 完全没跑 + 有裸 QQ 进程 → 才提示需要重启 QQ 走注入', () => {
    const r = classifyStartState({
      probeKind: 'not-running',
      qqPidCount: 3,
      napcatAlive: false,
      wsPortListening: false,
    });
    assert.equal(r.action, 'bare-qq');
  });

  test('NapCat 没跑 + 没有 QQ 进程 → 直接拉起即可', () => {
    const r = classifyStartState({
      probeKind: 'not-running',
      qqPidCount: 0,
      napcatAlive: false,
      wsPortListening: false,
    });
    assert.equal(r.action, 'launch');
  });

  test('探测已成功 → 什么都不用做', () => {
    const r = classifyStartState({ probeKind: 'ok', qqPidCount: 5, napcatAlive: true, wsPortListening: true });
    assert.equal(r.action, 'none');
  });

  test('token 不对 → 明确是 token 问题，不碰 QQ', () => {
    const r = classifyStartState({ probeKind: 'auth', qqPidCount: 5, napcatAlive: true, wsPortListening: true });
    assert.equal(r.action, 'fix-token');
  });
});
