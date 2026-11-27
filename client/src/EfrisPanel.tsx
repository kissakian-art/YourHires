/**
 * URA EFRIS setup for this business.
 *
 * Deliberately per-business: URA issues the API key against the taxpayer's own
 * TIN, so it belongs to them and is stored on their own company record, never
 * shared. The URL and key are the only credentials — the TIN itself is read back
 * from URA on a connection test, because asking someone to retype what the key
 * already identifies only creates a value that can drift.
 *
 * YourHires only calls the EFRIS middleware over HTTPS — the middleware does the
 * URA-facing work — but a wrong key or URL still breaks fiscalization mid-invoice,
 * which is why there is a Test button rather than finding out then.
 *
 * The panel also covers the two things that must exist before an invoice can be
 * fiscalized at all: every catalogue entry registered with URA (T130), and a
 * service product for charges that aren't catalogue items (late fees, damage
 * recovery).
 */
import { useEffect, useState } from 'react';
import {
  ShieldCheck, AlertTriangle, Plug, KeyRound, RefreshCw, CheckCircle2,
  CircleDashed, Package, Boxes, Wrench,
} from 'lucide-react';
import type { EfrisSettings, EfrisCatalogEntry, StockMovement } from './efris-types';

interface Props {
  apiUrl: string;
  companyId: number;
  /** Called after a save so the rest of the app can re-read the company. */
  onSaved?: () => void;
}

type Tab = 'connection' | 'catalog' | 'stock';

