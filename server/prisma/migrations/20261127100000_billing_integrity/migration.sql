-- Credits are tracked apart from cash received.
ALTER TABLE `invoices` ADD COLUMN `amount_credited` DECIMAL(12, 2) NOT NULL DEFAULT 0.00;

-- Backfill: fully credited invoices carried status 'Credited' with no amount;
-- partial credits had been added to amount_paid. Move both into amount_credited.
UPDATE `invoices` i
  JOIN (SELECT `invoice_id`, SUM(`amount`) AS credited FROM `credit_notes` WHERE `invoice_id` IS NOT NULL GROUP BY `invoice_id`) c
    ON c.`invoice_id` = i.`id`
SET i.`amount_credited` = LEAST(c.credited, i.`amount`),
    i.`amount_paid` = CASE WHEN i.`status` = 'Credited' THEN i.`amount_paid`
                           ELSE GREATEST(0, i.`amount_paid` - c.credited) END;

CREATE TABLE `invoice_payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `invoice_id` INTEGER NOT NULL,
    `payment_key` VARCHAR(100) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `payment_method` VARCHAR(50) NOT NULL,
    `payment_date` DATETIME(3) NOT NULL,
    `notes` VARCHAR(255) NULL,
    `created_by` VARCHAR(150) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `invoice_payments_invoice_id_idx`(`invoice_id`),
    UNIQUE INDEX `invoice_payments_company_id_payment_key_key`(`company_id`, `payment_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `return_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `rental_order_id` INTEGER NOT NULL,
    `sequence` INTEGER NOT NULL,
    `returned_qty` INTEGER NOT NULL DEFAULT 0,
    `damaged_qty` INTEGER NOT NULL DEFAULT 0,
    `lost_qty` INTEGER NOT NULL DEFAULT 0,
    `damage_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `lost_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `invoice_id` INTEGER NULL,
    `lines` JSON NOT NULL,
    `notes` TEXT NULL,
    `created_by` VARCHAR(150) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `return_events_company_id_idx`(`company_id`),
    UNIQUE INDEX `return_events_rental_order_id_sequence_key`(`rental_order_id`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `invoice_payments` ADD CONSTRAINT `invoice_payments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `invoice_payments` ADD CONSTRAINT `invoice_payments_invoice_id_fkey` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `return_events` ADD CONSTRAINT `return_events_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `return_events` ADD CONSTRAINT `return_events_rental_order_id_fkey` FOREIGN KEY (`rental_order_id`) REFERENCES `rental_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Public bookings stored the discriminator 'Item'; dispatch/return only move
-- stock for 'item'. Normalise. (Orders already dispatched from such bookings
-- did not deduct stock — reconcile them before adjusting quantities.)
UPDATE `booking_line_items` SET `item_type` = 'item' WHERE BINARY `item_type` = 'Item';

-- Bookings created with a deposit were stored as 'pending' + paid, which the UI
-- could neither collect nor dispatch. They are confirmed.
UPDATE `bookings` SET `status` = 'confirmed' WHERE `status` = 'pending' AND `deposit_paid` = 1;
