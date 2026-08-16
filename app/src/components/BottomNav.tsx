import type { ReactElement } from 'react';

export type Tab = 'home' | 'add' | 'notify' | 'family';

const TABS: Array<{ id: Tab; label: string; icon: ReactElement }> = [
  {
    id: 'home',
    label: 'Home',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 11l9-8 9 8" />
        <path d="M5 10v10h14V10" />
      </svg>
    ),
  },
  {
    id: 'add',
    label: 'Add',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
      </svg>
    ),
  },
  {
    id: 'notify',
    label: 'Alerts',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M6 8a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6" />
        <path d="M10 20a2 2 0 004 0" />
      </svg>
    ),
  },
  {
    id: 'family',
    label: 'Family',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="8" cy="8" r="3" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
        <path d="M15 14.5c2.5.3 4 2.2 4 5.5" />
      </svg>
    ),
  },
];

export default function BottomNav({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="tabbar">
      {TABS.map((t) => (
        <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.icon}
          {t.label}
        </button>
      ))}
    </nav>
  );
}
