import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { fetchSource, REPO_ROOT } from './lib.mjs';

const TOPIC_MAP = [
  { key: 'install', variants: ['install', 'installation', 'setup', 'environment', '安装', '环境'] },
  { key: 'camera', variants: ['camera', 'realsense', 'opencv', '相机', '摄像头'] },
  { key: 'motor', variants: ['motor', 'servo', 'feetech', '电机', '舵机'] },
  { key: 'calibration', variants: ['calibrat', '标定', '校准'] },
  { key: 'teleoperation', variants: ['teleop', '遥操作'] },
  { key: 'assembly', variants: ['assembl', '组装'] },
  { key: 'record', variants: ['record', 'dataset', '录制', '数据采集'] },
  { key: 'training', variants: ['train', '训练'] },
  { key: 'troubleshooting', variants: ['troubleshoot', 'faq', '故障', '排查', '常见问题'] },
  { key: 'quickstart', variants: ['quickstart', '快速开始'] },
  { key: 'sdk', variants: ['sdk', 'api', '接口'] },
  { key: 'moving', variants: ['moving the robot', '移动机器人'] },
  { key: 'vision_audio', variants: ['vision', 'audio', '视觉', '音频'] },
  { key: 'errors', variants: ['specific error', '错误消息', '错误信息'] },
  { key: 'shipping', variants: ['shipping', 'warranty', '运输', '保修'] },
  { key: 'still_stuck', variants: ['still stuck', '仍然卡住'] },
  { key: 'introduction', variants: ['introduction', '简介'] },
  { key: 'damaged', variants: ['damaged', '损坏'] },
  { key: 'new_cable', variants: ['new fpc cable', '新fpc线缆'] },
  { key: 'steps', variants: ['steps', '步骤'] },
  { key: 'tutorial', variants: ['tutorial', '教程'] },
];

export function stripFrontmatter(content) {
  const parsed = matter(content);
  return parsed.content;
}

export function normalizeCommand(command) {
  return command
    .trim()
    .replace(/^[#$]\s*/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function normalizeLink(link) {
  const withoutTrailingSlash = link.trim().replace(/\/$/, '').toLowerCase();
  return withoutTrailingSlash.replace(
    /^(https:\/\/github\.com\/[^/]+\/[^/]+\/raw\/)(?:[^/]+)(\/.*)$/,
    '$1main$2',
  );
}

function tokenizeCommand(command) {
  return new Set(
    normalizeCommand(command)
      .split(/\s+/)
      .filter(Boolean),
  );
}

function commandSimilarity(left, right) {
  const leftTokens = tokenizeCommand(left);
  const rightTokens = tokenizeCommand(right);
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function headingTokens(heading) {
  const lower = heading.toLowerCase();
  const tokens = new Set(lower.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean));
  for (const topic of TOPIC_MAP) {
    if (topic.variants.some((variant) => lower.includes(variant))) {
      tokens.add(topic.key);
    }
  }
  return tokens;
}

function headingTopicKeys(heading) {
  const lower = heading.toLowerCase();
  const topics = new Set();
  for (const topic of TOPIC_MAP) {
    if (topic.variants.some((variant) => lower.includes(variant))) {
      topics.add(topic.key);
    }
  }
  return topics;
}

function headingOverlap(left, right) {
  const leftTokens = headingTopicKeys(left);
  const rightTokens = headingTopicKeys(right);
  if (!leftTokens.size || !rightTokens.size) {
    const fallbackLeft = headingTokens(left);
    const fallbackRight = headingTokens(right);
    const fallbackIntersection = [...fallbackLeft].filter((token) => fallbackRight.has(token)).length;
    const fallbackUnion = new Set([...fallbackLeft, ...fallbackRight]).size;
    return fallbackUnion ? fallbackIntersection / fallbackUnion : 0;
  }
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

export function extractHeadings(content) {
  const headings = [];
  let inCodeBlock = false;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
      });
    }
  }
  return headings;
}

export function extractCodeBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let inBlock = false;
  let language = '';
  let buffer = [];
  let heading = '';

  for (const line of lines) {
    if (!inBlock) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) heading = headingMatch[2].trim();
      if (line.startsWith('```')) {
        inBlock = true;
        language = line.slice(3).trim();
        buffer = [];
      }
      continue;
    }

    if (line.trim() === '```') {
      blocks.push({ language, code: buffer.join('\n'), heading });
      inBlock = false;
      continue;
    }
    buffer.push(line);
  }
  return blocks;
}

export function extractCommands(content) {
  const commands = [];
  const codeBlocks = extractCodeBlocks(content);
  const commandPattern = /^(?:sudo |pip |pip3 |python |python3 |conda |git |lerobot |docker |npm |yarn |pnpm |curl |wget |uv |make |pytest |cd |source |export |chmod |chown |ssh |scp |apt |apt-get |brew |echo |code |open |source )/;

  for (const block of codeBlocks) {
    const lowerLanguage = block.language.toLowerCase();
    const isShell = ['bash', 'sh', 'shell', 'console', 'terminal', 'zsh', 'powershell', ''].includes(lowerLanguage);
    if (!isShell) continue;

    for (const line of block.code.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const withoutPrompt = trimmed.replace(/^\$\s*/, '');
      if (!commandPattern.test(withoutPrompt)) continue;
      const command = withoutPrompt.replace(/\s+&&\s+/g, ' && ');
      commands.push({
        command,
        normalized: normalizeCommand(command),
        heading: block.heading,
      });
    }
  }
  return commands;
}

export function extractLinks(content) {
  const links = [];
  const withoutCodeBlocks = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');
  const matches = withoutCodeBlocks.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  for (const match of matches) {
    const url = match.replace(/[.,;:!?]+$/, '');
    links.push({ url, normalized: normalizeLink(url) });
  }
  return links;
}

