CREATE TABLE `case_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`command_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`applied_case_version` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `case_lifecycle`(`case_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `case_commands_key_unique` ON `case_commands` (`case_id`,`command_id`);--> statement-breakpoint
CREATE TABLE `case_lifecycle` (
	`case_id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`case_version` integer NOT NULL,
	`material_revision` integer,
	`snapshot_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "case_lifecycle_version_check" CHECK("case_lifecycle"."case_version" > 0),
	CONSTRAINT "case_lifecycle_revision_check" CHECK("case_lifecycle"."material_revision" is null or "case_lifecycle"."material_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `case_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`case_version` integer NOT NULL,
	`material_revision` integer,
	`snapshot_json` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `case_lifecycle`(`case_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `case_revisions_version_unique` ON `case_revisions` (`case_id`,`case_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_revisions_material_unique` ON `case_revisions` (`case_id`,`material_revision`);