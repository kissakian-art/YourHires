-- CreateTable
CREATE TABLE `suppliers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `contact_person` VARCHAR(255) NULL,
    `phone` VARCHAR(50) NULL,
    `email` VARCHAR(255) NULL,
    `address` TEXT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `supplier_id` INTEGER NOT NULL,
    `po_number` VARCHAR(100) NOT NULL,
    `order_date` VARCHAR(50) NOT NULL,
    `delivery_date` VARCHAR(50) NULL,
    `total_amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `status` VARCHAR(50) NOT NULL DEFAULT 'Draft',
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `purchase_orders_po_number_key`(`po_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_order_line_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `purchase_order_id` INTEGER NOT NULL,
    `item_id` INTEGER NULL,
    `description` VARCHAR(255) NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `unit_cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `total_cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expenses` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `supplier_id` INTEGER NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `expense_category` VARCHAR(100) NOT NULL,
    `expense_date` VARCHAR(50) NOT NULL,
    `payment_method` VARCHAR(50) NOT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_periods` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `start_date` VARCHAR(50) NOT NULL,
    `end_date` VARCHAR(50) NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'Open',
    `total_spent` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `payroll_period_id` INTEGER NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `payment_date` VARCHAR(50) NULL,
    `payment_method` VARCHAR(50) NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'Unpaid',
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `suppliers` ADD CONSTRAINT `suppliers_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_supplier_id_fkey` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_line_items` ADD CONSTRAINT `purchase_order_line_items_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_line_items` ADD CONSTRAINT `purchase_order_line_items_purchase_order_id_fkey` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_line_items` ADD CONSTRAINT `purchase_order_line_items_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_supplier_id_fkey` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_periods` ADD CONSTRAINT `payroll_periods_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payments` ADD CONSTRAINT `payroll_payments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payments` ADD CONSTRAINT `payroll_payments_payroll_period_id_fkey` FOREIGN KEY (`payroll_period_id`) REFERENCES `payroll_periods`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payments` ADD CONSTRAINT `payroll_payments_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
