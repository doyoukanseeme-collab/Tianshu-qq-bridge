// WebSocket 客户端：Node 内置的全局 WebSocket 无法自定义握手头，
// 而 NapCat 的 WS 服务器要求 `Authorization: Bearer <token>`。
// 这里用 http.request 走 upgrade，复用 ws.js 的帧编解码，保持零依赖。
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { encodeFrame, consumeFrames } from './ws.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class WsClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.open = false;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;
    this._req = null;
  }

  /**
   * @param {string} url ws:// 或 wss://
   * @param {{headers?: Record<string,string>, timeoutMs?: number}} opts
   */
  connect(url, opts = {}) {
    const u = new URL(url);
    const isTls = u.protocol === 'wss:';
    const key = randomBytes(16).toString('base64');
    const pathWithQuery = `${u.pathname || '/'}${u.search || ''}`;
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...(opts.headers ?? {}),
    };

    const mod = isTls ? httpsRequest : httpRequest;
    const req = mod({
      host: u.hostname,
      port: u.port || (isTls ? 443 : 80),
      path: pathWithQuery,
      headers,
      timeout: opts.timeoutMs ?? 15000,
    });
    this._req = req;

    req.on('upgrade', (res, socket, head) => {
      const expected = createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        this.emit('error', new Error('WebSocket 握手失败：Sec-WebSocket-Accept 不匹配'));
        return;
      }
      this.socket = socket;
      this.open = true;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => {
        this._buf = Buffer.concat([this._buf, chunk]);
        this._buf = consumeFrames(this._buf, (f) => this.#onFrame(f));
      });
      socket.on('close', () => this.#markClosed('socket-close'));
      socket.on('error', (err) => {
        this.emit('error', err);
        this.#markClosed('socket-error');
      });
      if (head && head.length) {
        this._buf = Buffer.concat([this._buf, head]);
        this._buf = consumeFrames(this._buf, (f) => this.#onFrame(f));
      }
      this.emit('open');
    });

    // 服务端拒绝升级时（401/404）会走普通响应
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 500) body += c; });
      res.on('end', () => {
        this.emit('error', new Error(`WebSocket 握手被拒：HTTP ${res.statusCode}${body ? ` ${body.slice(0, 200)}` : ''}`));
        this.#markClosed('handshake-rejected');
      });
    });

    req.on('timeout', () => {
      req.destroy();
      this.emit('error', new Error('WebSocket 连接超时'));
      this.#markClosed('timeout');
    });
    req.on('error', (err) => {
      this.emit('error', err);
      this.#markClosed('request-error');
    });
    req.end();
    return this;
  }

  #onFrame({ fin, opcode, payload }) {
    if (opcode === OP_CLOSE) { this.close(); return; }
    if (opcode === OP_PING) { this.#raw(OP_PONG, payload); return; }
    if (opcode === OP_PONG) return;

    if (opcode === 0x0) this._fragments.push(payload);
    else { this._fragments = [payload]; this._fragmentOpcode = opcode; }
    if (!fin) return;

    const full = Buffer.concat(this._fragments);
    this._fragments = [];
    const op = this._fragmentOpcode;
    this._fragmentOpcode = null;
    if (op === OP_TEXT) this.emit('message', full.toString('utf8'));
    else if (op === OP_BIN) this.emit('binary', full);
  }

  #raw(opcode, payload) {
    if (!this.open || !this.socket?.writable) return false;
    try {
      this.socket.write(encodeFrame(opcode, payload, true));   // 客户端帧必须 mask
      return true;
    } catch {
      return false;
    }
  }

  send(text) {
    return this.#raw(OP_TEXT, Buffer.from(String(text), 'utf8'));
  }

  sendJson(obj) {
    return this.send(JSON.stringify(obj));
  }

  close() {
    if (!this.open) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(1000, 0);
    this.#raw(OP_CLOSE, body);
    this.#markClosed('local-close');
    try { this.socket.end(); } catch { /* 已断开 */ }
  }

  #markClosed(reason) {
    if (!this.open) {
      this._req?.destroy();
      return;
    }
    this.open = false;
    this.emit('close', reason);
  }
}
