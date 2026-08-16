import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { FamilyMember, NotificationTiming, PurchaseUpsertRow, Settings, StockItem } from '@stock-cycle-app/core';
import * as api from '../lib/api';

type Action =
  | { type: 'TOGGLE_TRACK'; id: string }
  | { type: 'TOGGLE_ALERT'; id: string }
  | { type: 'MARK_BOUGHT'; id: string }
  | { type: 'ADD_PURCHASES'; rows: PurchaseUpsertRow[] }
  | { type: 'SET_NOTIFICATION_TIMING'; timing: NotificationTiming };

interface StoreState {
  items: StockItem[];
  family: FamilyMember[];
  settings: Settings;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: StoreState = {
  items: [],
  family: [],
  settings: { notificationTiming: 2 },
  loading: true,
  error: null,
};

const StoreContext = createContext<{ state: StoreState; dispatch: (action: Action) => void } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState>(INITIAL_STATE);

  async function refreshItems() {
    const items = await api.listItems();
    setState((s) => ({ ...s, items }));
  }

  async function refreshSettings() {
    const settings = await api.getSettings();
    setState((s) => ({ ...s, settings }));
  }

  useEffect(() => {
    (async () => {
      try {
        const [items, family, settings] = await Promise.all([api.listItems(), api.listFamily(), api.getSettings()]);
        setState({ items, family, settings, loading: false, error: null });
      } catch (err) {
        setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  }, []);

  async function dispatch(action: Action) {
    try {
      switch (action.type) {
        case 'TOGGLE_TRACK': {
          const item = state.items.find((it) => it.id === action.id);
          if (!item) return;
          await api.patchItem(action.id, { tracked: !item.tracked });
          await refreshItems();
          return;
        }
        case 'TOGGLE_ALERT': {
          const item = state.items.find((it) => it.id === action.id);
          if (!item) return;
          await api.patchItem(action.id, { alertsOn: !item.alertsOn });
          await refreshItems();
          return;
        }
        case 'MARK_BOUGHT':
          await api.markBought(action.id);
          await refreshItems();
          return;
        case 'ADD_PURCHASES':
          await api.createPurchases(action.rows);
          await refreshItems();
          return;
        case 'SET_NOTIFICATION_TIMING':
          await api.putSettings({ notificationTiming: action.timing });
          await refreshSettings();
          return;
      }
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}
