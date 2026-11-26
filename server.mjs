// 将本机 ccusage 报表和 agy-auth 的 CLI 账号操作提供给同源浏览器。
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { periodRange, usageReport } from './usage.mjs';
import { startLogin, finishLogin, cancelLogin } from './login.mjs';
import { getQuota } from './quota.mjs';

const run = promisify(execFile);
const port = Number(process.env.AI_CLI_USAGE_PORT ?? 8789);
const hosts = new Set(['localhost:' + port, '127.0.0.1:' + port]);
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
]);
let accountBusy = false;
const pendingQuota = new Map();
const accountActions = new Set(['save', 'switch', 'alias', 'login/start', 'login/finish', 'login/cancel']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function agy(args) {
  try {
    const {stdout} = await run(join(homedir(), '.local/bin/agy-auth'), [...args, '--json'], {
      timeout: 20_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, AGY_AUTH_NO_UPDATE_CHECK: '1', AGY_AUTH_STORAGE: 'file' },
    });
    const envelope = JSON.parse(stdout);
    if (envelope.schema_version !== 1 || !envelope.data) throw new Error();
    return envelope.data;
  } catch (err) {
    let code;
    try { code = JSON.parse(err.stdout).error.code; } catch { /* 无结构化错误时显示通用提示。 */ }
    const messages = {
      account_not_found: '找不到这个账号，请刷新账号列表。',
      credential_error: '登录凭据已失效，请在 agy 中重新登录并保存。',
      credential_not_found: '请先在 agy 中登录账号。',
      registry_error: 'agy-auth 无法读取本地账号库，请检查账号存储。',
      backup_error: 'agy-auth 无法备份当前登录，请检查备份目录。',
    };
    throw new HttpError(502, messages[code] ?? 'agy-auth 操作失败，请刷新列表检查当前登录状态。');
  }
}

async function accounts() {
  const data = await agy(['list', '--no-sync', '--no-usage']);
  const rows = [...data.accounts];
  if (data.current && !data.current.stored) rows.unshift(data.current);
  return rows.map(row => ({
    id: row.id ?? null, alias: row.alias ?? '', email: row.email ?? '',
    active: Boolean(row.active), stored: Boolean(row.stored),
  }));
}

async function readBody(req) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 4096) throw new HttpError(413, '提交的数据过长。');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* 请求必须是 JSON 对象。 */ }
  throw new HttpError(400, '需要 JSON 对象。');
}

async function updateAccount(action, body) {
  if (action === 'login/start') return startLogin();
  if (action === 'login/cancel') return cancelLogin(body.id);
  if (accountBusy) throw new HttpError(409, '正在更新账号，请稍后刷新。');
  accountBusy = true;
  try {
    if (action === 'login/finish') return await finishLogin(body.id, body.code);
    const rows = await accounts();
    if (action === 'save') {
      if (!rows.some(row => row.active)) throw new HttpError(409, '请先在 agy 中登录要保存的账号。');
      await agy(['add', '--target=cli']);
    } else {
      if (typeof body.id !== 'string' || !/^acct_[a-zA-Z0-9_-]+$/.test(body.id)) throw new HttpError(400, '请选择已保存的账号。');
      const target = rows.find(row => row.id === body.id && row.stored);
      if (!target) throw new HttpError(404, '该账号已移除，请刷新列表。');
      if (action === 'alias') {
        if (typeof body.alias !== 'string') throw new HttpError(400, '账号别名应为文本。');
        const alias = body.alias.trim();
        if (alias.length > 64 || /[\s\p{Cc}]/u.test(alias) || /^-|^\+?\d+$/.test(alias)) {
          throw new HttpError(400, '别名最长 64 个字符，不能包含空白、仅由数字组成或以短横线开头。');
        }
        if (alias && rows.some(row => row.id !== target.id && row.alias.toLowerCase() === alias.toLowerCase())) {
          throw new HttpError(409, '这个别名已用于其他账号。');
        }
        if (alias !== target.alias) {
          await agy(alias ? ['alias', 'set', target.id, alias] : ['alias', 'clear', target.id]);
        }
      } else if (!target.active) {
        // 切换之前让 agy-auth 同步已保存账号在 CLI 运行期间刷新的凭据。
        await agy(['list', '--no-usage']);
        const result = await agy(['switch', '--target=cli', target.id]);
        if (!result.cli_switched) throw new HttpError(502, 'agy-auth 未确认 CLI 账号切换，请刷新列表。');
      }
    }
    return { ok: true };
  } finally {
    pendingQuota.delete('agy');
    accountBusy = false;
  }
}

async function readQuota(source) {
  if (source !== 'codex' && source !== 'agy') throw new HttpError(400, '请选择 Codex 或 agy。');
  let pending = pendingQuota.get(source);
  if (!pending) {
    pending = getQuota(source);
    pendingQuota.set(source, pending);
  }
  try {
    return await pending;
  } catch (err) {
    throw new HttpError(502, err.message);
  } finally {
    if (pendingQuota.get(source) === pending) pendingQuota.delete(source);
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  try {
    const host = req.headers.host;
    if (!hosts.has(host)) throw new HttpError(403, '请使用本机地址访问。');
    const url = new URL(req.url, 'http://' + host);
    if (req.method === 'GET' && assets.has(url.pathname)) {
      const [file, mime] = assets.get(url.pathname);
      const data = await readFile(new URL('./public/' + file, import.meta.url));
      res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
      return res.end(data);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请在本机网页中操作。');
    if (req.method === 'GET' && url.pathname === '/api/usage') {
      let range;
      try { range = periodRange(url.searchParams); } catch (err) { throw new HttpError(400, err.message); }
      return json(res, 200, await usageReport(range));
    }
    if (req.method === 'GET' && url.pathname === '/api/accounts') return json(res, 200, {accounts: await accounts()});
    if (req.method === 'GET' && url.pathname === '/api/quota') return json(res, 200, await readQuota(url.searchParams.get('source')));
    if (req.method === 'POST' && url.pathname.startsWith('/api/accounts/')) {
      const action = url.pathname.slice('/api/accounts/'.length);
      if (!accountActions.has(action)) throw new HttpError(404, '找不到这个账号操作。');
      if (req.headers.origin !== 'http://' + host) throw new HttpError(403, '请在本机网页中操作。');
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, '请提交 JSON 数据。');
      return json(res, 200, await updateAccount(action, await readBody(req)));
    }
    throw new HttpError(404, '找不到这个入口。');
  } catch (err) {
    if (!res.destroyed) json(res, err.status ?? 500, { error: err.status ? err.message : '读取本地用量失败，请检查 ccusage 或刷新重试。' });
  }
}).listen(port, '127.0.0.1', () => console.log('AI CLI 用量网页监听 http://127.0.0.1:' + port));
