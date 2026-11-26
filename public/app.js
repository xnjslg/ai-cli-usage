// 渲染本地模型用量和逐日趋势，将账号操作提交给同源服务。
'use strict';

const byId = (id) => document.getElementById(id);
const sourceNames = { codex: 'Codex', agy: 'agy' };
const numbers = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const axisNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4,
});
const periodButtons = [...document.querySelectorAll('[data-period]')];
const sourceButtons = [...document.querySelectorAll('[data-source]')];
const modelColors = new Map();
const palette = ['#44699b', '#358277', '#8a74a6', '#b27c4c', '#5d8ba4', '#ac6f78', '#78855d', '#63748b', '#9e8150', '#786b98', '#4e888c', '#a7705e'];
let selectedSource = new URLSearchParams(location.search).get('source') === 'agy' ? 'agy' : 'codex';
let currentReport;
let inspectedDate;
let period = 'week';
let customRange;
let reportRange;
let usageVersion = 0;
let accountsVersion = 0;
let accountBusy = false;
let currentQuotaVersion = 0;
let loginSession = null;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function usd(value) {
  if (!Number.isFinite(value)) return '未定价';
  if (value > 0 && value < 0.0001) return '< $0.0001';
  return dollars.format(value);
}

function status(id, message = '', error = false) {
  byId(id).textContent = message;
  byId(id).classList.toggle('problem', error);
}

async function request(url, data) {
  const options = { cache: 'no-store' };
  if (data !== undefined) {
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(data);
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('无法连接本地服务，请刷新重试。');
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('本地服务返回了无法读取的结果，请刷新重试。');
  }
  if (!response.ok) {
    const error = new Error(result.error || '请求失败，请重试。');
    error.status = response.status;
    throw error;
  }
  return result;
}

function modelColor(name) {
  if (!modelColors.has(name)) {
    const index = modelColors.size;
    modelColors.set(name, palette[index] ?? `hsl(${(index * 137.508) % 360} 32% 44%)`);
  }
  return modelColors.get(name);
}

function modelKey(name) {
  const label = element('span', name, 'model-key');
  label.style.setProperty('--model-color', modelColor(name));
  return label;
}

function renderModelRows(models) {
  const body = byId('model-rows');
  body.replaceChildren();
  if (!models.length) {
    const row = element('tr');
    const note = element('td', '本期没有用量记录', 'empty');
    note.colSpan = 6;
    row.append(note);
    body.append(row);
  }
  for (const model of models) {
    const row = element('tr');
    const name = element('td', undefined, 'model');
    name.append(modelKey(model.name));
    const expand = element('button', undefined, 'expand-model');
    expand.type = 'button';
    expand.setAttribute('aria-label', model.name + ' 的输入和输出明细');
    expand.setAttribute('aria-expanded', 'false');
    name.append(expand);
    row.append(name, element('td', numbers.format(model.total), 'token-total'), element('td', usd(model.cost)));
    const extra = element('tr', undefined, 'model-extra');
    extra.hidden = true;
    const cell = element('td');
    cell.colSpan = 3;
    const values = element('dl');
    for (const [field, label] of [['input','非缓存输入'], ['cached','缓存读取'], ['output','输出']]) {
      const value = numbers.format(model[field]);
      row.append(element('td', value, 'token-part'));
      const pair = element('div');
      pair.append(element('dt', label), element('dd', value));
      values.append(pair);
    }
    cell.append(values);
    extra.append(cell);
    expand.addEventListener('click', () => {
      extra.hidden = !extra.hidden;
      expand.setAttribute('aria-expanded', String(!extra.hidden));
    });
    body.append(row, extra);
  }
}

