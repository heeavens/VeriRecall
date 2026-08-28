CREATE TABLE `action_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`type` text NOT NULL,
	`recipient` text,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "action_drafts_type_check" CHECK("action_drafts"."type" in ('block_sale', 'notify_supplier', 'notify_customers')),
	CONSTRAINT "action_drafts_status_check" CHECK("action_drafts"."status" in ('draft', 'approved', 'simulated_sent', 'not_available'))
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_reference` text NOT NULL,
	`source_url` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`risk` text NOT NULL,
	`image_url` text,
	`brand` text,
	`product_name` text NOT NULL,
	`ean` text,
	`batch` text,
	`category` text,
	`published_at` text NOT NULL,
	`status` text NOT NULL,
	`raw_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "alerts_source_check" CHECK("alerts"."source" in ('safety_gate', 'rasff')),
	CONSTRAINT "alerts_status_check" CHECK("alerts"."status" in ('matched', 'needs_review', 'not_relevant'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_source_reference_unique` ON `alerts` (`source`,`source_reference`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text,
	`alert_id` text,
	`event_type` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_name` text NOT NULL,
	`summary` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_events_case_id_idx` ON `audit_events` (`case_id`);--> statement-breakpoint
CREATE TABLE `case_items` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`product_id` text NOT NULL,
	`batch` text NOT NULL,
	`stock_quantity` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "case_items_stock_quantity_check" CHECK("case_items"."stock_quantity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `case_items_case_product_batch_unique` ON `case_items` (`case_id`,`product_id`,`batch`);--> statement-breakpoint
CREATE TABLE `case_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`completed_by` text,
	`completed_at` text,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "case_tasks_type_check" CHECK("case_tasks"."type" in ('block_sale', 'notify_supplier', 'notify_customers')),
	CONSTRAINT "case_tasks_status_check" CHECK("case_tasks"."status" in ('pending', 'completed', 'not_available'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `case_tasks_case_type_unique` ON `case_tasks` (`case_id`,`type`);--> statement-breakpoint
CREATE TABLE `cases` (
	`id` text PRIMARY KEY NOT NULL,
	`case_number` text NOT NULL,
	`alert_id` text NOT NULL,
	`status` text NOT NULL,
	`severity` text NOT NULL,
	`opened_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cases_status_check" CHECK("cases"."status" in ('open', 'contained', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cases_case_number_unique` ON `cases` (`case_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `cases_alert_id_unique` ON `cases` (`alert_id`);--> statement-breakpoint
CREATE INDEX `cases_status_idx` ON `cases` (`status`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`name` text,
	`email` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_external_id_unique` ON `customers` (`external_id`);--> statement-breakpoint
CREATE TABLE `evidence_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`requested_evidence` text NOT NULL,
	`recipient` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`product_id` text NOT NULL,
	`total_score` integer NOT NULL,
	`name_score` integer NOT NULL,
	`brand_score` integer NOT NULL,
	`ean_score` integer NOT NULL,
	`batch_score` integer NOT NULL,
	`has_hard_conflict` integer DEFAULT false NOT NULL,
	`explanation` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "matches_total_score_check" CHECK("matches"."total_score" between 0 and 100),
	CONSTRAINT "matches_name_score_check" CHECK("matches"."name_score" between 0 and 100),
	CONSTRAINT "matches_brand_score_check" CHECK("matches"."brand_score" between 0 and 100),
	CONSTRAINT "matches_ean_score_check" CHECK("matches"."ean_score" between 0 and 100),
	CONSTRAINT "matches_batch_score_check" CHECK("matches"."batch_score" between 0 and 100),
	CONSTRAINT "matches_hard_conflict_check" CHECK("matches"."has_hard_conflict" in (0, 1)),
	CONSTRAINT "matches_status_check" CHECK("matches"."status" in ('candidate', 'confirmed', 'rejected', 'awaiting_evidence'))
);
--> statement-breakpoint
CREATE INDEX `matches_alert_id_idx` ON `matches` (`alert_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`brand` text NOT NULL,
	`normalized_brand` text NOT NULL,
	`ean` text,
	`batch` text,
	`supplier_name` text,
	`supplier_email` text,
	`category` text,
	`stock_quantity` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "products_stock_quantity_check" CHECK("products"."stock_quantity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_sku_unique` ON `products` (`sku`);--> statement-breakpoint
CREATE INDEX `products_ean_idx` ON `products` (`ean`);--> statement-breakpoint
CREATE INDEX `products_normalized_brand_idx` ON `products` (`normalized_brand`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`product_id` text NOT NULL,
	`batch` text,
	`purchased_at` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "purchases_quantity_check" CHECK("purchases"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`confidence_threshold` integer DEFAULT 85 NOT NULL,
	`review_floor` integer DEFAULT 55 NOT NULL,
	`onboarding_completed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "settings_confidence_threshold_check" CHECK("settings"."confidence_threshold" between 70 and 95),
	CONSTRAINT "settings_review_floor_check" CHECK("settings"."review_floor" between 0 and 100),
	CONSTRAINT "settings_onboarding_completed_check" CHECK("settings"."onboarding_completed" in (0, 1))
);
