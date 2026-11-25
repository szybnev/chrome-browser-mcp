export type DeckTab = 'overview' | 'timeline' | 'devtools' | 'workflows' | 'security';

declare module 'claude-code' {
  interface PluginState {
    'chrome-browser-mcp': {
      paneOpen: boolean;
      activeTab: DeckTab;
      tabQuery: string;
      showBand: boolean;
      locale: 'en' | 'ru' | 'zh-CN';
    };
  }
}