export function extractFeatures(content, sourceMeta = {}) {
  const body = stripFrontmatter(content);
  return {
    headings: extractHeadings(body).map((heading) => ({
      ...heading,
      source: sourceMeta.label || sourceMeta.path || null,
    })),
    commands: extractCommands(body).map((command) => ({
      ...command,
      source: sourceMeta.label || sourceMeta.path || null,
      sourceUrl: sourceMeta.url || null,
    })),
    links: extractLinks(body).map((link) => ({
      ...link,
      source: sourceMeta.label || sourceMeta.path || null,
      sourceUrl: sourceMeta.url || null,
    })),
  };
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = item[key];
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function compareFeatures(sourceFeatures, targetFeatures) {
  const targetCommands = new Set(targetFeatures.commands.map((command) => command.normalized));
  const targetLinks = new Set(targetFeatures.links.map((link) => link.normalized));
  const targetHeadings = targetFeatures.headings;

  const missingCommands = uniqueBy(
    sourceFeatures.commands.filter((command) => !targetCommands.has(command.normalized)),
    'normalized',
  );
  const missingLinks = uniqueBy(
    sourceFeatures.links.filter((link) => !targetLinks.has(link.normalized)),
    'normalized',
  );
  const missingHeadings = sourceFeatures.headings.filter(
    (heading) => !targetHeadings.some((targetHeading) => headingOverlap(heading.text, targetHeading.text) >= 0.34),
  );

  const commandCoverage = sourceFeatures.commands.length
    ? 1 - missingCommands.length / sourceFeatures.commands.length
    : 1;
  const linkCoverage = sourceFeatures.links.length
    ? 1 - missingLinks.length / sourceFeatures.links.length
    : 1;
  const headingCoverage = sourceFeatures.headings.length
    ? 1 - missingHeadings.length / sourceFeatures.headings.length
    : 1;

  return {
    missingCommands,
    missingLinks,
    missingHeadings,
    coverage: {
      commands: Math.round(commandCoverage * 100),
      links: Math.round(linkCoverage * 100),
      headings: Math.round(headingCoverage * 100),
      overall: Math.round(((commandCoverage + linkCoverage + headingCoverage) / 3) * 100),
    },
  };
}

function statusFor(semanticResult) {
  if (semanticResult.missingCommands.length || semanticResult.missingLinks.length) return 'outdated';
  if (semanticResult.missingHeadings.length) return 'warning';
  return 'ok';
}

export async function buildSemanticReport(config) {
  const semanticTargets = config.semanticTargets || [];
  const results = [];

  for (const semanticTarget of semanticTargets) {
    const result = {
      id: semanticTarget.id,
      label: semanticTarget.label || semanticTarget.id,
      target: semanticTarget.target,
      upstreamDocs: [],
      missingCommands: [],
      missingLinks: [],
      missingHeadings: [],
      coverage: null,
      status: 'error',
      message: '',
    };

    try {
      const targetPath = path.resolve(REPO_ROOT, semanticTarget.target);
      let targetContent = '';
      try {
        targetContent = await fs.readFile(targetPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const targetFeatures = extractFeatures(targetContent, { label: 'Wiki target' });
      const sourceFeatures = {
        headings: [],
        commands: [],
        links: [],
      };

      for (const upstreamDoc of semanticTarget.upstreamDocs) {
        const source = upstreamDoc.sourceText
          ? {
              text: upstreamDoc.sourceText,
              url: upstreamDoc.sourceUrl || null,
              commit: null,
              commitUrl: null,
              updatedAt: null,
            }
          : await fetchSource({
              type: 'github-file',
              repo: upstreamDoc.repo,
              branch: upstreamDoc.branch || 'main',
              path: upstreamDoc.path,
            });
        const features = extractFeatures(source.text, {
          label: upstreamDoc.path,
          url: source.url,
        });
        sourceFeatures.headings.push(...features.headings);
        sourceFeatures.commands.push(...features.commands);
        sourceFeatures.links.push(...features.links);
        result.upstreamDocs.push({
          repo: upstreamDoc.repo,
          branch: upstreamDoc.branch || 'main',
          path: upstreamDoc.path,
          url: source.url,
          commit: source.commit,
          commitUrl: source.commitUrl,
          updatedAt: source.updatedAt,
        });
      }

      const comparison = compareFeatures(sourceFeatures, targetFeatures);
      result.missingCommands = comparison.missingCommands;
      result.missingLinks = comparison.missingLinks;
      result.missingHeadings = comparison.missingHeadings;
      result.coverage = comparison.coverage;
      result.status = statusFor(comparison);
      result.message =
        result.status === 'ok'
          ? '未发现实质内容缺口。'
          : `覆盖率 ${comparison.coverage.overall}%：缺失 ${comparison.missingCommands.length} 条命令、${comparison.missingLinks.length} 个链接、${comparison.missingHeadings.length} 个标题。`;
    } catch (error) {
      result.status = 'error';
      result.message = error.message;
    }

    results.push(result);
  }

  const counts = results.reduce(
    (accumulator, result) => {
      accumulator[result.status] = (accumulator[result.status] || 0) + 1;
      return accumulator;
    },
    { ok: 0, outdated: 0, warning: 0, error: 0 },
  );
  const averageCoverage = results.length
    ? Math.round(results.reduce((total, result) => total + (result.coverage?.overall || 0), 0) / results.length)
    : 100;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      counts,
      averageCoverage,
      attentionRequired: counts.outdated > 0 || counts.error > 0,
    },
    targets: results,
  };
}
