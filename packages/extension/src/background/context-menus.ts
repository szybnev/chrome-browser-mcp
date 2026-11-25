export const CONTEXT_MENU_TOGGLE_TAB = 'chrome-browser-mcp-toggle-tab';

export const TOGGLE_TAB_MENU_PROPS = {
  title: 'Toggle tab in AI Agent group',
  contexts: ['page'],
} satisfies Omit<chrome.contextMenus.CreateProperties, 'id'>;

export interface ContextMenusApi {
  removeAll: (callback: () => void) => void;
  create: (createProperties: chrome.contextMenus.CreateProperties, callback?: () => void) => number | string;
  update: (
    id: string | number,
    updateProperties: Omit<chrome.contextMenus.CreateProperties, 'id'>,
    callback: () => void,
  ) => void;
}

export interface RuntimeErrorSource {
  readonly lastError?: { readonly message?: string };
}

export interface ContextMenuEnvironment {
  contextMenus?: ContextMenusApi;
  runtime?: RuntimeErrorSource;
}

const defaultGetEnvironment = (): ContextMenuEnvironment => ({
  contextMenus: typeof chrome !== 'undefined' ? chrome.contextMenus : undefined,
  runtime: typeof chrome !== 'undefined' ? chrome.runtime : undefined,
});

/**
 * Creates a single-flight, idempotent registrar for the extension's context menu.
 *
 * Prevents `Unchecked runtime.lastError: Cannot create item with duplicate id ...`
 * when `chrome.runtime.onInstalled` and `chrome.runtime.onStartup` fire concurrently
 * or when a pre-existing menu item survives a service worker restart.
 */
export function createContextMenuRegistrar(
  getEnv: () => ContextMenuEnvironment = defaultGetEnvironment,
): () => Promise<void> {
  let inflight: Promise<void> | null = null;

  const registerOnce = async (): Promise<void> => {
    const { contextMenus, runtime } = getEnv();
    if (!contextMenus) return;

    await new Promise<void>((resolve) => {
      try {
        contextMenus.removeAll(() => {
          // Consume chrome.runtime.lastError if present so Chrome does not log an unchecked error.
          void runtime?.lastError;
          resolve();
        });
      } catch {
        resolve();
      }
    });

    await new Promise<void>((resolve) => {
      try {
        contextMenus.create(
          {
            id: CONTEXT_MENU_TOGGLE_TAB,
            ...TOGGLE_TAB_MENU_PROPS,
          },
          () => {
            const createError = runtime?.lastError?.message;
            if (!createError) {
              resolve();
              return;
            }
            if (/duplicate id/i.test(createError)) {
              try {
                contextMenus.update(CONTEXT_MENU_TOGGLE_TAB, TOGGLE_TAB_MENU_PROPS, () => {
                  void runtime?.lastError;
                  resolve();
                });
              } catch {
                resolve();
              }
              return;
            }
            resolve();
          },
        );
      } catch {
        resolve();
      }
    });
  };

  return (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await registerOnce();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}
