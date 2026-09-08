CREATE TABLE `investigation_evidence` (
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
	FOREIGN KEY (`evidence_request_id`) REFERENCES `evidence_requests`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "investigation_evidence_source_kind_check" CHECK("investigation_evidence"."source_kind" in ('REGULATOR', 'INTERNAL', 'EXTERNAL_PARTY', 'HUMAN_OBSERVED')),
	CONSTRAINT "investigation_evidence_content_kind_check" CHECK("investigation_evidence"."content_kind" in ('STRUCTURED', 'LOCATOR')),
	CONSTRAINT "investigation_evidence_content_check" CHECK(("investigation_evidence"."content_kind" = 'STRUCTURED' and "investigation_evidence"."content_json" is not null and "investigation_evidence"."content_locator" is null)
          or ("investigation_evidence"."content_kind" = 'LOCATOR' and "investigation_evidence"."content_json" is null and "investigation_evidence"."content_locator" is not null)),
	CONSTRAINT "investigation_evidence_integrity_hash_check" CHECK(length("investigation_evidence"."integrity_hash") = 64 and "investigation_evidence"."integrity_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "investigation_evidence_demo_check" CHECK("investigation_evidence"."demo" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `investigation_evidence_case_idx` ON `investigation_evidence` (`case_id`);