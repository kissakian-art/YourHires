-- AlterTable
ALTER TABLE `booking_line_items` ADD COLUMN `consumable_id` INTEGER NULL,
    ADD COLUMN `unit_of_measure_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `companies` ADD COLUMN `country` VARCHAR(10) NOT NULL DEFAULT 'UG',
    ADD COLUMN `currency_symbol` VARCHAR(10) NOT NULL DEFAULT 'UGX',
    ADD COLUMN `industry` VARCHAR(150) NOT NULL DEFAULT 'Equipment Rental',
    ADD COLUMN `onboarding_complete` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `timezone` VARCHAR(100) NOT NULL DEFAULT 'Africa/Kampala',
    ADD COLUMN `trial_active` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `trial_ends_at` DATETIME(3) NULL,
    MODIFY `currency` VARCHAR(10) NOT NULL DEFAULT 'UGX';

-- AlterTable
ALTER TABLE `rental_line_items` ADD COLUMN `consumable_id` INTEGER NULL,
    ADD COLUMN `unit_of_measure_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `rental_orders` ADD COLUMN `late_fee_applied_at` DATETIME(3) NULL,
    ADD COLUMN `overdue_alert_sent` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `maintenance_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `asset_id` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NOT NULL,
    `start_time` DATETIME(3) NOT NULL,
    `end_time` DATETIME(3) NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'Scheduled',
    `cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `function_item_assignments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `function_id` INTEGER NOT NULL,
    `item_type` VARCHAR(50) NOT NULL,
    `item_id` INTEGER NULL,
    `asset_id` INTEGER NULL,
    `consumable_id` INTEGER NULL,
    `unit_of_measure_id` INTEGER NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `status` VARCHAR(50) NOT NULL DEFAULT 'booked',
    `notes` TEXT NULL,
    `dispatched_at` DATETIME(3) NULL,
    `returned_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `function_checklist_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `function_id` INTEGER NOT NULL,
    `item_text` VARCHAR(255) NOT NULL,
    `is_completed` BOOLEAN NOT NULL DEFAULT false,
    `completed_at` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `assigned_employee_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `function_activities` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `function_id` INTEGER NOT NULL,
    `activity_type` VARCHAR(50) NOT NULL,
    `description` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `function_issues` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `function_id` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NOT NULL,
    `severity` VARCHAR(50) NOT NULL DEFAULT 'Medium',
    `status` VARCHAR(50) NOT NULL DEFAULT 'Reported',
    `resolution_notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `income_records` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'UGX',
    `income_source` VARCHAR(50) NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `payment_method` VARCHAR(50) NOT NULL,
    `payment_date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reference_number` VARCHAR(100) NULL,
    `description` TEXT NOT NULL,
    `base_rental_amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `late_fee_amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `damage_fee_amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `deposit_amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `other_fee_amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consumables` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `category` VARCHAR(100) NOT NULL DEFAULT 'general',
    `stock_qty` INTEGER NOT NULL DEFAULT 0,
    `restock_level` INTEGER NOT NULL DEFAULT 0,
    `unit_price` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `cost_price` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `sku` VARCHAR(100) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `is_multi_unit` BOOLEAN NOT NULL DEFAULT false,
    `package_unit_id` INTEGER NULL,
    `piece_unit_id` INTEGER NULL,
    `unit_ratio` INTEGER NOT NULL DEFAULT 1,
    `package_price` DECIMAL(10, 2) NULL,
    `unit_of_measure_id` INTEGER NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consumable_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `consumable_id` INTEGER NOT NULL,
    `action` VARCHAR(50) NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 0,
    `operator` VARCHAR(100) NOT NULL,
    `notes` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `units_of_measure` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `abbreviation` VARCHAR(50) NOT NULL,
    `category` VARCHAR(50) NOT NULL DEFAULT 'other',
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `units_of_measure_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `help_categories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `icon` VARCHAR(50) NOT NULL DEFAULT 'HelpCircle',
    `description` TEXT NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `help_articles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `category_id` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `content` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `help_articles_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `faqs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `question` VARCHAR(255) NOT NULL,
    `answer` TEXT NOT NULL,
    `display_order` INTEGER NOT NULL DEFAULT 0,
    `is_featured` BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_components` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'operational',
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_incidents` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `component_id` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `severity` VARCHAR(50) NOT NULL DEFAULT 'info',
    `message` TEXT NOT NULL,
    `reporter` VARCHAR(100) NOT NULL DEFAULT 'system',
    `resolved_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs`(`created_at`);

