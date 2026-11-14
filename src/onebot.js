// OneBot v11 适配层：正向 WS（桥接器连 NapCat）和反向 WS（NapCat 连桥接器）两种模式共用同一套语义。
// 只实现用得到的部分：事件接收 + action 调用 + echo 应答配对。
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createWsServer } from './ws.js';
import { WsClient } from './wsclient.js';

const CALL_TIMEOUT = 15000;

export function makeChatKey(type, id) {
  return `${type}:${id}`;
}

export function parseChatKey(chatKey) {
  const idx = String(chatKey).indexOf(':');
  if (idx < 0) return null;
  return { type: chatKey.slice(0, idx), id: chatKey.slice(idx + 1) };
}

/** 把长文本切成 QQ 能接受的多段。按段落边界切，避免把代码截两半。 */
export function splitForQq(text, max = 1600) {
  const s = String(text ?? '');
  if (s.length <= max) return [s];
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.3) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

export class OneBot extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{mode:'forward'|'reverse', forwardUrl?:string, reversePort?:number, reverseHost?:string, path?:string, accessToken?:string|null}} opts.config
   */
  constructor(config) {
    super();
    this.config = config;
    this.mode = config.mode ?? 'forward';
    this.ws = null;          // forward 用（原生 WebSocket）
    this.conn = null;        // reverse 用（WsConnection）
    this.server = null;
    this.pending = new Map();
    this.stopped = true;
    this.backoff = 1000;
    this.selfId = null;
  }

  get ready() {
    return this.mode === 'forward'
      ? this.ws?.open === true
      : Boolean(this.conn && !this.conn.closed);
  }

  async start() {
    this.stopped = false;
    if (this.mode === 'reverse') await this.#startReverse();
    else this.#connectForward();
  }

  async stop() {
    this.stopped = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('OneBot 连接已关闭'));
    }
    this.pending.clear();
    try { this.ws?.close(); } catch { /* ignore */ }
    try { this.conn?.close(); } catch { /* ignore */ }
    if (this.server) { await this.server.close(); this.server = null; }
    this.ws = null;
    this.conn = null;
  }

  // ---------- 连接管理 ----------

  async #startReverse() {
    const { reversePort = 6700, reverseHost = '127.0.0.1', path = '/onebot' } = this.config;
    this.server = await createWsServer({
      port: reversePort,
      host: reverseHost,
      path: path || undefined,
      onConnection: (conn) => {
        this.emit('log', `NapCat 已连入（反向 WS，${conn.remote}）`);
        this.conn = conn;
        conn.on('message', (raw) => this.#handleRaw(raw));
        conn.on('close', () => {
          if (this.conn === conn) this.conn = null;
          this.emit('close');
        });
        this.#announceReady();
      },
    });
    this.emit('log', `反向 WS 监听 ${this.server.url}`);
  }

  #connectForward() {
    if (this.stopped) return;
    const url = this.config.forwardUrl ?? 'ws://127.0.0.1:3001';
    const token = this.config.accessToken;
    this.emit('log', `连接 ${url}${token ? '（带 access token）' : ''} …`);

    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const ws = new WsClient();
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 1000;
      this.emit('log', '已连上 NapCat（正向 WS）');
      this.#announceReady();
    });
    ws.on('message', (raw) => this.#handleRaw(raw));
    ws.on('error', (err) => this.emit('log', `WS 错误：${err.message}`));
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.emit('close');
      this.#scheduleReconnect();
    });

    try {
      ws.connect(url, { headers });
    } catch (err) {
      this.emit('log', `连接失败：${err.message}`);
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.emit('log', `${delay / 1000}s 后重连 NapCat…`);
    const t = setTimeout(() => this.#connectForward(), delay);
    t.unref?.();
  }

  async #announceReady() {
    try {
      const me = await this.call('get_login_info', {});
      this.selfId = me?.user_id ?? null;
      this.emit('log', `登录账号：${me?.nickname ?? '?'}（${me?.user_id ?? '?'}）`);
    } catch (err) {
      this.emit('log', `get_login_info 失败：${err.message}`);
    }
    this.emit('ready');
  }

  // ---------- 收发 ----------

  #handleRaw(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    // 优先当作 action 应答
    if (payload.echo != null && this.pending.has(payload.echo)) {
      const entry = this.pending.get(payload.echo);
      this.pending.delete(payload.echo);
      clearTimeout(entry.timer);
      if (payload.status === 'failed' || payload.retcode !== 0 && payload.retcode != null) {
        entry.reject(new Error(payload.message || payload.wording || `retcode=${payload.retcode}`));
      } else {
        entry.resolve(payload.data ?? payload);
      }
      return;
    }
    // 否则是事件推送
    this.emit('event', payload);
  }

  /** 调一个 OneBot action，等带 echo 的应答。 */
  call(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ready) {
        reject(new Error(`OneBot 未连接，无法执行 ${action}`));
        return;
      }
      const echo = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot ${action} 超时（${CALL_TIMEOUT}ms）`));
      }, CALL_TIMEOUT);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
      const frame = JSON.stringify({ action, params, echo });
      try {
        if (this.mode === 'forward') this.ws.send(frame);
        else this.conn.send(frame);
      } catch (err) {
        this.pending.delete(echo);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * 按 chatKey 发一张图片（传 PNG Buffer）。
   * OneBot v11 用 base64:// 段传图，NapCat 支持。
   */
  async sendImage(chatKey, buf) {
    const target = parseChatKey(chatKey);
    if (!target) throw new Error(`非法 chatKey：${chatKey}`);
    const b64 = Buffer.isBuffer(buf) ? buf.toString('base64') : String(buf);
    const segment = [{ type: 'image', data: { file: `base64://${b64}` } }];
    const res = target.type === 'group'
      ? await this.call('send_group_msg', { group_id: Number(target.id), message: segment })
      : await this.call('send_private_msg', { user_id: Number(target.id), message: segment });
    return { messageIds: res?.message_id != null ? [res.message_id] : [] };
  }

  /**
   * 按 chatKey 发文本（自动分段）。
   * 返回每段的消息 id —— 引用路由靠它把「用户引用的那条」映射回会话。
   * @returns {Promise<{chunks:number, messageIds:Array<string|number>}>}
   */
  async sendText(chatKey, text) {
    const target = parseChatKey(chatKey);
    if (!target) throw new Error(`非法 chatKey：${chatKey}`);
    const chunks = splitForQq(text);
    const messageIds = [];
    for (const chunk of chunks) {
      const res = target.type === 'group'
        ? await this.call('send_group_msg', { group_id: Number(target.id), message: chunk })
        : await this.call('send_private_msg', { user_id: Number(target.id), message: chunk });
      if (res?.message_id != null) messageIds.push(res.message_id);
    }
    return { chunks: chunks.length, messageIds };
  }
}

