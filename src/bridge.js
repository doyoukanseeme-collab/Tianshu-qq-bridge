// 桥接核心：把 OneBot 的消息事件接到天枢 API，把天枢的事件流摘要成 QQ 消息。
import { TianshuClient, TianshuError } from './tianshu.js';
import { Store } from './state.js';
import { StreamManager } from './stream.js';
import { Summarizer, splitChunks } from './summarize.js';
import { splitForDelivery, mermaidToMarkdown, mermaidToFallbackText } from './delivery.js';
import { OneBot, normalizeIncoming } from './onebot.js';
import { collectImageSegments, resolveImageSources } from './attachments.js';
import { markdownToHtml, wrapDocument } from './markdown.js';
import { formatQuestion, parseAnswer, resolveChoice } from './question.js';
import { Renderer } from './render.js';
import { handleCommand, dispatchText, HELP_TEXT } from './commands.js';

export class Bridge {
  constructor(config) {
    this.config = config;
    this.store = new Store(config.statePath);
    this.client = null;
    this.summarizers = new Map();       // sessionId -> Summarizer
    this.approvals = new Map();         // sessionId -> {id, title, at}
    this.startedAt = Date.now();
    this.renderer = config.push?.renderMarkdown
      ? new Renderer({
        chromePath: config.push?.chromePath,
        width: config.push?.renderWidth ?? 760,
        dark: config.push?.renderDark ?? false,
      })
      : null;

    this.onebot = new OneBot(config.onebot);
    this.streams = new StreamManager({
      getClient: () => this.getClient(),
      store: this.store,
      onEvent: (sessionId, ev) => this.onTianshuEvent(sessionId, ev),
      onError: (sessionId, err, { retryInMs }) => {
        this.log(`[流] ${sessionId.slice(-8)} 断开：${err.message}（${retryInMs / 1000}s 后重试）`);
      },
      onConnect: (sessionId) => this.log(`[流] ${sessionId.slice(-8)} 已接上`),
    });
  }

