// 分支问答：天枢用 ask_user_question 抛出选项，用户回一个数字即完成选择。
// 事件结构（实测）：{ type:'user_question', data:{ toolUseId, questions:[{id,prompt,options,optionDetails,allowMultiple}] } }

/** 把一条提问格式化成 QQ 里能读的文本。 */
export function formatQuestion(data, { maxOptionChars = 120 } = {}) {
  const qs = data?.questions ?? [];
  if (qs.length === 0) return '（提问内容为空）';

  const blocks = [];
  // 只有一道题时省略「第 N 题」标题，减少噪音
  const single = qs.length === 1;

  qs.forEach((q, qi) => {
    const lines = [];
    if (!single) lines.push(`【第 ${qi + 1} 题】`);
    lines.push(q.prompt ?? '(无题面)');
    lines.push('');

    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length === 0) {
      lines.push('（这道题没有预设选项，直接回复内容即可）');
    } else {
      opts.forEach((opt, i) => {
        const detail = q.optionDetails?.[i];
        const rec = detail?.recommended ? '（推荐）' : '';
        lines.push(`${i + 1}. ${clip(opt, maxOptionChars)}${rec}`);
      });
      lines.push('');
      if (q.allowMultiple) {
        lines.push('可多选：回复编号，多个用逗号隔开，例如 1,3');
      } else {
        lines.push('回复编号选择，例如 1');
      }
    }
    blocks.push(lines.join('\n'));
  });

  return blocks.join('\n\n');
}

function clip(s, max) {
  const t = String(s ?? '');
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * 把用户的回复解析成选择。
 * @returns {{kind:'choice', indices:number[]} | {kind:'text', text:string}}
 */
export function parseAnswer(reply, question) {
  const raw = String(reply ?? '').trim();
  const opts = Array.isArray(question?.options) ? question.options : [];

  const nums = raw.match(/\d+/g)?.map(Number) ?? [];
  const valid = nums.filter((n) => n >= 1 && n <= opts.length);

  if (valid.length > 0 && opts.length > 0) {
    // 非多选时只取第一个，避免「1,3」这种在单选语境下的歧义
    const picked = question?.allowMultiple ? valid.slice(0, opts.length) : valid.slice(0, 1);
    const indices = [...new Set(picked.map((n) => n - 1))];
    // 整条回复必须基本就是编号（允许逗号/空格分隔），否则视为自由文本
    const stripped = raw.replace(/[\d\s,，、.。]+/g, '');
    if (stripped.length === 0) return { kind: 'choice', indices };
  }
  return { kind: 'text', text: raw };
}

/** 选择 → 交给模型的答案文本（用选项原文，模型才看得懂）。 */
export function resolveChoice(answer, question) {
  if (!answer || answer.kind === 'text') return answer?.text ?? '';
  const opts = Array.isArray(question?.options) ? question.options : [];
  const picked = answer.indices.map((i) => opts[i]).filter(Boolean);
  if (picked.length === 0) return '';
  return picked.join('、');
}
