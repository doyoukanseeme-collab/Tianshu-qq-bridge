// 桥接器状态持久化：事件游标 + 会话绑定/关注 + 消息索引 + 推送开关。
// 原子写（写临时文件再改名），避免进程被杀时留下半截 JSON。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const EMPTY = () => ({
  version: 2,
  cursors: {},
  bindings: {},        // chatKey -> sessionId   （默认会话：不引用时发这里）
  subscriptions: {},   // chatKey -> [sessionId] （同时关注的多个会话）
  messageIndex: {},    // qqMessageId -> { sessionId, seq }
  pushEnabled: {},
  listCache: {},
  knownChats: [],      // 收到过消息的聊天，用于「哪个会话有消息就转发」
  pendingQuestions: {}, // chatKey -> 待回答的分支问答
});

const DEFAULT_MAX_INDEXED = 800;

export class Store {
  constructor(path, opts = {}) {
    this.path = resolve(path);
    this.maxIndexedMessages = opts.maxIndexedMessages ?? DEFAULT_MAX_INDEXED;
    this.data = EMPTY();
    this._lastIndexSeq = 0;
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      this.data = {
        ...EMPTY(),
        ...parsed,
        cursors: { ...(parsed.cursors || {}) },
        bindings: { ...(parsed.bindings || {}) },
        subscriptions: { ...(parsed.subscriptions || {}) },
        messageIndex: { ...(parsed.messageIndex || {}) },
        pushEnabled: { ...(parsed.pushEnabled || {}) },
        listCache: { ...(parsed.listCache || {}) },
        knownChats: Array.isArray(parsed.knownChats) ? [...parsed.knownChats] : [],
        pendingQuestions: { ...(parsed.pendingQuestions || {}) },
      };
    } catch {
      this.data = EMPTY();       // 首次运行或文件损坏：从头开始，不阻断启动
    }
    // 索引序号从已有最大值续上，保证裁剪顺序稳定
    let maxSeq = 0;
    for (const v of Object.values(this.data.messageIndex)) {
      if (typeof v?.seq === 'number' && v.seq > maxSeq) maxSeq = v.seq;
    }
    this._lastIndexSeq = maxSeq;
    return this.data;
  }

  save() {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  // ---- 游标 ----
  cursor(sessionId) {
    return this.data.cursors[sessionId] ?? 0;
  }

  setCursor(sessionId, seq) {
    if (!Number.isFinite(seq)) return;
    if (seq <= this.cursor(sessionId)) return;      // 只前进，不回退
    this.data.cursors[sessionId] = seq;
    this.dirty();
  }

  // ---- 消息索引（引用路由的核心）----

  /** 记下「这条 QQ 消息是哪个会话推出来的」。 */
  indexMessage(messageId, sessionId) {
    if (messageId == null || !sessionId) return;
    const key = String(messageId);
    this._lastIndexSeq += 1;
    this.data.messageIndex[key] = { sessionId, seq: this._lastIndexSeq };

    const keys = Object.keys(this.data.messageIndex);
    if (keys.length > this.maxIndexedMessages) {
      keys.sort((a, b) => (this.data.messageIndex[a].seq ?? 0) - (this.data.messageIndex[b].seq ?? 0));
      for (const k of keys.slice(0, keys.length - this.maxIndexedMessages)) {
        delete this.data.messageIndex[k];
      }
    }
    this.dirty();
  }

  /** 用户引用了这条消息 → 它属于哪个会话。 */
  sessionForMessage(messageId) {
    if (messageId == null) return null;
    return this.data.messageIndex[String(messageId)]?.sessionId ?? null;
  }

  // ---- 绑定（默认会话）----
  binding(chatKey) {
    return this.data.bindings[chatKey] ?? null;
  }

  setBinding(chatKey, sessionId) {
    if (sessionId) this.data.bindings[chatKey] = sessionId;
    else delete this.data.bindings[chatKey];
    this.dirty();
  }

  // ---- 关注列表（多会话并行）----
  subscribed(chatKey) {
    return [...(this.data.subscriptions[chatKey] ?? [])];
  }

  subscribe(chatKey, sessionId) {
    if (!sessionId) return;
    const list = this.data.subscriptions[chatKey] ?? [];
    if (list.includes(sessionId)) return;
    list.push(sessionId);
    this.data.subscriptions[chatKey] = list;
    this.dirty();
  }

  unsubscribe(chatKey, sessionId) {
    const list = this.data.subscriptions[chatKey];
    if (!list) return;
    const next = list.filter((x) => x !== sessionId);
    if (next.length) this.data.subscriptions[chatKey] = next;
    else delete this.data.subscriptions[chatKey];
    this.dirty();
  }

  /** 反查：哪些聊天在看这个会话（绑定 + 关注，去重）。 */
  chatsFor(sessionId) {
    const out = new Set();
    for (const [chatKey, bound] of Object.entries(this.data.bindings)) {
      if (bound === sessionId) out.add(chatKey);
    }
    for (const [chatKey, list] of Object.entries(this.data.subscriptions)) {
      if (list.includes(sessionId)) out.add(chatKey);
    }
    return [...out];
  }

  // ---- 分支问答：等待用户选择 ----
  pendingQuestion(chatKey) {
    return this.data.pendingQuestions[chatKey] ?? null;
  }

  setPendingQuestion(chatKey, payload) {
    if (!chatKey || !payload) return;
    this.data.pendingQuestions[chatKey] = payload;
    this.dirty();
  }

  clearPendingQuestion(chatKey) {
    if (!this.data.pendingQuestions[chatKey]) return;
    delete this.data.pendingQuestions[chatKey];
    this.dirty();
  }

  // ---- 已知聊天（「哪个会话有消息就转发」的送达范围）----
  touchChat(chatKey) {
    if (!chatKey) return;
    if (this.data.knownChats.includes(chatKey)) return;
    this.data.knownChats.push(chatKey);
    if (this.data.knownChats.length > 20) this.data.knownChats.shift();
    this.dirty();
  }

  knownChats() {
    return [...this.data.knownChats];
  }

  // ---- /list 的编号缓存（让用户能用「/use 3」而不是 20 位 id）----
  listCache(chatKey) {
    return this.data.listCache[chatKey] ?? [];
  }

  setListCache(chatKey, ids) {
    this.data.listCache[chatKey] = Array.isArray(ids) ? ids : [];
    this.dirty();
  }

  // ---- 推送开关 ----
  isPushEnabled(chatKey) {
    return this.data.pushEnabled[chatKey] !== false;
  }

  setPushEnabled(chatKey, enabled) {
    this.data.pushEnabled[chatKey] = Boolean(enabled);
    this.dirty();
  }

  dirty() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try { this.save(); } catch (err) {
        console.error('[store] 保存状态失败：', err.message);
      }
    }, 250);
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.save();
  }
}
