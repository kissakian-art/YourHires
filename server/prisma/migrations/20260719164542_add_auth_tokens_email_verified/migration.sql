-- AlterTable
ALTER TABLE `users` ADD COLUMN `email_verified` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `auth_tokens` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `token` VARCHAR(255) NOT NULL,
    `purpose` VARCHAR(30) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `auth_tokens_token_key`(`token`),
    INDEX `auth_tokens_token_idx`(`token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `auth_tokens` ADD CONSTRAINT `auth_tokens_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

