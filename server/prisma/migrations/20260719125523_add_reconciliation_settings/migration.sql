-- AlterTable
ALTER TABLE `companies` ADD COLUMN `damage_fee_percent` DECIMAL(6, 2) NOT NULL DEFAULT 50.00,
    ADD COLUMN `default_payment_terms_days` INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN `late_fee_percent_per_day` DECIMAL(6, 2) NOT NULL DEFAULT 10.00,
    ADD COLUMN `lost_fee_percent` DECIMAL(6, 2) NOT NULL DEFAULT 100.00,
    ADD COLUMN `restock_returned_items` BOOLEAN NOT NULL DEFAULT true;

