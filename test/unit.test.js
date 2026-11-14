// 单元层：不碰网络和真天枢，只验纯逻辑。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { splitChunks, pickToolDetail, Summarizer } from '../src/summarize.js';
import { splitForQq, normalizeIncoming, makeChatKey, parseChatKey } from '../src/onebot.js';
import { Store } from '../src/state.js';
import { Bridge } from '../src/bridge.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), 'qqbridge-'));
  return { path: join(dir, 'state.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('splitChunks / splitForQq', () => {
  test('短文本不切', () => {
    assert.deepEqual(splitChunks('hello', 100), ['hello']);
    assert.deepEqual(splitForQq('hello', 100), ['hello']);
  });

  test('长文本每段不超过上限，且不丢字', () => {
    const text = Array.from({ length: 40 }, (_, i) => `第${i}行内容`).join('\n');
    const chunks = splitChunks(text, 60);
    for (const chunk of chunks) assert.ok(chunk.length <= 60, `块太长：${chunk.length}`);
    const joined = chunks.join('').replace(/\s/g, '');
    assert.equal(joined, text.replace(/\s/g, ''), '切块后不应丢内容');
  });

  test('优先在换行处切，不拦腰截断代码', () => {
    const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50);
    const [first] = splitChunks(text, 60);
    assert.ok(first.endsWith('a'), `应在换行处切，实际结尾：${JSON.stringify(first.slice(-5))}`);
  });
});

describe('pickToolDetail', () => {
  test('优先取 command', () => {
    assert.equal(pickToolDetail('bash', { command: 'ls -la', file_path: '/x' }), 'ls -la');
  });
  test('没有 command 时取 file_path', () => {
    assert.equal(pickToolDetail('read_file', { file_path: '/a/b.js' }), '/a/b.js');
  });
  test('未知字段退化为 JSON', () => {
    assert.equal(pickToolDetail('x', { z: 1 }), '{"z":1}');
  });
  test('空入参返回空串', () => {
    assert.equal(pickToolDetail('x', null), '');
  });
});

