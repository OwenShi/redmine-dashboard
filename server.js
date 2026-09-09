#!/usr/bin/env node
/**
 * Redmine 个人看板后端 —— 单文件，零 npm 依赖（仅 Node 内置模块）
 *
 * 聚合「我」的 Redmine 数据，另提供 GitLab MR 列表与 pipeline 按需查询。
 * issue ↔ MR 的关联匹配放在前端完成（两段式渲染，MR 数据不阻塞首屏）。
 * 凭据存在环境变量 / 本地 CLI 配置文件，前端拿不到。
 *
 * 启动：node server.js
 * 访问：http://localhost:7788
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ────────────────────────────────────────────────────────────
// 配置（环境变量优先）
// ────────────────────────────────────────────────────────────
const REDMINE_URL = (process.env.REDMINE_URL || '').replace(/\/+$/, '');
const REDMINE_API_KEY = process.env.REDMINE_API_KEY || '';
const GITLAB_URL_TMP = (process.env.GITLAB_URL || '').replace(/\/+$/, '');
const GITLAB_TOKEN_TMP = process.env.GITLAB_TOKEN || '';
const { url: GITLAB_URL, token: GITLAB_TOKEN } = resolveGitLab(GITLAB_URL_TMP, GITLAB_TOKEN_TMP);
const PORT = parseInt(process.env.PORT || '7788', 10);
const HOST = process.env.HOST || '0.0.0.0';

const ISSUE_PAGE_SIZE = 100;
const MAX_ISSUE_PAGES = 200;
const REDMINE_CONCURRENCY = 6; // 分页并发上限
const OVERVIEW_CACHE_TTL = 60_000; // Redmine 聚合缓存
const MR_CACHE_TTL = 120_000; // GitLab MR 列表缓存
const PIPELINE_CACHE_TTL = 60_000; // 单个 MR pipeline 按需缓存
const BRANCH_CF_ID = 56; // Redmine「分支名称」自定义字段

if (!REDMINE_URL || !REDMINE_API_KEY) {
  console.error('\n[错误] 未配置 Redmine：需要 REDMINE_URL 和 REDMINE_API_KEY。');
  console.error('推荐用启动脚本自动读取 redmine CLI 配置：bash start.sh（或双击 Redmine看板.command / start.bat）');
  console.error('或直接：REDMINE_URL=https://你的redmine地址 REDMINE_API_KEY=xxx node server.js\n');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────
// glab CLI 配置读取（GitLab 地址与 token 自动发现，免额外配置）
// ────────────────────────────────────────────────────────────

/** glab CLI 配置文件候选路径（对齐官方文档：docs.gitlab.com/cli/configuration） */
function glabConfigFiles() {
  const home = os.homedir();
  const candidates = [];
  // 显式覆盖：GLAB_CONFIG_FILE（直接指定文件）/ GLAB_CONFIG_DIR（官方目录覆盖）
  if (process.env.GLAB_CONFIG_FILE) candidates.push(process.env.GLAB_CONFIG_FILE);
  if (process.env.GLAB_CONFIG_DIR) candidates.push(path.join(process.env.GLAB_CONFIG_DIR, 'config.yml'));
  // Linux/macOS 遵循 XDG 规范
  if (process.env.XDG_CONFIG_HOME) candidates.push(path.join(process.env.XDG_CONFIG_HOME, 'glab-cli', 'config.yml'));
  if (process.platform === 'win32') {
    // Windows 官方路径是 %LOCALAPPDATA%，Roaming 作为个别版本兜底
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'glab-cli', 'config.yml'));
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'glab-cli', 'config.yml'));
  } else {
    if (process.platform === 'darwin') {
      candidates.push(path.join(home, 'Library', 'Application Support', 'glab-cli', 'config.yml'));
    }
    candidates.push(path.join(home, '.config', 'glab-cli', 'config.yml'));
  }
  candidates.push(path.join(home, '.glab-cli', 'config.yml')); // 旧版 glab 遗留路径
  return [...new Set(candidates.filter(Boolean))];
}

/**
 * 解析 GitLab 地址与 token。优先级：
 * 1. 环境变量 GITLAB_URL + GITLAB_TOKEN
 * 2. 环境变量 URL + glab 配置里该主机的 token
 * 3. glab 配置里第一个带 token 的主机（api_host 优先于主机名）
 */
