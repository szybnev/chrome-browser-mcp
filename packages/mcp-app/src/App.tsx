import { APP_VERSION } from '@chrome-browser-mcp/protocol';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { useMemo, useRef } from 'react';
import { BrowserDeckView } from './DeckView.js';
import type { DeckTransport, ToolStructuredPayload } from './transport.js';

const DECK_SECRET =
  (typeof window !== 'undefined'
    ? (window as unknown as { __CBMCP_DECK_SECRET__?: string }).__CBMCP_DECK_SECRET__
    : undefined) ?? '';

export function App() {
  const pushListenersRef = useRef(new Set<(payload: ToolStructuredPayload) => void>());

  const { app, isConnected, error } = useApp({
    appInfo: { name: 'Browser Control Deck', version: APP_VERSION },
    capabilities: {},
    onAppCreated: (instance) => {
      instance.ontoolresult = (result) => {
        const structured = result.structuredContent as ToolStructuredPayload | undefined;
        if (!structured) return;
        for (const listener of pushListenersRef.current) {
          listener(structured);
        }
      };
    },
  });

  useHostStyles(app, app?.getHostContext());

  const transport = useMemo<DeckTransport>(() => {
    const hostCaps = app?.getHostCapabilities();
    return {
      isConnected: Boolean(isConnected && app),
      error: error ?? null,
      callTool: async (name, args = {}) => {
        if (!app) return undefined;
        const finalArgs =
          name !== 'deck_get_state' && DECK_SECRET ? { deckSecret: DECK_SECRET, ...args } : args;
        const res = await app.callServerTool({ name, arguments: finalArgs });
        return res.structuredContent as ToolStructuredPayload | undefined;
      },
      subscribePush: (cb) => {
        pushListenersRef.current.add(cb);
        return () => {
          pushListenersRef.current.delete(cb);
        };
      },
      sendMessage:
        app && hostCaps?.message
          ? async (text: string) => {
              await app.sendMessage({
                role: 'user',
                content: [{ type: 'text', text }],
              });
            }
          : undefined,
      updateModelContext:
        app && hostCaps?.updateModelContext
          ? async (text: string) => {
              await app.updateModelContext({
                content: [{ type: 'text', text }],
              });
            }
          : undefined,
    };
  }, [app, isConnected, error]);

  return <BrowserDeckView transport={transport} />;
}
