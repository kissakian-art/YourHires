// Acceptance checks for PROJECT_REVIEW.md findings (tenant isolation, backups,
// deposits/dispatch, payments, aging, credit notes, returns, public bookings).
// Run against a DISPOSABLE database started with demo data and a platform admin:
//   SEED_DEMO_DATA=true SEED_DEMO_PASSWORD=Demo-pass-123 \
//   PLATFORM_ADMIN_USER=platformops PLATFORM_ADMIN_PASSWORD=Very-long-setup-pass-1 node dist/server.js
// then: node scripts/e2e-acceptance.mjs   (it creates and mutates records)
const API = 'http://localhost:20090';
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };

async function call(tok, method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', ...(tok ? { 'x-session-token': tok } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
async function login(u, p) {
  const r = await call(null, 'POST', '/api/auth/login', { username: u, password: p });
  if (r.status !== 200) throw new Error(`login ${u} failed ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
const day = (n) => new Date(Date.now() + n * 864e5).toISOString();

// Credentials (override for a copy of an existing database).
const DEMO_PW = process.env.E2E_DEMO_PASSWORD || 'Demo-pass-123';
const OPS_USER = process.env.E2E_PLATFORM_USER || 'platformops';
const OPS_PW = process.env.E2E_PLATFORM_PASSWORD || 'Very-long-setup-pass-1';
const mega = (await login('admin', DEMO_PW)).sessionToken;
const kla = (await login('kampala_admin', DEMO_PW)).sessionToken;
// Catalog IDs differ between databases; resolve the demo items by name.
const catalog = (await call(mega, 'GET', '/api/items')).data;
const idOf = (prefix) => { const i = catalog.find(x => x.name.startsWith(prefix)); if (!i) throw new Error(`demo item "${prefix}" missing`); return i.id; };
const CHAIR = idOf('Executive Plastic'), TENT = idOf('Double Pyramidal Tent'), BANQUET = idOf('Banquet');
const BANQUET_REPLACEMENT = Number(catalog.find(x => x.id === BANQUET).unitReplacementCost);
const companySettings = (await call(mega, 'GET', '/api/companies')).data[0];
const klaCompanyId = (await call(kla, 'GET', '/api/companies')).data[0].id;

console.log('C1 tenant ownership');
{
  const megaBookings = (await call(mega, 'GET', '/api/bookings')).data;
  const kBookings = await call(kla, 'GET', '/api/bookings', null, { 'x-company-id': '1' });
  ok(Array.isArray(kBookings.data) && kBookings.data.every(b => b.companyId === klaCompanyId), 'spoofed x-company-id header is ignored', kBookings.data?.slice?.(0, 1));
  const target = megaBookings[0];
  ok((await call(kla, 'POST', `/api/bookings/${target.id}/dispatch`)).status === 404, 'other tenant cannot dispatch a booking by ID');
  ok((await call(kla, 'POST', `/api/bookings/${target.id}/confirm-deposit`)).status === 404, 'other tenant cannot confirm a booking');
  const megaInv = (await call(mega, 'GET', '/api/invoices')).data;
  ok((await call(kla, 'POST', `/api/invoices/${megaInv[0].id}/pay`, { paymentMethod: 'Cash', paymentDate: day(0), amount: 1 })).status === 404, 'other tenant cannot pay an invoice');
  ok((await call(kla, 'GET', `/api/invoices/${megaInv[0].id}/pdf`)).status === 404, 'other tenant cannot download invoice PDF');
  const c = await call(kla, 'POST', '/api/customers', { companyId: 1, name: 'Spoof Test Customer' });
  ok(c.status === 201 && c.data.companyId === 2, 'body companyId is overridden by session tenant', c.data);
  const cross = await call(kla, 'POST', '/api/bookings', { customerName: 'X', bookingType: 'pickup', scheduledPickupDate: day(1), scheduledReturnDate: day(2), lineItems: [{ itemType: 'item', itemId: CHAIR, quantity: 1 }] });
  ok(cross.status === 400, 'cannot book another company\'s catalog item', cross);
  const comp = (await call(kla, 'GET', '/api/companies')).data;
  ok(comp.length === 1 && comp[0].id === klaCompanyId, '/api/companies returns only own company');
  ok((await call(kla, 'PATCH', '/api/companies/1/settings', { lateFeePercentPerDay: 99 })).status === 404, 'cannot change another company\'s settings');
  ok((await call(null, 'GET', '/api/bookings')).status === 401, 'no session → 401');
  // Every accepted line is ownership-checked: a foreign item hidden after
  // position 500 must not slip through, and oversize submissions are refused.
  const own = Array.from({ length: 500 }, () => ({ itemType: 'item', itemId: TENT, quantity: 1 }));
  const big = await call(mega, 'POST', '/api/bookings', { customerName: 'Big', bookingType: 'pickup', scheduledPickupDate: day(1), scheduledReturnDate: day(2), lineItems: [...own, { itemType: 'item', itemId: 999999, quantity: 1 }] });
  ok(big.status === 413, 'more than 500 lines is rejected (413)', big);
  const kItem = (await call(kla, 'POST', '/api/items', { name: 'Kampala Only Item', category: 'x', currentStock: 5 })).data;
  const hidden = Array.from({ length: 499 }, () => ({ itemType: 'item', itemId: TENT, quantity: 1 }));
  const sneak = await call(mega, 'POST', '/api/bookings', { customerName: 'Sneak', bookingType: 'pickup', scheduledPickupDate: day(1), scheduledReturnDate: day(2), lineItems: [...hidden, { itemType: 'item', itemId: kItem.id, quantity: 1 }] });
  ok(sneak.status === 400 && /does not belong/.test(sneak.data?.error || ''), 'foreign item at line 500 is caught', sneak);
  const pub = await call(null, 'POST', '/api/public/kampala-events/bookings', { customerName: 'Pub', lineItems: [{ itemId: CHAIR, quantity: 1 }] });
  ok(pub.status === 400, 'public storefront cannot book another company\'s item', pub);
}

console.log('C2 backups');
{
  ok((await call(mega, 'GET', '/api/backup/config')).status === 403, 'tenant admin cannot list backups (hosted)');
  ok((await call(mega, 'POST', '/api/backup/run')).status === 403, 'tenant admin cannot run backups');
  ok((await call(mega, 'POST', '/api/backup/restore', { name: 'x', confirm: 'RESTORE' })).status === 403, 'tenant admin cannot restore');
  const ops = await login(OPS_USER, OPS_PW);
  const cfg = await call(ops.sessionToken, 'GET', '/api/backup/config');
  ok(cfg.status === 200, 'platform operator can list backups', cfg);
  ok((await call(ops.sessionToken, 'GET', '/api/bookings')).status === 403, 'platform operator session has no tenant data access');
  ok((await call(mega, 'PATCH', '/api/system/components/1/status', { status: 'degraded' })).status === 403, 'tenant cannot change installation status board');
}

console.log('Booking with deposit → dispatch (finding 1/3)');
const stockBefore = (await call(mega, 'GET', '/api/items')).data.find(i => i.id === CHAIR).currentStock;
const incomeCount = async () => (await call(mega, 'GET', '/api/income')).data?.records?.length ?? (await call(mega, 'GET', '/api/income')).data?.length;
const inc0 = await incomeCount();
const b1 = await call(mega, 'POST', '/api/bookings', { customerName: 'E2E Customer', contactInfo: 'x', bookingType: 'pickup', scheduledPickupDate: day(0), scheduledReturnDate: day(1), depositAmount: 1000, lineItems: [{ itemType: 'item', itemId: CHAIR, quantity: 4 }] });
ok(b1.status === 201 && b1.data.status === 'confirmed' && b1.data.depositPaid, 'paid-at-creation booking is confirmed', b1.data);
const conf = await call(mega, 'POST', `/api/bookings/${b1.data.id}/confirm-deposit`);
ok(conf.status === 200, 'confirm on confirmed booking is an idempotent no-op');
ok((await incomeCount()) === inc0 + 1, 'exactly one income entry for the deposit', { inc0, now: await incomeCount() });
const [d1, d2] = await Promise.all([call(mega, 'POST', `/api/bookings/${b1.data.id}/dispatch`), call(mega, 'POST', `/api/bookings/${b1.data.id}/dispatch`)]);
const codes = [d1.status, d2.status].sort();
ok(codes[0] === 201 && codes[1] === 409, 'two simultaneous dispatches → one order', codes);
const order = (d1.status === 201 ? d1 : d2).data;
const stockAfter = (await call(mega, 'GET', '/api/items')).data.find(i => i.id === CHAIR).currentStock;
ok(stockBefore - stockAfter === 4, 'stock moved once (4 units)', { stockBefore, stockAfter });
const invs = (await call(mega, 'GET', '/api/invoices')).data.filter(i => i.rentalOrderId === order.id);
ok(invs.length === 1, 'exactly one invoice for the order', invs.length);
const inv = invs[0];
ok(Math.abs(Number(inv.amountPaid) - 1000) < 0.01, 'deposit recorded against invoice', inv.amountPaid);

console.log('Payments (finding 5) and aging (finding 6)');
const face = Number(inv.amount);
const bal0 = inv.balanceDue;
const [p1, p2] = await Promise.all([
  call(mega, 'POST', `/api/invoices/${inv.id}/pay`, { paymentMethod: 'Cash', paymentDate: day(0), amount: 300, paymentKey: 'e2e-key-aaaaaaaa' }),
  call(mega, 'POST', `/api/invoices/${inv.id}/pay`, { paymentMethod: 'Cash', paymentDate: day(0), amount: 300, paymentKey: 'e2e-key-bbbbbbbb' }),
]);
ok(p1.status === 200 && p2.status === 200, 'two distinct concurrent payments both post', [p1, p2]);
const replay = await call(mega, 'POST', `/api/invoices/${inv.id}/pay`, { paymentMethod: 'Cash', paymentDate: day(0), amount: 300, paymentKey: 'e2e-key-aaaaaaaa' });
ok(replay.status === 200 && replay.data.replayed, 'replayed payment is recognised', replay.data);
const invNow = (await call(mega, 'GET', '/api/invoices')).data.find(i => i.id === inv.id);
ok(Math.abs(invNow.balanceDue - (bal0 - 600)) < 0.01 && invNow.status === 'Part Paid', 'balance reduced by exactly 600 and status Part Paid', { bal0, now: invNow.balanceDue, st: invNow.status });
const over = await call(mega, 'POST', `/api/invoices/${inv.id}/pay`, { paymentMethod: 'Cash', paymentDate: day(0), amount: invNow.balanceDue + 1, paymentKey: 'e2e-key-cccccccc' });
ok(over.status === 400, 'over-payment rejected');
const aging = (await call(mega, 'GET', '/api/reports/invoice-aging')).data;
const allOpen = (await call(mega, 'GET', '/api/invoices')).data.filter(i => ['Unpaid', 'Part Paid'].includes(i.status)).reduce((s, i) => s + i.balanceDue, 0);
ok(Math.abs(aging.totalUnpaid - allOpen) < 0.01, 'aging total = sum of collectible balances (part-paid included)', { aging: aging.totalUnpaid, allOpen });
const dash = (await call(mega, 'GET', '/api/reports/dashboard-stats')).data;
ok(Math.abs(dash.outstandingInvoices - allOpen) < 0.01, 'dashboard outstanding agrees with aging', { dash: dash.outstandingInvoices, allOpen });

console.log('Credit notes (finding 7)');
{
  const b = await call(mega, 'POST', '/api/bookings', { customerName: 'E2E Credit', bookingType: 'pickup', scheduledPickupDate: day(0), scheduledReturnDate: day(1), lineItems: [{ itemType: 'item', itemId: BANQUET, quantity: 1 }] });
  await call(mega, 'POST', `/api/bookings/${b.data.id}/confirm-deposit`);
  const o = await call(mega, 'POST', `/api/bookings/${b.data.id}/dispatch`);
  const ci = (await call(mega, 'GET', '/api/invoices')).data.find(i => i.rentalOrderId === o.data.id);
  const cn = await call(mega, 'POST', `/api/invoices/${ci.id}/credit-memo`, { reason: 'test' });
  ok(cn.status === 201, 'full credit note issued', cn.data);
  const after = (await call(mega, 'GET', '/api/invoices')).data.find(i => i.id === ci.id);
  ok(after.balanceDue === 0 && after.status === 'Credited' && Number(after.amountPaid) === 0, 'fully credited invoice: 0 due, no cash recorded', after);
  const pay = await call(mega, 'POST', `/api/invoices/${ci.id}/pay`, { paymentMethod: 'Cash', paymentDate: day(0) });
  ok(pay.status === 400, 'payment rejected on fully credited invoice', pay.data);
  const again = await call(mega, 'POST', `/api/invoices/${ci.id}/credit-memo`, { reason: 'again' });
  ok(again.status === 400, 'cannot credit beyond invoice value', again.data);
}

console.log('Returns (finding 4)');
{
  const b = await call(mega, 'POST', '/api/bookings', { customerName: 'E2E Return', bookingType: 'pickup', scheduledPickupDate: day(0), scheduledReturnDate: day(5), lineItems: [{ itemType: 'item', itemId: BANQUET, quantity: 10 }] });
  await call(mega, 'POST', `/api/bookings/${b.data.id}/confirm-deposit`);
  const o = (await call(mega, 'POST', `/api/bookings/${b.data.id}/dispatch`)).data;
  const orderFull = (await call(mega, 'GET', '/api/rental-orders')).data.find(x => x.id === o.id);
  const line = orderFull.lineItems[0];
  const r1 = await call(mega, 'POST', `/api/rental-orders/${o.id}/return`, { lines: [{ lineItemId: line.id, returnedQty: 2, damagedQty: 2, lostQty: 0 }] });
  const r2 = await call(mega, 'POST', `/api/rental-orders/${o.id}/return`, { lines: [{ lineItemId: line.id, returnedQty: 2, damagedQty: 1, lostQty: 0 }] });
  const r3 = await call(mega, 'POST', `/api/rental-orders/${o.id}/return`, { lines: [{ lineItemId: line.id, returnedQty: 3, damagedQty: 0, lostQty: 0 }] });
  const unit = BANQUET_REPLACEMENT * Number(companySettings.damageFeePercent) / 100;
  ok(r1.status === 200 && r2.status === 200 && r3.status === 200, 'three partial returns accepted', [r1.status, r2.status, r3.status, r1.data?.error, r3.data?.error]);
  ok(Math.round(r3.data.totalReplacementFeeCalculated) === Math.round(unit * 3) && r3.data.status === 'Returned', 'later clean return preserves cumulative damage total', r3.data);
  const dmg = (await call(mega, 'GET', '/api/invoices')).data.filter(i => i.rentalOrderId === o.id && i.invoiceType === 'PENALTY');
  const dmgSum = dmg.reduce((s, i) => s + Number(i.amount), 0);
  ok(Math.round(dmgSum) === Math.round(unit * 3) && dmg.length === 2, 'two damage invoices summing to the total', dmg.map(i => [i.referenceNumber, i.amount]));
}

console.log('Public booking discriminator (finding 2)');
{
  const s0 = (await call(mega, 'GET', '/api/items')).data.find(i => i.id === TENT).currentStock;
  const pb = await call(null, 'POST', '/api/public/mega-rentals/bookings', { customerName: 'Public Person', contactInfo: 'p', scheduledPickupDate: day(0), scheduledReturnDate: day(1), lineItems: [{ itemId: TENT, quantity: 3 }] });
  ok(pb.status === 200, 'public booking created', pb.data);
  await call(mega, 'POST', `/api/bookings/${pb.data.id}/confirm-deposit`);
  const o = (await call(mega, 'POST', `/api/bookings/${pb.data.id}/dispatch`)).data;
  const s1 = (await call(mega, 'GET', '/api/items')).data.find(i => i.id === TENT).currentStock;
  await call(mega, 'POST', `/api/rental-orders/${o.id}/return`, {});
  const s2 = (await call(mega, 'GET', '/api/items')).data.find(i => i.id === TENT).currentStock;
  ok(s0 - s1 === 3 && s2 === s0, 'public booking: 3 out, 3 back', { s0, s1, s2 });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
