// 集成层：
//  - mock NapCat（扮演 OneBot 服务端）+ 真天枢 API（只读，不触发 LLM）
//  - stub 天枢客户端验「发指令走 prompt 还是 steer」的分支
//  - StreamManager 断点续流从持久化游标起订
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWsServer } from '../src/ws.js';
import { Bridge } from '../src/bridge.js';
import { DEFAULT_CONFIG, findServerInfo } from '../src/config.js';
import { Store } from '../src/state.js';
import { StreamManager } from '../src/stream.js';
import { dispatchText } from '../src/commands.js';

const SERVER_INFO = 'D:/tianshu/TianshuData/.rivet/server-info.json';
const TIANSHU_UP = existsSync(SERVER_INFO);

/** 起一个假 NapCat：收 action 回 ok，可主动推事件。不等连接——连接由桥接器发起。 */
async function startMockNapCat() {
  const actions = [];
  let conn = null;

  const srv = await createWsServer({
    port: 0,
    onConnection: (c) => {
      conn = c;
      c.on('message', (raw) => {
        let req;
        try { req = JSON.parse(raw); } catch { return; }
        actions.push(req);
        const data = req.action === 'get_login_info'
          ? { user_id: 999, nickname: '桥接机器人' }
          : { message_id: Math.floor(Math.random() * 1e6) };
        c.sendJson({ status: 'ok', retcode: 0, echo: req.echo, data });
      });
    },
  });

  return {
    srv,
    actions,
    get conn() { return conn; },
    /** 推一条 QQ 消息事件。 */
    pushMessage(msg) {
      if (!conn) throw new Error('桥接器还没连上来，无法推送事件');
      conn.sendJson({ post_type: 'message', self_id: 999, ...msg });
    },
    /** 等某个 action 出现（轮询）。 */
    async waitAction(action, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = actions.filter((a) => a.action === action);
        if (hit.length) return hit[hit.length - 1];
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`等不到 action ${action}，已收到：${actions.map((a) => a.action).join(',') || '(无)'}`);
    },
  };
}

