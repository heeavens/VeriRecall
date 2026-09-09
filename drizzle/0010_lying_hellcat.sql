CREATE TABLE `investigation_challenges` (
	`challenge_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`question_ref` text NOT NULL,
	`challenged_revision_id` text NOT NULL,
	`challenged_material_revision` integer NOT NULL,
	`opened_case_version` integer NOT NULL,
	`trigger_evidence_refs_json` text NOT NULL,
	`opened_by_kind` text NOT NULL,
	`opened_by_identifier` text NOT NULL,
	`rationale` text NOT NULL,
	`created_at` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_ref`) REFERENCES `investigation_questions`(`question_ref`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`challenged_revision_id`) REFERENCES `case_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "investigation_challenges_material_revision_check" CHECK("investigation_challenges"."challenged_material_revision" > 0),
	CONSTRAINT "investigation_challenges_opened_case_version_check" CHECK("investigation_challenges"."opened_case_version" > 0),
	CONSTRAINT "investigation_challenges_opened_by_kind_check" CHECK("investigation_challenges"."opened_by_kind" = 'HUMAN'),
	CONSTRAINT "investigation_challenges_opened_by_identifier_check" CHECK(length(trim("investigation_challenges"."opened_by_identifier")) > 0),
	CONSTRAINT "investigation_challenges_rationale_check" CHECK(length(trim("investigation_challenges"."rationale")) > 0),
	CONSTRAINT "investigation_challenges_demo_check" CHECK("investigation_challenges"."demo" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investigation_challenges_case_question_material_unique` ON `investigation_challenges` (`case_id`,`question_ref`,`challenged_material_revision`);--> statement-breakpoint
CREATE INDEX `investigation_challenges_case_question_created_idx` ON `investigation_challenges` (`case_id`,`question_ref`,`created_at`);