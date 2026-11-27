/**
 * Tax and URA details for one catalogue entry.
 *
 * These fields are a different concern from the day-to-day catalogue ones —
 * you set them once, when you first register a product with URA, and rarely
 * touch them again. Keeping them in their own editor stops the "new item" form
 * turning into a tax return, and the same editor serves items, assets and
 * consumables because URA asks all three for the same things.
 */
import { useEffect, useState } from 'react';
import { X, Search } from 'lucide-react';
import SearchableUnitSelect from './SearchableUnitSelect';
import type { TaxRate, ExciseCode } from './efris-types';

export type CatalogKind = 'item' | 'asset' | 'consumable';

export interface CatalogTarget {
  kind: CatalogKind;
  id: number;
  name: string;
  sku?: string | null;
  unitOfMeasureId?: number | null;
  taxRateId?: number | null;
  commodityCode?: string | null;
  haveExciseTax?: string | null;
  exciseDutyCode?: string | null;
  efrisRegisteredAt?: string | null;
}

interface Props {
  apiUrl: string;
  companyId: number;
  target: CatalogTarget;
  taxRates: TaxRate[];
  units: { id: number; code: string; name: string; abbreviation: string; category?: string }[];
  /** Whether EFRIS is on and configured — the URA half is pointless otherwise. */
  efrisReady: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const ENDPOINTS: Record<CatalogKind, string> = {
  item: '/api/items',
  asset: '/api/serialized-assets',
  consumable: '/api/consumables',
};

export default function CatalogTaxModal({ apiUrl, companyId, target, taxRates, units, efrisReady, onClose, onSaved }: Props) {
  const [form, setForm] = useState({
    sku: target.sku || '',
    unitOfMeasureId: (target.unitOfMeasureId ?? '') as number | '',
    taxRateId: (target.taxRateId ?? '') as number | '',
    commodityCode: target.commodityCode || '',
    hasExcise: target.haveExciseTax === '101',
    exciseDutyCode: target.exciseDutyCode || '',
  });
  const [saving, setSaving] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [exciseSearch, setExciseSearch] = useState('');
  const [exciseCodes, setExciseCodes] = useState<ExciseCode[]>([]);

  const headers = { 'Content-Type': 'application/json', 'x-company-id': String(companyId) };

  // Excise codes come from the locally cached URA registry, so typing here never
  // hits the network.
  useEffect(() => {
    if (!form.hasExcise) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${apiUrl}/api/efris/excise-codes?search=${encodeURIComponent(exciseSearch)}`, {
          headers: { 'x-company-id': String(companyId) },
        });
        if (res.ok) setExciseCodes((await res.json()).slice(0, 30));
      } catch { /* the list simply stays as it was */ }
    }, 250);
    return () => clearTimeout(t);
  }, [exciseSearch, form.hasExcise, companyId]);

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${apiUrl}${ENDPOINTS[target.kind]}/${target.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          sku: form.sku,
          unitOfMeasureId: form.unitOfMeasureId === '' ? null : form.unitOfMeasureId,
          taxRateId: form.taxRateId === '' ? null : form.taxRateId,
          commodityCode: form.commodityCode,
          haveExciseTax: form.hasExcise ? '101' : '102',
          exciseDutyCode: form.hasExcise ? form.exciseDutyCode : '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save.');
      onSaved();
      return true;
    } catch (err: any) {
      setMessage({ kind: 'error', text: err.message });
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Registering always saves first, so URA never receives details the operator
  // typed but hadn't committed.
  const saveAndRegister = async () => {
    if (!(await save())) return;
    setRegistering(true);
    setMessage(null);
    try {
      const res = await fetch(`${apiUrl}/api/efris/register/${target.kind}/${target.id}`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed.');
      setMessage({ kind: 'ok', text: data.message });
      onSaved();
    } catch (err: any) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setRegistering(false);
    }
  };

  const busy = saving || registering;
  const kindLabel = target.kind === 'item' ? 'Hire item' : target.kind === 'asset' ? 'Serialized asset' : 'Consumable';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-neo shadow-neo-outset rounded-2xl p-6 w-full max-w-lg space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between border-b border-slate-200/10 pb-3">
          <div>
            <h3 className="text-sm font-black text-slate-800 dark:text-white">Tax &amp; URA details</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">{kindLabel} · {target.name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl bg-neo shadow-neo-outset-sm hover:shadow-neo-inset-sm text-slate-500 active-shrink cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold text-slate-500 block">SKU / code</label>
              <input
                value={form.sku}
                onChange={e => setForm(f => ({ ...f, sku: e.target.value }))}
                placeholder="Your own product code"
                className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none"
              />
              <p className="text-[9px] text-slate-400">URA identifies the product by this. Changing it after registering orphans the registration.</p>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold text-slate-500 block">Tax rate</label>
              <select
                value={form.taxRateId}
                onChange={e => setForm(f => ({ ...f, taxRateId: e.target.value === '' ? '' : Number(e.target.value) }))}
                className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
              >
                <option value="">Use the business default</option>
                {taxRates.filter(r => r.isActive).map(r => (
                  <option key={r.id} value={r.id}>{r.name} — {(Number(r.rate) * 100).toFixed(0)}%</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase font-bold text-slate-500 block">Unit of measure</label>
            <SearchableUnitSelect
              options={units}
              value={form.unitOfMeasureId}
              onChange={v => setForm(f => ({ ...f, unitOfMeasureId: v }))}
              placeholder="Search URA units…"
            />
          </div>

          {efrisReady && (
            <>
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 block">URA commodity code *</label>
                <input
                  value={form.commodityCode}
                  onChange={e => setForm(f => ({ ...f, commodityCode: e.target.value }))}
                  placeholder="e.g. 73110000"
                  className="w-full bg-neo shadow-neo-inset-sm border-none p-2.5 rounded-xl text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none"
                />
                <p className="text-[9px] text-slate-400">URA's classification for this product. Required before it can be registered.</p>
              </div>

              <div className="space-y-2 border-t border-slate-200/10 pt-3">
                <label className="flex items-center justify-between cursor-pointer">
                  <span>
                    <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 block">Subject to excise duty</span>
                    <span className="text-[9px] text-slate-500">Most hire equipment is not. Beverages, fuel and similar goods are.</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={form.hasExcise}
                    onChange={e => setForm(f => ({ ...f, hasExcise: e.target.checked }))}
                    className="w-4 h-4 accent-blue-600 cursor-pointer flex-shrink-0"
                  />
                </label>

                {form.hasExcise && (
                  <div className="space-y-2">
                    <div className="relative">
                      <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        value={exciseSearch}
                        onChange={e => setExciseSearch(e.target.value)}
                        placeholder="Search the URA excise register…"
                        className="w-full bg-neo shadow-neo-inset-sm border-none py-2 pl-8 pr-2.5 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
                      />
                    </div>
                    {form.exciseDutyCode && (
                      <p className="text-[10px] text-slate-600 dark:text-slate-400">
                        Selected: <span className="font-mono font-bold">{form.exciseDutyCode}</span>
                      </p>
                    )}
                    <div className="max-h-40 overflow-y-auto bg-neo shadow-neo-inset-sm rounded-xl divide-y divide-slate-200/10">
                      {exciseCodes.length === 0 ? (
                        <p className="text-[10px] text-slate-400 p-3 text-center">
                          Nothing found. Sync the excise codes under Settings → URA EFRIS first.
                        </p>
                      ) : exciseCodes.map(c => (
                        <button
                          key={c.id}
                          onClick={() => setForm(f => ({ ...f, exciseDutyCode: c.code }))}
                          className={`w-full text-left p-2.5 hover:bg-slate-200/10 cursor-pointer ${form.exciseDutyCode === c.code ? 'bg-blue-500/10' : ''}`}
                        >
                          <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 block">{c.name}</span>
                          <span className="text-[9px] text-slate-400 font-mono">
                            {c.code}
                            {c.rate ? ` · ${c.rate}${c.exciseRule === '2' ? ` per ${c.unit || 'unit'}` : '%'}` : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {message && (
          <p className={`text-[10px] leading-relaxed ${message.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
            {message.text}
          </p>
        )}

        <div className="flex justify-end gap-3 border-t border-slate-200/10 pt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-slate-600 dark:text-slate-400 active-shrink cursor-pointer"
          >
            Close
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="px-4 py-2 rounded-xl bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-xs font-bold text-blue-600 dark:text-blue-400 active-shrink cursor-pointer disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {efrisReady && (
            <button
              onClick={saveAndRegister}
              disabled={busy}
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-5 py-2 rounded-xl shadow-lg active-shrink cursor-pointer disabled:opacity-60"
            >
              {registering ? 'Registering…' : target.efrisRegisteredAt ? 'Save & update at URA' : 'Save & register with URA'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
