import { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './state/StoreContext';
import { handleRedirectCallback, isSignedIn, redirectToLogin, signOut } from './lib/auth';
import BottomNav, { type Tab } from './components/BottomNav';
import HomeTab from './components/HomeTab';
import AddTab from './components/AddTab';
import NotifyTab from './components/NotifyTab';
import FamilyTab from './components/FamilyTab';

const TITLES: Record<Tab, { t: string; s?: string }> = {
  home: { t: 'StockCycle', s: 'Sorted by soonest predicted restock date' },
  add: { t: 'Add a Receipt' },
  notify: { t: 'Notification Preview' },
  family: { t: 'Family & Settings' },
};

function AppShell() {
  const { state } = useStore();
  const [tab, setTab] = useState<Tab>('home');
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }

  const title = TITLES[tab];

  return (
    <div className="app-shell">
      <header className="appbar">
        <h1>{title.t}</h1>
        {title.s && <p>{title.s}</p>}
        <button className="link-btn inline signout-btn" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main className="content">
        {state.loading && <p className="hint-text">Loading…</p>}
        {state.error && <div className="banner">⚠️ {state.error}</div>}
        {!state.loading && tab === 'home' && <HomeTab />}
        {!state.loading && tab === 'add' && <AddTab onDone={() => setTab('home')} showToast={showToast} />}
        {!state.loading && tab === 'notify' && <NotifyTab />}
        {!state.loading && tab === 'family' && <FamilyTab />}
      </main>
      {toast && <div className="toast show">{toast}</div>}
      <BottomNav tab={tab} onChange={setTab} />
    </div>
  );
}

function SignInScreen({ error }: { error?: string | null }) {
  return (
    <div className="app-shell signin-shell">
      <div className="signin-card">
        <h1>StockCycle</h1>
        <p className="hint-text">Sign in with your LINE account to see your household's stock.</p>
        {error && <div className="banner">⚠️ {error}</div>}
        <button className="btn btn-primary" onClick={() => redirectToLogin()}>
          Sign in with LINE
        </button>
      </div>
    </div>
  );
}

type AuthPhase = 'checking' | 'signed-out' | 'signed-in';

export default function App() {
  const [phase, setPhase] = useState<AuthPhase>('checking');
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await handleRedirectCallback();
        setPhase(isSignedIn() ? 'signed-in' : 'signed-out');
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : String(err));
        setPhase('signed-out');
      }
    })();
  }, []);

  if (phase === 'checking') return null;
  if (phase === 'signed-out') return <SignInScreen error={authError} />;

  return (
    <StoreProvider>
      <AppShell />
    </StoreProvider>
  );
}