function chartDates(since, until) {
  const end = new Date(until + 'T00:00:00Z');
  const lastMonth = new Date(end);
  lastMonth.setUTCDate(lastMonth.getUTCDate() - 30);
  const cursor = new Date(Math.max(Date.parse(since + 'T00:00:00Z'), lastMonth.getTime()));
  const dates = [];
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function renderTrend(days, models, dates) {
  const chart = byId('days');
  const detail = byId('day-detail');
  chart.replaceChildren();
  detail.textContent = '';
  const byDate = new Map(days.map(day => [day.date, day]));
  const visibleDays = dates.map(date => byDate.get(date)).filter(Boolean);
  const names = new Set(visibleDays.flatMap(day => day.models.filter(model => model.total > 0).map(model => model.name)));
  const series = models.map(model => model.name).filter(name => names.has(name));
  byId('legend').replaceChildren(...series.map(modelKey));
  const empty = !visibleDays.some(day => day.total > 0);
  byId('trend-empty').hidden = !empty;
  chart.closest('.plot').hidden = empty;
  detail.closest('.chart-inspector').hidden = empty;
  if (empty) return;
  const peak = Math.max(1, ...visibleDays.map(day => day.total));
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const maximum = Math.ceil(peak / magnitude) * magnitude;
  byId('axis-high').textContent = axisNumber.format(maximum);
  byId('axis-mid').textContent = axisNumber.format(maximum / 2);
  const preferredDay = dates.includes(inspectedDate) ? inspectedDate : (dates.findLast(date => byDate.get(date)?.total > 0) ?? dates.at(-1));
  const dayButtons = [];
  let selectedIndex;
  function selectDay(index, interactive = false) {
    const previous = dayButtons[selectedIndex];
    if (previous) {
      previous.setAttribute('aria-pressed', 'false');
      previous.tabIndex = -1;
    }
    selectedIndex = index;
    const button = dayButtons[index];
    const date = dates[index];
    button.setAttribute('aria-pressed', 'true');
    button.tabIndex = 0;
    if (interactive) inspectedDate = date;
    const record = byDate.get(date);
    byId('day-date').textContent = date;
    byId('day-total').textContent = numbers.format(record?.total ?? 0) + ' Token';
    const used = (record?.models ?? []).filter(model => model.total > 0).sort((a, b) => b.total - a.total);
    detail.replaceChildren(...used.map(model => {
      const item = element('li');
      item.append(modelKey(model.name), element('strong', numbers.format(model.total)));
      return item;
    }));
    if (!used.length) detail.append(element('li', '当天没有用量记录。', 'fine'));
    const scroll = byId('chart-scroll');
    const offset = button.getBoundingClientRect().left - scroll.getBoundingClientRect().left;
    if (offset < 0) scroll.scrollLeft += offset;
    else if (offset + button.offsetWidth > scroll.clientWidth) scroll.scrollLeft += offset + button.offsetWidth - scroll.clientWidth;
  }
  for (const [index, date] of dates.entries()) {
    const day = element('button', undefined, 'day');
    day.type = 'button';
    day.tabIndex = -1;
    day.setAttribute('aria-pressed', 'false');
    const bars = element('span', undefined, 'bars');
    const record = byDate.get(date);
    const totals = new Map(record?.models.map(model => [model.name, model.total]));
    const descriptions = [date, '合计 ' + numbers.format(record?.total ?? 0) + ' Token'];
    for (const name of series) {
      const total = totals.get(name);
      if (!total) continue;
      descriptions.push(name + ' ' + numbers.format(total));
      const bar = element('span', undefined, 'bar');
      bar.style.backgroundColor = modelColor(name);
      bar.style.height = total * 100 / maximum + '%';
      bars.append(bar);
    }
    const caption = descriptions.join(' · ');
    day.setAttribute('aria-label', caption);
    day.title = caption;
    const tick = dates.length <= 10 ? date.slice(5).replace('-', '/') :
      (index % 5 === 0 || index === dates.length - 1 ? date.slice(-2) : ' ');
    day.append(bars, element('span', tick, 'tick'));
    day.addEventListener('click', () => selectDay(index, true));
    day.addEventListener('keydown', event => {
      const target = {ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: dates.length - 1}[event.key];
      if (target === undefined) return;
      event.preventDefault();
      if (dayButtons[target]) {
        selectDay(target, true);
        dayButtons[target].focus({preventScroll: true});
      }
    });
    dayButtons.push(day);
  }
  chart.append(...dayButtons);
  selectDay(dates.indexOf(preferredDay));
}

function renderUsage(report) {
  reportRange = { since: report.since, until: report.until };
  byId('date-range').textContent = report.since + ' 至 ' + report.until + ' · ' + report.timezone;
  const source = report.sources.find(item => item.id === selectedSource);
  if (!source || source.error) {
    byId('usage-content').hidden = true;
    status('usage-status', sourceNames[selectedSource] + ' · ' + (source?.error || '无法读取所选来源。'), true);
    return;
  }
  const models = [...source.models].sort((a, b) => b.total - a.total);
  const priced = models.filter((model) => Number.isFinite(model.cost));
  byId('total-label').textContent = sourceNames[selectedSource] + ' Token 合计';
  byId('cost-label').textContent = sourceNames[selectedSource] + ' API 等价费用' + (priced.length < models.length ? '（已计价部分）' : '');
  byId('total-tokens').textContent = numbers.format(source.days.reduce((sum, day) => sum + day.total, 0));
  byId('total-cost').textContent = models.length && !priced.length ? '未定价' : usd(priced.reduce((sum, m) => sum + m.cost, 0));
  byId('codex-analytics').hidden = selectedSource !== 'codex';
  renderModelRows(models);
  const dates = chartDates(report.since, report.until);
  const rangeNote = byId('trend-range');
  rangeNote.hidden = !dates.length || dates[0] === report.since;
  rangeNote.textContent = rangeNote.hidden ? '' : '趋势显示 ' + dates[0] + ' 至 ' + report.until + '，模型明细覆盖全部所选日期。';
  byId('usage-content').hidden = false;
  renderTrend(source.days, models, dates);
  byId('usage-warnings').textContent = source.warnings.join('\n');
  status('usage-status');
}

async function loadUsage(refresh = false) {
  const version = ++usageVersion;
  if (!refresh) {
    currentReport = undefined;
    byId('usage-content').hidden = true;
    byId('date-range').textContent = '';
  }
  byId('usage-content').setAttribute('aria-busy', 'true');
  status('usage-status', refresh ? '正在刷新用量…' : '正在读取用量…');
  byId('usage-refresh').disabled = true;
  try {
    const query = new URLSearchParams({ period, ...(period === 'custom' ? customRange : {}) });
    const result = await request('/api/usage?' + query);
    if (version === usageVersion) {
      currentReport = result;
      const models = result.sources.flatMap(source => source.models);
      for (const model of models.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))) modelColor(model.name);
      renderUsage(result);
    }
  } catch (error) {
    if (version === usageVersion) status('usage-status', error.message, true);
  } finally {
    if (version === usageVersion) {
      byId('usage-refresh').disabled = false;
      byId('usage-content').setAttribute('aria-busy', 'false');
    }
  }
}

const quotaDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const quotaPercent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

function quotaTime(value) {
  if (!value) return '';
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? '' : quotaDate.format(timestamp);
}

function quotaMessage(target, message) {
  target.replaceChildren(element('p', message, 'quota-note'));
}

function showQuota(target, account, showIdentity = false) {
  target.replaceChildren();
  const info = [showIdentity ? account.email : '', account.plan].filter(Boolean);
  if (account.stale) info.push('缓存数据');
  const updated = quotaTime(account.updatedAt);
  if (updated) info.push('更新于 ' + updated + '（北京时间）');
  if (info.length) target.append(element('p', info.join(' · '), 'quota-note'));
  const groups = element('div', undefined, 'quota-groups');
  for (const group of account.groups ?? []) {
    if (!group.windows?.length) continue;
    const box = element('section', undefined, 'quota-group');
    box.append(element('h3', group.name || '订阅额度'));
    for (const window of group.windows) {
      const line = element('div', undefined, 'quota-window');
      const percent = window.remainingPercent;
      const hasPercent = Number.isFinite(percent) && percent >= 0 && percent <= 100;
      let remaining = '未提供';
      if (hasPercent) remaining = quotaPercent.format(percent) + '%';
      else if (Number.isFinite(window.remainingAmount) && window.remainingAmount >= 0) remaining = '剩余 ' + window.remainingAmount;
      line.append(element('span', window.label), element('strong', remaining));
      box.append(line);
      if (hasPercent) {
        const meter = element('meter');
        meter.min = 0;
        meter.max = 100;
        meter.value = percent;
        meter.setAttribute('aria-label', (group.name || '订阅') + ' ' + window.label + '剩余');
        box.append(meter);
      }
      const reset = quotaTime(window.resetAt);
      if (reset) box.append(element('small', reset + ' 重置（北京时间）', 'quota-reset'));
    }
    groups.append(box);
  }
  if (groups.childElementCount) target.append(groups);
  const credits = account.credits;
  const balance = credits?.unlimited ? '不限额' : credits?.balance;
  const hasBalance = balance != null && balance !== '';
  if (hasBalance) target.append(element('p', 'Credits 余额 · ' + balance, 'quota-note'));
  if (account.error || (!groups.childElementCount && !hasBalance)) {
    target.append(element('p', account.error || '服务端暂无额度信息。', 'quota-note'));
  }
}

