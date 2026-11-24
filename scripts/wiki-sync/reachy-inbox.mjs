import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { REPO_ROOT, sha256 } from './lib.mjs';
import { diffMarkdownSections, splitMarkdownSections } from './content-diff.mjs';

const sdk = 'pollen-robotics/reachy_mini';
const docsUrl = 'https://huggingface.co/docs/reachy_mini';
export const inboxDirectory = path.join(REPO_ROOT, 'scripts/wiki-sync/output/reachy-inbox');

// Every source has an existing Wiki destination. New upstream filenames never become Wiki paths.
export const destinations = {
  reflash: ['重新刷写 Raspberry Pi OS 镜像', 'platforms/reachy_mini/reflash_the_rpi_ISO.md'],
  faq: ['故障排除与 FAQ', 'troubleshooting.md'],
  apps: ['构建与发布应用', 'SDK/apps.md'],
  js: ['JavaScript SDK 和 Web 应用', 'SDK/javascript-sdk.md'],
  sdk: ['Python SDK', 'SDK/python-sdk.md'],
  wireless: ['Wireless 使用指南', 'platforms/reachy_mini/usage.md'],
  lite: ['Lite 使用指南', 'platforms/reachy_mini_lite/usage.md'],
  examples: ['开发示例与资源', 'intro.md'],
};

export function wikiPaths(destination) {
  const [, relative] = destinations[destination];
  const root = 'docs/Robotics/Robot_Kits/ReachyMini';
  const cn = path.posix.join(path.posix.dirname(relative), `cn_${path.posix.basename(relative)}`);
  return { zh: `sites/zh-CN/${root}/${cn}`, en: `sites/en/${root}/${relative}` };
}

