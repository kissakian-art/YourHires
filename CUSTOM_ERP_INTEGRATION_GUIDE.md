# EFRIS Middleware Integration Guide (ERP Edition)

This document outlines the standard integration flow for the EFRIS Middleware API. It is intended for ERP developers to ensure consistent data reporting to URA.

> **Base URL:** `https://efris.midwayug.com/api/external/efris`  
> All requests require `X-API-Key: YOUR_SECRET_KEY` in the HTTP header.

---

## 1. Authentication

```http
X-API-Key: YOUR_SECRET_KEY
Content-Type: application/json
```

---

## 2. Product Registration (T130)

Before any item can be sold or stocked, it **must** be registered with EFRIS.

### The "Packaging" (Multi-Unit) System
EFRIS uses scaling to handle bulk vs retail units.

| Field | Meaning |
|-------|---------|
| `package_scaled_value` | The base "outer" unit multiplier (usually `"1"`) |
| `piece_scaled_value` | How many inner units fit in one outer unit (e.g., `"24"` = 24 bottles per crate) |
| `have_piece_unit` | `"101"` = Yes has piece units, `"102"` = No |
| `piece_measure_unit` | Unit code for the inner unit (from T115 rateUnit) |

### Registering Products with Excise Duty
If an item is subject to excise duty, you must report it during product registration using the following fields:

| Field | Meaning | Required / Value |
|-------|------------------|------------------|
| `have_excise_tax` / `haveExciseTax` | Is the product subject to excise tax | `"101"` = Yes, `"102"` = No (default) |
| `excise_duty_code` / `exciseDutyCode` | The official URA Excise Duty code | **Required if `have_excise_tax` is `"101"`**. Must be empty otherwise. Query active codes via `GET /excise-duty`. |

#### Important Excise Rules & Piece Units (EFRIS Error 676)
Depending on whether the chosen excise duty code has a **percentage rate** or a **unit rate**, different piece unit settings apply:

1. **Percentage-based Excise** (e.g., Beer at 60%, rule `1`):
   * `have_piece_unit` can remain `"102"` (No piece unit) unless the product naturally uses multi-unit packaging.
2. **Unit-based Excise** (e.g., Mineral water at `UGX 150 per Litre`, rule `2`):
   * **`have_piece_unit` MUST be set to `"101"` (Yes)**. If set to `"102"`, registration will fail with EFRIS error `676`: `"haveExciseTax is '101', excise duty has unit of measurement, 'havePieceUnit' must be '101'!"`.
   * **`piece_measure_unit`** must match the excise duty unit (e.g. `"102"` for Litre, `"103"` for Kilogram, `"106"` for 1000 pieces).
   * **`piece_scaled_value`** must represent the scale factor. If it is a standard single-unit product, set this to `"1"`.
   * **`piece_unit_price`** should match the unit price divided by the scale factor. For a single-unit product with scale `"1"`, this should match `unit_price`.

**`POST /register-product` (Percentage-based Excise Duty Example)**
```json
{
  "operationType": "101",
  "item_code": "BELL-500",
  "item_name": "Bell Lager 500ml",
  "unit_price": "4720",
  "commodity_code": "2203001000",
  "unit_of_measure": "102", // Litre
  "is_service": false,
  "have_piece_unit": "102",
  "have_excise_tax": "101",
  "excise_duty_code": "LED190100" // Beer (percentage-based)
}
```

**`POST /register-product` (Unit-based Excise Duty Example)**
```json
{
  "operationType": "101",
  "item_code": "WATER-LITRE",
  "item_name": "Mineral Water 1L",
  "unit_price": "2000",
  "commodity_code": "50202310",
  "unit_of_measure": "102", // Litre
  "is_service": false,
  "have_piece_unit": "101", // Required '101' because rate has unit (per Litre)
  "piece_measure_unit": "102", // Litre
  "piece_scaled_value": "1", // Single item scaling
  "piece_unit_price": "2000", // Same as unit price
  "package_scaled_value": "1",
  "have_excise_tax": "101",
  "excise_duty_code": "LED190400" // Mineral Water (UGX 150 per Litre)
}
```

### Modifying Existing Products
To update a registered product, use `"operationType": "102"` with the same `item_code`. Using `"101"` on an existing code will return an EFRIS error.