describe('Summarizer 降噪', () => {
  test('text_delta 合并成一段，遇 turn_complete 才推', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '你好' } });
    s.handle({ seq: 2, type: 'text_delta', data: { text: '世界' } });
    assert.deepEqual(out, [], '正文不该逐字推');
    s.handle({ seq: 3, type: 'turn_complete', data: { usage: { input_tokens: 10, output_tokens: 5 } } });
    assert.equal(out[0], '你好世界');
    assert.match(out[1], /回合结束.*in 10.*out 5/);
  });

  test('tool_use 压成一行，且先冲刷正文', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '我先看看' } });
    s.handle({ seq: 2, type: 'tool_use', data: { name: 'bash', input: { command: 'ls -la' } } });
    assert.deepEqual(out, ['我先看看', '▸ bash: ls -la']);
  });

  test('tool_result 只在出错时推', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'tool_result', data: { name: 'bash', isError: false, result: 'ok' } });
    assert.deepEqual(out, []);
    s.handle({ seq: 2, type: 'tool_result', data: { name: 'bash', isError: true, result: 'EACCES' } });
    assert.match(out[0], /✗ bash 失败.*EACCES/);
  });

  test('重复 seq 被丢弃（断点重放不重复推）', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), idleFlushMs: 999999 });
    s.handle({ seq: 5, type: 'tool_use', data: { name: 'a', input: {} } });
    s.handle({ seq: 5, type: 'tool_use', data: { name: 'a', input: {} } });
    s.handle({ seq: 4, type: 'tool_use', data: { name: 'a', input: {} } });
    assert.equal(out.length, 1);
  });

  test('quiet 模式不推工具调用', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'quiet', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'tool_use', data: { name: 'bash', input: { command: 'ls' } } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    assert.deepEqual(out, []);
  });

  test('超长正文按上限切块', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), maxChars: 10, idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: 'a'.repeat(25) } });
    assert.ok(out.length >= 2, `应切块，实际 ${out.length} 块`);
    for (const c of out) assert.ok(c.length <= 10);
  });

  describe('final 模式：只在回合结束推最终结果', () => {
    test('流式正文不中途推，回合结束一次性推完整内容', async () => {
      const out = [];
      const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 10 });
      s.handle({ seq: 1, type: 'text_delta', data: { text: '第一段。' } });
      s.handle({ seq: 2, type: 'text_delta', data: { text: '第二段。' } });
      assert.deepEqual(out, [], '中途不该推任何东西');
      s.handle({ seq: 3, type: 'turn_complete', data: { usage: { input_tokens: 100, output_tokens: 20 } } });
      assert.deepEqual(out, [], '回合结束时还不该推（要等更久确认整轮真的结束）');
      s.flush();
      assert.equal(out.length, 1, `交付后应只有一条，实际 ${out.length}`);
      assert.equal(out[0], '第一段。第二段。');
    });

    test('工具调用不推（只要结果不要过程）', () => {
      const out = [];
      const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
      s.handle({ seq: 1, type: 'tool_use', data: { name: 'bash', input: { command: 'ls' } } });
      s.handle({ seq: 2, type: 'tool_use', data: { name: 'read_file', input: { file_path: '/x' } } });
      s.handle({ seq: 3, type: 'text_delta', data: { text: '结果在这。' } });
      assert.deepEqual(out, []);
      s.handle({ seq: 4, type: 'turn_complete', data: {} });
      s.flush();
      assert.equal(out.length, 1, `实际 ${JSON.stringify(out)}`);
      assert.equal(out[0], '结果在这。', '正文里不应夹带工具行');
    });

    test('有正文时不再追加收尾行（元数据也是噪音）', () => {
      const out = [];
      const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
      s.handle({ seq: 1, type: 'tool_use', data: { name: 'bash', input: {} } });
      s.handle({ seq: 2, type: 'text_delta', data: { text: '完成。' } });
      s.handle({ seq: 3, type: 'turn_complete', data: { usage: { output_tokens: 9 } } });
      s.flush();
      assert.deepEqual(out, ['完成。'], `有正文就只推正文，实际：${JSON.stringify(out)}`);
    });

    test('final 模式整段一次交付，不自己切块（切块归 bridge 管）', () => {
      // 切块不能放在 summarizer：
      //   - 每块单独判定「像不像 Markdown」→ 一条回复会一半图片一半文字
      //   - 多块并发渲染 → 谁先渲染完谁先发，顺序乱掉
      // 所以这里必须只 emit 一次，且内容是完整原文。
      const out = [];
      const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', maxChars: 10, idleFlushMs: 999999 });
      s.handle({ seq: 1, type: 'text_delta', data: { text: 'a'.repeat(25) } });
      s.handle({ seq: 2, type: 'turn_complete', data: {} });
      s.flush();
      assert.equal(out.length, 1, `应整段交付一次，实际 ${out.length} 条：${JSON.stringify(out.map(c => c.length))}`);
      assert.equal(out[0], 'a'.repeat(25), '内容不能丢、不能截断');
    });

    test('思考过程在 final 模式下永不推', () => {
      const out = [];
      const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', includeThinking: true, idleFlushMs: 999999 });
      s.handle({ seq: 1, type: 'thinking_delta', data: { text: '我该如何回答…' } });
      s.handle({ seq: 2, type: 'turn_complete', data: {} });
      assert.ok(!out.some((t) => t.includes('💭')), `不该出现思考：${JSON.stringify(out)}`);
    });
  });
});

