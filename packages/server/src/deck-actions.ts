import { spawn } from 'node:child_process';
import { type DeckState, SecurityPolicySchema } from '@chrome-browser-mcp/protocol';
import { z } from 'zod';
import type { BrowserHubInterface } from './hub.js';

export const DECK_TOOL_NAMES = [
  'deck_get_state',
  'deck_set_paused',
  'deck_select_profile',
  'deck_tab_action',
  'deck_resolve_approval',
  'deck_update_policy',
  'deck_delete_workflow',
  'deck_clear_diagnostics',
  'deck_create_pin',
  'deck_handle_dialog',
] as const;

export type DeckToolName = (typeof DECK_TOOL_NAMES)[number];

export interface DeckToolStructuredResult {
  state?: DeckState;
  pin?: string;
  expiresAt?: number;
  copied?: boolean;
}

export interface DeckToolExecutionResult {
  text: string;
  structuredContent: DeckToolStructuredResult;
}

export interface DeckPinCache {
  lastMintedPin: { pin: string; expiresAt: number } | null;
}

export function createDeckPinCache(): DeckPinCache {
  return { lastMintedPin: null };
}

export async function copySixDigitPinToClipboard(pin: string): Promise<boolean> {
  if (!/^\d{6}$/.test(pin) || process.env.VITEST === 'true') return false;
  const candidates: Array<{ cmd: string; args: string[] }> =
    process.platform === 'darwin'
      ? [{ cmd: 'pbcopy', args: [] }]
      : process.platform === 'win32'
        ? [{ cmd: 'clip', args: [] }]
        : [
            { cmd: 'wl-copy', args: [] },
            { cmd: 'xclip', args: ['-selection', 'clipboard'] },
            { cmd: 'xsel', args: ['--clipboard', '--input'] },
          ];

  for (const { cmd, args } of candidates) {
    const ok = await new Promise<boolean>((resolvePromise) => {
      let settled = false;
      const done = (val: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(val);
      };
      const timer = setTimeout(() => done(false), 1500);
      try {
        const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        child.once('error', () => done(false));
        child.once('close', (code) => done(code === 0));
        child.stdin?.once('error', () => done(false));
        child.stdin?.end(pin, 'utf8');
      } catch {
        done(false);
      }
    });
    if (ok) return true;
  }
  return false;
}

const DeckSetPausedInput = z.object({ paused: z.boolean() });
const DeckSelectProfileInput = z.object({ profileId: z.string() });
const DeckTabActionInput = z.object({
  profileId: z.string(),
  tabId: z.number().int(),
  action: z.enum(['attach', 'detach', 'focus', 'close']),
  bringToFront: z.boolean().optional(),
});
const DeckResolveApprovalInput = z.object({
  approvalId: z.string(),
  decision: z.enum(['approved', 'rejected']),
});
const DeckUpdatePolicyInput = SecurityPolicySchema.partial();
const DeckDeleteWorkflowInput = z.object({ workflowId: z.string() });
const DeckClearDiagnosticsInput = z.object({
  target: z.enum(['console', 'network', 'all']).default('all'),
});
const DeckCreatePinInput = z.object({ copyActive: z.boolean().optional() });
const DeckHandleDialogInput = z.object({
  profileId: z.string(),
  tabId: z.number().int(),
  accept: z.boolean(),
  promptText: z.string().optional(),
});

