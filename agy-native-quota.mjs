// 使用隔离的官方 agy 状态栏读取指定账号的额度，不向模型发送消息。
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const binDir = join(homedir(), '.local/bin');
const liveDir = join(homedir(), '.gemini/antigravity-cli');
const authEnv = { ...process.env, AGY_AUTH_STORAGE: 'file', AGY_AUTH_NO_UPDATE_CHECK: '1' };
const periodNames = { '5h': '5 小时', weekly: '每周', daily: '每日', monthly: '每月' };
const modelNames = { '3p': 'Claude / GPT', gemini: 'Gemini' };

function accountQuota(data) {
  const groups = new Map();
  for (const [key, bucket] of Object.entries(data.quota || {})) {
    const fraction = bucket?.remaining_fraction;
    const amount = bucket?.remaining_amount;
    if (bucket?.disabled) continue;
    const remainingPercent = Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction * 100 : null;
    const remainingAmount = Number.isFinite(amount) && amount >= 0 ? amount : null;
    if (remainingPercent === null && remainingAmount === null) continue;
    const match = /^(.*)-(5h|weekly|daily|monthly)$/.exec(key);
    const group = match?.[1] || key;
    const name = Object.hasOwn(modelNames, group) ? modelNames[group] : group;
    if (!groups.has(name)) groups.set(name, { name, windows: [] });
    const reset = Date.parse(bucket.reset_time);
    groups.get(name).windows.push({
      label: match ? periodNames[match[2]] : '剩余额度', remainingPercent, remainingAmount,
      resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset).toISOString() : null,
    });
  }
  if (!groups.size) return null;
  return { email: data.email, plan: data.plan_tier || null, groups: [...groups.values()], updatedAt: new Date().toISOString() };
}

async function prepareAccount(row, directory, cliDir) {
  const credential = join(cliDir, 'antigravity-oauth-token');
  let installation = join(liveDir, 'installation_id');
  if (row.stored) {
    if (!row.id || basename(row.id) !== row.id || row.id.startsWith('-')) return false;
    const exported = join(directory, 'export');
    await mkdir(exported, { mode: 0o700 });
    await run(join(binDir, 'agy-auth'), ['export', '--dir', exported, row.id, '--json'], {
      env: authEnv, timeout: 8_000, maxBuffer: 512 * 1024,
    });
    const files = await readdir(exported, { withFileTypes: true });
    if (files.length !== 1 || !files[0].isFile()) return false;
    await rename(join(exported, files[0].name), credential);
    const registry = process.env.AGY_AUTH_HOME || join(homedir(), '.config/agy-auth');
    const savedId = join(registry, 'accounts', row.id + '.installation_id');
    if (existsSync(savedId)) installation = savedId;
  } else if (row.active) {
    await copyFile(process.env.AGY_AUTH_AGY_TOKEN_FILE || join(liveDir, 'antigravity-oauth-token'), credential);
  } else {
    return false;
  }
  try {
    await copyFile(installation, join(cliDir, 'installation_id'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // 首次使用 CLI 时按官方默认方式在临时目录初始化。
  }
  return true;
}

async function readStatus(directory, home, workspace, email) {
  const target = join(directory, 'quota.jsonl');
  const binary = process.env.AGY_AUTH_AGY_PATH || join(binDir, 'agy');
  // CLI 仅在 TTY 下发送状态栏事件。只记录已载入额度后的账号与分组，不保存终端或会话内容。
  const command = `/usr/bin/jq -c 'select(.email and (.quota | length > 0)) | {email, quota, plan_tier}' >> "$AGY_QUOTA_OUTPUT"`;
  const settings = { trustedWorkspaces: [workspace], statusLine: { type: 'command', enabled: true, command } };
  const child = spawn('/usr/bin/script', ['-q', '-e', '-c',
    'stty cols 140 rows 48; exec "$AGY_QUOTA_BIN" --log-file /dev/null --settings "$AGY_QUOTA_SETTINGS"', '/dev/null'], {
    cwd: workspace, stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env, HOME: home, SHELL: '/bin/sh', TERM: 'xterm-256color', XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), XDG_RUNTIME_DIR: join(home, 'run'),
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(home, 'run/bus'), AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      AGY_QUOTA_BIN: binary, AGY_QUOTA_SETTINGS: JSON.stringify(settings), AGY_QUOTA_OUTPUT: target,
    },
  });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  // 只应答光标位置与终端底色查询，无需输入任何提示词或命令。
  child.stdout.on('data', chunk => {
    if (chunk.includes('\x1b[6n')) child.stdin.write('\x1b[1;1R');
    if (chunk.includes('\x1b]11;?')) child.stdin.write('\x1b]11;rgb:0000/0000/0000\x1b\\');
  });
  let closed = false;
  const exit = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  try {
    const deadline = Date.now() + 20_000;
    while (!closed && Date.now() < deadline) {
      await sleep(250);
      let text;
      try { text = await readFile(target, 'utf8'); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const end = text.lastIndexOf('\n');
      if (end < 0) continue;
      const last = text.slice(0, end).trimEnd().split('\n').at(-1);
      if (!last) continue;
      const data = JSON.parse(last);
      if (!data.email) continue;
      if (data.email.toLowerCase() !== email.toLowerCase()) return null;
      const account = accountQuota(data);
      if (account) return account;
    }
    return null;
  } finally {
    child.kill();
    await exit;
  }
}

export async function readAgyNativeQuota(row) {
  if (!row?.email || (!row.stored && !row.active)) return null;
  const directory = await mkdtemp(join(tmpdir(), 'ai-cli-agy-quota-'));
  try {
    const home = join(directory, 'home');
    const workspace = join(directory, 'workspace');
    const cliDir = join(home, '.gemini/antigravity-cli');
    await mkdir(cliDir, { recursive: true, mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    if (!await prepareAccount(row, directory, cliDir)) return null;
    return await readStatus(directory, home, workspace, row.email);
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
