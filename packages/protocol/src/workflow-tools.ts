import type { ActionStep, RecordedWorkflow } from './schemas.js';

const VAR_PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export function extractWorkflowParamNames(workflow: RecordedWorkflow): string[] {
  const names = new Set<string>();
  const scan = (text?: string) => {
    if (!text) return;
    for (const match of text.matchAll(VAR_PLACEHOLDER_RE)) {
      if (match[1]) names.add(match[1]);
    }
  };

  for (const p of workflow.parameters ?? []) {
    names.add(p.name);
  }
  scan(workflow.startUrl);
  for (const entry of workflow.steps) {
    const s = entry.step;
    if (s.kind === 'fill') scan(s.value);
    else if (s.kind === 'type') scan(s.text);
    else if (s.kind === 'select') scan(s.value);
    else if (s.kind === 'wait') scan(s.text);
  }
  return [...names];
}

function interpolateString(
  raw: string,
  values: Record<string, string>,
  defaults: Map<string, string>,
  missing: Set<string>,
): string {
  VAR_PLACEHOLDER_RE.lastIndex = 0;
  return raw.replace(VAR_PLACEHOLDER_RE, (_full, name: string) => {
    if (Object.hasOwn(values, name)) {
      return values[name]!;
    }
    const fallback = defaults.get(name);
    if (fallback !== undefined) {
      return fallback;
    }
    missing.add(name);
    return `{{${name}}}`;
  });
}

export function interpolateWorkflowSteps(
  workflow: RecordedWorkflow,
  variables: Record<string, string> = {},
): { startUrl: string; steps: ActionStep[] } {
  const defaults = new Map<string, string>();
  for (const param of workflow.parameters ?? []) {
    if (param.defaultValue !== undefined) {
      defaults.set(param.name, param.defaultValue);
    }
  }

  const missing = new Set<string>();
  const startUrl = interpolateString(workflow.startUrl, variables, defaults, missing);
  const steps: ActionStep[] = workflow.steps.map((entry) => {
    const s = entry.step;
    if (s.kind === 'fill' && s.value !== undefined) {
      return { ...s, value: interpolateString(s.value, variables, defaults, missing) };
    }
    if (s.kind === 'type' && s.text !== undefined) {
      return { ...s, text: interpolateString(s.text, variables, defaults, missing) };
    }
    if (s.kind === 'select') {
      return { ...s, value: interpolateString(s.value, variables, defaults, missing) };
    }
    if (s.kind === 'wait' && s.text !== undefined) {
      return { ...s, text: interpolateString(s.text, variables, defaults, missing) };
    }
    return { ...s };
  });

  if (missing.size > 0) {
    throw new Error(
      `Missing required workflow variable(s): ${[...missing].join(', ')}. Pass them in "variables".`,
    );
  }

  return { startUrl, steps };
}

