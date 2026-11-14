import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { markdownToHtml } from '../src/markdown.js';

const M = String.fromCharCode(96, 96, 96);   // ```  避免在任何层被转义
const fence = (lang, body) => `${M}${lang}\n${body}\n${M}`;

describe('mermaid 交给 mermaid.js 真渲染', () => {
  test('flowchart 输出 mermaid 容器并保留源码', () => {
    const src = fence('mermaid', 'flowchart LR\n  A[开始] --> B{判断}\n  B -->|是| C[结束]');
    const html = markdownToHtml(src);
    assert.match(html, /class="mermaid"/, `应是 mermaid 容器，实际：${html.slice(0, 160)}`);
    assert.match(html, /flowchart LR/, '源码要留给 mermaid.js');
    assert.match(html, /开始/, '节点标签应保留');
    assert.ok(!html.includes('mermaid-fallback'), '不该再走降级路径');
  });

  test('sequenceDiagram 等其它类型也交给 mermaid.js', () => {
    const html = markdownToHtml(fence('mermaid', 'sequenceDiagram\n  A->>B: hi'));
    assert.match(html, /class="mermaid"/);
    assert.match(html, /sequenceDiagram/);
  });

  test('普通代码块仍然是代码块，不受影响', () => {
    const html = markdownToHtml(fence('js', 'const a = 1;'));
    assert.match(html, /<pre><code>/);
    assert.ok(!html.includes('class="mermaid"'));
  });
});