describe('normalizeIncoming', () => {
  // 「只发一张图、不配文字」是最自然的用法之一。之前它被整条丢弃：
  //   const text = ...; if (!text) return null;
  // 用户发了图，桥这边毫无反应，也不知道为什么。
  describe('纯图片消息不能被丢弃', () => {
    const base = {
      post_type: 'message', message_type: 'private', user_id: 42,
      sender: { nickname: '小明' }, self_id: 9,
    };

    test('数组格式的纯图片 → 保留，text 为空', () => {
      const r = normalizeIncoming({
        ...base,
        message: [{ type: 'image', data: { file: 'a.jpg' } }],
        raw_message: '[CQ:image,file=a.jpg]',
      });
      assert.ok(r, '纯图片消息不该被丢掉');
      assert.equal(r.text, '');
      assert.equal(r.chatKey, 'private:42');
    });

    test('CQ 码串格式的纯图片 → 也保留', () => {
      const r = normalizeIncoming({
        ...base,
        message: '[CQ:image,file=a.jpg]',
        raw_message: '[CQ:image,file=a.jpg]',
      });
      assert.ok(r, 'CQ 码串形式同样不该被丢掉');
    });

    test('图 + 文 → 保留文字', () => {
      const r = normalizeIncoming({
        ...base,
        message: [{ type: 'text', data: { text: '看看这个' } }, { type: 'image', data: { file: 'a.jpg' } }],
        raw_message: '看看这个[CQ:image,file=a.jpg]',
      });
      assert.equal(r.text, '看看这个');
    });

    test('空消息（无字也无图）→ 仍然丢弃', () => {
      const r = normalizeIncoming({ ...base, message: [], raw_message: '' });
      assert.equal(r, null, '什么都没有的消息不该转发');
    });
  });

  test('私聊消息', () => {
    const r = normalizeIncoming({
      post_type: 'message', message_type: 'private', user_id: 42,
      raw_message: '你好', sender: { nickname: '小明' }, self_id: 9,
    });
    assert.equal(r.chatKey, 'private:42');
    assert.equal(r.text, '你好');
    assert.equal(r.senderName, '小明');
  });

  test('群聊消息', () => {
    const r = normalizeIncoming({
      post_type: 'message', message_type: 'group', group_id: 777, user_id: 42,
      raw_message: '/list', self_id: 9,
    });
    assert.equal(r.chatKey, 'group:777');
    assert.equal(r.chatId, 777);
  });

  test('从 message 段提取文本', () => {
    const r = normalizeIncoming({
      post_type: 'message', message_type: 'private', user_id: 1,
      message: [{ type: 'text', data: { text: 'ab' } }, { type: 'text', data: { text: 'cd' } }],
    });
    assert.equal(r.text, 'abcd');
  });

  test('非消息事件返回 null', () => {
    assert.equal(normalizeIncoming({ post_type: 'notice' }), null);
    assert.equal(normalizeIncoming({ post_type: 'meta_event' }), null);
    assert.equal(normalizeIncoming(null), null);
  });

  test('空文本返回 null', () => {
    assert.equal(normalizeIncoming({ post_type: 'message', message_type: 'private', user_id: 1, raw_message: '   ' }), null);
  });
});

describe('chatKey 工具函数', () => {
  test('往返一致', () => {
    assert.equal(parseChatKey(makeChatKey('private', 123)).id, '123');
    assert.equal(parseChatKey(makeChatKey('group', 456)).type, 'group');
    assert.equal(parseChatKey('bad'), null);
  });
});

describe('Store 持久化', () => {
  test('游标只前进不回退', () => {
    const t = tmpState();
    try {
      const s = new Store(t.path);
      s.setCursor('a', 10);
      s.setCursor('a', 5);
      assert.equal(s.cursor('a'), 10);
    } finally { t.cleanup(); }
  });

  test('绑定与列表缓存跨实例存活', () => {
    const t = tmpState();
    try {
      const s1 = new Store(t.path);
      s1.setBinding('private:1', 'sess-abc');
      s1.setListCache('private:1', ['sess-abc', 'sess-def']);
      s1.setCursor('sess-abc', 42);
      s1.flush();

      const s2 = new Store(t.path);
      assert.equal(s2.binding('private:1'), 'sess-abc');
      assert.deepEqual(s2.listCache('private:1'), ['sess-abc', 'sess-def']);
      assert.equal(s2.cursor('sess-abc'), 42);
      assert.deepEqual(s2.chatsFor('sess-abc'), ['private:1']);
    } finally { t.cleanup(); }
  });

  test('损坏的状态文件不阻断启动', () => {
    const t = tmpState();
    try {
      const s = new Store(t.path);
      s.flush();
      writeFileSync(t.path, '{ 坏掉的 json');
      const s2 = new Store(t.path);
      assert.equal(s2.cursor('x'), 0);
    } finally { t.cleanup(); }
  });
});

