// 交付分段：决定「哪部分发文本、哪部分必须画图」。
//
// 原则：能用文本表达的统统走文本（QQ 里可长按复制、可搜索），
// 只有文本根本表达不了的东西才渲染成图片——目前就是 mermaid 流程图。
//
// 两个硬约束：
//   1. 顺序必须原样保留。文本段和图片段在数组里的次序，就是发送次序。
//   2. 分段只在这里做一次。绝不能把已经切碎的片段再单独判断形态，
//      那样同一条回复会一半图一半字（实测踩过）。

/** 需要渲染成图片的代码围栏语言。其余一律当文本发。 */
export const IMAGE_LANGS = ['mermaid'];

const FENCE = /^\s*```+\s*([A-Za-z0-9_+-]*)\s*$/;
const FENCE_END = /^\s*```+\s*$/;

/**
 * 把一段 Markdown 切成有序的交付片段。
 *
 * @param {string} text
 * @param {{imageLangs?: string[]}} [opts]
 * @returns {Array<{kind:'text', text:string} | {kind:'mermaid', code:string}>}
 */
export function splitForDelivery(text, { imageLangs = IMAGE_LANGS } = {}) {
  const s = String(text ?? '');
  if (!s.trim()) return [];

  const langs = new Set(imageLangs.map((l) => String(l).toLowerCase()));
  const lines = s.split(/\r?\n/);
  const segs = [];
  let buf = [];

  const flushText = () => {
    const t = buf.join('\n').trim();
    if (t) segs.push({ kind: 'text', text: t });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    const lang = (open?.[1] ?? '').toLowerCase();

    if (open && langs.has(lang)) {
      // 找到闭合围栏；没有闭合（流被截断）就一直取到末尾
      const code = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (FENCE_END.test(lines[j])) { closed = true; break; }
        code.push(lines[j]);
      }

      if (code.length > 0) {
        flushText();
        segs.push({ kind: 'mermaid', code: code.join('\n') });
        i = closed ? j : lines.length;   // closed 时跳过闭合行
        continue;
      }
    }

    buf.push(lines[i]);
  }

  flushText();
  return segs;
}

/** 把 mermaid 源码还原成可渲染的 Markdown（交给既有渲染管线）。 */
export function mermaidToMarkdown(code) {
  return ['```mermaid', String(code ?? '').trimEnd(), '```'].join('\n');
}

/** 图片发不出去时的兜底：退化成一段人能读的源码文本，别让内容丢失。 */
export function mermaidToFallbackText(code) {
  return ['流程图（渲染失败，原始定义如下）：', '```', String(code ?? '').trimEnd(), '```'].join('\n');
}

/** 这段内容里是否含需要画图的部分。 */
export function hasImageSegment(segs) {
  return Array.isArray(segs) && segs.some((s) => s.kind === 'mermaid');
}
