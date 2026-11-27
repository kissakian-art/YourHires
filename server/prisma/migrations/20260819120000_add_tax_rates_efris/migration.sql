-- AlterTable
ALTER TABLE `companies` ADD COLUMN `efris_api_key` VARCHAR(255) NULL,
    ADD COLUMN `efris_api_url` VARCHAR(255) NULL,
    ADD COLUMN `efris_enabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `efris_tin` VARCHAR(50) NULL,
    ADD COLUMN `prices_include_tax` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `consumables` ADD COLUMN `commodity_code` VARCHAR(50) NULL,
    ADD COLUMN `efris_item_code` VARCHAR(100) NULL,
    ADD COLUMN `efris_product_code` VARCHAR(100) NULL,
    ADD COLUMN `efris_registered_at` DATETIME(3) NULL,
    ADD COLUMN `excise_duty_code` VARCHAR(50) NULL,
    ADD COLUMN `have_excise_tax` VARCHAR(4) NULL,
    ADD COLUMN `tax_rate_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `credit_notes` ADD COLUMN `customer_id` INTEGER NULL,
    ADD COLUMN `e_invoice_response` JSON NULL,
    ADD COLUMN `efris_error` TEXT NULL,
    ADD COLUMN `efris_fdn` VARCHAR(100) NULL,
    ADD COLUMN `efris_fiscalized_at` DATETIME(3) NULL,
    ADD COLUMN `efris_invoice_no` VARCHAR(100) NULL,
    ADD COLUMN `efris_qr_code` TEXT NULL,
    ADD COLUMN `efris_status` VARCHAR(20) NULL,
    ADD COLUMN `efris_verification_code` VARCHAR(100) NULL,
    ADD COLUMN `invoice_id` INTEGER NULL,
    ADD COLUMN `reason_code` VARCHAR(4) NOT NULL DEFAULT '101',
    ADD COLUMN `subtotal` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `tax_total` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    MODIFY `amount` DECIMAL(12, 2) NOT NULL;

-- AlterTable
ALTER TABLE `customers` ADD COLUMN `tax_id` VARCHAR(50) NULL;