describe('白名单鉴权', () => {
  function makeBridge(qq) {
    const t = tmpState();
    const bridge = new Bridge({ ...structuredClone(DEFAULT_CONFIG), qq, statePath: t.path });
    bridge._cleanup = t.cleanup;
    return bridge;
  }

  test('白名单为空时拒绝一切（fail-closed，开源安全默认）', () => {
    const b = makeBridge({ allowUsers: [], allowGroups: [] });
    try {
      assert.match(b.checkAcl({ chatType: 'private', userId: 1, chatId: 1, text: 'hi', raw: '' }), /拒绝/);
    } finally { b._cleanup(); }
  });

  test('私聊：非白名单用户被拒', () => {
    const b = makeBridge({ allowUsers: ['10086'], allowGroups: [] });
    try {
      assert.match(b.checkAcl({ chatType: 'private', userId: 999, chatId: 999, text: 'hi', raw: '' }), /不在白名单/);
      assert.equal(b.checkAcl({ chatType: 'private', userId: 10086, chatId: 10086, text: 'hi', raw: '' }), null);
    } finally { b._cleanup(); }
  });

  test('群聊：未 @ 且非指令的闲聊被忽略', () => {
    const b = makeBridge({ allowUsers: [], allowGroups: ['555'] });
    try {
      assert.match(
        b.checkAcl({ chatType: 'group', userId: 1, chatId: 555, text: '今天天气不错', raw: '今天天气不错' }),
        /@我 或使用/,
      );
      assert.equal(
        b.checkAcl({ chatType: 'group', userId: 1, chatId: 555, text: '/status', raw: '/status' }),
        null,
      );
    } finally { b._cleanup(); }
  });

  test('群聊：不在白名单的群被拒', () => {
    const b = makeBridge({ allowUsers: [], allowGroups: ['555'] });
    try {
      assert.match(
        b.checkAcl({ chatType: 'group', userId: 1, chatId: 666, text: '/list', raw: '/list' }),
        /群不在白名单/,
      );
    } finally { b._cleanup(); }
  });
});

describe('final 模式：不推任何过程噪音（含回合结束行）', () => {
  test('纯工具轮（无正文）不推任何东西', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    for (let i = 0; i < 5; i++) s.handle({ seq: i * 2 + 1, type: 'tool_use', data: { name: 'bash', input: {} } });
    s.handle({ seq: 100, type: 'turn_complete', data: { usage: { output_tokens: 174863 } } });
    assert.deepEqual(out, [], `纯工具轮不该推任何东西，实际：${JSON.stringify(out)}`);
  });

  test('多轮 turn：只有带正文的那轮推出来', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    // 第 1 轮：纯工具
    s.handle({ seq: 1, type: 'tool_use', data: { name: 'bash', input: {} } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    // 第 2 轮：纯工具
    s.handle({ seq: 3, type: 'tool_use', data: { name: 'read_file', input: {} } });
    s.handle({ seq: 4, type: 'turn_complete', data: {} });
    // 第 3 轮：有正文
    s.handle({ seq: 5, type: 'text_delta', data: { text: '搞定了。' } });
    s.handle({ seq: 6, type: 'turn_complete', data: {} });
    s.flush();
    assert.deepEqual(out, ['搞定了。'], `只该推最终正文，实际：${JSON.stringify(out)}`);
  });

  test('status 事件不推（避免又一条噪音）', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'status', data: { status: 'completed' } });
    assert.deepEqual(out, []);
  });

  test('工具报错在 final 模式也不单独推（模型会在正文里说明）', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'tool_result', data: { name: 'bash', isError: true, result: 'EACCES' } });
    assert.deepEqual(out, [], `final 模式只要结果，实际：${JSON.stringify(out)}`);
  });
});

describe('final 模式：整轮聚合，只交付最终那段', () => {
  test('工具轮中间夹的正文不立即推，等静默后合并交付', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 50 });
    // 第 1 轮：有正文
    s.handle({ seq: 1, type: 'text_delta', data: { text: '我先看看目录。' } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    // 紧接着第 2 轮：又有正文（说明还没结束）
    s.handle({ seq: 3, type: 'tool_use', data: { name: 'bash', input: {} } });
    s.handle({ seq: 4, type: 'text_delta', data: { text: '发现问题了。' } });
    s.handle({ seq: 5, type: 'turn_complete', data: {} });
    // 此时不该推：中间段都是过程
    assert.deepEqual(out, [], `中间正文不该推，实际：${JSON.stringify(out)}`);
  });

  test('turn 之间静默再久也不推，只有 done 才交付最后一段', async () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 40 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '第一段。' } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    s.handle({ seq: 3, type: 'text_delta', data: { text: '最终结论是 X。' } });
    s.handle({ seq: 4, type: 'turn_complete', data: {} });
    await new Promise((r) => setTimeout(r, 120));
    // 实测相邻 turn 间隔常超 20s：任何按时间兜底的推送都会变成「每轮一条」。
    assert.deepEqual(out, [], `静默期不该推任何东西，实际：${JSON.stringify(out)}`);
    s.handle({ seq: 5, type: 'done', data: { status: 'completed' } });
    assert.deepEqual(out, ['最终结论是 X。'], `done 时只交付最后那段，实际：${JSON.stringify(out)}`);
  });

  test('flush()（会话切走/重启）也会把攒着的正文交付出去', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '攒着的内容。' } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    assert.deepEqual(out, []);
    s.flush();
    assert.deepEqual(out, ['攒着的内容。']);
  });
});

