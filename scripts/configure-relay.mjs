/**
 * 中转站配置助手。
 *
 * 做三件真实的事，不猜测：
 *   1. 用 .env 里的 BASE_URL + API_KEY 真实请求 {base}/models，列出中转站
 *      实际可用的模型名（很多中转站改写了模型名，不能靠猜）。
 *   2. 把选中的模型登记进本项目的模型库（走 POST /api/models）。
 *   3. 可选：跑一次 3 题的冒烟评测，确认真实调用链路通。
 *
 * 用法：
 *   node scripts/configure-relay.mjs               # 只探测并列出模型
 *   node scripts/configure-relay.mjs --register    # 探测 + 登记全部模型
 *   node scripts/configure-relay.mjs --register --smoke
 *   node scripts/configure-relay.mjs --model gpt-4o-mini --smoke
 *
 * 密钥只从 .env 读取，只发给中转站，不打印、不写库、不进日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_BASE = process.env.MODEL_LAB_API || 'http://127.0.0.1:8790';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
};

// ---- 读取 .env（不引入 dotenv，保持脚本零依赖） -----------------------------

function readEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) {
    console.error('找不到 .env。先执行：copy .env.example .env  然后填入中转站地址和密钥。');
    process.exit(1);
  }
  const values = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

const env = readEnv();
const baseUrl = (env.OPENAI_COMPATIBLE_BASE_URL || '').replace(/\/+$/, '');
const apiKey = env.OPENAI_COMPATIBLE_API_KEY || '';

let problems = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  OK    ${name}`);
  } else {
    problems += 1;
    console.log(`  问题  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('检查 .env\n');
check('OPENAI_COMPATIBLE_BASE_URL 已填写', baseUrl.length > 0);
check('OPENAI_COMPATIBLE_API_KEY 已填写', apiKey.length > 0);
check(
  'BASE_URL 没有误带 /chat/completions',
  !/\/chat\/completions\/?$/.test(baseUrl),
  '代码会自动拼接这个路径，带上会变成双重路径',
);
check(
  'BASE_URL 以 /v1 结尾（多数中转站需要）',
  /\/v1$/.test(baseUrl),
  '若你的中转站不需要 /v1，可忽略；否则请补上',
);
if (baseUrl.startsWith('http://')) {
  check(
    'http 内网地址已设置 ALLOW_LOOPBACK_PROVIDER=true',
    env.ALLOW_LOOPBACK_PROVIDER === 'true' || env.ALLOW_LOOPBACK_PROVIDER === '1',
    'http/内网地址会被 SSRF 防护拦截，需要显式放行',
  );
}
if (problems > 0) {
  console.log('\n先把上面标「问题」的项改好，再运行本脚本。');
  process.exit(1);
}

// ---- 1. 真实探测中转站 ------------------------------------------------------

console.log(`\n向中转站请求 GET ${baseUrl}/models …`);
let remoteModels = [];
try {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`  失败：HTTP ${response.status}`);
    console.error(`  返回：${text.slice(0, 400)}`);
    console.error('\n  401/403 说明密钥不对；404 说明 BASE_URL 路径不对（试试补上或去掉 /v1）。');
    process.exit(1);
  }
  const payload = JSON.parse(text);
  remoteModels = (payload.data ?? payload.models ?? []).map((entry) =>
    typeof entry === 'string' ? entry : entry.id ?? entry.name,
  ).filter(Boolean);
  console.log(`  成功，发现 ${remoteModels.length} 个模型\n`);
  for (const id of remoteModels.slice(0, 60)) console.log(`    ${id}`);
  if (remoteModels.length > 60) console.log(`    … 还有 ${remoteModels.length - 60} 个`);
} catch (err) {
  console.error(`  连接失败：${err.message}`);
  console.error('\n  检查项：BASE_URL 是否正确、机器能否访问该域名、是否需要代理。');
  process.exit(1);
}
if (remoteModels.length === 0) {
  console.warn('  中转站没有返回模型列表。部分中转站不实现 /models，这不影响调用。');
}

// ---- 2. 登记模型 ------------------------------------------------------------

async function apiJson(method, route, body) {
  const response = await fetch(`${API_BASE}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: response.status, body: parsed };
}

const health = await apiJson('GET', '/api/health');
if (health.status !== 200) {
  console.error(`\n无法连接本项目 API（${API_BASE}）。先运行 npm run dev:api。`);
  process.exit(1);
}
if (health.body?.services?.providers?.['OpenAI-compatible gateway'] === 'unconfigured') {
  console.log(
    '\n注意：API 进程还没读到新的密钥（它只在启动时读取 .env）。\n' +
      '请重启 API：先 Ctrl+C 停掉 npm run dev，再重新 npm run dev。\n',
  );
}

const only = option('model');
const toRegister = only ? [only] : remoteModels;

if (flag('register')) {
  console.log(`\n登记模型（provider = OpenAI-compatible gateway）…`);
  const providers = await apiJson('GET', '/api/providers');
  const provider = providers.body?.providers?.find((entry) => entry.kind === 'openai-compatible');
  if (!provider) {
    console.error('  找不到 openai-compatible 服务商记录。');
    process.exit(1);
  }
  let created = 0;
  let existed = 0;
  for (const modelId of toRegister.slice(0, 40)) {
    const result = await apiJson('POST', '/api/models', {
      providerId: provider.id,
      modelId,
      displayName: modelId,
    });
    if (result.status === 201) {
      created += 1;
      console.log(`  + ${modelId}`);
    } else if (result.status === 409) {
      existed += 1;
    } else {
      console.log(`  ! ${modelId} → HTTP ${result.status} ${result.body?.error?.code ?? ''}`);
    }
  }
  console.log(`  新增 ${created} 个，已存在 ${existed} 个`);
} else if (!only) {
  console.log('\n（未加 --register，只探测不登记。加 --register 可把模型登记进模型库。）');
}

// ---- 3. 冒烟评测 ------------------------------------------------------------

if (flag('smoke')) {
  const models = await apiJson('GET', '/api/models');
  const candidates = (models.body?.models ?? []).filter(
    (entry) => entry.providerKind === 'openai-compatible' && (!only || entry.modelId === only),
  );
  if (candidates.length === 0) {
    console.error('\n没有可用的中转站模型。先加 --register 登记。');
    process.exit(1);
  }
  const target = candidates[0];
  console.log(`\n冒烟评测：${target.displayName} × 3 题 …`);

  const created = await apiJson('POST', '/api/evaluations', {
    modelId: target.id,
    itemLimit: 3,
    idempotencyKey: `relay-smoke-${Date.now()}`,
    params: { temperature: 0, maxTokens: 256, retries: 1, concurrency: 1, budgetUsd: 0.5 },
  });
  if (![200, 202].includes(created.status)) {
    console.error(`  创建任务失败：HTTP ${created.status} ${JSON.stringify(created.body?.error ?? {})}`);
    process.exit(1);
  }
  const runId = created.body.run.id;

  let run = null;
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const detail = await apiJson('GET', `/api/evaluations/${runId}`);
    run = detail.body?.run;
    if (run && !['queued', 'running'].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  console.log(`  状态：${run?.status}`);
  const results = await apiJson('GET', `/api/evaluations/${runId}/results`);
  for (const row of results.body?.results ?? []) {
    const score = row.status === 'scored' ? row.score.toFixed(2) : row.status;
    console.log(`    ${row.externalKey}  score=${score}  ${row.latencyMs ?? '-'}ms`);
    console.log(`      题目: ${row.question.slice(0, 70)}`);
    console.log(`      回答: ${String(row.rawResponse ?? row.errorMessage ?? '').replace(/\n/g, ' ').slice(0, 110)}`);
  }

  if (run?.status === 'completed') {
    console.log(`\n真实调用链路已打通。总分 ${run.overallScore ?? '—'}，质量分见 http://127.0.0.1:5199/lab?run=${runId}`);
  } else {
    console.log(`\n任务未成功完成（${run?.status}）。常见原因：模型名不对、余额不足、超时。`);
    console.log(`错误摘要：${JSON.stringify(run?.errorSummary ?? {})}`);
    process.exit(1);
  }
}