### `operationType` Reference
| Code | Meaning |
|------|---------|
| `101` | New registration |
| `102` | Update existing |

---

## 3. Stock Management (T131)

Stock must be reported before fiscalization (unless negative stock is enabled in your URA settings).

### 3a. Stock Increase — **`POST /stock-increase`**
```json
{
  "goodsStockIn": {
    "operationType": "101",
    "supplierName": "Supplier XYZ",
    "supplierTin": "1000001234",
    "stockInType": "102",
    "stockInDate": "2026-05-02",
    "goodsTypeCode": "101"
  },
  "goodsStockInItem": [
    {
      "goodsCode": "SKU-BOTTLE-01",
      "quantity": "100",
      "unitPrice": "18000",
      "measureUnit": "101"
    }
  ]
}
```

### 3b. Stock Decrease — **`POST /stock-decrease`**
```json
{
  "goodsStockIn": {
    "operationType": "102",
    "adjustType": "102",
    "remarks": "Damaged goods in warehouse"
  },
  "goodsStockInItem": [
    {
      "goodsCode": "SKU-BOTTLE-01",
      "quantity": "10",
      "unitPrice": "18000",
      "measureUnit": "101"
    }
  ]
}
```

### 3c. Stock Transfer Between Branches — **`POST /stock-transfer`** _(NEW)_

Transfers stock from one branch to another within the same TIN. Get valid `branchId` values from **`GET /registration-details`** (look inside the `taxpayerBranch` array in the response).

```json
{
  "goodsStockTransfer": {
    "source_branch_id": "206637525568955296",
    "destination_branch_id": "206637528324276772",
    "transfer_type_code": "101",
    "remarks": "",
    "roll_back_if_error": "0",
    "goods_type_code": "101"
  },
  "goodsStockTransferItem": [
    {
      "goods_code": "SKU-BOTTLE-01",
      "measure_unit": "101",
      "quantity": "100",
      "remarks": ""
    }
  ]
}
```

Both snake_case and camelCase field names are accepted for all stock transfer fields.

**`transfer_type_code` (transferTypeCode):**
| Code | Meaning |
|------|---------|
| `101` | Out of Stock Adjust |
| `102` | Error Adjust |
| `103` | Others — **`remarks` is REQUIRED** |

**Business Rules:**
- `source_branch_id` and `destination_branch_id` **cannot** be the same.
- Each item needs either `goods_code` **or** `commodity_goods_id` (EFRIS internal ID).
- If `transfer_type_code` is `"103"`, `remarks` cannot be empty.
- Set `roll_back_if_error: "1"` to rollback the entire transfer if any single item fails.

**Stock operation rules summary:**

| Rule | Condition |
|------|-----------|
| `stockInType` required | when `operationType = 101` |
| `stockInType` must be empty | when `operationType = 102` |
| `supplierTin` must be empty | when `operationType = 102` or `stockInType = 103` |
| `supplierName` required | when `operationType = 101` (except stockInType=103) |
| `adjustType` required | when `operationType = 102` |

**`stockInType` codes** — required when `operationType = 101`:

| Code | Meaning | Notes |
|------|---------|-------|
| `101` | Import | `supplierTin` and `supplierName` required |
| `102` | Local Purchase | `supplierTin` and `supplierName` required |
| `103` | Manufacture / Assembling | `supplierTin` and `supplierName` must be **empty**; use `productionBatchNo` and `productionDate` instead |
| `104` | Opening Stock | Use for initial stock load when first going live |

> **Manufacture/Assembling extra fields** (`stockInType = 103` only):
> - `productionBatchNo` — batch/lot number of the manufactured goods
> - `productionDate` — date of manufacture (`YYYY-MM-DD`)
>
> For all other `stockInType` values, these two fields **must be empty**.

**`adjustType` codes** — required when `operationType = 102` (Decrease):

| Code | Meaning | Notes |
|------|---------|-------|
| `101` | Expired Goods | |
| `102` | Damaged Goods | |
| `103` | Personal Use | |
| `104` | Others | `remarks` is **required** when `adjustType = 104` |
| `105` | Raw Materials | |


---

## 4. Invoicing / Fiscalization (T109)

### 4a. Standard Invoice — **`POST /submit-invoice`**

The middleware accepts both **Simple Format** (ERP sends raw data, middleware handles all EFRIS calculations) and **Pre-formatted EFRIS Format** (ERP sends already-computed EFRIS fields).

