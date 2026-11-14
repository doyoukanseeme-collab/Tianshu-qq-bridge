// 图片附件：把 QQ 消息里的图片段转成天枢能吃的 data URL。
// 天枢限制（来自 rivet-runtime 的 attachment-limits/validation）：
//   最多 4 张，单张 ≤10MB，格式 data:image/(png|jpeg|webp|gif);base64,...
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectImageSegments,
  sniffImageMime,
  toDataUrl,
  resolveImageSources,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
} from '../src/attachments.js';

// 最小的合法 PNG（1x1 透明）
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'qqbridge-img-'));
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

describe('collectImageSegments：从消息里挑出图片', () => {
  test('数组格式的 message', () => {
    const segs = collectImageSegments([
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { file: 'a.png', url: 'https://x/a.png' } },
      { type: 'image', data: { file: 'b.jpg' } },
    ]);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].file, 'a.png');
    assert.equal(segs[1].file, 'b.jpg');
  });

  test('CQ 码格式的 raw_message', () => {
    const segs = collectImageSegments(
      undefined,
      '[CQ:image,file=abc.image,url=https://multimedia.nt.qq.com/x?appid=1]看下这个',
    );
    assert.equal(segs.length, 1);
    assert.equal(segs[0].url, 'https://multimedia.nt.qq.com/x?appid=1');
  });

  test('数组与 CQ 码同时存在时不重复计同一张图', () => {
    const segs = collectImageSegments(
      [{ type: 'image', data: { file: 'abc.image', url: 'https://x/1' } }],
      '[CQ:image,file=abc.image,url=https://x/1]',
    );
    assert.equal(segs.length, 1, `不该重复：${JSON.stringify(segs)}`);
  });

  test('没有图片时返回空数组', () => {
    assert.deepEqual(collectImageSegments([{ type: 'text', data: { text: 'hi' } }], 'hi'), []);
  });

  test('超过 4 张时截断到 4 张（天枢上限）', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ type: 'image', data: { file: `f${i}.png` } }));
    assert.equal(collectImageSegments(many).length, MAX_IMAGES);
  });
});

describe('sniffImageMime：从字节猜图片类型', () => {
  test('PNG', () => assert.equal(sniffImageMime(PNG_1X1), 'image/png'));
  test('JPEG', () => assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), 'image/jpeg'));
  test('GIF', () => assert.equal(sniffImageMime(Buffer.from('GIF89a')), 'image/gif'));
  test('WebP', () => {
    const b = Buffer.alloc(16);
    b.write('RIFF', 0); b.write('WEBP', 8);
    assert.equal(sniffImageMime(b), 'image/webp');
  });
  test('认不出返回 null', () => assert.equal(sniffImageMime(Buffer.from('hello world')), null));
});

describe('toDataUrl', () => {
  test('生成天枢接受的 data URL', () => {
    const url = toDataUrl(PNG_1X1, 'image/png');
    assert.match(url, /^data:image\/png;base64,.+$/);
    assert.equal(Buffer.from(url.split(',')[1], 'base64').length, PNG_1X1.length);
  });
  test('超过 10MB 抛错（天枢会 400）', () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0);
    assert.throws(() => toDataUrl(big, 'image/png'), /10MB|too large|过大/i);
  });
});

