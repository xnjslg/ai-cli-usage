// 在独立的 agy-auth 登录目录完成 Google 授权，仅把成功获得的账号导入本机账号库。
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const binDir = join(homedir(), '.local/bin');
const authBin = join(binDir, 'agy-auth');
const env = { ...process.env, AGY_AUTH_STORAGE: 'file', AGY_AUTH_NO_UPDATE_CHECK: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
const loginLifetime = 10 * 60_000;
const sessions = new Map();

function failure(status, message) {
  return Object.assign(new Error(message), {status});
}

function current(id) {
  const session = sessions.get(id);
  if (!session) throw failure(410, '这次授权已结束，请重新添加账号。');
  return session;
}

async function cleanup(session) {
  clearTimeout(session.timer);
  session.phase = 'closed';
  sessions.delete(session.id);
  if (session.child) {
    session.child.kill();
    await session.exit;
  }
  if (session.directory) await rm(session.directory, {recursive: true, force: true});
}

function authorizationLink(output) {
  const match = output.match(/(?:^|\n)(https:\/\/accounts\.google\.com\/[^\s]+)\r?\n/);
  if (!match) return;
  const url = new URL(match[1]);
  if (url.origin === 'https://accounts.google.com' && url.searchParams.get('code_challenge_method') === 'S256'
      && url.searchParams.get('redirect_uri') === 'https://antigravity.google/oauth-callback') {
    return url.href;
  }
  throw failure(502, 'agy-auth 返回了无法识别的 Google 授权链接。');
}

async function open(session) {
  try {
    session.directory = await mkdtemp(join(tmpdir(), 'ai-cli-login-'));
    const dir = session.directory;
    session.token = join(dir, 'cli', 'antigravity-oauth-token');
    const nativeAgy = env.AGY_AUTH_AGY_PATH || join(binDir, 'agy');
    const child = spawn(authBin, ['login', '--no-browser', '--agy', nativeAgy, '--json'], {
      cwd: dir, stdio: ['pipe', 'ignore', 'pipe'], env: {
        ...env, AGY_AUTH_HOME: join(dir, 'registry'), AGY_AUTH_AGY_TOKEN_FILE: session.token,
        AGY_AUTH_DESKTOP_TOKEN_FILE: join(dir, 'desktop', 'token'), AGY_DESKTOP_HOME: join(dir, 'desktop-home'),
        AGY_DESKTOP_DATA_DIR: join(dir, 'desktop-data'), AGY_DESKTOP_BIN: join(dir, 'desktop-bin'),
      },
    });
    session.child = child;
    // 子进程异常或授权码提交期间提前退出，都通过 close 处理；不记录授权输出。
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    session.exit = new Promise(resolve => child.once('close', code => resolve(code)));
    const url = await new Promise((resolve, reject) => {
      const startupError = () => reject(failure(502, '无法启动 Google 授权，请检查本机 agy 安装并重试。'));
      session.timer = setTimeout(startupError, 20_000);
      session.exit.then(startupError);
      let buffer = '';
      child.stderr.setEncoding('utf8');
      function read(chunk) {
        buffer += chunk;
        if (buffer.length > 32_768) return startupError();
        try {
          const url = authorizationLink(buffer);
          if (url) {
            child.stderr.off('data', read);
            child.stderr.resume();
            resolve(url);
          }
        } catch { startupError(); }
      }
      child.stderr.on('data', read);
    });
    clearTimeout(session.timer);
    session.phase = 'waiting';
    session.timer = setTimeout(() => { void cleanup(session); }, loginLifetime);
    session.timer.unref();
    session.exit.then(() => {
      if (session.phase === 'waiting') void cleanup(session);
    });
    return {id: session.id, url, expiresAt: new Date(Date.now() + loginLifetime).toISOString()};
  } catch (error) {
    await cleanup(session);
    throw error.status ? error : failure(502, '无法创建登录会话，请重新添加账号。');
  }
}

export function startLogin() {
  if (sessions.size >= 4) throw failure(409, '已有多个账号正在授权，请先完成或关闭已打开的授权窗口。');
  const session = {id: randomUUID(), phase: 'opening'};
  sessions.set(session.id, session);
  return open(session);
}

export async function finishLogin(id, code) {
  const session = current(id);
  if (session.phase !== 'waiting') throw failure(409, '授权正在处理，请稍后刷新账号列表。');
  if (typeof code !== 'string' || !code.trim() || code.length > 4096 || /[\p{Cc}]/u.test(code.trim())) {
    throw failure(400, '请粘贴 Google 授权完成后显示的一次性授权码。');
  }
  session.phase = 'submitting';
  clearTimeout(session.timer);
  session.timer = setTimeout(() => session.child.kill(), 70_000);
  try {
    session.child.stdin.end(code.trim() + '\n');
    if (await session.exit !== 0) throw failure(502, 'Google 授权未完成，请重新添加账号并使用新的授权码。');
    const {stdout} = await run(authBin, ['import', session.token, '--json'], {
      env, timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout).data;
    if (result?.imported?.length !== 1 || result.activated !== false) throw new Error();
    return {ok: true};
  } catch (error) {
    throw error.status ? error : failure(502, '授权已结束，导入结果未确认，请刷新账号列表后重试。');
  } finally {
    await cleanup(session);
  }
}

export async function cancelLogin(id) {
  const session = current(id);
  if (session.phase !== 'waiting') throw failure(409, '授权正在处理，请稍后刷新账号列表。');
  await cleanup(session);
  return {ok: true};
}