> **Simple Format** is recommended for all new integrations.

> **Pricing Rule:** Send **Gross Prices (Tax-Inclusive)**.  
> Net price 10,000 + 18% VAT → send `unit_price: 11800`

```json
{
  "format": "simple",
  "invoice_number": "INV-2026-001",
  "invoice_date": "2026-05-30",
  "customer_name": "John Doe",
  "customer_tin": "1000999888",
  "buyer_type": "1",
  "payment_method": "102",
  "currency": "UGX",
  "remarks": "Thank you for your business",
  "operator": "Jane Kasule",
  "items": [
    {
      "item_name": "Premium Water 500ml",
      "item_code": "SKU-BOTTLE-01",
      "quantity": 2,
      "unit_price": 24000,
      "tax_rate": 18,
      "unit_of_measure": "101",
      "package_scaled": "1",
      "piece_scaled": "24",
      "piece_qty": "48",
      "goods_category_id": "22011000"
    }
  ]
}
```

Both `snake_case` and `camelCase` are accepted for all fields throughout the API.

### Key Field Reference

**`buyer_type`:**
| Code | Meaning |
|------|---------|
| `0` | B2B (Business to Business) — `customer_tin` required |
| `1` | B2C (Individual) |
| `2` | Foreigner |
| `3` | B2G (Government) — `customer_tin` required |

**`payment_method`:**
| Code | Meaning |
|------|---------|
| `101` | Credit |
| `102` | Cash |
| `103` | Cheque |
| `104` | Demand Draft |
| `105` | Mobile Money |
| `106` | Visa/Mastercard |
| `107` | EFT |
| `108` | POS |

**`tax_rate` (Simple Format):**
| Value | Meaning |
|-------|---------|
| `18` or `0.18` | Standard VAT (18%) |
| `0` | Zero Rated |
| `-1` or `"-"` | Exempt |

---

### 4b. Discounts

#### Simple Format
Add a `discount` field (gross/tax-inclusive amount) to any item. The middleware auto-generates the required EFRIS discount lines.

```json
{
  "format": "simple",
  "invoice_number": "INV-2026-050",
  "customer_name": "Jane Doe",
  "buyer_type": "1",
  "payment_method": "102",
  "items": [
    {
      "item_name": "Premium Water 500ml",
      "item_code": "SKU-BOTTLE-01",
      "quantity": 5,
      "unit_price": 24000,
      "tax_rate": 18,
      "discount": 10000
    }
  ]
}
```

#### Pre-formatted EFRIS Format
You must send discount lines explicitly:
1. Parent item: `"discountFlag": "1"`, `"discountTotal"` = negative discount amount.
2. A separate following line: `"discountFlag": "0"`, negative `"total"` and `"tax"`, empty `"qty"`, `"unitOfMeasure"`, `"unitPrice"`.

> **⚠️ Error 1304:** If you get "itemCount must match the Number of all product lines…" — do **not** send `itemCount` manually in simple format; the middleware calculates it.

---

### 4c. Excise Duty Items

For items subject to excise duty, add these fields per item:

```json
{
  "item_name": "Bell Lager 500ml",
  "item_code": "BELL-500",
  "quantity": 24,
  "unit_price": 4720,
  "tax_rate": 18,
  "unit_of_measure": "101",
  "excise_flag": "1",
  "category_id": "BEV001",
  "category_name": "Beer & Malt Beverages",
  "excise_rule": "2",
  "excise_rate": "650",
  "excise_tax": "15600",
  "excise_unit": "102",
  "excise_currency": "UGX",
  "pack": "1",
  "stick": "500"
}
```

**`excise_flag`:** `"1"` = Item has excise, `"2"` = No excise (default)

**`excise_rule`:**
| Code | Meaning |
|------|---------|
| `"1"` | Percentage-based (`excise_rate` = decimal e.g. `"0.10"` for 10%) |
| `"2"` | Quantity/unit-based (`excise_rate` = fixed amount per unit e.g. `"650"` = UGX 650 per litre) |

**`excise_unit` codes (T115 rateUnit):**
| Code | Meaning |
|------|---------|
| `101` | Per stick |
| `102` | Per litre |
| `103` | Per kg |
| `104` | Per user per day |
| `105` | Per minute |
| `106` | Per 1,000 sticks |
| `107` | Per 50 kgs |

