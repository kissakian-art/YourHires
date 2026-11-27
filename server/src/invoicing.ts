/**
 * invoicing.ts
 * ------------
 * Standard-invoice arithmetic: turning priced lines into an invoice with a
 * subtotal, tax and gross total.
 *
 * Before this, an invoice was a single `amount` with a description — enough for
 * a ledger, but not something URA EFRIS can fiscalize (T109 reports every line
 * with its own tax). Everything here is pure: no DB, no network, so the same
 * maths runs for rental orders, penalty charges and hand-raised invoices.
 *
 * Money convention:
 *  • `unitPrice` on a line is always NET (tax-exclusive), whatever the business
 *    types in — `normalizeUnitPrice` backs the tax out first when the company
 *    prices tax-inclusively.
 *  • `amount` on the invoice is the GROSS total. It stays the one figure the
 *    customer ledger, aging report and payment flow charge against.
 */

// Currency is UGX-style (no minor units in practice), but rates and part-days
// can produce fractions, so every stored figure is rounded to 2dp once, at the
// point it is stored — never re-rounded downstream.
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Unit prices keep four decimals. Backing 18% out of a round 2,500 gives
// 2,118.6441 — at two decimals that drifts by nearly a shilling per unit, which
// on a 150-unit line is visible on the invoice.
export function round4(n: number): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

/** A tax rate as it applies to one line: a fraction plus its URA category. */
export interface ResolvedTaxRate {
  taxRateId: number | null;
  /** Fraction, e.g. 0.18 for 18%. */
  rate: number;
  /** EFRIS tax category: 01 standard · 02 zero-rated · 03 exempt · 04 deemed. */
  taxCode: string;
}

/**
 * The fallback when a company has defined no tax rates at all (or the entity
 * has none picked): zero-rated. Deliberately not 18% — silently taxing a
 * business that never configured VAT would overcharge their customers.
 */
export const ZERO_RATED: ResolvedTaxRate = { taxRateId: null, rate: 0, taxCode: '02' };

/**
 * Picks the rate for a line: the entity's own rate if it has one, else the
 * company default, else zero-rated.
 */
export function resolveTaxRate(
  entityRateId: number | null | undefined,
  companyRates: { id: number; rate: any; taxCode: string; isDefault: boolean; isActive: boolean }[]
): ResolvedTaxRate {
  const active = companyRates.filter(r => r.isActive);
  const own = entityRateId ? active.find(r => r.id === entityRateId) : undefined;
  const chosen = own || active.find(r => r.isDefault);
  if (!chosen) return { ...ZERO_RATED };
  return { taxRateId: chosen.id, rate: Number(chosen.rate) || 0, taxCode: chosen.taxCode || '01' };
}

/**
 * Converts an entered price to the NET price the line stores.
 * When the company's catalogue rates already include VAT, the tax is backed out
 * so `net + tax` reproduces exactly the price the customer was quoted.
 */
export function normalizeUnitPrice(entered: number, rate: number, pricesIncludeTax: boolean): number {
  const price = Number(entered) || 0;
  if (!pricesIncludeTax || !rate) return round4(price);
  return round4(price / (1 + rate));
}

/** A line before its money has been worked out. */
export interface DraftLine {
  itemType: string;               // item | asset | consumable | fee | service
  itemId?: number | null;
  assetId?: number | null;
  consumableId?: number | null;
  unitOfMeasureId?: number | null;
  description: string;
  quantity: number;
  rentalDays?: number;            // 1 for anything that isn't priced per day
  unitPrice: number;              // NET price per unit per day
  /**
   * The tax-INCLUSIVE price the business actually quoted, when it prices that
   * way. Set it and the line is worked out from the gross downwards, so the
   * total matches the quote to the shilling; leave it unset and the tax is
   * added on top of `unitPrice` instead.
   */
  grossUnitPrice?: number | null;
  discount?: number;              // discount on the whole line, in the same basis as the price
  tax: ResolvedTaxRate;
  sortOrder?: number;
}

