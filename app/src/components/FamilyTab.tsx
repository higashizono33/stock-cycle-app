import { useState } from 'react';
import { useStore } from '../state/StoreContext';
import type { NotificationTiming } from '@stock-cycle-app/core';
import { requestLineLinkCode } from '../lib/api';

const MEMBER_COLORS = ['#2F9E7F', '#F2994A', '#5B8DEF', '#EB5757', '#9B59B6'];

export default function FamilyTab() {
  const { state, dispatch } = useStore();
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);

  async function getLinkCode() {
    if (!selectedMemberId) return;
    setIssuing(true);
    try {
      const { code } = await requestLineLinkCode(selectedMemberId);
      setLinkCode(code);
    } finally {
      setIssuing(false);
    }
  }

  return (
    <div>
      <div className="section-title">Family Members</div>
      <p className="section-hint">
        Set up together when the household joined StockCycle. Everyone has equal access — there's no admin/member
        distinction, and adding new members isn't supported yet.
      </p>
      <div className="card">
        {state.family.map((m, i) => (
          <div className="member" key={m.id}>
            <div className="avatar-circle" style={{ background: MEMBER_COLORS[i % MEMBER_COLORS.length] }}>
              {m.name.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="member-name">{m.name}</div>
              <div className="member-role">Can add & edit</div>
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">Link Your LINE Account</div>
      <p className="section-hint">
        requirements.md §3.1: pick your name, get a code, then send that code as a chat message to the StockCycle
        LINE Official Account to receive restock reminders there.
      </p>
      <div className="card">
        <select value={selectedMemberId} onChange={(e) => setSelectedMemberId(e.target.value)}>
          <option value="">Which one are you?</option>
          {state.family.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <div style={{ height: 10 }} />
        <button className="btn btn-secondary" disabled={!selectedMemberId || issuing} onClick={getLinkCode}>
          {issuing ? 'Generating…' : 'Get linking code'}
        </button>
        {linkCode && (
          <div className="banner info" style={{ marginTop: 12 }}>
            🔗 Send this code to the StockCycle LINE account in chat within 15 minutes: <b>{linkCode}</b>
          </div>
        )}
      </div>

      <div className="section-title">Notification Timing</div>
      <p className="section-hint">
        Applies to every tracked item with Alerts turned on. Mute individual items from the Home tab instead of
        changing this.
      </p>
      <div className="card">
        {[1, 2, 5].map((t) => (
          <label className="radio-row" key={t}>
            <input
              type="radio"
              name="timing"
              checked={state.settings.notificationTiming === t}
              onChange={() => dispatch({ type: 'SET_NOTIFICATION_TIMING', timing: t as NotificationTiming })}
            />
            {t === 2 ? '2–3 days before' : `${t} day${t > 1 ? 's' : ''} before`}
          </label>
        ))}
      </div>

      <div className="section-title">About Your Data</div>
      <div className="card muted-note" style={{ margin: 0 }}>
        Receipt photos are automatically deleted 30 days after processing. Only the item name, quantity, and
        purchase date are kept for predictions.
      </div>
    </div>
  );
}
