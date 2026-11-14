// 分支问答：天枢用 ask_user_question 工具抛选项，必须推到 QQ 并支持回答。
// 事件结构（实测自 events?since=0）：
//   { type:'user_question', data:{ toolUseId, questions:[{ id, prompt, options[], optionDetails[], allowMultiple }] } }
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatQuestion, parseAnswer, resolveChoice } from '../src/question.js';
import { Store } from '../src/state.js';
import { Bridge } from '../src/bridge.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const SAMPLE = {
  toolUseId: 'call_00_abc',
  questions: [{
    id: 'q1',
    prompt: 'QQ 不支持 Markdown 渲染。你想怎么处理？',
    options: ['转成图片发', '只做文本清洗', '只处理 mermaid'],
    optionDetails: [
      { description: '渲染成图，观感接近 tianshu', recommended: true },
      { description: '去掉 markdown 符号' },
      { description: '只处理 mermaid' },
    ],
    allowMultiple: false,
  }],
};

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'qqbridge-q-'));
  return { path: join(dir, 'state.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('formatQuestion：把选项排成可读文本', () => {
  test('单题单选项：编号 + 题干 + 推荐标记', () => {
    const text = formatQuestion(SAMPLE);
    assert.match(text, /你想怎么处理/, '应含题干');
    assert.match(text, /1[.、)]\s*转成图片发/, '应含编号 1 的选项');
    assert.match(text, /3[.、)]\s*只处理 mermaid/, '应含编号 3 的选项');
    assert.match(text, /推荐|👍|✔/, '应标出推荐项');
  });

  test('多选时明确提示可多选', () => {
    const multi = {
      toolUseId: 'x',
      questions: [{ id: 'q1', prompt: '选哪些', options: ['a', 'b'], allowMultiple: true }],
    };
    assert.match(formatQuestion(multi), /多选|可多/, '应提示多选');
  });

  test('没选项时退化为让用户自由回答', () => {
    const open = { toolUseId: 'x', questions: [{ id: 'q1', prompt: '项目路径？', options: [] }] };
    const text = formatQuestion(open);
    assert.match(text, /项目路径/);
    assert.match(text, /回复|直接说/, '应提示直接回答');
  });
});

describe('parseAnswer：把用户回复解析成选择', () => {
  test('数字 1 选第一个选项', () => {
    assert.deepEqual(parseAnswer('1', SAMPLE.questions[0]), { kind: 'choice', indices: [0] });
  });

  test('「2」和「 2 」都能解析（容忍空白）', () => {
    assert.deepEqual(parseAnswer('  2 ', SAMPLE.questions[0]), { kind: 'choice', indices: [1] });
  });

  test('多选：1,3 解析成两项', () => {
    const multi = { ...SAMPLE.questions[0], allowMultiple: true };
    assert.deepEqual(parseAnswer('1,3', multi), { kind: 'choice', indices: [0, 2] });
    assert.deepEqual(parseAnswer('1 3', multi), { kind: 'choice', indices: [0, 2] });
  });

  test('非多选时给多个数字只取第一个（避免歧义）', () => {
    assert.deepEqual(parseAnswer('1,3', SAMPLE.questions[0]), { kind: 'choice', indices: [0] });
  });

  test('超出范围的编号不猜，当作自由文本', () => {
    assert.deepEqual(parseAnswer('9', SAMPLE.questions[0]), { kind: 'text', text: '9' });
  });

  test('普通文字当作自由回答', () => {
    assert.deepEqual(parseAnswer('用第一个方案吧', SAMPLE.questions[0]), { kind: 'text', text: '用第一个方案吧' });
  });
});

describe('resolveChoice：选择 → 给天枢的答案文本', () => {
  test('把编号还原成选项原文（模型需要文字而非数字）', () => {
    const out = resolveChoice({ kind: 'choice', indices: [0] }, SAMPLE.questions[0]);
    assert.equal(out, '转成图片发');
  });

  test('多选取值用顿号连接', () => {
    const multi = { ...SAMPLE.questions[0], allowMultiple: true };
    const out = resolveChoice({ kind: 'choice', indices: [0, 2] }, multi);
    assert.match(out, /转成图片发/);
    assert.match(out, /只处理 mermaid/);
  });

  test('自由文本原样返回', () => {
    assert.equal(resolveChoice({ kind: 'text', text: '随便' }, SAMPLE.questions[0]), '随便');
  });
});

describe('等待中的提问要持久化（重启后可继续回答）', () => {
  test('存进去能取回', () => {
    const t = tmpStore();
    try {
      const s = new Store(t.path);
      s.setPendingQuestion('private:1', SAMPLE);
      const got = s.pendingQuestion('private:1');
      assert.equal(got.toolUseId, 'call_00_abc');
      assert.equal(got.questions[0].options.length, 3);
    } finally { t.cleanup(); }
  });

  test('回答后清除', () => {
    const t = tmpStore();
    try {
      const s = new Store(t.path);
      s.setPendingQuestion('private:1', SAMPLE);
      s.clearPendingQuestion('private:1');
      assert.equal(s.pendingQuestion('private:1'), null);
    } finally { t.cleanup(); }
  });

  test('跨实例存活', () => {
    const t = tmpStore();
    try {
      const a = new Store(t.path);
      a.setPendingQuestion('private:1', SAMPLE);
      a.flush();
      const b = new Store(t.path);
      assert.equal(b.pendingQuestion('private:1')?.toolUseId, 'call_00_abc');
    } finally { t.cleanup(); }
  });
});

describe('Bridge：收到 user_question 要推到 QQ', () => {
  test('onTianshuEvent 遇到 user_question 会广播选项', async () => {
    const t = tmpStore();
    const sent = [];
    const b = new Bridge({
      ...structuredClone(DEFAULT_CONFIG),
      qq: { allowUsers: ['1'], allowGroups: [] },
      statePath: t.path,
    });
    try {
      b.onebot = { sendText: async (chat, text) => { sent.push([chat, text]); return { messageIds: [] }; }, sendImage: async () => ({ messageIds: [] }) };
      b.store.touchChat('private:1');
      b.store.subscribe('private:1', 'sess-q');

      b.onTianshuEvent('sess-q', { seq: 1, type: 'user_question', data: SAMPLE });
      await new Promise((r) => setTimeout(r, 60));

      assert.ok(sent.length > 0, '应有人收到消息');
      const joined = sent.map(([, t2]) => t2).join('\n');
      assert.match(joined, /你想怎么处理/, `应推送题干，实际：${joined.slice(0, 200)}`);
      assert.match(joined, /转成图片发/, '应推送选项');
    } finally { t.cleanup(); }
  });

  test('待答问题被记住，便于下一条消息识别为回答', async () => {
    const t = tmpStore();
    const b = new Bridge({ ...structuredClone(DEFAULT_CONFIG), qq: { allowUsers: ['1'], allowGroups: [] }, statePath: t.path });
    try {
      b.store.subscribe('private:1', 'sess-q');
      b.onTianshuEvent('sess-q', { seq: 1, type: 'user_question', data: SAMPLE });
      await new Promise((r) => setTimeout(r, 80));   // handleUserQuestion 是异步的
      assert.equal(b.store.pendingQuestion('private:1')?.toolUseId, 'call_00_abc');
    } finally { t.cleanup(); }
  });
});
