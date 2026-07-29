/*
  Warnings:

  - Added the required column `company_id` to the `audit_logs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `audit_logs` ADD COLUMN `company_id` INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
