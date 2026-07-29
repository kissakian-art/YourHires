-- AlterTable
ALTER TABLE `invoices` ADD COLUMN `payment_date` DATETIME(3) NULL,
    ADD COLUMN `payment_method` VARCHAR(50) NULL,
    ADD COLUMN `payment_notes` VARCHAR(255) NULL;
