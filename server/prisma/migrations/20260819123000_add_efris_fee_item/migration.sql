-- AlterTable
ALTER TABLE `companies` ADD COLUMN `efris_fee_commodity_code` VARCHAR(50) NULL,
    ADD COLUMN `efris_fee_item_code` VARCHAR(50) NOT NULL DEFAULT 'SERVICE-CHARGE',
    ADD COLUMN `efris_fee_item_name` VARCHAR(255) NOT NULL DEFAULT 'Service Charges & Penalties',
    ADD COLUMN `efris_fee_registered_at` DATETIME(3) NULL;

