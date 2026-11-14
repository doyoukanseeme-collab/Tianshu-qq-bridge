#!/usr/bin/env node
// 入口：加载配置 → 起桥 → 等信号退出。
import { loadConfig } from './config.js';
import { Bridge } from './bridge.js';

const config = loadConfig(process.argv[2] ?? './bridge.config.json');

const bridge = new Bridge(config);

bridge.log('天枢 ⇄ QQ 桥启动');
bridge.log(`天枢配置：${config.tianshu.serverInfoPath}`);
bridge.log(`OneBot 模式：${config.onebot.mode}${config.onebot.mode === 'forward' ? ` → ${config.onebot.forwardUrl}` : ` → 端口 ${config.onebot.reversePort}`}`);
if ((config.qq.allowUsers ?? []).length === 0 && (config.qq.allowGroups ?? []).length === 0) {
  bridge.log('✗ qq.allowUsers 和 qq.allowGroups 都是空的：桥会拒绝处理所有消息。');
  bridge.log('  在 bridge.config.json 里填上你的 QQ 号才能用（这是防止陌生人操纵你机器的唯一屏障）。');
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  bridge.log(`收到 ${signal}，正在收尾…`);
  try {
    await bridge.stop();
  } catch (err) {
    bridge.log(`收尾失败：${err.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  bridge.log(`未捕获的 rejection：${err?.stack || err}`);
});

await bridge.start();
bridge.log('就绪。在 QQ 里发 /help 试试。');
