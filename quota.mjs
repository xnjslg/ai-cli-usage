// 读取本机 Codex 和 agy 的订阅额度，只向网页返回账号标识、剩余量和重置时间。
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { readAgyNativeQuota } from './agy-native-quota.mjs';

const run = promisify(execFile);
const agyBin = join(homedir(), '.local/bin/agy-auth');
const agyEnv = { ...process.env, AGY_AUTH_NO_UPDATE_CHECK: '1', AGY_AUTH_STORAGE: 'file' };

function percent(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function isoDate(value) {
  if (value == null || value === '') return null;
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function codexWindowLabel(minutes, fallback) {
  if (minutes === 10080) return '每周';
  if (!(minutes > 0)) return fallback;
  if (minutes % 1440 === 0) return minutes / 1440 + ' 天';
  if (minutes % 60 === 0) return minutes / 60 + ' 小时';
  return minutes + ' 分钟';
}

function codexAccount(result) {
  const legacy = result.rateLimits;
  const limits = new Map(Object.entries(result.rateLimitsByLimitId ?? {}));
  if (legacy && !limits.has(legacy.limitId || 'codex')) {
    limits.set(legacy.limitId || 'codex', legacy);
  }
  const account = { id: 'current', active: true, plan: null, groups: [], updatedAt: new Date().toISOString() };
  for (const [id, limit] of limits) {
    if (!limit) continue;
    const windows = [];
    for (const [key, label] of [['primary', '主要时段'], ['secondary', '次要时段']]) {
      const window = limit[key];
      if (!window) continue;
      const used = percent(window.usedPercent);
      windows.push({
        label: codexWindowLabel(window.windowDurationMins, label),
        remainingPercent: used === null ? null : 100 - used,
        resetAt: isoDate(window.resetsAt),
      });
    }
    if (limit.individualLimit) {
      windows.push({ label: '个人消费额度', remainingPercent: percent(limit.individualLimit.remainingPercent),
        resetAt: isoDate(limit.individualLimit.resetsAt) });
    }
    if (windows.length) account.groups.push({ name: limit.limitName || (id === 'codex' ? 'Codex' : id), windows });
    account.plan ??= limit.planType ?? null;
    if (!account.credits && limit.credits && (limit.credits.unlimited || limit.credits.balance != null)) {
      account.credits = { unlimited: Boolean(limit.credits.unlimited), balance: limit.credits.balance ?? null };
    }
  }
  return account;
}

function readCodexRpc(directory) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: directory, env: { ...process.env, CODEX_HOME: directory }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: child.stdout });
    let result;
    let failure = 'Codex 未返回额度，请检查登录状态及网络连接。';
    const timeout = setTimeout(() => {
      failure = 'Codex 额度查询超时。';
      child.kill();
    }, 25000);
    child.on('error', () => { failure = '无法启动 Codex，请检查 WSL 中的 Codex CLI 安装。'; });
    child.stdin.on('error', () => {}); // 提前退出时由 close 统一处理。
    child.once('close', () => {
      clearTimeout(timeout);
      lines.close();
      if (result) resolveResult(result);
      else reject(new Error(failure));
    });
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const end = () => child.stdin.end();
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error) {
        const detail = String(message.error.message ?? '');
        if (/401|unauthori[sz]ed|authentication|not (authenticated|logged in)|api.key/i.test(detail)) {
          failure = '当前 Codex 登录方式无法读取订阅额度，请检查 ChatGPT 账号登录状态。';
        } else if (/403|forbidden/i.test(detail)) {
          failure = 'Codex 拒绝了当前账号的额度查询（403）。';
        }
        return end();
      }
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
      } else {
        result = message.result;
        end();
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'ai-cli-usage', version: '1.0.0' }, capabilities: {},
    } });
  });
}

