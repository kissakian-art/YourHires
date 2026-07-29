-- CreateTable
CREATE TABLE `notifications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `category` VARCHAR(50) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `message` TEXT NOT NULL,
    `link` VARCHAR(255) NULL,
    `is_read` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_company_id_is_read_idx`(`company_id`, `is_read`),
    INDEX `notifications_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_preferences` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `overdue` BOOLEAN NOT NULL DEFAULT true,
    `low_stock` BOOLEAN NOT NULL DEFAULT true,
    `returns` BOOLEAN NOT NULL DEFAULT true,
    `payments` BOOLEAN NOT NULL DEFAULT true,
    `bookings` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `notification_preferences_user_id_key`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_preferences` ADD CONSTRAINT `notification_preferences_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

