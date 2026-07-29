/*
  Warnings:

  - Added the required column `company_id` to the `credit_notes` table without a default value. This is not possible if the table is not empty.
  - Added the required column `company_id` to the `invoices` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `credit_notes` ADD COLUMN `company_id` INTEGER NOT NULL;

-- AlterTable
ALTER TABLE `invoices` ADD COLUMN `company_id` INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_notes` ADD CONSTRAINT `credit_notes_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