  log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`${ts} ${msg}`);
  }

  // ---------- 天枢客户端（天枢重启用新端口/令牌，401 时重建） ----------

  async getClient() {
    if (!this.client) {
      this.client = TianshuClient.fromServerInfo(this.config.tianshu.serverInfoPath, {
        timeoutMs: this.config.tianshu.timeoutMs,
      });
    }
    return this.client;
  }

  /** 调用天枢；遇到 401 说明桌面端重启换了令牌，重读 server-info 再试一次。 */
  async call(fn) {
    let client = await this.getClient();
    try {
      return await fn(client);
    } catch (err) {
      if (err instanceof TianshuError && (err.status === 401 || err.code === 'NETWORK')) {
        this.client = null;
        client = await this.getClient();
        this.log('天枢令牌/端口已变化，已重连');
        return await fn(client);
      }
      throw err;
    }
  }

  // ---------- 启动 ----------

  async start() {
    this.onebot.on('log', (m) => this.log(`[onebot] ${m}`));
    this.onebot.on('ready', () => this.log('[onebot] 就绪'));
    this.onebot.on('event', (ev) => {
      this.onOneBotEvent(ev).catch((err) => this.log(`[事件处理失败] ${err.stack || err.message}`));
    });
    await this.onebot.start();

    // 恢复上次绑定与关注：重启后自动重新接上这些会话的事件流
    const restore = new Set();
    for (const sessionId of Object.values(this.store.data.bindings)) restore.add(sessionId);
    for (const list of Object.values(this.store.data.subscriptions)) {
      for (const sessionId of list) restore.add(sessionId);
    }
    for (const sessionId of restore) {
      await this.attachSession(sessionId, { fromLatest: false }).catch((err) => {
        this.log(`恢复 ${sessionId.slice(-8)} 失败：${err.message}`);
      });
    }

    // 自动追踪所有正在运行的会话，并定期复查（启动后才开跑的也要跟上）
    await this.scanRunningSessions();
    if (this.config.push?.autoForward !== false) {
      const every = this.config.push?.scanIntervalMs ?? 20000;
      this.scanTimer = setInterval(() => {
        this.scanRunningSessions().catch(() => {});
      }, every);
      this.scanTimer.unref?.();
      this.log(`每 ${Math.round(every / 1000)}s 复查新开的会话`);
    }
  }

  /**
   * 扫一遍会话列表，把「正在跑但还没被追踪」的接上。
   * 桥启动后用户可能才开新会话——只在启动时扫一次会漏掉它们。
   */
  async scanRunningSessions() {
    if (this.config.push?.autoForward === false) return;
    let sessions;
    try {
      sessions = await this.call((c) => c.listSessions());
    } catch (err) {
      this.log(`列会话失败（不影响运行）：${err.message}`);
      return;
    }
    const running = sessions.filter((s) => s.status === 'running');
    const fresh = running.filter((s) => !this.streams.isWatching(s.id));
    for (const s of fresh) {
      await this.attachSession(s.id, { fromLatest: true, lastSeq: s.lastSeq })
        .catch((err) => this.log(`追踪 ${String(s.id).slice(-8)} 失败：${err.message}`));
    }
    if (fresh.length) {
      this.log(`新追踪 ${fresh.length} 个运行中的会话：${fresh.map((s) => String(s.id).slice(-8)).join(', ')}`);
    }
    return fresh.map((s) => s.id);
  }

  async stop() {
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    this.streams.stopAll();
    await this.onebot.stop();
    this.store.flush();
  }

  // ---------- 会话订阅 ----------

  /** 让桥开始追踪某个会话的事件流（幂等）。 */
  async attachSession(sessionId, { fromLatest = false, lastSeq = null } = {}) {
    if (!this.summarizers.has(sessionId)) {
      this.summarizers.set(sessionId, new Summarizer({
        ...this.config.push,
        // 串行化：emit 是同步回调，broadcast 是异步的（要渲染、要发 HTTP）。
        // 不排队就会并发跑，多条消息到达顺序由「谁先渲染完」决定，不是发出的顺序。
        emit: (text) => this.enqueuePush(sessionId, text),
      }));
    }
    if (!this.streams.isWatching(sessionId)) {
      await this.streams.watch(sessionId, { fromLatest, lastSeq });
    }
  }

  /**
   * 推送串行队列：同一个桥内所有推送按调用顺序逐条发完再发下一条。
   * 保证 QQ 里看到的顺序与内容顺序一致。
   */
  enqueuePush(sessionId, text) {
    if (!this._pushChain) this._pushChain = Promise.resolve();
    this._pushChain = this._pushChain
      .then(() => this.broadcast(sessionId, text))
      .catch((err) => this.log(`推送队列出错：${err.message}`));
    return this._pushChain;
  }

  detachSession(sessionId) {
    this.streams.unwatch(sessionId);
    const s = this.summarizers.get(sessionId);
    s?.flush();
    this.summarizers.delete(sessionId);
  }

  // ---------- 天枢 → QQ ----------

  onTianshuEvent(sessionId, ev) {
    if (!ev || typeof ev.type !== 'string') return;

    // 分支问答：天枢用 ask_user_question 抛选项，必须推到 QQ 并记住待答
    if (ev.type === 'user_question') {
      this.handleUserQuestion(sessionId, ev.data).catch((err) => this.log(`处理提问失败：${err.message}`));
      return;
    }

    // 审批类事件：记下来，供 /approve /deny 使用
    if (/approv|permission|confirm/i.test(ev.type)) {
      const d = ev.data ?? {};
      const id = d.id ?? d.approvalId ?? d.requestId;
      if (id) {
        this.approvals.set(sessionId, { id, title: d.title ?? d.reason ?? d.name ?? ev.type, at: Date.now() });
        for (const chatKey of this.store.chatsFor(sessionId)) {
          if (!this.store.isPushEnabled(chatKey)) continue;
          this.reply(chatKey, `⚠ 待审批：${String(d.title ?? d.reason ?? '').slice(0, 120)}\n发 /approve 或 /deny`).catch(() => {});
        }
      }
    }

    const summarizer = this.summarizers.get(sessionId);
    summarizer?.handle(ev);
  }

  /**
   * 把一段文本推给所有在看这个会话的聊天。
   * 每段发出后把 QQ 的 message_id 记进索引——用户引用它回复时才能路由回这个会话。
   */
  async broadcast(sessionId, text) {
    const chatKeys = this.pushTargets(sessionId);
    if (chatKeys.length === 0) return;
    const label = await this.sessionLabel(sessionId);
    const stamp = `[${label}] `;

    // 先切段：文本段走文本（可复制、可搜索），只有 mermaid 这类
    // 文本表达不了的内容才渲染成图。段序 = 发送顺序，必须严格保持。
    const segs = splitForDelivery(text);

    for (const chatKey of chatKeys) {
      if (!this.store.isPushEnabled(chatKey)) continue;
      // 逐段串行：await 上一条发完再发下一条，顺序才不会被渲染耗时打乱
      for (const seg of segs) {
        try {
          if (seg.kind === 'mermaid') {
            await this.sendMermaidSegment(chatKey, sessionId, seg.code, label);
          } else {
            for (const chunk of splitChunks(seg.text, this.config.push?.maxChars ?? 900)) {
              const res = await this.onebot.sendText(chatKey, stamp + chunk);
              for (const id of res?.messageIds ?? []) this.store.indexMessage(id, sessionId);
            }
          }
        } catch (err) {
          this.log(`推送到 ${chatKey} 失败：${err.message}`);
        }
      }
    }
  }

  /** 发一段 mermaid 图；渲染失败就退化成源码文本，不让内容丢失。 */
  async sendMermaidSegment(chatKey, sessionId, code, label) {
    let image = null;
    try {
      image = await this.renderToPng(mermaidToMarkdown(code), label);
    } catch (err) {
      this.log(`  渲染 mermaid 失败：${err.message}`);
    }
    if (image) {
      const res = await this.onebot.sendImage(chatKey, image);
      for (const id of res?.messageIds ?? []) this.store.indexMessage(id, sessionId);
      return;
    }
    this.log('  ⚠ mermaid 未能成图，改发源码');
    const res = await this.onebot.sendText(chatKey, mermaidToFallbackText(code));
    for (const id of res?.messageIds ?? []) this.store.indexMessage(id, sessionId);
  }

  /**
   * Markdown → PNG。只给「必须画图」的内容用（目前只有 mermaid 流程图）。
   * 代码块、表格、标题都走文本，不再渲染。
   * @returns {Promise<Buffer|null>} null 表示「按文本发」
   */
  async renderToPng(md, label) {
    if (!this.renderer?.available) return null;
    if (!needsImage(md)) return null;
    try {
      const t0 = Date.now();
      const body = markdownToHtml(md);
      // 只有真含 mermaid 图时才内联 2.5MB 的 mermaid.js
      const needsMermaid = body.includes('class="mermaid');
      const html = wrapDocument(body, {
        title: label,
        width: this.renderer.width,
        dark: this.renderer.dark,
        mermaidScript: needsMermaid ? this.renderer.mermaidScript() : null,
      });
      const png = await this.renderer.screenshotHtml(html);
      this.log(`  渲染成图：${(png.length / 1024).toFixed(0)}KB / ${Date.now() - t0}ms`);
      return png;
    } catch (err) {
      this.log(`  ⚠ 渲染失败，退回文本：${err.message}`);
      return null;
    }
  }

  /**
   * 推送送达范围：显式绑定/关注的聊天；若没有，则发给所有已知聊天
   * （这就是「哪个会话有消息就转发到 QQ」——不需要事先一个个 /use）。
   */
  pushTargets(sessionId) {
    const explicit = this.store.chatsFor(sessionId);
    if (explicit.length > 0) return explicit;
    if (this.config.push?.autoForward === false) return [];
    return this.store.knownChats();
  }

  /** 会话的可读标签：项目目录名|短 id，缓存避免反复打天枢。 */
  async sessionLabel(sessionId) {
    if (!this._labels) this._labels = new Map();
    const hit = this._labels.get(sessionId);
    if (hit) return hit;
    let label = sessionId.slice(-8);
    try {
      const s = await this.call((c) => c.getSession(sessionId));
      const base = String(s.cwd ?? '').split(/[\\/]+/).filter(Boolean).pop();
      if (base) label = `${base}|${sessionId.slice(-4)}`;
    } catch { /* 拿不到就退回短 id */ }
    this._labels.set(sessionId, label);
    return label;
  }

  /** 用户引用的那条消息属于哪个会话；不认识就返回 null，由调用方回退。 */
  resolveReplyTarget(messageId) {
    if (messageId == null) return null;
    return this.store.sessionForMessage(messageId);
  }

  async reply(chatKey, text) {
    try {
      await this.onebot.sendText(chatKey, text);
    } catch (err) {
      this.log(`回复 ${chatKey} 失败：${err.message}`);
    }
  }

  /**
   * 把消息里的图片转成天枢要的 data URL。
   * 不抛错：一张图坏了不能连累整条指令，只在回执里提示。
   */
  async resolveImages(msg) {
    const segs = collectImageSegments(msg.messageSegments, msg.raw);
    if (segs.length === 0) return [];
    const { images, errors } = await resolveImageSources(segs, {
      allowUrl: this.config.push?.imageUrlFallback !== false,
      cacheDirs: this.config.push?.imageCacheDirs ?? [],
      httpGet: this._httpGet,
    });
    if (errors.length) {
      this.log(`  ⚠ 图片处理问题：${errors.join('；')}`);
      this._lastImageErrors = errors;
    }
    if (images.length) this.log(`  附件：${images.length} 张图片已转为 data URL`);
    return images;
  }

  pendingApproval(sessionId) {
    const a = this.approvals.get(sessionId);
    if (!a) return null;
    if (Date.now() - a.at > 10 * 60 * 1000) return null;   // 10 分钟前的审批视为过期
    return a;
  }

  /**
   * 把天枢的分支问答推给 QQ，并记住「在等这个聊天回答」。
   * 回答走下一条普通消息（编号或文字），由 onOneBotEvent 识别。
   */
  async handleUserQuestion(sessionId, data) {
    const text = formatQuestion(data);
    // 这道题可能要等用户，暂不交付已攒的正文（避免答案还没给就先把话说死）
    this.summarizers.get(sessionId)?.flush();

    const targets = this.pushTargets(sessionId);
    const label = await this.sessionLabel(sessionId);
    for (const chatKey of targets) {
      this.store.setPendingQuestion(chatKey, {
        sessionId,
        toolUseId: data?.toolUseId ?? null,
        questions: data?.questions ?? [],
        askAt: Date.now(),
      });
      if (!this.store.isPushEnabled(chatKey)) continue;
      try {
        const res = await this.onebot.sendText(chatKey, `[${label}] ❓ 需要你选一下：

${text}`);
        for (const id of res?.messageIds ?? []) this.store.indexMessage(id, sessionId);
      } catch (err) {
        this.log(`推送提问到 ${chatKey} 失败：${err.message}`);
      }
    }
    this.log(`  → 分支问答已推送（${data?.questions?.length ?? 0} 题）`);
  }

  /**
   * 如果这个聊天正在等一个分支问答的回答，就把这条消息当答案送给天枢。
   * @returns {Promise<boolean>} 是否已作为答案处理
   */
  async tryAnswerQuestion(msg) {
    const pending = this.store.pendingQuestion(msg.chatKey);
    if (!pending) return false;
    // 超过 30 分钟视为过期，别拿旧问题套新消息
    if (Date.now() - (pending.askAt ?? 0) > 30 * 60 * 1000) {
      this.store.clearPendingQuestion(msg.chatKey);
      return false;
    }
    const q = pending.questions?.[0];
    if (!q) {
      this.store.clearPendingQuestion(msg.chatKey);
      return false;
    }

    const answer = parseAnswer(msg.text, q);
    const resolved = resolveChoice(answer, q);
    if (!resolved || !String(resolved).trim()) return false;

    this.store.clearPendingQuestion(msg.chatKey);
    try {
      const receipt = await dispatchText(this, msg.chatKey, resolved, { sessionId: pending.sessionId });
      const label = await this.sessionLabel(pending.sessionId);
      this.log(`  → 回答分支问答：${JSON.stringify(resolved).slice(0, 40)}（${receipt}）`);
      await this.reply(msg.chatKey, `[${label}] 已选：${resolved}`);
      return true;
    } catch (err) {
      // 送不出去就把提问放回去，免得用户白选一次
      this.store.setPendingQuestion(msg.chatKey, pending);
      this.log(`回答分支问答失败：${err.message}`);
      await this.reply(msg.chatKey, `提交选择失败：${err.message}`);
      return true;
    }
  }

  // ---------- QQ → 天枢 ----------

  async onOneBotEvent(event) {
    if (event?.post_type === 'meta_event') return;         // 心跳

    const msg = normalizeIncoming(event);
    if (!msg) return;
    if (msg.selfId != null && String(msg.userId) === String(msg.selfId)) return;  // 自己发的

    const denial = this.checkAcl(msg);
    if (denial) {
      // 不给未授权方任何回复：避免暴露「这台机器上有个能操作命令的机器人」。
      this.log(`拒绝 ${msg.chatKey}（${msg.senderName}）：${denial}`);
      return;
    }

    this.store.touchChat(msg.chatKey);   // 记住这个聊天，「有消息就转发」要用

    // 图片/附件：QQ 图片段 → data URL（本地文件优先，URL 兜底）
    const images = await this.resolveImages(msg);

    // 只发图片、不配文字时 text 是空的。发给天枢前补一句中性的说明，
    // 否则 prompt 为空，模型不知道要它看什么。用户配了文字就原样用。
    const text = msg.text.trim()
      ? msg.text
      : (images.length ? '看这张图。' : '');

    const brief = msg.text.slice(0, 80).replace(/\n/g, ' ');
    const imgNote = images.length ? ` [${images.length}张图]` : '';
    this.log(`收到 ${msg.chatKey}（${msg.senderName}）${msg.replyTo ? `[引用 ${msg.replyTo}]` : ''}${imgNote}：${brief || '(仅图片)'}`);

    // 有待答的分支问答时，这条消息优先当答案处理（除非显式是指令）
    if (!/^[/#]/.test(msg.text)) {
      const answered = await this.tryAnswerQuestion(msg);
      if (answered) return;
    }

    // 引用路由优先：引用哪条推送，就是在回答产生那条推送的会话
    if (msg.replyTo) {
      const target = this.resolveReplyTarget(msg.replyTo);
      if (target) {
        if (!this.streams.isWatching(target)) {
          const s = await this.call((c) => c.getSession(target)).catch(() => null);
          await this.attachSession(target, { fromLatest: true, lastSeq: s?.lastSeq ?? 0 }).catch(() => {});
        }
        const receipt = await dispatchText(this, msg.chatKey, text, { sessionId: target, images });
        const label = await this.sessionLabel(target);
        this.log(`  → 引用路由到 ${label}：${receipt}`);
        await this.reply(msg.chatKey, `[${label}] ${receipt}`);
        return;
      }
      this.log(`  ⚠ 引用的消息 id=${msg.replyTo} 不在索引里（可能已裁剪或来自别的客户端），回退到默认会话`);
    }

    const handled = await handleCommand(this, msg);
    if (handled) {
      this.log(`  → 指令已处理：${msg.text.split(/\s+/)[0]}`);
      return;
    }

    const receipt = await dispatchText(this, msg.chatKey, text, { images });
    this.log(`  → 转发到会话：${receipt}`);
    await this.reply(msg.chatKey, receipt);
  }

  /**
   * 白名单校验。空配置 = 拒绝一切（fail-closed）。
   *
   * 为什么是 fail-closed：这个桥等于把本机的命令执行权限挂在 QQ 上。
   * 之前空名单时只警告一次然后放行，任何人加到这个 QQ 就能操纵机器——
   * 对个人自用没问题，但这个项目会被别人 clone 走，
   * 一个忘了填白名单的新用户就等于开了后门。宁可默认不可用。
   */
  checkAcl(msg) {
    const { allowUsers = [], allowGroups = [] } = this.config.qq ?? {};
    const users = allowUsers.map(String);
    const groups = allowGroups.map(String);

    if (users.length === 0 && groups.length === 0) {
      if (!this.config._aclWarned) {
        this.config._aclWarned = true;
        this.log('✗ qq.allowUsers / qq.allowGroups 都是空的 → 拒绝所有消息（fail-closed）。');
        this.log('  在 bridge.config.json 里填上你的 QQ 号才能用。这是唯一防止陌生人操纵你机器的屏障。');
      }
      return '桥还没配置白名单（qq.allowUsers / qq.allowGroups），已拒绝所有消息';
    }

    if (msg.chatType === 'private') {
      return users.includes(String(msg.userId)) ? null : '你的 QQ 号不在白名单';
    }
    // 群聊：群在白名单内，且必须 @机器人 或以 / # 开头，避免群里闲聊触发
    if (!groups.includes(String(msg.chatId))) return '这个群不在白名单';
    const mentioned = String(msg.raw ?? '').includes(`[CQ:at,qq=${this.onebot.selfId}]`);
    if (!mentioned && !/^[/#]/.test(msg.text)) return '群里请 @我 或使用 / 指令';
    return null;
  }
}

export { HELP_TEXT };

/** 有这些语法才值得渲染成图；纯文本走文本消息更轻。 */
/**
 * 这段内容是否必须画图。
 *
 * 只有 mermaid 这种「文本没法表达」的东西才返回 true。
 * 代码块、表格、标题一律走文本——QQ 里能长按复制、能搜索，
 * 比截图有用得多（用户明确要求：能用文本的全用文本）。
 */
export function needsImage(text) {
  const s = String(text ?? '');
  return /^\s*```+\s*mermaid\s*$/im.test(s);
}
