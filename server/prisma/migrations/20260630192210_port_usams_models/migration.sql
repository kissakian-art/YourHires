/*
  Warnings:

  - You are about to drop the `healthcheck` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
-- The init migration created this table as `HealthCheck`. Drop it under that
-- exact name: on Linux MariaDB/MySQL table names are case-sensitive (default
-- lower_case_table_names=0), so `healthcheck` didn't exist and fresh installs
-- failed here. On Windows (case-insensitive) both names are the same table.
DROP TABLE IF EXISTS `HealthCheck`;

-- CreateTable
CREATE TABLE `subscription_plans` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `plan_type` VARCHAR(20) NOT NULL DEFAULT 'free',
    `price_monthly` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `max_users` INTEGER NULL,
    `max_items` INTEGER NULL,
    `features` JSON NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `subscription_plans_plan_type_key`(`plan_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `companies` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NULL,
    `phone` VARCHAR(50) NULL,
    `address` TEXT NULL,
    `logo` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `plan_id` INTEGER NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'USD',
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `payment_approval_status` VARCHAR(50) NOT NULL DEFAULT 'approved',
    `public_slug` VARCHAR(255) NOT NULL,
    `public_bookings_enabled` BOOLEAN NOT NULL DEFAULT true,
    `booking_expiration_hours` INTEGER NOT NULL DEFAULT 24,

    UNIQUE INDEX `companies_public_slug_key`(`public_slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(150) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `password` VARCHAR(128) NOT NULL,
    `first_name` VARCHAR(150) NULL,
    `last_name` VARCHAR(150) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `is_superuser` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `users_username_key`(`username`),
    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_profiles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `company_id` INTEGER NULL,

    UNIQUE INDEX `user_profiles_user_id_key`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `contact_info` TEXT NOT NULL,
    `is_on_watch_list` BOOLEAN NOT NULL DEFAULT false,
    `watch_list_reason` TEXT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `category` VARCHAR(100) NOT NULL,
    `unit_of_measure` VARCHAR(20) NOT NULL DEFAULT 'piece',
    `unit_cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `unit_replacement_cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `daily_rental_rate` DECIMAL(10, 2) NOT NULL,
    `current_stock` INTEGER NOT NULL DEFAULT 0,
    `low_stock_threshold` INTEGER NOT NULL DEFAULT 5,
    `image` VARCHAR(255) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `serialized_assets` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `asset_type` VARCHAR(100) NOT NULL,
    `serial_number` VARCHAR(100) NOT NULL,
    `cost_price` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `daily_rental_rate` DECIMAL(10, 2) NOT NULL,
    `replacement_cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `status` VARCHAR(50) NOT NULL DEFAULT 'Available',
    `image` VARCHAR(255) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bookings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `customer_id` INTEGER NULL,
    `booking_type` VARCHAR(20) NOT NULL,
    `booking_date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `scheduled_pickup_date` DATETIME(3) NULL,
    `scheduled_return_date` DATETIME(3) NULL,
    `rental_start_date` DATETIME(3) NULL,
    `rental_end_date` DATETIME(3) NULL,
    `estimated_total_cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `deposit_amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `deposit_paid` BOOLEAN NOT NULL DEFAULT false,
    `deposit_paid_date` DATETIME(3) NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'USD',
    `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
    `booking_number` VARCHAR(100) NOT NULL,
    `converted_rental_order_id` INTEGER NULL,
    `notes` TEXT NULL,
    `customer_notes` TEXT NULL,
    `cancellation_reason` TEXT NULL,
    `cancelled_at` DATETIME(3) NULL,

    UNIQUE INDEX `bookings_booking_number_key`(`booking_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking_line_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `booking_id` INTEGER NOT NULL,
    `item_type` VARCHAR(20) NOT NULL,
    `item_id` INTEGER NULL,
    `asset_id` INTEGER NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `daily_rate_at_booking` DECIMAL(10, 2) NOT NULL,
    `estimated_rental_days` INTEGER NOT NULL,
    `estimated_line_total` DECIMAL(10, 2) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rental_orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `customer_id` INTEGER NOT NULL,
    `checkout_date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expected_return_date` DATETIME(3) NOT NULL,
    `actual_return_date` DATETIME(3) NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'Active',
    `company_order_number` VARCHAR(100) NOT NULL,
    `is_finalized` BOOLEAN NOT NULL DEFAULT false,
    `is_fully_reconciled` BOOLEAN NOT NULL DEFAULT false,
    `total_late_fee_calculated` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `total_replacement_fee_calculated` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `total_amount_paid` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rental_line_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `item_type` VARCHAR(20) NOT NULL,
    `item_id` INTEGER NULL,
    `asset_id` INTEGER NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `daily_rate` DECIMAL(10, 2) NOT NULL,
    `rented_qty` INTEGER NOT NULL DEFAULT 0,
    `returned_qty` INTEGER NOT NULL DEFAULT 0,
    `damaged_qty` INTEGER NOT NULL DEFAULT 0,
    `lost_qty` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customer_id` INTEGER NOT NULL,
    `credit_limit` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `total_outstanding` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `total_overdue` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `current_balance` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `balance_31_60` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `balance_61_90` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `balance_over_90` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `payment_terms_days` INTEGER NOT NULL DEFAULT 30,

    UNIQUE INDEX `customer_accounts_customer_id_key`(`customer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_account_transactions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `account_id` INTEGER NOT NULL,
    `transaction_type` VARCHAR(50) NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `balance_after_transaction` DECIMAL(10, 2) NOT NULL,
    `description` TEXT NOT NULL,
    `due_date` DATETIME(3) NULL,
    `reference_number` VARCHAR(100) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(150) NOT NULL,
    `action` VARCHAR(50) NOT NULL,
    `model_name` VARCHAR(100) NOT NULL,
    `object_id` INTEGER NULL,
    `object_repr` VARCHAR(255) NOT NULL,
    `changes` JSON NULL,
    `additional_info` TEXT NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `companies` ADD CONSTRAINT `companies_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `subscription_plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_profiles` ADD CONSTRAINT `user_profiles_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_profiles` ADD CONSTRAINT `user_profiles_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customers` ADD CONSTRAINT `customers_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `serialized_assets` ADD CONSTRAINT `serialized_assets_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_converted_rental_order_id_fkey` FOREIGN KEY (`converted_rental_order_id`) REFERENCES `rental_orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `booking_line_items` ADD CONSTRAINT `booking_line_items_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `booking_line_items` ADD CONSTRAINT `booking_line_items_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `booking_line_items` ADD CONSTRAINT `booking_line_items_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `serialized_assets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rental_orders` ADD CONSTRAINT `rental_orders_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rental_orders` ADD CONSTRAINT `rental_orders_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rental_line_items` ADD CONSTRAINT `rental_line_items_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `rental_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rental_line_items` ADD CONSTRAINT `rental_line_items_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rental_line_items` ADD CONSTRAINT `rental_line_items_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `serialized_assets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_accounts` ADD CONSTRAINT `customer_accounts_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_account_transactions` ADD CONSTRAINT `customer_account_transactions_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
