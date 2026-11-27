/**
 * Tax rates, defined per business in Settings.
 *
 * Every company runs its own list: a VAT-registered hire firm needs 18% plus
 * zero-rated and exempt, a small one may need none at all. Each rate carries the
 * URA tax-category code that EFRIS reports it under, which is why the code is a
 * fixed choice rather than free text.
 */
import { useEffect, useState } from 'react';
import { Plus, Trash2, Check, Percent } from 'lucide-react';
import { TAX_CATEGORIES, type TaxRate } from './efris-types';

interface Props {
  apiUrl: string;
  companyId: number;
  /** Whether the business's catalogue rates already include tax. */
  pricesIncludeTax: boolean;
  onPricesIncludeTaxChange: (value: boolean) => void;
  /** Called after any change, so the rest of the app can re-read the catalogue. */
  onChanged?: () => void;
}

export default function TaxRatesPanel({ apiUrl, companyId, pricesIncludeTax, onPricesIncludeTaxChange, onChanged }: Props) {
  const [rates, setRates] = useState<TaxRate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [draft, setDraft] = useState({ name: '', percent: '18', taxCode: '01', isDefault: false });

  const headers = { 'Content-Type': 'application/json', 'x-company-id': String(companyId) };

  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const res = await fetch(`${apiUrl}/api/tax-rates`, { headers: { 'x-company-id': String(companyId) } });
      if (res.ok) { setRates(await res.json()); return; }
      // Without this the panel would sit on "Loading…" indefinitely.
      setLoadError(res.status === 401
        ? 'Your session expired while this was loading.'
        : `Could not load the tax rates (HTTP ${res.status}).`);
    } catch {
      setLoadError('Could not reach the server.');
    }
  };

  useEffect(() => { load(); }, [companyId]);

  const call = async (path: string, init: RequestInit, okText: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${apiUrl}${path}`, { ...init, headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      setMessage({ kind: 'ok', text: data.message || okText });
      await load();
      onChanged?.();
      return true;
    } catch (err: any) {
      setMessage({ kind: 'error', text: err.message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addRate = async () => {
    const percent = Number(draft.percent);
    if (!draft.name.trim()) return setMessage({ kind: 'error', text: 'Give the rate a name.' });
    if (isNaN(percent) || percent < 0 || percent > 100) {
      return setMessage({ kind: 'error', text: 'Enter the rate as a percentage between 0 and 100.' });
    }
    const ok = await call('/api/tax-rates', {
      method: 'POST',
      body: JSON.stringify({ name: draft.name.trim(), rate: percent / 100, taxCode: draft.taxCode, isDefault: draft.isDefault }),
    }, 'Tax rate added.');
    if (ok) setDraft({ name: '', percent: '18', taxCode: '01', isDefault: false });
  };

  const pct = (r: TaxRate) => (Number(r.rate) * 100).toFixed(Number(r.rate) * 100 % 1 === 0 ? 0 : 2);

  if (!rates) {
    return loadError ? (
      <div className="space-y-2">
        <p className="text-[11px] text-red-500">{loadError}</p>
        <button
          onClick={load}
          className="px-3 py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink transition-all cursor-pointer"
        >
          Try again
        </button>
      </div>
    ) : (
      <p className="text-[11px] text-slate-400">Loading tax rates…</p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase border-b border-slate-200/10 pb-2 flex items-center gap-2">
          <Percent size={13} /> Tax Rates
        </h3>
        <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
          The rates this business charges. Each one is reported to URA under its tax category,
          so pick the category that matches — that is what appears on a fiscal invoice.
        </p>
      </div>

      {/* How the catalogue prices are meant to be read. Getting this wrong shifts
          every invoice by the tax amount, so it sits above the rates themselves. */}
      <label className="flex items-start justify-between gap-3 bg-neo shadow-neo-inset-sm rounded-xl p-3 cursor-pointer border border-transparent">
        <span>
          <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 block">Catalogue rates already include tax</span>
          <span className="text-[9px] text-slate-500 leading-relaxed block mt-0.5">
            On: a 2,500 chair stays 2,500 on the invoice, with the VAT shown inside it.
            Off: tax is added on top, so it bills at 2,950.
          </span>
        </span>
        <input
          type="checkbox"
          checked={pricesIncludeTax}
          onChange={e => onPricesIncludeTaxChange(e.target.checked)}
          className="w-4 h-4 accent-blue-600 cursor-pointer mt-0.5 flex-shrink-0"
        />
      </label>

      {rates.length === 0 ? (
        <div className="bg-neo shadow-neo-inset-sm rounded-xl p-4 text-center space-y-2 border border-transparent">
          <p className="text-[11px] text-slate-500">No tax rates set up yet.</p>
          <button
            onClick={() => call('/api/tax-rates/defaults', { method: 'POST' }, 'Standard rates added.')}
            disabled={busy}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold rounded-lg active-shrink transition-all cursor-pointer disabled:opacity-60"
          >
            Add the standard Uganda rates
          </button>
          <p className="text-[9px] text-slate-400">Standard VAT 18%, Zero Rated, and Exempt.</p>
        </div>
      ) : (
        <div className="bg-neo shadow-neo-inset-sm rounded-xl overflow-hidden border border-transparent">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[9px] text-slate-500 uppercase font-black">
                <th className="p-2.5">Name</th>
                <th className="p-2.5 text-right">Rate</th>
                <th className="p-2.5">URA Category</th>
                <th className="p-2.5 text-center">Default</th>
                <th className="p-2.5"></th>
              </tr>
            </thead>
            <tbody className="text-[11px] divide-y divide-slate-200/10">
              {rates.map(r => (
                <tr key={r.id} className={r.isActive ? '' : 'opacity-50'}>
                  <td className="p-2.5 font-bold text-slate-700 dark:text-slate-300">
                    {r.name}
                    {!r.isActive && <span className="ml-1.5 text-[9px] text-slate-400 font-normal">(retired)</span>}
                  </td>
                  <td className="p-2.5 text-right font-mono">{pct(r)}%</td>
                  <td className="p-2.5 text-slate-500 text-[10px]">
                    {TAX_CATEGORIES.find(c => c.code === r.taxCode)?.label || r.taxCode}
                  </td>
                  <td className="p-2.5 text-center">
                    {r.isDefault ? (
                      <Check size={13} className="inline text-emerald-500" />
                    ) : (
                      <button
                        onClick={() => call(`/api/tax-rates/${r.id}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) }, 'Default rate changed.')}
                        disabled={busy || !r.isActive}
                        className="text-[9px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer disabled:opacity-40"
                      >
                        Make default
                      </button>
                    )}
                  </td>
                  <td className="p-2.5 text-right">
                    <button
                      onClick={() => {
                        if (!confirm(`Remove "${r.name}"? Invoices already issued keep the rate they were charged at.`)) return;
                        call(`/api/tax-rates/${r.id}`, { method: 'DELETE' }, 'Tax rate removed.');
                      }}
                      disabled={busy}
                      className="text-slate-400 hover:text-red-500 cursor-pointer disabled:opacity-40"
                      title="Remove this rate"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add a rate */}
      <div className="grid grid-cols-12 gap-2 items-end">
        <div className="col-span-4 space-y-1">
          <label className="text-[9px] uppercase font-bold text-slate-500 block">Name</label>
          <input
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder="e.g. Standard VAT (18%)"
            className="w-full bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none"
          />
        </div>
        <div className="col-span-2 space-y-1">
          <label className="text-[9px] uppercase font-bold text-slate-500 block">Rate %</label>
          <input
            type="number" min={0} max={100} step="0.01"
            value={draft.percent}
            onChange={e => setDraft(d => ({ ...d, percent: e.target.value }))}
            className="w-full bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[11px] text-center font-mono text-slate-800 dark:text-slate-200 focus:outline-none"
          />
        </div>
        <div className="col-span-4 space-y-1">
          <label className="text-[9px] uppercase font-bold text-slate-500 block">URA category</label>
          <select
            value={draft.taxCode}
            onChange={e => setDraft(d => ({ ...d, taxCode: e.target.value }))}
            className="w-full bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none"
          >
            {TAX_CATEGORIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <button
            onClick={addRate}
            disabled={busy}
            className="w-full py-2 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink transition-all cursor-pointer disabled:opacity-60 flex items-center justify-center gap-1"
          >
            <Plus size={12} /> Add
          </button>
        </div>
      </div>

      {message && (
        <p className={`text-[10px] ${message.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