export default function EfrisPanel({ apiUrl, companyId, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>('connection');
  const [settings, setSettings] = useState<EfrisSettings | null>(null);
  const [form, setForm] = useState({ enabled: false, apiUrl: '', apiKey: '', feeItemName: '', feeCommodityCode: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [catalog, setCatalog] = useState<{ items: EfrisCatalogEntry[]; assets: EfrisCatalogEntry[]; consumables: EfrisCatalogEntry[] } | null>(null);
  const [movements, setMovements] = useState<StockMovement[]>([]);

  const headers = { 'Content-Type': 'application/json', 'x-company-id': String(companyId) };

  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSettings = async () => {
    setLoadError(null);
    try {
      const res = await fetch(`${apiUrl}/api/efris/settings`, { headers: { 'x-company-id': String(companyId) }, cache: 'no-store' });
      if (!res.ok) {
        // A failed first load used to leave the panel on "Loading…" forever with
        // no way out but a page refresh.
        setLoadError(res.status === 401
          ? 'Your session expired while this was loading.'
          : `Could not read the EFRIS settings (HTTP ${res.status}).`);
        return;
      }
      const data: EfrisSettings = await res.json();
      setSettings(data);
      setForm({
        enabled: data.enabled,
        apiUrl: data.apiUrl,
        apiKey: '',
        feeItemName: data.feeItemName,
        feeCommodityCode: data.feeCommodityCode || '',
      });
    } catch {
      setLoadError('Could not reach the server.');
    }
  };

  const loadCatalog = async () => {
    try {
      const res = await fetch(`${apiUrl}/api/efris/catalog-status`, { headers: { 'x-company-id': String(companyId) } });
      if (res.ok) setCatalog(await res.json());
    } catch { /* the panel simply shows nothing */ }
  };

  const loadMovements = async () => {
    try {
      const res = await fetch(`${apiUrl}/api/efris/stock-movements`, { headers: { 'x-company-id': String(companyId) } });
      if (res.ok) setMovements(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => { loadSettings(); }, [companyId]);
  useEffect(() => {
    if (tab === 'catalog') loadCatalog();
    if (tab === 'stock') loadMovements();
  }, [tab, companyId]);

  const save = async () => {
    setBusy('save');
    setMessage(null);
    try {
      const res = await fetch(`${apiUrl}/api/efris/settings`, {
        method: 'POST',
        headers,
        // An empty key box means "keep the saved key" — it can never show the
        // stored value, so blanking it must not wipe it.
        body: JSON.stringify({
          enabled: form.enabled,
          apiUrl: form.apiUrl,
          feeItemName: form.feeItemName,
          feeCommodityCode: form.feeCommodityCode,
          ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMessage({ kind: 'ok', text: data.message });
      setForm(f => ({ ...f, apiKey: '' }));
      await loadSettings();
      onSaved?.();
    } catch (err: any) {
      setMessage({ kind: 'error', text: err.message || 'Could not reach the server.' });
    } finally {
      setBusy(null);
    }
  };

  const post = async (path: string, label: string, after?: () => Promise<void>) => {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(`${apiUrl}${path}`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMessage({ kind: 'ok', text: data.message || 'Done.' });
      await after?.();
    } catch (err: any) {
      setMessage({ kind: 'error', text: err.message || 'Could not reach the server.' });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setMessage(null);
    try {
      const res = await fetch(`${apiUrl}/api/efris/test`, { method: 'POST', headers });
      const data = await res.json();
      setMessage(res.ok
        ? { kind: 'ok', text: `${data.message} (${data.responseMs}ms)` }
        : { kind: 'error', text: data.error });
      if (res.ok) { await loadSettings(); onSaved?.(); }
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the server.' });
    } finally {
      setBusy(null);
    }
  };

  if (!settings) {
    return loadError ? (
      <div className="space-y-2">
        <p className="text-[11px] text-red-500">{loadError}</p>
        <button
          onClick={loadSettings}
          className="px-3 py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink transition-all cursor-pointer"
        >
          Try again
        </button>
      </div>
    ) : (
      <p className="text-[11px] text-slate-400">Loading EFRIS settings…</p>
    );
  }

  const tabs: { key: Tab; label: string; icon: any }[] = [
    { key: 'connection', label: 'Connection', icon: Plug },
    { key: 'catalog', label: 'Product registration', icon: Package },
    { key: 'stock', label: 'Stock reports', icon: Boxes },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase border-b border-slate-200/10 pb-2 flex items-center gap-2">
          <ShieldCheck size={13} /> URA EFRIS e-Invoicing
        </h3>
        <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
          Fiscalize invoices and credit notes with URA, register your catalogue, and report
          consumable stock. Your API key is issued by URA against your own TIN and is stored
          only on this business's record.
        </p>
      </div>

      <div className="flex gap-1.5">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all cursor-pointer ${
              tab === t.key
                ? 'bg-blue-600 text-white'
                : 'bg-neo shadow-neo-outset text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            <t.icon size={12} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'connection' && (
        <div className="space-y-3">
          <label className="flex items-center justify-between bg-neo shadow-neo-inset-sm rounded-xl p-3 cursor-pointer border border-transparent">
            <span>
              <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 block">Use URA EFRIS</span>
              <span className="text-[9px] text-slate-500">Adds fiscalize actions to invoices and credit notes.</span>
            </span>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
              className="w-4 h-4 accent-blue-600 cursor-pointer flex-shrink-0"
            />
          </label>

          <div className="space-y-1">
            <label className="text-[9px] uppercase font-bold text-slate-500 block">EFRIS service URL</label>
            <input
              value={form.apiUrl}
              onChange={e => setForm(f => ({ ...f, apiUrl: e.target.value }))}
              className="w-full bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[10px] text-slate-800 dark:text-slate-200 focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[9px] uppercase font-bold text-slate-500 flex items-center gap-1">
              <KeyRound size={10} /> API key
              {settings.configured && <span className="text-emerald-600 dark:text-emerald-400 font-mono normal-case">· saved {settings.apiKeyMasked}</span>}
            </label>
            <input
              type="password"
              value={form.apiKey}
              onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
              placeholder={settings.configured ? 'Leave blank to keep the saved key' : 'Paste the key URA issued you'}
              className="w-full bg-neo shadow-neo-inset-sm border-none p-2 rounded-lg text-[11px] font-mono text-slate-800 dark:text-slate-200 focus:outline-none"
            />
            <p className="text-[9px] text-slate-400">
              The URL and key are the only credentials needed. Your TIN comes from URA when you
              test the connection — the key is issued against it.
            </p>
          </div>

          {/* Charges that aren't catalogue items still need a registered product
              at URA, or the invoice carrying them is rejected. */}
          <div className="bg-neo shadow-neo-inset-sm rounded-xl p-3 space-y-2.5 border border-transparent">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase font-black text-slate-500 flex items-center gap-1.5">
                <Wrench size={11} /> Charges &amp; penalties
              </p>
              {settings.feeRegisteredAt
                ? <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 size={11} /> Registered</span>
                : <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1"><CircleDashed size={11} /> Not registered</span>}
            </div>
            <p className="text-[9px] text-slate-500 leading-relaxed">
              Late fees, damage recovery and ad-hoc charges aren't catalogue items, so URA bills
              them under one service product. Register it once and every charge invoice can be
              fiscalized.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[9px] uppercase font-bold text-slate-500 block">Product name</label>
                <input
                  value={form.feeItemName}
                  onChange={e => setForm(f => ({ ...f, feeItemName: e.target.value }))}
                  className="w-full bg-neo shadow-neo-outset border-none p-2 rounded-lg text-[10px] text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[9px] uppercase font-bold text-slate-500 block">URA commodity code</label>
                <input
                  value={form.feeCommodityCode}
                  onChange={e => setForm(f => ({ ...f, feeCommodityCode: e.target.value }))}
                  placeholder="e.g. 73110000"
                  className="w-full bg-neo shadow-neo-outset border-none p-2 rounded-lg text-[10px] font-mono text-slate-800 dark:text-slate-200 focus:outline-none"
                />
              </div>
            </div>
            <button
              onClick={() => post('/api/efris/register/fee-item', 'fee', loadSettings)}
              disabled={!!busy || !settings.configured}
              className="w-full py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-blue-600 dark:text-blue-400 rounded-lg active-shrink transition-all cursor-pointer disabled:opacity-40"
            >
              {busy === 'fee' ? 'Registering…' : settings.feeRegisteredAt ? 'Update at URA' : 'Register with URA'}
            </button>
          </div>

          {settings.tin && (
            <div className="bg-neo shadow-neo-inset-sm rounded-xl p-2.5 flex items-center justify-between border border-transparent">
              <span className="text-[10px] text-slate-500">Registered taxpayer</span>
              <span className="text-[11px] font-mono font-bold text-slate-700 dark:text-slate-300">TIN {settings.tin}</span>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={!!busy}
              className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-bold rounded-xl active-shrink transition-all cursor-pointer disabled:opacity-60"
            >
              {busy === 'save' ? 'Saving…' : 'Save EFRIS settings'}
            </button>
            <button
              onClick={test}
              disabled={!!busy || !settings.configured}
              className="px-4 py-2 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[11px] font-bold text-slate-600 dark:text-slate-400 rounded-xl active-shrink transition-all cursor-pointer disabled:opacity-40"
            >
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
          </div>

          <button
            onClick={() => post('/api/efris/sync-excise-codes', 'excise')}
            disabled={!!busy || !settings.configured}
            className="w-full py-1.5 bg-neo shadow-neo-outset hover:shadow-neo-inset-sm text-[10px] font-bold text-slate-500 rounded-lg active-shrink transition-all cursor-pointer disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            <RefreshCw size={11} /> {busy === 'excise' ? 'Syncing…' : 'Sync excise duty codes from URA'}
          </button>
        </div>
      )}

      {tab === 'catalog' && (
        <CatalogTab
          catalog={catalog}
          busy={busy}
          configured={settings.configured && settings.enabled}
          onRegister={(kind, id) => post(`/api/efris/register/${kind}/${id}`, `reg-${kind}-${id}`, loadCatalog)}
        />
      )}

      {tab === 'stock' && (
        <div className="space-y-2">
          <p className="text-[10px] text-slate-500 leading-relaxed">
            Only consumables carry stock at URA — hired items and assets are registered as
            services, so they go out and come back without ever being sold. Report movements
            from the Consumables screen; what has been sent shows here.
          </p>
          {movements.length === 0 ? (
            <p className="text-[10px] text-slate-400 text-center py-6">Nothing reported to URA yet.</p>
          ) : (
            <div className="bg-neo shadow-neo-inset-sm rounded-xl overflow-hidden border border-transparent">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[9px] text-slate-500 uppercase font-black">
                    <th className="p-2.5">Reference</th>
                    <th className="p-2.5">Movement</th>
                    <th className="p-2.5">When</th>
                    <th className="p-2.5 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="text-[11px] divide-y divide-slate-200/10">
                  {movements.map(m => (
                    <tr key={m.id}>
                      <td className="p-2.5 font-mono text-slate-600 dark:text-slate-400">{m.reference}</td>
                      <td className="p-2.5 text-slate-500">
                        {m.direction === 'INCREASE' ? 'In' : 'Out'} · {m.typeLabel}
                      </td>
                      <td className="p-2.5 font-mono text-[10px] text-slate-400">{m.createdAt?.split('T')[0]}</td>
                      <td className="p-2.5 text-center">
                        <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded-full ${
                          m.status === 'ACCEPTED' ? 'text-emerald-600 bg-emerald-500/10' : 'text-red-500 bg-red-500/10'
                        }`} title={m.error || ''}>
                          {m.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {message && (
        <div className={`rounded-xl p-2.5 text-[10px] leading-relaxed flex items-start gap-2 ${
          message.kind === 'ok'
            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
            : 'bg-red-500/10 text-red-600 dark:text-red-400'
        }`}>
          {message.kind === 'ok' ? <CheckCircle2 size={12} className="mt-0.5 flex-shrink-0" /> : <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}
    </div>
  );
}

/** The registration state of everything billable, and the button to fix it. */
function CatalogTab({ catalog, busy, configured, onRegister }: {
  catalog: { items: EfrisCatalogEntry[]; assets: EfrisCatalogEntry[]; consumables: EfrisCatalogEntry[] } | null;
  busy: string | null;
  configured: boolean;
  onRegister: (kind: string, id: number) => void;
}) {
  if (!catalog) return <p className="text-[11px] text-slate-400">Loading catalogue…</p>;

  const groups: { key: string; label: string; note: string; rows: EfrisCatalogEntry[] }[] = [
    { key: 'item', label: 'Hire items', note: 'Registered as services — hiring is a service, so URA holds no stock for them.', rows: catalog.items },
    { key: 'asset', label: 'Serialized assets', note: 'Also services.', rows: catalog.assets },
    { key: 'consumable', label: 'Consumables', note: 'Registered as goods, because they are sold outright — these are what stock reports cover.', rows: catalog.consumables },
  ];

  return (
    <div className="space-y-4">
      {!configured && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-lg p-2">
          Turn EFRIS on and save your API key before registering anything.
        </p>
      )}
      {groups.map(g => (
        <div key={g.key} className="space-y-1.5">
          <p className="text-[10px] uppercase font-black text-slate-500">{g.label}</p>
          <p className="text-[9px] text-slate-400 leading-relaxed">{g.note}</p>
          {g.rows.length === 0 ? (
            <p className="text-[10px] text-slate-400 py-2">None yet.</p>
          ) : (
            <div className="bg-neo shadow-neo-inset-sm rounded-xl overflow-hidden border border-transparent">
              <table className="w-full text-left">
                <tbody className="text-[11px] divide-y divide-slate-200/10">
                  {g.rows.map(r => (
                    <tr key={r.id}>
                      <td className="p-2.5">
                        <span className="font-bold text-slate-700 dark:text-slate-300">{r.name}</span>
                        {r.missing.length > 0 && (
                          <span className="block text-[9px] text-amber-600 dark:text-amber-400 mt-0.5">
                            Needs a {r.missing.join(' and ')} first
                          </span>
                        )}
                        {r.registered && r.efrisItemCode && (
                          <span className="block text-[9px] text-slate-400 font-mono mt-0.5">{r.efrisItemCode}</span>
                        )}
                      </td>
                      <td className="p-2.5 text-right w-32">
                        {r.registered ? (
                          <span className="text-[9px] font-black uppercase text-emerald-600 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">Registered</span>
                        ) : (
                          <button
                            onClick={() => onRegister(g.key, r.id)}
                            disabled={!!busy || !configured || r.missing.length > 0}
                            className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-[9px] font-bold rounded-lg active-shrink transition-all cursor-pointer disabled:opacity-30"
                          >
                            {busy === `reg-${g.key}-${r.id}` ? 'Sending…' : 'Register'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
