import { z } from 'zod';
import { APP_VERSION } from './version.js';

export const DEFAULT_BROKER_HOST = '127.0.0.1';
export const DEFAULT_BROKER_PORT = 43179;
export const PROTOCOL_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Profiles & Tabs
// ---------------------------------------------------------------------------

export const BrowserProfileInfoSchema = z.object({
  profileId: z.string().min(1),
  browserName: z.string().default('Chrome'),
  label: z.string().default('default'),
  extensionVersion: z.string().default(APP_VERSION),
  connectedAt: z.number(),
  lastSeenAt: z.number(),
  tabGroupId: z.number().nullable().default(null),
  allowAllTabs: z.boolean().default(false),
  paused: z.boolean().default(false),
  tabCount: z.number().int().nonnegative().default(0),
});
export type BrowserProfileInfo = z.infer<typeof BrowserProfileInfoSchema>;

export const TabInfoSchema = z.object({
  tabId: z.number().int(),
  windowId: z.number().int(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  inAgentGroup: z.boolean(),
  cdpAttached: z.boolean(),
  status: z.enum(['loading', 'complete', 'unloaded']).default('complete'),
  favIconUrl: z.string().optional(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

// ---------------------------------------------------------------------------
// Semantic Snapshot
// ---------------------------------------------------------------------------

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

export const SnapshotNodeSchema = z.object({
  ref: z.string(),
  role: z.string(),
  name: z.string(),
  tag: z.string(),
  value: z.string().optional(),
  placeholder: z.string().optional(),
  href: z.string().optional(),
  inputType: z.string().optional(),
  checked: z.boolean().optional(),
  disabled: z.boolean().optional(),
  expanded: z.boolean().optional(),
  selected: z.boolean().optional(),
  focused: z.boolean().optional(),
  interactive: z.boolean().default(true),
  inViewport: z.boolean().default(true),
  depth: z.number().int().nonnegative().default(0),
  bbox: BoundingBoxSchema.optional(),
  selectorHint: z.string().optional(),
  frameId: z.number().int().nonnegative().optional(),
  frameUrl: z.string().optional(),
  inShadowDom: z.boolean().optional(),
});
export type SnapshotNode = z.infer<typeof SnapshotNodeSchema>;

export const FrameSummarySchema = z.object({
  frameId: z.number().int().nonnegative(),
  url: z.string(),
  title: z.string().default(''),
});
export type FrameSummary = z.infer<typeof FrameSummarySchema>;

export const PageSnapshotSchema = z.object({
  snapshotId: z.string(),
  tabId: z.number().int(),
  url: z.string(),
  origin: z.string(),
  title: z.string(),
  timestamp: z.number(),
  engine: z.enum(['content-script', 'cdp', 'hybrid']),
  viewport: z.object({
    width: z.number(),
    height: z.number(),
    scrollX: z.number(),
    scrollY: z.number(),
    scrollHeight: z.number(),
  }),
  nodes: z.array(SnapshotNodeSchema),
  filteredHiddenCount: z.number().int().nonnegative().default(0),
  webMcpToolCount: z.number().int().nonnegative().default(0),
  frames: z.array(FrameSummarySchema).optional(),
});
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;

// ---------------------------------------------------------------------------
// Actions (Single & Batch)
// ---------------------------------------------------------------------------

export const ActionStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('click'),
    ref: z.string().optional(),
    selector: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    button: z.enum(['left', 'right', 'middle']).default('left'),
    clickCount: z.number().int().min(1).max(3).default(1),
    useCdp: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('hover'),
    ref: z.string().optional(),
    selector: z.string().optional(),
  }),
  z.object({
    kind: z.literal('fill'),
    ref: z.string().optional(),
    selector: z.string().optional(),
    value: z.string().optional(),
    secretRef: z.string().optional(),
    clearFirst: z.boolean().default(true),
    submit: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('type'),
    ref: z.string().optional(),
    selector: z.string().optional(),
    text: z.string().optional(),
    secretRef: z.string().optional(),
    delayMs: z.number().int().min(0).max(200).default(15),
  }),
  z.object({
    kind: z.literal('press'),
    key: z.string(),
    ref: z.string().optional(),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
  }),
  z.object({
    kind: z.literal('select'),
    ref: z.string().optional(),
    selector: z.string().optional(),
    value: z.string(),
  }),
  z.object({
    kind: z.literal('check'),
    ref: z.string().optional(),
    selector: z.string().optional(),
    checked: z.boolean(),
  }),
  z.object({
    kind: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']).default('down'),
    amount: z.number().int().min(50).max(5000).default(600),
    ref: z.string().optional(),
  }),
  z.object({
    kind: z.literal('drag'),
    sourceRef: z.string(),
    targetRef: z.string(),
  }),
  z.object({
    kind: z.literal('upload'),
    ref: z.string().optional(),
    selector: z.string().optional(),
    files: z.array(z.string().min(1)).min(1).max(20),
  }),
  z.object({
    kind: z.literal('wait'),
    ms: z.number().int().min(50).max(15000).optional(),
    selector: z.string().optional(),
    text: z.string().optional(),
    timeoutMs: z.number().int().min(200).max(30000).default(5000),
  }),
]);
export type ActionStep = z.infer<typeof ActionStepSchema>;