async function codexQuota() {
  const original = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const directory = await mkdtemp(join(tmpdir(), 'ai-cli-codex-quota-'));
  try {
    // app-server 需要写入自身的 SQLite 和运行状态。正式服务中的原账号目录只读。
    for (const name of ['auth.json', 'accounts', 'config.toml']) {
      await symlink(join(original, name), join(directory, name));
    }
    return { accounts: [codexAccount(await readCodexRpc(directory))] };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const agyErrors = {
  auth: 'agy 账号登录已失效，请重新授权。',
  credential_error: 'agy 无法读取账号登录信息，请检查授权状态。',
  missing_auth: 'agy 账号缺少登录信息。',
  refresh_failed: 'agy 无法刷新账号授权，请重新登录。',
  forbidden: 'Google 拒绝了此账号的额度查询（403）。',
  unsupported: 'Google 未向此账号提供额度查询。',
  timeout: 'agy 额度查询超时。',
  network: '无法连接 Google 额度服务。',
  invalid_response: 'Google 返回了无法识别的额度数据。',
};

function agyError(code) {
  if (agyErrors[code]) return agyErrors[code];
  const status = /^http_(\d{3})$/.exec(code ?? '');
  return status ? 'Google 额度服务返回 HTTP ' + status[1] + '。' : '未能读取 agy 额度，请稍后刷新。';
}

async function agy(args) {
  try {
    const { stdout } = await run(agyBin, [...args, '--json'], { env: agyEnv, timeout: 36000, maxBuffer: 4 * 1024 * 1024 });
    const data = JSON.parse(stdout).data;
    if (!data) throw new Error();
    return data;
  } catch (error) {
    let code = error.killed ? 'timeout' : null;
    try {
      const failure = JSON.parse(error.stdout).error;
      code = /\(([a-z_0-9]+)\)$/.exec(failure.message)?.[1] || failure.code;
    } catch { /* 命令本身不可用时只返回通用提示。 */ }
    throw new Error(agyError(code));
  }
}

function agySummary(row) {
  const groups = new Map();
  for (const [key, label] of [['five_hour', '5 小时'], ['weekly', '每周']]) {
    const bucket = row.usage?.[key];
    if (!bucket) continue;
    const name = bucket.group || '订阅额度';
    if (!groups.has(name)) groups.set(name, { name, windows: [] });
    groups.get(name).windows.push({ label, remainingPercent: percent(bucket.remaining_percent), resetAt: isoDate(bucket.resets_at) });
  }
  const account = { id: row.id ?? null, email: row.email ?? '', active: Boolean(row.active),
    plan: row.plan || null, groups: [...groups.values()] };
  if (row.usage?.updated_at) account.updatedAt = isoDate(row.usage.updated_at);
  if (row.usage?.stale) account.stale = true;
  if (row.usage_error) account.error = agyError(row.usage_error);
  return account;
}

function agyGroups(data) {
  return (data?.groups ?? []).map(group => ({
    name: group.name || '订阅额度',
    windows: (group.buckets ?? []).map(bucket => {
      const window = String(bucket.window ?? '').toLowerCase();
      let label = bucket.name || bucket.window || bucket.id || '额度';
      if (['5h', '5-hour', 'five_hour', 'five-hour'].includes(window)) label = '5 小时';
      if (['week', 'weekly'].includes(window)) label = '每周';
      const fraction = percent(bucket.remaining_fraction * 100);
      return { label, remainingPercent: typeof bucket.remaining_fraction === 'number' && fraction !== null
        ? fraction : percent(bucket.remaining_percent), resetAt: isoDate(bucket.reset_time) };
    }),
  })).filter(group => group.windows.length);
}

function mergeAgyDetail(account, detail) {
  const groups = agyGroups(detail);
  if (groups.length) {
    account.groups = groups;
    account.updatedAt = isoDate(detail.updated_at);
    delete account.error;
    delete account.stale;
  } else if (detail?.usage_error && !account.groups.length) {
    account.error = agyError(detail.usage_error);
  }
}

// 原生 CLI 读取成功后按账号保留短期快照，供查询失败时显示上次可核实的时间。
const recentAgy = new Map();
const nativePending = new Map();
const nativeSlots = [Promise.resolve(), Promise.resolve()];

function queryNativeQuota(key, account) {
  if (nativePending.has(key)) return nativePending.get(key);
  // 所有 HTTP 请求共用两个串行队列，切换账号期间也只会同时启动两个原生 CLI。
  const ready = nativeSlots.shift();
  const pending = ready.then(() => readAgyNativeQuota(account)).finally(() => nativePending.delete(key));
  nativeSlots.push(pending.catch(() => {}));
  nativePending.set(key, pending);
  return pending;
}

async function supplementAgyAccount(row, account) {
  const key = JSON.stringify([account.id, account.email]);
  const cached = recentAgy.get(key);
  let snapshot = cached?.data;
  let stale = false;
  if (!cached || Date.now() - cached.time >= 30_000) {
    const identity = { id: account.id, email: account.email, stored: !!row.stored, active: account.active };
    const fresh = await queryNativeQuota(key, identity).catch(() => null);
    if (fresh?.email && fresh.email.toLowerCase() === account.email.toLowerCase()
      && (fresh.groups?.length || fresh.credits) && isoDate(fresh.updatedAt)) {
      snapshot = fresh;
      recentAgy.set(key, { data: fresh, time: Date.now() });
    } else {
      stale = true;
    }
  }
  if (!snapshot) return;
  account.groups = snapshot.groups ?? [];
  if (snapshot.plan) account.plan = snapshot.plan;
  if (snapshot.credits) account.credits = snapshot.credits;
  account.updatedAt = snapshot.updatedAt;
  account.stale = stale || !!snapshot.stale;
  if (!stale) delete account.error;
}

async function readMissingAgyQuotas(rows, accounts) {
  const pending = rows.map((row, index) => ({ row, account: accounts[index] }))
    .filter(({ account }) => !account.groups.length || account.stale);
  if (!pending.length) return;
  const now = Date.now();
  for (const [key, snapshot] of recentAgy) {
    if (now - snapshot.time >= 6 * 3600_000) recentAgy.delete(key);
  }
  await Promise.all(pending.map(({ row, account }) => supplementAgyAccount(row, account)));
}

async function agyQuota() {
  const list = await agy(['list', '--no-sync']);
  const rows = [...list.accounts];
  if (list.current && !list.current.stored) rows.unshift(list.current);
  const accounts = rows.map(agySummary);
  // 汇总和分组共用 Google quota summary 接口。接口已拒绝时保留每个账号的具体原因。
  const fetchStored = rows.some(row => row.stored && !row.usage_error);
  const fetchLive = list.current && (!list.current.stored || ['auth', 'refresh_failed'].includes(list.current.usage_error));
  const [stored, live] = await Promise.allSettled([
    fetchStored ? agy(['usage', '--all']) : null,
    fetchLive ? agy(['usage']) : null,
  ]);
  const byId = new Map((stored.value?.accounts ?? []).map(row => [row.id, row]));
  for (const account of accounts) {
    if (byId.has(account.id)) mergeAgyDetail(account, byId.get(account.id));
    if (account.active && live.value && (account.email ? account.email === live.value.email : account.id && account.id === live.value.account?.id)) {
      mergeAgyDetail(account, live.value);
    }
    if (account.active && live.status === 'rejected' && !account.groups.length) account.error ??= live.reason.message;
    if (!account.groups.length && !account.error && stored.status === 'rejected') account.error = stored.reason.message;
  }
  await readMissingAgyQuotas(rows, accounts);
  return { accounts };
}

export async function getQuota(source) {
  if (source === 'codex') return codexQuota();
  if (source === 'agy') return agyQuota();
  throw new Error('请选择 Codex 或 agy。');
}
