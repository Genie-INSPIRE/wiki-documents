export function splitMarkdownSections(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const sections = [];
  let current = { heading: '页面开头', level: 0, lines: [] };
  let fence = null;

  for (const line of lines) {
    const fenceMarker = line.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/);
    if (fenceMarker) {
      const [, marker, tail] = fenceMarker;
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && !tail.trim()) fence = null;
      current.lines.push(line);
      continue;
    }
    if (fence) {
      current.lines.push(line);
      continue;
    }
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      sections.push(current);
      current = { heading: match[2].trim(), level: match[1].length, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  return sections
    .map((section) => ({
      ...section,
      content: section.lines.join('\n').trim(),
    }))
    .filter((section) => section.content.length > 0);
}

function sectionKey(section) {
  return `${section.level}:${section.heading.toLowerCase()}`;
}

function changedLines(before, after) {
  const beforeLines = before.split(/\r?\n/).map((line) => line.trim());
  const afterLines = after.split(/\r?\n/).map((line) => line.trim());
  const beforeCounts = new Map();
  const afterCounts = new Map();

  for (const line of beforeLines) {
    beforeCounts.set(line, (beforeCounts.get(line) || 0) + 1);
  }
  for (const line of afterLines) {
    afterCounts.set(line, (afterCounts.get(line) || 0) + 1);
  }

  const removed = [];
  const added = [];
  for (const line of beforeLines) {
    const remaining = (beforeCounts.get(line) || 0) - (afterCounts.get(line) || 0);
    if (remaining > 0 && !removed.includes(line)) removed.push(line);
  }
  for (const line of afterLines) {
    const remaining = (afterCounts.get(line) || 0) - (beforeCounts.get(line) || 0);
    if (remaining > 0 && !added.includes(line)) added.push(line);
  }
  return { added, removed };
}

export function diffMarkdownSections(beforeMarkdown, afterMarkdown, referenceUrl = null) {
  const beforeSections = new Map(splitMarkdownSections(beforeMarkdown).map((section) => [sectionKey(section), section]));
  const afterSections = new Map(splitMarkdownSections(afterMarkdown).map((section) => [sectionKey(section), section]));
  const changes = [];

  for (const [key, section] of afterSections) {
    const previous = beforeSections.get(key);
    if (!previous) {
      changes.push({
        status: 'added',
        heading: section.heading,
        referenceUrl,
        changedLines: changedLines('', section.content),
      });
      continue;
    }
    if (previous.content !== section.content) {
      changes.push({
        status: 'changed',
        heading: section.heading,
        referenceUrl,
        changedLines: changedLines(previous.content, section.content),
      });
    }
  }

  for (const [key, section] of beforeSections) {
    if (!afterSections.has(key)) {
      changes.push({
        status: 'removed',
        heading: section.heading,
        referenceUrl,
        changedLines: changedLines(section.content, ''),
      });
    }
  }

  return changes.filter((change) => change.changedLines.added.length || change.changedLines.removed.length);
}

export function materialChangeSections({ sourceText, targetFeatures, referenceUrl }) {
  const targetCommands = new Set(targetFeatures.commands.map((command) => command.normalized));
  const targetLinks = new Set(targetFeatures.links.map((link) => link.normalized));
  const sections = [];

  for (const section of splitMarkdownSections(sourceText)) {
    const sectionCommands = extractCommands(section.content);
    const sectionLinks = extractLinks(section.content);
    const missingCommands = sectionCommands.filter((command) => !targetCommands.has(command.normalized));
    const missingLinks = sectionLinks.filter((link) => !targetLinks.has(link.normalized));
    if (!missingCommands.length && !missingLinks.length) continue;

    sections.push({
      status: 'changed',
      heading: section.heading,
      referenceUrl,
      changedLines: {
        added: [
          ...missingCommands.map((command) => command.command),
          ...missingLinks.map((link) => link.url),
        ],
        removed: [],
      },
      reason: '上游新增或修改了命令 / 链接',
    });
  }

  return sections;
}
import { extractCommands, extractLinks } from './semantic.mjs';