function resolveGitLab(envUrl, envToken) {
  const hosts = [];
  for (const file of glabConfigFiles()) hosts.push(...parseGlabHosts(file));

  if (envUrl) {
    const hostname = new URL(envUrl).hostname;
    const hit =
      hosts.find((h) => h.token && h.name === hostname) ||
      hosts.find((h) => h.token && h.apiHost === hostname);
    return { url: envUrl, token: envToken || (hit ? hit.token : '') };
  }
  if (envToken) {
    const hit = hosts.find((h) => h.apiHost || h.name);
    if (hit) return { url: `https://${hit.apiHost || hit.name}`, token: envToken };
    return { url: '', token: envToken };
  }
  const hit = hosts.find((h) => h.token && (h.apiHost || h.name));
  if (hit) return { url: `https://${hit.apiHost || hit.name}`, token: hit.token };
  return { url: '', token: '' };
}

/** 解析 glab config.yml 的 hosts: 段（缩进结构固定：条目 4 空格、字段 8 空格） */
function parseGlabHosts(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const hosts = [];
  let inHosts = false;
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^hosts:\s*$/.test(raw)) {
      inHosts = true;
      continue;
    }
    if (!inHosts) continue;
    if (/^\S/.test(raw)) break; // hosts: 段结束
    const entry = raw.match(/^ {4}(\S+):\s*$/);
    if (entry) {
      current = { name: entry[1], token: '', apiHost: '' };
      hosts.push(current);
      continue;
    }
    if (!current) continue;
    const token = raw.match(/^ {8}token:\s*(\S+)\s*$/);
    if (token) current.token = token[1];
    const apiHost = raw.match(/^ {8}api_host:\s*(\S+)\s*$/);
    if (apiHost) current.apiHost = apiHost[1];
  }
  return hosts;
}

// ────────────────────────────────────────────────────────────
// HTTP 工具
// ────────────────────────────────────────────────────────────