The middleware automatically generates the correct `exciseRateName` (e.g., `"UGX650 per litre"`) and adds a separate `"05"` (Excise Duty) entry in `taxDetails`.

---

### 4d. Export Invoices _(NEW)_

For goods being exported, set `invoice_industry_code: "102"`. The middleware automatically sets `nonResidentFlag` and routes the customs block correctly.

```json
{
  "invoice_number": "EXP-2026-001",
  "invoice_date": "2026-05-30",
  "customer_name": "Nairobi Traders Ltd",
  "customer_tin": "P051234567X",
  "buyer_type": "0",
  "payment_method": "102",
  "invoice_industry_code": "102",
  "delivery_terms_code": "FOB",
  "customs": {
    "sad_number": "SAD12345",
    "office": "Busia",
    "cif": "5000",
    "ware_house_number": "WH001",
    "ware_house_name": "Busia Warehouse",
    "destination_country": "Kenya",
    "origin_country": "Uganda",
    "import_export_flag": "2",
    "confirm_status": "0",
    "valuation_method": "CIF",
    "prn": "PRN123"
  },
  "items": [
    {
      "item_name": "Ugandan Coffee",
      "item_code": "COFFEE-001",
      "quantity": 500,
      "unit_price": 12000,
      "tax_rate": 0,
      "unit_of_measure": "103",
      "total_weight": 500,
      "piece_qty": 500,
      "piece_measure_unit": "103",
      "hs_code": "0901110000",
      "hs_name": "Coffee, not roasted, not decaffeinated"
    }
  ]
}
```

**`invoice_industry_code`:**
| Code | Meaning |
|------|---------|
| `101` | General Industry (default — omit this field for normal invoices) |
| `102` | Export |
| `112` | Export Service |

**`delivery_terms_code`** (Incoterms — mandatory for export):
`FOB`, `CIF`, `CFR`, `EXW`, `DAP`, `DDP`, `DPU`, `CIP`, `CPT`, `FAS`, `FCA`

**`import_export_flag`:** `"1"` = Import, `"2"` = Export

**Per-item export fields (mandatory when `invoice_industry_code = "102"`):**

| Field | Alias | Description |
|-------|-------|-------------|
| `total_weight` | `totalWeight` | Total Net Weight in KGM |
| `piece_qty` | `pieceQty` | Piece Quantity |
| `piece_measure_unit` | `pieceMeasureUnit` | Unit code from T115 rateUnit |
| `hs_code` | `hsCode` | HS Tariff Code (optional) |
| `hs_name` | `hsName` | HS Code description (optional) |

> Export invoices typically use `tax_rate: 0` (Zero Rated) since exported goods are zero-rated for VAT.

---

### 4e. Deemed VAT Items _(NEW)_

Deemed VAT applies when a taxpayer is registered as a "deemed" supplier (e.g., Strategic Investors). Set `deemed_flag: "1"` on each deemed item. The middleware will:
- Append `" (deemed)"` to the item name per EFRIS spec
- Set `taxCategoryCode` to `"04"` (Deemed 18%) instead of `"01"` (Standard)
- Group these in a separate `"04"` tax detail line in the response

```json
{
  "invoice_number": "INV-DEEMED-001",
  "customer_name": "NSSF Uganda",
  "buyer_type": "3",
  "payment_method": "101",
  "items": [
    {
      "item": "Consulting Services",
      "itemCode": "SVC-CONSULT-01",
      "qty": "1",
      "unitPrice": "5000000.00",
      "total": "5000000.00",
      "taxRate": "0.18",
      "tax": "762711.86",
      "goodsCategoryId": "73110000",
      "deemed_flag": "1",
      "deemed_exempt_code": "101",
      "vat_project_id": "893997229738400343",
      "vat_project_name": "Strategic Investor Project"
    }
  ]
}
```

**Deemed fields per item:**

| Field | Alias | Required | Description |
|-------|-------|----------|-------------|
| `deemed_flag` | `deemedFlag` | Yes | `"1"` = Deemed, `"2"` = Not deemed (default) |
| `deemed_exempt_code` | `deemedExemptCode` | When deemed | See codes below |
| `vat_project_id` | `vatProjectId` | **Required when `deemed_flag=1`** | EFRIS project ID from URA |
| `vat_project_name` | `vatProjectName` | **Required when `deemed_flag=1`** | Project name |