export const PendingDialogSchema = z.object({
  tabId: z.number().int(),
  type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
  message: z.string(),
  defaultPrompt: z.string().optional(),
  url: z.string().optional(),
  timestamp: z.number(),
});
export type PendingDialog = z.infer<typeof PendingDialogSchema>;

export const DownloadItemSchema = z.object({
  id: z.number().int(),
  filename: z.string(),
  url: z.string(),
  state: z.enum(['in_progress', 'interrupted', 'complete']),
  bytesReceived: z.number().nonnegative().default(0),
  totalBytes: z.number().default(-1),
  mime: z.string().optional(),
  startTime: z.string().optional(),
});
export type DownloadItem = z.infer<typeof DownloadItemSchema>;

export const EmulationConfigSchema = z.object({
  preset: z.enum(['desktop', 'iphone-15', 'pixel-9', 'ipad', 'reset']).optional(),
  width: z.number().int().min(240).max(3840).optional(),
  height: z.number().int().min(240).max(2160).optional(),
  deviceScaleFactor: z.number().min(0.5).max(4).optional(),
  mobile: z.boolean().optional(),
  colorScheme: z.enum(['light', 'dark', 'auto']).optional(),
  network: z.enum(['online', 'fast-3g', 'slow-3g', 'offline']).optional(),
  geolocation: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().min(1).max(10000).default(50),
    })
    .optional(),
});
export type EmulationConfig = z.infer<typeof EmulationConfigSchema>;

export const StepOutcomeSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.string(),
  ok: z.boolean(),
  engine: z.enum(['content-script', 'cdp']).optional(),
  detail: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative(),
});
export type StepOutcome = z.infer<typeof StepOutcomeSchema>;

export const BatchActResultSchema = z.object({
  tabId: z.number().int(),
  ok: z.boolean(),
  completedSteps: z.number().int().nonnegative(),
  totalSteps: z.number().int().nonnegative(),
  outcomes: z.array(StepOutcomeSchema),
  snapshot: PageSnapshotSchema.optional(),
  pendingDialog: PendingDialogSchema.optional(),
});
export type BatchActResult = z.infer<typeof BatchActResultSchema>;

// ---------------------------------------------------------------------------
// DevTools: Console, Network, Audit, Eval
// ---------------------------------------------------------------------------

export const ConsoleEntrySchema = z.object({
  id: z.string(),
  tabId: z.number().int(),
  level: z.enum(['log', 'info', 'warn', 'error', 'debug']),
  text: z.string(),
  source: z.string().optional(),
  line: z.number().optional(),
  timestamp: z.number(),
});
export type ConsoleEntry = z.infer<typeof ConsoleEntrySchema>;

export const NetworkEntrySchema = z.object({
  requestId: z.string(),
  tabId: z.number().int(),
  url: z.string(),
  method: z.string(),
  resourceType: z.string().optional(),
  status: z.number().int().optional(),
  statusText: z.string().optional(),
  failed: z.boolean().default(false),
  errorText: z.string().optional(),
  durationMs: z.number().optional(),
  mimeType: z.string().optional(),
  responsePreview: z.string().optional(),
  timestamp: z.number(),
});
export type NetworkEntry = z.infer<typeof NetworkEntrySchema>;

export const AuditResultSchema = z.object({
  tabId: z.number().int(),
  url: z.string(),
  accessibility: z.object({
    missingAltImages: z.number().int(),
    unlabeledControls: z.number().int(),
    missingHeadingH1: z.boolean(),
    duplicateIds: z.number().int(),
    issues: z.array(z.string()),
  }),
  performance: z.object({
    domContentLoadedMs: z.number().nullable(),
    loadEventMs: z.number().nullable(),
    domNodeCount: z.number().int(),
    largestContentfulPaintMs: z.number().nullable(),
    clsScore: z.number().nullable(),
  }),
  storage: z.object({
    localStorageKeys: z.array(z.string()),
    sessionStorageKeys: z.array(z.string()),
    cookieCount: z.number().int(),
  }),
});
export type AuditResult = z.infer<typeof AuditResultSchema>;

// ---------------------------------------------------------------------------
// WebMCP (navigator.modelContext)
// ---------------------------------------------------------------------------

export const WebMcpToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  readOnlyHint: z.boolean().optional(),
});
export type WebMcpToolInfo = z.infer<typeof WebMcpToolInfoSchema>;

