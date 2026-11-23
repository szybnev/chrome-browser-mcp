import type { PageSnapshot, SnapshotNode } from './schemas.js';

// Zero-allocation field comparison instead of building joined signature strings
function areNodesEqual(a: SnapshotNode, b: SnapshotNode): boolean {
  return (
    a.role === b.role &&
    a.name === b.name &&
    (a.value ?? '') === (b.value ?? '') &&
    (a.href ?? '') === (b.href ?? '') &&
    a.checked === b.checked &&
    Boolean(a.disabled) === Boolean(b.disabled) &&
    a.expanded === b.expanded &&
    Boolean(a.selected) === Boolean(b.selected) &&
    Boolean(a.focused) === Boolean(b.focused)
  );
}

export function formatSnapshotNodeLine(node: SnapshotNode): string {
  const indent = '  '.repeat(Math.min(node.depth, 5));
  const parts: string[] = [`${indent}[${node.ref}] ${node.role}`];
  if (node.name) {
    parts.push(`"${node.name.replace(/\s+/g, ' ').slice(0, 140)}"`);
  }
  if (node.inputType && node.inputType !== 'text') {
    parts.push(`type=${node.inputType}`);
  }
  if (node.value !== undefined && node.value !== '') {
    const safeVal = node.inputType === 'password' ? '••••••' : node.value.slice(0, 100);
    parts.push(`val="${safeVal}"`);
  } else if (node.placeholder) {
    parts.push(`placeholder="${node.placeholder.slice(0, 80)}"`);
  }
  if (node.href) {
    parts.push(`href=${node.href.slice(0, 120)}`);
  }
  const flags: string[] = [];
  if (node.checked === true) flags.push('checked');
  if (node.disabled) flags.push('disabled');
  if (node.expanded === true) flags.push('expanded');
  if (node.expanded === false) flags.push('collapsed');
  if (node.selected) flags.push('selected');
  if (node.focused) flags.push('focused');
  if (!node.inViewport) flags.push('offscreen');
  if (flags.length > 0) {
    parts.push(`(${flags.join(',')})`);
  }
  return parts.join(' ');
}

export function formatFullSnapshot(snapshot: PageSnapshot, maxNodes = 250): string {
  const { viewport } = snapshot;
  const scrollPct =
    viewport.scrollHeight > viewport.height
      ? Math.round((viewport.scrollY / Math.max(1, viewport.scrollHeight - viewport.height)) * 100)
      : 0;

  const lines: string[] = [
    `PAGE: ${snapshot.title} | ${snapshot.url}`,
    `VIEWPORT: ${viewport.width}x${viewport.height} scroll=${scrollPct}% engine=${snapshot.engine} nodes=${snapshot.nodes.length}${snapshot.webMcpToolCount > 0 ? ` webmcp_tools=${snapshot.webMcpToolCount}` : ''}`,
  ];

  const limit = Math.min(snapshot.nodes.length, maxNodes);
  for (let i = 0; i < limit; i++) {
    lines.push(formatSnapshotNodeLine(snapshot.nodes[i]!));
  }
  if (snapshot.nodes.length > maxNodes) {
    lines.push(
      `... (${snapshot.nodes.length - maxNodes} more nodes truncated; scroll or narrow query)`,
    );
  }
  return lines.join('\n');
}

export interface SnapshotDiffSummary {
  urlChanged: boolean;
  added: SnapshotNode[];
  changed: SnapshotNode[];
  removedRefs: string[];
  formatted: string;
}

export function computeSnapshotDiff(
  previous: PageSnapshot | undefined,
  current: PageSnapshot,
  maxNodes = 250,
): SnapshotDiffSummary {
  if (!previous || previous.url !== current.url) {
    return {
      urlChanged: true,
      added: current.nodes,
      changed: [],
      removedRefs: [],
      formatted: formatFullSnapshot(current, maxNodes),
    };
  }

  // Single-map diff: deleting matched refs leaves removedRefs with half the allocations
  const remainingPrev = new Map<string, SnapshotNode>();
  for (const node of previous.nodes) {
    remainingPrev.set(node.ref, node);
  }

  const added: SnapshotNode[] = [];
  const changed: SnapshotNode[] = [];

  for (const node of current.nodes) {
    const old = remainingPrev.get(node.ref);
    if (!old) {
      added.push(node);
    } else {
      remainingPrev.delete(node.ref);
      if (!areNodesEqual(old, node)) {
        changed.push(node);
      }
    }
  }

  const removedRefs = remainingPrev.size > 0 ? Array.from(remainingPrev.keys()) : [];

  // If >60% of the page changed, emit full snapshot instead of a noisy diff
  const deltaSize = added.length + changed.length + removedRefs.length;
  if (current.nodes.length > 0 && deltaSize > current.nodes.length * 0.6) {
    return {
      urlChanged: false,
      added,
      changed,
      removedRefs,
      formatted: formatFullSnapshot(current, maxNodes),
    };
  }

  const lines: string[] = [
    `SNAPSHOT DIFF: ${current.title} | ${current.url} (+${added.length} ~${changed.length} -${removedRefs.length}, total=${current.nodes.length})`,
  ];

  if (deltaSize === 0) {
    lines.push('(No interactive DOM/a11y changes since previous snapshot)');
  } else {
    for (const node of added.slice(0, 80)) {
      lines.push(`+ ${formatSnapshotNodeLine(node).trimStart()}`);
    }
    for (const node of changed.slice(0, 80)) {
      lines.push(`~ ${formatSnapshotNodeLine(node).trimStart()}`);
    }
    if (removedRefs.length > 0) {
      lines.push(
        `- removed refs: ${removedRefs.slice(0, 40).join(', ')}${removedRefs.length > 40 ? ' ...' : ''}`,
      );
    }
  }

  return {
    urlChanged: false,
    added,
    changed,
    removedRefs,
    formatted: lines.join('\n'),
  };
}
