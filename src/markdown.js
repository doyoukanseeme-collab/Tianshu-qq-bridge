import { readFileSync } from 'node:fs';

// Markdown → HTML。不追求完整 CommonMark，只覆盖模型实际会用的语法，
// 目标是在 QQ 里看起来接近天枢的渲染效果（代码块、表格、标题、列表、行内样式）。
// 刻意零依赖：用户机器上不用 npm install。

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 抽出 ``` 围栏代码块，返回 { text: 占位后的正文, blocks: [{lang, code}] } */
export function extractFences(md) {
  const blocks = [];
  const text = String(md ?? '').replace(
    /^```([\w+-]*)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm,
    (_, lang, code) => {
      const i = blocks.length;
      blocks.push({ lang: (lang || '').toLowerCase(), code: code.replace(/\r?\n$/, '') });
      return `\u0000FENCE${i}\u0000`;
    },
  );
  return { text, blocks };
}

/** 行内：代码 `x`、粗体 **x**、斜体 *x*、链接 [t](u)、行内代码优先保护 */
export function renderInline(s) {
  const codes = [];
  let out = String(s ?? '').replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000IC${codes.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\u0000IC(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return out;
}

/** 极简 mermaid 支持：只认 flowchart/graph 的 "A --> B" 与 "A[x]" 形式，产出 HTML 块。 */
export function renderMermaidFallback(code) {
  const lines = String(code).split(/\r?\n/);
  const isFlow = /^\s*(flowchart|graph)\b/i.test(lines[0] ?? '');
  if (!isFlow) {
    return `<div class="diagram-unsupported">${escapeHtml(code.slice(0, 400))}</div>`;
  }
  // 解析节点标签 A[文本] / A(文本) / A{文本} 与边 A --> B / A -->|label| B
  const nodeLabel = new Map();
  const nodeOrder = [];
  const edges = [];
  const labelOf = (raw) => {
    const m = raw.match(/^([A-Za-z0-9_]+)\s*(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?$/);
    if (!m) return raw;
    const id = m[1];
    const label = m[2] ?? m[3] ?? m[4] ?? id;
    if (!nodeLabel.has(id)) { nodeLabel.set(id, label); nodeOrder.push(id); }
    return id;
  };
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (!t || t.startsWith('%%')) continue;
    const em = t.match(/^([A-Za-z0-9_]+(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?))\s*-->\s*(?:\|([^|]*)\|\s*)?([A-Za-z0-9_]+(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?))$/);
    if (em) {
      const from = labelOf(em[1]);
      const to = labelOf(em[3]);
      edges.push({ from, to, label: em[2] ?? '' });
    }
  }
  if (edges.length === 0) {
    return `<div class="diagram-unsupported">${escapeHtml(code.slice(0, 400))}</div>`;
  }
  const nodes = nodeOrder.map((id) => {
    const shape = /\{/.test(id) ? 'diamond' : 'box';
    return `<div class="mnode ${shape}" data-id="${escapeHtml(id)}">${escapeHtml(nodeLabel.get(id))}</div>`;
  }).join('');
  const edgeText = edges.map((e) => `${nodeLabel.get(e.from)} → ${nodeLabel.get(e.to)}${e.label ? `（${e.label}）` : ''}`);
  return `<div class="mermaid-fallback"><div class="mnodes">${nodes}</div>
    <ul class="medges">${edgeText.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>`;
}

/** 表格：| a | b | 与分隔行 |---| */
function tryTable(lines, i) {
  if (!/^\s*\|.*\|\s*$/.test(lines[i] ?? '')) return null;
  if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) return null;
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(lines[i]);
  const rows = [];
  let j = i + 2;
  while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
    rows.push(cells(lines[j]));
    j += 1;
  }
  const html = `<table><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return { html, next: j };
}

function codeBlockHtml(block) {
  // mermaid 交给页面里的 mermaid.js 真渲染成 SVG（降级只用于脚本不可用时）
  if (block.lang === 'mermaid') {
    return `<div class="mermaid-block"><pre class="mermaid">${escapeHtml(block.code)}</pre></div>`;
  }
  const lang = block.lang ? `<span class="lang">${escapeHtml(block.lang)}</span>` : '';
  return `<div class="codeblock">${lang}<pre><code>${escapeHtml(block.code)}</code></pre></div>`;
}

/**
 * 主转换：Markdown → HTML 片段。
 * @returns {string}
 */
export function markdownToHtml(md) {
  const { text, blocks } = extractFences(md);
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  let listType = null;

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏占位
    const fm = line.match(/^\u0000FENCE(\d+)\u0000$/);
    if (fm) {
      closeList();
      out.push(codeBlockHtml(blocks[Number(fm[1])]));
      i += 1;
      continue;
    }

    // 空行
    if (!line.trim()) { closeList(); i += 1; continue; }

    // 表格
    const tbl = tryTable(lines, i);
    if (tbl) { closeList(); out.push(tbl.html); i = tbl.next; continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lv = Math.min(h[1].length, 4);
      out.push(`<h${lv}>${renderInline(h[2])}</h${lv}>`);
      i += 1;
      continue;
    }

    // 水平线
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push('<hr>'); i += 1; continue; }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // 列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want; }
      out.push(`<li>${renderInline((ul || ol)[1])}</li>`);
      i += 1;
      continue;
    }

    // 普通段落
    closeList();
    const buf = [];
    while (i < lines.length && lines[i].trim()
      && !/^\u0000FENCE\d+\u0000$/.test(lines[i])
      && !/^(#{1,6})\s/.test(lines[i])
      && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+[.)]\s+/.test(lines[i])
      && !/^\s*>\s?/.test(lines[i])
      && !/^\s*(---|\*\*\*|___)\s*$/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${renderInline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  closeList();
  return out.join('\n');
}

/** 完整 HTML 文档（含样式），供无头浏览器截图。 */
/** 读入内联的 mermaid.js（只在实际含 mermaid 图时才塞进去，省 2.5MB）。 */
export function loadMermaidScript(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;      // 没有 vendor 文件就退回降级渲染，不阻断
  }
}

export function wrapDocument(bodyHtml, { title = '', width = 760, dark = false, mermaidScript = null } = {}) {
  const bg = dark ? '#1e1e1e' : '#ffffff';
  const fg = dark ? '#d4d4d4' : '#1f2328';
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:${bg}; color:${fg};
    font: 15px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    padding: 20px 22px; max-width: ${width}px; }
  h1 { font-size:21px; margin:0 0 12px; font-weight:650; }
  h2 { font-size:18px; margin:20px 0 10px; font-weight:650; }
  h3 { font-size:16px; margin:16px 0 8px; font-weight:650; }
  h4 { font-size:15px; margin:14px 0 6px; font-weight:650; }
  p { margin: 0 0 10px; }
  ul, ol { margin: 0 0 10px; padding-left: 22px; }
  li { margin: 3px 0; }
  code { background:${dark ? '#2d2d2d' : '#eff1f3'}; padding:1px 5px; border-radius:4px;
    font: 13px/1.5 "Cascadia Code", Consolas, "Courier New", monospace; }
  .codeblock { position:relative; margin: 10px 0 12px; }
  .codeblock .lang { position:absolute; top:6px; right:8px; font-size:11px; opacity:.45;
    font-family: Consolas, monospace; text-transform: lowercase; }
  pre { margin:0; background:${dark ? '#252526' : '#f6f8fa'};
    border:1px solid ${dark ? '#3c3c3c' : '#d8dee4'}; border-radius:8px;
    padding: 12px 14px; overflow:auto; }
  pre code { background:none; padding:0; font: 13px/1.55 "Cascadia Code", Consolas, "Courier New", monospace;
    white-space: pre-wrap; word-break: break-word; }
  table { border-collapse: collapse; margin: 10px 0 12px; font-size:14px; }
  th, td { border:1px solid ${dark ? '#3c3c3c' : '#d8dee4'}; padding:6px 10px; text-align:left; }
  th { background:${dark ? '#2d2d2d' : '#f6f8fa'}; font-weight:640; }
  blockquote { margin: 10px 0; padding: 4px 12px; border-left:3px solid ${dark ? '#4b5563' : '#d0d7de'};
    color:${dark ? '#9ca3af' : '#57606a'}; }
  hr { border:none; border-top:1px solid ${dark ? '#3c3c3c' : '#d8dee4'}; margin:16px 0; }
  a { color:#0969da; text-decoration:none; }
  .mermaid-fallback { border:1px solid ${dark ? '#3c3c3c' : '#d8dee4'}; border-radius:8px;
    padding:14px; margin:10px 0; background:${dark ? '#252526' : '#fbfcfd'}; }
  .mnodes { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
  .mnode { border:1px solid ${dark ? '#4b5563' : '#c8d1da'}; border-radius:6px;
    padding:6px 12px; background:${dark ? '#1e1e1e' : '#fff'}; font-size:13px; }
  .mnode.diamond { border-radius:4px; transform: rotate(0deg); background:${dark ? '#2d2d2d' : '#fff8e6'};
    border-color:${dark ? '#6b5b3e' : '#e6c98a'}; }
  .medges { margin:0; padding-left:18px; font-size:13px; opacity:.85; }
  .medges li { margin:2px 0; }
  .diagram-unsupported { border:1px dashed ${dark ? '#4b5563' : '#d0d7de'}; border-radius:8px;
    padding:12px; margin:10px 0; font: 12px/1.5 Consolas, monospace; white-space:pre-wrap;
    opacity:.8; color:${dark ? '#9ca3af' : '#57606a'}; }
</style>${mermaidScript ? `<script>${mermaidScript}</script>` : ''}</head><body>${bodyHtml}
${mermaidScript ? `<script>
  (function(){
    if (window.mermaid) {
      mermaid.initialize({ startOnLoad: true, theme: '${dark ? 'dark' : 'default'}',
        flowchart: { useMaxWidth: true, htmlLabels: true }, securityLevel: 'loose' });
    }
  })();
</script>` : ''}
</body></html>`;
}
