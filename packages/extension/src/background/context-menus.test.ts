import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_MENU_TOGGLE_TAB,
  type ContextMenusApi,
  createContextMenuRegistrar,
  TOGGLE_TAB_MENU_PROPS,
} from './context-menus.js';

interface MockChromeContextMenus {
  contextMenus: ContextMenusApi;
  runtime: { readonly lastError?: { readonly message?: string } };
  items: Map<string, Omit<chrome.contextMenus.CreateProperties, 'id'>>;
  uncheckedErrors: string[];
  removeAllCalls: () => number;
  createCalls: () => number;
  updateCalls: () => number;
  flushPending: () => void;
}

function createMockChromeContextMenus(options?: {
  deferRemoveAll?: boolean;
  preExistingDuplicateOnCreate?: boolean;
  createErrorMessage?: string;
}): MockChromeContextMenus {
  const items = new Map<string, Omit<chrome.contextMenus.CreateProperties, 'id'>>();
  const pendingCallbacks: Array<() => void> = [];
  const uncheckedErrors: string[] = [];

  let currentError: { message: string } | undefined;
  let errorChecked = true;

  const runtime = {
    get lastError(): { readonly message?: string } | undefined {
      errorChecked = true;
      return currentError;
    },
  };

  const invokeWithError = (errorMessage: string | undefined, callback?: () => void) => {
    currentError = errorMessage ? { message: errorMessage } : undefined;
    errorChecked = !errorMessage;
    try {
      callback?.();
    } finally {
      if (currentError && !errorChecked) {
        uncheckedErrors.push(currentError.message);
      }
      currentError = undefined;
      errorChecked = true;
    }
  };

  const removeAllSpy = vi.fn((callback: () => void) => {
    const finish = () => {
      items.clear();
      invokeWithError(undefined, callback);
    };
    if (options?.deferRemoveAll) {
      pendingCallbacks.push(finish);
    } else {
      queueMicrotask(finish);
    }
  });

  const createSpy = vi.fn((props: chrome.contextMenus.CreateProperties, callback?: () => void) => {
    const id = String(props.id ?? '');
    const finish = () => {
      if (options?.createErrorMessage) {
        invokeWithError(options.createErrorMessage, callback);
        return;
      }
      if (options?.preExistingDuplicateOnCreate || items.has(id)) {
        invokeWithError(`Cannot create item with duplicate id ${id}`, callback);
        return;
      }
      const { id: _ignored, ...rest } = props;
      items.set(id, rest as Omit<chrome.contextMenus.CreateProperties, 'id'>);
      invokeWithError(undefined, callback);
    };
    queueMicrotask(finish);
    return id;
  });

  const updateSpy = vi.fn(
    (
      id: string | number,
      updateProperties: Omit<chrome.contextMenus.CreateProperties, 'id'>,
      callback: () => void,
    ) => {
      queueMicrotask(() => {
        items.set(String(id), updateProperties);
        invokeWithError(undefined, callback);
      });
    },
  );

  return {
    contextMenus: {
      removeAll: removeAllSpy,
      create: createSpy,
      update: updateSpy,
    },
    runtime,
    items,
    uncheckedErrors,
    removeAllCalls: () => removeAllSpy.mock.calls.length,
    createCalls: () => createSpy.mock.calls.length,
    updateCalls: () => updateSpy.mock.calls.length,
    flushPending: () => {
      while (pendingCallbacks.length > 0) {
        pendingCallbacks.shift()?.();
      }
    },
  };
}

describe('createContextMenuRegistrar', () => {
  it('removes stale items and creates the toggle-tab menu item with no unchecked runtime.lastError', async () => {
    const mock = createMockChromeContextMenus();
    mock.items.set('stale-item', { title: 'Old item', contexts: ['page'] });

    const ensureContextMenus = createContextMenuRegistrar(() => ({
      contextMenus: mock.contextMenus,
      runtime: mock.runtime,
    }));

    await ensureContextMenus();

    expect(mock.removeAllCalls()).toBe(1);
    expect(mock.createCalls()).toBe(1);
    expect(mock.updateCalls()).toBe(0);
    expect(mock.uncheckedErrors).toEqual([]);
    expect(mock.items.has('stale-item')).toBe(false);
    expect(mock.items.get(CONTEXT_MENU_TOGGLE_TAB)).toEqual(TOGGLE_TAB_MENU_PROPS);
  });

  it('coalesces concurrent calls (onInstalled + onStartup race) into one single-flight registration', async () => {
    const mock = createMockChromeContextMenus({ deferRemoveAll: true });
    const ensureContextMenus = createContextMenuRegistrar(() => ({
      contextMenus: mock.contextMenus,
      runtime: mock.runtime,
    }));

    const first = ensureContextMenus();
    const second = ensureContextMenus();

    expect(mock.removeAllCalls()).toBe(1);
    mock.flushPending();

    await Promise.all([first, second]);

    expect(mock.removeAllCalls()).toBe(1);
    expect(mock.createCalls()).toBe(1);
    expect(mock.uncheckedErrors).toEqual([]);
    expect(mock.items.get(CONTEXT_MENU_TOGGLE_TAB)).toEqual(TOGGLE_TAB_MENU_PROPS);
  });

  it('allows sequential re-registration after an earlier registration completes', async () => {
    const mock = createMockChromeContextMenus();
    const ensureContextMenus = createContextMenuRegistrar(() => ({
      contextMenus: mock.contextMenus,
      runtime: mock.runtime,
    }));

    await ensureContextMenus();
    await ensureContextMenus();

    expect(mock.removeAllCalls()).toBe(2);
    expect(mock.createCalls()).toBe(2);
    expect(mock.uncheckedErrors).toEqual([]);
  });

  it('consumes duplicate-id runtime.lastError and updates the existing menu item instead of leaking an error', async () => {
    const mock = createMockChromeContextMenus({ preExistingDuplicateOnCreate: true });
    const ensureContextMenus = createContextMenuRegistrar(() => ({
      contextMenus: mock.contextMenus,
      runtime: mock.runtime,
    }));

    await ensureContextMenus();

    expect(mock.createCalls()).toBe(1);
    expect(mock.updateCalls()).toBe(1);
    expect(mock.uncheckedErrors).toEqual([]);
    expect(mock.items.get(CONTEXT_MENU_TOGGLE_TAB)).toEqual(TOGGLE_TAB_MENU_PROPS);
  });

  it('consumes non-duplicate runtime.lastError without throwing or updating', async () => {
    const mock = createMockChromeContextMenus({ createErrorMessage: 'Unexpected contextMenus error' });
    const ensureContextMenus = createContextMenuRegistrar(() => ({
      contextMenus: mock.contextMenus,
      runtime: mock.runtime,
    }));

    await expect(ensureContextMenus()).resolves.toBeUndefined();

    expect(mock.createCalls()).toBe(1);
    expect(mock.updateCalls()).toBe(0);
    expect(mock.uncheckedErrors).toEqual([]);
  });
});
