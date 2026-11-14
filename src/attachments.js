// QQ 图片附件 → 天枢 images 载荷。
// 天枢的约束（从 rivet-runtime 的 attachment-limits / attachment-validation 读出）：
//   最多 4 张，单张 ≤ 10MB，
//   格式必须匹配 /^data:image\/(png|jpeg|webp|gif);base64,.+$/i
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED = /^data:image\/(png|jpeg|webp|gif);base64,.+$/i;

/**
 * 从消息里挑出图片段。
 * 同时支持数组格式（message 段）和 CQ 码格式（raw_message）。
 * @returns {Array<{file?:string, url?:string}>} 最多 MAX_IMAGES 条
 */
export function collectImageSegments(message, rawMessage) {
  const out = [];

  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type !== 'image') continue;
      out.push({ file: seg.data?.file, url: seg.data?.url });
      if (out.length >= MAX_IMAGES) return out;
    }
  }

  if (out.length < MAX_IMAGES && typeof rawMessage === 'string') {
    const re = /\[CQ:image,([^\]]*)\]/g;
    let m;
    while ((m = re.exec(rawMessage)) !== null && out.length < MAX_IMAGES) {
      const params = {};
      for (const kv of m[1].split(',')) {
        const eq = kv.indexOf('=');
        if (eq > 0) params[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      // 避免与数组格式重复（同一张图两边都会出现）
      const dup = out.some((o) => (params.file && o.file === params.file) || (params.url && o.url === params.url));
      if (!dup) out.push({ file: params.file, url: params.url });
    }
  }

  return out.slice(0, MAX_IMAGES);
}

/** 按文件头判图片类型，不信任扩展名。 */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** 字节 → 天枢接受的 data URL。超限抛错（天枢会 400，不如提前说清）。 */
export function toDataUrl(buf, mime) {
  if (!Buffer.isBuffer(buf)) throw new Error('toDataUrl 需要 Buffer');
  if (buf.length > MAX_IMAGE_BYTES) {
    const mb = (buf.length / 1024 / 1024).toFixed(1);
    throw new Error(`图片过大（${mb}MB，天枢上限 10MB）`);
  }
  const url = `data:${mime};base64,${buf.toString('base64')}`;
  if (!ACCEPTED.test(url)) throw new Error(`图片格式不被天枢接受：${mime}`);
  return url;
}

/** file:///C:/x.png 或 C:\x.png → 本地路径 */
export function normalizeLocalPath(p) {
  let s = String(p ?? '');
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length);
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);          // /C:/x → C:/x
  }
  try { s = decodeURIComponent(s); } catch { /* 保留原样 */ }
  return s;
}

async function readLocal(candidate, cacheDirs) {
  const tries = [];
  const norm = normalizeLocalPath(candidate);
  if (norm) tries.push(norm);
  // NapCat 有时只给文件名，去缓存目录里找
  if (norm && !/^[A-Za-z]:[\\/]|^\//.test(norm)) {
    for (const dir of cacheDirs ?? []) tries.push(join(dir, norm));
  }
  for (const p of tries) {
    try {
      if (!existsSync(p)) continue;
      const st = await stat(p);
      if (!st.isFile()) continue;
      return await readFile(p);
    } catch { /* 试下一个 */ }
  }
  return null;
}

const defaultHttpGet = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

/**
 * 把图片段解析成 data URL 列表。
 * 策略：本地文件优先（NapCat 与桥同机，路径可直接读），URL 兜底。
 * 单张失败只记错误，不抛——不能因为一张图坏了就丢掉整条指令。
 * @returns {Promise<{images: string[], errors: string[]}>}
 */
export async function resolveImageSources(segments, opts = {}) {
  const { allowUrl = true, cacheDirs = [], httpGet = defaultHttpGet } = opts;
  const images = [];
  const errors = [];

  for (const seg of segments.slice(0, MAX_IMAGES)) {
    let buf = null;
    let via = '';

    if (seg.file) {
      buf = await readLocal(seg.file, cacheDirs);
      if (buf) via = 'local';
    }

    if (!buf && seg.url && allowUrl) {
      try {
        buf = await httpGet(seg.url);
        if (buf) via = 'url';
      } catch (err) {
        errors.push(`下载图片失败：${err.message}`);
      }
    }

    if (!buf) {
      if (!seg.file && !seg.url) errors.push('图片段里没有 file 也没有 url');
      else if (!allowUrl && !via) errors.push(`读不到本地图片：${seg.file ?? '(无 file)'}（URL 下载已禁用）`);
      else if (!errors.length) errors.push(`读不到图片：${seg.file ?? seg.url ?? '未知来源'}`);
      continue;
    }

    const mime = sniffImageMime(buf);
    if (!mime) {
      errors.push(`图片格式认不出（既不是 png/jpeg/webp/gif）：${seg.file ?? seg.url}`);
      continue;
    }
    try {
      images.push(toDataUrl(buf, mime));
    } catch (err) {
      errors.push(err.message);
    }
  }

  return { images, errors };
}
