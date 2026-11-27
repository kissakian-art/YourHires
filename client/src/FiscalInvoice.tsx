/**
 * The fiscal invoice as URA expects it to be shown: six sections in a fixed
 * order, seller through to summary, with the QR a customer can scan to verify it
 * on the URA portal.
 *
 * The layout follows the EFRIS display spec — a fiscal invoice is a legal
 * document, so its shape is not ours to redesign. The FDN gets visual weight
 * because that is the number a URA officer looks for first.
 *
 * Everything renders from data already stored on the invoice, so re-opening a
 * fiscalized invoice never calls URA again.
 */
import { fmtMoney, type Invoice } from './efris-types';

interface Props {
  invoice: Invoice;
  company: { name: string; address?: string | null; efrisTin?: string | null };
  /** Rendered inside the print sheet, so the browser's print dialog gets it too. */
  onClose?: () => void;
}

const Section = ({ title, children }: { title: string; children: any }) => (
  <div className="border-b border-slate-300 dark:border-slate-700 last:border-b-0">
    <div className="bg-slate-100 dark:bg-slate-800 px-3 py-1.5">
      <p className="text-[10px] font-black uppercase tracking-wide text-slate-600 dark:text-slate-300">{title}</p>
    </div>
    <div className="px-3 py-2.5">{children}</div>
  </div>
);

const Row = ({ label, value, mono, bold }: { label: string; value: any; mono?: boolean; bold?: boolean }) => (
  <div className="flex justify-between gap-4 py-0.5">
    <span className="text-[10px] text-slate-500 flex-shrink-0">{label}</span>
    <span className={`text-[11px] text-right text-slate-800 dark:text-slate-200 ${mono ? 'font-mono' : ''} ${bold ? 'font-black' : 'font-medium'}`}>
      {value || '—'}
    </span>
  </div>
);

