// 读取 ccusage 的原生报表，按上海日期汇总模型 Token 和 API 等价美元费用。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const ccusage = join(homedir(), '.local/bin/ccusage');
const timezone = 'Asia/Shanghai';
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' });
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const iso = date => date.toISOString().slice(0, 10);
const dayMs = 86_400_000;

export function periodRange(params, now = new Date()) {
  const today = calendar.format(now);
  const timestamp = Date.parse(today + 'T00:00:00Z');
  const weekday = (new Date(timestamp).getUTCDay() + 6) % 7;
  const monday = timestamp - weekday * dayMs;
  let since = today;
  let until = today;
  switch (params.get('period') ?? 'week') {
    case 'today': break;
    case 'week': since = iso(new Date(monday)); break;
    case 'last-week':
      since = iso(new Date(monday - 7 * dayMs));
      until = iso(new Date(monday - dayMs));
      break;
    case 'month': since = today.slice(0, 8) + '01'; break;
    case 'custom':
      since = params.get('since');
      until = params.get('until');
      if (![since, until].every(validDate) || since > until || until > today) {
        throw new RangeError('请选择有效的历史起止日期。');
      }
      break;
    default: throw new RangeError('无法识别所选时间范围。');
  }
  return { since, until, timezone };
}

function validDate(value) {
  if (!datePattern.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.valueOf()) && iso(date) === value;
}

function reportCommand(prefix, { since, until }, format) {
  const args = [...prefix, 'daily', '--breakdown', '--mode', 'calculate', '--offline',
    '--timezone', timezone, '--since', since, '--until', until, ...format];
  return run(ccusage, args, {
    timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ANTIGRAVITY_DATA_DIR: join(homedir(), '.gemini/antigravity-cli/conversations'),
      CCUSAGE_TELEMETRY_DISABLED: '1', NO_COLOR: '1', COLUMNS: '400', RAYON_NUM_THREADS: '4' },
  });
}

const componentTotal = row => row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens;
const fingerprint = row => [row.inputTokens, row.outputTokens, row.cacheCreationTokens, row.cacheReadTokens].join('/');

// 20.1.2 的 agy JSON 省略模型级额外 Token，原生明细表保留该列。按日期和四项计数核对后取值。
function agyModelTotals(table) {
  const counts = new Map();
  let date = '';
  for (const line of table.split('\n')) {
    if (!line.startsWith('│')) continue;
    const cells = line.split('│').slice(1, -1).map(s => s.trim());
    if (datePattern.test(cells[0])) date = cells[0];
    if (!date || !cells[0]?.startsWith('└─') || cells.length !== 8) continue;
    const fields = cells.slice(2, 7).map(s => Number(s.replaceAll(',', '')));
    if (!fields.every(Number.isSafeInteger)) continue;
    const key = date + '/' + fields.slice(0, 4).join('/');
    // 若两个模型计数相同但合计不同，只采用能唯一匹配的明细。
    counts.set(key, counts.has(key) && counts.get(key) !== fields[4] ? null : fields[4]);
  }
  return counts;
}

function needsDetails({totalTokens, modelBreakdowns}) {
  return modelBreakdowns.length > 1 && modelBreakdowns.reduce((sum, row) => sum + componentTotal(row), 0) !== totalTokens;
}

async function summarize(id, days, range) {
  const models = new Map();
  const dailyUsage = [];
  const warnings = new Set();
  let detail = new Map();
  if (days.some(needsDetails)) {
    if (id === 'agy') {
      const result = await reportCommand(['antigravity'], range, ['--no-color']);
      detail = agyModelTotals(result.stdout);
    } else {
      const result = await reportCommand(['codex'], range, ['--json']);
      for (const day of JSON.parse(result.stdout).daily) {
        for (const [name, row] of Object.entries(day.models)) detail.set(day.date + '/' + name, row.totalTokens);
      }
    }
  }
  for (const day of days) {
    const breakdown = day.modelBreakdowns;
    const knownTotals = breakdown.map(r => componentTotal(r));
    if (breakdown.length === 1) knownTotals[0] = day.totalTokens;
    if (needsDetails(day)) {
      for (const [i, row] of breakdown.entries()) {
        const key = day.date + '/' + (id === 'agy' ? fingerprint(row) : row.modelName);
        knownTotals[i] = detail.get(key) ?? knownTotals[i];
      }
    }
    const attributed = knownTotals.reduce((a, b) => a + b, 0);
    if (attributed > day.totalTokens) throw new Error('报告读取期间发生变化，请刷新。');
    const dailyModels = breakdown.map((row, index) => ({ name: row.modelName, total: knownTotals[index] }));
    if (attributed < day.totalTokens) {
      const name = '未归属模型的 Token';
      const other = models.get(name) ?? { name, input: 0, output: 0, cached: 0, total: 0, cost: 0 };
      other.total += day.totalTokens - attributed;
      dailyModels.push({ name, total: day.totalTokens - attributed });
      models.set(name, other);
      warnings.add('部分额外 Token 仅有每日合计，已单列为未归属。');
    }
    for (const [i, row] of breakdown.entries()) {
      const name = row.modelName;
      const model = models.get(name) ?? { name, input: 0, cached: 0, output: 0, total: 0, cost: 0 };
      model.input += row.inputTokens;
      model.cached += row.cacheReadTokens;
      model.output += row.outputTokens;
      model.total += knownTotals[i];
      if (row.missingPricing || !Number.isFinite(row.cost)) model.cost = null;
      else if (model.cost !== null) model.cost += row.cost;
      if (row.estimatedPricing) warnings.add(name + ' 使用 ccusage 的参考报价。');
      if (row.cacheCreationTokens || knownTotals[i] !== componentTotal(row)) {
        warnings.add('Token 合计包含记录中的缓存写入或其他额外 Token。');
      }
      models.set(name, model);
    }
    dailyUsage.push({ date: day.date, total: day.totalTokens, models: dailyModels });
  }
  return { id, models: [...models.values()], days: dailyUsage, warnings: [...warnings] };
}

const pending = new Map();
export function usageReport(range) {
  const key = range.since + '/' + range.until;
  if (!pending.has(key)) pending.set(key, loadReport(range).finally(() => pending.delete(key)));
  return pending.get(key);
}

async function loadReport(range) {
  // 统一报表同时输出客户端、模型和逐模型费用。Codex 的专用 JSON 仅提供每日费用。
  const result = await reportCommand([], range, ['--json', '--by-agent']);
  const { daily } = JSON.parse(result.stdout);
  const sources = await Promise.all(['codex', 'agy'].map(async id => {
    const agent = id === 'agy' ? 'antigravity' : 'codex';
    const days = daily.flatMap(row => row.agents.filter(item => item.agent === agent)
      .map(item => ({ ...item, date: row.period })));
    try {
      return await summarize(id, days, range);
    } catch {
      return { id, models: [], days: [], error: '无法核对模型明细，请刷新重试。' };
    }
  }));
  return { ...range, sources };
}