**`deemed_exempt_code` values:**
| Code | Meaning |
|------|---------|
| `101` | Strategic Investor |
| `102` | Petroleum Licensee |
| `103` | Aid Funded Project Contractor |
| `104` | Government MDA |
| `105` | VAT & Excise Duty Exempt |
| `106` | Excise Duty Exempt |
| `107` | Mining Licensee |
| `108` | EACOP Licensee |
| `109` | EACOP Level 1 Contractor |

> ⚠️ **Omitting `vat_project_id` and `vat_project_name` on deemed items will cause EFRIS to reject the invoice.** These must come from the URA project registry.

---

### 4f. Remarks on Invoices

You can attach a remark (up to 500 characters) at the invoice level:

```json
{
  "invoice_number": "INV-2026-010",
  "customer_name": "Kampala Mart",
  "buyer_type": "0",
  "payment_method": "102",
  "remarks": "Payment due within 30 days. Reference PO-4455.",
  "items": [...]
}
```

The middleware passes this through to the EFRIS `summary.remarks` field. Your ERP system may send this even when using simple format — it is gracefully handled.

---

## 5. Credit Notes (T110)

Used to reverse or adjust an already-fiscalized invoice (returns, corrections, etc.).

**`POST /submit-credit-note`**
```json
{
  "original_invoice_number": "INV-2026-001",
  "original_fdn": "YBS2026051011223344",
  "reason": "Customer returned defective goods",
  "reason_code": "101",
  "items": [
    {
      "item_name": "Premium Water 500ml",
      "item_code": "SKU-BOTTLE-01",
      "quantity": 1,
      "unit_price": 24000,
      "tax_rate": 0.18
    }
  ]
}
```

**`reason_code`:**
| Code | Meaning |
|------|---------|
| `101` | Return of products |
| `102` | Cancellation of purchase |
| `103` | Invoice amount wrongly stated |
| `104` | Partial or complete waive off |
| `105` | Others (specify in `reason`) |

---

## 6. Data Lookups & Inquiries

### `GET /registration-details`
Returns taxpayer info, branch list, device details, and configuration. Use this to find valid `branchId` values for stock transfers.

### `GET /branches` _(NEW - T138)_
Returns all branches for the taxpayer using the EFRIS T138 interface.

**Example Response:**
```json
[
  {
    "branchId": "206637525568955296",
    "branchName": "Mr. STEPHEN BUNJO"
  },
  {
    "branchId": "206637528324276772",
    "branchName": "ARINAIT AND SONS CO. LIMITED"
  }
]
```

Use `branchId` values for stock transfers and branch-specific operations. Required for `POST /stock-transfer` source and destination branch IDs.

### `GET /excise-duty`
Returns all valid excise duty codes and rates from the EFRIS registry. Use this to lookup codes before product registration.

* **Query Parameters:**
  * `excise_name` (optional): Case-insensitive name filter (e.g., `beer`, `cement`)
  * `excise_code` (optional): Retrieve a specific code (e.g., `LED190100`)

* **Example Request:**
  `GET /excise-duty?excise_name=beer`

* **Example Response:**
  ```json
  {
    "success": true,
    "excise_codes": [
      {
        "code": "LED190100",
        "name": "Beer",
        "rate": "200.00",
        "unit": "Litre",
        "currency": "UGX",
        "excise_rule": "2" // 1=Percentage, 2=Fixed Unit
      }
    ],
    "total": 1,
    "last_updated": "2026-06-02T11:24:38"
  }
  ```

### `GET /goods`
Returns all registered products for this TIN.
- Search: `GET /goods?search=Water`
- Filter by code: `GET /goods?goods_code=SKU-BOTTLE-01`

### `GET /invoice/{invoice_number}`
Check fiscalization status and retrieve FDN/QR code.
- Use this to recover data if your ERP timed out during submission.

### `GET /invoices`
List recent invoices with pagination.

### `GET /commodity-categories`
Returns commodity classification codes for product registration.

### `GET /taxpayer/{tin}`
Look up a buyer's TIN to get their legal name for B2B invoices.

### `GET /units-of-measure`
Returns all valid unit codes (T115 rateUnit) — use for `unit_of_measure`, `piece_measure_unit`, `excise_unit`.

