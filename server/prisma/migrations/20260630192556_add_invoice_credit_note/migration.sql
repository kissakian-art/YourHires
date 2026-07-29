-- CreateTable
CREATE TABLE `invoices` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reference_number` VARCHAR(100) NOT NULL,
    `customer_name` VARCHAR(255) NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `due_date` DATETIME(3) NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'Unpaid',
    `description` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `invoices_reference_number_key`(`reference_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credit_notes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reference_number` VARCHAR(100) NOT NULL,
    `customer_name` VARCHAR(255) NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reason` TEXT NOT NULL,

    UNIQUE INDEX `credit_notes_reference_number_key`(`reference_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