-- CreateIndex
CREATE INDEX `bookings_status_idx` ON `bookings`(`status`);

-- CreateIndex
CREATE INDEX `invoices_status_idx` ON `invoices`(`status`);

-- CreateIndex
CREATE INDEX `invoices_due_date_idx` ON `invoices`(`due_date`);

-- CreateIndex
CREATE INDEX `rental_orders_status_idx` ON `rental_orders`(`status`);

-- CreateIndex
CREATE INDEX `rental_orders_expected_return_date_idx` ON `rental_orders`(`expected_return_date`);

-- CreateIndex
CREATE INDEX `serialized_assets_status_idx` ON `serialized_assets`(`status`);

-- AddForeignKey
ALTER TABLE `booking_line_items` ADD CONSTRAINT `booking_line_items_consumable_id_fkey` FOREIGN KEY (`consumable_id`) REFERENCES `consumables`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `booking_line_items` ADD CONSTRAINT `booking_line_items_unit_of_measure_id_fkey` FOREIGN KEY (`unit_of_measure_id`) REFERENCES `units_of_measure`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rental_line_items` ADD CONSTRAINT `rental_line_items_consumable_id_fkey` FOREIGN KEY (`consumable_id`) REFERENCES `consumables`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rental_line_items` ADD CONSTRAINT `rental_line_items_unit_of_measure_id_fkey` FOREIGN KEY (`unit_of_measure_id`) REFERENCES `units_of_measure`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `maintenance_events` ADD CONSTRAINT `maintenance_events_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `maintenance_events` ADD CONSTRAINT `maintenance_events_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `serialized_assets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_item_assignments` ADD CONSTRAINT `function_item_assignments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_item_assignments` ADD CONSTRAINT `function_item_assignments_function_id_fkey` FOREIGN KEY (`function_id`) REFERENCES `function_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_item_assignments` ADD CONSTRAINT `function_item_assignments_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_item_assignments` ADD CONSTRAINT `function_item_assignments_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `serialized_assets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_item_assignments` ADD CONSTRAINT `function_item_assignments_consumable_id_fkey` FOREIGN KEY (`consumable_id`) REFERENCES `consumables`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_item_assignments` ADD CONSTRAINT `function_item_assignments_unit_of_measure_id_fkey` FOREIGN KEY (`unit_of_measure_id`) REFERENCES `units_of_measure`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_checklist_items` ADD CONSTRAINT `function_checklist_items_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_checklist_items` ADD CONSTRAINT `function_checklist_items_function_id_fkey` FOREIGN KEY (`function_id`) REFERENCES `function_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_checklist_items` ADD CONSTRAINT `function_checklist_items_assigned_employee_id_fkey` FOREIGN KEY (`assigned_employee_id`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_activities` ADD CONSTRAINT `function_activities_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_activities` ADD CONSTRAINT `function_activities_function_id_fkey` FOREIGN KEY (`function_id`) REFERENCES `function_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_issues` ADD CONSTRAINT `function_issues_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_issues` ADD CONSTRAINT `function_issues_function_id_fkey` FOREIGN KEY (`function_id`) REFERENCES `function_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `income_records` ADD CONSTRAINT `income_records_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consumables` ADD CONSTRAINT `consumables_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consumables` ADD CONSTRAINT `consumables_package_unit_id_fkey` FOREIGN KEY (`package_unit_id`) REFERENCES `units_of_measure`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consumables` ADD CONSTRAINT `consumables_piece_unit_id_fkey` FOREIGN KEY (`piece_unit_id`) REFERENCES `units_of_measure`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consumables` ADD CONSTRAINT `consumables_unit_of_measure_id_fkey` FOREIGN KEY (`unit_of_measure_id`) REFERENCES `units_of_measure`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consumable_logs` ADD CONSTRAINT `consumable_logs_consumable_id_fkey` FOREIGN KEY (`consumable_id`) REFERENCES `consumables`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `help_articles` ADD CONSTRAINT `help_articles_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `help_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `system_incidents` ADD CONSTRAINT `system_incidents_component_id_fkey` FOREIGN KEY (`component_id`) REFERENCES `system_components`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

