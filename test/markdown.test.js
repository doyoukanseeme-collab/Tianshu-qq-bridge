// Markdown → 图片：转换正确性 + 真渲染（用系统 Chrome，不 mock）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { markdownToHtml, wrapDocument, extractFences, escapeHtml, renderInline } from '../src/markdown.js';
import { Renderer, findChrome, savePng } from '../src/render.js';
import { needsImage } from '../src/bridge.js';

describe('markdown 转换', () => {
  test('转义 HTML，防止模型输出的尖括号破坏结构', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    assert.equal(markdownToHtml('<img src=x onerror=1>'), '<p>&lt;img src=x onerror=1&gt;</p>');
  });

  test('围栏代码块被抽出并保留语言', () => {
    const { text, blocks } = extractFences('前\n```js\nconst a=1\n```\n后');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].lang, 'js');
    assert.equal(blocks[0].code, 'const a=1');
    assert.ok(!text.includes('```'));
  });

  test('代码内容里的 HTML 被转义', () => {
    const html = markdownToHtml('```\n<div class="x">&</div>\n```');
    assert.match(html, /&lt;div/);
    assert.ok(!html.includes('<div class="x">'));
  });

  test('标题 / 列表 / 表格 / 引用', () => {
    assert.match(markdownToHtml('## 标题'), /<h2>标题<\/h2>/);
    assert.match(markdownToHtml('- a\n- b'), /<ul>[\s\S]*<li>a<\/li>/);
    const tbl = markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |');
    assert.match(tbl, /<table>/);
    assert.match(tbl, /<th>a<\/th>/);
    assert.match(tbl, /<td>1<\/td>/);
    assert.match(markdownToHtml('> 引用'), /<blockquote>引用<\/blockquote>/);
  });

  test('行内样式：粗体、斜体、行内代码、链接', () => {
    assert.match(renderInline('**粗**'), /<strong>粗<\/strong>/);
    assert.match(renderInline('*斜*'), /<em>斜<\/em>/);
    assert.match(renderInline('`code`'), /<code>code<\/code>/);
    assert.match(renderInline('[t](https://x)'), /<a href="https:\/\/x">t<\/a>/);
  });

  test('行内代码里的星号不被当成粗体', () => {
    const html = renderInline('`a**b**c`');
    assert.match(html, /<code>a\*\*b\*\*c<\/code>/, `实际：${html}`);
  });


  test('包裹成完整文档时带样式', () => {
    const doc = wrapDocument('<p>x</p>');
    assert.match(doc, /^<!doctype html>/);
    assert.match(doc, /<style>/);
    assert.match(doc, /<p>x<\/p>/);
  });
});

describe('何时必须画图', () => {
  // 需求：能用文本的全用文本（可复制、可搜索），只有文本表达不了的才画图。
  // 所以代码块/表格/标题一律不再触发渲染——它们走文本比截图有用。
  test('mermaid 流程图 → 画图（文本表达不了）', () => {
    assert.equal(needsImage('```mermaid\ngraph LR\nA-->B\n```'), true);
    assert.equal(needsImage('前言\n\n```mermaid\nflowchart TD\nA-->B\n```\n\n后记'), true);
  });

  test('代码块 → 不画图，走文本', () => {
    assert.equal(needsImage('```js\nconsole.log(1)\n```'), false);
  });

  test('表格 → 不画图，走文本', () => {
    assert.equal(needsImage('| a | b |\n|---|---|\n| 1 | 2 |'), false);
  });

  test('标题和长文带行内样式 → 不画图', () => {
    assert.equal(needsImage('## 标题'), false);
    assert.equal(needsImage('**加粗**和`反引号`'.repeat(30)), false);
  });

  test('纯一句话 → 不画图', () => {
    assert.equal(needsImage('好的，已完成。'), false);
    assert.equal(needsImage('已发送。'), false);
  });
});

const HAS_CHROME = Boolean(findChrome());

