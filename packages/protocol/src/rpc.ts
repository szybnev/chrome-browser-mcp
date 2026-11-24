import { z } from 'zod';
import {
  ActionStepSchema,
  ApprovalRequestSchema,
  BrowserProfileInfoSchema,
  ConsoleEntrySchema,
  NetworkEntrySchema,
  PendingDialogSchema,
  RecordedWorkflowSchema,
  SecurityPolicySchema,
  TabInfoSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// RPC methods invoked by Broker -> Extension
// ---------------------------------------------------------------------------

export const ExtensionRpcMethodSchema = z.enum([
  'ping',
  'tabs.list',
  'tabs.open',
  'tabs.close',
  'tabs.focus',
  'tabs.attach',
  'tabs.detach',
  'page.navigate',
  'page.snapshot',
  'page.read',
  'page.screenshot',
  'page.act',
  'page.dialog',
  'page.emulate',
  'devtools.console',
  'devtools.network',
  'devtools.networkBody',
  'devtools.eval',
  'devtools.audit',
  'browser.downloads',
  'cdp.raw',
  'webmcp.list',
  'webmcp.call',
  'state.setPaused',
  'state.updatePolicy',
  'state.syncApprovals',
  'workflows.list',
]);
export type ExtensionRpcMethod = z.infer<typeof ExtensionRpcMethodSchema>;

export const BrokerToExtensionMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rpc.request'),
    id: z.string(),
    method: ExtensionRpcMethodSchema,
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    type: z.literal('broker.welcome'),
    brokerVersion: z.string(),
    policy: SecurityPolicySchema,
    paused: z.boolean(),
  }),
  z.object({
    type: z.literal('broker.event'),
    event: z.enum(['approvals.updated', 'policy.updated', 'paused.updated', 'activity.updated']),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal('pong'),
    ts: z.number(),
  }),
]);
export type BrokerToExtensionMessage = z.infer<typeof BrokerToExtensionMessageSchema>;

export const ExtensionToBrokerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    token: z.string(),
    profile: BrowserProfileInfoSchema,
  }),
  z.object({
    type: z.literal('ping'),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('rpc.response'),
    id: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    errorCode: z.string().optional(),
  }),
  z.object({
    type: z.literal('event.tabs'),
    tabs: z.array(TabInfoSchema),
    tabGroupId: z.number().nullable(),
    allowAllTabs: z.boolean(),
  }),
  z.object({
    type: z.literal('event.console'),
    entry: ConsoleEntrySchema,
  }),
  z.object({
    type: z.literal('event.network'),
    entry: NetworkEntrySchema,
  }),
  z.object({
    type: z.literal('event.approvalDecision'),
    approvalId: z.string(),
    decision: z.enum(['approved', 'rejected']),
  }),
  z.object({
    type: z.literal('event.paused'),
    paused: z.boolean(),
  }),
  z.object({
    type: z.literal('event.policy'),
    policy: SecurityPolicySchema,
  }),
  z.object({
    type: z.literal('event.workflowSaved'),
    workflow: RecordedWorkflowSchema,
  }),
  z.object({
    type: z.literal('event.workflowDeleted'),
    workflowId: z.string(),
  }),
  z.object({
    type: z.literal('event.dialog'),
    tabId: z.number().int(),
    dialog: PendingDialogSchema.nullable(),
  }),
]);
export type ExtensionToBrokerMessage = z.infer<typeof ExtensionToBrokerMessageSchema>;

export const ExtensionApprovalSyncPayloadSchema = z.object({
  approvals: z.array(ApprovalRequestSchema),
});

export const ExtensionActParamsSchema = z.object({
  tabId: z.number().int().optional(),
  steps: z.array(ActionStepSchema).min(1).max(30),
  returnSnapshot: z.enum(['diff', 'full', 'none']).default('diff'),
  forceCdp: z.boolean().default(false),
  expectedOrigin: z.string().optional(),
});
export type ExtensionActParams = z.infer<typeof ExtensionActParamsSchema>;