/** 去掉文本里的 CQ 码（引用、@、图片等），只留人能读的部分。 */
function stripCq(text) {
  return String(text ?? '').replace(/\[CQ:[^\]]*\]/g, '');
}

/** 找出这条消息引用的是哪一条（被引用消息的 id）。 */
export function extractReplyTo(event) {
  if (Array.isArray(event?.message)) {
    const seg = event.message.find((s) => s?.type === 'reply');
    if (seg?.data?.id != null) return String(seg.data.id);
  }
  const raw = event?.raw_message;
  if (typeof raw === 'string') {
    const m = raw.match(/\[CQ:reply,[^\]]*?id=(-?\d+)/);
    if (m) return m[1];
  }
  return null;
}

/** 从 OneBot 的 message 事件里抽出一条「谁在哪儿说了什么、引用了谁」。 */
export function normalizeIncoming(event) {
  if (!event || event.post_type !== 'message') return null;
  const type = event.message_type;
  if (type !== 'private' && type !== 'group') return null;
  const text = extractText(event.message, event.raw_message).trim();
  // 只发图片、不配文字是常见用法（"看这张图"）。这时 text 为空，
  // 但不能把整条消息丢掉——否则用户发了图，桥那边毫无反应。
  const hasImage = hasImageSegment(event.message, event.raw_message);
  if (!text && !hasImage) return null;
  const id = type === 'group' ? event.group_id : event.user_id;
  return {
    chatKey: makeChatKey(type, id),
    chatType: type,
    chatId: id,
    userId: event.user_id,
    senderName: event.sender?.card || event.sender?.nickname || String(event.user_id),
    text,
    raw: event.raw_message ?? '',
    replyTo: extractReplyTo(event),
    messageId: event.message_id ?? null,
    messageSegments: Array.isArray(event.message) ? event.message : null,
    selfId: event.self_id ?? null,
  };
}

/** 消息里是否带图片段（数组格式看 type，字符串格式看 CQ 码）。 */
function hasImageSegment(message, raw) {
  if (Array.isArray(message)) {
    return message.some((seg) => seg?.type === 'image');
  }
  if (typeof raw === 'string') return /\[CQ:image,/.test(raw);
  return false;
}

function extractText(message, raw) {
  if (Array.isArray(message)) {
    return message
      .filter((seg) => seg?.type === 'text')
      .map((seg) => seg.data?.text ?? '')
      .join('');
  }
  if (typeof message === 'string') return stripCq(message);
  if (typeof raw === 'string') return stripCq(raw);
  return '';
}