export default function FiscalInvoice({ invoice, company }: Props) {
  const sym = invoice.currency || 'UGX';
  const lines = invoice.lineItems || [];
  const summary = invoice.taxSummary || [];

  // The QR value is a URL to URA's verification page. Rendering it as an image
  // through a third-party service would leak invoice data off the machine, so
  // the link is shown as a link and the stored QR image used only when the
  // middleware returned one.
  const qr = invoice.efrisQRCode || '';
  const qrIsImage = /^data:image\//i.test(qr);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl overflow-hidden max-w-2xl mx-auto">
      {/* Blue header bar, as on every EFRIS fiscal invoice */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-3 py-2 flex items-center justify-between">
        <span className="text-[11px] font-black text-white tracking-wide">EFRIS</span>
        <span className="text-[11px] font-black text-white tracking-wide">e-INVOICE / TAX INVOICE</span>
        <span className="text-[11px] font-black text-white">1/1</span>
      </div>

      <Section title="A · Seller Details">
        <Row label="TIN" value={company.efrisTin} mono />
        <Row label="Legal Name" value={company.name?.toUpperCase()} />
        <Row label="Address" value={company.address} />
        <Row label="Reference No." value={invoice.efrisInvoiceNo || invoice.referenceNumber} mono />
      </Section>

      <Section title="B · URA Fiscal Information">
        <div className="mb-1.5">
          <p className="text-[9px] uppercase text-slate-500 font-bold">Fiscal Document Number</p>
          <p className="text-[15px] font-black text-blue-700 dark:text-blue-400 font-mono break-all">{invoice.efrisFDN || '—'}</p>
        </div>
        <Row label="Verification Code" value={invoice.efrisVerificationCode} mono />
        <Row label="Fiscalized" value={invoice.efrisFiscalizedAt?.replace('T', ' ').slice(0, 19)} mono />
        <Row label="Issued Date" value={(invoice.issueDate || invoice.createdAt || '').slice(0, 10)} mono />
      </Section>

      <Section title="C · Buyer Details">
        <Row label="Name" value={invoice.customerName} />
        <Row label="TIN" value={invoice.customerTin} mono />
        <Row label="Buyer Type" value={invoice.customerTin ? 'B2B — Business' : 'B2C — Individual'} />
      </Section>

      <Section title="D · Goods & Services">
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[420px]">
            <thead>
              <tr className="text-[9px] uppercase font-black text-slate-500 border-b border-slate-200 dark:border-slate-700">
                <th className="py-1 pr-1 w-6">#</th>
                <th className="py-1 pr-2">Item</th>
                <th className="py-1 px-1 text-right">Qty</th>
                <th className="py-1 px-1 text-right">Price</th>
                <th className="py-1 pl-1 text-right">Tax</th>
                <th className="py-1 pl-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="text-[10px] divide-y divide-slate-100 dark:divide-slate-800">
              {lines.map((l, i) => {
                const days = Math.max(1, l.rentalDays || 1);
                return (
                  <tr key={l.id}>
                    <td className="py-1 pr-1 text-slate-400">{i + 1}</td>
                    <td className="py-1 pr-2 text-slate-700 dark:text-slate-300">{l.description}</td>
                    <td className="py-1 px-1 text-right font-mono whitespace-nowrap">
                      {Number(l.quantity)}{days > 1 ? ` × ${days}d` : ''}
                    </td>
                    <td className="py-1 px-1 text-right font-mono whitespace-nowrap">
                      {Number(l.unitPrice).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </td>
                    <td className="py-1 pl-1 text-right font-mono whitespace-nowrap">
                      {Number(l.lineTax).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </td>
                    <td className="py-1 pl-1 text-right font-mono font-bold whitespace-nowrap">
                      {Number(l.lineTotal).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="E · Tax Summary">
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[360px]">
            <thead>
              <tr className="text-[9px] uppercase font-black text-slate-500 border-b border-slate-200 dark:border-slate-700">
                <th className="py-1 pr-2">Category</th>
                <th className="py-1 px-1 text-right">Net</th>
                <th className="py-1 px-1 text-right">Tax</th>
                <th className="py-1 pl-1 text-right">Gross</th>
              </tr>
            </thead>
            <tbody className="text-[10px] divide-y divide-slate-100 dark:divide-slate-800">
              {summary.map(r => (
                <tr key={r.taxCode}>
                  <td className="py-1 pr-2 text-slate-700 dark:text-slate-300">{r.label}</td>
                  <td className="py-1 px-1 text-right font-mono">{r.net.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                  <td className="py-1 px-1 text-right font-mono">{r.tax.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                  <td className="py-1 pl-1 text-right font-mono font-bold">{r.gross.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="F · Invoice Summary">
        <Row label="Net Amount" value={fmtMoney(invoice.subtotal, sym)} mono />
        <Row label="Tax Amount" value={fmtMoney(invoice.taxTotal, sym)} mono />
        <Row label="Gross Amount" value={fmtMoney(invoice.amount, sym)} mono bold />
        {invoice.amountInWords && (
          <p className="text-[10px] italic text-slate-500 mt-1.5 leading-relaxed">{invoice.amountInWords}</p>
        )}
        <div className="mt-1.5 pt-1.5 border-t border-slate-100 dark:border-slate-800">
          <Row label="Payment Mode" value={invoice.paymentMethod || 'Credit'} />
          <Row label="Number of Items" value={lines.length} />
          <Row label="Remarks" value={invoice.notes || invoice.description} />
        </div>
      </Section>

      <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-3 py-1.5 text-center">
        <span className="text-[10px] font-black text-white tracking-wide">*** END OF e-INVOICE / TAX INVOICE ***</span>
      </div>

      {qr && (
        <div className="px-3 py-3 text-center space-y-1.5">
          {qrIsImage ? (
            <img src={qr} alt="URA verification QR code" className="w-32 h-32 mx-auto" />
          ) : (
            <a
              href={qr}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-blue-600 dark:text-blue-400 underline break-all"
            >
              {qr}
            </a>
          )}
          <p className="text-[9px] text-slate-400">Scan or open to verify this invoice on the URA portal.</p>
        </div>
      )}
    </div>
  );
}