### `GET /server-time`
Returns the current EFRIS server timestamp. Useful for debugging clock-skew issues.

---

## 7. Implementation Tips for Developers

### Critical Rules
1. **Always Register First:** Never fiscalize a sale with a `goods_code` that hasn't been registered via T130.
2. **No Auto-Retry on Invoices (T109):** If you get a timeout, call `GET /invoice/{number}` first before retrying. Duplicate fiscalization = double tax.
3. **Stock Before Sale:** Ensure stock is increased before selling, or enable negative stock in URA portal settings.
4. **Packaging Fields:** If a product has `piece_scaled_value > 1` in T130 registration, you **must** send `package_scaled`, `piece_scaled`, and `piece_qty` in invoice items for correct URA stock decrements.

### Field Naming — Both Accepted Everywhere
The middleware accepts both `snake_case` and `camelCase` for every field. Examples:

| snake_case | camelCase |
|-----------|-----------|
| `invoice_number` | `invoiceNumber` |
| `customer_tin` | `customerTin` |
| `goods_code` | `goodsCode` |
| `source_branch_id` | `sourceBranchId` |
| `deemed_flag` | `deemedFlag` |
| `vat_project_id` | `vatProjectId` |
| `total_weight` | `totalWeight` |
| `hs_code` | `hsCode` |

### Invoice Type Quick Reference

| Invoice Type | `invoice_industry_code` | Extra fields needed |
|-------------|------------------------|-------------------|
| Normal sale | `101` (or omit) | None |
| Export goods | `102` | `customs` block, `delivery_terms_code`, per-item `total_weight`, `piece_qty`, `piece_measure_unit` |
| Export service | `112` | `delivery_terms_code` |
| Deemed VAT | `101` + `deemed_flag: "1"` per item | `vat_project_id`, `vat_project_name`, `deemed_exempt_code` per item |
| Excise duty | `101` + `excise_flag: "1"` per item | `category_id`, `excise_rule`, `excise_rate`, `excise_tax` per item |

---

## 8. Fiscal Invoice Display — Response Structure

When fiscalization succeeds (`success: true`), the API returns a complete response for rendering the fiscal invoice:

```json
{
  "success": true,
  "message": "Invoice fiscalized successfully",
  "seller": {
    "tin": "1014409555",
    "legal_name": "YOUR BUSINESS NAME",
    "trade_name": "Your Brand",
    "address": "Plot 1, Kampala Road, Kampala",
    "reference_number": "INV-2026-001",
    "served_by": "API User"
  },
  "fiscal_data": {
    "document_type": "Original",
    "fdn": "YBS2026...",
    "verification_code": "ABCD1234...",
    "device_number": "1014409555_02",
    "issued_date": "2026-05-30",
    "issued_time": "10:30:00",
    "qr_code": "https://..."
  },
  "buyer": {
    "name": "John Doe",
    "tin": "",
    "buyer_type": "1"
  },
  "items": [...],
  "tax_details": [
    {
      "taxCategoryCode": "01",
      "netAmount": "84746",
      "taxAmount": "15254",
      "grossAmount": "100000",
      "taxRateName": "Standard Rate (18%)"
    }
  ],
  "summary": {
    "net_amount": 84746,
    "tax_amount": 15254,
    "gross_amount": 100000,
    "gross_amount_words": "One Hundred Thousand Shillings Only",
    "payment_mode": "Cash",
    "number_of_items": 1,
    "mode": "Online",
    "remarks": ""
  }
}
```

### Tax Category Codes in Response

| `taxCategoryCode` | Letter | Meaning |
|-------------------|--------|---------|
| `01` | A | Standard VAT (18%) |
| `02` | B | Zero Rate (0%) |
| `03` | C | Exempt |
| `04` | D | Deemed VAT (18%) |
| `05` | E | Excise Duty |
| `11` | F | VAT Out of Scope |

---

## 9. Invoice Display Layout — 6 URA Sections

Render in this order (scrollable, single-column):

