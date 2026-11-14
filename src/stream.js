// 每个被关注的会话一条 SSE 长连接，断线指数退避重连，游标落地后重放不漏事件。

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30000;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export class StreamManager {
  /**
   * @param {object} opts
   * @param {() => Promise<import('./tianshu.js').TianshuClient>} opts.getClient 每次重连重新取客户端（天枢重启后端口/令牌会变）
   * @param {import('./state.js').Store} opts.store
   * @param {(sessionId: string, event: object) => void} opts.onEvent
   * @param {(sessionId: string, err: Error, info: {retryInMs: number}) => void} [opts.onError]
   * @param {(sessionId: string) => void} [opts.onConnect]
   */
  constructor({ getClient, store, onEvent, onError, onConnect }) {
    this.getClient = getClient;
    this.store = store;
    this.onEvent = onEvent;
    this.onError = onError ?? (() => {});
    this.onConnect = onConnect ?? (() => {});
    this.subs = new Map();      // sessionId -> { sessionId, controller, stopped, connected }
  }

  get activeIds() {
    return [...this.subs.keys()];
  }

  isWatching(sessionId) {
    return this.subs.has(sessionId);
  }

  /**
   * 开始关注某个会话。幂等。
   * @param {string} sessionId
   * @param {{fromLatest?: boolean, lastSeq?: number}} [opts] fromLatest=true 时从会话当前末尾开始，不重放历史
   */
  async watch(sessionId, opts = {}) {
    if (this.subs.has(sessionId)) return;
    if (opts.fromLatest && opts.lastSeq != null) {
      this.store.setCursor(sessionId, opts.lastSeq);
    }
    const sub = { sessionId, controller: new AbortController(), stopped: false, connected: false };
    this.subs.set(sessionId, sub);
    sub.task = this.#run(sub);
  }

  unwatch(sessionId) {
    const sub = this.subs.get(sessionId);
    if (!sub) return;
    sub.stopped = true;
    sub.controller.abort();
    this.subs.delete(sessionId);
  }

  stopAll() {
    for (const id of [...this.subs.keys()]) this.unwatch(id);
  }

  async #run(sub) {
    let backoff = MIN_BACKOFF;
    while (!sub.stopped) {
      try {
        const client = await this.getClient();
        const since = this.store.cursor(sub.sessionId);
        const iterable = client.streamEvents(sub.sessionId, since, { signal: sub.controller.signal });
        for await (const ev of iterable) {
          if (sub.stopped) break;
          if (!sub.connected) { sub.connected = true; backoff = MIN_BACKOFF; this.onConnect(sub.sessionId); }
          const seq = typeof ev?.seq === 'number' ? ev.seq : 0;
          if (seq > 0) this.store.setCursor(sub.sessionId, seq);
          this.onEvent(sub.sessionId, ev);
        }
      } catch (err) {
        if (sub.stopped || sub.controller.signal.aborted) break;
        sub.connected = false;
        this.onError(sub.sessionId, err, { retryInMs: backoff });
        // 401/404 多半是天枢重启或会话被删——退避拉长但继续试，重启后自动接上
      }
      if (sub.stopped) break;
      sub.connected = false;
      await sleep(backoff, sub.controller.signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }
  }
}