/** A line with its money worked out, ready to persist. */
export interface CostedLine {
  itemType: string;
  itemId: number | null;
  assetId: number | null;
  consumableId: number | null;
  unitOfMeasureId: number | null;
  description: string;
  quantity: number;
  rentalDays: number;
  unitPrice: number;
  discount: number;
  taxRateId: number | null;
  taxRatePercent: number;
  taxCode: string;
  lineNet: number;
  lineTax: number;
  lineTotal: number;
  sortOrder: number;
}

/**
 * Prices one line: rate x quantity x days, less discount, plus its own tax.
 *
 * Which figure is authoritative depends on how the business prices. Quoting
 * tax-inclusively makes the GROSS total the number the customer agreed to, so
 * net and tax are derived from it; quoting net-of-tax works the other way.
 * Rounding once, at the end, in whichever direction the business thinks, is what
 * stops an invoice disagreeing with its own quote by a shilling.
 */
export function costLine(line: DraftLine, index = 0): CostedLine {
  const quantity = Number(line.quantity) || 0;
  const rentalDays = Math.max(1, Number(line.rentalDays) || 1);
  const rate = Number(line.tax.rate) || 0;
  const unitPrice = round4(line.unitPrice);
  const inclusive = line.grossUnitPrice != null;

  const basisLine = (inclusive ? Number(line.grossUnitPrice) : unitPrice) * quantity * rentalDays;
  // A discount can reduce a line to zero but never below it — a negative line
  // would quietly turn an invoice into a credit note.
  const discount = Math.min(round2(line.discount || 0), round2(basisLine));

  let lineNet: number, lineTax: number;
  if (inclusive) {
    const lineGross = round2(basisLine - discount);
    lineNet = round2(lineGross / (1 + rate));
    lineTax = round2(lineGross - lineNet);
  } else {
    lineNet = round2(basisLine - discount);
    lineTax = round2(lineNet * rate);
  }
  return {
    itemType: line.itemType,
    itemId: line.itemId ?? null,
    assetId: line.assetId ?? null,
    consumableId: line.consumableId ?? null,
    unitOfMeasureId: line.unitOfMeasureId ?? null,
    description: (line.description || '').slice(0, 255),
    quantity,
    rentalDays,
    unitPrice,
    // Stored net, so the discount is recorded on the same basis as lineNet and
    // the header totals still add up.
    discount: inclusive ? round2(discount / (1 + rate)) : discount,
    taxRateId: line.tax.taxRateId,
    taxRatePercent: Number(line.tax.rate) || 0,
    taxCode: line.tax.taxCode || '01',
    lineNet,
    lineTax,
    lineTotal: round2(lineNet + lineTax),
    sortOrder: line.sortOrder ?? index,
  };
}

export interface InvoiceTotals {
  subtotal: number;      // sum of line values before discount and tax
  discountTotal: number;
  taxTotal: number;
  amount: number;        // gross total — what the customer owes
}

/** Rolls costed lines up into the invoice header figures. */
export function totalLines(lines: CostedLine[]): InvoiceTotals {
  let subtotal = 0, discountTotal = 0, taxTotal = 0;
  for (const l of lines) {
    subtotal += l.lineNet + l.discount;
    discountTotal += l.discount;
    taxTotal += l.lineTax;
  }
  subtotal = round2(subtotal);
  discountTotal = round2(discountTotal);
  taxTotal = round2(taxTotal);
  return { subtotal, discountTotal, taxTotal, amount: round2(subtotal - discountTotal + taxTotal) };
}

/**
 * Costs a set of draft lines and returns them with the header totals — the one
 * call every invoice creation site uses, so they can't drift apart.
 */
export function buildInvoiceLines(drafts: DraftLine[]): { lines: CostedLine[] } & InvoiceTotals {
  const lines = drafts.map((d, i) => costLine(d, i));
  return { lines, ...totalLines(lines) };
}

