import type {
  ActionStep,
  AuditResult,
  PageSnapshot,
  RecordedStep,
  SnapshotNode,
} from '@chrome-browser-mcp/protocol';

declare global {
  interface Window {
    __CHROME_BROWSER_MCP_LOADED__?: boolean;
  }
}

if (!window.__CHROME_BROWSER_MCP_LOADED__) {
  window.__CHROME_BROWSER_MCP_LOADED__ = true;

  const refMap = new Map<string, Element>();
  let recordingActive = false;
  let visualHudEnabled = true;
  let hudHost: HTMLDivElement | null = null;
  let hudShadow: ShadowRoot | null = null;
  let somContainer: HTMLDivElement | null = null;
  let cursorEl: HTMLDivElement | null = null;
  let spotlightEl: HTMLDivElement | null = null;
  let spotlightTimer: ReturnType<typeof setTimeout> | null = null;

  // -------------------------------------------------------------------------
  // Isolated Shadow DOM Visual HUD (optional, enabled by default)
  // -------------------------------------------------------------------------

  function ensureHud(): ShadowRoot {
    if (hudShadow && hudHost?.isConnected) return hudShadow;
    hudHost = document.createElement('div');
    hudHost.id = 'chrome-browser-mcp-hud-host';
    hudHost.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;contain:layout style;';
    hudShadow = hudHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .frame {
        position: fixed; inset: 0; pointer-events: none;
        border: 2.5px solid rgba(56, 228, 212, 0.72);
        box-shadow: inset 0 0 18px rgba(56, 228, 212, 0.18);
        opacity: 0; transition: opacity 180ms ease;
      }
      .frame.active { opacity: 1; }
      .badge {
        position: fixed; top: 10px; right: 12px; pointer-events: none;
        background: rgba(15, 23, 42, 0.92); color: #e2f8f5;
        border: 1px solid rgba(56, 228, 212, 0.55);
        border-radius: 999px; padding: 4px 10px;
        font: 600 11px/1.3 system-ui, -apple-system, sans-serif;
        letter-spacing: 0.02em; display: none; align-items: center; gap: 7px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.32);
      }
      .badge.visible { display: inline-flex; }
      .badge-pause {
        pointer-events: auto; cursor: pointer;
        border: 1px solid rgba(248, 113, 113, 0.6);
        background: rgba(239, 68, 68, 0.18); color: #fecaca;
        border-radius: 999px; padding: 1px 7px;
        font: 700 10px/1.3 system-ui, -apple-system, sans-serif;
      }
      .badge-pause:hover { background: rgba(239, 68, 68, 0.35); color: #fff; }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #38e4d4; }
      .dot.rec { background: #ef4444; }
      .agent-cursor {
        position: fixed; top: 0; left: 0; width: 22px; height: 22px;
        pointer-events: none; opacity: 0;
        transform: translate3d(-40px, -40px, 0);
        transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease;
        filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.45));
      }
      .agent-cursor.visible { opacity: 1; }
      .target-spotlight {
        position: fixed; pointer-events: none; opacity: 0;
        border: 2px solid #38e4d4; border-radius: 6px;
        background: rgba(56, 228, 212, 0.12);
        box-shadow: 0 0 0 3px rgba(56, 228, 212, 0.16);
        transition: opacity 150ms ease, left 180ms ease, top 180ms ease, width 180ms ease, height 180ms ease;
      }
      .target-spotlight.visible { opacity: 1; }
      .ripple {
        position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px;
        border-radius: 50%; border: 2px solid #38e4d4;
        background: rgba(56, 228, 212, 0.25);
        transform: scale(0.4); opacity: 1;
        transition: transform 360ms ease-out, opacity 360ms ease-out;
      }
      .ripple.done { transform: scale(1.7); opacity: 0; }
      .toast {
        position: fixed; bottom: 18px; right: 18px;
        background: rgba(15, 23, 42, 0.94); color: #f8fafc;
        border: 1px solid rgba(56, 228, 212, 0.55);
        border-radius: 10px; padding: 8px 14px;
        font: 500 12px/1.4 system-ui, -apple-system, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,0.3);
        opacity: 0; transform: translateY(8px);
        transition: opacity 160ms ease, transform 160ms ease;
      }
      .toast.show { opacity: 1; transform: translateY(0); }
      .som-layer { position: fixed; inset: 0; pointer-events: none; }
      .som-tag {
        position: fixed;
        background: #0f172a; color: #38e4d4;
        border: 1px solid #38e4d4; border-radius: 4px;
        padding: 1px 4px; font: 700 10px/1.2 ui-monospace, monospace;
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      }
      @media (prefers-reduced-motion: reduce) {
        .agent-cursor, .target-spotlight, .ripple, .frame, .toast { transition: none !important; }
      }
    `;
    const frame = document.createElement('div');
    frame.className = 'frame';
    const badge = document.createElement('div');
    badge.className = 'badge';
    spotlightEl = document.createElement('div');
    spotlightEl.className = 'target-spotlight';
    cursorEl = document.createElement('div');
    cursorEl.className = 'agent-cursor';
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', 'M4 3 L19 11.5 L12.2 13.6 L9.5 20.5 Z');
    path.setAttribute('fill', '#38e4d4');
    path.setAttribute('stroke', '#0f172a');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    cursorEl.appendChild(svg);
    somContainer = document.createElement('div');
    somContainer.className = 'som-layer';
    hudShadow.append(style, frame, spotlightEl, cursorEl, badge, somContainer);
    document.documentElement.appendChild(hudHost);
    return hudShadow;
  }

  function hideVisualCursor(): void {
    cursorEl?.classList.remove('visible');
    spotlightEl?.classList.remove('visible');
    if (spotlightTimer) {
      clearTimeout(spotlightTimer);
      spotlightTimer = null;
    }
  }

  function setHudActive(active: boolean, label?: string, isRecording = false): void {
    requestAnimationFrame(() => {
      const show = active && (visualHudEnabled || isRecording);
      if (!show && !hudShadow) return;
      const shadow = ensureHud();
      const frame = shadow.querySelector('.frame');
      const badge = shadow.querySelector('.badge');
      frame?.classList.toggle('active', show);
      if (!show) hideVisualCursor();
      if (badge) {
        badge.classList.toggle('visible', show && Boolean(label));
        badge.textContent = '';
        if (show && label) {
          const dot = document.createElement('span');
          dot.className = isRecording ? 'dot rec' : 'dot';
          const text = document.createElement('span');
          text.textContent = label;
          badge.append(dot, text);
          if (!isRecording) {
            const pauseBtn = document.createElement('button');
            pauseBtn.type = 'button';
            pauseBtn.className = 'badge-pause';
            pauseBtn.textContent = 'Pause';
            pauseBtn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              void chrome.runtime.sendMessage({ type: 'cs.togglePause' }).catch(() => {});
            });
            badge.append(pauseBtn);
          }
        }
      }
    });
  }

  function moveAgentCursor(x: number, y: number, rect?: DOMRect): void {
    if (!visualHudEnabled) return;
    requestAnimationFrame(() => {
      ensureHud();
      if (cursorEl) {
        cursorEl.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        cursorEl.classList.add('visible');
      }
      if (spotlightEl && rect && rect.width > 1 && rect.height > 1) {
        spotlightEl.style.left = `${Math.max(0, Math.round(rect.left - 3))}px`;
        spotlightEl.style.top = `${Math.max(0, Math.round(rect.top - 3))}px`;
        spotlightEl.style.width = `${Math.round(rect.width + 6)}px`;
        spotlightEl.style.height = `${Math.round(rect.height + 6)}px`;
        spotlightEl.classList.add('visible');
        if (spotlightTimer) clearTimeout(spotlightTimer);
        spotlightTimer = setTimeout(() => {
          spotlightEl?.classList.remove('visible');
        }, 700);
      }
    });
  }

  function showClickPulse(x: number, y: number, rect?: DOMRect): void {
    if (!visualHudEnabled) return;
    moveAgentCursor(x, y, rect);
    requestAnimationFrame(() => {
      const shadow = ensureHud();
      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      shadow.appendChild(ripple);
      requestAnimationFrame(() => ripple.classList.add('done'));
      setTimeout(() => ripple.remove(), 420);
    });
  }

  function showToast(message: string): void {
    requestAnimationFrame(() => {
      const shadow = ensureHud();
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = message;
      shadow.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('show'));
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 220);
      }, 2400);
    });
  }

  async function renderSetOfMark(show: boolean): Promise<void> {
    if (show && refMap.size === 0) {
      buildSnapshot({ tabId: 0, includeOffscreen: false, maxNodes: 120 });
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        ensureHud();
        if (!somContainer) {
          resolve();
          return;
        }
        somContainer.textContent = '';
        if (!show) {
          requestAnimationFrame(() => resolve());
          return;
        }
        const entries = [...refMap.entries()].slice(0, 120);
        const frag = document.createDocumentFragment();
        for (const [ref, el] of entries) {
          if (!el.isConnected) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          if (
            rect.bottom < 0 ||
            rect.top > window.innerHeight ||
            rect.right < 0 ||
            rect.left > window.innerWidth
          ) {
            continue;
          }
          const tag = document.createElement('div');
          tag.className = 'som-tag';
          tag.textContent = ref;
          tag.style.left = `${Math.max(2, Math.round(rect.left))}px`;
          tag.style.top = `${Math.max(2, Math.round(rect.top))}px`;
          frag.appendChild(tag);
        }
        somContainer.appendChild(frag);
        // Force layout & wait a second compositor frame so captureVisibleTab/CDP captures the painted badges
        void somContainer.offsetHeight;
        requestAnimationFrame(() => resolve());
      });
    });
  }

  // -------------------------------------------------------------------------
  // Visibility & Prompt-Injection Shield Filtering
  // -------------------------------------------------------------------------

  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
  const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'option',
    'slider',
  ]);
  const LANDMARK_ROLES = new Set(['heading', 'dialog', 'alert', 'status']);
  const HEADING_TAG_RE = /^h[1-6]$/;

  function isElementHiddenOrTrap(el: Element): boolean {
    if (el.id === 'chrome-browser-mcp-hud-host') return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;

    // Native fast path (Chrome 105+): rejects display:none, visibility:hidden, opacity:0,
    // and content-visibility:hidden without calling getComputedStyle() or getBoundingClientRect().
    if (typeof (el as Element & { checkVisibility?: (opts?: Record<string, boolean>) => boolean }).checkVisibility === 'function') {
      const visible = (el as Element & { checkVisibility: (opts?: Record<string, boolean>) => boolean }).checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
      if (!visible) {
        // Double-check display:contents which checkVisibility reports as false even when children are visible
        if (window.getComputedStyle(el).display === 'contents') return false;
        return true;
      }
    }

    const style = window.getComputedStyle(el);
    if (style.display === 'contents') return false;
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      parseFloat(style.opacity || '1') <= 0.02
    ) {
      return true;
    }
    const fontSize = parseFloat(style.fontSize || '12');
    if (fontSize < 1 && el.children.length === 0) return true;
    const rect = el.getBoundingClientRect();
    const clipsChildren =
      style.overflow === 'hidden' ||
      style.overflow === 'clip' ||
      style.overflowX === 'hidden' ||
      style.overflowY === 'hidden';
    if (rect.width < 1 && rect.height < 1 && (el.children.length === 0 || clipsChildren)) {
      return true;
    }
    // Detect classic sr-only / offscreen hidden text traps (-9999px) on leaf or clipped nodes
    if ((rect.right < -500 || rect.bottom < -500) && (el.children.length === 0 || clipsChildren)) {
      return true;
    }
    return false;
  }

  function isInteractive(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    const tabIndex = el.getAttribute('tabindex');
    if (tabIndex !== null && Number(tabIndex) >= 0) return true;
    return false;
  }

  function isLandmarkOrHeading(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (HEADING_TAG_RE.test(tag)) return true;
    const role = el.getAttribute('role');
    return Boolean(role && LANDMARK_ROLES.has(role));
  }

  function inferRole(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return `heading-${tag[1]}`;
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type || 'text';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return tag;
  }

  function computeAccessibleName(el: Element): string {
    const ariaLabel = el.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() || '')
        .filter(Boolean)
        .join(' ');
      if (text) return text;
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.labels && el.labels.length > 0) {
        const labelText = [...el.labels]
          .map((l) => l.textContent?.trim() || '')
          .filter(Boolean)
          .join(' ');
        if (labelText) return labelText;
      }
      if ('placeholder' in el && el.placeholder) return el.placeholder.trim();
      if (el.name) return el.name;
    }

    const title = el.getAttribute('title')?.trim();
    if (title) return title;

    const alt = el.getAttribute('alt')?.trim();
    if (alt) return alt;

    const inner = (el as HTMLElement).innerText || el.textContent || '';
    return inner.replace(/\s+/g, ' ').trim().slice(0, 140);
  }

  function isEphemeralId(id: string): boolean {
    if (!id || id.length > 64) return true;
    // React useId (_R_..., :r0:, _r_...), Radix, HeadlessUI, MUI, Ember, UUIDs
    if (/^(_[Rr]_|:[rR]|react-|radix-|headlessui-|mui-|ember\d|el-id-)/.test(id)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return true;
    // Long random alphanumeric hash with mixed digits and letters
    if (id.length >= 16 && /\d/.test(id) && /[a-z]/i.test(id) && !/[-_]/.test(id)) return true;
    return false;
  }

  function isUniqueSelector(sel: string): boolean {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  }

  function buildSelectorHint(el: Element): string {
    const tag = el.tagName.toLowerCase();

    if (el.id && /^[A-Za-z_][\w-]*$/.test(el.id) && !isEphemeralId(el.id)) {
      const sel = `#${CSS.escape(el.id)}`;
      if (isUniqueSelector(sel)) return sel;
    }

    for (const attr of ['data-testid', 'data-test', 'data-cy'] as const) {
      const val = el.getAttribute(attr)?.trim();
      if (val) {
        const sel = `[${attr}="${CSS.escape(val)}"]`;
        if (isUniqueSelector(sel)) return sel;
      }
    }

    const name = el.getAttribute('name')?.trim();
    if (name) {
      const sel = `${tag}[name="${CSS.escape(name)}"]`;
      if (isUniqueSelector(sel)) return sel;
    }

    const aria = el.getAttribute('aria-label')?.trim();
    if (aria) {
      const sel = `${tag}[aria-label="${CSS.escape(aria.slice(0, 80))}"]`;
      if (isUniqueSelector(sel)) return sel;
    }

    if (tag === 'a') {
      const href = el.getAttribute('href')?.trim();
      if (href && href !== '#' && href.length <= 160 && !href.startsWith('javascript:')) {
        const sel = `a[href="${CSS.escape(href)}"]`;
        if (isUniqueSelector(sel)) return sel;
      }
    }

    const title = el.getAttribute('title')?.trim();
    if (title) {
      const sel = `${tag}[title="${CSS.escape(title.slice(0, 80))}"]`;
      if (isUniqueSelector(sel)) return sel;
    }

    const placeholder = el.getAttribute('placeholder')?.trim();
    if (placeholder) {
      const sel = `${tag}[placeholder="${CSS.escape(placeholder.slice(0, 80))}"]`;
      if (isUniqueSelector(sel)) return sel;
    }

    // Build shortest unique CSS ancestor path so Playwright strict mode matches exactly 1 element
    const segments: string[] = [];
    let cur: Element | null = el;
    let depth = 0;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur.tagName.toLowerCase() !== 'html' && depth < 8) {
      const curTag = cur.tagName.toLowerCase();
      if (cur !== el && cur.id && /^[A-Za-z_][\w-]*$/.test(cur.id) && !isEphemeralId(cur.id)) {
        const anchored = `#${CSS.escape(cur.id)} > ${segments.join(' > ')}`;
        if (isUniqueSelector(anchored)) return anchored;
      }
      const curTestId = cur !== el ? cur.getAttribute('data-testid')?.trim() : null;
      if (curTestId) {
        const anchored = `[data-testid="${CSS.escape(curTestId)}"] > ${segments.join(' > ')}`;
        if (isUniqueSelector(anchored)) return anchored;
      }

      const parent: Element | null = cur.parentElement;
      if (!parent) {
        segments.unshift(curTag);
        break;
      }
      const siblings = [...parent.children].filter((c) => c.tagName === cur!.tagName);
      const seg = siblings.length === 1 ? curTag : `${curTag}:nth-of-type(${siblings.indexOf(cur) + 1})`;
      segments.unshift(seg);

      const candidate = segments.join(' > ');
      if (isUniqueSelector(candidate)) return candidate;

      cur = parent;
      depth += 1;
    }

    return segments.join(' > ') || tag;
  }

  // -------------------------------------------------------------------------
  // Snapshot Builder
  // -------------------------------------------------------------------------

  function buildSnapshot(options: {
    tabId: number;
    includeOffscreen?: boolean;
    maxNodes?: number;
    refPrefix?: string;
    frameId?: number;
  }): PageSnapshot {
    refMap.clear();
    const maxNodes = options.maxNodes ?? 220;
    const includeOffscreen = options.includeOffscreen ?? false;
    const refPrefix = options.refPrefix ?? '';
    const frameId = options.frameId ?? 0;
    const nodes: SnapshotNode[] = [];
    let filteredHiddenCount = 0;
    let refCounter = 0;

    const visit = (el: Element, inShadowDom: boolean) => {
      if (nodes.length >= maxNodes) return;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg', 'path'].includes(tag)) return;

      const interactive = isInteractive(el);
      const landmark = isLandmarkOrHeading(el);
      if (!interactive && !landmark) return;

      if (isElementHiddenOrTrap(el)) {
        filteredHiddenCount += 1;
        return;
      }

      const rect = el.getBoundingClientRect();
      const inViewport =
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight &&
        rect.right >= 0 &&
        rect.left <= window.innerWidth;

      if (!includeOffscreen && !inViewport && !landmark) {
        return;
      }

      const name = computeAccessibleName(el);
      if (!interactive && !name) return;

      refCounter += 1;
      const ref = `${refPrefix}e${refCounter}`;
      refMap.set(ref, el);

      let depth = 0;
      let cur = el.parentElement;
      while (cur && depth < 6) {
        if (['main', 'nav', 'aside', 'section', 'form', 'dialog'].includes(cur.tagName.toLowerCase())) {
          depth += 1;
        }
        cur = cur.parentElement;
      }

      const inputEl = el instanceof HTMLInputElement ? el : null;
      const textAreaEl = el instanceof HTMLTextAreaElement ? el : null;
      const selectEl = el instanceof HTMLSelectElement ? el : null;
      const anchorEl = el instanceof HTMLAnchorElement ? el : null;

      nodes.push({
        ref,
        role: inferRole(el),
        name,
        tag,
        value: inputEl
          ? inputEl.type === 'checkbox' || inputEl.type === 'radio'
            ? undefined
            : inputEl.type === 'password'
              ? inputEl.value
                ? '••••••'
                : ''
              : inputEl.value
          : textAreaEl
            ? textAreaEl.value
            : selectEl
              ? selectEl.value
              : undefined,
        placeholder: inputEl?.placeholder || textAreaEl?.placeholder || undefined,
        href: anchorEl?.href || undefined,
        inputType: inputEl?.type || undefined,
        checked: inputEl && (inputEl.type === 'checkbox' || inputEl.type === 'radio') ? inputEl.checked : undefined,
        disabled:
          (inputEl?.disabled ?? textAreaEl?.disabled ?? selectEl?.disabled ?? false) ||
          el.getAttribute('aria-disabled') === 'true' ||
          undefined,
        expanded:
          el.hasAttribute('aria-expanded')
            ? el.getAttribute('aria-expanded') === 'true'
            : undefined,
        selected:
          el.hasAttribute('aria-selected')
            ? el.getAttribute('aria-selected') === 'true'
            : undefined,
        focused: document.activeElement === el || undefined,
        interactive,
        inViewport,
        depth,
        bbox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        selectorHint: buildSelectorHint(el),
        ...(frameId > 0 ? { frameId, frameUrl: location.href } : {}),
        ...(inShadowDom ? { inShadowDom: true } : {}),
      });
    };

    const traverseRoot = (root: Document | ShadowRoot | Element, inShadowDom = false) => {
      if (nodes.length >= maxNodes) return;
      const children = root.children;
      for (let i = 0; i < children.length && nodes.length < maxNodes; i++) {
        const child = children[i]!;
        if (child.id === 'chrome-browser-mcp-hud-host') continue;
        visit(child, inShadowDom);
        if (child.shadowRoot) {
          traverseRoot(child.shadowRoot, true);
        }
        // Iframes (both same-origin and cross-origin) are collected by the service worker
        // multi-frame collector with explicit f<frameId>:e<n> refs to prevent duplicate nodes.
        if (!(child instanceof HTMLIFrameElement)) {
          traverseRoot(child, inShadowDom);
        }
      }
    };

    if (document.body) {
      traverseRoot(document.body, false);
    } else if (document.documentElement) {
      traverseRoot(document.documentElement, false);
    }

    return {
      snapshotId: `snap-${Date.now().toString(36)}`,
      tabId: options.tabId,
      url: location.href,
      origin: location.origin,
      title: document.title,
      timestamp: Date.now(),
      engine: 'content-script',
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement.scrollHeight,
      },
      nodes,
      filteredHiddenCount,
      webMcpToolCount: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Clean Markdown Extractor (with hidden-node filtering)
  // -------------------------------------------------------------------------

  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'dialog', 'div',
    'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
    'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
    'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ]);

  function extractCodeLanguage(pre: Element): string {
    const codeEl = pre.querySelector('code') ?? pre;
    const cls = `${pre.className ?? ''} ${codeEl.className ?? ''}`;
    const match = cls.match(/\b(?:language|lang)-([a-z0-9_+#.-]+)/i);
    return match?.[1] ?? '';
  }

  function pickReadRoot(selector?: string, scope: 'main' | 'body' = 'main'): Element | null {
    if (selector) return document.querySelector(selector);
    if (scope === 'body') return document.body;

    const bodyTextLen = (document.body?.innerText ?? '').trim().length;
    const mainCandidate = document.querySelector('main, [role="main"]');
    if (mainCandidate) {
      const mainLen = ((mainCandidate as HTMLElement).innerText ?? '').trim().length;
      // Only lock onto <main> when it holds a meaningful portion of the page text
      if (bodyTextLen === 0 || mainLen >= bodyTextLen * 0.3) {
        return mainCandidate;
      }
    }

    const articles = document.querySelectorAll('article');
    if (articles.length === 1) {
      const artLen = ((articles[0] as HTMLElement).innerText ?? '').trim().length;
      if (bodyTextLen === 0 || artLen >= bodyTextLen * 0.45) {
        return articles[0]!;
      }
    }

    return document.body;
  }

  function extractMarkdown(options?: {
    selector?: string;
    maxChars?: number;
    offset?: number;
    scope?: 'main' | 'body';
  }): {
    markdown: string;
    totalChars: number;
    offset: number;
    returnedChars: number;
    hasMore: boolean;
    nextOffset: number | null;
    filteredHiddenCount: number;
    tabsSummary: string[];
    alternateLinks: string[];
  } {
    const maxChars = options?.maxChars ?? 30000;
    const offset = Math.max(0, options?.offset ?? 0);
    const scope = options?.scope ?? 'main';
    const root = pickReadRoot(options?.selector, scope);

    const tabsSummary = [...document.querySelectorAll('[role="tab"]')]
      .filter((t) => !isElementHiddenOrTrap(t))
      .slice(0, 20)
      .map((t) => {
        const label = computeAccessibleName(t).slice(0, 40);
        const sel = t.getAttribute('aria-selected') === 'true';
        return sel ? `${label} (selected)` : label;
      })
      .filter(Boolean);

    const alternateLinks = [...document.querySelectorAll('link[rel="alternate"]')]
      .map((l) => {
        const type = l.getAttribute('type') ?? '';
        const href = l.getAttribute('href') ?? '';
        return href ? `${type || 'alternate'}: ${href}` : '';
      })
      .filter(Boolean)
      .slice(0, 5);

    if (!root) {
      return {
        markdown: '',
        totalChars: 0,
        offset,
        returnedChars: 0,
        hasMore: false,
        nextOffset: null,
        filteredHiddenCount: 0,
        tabsSummary,
        alternateLinks,
      };
    }

    const lines: string[] = [];
    let filteredHiddenCount = 0;

    const hasBlockChild = (el: Element): boolean => {
      for (const child of el.children) {
        if (BLOCK_TAGS.has(child.tagName.toLowerCase())) return true;
      }
      return false;
    };

    const visibleInlineText = (el: Element): string => {
      let buf = '';
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          buf += child.textContent ?? '';
        } else if (child instanceof Element) {
          const t = child.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg', 'template'].includes(t)) continue;
          if (isElementHiddenOrTrap(child)) {
            filteredHiddenCount += 1;
            continue;
          }
          if (t === 'br') {
            buf += '\n';
          } else if (t === 'code') {
            const inner = visibleInlineText(child).trim();
            if (inner) buf += `\`${inner}\``;
          } else if (t === 'a' && child instanceof HTMLAnchorElement && child.href) {
            const label = visibleInlineText(child).trim();
            if (label) buf += `[${label}](${child.href})`;
          } else {
            buf += visibleInlineText(child);
          }
        }
      }
      return buf.replace(/[ \t]+/g, ' ');
    };

    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const txt = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (txt) lines.push(txt);
        return;
      }
      if (!(node instanceof Element)) return;

      const tag = node.tagName.toLowerCase();
      if (
        node.id === 'chrome-browser-mcp-hud-host' ||
        ['script', 'style', 'noscript', 'svg', 'template'].includes(tag)
      ) {
        return;
      }
      if (scope === 'main' && ['nav', 'footer'].includes(tag)) {
        return;
      }
      if (isElementHiddenOrTrap(node)) {
        filteredHiddenCount += 1;
        return;
      }

      if (tag === 'iframe' && node instanceof HTMLIFrameElement) {
        try {
          if (node.contentDocument?.body) {
            for (const c of node.contentDocument.body.childNodes) walk(c);
          }
        } catch {
          // Cross-origin iframe
        }
        return;
      }

      if (node.shadowRoot) {
        for (const c of node.shadowRoot.childNodes) walk(c);
      }

      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        const txt = visibleInlineText(node).trim();
        if (txt) lines.push(`\n${'#'.repeat(level)} ${txt}\n`);
        return;
      }
      if (tag === 'pre') {
        const code = node.textContent?.trim();
        const lang = extractCodeLanguage(node);
        if (code) lines.push(`\n\`\`\`${lang}\n${code}\n\`\`\`\n`);
        return;
      }
      if (tag === 'table') {
        const rows = [...node.querySelectorAll('tr')];
        for (let r = 0; r < rows.length; r++) {
          const row = rows[r]!;
          if (isElementHiddenOrTrap(row)) continue;
          const cells = [...row.querySelectorAll('th, td')].map((cell) =>
            visibleInlineText(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, ' '),
          );
          if (cells.length > 0) {
            lines.push(`| ${cells.join(' | ')} |`);
            if (r === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
          }
        }
        return;
      }
      if (tag === 'li') {
        if (!hasBlockChild(node)) {
          const txt = visibleInlineText(node).trim();
          if (txt) lines.push(`- ${txt}`);
          return;
        }
      }
      if (tag === 'dt') {
        const txt = visibleInlineText(node).trim();
        if (txt) lines.push(`\n**${txt}**`);
        return;
      }
      if (tag === 'dd') {
        const txt = visibleInlineText(node).trim();
        if (txt) lines.push(`: ${txt}`);
        return;
      }
      if (tag === 'p' || tag === 'blockquote') {
        const txt = visibleInlineText(node).trim();
        if (txt) lines.push(tag === 'blockquote' ? `> ${txt}` : `\n${txt}`);
        return;
      }
      if (BLOCK_TAGS.has(tag) && !hasBlockChild(node) && !node.shadowRoot) {
        const txt = visibleInlineText(node).trim();
        if (txt) lines.push(txt);
        return;
      }

      for (const child of node.childNodes) {
        walk(child);
      }
    };

    walk(root);
    const full = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const totalChars = full.length;
    const slice = full.slice(offset, offset + maxChars);
    const hasMore = offset + slice.length < totalChars;

    return {
      markdown: slice,
      totalChars,
      offset,
      returnedChars: slice.length,
      hasMore,
      nextOffset: hasMore ? offset + slice.length : null,
      filteredHiddenCount,
      tabsSummary,
      alternateLinks,
    };
  }

  // -------------------------------------------------------------------------
  // Structured Table & PDF Extraction (v2.0)
  // -------------------------------------------------------------------------

  interface ExtractedTable {
    caption?: string;
    headers: string[];
    rows: string[][];
  }

  function extractTablesFromRoot(root: Document | ShadowRoot | Element): ExtractedTable[] {
    const tables: ExtractedTable[] = [];
    const seen = new Set<Element>();

    const collect = (container: Document | ShadowRoot | Element) => {
      const found = container.querySelectorAll('table');
      for (const table of found) {
        if (seen.has(table) || isElementHiddenOrTrap(table)) continue;
        seen.add(table);
        const caption = table.querySelector('caption')?.textContent?.trim() || undefined;
        const trList = [...table.querySelectorAll('tr')].filter((r) => !isElementHiddenOrTrap(r));
        if (trList.length === 0) continue;
        let headers: string[] = [];
        const rows: string[][] = [];
        for (let i = 0; i < trList.length; i++) {
          const row = trList[i]!;
          const cells = [...row.querySelectorAll('th, td')].map((c) =>
            ((c as HTMLElement).innerText || c.textContent || '').replace(/\s+/g, ' ').trim(),
          );
          if (cells.length === 0) continue;
          if (i === 0 && (row.querySelector('th') !== null || row.parentElement?.tagName === 'THEAD')) {
            headers = cells;
          } else {
            rows.push(cells);
          }
        }
        if (headers.length === 0 && rows.length > 0) {
          headers = rows.shift()!;
        }
        if (headers.length > 0 || rows.length > 0) {
          tables.push({ caption, headers, rows });
        }
      }

      for (const el of container.querySelectorAll('*')) {
        if (el.id === 'chrome-browser-mcp-hud-host') continue;
        if (el.shadowRoot) collect(el.shadowRoot);
      }
    };

    collect(root);
    return tables;
  }

  function csvEscape(cell: string): string {
    if (/[",\n\r]/.test(cell)) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  }

  function formatTablesAsCsv(tables: ExtractedTable[]): string {
    return tables
      .map((t, idx) => {
        const headerLine = t.headers.map(csvEscape).join(',');
        const bodyLines = t.rows.map((r) => r.map(csvEscape).join(','));
        const prefix = tables.length > 1 ? `# Table ${idx + 1}${t.caption ? `: ${t.caption}` : ''}\n` : '';
        return `${prefix}${[headerLine, ...bodyLines].filter(Boolean).join('\n')}`;
      })
      .join('\n\n');
  }

  async function tryExtractPdfText(maxChars: number): Promise<string | null> {
    const isPdf =
      document.contentType === 'application/pdf' ||
      Boolean(document.querySelector('embed[type="application/pdf"]'));
    if (!isPdf) return null;

    // 1. Check PDF.js or embedded text layers first
    const textLayer = document.querySelector('.textLayer, #viewer');
    if (textLayer && textLayer.textContent && textLayer.textContent.trim().length > 20) {
      return textLayer.textContent.replace(/\s+/g, ' ').trim().slice(0, maxChars);
    }

    // 2. Lightweight same-origin PDF literal-string text extraction
    try {
      const resp = await fetch(location.href, { credentials: 'include' });
      if (!resp.ok) return null;
      const buf = new Uint8Array(await resp.arrayBuffer());
      const latin = new TextDecoder('latin1').decode(buf.subarray(0, Math.min(buf.length, 2_000_000)));
      const chunks: string[] = [];
      const btBlocks = latin.match(/BT[\s\S]*?ET/g) ?? [];
      for (const block of btBlocks) {
        const matches = block.match(/\((?:\\.|[^()\\]){1,240}\)/g) ?? [];
        for (const m of matches) {
          const decoded = m
            .slice(1, -1)
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '')
            .replace(/\\t/g, ' ')
            .replace(/\\\(/g, '(')
            .replace(/\\\)/g, ')')
            .replace(/\\\\/g, '\\');
          if (/[\p{L}\p{N}]/u.test(decoded)) chunks.push(decoded);
        }
      }
      const combined = chunks.join(' ').replace(/\s+/g, ' ').trim();
      if (combined.length > 20) {
        return combined.slice(0, maxChars);
      }
      return '[PDF detected: document uses compressed/image streams; download the PDF via browser_downloads or inspect visually with browser_screenshot.]';
    } catch {
      return '[PDF detected: unable to fetch raw PDF bytes in page context; use browser_screenshot or browser_downloads.]';
    }
  }

  // -------------------------------------------------------------------------
  // Action Helpers (Hybrid: resolves coords for CDP + fallback JS execution)
  // -------------------------------------------------------------------------

  function querySelectorDeep(selector: string, root: Document | ShadowRoot = document): Element | null {
    try {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    } catch {
      return null;
    }
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el.id === 'chrome-browser-mcp-hud-host') continue;
      if (el.shadowRoot) {
        const hit = querySelectorDeep(selector, el.shadowRoot);
        if (hit) return hit;
      }
    }
    return null;
  }

  function resolveTarget(ref?: string, selector?: string): Element | null {
    if (ref) {
      const el = refMap.get(ref);
      if (el && el.isConnected) return el;
    }
    if (selector) {
      return querySelectorDeep(selector);
    }
    return null;
  }

  function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function executeContentStep(step: ActionStep): Promise<{
    ok: boolean;
    detail?: string;
    error?: string;
    coords?: { x: number; y: number };
    needsCdpClick?: boolean;
  }> {
    if (step.kind === 'wait') {
      if (step.ms) {
        await new Promise((r) => setTimeout(r, step.ms));
        return { ok: true, detail: `Waited ${step.ms}ms` };
      }
      const checkMatch = (): string | null => {
        if (step.selector && document.querySelector(step.selector)) {
          return `Selector "${step.selector}" appeared`;
        }
        if (step.text && document.body?.innerText.includes(step.text)) {
          return `Text "${step.text}" appeared`;
        }
        return null;
      };
      const immediate = checkMatch();
      if (immediate) return { ok: true, detail: immediate };

      const timeoutMs = step.timeoutMs ?? 5000;
      const matched = await new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (val: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          observer.disconnect();
          resolve(val);
        };
        const observer = new MutationObserver(() => {
          const hit = checkMatch();
          if (hit) finish(hit);
        });
        const root = document.documentElement || document;
        observer.observe(root, {
          childList: true,
          subtree: true,
          characterData: Boolean(step.text),
          attributes: Boolean(step.selector),
        });
        const timer = setTimeout(() => finish(checkMatch()), timeoutMs);
      });
      if (matched) return { ok: true, detail: matched };
      return { ok: false, error: `Wait timed out after ${timeoutMs}ms` };
    }

    if (step.kind === 'scroll') {
      const target = step.ref ? resolveTarget(step.ref) : null;
      const dx = step.direction === 'right' ? step.amount : step.direction === 'left' ? -step.amount : 0;
      const dy = step.direction === 'down' ? step.amount : step.direction === 'up' ? -step.amount : 0;
      if (target) {
        target.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
      } else {
        window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
      }
      return { ok: true, detail: `Scrolled ${step.direction} ${step.amount}px` };
    }

    if (step.kind === 'click') {
      if (step.x !== undefined && step.y !== undefined) {
        showClickPulse(step.x, step.y);
        return { ok: true, coords: { x: step.x, y: step.y }, needsCdpClick: true };
      }
      const el = resolveTarget(step.ref, step.selector);
      if (!el) return { ok: false, error: `Element not found (${step.ref || step.selector})` };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      showClickPulse(x, y, rect);
      if (step.useCdp) {
        return { ok: true, coords: { x, y }, needsCdpClick: true, detail: `Target (${x}, ${y})` };
      }
      if (el instanceof HTMLElement) {
        el.focus({ preventScroll: true });
        el.click();
      } else {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      }
      return { ok: true, coords: { x, y }, detail: `Clicked ${step.ref || step.selector}` };
    }

    if (step.kind === 'hover') {
      const el = resolveTarget(step.ref, step.selector);
      if (!el) return { ok: false, error: `Element not found (${step.ref || step.selector})` };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      moveAgentCursor(x, y, rect);
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: x, clientY: y }));
      return { ok: true, coords: { x, y }, detail: `Hovered ${step.ref || step.selector}` };
    }

    if (step.kind === 'fill' || step.kind === 'type') {
      const el = resolveTarget(step.ref, step.selector);
      if (!el) return { ok: false, error: `Input element not found (${step.ref || step.selector})` };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      if (el instanceof HTMLElement) el.focus();
      const rect = el.getBoundingClientRect();
      showClickPulse(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2), rect);

      const textVal = (step.kind === 'fill' ? step.value : step.text) ?? '';
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const nextVal = step.kind === 'fill' && step.clearFirst ? textVal : `${el.value}${textVal}`;
        setNativeValue(el, nextVal);
        if (step.kind === 'fill' && step.submit && el.form) {
          el.form.requestSubmit();
        }
        return { ok: true, detail: `Entered ${textVal.length} chars into ${step.ref || step.selector}` };
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        el.textContent = step.kind === 'fill' && step.clearFirst ? textVal : `${el.textContent ?? ''}${textVal}`;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: textVal }));
        return { ok: true, detail: `Updated contenteditable ${step.ref || step.selector}` };
      }
      return { ok: false, error: 'Target element is not an editable input' };
    }

    if (step.kind === 'select') {
      const el = resolveTarget(step.ref, step.selector);
      if (!(el instanceof HTMLSelectElement)) {
        return { ok: false, error: `Select element not found (${step.ref || step.selector})` };
      }
      el.value = step.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: `Selected "${step.value}"` };
    }

    if (step.kind === 'check') {
      const el = resolveTarget(step.ref, step.selector);
      if (!(el instanceof HTMLInputElement)) {
        return { ok: false, error: `Checkbox/radio not found (${step.ref || step.selector})` };
      }
      if (el.checked !== step.checked) {
        el.click();
      }
      return { ok: true, detail: `Set checked=${step.checked}` };
    }

    if (step.kind === 'press') {
      const el = (step.ref ? resolveTarget(step.ref) : document.activeElement) || document.body;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: step.key, bubbles: true, cancelable: true }));
      if (step.key === 'Enter' && el instanceof HTMLInputElement && el.form) {
        el.form.requestSubmit();
      }
      return { ok: true, detail: `Pressed ${step.key}` };
    }

    if (step.kind === 'drag') {
      const src = resolveTarget(step.sourceRef);
      const dst = resolveTarget(step.targetRef);
      if (!src || !dst) return { ok: false, error: 'Drag source or target not found' };
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return { ok: true, detail: `Dragged ${step.sourceRef} -> ${step.targetRef}` };
    }

    return { ok: false, error: 'Unsupported action step' };
  }

  // -------------------------------------------------------------------------
  // Quick Page Audit (a11y + Performance + Storage Keys)
  // -------------------------------------------------------------------------

  async function readBufferedPerfEntries<T extends PerformanceEntry>(type: string): Promise<T[]> {
    if (typeof PerformanceObserver === 'undefined') return [];
    const supported = PerformanceObserver.supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes(type)) return [];

    return await new Promise<T[]>((resolve) => {
      const collected: T[] = [];
      let done = false;
      const finish = (obs?: PerformanceObserver) => {
        if (done) return;
        done = true;
        try {
          obs?.disconnect();
        } catch {
          // ignore
        }
        resolve(collected);
      };
      try {
        const obs = new PerformanceObserver((list) => {
          collected.push(...(list.getEntries() as T[]));
        });
        obs.observe({ type, buffered: true });
        setTimeout(() => finish(obs), 30);
      } catch {
        finish();
      }
    });
  }

  async function runAudit(tabId: number): Promise<AuditResult> {
    const imgs = [...document.querySelectorAll('img')];
    const missingAltImages = imgs.filter((img) => !img.hasAttribute('alt')).length;

    const controls = [...document.querySelectorAll('button, input, select, textarea')];
    const unlabeledControls = controls.filter((c) => !computeAccessibleName(c)).length;

    const missingHeadingH1 = document.querySelectorAll('h1').length === 0;

    const idCounts = new Map<string, number>();
    for (const el of document.querySelectorAll('[id]')) {
      idCounts.set(el.id, (idCounts.get(el.id) ?? 0) + 1);
    }
    const duplicateIds = [...idCounts.values()].filter((count) => count > 1).length;

    const issues: string[] = [];
    if (missingAltImages > 0) issues.push(`${missingAltImages} <img> element(s) missing alt attribute`);
    if (unlabeledControls > 0) issues.push(`${unlabeledControls} interactive control(s) missing accessible name`);
    if (missingHeadingH1) issues.push('Page has no <h1> heading');
    if (duplicateIds > 0) issues.push(`${duplicateIds} duplicate id attribute(s) found`);

    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const [lcpEntries, layoutShifts] = await Promise.all([
      readBufferedPerfEntries<PerformanceEntry>('largest-contentful-paint'),
      readBufferedPerfEntries<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>('layout-shift'),
    ]);
    const lastLcp = lcpEntries[lcpEntries.length - 1];
    const clsScore =
      layoutShifts.length > 0
        ? Number(
            layoutShifts
              .filter((s) => !s.hadRecentInput)
              .reduce((sum, s) => sum + (s.value ?? 0), 0)
              .toFixed(4),
          )
        : null;

    let localStorageKeys: string[] = [];
    let sessionStorageKeys: string[] = [];
    try {
      localStorageKeys = Object.keys(localStorage).slice(0, 50);
      sessionStorageKeys = Object.keys(sessionStorage).slice(0, 50);
    } catch {
      // Blocked in sandboxed frames
    }

    const cookieCount = document.cookie
      ? document.cookie.split(';').filter((c) => c.trim().length > 0).length
      : 0;

    return {
      tabId,
      url: location.href,
      accessibility: {
        missingAltImages,
        unlabeledControls,
        missingHeadingH1,
        duplicateIds,
        issues,
      },
      performance: {
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadEventMs: nav ? Math.round(nav.loadEventEnd) : null,
        domNodeCount: document.getElementsByTagName('*').length,
        largestContentfulPaintMs: lastLcp ? Math.round(lastLcp.startTime) : null,
        clsScore,
      },
      storage: {
        localStorageKeys,
        sessionStorageKeys,
        cookieCount,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Workflow Recorder ("Show by hand")
  // -------------------------------------------------------------------------

  function emitRecordedStep(step: RecordedStep): void {
    void chrome.runtime.sendMessage({ type: 'recorder.step', step }).catch(() => {});
  }

  const onRecordClick = (ev: MouseEvent) => {
    if (!recordingActive || !ev.isTrusted) return;
    const target = ev.target instanceof Element ? ev.target.closest('button, a, [role="button"], input[type="submit"], input[type="checkbox"], input[type="radio"], summary') || ev.target : null;
    if (!target || target.id === 'chrome-browser-mcp-hud-host') return;
    if (target instanceof HTMLInputElement && !['submit', 'button', 'checkbox', 'radio'].includes(target.type)) {
      return;
    }
    const selector = buildSelectorHint(target);
    const label = computeAccessibleName(target) || target.tagName.toLowerCase();
    emitRecordedStep({
      timestamp: Date.now(),
      url: location.href,
      description: `Click "${label.slice(0, 60)}"`,
      step: {
        kind: 'click',
        selector,
        button: 'left',
        clickCount: 1,
      },
      maskedSensitiveValue: false,
    });
  };

  const onRecordChange = (ev: Event) => {
    if (!recordingActive || !ev.isTrusted) return;
    const target = ev.target;
    if (target instanceof HTMLSelectElement) {
      const selector = buildSelectorHint(target);
      emitRecordedStep({
        timestamp: Date.now(),
        url: location.href,
        description: `Select "${target.value}" in ${computeAccessibleName(target) || selector}`,
        step: { kind: 'select', selector, value: target.value },
        maskedSensitiveValue: false,
      });
      return;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const selector = buildSelectorHint(target);
      const isPassword = target instanceof HTMLInputElement && target.type === 'password';
      const maskedVal = isPassword ? '{{PASSWORD}}' : target.value;
      emitRecordedStep({
        timestamp: Date.now(),
        url: location.href,
        description: `Fill "${computeAccessibleName(target) || selector}"`,
        step: {
          kind: 'fill',
          selector,
          value: maskedVal,
          clearFirst: true,
          submit: false,
        },
        maskedSensitiveValue: isPassword,
      });
    }
  };

  function setRecording(enabled: boolean): void {
    recordingActive = enabled;
    if (enabled) {
      document.addEventListener('click', onRecordClick, true);
      document.addEventListener('change', onRecordChange, true);
      setHudActive(true, 'REC Workflow', true);
    } else {
      document.removeEventListener('click', onRecordClick, true);
      document.removeEventListener('change', onRecordChange, true);
      setHudActive(false);
    }
  }

  // -------------------------------------------------------------------------
  // Message Listener from Service Worker
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'cs.ping':
            sendResponse({ ok: true });
            return;
          case 'cs.snapshot':
            sendResponse({ ok: true, data: buildSnapshot(msg.params) });
            return;
          case 'cs.read': {
            const format = String(msg.params?.format ?? 'markdown');
            const maxChars = Number(msg.params?.maxChars ?? 30_000);
            if (format === 'tables_json' || format === 'tables_csv') {
              const root = pickReadRoot(msg.params?.selector, msg.params?.scope === 'body' ? 'body' : 'main') ?? document;
              const tables = extractTablesFromRoot(root);
              const rendered =
                format === 'tables_json'
                  ? JSON.stringify(tables, null, 2)
                  : formatTablesAsCsv(tables);
              const slice = rendered.slice(0, maxChars);
              sendResponse({
                ok: true,
                data: {
                  markdown: slice,
                  totalChars: rendered.length,
                  offset: 0,
                  returnedChars: slice.length,
                  hasMore: slice.length < rendered.length,
                  nextOffset: slice.length < rendered.length ? slice.length : null,
                  filteredHiddenCount: 0,
                  tabsSummary: [],
                  alternateLinks: [],
                  tableCount: tables.length,
                  url: location.href,
                  origin: location.origin,
                  title: document.title,
                },
              });
              return;
            }

            const pdfText = await tryExtractPdfText(maxChars);
            if (pdfText !== null) {
              sendResponse({
                ok: true,
                data: {
                  markdown: pdfText,
                  totalChars: pdfText.length,
                  offset: 0,
                  returnedChars: pdfText.length,
                  hasMore: false,
                  nextOffset: null,
                  filteredHiddenCount: 0,
                  tabsSummary: [],
                  alternateLinks: [],
                  isPdf: true,
                  url: location.href,
                  origin: location.origin,
                  title: document.title || 'PDF Document',
                },
              });
              return;
            }

            sendResponse({
              ok: true,
              data: {
                ...extractMarkdown({
                  selector: msg.params?.selector,
                  maxChars,
                  offset: msg.params?.offset,
                  scope: msg.params?.scope,
                }),
                url: location.href,
                origin: location.origin,
                title: document.title,
              },
            });
            return;
          }
          case 'cs.resolveCoords': {
            if (typeof msg.params?.hudEnabled === 'boolean') {
              visualHudEnabled = msg.params.hudEnabled;
            }
            const el = resolveTarget(msg.params?.ref, msg.params?.selector);
            if (!el) {
              sendResponse({ ok: false, error: 'Element not found' });
              return;
            }
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const rect = el.getBoundingClientRect();
            const coords = {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              selectorHint: buildSelectorHint(el),
            };
            showClickPulse(coords.x, coords.y, rect);
            sendResponse({ ok: true, data: coords });
            return;
          }
          case 'cs.actStep': {
            if (typeof msg.params?.hudEnabled === 'boolean') {
              visualHudEnabled = msg.params.hudEnabled;
            }
            const res = await executeContentStep(msg.params.step as ActionStep);
            sendResponse({ ok: true, data: res });
            return;
          }
          case 'cs.audit':
            sendResponse({ ok: true, data: await runAudit(msg.params.tabId) });
            return;
          case 'cs.hud':
            if (typeof msg.params?.hudEnabled === 'boolean') {
              visualHudEnabled = msg.params.hudEnabled;
            }
            setHudActive(Boolean(msg.params?.active), msg.params?.label, Boolean(msg.params?.recording));
            sendResponse({ ok: true });
            return;
          case 'cs.setHudEnabled':
            visualHudEnabled = Boolean(msg.params?.enabled);
            if (!visualHudEnabled) {
              setHudActive(false);
            }
            sendResponse({ ok: true });
            return;
          case 'cs.toast':
            showToast(String(msg.params?.message ?? ''));
            sendResponse({ ok: true });
            return;
          case 'cs.setOfMark':
            await renderSetOfMark(Boolean(msg.params?.show));
            sendResponse({ ok: true });
            return;
          case 'cs.setRecording':
            setRecording(Boolean(msg.params?.enabled));
            sendResponse({ ok: true });
            return;
          default:
            sendResponse({ ok: false, error: `Unknown content script command: ${String(msg.type)}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  });
}