function makeBridgeConfig(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbridge-int-'));
  return {
    config: {
      ...structuredClone(DEFAULT_CONFIG),
      ...overrides,
      statePath: join(dir, 'state.json'),
      tianshu: { serverInfoPath: findServerInfo() ?? '', ...(overrides.tianshu ?? {}) },
      qq: { allowUsers: ['12345'], allowGroups: [], ...(overrides.qq ?? {}) },
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('端到端：QQ 消息 → 桥 → mock NapCat 回执', { skip: !TIANSHU_UP && '天枢未运行，跳过' }, () => {
  let bridge;
  let mock;
  let cleanup;

  before(async () => {
    mock = await startMockNapCat();
    const made = makeBridgeConfig({
      onebot: { mode: 'forward', forwardUrl: mock.srv.url, path: '' },
    });
    cleanup = made.cleanup;
    made.config.push = { ...made.config.push, idleFlushMs: 50 };
    bridge = new Bridge(made.config);
    await bridge.start();
    // 等 OneBot ready（get_login_info 往返完成）
    const deadline = Date.now() + 4000;
    while (!bridge.onebot.ready && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  after(async () => {
    await bridge?.stop();
    try { mock?.conn.close(); } catch { /* 已断开 */ }
    await mock?.srv.close();
    cleanup?.();
  });

  test('/help 立即回指令表，不打天枢', async () => {
    const before = mock.actions.filter((a) => a.action === 'send_private_msg').length;
    mock.pushMessage({ message_type: 'private', user_id: 12345, raw_message: '/help' });
    const deadline = Date.now() + 4000;
    let hit = null;
    while (Date.now() < deadline) {
      const sent = mock.actions.filter((a) => a.action === 'send_private_msg');
      if (sent.length > before) { hit = sent[sent.length - 1]; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(hit, '没收到 /help 回复');
    assert.match(String(hit.params.message), /指令表/);
    assert.equal(hit.params.user_id, 12345);
  });

  test('/list 打到真天枢并回会话清单', async () => {
    const before = mock.actions.filter((a) => a.action === 'send_private_msg').length;
    mock.pushMessage({ message_type: 'private', user_id: 12345, raw_message: '/list' });
    const deadline = Date.now() + 6000;
    let hit = null;
    while (Date.now() < deadline) {
      const sent = mock.actions.filter((a) => a.action === 'send_private_msg');
      if (sent.length > before) { hit = sent[sent.length - 1]; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(hit, '没收到 /list 回复');
    const text = String(hit.params.message);
    assert.match(text, /会话列表/, `回复内容不对：${text.slice(0, 100)}`);
    assert.match(text, /\/use/, '应提示如何绑定');
  });

  test('非白名单 QQ 号被拒，且不触发天枢调用', async () => {
    const before = mock.actions.filter((a) => a.action === 'send_private_msg').length;
    mock.pushMessage({ message_type: 'private', user_id: 66666, raw_message: '/list' });
    await new Promise((r) => setTimeout(r, 600));
    const sent = mock.actions.filter((a) => a.action === 'send_private_msg');
    assert.equal(sent.length, before, '非白名单用户不该收到任何回复');
  });
});

describe('指令分支：idle 走 prompt、running 走 steer', () => {
  function stubBridge(status) {
    const made = makeBridgeConfig();
    const b = new Bridge(made.config);
    b._cleanup = made.cleanup;
    b.store.setBinding('private:1', 'sess-1');
    b.calls = [];
    b.client = {
      getSession: async () => ({ id: 'sess-1', status, lastSeq: 0 }),
      sendPrompt: async (id, text) => { b.calls.push(['prompt', id, text]); },
      steerSession: async (id, text) => { b.calls.push(['steer', id, text]); },
    };
    return b;
  }

  test('idle 会话收到文本 → sendPrompt', async () => {
    const b = stubBridge('idle');
    try {
      const receipt = await dispatchText(b, 'private:1', '修一下构建');
      assert.deepEqual(b.calls, [['prompt', 'sess-1', '修一下构建']]);
      assert.match(receipt, /已发送/);
    } finally { b._cleanup(); }
  });

  test('running 会话收到文本 → steerSession', async () => {
    const b = stubBridge('running');
    try {
      const receipt = await dispatchText(b, 'private:1', '顺便看下日志');
      assert.deepEqual(b.calls, [['steer', 'sess-1', '顺便看下日志']]);
      assert.match(receipt, /插话/);
    } finally { b._cleanup(); }
  });

  test('steer 报 idle 时自动回退到 prompt', async () => {
    const b = stubBridge('running');
    b.client.steerSession = async () => {
      const { TianshuError } = await import('../src/tianshu.js');
      throw new TianshuError('Session is not running', { status: 409, code: 'idle' });
    };
    try {
      const receipt = await dispatchText(b, 'private:1', '继续');
      assert.deepEqual(b.calls, [['prompt', 'sess-1', '继续']]);
      assert.match(receipt, /新起一轮/);
    } finally { b._cleanup(); }
  });

  test('会话已被删（404）→ 清绑定并提示', async () => {
    const b = stubBridge('idle');
    b.client.getSession = async () => {
      const { TianshuError } = await import('../src/tianshu.js');
      throw new TianshuError('not found', { status: 404 });
    };
    try {
      const receipt = await dispatchText(b, 'private:1', '在吗');
      assert.match(receipt, /已不存在/);
      assert.equal(b.store.binding('private:1'), null);
    } finally { b._cleanup(); }
  });

  test('未绑定时提示先绑定', async () => {
    const made = makeBridgeConfig();
    const b = new Bridge(made.config);
    try {
      const receipt = await dispatchText(b, 'private:2', '你好');
      assert.match(receipt, /还没绑定/);
    } finally { made.cleanup(); }
  });
});

describe('断点续流', () => {
  test('watch 时用持久化的游标作为 since', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbridge-stream-'));
    const statePath = join(dir, 'state.json');
    const store = new Store(statePath);
    store.setCursor('sess-x', 777);

    const seen = [];
    const fakeClient = {
      async *streamEvents(id, since, { signal } = {}) {
        seen.push({ id, since });
        yield { seq: since + 1, type: 'text_delta', data: { text: 'x' } };
        // 挂住模拟长连接，但要能被 abort 唤醒，否则测试进程退不出去
        await new Promise((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', resolve, { once: true });
        });
      },
    };
    const mgr = new StreamManager({
      getClient: async () => fakeClient,
      store,
      onEvent: () => {},
    });

    try {
      await mgr.watch('sess-x');
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(seen, [{ id: 'sess-x', since: 777 }], '应从游标 777 起订，而不是从 0 重放');
      assert.equal(store.cursor('sess-x'), 778, '收到事件后游标应前进');
    } finally {
      mgr.stopAll();
      store.flush();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fromLatest 时把游标对齐到会话末尾，不重放历史', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbridge-stream2-'));
    const statePath = join(dir, 'state.json');
    const store = new Store(statePath);
    const seen = [];
    const fakeClient = {
      async *streamEvents(id, since, { signal } = {}) {
        seen.push(since);
        await new Promise((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', resolve, { once: true });
        });
      },
    };
    const mgr = new StreamManager({ getClient: async () => fakeClient, store, onEvent: () => {} });
    try {
      await mgr.watch('sess-y', { fromLatest: true, lastSeq: 4242 });
      await new Promise((r) => setTimeout(r, 120));
      assert.deepEqual(seen, [4242]);
    } finally {
      mgr.stopAll();
      store.flush();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
