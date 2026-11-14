// 事件降噪：把天枢的事件流压成适合手机看的短消息。
// 原则：正文按段落推、工具调用压成一行、错误必推、token 统计收尾。
const DEFAULT_IDLE_FLUSH_MS = 1200;

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+$/u, '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 从工具入参里挑最能说明「在干什么」的那个字段。 */
export function pickToolDetail(name, input) {
  if (!input || typeof input !== 'object') return '';
  const order = [
    'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt',
    'description', 'objective', 'name', 'text', 'content',
  ];
  for (const key of order) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

export class Summarizer {
  /**
   * @param {object} opts
   * @param {'quiet'|'normal'|'verbose'} opts.level
   * @param {number} opts.maxChars     单条推送的字符上限
   * @param {boolean} opts.includeToolCalls
   * @param {boolean} opts.includeThinking
   * @param {number} opts.idleFlushMs  正文静默多久后强制推送
   * @param {(text: string) => void} opts.emit
   */
  constructor(opts = {}) {
    this.level = opts.level ?? 'normal';
    this.maxChars = opts.maxChars ?? 900;
    this.includeToolCalls = opts.includeToolCalls ?? true;
    this.includeThinking = opts.includeThinking ?? false;
    this.idleFlushMs = opts.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS;
    this.emit = opts.emit ?? (() => {});
    this.text = '';
    this.lastTurnText = '';   // final 模式：最后一个有正文的 turn（等 done 时交付）
    this.pendingError = null; // 攒着的 error 事件（final 模式等 done 一起交付）
    this.thinking = '';
    this.timer = null;
    this.lastSeq = 0;
  }

  /** 喂一个事件；内部决定推什么。 */
  handle(event) {
    if (!event || typeof event.type !== 'string') return;
    // 同一 seq 重放时跳过（断点续流可能重复最后一帧）
    if (typeof event.seq === 'number') {
      if (event.seq <= this.lastSeq && event.seq !== 0) return;
      if (event.seq > 0) this.lastSeq = event.seq;
    }

    switch (event.type) {
      case 'text_delta':
        this.appendText(event.data?.text);
        break;
      case 'thinking_delta':
        // final 模式连思考都不推：只交付最终结果
        if (this.includeThinking && this.level !== 'final') this.appendThinking(event.data?.text);
        break;
      case 'tool_use': {
        this.toolCount = (this.toolCount ?? 0) + 1;
        if (this.level === 'final') break;      // 只要结果，过程一律不推
        this.flushText();
        if (!this.includeToolCalls || this.level === 'quiet') break;
        const name = event.data?.name ?? 'tool';
        const detail = clip(pickToolDetail(name, event.data?.input), 160);
        this.emit(`▸ ${name}${detail ? `: ${detail}` : ''}`);
        break;
      }
      case 'tool_result': {
        const d = event.data ?? {};
        if (d.isError && this.level !== 'quiet' && this.level !== 'final') {
          this.flushText();
          this.emit(`✗ ${d.name ?? 'tool'} 失败：${clip(d.result ?? '', 240)}`);
        }
        break;
      }
      case 'done': {
        // 天枢在整轮真正结束时发 done（data.status = completed/interrupted/failed），
        // 这才是「这一轮跑完了」的权威信号。有正文就交付，没正文就没正文。
        if (this.level === 'final') {
          this.emitFinal(event.data?.status);
          break;
        }
        this.flushText();
        this.flushThinking();
        break;
      }
      case 'error': {
        // 天枢的报错走独立事件，形状是：
        //   { error: "OpenAI API error (insufficient_user_quota)…",
        //     kind: "rate_limit", guidance: "限流/额度不足：稍等片刻再发…" }
        // 之前这里没有分支，落到 default 被静默丢弃——用户只看到没反应，
        // 不知道是额度/鉴权/限流出了问题。报错必须让手机那头看见。
        const d = event.data ?? {};
        const text = typeof d === 'string' ? d : (d.error ?? d.message ?? '');
        if (!text) break;
        this.pendingError = {
          text: String(text),
          guidance: d.guidance ? String(d.guidance) : '',
          kind: d.kind ? String(d.kind) : '',
        };
        // 流式模式下立刻推；final 模式攒着，等 done 时连正文一起交付
        if (this.level !== 'final') {
          this.emit(formatError(this.pendingError));
          this.pendingError = null;
        }
        break;
      }
      case 'turn_complete': {
        if (this.level === 'final') {
          // turn_complete 只是「一个 turn 结束」，一次提问会连跑十几个 turn。
          // 手机只该收到「最后那段回话」：把本 turn 正文记成候选、清空累积，
          // 等 done 时交付最后一个有正文的 turn。
          // 这里绝不能按时间兜底推送——实测相邻 turn 间隔常有 20~30s，
          // 任何短超时都会把中间播报发出去（那正是「每轮结尾都发」的根因）。
          const turnText = this.text.trim();
          this.text = '';
          if (turnText) this.lastTurnText = turnText;
          break;
        }
        this.flushText();
        this.flushThinking();
        if (this.level === 'quiet') break;
        const u = event.data?.usage ?? {};
        const bits = [];
        if (u.input_tokens != null) bits.push(`in ${u.input_tokens}`);
        if (u.output_tokens != null) bits.push(`out ${u.output_tokens}`);
        this.emit(`✓ 回合结束${bits.length ? `（${bits.join(' / ')} tokens）` : ''}`);
        break;
      }
      case 'status': {
        if (this.level === 'final') break;   // 状态变化也是过程噪音
        const status = event.data?.status;
        if (status && status !== 'running') this.emit(`● 会话状态：${status}`);
        break;
      }
      case 'phase': {
        if (this.level !== 'verbose') break;
        const p = event.data?.phase;
        if (p) this.emit(`… ${p}`);
        break;
      }
      default:
        break;      // context_budget / hook_result / goal_state 等不推
    }
  }

  appendText(text) {
    if (!text) return;
    this.text += text;
    if (this.level === 'final') return;    // final：一路攒着，回合结束一次性交付
    if (this.text.length >= this.maxChars) this.flushText();
    else this.scheduleIdleFlush();
  }

  appendThinking(text) {
    if (!text) return;
    this.thinking += text;
    if (this.thinking.length >= this.maxChars) this.flushThinking();
  }

  scheduleIdleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushText();
    }, this.idleFlushMs);
    this.timer.unref?.();
  }

  flushText() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const body = this.text.trim();
    this.text = '';
    if (!body) return;
    for (const chunk of splitChunks(body, this.maxChars)) this.emit(chunk);
  }

  flushThinking() {
    const body = this.thinking.trim();
    this.thinking = '';
    if (!body || !this.includeThinking) return;
    this.emit(`💭 ${clip(body, this.maxChars)}`);
  }

  /**
   * final 模式交付：只发「最后那段有正文的回话」。
   * 优先用 done 时还没收尾的残余正文（最后一个 turn 未及 turn_complete），
   * 否则用最后一个已完成的 turn。
   *
   * 这里必须整段交给上层，不能自己切块：
   *   - 切块后每块单独判断「像不像 Markdown」，会一条回复里一半渲染成图、
   *     一半发文本（实测踩过）；
   *   - 多次 emit 是并发的，每块渲染耗时不同，谁先渲染完谁先发，顺序会乱。
   * 分片与形态统一由 Bridge.broadcast 决定。
   */
  emitFinal(status) {
    const body = (this.text.trim() || this.lastTurnText || '').trim();
    const err = this.pendingError;
    this.text = '';
    this.lastTurnText = '';
    this.pendingError = null;

    // 失败时：正文（如果有）在前，报错在后——报错放最后最显眼，
    // 用户看一眼就知道「没结果」是额度/鉴权/限流，而不是桥挂了。
    if (body) this.emit(body);
    if (err) this.emit(formatError(err, status));
    if (body || err) return;

    // 既没正文也没 error：一轮跑失败了却什么都没说，也得给个交代，
    // 否则表现就是「发了指令，手机毫无反应」。
    if (status && status !== 'completed') {
      this.emit(`⚠️ 本轮${statusText(status)}，但没有拿到任何内容。天枢那边可能没跑起来，发 /status 看看会话状态。`);
    }
  }

  /** 会话结束/切走时把残留内容推出去。 */
  flush() {
    if (this.level === 'final') { this.emitFinal(); return; }
    this.flushText();
    this.flushThinking();
  }
}

/** 把天枢的 error 事件整理成一条能直接照做的消息。 */
export function formatError(err, status) {
  if (!err) return '';
  const head = status && status !== 'completed' ? `⚠️ 本轮${statusText(status)}` : '⚠️ 天枢报错';
  const lines = [`${head}：${err.text}`];
  if (err.guidance) lines.push(`\n处理建议：${err.guidance}`);
  return lines.join('');
}

/** status 值翻成人话。 */
export function statusText(status) {
  if (status === 'failed') return '失败';
  if (status === 'interrupted') return '被中断';
  if (status === 'completed') return '完成';
  return status ?? '结束';
}

/** 把长文本按段落边界切成 <=max 的块，尽量不截断句子。 */
export function splitChunks(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.4) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}