describe('真渲染（系统 Chrome，不 mock）', { skip: !HAS_CHROME && '本机无 Chrome' }, () => {
  test('Markdown → 合法 PNG，尺寸随内容增长', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbridge-render-'));
    const r = new Renderer({ width: 720 });
    try {
      assert.equal(r.available, true, '应探测到 Chrome');

      const shortMd = '## A\n\n一行字。';
      const longMd = '## A\n\n' + Array.from({ length: 30 }, (_, i) => `第 ${i} 段内容。`).join('\n\n');

      const png1 = await r.screenshotHtml(wrapDocument(markdownToHtml(shortMd)));
      const png2 = await r.screenshotHtml(wrapDocument(markdownToHtml(longMd)));

      for (const png of [png1, png2]) {
        assert.equal(png.subarray(0, 4).toString('hex'), '89504e47', '必须是 PNG');
        assert.ok(png.length > 1000, `PNG 太小：${png.length}`);
      }
      assert.ok(png2.length > png1.length, '内容更长的图应更大');

      const saved = savePng(png1, dir, 'a.png');
      assert.ok(saved.endsWith('a.png'));
    } finally {
      await r.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('含代码块和表格的完整文档能渲染（复杂布局不崩）', async () => {
    const r = new Renderer({ width: 760 });
    try {
      const md = [
        '## 概览',
        '',
        '```js',
        'const x = 1;',
        'console.log(x);',
        '```',
        '',
        '| 项 | 值 |',
        '|---|---|',
        '| 数量 | 4 |',
        '',
        '```mermaid',
        'flowchart LR',
        '  A[开始] --> B[结束]',
        '```',
      ].join('\n');
      const png = await r.screenshotHtml(wrapDocument(markdownToHtml(md)));
      assert.equal(png.subarray(0, 4).toString('hex'), '89504e47');
      assert.ok(png.length > 5000, `复杂文档 PNG 偏小：${png.length}`);
      assert.equal(r.stats.failed, 0);
    } finally {
      await r.close();
    }
  });

  test('浏览器实例复用（两次渲染不重复启动）', async () => {
    const r = new Renderer();
    try {
      await r.screenshotHtml(wrapDocument('<p>a</p>'));
      const first = r.browser;
      await r.screenshotHtml(wrapDocument('<p>b</p>'));
      assert.equal(r.browser, first, '应复用同一个浏览器实例');
      assert.equal(r.stats.rendered, 2);
    } finally {
      await r.close();
    }
  });
});

describe('mermaid 真渲染（不再降级为方框列表）', () => {
  test('mermaid 代码块输出给前端渲染的 div，而不是降级节点列表', () => {
    const html = markdownToHtml('```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```');
    assert.match(html, /class="mermaid"/, `应输出 mermaid 容器，实际：${html.slice(0, 200)}`);
    assert.match(html, /flowchart LR/, 'mermaid 源码应保留在容器里交给 mermaid.js');
    assert.ok(!html.includes('mermaid-fallback'), '不该再走降级路径');
  });


  test('没有 mermaid 时不内联脚本（省 2.5MB）', () => {
    const doc = wrapDocument(markdownToHtml('## 标题\n普通文本'));
    assert.ok(!doc.includes('mermaid.initialize'), '不该无谓内联 mermaid');
  });
});

describe('mermaid 真渲染（Chrome）', { skip: !HAS_CHROME && '本机无 Chrome' }, () => {
  test('流程图画成 SVG，真实出现在截图里', async () => {
    const r = new Renderer({ width: 700 });
    try {
      const md = '```mermaid\nflowchart LR\n  A[起点] --> B{判断}\n  B -->|是| C[终点]\n```';
      const doc = wrapDocument(markdownToHtml(md));
      const png = await r.screenshotHtml(doc, { width: 700 });
      assert.equal(png.subarray(0, 4).toString('hex'), '89504e47');
      // 真流程图的 PNG 会明显大于「一行文字」
      assert.ok(png.length > 8000, `PNG 太小，可能没渲染出图：${png.length}`);
    } finally { await r.close(); }
  });
});
