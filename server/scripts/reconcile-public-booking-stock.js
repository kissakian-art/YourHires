#!/usr/bin/env node
// Reconcile stock for rental orders dispatched from PUBLIC bookings before the
// discriminator fix (migration 20261127100000_billing_integrity).
//
// Background: public bookings stored line type 'Item' (capital I). Dispatch and
// return only move bulk stock for 'item', so for those orders:
//   • dispatch never deducted the rented units, and
//   • the return never added good units back.
// Net effect per line: on-hand stock is overstated by the units that should
// still be out or were written off — rentedQty − returnedQty when returns are
// restocked (company setting), or rentedQty when they are not.
//
// The migration normalised BOOKING lines only. RENTAL lines from those orders
// keep 'Item' until this script runs, so a later return can't double-count.
//
// Usage (from server/, with DATABASE_URL set):
//   node scripts/reconcile-public-booking-stock.js            # report only (default)
//   node scripts/reconcile-public-booking-stock.js --json     # report as JSON
//   node scripts/reconcile-public-booking-stock.js --apply    # apply after review
//
// --apply runs in one transaction: for each affected line it decrements the
// item's stock by the proposed correction (never below zero; any shortfall is
// reported), sets the line type to 'item', and writes an audit-log entry.
// Review the report with someone who has checked the physical count first.

const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');
const prisma = new PrismaClient();

async function findAffected(db) {
  // BINARY: MySQL's default collation would also match 'item'.
  const rows = await db.$queryRaw`
    SELECT rli.id AS lineId, rli.order_id AS orderId, rli.item_id AS itemId,
           rli.rented_qty AS rentedQty, rli.returned_qty AS returnedQty,
           rli.damaged_qty AS damagedQty, rli.lost_qty AS lostQty,
           ro.company_id AS companyId, ro.company_order_number AS orderNumber,
           ro.status AS orderStatus, ro.customer_name AS customerName,
           i.name AS itemName, i.current_stock AS currentStock,
           c.restock_returned_items AS restock
      FROM rental_line_items rli
      JOIN rental_orders ro ON ro.id = rli.order_id
      JOIN companies c      ON c.id = ro.company_id
      LEFT JOIN items i     ON i.id = rli.item_id
     WHERE BINARY rli.item_type = 'Item'
     ORDER BY ro.company_id, ro.id, rli.id`;
  return rows.map(r => {
    const rented = Number(r.rentedQty), returned = Number(r.returnedQty);
    const correction = r.restock ? rented - returned : rented;
    return {
      ...r,
      lineId: Number(r.lineId), orderId: Number(r.orderId), itemId: r.itemId == null ? null : Number(r.itemId),
      companyId: Number(r.companyId), rentedQty: rented, returnedQty: returned,
      damagedQty: Number(r.damagedQty), lostQty: Number(r.lostQty),
      currentStock: r.currentStock == null ? null : Number(r.currentStock),
      restock: !!r.restock,
      outstanding: rented - returned - Number(r.damagedQty) - Number(r.lostQty),
      proposedStockCorrection: -Math.max(0, correction),
    };
  });
}

function printReport(rows) {
  if (rows.length === 0) { console.log('No affected rental lines. Nothing to reconcile.'); return; }
  console.log(`${rows.length} rental line(s) from public bookings never moved stock:\n`);
  console.log(['company', 'order', 'status', 'item', 'rented', 'returned', 'damaged', 'lost', 'stock now', 'correction'].join('\t'));
  for (const r of rows) {
    console.log([r.companyId, r.orderNumber, r.orderStatus, r.itemName ?? `(item ${r.itemId} missing)`,
      r.rentedQty, r.returnedQty, r.damagedQty, r.lostQty, r.currentStock ?? '-', r.proposedStockCorrection].join('\t'));
  }
  const byItem = new Map();
  for (const r of rows) if (r.itemId != null) byItem.set(r.itemId, (byItem.get(r.itemId) || 0) + r.proposedStockCorrection);
  console.log('\nNet proposed correction per item:');
  for (const [itemId, delta] of byItem) {
    const r = rows.find(x => x.itemId === itemId);
    console.log(`  item ${itemId} (${r.itemName}, company ${r.companyId}): ${r.currentStock} → ${r.currentStock + delta} (${delta})`);
  }
  console.log('\nCorrections assume each company\'s CURRENT "restock returned items" setting applied at the time.');
  console.log('Compare against a physical count before running with --apply.');
}

async function main() {
  const rows = await findAffected(prisma);
  if (JSON_OUT) console.log(JSON.stringify(rows, null, 2)); else printReport(rows);
  if (!APPLY || rows.length === 0) return;

  const shortfalls = [];
  await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      if (r.itemId != null && r.proposedStockCorrection < 0) {
        const item = await tx.item.findUnique({ where: { id: r.itemId } });
        const take = Math.min(item.currentStock, -r.proposedStockCorrection);
        if (take < -r.proposedStockCorrection) shortfalls.push({ ...r, applied: -take });
        if (take > 0) await tx.item.update({ where: { id: r.itemId }, data: { currentStock: { decrement: take } } });
      }
      // From now on returns of this line move stock like any other hire line.
      await tx.rentalLineItem.update({ where: { id: r.lineId }, data: { itemType: 'item' } });
      await tx.auditLog.create({
        data: {
          companyId: r.companyId, username: 'system', action: 'STOCK_RECONCILED', modelName: 'RentalLineItem',
          objectId: r.lineId, objectRepr: r.orderNumber,
          additionalInfo: `Public-booking stock reconciliation: ${r.itemName ?? 'item'} stock ${r.proposedStockCorrection} (rented ${r.rentedQty}, returned ${r.returnedQty}); line type normalised.`,
        },
      });
    }
  }, { timeout: 120000 });
  console.log(`\nApplied to ${rows.length} line(s).`);
  for (const s of shortfalls) {
    console.log(`  WARNING: ${s.itemName} (order ${s.orderNumber}) needed ${s.proposedStockCorrection} but stock only allowed ${s.applied}. Check the physical count.`);
  }
}

main()
  .catch((e) => { console.error('Reconciliation failed; nothing was changed:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
