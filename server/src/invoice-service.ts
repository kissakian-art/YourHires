/**
 * invoice-service.ts
 * ------------------
 * Everything that turns YourHires business events into standard invoices with
 * real line items.
 *
 * Invoices used to be a bare `amount` plus a description. That was enough to
 * bill and chase a customer, but not to fiscalize: URA EFRIS reports each line
 * with its own item, quantity and tax. So every place that raises an invoice —
 * dispatching a booking, reconciling a late or damaged return, or raising one by
 * hand — now routes through here and gets the same lines, the same tax and the
 * same totals.
 *
 * `invoicing.ts` holds the pure arithmetic; this module is the part that reads
 * and writes the database.
 */

import type { PrismaClient } from '@prisma/client';
import {
  buildInvoiceLines, resolveTaxRate, normalizeUnitPrice, feeLine, round2, round4,
  rentalDaysBetween, type DraftLine, type ResolvedTaxRate,
} from './invoicing';

/** The company's tax setup, loaded once and reused for every line of an invoice. */
export interface TaxContext {
  companyId: number;
  pricesIncludeTax: boolean;
  currency: string;
  rates: { id: number; rate: any; taxCode: string; isDefault: boolean; isActive: boolean }[];
}

export async function loadTaxContext(prisma: PrismaClient, companyId: number): Promise<TaxContext> {
  const [company, rates] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { pricesIncludeTax: true, currency: true },
    }),
    prisma.taxRate.findMany({
      where: { companyId, isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true, rate: true, taxCode: true, isDefault: true, isActive: true },
    }),
  ]);
  return {
    companyId,
    pricesIncludeTax: !!company?.pricesIncludeTax,
    currency: company?.currency || 'UGX',
    rates,
  };
}

/**
 * Applies the company's tax setup to one entered price.
 *
 * When the business prices tax-inclusively the entered figure is kept as the
 * gross, so the line total lands on the quoted number rather than on a rounding
 * artefact of the net.
 */
export function priced(ctx: TaxContext, enteredPrice: number, entityTaxRateId?: number | null) {
  const tax = resolveTaxRate(entityTaxRateId, ctx.rates);
  return {
    tax,
    unitPrice: normalizeUnitPrice(enteredPrice, tax.rate, ctx.pricesIncludeTax),
    grossUnitPrice: ctx.pricesIncludeTax ? round2(enteredPrice) : null,
  };
}

// ── Building lines from rental work ────────────────────────────────────────

/** A rental order with the relations `draftLinesFromOrder` needs. */
export type OrderWithLines = {
  checkoutDate: Date;
  expectedReturnDate: Date;
  lineItems: {
    itemType: string;
    itemId: number | null;
    assetId: number | null;
    consumableId: number | null;
    unitOfMeasureId: number | null;
    quantity: number;
    dailyRate: any;
    item?: { name: string; taxRateId: number | null; unitOfMeasureId: number | null } | null;
    asset?: { name: string; serialNumber: string; taxRateId: number | null; unitOfMeasureId: number | null } | null;
    consumable?: { name: string; taxRateId: number | null; unitOfMeasureId: number | null } | null;
  }[];
};

/**
 * Turns a rental order's lines into invoice lines.
 *
 * Hire lines are priced per day across the booked period; consumables are sold
 * outright, so they bill once regardless of how long the order runs. That split
 * matches how the booking priced them in the first place, so the invoice never
 * disagrees with the quote the customer accepted.
 *
 * `rentalDays` overrides the period taken from the order's own dates. Dispatch
 * passes the booking's agreed pickup-to-return window, because that is what the
 * customer was quoted — collecting a day late lengthens the order but must not
 * quietly re-price the hire. An overrun is charged as a late fee instead.
 */
export function draftLinesFromOrder(
  order: OrderWithLines, ctx: TaxContext, opts?: { rentalDays?: number }
): DraftLine[] {
  const days = opts?.rentalDays && opts.rentalDays > 0
    ? Math.max(1, Math.round(opts.rentalDays))
    : rentalDaysBetween(order.checkoutDate, order.expectedReturnDate);

  return order.lineItems.map((li, i) => {
    const entity = li.item || li.asset || li.consumable;
    const isConsumable = li.itemType === 'consumable';
    const name = entity?.name
      || (li.itemType === 'asset' ? 'Serialized asset' : li.itemType === 'consumable' ? 'Consumable' : 'Hire item');
    const { tax, unitPrice, grossUnitPrice } = priced(ctx, Number(li.dailyRate), entity?.taxRateId ?? null);

    return {
      itemType: li.itemType,
      itemId: li.itemId,
      assetId: li.assetId,
      consumableId: li.consumableId,
      unitOfMeasureId: li.unitOfMeasureId ?? entity?.unitOfMeasureId ?? null,
      description: isConsumable ? name : `${name} — hire`,
      quantity: li.quantity,
      rentalDays: isConsumable ? 1 : days,
      unitPrice,
      grossUnitPrice,
      tax,
      sortOrder: i,
    };
  });
}