/**
 * Builds the single line a charge-style invoice needs (late fee, damage
 * recovery, an ad-hoc amount) so even these carry a proper line for EFRIS.
 * The amount passed in is what the business intends to collect, i.e. GROSS.
 */
export function feeLine(description: string, grossAmount: number, tax: ResolvedTaxRate): DraftLine {
  const rate = Number(tax.rate) || 0;
  return {
    itemType: 'fee',
    description,
    quantity: 1,
    rentalDays: 1,
    unitPrice: round4(rate ? Number(grossAmount) / (1 + rate) : Number(grossAmount)),
    // A fee is defined by what it collects, so the gross drives the line.
    grossUnitPrice: round2(grossAmount),
    tax,
  };
}

/**
 * Number of rental days a line covers. Inclusive of the start day: a same-day
 * hire is one day, not zero, which is how the rest of the app already charges.
 */
export function rentalDaysBetween(start: Date | string, end: Date | string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Groups costed lines into the per-category tax summary URA prints in Section E
 * of a fiscal invoice (and that a plain invoice shows as its tax breakdown).
 */
export function taxSummary(lines: { taxCode: string; taxRatePercent: number; lineNet: number; lineTax: number }[]) {
  const byCode = new Map<string, { taxCode: string; rate: number; net: number; tax: number; gross: number }>();
  for (const l of lines) {
    const key = l.taxCode || '01';
    const row = byCode.get(key) || { taxCode: key, rate: Number(l.taxRatePercent) || 0, net: 0, tax: 0, gross: 0 };
    row.net = round2(row.net + l.lineNet);
    row.tax = round2(row.tax + l.lineTax);
    row.gross = round2(row.net + row.tax);
    byCode.set(key, row);
  }
  return [...byCode.values()].sort((a, b) => a.taxCode.localeCompare(b.taxCode));
}

/** Human label for a URA tax category code. */
export function taxCategoryLabel(code: string): string {
  const labels: Record<string, string> = {
    '01': 'A — Standard (18%)',
    '02': 'B — Zero Rate (0%)',
    '03': 'C — Exempt',
    '04': 'D — Deemed (18%)',
    '05': 'E — Excise Duty',
    '11': 'F — Out of Scope',
  };
  return labels[code] || `Tax Category ${code}`;
}

/**
 * The seed set of rates offered when a Ugandan business first opens Settings.
 * Codes match URA's tax categories so EFRIS reports them correctly.
 */
export const DEFAULT_TAX_RATES = [
  { name: 'Standard VAT (18%)', rate: 0.18, taxCode: '01', isDefault: true },
  { name: 'Zero Rated (0%)', rate: 0, taxCode: '02', isDefault: false },
  { name: 'Exempt', rate: 0, taxCode: '03', isDefault: false },
];

/**
 * Amount in words, for the "Amount in words" line URA prints on a fiscal
 * invoice. Handles values up to the trillions, which is well past any hire bill.
 */
export function amountInWords(amount: number, currency = 'Shillings'): string {
  const n = Math.floor(Math.abs(Number(amount) || 0));
  if (n === 0) return `Zero ${currency} Only`;
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const under1000 = (v: number): string => {
    if (v === 0) return '';
    if (v < 20) return ones[v];
    if (v < 100) return tens[Math.floor(v / 10)] + (v % 10 ? ' ' + ones[v % 10] : '');
    return ones[Math.floor(v / 100)] + ' Hundred' + (v % 100 ? ' ' + under1000(v % 100) : '');
  };

  const scales: [number, string][] = [
    [1e12, 'Trillion'], [1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand'],
  ];
  let rest = n;
  const parts: string[] = [];
  for (const [value, label] of scales) {
    if (rest >= value) {
      parts.push(under1000(Math.floor(rest / value)) + ' ' + label);
      rest %= value;
    }
  }
  if (rest > 0) parts.push(under1000(rest));
  return parts.join(' ').replace(/\s+/g, ' ').trim() + ` ${currency} Only`;
}
