// delivery.js：决定「哪些部分发文本、哪些必须画图」，以及它们的前后顺序。
// 这里锁住用户提的两条要求：
//   1. 能用文本的全用文本（代码块、表格也算文本）
//   2. 只有 mermaid 这类文本表达不了的才画图，且顺序不能乱
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitForDelivery,
  mermaidToMarkdown,
  mermaidToFallbackText,
  hasImageSegment,
} from '../src/delivery.js';

describe('splitForDelivery：按顺序切出文本段与图片段', () => {
  test('纯文本 → 只有一段文本，不画图', () => {
    const segs = splitForDelivery('好的，已完成。');
    assert.deepEqual(segs, [{ kind: 'text', text: '好的，已完成。' }]);
    assert.equal(hasImageSegment(segs), false);
  });

  test('代码块（非 mermaid）→ 留在文本里，不单独抽出来画图', () => {
    // 这是用户明确要求：代码能用文本表达，就该发文本（可复制、可搜索）
    const md = '看这里：\n\n```js\nconsole.log(1)\n```\n\n完。';
    const segs = splitForDelivery(md);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].kind, 'text');
    assert.match(segs[0].text, /console\.log\(1\)/, '代码内容不能丢');
  });

  test('表格 → 留在文本里', () => {
    const segs = splitForDelivery('| a | b |\n|---|---|\n| 1 | 2 |');
    assert.equal(segs.length, 1);
    assert.equal(segs[0].kind, 'text');
  });

  test('mermaid → 抽成图片段，两侧文本各自成段', () => {
    const md = ['开头说明。', '', '```mermaid', 'graph LR', 'A-->B', '```', '', '结尾说明。'].join('\n');
    const segs = splitForDelivery(md);
    assert.equal(segs.length, 3, `应切 3 段，实际 ${JSON.stringify(segs.map(s => s.kind))}`);
    assert.equal(segs[0].kind, 'text');
    assert.equal(segs[1].kind, 'mermaid');
    assert.equal(segs[2].kind, 'text');
  });

  test('顺序必须保持：文本在前、图在中、文本在后', () => {
    // 这条直接对应故障现象「顺序反了」——段序就是发送序，不能靠渲染耗时决定
    const md = ['【前】', '```mermaid', 'graph TD\nA-->B', '```', '【后】'].join('\n');
    const segs = splitForDelivery(md);
    assert.equal(segs[0].text, '【前】');
    assert.equal(segs[1].kind, 'mermaid');
    assert.equal(segs[2].text, '【后】');
  });

  test('开头的 mermaid → 第一段就是图片，没有空文本段', () => {
    const md = ['```mermaid', 'graph TD', 'A-->B', '```', '后面的话。'].join('\n');
    const segs = splitForDelivery(md);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].kind, 'mermaid', '前面不该插一个空文本段');
    assert.equal(segs[1].text, '后面的话。');
  });

  test('结尾的 mermaid → 最后一段是图片', () => {
    const md = ['前面的话。', '```mermaid', 'graph TD', 'A-->B', '```'].join('\n');
    const segs = splitForDelivery(md);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].text, '前面的话。');
    assert.equal(segs[1].kind, 'mermaid');
  });

  test('多张 mermaid → 全部按原顺序抽出', () => {
    const md = [
      'A段', '```mermaid', 'graph LR', 'X-->Y', '```',
      'B段', '```mermaid', 'graph TD', 'P-->Q', '```', 'C段',
    ].join('\n');
    const kinds = splitForDelivery(md).map((s) => s.kind);
    assert.deepEqual(kinds, ['text', 'mermaid', 'text', 'mermaid', 'text']);
  });

  test('围栏没闭合（流被截断）→ 仍当作图片段，内容不丢', () => {
    const md = ['说明。', '```mermaid', 'graph LR', 'A-->B'].join('\n');
    const segs = splitForDelivery(md);
    assert.equal(segs.length, 2);
    assert.equal(segs[1].kind, 'mermaid');
    assert.match(segs[1].code, /A-->B/);
  });

  test('大小写不敏感：```Mermaid 也认', () => {
    const segs = splitForDelivery('```Mermaid\ngraph LR\nA-->B\n```');
    assert.equal(segs[0].kind, 'mermaid');
  });

  test('空输入 → 空数组，不产生空消息', () => {
    assert.deepEqual(splitForDelivery(''), []);
    assert.deepEqual(splitForDelivery('   \n\n  '), []);
    assert.deepEqual(splitForDelivery(null), []);
  });

  test('切段后拼回去，内容不增不减（只去掉段间空白）', () => {
    const md = ['甲。', '```mermaid', 'graph LR', 'A-->B', '```', '乙。'].join('\n');
    const segs = splitForDelivery(md);
    const joined = segs.map((s) => (s.kind === 'text' ? s.text : s.code)).join('');
    for (const piece of ['甲。', 'A-->B', '乙。']) {
      assert.ok(joined.includes(piece), `丢了内容：${piece}`);
    }
  });
});

describe('辅助转换', () => {
  test('mermaidToMarkdown 还原成可渲染围栏', () => {
    const md = mermaidToMarkdown('graph LR\nA-->B');
    assert.equal(md, '```mermaid\ngraph LR\nA-->B\n```');
  });

  test('mermaidToFallbackText 保留源码，渲染失败也不丢内容', () => {
    const t = mermaidToFallbackText('graph LR\nA-->B');
    assert.match(t, /A-->B/);
    assert.match(t, /渲染失败/);
  });
});
