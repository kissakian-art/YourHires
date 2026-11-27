import { collectibleBalance } from './invoice-service';
// Server-side PDF generation (pdfkit — pure JS, no Chromium, safe for the Tauri desktop bundle).
// Produces professional, downloadable documents: invoices, booking/deposit receipts and
// rental-order / dispatch notes. Streams directly to an Express response.
import PDFDocument from 'pdfkit';
import type { Response } from 'express';

const ACCENT = '#2563eb';
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';

type Company = {
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  currencySymbol?: string | null;
  efrisTin?: string | null;
};

// One priced line as stored on an invoice.
type InvoiceLine = {
  description: string;
  quantity: number | string;
  rentalDays?: number;
  unitPrice: number | string;
  discount?: number | string;
  taxRatePercent?: number | string;
  taxCode?: string;
  lineNet: number | string;
  lineTax: number | string;
  lineTotal: number | string;
};

function money(sym: string, n: number | string) {
  return `${sym} ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function fmtDate(d: Date | string | null | undefined) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toISOString().split('T')[0];
}

// Shared page furniture. Returns the y-coordinate below the header block.
function header(doc: PDFKit.PDFDocument, company: Company, title: string, ref: string) {
  const top = 50;
  // Accent bar
  doc.rect(0, 0, doc.page.width, 6).fill(ACCENT);

  // Company block (left)
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(company.name, 50, top);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const lines = [company.address, company.phone, company.email].filter(Boolean) as string[];
  let cy = doc.y + 2;
  lines.forEach(l => { doc.text(l, 50, cy, { width: 260 }); cy = doc.y; });

  // Document title block (right)
  doc.font('Helvetica-Bold').fontSize(22).fillColor(ACCENT)
    .text(title.toUpperCase(), 320, top, { width: 225, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(`Ref: ${ref}`, 320, doc.y + 2, { width: 225, align: 'right' })
    .text(`Issued: ${fmtDate(new Date())}`, { width: 225, align: 'right' });

  const y = Math.max(cy, doc.y) + 16;
  doc.moveTo(50, y).lineTo(545, y).lineWidth(1).strokeColor(LINE).stroke();
  return y + 16;
}

function footer(doc: PDFKit.PDFDocument, note: string) {
  const y = 770;
  doc.moveTo(50, y).lineTo(545, y).lineWidth(1).strokeColor(LINE).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text(note, 50, y + 8, { width: 495, align: 'center' });
}

// Two-column "meta" row: Bill-To on the left, key/value pairs on the right.
function metaBlock(doc: PDFKit.PDFDocument, y: number, billToLabel: string, billToName: string, rows: Array<[string, string]>) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(billToLabel.toUpperCase(), 50, y);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(billToName, 50, doc.y + 2, { width: 260 });

  let ry = y;
  rows.forEach(([k, v]) => {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(k, 320, ry, { width: 120, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(v, 445, ry, { width: 100, align: 'right' });
    ry += 15;
  });
  return Math.max(doc.y, ry) + 14;
}

// Simple line-items table. Columns: description | rate | qty/period | amount.
function itemsTable(
  doc: PDFKit.PDFDocument, y: number, sym: string,
  rows: Array<{ desc: string; rate?: string; qty?: string; amount: string }>
) {
  const cols = { desc: 50, rate: 300, qty: 390, amount: 470 };
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  doc.text('DESCRIPTION', cols.desc, y);
  doc.text('RATE', cols.rate, y, { width: 80, align: 'right' });
  doc.text('QTY / PERIOD', cols.qty, y, { width: 70, align: 'right' });
  doc.text('AMOUNT', cols.amount, y, { width: 75, align: 'right' });
  y += 14;
  doc.moveTo(50, y).lineTo(545, y).lineWidth(1).strokeColor(LINE).stroke();
  y += 8;

  doc.font('Helvetica').fontSize(9).fillColor(INK);
  rows.forEach(r => {
    const startY = y;
    doc.text(r.desc, cols.desc, y, { width: 240 });
    const descBottom = doc.y;
    doc.text(r.rate || '', cols.rate, startY, { width: 80, align: 'right' });
    doc.text(r.qty || '', cols.qty, startY, { width: 70, align: 'right' });
    doc.font('Helvetica-Bold').text(r.amount, cols.amount, startY, { width: 75, align: 'right' });
    doc.font('Helvetica');
    y = Math.max(descBottom, startY + 12) + 6;
    doc.moveTo(50, y - 3).lineTo(545, y - 3).lineWidth(0.5).strokeColor(LINE).stroke();
  });
  return y + 6;
}

// Invoice line table. Unlike the generic one above this is a tax invoice, so
// amounts are shown NET with the tax in its own column — that way the column
// adds up to the subtotal, and subtotal + tax reaches the total the customer
// pays. Showing gross line amounts against a net subtotal reads as an error.
function invoiceItemsTable(doc: PDFKit.PDFDocument, y: number, sym: string, lines: InvoiceLine[]) {
  const cols = { desc: 50, rate: 245, qty: 325, tax: 395, amount: 470 };
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  doc.text('DESCRIPTION', cols.desc, y);
  doc.text('RATE', cols.rate, y, { width: 75, align: 'right' });
  doc.text('QTY / PERIOD', cols.qty, y, { width: 65, align: 'right' });
  doc.text('TAX', cols.tax, y, { width: 70, align: 'right' });
  doc.text('AMOUNT', cols.amount, y, { width: 75, align: 'right' });
  y += 14;
  doc.moveTo(50, y).lineTo(545, y).lineWidth(1).strokeColor(LINE).stroke();
  y += 8;

  doc.fontSize(9).fillColor(INK);
  for (const l of lines) {
    const days = Math.max(1, Number(l.rentalDays) || 1);
    const qty = `${Number(l.quantity)}${days > 1 ? ` × ${days} day${days === 1 ? '' : 's'}` : ''}`;
    const startY = y;
    doc.font('Helvetica').text(l.description, cols.desc, y, { width: 185 });
    const descBottom = doc.y;
    doc.text(money(sym, l.unitPrice), cols.rate, startY, { width: 75, align: 'right' });
    doc.text(qty, cols.qty, startY, { width: 65, align: 'right' });
    doc.text(money(sym, l.lineTax), cols.tax, startY, { width: 70, align: 'right' });
    doc.font('Helvetica-Bold').text(money(sym, l.lineNet), cols.amount, startY, { width: 75, align: 'right' });
    y = Math.max(descBottom, startY + 12) + 6;
    doc.moveTo(50, y - 3).lineTo(545, y - 3).lineWidth(0.5).strokeColor(LINE).stroke();
  }
  return y + 6;
}

// Right-aligned totals stack; the last row is emphasised.
function totals(doc: PDFKit.PDFDocument, y: number, rows: Array<[string, string, boolean?]>) {
  rows.forEach(([label, value, strong]) => {
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 12 : 9)
      .fillColor(strong ? INK : MUTED)
      .text(label, 320, y, { width: 120, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(strong ? 12 : 9).fillColor(strong ? ACCENT : INK)
      .text(value, 445, y, { width: 100, align: 'right' });
    y += strong ? 20 : 16;
  });
  return y;
}

// URA's tax-category letters, printed in the tax summary so the invoice reads
// the same way as a fiscal receipt from any other EFRIS system.
function taxCategoryLabel(code: string): string {
  const labels: Record<string, string> = {
    '01': 'A — Standard', '02': 'B — Zero Rate', '03': 'C — Exempt',
    '04': 'D — Deemed', '05': 'E — Excise Duty', '11': 'F — Out of Scope',
  };
  return labels[code] || `Tax Category ${code}`;
}

// Per-category tax breakdown: net, tax and gross for each rate on the invoice.
function taxTable(doc: PDFKit.PDFDocument, y: number, sym: string, lines: InvoiceLine[]) {
  const byCode = new Map<string, { code: string; net: number; tax: number }>();
  for (const l of lines) {
    const code = l.taxCode || '01';
    const row = byCode.get(code) || { code, net: 0, tax: 0 };
    row.net += Number(l.lineNet) || 0;
    row.tax += Number(l.lineTax) || 0;
    byCode.set(code, row);
  }
  const rows = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  // A single standard-rated invoice says nothing extra here that the totals
  // don't already say, so the table only earns its space on a mixed one.
  if (rows.length < 2) return y;

  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('TAX SUMMARY', 50, y);
  y += 12;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  doc.text('CATEGORY', 50, y);
  doc.text('NET', 300, y, { width: 80, align: 'right' });
  doc.text('TAX', 385, y, { width: 75, align: 'right' });
  doc.text('GROSS', 465, y, { width: 80, align: 'right' });
  y += 12;
  doc.moveTo(50, y).lineTo(545, y).lineWidth(0.5).strokeColor(LINE).stroke();
  y += 6;

  doc.font('Helvetica').fontSize(9).fillColor(INK);
  for (const r of rows) {
    doc.text(taxCategoryLabel(r.code), 50, y, { width: 240 });
    doc.text(money(sym, r.net), 300, y, { width: 80, align: 'right' });
    doc.text(money(sym, r.tax), 385, y, { width: 75, align: 'right' });
    doc.text(money(sym, r.net + r.tax), 465, y, { width: 80, align: 'right' });
    y += 14;
  }
  return y + 6;
}

// The URA fiscal block. Present only once an invoice has been fiscalized, and
// deliberately prominent — the FDN is what a URA officer looks for.
function fiscalBlock(doc: PDFKit.PDFDocument, y: number, fiscal: {
  fdn: string; verificationCode?: string | null; issuedAt?: Date | string | null;
  sellerTin?: string | null; qrCode?: string | null;
}) {
  const boxTop = y;
  doc.rect(50, boxTop, 495, 62).lineWidth(1).strokeColor(ACCENT).stroke();

  doc.font('Helvetica-Bold').fontSize(8).fillColor(ACCENT)
    .text('URA EFRIS — FISCALIZED e-INVOICE', 60, boxTop + 8);

  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Fiscal Document No.', 60, boxTop + 24);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(ACCENT).text(fiscal.fdn, 60, boxTop + 34, { width: 240 });

  let ry = boxTop + 22;
  const pair = (k: string, v: string) => {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(k, 310, ry, { width: 110, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(v, 425, ry, { width: 110, align: 'right' });
    ry += 12;
  };
  if (fiscal.sellerTin) pair('Seller TIN:', fiscal.sellerTin);
  if (fiscal.verificationCode) pair('Verification:', fiscal.verificationCode);
  if (fiscal.issuedAt) pair('Fiscalized:', fmtDate(fiscal.issuedAt));

  let out = boxTop + 70;
  if (fiscal.qrCode) {
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(`Verify at: ${fiscal.qrCode}`, 50, out, { width: 495 });
    out = doc.y + 4;
  }
  return out;
}

function statusStamp(doc: PDFKit.PDFDocument, y: number, label: string, paid: boolean) {
  const color = paid ? '#16a34a' : '#dc2626';
  doc.font('Helvetica-Bold').fontSize(11).fillColor(color)
    .text(label.toUpperCase(), 50, y);
}

function startDoc(res: Response, filename: string) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}

export function streamInvoicePdf(res: Response, company: Company, invoice: {
  referenceNumber: string; customerName: string; customerTin?: string | null;
  amount: number | string; subtotal?: number | string; discountTotal?: number | string;
  taxTotal?: number | string; amountPaid?: number | string; amountCredited?: number | string;
  dueDate: Date | string; issueDate?: Date | string; createdAt?: Date | string;
  status: string; description: string; notes?: string | null; terms?: string | null;
  paymentMethod?: string | null; paymentDate?: Date | string | null;
  lineItems?: InvoiceLine[];
  efrisFDN?: string | null; efrisVerificationCode?: string | null;
  efrisQRCode?: string | null; efrisFiscalizedAt?: Date | string | null;
}) {
  const sym = company.currencySymbol || 'UGX';
  const doc = startDoc(res, `Invoice-${invoice.referenceNumber}.pdf`);
  const lines = invoice.lineItems || [];

  let y = header(doc, company, invoice.efrisFDN ? 'Tax Invoice' : 'Invoice', invoice.referenceNumber);

  const meta: Array<[string, string]> = [
    ['Issue Date:', fmtDate(invoice.issueDate || invoice.createdAt || new Date())],
    ['Due Date:', fmtDate(invoice.dueDate)],
    ['Status:', invoice.status],
  ];
  if (company.efrisTin) meta.unshift(['Seller TIN:', company.efrisTin]);
  if (invoice.customerTin) meta.push(['Customer TIN:', invoice.customerTin]);
  y = metaBlock(doc, y, 'Bill To', invoice.customerName, meta);

  // Older invoices, raised before line items existed, fall back to a single
  // line built from the description so historical PDFs still render.
  y = lines.length
    ? invoiceItemsTable(doc, y, sym, lines)
    : itemsTable(doc, y, sym, [
        { desc: invoice.description || 'Rental charges', rate: money(sym, invoice.amount), qty: '1', amount: money(sym, invoice.amount) },
      ]);

  if (lines.length) y = taxTable(doc, y + 4, sym, lines);

  const paid = Number(invoice.amountPaid) || 0;
  const credited = Number(invoice.amountCredited) || 0;
  const due = collectibleBalance(invoice);
  const settlementRows: Array<[string, string]> = [
    ...(paid > 0 ? [['Paid', `-${money(sym, paid)}`] as [string, string]] : []),
    ...(credited > 0 ? [['Credited', `-${money(sym, credited)}`] as [string, string]] : []),
  ];
  const totalRows: Array<[string, string, boolean?]> = lines.length
    ? [
        ['Subtotal (excl. tax)', money(sym, invoice.subtotal ?? invoice.amount)],
        ...(Number(invoice.discountTotal) > 0 ? [['Discount', `-${money(sym, invoice.discountTotal!)}`] as [string, string]] : []),
        ['Tax', money(sym, invoice.taxTotal ?? 0)],
        ['Total', money(sym, invoice.amount)],
        ...settlementRows,
        ['Balance Due', money(sym, due), true],
      ]
    : [
        ['Subtotal', money(sym, invoice.amount)],
        ...settlementRows,
        ['Balance Due', money(sym, due), true],
      ];
  y = totals(doc, y + 4, totalRows);

  if (invoice.efrisFDN) {
    y = fiscalBlock(doc, y + 10, {
      fdn: invoice.efrisFDN,
      verificationCode: invoice.efrisVerificationCode,
      issuedAt: invoice.efrisFiscalizedAt,
      sellerTin: company.efrisTin,
      qrCode: invoice.efrisQRCode,
    });
  }

  if (invoice.notes) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('NOTES', 50, y + 8);
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(invoice.notes, 50, doc.y + 2, { width: 495 });
    y = doc.y + 6;
  }
  if (invoice.terms) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('TERMS', 50, y + 4);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(invoice.terms, 50, doc.y + 2, { width: 495 });
    y = doc.y + 6;
  }

  const settled = String(invoice.status).toLowerCase() === 'paid';
  statusStamp(doc, y + 6, settled ? `Paid${invoice.paymentMethod ? ' · ' + invoice.paymentMethod : ''}` : 'Payment Outstanding', settled);

  footer(doc, `${company.name} — thank you for your business. Generated by YourHires.`);
  doc.end();
}

export function streamBookingReceiptPdf(res: Response, company: Company, booking: {
  bookingNumber: string; customerName: string; contactInfo?: string | null;
  estimatedTotalCost: number | string; depositAmount: number | string; depositPaid: boolean;
  depositPaidDate?: Date | string | null; scheduledPickupDate?: Date | string | null;
  scheduledReturnDate?: Date | string | null; status: string;
}) {
  const sym = company.currencySymbol || 'UGX';
  const doc = startDoc(res, `Receipt-${booking.bookingNumber}.pdf`);

  let y = header(doc, company, 'Deposit Receipt', booking.bookingNumber);
  y = metaBlock(doc, y, 'Received From', booking.customerName, [
    ['Booking:', booking.bookingNumber],
    ['Paid On:', fmtDate(booking.depositPaidDate)],
    ['Status:', booking.status],
  ]);
  if (booking.contactInfo) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(booking.contactInfo, 50, y);
    y = doc.y + 10;
  }
  y = itemsTable(doc, y, sym, [
    { desc: `Booking deposit — ${booking.bookingNumber}`, qty: '1', amount: money(sym, booking.depositAmount) },
  ]);
  const balance = Number(booking.estimatedTotalCost) - Number(booking.depositAmount);
  y = totals(doc, y + 4, [
    ['Estimated Total', money(sym, booking.estimatedTotalCost)],
    ['Deposit Paid', money(sym, booking.depositAmount)],
    ['Balance on Pickup', money(sym, balance), true],
  ]);
  statusStamp(doc, y + 10, booking.depositPaid ? 'Deposit Received' : 'Deposit Pending', booking.depositPaid);

  footer(doc, `This is a payment confirmation receipt. ${company.name} — Generated by YourHires.`);
  doc.end();
}

export function streamRentalOrderPdf(res: Response, company: Company, order: {
  companyOrderNumber: string; customerName: string; checkoutDate: Date | string;
  expectedReturnDate: Date | string; status: string; estimatedTotal: number | string;
  totalLateFeeCalculated?: number | string; totalReplacementFeeCalculated?: number | string;
  lineItems: Array<{ itemType: string; quantity: number; dailyRate: number | string;
    item?: { name: string } | null; asset?: { name: string; serialNumber: string } | null;
    consumable?: { name: string } | null; }>;
}) {
  const sym = company.currencySymbol || 'UGX';
  const doc = startDoc(res, `Order-${order.companyOrderNumber}.pdf`);

  let y = header(doc, company, 'Dispatch Note', order.companyOrderNumber);
  y = metaBlock(doc, y, 'Dispatched To', order.customerName, [
    ['Checked Out:', fmtDate(order.checkoutDate)],
    ['Expected Return:', fmtDate(order.expectedReturnDate)],
    ['Status:', order.status],
  ]);

  const rows = order.lineItems.map(li => {
    const name = li.item?.name || (li.asset ? `${li.asset.name} (${li.asset.serialNumber})` : '') || li.consumable?.name || 'Item';
    const lineTotal = Number(li.dailyRate) * li.quantity;
    return {
      desc: `${name}  ·  ${li.itemType}`,
      rate: money(sym, li.dailyRate) + '/day',
      qty: String(li.quantity),
      amount: money(sym, lineTotal),
    };
  });
  y = itemsTable(doc, y, sym, rows.length ? rows : [{ desc: 'No line items recorded', amount: money(sym, 0) }]);

  const totalRows: Array<[string, string, boolean?]> = [['Estimated Total', money(sym, order.estimatedTotal)]];
  if (Number(order.totalLateFeeCalculated) > 0) totalRows.push(['Late Fees', money(sym, order.totalLateFeeCalculated!)]);
  if (Number(order.totalReplacementFeeCalculated) > 0) totalRows.push(['Damage / Loss', money(sym, order.totalReplacementFeeCalculated!)]);
  const grand = Number(order.estimatedTotal) + Number(order.totalLateFeeCalculated || 0) + Number(order.totalReplacementFeeCalculated || 0);
  totalRows.push(['Grand Total', money(sym, grand), true]);
  y = totals(doc, y + 4, totalRows);

  footer(doc, `Please inspect all items on receipt. ${company.name} — Generated by YourHires.`);
  doc.end();
}