async function loadCurrentQuota() {
  const version = ++currentQuotaVersion;
  const source = selectedSource;
  const target = byId('current-quota-body');
  byId('current-quota-title').textContent = sourceNames[source] + ' 当前账号剩余额度';
  quotaMessage(target, '正在读取额度…');
  try {
    const data = await request('/api/quota?source=' + source);
    if (version !== currentQuotaVersion) return;
    const active = data.accounts.find(account => account.active);
    if (active) showQuota(target, active, true);
    else quotaMessage(target, '当前没有已登录账号。');
  } catch (error) {
    if (version === currentQuotaVersion) quotaMessage(target, error.message);
  }
}

async function loadAccountQuotas(mounts) {
  if (!mounts.length) return;
  try {
    const data = await request('/api/quota?source=agy');
    for (const {account, target} of mounts) {
      if (!target.isConnected) continue;
      const quota = data.accounts.find(item => account.id ? item.id === account.id
        : item.active && (!account.email || !item.email || item.email === account.email));
      if (quota) showQuota(target, quota);
      else quotaMessage(target, '此账号暂无额度信息。');
    }
  } catch (error) {
    for (const {target} of mounts) if (target.isConnected) quotaMessage(target, error.message);
  }
}

function editAlias(account, actions, editButton) {
  const form = element('form', undefined, 'account-editor');
  const input = element('input');
  input.id = 'alias-' + account.id;
  input.name = 'alias';
  input.maxLength = 64;
  input.placeholder = '留空显示邮箱';
  input.value = account.alias;
  const label = element('label', '账号别名');
  label.htmlFor = input.id;
  const feedback = element('p', undefined, 'alias-error');
  feedback.id = input.id + '-error';
  feedback.setAttribute('role', 'alert');
  input.setAttribute('aria-describedby', feedback.id);
  input.addEventListener('input', () => { feedback.textContent = ''; });
  const controls = element('div', undefined, 'form-row');
  const save = element('button', '保存修改', 'primary');
  save.type = 'submit';
  const cancel = element('button', '取消', 'outline');
  cancel.type = 'button';
  function cancelEdit() {
    form.remove();
    actions.hidden = false;
    editButton.focus();
  }
  cancel.addEventListener('click', cancelEdit);
  form.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && !accountBusy) {
      event.preventDefault();
      cancelEdit();
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    feedback.textContent = '';
    const error = await mutateAccount('alias', { id: account.id, alias: input.value.trim() });
    if (error) {
      feedback.textContent = error;
      input.focus();
    } else {
      byId(editButton.id)?.focus();
    }
  });
  controls.append(input, save, cancel);
  form.append(label, controls, feedback);
  actions.after(form);
  actions.hidden = true;
  input.focus();
}

function renderAccounts(accounts) {
  const list = byId('account-list');
  const mounts = [];
  list.replaceChildren();
  if (!accounts.some(account => account.active)) {
    const message = accounts.length
      ? '当前 agy 尚未登录。可切换到下方账号，或添加新账号。'
      : '还没有 agy 账号。点击“添加账号”开始 Google 授权。';
    list.append(element('li', message, 'account empty'));
  }
  for (const account of accounts) {
    const row = element('li', undefined, 'account');
    const identity = element('div');
    identity.append(element('strong', account.alias || account.email || account.id || '当前 agy 登录'));
    if (account.alias && account.email) identity.append(element('small', account.email));
    row.append(identity);
    const actions = element('div', undefined, 'account-actions');
    if (account.active || !account.stored) {
      actions.append(element('span', account.active ? (account.stored ? '当前账号' : '当前账号 · 待保存') : '待保存', 'account-state'));
      if (account.active && !account.stored) {
        const save = element('button', '保存账号', 'primary');
        save.id = 'save-account';
        save.type = 'button';
        save.addEventListener('click', () => mutateAccount('save', {}));
        actions.append(save);
      }
    } else {
      const button = element('button', '切换到此账号', 'outline');
      button.type = 'button';
      button.setAttribute('aria-label', '切换到 ' + (account.alias || account.email || account.id));
      button.addEventListener('click', () => mutateAccount('switch', { id: account.id }));
      actions.append(button);
    }
    if (account.stored) {
      const edit = element('button', '修改别名', 'outline');
      edit.id = 'edit-' + account.id;
      edit.type = 'button';
      edit.setAttribute('aria-label', '修改 ' + (account.email || account.id) + ' 的别名');
      edit.addEventListener('click', () => editAlias(account, actions, edit));
      actions.append(edit);
    }
    const quotas = element('div', undefined, 'account-quota');
    quotas.setAttribute('aria-label', '账号剩余额度');
    quotaMessage(quotas, '正在读取剩余额度…');
    mounts.push({account, target: quotas});
    row.append(actions, quotas);
    list.append(row);
  }
  return mounts;
}