const documentWatches = [
  {
    destination: 'reflash', kind: '工具', source: 'platforms/reachy_mini/reflash_the_rpi_ISO',
    rules: [{
      id: 'flasher', heading: /reachy mini flasher/i, marker: /reachy[-_ ]mini[-_ ]flasher/i,
      title: '官方刷机工具 Reachy Mini Flasher',
      summary: 'Wireless 用户可在 Windows 和 macOS 用官方工具下载系统镜像并刷机。适合补到刷机页开头，原有手动流程可继续保留。',
    }],
  },
  {
    destination: 'faq', kind: 'FAQ', source: 'troubleshooting',
    topic: /camera|microphone|connection|connect |start|boot|update|install|error|fail|recover|motor|battery/i,
    rules: [
      {
        id: 'camera', heading: /camera (?:is )?not detected/i, marker: /rpicam-hello\s+--list-cameras/i,
        title: '机身能动但应用全部启动失败',
        summary: '官方增加了摄像头未识别的排查项。遇到机身动作正常、应用普遍打不开时，可先检查摄像头连接，再按 Wireless 指南确认系统能否识别摄像头。',
      },
    ],
  },
  { destination: 'wireless', kind: '教程', source: 'platforms/reachy_mini/usage', topic: /mobile app|pairing|wi-fi|^##.*update/im },
  { destination: 'lite', kind: '教程', source: 'platforms/reachy_mini_lite/usage', topic: /desktop app|mobile app|^##.*update/im },
  { destination: 'apps', kind: '教程', source: 'SDK/apps', topic: /publish|app assistant|template|debug/i },
  { destination: 'js', kind: '教程', source: 'SDK/javascript-sdk', topic: /web app|mountHost|connectToHost|npm|webRTC/i },
  { destination: 'sdk', kind: '教程', source: 'SDK/python-sdk', topic: /install|connection|backwards compatib|deprecated|migration/i },
];

const releaseWatches = [
  [sdk, 'Reachy Mini SDK', 'sdk'],
  ['pollen-robotics/reachy-mini-desktop-app', 'Reachy Mini Control', 'lite'],
  ['pollen-robotics/reachy_mini_flasher', 'Reachy Mini Flasher', 'reflash'],
  ['pollen-robotics/reachy-mini-os', 'Reachy Mini Wireless OS', 'wireless'],
  ['pollen-robotics/reachy_mini_conversation_app', 'Reachy Mini Conversation App', 'apps'],
];

const spaceTags = [['reachy_mini_js_app', '浏览器应用', 'js'], ['reachy_mini_python_app', 'Python 应用', 'apps']];
const hfBlog = 'https://huggingface.co/blog';
const hfBlogRepo = 'huggingface/blog';
const hfBlogSource = `https://raw.githubusercontent.com/${hfBlogRepo}/main`;
const pollenBlog = 'https://pollen-robotics.com/reachy-mini/blog/';
const pollenApps = 'https://pollen-robotics.com/reachy-mini/apps/';
const articleTopic = /app|sdk|media|web[- ]?rtc|workflow|tutorial|setup|blender|flash|animation|telepresence|voice|troubleshoot|\b(?:mcp|tools?)\b/i;
const internalChange = /\b(?:typo|formatting|lint|ci\/cd|github actions|internal refactor|bump dependencies|dependabot|unit tests?)\b/i;
const releaseRules = [
  [/breaking change|removed|deprecat|migrat/i, '安装、命令或接口的兼容性有变化，升级前应核对受影响版本和替代操作。'],
  [/camera|microphone|gstreamer|audio|device not detected/i, '发布说明涉及音视频设备或连接问题，可以核对现有排障步骤是否覆盖。'],
  [/flash|recover|factory reset|firmware|os image/i, '发布说明涉及刷机、恢复或系统镜像，可以核对下载入口和适用型号。'],
  [/pairing|reconnect|wi-fi|connection|sign.in/i, '发布说明涉及配对、登录或连接，可以核对连接与故障排除步骤。'],
  [/add(?:s|ed)? support|now support|new (?:app|feature|option)|windows|macos|linux|install|startup app|new tool/i, '发布说明涉及用户可用的功能、安装方式或支持平台，可以核对 Wiki 的操作步骤。'],
];
const docTopics = [
  [/camera|camera ribbon/i, '摄像头识别与连接', '可检查现有指南是否覆盖摄像头的连接、设备识别和受影响的型号。'],
  [/wi-fi|pairing|sign.in|mobile app/i, '配对、登录与移动端操作', '可核对设置入口、连接步骤和适用版本。'],
  [/microphone|gstreamer|webRTC|audio|voice/i, '音视频与通信', '可核对现有音视频设置、依赖和连接方式。'],
  [/publish|app assistant|template/i, '应用创建与发布', '可核对模板、发布命令及应用上架条件。'],
  [/update|install|upgrade|deprecat|migrat/i, '安装与升级步骤', '可核对支持的版本、安装命令和升级注意事项。'],
  [/reconnect|connection|start|boot|recover/i, '连接与启动', '可根据故障现象补充验证步骤或恢复说明。'],
];

function plain(text) {
  return String(text || '').replace(/<[^>]*>/g, '').replace(/&(?:amp|#38);/g, '&')
    .replace(/&(?:quot|#34);/g, '"').replace(/&(?:nbsp|#160);/g, ' ').replace(/\s+/g, ' ').trim();
}

function prioritize(result) {
  const priority = { FAQ: 0, 工具: 1, 教程: 2, 文章: 3, 应用: 4 };
  return (priority[result.kind] ?? 5) + (result.community ? 10 : 0);
}

function candidate(data) {
  const { key, revision } = data;
  return { ...data, id: sha256(`${key}:${revision}`).slice(0, 20) };
}

async function request(url, { fetcher, json = false } = {}) {
  const headers = { 'User-Agent': 'seeed-reachy-mini-wiki-inbox' };
  if (new URL(url).hostname === 'api.github.com' && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  let response;
  try {
    response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch (error) {
    const code = error.cause?.code;
    throw new Error(code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? '本机无法解析来源域名'
      : error.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' ? '连接来源超时'
      : '暂时无法连接来源');
  }
  if (!response.ok) throw new Error(`来源返回 HTTP ${response.status}`);
  return json ? response.json() : response.text();
}

function sectionCandidates(watch, previous, current, wiki, revision) {
  const link = `${docsUrl}/${watch.source}`;
  const sections = splitMarkdownSections(current);
  const changes = typeof previous === 'string' ? diffMarkdownSections(previous, current, link) : [];
  const changed = new Map(changes.map((change) => [change.heading, change]));
  const results = [];
  for (const section of sections) {
    const change = changed.get(section.heading);
    const rule = watch.rules?.find((entry) => entry.heading.test(section.heading));
    const substantive = change?.changedLines.added.filter((line) =>
      line.length >= 24 && !line.startsWith('#') && !internalChange.test(line));
    if (rule) {
      const knownGap = !rule.marker.test(wiki);
      const meaningfulChange = change?.status === 'added' || substantive?.some((line) =>
        /https?:|command|install|windows|macos|cable|power|camera|version|download/i.test(line));
      if (!knownGap && !meaningfulChange) continue;
    } else {
      if (!change || !substantive.length || section.level < 2) continue;
      const addedFaq = watch.kind === 'FAQ' && change.status === 'added';
      if (!addedFaq && !(watch.topic?.test(section.heading) || substantive.some((line) => watch.topic?.test(line)))) continue;
      if (!addedFaq && change.status !== 'added' && !substantive.some((line) =>
        /https?:|\x60[^\x60]+\x60|\bstep\b|\brequires?\b|\bnow\b|\bno longer\b/i.test(line))) continue;
    }
    const wikiPage = destinations[watch.destination][0];
    const topic = docTopics.find(([signal]) => signal.test(section.heading)) ||
      docTopics.find(([signal]) => substantive?.some((line) => signal.test(line)));
    const title = rule?.title || (topic ? `${topic[1]}有新说明` : `${wikiPage}有新的操作说明`);
    const summary = rule?.summary || (watch.kind === 'FAQ'
      ? `官方排障指南${change.status === 'added' ? '新增问答' : '补充了解决步骤'}。${topic?.[2] || '建议核实故障现象和解决方式后补到现有 FAQ。'}`
      : `官方指南更新了操作步骤、命令或入口。${topic?.[2] || '建议核实适用条件后补充对应章节。'}`);
    results.push(candidate({
      key: `doc:${watch.source}:${rule?.id || section.heading}`,
      revision: sha256(section.content), version: `官方文档 main · ${revision.slice(0, 7)}`,
      kind: watch.kind, title, summary, sourceTitle: section.heading, link,
      evidenceUrl: `https://github.com/${sdk}/blob/${revision}/docs/source/${watch.source}.md`,
      evidence: section.content.slice(0, 10000), destination: watch.destination,
    }));
  }
  return results;
}

async function readGitHubText(repo, revision, sourcePath, options) {
  return request(`https://raw.githubusercontent.com/${repo}/${revision}/${sourcePath}`, options).catch(async () => {
    const source = await request(`https://api.github.com/repos/${repo}/contents/${sourcePath}?ref=${revision}`, { ...options, json: true });
    if (source.encoding !== 'base64' || typeof source.content !== 'string') throw new Error('官方文档文件格式无法读取');
    return Buffer.from(source.content, 'base64').toString('utf8');
  });
}

async function readDocument(watch, revision, previous, options) {
  const text = await readGitHubText(sdk, revision, `docs/source/${watch.source}.md`, options);
  if (!/^#{1,6}\s/m.test(text)) throw new Error('返回内容不像官方 Markdown 文档');
  const wiki = watch.rules
    ? await fs.readFile(path.join(options.root, wikiPaths(watch.destination).zh), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    }) : '';
  return { value: text, items: sectionCandidates(watch, previous, text, wiki, revision) };
}

async function readReleases([repo, name, destination], previous, options) {
  const releases = await request(`https://api.github.com/repos/${repo}/releases?per_page=10`, { ...options, json: true });
  const stable = releases.filter((release) => !release.draft && !release.prerelease && release.published_at);
  const value = stable.map((release) => release.tag_name);
  if (!Array.isArray(previous)) return { value, items: [] };
  const items = [];
  for (const release of stable.filter((entry) => !previous.includes(entry.tag_name))) {
    if (!release.html_url?.startsWith(`https://github.com/${repo}/releases/tag/`)) continue;
    const notes = String(release.body || '').split(/\r?\n/).filter((line) =>
      line.length > 15 && !internalChange.test(line) && !/full changelog/i.test(line));
    const signals = releaseRules.filter(([pattern]) => notes.some((line) => pattern.test(line)));
    if (!signals.length) continue;
    items.push(candidate({
      key: `release:${repo}:${release.tag_name}`, revision: release.tag_name, kind: '工具',
      title: `${name} ${release.tag_name}`, summary: signals.slice(0, 2).map(([, text]) => text).join(''),
      link: release.html_url, version: release.tag_name, destination, evidence: notes.slice(0, 40).join('\n').slice(0, 8500),
    }));
  }
  return { value: [...new Set([...value, ...previous])].slice(0, 100), items };
}

async function readSpaces([tag, type, destination], previous, options) {
  const url = new URL('https://huggingface.co/api/spaces');
  // The catalog tags identify Spaces; authorship and community relevance are separate checks.
  url.search = new URLSearchParams({ filter: tag, sort: 'lastModified', direction: '-1', limit: '30', full: 'true' });
  const spaces = await request(url.href, { ...options, json: true });
  const value = {};
  const items = [];
  for (const space of spaces) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(space.id) || space.private || space.disabled) continue;
    const official = space.id.startsWith('pollen-robotics/');
    const metadata = space.cardData || {};
    const title = plain(metadata.title || space.id.split('/')[1].replace(/[-_]/g, ' '));
    const description = plain(metadata.short_description || metadata.description).slice(0, 300);
    if (!official && (!(space.likes >= 5) || !description)) continue;
    if (!title || /template|test|sandbox|backend|relay|central/i.test(title)) continue;
    value[space.id] = sha256(`${title}\n${description}`);
    if (!previous || previous[space.id] === value[space.id]) continue;
    items.push(candidate({
      key: `space:${space.id}`, revision: value[space.id], kind: '应用',
      title, summary: `${official ? 'Pollen Robotics 官方' : '已达到收录门槛的社区'}${type}，${previous[space.id] ? '应用说明有更新' : '本周发现'}。可先确认安装方式和适用型号，再决定是否加入应用指引。`,
      destination, link: `https://huggingface.co/spaces/${space.id}`, community: !official,
      evidence: `应用 ID：${space.id}\n应用类型：${type}\n应用说明：${description || '请打开来源查看'}`,
    }));
  }
  return { value: { ...previous, ...value }, items };
}

async function readPollenApps(previous, options) {
  const html = await request(pollenApps, options);
  const value = { ...previous };
  const items = [];
  const curated = new Map([
    ['telepresence', ['Telepresence', '在远程端查看机器人的摄像头，并控制 Reachy Mini。']],
    ['emotions', ['Emotions', '播放 Reachy Mini 的表情和动作。']],
    ['marionette-js', ['Marionette', '从手机录制和回放 Reachy Mini 的动作。']],
  ]);
  const ids = new Set([...html.matchAll(/href=["']https:\/\/huggingface\.co\/spaces\/pollen-robotics\/([\w.-]+)["']/gi)]
    .map((match) => match[1]));
  if (!ids.size) throw new Error('Pollen 应用目录未返回可识别的官方 Space');
  for (const id of ids) {
    value[id] = true;
    if (previous?.[id]) continue;
    const [title, description] = curated.get(id) || [id.replace(/[-_]/g, ' '), 'Pollen Robotics 官方应用，功能和适用条件请参照应用目录。'];
    const url = `https://huggingface.co/spaces/pollen-robotics/${id}`;
    items.push(candidate({
      key: `space:pollen-robotics/${id}`, revision: `catalog:${id}`, kind: '应用', title,
      summary: description, link: url, evidenceUrl: pollenApps, destination: 'apps',
      evidence: `Pollen Robotics 官方应用目录：${pollenApps}\n应用：${title}\n${description}`,
    }));
  }
  return { value, items };
}

async function readHuggingFaceBlog(previous, options) {
  const index = yaml.load(await readGitHubText(hfBlogRepo, 'main', '_blog.yml', options));
  if (!Array.isArray(index)) throw new Error('Hugging Face 官方博客索引格式无法读取');
  const articles = index.filter(({ local }) => typeof local === 'string' && /^[\w-]*reachy[-_]?mini[\w-]*$/i.test(local));
  const value = [...new Set([...(previous || []), ...articles.map((entry) => entry.local)])];
  const items = [];
  if (previous) for (const article of articles.filter((entry) => !previous.includes(entry.local))) {
    const evidenceUrl = `${hfBlogSource}/${article.local}.md`;
    const markdown = await readGitHubText(hfBlogRepo, 'main', `${article.local}.md`, options);
    const sourceTitle = markdown.match(/^#\s+(.+)$/m)?.[1] || article.local.replace(/-/g, ' ');
    if (!articleTopic.test(sourceTitle)) continue;
    const topic = docTopics.find(([signal]) => signal.test(sourceTitle));
    items.push(candidate({
      key: `article:huggingface/${article.local}`, revision: article.local, kind: '文章',
      title: topic ? `官方文章 · ${topic[1]}` : 'Hugging Face Reachy Mini 文章',
      summary: topic ? `Hugging Face 发布了实操文章。${topic[2]}` : 'Hugging Face 发布了 Reachy Mini 相关实操内容，可查看其中适合写入 Wiki 的部分。',
      sourceTitle, link: `${hfBlog}/${article.local}`, evidenceUrl, evidence: markdown.slice(0, 10000), destination: 'examples',
    }));
  }
  return { value, items };
}

function articleLinks(html, index) {
  const links = new Map();
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, href, markup] = match;
    let url;
    try {
      url = new URL(href, index);
    } catch {
      continue;
    }
    url.search = '';
    url.hash = '';
    if (url.origin !== new URL(pollenBlog).origin || !/^\/reachy-mini\/blog\/[\w-]+\/?$/.test(url.pathname)) continue;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    const title = plain(markup.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] || markup).slice(0, 140);
    if (title && articleTopic.test(`${title} ${url.pathname}`)) links.set(url.href, title);
  }
  return links;
}

function articleEvidence(html) {
  return plain(html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    html.match(/<(?:div|section)\b[^>]*class=["'][^"']*\bprose\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i)?.[1] ||
    html.match(/<meta\s+(?:name=["']description["']|property=["']og:description["'])\s+content=["']([^"']+)["']/i)?.[1]);
}

async function readArticles(index, previous, options) {
  const links = articleLinks(await request(index, options), index);
  if (!links.size) throw new Error('官方博客目录格式需要重新核对');
  const value = [...new Set([...links.keys(), ...(previous || [])])].slice(0, 300);
  const items = [];
  for (const [link, articleTitle] of links) {
    const blender = link === `${pollenBlog}animate-in-blender/`;
    const intro = blender
      ? await fs.readFile(path.join(options.root, wikiPaths('examples').zh), 'utf8').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      })
      : '';
    const knownGap = blender && !/blender|reachy_mini_link/i.test(intro);
    if (knownGap ? options.itemKeys.has(`article:${link}`) : !previous || previous.includes(link)) continue;
    const html = await request(link, options);
    const description = articleEvidence(html);
    const topic = docTopics.find(([signal]) => signal.test(articleTitle));
    items.push(candidate({
      key: `article:${link}`, revision: link, kind: blender ? '工具' : '文章',
      title: blender ? '用 Blender 为 Reachy Mini 制作动作' : topic ? `官方文章 · ${topic[1]}` : 'Reachy Mini 官方实用文章',
      summary: blender
        ? '官方 Blender 插件支持在视口中控制真机或仿真机器人、编辑动作关键帧，并把完成的动作发布到 Hugging Face。可以作为 Wiki 开发示例。'
        : topic ? `官方发布了新的实操或开发文章。${topic[2]}` : '官方发布了与 Reachy Mini 操作或开发有关的新文章。可先看原文，再挑选适合写成 Wiki 示例的步骤。',
      sourceTitle: articleTitle, link, destination: 'examples',
      evidence: `标题：${articleTitle}\n${description.slice(0, 8000) || '请打开来源查看详细步骤。'}`,
    }));
  }
  return { value, items };
}

export async function readInbox(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeInbox(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export function inboxMarkdown(report) {
  const escape = (value) => String(value || '').replace(/[\\|<>\[\]\x60*_]/g, '\\$&').replace(/[\r\n]/g, ' ');
  return [
    '# Reachy Mini Wiki 更新收件箱', '',
    report.items.length ? `共有 ${report.items.length} 条候选，选中后可生成章节草稿。`
      : report.failures.length ? '目前暂无候选，部分来源仍需重试。' : '本次没有值得同步的新内容。',
    '', ...report.items.flatMap((item) => [
      `### ${escape(item.kind)} · ${escape(item.title)}`, '',
      escape(item.summary),
      `- 建议更新 ${escape(destinations[item.destination][0])}`,
      `- [查看官方或社区来源](${item.link})`, '',
    ]),
    ...(report.failures.length ? ['## 本次未能检查的来源', '', ...report.failures.map(({ label, message }) => `- ${escape(label)} · ${escape(message)}`)] : []),
  ].join('\n');
}

function sortedItems(items) {
  return [...items].sort((a, b) => prioritize(a) - prioritize(b) || b.seenAt.localeCompare(a.seenAt)).slice(0, 100);
}

export function mergeInboxReports(local, incoming) {
  if (!local) return incoming;
  const latest = Date.parse(local.checkedAt) > Date.parse(incoming.checkedAt) ? local : incoming;
  const sources = {};
  const sourceCheckedAt = {};
  const items = new Map();
  for (const report of [local, incoming]) {
    for (const [key, value] of Object.entries(report.sources)) {
      const checked = report.sourceCheckedAt?.[key] || report.checkedAt;
      if (!sourceCheckedAt[key] || checked >= sourceCheckedAt[key]) {
        sources[key] = value;
        sourceCheckedAt[key] = checked;
      }
    }
    for (const item of report.items) {
      if (!items.has(item.key) || item.seenAt >= items.get(item.key).seenAt) items.set(item.key, item);
    }
  }
  return { ...latest, sources, sourceCheckedAt, items: sortedItems(items.values()) };
}

export async function scanInbox({ root = REPO_ROOT, directory = inboxDirectory, fetcher = fetch, now = new Date() } = {}) {
  const file = path.join(directory, 'inbox.json');
  const state = await readInbox(file, { schemaVersion: 1, sources: {}, items: [] });
  if (state.schemaVersion !== 1) throw new Error('无法读取当前版本的收件箱记录');
  const options = { root, fetcher, itemKeys: new Set(state.items.map((item) => item.key)) };
  const sources = { ...state.sources };
  const sourceCheckedAt = { ...state.sourceCheckedAt };
  const checkedAt = now.toISOString();
  const revision = request(`https://api.github.com/repos/${sdk}/commits/main`, { ...options, json: true })
    .then((result) => {
      if (!/^[0-9a-f]{40}$/.test(result.sha)) throw new Error('无法确认 SDK 文档的上游提交');
      return result.sha;
    });
  const spaces = spaceTags.map((watch) => {
    const key = `space:${watch[0]}`;
    return [key, watch[1], readSpaces(watch, sources[key], options)];
  });
  const spacesStatus = Promise.allSettled(spaces.map((entry) => entry[2]));
  const pollenAppKey = 'space:pollen-official';
  const checks = [
    ...documentWatches.map((watch) => [`doc:${watch.source}`, destinations[watch.destination][0],
      async (previous) => readDocument(watch, await revision, previous, options)]),
    ...releaseWatches.map((watch) => [`release:${watch[0]}`, watch[1], (previous) => readReleases(watch, previous, options)]),
    ...spaces.map(([key, label, pending]) => [key, `Hugging Face ${label}标签`, () => pending]),
    [pollenAppKey, 'Pollen Robotics 官方应用目录', async (previous) => {
      if ((await spacesStatus).every((item) => item.status === 'fulfilled')) return null;
      return readPollenApps(previous, options);
    }],
    [`articles:${pollenBlog}`, 'Pollen Robotics Reachy Mini 博客', (previous) => readArticles(pollenBlog, previous, options)],
    ['articles:huggingface/blog', 'Hugging Face 博客官方 GitHub 索引', (previous) => readHuggingFaceBlog(previous, options)],
    ...[
      [`${pollenBlog}media-stack/`, '媒体架构', 'sdk'],
    ].map(([link, title, destination]) => [`article:${link}`, `Pollen Robotics ${title}`, async (previous) => {
      const html = await request(link, options);
      const body = articleEvidence(html);
      if (!body) throw new Error('文章正文格式需要重新核对');
      const value = sha256(body);
      const items = previous && previous !== value ? [candidate({
        key: `article:${link}`, revision: value, kind: '文章', title: `官方${title}指南有更新`,
        summary: '官方文章正文有变化，适合核对设置步骤或参考链接，再决定是否补到 Wiki。',
        link, destination, evidence: body.slice(0, 8000),
      })] : [];
      return { value, items };
    }]),
  ];
  const results = await Promise.allSettled(checks.map(([key, , collect]) => collect(sources[key])));
  const failures = [];
  let checkedCount = 0;
  const fallbackSucceeded = results[checks.findIndex(([key]) => key === pollenAppKey)].value;
  const byKey = new Map(state.items.map((item) => [item.key, item]));
  for (const [index, result] of results.entries()) {
    const [key, label] = checks[index];
    if (result.status === 'rejected') {
      const message = result.reason.message || '请求失败';
      failures.push({ label, message: fallbackSucceeded && spaces.some(([spaceKey]) => spaceKey === key)
        ? `${message}。官方推荐应用已从 Pollen 目录补上；Hub 的完整标签扫描仍待重试。` : message });
      continue;
    }
    if (!result.value) continue;
    checkedCount += 1;
    sources[key] = result.value.value;
    sourceCheckedAt[key] = checkedAt;
    for (const item of result.value.items) {
      if (key === pollenAppKey && byKey.has(item.key)) continue;
      if (byKey.get(item.key)?.id !== item.id) byKey.set(item.key, { ...item, seenAt: checkedAt });
    }
  }
  const items = sortedItems(byKey.values());
  const report = { schemaVersion: 1, checkedAt, checkedCount, sources, sourceCheckedAt, items, failures };
  await writeInbox(file, report);
  await fs.writeFile(path.join(directory, 'summary.md'), inboxMarkdown(report));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await scanInbox();
  console.log(`Reachy Mini 收件箱 · ${report.items.length} 条候选 · ${report.failures.length} 个来源需要重试`);
  if (!report.checkedCount) process.exitCode = 1;
}