/** 通用 GET JSON 请求，根据 URL 协议自动选择 http/https */
function getJson(urlStr, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        method: 'GET',
        path: url.pathname + url.search,
        headers: {
          'User-Agent': 'redmine-dashboard/2.0',
          Accept: 'application/json',
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`JSON 解析失败: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时 (15s)')));
    req.end();
  });
}

/** Redmine REST GET */
async function redmineGet(endpoint, params = {}, timeoutMs = 15000) {
  const qs = new URLSearchParams(params).toString();
  try {
    return await getJson(`${REDMINE_URL}${endpoint}.json${qs ? '?' + qs : ''}`, {
      'X-Redmine-API-Key': REDMINE_API_KEY,
    }, timeoutMs);
  } catch (e) {
    throw new Error(`Redmine ${e.message}`);
  }
}

/** GitLab REST GET */
async function gitlabGet(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  try {
    return await getJson(`${GITLAB_URL}/api/v4${endpoint}${qs ? '?' + qs : ''}`, {
      'PRIVATE-TOKEN': GITLAB_TOKEN,
    });
  } catch (e) {
    throw new Error(`GitLab ${e.message}`);
  }
}

/** 带并发上限的 map，失败即整体失败 */
function mapLimit(items, limit, fn) {
  return new Promise((resolve, reject) => {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    let failed = false;
    const launch = () => {
      if (failed) return;
      if (next >= items.length) {
        if (done === items.length) resolve(results);
        return;
      }
      const idx = next++;
      Promise.resolve(fn(items[idx]))
        .then((r) => {
          results[idx] = r;
          done += 1;
          launch();
        })
        .catch((e) => {
          if (!failed) {
            failed = true;
            reject(e);
          }
        });
    };
    for (let i = 0; i < Math.min(limit, items.length); i += 1) launch();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 单页拉取：Redmine 高负载下偶发超时，放宽到 25s 并重试一次 */
async function fetchIssuePage(params, offset) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await redmineGet('/issues', { ...params, limit: ISSUE_PAGE_SIZE, offset }, 25000);
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(800);
    }
  }
}

/**
 * Redmine 服务器可能把单页上限压到 25，即使请求 limit=0 也不会返回全部数据。
 * 先拉第一页拿 total_count，剩余页并发拉取（上限 REDMINE_CONCURRENCY），
 * 串行翻页（约 N×RTT）降为约 2×RTT。单页失败自动重试一次。
 */
async function redmineGetAllIssues(params = {}) {
  const first = await fetchIssuePage(params, 0);
  const firstIssues = Array.isArray(first.issues) ? first.issues : [];
  const totalCount = Number(first.total_count);
  const issues = [...firstIssues];

  if (Number.isFinite(totalCount) && firstIssues.length > 0 && issues.length < totalCount) {
    if (totalCount / firstIssues.length > MAX_ISSUE_PAGES) {
      throw new Error(`Redmine 分页异常：total=${totalCount}，单页=${firstIssues.length}`);
    }
    const offsets = [];
    for (let off = firstIssues.length; off < totalCount; off += firstIssues.length) {
      offsets.push(off);
    }
    const pages = await mapLimit(offsets, REDMINE_CONCURRENCY, (off) => fetchIssuePage(params, off));
    for (const page of pages) {
      for (const issue of Array.isArray(page.issues) ? page.issues : []) issues.push(issue);
    }
  }

  const seen = new Set();
  const unique = issues.filter((i) => i && !seen.has(i.id) && seen.add(i.id));
  if (Number.isFinite(totalCount) && unique.length < totalCount) {
    throw new Error(`Redmine 分页不完整：已读取 ${unique.length}/${totalCount} 条 issue`);
  }
  return { issues: unique, total_count: Number.isFinite(totalCount) ? totalCount : unique.length };
}

// ────────────────────────────────────────────────────────────
// 内存缓存
// ────────────────────────────────────────────────────────────

const cache = new Map(); // key -> { at, value }

/** TTL 缓存包装；force=true 绕过缓存强制拉新（手动刷新用）。失败不写缓存。 */
async function withCache(key, ttl, force, producer) {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await producer();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ────────────────────────────────────────────────────────────
// 响应工具
// ────────────────────────────────────────────────────────────

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ────────────────────────────────────────────────────────────
// 聚合逻辑
// ────────────────────────────────────────────────────────────

/** 读取 issue 的「分支名称」自定义字段，用于前端关联 GitLab MR */
function issueBranch(issue) {
  const fields = Array.isArray(issue.custom_fields) ? issue.custom_fields : [];
  for (const cf of fields) {
    if (!cf) continue;
    const matched = cf.id === BRANCH_CF_ID || cf.name === '分支名称';
    if (!matched) continue;
    const value = Array.isArray(cf.value) ? cf.value[0] : cf.value;
    if (value) return String(value).trim();
  }
  return '';
}

/** 精简 issue 字段，减少传输量 */
function simplifyIssue(issue) {
  return {
    id: issue.id,
    subject: issue.subject,
    tracker: issue.tracker ? issue.tracker.name : '',
    status: issue.status ? issue.status.name : '',
    priority: issue.priority ? issue.priority.name : '',
    project: issue.project ? issue.project.name : '',
    version: issue.fixed_version ? issue.fixed_version.name : '',
    updated_on: issue.updated_on,
    created_on: issue.created_on,
    due_date: issue.due_date,
    done_ratio: issue.done_ratio || 0,
    branch: issueBranch(issue),
    url: `${REDMINE_URL}/issues/${issue.id}`,
  };
}

/** 把扁平 issue 列表重组成 {版本: {状态: [issue]}} 嵌套结构，并统计汇总 */
function groupByVersionAndStatus(issues) {
  const grouped = {};
  const statusCount = {};
  const trackerCount = {};
  const versionCount = {};

  for (const issue of issues) {
    const version = issue.fixed_version ? issue.fixed_version.name : '（无版本）';
    const status = issue.status ? issue.status.name : '未知';
    const tracker = issue.tracker ? issue.tracker.name : '其他';

    if (!grouped[version]) grouped[version] = {};
    if (!grouped[version][status]) grouped[version][status] = [];
    grouped[version][status].push(simplifyIssue(issue));

    statusCount[status] = (statusCount[status] || 0) + 1;
    trackerCount[tracker] = (trackerCount[tracker] || 0) + 1;
    versionCount[version] = (versionCount[version] || 0) + 1;
  }

  return { grouped, statusCount, trackerCount, versionCount, total: issues.length };
}

// ────────────────────────────────────────────────────────────
// GitLab MR
// ────────────────────────────────────────────────────────────

/** 精简 MR 字段（关联匹配和徽标展示够用） */
function simplifyMr(mr) {
  const refFull = mr.references && mr.references.full ? String(mr.references.full) : '';
  return {
    iid: mr.iid,
    project_id: mr.project_id,
    project_path: refFull ? refFull.split('!')[0] : '',
    title: mr.title || '',
    state: mr.state || 'opened', // opened | merged | closed | locked
    draft: Boolean(mr.draft || mr.work_in_progress),
    has_conflicts: Boolean(mr.has_conflicts),
    has_unresolved_discussions: mr.blocking_discussions_resolved === false,
    detailed_merge_status: mr.detailed_merge_status || mr.merge_status || '',
    source_branch: mr.source_branch || '',
    target_branch: mr.target_branch || '',
    web_url: mr.web_url || '',
    updated_at: mr.updated_at || '',
  };
}

/**
 * 我创建的 MR（近 100 条有更新的，含 opened + 近期 merged/closed）。
 * 前端按 issue 分支名 / Refs #N 引用 / 分支数字 token 三级匹配。
 */
async function fetchMyMrs() {
  if (!GITLAB_URL || !GITLAB_TOKEN) {
    return {
      available: false,
      error: '未配置 GitLab（设置 GITLAB_URL / GITLAB_TOKEN 环境变量，或 glab CLI 登录后自动识别）',
      mrs: [],
      count: 0,
      fetchedAt: new Date().toISOString(),
    };
  }
  const data = await gitlabGet('/merge_requests', {
    scope: 'created_by_me',
    state: 'all',
    order_by: 'updated_at',
    per_page: 100,
  });
  const mrs = (Array.isArray(data) ? data : []).map(simplifyMr);
  return {
    available: true,
    count: mrs.length,
    mrs,
    fetchedAt: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────
// API 接口
// ────────────────────────────────────────────────────────────

/** GET /api/overview?status=open|closed|*&force=1 — 我的 issue 按版本+状态分组 */
async function handleOverview(res, query) {
  const statusScope = query.status || 'open';
  const result = await withCache(
    `overview:${statusScope}`,
    OVERVIEW_CACHE_TTL,
    query.force === '1',
    async () => {
      const data = await redmineGetAllIssues({
        assigned_to_id: 'me',
        status_id: statusScope,
        sort: 'updated_on:desc',
      });
      const result = groupByVersionAndStatus(data.issues || []);
      result.scope = statusScope;
      result.totalCount = data.total_count;
      result.fetchedAt = new Date().toISOString();
      return result;
    }
  );
  sendJson(res, 200, result);
}

/** GET /api/recent?days=7&force=1 — 近 N 天我更新的 issue（扁平列表，按时间倒序） */
async function handleRecent(res, query) {
  const days = Math.min(Math.max(parseInt(query.days || '7', 10) || 7, 1), 90);
  const result = await withCache(`recent:${days}`, OVERVIEW_CACHE_TTL, query.force === '1', async () => {
    const since = new Date(Date.now() - days * 86400000);
    const sinceStr = since.toISOString().slice(0, 10);
    const data = await redmineGetAllIssues({
      assigned_to_id: 'me',
      status_id: '*',
      updated_on: `>=${sinceStr}`,
      sort: 'updated_on:desc',
    });
    return {
      days,
      since: sinceStr,
      total: (data.issues || []).length,
      totalCount: data.total_count,
      fetchedAt: new Date().toISOString(),
      issues: (data.issues || []).map(simplifyIssue),
    };
  });
  sendJson(res, 200, result);
}

/** GET /api/mrs?force=1 — 我创建的 GitLab MR 列表（120s 缓存） */
async function handleMrs(res, query) {
  const data = await withCache('mrs', MR_CACHE_TTL, query.force === '1', fetchMyMrs);
  sendJson(res, 200, data);
}

/** GET /api/mr-pipeline?project_id=&iid=&force=1 — 单个 MR 最新 pipeline（按需，60s 缓存） */
async function handleMrPipeline(res, query) {
  const projectId = parseInt(query.project_id, 10);
  const iid = parseInt(query.iid, 10);
  if (!Number.isFinite(projectId) || projectId <= 0 || !Number.isFinite(iid) || iid <= 0) {
    sendJson(res, 400, { error: '需要有效的 project_id 和 iid' });
    return;
  }
  if (!GITLAB_URL || !GITLAB_TOKEN) {
    sendJson(res, 503, { error: '未配置 GitLab token' });
    return;
  }
  const data = await withCache(`pipe:${projectId}:${iid}`, PIPELINE_CACHE_TTL, query.force === '1', async () => {
    const list = await gitlabGet(`/projects/${projectId}/merge_requests/${iid}/pipelines`, {
      per_page: 1,
      sort: 'desc',
    });
    const p = Array.isArray(list) && list[0];
    if (!p) return { status: 'none' };
    return {
      id: p.id,
      status: p.status,
      duration: typeof p.duration === 'number' ? p.duration : null,
      ref: p.ref || '',
      sha: p.sha || '',
      web_url: p.web_url || '',
      created_at: p.created_at || null,
      started_at: p.started_at || null,
      finished_at: p.finished_at || null,
    };
  });
  sendJson(res, 200, data);
}

/** GET /api/mr-jobs?project_id=&pipeline_id=&force=1 — 某条流水线的 job 列表（按需，60s 缓存） */
async function handleMrJobs(res, query) {
  const projectId = parseInt(query.project_id, 10);
  const pipelineId = parseInt(query.pipeline_id, 10);
  if (!Number.isFinite(projectId) || projectId <= 0 || !Number.isFinite(pipelineId) || pipelineId <= 0) {
    sendJson(res, 400, { error: '需要有效的 project_id 和 pipeline_id' });
    return;
  }
  if (!GITLAB_URL || !GITLAB_TOKEN) {
    sendJson(res, 503, { error: '未配置 GitLab token' });
    return;
  }
  const data = await withCache(`jobs:${projectId}:${pipelineId}`, PIPELINE_CACHE_TTL, query.force === '1', async () => {
    const list = await gitlabGet(`/projects/${projectId}/pipelines/${pipelineId}/jobs`, { per_page: 30 });
    const jobs = (Array.isArray(list) ? list : [])
      .map((j) => ({
        id: j.id,
        name: j.name || '',
        stage: j.stage || '',
        status: j.status || '',
        duration: typeof j.duration === 'number' ? j.duration : null,
        failure_reason: j.failure_reason || '',
        web_url: j.web_url || '',
      }))
      .sort((a, b) => a.id - b.id);
    return { jobs };
  });
  sendJson(res, 200, data);
}

/** GET /api/meta — 状态/tracker 元信息，供前端配色与分组用 */
async function handleMeta(res) {
  const [statuses, trackers] = await Promise.all([
    redmineGet('/issue_statuses', { limit: 0 }),
    redmineGet('/trackers', { limit: 0 }),
  ]);
  sendJson(res, 200, {
    statuses: (statuses.issue_statuses || []).map((s) => ({ name: s.name, is_closed: s.is_closed })),
    trackers: (trackers.trackers || []).map((t) => ({ name: t.name })),
    redmineUrl: REDMINE_URL,
  });
}

/** GET /api/user — 当前用户信息 */
async function handleUser(res) {
  const data = await redmineGet('/users/current');
  const u = data.user || {};
  sendJson(res, 200, {
    id: u.id,
    login: u.login,
    name: `${u.firstname || ''} ${u.lastname || ''}`.trim(),
    redmineUrl: REDMINE_URL,
  });
}

// ────────────────────────────────────────────────────────────
// HTTP 服务
// ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const query = Object.fromEntries(url.searchParams);

  try {
    switch (url.pathname) {
      case '/':
      case '/index.html':
        serveStatic(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
        break;
      case '/api/overview':
        await handleOverview(res, query);
        break;
      case '/api/recent':
        await handleRecent(res, query);
        break;
      case '/api/mrs':
        await handleMrs(res, query);
        break;
      case '/api/mr-pipeline':
        await handleMrPipeline(res, query);
        break;
      case '/api/mr-jobs':
        await handleMrJobs(res, query);
        break;
      case '/api/meta':
        await handleMeta(res);
        break;
      case '/api/user':
        await handleUser(res);
        break;
      default:
        sendJson(res, 404, { error: 'Not Found', path: url.pathname });
    }
  } catch (err) {
    console.error(`[${url.pathname}] 错误:`, err.message);
    sendJson(res, 502, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Redmine 个人看板已启动`);
  console.log(`  ────────────────────────────`);
  console.log(`  本地:   http://localhost:${PORT}`);
  console.log(`  内网:   http://${HOST}:${PORT}`);
  console.log(`  Redmine: ${REDMINE_URL}`);
  console.log(`  GitLab:  ${GITLAB_URL || '未配置'} (token ${GITLAB_TOKEN ? '已配置' : '未配置，MR 状态不可用'})`);
  console.log(`  ────────────────────────────\n`);
});