function disableAccountControls(disabled) {
  for (const control of byId('accounts').querySelectorAll('button, input')) control.disabled = disabled;
}

async function loadAccounts(message = '') {
  const version = ++accountsVersion;
  status('accounts-status', '正在读取账号…');
  try {
    const data = await request('/api/accounts');
    if (version !== accountsVersion) return;
    const mounts = renderAccounts(data.accounts);
    status('accounts-status', message);
    void loadAccountQuotas(mounts);
  } catch (error) {
    if (version !== accountsVersion) return;
    byId('account-list').replaceChildren();
    status('accounts-status', [message, error.message].filter(Boolean).join(' '), true);
  }
}

async function mutateAccount(action, data) {
  if (accountBusy) return;
  accountBusy = true;
  ++accountsVersion;
  disableAccountControls(true);
  const messages = {
    save: ['正在保存账号…', '已保存当前账号。'],
    switch: ['正在切换账号…', '已切换账号。重新打开 agy 会话后生效。'],
    alias: ['正在修改别名…', '已更新账号别名。'],
  };
  status('accounts-status', messages[action][0]);
  try {
    const result = await request('/api/accounts/' + action, data);
    if (result.ok !== true) throw new Error('服务未确认操作结果，请刷新账号列表。');
    await loadAccounts(messages[action][1]);
  } catch (error) {
    if (action === 'alias') {
      status('accounts-status');
      return error.message;
    }
    status('accounts-status', error.message, true);
  } finally {
    accountBusy = false;
    disableAccountControls(false);
  }
}

function clearLoginFields() {
  byId('login-code').value = '';
  byId('login-link').removeAttribute('href');
  byId('login-fields').hidden = true;
  byId('login-finish').hidden = true;
}

function abandonLogin(id) {
  if (!id) return;
  // 离开页面时也通知后端销毁尚未使用的授权会话。
  void fetch('/api/accounts/login/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }), keepalive: true,
  }).catch(() => {});
}

function closeLogin() {
  if (loginSession && !loginSession.submitting) abandonLogin(loginSession.id);
  loginSession = null;
  clearLoginFields();
  byId('login-dialog').close();
}

function loginError(message) {
  loginSession = null;
  clearLoginFields();
  byId('login-retry').hidden = false;
  byId('login-cancel').disabled = false;
  status('login-status', message, true);
  byId('login-retry').focus();
}

async function startLogin() {
  if (loginSession || accountBusy) return;
  const session = { id: null, submitting: false };
  loginSession = session;
  const dialog = byId('login-dialog');
  if (!dialog.open) dialog.showModal();
  clearLoginFields();
  byId('login-retry').hidden = true;
  byId('login-cancel').disabled = false;
  status('login-status', '正在准备 Google 授权…');
  try {
    const result = await request('/api/accounts/login/start', {});
    session.id = result.id;
    if (session !== loginSession) { abandonLogin(session.id); return; }
    const url = URL.canParse(result.url) ? new URL(result.url) : null;
    if (!session.id || url?.origin !== 'https://accounts.google.com' || url.username || url.password) {
      throw new Error('本地服务未返回有效的 Google 授权链接。');
    }
    byId('login-link').href = url.href;
    byId('login-fields').hidden = false;
    byId('login-finish').hidden = false;
    byId('login-finish').disabled = false;
    byId('login-code').disabled = false;
    const expires = quotaTime(result.expiresAt);
    status('login-status', expires ? '授权截止 ' + expires + '（北京时间）' : '');
    byId('login-link').focus();
  } catch (error) {
    if (session === loginSession) {
      abandonLogin(session.id);
      loginError(error.message);
    }
  }
}

