-- AlterTable
ALTER TABLE `items` ADD COLUMN `unit_of_measure_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `serialized_assets` ADD COLUMN `unit_of_measure_id` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_unit_of_measure_id_fkey` FOREIGN KEY (`unit_of_measure_id`) REFERENCES `units_of_measure`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `serialized_assets` ADD CONSTRAINT `serialized_assets_unit_of_measure_id_fkey` FOREIGN KEY (`unit_of_measure_id`) REFERENCES `units_of_measure`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