```
┌───────────────────────────────────────────┐
│  EFRIS     e-INVOICE/TAX INVOICE     1/1  │  ← Blue header
├───────────────────────────────────────────┤
│ SECTION A: Seller Details                 │
│   TIN · Legal Name · Address · Reference  │
├───────────────────────────────────────────┤
│ SECTION B: URA / Fiscal Information       │
│   FDN (bold, blue) · Verification Code    │
│   Issued Date · Time · Device No.         │
├───────────────────────────────────────────┤
│ SECTION C: Buyer Details                  │
│   Name · TIN (if B2B)                     │
├───────────────────────────────────────────┤
│ SECTION D: Goods & Services               │
│   Table: No | Item | Qty | Price | Tax    │
├───────────────────────────────────────────┤
│ SECTION E: Tax Summary                    │
│   Table: Category | Net | Tax | Gross     │
├───────────────────────────────────────────┤
│ SECTION F: Invoice Summary                │
│   Net · Tax · Gross (bold) · Amount words │
│   Payment mode · Remarks                  │
├───────────────────────────────────────────┤
│  *** END OF e-INVOICE/TAX INVOICE ***     │  ← Blue footer
├───────────────────────────────────────────┤
│  [QR CODE]  — Scan to verify on URA       │
└───────────────────────────────────────────┘
```

### Dart/Flutter Field Extraction

```dart
// Use fallback chains — field locations can vary by response version
final response = fullEfrisResponse;

// FDN
final fdn = response['fdn']
  ?? response['fiscal_data']?['fdn']
  ?? response['fiscal_data']?['fiscalDocumentNumber']
  ?? '';

// Verification Code
final verificationCode = response['verification_code']
  ?? response['fiscal_data']?['verification_code']
  ?? response['fiscal_data']?['verificationCode']
  ?? '';

// QR Code
final qrCode = response['qr_code']
  ?? response['fiscal_data']?['qr_code']
  ?? response['fiscal_data']?['qrCode']
  ?? '';

// Seller
final seller = response['seller'] ?? {};
final tin         = seller['tin'] ?? 'N/A';
final legalName   = (seller['legal_name'] ?? 'N/A').toUpperCase();
final tradeName   = (seller['trade_name'] ?? seller['legal_name'] ?? 'N/A').toUpperCase();
final reference   = seller['reference_number'] ?? response['invoice_number'] ?? 'N/A';

// Summary
final summary = response['summary'] ?? {};
final netAmount   = summary['net_amount'] ?? summary['netAmount'] ?? '0';
final taxAmount   = summary['tax_amount'] ?? summary['taxAmount'] ?? '0';
final grossAmount = summary['gross_amount'] ?? summary['grossAmount'] ?? '0';
final remarks     = summary['remarks'] ?? response['notes'] ?? '';

// Tax category letter helper
String getCategoryLabel(String code) {
  const labels = {
    '01': 'A-Standard (18%)',
    '02': 'B-Zero Rate (0%)',
    '03': 'C-Exempt',
    '04': 'D-Deemed (18%)',
    '05': 'E-Excise Duty',
    '11': 'F-Out of Scope',
  };
  return labels[code] ?? 'Tax Category $code';
}
```

---

## 10. Re-Opening a Previously Fiscalized Invoice

When a user opens an already-fiscalized invoice, fetch the invoice detail which includes `eInvoiceResponse` (the full response). Pass it to the same fiscal invoice display screen.

```
GET /api/orgs/{orgSlug}/invoices/{id}
Response includes: { efrisFDN, efrisVerificationCode, efrisQRCode, eInvoiceResponse }
Use eInvoiceResponse as fullEfrisResponse.
```

Also cache the full response locally (SharedPreferences / SQLite) keyed by `invoiceId` so users can re-open without re-fetching.

---

## 11. Visual Styling Reference

| Element | Style |
|---------|-------|
| Header / Footer bars | Blue gradient (`#2563EB → #1D4ED8`), white bold text |
| Section header rows | Light grey background (`#F3F4F6`), small bold text |
| FDN value | Bold, blue (`#1D4ED8`), 14–16sp — give it visual prominence |
| Verification Code | Monospace font, 11–12sp |
| Legal / Trade Name | ALL CAPS |
| Gross Amount | Bold, 14sp |
| Amount in words | Italic, grey (`#6B7280`) |
| Section dividers | 1px grey border (`#D1D5DB`) |

---

*Last updated: May 2026 — covers T109 (Standard, Export, Deemed VAT, Excise, Discounts, Remarks), T110 (Credit Notes), T130 (Product Registration), T131 (Stock Increase/Decrease), T139 (Stock Transfer).*