describe('error 事件：报错必须让手机那头看见', () => {
  // 真实故障：额度不足 / 鉴权失败时，天枢发 error 事件，
  // 事件序列是 done(completed) → error → done(failed)。
  // 之前 switch 里没有 case 'error'，落进 default 被静默丢弃，
  // 用户只看到"发了指令毫无反应"，完全不知道是额度或 key 的问题。

  test('final 模式：error 跟在本轮正文后一起交付', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: 'math 还没导入，补上。' } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    s.handle({ seq: 3, type: 'done', data: { status: 'completed' } });
    s.handle({ seq: 4, type: 'error', data: {
      error: 'OpenAI API error (insufficient_user_quota): Not enough quota',
      kind: 'quota',
      guidance: '请检查 API key 是否正确',
    } });
    s.handle({ seq: 5, type: 'done', data: { status: 'failed' } });

    assert.equal(out.length, 2, `应有正文+报错两条，实际 ${JSON.stringify(out)}`);
    assert.match(out[0], /math 还没导入/, '正文在前');
    assert.match(out[1], /insufficient_user_quota/, '报错必须出现');
    assert.match(out[1], /本轮失败/, '要说清这一轮失败了');
    assert.match(out[1], /请检查 API key/, 'guidance 要带上，能直接照做');
  });

  test('final 模式：纯报错（无正文）也要推出来', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'error', data: { error: 'missing_credentials', guidance: '重发一次' } });
    s.handle({ seq: 2, type: 'done', data: { status: 'failed' } });

    assert.equal(out.length, 1, `纯报错必须推一条，实际 ${out.length}`);
    assert.match(out[0], /missing_credentials/);
  });

  test('final 模式：失败但既无正文也无 error → 也要吭一声', () => {
    // 否则表现就是「发了指令，手机毫无反应」，最让人迷惑
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'tool_use', data: { name: 'bash', input: {} } });
    s.handle({ seq: 2, type: 'done', data: { status: 'failed' } });

    assert.equal(out.length, 1, `失败轮不该完全静默，实际 ${out.length}`);
    assert.match(out[0], /失败/);
  });

  test('final 模式：正常完成且无正文 → 不推（纯工具轮照旧静默）', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'tool_use', data: { name: 'bash', input: {} } });
    s.handle({ seq: 2, type: 'done', data: { status: 'completed' } });
    assert.deepEqual(out, [], '成功但没正文时不该发失败提示');
  });

  test('报错不会被下一轮静默吞掉', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'error', data: { error: '限流', guidance: '稍等再发' } });
    s.handle({ seq: 2, type: 'done', data: { status: 'failed' } });
    s.handle({ seq: 3, type: 'text_delta', data: { text: '第二轮正常。' } });
    s.handle({ seq: 4, type: 'done', data: { status: 'completed' } });

    assert.equal(out.length, 2);
    assert.match(out[0], /限流/, '报错先到');
    assert.match(out[1], /第二轮正常/, '第二轮不夹带上轮报错');
    assert.doesNotMatch(out[1], /限流/);
  });

  test('normal 模式：error 立刻推，不等 done', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'error', data: { error: 'ECONNRESET', guidance: '重试' } });
    assert.equal(out.length, 1);
    assert.match(out[0], /ECONNRESET/);
  });
});

