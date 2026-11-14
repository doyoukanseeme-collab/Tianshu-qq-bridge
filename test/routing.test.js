// 引用路由：QQ 里「引用某条推送再回复」必须精确落到产生那条推送的会话上。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeIncoming } from '../src/onebot.js';
import { Store } from '../src/state.js';
import { Bridge } from '../src/bridge.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { dispatchText } from '../src/commands.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'qqbridge-route-'));
  return { path: join(dir, 'state.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('入站解析：引用段', () => {
  test('从 message 段数组里认出 reply', () => {
    const r = normalizeIncoming({
      post_type: 'message', message_type: 'private', user_id: 1, self_id: 9,
      message: [
        { type: 'reply', data: { id: '123456' } },
        { type: 'text', data: { text: '/use 2' } },
      ],
      raw_message: '[CQ:reply,id=123456]/use 2',
    });
    assert.equal(r.replyTo, '123456', '应解析出被引用的消息 id');
    assert.equal(r.text, '/use 2');
  });

  test('从 raw_message 的 CQ 码里兜底认出 reply', () => {
    const r = normalizeIncoming({
      post_type: 'message', message_type: 'private', user_id: 1,
      raw_message: '[CQ:reply,id=777]继续',
    });
    assert.equal(r.replyTo, '777');
    assert.equal(r.text, '继续');
  });

  test('没有引用时 replyTo 为 null', () => {
    const r = normalizeIncoming({
      post_type: 'message', message_type: 'private', user_id: 1, raw_message: '你好',
    });
    assert.equal(r.replyTo, null);
  });

  test('引用时正文不应夹带 reply 段的占位文本', () => {
    const r = normalizeIncoming({
      post_type: 'message', message_type: 'private', user_id: 1,
      message: [
        { type: 'reply', data: { id: '9' } },
        { type: 'text', data: { text: '看下这个' } },
      ],
      raw_message: '[CQ:reply,id=9]看下这个',
    });
    assert.equal(r.text, '看下这个');
  });
});

describe('消息索引：message_id → 会话', () => {
  test('存进去能查回来', () => {
    const t = tmpStore();
    try {
      const s = new Store(t.path);
      s.indexMessage(1001, 'sess-a');
      s.indexMessage(1002, 'sess-b');
      assert.equal(s.sessionForMessage(1001), 'sess-a');
      assert.equal(s.sessionForMessage(1002), 'sess-b');
      assert.equal(s.sessionForMessage(9999), null, '未知 id 应返回 null');
    } finally { t.cleanup(); }
  });

  test('超量时裁掉最旧的，不会无限增长', () => {
    const t = tmpStore();
    try {
      const s = new Store(t.path, { maxIndexedMessages: 5 });
      for (let i = 0; i < 12; i++) s.indexMessage(2000 + i, `sess-${i}`);
      const kept = Object.keys(s.data.messageIndex);
      assert.equal(kept.length, 5, `应只保留 5 条，实际 ${kept.length}`);
      assert.equal(s.sessionForMessage(2011), 'sess-11', '最新的必须在');
      assert.equal(s.sessionForMessage(2000), null, '最早的应被裁掉');
    } finally { t.cleanup(); }
  });

  test('索引跨实例存活（重启后引用仍能路由）', () => {
    const t = tmpStore();
    try {
      const s1 = new Store(t.path);
      s1.indexMessage(3001, 'sess-x');
      s1.flush();
      const s2 = new Store(t.path);
      assert.equal(s2.sessionForMessage(3001), 'sess-x');
    } finally { t.cleanup(); }
  });

  test('message_id 数字与字符串都能查', () => {
    const t = tmpStore();
    try {
      const s = new Store(t.path);
      s.indexMessage(4321, 'sess-n');
      assert.equal(s.sessionForMessage('4321'), 'sess-n');
    } finally { t.cleanup(); }
  });
});

describe('多会话关注', () => {
  test('一个聊天能关注多个会话', () => {
    const t = tmpStore();
    try {
      const s = new Store(t.path);
      s.subscribe('private:1', 'sess-a');
      s.subscribe('private:1', 'sess-b');
      assert.deepEqual(s.subscribed('private:1').sort(), ['sess-a', 'sess-b']);
    } finally { t.cleanup(); }
  });

  test('重复关注幂等', () => {
    const t = tmpStore();
    try {
      const s = new Store(t.path);
      s.subscribe('private:1', 'sess-a');
      s.subscribe('private:1', 'sess-a');
      assert.equal(s.subscribed('private:1').length, 1);
    } finally { t.cleanup(); }
  });

  test('退订后不再收到', () => {
    const t = tmpStore();
    try {
      const s = new Store(t.path);
      s.subscribe('private:1', 'sess-a');
      s.subscribe('private:1', 'sess-b');
      s.unsubscribe('private:1', 'sess-a');
      assert.deepEqual(s.subscribed('private:1'), ['sess-b']);
    } finally { t.cleanup(); }
  });

  test('chatsFor 汇总「绑定 + 关注」两种来源', () => {
    const t = tmpStore();
    try {
      const s = new Store(t.path);
      s.setBinding('private:1', 'sess-a');      // 默认会话
      s.subscribe('private:2', 'sess-a');       // 关注列表
      const chats = s.chatsFor('sess-a').sort();
      assert.deepEqual(chats, ['private:1', 'private:2'], `实际：${chats}`);
    } finally { t.cleanup(); }
  });
});