// ---------------------------------------------------------------------------
// Workflow Recorder
// ---------------------------------------------------------------------------

export const WorkflowParameterSchema = z.object({
  name: z.string().min(1),
  defaultValue: z.string().optional(),
  description: z.string().optional(),
  sensitive: z.boolean().default(false),
});
export type WorkflowParameter = z.infer<typeof WorkflowParameterSchema>;

export const RecordedStepSchema = z.object({
  timestamp: z.number(),
  url: z.string(),
  description: z.string(),
  step: ActionStepSchema,
  maskedSensitiveValue: z.boolean().default(false),
});
export type RecordedStep = z.infer<typeof RecordedStepSchema>;

export const RecordedWorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  startUrl: z.string(),
  steps: z.array(RecordedStepSchema),
  parameters: z.array(WorkflowParameterSchema).optional(),
});
export type RecordedWorkflow = z.infer<typeof RecordedWorkflowSchema>;

// ---------------------------------------------------------------------------
// Security Policy & Human-in-the-Loop Approvals
// ---------------------------------------------------------------------------

export const DEFAULT_BLOCKED_DOMAINS = [
  'chrome://*',
  'chrome-extension://*',
  'about:*',
  '*.bankofamerica.com',
  '*.chase.com',
  '*.wellsfargo.com',
  '*.paypal.com',
  '*.stripe.com/dashboard*',
  '*.1password.com',
  '*.bitwarden.com',
  '*.lastpass.com',
  'online.sberbank.ru',
  '*.tbank.ru',
  '*.tinkoff.ru',
  '*.alfabank.ru',
];

export const READ_ONLY_DOMAIN_PRESETS = [
  'mail.google.com',
  'github.com',
  'linear.app',
  'notion.so',
] as const;

export const SecurityPolicySchema = z.object({
  scopeMode: z.enum(['agent-group', 'all-tabs']).default('agent-group'),
  blockedDomains: z.array(z.string()).default(DEFAULT_BLOCKED_DOMAINS),
  allowedDomains: z.array(z.string()).default([]),
  readOnlyDomains: z.array(z.string()).default([]),
  requireApprovalForEval: z.boolean().default(true),
  requireApprovalForPasswords: z.boolean().default(true),
  requireApprovalForPayments: z.boolean().default(true),
  requireApprovalForUploads: z.boolean().default(true),
  uploadAllowedDirs: z.array(z.string()).default([]),
  dialogPolicy: z.enum(['ask-agent', 'auto-dismiss', 'approval']).default('ask-agent'),
  cdpProxyEnabled: z.boolean().default(false),
  cdpIdleDetachSec: z.number().int().min(10).max(600).default(60),
  promptInjectionShield: z.boolean().default(true),
});
export type SecurityPolicy = z.infer<typeof SecurityPolicySchema>;

export const RiskLevelSchema = z.enum(['medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  tabId: z.number().int().optional(),
  origin: z.string(),
  action: z.string(),
  reason: z.string(),
  risk: RiskLevelSchema,
  preview: z.string(),
  createdAt: z.number(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).default('pending'),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ---------------------------------------------------------------------------
// Activity Feed & MCP App Deck State
// ---------------------------------------------------------------------------

export const ActivityEventSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  profileId: z.string(),
  tabId: z.number().int().optional(),
  url: z.string().optional(),
  tool: z.string(),
  summary: z.string(),
  status: z.enum(['running', 'ok', 'error', 'blocked']),
  engine: z.enum(['content-script', 'cdp', 'webmcp', 'broker']).optional(),
  durationMs: z.number().optional(),
  thumbnailDataUrl: z.string().optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ScreenshotRecordSchema = z.object({
  tabId: z.number().int(),
  url: z.string(),
  mimeType: z.string(),
  dataUrl: z.string(),
  setOfMark: z.boolean(),
  timestamp: z.number(),
});
export type ScreenshotRecord = z.infer<typeof ScreenshotRecordSchema>;

export const DeckStateSchema = z.object({
  brokerVersion: z.string(),
  brokerUrl: z.string(),
  paused: z.boolean(),
  defaultProfileId: z.string().nullable(),
  profiles: z.array(BrowserProfileInfoSchema),
  tabs: z.record(z.string(), z.array(TabInfoSchema)),
  policy: SecurityPolicySchema,
  pendingApprovals: z.array(ApprovalRequestSchema),
  pendingDialogs: z.record(z.string(), PendingDialogSchema).optional(),
  recentActivity: z.array(ActivityEventSchema),
  recentErrors: z.array(ConsoleEntrySchema),
  recentFailedNetwork: z.array(NetworkEntrySchema),
  workflows: z.array(RecordedWorkflowSchema),
  latestScreenshot: ScreenshotRecordSchema.nullable(),
});
export type DeckState = z.infer<typeof DeckStateSchema>;