// ── Persisting invoices ────────────────────────────────────────────────────

export interface CreateInvoiceInput {
  companyId: number;
  referenceNumber: string;
  customerId?: number | null;
  customerName: string;
  customerTin?: string | null;
  invoiceType?: 'RENTAL' | 'PENALTY' | 'MANUAL';
  rentalOrderId?: number | null;
  bookingId?: number | null;
  description: string;
  notes?: string | null;
  terms?: string | null;
  dueDate: Date;
  issueDate?: Date;
  /** Already collected against this invoice — a booking deposit, typically. */
  amountPaid?: number;
  lines: DraftLine[];
}

/**
 * Creates an invoice and its lines in one transaction, with the header totals
 * derived from the lines rather than passed in — so a header can never claim a
 * figure its lines don't add up to.
 */
export async function createInvoice(
  prisma: PrismaClient,
  ctx: TaxContext,
  input: CreateInvoiceInput
) {
  const { lines, subtotal, discountTotal, taxTotal, amount } = buildInvoiceLines(input.lines);
  const amountPaid = round2(Math.min(Number(input.amountPaid) || 0, amount));

  return prisma.invoice.create({
    data: {
      companyId: input.companyId,
      referenceNumber: input.referenceNumber,
      customerId: input.customerId ?? null,
      customerName: input.customerName,
      customerTin: input.customerTin ?? null,
      invoiceType: input.invoiceType || 'MANUAL',
      rentalOrderId: input.rentalOrderId ?? null,
      bookingId: input.bookingId ?? null,
      currency: ctx.currency,
      subtotal,
      discountTotal,
      taxTotal,
      amount,
      amountPaid,
      issueDate: input.issueDate || new Date(),
      dueDate: input.dueDate,
      status: amountPaid >= amount && amount > 0 ? 'Paid' : 'Unpaid',
      description: input.description,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      lineItems: { create: lines },
    },
    include: { lineItems: true },
  });
}

/**
 * A penalty or charge invoice keyed by a deterministic reference, so re-applying
 * a fee updates the existing invoice instead of raising a second one.
 *
 * `grossAmount` is what the business means to collect, so the fee line is worked
 * backwards from it — charging 100,000 for a damaged tent means the customer
 * pays 100,000, with the VAT inside it, not 118,000.
 */
export async function upsertPenaltyInvoice(
  prisma: PrismaClient,
  ctx: TaxContext,
  params: {
    companyId: number;
    reference: string;
    customerId?: number | null;
    customerName: string;
    customerTin?: string | null;
    grossAmount: number;
    description: string;
    dueDate: Date;
    rentalOrderId?: number | null;
  }
) {
  const draft = feeLine(params.description, params.grossAmount, resolveTaxRate(null, ctx.rates));
  const { lines, subtotal, discountTotal, taxTotal, amount } = buildInvoiceLines([draft]);

  const existing = await prisma.invoice.findFirst({
    where: { companyId: params.companyId, referenceNumber: params.reference },
  });

  if (existing) {
    // A fiscalized invoice has been reported to URA under these figures.
    // Silently rewriting it would put the books out of step with the tax
    // authority, so the amount stands and a credit note is the way to correct it.
    if (existing.efrisFDN) return existing;

    return prisma.$transaction(async (tx) => {
      await tx.invoiceLineItem.deleteMany({ where: { invoiceId: existing.id } });
      return tx.invoice.update({
        where: { id: existing.id },
        data: {
          amount, subtotal, discountTotal, taxTotal,
          dueDate: params.dueDate,
          description: params.description,
          customerId: params.customerId ?? existing.customerId,
          customerTin: params.customerTin ?? existing.customerTin,
          rentalOrderId: params.rentalOrderId ?? existing.rentalOrderId,
          currency: ctx.currency,
          invoiceType: 'PENALTY',
          status: existing.status === 'Paid' ? 'Paid' : 'Unpaid',
          lineItems: { create: lines },
        },
        include: { lineItems: true },
      });
    });
  }

  return prisma.invoice.create({
    data: {
      companyId: params.companyId,
      referenceNumber: params.reference,
      customerId: params.customerId ?? null,
      customerName: params.customerName,
      customerTin: params.customerTin ?? null,
      invoiceType: 'PENALTY',
      rentalOrderId: params.rentalOrderId ?? null,
      currency: ctx.currency,
      subtotal, discountTotal, taxTotal, amount,
      dueDate: params.dueDate,
      status: 'Unpaid',
      description: params.description,
      lineItems: { create: lines },
    },
    include: { lineItems: true },
  });
}

