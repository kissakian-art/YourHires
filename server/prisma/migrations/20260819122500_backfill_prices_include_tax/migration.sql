-- Existing catalogue rates were entered before tax existed in the system, so
-- they are what the customer actually pays. Treat them as tax-inclusive, which
-- keeps every existing quote, order and ledger figure unchanged once a company
-- configures VAT.
UPDATE `companies` SET `prices_include_tax` = true;
