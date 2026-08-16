import { useStore } from '../state/StoreContext';
import { buildRestockAlert } from '../lib/linePreview';

export default function NotifyTab() {
  const { state } = useStore();
  const alertItems = buildRestockAlert(state.items, state.settings.notificationTiming);
  const mutedNames = state.items.filter((it) => it.tracked && !it.alertsOn).map((it) => it.name);

  return (
    <div>
      <p className="line-note">
        📱 This is what a LINE reminder looks like. It arrives{' '}
        <b>{state.settings.notificationTiming} day{state.settings.notificationTiming > 1 ? 's' : ''} before</b> the
        predicted restock date, for any tracked item with alerts turned on.
      </p>
      <div className="line-header">
        <div className="avatar">S</div>
        <div className="names">
          <b>StockCycle</b>
          <span>Official Account</span>
        </div>
      </div>
      <div className="line-chat">
        <div className="flex-bubble">
          <div className="ftitle">🔔 Time to restock soon</div>
          {alertItems.length === 0 && <div className="flex-item">Nothing due within the alert window right now.</div>}
          {alertItems.map((it) => (
            <div className="flex-item" key={it.name}>
              {it.emoji} &nbsp;{it.name} ({it.daysLeft} days left)
            </div>
          ))}
          <button className="flex-btn">I bought this</button>
        </div>
        <div className="line-time">Preview only — not sent</div>
      </div>
      {mutedNames.length > 0 && (
        <p className="muted-note">
          🔕 Muted, won't trigger an alert: {mutedNames.join(', ')}. Turn alerts back on for an item from the Home tab.
        </p>
      )}
      <p className="muted-note">
        In the real message, "I bought this" deep-links back into the app and logs today as a new purchase for that
        item, resetting its restock cycle — the same as the "I bought this today" link on each item's Home card.
      </p>
      <p className="muted-note">
        This is a live preview built from your current stock data. The actual LINE message is sent once a day by
        the reminder batch job, not from this screen — this just shows what that message will contain right now.
      </p>
    </div>
  );
}
