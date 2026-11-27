/**
 * efris.ts
 * --------
 * URA EFRIS e-invoicing for YourHires, over the Midway EFRIS middleware.
 *
 *   Base URL: https://efris.midwayug.com/api/external/efris
 *   Auth:     X-API-Key: <this company's key>
 *
 * Covers the interfaces a hire business needs (see CUSTOM_ERP_INTEGRATION_GUIDE.md):
 *   T130  register-product      — catalogue must exist at URA before it can be billed
 *   T109  submit-invoice        — fiscalize an invoice, get back an FDN + QR
 *   T110  submit-credit-note    — reverse a fiscalized invoice
 *   T131  stock-increase/decrease — consumable stock movements
 *
 * Two things about hire that differ from a shop, and shape everything below:
 *
 *  1. Hiring out an item is a SERVICE, not a sale of goods. Items and serialized
 *     assets therefore register with `is_service: true` and carry no stock at
 *     URA. Only consumables — which really are sold — register as goods and get
 *     T131 stock movements.
 *  2. EFRIS prices are GROSS (tax-inclusive), while invoice lines are stored NET.
 *     Every builder here converts on the way out; nothing upstream has to think
 *     about it.
 *
 * Credentials are per-company: URA issues the key against that taxpayer's own
 * TIN, so they are stored on the Company row and never shared between tenants.
 */

export const DEFAULT_EFRIS_BASE_URL = 'https://efris.midwayug.com/api/external/efris';

// ── Configuration ──────────────────────────────────────────────────────────

export interface EfrisConfig {
  apiKey: string;
  baseUrl: string;
  tin: string | null;
}

export interface EfrisCompanyRow {
  efrisEnabled: boolean;
  efrisApiUrl: string | null;
  efrisApiKey: string | null;
  efrisTin: string | null;
}

/**
 * The company's EFRIS config, or null when it is switched off or has no key.
 * Callers treat null as "EFRIS is not available here" rather than an error, so
 * a business that doesn't use EFRIS never sees a failure.
 */
export function resolveEfrisConfig(company: EfrisCompanyRow | null | undefined): EfrisConfig | null {
  if (!company?.efrisEnabled) return null;
  const apiKey = company.efrisApiKey?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (company.efrisApiUrl?.trim() || DEFAULT_EFRIS_BASE_URL).replace(/\/+$/, ''),
    tin: company.efrisTin?.trim() || null,
  };
}

/** Shows only the last 4 characters of a saved key, so the UI can confirm which key is stored without leaking it. */
export function maskApiKey(key: string | null | undefined): string {
  const k = (key || '').trim();
  if (!k) return '';
  return k.length <= 4 ? '••••' : '••••••••' + k.slice(-4);
}

/**
 * An EFRIS call that failed. Carries the parsed middleware body so the operator
 * can be shown URA's own words, and so a rejection can be persisted verbatim.
 */
export class EfrisError extends Error {
  response: any;
  httpStatus: number;
  constructor(message: string, response: any = null, httpStatus = 0) {
    super(message);
    this.name = 'EfrisError';
    this.response = response;
    this.httpStatus = httpStatus;
  }
}

/**
 * One request to the middleware.
 *
 * The body is read as text before parsing so a gateway's HTML error page can't
 * mask the real failure behind a JSON parse error — a lesson from the POS
 * integration, where "unexpected token <" hid every 502.
 */
