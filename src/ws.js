// 最小 WebSocket 服务端（RFC 6455 子集）：只为两件事服务——
//   1) OneBot 反向 WS 模式（NapCat 主动连进来）
//   2) 测试里扮演 NapCat（mock 服务端）
// 只处理 text 帧 + ping/pong/close + 分片累积，不做扩展协商。零依赖是刻意的：
// 用户机器上不需要 npm install 就能跑。
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export function encodeFrame(opcode, payload, mask = false) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;          // FIN=1
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const key = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([header, key, masked]);
}

/** 从累积缓冲里尽量多地切出完整帧，返回未消费的余量。 */
export function consumeFrames(buffer, onFrame) {
  let buf = buffer;
  while (buf.length >= 2) {
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return buf;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return buf;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < off + 4) return buf;
      maskKey = buf.subarray(off, off + 4);
      off += 4;
    }
    if (buf.length < off + len) return buf;
    let payload = buf.subarray(off, off + len);
    if (masked) {
      const p = Buffer.alloc(len);
      for (let i = 0; i < len; i++) p[i] = payload[i] ^ maskKey[i % 4];
      payload = p;
    }
    buf = buf.subarray(off + len);
    onFrame({ fin, opcode, payload });
  }
  return buf;
}

export class WsConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.closed = false;
    this.remote = `${req?.socket?.remoteAddress ?? '?'}:${req?.socket?.remotePort ?? '?'}`;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;

    socket.on('data', (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk]);
      this._buf = consumeFrames(this._buf, (frame) => this.#onFrame(frame));
    });
    socket.on('close', () => this.#markClosed('socket-close'));
    socket.on('error', (err) => {
      this.emit('error', err);
      this.#markClosed('socket-error');
    });
  }

  #onFrame({ fin, opcode, payload }) {
    if (opcode === OP_CLOSE) {
      this.close(1000, '');
      return;
    }
    if (opcode === OP_PING) {
      this.#raw(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) return;

    if (opcode === OP_CONT) {
      this._fragments.push(payload);
    } else {
      this._fragments = [payload];
      this._fragmentOpcode = opcode;
    }
    if (!fin) return;

    const full = Buffer.concat(this._fragments);
    this._fragments = [];
    const op = this._fragmentOpcode;
    this._fragmentOpcode = null;
    if (op === OP_TEXT) this.emit('message', full.toString('utf8'));
    else if (op === OP_BIN) this.emit('binary', full);
  }

  #raw(opcode, payload) {
    if (this.closed || !this.socket.writable) return false;
    try {
      this.socket.write(encodeFrame(opcode, payload));
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

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.#raw(OP_CLOSE, body);
    this.#markClosed('local-close');
    try { this.socket.end(); } catch { /* 已断开 */ }
  }

  #markClosed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', reason);
  }
}

/**
 * 起一个 WS 服务端。
 * @param {{port:number, host?:string, path?:string, onConnection:(conn:WsConnection, req)=>void}} opts
 * @returns {Promise<{port:number, close:()=>Promise<void>, url:string}>}
 */
export function createWsServer({ port, host = '127.0.0.1', path, onConnection }) {
  const server = createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('WebSocket only');
  });

  server.on('upgrade', (req, socket) => {
    const url = req.url || '/';
    if (path && !url.startsWith(path)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const conn = new WsConnection(socket, req);
    onConnection?.(conn, req);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const actual = server.address();
      resolve({
        port: actual.port,
        url: `ws://${host}:${actual.port}${path ?? ''}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