describe('引用路由：回复落到正确的会话', () => {
  function makeBridge(config = {}) {
    const t = tmpStore();
    const b = new Bridge({ ...structuredClone(DEFAULT_CONFIG), qq: { allowUsers: ['1'], allowGroups: [] }, statePath: t.path, ...config });
    b._cleanup = t.cleanup;
    b.calls = [];
    b.client = {
      getSession: async (id) => ({ id, status: 'idle', lastSeq: 0 }),
      sendPrompt: async (id, text) => { b.calls.push(['prompt', id, text]); },
      steerSession: async (id, text) => { b.calls.push(['steer', id, text]); },
    };
    return b;
  }

  test('引用了哪个会话的消息，就发给哪个会话', async () => {
    const b = makeBridge();
    try {
      // 模拟：sess-aaa 的推送发出去，QQ 返回 message_id 555
      b.store.indexMessage(555, 'sess-aaa');
      // 用户引用 555 回复「继续」
      const target = b.resolveReplyTarget('555');
      assert.equal(target, 'sess-aaa');
    } finally { b._cleanup(); }
  });

  test('引用了不认识的 id 时返回 null（调用方回退到默认会话）', () => {
    const b = makeBridge();
    try {
      assert.equal(b.resolveReplyTarget('999999'), null);
      assert.equal(b.resolveReplyTarget(null), null);
    } finally { b._cleanup(); }
  });

  test('dispatchText 支持显式指定会话，不看绑定', async () => {
    const b = makeBridge();
    try {
      b.store.setBinding('private:9', 'sess-default');
      const receipt = await dispatchText(b, 'private:9', '看下这个', { sessionId: 'sess-explicit' });
      assert.deepEqual(b.calls, [['prompt', 'sess-explicit', '看下这个']]);
      assert.match(receipt, /已发送/);
    } finally { b._cleanup(); }
  });

  test('显式指定时即使没绑定也能发', async () => {
    const b = makeBridge();
    try {
      const receipt = await dispatchText(b, 'private:9', '你好', { sessionId: 'sess-free' });
      assert.deepEqual(b.calls, [['prompt', 'sess-free', '你好']], '不应因为没绑定而拒绝');
      assert.ok(receipt);
    } finally { b._cleanup(); }
  });
});

describe('运行中新出现的会话要被自动追踪', () => {
  test('定期扫描：启动后才进入 running 的会话会被 attach', async () => {
    const t = tmpStore();
    const b = new Bridge({
      ...structuredClone(DEFAULT_CONFIG),
      qq: { allowUsers: ['1'], allowGroups: [] },
      statePath: t.path,
      push: { ...DEFAULT_CONFIG.push, autoForward: true },
    });
    try {
      let polled = 0;
      b.client = {
        listSessions: async () => {
          polled += 1;
          // 第一次没有，第二次出现一个新的 running 会话（模拟启动后才开跑）
          return polled === 1
            ? []
            : [{ id: 'sess-new-1234', status: 'running', lastSeq: 50, cwd: 'D:/x' }];
        },
        getSession: async (id) => ({ id, status: 'running', lastSeq: 50 }),
      };
      const attached = [];
      b.attachSession = async (id) => { attached.push(id); };

      await b.scanRunningSessions();
      assert.deepEqual(attached, [], '第一次扫描没有运行中会话');

      await b.scanRunningSessions();
      assert.deepEqual(attached, ['sess-new-1234'], `第二次应追踪新会话，实际：${JSON.stringify(attached)}`);
    } finally { t.cleanup(); }
  });

  test('已追踪的会话不重复 attach', async () => {
    const t = tmpStore();
    const b = new Bridge({ ...structuredClone(DEFAULT_CONFIG), qq: { allowUsers: ['1'], allowGroups: [] }, statePath: t.path });
    try {
      b.client = {
        listSessions: async () => [{ id: 'sess-dup', status: 'running', lastSeq: 1, cwd: 'D:/x' }],
        getSession: async (id) => ({ id, status: 'running', lastSeq: 1 }),
      };
      const attached = [];
      b.attachSession = async (id) => { attached.push(id); };
      b.streams.subs.set('sess-dup', { sessionId: 'sess-dup', stopped: false });   // 假装已在追踪

      await b.scanRunningSessions();
      assert.deepEqual(attached, [], '已在追踪的不该重复 attach');
    } finally { t.cleanup(); }
  });

  test('autoForward 关闭时不扫描', async () => {
    const t = tmpStore();
    const b = new Bridge({
      ...structuredClone(DEFAULT_CONFIG),
      qq: { allowUsers: ['1'], allowGroups: [] },
      statePath: t.path,
      push: { ...DEFAULT_CONFIG.push, autoForward: false },
    });
    try {
      let called = false;
      b.client = { listSessions: async () => { called = true; return []; } };
      await b.scanRunningSessions();
      assert.equal(called, false, 'autoForward=false 时不该扫会话');
    } finally { t.cleanup(); }
  });
});