export async function efrisRequest(
  cfg: EfrisConfig,
  path: string,
  init: { method?: string; body?: any; timeoutMs?: number } = {}
): Promise<any> {
  const url = `${cfg.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 60000);

  let res: Response;
  let rawBody: string;
  try {
    res = await fetch(url, {
      method: init.method || 'GET',
      headers: {
        'X-API-Key': cfg.apiKey,
        'Content-Type': 'application/json',
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    rawBody = await res.text();
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new EfrisError('The EFRIS service did not respond in time. Check this computer’s internet connection.');
    }
    throw new EfrisError('Could not reach the EFRIS service. Check this computer’s internet connection and the EFRIS URL.');
  } finally {
    clearTimeout(timer);
  }

  let parsed: any = null;
  try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { /* non-JSON handled below */ }

  if (res.status === 401 || res.status === 403) {
    throw new EfrisError('EFRIS rejected the API key. Check it was copied in full.', parsed, res.status);
  }
  if (!res.ok || (parsed && parsed.success === false)) {
    throw new EfrisError(extractEfrisError(parsed, res.status), parsed, res.status);
  }
  if (parsed === null) {
    throw new EfrisError(`EFRIS returned a non-JSON response (HTTP ${res.status}).`, rawBody, res.status);
  }
  return parsed;
}

/**
 * Digs the human-readable reason out of a rejection. The middleware surfaces
 * URA's message under several different keys depending on where the failure
 * happened, so all of them are tried before falling back to the raw body.
 */
export function extractEfrisError(body: any, httpStatus = 0): string {
  if (!body) return `EFRIS returned an error (HTTP ${httpStatus}).`;
  if (typeof body === 'string') return body.slice(0, 500);
  const msg =
    body.message || body.error || body.errorMessage || body.msg || body.detail ||
    body?.data?.message || body?.data?.error ||
    body?.returnStateInfo?.returnMessage;
  if (msg) return String(msg).slice(0, 500);
  return `EFRIS returned an error (HTTP ${httpStatus}).`;
}

// ── Unit of measure ────────────────────────────────────────────────────────

/**
 * YourHires seeds `units_of_measure` from URA's own list, so a unit's `code` is
 * already the EFRIS code (PCE, KGM, LTR, 4C…). `efrisCode` exists only as a
 * per-row override for anything a business adds by hand.
 */
export function unitCode(uom: { code: string; efrisCode?: string | null } | null | undefined): string {
  return (uom?.efrisCode?.trim() || uom?.code?.trim() || 'PCE').toUpperCase();
}

/**
 * Fallback for the legacy free-text unit on Item ("piece", "set", …) used when
 * no unit has been picked from the catalogue yet.
 */
export function legacyUnitToEfris(text: string | null | undefined): string {
  const map: Record<string, string> = {
    piece: 'PCE', pieces: 'PCE', pcs: 'PCE', pc: 'PCE', each: 'PCE', unit: 'PCE',
    kg: 'KGM', kilogram: 'KGM', g: 'GRM', gram: 'GRM', tonne: 'TNE', ton: 'TNE',
    l: 'LTR', litre: 'LTR', liter: 'LTR', ml: 'MLT',
    m: 'MTR', metre: 'MTR', meter: 'MTR',
    box: '4C', carton: 'CT', pack: 'PK', packet: 'PA', bag: 'BG',
    dozen: 'DZN', pair: 'NPR', set: 'SET', roll: 'RO', bundle: 'BE',
    day: 'DAY', days: 'DAY', hour: 'HUR', hours: 'HUR',
  };
  return map[(text || '').trim().toLowerCase()] || 'PCE';
}

// ── T130 — Product registration ────────────────────────────────────────────

/**
 * What EFRIS needs to know about a catalogue entry. Items and serialized assets
 * arrive here as services; consumables as goods.
 */
export interface EfrisRegisterInput {
  itemCode: string;          // our stable identifier for the product at URA
  itemName: string;
  /** GROSS (tax-inclusive) selling price of one unit. */
  unitPrice: number;
  commodityCode: string;     // URA commodity classification
  unitOfMeasure: string;     // EFRIS unit code
  isService: boolean;
  /** Already registered? Then this is an update, not a new registration. */
  alreadyRegistered: boolean;
  haveExciseTax?: string | null;   // "101" yes · "102" no
  exciseDutyCode?: string | null;
  /** Rule of the chosen excise code: "1" percentage · "2" per unit. */
  exciseRule?: string | null;
  /** Excise rate unit code (T115), e.g. "102" litre. */
  exciseUnit?: string | null;
}

/**
 * Builds the POST /register-product body.
 *
 * The piece-unit rules are the fiddly part (guide §2). A unit-based excise duty
 * — say UGX 150 per litre — makes `have_piece_unit: "101"` mandatory and the
 * piece unit must match the duty's unit, or URA rejects with error 676. For
 * everything else a single-unit product is fine.
 */
export function buildRegisterProductPayload(input: EfrisRegisterInput): Record<string, any> {
  const operationType = input.alreadyRegistered ? '102' : '101';
  const hasExcise = input.haveExciseTax === '101' && !!input.exciseDutyCode;
  // A per-unit duty carries a unit of measurement, which forces the piece unit on.
  const exciseHasUnit = hasExcise && (input.exciseRule === '2' || !!input.exciseUnit);

  const payload: Record<string, any> = {
    operationType,
    item_code: input.itemCode,
    item_name: input.itemName,
    unit_price: String(Math.round(input.unitPrice)),
    commodity_code: input.commodityCode,
    unit_of_measure: input.unitOfMeasure,
    is_service: input.isService,
    have_piece_unit: exciseHasUnit ? '101' : '102',
    have_excise_tax: hasExcise ? '101' : '102',
  };

  if (exciseHasUnit) {
    payload.piece_measure_unit = input.exciseUnit || input.unitOfMeasure;
    payload.piece_scaled_value = '1';
    payload.piece_unit_price = String(Math.round(input.unitPrice));
    payload.package_scaled_value = '1';
  }
  if (hasExcise) payload.excise_duty_code = input.exciseDutyCode;

  return payload;
}

// ── T109 — Invoice fiscalization ───────────────────────────────────────────

/**
 * EFRIS payment-method codes (guide §4). YourHires records payment methods as
 * free text on the invoice, so unknown values fall back to Cash rather than
 * failing the whole submission over a label.
 */
export function mapPaymentMethod(method?: string | null): string {
  const key = (method || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map: Record<string, string> = {
    credit: '101', on_account: '101', account: '101', invoice: '101',
    cash: '102',
    cheque: '103', check: '103',
    demand_draft: '104',
    mobile_money: '105', momo: '105', mtn: '105', airtel: '105',
    card: '106', visa: '106', mastercard: '106', credit_card: '106', debit_card: '106',
    eft: '107', bank_transfer: '107', bank: '107', transfer: '107',
    pos: '108',
  };
  return map[key] || '102';
}

/**
 * A stored tax fraction (0.18) as the EFRIS simple-format `tax_rate`.
 * Exempt lines report "-" per the guide; zero-rated report 0.
 */
export function efrisTaxRate(rateFraction: number, taxCode: string): number | string {
  if (taxCode === '03') return '-';           // Exempt
  const r = Number(rateFraction) || 0;
  if (r <= 0) return 0;                        // Zero rated
  return Math.round(r * 100);
}

/** One invoice line as EFRIS should see it. */
export interface EfrisInvoiceItemInput {
  itemName: string;
  itemCode: string;
  commodityCode: string;
  quantity: number;
  /** NET unit price for one unit (already multiplied out by days upstream). */
  unitPriceNet: number;
  taxRateFraction: number;
  taxCode: string;
  unitOfMeasure: string;
  /** NET discount on the line, if any. */
  discountNet?: number;
  /** Set when the product carries excise duty, resolved from the cached registry. */
  excise?: {
    code: string;
    name: string;
    rate: string | null;
    unit: string | null;
    currency: string | null;
    exciseRule: string | null;
  } | null;
}

export interface EfrisInvoiceInput {
  invoiceNumber: string;      // our seller reference (≤50 chars)
  invoiceDate: string;        // YYYY-MM-DD
  customerName: string;
  customerTin?: string | null;
  paymentMethod?: string | null;
  currency?: string | null;
  operator?: string | null;
  remarks?: string | null;
  items: EfrisInvoiceItemInput[];
}

/**
 * Builds the simple-format POST /submit-invoice body (guide §4a).
 *
 * Prices go out GROSS, as EFRIS requires, converted from the net figures the
 * invoice stores. Discounted lines report the ORIGINAL gross price plus a
 * `discount`, and the middleware emits the paired discount lines URA wants —
 * sending the already-discounted price instead would understate the discount to
 * URA (guide §4b).
 */
export function buildInvoicePayload(input: EfrisInvoiceInput): Record<string, any> {
  const buyerType = input.customerTin && input.customerTin.trim() ? '0' : '1';

  const items = input.items.map((it) => {
    const rate = Number(it.taxRateFraction) || 0;
    const grossUnitPrice = Math.round(it.unitPriceNet * (1 + rate) * 100) / 100;
    const discountNet = Number(it.discountNet) || 0;
    const grossDiscount = Math.round(discountNet * (1 + rate) * 100) / 100;

    const line: Record<string, any> = {
      item_name: it.itemName,
      item_code: it.itemCode,
      quantity: Number(it.quantity),
      unit_price: grossUnitPrice,
      tax_rate: efrisTaxRate(rate, it.taxCode),
      unit_of_measure: it.unitOfMeasure,
      goods_category_id: it.commodityCode,
    };
    if (grossDiscount > 0) line.discount = grossDiscount;

    if (it.excise) {
      const ex = it.excise;
      const rule = ex.exciseRule || '1';
      line.excise_flag = '1';
      line.category_id = ex.code;
      line.category_name = ex.name;
      line.excise_rule = rule;
      if (ex.rate) line.excise_rate = ex.rate;
      if (ex.unit) line.excise_unit = ex.unit;
      if (ex.currency) line.excise_currency = ex.currency;

      // The middleware does not compute the duty, so we do: a percentage rule
      // applies to the line's net value, a per-unit rule to the quantity.
      const rawRate = Number(ex.rate || 0);
      if (rawRate > 0) {
        const netLine = it.unitPriceNet * Number(it.quantity) - discountNet;
        const exciseTax = rule === '1'
          ? (rawRate > 1 ? rawRate / 100 : rawRate) * netLine
          : rawRate * Number(it.quantity);
        if (exciseTax > 0) line.excise_tax = Math.round(exciseTax * 100) / 100;
      }
    }

    return line;
  });

  return {
    format: 'simple',
    invoice_number: input.invoiceNumber,
    invoice_date: input.invoiceDate,
    customer_name: input.customerName || 'General Customer',
    customer_tin: input.customerTin || '',
    buyer_type: buyerType,
    payment_method: mapPaymentMethod(input.paymentMethod),
    currency: input.currency || 'UGX',
    remarks: (input.remarks || 'e-Invoice generated by YourHires').slice(0, 500),
    operator: input.operator || 'System Operator',
    items,
  };
}

/**
 * Who URA says this taxpayer is. Read from the service rather than typed in:
 * the API key is issued against exactly one TIN, so asking the operator to
 * retype it only creates something that can drift from the truth.
 */
export interface EfrisTaxpayer {
  tin: string | null;
  legalName: string | null;
  tradeName: string | null;
  address: string | null;
}

/**
 * Extracts the taxpayer block from a /registration-details response, or from the
 * `seller` block of a fiscalization response — both describe the same thing, and
 * neither has a stable field layout across middleware versions.
 */
export function extractTaxpayer(result: any): EfrisTaxpayer {
  const t = result?.taxpayer || result?.taxpayerInfo || result?.data?.taxpayer || result?.seller || result || {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = t[k] ?? result?.[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return null;
  };
  return {
    tin: pick('tin', 'TIN', 'taxpayerTin', 'taxpayer_tin'),
    legalName: pick('legal_name', 'legalName', 'ninBrn', 'name'),
    tradeName: pick('trade_name', 'tradeName', 'businessName'),
    address: pick('address', 'businessAddress', 'addressLine'),
  };
}

/**
 * Pulls the fiscal identifiers out of a /submit-invoice response. Field
 * locations vary between middleware versions, so each is tried in turn (guide §9).
 */
export function summarizeFiscalResponse(result: any, fallbackInvoiceNo: string) {
  const fd = result?.fiscal_data || result?.fiscalData || {};
  return {
    fdn: result?.fdn || fd.fdn || fd.fiscalDocumentNumber || '',
    verificationCode: result?.verification_code || fd.verification_code || fd.verificationCode || '',
    qrCode: result?.qr_code || fd.qr_code || fd.qrCode || '',
    invoiceNo: result?.seller?.reference_number || result?.invoice_number || fallbackInvoiceNo,
  };
}

// ── T110 — Credit notes ────────────────────────────────────────────────────

/** 101 return · 102 cancellation · 103 amount wrongly stated · 104 waive off · 105 other. */
export function creditNoteReasonCode(code?: string | null): string {
  const allowed = ['101', '102', '103', '104', '105'];
  return code && allowed.includes(String(code)) ? String(code) : '101';
}

export interface EfrisCreditNoteItemInput {
  itemName: string;
  itemCode: string;
  quantity: number;
  /** NET unit price the original invoice charged. */
  unitPriceNet: number;
  taxRateFraction: number;
  taxCode: string;
}

export interface EfrisCreditNoteInput {
  originalInvoiceNumber: string;  // the reference the original invoice was fiscalized under
  originalFdn: string;
  reason: string;
  reasonCode?: string;
  items: EfrisCreditNoteItemInput[];
}

/** Builds the POST /submit-credit-note body (guide §5). */
export function buildCreditNotePayload(input: EfrisCreditNoteInput): Record<string, any> {
  return {
    original_invoice_number: input.originalInvoiceNumber,
    original_fdn: input.originalFdn,
    reason: (input.reason || 'Customer credit').slice(0, 500),
    reason_code: creditNoteReasonCode(input.reasonCode),
    items: input.items.map((it) => {
      const rate = Number(it.taxRateFraction) || 0;
      return {
        item_name: it.itemName,
        item_code: it.itemCode,
        quantity: Number(it.quantity),
        unit_price: Math.round(it.unitPriceNet * (1 + rate) * 100) / 100,
        tax_rate: efrisTaxRate(rate, it.taxCode),
      };
    }),
  };
}

// ── T131 — Stock movements ─────────────────────────────────────────────────

export interface EfrisStockItemInput {
  goodsCode: string;
  quantity: number;
  /** GROSS unit price, as EFRIS expects everywhere. */
  unitPrice: number;
  measureUnit: string;
}

export interface EfrisStockIncreaseInput {
  /** 101 import · 102 local purchase · 103 manufacture · 104 opening stock. */
  stockInType: string;
  supplierName?: string | null;
  supplierTin?: string | null;
  stockInDate: string;              // YYYY-MM-DD
  productionBatchNo?: string | null;
  productionDate?: string | null;
  items: EfrisStockItemInput[];
}

/**
 * Builds the POST /stock-increase body (guide §3a).
 *
 * URA's field rules are conditional and unforgiving: a manufacture entry (103)
 * must have NO supplier but must carry a batch number and date, while every
 * other type is the other way round. Sending a field that should be empty is
 * rejected, so each is set only where it belongs.
 */
export function buildStockIncreasePayload(input: EfrisStockIncreaseInput): Record<string, any> {
  const isManufacture = input.stockInType === '103';
  const head: Record<string, any> = {
    operationType: '101',
    stockInType: input.stockInType,
    stockInDate: input.stockInDate,
    goodsTypeCode: '101',
  };
  if (isManufacture) {
    head.productionBatchNo = input.productionBatchNo || '';
    head.productionDate = input.productionDate || input.stockInDate;
  } else {
    head.supplierName = input.supplierName || '';
    head.supplierTin = input.supplierTin || '';
  }

  return {
    goodsStockIn: head,
    goodsStockInItem: input.items.map((it) => ({
      goodsCode: it.goodsCode,
      quantity: String(it.quantity),
      unitPrice: String(Math.round(it.unitPrice)),
      measureUnit: it.measureUnit,
    })),
  };
}

export interface EfrisStockDecreaseInput {
  /** 101 expired · 102 damaged · 103 personal use · 104 other · 105 raw materials. */
  adjustType: string;
  remarks?: string | null;
  items: EfrisStockItemInput[];
}

/**
 * Builds the POST /stock-decrease body (guide §3b). `adjustType` 104 ("Others")
 * is the one case where URA requires a remark.
 */
export function buildStockDecreasePayload(input: EfrisStockDecreaseInput): Record<string, any> {
  return {
    goodsStockIn: {
      operationType: '102',
      adjustType: input.adjustType,
      remarks: input.remarks || '',
    },
    goodsStockInItem: input.items.map((it) => ({
      goodsCode: it.goodsCode,
      quantity: String(it.quantity),
      unitPrice: String(Math.round(it.unitPrice)),
      measureUnit: it.measureUnit,
    })),
  };
}

/** Labels for the stock-movement codes, used by the UI and audit entries. */
export const STOCK_IN_TYPES: Record<string, string> = {
  '101': 'Import',
  '102': 'Local Purchase',
  '103': 'Manufacture / Assembling',
  '104': 'Opening Stock',
};

export const STOCK_ADJUST_TYPES: Record<string, string> = {
  '101': 'Expired Goods',
  '102': 'Damaged Goods',
  '103': 'Personal Use',
  '104': 'Others',
  '105': 'Raw Materials',
};

export const CREDIT_NOTE_REASONS: Record<string, string> = {
  '101': 'Return of products',
  '102': 'Cancellation of purchase',
  '103': 'Invoice amount wrongly stated',
  '104': 'Partial or complete waive off',
  '105': 'Others',
};

// ── Identifiers ────────────────────────────────────────────────────────────

/**
 * The item_code a catalogue entry is known by at URA. Prefers the business's own
 * SKU; falls back to a stable type-and-id code so an entry without a SKU can
 * still be registered — and always resolves to the same value, since changing an
 * item_code at URA orphans the registration.
 */
export function catalogItemCode(
  kind: 'ITEM' | 'ASSET' | 'CONSUMABLE',
  entity: { id: number; sku?: string | null; serialNumber?: string | null }
): string {
  const sku = entity.sku?.trim();
  if (sku) return sku.slice(0, 50);
  if (kind === 'ASSET' && entity.serialNumber?.trim()) return entity.serialNumber.trim().slice(0, 50);
  const prefix = kind === 'ITEM' ? 'ITM' : kind === 'ASSET' ? 'AST' : 'CON';
  return `${prefix}-${entity.id}`;
}

/**
 * The seller reference an invoice is fiscalized under. URA treats this as the
 * unique invoice identity, so it is derived from the invoice's own reference
 * number and never regenerated — a second submission under a new reference
 * would double-report the tax.
 */
export function fiscalReference(referenceNumber: string): string {
  return referenceNumber.trim().slice(0, 50);
}
