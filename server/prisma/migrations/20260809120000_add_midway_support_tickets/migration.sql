-- Local index of tickets filed into the central Midway support desk.
-- The desk's channel API can read a ticket by ref but cannot list them, so we keep
-- the refs this tenant opened to power the "My requests" screen.
--
-- Written by hand to stay valid on BOTH MariaDB (dev) and MySQL 8.0 (production):
-- plain CREATE TABLE, no engine-specific syntax, and IF NOT EXISTS so re-running
-- against a database already built with `prisma db push` is a no-op rather than an
-- error (this project's production schema was created that way — see the deploy notes).
CREATE TABLE IF NOT EXISTS `midway_support_tickets` (
  `id`         INTEGER      NOT NULL AUTO_INCREMENT,
  `ref`        VARCHAR(32)  NOT NULL,
  `company_id` INTEGER      NULL,
  `user_id`    INTEGER      NOT NULL,
  `system`     VARCHAR(191) NULL,
  `subject`    VARCHAR(255) NOT NULL,
  `status`     VARCHAR(32)  NOT NULL DEFAULT 'OPEN',
  `priority`   VARCHAR(16)  NOT NULL DEFAULT 'NORMAL',
  `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3)  NOT NULL,

  UNIQUE INDEX `midway_support_tickets_ref_key`(`ref`),
  INDEX `midway_support_tickets_company_id_created_at_idx`(`company_id`, `created_at`),
  INDEX `midway_support_tickets_user_id_idx`(`user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