export function isDeckToolName(name: string): name is DeckToolName {
  return (DECK_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Unified executor for all 10 Browser Control Deck actions.
 * Used identically by MCP App app-only tools and authenticated `/internal/deck-tool` HTTP callers
 * (OpenChamber local service, OpenCode Desktop Electron main IPC, and Claude Mods).
 */
export async function executeDeckTool(
  hub: BrowserHubInterface,
  name: DeckToolName,
  rawArgs: Record<string, unknown> = {},
  pinCache: DeckPinCache = createDeckPinCache(),
): Promise<DeckToolExecutionResult> {
  switch (name) {
    case 'deck_get_state': {
      const state = await hub.getDeckState();
      return { text: 'ok', structuredContent: { state } };
    }

    case 'deck_set_paused': {
      const { paused } = DeckSetPausedInput.parse(rawArgs);
      await hub.setPaused(paused);
      const state = await hub.getDeckState();
      return { text: paused ? 'paused' : 'resumed', structuredContent: { state } };
    }

    case 'deck_select_profile': {
      const { profileId } = DeckSelectProfileInput.parse(rawArgs);
      await hub.selectDefaultProfile(profileId);
      const state = await hub.getDeckState();
      return { text: `selected ${profileId}`, structuredContent: { state } };
    }

    case 'deck_tab_action': {
      const { profileId, tabId, action, bringToFront } = DeckTabActionInput.parse(rawArgs);
      const map = {
        attach: 'tabs.attach',
        detach: 'tabs.detach',
        focus: 'tabs.focus',
        close: 'tabs.close',
      } as const;
      await hub.callExtension(
        map[action],
        { tabId, userInitiated: true, bringToFront: Boolean(bringToFront) },
        { profileId, skipPauseCheck: true },
      );
      const state = await hub.getDeckState();
      return { text: `tab ${tabId} ${action}`, structuredContent: { state } };
    }

    case 'deck_resolve_approval': {
      const { approvalId, decision } = DeckResolveApprovalInput.parse(rawArgs);
      await hub.resolveApproval(approvalId, decision);
      const state = await hub.getDeckState();
      return { text: `${approvalId}: ${decision}`, structuredContent: { state } };
    }

    case 'deck_update_policy': {
      const patch = DeckUpdatePolicyInput.parse(rawArgs);
      await hub.updatePolicy(patch);
      const state = await hub.getDeckState();
      return { text: 'policy updated', structuredContent: { state } };
    }

    case 'deck_delete_workflow': {
      const { workflowId } = DeckDeleteWorkflowInput.parse(rawArgs);
      await hub.deleteWorkflow(workflowId);
      const state = await hub.getDeckState();
      return { text: 'workflow deleted', structuredContent: { state } };
    }

    case 'deck_clear_diagnostics': {
      const { target } = DeckClearDiagnosticsInput.parse(rawArgs);
      await hub.clearDiagnostics(target);
      const state = await hub.getDeckState();
      return { text: `cleared ${target}`, structuredContent: { state } };
    }

    case 'deck_create_pin': {
      const { copyActive } = DeckCreatePinInput.parse(rawArgs);
      if (copyActive && pinCache.lastMintedPin && Date.now() < pinCache.lastMintedPin.expiresAt) {
        const copied = await copySixDigitPinToClipboard(pinCache.lastMintedPin.pin);
        return {
          text: copied ? 'Pairing PIN copied' : 'Pairing PIN ready',
          structuredContent: {
            pin: pinCache.lastMintedPin.pin,
            expiresAt: pinCache.lastMintedPin.expiresAt,
            copied,
          },
        };
      }
      const { pin, expiresAt } = await hub.createPairingPin();
      pinCache.lastMintedPin = { pin, expiresAt };
      const copied = await copySixDigitPinToClipboard(pin);
      return {
        text: copied
          ? 'Pairing PIN generated and copied to clipboard (valid 2 min)'
          : 'Pairing PIN generated (valid 2 min)',
        structuredContent: { pin, expiresAt, copied },
      };
    }

    case 'deck_handle_dialog': {
      const { profileId, tabId, accept, promptText } = DeckHandleDialogInput.parse(rawArgs);
      await hub.callExtension(
        'page.dialog',
        { action: accept ? 'accept' : 'dismiss', tabId, promptText },
        { profileId, skipPauseCheck: true },
      );
      const state = await hub.getDeckState();
      return { text: accept ? 'dialog accepted' : 'dialog dismissed', structuredContent: { state } };
    }
  }
}
