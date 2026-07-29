-- AlterTable
ALTER TABLE `function_events` ADD COLUMN `completed_at` DATETIME(3) NULL,
    ADD COLUMN `completion_notes` TEXT NULL,
    ADD COLUMN `revenue_paid` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `revenue_paid_date` DATETIME(3) NULL,
    ADD COLUMN `template_name` VARCHAR(255) NULL,
    ADD COLUMN `total_expenses` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `total_revenue` DECIMAL(10, 2) NOT NULL DEFAULT 0.00;

-- CreateTable
CREATE TABLE `function_expenses` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `function_id` INTEGER NOT NULL,
    `expense_type` VARCHAR(30) NOT NULL DEFAULT 'other',
    `description` VARCHAR(255) NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `expense_date` VARCHAR(50) NOT NULL,
    `receipt_number` VARCHAR(100) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `function_expenses_company_id_function_id_idx`(`company_id`, `function_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `function_signatures` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `function_id` INTEGER NOT NULL,
    `signature_type` VARCHAR(20) NOT NULL,
    `signee_name` VARCHAR(255) NOT NULL,
    `signee_contact` VARCHAR(255) NULL,
    `signature_data` TEXT NOT NULL,
    `confirmation_notes` TEXT NULL,
    `signed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `function_signatures_company_id_function_id_idx`(`company_id`, `function_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `function_templates` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `default_location` VARCHAR(255) NULL,
    `default_time` VARCHAR(50) NULL,
    `default_notes` TEXT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `function_templates_company_id_name_key`(`company_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `function_template_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `template_id` INTEGER NOT NULL,
    `item_type` VARCHAR(20) NOT NULL,
    `item_id` INTEGER NULL,
    `asset_id` INTEGER NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `function_expenses` ADD CONSTRAINT `function_expenses_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_expenses` ADD CONSTRAINT `function_expenses_function_id_fkey` FOREIGN KEY (`function_id`) REFERENCES `function_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_signatures` ADD CONSTRAINT `function_signatures_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_signatures` ADD CONSTRAINT `function_signatures_function_id_fkey` FOREIGN KEY (`function_id`) REFERENCES `function_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_templates` ADD CONSTRAINT `function_templates_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_template_items` ADD CONSTRAINT `function_template_items_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `function_templates`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_template_items` ADD CONSTRAINT `function_template_items_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_template_items` ADD CONSTRAINT `function_template_items_asset_id_fkey` FOREIGN KEY (`asset_id`) REFERENCES `serialized_assets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