describe('final 模式：用 done 事件判定整轮结束（不靠超时猜）', () => {
  test('收到 done 立即交付攒下的正文', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '中间说明。' } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    s.handle({ seq: 3, type: 'text_delta', data: { text: '最终结论。' } });
    s.handle({ seq: 4, type: 'turn_complete', data: {} });
    assert.deepEqual(out, [], 'done 之前不该推');
    s.handle({ seq: 5, type: 'done', data: { status: 'completed' } });
    assert.equal(out.length, 1, `done 后应立刻只推一条，实际 ${out.length}：${JSON.stringify(out)}`);
    assert.match(out[0], /最终结论/, '应包含最终正文');
  });

  test('done 后即使超时也不再重复推', async () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 30 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '内容。' } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    s.handle({ seq: 3, type: 'done', data: { status: 'completed' } });
    assert.equal(out.length, 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(out.length, 1, `不该重复推送，实际 ${out.length}`);
  });

  test('长回答含代码块：整段一次交付，片段不被拆散', () => {
    // 这条锁住「图文混杂 + 顺序反了」那个真实故障：
    // 报告前半段是代码块（会被判成 Markdown → 渲染成图），
    // 后半段是纯叙述（判成文本）。如果按块分别 emit，就会一半图一半字，
    // 且两块并发渲染导致到达顺序反了。
    const report = [
      '## 一键脚本验证通过',
      '',
      '```',
      '13:50:25  天枢 ⇄ QQ 桥 · 一键启动',
      '13:51:56  ✓ QQ 已在线：C（123456789）',
      '```',
      '',
      '**这个窗口不能关**，脚本是 NapCat 的父进程。',
      '上一轮那个推送修复这次随新代码一起生效。',
    ].join('\n');

    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: report } });
    s.handle({ seq: 2, type: 'done', data: { status: 'completed' } });

    assert.equal(out.length, 1, `整段只能交付一次，实际 ${out.length} 条（会变成图文混杂）`);
    assert.equal(out[0], report, '内容与顺序必须原样保留');
    assert.match(out[0], /^## 一键脚本验证通过/, '开头是标题，不能被挪到后面');
    assert.match(out[0], /随新代码一起生效。$/, '结尾是叙述，不能跑到前面');
  });

  test('done 但没有正文时不推（纯工具轮结束）', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'tool_use', data: { name: 'bash', input: {} } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    s.handle({ seq: 3, type: 'done', data: { status: 'completed' } });
    assert.deepEqual(out, [], `实际：${JSON.stringify(out)}`);
  });

  test('中间 turn 的播报被丢掉，只留最后那段回话', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '我先看看目录。' } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    s.handle({ seq: 3, type: 'tool_use', data: { name: 'bash', input: {} } });
    s.handle({ seq: 4, type: 'text_delta', data: { text: '发现问题了，开始修。' } });
    s.handle({ seq: 5, type: 'turn_complete', data: {} });
    s.handle({ seq: 6, type: 'tool_use', data: { name: 'bash', input: {} } });
    s.handle({ seq: 7, type: 'text_delta', data: { text: '修好了，结论：X。' } });
    s.handle({ seq: 8, type: 'turn_complete', data: {} });
    assert.deepEqual(out, [], 'done 之前一条都不该推');
    s.handle({ seq: 9, type: 'done', data: { status: 'completed' } });
    assert.deepEqual(out, ['修好了，结论：X。'], `只该推最后那段，实际：${JSON.stringify(out)}`);
  });

  test('最后一个 turn 只有工具、没正文：交付上一个有正文的 turn', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '总结：全部做完了。' } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    s.handle({ seq: 3, type: 'tool_use', data: { name: 'bash', input: {} } });
    s.handle({ seq: 4, type: 'turn_complete', data: {} });
    s.handle({ seq: 5, type: 'done', data: { status: 'completed' } });
    assert.deepEqual(out, ['总结：全部做完了。'], `实际：${JSON.stringify(out)}`);
  });

  test('最后一段没等到 turn_complete，done 直接交付残余正文', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '前面的。' } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    s.handle({ seq: 3, type: 'text_delta', data: { text: '最后的。' } });
    s.handle({ seq: 4, type: 'done', data: { status: 'completed' } });
    assert.deepEqual(out, ['最后的。'], `实际：${JSON.stringify(out)}`);
  });

  test('flush()（会话切走/重启）也只交付最后那段', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '中间播报。' } });
    s.handle({ seq: 2, type: 'turn_complete', data: {} });
    s.handle({ seq: 3, type: 'text_delta', data: { text: '最后回话。' } });
    s.handle({ seq: 4, type: 'turn_complete', data: {} });
    s.flush();
    assert.deepEqual(out, ['最后回话。'], `实际：${JSON.stringify(out)}`);
  });

  test('done 交付后，下一轮的正文从头攒起', () => {
    const out = [];
    const s = new Summarizer({ emit: (t) => out.push(t), level: 'final', idleFlushMs: 999999 });
    s.handle({ seq: 1, type: 'text_delta', data: { text: '第一问的答案。' } });
    s.handle({ seq: 2, type: 'done', data: { status: 'completed' } });
    s.handle({ seq: 3, type: 'text_delta', data: { text: '第二问的答案。' } });
    s.handle({ seq: 4, type: 'done', data: { status: 'completed' } });
    assert.equal(out.length, 2, `两轮应各推一条，实际：${JSON.stringify(out)}`);
    assert.equal(out[0], '第一问的答案。');
    assert.equal(out[1], '第二问的答案。');
  });
});
