CREATE TABLE `traceability_records` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`source_ref` text NOT NULL,
	`record_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `case_lifecycle`(`case_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_records_source_unique` ON `traceability_records` (`case_id`,`source_ref`);--> statement-breakpoint
CREATE INDEX `traceability_records_case_idx` ON `traceability_records` (`case_id`);--> statement-breakpoint
DROP INDEX `case_revisions_material_unique`;--> statement-breakpoint
CREATE INDEX `case_revisions_material_idx` ON `case_revisions` (`case_id`,`material_revision`);