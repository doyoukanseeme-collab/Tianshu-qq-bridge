// QQ 侧指令路由。
// 约定：以 / 或 # 开头的是控制指令；其它文本一律当作给天枢的话，
// 自动判断「新起一轮（prompt）」还是「运行中插话（steer）」。
import { TianshuError } from './tianshu.js';

const STATUS_ICON = {
  running: '▶',
  idle: '⏸',
  completed: '✓',
  interrupted: '⚠',
  archived: '📦',
  error: '✗',
};

const MAX_LIST = 12;

function icon(status) {
  return STATUS_ICON[status] ?? '·';
}

function shortId(id) {
  return String(id ?? '').slice(-8);
}

function clip(text, max = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function baseName(p) {
  if (!p) return '(未知目录)';
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

export const HELP_TEXT = [
  '天枢 QQ 桥 —— 指令表',
  '',
  '/list          列出最近的会话（编号可直接用）',
  '/use <编号>    设定默认会话（不引用时发这里）',
  '/watch <编号>  关注一个会话，它的动静都会推到 QQ',
  '/watch all     关注所有未归档会话（多开并行）',
  '/unwatch <编号|all>  取消关注',
  '/watch         看当前关注了哪些',
  '/unbind        解除默认会话',
  '/status        当前绑定会话的状态',
  '/tail [n]      最近 n 条事件摘要（默认 8）',
  '/new <目录> <指令>   在指定目录新建会话并开跑',
  '/abort         中止当前会话',
  '/mute /unmute  开关本聊天的进展推送',
  '/approve [总是]    批准最近一次待审批',
  '/deny          拒绝最近一次待审批',
  '/plan on|off   切换计划模式',
  '/help          这张表',
  '',
  '不带斜杠的话会直接发给当前绑定的会话。',
].join('\n');

/**
 * @param {import('./bridge.js').Bridge} bridge
 * @param {{chatKey:string, text:string, chatType:string, chatId:any, userId:any, senderName:string}} incoming
 * @returns {Promise<boolean>} 是否已作为指令处理
 */
export async function handleCommand(bridge, incoming) {
  const { text, chatKey } = incoming;
  const m = text.match(/^[/#](\S+)\s*([\s\S]*)$/);
  if (!m) return false;

  const cmd = m[1].toLowerCase();
  const arg = m[2].trim();

  try {
    switch (cmd) {
      case 'help': case '帮助': case '?':
        await bridge.reply(chatKey, HELP_TEXT);
        return true;

      case 'list': case 'ls': case '列表':
        await cmdList(bridge, chatKey);
        return true;

      case 'use': case 'switch': case '切换':
        await cmdUse(bridge, chatKey, arg);
        return true;

      case 'unbind': case '断开':
        await cmdUnbind(bridge, chatKey);
        return true;

      case 'watch': case '关注':
        await cmdWatch(bridge, chatKey, arg);
        return true;

      case 'unwatch': case '取消关注':
        await cmdUnwatch(bridge, chatKey, arg);
        return true;

      case 'status': case '状态':
        await cmdStatus(bridge, chatKey);
        return true;

      case 'tail': case '回顾':
        await cmdTail(bridge, chatKey, arg);
        return true;

      case 'new': case '新建':
        await cmdNew(bridge, chatKey, arg);
        return true;

      case 'abort': case 'stop': case '中止':
        await cmdAbort(bridge, chatKey);
        return true;

      case 'mute': case '静音':
        bridge.store.setPushEnabled(chatKey, false);
        await bridge.reply(chatKey, '已静音，不再推送进展。/unmute 恢复。');
        return true;

      case 'unmute': case '取消静音':
        bridge.store.setPushEnabled(chatKey, true);
        await bridge.reply(chatKey, '已恢复推送。');
        return true;

      case 'approve': case '允许':
        await cmdApprove(bridge, chatKey, arg, true);
        return true;

      case 'deny': case '拒绝':
        await cmdApprove(bridge, chatKey, arg, false);
        return true;

      case 'plan': case '计划':
        await cmdPlan(bridge, chatKey, arg);
        return true;

      default:
        await bridge.reply(chatKey, `未知指令 /${cmd}，发 /help 看列表。`);
        return true;
    }
  } catch (err) {
    await bridge.reply(chatKey, `指令失败：${err.message}`);
    return true;
  }
}

// ---------- 各指令 ----------

async function cmdList(bridge, chatKey) {
  const sessions = await bridge.call((c) => c.listSessions());
  if (sessions.length === 0) {
    await bridge.reply(chatKey, '天枢里还没有会话。用 /new <目录> <指令> 起一个。');
    return;
  }
  const sorted = sessions
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_LIST);

  bridge.store.setListCache(chatKey, sorted.map((s) => s.id));
  const bound = bridge.store.binding(chatKey);
  const watched = new Set(bridge.store.subscribed(chatKey));

  const lines = sorted.map((s, i) => {
    let mark = ' ';
    if (s.id === bound) mark = '→';
    else if (watched.has(s.id)) mark = '*';
    const title = clip(s.title || s.titleInput || '(无标题)', 24);
    const pending = s.pendingApprovals > 0 ? ` 待审${s.pendingApprovals}` : '';
    return `${mark}${i + 1}. ${icon(s.status)} ${baseName(s.cwd)}｜${title}（${shortId(s.id)}）${pending}`;
  });
  const total = sessions.length > MAX_LIST ? `\n（共 ${sessions.length} 个，只列最近 ${MAX_LIST} 个）` : '';
  await bridge.reply(chatKey, [
    '会话列表（→ 默认会话　* 关注中）：',
    ...lines,
    total,
    '',
    '/use <编号> 设默认　/watch <编号> 加关注　/watch all 全关注',
    '引用任意一条推送再回复，就会精确回给那个会话。',
  ].join('\n'));
}

async function resolveTarget(bridge, chatKey, arg) {
  const cache = bridge.store.listCache(chatKey);
  const sessions = await bridge.call((c) => c.listSessions());

  if (/^\d+$/.test(arg)) {
    const idx = Number(arg) - 1;
    const fromCache = cache[idx];
    if (fromCache && sessions.some((s) => s.id === fromCache)) return fromCache;
    const sorted = sessions.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    if (sorted[idx]) return sorted[idx].id;
    return null;
  }
  const needle = arg.toLowerCase();
  const hit = sessions.find((s) => s.id.toLowerCase() === needle)
    ?? sessions.find((s) => s.id.toLowerCase().endsWith(needle))
    ?? sessions.find((s) => String(s.title ?? '').toLowerCase().includes(needle));
  return hit?.id ?? null;
}

async function cmdUse(bridge, chatKey, arg) {
  if (!arg) {
    await bridge.reply(chatKey, '用法：/use <列表编号 | 会话 id 后 8 位 | 标题片段>');
    return;
  }
  const id = await resolveTarget(bridge, chatKey, arg);
  if (!id) {
    await bridge.reply(chatKey, `没找到匹配「${arg}」的会话，先 /list 看看。`);
    return;
  }
  const session = await bridge.call((c) => c.getSession(id));
  bridge.store.setBinding(chatKey, id);
  await bridge.attachSession(id, { fromLatest: true, lastSeq: session.lastSeq });
  await bridge.reply(
    chatKey,
    `已绑定：${baseName(session.cwd)}｜${clip(session.title ?? '', 30)}\n`
    + `${icon(session.status)} ${session.status}　${shortId(id)}\n`
    + '直接发消息就是给它下指令。',
  );
}

async function cmdUnbind(bridge, chatKey) {
  const bound = bridge.store.binding(chatKey);
  bridge.store.setBinding(chatKey, null);
  await bridge.reply(chatKey, bound ? `已解除绑定（原会话 ${shortId(bound)}）。` : '当前没有绑定。');
}

async function cmdWatch(bridge, chatKey, arg) {
  if (!arg) {
    const list = bridge.store.subscribed(chatKey);
    if (list.length === 0) {
      await bridge.reply(chatKey, '当前没有额外关注。/watch <编号> 加一个，或 /watch all 全关注。');
      return;
    }
    const lines = [];
    for (const id of list) {
      const s = await bridge.call((c) => c.getSession(id)).catch(() => null);
      lines.push(`${icon(s?.status)} ${baseName(s?.cwd)}｜${clip(s?.title ?? '', 20)}（${shortId(id)}）`);
    }
    await bridge.reply(chatKey, `正在关注 ${list.length} 个会话：\n${lines.join('\n')}`);
    return;
  }

  if (/^all$/i.test(arg) || arg === '全部') {
    const sessions = await bridge.call((c) => c.listSessions());
    const active = sessions.filter((s) => s.status !== 'archived');
    for (const s of active) {
      bridge.store.subscribe(chatKey, s.id);
      await bridge.attachSession(s.id, { fromLatest: true, lastSeq: s.lastSeq }).catch(() => {});
    }
    await bridge.reply(chatKey, `已关注 ${active.length} 个会话。它们的动静都会推到这个聊天，引用任意一条回复就能精确回给它。`);
    return;
  }

  const id = await resolveTarget(bridge, chatKey, arg);
  if (!id) {
    await bridge.reply(chatKey, `没找到匹配「${arg}」的会话，先 /list 看看。`);
    return;
  }
  const s = await bridge.call((c) => c.getSession(id)).catch(() => null);
  bridge.store.subscribe(chatKey, id);
  await bridge.attachSession(id, { fromLatest: true, lastSeq: s?.lastSeq ?? 0 }).catch(() => {});
  await bridge.reply(chatKey, `已关注：${baseName(s?.cwd)}（${shortId(id)}）\n它的推送会带 [${await bridge.sessionLabel(id)}] 前缀，引用那条回复就能回给它。`);
}

async function cmdUnwatch(bridge, chatKey, arg) {
  if (!arg) {
    await bridge.reply(chatKey, '用法：/unwatch <编号|all>');
    return;
  }
  if (/^all$/i.test(arg) || arg === '全部') {
    const list = bridge.store.subscribed(chatKey);
    for (const id of list) bridge.store.unsubscribe(chatKey, id);
    await bridge.reply(chatKey, `已取消全部关注（${list.length} 个）。`);
    return;
  }
  const id = await resolveTarget(bridge, chatKey, arg);
  if (!id) {
    await bridge.reply(chatKey, `没找到匹配「${arg}」的会话。`);
    return;
  }
  bridge.store.unsubscribe(chatKey, id);
  await bridge.reply(chatKey, `已取消关注 ${shortId(id)}。`);
}

async function cmdStatus(bridge, chatKey) {
  const id = bridge.store.binding(chatKey);
  if (!id) {
    await bridge.reply(chatKey, '当前没绑定会话。/list 选一个。');
    return;
  }
  const s = await bridge.call((c) => c.getSession(id));
  const budget = s.contextBudget;
  const used = budget?.inputTokens != null && budget?.inputBudget
    ? `${Math.round((budget.inputTokens / budget.inputBudget) * 100)}%`
    : '—';
  const lines = [
    `${icon(s.status)} ${s.status}　${baseName(s.cwd)}`,
    `标题：${clip(s.title || s.titleInput || '(无)', 40)}`,
    `模型：${s.model ?? '—'}　努力：${s.reasoningEffort ?? '—'}`,
    `上下文：${used}　游标：${s.lastSeq}　待审批：${s.pendingApprovals ?? 0}`,
    `id：${s.id}`,
  ];
  await bridge.reply(chatKey, lines.join('\n'));
}

async function cmdTail(bridge, chatKey, arg) {
  const id = bridge.store.binding(chatKey);
  if (!id) {
    await bridge.reply(chatKey, '当前没绑定会话。');
    return;
  }
  const n = Math.min(Math.max(Number(arg) || 8, 1), 30);
  const session = await bridge.call((c) => c.getSession(id));
  const events = await bridge.call((c) => c.fetchEvents(id, Math.max(0, (session.lastSeq ?? 0) - 400)));
  const picked = [];
  for (const ev of events) {
    const line = renderEventLine(ev);
    if (line) picked.push(line);
  }
  const tail = picked.slice(-n);
  await bridge.reply(chatKey, tail.length ? `最近 ${tail.length} 条：\n${tail.join('\n')}` : '还没有可回顾的内容。');
}

function renderEventLine(ev) {
  const d = ev?.data ?? {};
  switch (ev.type) {
    case 'user':
      return `· 你：${clip(d.text, 80)}`;
    case 'tool_use':
      return `· ▸ ${d.name ?? 'tool'}：${clip(d.input?.command ?? d.input?.file_path ?? '', 70)}`;
    case 'tool_result':
      return d.isError ? `· ✗ ${d.name ?? 'tool'} 失败` : null;
    case 'turn_complete':
      return `· ✓ 回合结束（out ${d.usage?.output_tokens ?? '?'}）`;
    case 'status':
      return d.status && d.status !== 'running' ? `· ● ${d.status}` : null;
    default:
      return null;
  }
}

async function cmdNew(bridge, chatKey, arg) {
  if (!arg) {
    await bridge.reply(chatKey, '用法：/new <项目目录> <给它的话>');
    return;
  }
  const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) {
    await bridge.reply(chatKey, '要同时给出目录和指令，例如：\n/new D:\\proj 修一下登录报错');
    return;
  }
  const [, cwd, prompt] = m;
  const session = await bridge.call((c) => c.createSession({ prompt, cwd }));
  bridge.store.setBinding(chatKey, session.id);
  await bridge.attachSession(session.id, { fromLatest: true, lastSeq: session.lastSeq });
  await bridge.reply(chatKey, `已新建并开跑：${baseName(cwd)}｜${clip(prompt, 40)}\n${shortId(session.id)}`);
}

async function cmdAbort(bridge, chatKey) {
  const id = bridge.store.binding(chatKey);
  if (!id) {
    await bridge.reply(chatKey, '当前没绑定会话。');
    return;
  }
  await bridge.call((c) => c.abortSession(id));
  await bridge.reply(chatKey, '已发送中止。');
}

async function cmdApprove(bridge, chatKey, arg, approve) {
  const id = bridge.store.binding(chatKey);
  if (!id) {
    await bridge.reply(chatKey, '当前没绑定会话。');
    return;
  }
  const pending = bridge.pendingApproval(id);
  if (!pending) {
    await bridge.reply(chatKey, '没有待审批项（或桥接器还没收到审批事件）。');
    return;
  }
  const remember = /总是|always|记住/.test(arg);
  try {
    await bridge.call((c) => c.answerApproval(id, pending.id, approve ? 'approve' : 'deny', remember));
    await bridge.reply(chatKey, `${approve ? '已批准' : '已拒绝'}${remember ? '（并记住）' : ''}：${clip(pending.title ?? pending.id, 60)}`);
  } catch (err) {
    if (err instanceof TianshuError && err.status === 404) {
      await bridge.reply(chatKey, '这个审批已失效（可能已自动处理）。');
      return;
    }
    throw err;
  }
}

async function cmdPlan(bridge, chatKey, arg) {
  const id = bridge.store.binding(chatKey);
  if (!id) {
    await bridge.reply(chatKey, '当前没绑定会话。');
    return;
  }
  const state = /^(on|开|true|1)$/i.test(arg) ? true : /^(off|关|false|0)$/i.test(arg) ? false : null;
  if (state === null) {
    await bridge.reply(chatKey, '用法：/plan on 或 /plan off');
    return;
  }
  await bridge.call((c) => c.setPlanMode(id, state));
  await bridge.reply(chatKey, `计划模式已${state ? '开启' : '关闭'}。`);
}

/**
 * 自然语言 → 会话。running 走 steer，idle 走 prompt；steer 报 idle 时自动回退。
 * sessionId 显式给出时优先于绑定（引用回复就是靠这个精确落到目标会话）。
 * images 为天枢接受的 data URL 数组，随指令一起送过去。
 * @returns {Promise<string>} 给用户的简短回执
 */
export async function dispatchText(bridge, chatKey, text, { sessionId = null, images = null } = {}) {
  const id = sessionId ?? bridge.store.binding(chatKey);
  if (!id) {
    return '还没绑定会话。先 /list 选一个，或用 /new <目录> <指令> 起一个新的。';
  }
  let session;
  try {
    session = await bridge.call((c) => c.getSession(id));
  } catch (err) {
    if (err instanceof TianshuError && (err.status === 404 || err.status === 400)) {
      if (!sessionId) bridge.store.setBinding(chatKey, null);   // 只清默认绑定，不动别人的关注
      return '原会话已不存在，绑定已清除。请重新 /list 选择。';
    }
    throw err;
  }

  // 发指令前确保这个会话在被追踪，否则它跑起来的事件流收不到、QQ 端看不到进展
  if (bridge.streams && !bridge.streams.isWatching(id)) {
    await bridge.attachSession(id, { fromLatest: true, lastSeq: session.lastSeq ?? 0 }).catch(() => {});
  }

  const note = images?.length ? `（含 ${images.length} 张图片）` : '';

  if (session.status === 'running') {
    try {
      await bridge.call((c) => c.steerSession(id, text, images));
      return `已插话到运行中的会话${note}。`;
    } catch (err) {
      if (err instanceof TianshuError && err.code === 'idle') {
        await bridge.call((c) => c.sendPrompt(id, text, images));
        return `会话刚转为空闲，已改为新起一轮${note}。`;
      }
      throw err;
    }
  }
  await bridge.call((c) => c.sendPrompt(id, text, images));
  return `已发送${note}。`;
}