function escapeSingleQuoted(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function escapeTemplateLiteralChunk(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function formatVarExpr(name: string, sensitiveNames: Set<string>): string {
  const envKey = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (sensitiveNames.has(name)) {
    return `process.env.${envKey} ?? ''`;
  }
  return `vars.${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function formatTsValueExpr(raw: string, sensitiveNames: Set<string>): string {
  VAR_PLACEHOLDER_RE.lastIndex = 0;
  const fullVarMatch = /^\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}$/.exec(raw.trim());
  if (fullVarMatch?.[1]) {
    return formatVarExpr(fullVarMatch[1], sensitiveNames);
  }

  // Support embedded {{var}} placeholders inside URLs/text via template literal
  const matches = [...raw.matchAll(new RegExp(VAR_PLACEHOLDER_RE.source, 'g'))];
  if (matches.length > 0) {
    let out = '`';
    let lastIndex = 0;
    for (const match of matches) {
      const idx = match.index ?? 0;
      out += escapeTemplateLiteralChunk(raw.slice(lastIndex, idx));
      const varName = match[1]!;
      out += `\${${formatVarExpr(varName, sensitiveNames)}}`;
      lastIndex = idx + match[0].length;
    }
    out += escapeTemplateLiteralChunk(raw.slice(lastIndex));
    out += '`';
    return out;
  }

  return `'${escapeSingleQuoted(raw)}'`;
}

export function exportWorkflowToPlaywright(workflow: RecordedWorkflow): string {
  const paramNames = extractWorkflowParamNames(workflow);
  const sensitiveSet = new Set((workflow.parameters ?? []).filter((p) => p.sensitive).map((p) => p.name));
  const defaults = new Map((workflow.parameters ?? []).map((p) => [p.name, p.defaultValue ?? '']));

  const safeCommentName = workflow.name.replace(/[\r\n]+/g, ' ');
  const safeCommentId = workflow.id.replace(/[\r\n]+/g, ' ');
  const lines: string[] = [
    `import { test, expect } from '@playwright/test';`,
    '',
    '// Exported from Chrome Browser MCP Workflow Recorder',
    `// Workflow: ${safeCommentName} (${safeCommentId})`,
    `test('${escapeSingleQuoted(workflow.name)}', async ({ page }) => {`,
  ];

  const nonSensitiveParams = paramNames.filter((n) => !sensitiveSet.has(n));
  if (nonSensitiveParams.length > 0) {
    lines.push('  const vars = {');
    for (const name of nonSensitiveParams) {
      const envKey = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      const def = escapeSingleQuoted(defaults.get(name) ?? '');
      lines.push(`    ${name.replace(/[^A-Za-z0-9_]/g, '_')}: process.env.${envKey} ?? '${def}',`);
    }
    lines.push('  };', '');
  }

  if (workflow.startUrl) {
    lines.push(`  await page.goto(${formatTsValueExpr(workflow.startUrl, sensitiveSet)});`);
  }

  for (const entry of workflow.steps) {
    const s = entry.step;
    const locator =
      'selector' in s && s.selector
        ? `page.locator('${escapeSingleQuoted(s.selector)}')`
        : 'ref' in s && s.ref
          ? `page.locator('[data-mcp-ref="${escapeSingleQuoted(s.ref.replace(/"/g, '\\"'))}"]')`
          : null;

    if (entry.description) {
      lines.push(`  // ${entry.description.replace(/\r?\n/g, ' ')}`);
    }

    switch (s.kind) {
      case 'click':
        if (locator) {
          lines.push(`  await ${locator}.click();`);
        } else if (typeof s.x === 'number' && typeof s.y === 'number') {
          lines.push(`  await page.mouse.click(${Math.round(s.x)}, ${Math.round(s.y)});`);
        }
        break;
      case 'hover':
        if (locator) lines.push(`  await ${locator}.hover();`);
        break;
      case 'fill':
        if (locator) {
          const expr = entry.maskedSensitiveValue
            ? `process.env.SECRET_VALUE ?? ''`
            : s.secretRef
              ? `process.env.${s.secretRef
                  .replace(/^[^:]+:/, '')
                  .toUpperCase()
                  .replace(/[^A-Z0-9_]/g, '_')} ?? ''`
              : formatTsValueExpr(s.value ?? '', sensitiveSet);
          lines.push(`  await ${locator}.fill(${expr});`);
          if (s.submit) lines.push(`  await ${locator}.press('Enter');`);
        }
        break;
      case 'type':
        if (locator) {
          const expr = entry.maskedSensitiveValue
            ? `process.env.SECRET_VALUE ?? ''`
            : s.secretRef
              ? `process.env.${s.secretRef
                  .replace(/^[^:]+:/, '')
                  .toUpperCase()
                  .replace(/[^A-Z0-9_]/g, '_')} ?? ''`
              : formatTsValueExpr(s.text ?? '', sensitiveSet);
          lines.push(`  await ${locator}.pressSequentially(${expr}, { delay: ${s.delayMs} });`);
        }
        break;
      case 'press': {
        const combo = s.modifiers?.length ? `${s.modifiers.join('+')}+${s.key}` : s.key;
        lines.push(`  await page.keyboard.press('${escapeSingleQuoted(combo)}');`);
        break;
      }
      case 'select':
        if (locator) {
          lines.push(`  await ${locator}.selectOption(${formatTsValueExpr(s.value, sensitiveSet)});`);
        }
        break;
      case 'check':
        if (locator) {
          lines.push(`  await ${locator}.${s.checked ? 'check' : 'uncheck'}();`);
        }
        break;
      case 'scroll': {
        const dx = s.direction === 'left' ? -s.amount : s.direction === 'right' ? s.amount : 0;
        const dy = s.direction === 'up' ? -s.amount : s.direction === 'down' ? s.amount : 0;
        lines.push(`  await page.mouse.wheel(${dx}, ${dy});`);
        break;
      }
      case 'upload':
        if (locator) {
          const arr = s.files.map((f) => `'${escapeSingleQuoted(f)}'`).join(', ');
          lines.push(`  await ${locator}.setInputFiles([${arr}]);`);
        }
        break;
      case 'wait':
        if (s.selector) {
          lines.push(
            `  await page.locator('${escapeSingleQuoted(s.selector)}').waitFor({ timeout: ${s.timeoutMs} });`,
          );
        } else if (s.text) {
          lines.push(
            `  await expect(page.getByText(${formatTsValueExpr(s.text, sensitiveSet)})).toBeVisible({ timeout: ${s.timeoutMs} });`,
          );
        } else if (s.ms) {
          lines.push(`  await page.waitForTimeout(${s.ms});`);
        }
        break;
      case 'drag':
        lines.push(`  // Drag from ${s.sourceRef} to ${s.targetRef}`);
        break;
    }
  }

  lines.push('});', '');
  return lines.join('\n');
}