describe('resolveImageSources：本地文件优先，URL 兜底', () => {
  test('从本地 file 路径读图（优先）', async () => {
    const t = tmpDir();
    try {
      const p = join(t.dir, 'shot.png');
      writeFileSync(p, PNG_1X1);
      const { images, errors } = await resolveImageSources([{ file: p }], {
        allowUrl: true,
        httpGet: async () => { throw new Error('不该走网络'); },
      });
      assert.equal(images.length, 1, `错误：${JSON.stringify(errors)}`);
      assert.match(images[0], /^data:image\/png;base64,/);
    } finally { t.cleanup(); }
  });

  test('file:// 前缀也能读', async () => {
    const t = tmpDir();
    try {
      const p = join(t.dir, 'shot.png');
      writeFileSync(p, PNG_1X1);
      const { images } = await resolveImageSources([{ file: `file:///${p.replace(/\\/g, '/')}` }], { allowUrl: false });
      assert.equal(images.length, 1);
    } finally { t.cleanup(); }
  });

  test('本地文件不存在时回退到 url 下载', async () => {
    const { images, errors } = await resolveImageSources(
      [{ file: 'D:/不存在/x.png', url: 'https://example/a.png' }],
      { allowUrl: true, httpGet: async () => PNG_1X1 },
    );
    assert.equal(images.length, 1, `错误：${JSON.stringify(errors)}`);
    assert.match(images[0], /^data:image\/png;base64,/);
  });

  test('两种来源都失败时记录错误但不抛（不阻断整条指令）', async () => {
    const { images, errors } = await resolveImageSources(
      [{ file: 'D:/不存在/x.png', url: 'https://example/b.png' }],
      { allowUrl: true, httpGet: async () => { throw new Error('404'); } },
    );
    assert.equal(images.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /404|失败/);
  });

  test('禁止 URL 时不去下载', async () => {
    let called = false;
    const { images } = await resolveImageSources(
      [{ url: 'https://example/c.png' }],
      { allowUrl: false, httpGet: async () => { called = true; return PNG_1X1; } },
    );
    assert.equal(called, false, 'allowUrl=false 时不该发起网络请求');
    assert.equal(images.length, 0);
  });

  test('相对文件名会到 cacheDirs 里找', async () => {
    const t = tmpDir();
    try {
      mkdirSync(join(t.dir, 'cache'), { recursive: true });
      writeFileSync(join(t.dir, 'cache', 'abc.image'), PNG_1X1);
      const { images } = await resolveImageSources([{ file: 'abc.image' }], {
        allowUrl: false,
        cacheDirs: [join(t.dir, 'cache')],
      });
      assert.equal(images.length, 1, '应在 cache 目录里找到 abc.image');
    } finally { t.cleanup(); }
  });

  test('认不出图片类型的不提交', async () => {
    const t = tmpDir();
    try {
      const p = join(t.dir, 'notimage.png');
      writeFileSync(p, Buffer.from('this is not an image'));
      const { images, errors } = await resolveImageSources([{ file: p }], { allowUrl: false });
      assert.equal(images.length, 0);
      assert.match(errors[0], /格式|mime|认不出/i);
    } finally { t.cleanup(); }
  });
});

describe('端到端：真图片文件 → 天枢校验规则', () => {
  test('本地 PNG 经完整链路后，格式与大小都符合天枢服务端约束', async () => {
    const t = tmpDir();
    try {
      const p = join(t.dir, 'real.png');
      writeFileSync(p, PNG_1X1);

      // 模拟一条真实 QQ 消息（数组段 + CQ 码同时存在，和 NapCat 实际行为一致）
      const raw = `[CQ:image,file=${p},url=https://example/never-used]看这个报错`;
      const segs = collectImageSegments(
        [{ type: 'reply', data: { id: '1' } }, { type: 'image', data: { file: p, url: 'https://example/never-used' } }, { type: 'text', data: { text: '看这个报错' } }],
        raw,
      );
      assert.equal(segs.length, 1, '数组与 CQ 码应去重成 1 张');

      const { images, errors } = await resolveImageSources(segs, {
        allowUrl: false,           // 强制走本地
        httpGet: async () => { throw new Error('不该联网'); },
      });
      assert.deepEqual(errors, [], `不该有错误：${errors}`);
      assert.equal(images.length, 1);

      // 用天枢服务端同一套规则复验（ACCEPTED_IMAGE_DATA_URL + 10MB 上限）
      const ACCEPTED = /^data:image\/(png|jpeg|webp|gif);base64,.+$/i;
      const dataUrl = images[0];
      assert.match(dataUrl, ACCEPTED, '必须匹配天枢的 data URL 正则');
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
      const bytes = Math.floor(b64.length * 3 / 4) - padding;
      assert.equal(bytes, PNG_1X1.length, 'base64 解码后字节数应与原文件一致');
      assert.ok(bytes <= MAX_IMAGE_BYTES, '不能超过 10MB');
      // 解回来还是合法 PNG
      assert.equal(Buffer.from(b64, 'base64').subarray(0, 4).toString('hex'), '89504e47');
    } finally { t.cleanup(); }
  });
});
