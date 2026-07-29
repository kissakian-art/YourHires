-- CreateTable
CREATE TABLE `employees` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `role` VARCHAR(100) NULL,
    `billing_rate_to_client` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `pay_structure` VARCHAR(50) NOT NULL DEFAULT 'Per Function',
    `pay_rate` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sites` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `location` VARCHAR(255) NULL,
    `contact_person` VARCHAR(255) NULL,
    `contact_info` VARCHAR(255) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `site_assignments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `site_id` INTEGER NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `assigned_date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `notes` TEXT NULL,

    UNIQUE INDEX `site_assignments_site_id_employee_id_key`(`site_id`, `employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `function_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `date` VARCHAR(50) NOT NULL,
    `time` VARCHAR(50) NOT NULL,
    `location` VARCHAR(255) NOT NULL,
    `client_name` VARCHAR(255) NOT NULL,
    `client_contact` VARCHAR(255) NOT NULL,
    `notes` TEXT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'Scheduled',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `function_roles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `description` TEXT NULL,

    UNIQUE INDEX `function_roles_company_id_name_key`(`company_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `function_assignments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `function_id` INTEGER NOT NULL,
    `employee_id` INTEGER NOT NULL,
    `role_id` INTEGER NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'Assigned',
    `start_time` VARCHAR(50) NULL,
    `end_time` VARCHAR(50) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `function_assignments_function_id_employee_id_role_id_key`(`function_id`, `employee_id`, `role_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sites` ADD CONSTRAINT `sites_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `site_assignments` ADD CONSTRAINT `site_assignments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `site_assignments` ADD CONSTRAINT `site_assignments_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `site_assignments` ADD CONSTRAINT `site_assignments_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_events` ADD CONSTRAINT `function_events_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_roles` ADD CONSTRAINT `function_roles_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_assignments` ADD CONSTRAINT `function_assignments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_assignments` ADD CONSTRAINT `function_assignments_function_id_fkey` FOREIGN KEY (`function_id`) REFERENCES `function_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_assignments` ADD CONSTRAINT `function_assignments_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `function_assignments` ADD CONSTRAINT `function_assignments_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `function_roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
