#!/usr/bin/env node
/**
 * 通用启动入口 —— 所有平台同一命令：node start.js
 *
 * 自动读取 ~/.redmine-cli.yaml 里的 server 和 api_key（存在且未设环境变量时），
 * 然后启动 server.js。平台专属的 .command / .bat / .sh 都只是本命令的双击包装。
 *
 * 用法：
 *   node start.js
 *   REDMINE_URL=https://xxx REDMINE_API_KEY=xxx node start.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 从 redmine CLI 配置自动补凭据（环境变量优先）
const cfgPath = path.join(os.homedir(), '.redmine-cli.yaml');
if (fs.existsSync(cfgPath)) {
  const text = fs.readFileSync(cfgPath, 'utf8');
  const pick = (key) => {
    const m = text.match(new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  if (!process.env.REDMINE_URL) process.env.REDMINE_URL = pick('server');
  if (!process.env.REDMINE_API_KEY) process.env.REDMINE_API_KEY = pick('api_key');
}

if (!process.env.PORT) process.env.PORT = '7788';

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  stdio: 'inherit',
  env: process.env,
});
child.on('close', (code) => process.exit(code == null ? 0 : code));
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => child.kill(sig));
});