// ── Credit notes ───────────────────────────────────────────────────────────

/** One invoice line, as stored. */
export type StoredInvoiceLine = {
  id: number;
  itemType: string;
  itemId: number | null;
  assetId: number | null;
  consumableId: number | null;
  unitOfMeasureId: number | null;
  description: string;
  quantity: any;
  rentalDays: number;
  unitPrice: any;
  discount: any;
  taxRatePercent: any;
  taxCode: string;
  lineNet: any;
  lineTax: any;
  lineTotal: any;
};

/**
 * Builds credit-note lines from the invoice being credited.
 *
 * `selection` credits specific quantities of specific lines; without it the
 * whole invoice is reversed. Prices are copied from the invoice rather than
 * re-derived from the catalogue, because a credit note has to reverse what was
 * actually charged, not what the item costs today.
 */
export function creditNoteLinesFromInvoice(
  lines: StoredInvoiceLine[],
  selection?: { lineId: number; quantity: number }[]
) {
  const wanted = selection && selection.length
    ? lines
        .map((l) => {
          const pick = selection.find((s) => s.lineId === l.id);
          if (!pick) return null;
          const qty = Math.min(Number(pick.quantity) || 0, Number(l.quantity) || 0);
          return qty > 0 ? { line: l, quantity: qty } : null;
        })
        .filter((x): x is { line: StoredInvoiceLine; quantity: number } => x !== null)
    : lines.map((l) => ({ line: l, quantity: Number(l.quantity) || 0 }));

  const rows = wanted.map(({ line, quantity }) => {
    const days = Math.max(1, line.rentalDays || 1);
    const unitPrice = round4(Number(line.unitPrice));
    const fullQty = Number(line.quantity) || 1;
    const share = quantity / fullQty;
    // Credit the same proportion of what the line actually charged, rather than
    // re-deriving it from the unit price — that way a full credit returns the
    // invoice total exactly, with no rounding residue left owing.
    const lineNet = round2(Number(line.lineNet) * share);
    const lineTax = round2(Number(line.lineTax) * share);
    return {
      itemType: line.itemType,
      itemId: line.itemId,
      assetId: line.assetId,
      consumableId: line.consumableId,
      unitOfMeasureId: line.unitOfMeasureId,
      description: line.description,
      // Days fold into the quantity: a credit note has no rental period of its
      // own, it just reverses a value.
      quantity: round2(quantity * days),
      unitPrice,
      taxRatePercent: Number(line.taxRatePercent) || 0,
      taxCode: line.taxCode || '01',
      lineNet,
      lineTax,
      lineTotal: round2(lineNet + lineTax),
    };
  });

  const subtotal = round2(rows.reduce((s, r) => s + r.lineNet, 0));
  const taxTotal = round2(rows.reduce((s, r) => s + r.lineTax, 0));
  return { rows, subtotal, taxTotal, amount: round2(subtotal + taxTotal) };
}

// ── Reading ────────────────────────────────────────────────────────────────

/** The include shape used everywhere an invoice is read for display or fiscalization. */
export const INVOICE_INCLUDE = {
  lineItems: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      item: { select: { id: true, name: true, sku: true, commodityCode: true, efrisItemCode: true, efrisRegisteredAt: true, haveExciseTax: true, exciseDutyCode: true, unitOfMeasure: true } },
      asset: { select: { id: true, name: true, sku: true, serialNumber: true, commodityCode: true, efrisItemCode: true, efrisRegisteredAt: true, haveExciseTax: true, exciseDutyCode: true } },
      consumable: { select: { id: true, name: true, sku: true, commodityCode: true, efrisItemCode: true, efrisRegisteredAt: true, haveExciseTax: true, exciseDutyCode: true } },
      unitOfMeasure: { select: { id: true, code: true, name: true, abbreviation: true, efrisCode: true } },
    },
  },
} as const;

/**
 * Fills in the derived figures the UI wants but the row doesn't store: what is
 * still owed, and whether the invoice has been reported to URA.
 */
export function decorateInvoice(invoice: any) {
  const amount = Number(invoice.amount) || 0;
  const paid = Number(invoice.amountPaid) || 0;
  return {
    ...invoice,
    balanceDue: round2(amount - paid),
    isFiscalized: !!invoice.efrisFDN,
  };
}
