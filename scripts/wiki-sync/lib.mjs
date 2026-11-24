import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_TIMEOUT_MS = 20000;

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new Error('wiki-sync config must contain at least one source');
  }
  for (const source of config.sources) {
    if (!source.id || !source.type || !source.repo || !source.target) {
      throw new Error(`invalid wiki-sync source: ${JSON.stringify(source)}`);
    }
  }
  return config;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function parsePyprojectVersion(text) {
  const match = text.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
  return match ? match[1] : null;
}

export function parseVersion(version) {
  if (!version) return null;
  const match = String(version).match(/v?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

export function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return 0;
  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major - rightVersion.major;
  }
  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor - rightVersion.minor;
  }
  return leftVersion.patch - rightVersion.patch;
}

export function parseUpdatedAt(frontmatter) {
  const value = frontmatter.updatedAt ?? frontmatter.last_update?.date;
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00Z`);

  const dateMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dateMatch) {
    const [, month, day, year] = dateMatch;
    return new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00Z`);
  }
  return null;
}

export function isOutdatedByDate(targetUpdatedAt, sourceUpdatedAt) {
  if (!targetUpdatedAt || !sourceUpdatedAt) return false;
  return new Date(targetUpdatedAt).getTime() < new Date(sourceUpdatedAt).getTime();
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(attempt * 500);
    }
  }
  throw lastError;
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'seeed-wiki-sync/1.0',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function githubJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return retry(async () => {
    try {
      const response = await fetch(url, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`GitHub API ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      const cause = error?.cause?.message ? ` (${error.cause.message})` : '';
      throw new Error(`GitHub API request failed for ${url}${cause}: ${error.message}`);
    }
  });
}

function encodeGithubPath(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

export async function fetchSource(source) {
  if (source.type === 'github-release') {
    const release = await githubJson(`https://api.github.com/repos/${source.repo}/releases/latest`);
    return {
      version: release.tag_name,
      url: release.html_url,
      updatedAt: release.published_at || release.created_at || null,
      hash: sha256(`${release.tag_name}\n${release.target_commitish}\n${release.published_at}`),
    };
  }

  if (source.type === 'github-file') {
    const branch = source.branch || 'main';
    const encodedPath = encodeGithubPath(source.path);
    const file = await githubJson(
      `https://api.github.com/repos/${source.repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    );
    if (file.encoding !== 'base64' || typeof file.content !== 'string') {
      throw new Error(`unexpected GitHub contents response for ${source.repo}/${source.path}`);
    }
    const text = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');

    const commits = await githubJson(
      `https://api.github.com/repos/${source.repo}/commits?path=${encodedPath}&sha=${encodeURIComponent(branch)}&per_page=1`,
    );
    const commit = Array.isArray(commits) ? commits[0] : commits;
    const updatedAt = commit?.commit?.committer?.date || commit?.commit?.author?.date || null;

    return {
      version: source.extract === 'pyproject-version' ? parsePyprojectVersion(text) : null,
      url: file.html_url || commit?.html_url || null,
      commit: commit?.sha || file.sha || null,
      commitUrl: commit?.html_url || null,
      updatedAt,
      text,
      hash: sha256(text),
    };
  }

  throw new Error(`unsupported source type: ${source.type}`);
}

export async function readTarget(targetPath) {
  const absolutePath = path.resolve(REPO_ROOT, targetPath);
  const content = await fs.readFile(absolutePath, 'utf8');
  const parsed = matter(content);
  const updatedAt = parseUpdatedAt(parsed.data);
  return {
    path: targetPath.replace(/\\/g, '/'),
    title: parsed.data.title || path.basename(targetPath),
    url: parsed.data.url || null,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    hash: sha256(content),
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function isCheckableHttpUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.example') ||
      hostname.endsWith('.example.com') ||
      hostname.endsWith('.invalid')
    ) {
      return false;
    }

    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [first, second] = [Number(ipv4[1]), Number(ipv4[2])];
      return !(
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function extractHttpLinks(markdown) {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
  const matches =
    withoutCode.match(/https?:\/\/[^\s<>"')\]\p{Script=Han}]+/gu) || [];
  const links = new Set();
  for (const match of matches) {
    const url = match
      .replace(/[.,;:!?]+$/, '')
      .replace(/[，。；：、！？“”‘’）】》]+$/u, '');
    if (isCheckableHttpUrl(url)) links.add(url);
  }
  return [...links];
}

async function checkLink(url, timeoutMs) {
  const headers = { 'User-Agent': 'seeed-wiki-sync/1.0' };
  try {
    let response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ([403, 405, 501].includes(response.status)) {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { ...headers, Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    const reason =
      response.status === 401 || response.status === 403
        ? '目标站点拒绝机器人访问，页面可能仍可正常打开'
        : response.status === 404
          ? '链接不存在或已被移动'
          : response.status >= 500
            ? '目标站点服务器错误，需稍后重试'
            : response.status === 406
              ? '目标站点不接受当前请求方式，需人工复核'
              : `HTTP ${response.status}，需人工复核`;
    return {
      url,
      status: response.status >= 200 && response.status < 400 ? 'ok' : 'warning',
      httpStatus: response.status,
      reason,
    };
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '');
    return {
      url,
      status: 'warning',
      httpStatus: null,
      error: error.message,
      reason: isTimeout ? '连接超时，可能是站点限制或网络环境' : '无法访问目标链接，需人工复核',
    };
  }
}

export async function checkLinks(urls, options = {}) {
  const concurrency = Math.max(1, options.concurrency || 6);
  const timeoutMs = options.timeoutMs || 10000;
  const queue = [...urls];
  let cursor = 0;

  async function worker() {
    const results = [];
    while (cursor < queue.length) {
      const url = queue[cursor];
      cursor += 1;
      results.push(await checkLink(url, timeoutMs));
    }
    return results;
  }

  const groups = await Promise.all(Array.from({ length: concurrency }, worker));
  return groups.flat();
}

export function summarize(sources, linkResults = []) {
  const counts = sources.reduce(
    (accumulator, source) => {
      accumulator[source.status] = (accumulator[source.status] || 0) + 1;
      return accumulator;
    },
    { ok: 0, outdated: 0, error: 0 },
  );
  const linkWarnings = linkResults.filter((link) => link.status !== 'ok').length;
  return {
    counts: { ...counts, warning: linkWarnings },
    attentionRequired: counts.error > 0 || counts.outdated > 0,
  };
}

function determineStatus(result, allResults) {
  if (result.error || result.targetError) return 'error';

  if (result.type === 'github-release') {
    const reference = allResults.find((item) => item.id === result.compareWith);
    const comparison = compareVersions(result.source.version, reference?.source?.version);
    if (comparison > 0) {
      return {
        status: 'outdated',
        message: `上游版本 ${result.source.version} 新于 Seeed fork ${reference.source.version}。`,
      };
    }
    if (isOutdatedByDate(result.target.updatedAt, result.source.updatedAt)) {
      return {
        status: 'outdated',
        message: `Wiki 页面更新时间早于上游版本 ${result.source.version}。`,
      };
    }
    return { status: 'ok', message: '上游版本已被验证过的 fork 覆盖。' };
  }

  if (isOutdatedByDate(result.target.updatedAt, result.source.updatedAt)) {
    return {
      status: 'outdated',
      message: 'Wiki 页面更新时间早于最近一次上游源文件变化。',
    };
  }
  return { status: 'ok', message: 'Wiki 页面不早于最近一次上游源文件变化。' };
}

export async function buildReport(config, options = {}) {
  const generatedAt = new Date();
  const statePath = path.resolve(REPO_ROOT, config.outputs.state);
  const state = await readJson(statePath, { schemaVersion: 1, sources: {} });
  const results = [];

  for (const source of config.sources) {
    const result = {
      id: source.id,
      label: source.label || source.id,
      type: source.type,
      repo: source.repo,
      branch: source.branch,
      path: source.path,
      compareWith: source.compareWith,
      source: null,
      target: null,
      error: null,
      targetError: null,
      sourceChanged: false,
      targetChanged: false,
    };

    try {
      result.source = await fetchSource(source);
    } catch (error) {
      result.error = error.message;
    }

    try {
      result.target = await readTarget(source.target);
    } catch (error) {
      result.targetError = error.message;
    }

    const previous = state.sources[source.id] || {};
    result.sourceChanged = Boolean(
      result.source?.hash && previous.sourceHash && previous.sourceHash !== result.source.hash,
    );
    result.targetChanged = Boolean(
      result.target?.hash && previous.targetHash && previous.targetHash !== result.target.hash,
    );
    results.push(result);
  }

  for (const result of results) {
    if (result.error || result.targetError) {
      result.status = 'error';
      result.message = result.error || result.targetError;
      continue;
    }
    const outcome = determineStatus(result, results);
    result.status = outcome.status;
    result.message = outcome.message;
  }

  const uniqueLinks = new Set();
  for (const result of results) {
    if (!result.target) continue;
    try {
      const targetPath = path.resolve(REPO_ROOT, result.target.path);
      const content = await fs.readFile(targetPath, 'utf8');
      for (const link of extractHttpLinks(content)) uniqueLinks.add(link);
    } catch {
      // Target read errors are already reported per source.
    }
  }
  const links = [...uniqueLinks];
  const linkResults = options.checkLinks ? await checkLinks(links, config.linkCheck || {}) : [];
  const summary = summarize(results, linkResults);

  const report = {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    timezone: config.timezone || 'UTC',
    summary,
    sources: results,
    links: {
      checked: options.checkLinks,
      count: links.length,
      results: linkResults,
    },
  };

  if (options.updateState !== false) {
    for (const result of results) {
      state.sources[result.id] = {
        sourceHash: result.source?.hash || null,
        targetHash: result.target?.hash || null,
        sourceUpdatedAt: result.source?.updatedAt || null,
        sourceVersion: result.source?.version || null,
        lastSeenAt: generatedAt.toISOString(),
      };
    }
    state.generatedAt = generatedAt.toISOString();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  return report;
}
