-- Follow-up to 20261127100000_billing_integrity, kept separate so installations
-- that already applied that migration also receive this correction.
--
-- billing_integrity moved partial credits out of amount_paid into
-- amount_credited but left status untouched, so e.g. a partly credited invoice
-- could still read 'Unpaid'. Re-derive status from the figures, using the same
-- rule as deriveInvoiceStatus() in src/invoice-service.ts.
--
-- OPEN invoices only. Paid/Credited rows are left alone: invoices settled
-- before amount_paid existed carry amount_paid = 0 and must not be reopened.
-- Idempotent: running it again changes nothing.
UPDATE `invoices`
SET `status` = CASE
    WHEN `amount` > 0 AND `amount` - `amount_paid` - `amount_credited` <= 0.005
      THEN IF(`amount_paid` > 0.005, 'Paid', 'Credited')
    WHEN `amount_paid` + `amount_credited` > 0.005 THEN 'Part Paid'
    ELSE 'Unpaid' END
WHERE `status` IN ('Unpaid', 'Part Paid');
