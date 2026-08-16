import { useRef, useState } from 'react';
import { useStore } from '../state/StoreContext';
import { requestReceiptUploadUrl, scanReceipt as scanReceiptApi, uploadReceiptPhoto } from '../lib/api';
import type { Category, ScannedRow } from '@stock-cycle-app/core';
import { todayISO } from '@stock-cycle-app/core';

type Step = 'choose' | 'loading' | 'confirm' | 'manual';

export default function AddTab({ onDone, showToast }: { onDone: () => void; showToast: (msg: string) => void }) {
  const { dispatch } = useStore();
  const [step, setStep] = useState<Step>('choose');
  const [scannedFrom, setScannedFrom] = useState<{ store: string; date: string } | null>(null);
  const [rows, setRows] = useState<ScannedRow[]>([]);
  const [extractionFailed, setExtractionFailed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [manualName, setManualName] = useState('');
  const [manualCategory, setManualCategory] = useState<Category>('Household');
  const [manualDate, setManualDate] = useState(todayISO());

  function pickPhoto() {
    fileInputRef.current?.click();
  }

  async function onPhotoSelected(file: File | null) {
    if (!file) return;
    setStep('loading');
    const { uploadUrl, key } = await requestReceiptUploadUrl(file.type || 'image/jpeg');
    await uploadReceiptPhoto(uploadUrl, file);
    const result = await scanReceiptApi(key);
    // requirements.md §3.2: if OCR couldn't extract any product info, skip
    // the confirm screen and drop straight into manual entry.
    if (result.rows.length === 0) {
      setExtractionFailed(true);
      setManualDate(result.date);
      setStep('manual');
      return;
    }
    setScannedFrom({ store: result.store, date: result.date });
    setRows(result.rows);
    setStep('confirm');
  }

  function updateRow(i: number, patch: Partial<ScannedRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addRow() {
    setRows((prev) => [...prev, { checked: true, name: '', category: 'Household', qty: 1 }]);
  }

  function saveConfirm() {
    const toSave = rows.filter((r) => r.checked && r.name.trim());
    dispatch({
      type: 'ADD_PURCHASES',
      rows: toSave.map((r) => ({ name: r.name.trim(), category: r.category, qty: r.qty, date: scannedFrom?.date })),
    });
    showToast('Saved! This will be used to refine your restock predictions 🎉');
    reset();
    onDone();
  }

  function saveManual() {
    if (!manualName.trim()) return;
    dispatch({
      type: 'ADD_PURCHASES',
      rows: [{ name: manualName.trim(), category: manualCategory, qty: 1, date: manualDate }],
    });
    showToast('Added manually 👍');
    reset();
    onDone();
  }

  function reset() {
    setStep('choose');
    setRows([]);
    setScannedFrom(null);
    setExtractionFailed(false);
    setManualName('');
    setManualCategory('Household');
    setManualDate(todayISO());
  }

  function backChoose() {
    setExtractionFailed(false);
    setStep('choose');
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => onPhotoSelected(e.target.files?.[0] ?? null)}
      />

      {step === 'choose' && (
        <>
          <p className="hint-text">Upload a receipt and we'll read the items automatically and update your stock levels.</p>
          <button className="choice-btn" onClick={pickPhoto}>
            <div className="ic">📷</div>
            <div>
              Take a Photo
              <span className="sub">Snap a receipt right now</span>
            </div>
          </button>
          <button className="choice-btn" onClick={pickPhoto}>
            <div className="ic">🖼️</div>
            <div>
              Choose from Gallery
              <span className="sub">Pick a saved photo</span>
            </div>
          </button>
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button className="link-btn" onClick={() => setStep('manual')}>
              No receipt? Add an item manually
            </button>
          </div>
        </>
      )}

      {step === 'loading' && (
        <div className="loading-wrap">
          <div className="spinner" />
          <p>
            <b>Scanning your receipt…</b>
          </p>
          <p>Reading item names, quantities, and the purchase date</p>
        </div>
      )}

      {step === 'confirm' && (
        <>
          <div className="banner info">
            🧾 We read a receipt from {scannedFrom?.store}, {scannedFrom?.date}. Please check the details below.
          </div>
          {rows.map((r, i) => (
            <div className="row-item" key={i}>
              <div className="row-item-top">
                <input type="checkbox" checked={r.checked} onChange={(e) => updateRow(i, { checked: e.target.checked })} />
                <input type="text" value={r.name} onChange={(e) => updateRow(i, { name: e.target.value })} />
              </div>
              <div className="row-item-grid">
                <select value={r.category} onChange={(e) => updateRow(i, { category: e.target.value as Category })}>
                  {(['Household', 'Food', 'Other'] as Category[]).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  value={r.qty}
                  onChange={(e) => updateRow(i, { qty: Number(e.target.value) || 1 })}
                />
                <button className="del-btn" onClick={() => removeRow(i)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
          <button className="link-btn" onClick={addRow}>
            ＋ Add an item
          </button>
          <div style={{ height: 8 }} />
          <button className="btn btn-primary" onClick={saveConfirm}>
            Save These Items
          </button>
        </>
      )}

      {step === 'manual' && (
        <>
          {extractionFailed ? (
            <div className="banner">
              📷 We couldn't read that receipt clearly (blurry or damaged photo). Please add the item{rows.length ? 's' : ''}{' '}
              by hand instead.
            </div>
          ) : (
            <p className="hint-text">No receipt? Add an item directly.</p>
          )}
          <div className="field">
            <label>Item name</label>
            <input type="text" placeholder="e.g. Tissues" value={manualName} onChange={(e) => setManualName(e.target.value)} />
          </div>
          <div className="field">
            <label>Category</label>
            <select value={manualCategory} onChange={(e) => setManualCategory(e.target.value as Category)}>
              {(['Household', 'Food', 'Other'] as Category[]).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Purchase date</label>
            <input type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={saveManual}>
            Add Item
          </button>
          <div style={{ textAlign: 'center', marginTop: 10 }}>
            <button className="link-btn" onClick={backChoose}>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}
