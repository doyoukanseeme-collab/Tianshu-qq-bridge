// Markdown → 图片。用系统 Chrome 渲染后截图，不引入新依赖。
// Chrome 路径优先取配置，其次自动探测；找不到就报错让上层降级为文本。
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MERMAID_PATH = resolve(HERE, '../vendor/mermaid.min.js');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

/**
 * playwright-core 是可选的渲染依赖：桥不打包它。
 * 优先用配置里显式给的路径，其次试本机常见位置（含随天枢桌面端分发的副本）。
 * 都找不到时由调用方降级为纯文本发送——Markdown 渲染不是核心功能。
 */
const PLAYWRIGHT_CANDIDATES = [
  process.env.PLAYWRIGHT_CORE_PATH,
  resolve(HERE, '../node_modules/playwright-core/index.js'),
  'D:/tianshu/rivet-runtime/node_modules/playwright-core/index.js',
  'C:/tianshu/rivet-runtime/node_modules/playwright-core/index.js',
].filter(Boolean);

export function findChrome(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

let _pw = null;
async function loadPlaywright(explicit) {
  if (_pw) return _pw;
  const tries = explicit ? [explicit, ...PLAYWRIGHT_CANDIDATES] : PLAYWRIGHT_CANDIDATES;
  for (const p of tries) {
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      const pw = mod.default ?? mod;
      if (pw.chromium) { _pw = pw; return pw; }
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到可用的 playwright-core（可在配置里指定 playwrightPath）');
}

export class Renderer {
  /**
   * @param {object} opts
   * @param {string} [opts.chromePath]  显式 Chrome 路径
   * @param {string} [opts.playwrightPath]
   * @param {number} [opts.width]       视口宽度
   * @param {boolean} [opts.dark]
   * @param {number} [opts.scale]       设备像素比（2 = 清晰二倍图）
   */
  constructor(opts = {}) {
    this.chromePath = findChrome(opts.chromePath);
    this.playwrightPath = opts.playwrightPath;
    this.width = opts.width ?? 760;
    this.dark = opts.dark ?? false;
    this.scale = opts.scale ?? 2;
    this.browser = null;

    this.stats = { rendered: 0, failed: 0, totalMs: 0 };
    this._mermaidScript = undefined;   // 懒加载，只在需要时读 2.5MB
  }

  get available() {
    return Boolean(this.chromePath);
  }

  async #ensureBrowser() {
    if (this.browser?.isConnected?.()) return this.browser;
    const pw = await loadPlaywright(this.playwrightPath);
    this.browser = await pw.chromium.launch({
      executablePath: this.chromePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
    });
    return this.browser;
  }

  /**
   * 把一个完整 HTML 文档截成 PNG。
   * @returns {Promise<Buffer>}
   */
  async screenshotHtml(html, { width = this.width } = {}) {
    const t0 = Date.now();
    const browser = await this.#ensureBrowser();
    const page = await browser.newPage({
      viewport: { width, height: 800 },
      deviceScaleFactor: this.scale,
    });
    try {
      await page.setContent(html, { waitUntil: 'load' });
      // 等字体就绪，避免截到 fallback 字体
      await page.evaluate(() => document.fonts?.ready ?? Promise.resolve()).catch(() => {});
      const buf = await page.screenshot({ type: 'png', fullPage: true });
      this.stats.rendered += 1;
      this.stats.totalMs += Date.now() - t0;
      return buf;
    } catch (err) {
      this.stats.failed += 1;
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** mermaid.js 源码（没有 vendor 文件则返回 null，走降级渲染）。 */
  mermaidScript() {
    if (this._mermaidScript === undefined) {
      this._mermaidScript = existsSync(MERMAID_PATH) ? readFileSync(MERMAID_PATH, 'utf8') : null;
    }
    return this._mermaidScript;
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

/** 把 PNG 落盘（调试用，可看到实际渲染效果）。 */
export function savePng(buf, dir, name = `md-${Date.now()}.png`) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}
