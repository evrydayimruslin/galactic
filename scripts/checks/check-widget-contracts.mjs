import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { ensureNode20, repoRoot } from '../analysis/_shared.mjs';

ensureNode20();

const findings = [];

function walkForManifests(directory) {
  const results = [];

  for (const entry of readdirSync(directory)) {
    const fullPath = resolve(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...walkForManifests(fullPath));
      continue;
    }

    if (entry === 'manifest.json') {
      results.push(fullPath);
    }
  }

  return results;
}

function addFinding(file, message) {
  findings.push({ file, message });
}

function validateCommandCard(file, widgetId, dataTool, functions, card, seenCardIds) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    addFinding(file, `Widget \`${widgetId}\` command cards must be objects.`);
    return;
  }

  const cardId = typeof card.id === 'string' ? card.id : '';
  if (!cardId) {
    addFinding(file, `Widget \`${widgetId}\` command cards must include a string \`id\` field.`);
    return;
  }

  if (seenCardIds.has(cardId)) {
    addFinding(file, `Widget \`${widgetId}\` declares duplicate command card \`${cardId}\`.`);
  }
  seenCardIds.add(cardId);

  if (typeof card.label !== 'string' || !card.label.trim()) {
    addFinding(file, `Widget card \`${widgetId}.${cardId}\` must include a string \`label\` field.`);
  }
  if (typeof card.size !== 'string' || !/^[1-4]x[1-4]$/.test(card.size)) {
    addFinding(file, `Widget card \`${widgetId}.${cardId}\` must declare one fixed size like \`2x1\`.`);
  }
  if (card.render !== undefined && card.render !== 'native') {
    addFinding(file, `Widget card \`${widgetId}.${cardId}\` must use native rendering for v1.`);
  }

  const cardDataFunction = typeof card.data_function === 'string' && card.data_function
    ? card.data_function
    : dataTool;
  if (cardDataFunction && !functions[cardDataFunction]) {
    addFinding(file, `Widget card \`${widgetId}.${cardId}\` references missing data function \`${cardDataFunction}\`.`);
  }

  const dependencies = Array.isArray(card.dependencies) ? card.dependencies : [];
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency !== 'object') {
      addFinding(file, `Widget card \`${widgetId}.${cardId}\` dependencies must be objects.`);
      continue;
    }
    if (dependency.access !== undefined && dependency.access !== 'read') {
      addFinding(file, `Widget card \`${widgetId}.${cardId}\` dependencies must be read-only.`);
    }
  }
}

const manifestPaths = walkForManifests(resolve(repoRoot, 'apps'));

for (const manifestPath of manifestPaths) {
  const relativePath = relative(repoRoot, manifestPath).replaceAll('\\', '/');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const widgets = Array.isArray(manifest.widgets) ? manifest.widgets : [];
  const functions = manifest.functions && typeof manifest.functions === 'object' ? manifest.functions : {};

  for (const widget of widgets) {
    if (!widget || typeof widget !== 'object') {
      addFinding(relativePath, 'Widget declarations must be objects.');
      continue;
    }

    const widgetId = typeof widget.id === 'string' ? widget.id : '';
    const dataTool = typeof widget.data_tool === 'string' ? widget.data_tool : null;
    if (!widgetId) {
      addFinding(relativePath, 'Widget declarations must include a string `id` field.');
      continue;
    }

    const expectedDataTool = `widget_${widgetId}_data`;
    if (dataTool !== null && dataTool !== expectedDataTool) {
      addFinding(
        relativePath,
        `Widget \`${widgetId}\` should declare \`${expectedDataTool}\` as its data_tool instead of \`${dataTool}\`.`,
      );
    }

    const uiFunction = `widget_${widgetId}_ui`;
    if (!functions[uiFunction]) {
      addFinding(relativePath, `Widget \`${widgetId}\` is missing its canonical UI function \`${uiFunction}\`.`);
    }

    if (!functions[expectedDataTool]) {
      addFinding(
        relativePath,
        `Widget \`${widgetId}\` is missing its canonical data function \`${expectedDataTool}\`.`,
      );
    }

    const cards = Array.isArray(widget.cards) ? widget.cards : [];
    const seenCardIds = new Set();
    for (const card of cards) {
      validateCommandCard(relativePath, widgetId, dataTool || expectedDataTool, functions, card, seenCardIds);
    }
  }
}

if (findings.length > 0) {
  console.error('Widget contract guardrails failed:');
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.message}`);
  }
  process.exit(1);
}

console.log('Widget contract guardrails passed.');