async function finishLogin(event) {
  event.preventDefault();
  const session = loginSession;
  if (!session?.id || session.submitting) return;
  const input = byId('login-code');
  const code = input.value.trim();
  if (!code) {
    status('login-status', '请粘贴 Google 返回的一次性授权码。', true);
    input.focus();
    return;
  }
  session.submitting = true;
  input.value = '';
  input.disabled = true;
  byId('login-finish').disabled = true;
  byId('login-cancel').disabled = true;
  status('login-status', '正在验证授权码并保存账号…');
  try {
    const result = await request('/api/accounts/login/finish', {id: session.id, code});
    if (result.ok !== true) throw new Error('未收到保存结果，请刷新列表检查账号。');
    if (session !== loginSession) return;
    closeLogin();
    await loadAccounts('已保存账号。需要使用时点击“切换到此账号”。');
  } catch (error) {
    if (session !== loginSession) return;
    session.submitting = false;
    if ([400, 409, 413].includes(error.status)) {
      input.value = code;
      input.disabled = false;
      byId('login-finish').disabled = false;
      byId('login-cancel').disabled = false;
      status('login-status', error.message, true);
      input.focus();
    } else {
      abandonLogin(session.id);
      loginError(error.message);
    }
  }
}

function navigate() {
  const showAccounts = location.hash === '#accounts';
  if (!showAccounts && byId('login-dialog').open) closeLogin();
  byId('accounts').hidden = !showAccounts;
  byId('usage').hidden = showAccounts;
  const current = byId(showAccounts ? 'accounts-tab' : 'usage-tab');
  const other = byId(showAccounts ? 'usage-tab' : 'accounts-tab');
  current.setAttribute('aria-current', 'page');
  other.removeAttribute('aria-current');
  if (showAccounts && !accountBusy) loadAccounts();
  if (!showAccounts) {
    loadCurrentQuota();
    if (usageVersion === 0) loadUsage();
  }
}

function showDateForm(open) {
  byId('date-form').hidden = !open;
  byId('custom-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    const range = customRange || reportRange;
    if (range) {
      byId('since').value = range.since;
      byId('until').value = range.until;
    }
    byId('until').setCustomValidity('');
    byId('since').focus();
  }
}

function setPeriod(next) {
  period = next;
  for (const item of periodButtons) item.setAttribute('aria-pressed', String(item.dataset.period === next));
  loadUsage();
}

for (const button of sourceButtons) {
  button.setAttribute('aria-pressed', String(button.dataset.source === selectedSource));
  button.addEventListener('click', () => {
    if (selectedSource === button.dataset.source) return;
    selectedSource = button.dataset.source;
    const url = new URL(location.href);
    url.searchParams.set('source', selectedSource);
    history.replaceState(null, '', url);
    for (const item of sourceButtons) item.setAttribute('aria-pressed', String(item === button));
    if (currentReport) renderUsage(currentReport);
    loadCurrentQuota();
  });
}
for (const button of periodButtons) {
  button.addEventListener('click', () => {
    if (button.dataset.period === 'custom') {
      showDateForm(byId('date-form').hidden);
      return;
    }
    showDateForm(false);
    if (period !== button.dataset.period) setPeriod(button.dataset.period);
  });
}
byId('date-form').addEventListener('input', () => byId('until').setCustomValidity(''));
byId('date-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const since = byId('since').value;
  const until = byId('until').value;
  if (since > until) {
    byId('until').setCustomValidity('结束日期须与开始日期相同或更晚。');
    byId('until').reportValidity();
    return;
  }
  customRange = { since, until };
  setPeriod('custom');
});
byId('usage-refresh').addEventListener('click', () => { loadUsage(true); loadCurrentQuota(); });
byId('accounts-refresh').addEventListener('click', () => loadAccounts());
byId('add-account').addEventListener('click', startLogin);
byId('login-retry').addEventListener('click', startLogin);
byId('login-cancel').addEventListener('click', closeLogin);
byId('login-form').addEventListener('submit', finishLogin);
byId('login-dialog').addEventListener('cancel', event => {
  event.preventDefault();
  if (!loginSession?.submitting) closeLogin();
});
window.addEventListener('pagehide', () => { if (byId('login-dialog').open) closeLogin(); });
window.addEventListener('hashchange', navigate);
navigate();
