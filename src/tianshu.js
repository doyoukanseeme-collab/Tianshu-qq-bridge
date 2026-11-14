// 天枢本地 API 客户端。
// 协议来自随桌面端分发的 mobile-web（assets/mobile-vavpTRPl.js 内 API 客户端），
// 全部端点均经实测确认，见 README「API 速查」。
import { readFileSync } from 'node:fs';

export class TianshuError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'TianshuError';
    this.status = status;
    this.code = code;
  }
}

/** 从桌面端写的 server-info.json 读端口与令牌。重启后端口和令牌都会变，所以每次启动都重读。 */
export function readServerInfo(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new TianshuError(
      `读不到天枢服务信息：${path}（${err.code || err.message}）。天枢桌面端是否在运行？`,
      { code: 'NO_SERVER_INFO' },
    );
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new TianshuError(`天枢服务信息不是合法 JSON：${path}`, { code: 'BAD_SERVER_INFO' });
  }
  if (!info?.port || !info?.token) {
    throw new TianshuError(`天枢服务信息缺少 port/token：${path}`, { code: 'BAD_SERVER_INFO' });
  }
  return info;
}

export class TianshuClient {
  constructor({ baseUrl, token, timeoutMs = 15000 }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /** 从 server-info.json 构造；host 固定 127.0.0.1（桌面端只绑 loopback）。 */
  static fromServerInfo(path, opts = {}) {
    const info = readServerInfo(path);
    return new TianshuClient({
      baseUrl: `http://127.0.0.1:${info.port}`,
      token: info.token,
      ...opts,
    });
  }

  get headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async request(method, path, body) {
    const init = {
      method,
      headers: { ...this.headers },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(this.baseUrl + path, init);
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw new TianshuError(`天枢 ${method} ${path} 超时（${this.timeoutMs}ms）`, { code: 'TIMEOUT' });
      }
      throw new TianshuError(`天枢 ${method} ${path} 连接失败：${err.message}`, { code: 'NETWORK' });
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!res.ok) {
      throw new TianshuError(
        `天枢 ${method} ${path} → ${res.status}${payload?.error ? `：${payload.error}` : ''}`,
        { status: res.status, code: payload?.code || '' },
      );
    }
    return payload;
  }

  // ---- 会话 ----
  async listSessions({ includeArchived = false } = {}) {
    const path = includeArchived ? '/sessions?includeArchived=true' : '/sessions';
    const data = await this.request('GET', path);
    return data?.sessions ?? [];
  }

  getSession(id) {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}`);
  }

  createSession({ prompt, cwd, planMode }) {
    const body = { prompt };
    if (cwd) body.cwd = cwd;
    if (planMode) body.planMode = planMode;
    return this.request('POST', '/sessions', body);
  }

  renameSession(id, title) {
    return this.request('PATCH', `/sessions/${encodeURIComponent(id)}`, { title });
  }

  archiveSession(id) {
    return this.request('DELETE', `/sessions/${encodeURIComponent(id)}`);
  }

  unarchiveSession(id) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/unarchive`, {});
  }

  deleteSession(id) {
    return this.request('DELETE', `/sessions/${encodeURIComponent(id)}/permanent`);
  }

  // ---- 输入 ----
  /** idle 会话：新起一轮。 */
  /**
   * idle 会话：新起一轮。
   * images: 天枢接受的 data URL 数组，最多 4 张、单张 ≤10MB
   * （限制来自服务端 attachment-limits / attachment-validation）。
   */
  sendPrompt(id, prompt, images = null) {
    const body = { prompt };
    if (Array.isArray(images) && images.length > 0) body.images = images.slice(0, 4);
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/prompt`, body);
  }

  /** running 会话：运行中插话。idle 时会返回 409 code=idle，调用方应回退到 sendPrompt。 */
  steerSession(id, text, images = null) {
    const body = { text };
    if (Array.isArray(images) && images.length > 0) body.images = images.slice(0, 4);
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/steer`, body);
  }

  abortSession(id) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/abort`, {});
  }

  setPlanMode(id, state) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/plan-mode`, { state });
  }

  setEffort(id, effort) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/effort`, { effort });
  }

  // ---- 审批 ----
  answerApproval(id, approvalId, decision, remember = false) {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}/answer`,
      remember ? { decision, remember: true } : { decision },
    );
  }

  approvePlan(id, planId, approach) {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/plans/${encodeURIComponent(planId)}/approve`,
      approach ? { selectedApproach: approach } : {},
    );
  }

  rejectPlan(id, planId, comment) {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/plans/${encodeURIComponent(planId)}/reject`,
      comment ? { comment } : {},
    );
  }

  // ---- 历史与产物 ----
  async fetchEvents(id, since = 0) {
    const data = await this.request('GET', `/sessions/${encodeURIComponent(id)}/events?since=${since}`);
    return data?.events ?? [];
  }

  async fetchHistory(id, { before, limit = 500 } = {}) {
    const qs = new URLSearchParams();
    if (before) qs.set('before', String(before));
    qs.set('limit', String(limit));
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/history?${qs}`);
  }

  async listArtifacts(id) {
    const data = await this.request('GET', `/sessions/${encodeURIComponent(id)}/artifacts`);
    return data?.artifacts ?? [];
  }

  readArtifact(id, artifactId) {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`);
  }

  searchSessions(q) {
    return this.request('GET', `/sessions/search?q=${encodeURIComponent(q)}`);
  }

  remoteInfo() {
    return this.request('GET', '/remote/info');
  }

  /**
   * 订阅事件流（SSE）。断点续流靠 since。
   * 产出 {seq, ts, type, data} 对象，遇到 replay_window 等控制帧也原样产出，由调用方决定忽略。
   * 正常情况下永不自然结束；连接断开时抛出，由调用方按退避重连。
   */
  async *streamEvents(id, since = 0, { signal, onOpen } = {}) {
    let res;
    try {
      res = await fetch(
        `${this.baseUrl}/sessions/${encodeURIComponent(id)}/stream?since=${since}`,
        { headers: this.headers, signal },
      );
    } catch (err) {
      if (signal?.aborted) return;
      throw new TianshuError(`订阅事件流连接失败：${err.message}`, { code: 'NETWORK' });
    }
    if (!res.ok || !res.body) {
      throw new TianshuError(`订阅事件流失败：HTTP ${res.status}`, { status: res.status });
    }
    onOpen?.();

    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];

    const flushFrame = () => {
      if (dataLines.length === 0) return null;
      const payload = dataLines.join('\n');
      dataLines = [];
      try {
        const obj = JSON.parse(payload);
        return obj && typeof obj === 'object' ? obj : null;
      } catch {
        return null;
      }
    };

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          const frame = flushFrame();
          if (frame) yield frame;
          continue;
        }
        if (line.startsWith(':')) continue;            // 注释/心跳
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        // event: / id: / retry: 字段对解码无影响，忽略
      }
    }
    const tail = flushFrame();
    if (tail) yield tail;
  }
}
