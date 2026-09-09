CREATE TABLE `investigation_claims` (
	`claim_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`question_ref` text NOT NULL,
	`subject_ref` text NOT NULL,
	`claim_type` text NOT NULL,
	`value_json` text NOT NULL,
	`evidence_refs_json` text NOT NULL,
	`origin_kind` text NOT NULL,
	`producer_identifier` text NOT NULL,
	`derivation_metadata_json` text,
	`supersedes_claim_ref` text,
	`created_at` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_ref`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supersedes_claim_ref`) REFERENCES `investigation_claims`(`claim_ref`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "investigation_claims_claim_type_check" CHECK("investigation_claims"."claim_type" in ('AFFECTED_BATCH_LOT')),
	CONSTRAINT "investigation_claims_origin_kind_check" CHECK("investigation_claims"."origin_kind" in ('DETERMINISTIC_EXTRACTED', 'AI_PROPOSED', 'HUMAN_OBSERVED')),
	CONSTRAINT "investigation_claims_demo_check" CHECK("investigation_claims"."demo" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `investigation_claims_case_question_created_idx` ON `investigation_claims` (`case_id`,`question_ref`,`created_at`);