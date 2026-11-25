// plugins/claude/src/register.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// packages/protocol/dist/i18n.js
var EN = {
  "app.title": "Chrome Browser MCP",
  "app.subtitle": "Local AI Browser Control",
  "app.loading": "Loading Chrome Browser MCP Control HUD\u2026",
  "app.deckTitle": "Browser Control Deck",
  "status.connected": "Connected",
  "status.offline": "Offline",
  "status.paused": "Automation Paused",
  "status.pausedDesc": "All external MCP actions are blocked until you resume.",
  "status.idle": "Idle",
  "status.on": "ON",
  "status.off": "OFF",
  "status.copied": "Copied!",
  "status.saved": "Saved!",
  "status.savedTo": "Saved to {path}",
  "status.clickToCopy": "Click to copy",
  "btn.pause": "Pause",
  "btn.pauseAll": "Pause All",
  "btn.resume": "Resume",
  "btn.refresh": "Refresh",
  "btn.focus": "Focus",
  "btn.attach": "Attach",
  "btn.detach": "Detach",
  "btn.attachActive": "+ Attach Active",
  "btn.attachToAgent": "Attach to Agent",
  "btn.save": "Save",
  "btn.discard": "Discard",
  "btn.approve": "Approve",
  "btn.reject": "Reject",
  "btn.accept": "Accept",
  "btn.dismiss": "Dismiss",
  "btn.clear": "Clear",
  "btn.delete": "Delete",
  "btn.exportPlaywright": "Export .spec.ts",
  "btn.exportJson": "Export JSON",
  "btn.exportHtml": "Export HTML",
  "btn.replayTour": "Replay Guided Tour",
  "btn.openWelcome": "Setup Wizard",
  "btn.openPairPage": "Get 6-Digit PIN",
  "btn.generatePin": "Generate PIN",
  "btn.connect": "Connect",
  "btn.next": "Next",
  "btn.back": "Back",
  "btn.skip": "Skip",
  "btn.finish": "Finish",
  "tab.control": "Control",
  "tab.overview": "Overview",
  "tab.timeline": "Timeline",
  "tab.devtools": "DevTools",
  "tab.recorder": "Recorder",
  "tab.workflows": "Workflows",
  "tab.security": "Security",
  "tab.connect": "Pair",
  "section.agentTabs": "AI Agent Tabs",
  "section.otherTabs": "All Browser Tabs",
  "section.approvals": "Approval Required",
  "section.pendingDialog": "Pending Browser Dialog",
  "section.advancedSettings": "Advanced Settings",
  "section.advancedConnection": "Advanced Connection",
  "section.optionalPermissions": "Optional Chrome Permissions",
  "section.latestCapture": "Latest Viewport Capture",
  "section.consoleErrors": "Console Errors & Warnings",
  "section.failedNetwork": "Failed Network Requests",
  "section.savedWorkflows": "Saved Workflows",
  "setting.allowAllTabs": "Allow all tabs in window",
  "setting.allowAllTabsInfo": 'By default, AI agents can only access tabs inside the cyan "AI Agent" tab group. Enable this to allow access to any tab in the window (blocked domains still stay protected).',
  "setting.visualHud": "Visual Agent Cursor & Page Highlight",
  "setting.visualHudDesc": "Show animated cursor, element spotlight, and clickable Pause button while AI acts.",
  "setting.visualHudActive": "Enabled: animated cursor, element highlight, and in-page Pause button",
  "setting.visualHudSilent": "Silent mode: no on-page cursor or highlights during agent actions",
  "setting.shield": "Prompt-Injection Shield",
  "setting.shieldInfo": "Filters hidden/zero-opacity/offscreen DOM traps, strips invisible Unicode characters, and wraps page text in UNTRUSTED_PAGE_CONTENT boundaries.",
  "setting.approvalEval": "Approve JS Eval on new origins",
  "setting.approvalEvalInfo": "Requires explicit Approve/Reject confirmation the first time an agent runs arbitrary JavaScript on a website origin.",
  "setting.approvalPasswords": "Approve password & secret autofill",
  "setting.approvalPasswordsInfo": "Pauses for your confirmation before filling any password input or resolving a Zero-Secret reference.",
  "setting.approvalPayments": "Approve payment & checkout actions",
  "setting.approvalPaymentsInfo": "Pauses before clicking buttons related to checkout, payments, fund transfers, or account deletion.",
  "setting.approvalUploads": "Approve local file uploads",
  "setting.approvalUploadsInfo": "Requires confirmation before attaching local files from your computer to any web form.",
  "setting.language": "Interface Language",
  "setting.readOnlyDomains": "Read-Only Domains (one per line)",
  "setting.readOnlyOptional": "Read-Only Domains (optional)",
  "setting.readOnlyHint": "Reading is allowed; clicks, typing, and JS eval require explicit approval.",
  "setting.readOnlyInfo": "Domains where reading snapshots, text, and screenshots is allowed, while clicks, typing, uploads, and JS execution require approval. Format: example.com or *.example.com/path*.",
  "setting.blockedDomains": "Blocked Domains (one per line)",
  "setting.blockedDomainsInfo": 'Wildcard rules (e.g. chrome://*, *.paypal.com) that completely block AI access even if "Allow all tabs" is enabled.',
  "setting.dialogPolicy": "JS Dialog Policy (alert / confirm / prompt)",
  "setting.dialogPolicyInfo": "Controls how native browser dialogs are handled: pass to agent (browser_dialog), dismiss automatically, or ask for user approval.",
  "setting.dialogAsk": "Ask agent",
  "setting.dialogDismiss": "Auto-dismiss",
  "setting.dialogApproval": "Require approval",
  "setting.cdpDetach": "CDP Idle Auto-Detach (sec)",
  "setting.cdpDetachInfo": "Seconds of inactivity (10\u2013600) before chrome.debugger automatically detaches so Chrome hides the yellow debugger banner.",
  "setting.cdpProxy": "Enable Local CDP Proxy (/json/version)",
  "setting.cdpProxyDesc": "Allow external Playwright / Puppeteer scripts to attach via 127.0.0.1 while enforcing AI Tab Group, blocklist, read-only rules, and Pause.",
  "setting.downloadsPerm": "Downloads tracking (browser_downloads)",
  "setting.downloadsPermInfo": 'Grants optional Chrome "downloads" permission so agents can list recent downloads or wait for a file download to finish.',
  "setting.nativeHostPerm": "Native Messaging Host transport",
  "setting.nativeHostPermInfo": 'Grants optional Chrome "nativeMessaging" permission to connect via a local Native Messaging Host instead of loopback WebSocket.',
  "btn.askAgentFix": "Ask Agent to Fix",
  "btn.askAgentDebug": "Ask Agent to Debug",
  "deck.workflowsDesc": "Record multi-step flows in Chrome Side Panel, attach them to your conversation, or replay with {{variables}} via MCP.",
  "deck.securityTitle": "Security & Guardrails",
  "deck.blockedSummary": "Blocked domains",
  "deck.waitingActions": "Waiting for agent browser actions\u2026",
  "tour.playwrightDocs": "Learn more in Playwright docs \u2197",
  "val.domainComma": 'Line {line} ("{val}"): enter one rule per line without spaces or commas.',
  "val.domainInvalid": 'Line {line} ("{val}"): invalid domain pattern (e.g. example.com, *.example.com, chrome://*).',
  "val.wsUrlProtocol": "WebSocket URL must start with ws:// or wss://.",
  "val.wsUrlLoopback": "For security, only local loopback hosts (127.0.0.1, localhost, ::1) are allowed.",
  "val.wsUrlInvalid": "Enter a valid local WebSocket URL (e.g. ws://127.0.0.1:43179/ws).",
  "val.labelEmpty": "Profile label cannot be empty.",
  "val.labelLength": "Profile label must be 32 characters or fewer.",
  "val.labelChars": 'Profile label may contain only letters, digits, spaces, ".", "-", "_".',
  "val.tokenEmpty": "Pairing token cannot be empty.",
  "val.tokenWhitespace": "Pairing token must not contain spaces or newlines.",
  "val.tokenShort": "Pairing token looks too short (expected at least 16 characters).",
  "val.pinInvalid": "Enter a valid 6-digit numeric PIN.",
  "val.cdpIdleRange": "Enter a whole number between 10 and 600 seconds.",
  "val.workflowNameLength": "Workflow name must be 80 characters or fewer.",
  "val.savedRules": "Saved {count} rule(s).",
  "pair.pinTitle": "Connect with 6-Digit PIN",
  "pair.pinSimpleHint": 'Click "Generate PIN" in Browser Control Deck (Antigravity) or run the CLI command below, then enter the 6 digits:',
  "pair.cliRepoHint": "Run inside the cloned chrome-browser-mcp repository folder:",
  "pair.pinPlaceholder": "123456",
  "pair.pinButton": "Connect",
  "pair.brokerDetected": "Local MCP ready on 127.0.0.1",
  "pair.brokerOffline": "Local MCP offline \u2014 start the local daemon first",
  "pair.profileLabel": "Profile Label",
  "pair.wsUrl": "Local MCP WebSocket URL",
  "pair.token": "Manual Pairing Token",
  "pair.tokenPlaceholder": "Paste token printed by the command above",
  "pair.saveConnect": "Save & Connect",
  "pair.pairedOk": "Connected! Moving to the next step\u2026",
  "pair.savedReconnecting": "Connection settings saved \u2014 connecting\u2026",
  "empty.agentTabs": "No tabs attached yet. Click + Attach Active above or Attach on any tab below.",
  "empty.matchingTabs": "No matching tabs.",
  "empty.timeline": "No actions recorded in this session yet.",
  "empty.workflows": "No saved workflows yet.",
  "empty.console": "No console warnings or errors captured yet.",
  "empty.network": "No failed network requests captured.",
  "filter.tabsPlaceholder": "Filter tabs by title, URL, or ID\u2026",
  "label.tabsCount": "tabs",
  "label.profilesCount": "profiles",
  "label.steps": "steps",
  "label.vars": "vars",
  "recorder.start": "Start Recording",
  "recorder.stop": "Stop & Save",
  "recorder.namePlaceholder": "Workflow name (e.g. Create Jira Ticket)",
  "recorder.varsHint": "Use {{variable}} placeholders in step values for parameterized MCP replay.",
  "recorder.restrictedUrl": "Cannot record on browser system pages (chrome://, extensions, Web Store). Switch to an http:// or https:// tab first.",
  "tour.step1.title": "1. AI Agent Tab Group",
  "tour.step1.body": "Only tabs you explicitly attach here are visible to AI agents. Your private tabs stay isolated by default.",
  "tour.step2.title": "2. Instant Emergency Pause",
  "tour.step2.body": "Click Pause or press {shortcut} anytime to freeze all agent actions immediately.",
  "tour.step3.title": "3. Workflow Recorder & Playwright Export",
  "tour.step3.body": "Demonstrate repetitive flows by hand, add {{variables}}, replay via MCP, or export clean Playwright tests.",
  "tour.step4.title": "4. Security & Visual Cursor Settings",
  "tour.step4.body": "Toggle the in-page Visual Agent Cursor, manage Prompt-Injection Shield, or open Advanced Settings for Read-Only domains.",
  "welcome.heroTitle": "Welcome to Chrome Browser MCP",
  "welcome.heroSub": "Connect local AI coding assistants to your real logged-in browser tabs \u2014 100% local-first.",
  "welcome.step1": "Language & Theme",
  "welcome.step2": "Pair Local Broker",
  "welcome.step3": "Safety & Visuals",
  "welcome.step4": "Launch Panel",
  "welcome.localTitle": "100% Local-First",
  "welcome.localDesc": "Strict 127.0.0.1 loopback connection. Zero cloud servers, zero telemetry, and dedicated AI Agent tab isolation.",
  "welcome.howTitle": "How it works in 30 seconds",
  "welcome.how1": "Connect the extension to your local MCP (works with Antigravity, Claude Code, Cursor, and Codex).",
  "welcome.how2": "Attach only the tabs you want AI to access \u2014 all other tabs remain private.",
  "welcome.how3Prefix": "Press",
  "welcome.how3Suffix": "anytime for instant emergency pause.",
  "welcome.readyTitle": "All set!",
  "welcome.readyDesc": "Click below to open the Control HUD Side Panel and take a quick 4-step guided tour of Tab Isolation, Emergency Pause, Workflow Recorder, and Security settings.",
  "welcome.openHud": "Open Control HUD & Start Guided Tour"
};
var RU = {
  "app.title": "Chrome Browser MCP",
  "app.subtitle": "\u041B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 AI-\u043C\u043E\u0441\u0442 \u0434\u043B\u044F \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430",
  "app.loading": "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u043F\u0430\u043D\u0435\u043B\u0438 \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F Chrome Browser MCP\u2026",
  "app.deckTitle": "\u041F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u043E\u043C",
  "status.connected": "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E",
  "status.offline": "\u041D\u0435\u0442 \u0441\u0432\u044F\u0437\u0438",
  "status.paused": "\u0410\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0437\u0430\u0446\u0438\u044F \u043D\u0430 \u043F\u0430\u0443\u0437\u0435",
  "status.pausedDesc": "\u0412\u0441\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F AI-\u0430\u0433\u0435\u043D\u0442\u043E\u0432 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u044B, \u043F\u043E\u043A\u0430 \u0432\u044B \u043D\u0435 \u043D\u0430\u0436\u043C\u0451\u0442\u0435 \xAB\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C\xBB.",
  "status.idle": "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435",
  "status.on": "\u0412\u041A\u041B",
  "status.off": "\u0412\u042B\u041A\u041B",
  "status.copied": "\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u043E!",
  "status.saved": "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E!",
  "status.savedTo": "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E \u0432 {path}",
  "status.clickToCopy": "\u041D\u0430\u0436\u043C\u0438\u0442\u0435, \u0447\u0442\u043E\u0431\u044B \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
  "btn.pause": "\u041F\u0430\u0443\u0437\u0430",
  "btn.pauseAll": "\u041F\u0430\u0443\u0437\u0430",
  "btn.resume": "\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C",
  "btn.refresh": "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C",
  "btn.focus": "\u041F\u0435\u0440\u0435\u0439\u0442\u0438",
  "btn.attach": "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C",
  "btn.detach": "\u041E\u0442\u043A\u043B\u044E\u0447\u0438\u0442\u044C",
  "btn.attachActive": "+ \u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0432\u043A\u043B\u0430\u0434\u043A\u0430",
  "btn.attachToAgent": "\u041F\u0435\u0440\u0435\u0434\u0430\u0442\u044C \u0430\u0433\u0435\u043D\u0442\u0443",
  "btn.save": "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C",
  "btn.discard": "\u041E\u0442\u043C\u0435\u043D\u0438\u0442\u044C",
  "btn.approve": "\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u044C",
  "btn.reject": "\u041E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C",
  "btn.accept": "\u041F\u0440\u0438\u043D\u044F\u0442\u044C",
  "btn.dismiss": "\u0417\u0430\u043A\u0440\u044B\u0442\u044C",
  "btn.clear": "\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C",
  "btn.delete": "\u0423\u0434\u0430\u043B\u0438\u0442\u044C",
  "btn.exportPlaywright": "\u042D\u043A\u0441\u043F\u043E\u0440\u0442 .spec.ts",
  "btn.exportJson": "\u042D\u043A\u0441\u043F\u043E\u0440\u0442 JSON",
  "btn.exportHtml": "\u042D\u043A\u0441\u043F\u043E\u0440\u0442 HTML",
  "btn.replayTour": "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C \u0442\u0443\u0440",
  "btn.openWelcome": "\u041C\u0430\u0441\u0442\u0435\u0440 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438",
  "btn.openPairPage": "\u041F\u043E\u043B\u0443\u0447\u0438\u0442\u044C 6-\u0437\u043D\u0430\u0447\u043D\u044B\u0439 PIN",
  "btn.generatePin": "\u0421\u043E\u0437\u0434\u0430\u0442\u044C PIN",
  "btn.connect": "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C",
  "btn.next": "\u0414\u0430\u043B\u0435\u0435",
  "btn.back": "\u041D\u0430\u0437\u0430\u0434",
  "btn.skip": "\u041F\u0440\u043E\u043F\u0443\u0441\u0442\u0438\u0442\u044C",
  "btn.finish": "\u0413\u043E\u0442\u043E\u0432\u043E",
  "tab.control": "\u0423\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435",
  "tab.overview": "\u041E\u0431\u0437\u043E\u0440",
  "tab.timeline": "\u0418\u0441\u0442\u043E\u0440\u0438\u044F",
  "tab.devtools": "\u041E\u0442\u043B\u0430\u0434\u043A\u0430",
  "tab.recorder": "\u0417\u0430\u043F\u0438\u0441\u044C",
  "tab.workflows": "\u0421\u0446\u0435\u043D\u0430\u0440\u0438\u0438",
  "tab.security": "\u0417\u0430\u0449\u0438\u0442\u0430",
  "tab.connect": "\u0421\u0432\u044F\u0437\u044C",
  "section.agentTabs": "\u0412\u043A\u043B\u0430\u0434\u043A\u0438 AI-\u0430\u0433\u0435\u043D\u0442\u0430",
  "section.otherTabs": "\u041E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u0432\u043A\u043B\u0430\u0434\u043A\u0438 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430",
  "section.approvals": "\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435",
  "section.pendingDialog": "\u041E\u0442\u043A\u0440\u044B\u0442 \u0434\u0438\u0430\u043B\u043E\u0433 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430",
  "section.advancedSettings": "\u0420\u0430\u0441\u0448\u0438\u0440\u0435\u043D\u043D\u044B\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438",
  "section.advancedConnection": "\u0420\u0443\u0447\u043D\u043E\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435",
  "section.optionalPermissions": "\u0414\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043F\u0440\u0430\u0432\u0430 Chrome",
  "section.latestCapture": "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u0441\u043D\u0438\u043C\u043E\u043A \u044D\u043A\u0440\u0430\u043D\u0430",
  "section.consoleErrors": "\u041E\u0448\u0438\u0431\u043A\u0438 \u0438 \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u044F \u043A\u043E\u043D\u0441\u043E\u043B\u0438",
  "section.failedNetwork": "\u041E\u0448\u0438\u0431\u043A\u0438 \u0441\u0435\u0442\u0435\u0432\u044B\u0445 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432",
  "section.savedWorkflows": "\u0421\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0435 \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u0438",
  "setting.allowAllTabs": "\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F \u043A\u043E \u0432\u0441\u0435\u043C \u0432\u043A\u043B\u0430\u0434\u043A\u0430\u043C \u043E\u043A\u043D\u0430",
  "setting.allowAllTabsInfo": "\u041F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E AI-\u0430\u0433\u0435\u043D\u0442 \u0432\u0438\u0434\u0438\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043A\u043B\u0430\u0434\u043A\u0438 \u0432 \u0433\u0440\u0443\u043F\u043F\u0435 \xABAI Agent\xBB. \u0412\u043A\u043B\u044E\u0447\u0438\u0442\u0435, \u0447\u0442\u043E\u0431\u044B \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F \u043A\u043E \u0432\u0441\u0435\u043C \u0432\u043A\u043B\u0430\u0434\u043A\u0430\u043C \u043E\u043A\u043D\u0430 (\u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0435 \u0434\u043E\u043C\u0435\u043D\u044B \u0432\u0441\u0451 \u0440\u0430\u0432\u043D\u043E \u0437\u0430\u0449\u0438\u0449\u0435\u043D\u044B).",
  "setting.visualHud": "\u0412\u0438\u0437\u0443\u0430\u043B\u044C\u043D\u044B\u0439 \u043A\u0443\u0440\u0441\u043E\u0440 \u0438 \u043F\u043E\u0434\u0441\u0432\u0435\u0442\u043A\u0430 \u043D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435",
  "setting.visualHudDesc": "\u041F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0442\u044C \u0430\u043D\u0438\u043C\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u043A\u0443\u0440\u0441\u043E\u0440, \u0440\u0430\u043C\u043A\u0443 \u0432\u043E\u043A\u0440\u0443\u0433 \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430 \u0438 \u043A\u043D\u043E\u043F\u043A\u0443 \u043F\u0430\u0443\u0437\u044B \u0432\u043E \u0432\u0440\u0435\u043C\u044F \u0440\u0430\u0431\u043E\u0442\u044B AI.",
  "setting.visualHudActive": "\u0412\u043A\u043B\u044E\u0447\u0435\u043D\u043E: \u0430\u043D\u0438\u043C\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u043A\u0443\u0440\u0441\u043E\u0440, \u043F\u043E\u0434\u0441\u0432\u0435\u0442\u043A\u0430 \u0446\u0435\u043B\u0438 \u0438 \u043A\u043D\u043E\u043F\u043A\u0430 \u043F\u0430\u0443\u0437\u044B \u043D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435",
  "setting.visualHudSilent": "\u0422\u0438\u0445\u0438\u0439 \u0440\u0435\u0436\u0438\u043C: \u0431\u0435\u0437 \u043A\u0443\u0440\u0441\u043E\u0440\u0430 \u0438 \u043F\u043E\u0434\u0441\u0432\u0435\u0442\u043A\u0438 \u043D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435 \u0432\u043E \u0432\u0440\u0435\u043C\u044F \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439 \u0430\u0433\u0435\u043D\u0442\u0430",
  "setting.shield": "\u0417\u0430\u0449\u0438\u0442\u0430 \u043E\u0442 Prompt Injection",
  "setting.shieldInfo": "\u041E\u0442\u0444\u0438\u043B\u044C\u0442\u0440\u043E\u0432\u044B\u0432\u0430\u0435\u0442 \u0441\u043A\u0440\u044B\u0442\u044B\u0435 \u0438 \u043D\u0435\u0432\u0438\u0434\u0438\u043C\u044B\u0435 DOM-\u043B\u043E\u0432\u0443\u0448\u043A\u0438, \u0443\u0434\u0430\u043B\u044F\u0435\u0442 \u043D\u0435\u0432\u0438\u0434\u0438\u043C\u044B\u0435 \u0441\u0438\u043C\u0432\u043E\u043B\u044B Unicode \u0438 \u043E\u0431\u043E\u0440\u0430\u0447\u0438\u0432\u0430\u0435\u0442 \u0442\u0435\u043A\u0441\u0442 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B \u0432 \u043C\u0430\u0440\u043A\u0435\u0440\u044B UNTRUSTED_PAGE_CONTENT.",
  "setting.approvalEval": "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0442\u044C \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 JS \u043D\u0430 \u043D\u043E\u0432\u044B\u0445 \u0434\u043E\u043C\u0435\u043D\u0430\u0445",
  "setting.approvalEvalInfo": "\u0417\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0435\u0442 \u044F\u0432\u043D\u043E\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u043F\u0440\u0438 \u043F\u0435\u0440\u0432\u043E\u043C \u0437\u0430\u043F\u0443\u0441\u043A\u0435 \u043F\u0440\u043E\u0438\u0437\u0432\u043E\u043B\u044C\u043D\u043E\u0433\u043E JavaScript \u0430\u0433\u0435\u043D\u0442\u043E\u043C \u043D\u0430 \u043D\u043E\u0432\u043E\u043C \u0441\u0430\u0439\u0442\u0435.",
  "setting.approvalPasswords": "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0442\u044C \u0432\u0432\u043E\u0434 \u043F\u0430\u0440\u043E\u043B\u0435\u0439 \u0438 \u0441\u0435\u043A\u0440\u0435\u0442\u043E\u0432",
  "setting.approvalPasswordsInfo": "\u041E\u0441\u0442\u0430\u043D\u0430\u0432\u043B\u0438\u0432\u0430\u0435\u0442 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u0438 \u0437\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0435\u0442 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u043F\u0435\u0440\u0435\u0434 \u0432\u0432\u043E\u0434\u043E\u043C \u0434\u0430\u043D\u043D\u044B\u0445 \u0432 \u043F\u043E\u043B\u0435 \u043F\u0430\u0440\u043E\u043B\u044F \u0438\u043B\u0438 \u043F\u043E\u0434\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u043E\u0439 \u0441\u0435\u043A\u0440\u0435\u0442\u0430.",
  "setting.approvalPayments": "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0442\u044C \u043E\u043F\u043B\u0430\u0442\u0443 \u0438 \u043E\u043F\u0430\u0441\u043D\u044B\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F",
  "setting.approvalPaymentsInfo": "\u0422\u0440\u0435\u0431\u0443\u0435\u0442 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u043F\u0435\u0440\u0435\u0434 \u043D\u0430\u0436\u0430\u0442\u0438\u0435\u043C \u043A\u043D\u043E\u043F\u043E\u043A \u043E\u043F\u043B\u0430\u0442\u044B, \u043E\u0444\u043E\u0440\u043C\u043B\u0435\u043D\u0438\u044F \u0437\u0430\u043A\u0430\u0437\u0430, \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u0430 \u0441\u0440\u0435\u0434\u0441\u0442\u0432 \u0438\u043B\u0438 \u0443\u0434\u0430\u043B\u0435\u043D\u0438\u044F \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430.",
  "setting.approvalUploads": "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0442\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0443 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0445 \u0444\u0430\u0439\u043B\u043E\u0432",
  "setting.approvalUploadsInfo": "\u0417\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0435\u0442 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u043F\u0435\u0440\u0435\u0434 \u043F\u0440\u0438\u043A\u0440\u0435\u043F\u043B\u0435\u043D\u0438\u0435\u043C \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0445 \u0444\u0430\u0439\u043B\u043E\u0432 \u0441 \u0432\u0430\u0448\u0435\u0433\u043E \u043A\u043E\u043C\u043F\u044C\u044E\u0442\u0435\u0440\u0430 \u043A \u0432\u0435\u0431-\u0444\u043E\u0440\u043C\u0430\u043C.",
  "setting.language": "\u042F\u0437\u044B\u043A \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430",
  "setting.readOnlyDomains": "\u0414\u043E\u043C\u0435\u043D\u044B \xAB\u0422\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u0435\u043D\u0438\u0435\xBB (\u043F\u043E \u043E\u0434\u043D\u043E\u043C\u0443 \u043D\u0430 \u0441\u0442\u0440\u043E\u043A\u0443)",
  "setting.readOnlyOptional": "\u0414\u043E\u043C\u0435\u043D\u044B \xAB\u0422\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u0435\u043D\u0438\u0435\xBB (\u043D\u0435\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u043E)",
  "setting.readOnlyHint": "\u0427\u0442\u0435\u043D\u0438\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u043E; \u043A\u043B\u0438\u043A\u0438, \u0432\u0432\u043E\u0434 \u0442\u0435\u043A\u0441\u0442\u0430 \u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 JS \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u044E\u0442 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F.",
  "setting.readOnlyInfo": "\u041D\u0430 \u044D\u0442\u0438\u0445 \u0434\u043E\u043C\u0435\u043D\u0430\u0445 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u044B \u0447\u0442\u0435\u043D\u0438\u0435 \u0438 \u0441\u043A\u0440\u0438\u043D\u0448\u043E\u0442\u044B, \u0430 \u043B\u044E\u0431\u044B\u0435 \u043A\u043B\u0438\u043A\u0438, \u0432\u0432\u043E\u0434 \u0442\u0435\u043A\u0441\u0442\u0430, \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u0444\u0430\u0439\u043B\u043E\u0432 \u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 JS \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u044E\u0442 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F. \u0424\u043E\u0440\u043C\u0430\u0442: example.com \u0438\u043B\u0438 *.example.com/path*.",
  "setting.blockedDomains": "\u0417\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0435 \u0434\u043E\u043C\u0435\u043D\u044B (\u043F\u043E \u043E\u0434\u043D\u043E\u043C\u0443 \u043D\u0430 \u0441\u0442\u0440\u043E\u043A\u0443)",
  "setting.blockedDomainsInfo": "\u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u0441 \u043C\u0430\u0441\u043A\u0430\u043C\u0438 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, chrome://*, *.paypal.com), \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u043F\u043E\u043B\u043D\u043E\u0441\u0442\u044C\u044E \u0437\u0430\u043F\u0440\u0435\u0449\u0430\u044E\u0442 \u0434\u043E\u0441\u0442\u0443\u043F \u0430\u0433\u0435\u043D\u0442\u0430 \u0434\u0430\u0436\u0435 \u043F\u0440\u0438 \u0432\u043A\u043B\u044E\u0447\u0451\u043D\u043D\u043E\u043C \u0434\u043E\u0441\u0442\u0443\u043F\u0435 \u043A\u043E \u0432\u0441\u0435\u043C \u0432\u043A\u043B\u0430\u0434\u043A\u0430\u043C.",
  "setting.dialogPolicy": "\u041E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0430 JS-\u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432 (alert / confirm / prompt)",
  "setting.dialogPolicyInfo": "\u041E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442 \u0440\u0435\u0430\u043A\u0446\u0438\u044E \u043D\u0430 \u0441\u0438\u0441\u0442\u0435\u043C\u043D\u044B\u0435 \u043E\u043A\u043D\u0430 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430: \u043F\u0435\u0440\u0435\u0434\u0430\u0442\u044C \u0430\u0433\u0435\u043D\u0442\u0443 (browser_dialog), \u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0442\u044C \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u0438\u043B\u0438 \u0442\u0440\u0435\u0431\u043E\u0432\u0430\u0442\u044C \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435.",
  "setting.dialogAsk": "\u041F\u0435\u0440\u0435\u0434\u0430\u0432\u0430\u0442\u044C \u0430\u0433\u0435\u043D\u0442\u0443",
  "setting.dialogDismiss": "\u0417\u0430\u043A\u0440\u044B\u0432\u0430\u0442\u044C \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438",
  "setting.dialogApproval": "\u0422\u0440\u0435\u0431\u043E\u0432\u0430\u0442\u044C \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435",
  "setting.cdpDetach": "\u0410\u0432\u0442\u043E\u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 CDP \u043F\u0440\u0438 \u043F\u0440\u043E\u0441\u0442\u043E\u0435 (\u0441\u0435\u043A)",
  "setting.cdpDetachInfo": "\u0412\u0440\u0435\u043C\u044F \u043F\u0440\u043E\u0441\u0442\u043E\u044F \u0432 \u0441\u0435\u043A\u0443\u043D\u0434\u0430\u0445 (10\u2013600), \u043F\u043E\u0441\u043B\u0435 \u043A\u043E\u0442\u043E\u0440\u043E\u0433\u043E chrome.debugger \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043E\u0442\u043A\u043B\u044E\u0447\u0430\u0435\u0442\u0441\u044F, \u0443\u0431\u0438\u0440\u0430\u044F \u0436\u0451\u043B\u0442\u0443\u044E \u043F\u043B\u0430\u0448\u043A\u0443 Chrome.",
  "setting.cdpProxy": "\u041B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 CDP-\u043F\u0440\u043E\u043A\u0441\u0438 (/json/version)",
  "setting.cdpProxyDesc": "\u041F\u043E\u0437\u0432\u043E\u043B\u044F\u0435\u0442 \u0432\u043D\u0435\u0448\u043D\u0438\u043C \u0441\u043A\u0440\u0438\u043F\u0442\u0430\u043C Playwright \u0438 Puppeteer \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0430\u0442\u044C\u0441\u044F \u043F\u043E 127.0.0.1 \u0441 \u0441\u043E\u0431\u043B\u044E\u0434\u0435\u043D\u0438\u0435\u043C \u0433\u0440\u0443\u043F\u043F\u044B \u0432\u043A\u043B\u0430\u0434\u043E\u043A AI, \u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u043E\u043A \u0438 \u043F\u0430\u0443\u0437\u044B.",
  "setting.downloadsPerm": "\u041E\u0442\u0441\u043B\u0435\u0436\u0438\u0432\u0430\u043D\u0438\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u043E\u043A (browser_downloads)",
  "setting.downloadsPermInfo": "\u0417\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0435\u0442 \u0434\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0435 \u043F\u0440\u0430\u0432\u043E Chrome \xABdownloads\xBB, \u0447\u0442\u043E\u0431\u044B \u0430\u0433\u0435\u043D\u0442 \u043C\u043E\u0433 \u0432\u0438\u0434\u0435\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A \u0441\u043A\u0430\u0447\u0430\u043D\u043D\u044B\u0445 \u0444\u0430\u0439\u043B\u043E\u0432 \u0438 \u0436\u0434\u0430\u0442\u044C \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u044F \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438.",
  "setting.nativeHostPerm": "\u0422\u0440\u0430\u043D\u0441\u043F\u043E\u0440\u0442 Native Messaging Host",
  "setting.nativeHostPermInfo": "\u0417\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0435\u0442 \u043F\u0440\u0430\u0432\u043E \xABnativeMessaging\xBB \u0434\u043B\u044F \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F \u0447\u0435\u0440\u0435\u0437 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 Native Messaging Host \u0432\u043C\u0435\u0441\u0442\u043E WebSocket.",
  "btn.askAgentFix": "\u041F\u043E\u043F\u0440\u043E\u0441\u0438\u0442\u044C \u0430\u0433\u0435\u043D\u0442\u0430 \u0438\u0441\u043F\u0440\u0430\u0432\u0438\u0442\u044C",
  "btn.askAgentDebug": "\u0420\u0430\u0437\u043E\u0431\u0440\u0430\u0442\u044C \u0441 \u0430\u0433\u0435\u043D\u0442\u043E\u043C",
  "deck.workflowsDesc": "\u0417\u0430\u043F\u0438\u0441\u044B\u0432\u0430\u0439\u0442\u0435 \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u0438 \u0432 \u0431\u043E\u043A\u043E\u0432\u043E\u0439 \u043F\u0430\u043D\u0435\u043B\u0438 Chrome, \u043F\u0435\u0440\u0435\u0434\u0430\u0432\u0430\u0439\u0442\u0435 \u0438\u0445 \u0430\u0433\u0435\u043D\u0442\u0443 \u0438\u043B\u0438 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0439\u0442\u0435 \u0441 {{\u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u043C\u0438}} \u0447\u0435\u0440\u0435\u0437 MCP.",
  "deck.securityTitle": "\u0417\u0430\u0449\u0438\u0442\u0430 \u0438 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u044F",
  "deck.blockedSummary": "\u0417\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0435 \u0434\u043E\u043C\u0435\u043D\u044B",
  "deck.waitingActions": "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439 \u0430\u0433\u0435\u043D\u0442\u0430 \u0432 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435\u2026",
  "tour.playwrightDocs": "\u041F\u043E\u0434\u0440\u043E\u0431\u043D\u0435\u0435 \u0432 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430\u0446\u0438\u0438 Playwright \u2197",
  "val.domainComma": "\u0421\u0442\u0440\u043E\u043A\u0430 {line} (\xAB{val}\xBB): \u0443\u043A\u0430\u0437\u044B\u0432\u0430\u0439\u0442\u0435 \u043F\u043E \u043E\u0434\u043D\u043E\u043C\u0443 \u0434\u043E\u043C\u0435\u043D\u0443 \u043D\u0430 \u0441\u0442\u0440\u043E\u043A\u0443, \u0431\u0435\u0437 \u043F\u0440\u043E\u0431\u0435\u043B\u043E\u0432 \u0438 \u0437\u0430\u043F\u044F\u0442\u044B\u0445.",
  "val.domainInvalid": "\u0421\u0442\u0440\u043E\u043A\u0430 {line} (\xAB{val}\xBB): \u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0434\u043E\u043C\u0435\u043D (\u043F\u0440\u0438\u043C\u0435\u0440: example.com, *.example.com, chrome://*).",
  "val.wsUrlProtocol": "WebSocket URL \u0434\u043E\u043B\u0436\u0435\u043D \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 ws:// \u0438\u043B\u0438 wss://.",
  "val.wsUrlLoopback": "\u0418\u0437 \u0441\u043E\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0439 \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0435 \u0430\u0434\u0440\u0435\u0441\u0430 (127.0.0.1, localhost, ::1).",
  "val.wsUrlInvalid": "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 WebSocket URL (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, ws://127.0.0.1:43179/ws).",
  "val.labelEmpty": "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043F\u0440\u043E\u0444\u0438\u043B\u044F \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u043F\u0443\u0441\u0442\u044B\u043C.",
  "val.labelLength": "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043F\u0440\u043E\u0444\u0438\u043B\u044F \u043D\u0435 \u0434\u043E\u043B\u0436\u043D\u043E \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0442\u044C 32 \u0441\u0438\u043C\u0432\u043E\u043B\u0430.",
  "val.labelChars": '\u0414\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u0431\u0443\u043A\u0432\u044B, \u0446\u0438\u0444\u0440\u044B, \u043F\u0440\u043E\u0431\u0435\u043B\u044B \u0438 \u0441\u0438\u043C\u0432\u043E\u043B\u044B ".", "-", "_".',
  "val.tokenEmpty": "\u0422\u043E\u043A\u0435\u043D \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u043F\u0443\u0441\u0442\u044B\u043C.",
  "val.tokenWhitespace": "\u0422\u043E\u043A\u0435\u043D \u043D\u0435 \u0434\u043E\u043B\u0436\u0435\u043D \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C \u043F\u0440\u043E\u0431\u0435\u043B\u044B \u0438\u043B\u0438 \u043F\u0435\u0440\u0435\u043D\u043E\u0441\u044B \u0441\u0442\u0440\u043E\u043A.",
  "val.tokenShort": "\u0422\u043E\u043A\u0435\u043D \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439 (\u043E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F \u043C\u0438\u043D\u0438\u043C\u0443\u043C 16 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432).",
  "val.pinInvalid": "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 6-\u0437\u043D\u0430\u0447\u043D\u044B\u0439 \u0446\u0438\u0444\u0440\u043E\u0432\u043E\u0439 PIN.",
  "val.cdpIdleRange": "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0446\u0435\u043B\u043E\u0435 \u0447\u0438\u0441\u043B\u043E \u043E\u0442 10 \u0434\u043E 600 \u0441\u0435\u043A\u0443\u043D\u0434.",
  "val.workflowNameLength": "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u044F \u043D\u0435 \u0434\u043E\u043B\u0436\u043D\u043E \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0442\u044C 80 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432.",
  "val.savedRules": "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E \u043F\u0440\u0430\u0432\u0438\u043B: {count}.",
  "pair.pinTitle": "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u043F\u043E 6-\u0437\u043D\u0430\u0447\u043D\u043E\u043C\u0443 PIN",
  "pair.pinSimpleHint": "\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u0421\u043E\u0437\u0434\u0430\u0442\u044C PIN\xBB \u0432 Browser Control Deck (Antigravity) \u0438\u043B\u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043A\u043E\u043C\u0430\u043D\u0434\u0443 CLI \u043D\u0438\u0436\u0435 \u0438 \u0432\u0432\u0435\u0434\u0438\u0442\u0435 6 \u0446\u0438\u0444\u0440:",
  "pair.cliRepoHint": "\u0412\u044B\u043F\u043E\u043B\u043D\u044F\u0439\u0442\u0435 \u0432 \u043F\u0430\u043F\u043A\u0435 \u0441\u043A\u0430\u0447\u0430\u043D\u043D\u043E\u0433\u043E \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0438\u044F chrome-browser-mcp:",
  "pair.pinPlaceholder": "123456",
  "pair.pinButton": "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C",
  "pair.brokerDetected": "\u041B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 MCP \u043D\u0430\u0439\u0434\u0435\u043D \u043D\u0430 127.0.0.1",
  "pair.brokerOffline": "\u041B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 MCP \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D \u2014 \u0441\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0435\u0433\u043E",
  "pair.profileLabel": "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043F\u0440\u043E\u0444\u0438\u043B\u044F",
  "pair.wsUrl": "WebSocket URL \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E\u0433\u043E MCP",
  "pair.token": "\u0422\u043E\u043A\u0435\u043D \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F (\u0432\u0440\u0443\u0447\u043D\u0443\u044E)",
  "pair.tokenPlaceholder": "\u0412\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u0442\u043E\u043A\u0435\u043D, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043D\u044B\u0439 \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 \u0432\u044B\u0448\u0435",
  "pair.saveConnect": "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0438 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C",
  "pair.pairedOk": "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E! \u041F\u0435\u0440\u0435\u0445\u043E\u0434\u0438\u043C \u043A \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C\u0443 \u0448\u0430\u0433\u0443\u2026",
  "pair.savedReconnecting": "\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u044B \u2014 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0430\u0435\u043C\u0441\u044F\u2026",
  "empty.agentTabs": "\u041F\u043E\u043A\u0430 \u043D\u0435\u0442 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D\u043D\u044B\u0445 \u0432\u043A\u043B\u0430\u0434\u043E\u043A. \u041D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB+ \u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0432\u043A\u043B\u0430\u0434\u043A\u0430\xBB \u0432\u044B\u0448\u0435 \u0438\u043B\u0438 \xAB\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C\xBB \u0443 \u043D\u0443\u0436\u043D\u043E\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0438.",
  "empty.matchingTabs": "\u041F\u043E\u0434\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0432\u043A\u043B\u0430\u0434\u043A\u0438 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u044B.",
  "empty.timeline": "\u0412 \u044D\u0442\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0437\u0430\u043F\u0438\u0441\u0430\u043D\u043D\u044B\u0445 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439.",
  "empty.workflows": "\u0421\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0445 \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u0435\u0432 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442.",
  "empty.console": "\u041E\u0448\u0438\u0431\u043E\u043A \u0438 \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0439 \u0432 \u043A\u043E\u043D\u0441\u043E\u043B\u0438 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442.",
  "empty.network": "\u041D\u0435\u0443\u0434\u0430\u0447\u043D\u044B\u0445 \u0441\u0435\u0442\u0435\u0432\u044B\u0445 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442.",
  "filter.tabsPlaceholder": "\u0424\u0438\u043B\u044C\u0442\u0440 \u0432\u043A\u043B\u0430\u0434\u043E\u043A \u043F\u043E \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u044E, URL \u0438\u043B\u0438 ID\u2026",
  "label.tabsCount": "\u0432\u043A\u043B\u0430\u0434\u043E\u043A",
  "label.profilesCount": "\u043F\u0440\u043E\u0444\u0438\u043B\u0435\u0439",
  "label.steps": "\u0448\u0430\u0433\u043E\u0432",
  "label.vars": "\u043F\u0435\u0440\u0435\u043C.",
  "recorder.start": "\u041D\u0430\u0447\u0430\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C",
  "recorder.stop": "\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C",
  "recorder.namePlaceholder": "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u044F (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440: \u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0437\u0430\u0434\u0430\u0447\u0443)",
  "recorder.varsHint": "\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 {{\u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u0430\u044F}} \u0432 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u044F\u0445 \u0448\u0430\u0433\u043E\u0432 \u0434\u043B\u044F \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u0438\u0437\u043E\u0432\u0430\u043D\u043D\u043E\u0433\u043E \u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0447\u0435\u0440\u0435\u0437 MCP.",
  "recorder.restrictedUrl": "\u041D\u0435\u043B\u044C\u0437\u044F \u0437\u0430\u043F\u0438\u0441\u044B\u0432\u0430\u0442\u044C \u043D\u0430 \u0441\u0438\u0441\u0442\u0435\u043C\u043D\u044B\u0445 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430\u0445 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430 (chrome://, \u0440\u0430\u0441\u0448\u0438\u0440\u0435\u043D\u0438\u044F, Web Store). \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0438\u0442\u0435\u0441\u044C \u043D\u0430 \u043E\u0431\u044B\u0447\u043D\u0443\u044E \u0432\u0435\u0431-\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443 (http:// \u0438\u043B\u0438 https://).",
  "tour.step1.title": "1. \u0413\u0440\u0443\u043F\u043F\u0430 \u0432\u043A\u043B\u0430\u0434\u043E\u043A AI-\u0430\u0433\u0435\u043D\u0442\u0430",
  "tour.step1.body": "\u0410\u0433\u0435\u043D\u0442 \u0432\u0438\u0434\u0438\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0442\u0435 \u0432\u043A\u043B\u0430\u0434\u043A\u0438, \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u0432\u044B \u044F\u0432\u043D\u043E \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u043B\u0438 \u0441\u044E\u0434\u0430. \u041B\u0438\u0447\u043D\u044B\u0435 \u0432\u043A\u043B\u0430\u0434\u043A\u0438 \u0438\u0437\u043E\u043B\u0438\u0440\u043E\u0432\u0430\u043D\u044B \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E.",
  "tour.step2.title": "2. \u041C\u0433\u043D\u043E\u0432\u0435\u043D\u043D\u0430\u044F \u043F\u0430\u0443\u0437\u0430",
  "tour.step2.body": "\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u041F\u0430\u0443\u0437\u0430\xBB \u0438\u043B\u0438 {shortcut} \u0432 \u043B\u044E\u0431\u043E\u0439 \u043C\u043E\u043C\u0435\u043D\u0442, \u0447\u0442\u043E\u0431\u044B \u043C\u0433\u043D\u043E\u0432\u0435\u043D\u043D\u043E \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0437\u0430\u0446\u0438\u044E.",
  "tour.step3.title": "3. \u0417\u0430\u043F\u0438\u0441\u044C \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u0435\u0432 \u0438 \u044D\u043A\u0441\u043F\u043E\u0440\u0442 Playwright",
  "tour.step3.body": "\u041F\u043E\u043A\u0430\u0436\u0438\u0442\u0435 \u0440\u0443\u0442\u0438\u043D\u043D\u044B\u0439 \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u0439 \u0440\u0443\u043A\u0430\u043C\u0438, \u0434\u043E\u0431\u0430\u0432\u044C\u0442\u0435 {{\u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0435}} \u0438 \u044D\u043A\u0441\u043F\u043E\u0440\u0442\u0438\u0440\u0443\u0439\u0442\u0435 \u0442\u0435\u0441\u0442 \u0432 Playwright .spec.ts.",
  "tour.step4.title": "4. \u0411\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C \u0438 \u0432\u0438\u0437\u0443\u0430\u043B\u044C\u043D\u044B\u0439 \u043A\u0443\u0440\u0441\u043E\u0440",
  "tour.step4.body": "\u0417\u0434\u0435\u0441\u044C \u043C\u043E\u0436\u043D\u043E \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u0438\u043B\u0438 \u043E\u0442\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u043A\u0443\u0440\u0441\u043E\u0440 \u0430\u0433\u0435\u043D\u0442\u0430, \u0437\u0430\u0449\u0438\u0442\u0443 \u043E\u0442 \u0438\u043D\u044A\u0435\u043A\u0446\u0438\u0439 \u0438 \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0420\u0430\u0441\u0448\u0438\u0440\u0435\u043D\u043D\u044B\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438.",
  "welcome.heroTitle": "\u0414\u043E\u0431\u0440\u043E \u043F\u043E\u0436\u0430\u043B\u043E\u0432\u0430\u0442\u044C \u0432 Chrome Browser MCP",
  "welcome.heroSub": "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0445 AI-\u0430\u0433\u0435\u043D\u0442\u043E\u0432 \u043A \u0432\u0430\u0448\u0438\u043C \u0440\u0435\u0430\u043B\u044C\u043D\u044B\u043C \u0432\u043A\u043B\u0430\u0434\u043A\u0430\u043C \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430 \u2014 \u043F\u043E\u043B\u043D\u043E\u0441\u0442\u044C\u044E \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E.",
  "welcome.step1": "\u042F\u0437\u044B\u043A \u0438 \u0442\u0435\u043C\u0430",
  "welcome.step2": "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435",
  "welcome.step3": "\u0417\u0430\u0449\u0438\u0442\u0430 \u0438 \u0432\u0438\u0437\u0443\u0430\u043B",
  "welcome.step4": "\u0417\u0430\u043F\u0443\u0441\u043A \u043F\u0430\u043D\u0435\u043B\u0438",
  "welcome.localTitle": "100% \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u0430\u044F \u0440\u0430\u0431\u043E\u0442\u0430",
  "welcome.localDesc": "\u0421\u0442\u0440\u043E\u0433\u043E\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u043F\u043E 127.0.0.1. \u041D\u0438\u043A\u0430\u043A\u0438\u0445 \u043E\u0431\u043B\u0430\u0447\u043D\u044B\u0445 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u0432, \u043D\u0443\u043B\u0435\u0432\u0430\u044F \u0442\u0435\u043B\u0435\u043C\u0435\u0442\u0440\u0438\u044F \u0438 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u0430\u044F \u0433\u0440\u0443\u043F\u043F\u0430 \u0432\u043A\u043B\u0430\u0434\u043E\u043A AI Agent.",
  "welcome.howTitle": "\u041A\u0430\u043A \u044D\u0442\u043E \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0437\u0430 30 \u0441\u0435\u043A\u0443\u043D\u0434",
  "welcome.how1": "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0440\u0430\u0441\u0448\u0438\u0440\u0435\u043D\u0438\u0435 \u043A \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E\u043C\u0443 MCP (\u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0441 Antigravity, Claude Code, Cursor \u0438 Codex).",
  "welcome.how2": "\u0414\u043E\u0431\u0430\u0432\u043B\u044F\u0439\u0442\u0435 \u0442\u043E\u043B\u044C\u043A\u043E \u0442\u0435 \u0432\u043A\u043B\u0430\u0434\u043A\u0438, \u0441 \u043A\u043E\u0442\u043E\u0440\u044B\u043C\u0438 \u043D\u0443\u0436\u043D\u043E \u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C \u2014 \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u043E\u0441\u0442\u0430\u044E\u0442\u0441\u044F \u043F\u0440\u0438\u0432\u0430\u0442\u043D\u044B\u043C\u0438.",
  "welcome.how3Prefix": "\u041D\u0430\u0436\u043C\u0438\u0442\u0435",
  "welcome.how3Suffix": "\u0432 \u043B\u044E\u0431\u043E\u0439 \u043C\u043E\u043C\u0435\u043D\u0442 \u0434\u043B\u044F \u043C\u0433\u043D\u043E\u0432\u0435\u043D\u043D\u043E\u0439 \u043F\u0430\u0443\u0437\u044B.",
  "welcome.readyTitle": "\u0412\u0441\u0451 \u0433\u043E\u0442\u043E\u0432\u043E!",
  "welcome.readyDesc": "\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0438\u0436\u0435, \u0447\u0442\u043E\u0431\u044B \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0431\u043E\u043A\u043E\u0432\u0443\u044E \u043F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F \u0438 \u043F\u0440\u043E\u0439\u0442\u0438 \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439 4-\u0448\u0430\u0433\u043E\u0432\u044B\u0439 \u0442\u0443\u0440 \u043F\u043E \u0438\u0437\u043E\u043B\u044F\u0446\u0438\u0438 \u0432\u043A\u043B\u0430\u0434\u043E\u043A, \u043F\u0430\u0443\u0437\u0435, \u0437\u0430\u043F\u0438\u0441\u0438 \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u0435\u0432 \u0438 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u043C \u0437\u0430\u0449\u0438\u0442\u044B.",
  "welcome.openHud": "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F \u0438 \u043D\u0430\u0447\u0430\u0442\u044C \u0442\u0443\u0440"
};
var ZH_CN = {
  "app.title": "Chrome Browser MCP",
  "app.subtitle": "\u672C\u5730 AI \u6D4F\u89C8\u5668\u63A7\u5236\u6865\u63A5",
  "app.loading": "\u6B63\u5728\u52A0\u8F7D Chrome Browser MCP \u63A7\u5236\u9762\u677F\u2026",
  "app.deckTitle": "\u6D4F\u89C8\u5668\u63A7\u5236\u53F0",
  "status.connected": "\u5DF2\u8FDE\u63A5",
  "status.offline": "\u672A\u8FDE\u63A5",
  "status.paused": "\u81EA\u52A8\u5316\u5DF2\u6682\u505C",
  "status.pausedDesc": "\u5728\u60A8\u6062\u590D\u4E4B\u524D\uFF0C\u6240\u6709\u5916\u90E8 MCP \u64CD\u4F5C\u5747\u5DF2\u6682\u505C\u3002",
  "status.idle": "\u7A7A\u95F2",
  "status.on": "\u5F00\u542F",
  "status.off": "\u5173\u95ED",
  "status.copied": "\u5DF2\u590D\u5236\uFF01",
  "status.saved": "\u5DF2\u4FDD\u5B58\uFF01",
  "status.savedTo": "\u5DF2\u4FDD\u5B58\u81F3 {path}",
  "status.clickToCopy": "\u70B9\u51FB\u590D\u5236",
  "btn.pause": "\u6682\u505C",
  "btn.pauseAll": "\u5168\u90E8\u6682\u505C",
  "btn.resume": "\u6062\u590D",
  "btn.refresh": "\u5237\u65B0",
  "btn.focus": "\u805A\u7126",
  "btn.attach": "\u63A5\u5165",
  "btn.detach": "\u79FB\u51FA",
  "btn.attachActive": "+ \u63A5\u5165\u5F53\u524D\u6807\u7B7E",
  "btn.attachToAgent": "\u53D1\u9001\u7ED9 Agent",
  "btn.save": "\u4FDD\u5B58",
  "btn.discard": "\u653E\u5F03",
  "btn.approve": "\u6279\u51C6",
  "btn.reject": "\u62D2\u7EDD",
  "btn.accept": "\u786E\u5B9A",
  "btn.dismiss": "\u53D6\u6D88",
  "btn.clear": "\u6E05\u7A7A",
  "btn.delete": "\u5220\u9664",
  "btn.exportPlaywright": "\u5BFC\u51FA .spec.ts",
  "btn.exportJson": "\u5BFC\u51FA JSON",
  "btn.exportHtml": "\u5BFC\u51FA HTML",
  "btn.replayTour": "\u91CD\u64AD\u5F15\u5BFC\u6559\u7A0B",
  "btn.openWelcome": "\u521D\u59CB\u914D\u7F6E\u5411\u5BFC",
  "btn.openPairPage": "\u83B7\u53D6 6 \u4F4D PIN \u7801",
  "btn.generatePin": "\u751F\u6210 PIN \u7801",
  "btn.connect": "\u8FDE\u63A5",
  "btn.next": "\u4E0B\u4E00\u6B65",
  "btn.back": "\u4E0A\u4E00\u6B65",
  "btn.skip": "\u8DF3\u8FC7",
  "btn.finish": "\u5B8C\u6210",
  "tab.control": "\u63A7\u5236",
  "tab.overview": "\u6982\u89C8",
  "tab.timeline": "\u65F6\u95F4\u7EBF",
  "tab.devtools": "\u8C03\u8BD5",
  "tab.recorder": "\u5F55\u5236",
  "tab.workflows": "\u5DE5\u4F5C\u6D41",
  "tab.security": "\u5B89\u5168",
  "tab.connect": "\u914D\u5BF9",
  "section.agentTabs": "AI Agent \u6807\u7B7E\u7EC4",
  "section.otherTabs": "\u5176\u4ED6\u6D4F\u89C8\u5668\u6807\u7B7E",
  "section.approvals": "\u7B49\u5F85\u4EBA\u5DE5\u5BA1\u6279",
  "section.pendingDialog": "\u5F85\u5904\u7406\u7684\u6D4F\u89C8\u5668\u5F39\u7A97",
  "section.advancedSettings": "\u9AD8\u7EA7\u8BBE\u7F6E",
  "section.advancedConnection": "\u624B\u52A8\u8FDE\u63A5\u8BBE\u7F6E",
  "section.optionalPermissions": "\u53EF\u9009 Chrome \u6743\u9650",
  "section.latestCapture": "\u6700\u65B0\u9875\u9762\u622A\u56FE",
  "section.consoleErrors": "\u63A7\u5236\u53F0\u9519\u8BEF\u4E0E\u8B66\u544A",
  "section.failedNetwork": "\u5931\u8D25\u7684\u7F51\u7EDC\u8BF7\u6C42",
  "section.savedWorkflows": "\u5DF2\u4FDD\u5B58\u7684\u5DE5\u4F5C\u6D41",
  "setting.allowAllTabs": "\u5141\u8BB8\u8BBF\u95EE\u5F53\u524D\u7A97\u53E3\u4E2D\u7684\u6240\u6709\u6807\u7B7E",
  "setting.allowAllTabsInfo": "\u9ED8\u8BA4\u60C5\u51B5\u4E0B\uFF0CAI \u4EC5\u80FD\u8BBF\u95EE\u9752\u8272\u201CAI Agent\u201D\u6807\u7B7E\u7EC4\u5185\u7684\u6807\u7B7E\u9875\u3002\u5F00\u542F\u540E\u53EF\u8BBF\u95EE\u5F53\u524D\u7A97\u53E3\u7684\u6240\u6709\u6807\u7B7E\uFF08\u5C4F\u853D\u57DF\u540D\u4ECD\u53D7\u4FDD\u62A4\uFF09\u3002",
  "setting.visualHud": "\u9875\u9762\u53EF\u89C6\u5316\u5149\u6807\u4E0E\u64CD\u4F5C\u9AD8\u4EAE",
  "setting.visualHudDesc": "\u5728 AI \u6267\u884C\u64CD\u4F5C\u65F6\u663E\u793A\u5E73\u6ED1\u5149\u6807\u3001\u76EE\u6807\u9AD8\u4EAE\u6846\u4E0E\u9875\u9762\u5185\u6682\u505C\u6309\u94AE\u3002",
  "setting.visualHudActive": "\u5DF2\u5F00\u542F\uFF1A\u663E\u793A\u5E73\u6ED1\u5149\u6807\u3001\u5143\u7D20\u9AD8\u4EAE\u6846\u4E0E\u9875\u9762\u5185\u4E00\u952E\u6682\u505C\u6309\u94AE",
  "setting.visualHudSilent": "\u9759\u9ED8\u6A21\u5F0F\uFF1A\u6267\u884C\u64CD\u4F5C\u65F6\u4E0D\u5728\u9875\u9762\u4E0A\u663E\u793A\u5149\u6807\u6216\u9AD8\u4EAE",
  "setting.shield": "\u63D0\u793A\u8BCD\u6CE8\u5165\u9632\u62A4 (Shield)",
  "setting.shieldInfo": "\u8FC7\u6EE4\u9690\u85CF\u3001\u96F6\u900F\u660E\u5EA6\u548C\u5C4F\u5916 DOM \u9677\u9631\uFF0C\u6E05\u9664\u4E0D\u53EF\u89C1 Unicode \u5B57\u7B26\uFF0C\u5E76\u7528 UNTRUSTED_PAGE_CONTENT \u8FB9\u754C\u5305\u88F9\u7F51\u9875\u5185\u5BB9\u3002",
  "setting.approvalEval": "\u65B0\u57DF\u540D\u6267\u884C JS \u65F6\u9700\u5BA1\u6279",
  "setting.approvalEvalInfo": "\u5F53 Agent \u9996\u6B21\u5728\u67D0\u4E2A\u7F51\u7AD9\u4E0A\u8FD0\u884C\u4EFB\u610F JavaScript \u4EE3\u7801\u65F6\uFF0C\u6682\u505C\u5E76\u8BF7\u6C42\u60A8\u660E\u786E\u6279\u51C6\u6216\u62D2\u7EDD\u3002",
  "setting.approvalPasswords": "\u5BC6\u7801\u4E0E\u5BC6\u94A5\u81EA\u52A8\u586B\u5145\u65F6\u9700\u5BA1\u6279",
  "setting.approvalPasswordsInfo": "\u5728\u586B\u5145\u4EFB\u4F55\u5BC6\u7801\u8F93\u5165\u6846\u6216\u89E3\u6790\u672C\u5730\u5BC6\u94A5\u5F15\u7528\u524D\uFF0C\u6682\u505C\u5E76\u7B49\u5F85\u60A8\u7684\u786E\u8BA4\u3002",
  "setting.approvalPayments": "\u652F\u4ED8\u4E0E\u9AD8\u98CE\u9669\u64CD\u4F5C\u65F6\u9700\u5BA1\u6279",
  "setting.approvalPaymentsInfo": "\u5728\u70B9\u51FB\u6D89\u53CA\u7ED3\u8D26\u3001\u652F\u4ED8\u3001\u8F6C\u8D26\u6216\u5220\u9664\u8D26\u53F7\u7684\u6309\u94AE\u524D\uFF0C\u8981\u6C42\u4EBA\u5DE5\u786E\u8BA4\u3002",
  "setting.approvalUploads": "\u4E0A\u4F20\u672C\u5730\u6587\u4EF6\u65F6\u9700\u5BA1\u6279",
  "setting.approvalUploadsInfo": "\u5728\u5C06\u672C\u673A\u6587\u4EF6\u4E0A\u4F20\u5230\u4EFB\u4F55\u7F51\u9875\u8868\u5355\u524D\uFF0C\u8981\u6C42\u60A8\u660E\u786E\u6279\u51C6\u3002",
  "setting.language": "\u754C\u9762\u8BED\u8A00",
  "setting.readOnlyDomains": "\u53EA\u8BFB\u57DF\u540D\uFF08\u6BCF\u884C\u4E00\u4E2A\uFF09",
  "setting.readOnlyOptional": "\u53EA\u8BFB\u57DF\u540D\uFF08\u53EF\u9009\uFF09",
  "setting.readOnlyHint": "\u5141\u8BB8\u8BFB\u53D6\u9875\u9762\u5185\u5BB9\uFF1B\u70B9\u51FB\u3001\u8F93\u5165\u548C\u6267\u884C JS \u5747\u9700\u4EBA\u5DE5\u6279\u51C6\u3002",
  "setting.readOnlyInfo": "\u5728\u8FD9\u4E9B\u57DF\u540D\u4E0A\u5141\u8BB8\u8BFB\u53D6\u5FEB\u7167\u3001\u6B63\u6587\u548C\u622A\u56FE\uFF0C\u4F46\u70B9\u51FB\u3001\u8F93\u5165\u3001\u4E0A\u4F20\u6587\u4EF6\u548C\u6267\u884C JS \u5FC5\u987B\u7ECF\u8FC7\u6279\u51C6\u3002\u683C\u5F0F\uFF1Aexample.com \u6216 *.example.com/path*\u3002",
  "setting.blockedDomains": "\u5C4F\u853D\u57DF\u540D\uFF08\u6BCF\u884C\u4E00\u4E2A\uFF09",
  "setting.blockedDomainsInfo": "\u901A\u914D\u7B26\u89C4\u5219\uFF08\u5982 chrome://*\u3001*.paypal.com\uFF09\uFF0C\u5373\u4F7F\u5F00\u542F\u201C\u5141\u8BB8\u8BBF\u95EE\u6240\u6709\u6807\u7B7E\u201D\uFF0C\u4E5F\u4F1A\u5B8C\u5168\u963B\u6B62 AI \u8BBF\u95EE\u8FD9\u4E9B\u7AD9\u70B9\u3002",
  "setting.dialogPolicy": "JS \u5F39\u7A97\u7B56\u7565 (alert / confirm / prompt)",
  "setting.dialogPolicyInfo": "\u8BBE\u7F6E\u9047\u5230\u539F\u751F\u6D4F\u89C8\u5668\u5F39\u7A97\u65F6\u7684\u5904\u7406\u65B9\u5F0F\uFF1A\u4EA4\u7531 Agent \u5904\u7406\uFF08browser_dialog\uFF09\u3001\u81EA\u52A8\u53D6\u6D88\uFF0C\u6216\u8BF7\u6C42\u4EBA\u5DE5\u786E\u8BA4\u3002",
  "setting.dialogAsk": "\u4EA4\u7531 Agent \u5904\u7406",
  "setting.dialogDismiss": "\u81EA\u52A8\u5173\u95ED",
  "setting.dialogApproval": "\u9700\u8981\u4EBA\u5DE5\u786E\u8BA4",
  "setting.cdpDetach": "CDP \u7A7A\u95F2\u81EA\u52A8\u65AD\u5F00\uFF08\u79D2\uFF09",
  "setting.cdpDetachInfo": "\u7A7A\u95F2\u6307\u5B9A\u79D2\u6570\uFF0810\u2013600\uFF09\u540E\u81EA\u52A8\u65AD\u5F00 chrome.debugger\uFF0C\u4ECE\u800C\u9690\u85CF\u6D4F\u89C8\u5668\u9876\u90E8\u9EC4\u8272\u8C03\u8BD5\u6A2A\u5E45\u3002",
  "setting.cdpProxy": "\u542F\u7528\u672C\u5730 CDP \u4EE3\u7406 (/json/version)",
  "setting.cdpProxyDesc": "\u5141\u8BB8\u5916\u90E8 Playwright / Puppeteer \u811A\u672C\u901A\u8FC7 127.0.0.1 \u63A5\u5165\uFF0C\u540C\u65F6\u7EE7\u7EED\u53D7 AI \u6807\u7B7E\u7EC4\u3001\u5C4F\u853D\u5217\u8868\u548C\u7D27\u6025\u6682\u505C\u4FDD\u62A4\u3002",
  "setting.downloadsPerm": "\u4E0B\u8F7D\u8FFD\u8E2A (browser_downloads)",
  "setting.downloadsPermInfo": "\u6309\u9700\u6388\u4E88 Chrome \u53EF\u9009\u201Cdownloads\u201D\u6743\u9650\uFF0C\u8BA9 Agent \u53EF\u4EE5\u67E5\u770B\u6700\u8FD1\u4E0B\u8F7D\u6216\u7B49\u5F85\u4E0B\u8F7D\u5B8C\u6210\u3002",
  "setting.nativeHostPerm": "Native Messaging \u672C\u5730\u901A\u9053",
  "setting.nativeHostPermInfo": "\u6309\u9700\u6388\u4E88 Chrome \u53EF\u9009\u201CnativeMessaging\u201D\u6743\u9650\uFF0C\u901A\u8FC7\u672C\u5730 Native Messaging Host \u66FF\u4EE3\u56DE\u73AF WebSocket \u8FDE\u63A5\u3002",
  "btn.askAgentFix": "\u8BA9 Agent \u4FEE\u590D",
  "btn.askAgentDebug": "\u8BA9 Agent \u6392\u67E5",
  "deck.workflowsDesc": "\u5728 Chrome \u4FA7\u8FB9\u680F\u5F55\u5236\u591A\u6B65\u9AA4\u64CD\u4F5C\uFF0C\u53D1\u9001\u7ED9 Agent \u6216\u901A\u8FC7 MCP \u4F7F\u7528 {{\u53D8\u91CF}} \u56DE\u653E\u3002",
  "deck.securityTitle": "\u5B89\u5168\u4E0E\u9632\u62A4\u7B56\u7565",
  "deck.blockedSummary": "\u5DF2\u5C4F\u853D\u57DF\u540D",
  "deck.waitingActions": "\u6B63\u5728\u7B49\u5F85 Agent \u6267\u884C\u6D4F\u89C8\u5668\u64CD\u4F5C\u2026",
  "tour.playwrightDocs": "\u67E5\u770B Playwright \u5B98\u65B9\u6587\u6863 \u2197",
  "val.domainComma": "\u7B2C {line} \u884C\uFF08\u201C{val}\u201D\uFF09\uFF1A\u6BCF\u884C\u4EC5\u586B\u5199\u4E00\u6761\u89C4\u5219\uFF0C\u8BF7\u52FF\u5305\u542B\u7A7A\u683C\u6216\u9017\u53F7\u3002",
  "val.domainInvalid": "\u7B2C {line} \u884C\uFF08\u201C{val}\u201D\uFF09\uFF1A\u57DF\u540D\u683C\u5F0F\u65E0\u6548\uFF08\u793A\u4F8B\uFF1Aexample.com\u3001*.example.com\u3001chrome://*\uFF09\u3002",
  "val.wsUrlProtocol": "WebSocket \u5730\u5740\u5FC5\u987B\u4EE5 ws:// \u6216 wss:// \u5F00\u5934\u3002",
  "val.wsUrlLoopback": "\u51FA\u4E8E\u5B89\u5168\u9650\u5236\uFF0C\u4EC5\u5141\u8BB8\u672C\u5730\u56DE\u73AF\u5730\u5740\uFF08127.0.0.1\u3001localhost\u3001::1\uFF09\u3002",
  "val.wsUrlInvalid": "\u8BF7\u8F93\u5165\u6709\u6548\u7684\u672C\u5730 WebSocket \u5730\u5740\uFF08\u4F8B\u5982 ws://127.0.0.1:43179/ws\uFF09\u3002",
  "val.labelEmpty": "\u914D\u7F6E\u6587\u4EF6\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u3002",
  "val.labelLength": "\u914D\u7F6E\u6587\u4EF6\u540D\u79F0\u4E0D\u80FD\u8D85\u8FC7 32 \u4E2A\u5B57\u7B26\u3002",
  "val.labelChars": '\u914D\u7F6E\u6587\u4EF6\u540D\u79F0\u4EC5\u652F\u6301\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u7A7A\u683C\u53CA "."\u3001"-"\u3001"_"\u3002',
  "val.tokenEmpty": "\u914D\u5BF9\u4EE4\u724C\u4E0D\u80FD\u4E3A\u7A7A\u3002",
  "val.tokenWhitespace": "\u914D\u5BF9\u4EE4\u724C\u4E0D\u80FD\u5305\u542B\u7A7A\u683C\u6216\u6362\u884C\u7B26\u3002",
  "val.tokenShort": "\u914D\u5BF9\u4EE4\u724C\u957F\u5EA6\u8FC7\u77ED\uFF08\u81F3\u5C11\u9700\u8981 16 \u4E2A\u5B57\u7B26\uFF09\u3002",
  "val.pinInvalid": "\u8BF7\u8F93\u5165\u6709\u6548\u7684 6 \u4F4D\u6570\u5B57 PIN \u7801\u3002",
  "val.cdpIdleRange": "\u8BF7\u8F93\u5165 10 \u5230 600 \u4E4B\u95F4\u7684\u6574\u6570\u79D2\u6570\u3002",
  "val.workflowNameLength": "\u5DE5\u4F5C\u6D41\u540D\u79F0\u4E0D\u80FD\u8D85\u8FC7 80 \u4E2A\u5B57\u7B26\u3002",
  "val.savedRules": "\u5DF2\u4FDD\u5B58 {count} \u6761\u89C4\u5219\u3002",
  "pair.pinTitle": "\u4F7F\u7528 6 \u4F4D PIN \u7801\u8FDE\u63A5",
  "pair.pinSimpleHint": "\u5728 Antigravity \u7684\u6D4F\u89C8\u5668\u63A7\u5236\u53F0\u4E2D\u70B9\u51FB\u201C\u751F\u6210 PIN \u7801\u201D\u6216\u8FD0\u884C\u4E0B\u65B9 CLI \u547D\u4EE4\uFF0C\u7136\u540E\u8F93\u5165 6 \u4F4D\u6570\u5B57\uFF1A",
  "pair.cliRepoHint": "\u8BF7\u5728\u5DF2\u4E0B\u8F7D\u7684 chrome-browser-mcp \u4ED3\u5E93\u76EE\u5F55\u4E2D\u8FD0\u884C\uFF1A",
  "pair.pinPlaceholder": "123456",
  "pair.pinButton": "\u8FDE\u63A5",
  "pair.brokerDetected": "\u672C\u5730 MCP \u5DF2\u5728 127.0.0.1 \u5C31\u7EEA",
  "pair.brokerOffline": "\u672C\u5730 MCP \u672A\u8FD0\u884C \u2014 \u8BF7\u5148\u542F\u52A8\u672C\u5730\u670D\u52A1",
  "pair.profileLabel": "\u914D\u7F6E\u6587\u4EF6\u540D\u79F0",
  "pair.wsUrl": "\u672C\u5730 MCP WebSocket \u5730\u5740",
  "pair.token": "\u624B\u52A8\u914D\u5BF9\u4EE4\u724C",
  "pair.tokenPlaceholder": "\u7C98\u8D34\u4E0A\u65B9\u547D\u4EE4\u8F93\u51FA\u7684\u4EE4\u724C",
  "pair.saveConnect": "\u4FDD\u5B58\u5E76\u8FDE\u63A5",
  "pair.pairedOk": "\u8FDE\u63A5\u6210\u529F\uFF01\u6B63\u5728\u8FDB\u5165\u4E0B\u4E00\u6B65\u2026",
  "pair.savedReconnecting": "\u8FDE\u63A5\u914D\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u6B63\u5728\u8FDE\u63A5\u2026",
  "empty.agentTabs": "\u6682\u672A\u63A5\u5165\u4EFB\u4F55\u6807\u7B7E\u9875\u3002\u8BF7\u70B9\u51FB\u4E0A\u65B9\u201C+ \u63A5\u5165\u5F53\u524D\u6807\u7B7E\u201D\u6216\u5728\u4E0B\u65B9\u5217\u8868\u4E2D\u70B9\u51FB\u201C\u63A5\u5165\u201D\u3002",
  "empty.matchingTabs": "\u6CA1\u6709\u5339\u914D\u7684\u6807\u7B7E\u9875\u3002",
  "empty.timeline": "\u672C\u6B21\u4F1A\u8BDD\u5C1A\u672A\u8BB0\u5F55\u4EFB\u4F55\u64CD\u4F5C\u3002",
  "empty.workflows": "\u6682\u65E0\u5DF2\u4FDD\u5B58\u7684\u5DE5\u4F5C\u6D41\u3002",
  "empty.console": "\u6682\u672A\u6355\u83B7\u5230\u63A7\u5236\u53F0\u8B66\u544A\u6216\u9519\u8BEF\u3002",
  "empty.network": "\u6682\u672A\u6355\u83B7\u5230\u5931\u8D25\u7684\u7F51\u7EDC\u8BF7\u6C42\u3002",
  "filter.tabsPlaceholder": "\u6309\u6807\u9898\u3001URL \u6216 ID \u7B5B\u9009\u6807\u7B7E\u9875\u2026",
  "label.tabsCount": "\u4E2A\u6807\u7B7E\u9875",
  "label.profilesCount": "\u4E2A\u914D\u7F6E",
  "label.steps": "\u6B65",
  "label.vars": "\u4E2A\u53D8\u91CF",
  "recorder.start": "\u5F00\u59CB\u5F55\u5236",
  "recorder.stop": "\u505C\u6B62\u5E76\u4FDD\u5B58",
  "recorder.namePlaceholder": "\u5DE5\u4F5C\u6D41\u540D\u79F0\uFF08\u4F8B\u5982\uFF1A\u521B\u5EFA\u5DE5\u5355\uFF09",
  "recorder.varsHint": "\u5728\u6B65\u9AA4\u503C\u4E2D\u4F7F\u7528 {{\u53D8\u91CF\u540D}} \u5373\u53EF\u5728 MCP \u56DE\u653E\u65F6\u52A8\u6001\u4F20\u5165\u53C2\u6570\u3002",
  "recorder.restrictedUrl": "\u65E0\u6CD5\u5728\u6D4F\u89C8\u5668\u7CFB\u7EDF\u9875\u9762\uFF08chrome://\u3001\u6269\u5C55\u7A0B\u5E8F\u9875\u6216\u5E94\u7528\u5546\u5E97\uFF09\u5F55\u5236\u3002\u8BF7\u5148\u5207\u6362\u5230\u666E\u901A\u7F51\u9875\uFF08http:// \u6216 https://\uFF09\u3002",
  "tour.step1.title": "1. AI Agent \u6807\u7B7E\u7EC4",
  "tour.step1.body": "AI \u4EC5\u80FD\u8BBF\u95EE\u60A8\u4E3B\u52A8\u63A5\u5165\u6B64\u5904\u7684\u6807\u7B7E\u9875\uFF0C\u5176\u4F59\u79C1\u5BC6\u6807\u7B7E\u9ED8\u8BA4\u5B8C\u5168\u9694\u79BB\u3002",
  "tour.step2.title": "2. \u4E00\u952E\u7D27\u6025\u6682\u505C",
  "tour.step2.body": "\u968F\u65F6\u70B9\u51FB\u201C\u6682\u505C\u201D\u6216\u6309 {shortcut}\uFF0C\u5373\u53EF\u7ACB\u5373\u51BB\u7ED3\u6240\u6709\u81EA\u52A8\u5316\u64CD\u4F5C\u3002",
  "tour.step3.title": "3. \u5DE5\u4F5C\u6D41\u5F55\u5236\u4E0E Playwright \u5BFC\u51FA",
  "tour.step3.body": "\u624B\u52A8\u6F14\u793A\u64CD\u4F5C\u5373\u53EF\u5F55\u5236\u6D41\u7A0B\uFF0C\u652F\u6301 {{\u53D8\u91CF}} \u53C2\u6570\u5316\uFF0C\u5E76\u53EF\u5BFC\u51FA\u4E3A Playwright .spec.ts \u6D4B\u8BD5\u811A\u672C\u3002",
  "tour.step4.title": "4. \u5B89\u5168\u7B56\u7565\u4E0E\u53EF\u89C6\u5316\u5149\u6807",
  "tour.step4.body": "\u5728\u6B64\u5F00\u5173\u9875\u9762\u5149\u6807\u9AD8\u4EAE\u3001\u63D0\u793A\u8BCD\u6CE8\u5165\u9632\u62A4\uFF0C\u6216\u5728\u201C\u9AD8\u7EA7\u8BBE\u7F6E\u201D\u4E2D\u914D\u7F6E\u53EA\u8BFB\u57DF\u540D\u3002",
  "welcome.heroTitle": "\u6B22\u8FCE\u4F7F\u7528 Chrome Browser MCP",
  "welcome.heroSub": "\u5C06\u672C\u5730 AI \u7F16\u7A0B\u52A9\u624B\u5B89\u5168\u8FDE\u63A5\u5230\u60A8\u771F\u5B9E\u5DF2\u767B\u5F55\u7684\u6D4F\u89C8\u5668\u6807\u7B7E\u9875 \u2014\u2014 100% \u7EAF\u672C\u5730\u8FD0\u884C\u3002",
  "welcome.step1": "\u8BED\u8A00\u4E0E\u4E3B\u9898",
  "welcome.step2": "\u914D\u5BF9 Broker",
  "welcome.step3": "\u5B89\u5168\u4E0E\u89C6\u89C9",
  "welcome.step4": "\u542F\u52A8\u9762\u677F",
  "welcome.localTitle": "100% \u672C\u5730\u4F18\u5148",
  "welcome.localDesc": "\u4EC5\u901A\u8FC7 127.0.0.1 \u672C\u5730\u56DE\u73AF\u901A\u4FE1\u3002\u65E0\u4E91\u7AEF\u670D\u52A1\u5668\u3001\u96F6\u9065\u6D4B\u6570\u636E\uFF0C\u5E76\u63D0\u4F9B\u72EC\u7ACB\u7684 AI Agent \u6807\u7B7E\u9875\u9694\u79BB\u3002",
  "welcome.howTitle": "30 \u79D2\u5FEB\u901F\u4E0A\u624B",
  "welcome.how1": "\u5C06\u6269\u5C55\u8FDE\u63A5\u5230\u672C\u5730 MCP\uFF08\u652F\u6301 Antigravity\u3001Claude Code\u3001Cursor \u548C Codex\uFF09\u3002",
  "welcome.how2": "\u4EC5\u63A5\u5165\u9700\u8981 AI \u534F\u52A9\u7684\u6807\u7B7E\u9875\uFF0C\u5176\u4F59\u79C1\u4EBA\u6807\u7B7E\u9875\u59CB\u7EC8\u4FDD\u6301\u9694\u79BB\u3002",
  "welcome.how3Prefix": "\u968F\u65F6\u6309\u4E0B",
  "welcome.how3Suffix": "\u5373\u53EF\u4E00\u952E\u7D27\u6025\u6682\u505C\u3002",
  "welcome.readyTitle": "\u5168\u90E8\u5C31\u7EEA\uFF01",
  "welcome.readyDesc": "\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u6253\u5F00\u4FA7\u8FB9\u63A7\u5236\u9762\u677F\uFF0C\u4F53\u9A8C 4 \u6B65\u4EA4\u4E92\u5F0F\u5F15\u5BFC\uFF0C\u5FEB\u901F\u4E86\u89E3\u6807\u7B7E\u9694\u79BB\u3001\u7D27\u6025\u6682\u505C\u3001\u5DE5\u4F5C\u6D41\u5F55\u5236\u548C\u5B89\u5168\u8BBE\u7F6E\u3002",
  "welcome.openHud": "\u6253\u5F00\u63A7\u5236\u9762\u677F\u5E76\u5F00\u59CB\u5F15\u5BFC"
};
var I18N_CATALOG = {
  en: EN,
  ru: RU,
  "zh-CN": ZH_CN
};
function resolveLocale(pref) {
  if (pref === "ru")
    return "ru";
  if (pref === "zh-CN")
    return "zh-CN";
  return "en";
}
function translate(locale, key, vars) {
  let text = I18N_CATALOG[locale]?.[key] ?? EN[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

// plugins/claude/src/register.ts
var READ_ONLY_DOMAIN_PRESETS = ["mail.google.com", "github.com", "linear.app"];
var PANE_ID = "chrome-browser-deck";
var DEFAULT_BROKER_PORT = 43179;
var POLL_MS = 3e3;
var VALID_TABS = ["overview", "timeline", "devtools", "workflows", "security"];
function resolveBrokerConfig() {
  const port = process.env.CHROME_BROWSER_MCP_PORT ? Number(process.env.CHROME_BROWSER_MCP_PORT) : DEFAULT_BROKER_PORT;
  const dataDir = process.env.CHROME_BROWSER_MCP_DATA_DIR || join(homedir(), ".chrome-browser-mcp");
  const brokerUrl = `http://127.0.0.1:${port}`;
  return { port, dataDir, brokerUrl };
}
function readBrokerToken(dataDir) {
  const envToken = process.env.CHROME_BROWSER_MCP_TOKEN?.trim();
  if (envToken) return envToken;
  const tokenFile = join(dataDir, "token.txt");
  if (existsSync(tokenFile)) {
    return readFileSync(tokenFile, "utf8").trim();
  }
  return "";
}
function resolveServerCliPath() {
  if (process.env.CHROME_BROWSER_MCP_CLI && existsSync(process.env.CHROME_BROWSER_MCP_CLI)) {
    return process.env.CHROME_BROWSER_MCP_CLI;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, "../../../packages/server/dist/cli.js"),
      resolve(here, "../../../../packages/server/dist/cli.js")
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {
  }
  return null;
}
async function isBrokerHealthy(brokerUrl) {
  try {
    const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}
function createDefaultBrokerClient() {
  let startup = null;
  const ensureRunning = async () => {
    const cfg = resolveBrokerConfig();
    if (await isBrokerHealthy(cfg.brokerUrl)) {
      const token2 = readBrokerToken(cfg.dataDir);
      if (!token2) throw new Error("Broker token missing in ~/.chrome-browser-mcp/token.txt");
      return { brokerUrl: cfg.brokerUrl, token: token2 };
    }
    if (!startup) {
      startup = (async () => {
        const cliPath = resolveServerCliPath();
        if (cliPath) {
          const child = spawn(
            process.execPath,
            [cliPath, "daemon", "--idle-exit", `--port=${cfg.port}`, `--data-dir=${cfg.dataDir}`],
            { detached: true, stdio: "ignore", env: process.env }
          );
          child.unref();
        } else {
          const child = spawn(
            "npx",
            ["-y", "chrome-browser-mcp@latest", "daemon", "--idle-exit", `--port=${cfg.port}`],
            { detached: true, stdio: "ignore", env: process.env }
          );
          child.unref();
        }
        const deadline = Date.now() + 8e3;
        while (Date.now() < deadline) {
          if (await isBrokerHealthy(cfg.brokerUrl)) return;
          await new Promise((r) => setTimeout(r, 180));
        }
        throw new Error(`Local Chrome Browser MCP broker unreachable at ${cfg.brokerUrl}`);
      })().finally(() => {
        startup = null;
      });
    }
    await startup;
    const token = readBrokerToken(cfg.dataDir);
    if (!token) throw new Error("Broker token missing after startup");
    return { brokerUrl: cfg.brokerUrl, token };
  };
  return {
    async callDeckTool(name, args = {}) {
      const { brokerUrl, token } = await ensureRunning();
      const res = await fetch(`${brokerUrl}/internal/deck-tool`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-broker-token": token
        },
        body: JSON.stringify({ name, arguments: args }),
        signal: AbortSignal.timeout(12e3)
      });
      const raw = await res.text();
      const parsed = JSON.parse(raw);
      if (!res.ok || parsed.ok === false) {
        throw new Error(parsed.error || `Broker HTTP error ${res.status}`);
      }
      return parsed.data ?? {};
    }
  };
}
function truncateText(text, maxLen) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 1))}\u2026`;
}
function buildDesktopStatusSvg(connected, paused, agentTabs, totalTabs) {
  const accent = paused ? "#f59e0b" : connected ? "#2563eb" : "#64748b";
  const statusLabel = paused ? "PAUSED" : connected ? "LIVE" : "OFFLINE";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 44" width="320" height="44"><rect x="1" y="1" width="318" height="42" rx="10" fill="#141518" stroke="#2c2f36"/><circle cx="20" cy="22" r="5" fill="${accent}"/><text x="34" y="20" fill="#f1f3f5" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Browser Control Deck \xB7 ${statusLabel}</text><text x="34" y="34" fill="#9ca3af" font-family="system-ui,sans-serif" font-size="10">${agentTabs} AI Agent tabs \xB7 ${totalTabs} total tabs</text></svg>`;
}
function createBrowserDeckMod(brokerOverride) {
  const broker = brokerOverride ?? createDefaultBrokerClient();
  let state = null;
  let lastError = null;
  let notice = null;
  let pairingPin = null;
  let paneOpen = false;
  let activeTab = "overview";
  let tabQuery = "";
  let showBand = true;
  let locale = "en";
  let inFlight = false;
  const tr = (key, vars) => translate(locale, key, vars);
  const runTool = async ($, name, args = {}) => {
    try {
      const res = await broker.callDeckTool(name, args);
      if (res.state) {
        state = res.state;
        lastError = null;
      }
      if (res.pin && res.expiresAt) {
        pairingPin = { pin: res.pin, expiresAt: res.expiresAt };
        notice = res.copied ? `${tr("status.copied")} (${res.pin})` : `PIN: ${res.pin} (valid 2m)`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      notice = lastError;
    }
    $.ui.invalidate("ui.render");
  };
  const refreshState = async ($) => {
    if (inFlight) return;
    inFlight = true;
    try {
      const res = await broker.callDeckTool("deck_get_state");
      if (res.state) {
        state = res.state;
        lastError = null;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      inFlight = false;
      $.ui.invalidate("ui.render");
    }
  };
  return function register2(on) {
    on("session.start", async ($raw, e, nextRaw) => {
      const $ = $raw;
      const next = nextRaw;
      const savedLocale = await $.store.get("locale");
      if (savedLocale === "en" || savedLocale === "ru" || savedLocale === "zh-CN") {
        locale = savedLocale;
      }
      const savedBand = await $.store.get("showBand");
      if (typeof savedBand === "boolean") {
        showBand = savedBand;
      }
      await $.command.register({
        name: "browser-deck",
        description: "Open the Browser Control Deck pane (/browser-deck [tab|pause|resume|pin|band on|off|close])",
        immediate: true
      });
      void refreshState($);
      $.clock.every(POLL_MS, () => {
        if (paneOpen || showBand || (state?.pendingApprovals.length ?? 0) > 0) {
          void refreshState($);
        }
      });
      return next(e);
    });
    on("ui.close", async (_$raw, eRaw, nextRaw) => {
      const e = eRaw;
      const next = nextRaw;
      if (e.id === PANE_ID) {
        paneOpen = false;
      }
      return next(e);
    });
    on("command.run", { command: "browser-deck" }, async ($raw, eRaw) => {
      const $ = $raw;
      const e = eRaw;
      const arg = (e.args ?? "").trim().toLowerCase();
      if (arg === "close") {
        paneOpen = false;
        await $.ui.close({ id: PANE_ID });
        return {};
      }
      if (arg === "pause" || arg === "resume") {
        await runTool($, "deck_set_paused", { paused: arg === "pause" });
        return { text: arg === "pause" ? "Browser automation paused." : "Browser automation resumed." };
      }
      if (arg === "pin") {
        await runTool($, "deck_create_pin", {});
        return {
          text: pairingPin ? `Pairing PIN: ${pairingPin.pin} (valid 2 min \u2014 paste into Chrome Side Panel \u2192 Pair)` : lastError || "Could not generate pairing PIN."
        };
      }
      if (arg === "band on" || arg === "band off") {
        showBand = arg === "band on";
        await $.store.set("showBand", showBand);
        $.ui.invalidate("ui.render");
        return { text: showBand ? "Browser Deck status bar shown." : "Browser Deck status bar hidden." };
      }
      if (VALID_TABS.includes(arg)) {
        activeTab = arg;
      }
      paneOpen = true;
      await $.ui.open({
        id: PANE_ID,
        title: "Browser Deck",
        focus: true,
        closeOnEscape: true
      });
      void refreshState($);
      return {};
    });
    on("ui.render", { component: "AbovePrompt" }, async ($raw, eRaw, nextRaw) => {
      const $ = $raw;
      const e = eRaw;
      const next = nextRaw;
      const hasPending = (state?.pendingApprovals.length ?? 0) > 0;
      if (e.props?.hasSurvey || !showBand && !hasPending) {
        return next(e);
      }
      const { Box, Text, Button } = $.ui.resolve(e);
      const activeProfileId = state?.defaultProfileId ?? state?.profiles[0]?.profileId ?? "";
      const tabs = activeProfileId && state ? state.tabs[activeProfileId] ?? [] : [];
      const agentCount = tabs.filter((t) => t.inAgentGroup).length;
      const firstApproval = state?.pendingApprovals[0];
      const children = [
        Text({
          bold: true,
          color: state?.paused ? "yellow" : state?.profiles.length ? "green" : "gray",
          children: [state?.paused ? "\u23F8 Chrome" : state?.profiles.length ? "\u25CF Chrome" : "\u25CB Chrome"]
        }),
        Text({
          dimColor: true,
          children: [
            state ? ` ${agentCount} AI tabs \xB7 ${tabs.length} total` : lastError ? " broker offline" : " connecting\u2026"
          ]
        })
      ];
      if (firstApproval) {
        children.push(
          Text({
            bold: true,
            color: "yellow",
            children: [` \xB7 \u26A0 ${firstApproval.action} (${firstApproval.origin})`]
          }),
          Button({
            key: "band-approve",
            label: tr("btn.approve"),
            onPress: () => void runTool($, "deck_resolve_approval", {
              approvalId: firstApproval.id,
              decision: "approved"
            })
          }),
          Button({
            key: "band-deny",
            label: tr("btn.deny"),
            onPress: () => void runTool($, "deck_resolve_approval", {
              approvalId: firstApproval.id,
              decision: "rejected"
            })
          })
        );
      }
      children.push(
        Button({
          key: "band-deck",
          label: paneOpen ? "Hide Deck" : "Browser Deck",
          plain: true,
          onPress: async () => {
            if (paneOpen) {
              paneOpen = false;
              await $.ui.close({ id: PANE_ID });
            } else {
              paneOpen = true;
              await $.ui.open({ id: PANE_ID, title: "Browser Deck", focus: true, closeOnEscape: true });
              void refreshState($);
            }
          }
        })
      );
      if (state) {
        children.push(
          Button({
            key: "band-pause",
            label: state.paused ? tr("btn.resume") : tr("btn.pauseAll"),
            plain: true,
            onPress: () => void runTool($, "deck_set_paused", { paused: !state?.paused })
          })
        );
      }
      return Box({
        flexDirection: "row",
        columnGap: 1,
        children
      });
    });
    on("ui.render", { component: "Pane" }, async ($raw, eRaw, nextRaw) => {
      const $ = $raw;
      const e = eRaw;
      const next = nextRaw;
      if (e.requestId !== PANE_ID) return next(e);
      const { Box, Text, Button, Input, Select, Svg } = $.ui.resolve(e);
      const redraw = () => $.ui.invalidate("ui.render");
      if (!state) {
        return Box({
          flexDirection: "column",
          gap: 1,
          padding: 1,
          children: [
            Text({ bold: true, children: [tr("app.deckTitle")] }),
            Text({
              color: lastError ? "red" : "gray",
              children: [lastError ?? "Connecting to Chrome Browser MCP Broker Daemon\u2026"]
            }),
            Box({
              flexDirection: "row",
              columnGap: 2,
              children: [
                Button({ key: "retry", label: tr("btn.refresh"), onPress: () => void refreshState($) }),
                Button({
                  key: "close-err",
                  label: "Close",
                  plain: true,
                  onPress: async () => {
                    paneOpen = false;
                    await $.ui.close({ id: PANE_ID });
                  }
                })
              ]
            })
          ]
        });
      }
      const activeProfileId = state.defaultProfileId ?? state.profiles[0]?.profileId ?? "";
      const profileTabs = activeProfileId ? state.tabs[activeProfileId] ?? [] : [];
      const agentTabs = profileTabs.filter((t) => t.inAgentGroup);
      const controlledCount = state.policy.scopeMode === "all-tabs" ? profileTabs.length : agentTabs.length;
      const q = tabQuery.trim().toLowerCase();
      const otherTabs = profileTabs.filter(
        (t) => !t.inAgentGroup && (!q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q) || String(t.tabId).includes(q))
      );
      const headerChildren = [
        Box({
          flexDirection: "row",
          columnGap: 2,
          children: [
            Text({
              bold: true,
              color: state.profiles.length > 0 ? "blue" : "gray",
              children: [`\u25CF ${tr("app.deckTitle")}`]
            }),
            Text({
              dimColor: true,
              children: [
                `v${state.brokerVersion} \xB7 ${state.profiles.length} ${tr("label.profilesCount")} \xB7 ${profileTabs.length} ${tr("label.tabsCount")}`
              ]
            }),
            ...Select ? [
              Select({
                key: "lang-select",
                label: "Lang",
                value: locale,
                options: [
                  { value: "en", label: "EN" },
                  { value: "ru", label: "RU" },
                  { value: "zh-CN", label: "\u4E2D\u6587" }
                ],
                onSelect: async (val) => {
                  locale = resolveLocale(val);
                  await $.store.set("locale", locale);
                  await runTool($, "deck_update_policy", { uiLocale: locale });
                }
              })
            ] : []
          ]
        })
      ];
      if (e.surface === "desktop" && Svg) {
        headerChildren.push(
          Svg({
            alt: `Browser Control Deck (${agentTabs.length} AI tabs, ${profileTabs.length} total)`,
            width: 320,
            height: 44,
            source: buildDesktopStatusSvg(
              state.profiles.length > 0,
              state.paused,
              agentTabs.length,
              profileTabs.length
            )
          })
        );
      }
      const controlBarChildren = [];
      if (state.profiles.length > 0 && Select) {
        controlBarChildren.push(
          Select({
            key: "profile-select",
            label: "Profile",
            value: activeProfileId,
            options: state.profiles.map((p) => ({
              value: p.profileId,
              label: `${p.browserName}: ${p.profileLabel || p.profileId} (${p.profileId})`
            })),
            onSelect: (val) => void runTool($, "deck_select_profile", { profileId: val })
          })
        );
      }
      controlBarChildren.push(
        Button({
          key: "gen-pin",
          label: tr("btn.generatePin"),
          onPress: () => void runTool($, "deck_create_pin", {})
        }),
        Button({
          key: "refresh",
          label: tr("btn.refresh"),
          onPress: () => void refreshState($)
        }),
        Button({
          key: "pause-toggle",
          label: state.paused ? tr("btn.resume") : tr("btn.pauseAll"),
          onPress: () => void runTool($, "deck_set_paused", { paused: !state?.paused })
        })
      );
      headerChildren.push(Box({ flexDirection: "row", columnGap: 1, children: controlBarChildren }));
      if (pairingPin && Date.now() < pairingPin.expiresAt) {
        headerChildren.push(
          Box({
            borderStyle: "round",
            paddingX: 1,
            flexDirection: "row",
            columnGap: 2,
            children: [
              Text({ bold: true, color: "green", children: [`PIN: ${pairingPin.pin}`] }),
              Text({ dimColor: true, children: ["Paste in Chrome Side Panel \u2192 Pair (valid 2m)"] }),
              Button({
                key: "pin-dismiss",
                label: "\u2715",
                plain: true,
                onPress: () => {
                  pairingPin = null;
                  redraw();
                }
              })
            ]
          })
        );
      }
      if (notice) {
        headerChildren.push(Text({ color: "yellow", children: [notice] }));
      }
      for (const ap of state.pendingApprovals) {
        headerChildren.push(
          Box({
            borderStyle: "round",
            borderColor: "yellow",
            paddingX: 1,
            flexDirection: "column",
            children: [
              Text({
                bold: true,
                color: "yellow",
                children: [`\u26A0 Approval required: ${ap.action} (${ap.origin})`]
              }),
              Text({ dimColor: true, children: [truncateText(ap.reason || ap.preview, 90)] }),
              Box({
                flexDirection: "row",
                columnGap: 2,
                children: [
                  Button({
                    key: `ap-ok-${ap.id}`,
                    label: tr("btn.approve"),
                    onPress: () => void runTool($, "deck_resolve_approval", { approvalId: ap.id, decision: "approved" })
                  }),
                  Button({
                    key: `ap-no-${ap.id}`,
                    label: tr("btn.deny"),
                    onPress: () => void runTool($, "deck_resolve_approval", { approvalId: ap.id, decision: "rejected" })
                  })
                ]
              })
            ]
          })
        );
      }
      const tabDefs = [
        { id: "overview", label: `${tr("tab.overview")} (${controlledCount})`, hotkey: "1" },
        { id: "timeline", label: `${tr("tab.timeline")} (${state.recentActivity.length})`, hotkey: "2" },
        {
          id: "devtools",
          label: `${tr("tab.devtools")} (${state.recentErrors.length + state.recentFailedNetwork.length})`,
          hotkey: "3"
        },
        { id: "workflows", label: `${tr("tab.workflows")} (${state.workflows.length})`, hotkey: "4" },
        { id: "security", label: tr("tab.security"), hotkey: "5" }
      ];
      const tabBar = Box({
        flexDirection: "row",
        columnGap: 2,
        children: tabDefs.map(
          (t) => Button({
            key: `tab-${t.id}`,
            label: activeTab === t.id ? `[${t.label}]` : t.label,
            hotkey: t.hotkey,
            plain: true,
            dimColor: activeTab !== t.id,
            onPress: () => {
              activeTab = t.id;
              redraw();
            }
          })
        )
      });
      const renderTabRow = (t) => Box({
        key: `tab-row-${t.tabId}`,
        flexDirection: "row",
        columnGap: 1,
        children: [
          Box({
            flexDirection: "column",
            children: [
              Text({
                bold: t.active,
                children: [
                  `[${t.tabId}] ${truncateText(t.title || "(untitled)", 48)}${t.cdpAttached ? " [CDP]" : ""}`
                ]
              }),
              Text({ dimColor: true, children: [truncateText(t.url, 56)] })
            ]
          }),
          Button({
            key: `tab-grp-${t.tabId}`,
            label: t.inAgentGroup ? tr("btn.detach") : tr("btn.attach"),
            onPress: () => void runTool($, "deck_tab_action", {
              profileId: activeProfileId,
              tabId: t.tabId,
              action: t.inAgentGroup ? "detach" : "attach"
            })
          }),
          Button({
            key: `tab-foc-${t.tabId}`,
            label: tr("btn.focus"),
            plain: true,
            onPress: () => void runTool($, "deck_tab_action", {
              profileId: activeProfileId,
              tabId: t.tabId,
              action: "focus",
              bringToFront: true
            })
          })
        ]
      });
      const bodyChildren = [];
      if (activeTab === "overview") {
        bodyChildren.push(
          Box({
            borderStyle: "round",
            paddingX: 1,
            flexDirection: "column",
            gap: 1,
            children: [
              Text({ bold: true, children: [`${tr("section.agentTabs")} (${agentTabs.length})`] }),
              ...agentTabs.length === 0 ? [Text({ dimColor: true, children: ["No tabs attached yet. Attach any tab below."] })] : agentTabs.slice(0, 12).map(renderTabRow)
            ]
          })
        );
        const latestShot = state.latestScreenshot;
        if (latestShot) {
          bodyChildren.push(
            Box({
              borderStyle: "round",
              paddingX: 1,
              flexDirection: "column",
              children: [
                Text({
                  bold: true,
                  children: [`${tr("section.latestCapture")} \xB7 Tab ${latestShot.tabId}`]
                }),
                Text({ dimColor: true, children: [truncateText(latestShot.url, 64)] }),
                Text({
                  dimColor: true,
                  children: ["Tip: Ask Claude to call browser_deck for inline HTML viewport preview."]
                })
              ]
            })
          );
        }
        bodyChildren.push(
          Box({
            borderStyle: "round",
            paddingX: 1,
            flexDirection: "column",
            gap: 1,
            children: [
              Text({ bold: true, children: [`${tr("section.allTabs")} (${otherTabs.length})`] }),
              ...Input ? [
                Input({
                  key: "tab-filter",
                  label: "Filter",
                  placeholder: "Filter tabs by title, URL, or ID\u2026",
                  value: tabQuery,
                  onInput: (val) => {
                    tabQuery = val;
                    redraw();
                  },
                  onSubmit: (val) => {
                    tabQuery = val;
                    redraw();
                  }
                })
              ] : [],
              ...otherTabs.slice(0, 20).map(renderTabRow),
              ...otherTabs.length > 20 ? [Text({ dimColor: true, children: [`+${otherTabs.length - 20} more tabs (use Filter)`] })] : []
            ]
          })
        );
      } else if (activeTab === "timeline") {
        bodyChildren.push(
          Box({
            borderStyle: "round",
            paddingX: 1,
            flexDirection: "column",
            gap: 1,
            children: [
              Text({ bold: true, children: [`${tr("tab.timeline")} (${state.recentActivity.length})`] }),
              ...state.recentActivity.length === 0 ? [Text({ dimColor: true, children: ["No recent browser actions recorded."] })] : state.recentActivity.slice(0, 25).map(
                (ev) => Box({
                  key: `act-${ev.id}`,
                  flexDirection: "row",
                  columnGap: 1,
                  children: [
                    Text({
                      color: ev.status === "error" ? "red" : "green",
                      children: [ev.status === "error" ? "\u2717" : "\u2713"]
                    }),
                    Text({ bold: true, children: [ev.tool] }),
                    Text({ dimColor: true, children: [truncateText(ev.summary, 48)] }),
                    Text({ dimColor: true, children: [`${ev.durationMs}ms`] })
                  ]
                })
              )
            ]
          })
        );
      } else if (activeTab === "devtools") {
        bodyChildren.push(
          Box({
            borderStyle: "round",
            paddingX: 1,
            flexDirection: "column",
            gap: 1,
            children: [
              Box({
                flexDirection: "row",
                columnGap: 2,
                children: [
                  Text({ bold: true, children: [`Console Errors (${state.recentErrors.length})`] }),
                  Button({
                    key: "clear-console",
                    label: tr("btn.clear"),
                    plain: true,
                    onPress: () => void runTool($, "deck_clear_diagnostics", { target: "console" })
                  })
                ]
              }),
              ...state.recentErrors.length === 0 ? [Text({ dimColor: true, children: ["No console errors captured."] })] : state.recentErrors.slice(0, 15).map(
                (err) => Text({
                  key: `cerr-${err.id}`,
                  color: "red",
                  children: [`[${err.level}] ${truncateText(err.text, 72)}`]
                })
              )
            ]
          }),
          Box({
            borderStyle: "round",
            paddingX: 1,
            flexDirection: "column",
            gap: 1,
            children: [
              Box({
                flexDirection: "row",
                columnGap: 2,
                children: [
                  Text({ bold: true, children: [`Failed Network (${state.recentFailedNetwork.length})`] }),
                  Button({
                    key: "clear-net",
                    label: tr("btn.clear"),
                    plain: true,
                    onPress: () => void runTool($, "deck_clear_diagnostics", { target: "network" })
                  })
                ]
              }),
              ...state.recentFailedNetwork.length === 0 ? [Text({ dimColor: true, children: ["No failed network requests."] })] : state.recentFailedNetwork.slice(0, 15).map(
                (n) => Text({
                  key: `net-${n.requestId}`,
                  color: "yellow",
                  children: [`${n.method} ${n.status ?? "ERR"} ${truncateText(n.url, 56)}`]
                })
              )
            ]
          })
        );
      } else if (activeTab === "workflows") {
        bodyChildren.push(
          Box({
            borderStyle: "round",
            paddingX: 1,
            flexDirection: "column",
            gap: 1,
            children: [
              Text({ bold: true, children: [`${tr("tab.workflows")} (${state.workflows.length})`] }),
              ...state.workflows.length === 0 ? [
                Text({
                  dimColor: true,
                  children: ["Record workflows from the Chrome Extension Side Panel."]
                })
              ] : state.workflows.map(
                (wf) => Box({
                  key: `wf-${wf.id}`,
                  flexDirection: "row",
                  columnGap: 2,
                  children: [
                    Text({ bold: true, children: [`${wf.name} (${wf.steps.length} steps)`] }),
                    Text({ dimColor: true, children: [truncateText(wf.startUrl, 40)] }),
                    Button({
                      key: `wf-del-${wf.id}`,
                      label: "Delete",
                      plain: true,
                      onPress: () => void runTool($, "deck_delete_workflow", { workflowId: wf.id })
                    })
                  ]
                })
              )
            ]
          })
        );
      } else if (activeTab === "security") {
        const p = state.policy;
        const togglePolicy = (key, label, enabled, patch) => Box({
          key: `pol-${key}`,
          flexDirection: "row",
          columnGap: 2,
          children: [
            Text({ children: [label] }),
            Button({
              key: `pol-btn-${key}`,
              label: enabled ? "ON" : "OFF",
              onPress: () => void runTool($, "deck_update_policy", patch)
            })
          ]
        });
        bodyChildren.push(
          Box({
            borderStyle: "round",
            paddingX: 1,
            flexDirection: "column",
            gap: 1,
            children: [
              Text({ bold: true, children: [tr("tab.security")] }),
              togglePolicy(
                "scope",
                `${tr("setting.scopeMode")}: ${p.scopeMode}`,
                p.scopeMode === "agent-group",
                { scopeMode: p.scopeMode === "agent-group" ? "all-tabs" : "agent-group" }
              ),
              togglePolicy("shield", tr("setting.shield"), p.promptInjectionShield, {
                promptInjectionShield: !p.promptInjectionShield
              }),
              togglePolicy("cursor", tr("setting.visualCursor"), p.visualCursor, {
                visualCursor: !p.visualCursor
              }),
              togglePolicy("eval", tr("setting.evalApproval"), p.requireApprovalForEval, {
                requireApprovalForEval: !p.requireApprovalForEval
              }),
              togglePolicy("cdp", tr("setting.cdpProxy"), p.cdpProxyEnabled, {
                cdpProxyEnabled: !p.cdpProxyEnabled
              }),
              Text({ bold: true, children: [tr("setting.readOnlyDomains")] }),
              Box({
                flexDirection: "row",
                columnGap: 1,
                children: READ_ONLY_DOMAIN_PRESETS.map((domain) => {
                  const active = p.readOnlyDomains.includes(domain);
                  return Button({
                    key: `ro-${domain}`,
                    label: `${active ? "\u2713 " : "+ "}${domain}`,
                    plain: !active,
                    onPress: () => {
                      const nextDomains = active ? p.readOnlyDomains.filter((d) => d !== domain) : [...p.readOnlyDomains, domain];
                      void runTool($, "deck_update_policy", { readOnlyDomains: nextDomains });
                    }
                  });
                })
              })
            ]
          })
        );
      }
      return Box({
        flexDirection: "column",
        gap: 1,
        children: [...headerChildren, tabBar, ...bodyChildren]
      });
    });
  };
}
var register = createBrowserDeckMod();
export {
  PANE_ID,
  createBrowserDeckMod,
  register
};
