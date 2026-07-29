/*
  Warnings:

  - Added the required column `customer_name` to the `bookings` table without a default value. This is not possible if the table is not empty.
  - Added the required column `customer_name` to the `rental_orders` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `bookings` ADD COLUMN `customer_name` VARCHAR(255) NOT NULL;

-- AlterTable
ALTER TABLE `rental_orders` ADD COLUMN `customer_name` VARCHAR(255) NOT NULL,
    ADD COLUMN `estimated_total` DECIMAL(10, 2) NOT NULL DEFAULT 0.00;
