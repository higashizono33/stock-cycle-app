import { useStore } from '../state/StoreContext';
import { computeStats, statusClass, formatDisplay } from '@stock-cycle-app/core';

export default function HomeTab() {
  const { state, dispatch } = useStore();

  const withStats = state.items.map((item) => ({ item, stats: computeStats(item) }));
  const tracked = withStats
    .filter((x) => x.item.tracked)
    // Items without a prediction yet (fewer than 2 purchases) sort to the end.
    .sort((a, b) => (a.stats.daysLeft ?? Infinity) - (b.stats.daysLeft ?? Infinity));
  const untracked = withStats.filter((x) => !x.item.tracked);

  const urgentCount = tracked.filter(
    (x) => x.item.alertsOn && x.stats.daysLeft !== null && x.stats.daysLeft <= 3,
  ).length;

  return (
    <div>
      <div className="greeting">Hi there 👋</div>

      {urgentCount > 0 && (
        <div className="banner">
          ⚠️ <b>{urgentCount} item{urgentCount > 1 ? 's' : ''}</b> running low soon. Worth picking up on your
          next shopping trip.
        </div>
      )}

      {tracked.map(({ item, stats }) => {
        const cls = statusClass(stats.daysLeft, item.alertsOn);
        const daysLabel =
          stats.daysLeft === null
            ? stats.purchaseCount <= 1
              ? 'Not enough data yet'
              : 'No history yet'
            : item.alertsOn
              ? `${stats.daysLeft}d left`
              : `🔕 ${stats.daysLeft}d left`;

        return (
          <div className="card item-card" key={item.id}>
            <div className="item-icon">{item.emoji}</div>
            <div className="item-main">
              <div className="item-top">
                <div>
                  <div className="item-name">{item.name}</div>
                  <span className="item-tag">{item.category}</span>
                </div>
                <div className={`item-days ${cls}`}>{daysLabel}</div>
              </div>
              <div className="progress-track">
                <div className={`progress-fill ${cls}`} style={{ width: `${Math.round(stats.progress * 100)}%` }} />
              </div>
              <div className="item-sub">
                {stats.lastBought ? `Last bought ${formatDisplay(stats.lastBought)}` : 'No purchases yet'}
                {stats.avgCycleDays
                  ? ` · avg. cycle ${stats.avgCycleDays} days`
                  : stats.purchaseCount === 1
                    ? ' · log the next purchase to start predicting'
                    : ''}
                {' · '}
                <button className="link-btn inline" onClick={() => dispatch({ type: 'MARK_BOUGHT', id: item.id })}>
                  I bought this today
                </button>
              </div>
              <div className="item-toggles">
                <label className="toggle-row">
                  <span
                    className={`switch ${item.tracked ? 'on' : ''}`}
                    onClick={() => dispatch({ type: 'TOGGLE_TRACK', id: item.id })}
                  >
                    <span className="knob" />
                  </span>
                  Tracking
                </label>
                <label className="toggle-row">
                  <span
                    className={`switch ${item.alertsOn ? 'on' : ''}`}
                    onClick={() => dispatch({ type: 'TOGGLE_ALERT', id: item.id })}
                  >
                    <span className="knob" />
                  </span>
                  Alerts
                </label>
              </div>
            </div>
          </div>
        );
      })}

      {untracked.length > 0 && (
        <>
          <div className="section-title">Not Tracked</div>
          <div className="card">
            {untracked.map(({ item }) => (
              <div className="untracked-row" key={item.id}>
                <div className="item-icon">{item.emoji}</div>
                <div className="item-name">{item.name}</div>
                <button className="track-btn" onClick={() => dispatch({ type: 'TOGGLE_TRACK', id: item.id })}>
                  Track
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
