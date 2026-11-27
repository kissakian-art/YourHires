/**
 * Shared shapes for the tax-rate and URA EFRIS screens.
 *
 * These mirror what the API returns; keeping them in one place stops the panels
 * and the main App drifting apart as the invoice shape grows.
 */

export interface TaxRate {
  id: number;
  name: string;
  /** Fraction: 0.18 = 18%. */
  rate: number | string;
  /** URA tax category: 01 standard · 02 zero-rated · 03 exempt · 04 deemed. */
  taxCode: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface InvoiceLine {
  id: number;
  itemType: string;
  itemId: number | null;
  assetId: number | null;
  consumableId: number | null;
  description: string;
  quantity: number | string;
  rentalDays: number;
  /** NET price per unit per day. */
  unitPrice: number | string;
  discount: number | string;
  taxRatePercent: number | string;
  taxCode: string;
  lineNet: number | string;
  lineTax: number | string;
  lineTotal: number | string;
  unitOfMeasure?: { id: number; code: string; abbreviation: string } | null;
  item?: { id: number; name: string; efrisRegisteredAt?: string | null } | null;
  asset?: { id: number; name: string; efrisRegisteredAt?: string | null } | null;
  consumable?: { id: number; name: string; efrisRegisteredAt?: string | null } | null;
}

export interface TaxSummaryRow {
  taxCode: string;
  rate: number;
  net: number;
  tax: number;
  gross: number;
  label: string;
}

export interface Invoice {
  id: number;
  referenceNumber: string;
  customerId?: number | null;
  customerName: string;
  customerTin?: string | null;
  invoiceType?: string;
  rentalOrderId?: number | null;
  currency?: string;
  subtotal?: number | string;
  discountTotal?: number | string;
  taxTotal?: number | string;
  amount: number | string;
  amountPaid?: number | string;
  balanceDue?: number;
  issueDate?: string;
  dueDate: string;
  status: string;
  description: string;
  notes?: string | null;
  terms?: string | null;
  createdAt?: string;
  paymentMethod?: string | null;
  paymentDate?: string | null;
  paymentNotes?: string | null;
  lineItems?: InvoiceLine[];
  taxSummary?: TaxSummaryRow[];
  amountInWords?: string;
  // URA EFRIS
  efrisInvoiceNo?: string | null;
  efrisFDN?: string | null;
  efrisVerificationCode?: string | null;
  efrisQRCode?: string | null;
  efrisStatus?: string | null;
  efrisError?: string | null;
  efrisFiscalizedAt?: string | null;
  eInvoiceResponse?: any;
  isFiscalized?: boolean;
}

export interface CreditNote {
  id: number;
  referenceNumber: string;
  invoiceId?: number | null;
  customerName: string;
  subtotal?: number | string;
  taxTotal?: number | string;
  amount: number | string;
  createdAt: string;
  reason: string;
  reasonCode?: string;
  reasonLabel?: string;
  lineItems?: InvoiceLine[];
  invoice?: { id: number; referenceNumber: string; efrisFDN?: string | null } | null;
  efrisFDN?: string | null;
  efrisVerificationCode?: string | null;
  efrisQRCode?: string | null;
  efrisStatus?: string | null;
  efrisError?: string | null;
  isFiscalized?: boolean;
  canFiscalize?: boolean;
}

export interface EfrisSettings {
  enabled: boolean;
  configured: boolean;
  apiKeyMasked: string;
  apiUrl: string;
  tin: string;
  feeItemCode: string;
  feeItemName: string;
  feeCommodityCode: string;
  feeRegisteredAt: string | null;
}

export interface EfrisCatalogEntry {
  id: number;
  name: string;
  kind: 'item' | 'asset' | 'consumable';
  sku: string | null;
  serialNumber?: string | null;
  commodityCode: string | null;
  taxRateId: number | null;
  unitOfMeasureId: number | null;
  efrisRegisteredAt: string | null;
  efrisItemCode: string | null;
  haveExciseTax: string | null;
  exciseDutyCode: string | null;
  registered: boolean;
  missing: string[];
}

export interface ExciseCode {
  id: number;
  code: string;
  name: string;
  rate: string | null;
  unit: string | null;
  currency: string | null;
  exciseRule: string | null;
}

export interface StockMovement {
  id: number;
  direction: 'INCREASE' | 'DECREASE';
  reference: string;
  stockInType: string | null;
  adjustType: string | null;
  supplierName: string | null;
  remarks: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  typeLabel: string;
}

/** URA tax categories, as shown in a fiscal invoice's tax summary. */
export const TAX_CATEGORIES: { code: string; label: string }[] = [
  { code: '01', label: 'A — Standard (18%)' },
  { code: '02', label: 'B — Zero Rate (0%)' },
  { code: '03', label: 'C — Exempt' },
  { code: '04', label: 'D — Deemed (18%)' },
];

export const CREDIT_NOTE_REASONS: { code: string; label: string }[] = [
  { code: '101', label: 'Return of products' },
  { code: '102', label: 'Cancellation of purchase' },
  { code: '103', label: 'Invoice amount wrongly stated' },
  { code: '104', label: 'Partial or complete waive off' },
  { code: '105', label: 'Others' },
];

export const STOCK_IN_TYPES: { code: string; label: string }[] = [
  { code: '101', label: 'Import' },
  { code: '102', label: 'Local Purchase' },
  { code: '103', label: 'Manufacture / Assembling' },
  { code: '104', label: 'Opening Stock' },
];

export const STOCK_ADJUST_TYPES: { code: string; label: string }[] = [
  { code: '101', label: 'Expired Goods' },
  { code: '102', label: 'Damaged Goods' },
  { code: '103', label: 'Personal Use' },
  { code: '104', label: 'Others' },
  { code: '105', label: 'Raw Materials' },
];

/** Formats a stored money value for display. */
export function fmtMoney(value: number | string | null | undefined, symbol = 'UGX'): string {
  const n = Number(value) || 0;
  return `${symbol} ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
