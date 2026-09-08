CREATE TABLE `__new_evidence_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`case_id` text,
	`question_ref` text,
	`requested_evidence` text NOT NULL,
	`recipient` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evidence_requests_versioned_question_check" CHECK(("__new_evidence_requests"."case_id" is null and "__new_evidence_requests"."question_ref" is null)
        or ("__new_evidence_requests"."case_id" is not null and "__new_evidence_requests"."question_ref" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_evidence_requests`(
	`id`, `match_id`, `requested_evidence`, `recipient`, `status`, `created_at`, `resolved_at`
) SELECT
	`id`, `match_id`, `requested_evidence`, `recipient`, `status`, `created_at`, `resolved_at`
FROM `evidence_requests`;
--> statement-breakpoint
CREATE TABLE `__new_investigation_evidence` (
	`evidence_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`question_ref` text NOT NULL,
	`evidence_request_id` text,
	`source_kind` text NOT NULL,
	`source_identifier` text NOT NULL,
	`received_at` text NOT NULL,
	`valid_as_of` text,
	`content_kind` text NOT NULL,
	`content_json` text,
	`content_locator` text,
	`integrity_hash` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_request_id`) REFERENCES `__new_evidence_requests`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "investigation_evidence_source_kind_check" CHECK(`source_kind` in ('REGULATOR', 'INTERNAL', 'EXTERNAL_PARTY', 'HUMAN_OBSERVED')),
	CONSTRAINT "investigation_evidence_content_kind_check" CHECK(`content_kind` in ('STRUCTURED', 'LOCATOR')),
	CONSTRAINT "investigation_evidence_content_check" CHECK((`content_kind` = 'STRUCTURED' and `content_json` is not null and `content_locator` is null)
          or (`content_kind` = 'LOCATOR' and `content_json` is null and `content_locator` is not null)),
	CONSTRAINT "investigation_evidence_integrity_hash_check" CHECK(length(`integrity_hash`) = 64 and `integrity_hash` not glob '*[^0-9a-f]*'),
	CONSTRAINT "investigation_evidence_demo_check" CHECK(`demo` in (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_investigation_evidence`(
	`evidence_ref`, `case_id`, `question_ref`, `evidence_request_id`,
	`source_kind`, `source_identifier`, `received_at`, `valid_as_of`,
	`content_kind`, `content_json`, `content_locator`, `integrity_hash`, `demo`
) SELECT
	`evidence_ref`, `case_id`, `question_ref`, `evidence_request_id`,
	`source_kind`, `source_identifier`, `received_at`, `valid_as_of`,
	`content_kind`, `content_json`, `content_locator`, `integrity_hash`, `demo`
FROM `investigation_evidence`;
--> statement-breakpoint
DROP TABLE `investigation_evidence`;
--> statement-breakpoint
DROP TABLE `evidence_requests`;
--> statement-breakpoint
ALTER TABLE `__new_evidence_requests` RENAME TO `evidence_requests`;
--> statement-breakpoint
ALTER TABLE `__new_investigation_evidence` RENAME TO `investigation_evidence`;
--> statement-breakpoint
CREATE INDEX `evidence_requests_case_question_created_idx` ON `evidence_requests` (`case_id`,`question_ref`,`created_at`);
--> statement-breakpoint
CREATE INDEX `investigation_evidence_case_idx` ON `investigation_evidence` (`case_id`);