-- AlterTable
ALTER TABLE `invoices` ADD COLUMN `amount_paid` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `booking_id` INTEGER NULL,
    ADD COLUMN `currency` VARCHAR(10) NOT NULL DEFAULT 'UGX',
    ADD COLUMN `customer_id` INTEGER NULL,
    ADD COLUMN `customer_tin` VARCHAR(50) NULL,
    ADD COLUMN `discount_total` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `e_invoice_response` JSON NULL,
    ADD COLUMN `efris_error` TEXT NULL,
    ADD COLUMN `efris_fdn` VARCHAR(100) NULL,
    ADD COLUMN `efris_fiscalized_at` DATETIME(3) NULL,
    ADD COLUMN `efris_invoice_no` VARCHAR(100) NULL,
    ADD COLUMN `efris_qr_code` TEXT NULL,
    ADD COLUMN `efris_status` VARCHAR(20) NULL,
    ADD COLUMN `efris_verification_code` VARCHAR(100) NULL,
    ADD COLUMN `invoice_type` VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    ADD COLUMN `issue_date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `notes` TEXT NULL,
    ADD COLUMN `rental_order_id` INTEGER NULL,
    ADD COLUMN `subtotal` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `tax_total` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `terms` TEXT NULL,
    MODIFY `amount` DECIMAL(12, 2) NOT NULL;

-- AlterTable
ALTER TABLE `items` ADD COLUMN `commodity_code` VARCHAR(50) NULL,
    ADD COLUMN `efris_item_code` VARCHAR(100) NULL,
    ADD COLUMN `efris_product_code` VARCHAR(100) NULL,
    ADD COLUMN `efris_registered_at` DATETIME(3) NULL,
    ADD COLUMN `excise_duty_code` VARCHAR(50) NULL,
    ADD COLUMN `have_excise_tax` VARCHAR(4) NULL,
    ADD COLUMN `sku` VARCHAR(100) NULL,
    ADD COLUMN `tax_rate_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `serialized_assets` ADD COLUMN `commodity_code` VARCHAR(50) NULL,
    ADD COLUMN `efris_item_code` VARCHAR(100) NULL,
    ADD COLUMN `efris_product_code` VARCHAR(100) NULL,
    ADD COLUMN `efris_registered_at` DATETIME(3) NULL,
    ADD COLUMN `excise_duty_code` VARCHAR(50) NULL,
    ADD COLUMN `have_excise_tax` VARCHAR(4) NULL,
    ADD COLUMN `sku` VARCHAR(100) NULL,
    ADD COLUMN `tax_rate_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `units_of_measure` ADD COLUMN `efris_code` VARCHAR(10) NULL;

-- CreateTable
CREATE TABLE `invoice_line_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `invoice_id` INTEGER NOT NULL,
    `item_type` VARCHAR(20) NOT NULL,
    `item_id` INTEGER NULL,
    `asset_id` INTEGER NULL,
    `consumable_id` INTEGER NULL,
    `unit_of_measure_id` INTEGER NULL,
    `description` VARCHAR(255) NOT NULL,
    `quantity` DECIMAL(12, 2) NOT NULL DEFAULT 1.00,
    `rental_days` INTEGER NOT NULL DEFAULT 1,
    `unitPrice` DECIMAL(12, 2) NOT NULL,
    `discount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `tax_rate_id` INTEGER NULL,
    `tax_rate_percent` DECIMAL(6, 4) NOT NULL DEFAULT 0.0000,
    `tax_code` VARCHAR(4) NOT NULL DEFAULT '01',
    `line_net` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `line_tax` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `line_total` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `sort_order` INTEGER NOT NULL DEFAULT 0,

    INDEX `invoice_line_items_invoice_id_idx`(`invoice_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credit_note_line_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `credit_note_id` INTEGER NOT NULL,
    `item_type` VARCHAR(20) NOT NULL,
    `item_id` INTEGER NULL,
    `asset_id` INTEGER NULL,
    `consumable_id` INTEGER NULL,
    `unit_of_measure_id` INTEGER NULL,
    `description` VARCHAR(255) NOT NULL,
    `quantity` DECIMAL(12, 2) NOT NULL DEFAULT 1.00,
    `unitPrice` DECIMAL(12, 2) NOT NULL,
    `tax_rate_percent` DECIMAL(6, 4) NOT NULL DEFAULT 0.0000,
    `tax_code` VARCHAR(4) NOT NULL DEFAULT '01',
    `line_net` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `line_tax` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `line_total` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,

    INDEX `credit_note_line_items_credit_note_id_idx`(`credit_note_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tax_rates` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `rate` DECIMAL(6, 4) NOT NULL DEFAULT 0.0000,
    `tax_code` VARCHAR(4) NOT NULL DEFAULT '01',
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `tax_rates_company_id_name_key`(`company_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `efris_excise_codes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `name` TEXT NOT NULL,
    `rate` VARCHAR(50) NULL,
    `unit` VARCHAR(50) NULL,
    `currency` VARCHAR(10) NULL,
    `excise_rule` VARCHAR(4) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `efris_excise_codes_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `efris_stock_movements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `direction` VARCHAR(10) NOT NULL,
    `reference` VARCHAR(120) NOT NULL,
    `stock_in_type` VARCHAR(4) NULL,
    `adjust_type` VARCHAR(4) NULL,
    `supplier_name` VARCHAR(255) NULL,
    `supplier_tin` VARCHAR(50) NULL,
    `remarks` TEXT NULL,
    `payload` JSON NULL,
    `response` JSON NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `efris_stock_movements_status_idx`(`status`),
    UNIQUE INDEX `efris_stock_movements_company_id_reference_key`(`company_id`, `reference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `credit_notes_efris_status_idx` ON `credit_notes`(`efris_status`);

-- CreateIndex
CREATE INDEX `invoices_efris_status_idx` ON `invoices`(`efris_status`);

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_tax_rate_id_fkey` FOREIGN KEY (`tax_rate_id`) REFERENCES `tax_rates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `serialized_assets` ADD CONSTRAINT `serialized_assets_tax_rate_id_fkey` FOREIGN KEY (`tax_rate_id`) REFERENCES `tax_rates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_rental_order_id_fkey` FOREIGN KEY (`rental_order_id`) REFERENCES `rental_orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_line_items` ADD CONSTRAINT `invoice_line_items_invoice_id_fkey` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_line_items` ADD CONSTRAINT `invoice_line_items_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_line_items` ADD CONSTRAINT `invoice_line_items_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `serialized_assets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_line_items` ADD CONSTRAINT `invoice_line_items_consumable_id_fkey` FOREIGN KEY (`consumable_id`) REFERENCES `consumables`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_line_items` ADD CONSTRAINT `invoice_line_items_unit_of_measure_id_fkey` FOREIGN KEY (`unit_of_measure_id`) REFERENCES `units_of_measure`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_line_items` ADD CONSTRAINT `invoice_line_items_tax_rate_id_fkey` FOREIGN KEY (`tax_rate_id`) REFERENCES `tax_rates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_notes` ADD CONSTRAINT `credit_notes_invoice_id_fkey` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_notes` ADD CONSTRAINT `credit_notes_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_note_line_items` ADD CONSTRAINT `credit_note_line_items_credit_note_id_fkey` FOREIGN KEY (`credit_note_id`) REFERENCES `credit_notes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_note_line_items` ADD CONSTRAINT `credit_note_line_items_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_note_line_items` ADD CONSTRAINT `credit_note_line_items_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `serialized_assets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_note_line_items` ADD CONSTRAINT `credit_note_line_items_consumable_id_fkey` FOREIGN KEY (`consumable_id`) REFERENCES `consumables`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_note_line_items` ADD CONSTRAINT `credit_note_line_items_unit_of_measure_id_fkey` FOREIGN KEY (`unit_of_measure_id`) REFERENCES `units_of_measure`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consumables` ADD CONSTRAINT `consumables_tax_rate_id_fkey` FOREIGN KEY (`tax_rate_id`) REFERENCES `tax_rates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tax_rates` ADD CONSTRAINT `tax_rates_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `efris_stock_movements` ADD CONSTRAINT `efris_stock_movements_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

