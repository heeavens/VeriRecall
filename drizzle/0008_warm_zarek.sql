CREATE TABLE `investigation_establishments` (
	`establishment_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`question_ref` text NOT NULL,
	`claim_ref` text NOT NULL,
	`policy_identifier` text NOT NULL,
	`policy_version` text NOT NULL,
	`basis_claim_refs_json` text NOT NULL,
	`basis_assessment_refs_json` text NOT NULL,
	`basis_evidence_refs_json` text NOT NULL,
	`evaluator_kind` text NOT NULL,
	`evaluator_identifier` text NOT NULL,
	`basis_case_version` integer NOT NULL,
	`basis_material_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_ref`) REFERENCES `investigation_claims`(`claim_ref`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "investigation_establishments_evaluator_kind_check" CHECK("investigation_establishments"."evaluator_kind" = 'RULE'),
	CONSTRAINT "investigation_establishments_policy_identifier_check" CHECK(length(trim("investigation_establishments"."policy_identifier")) > 0),
	CONSTRAINT "investigation_establishments_policy_version_check" CHECK(length(trim("investigation_establishments"."policy_version")) > 0),
	CONSTRAINT "investigation_establishments_evaluator_identifier_check" CHECK(length(trim("investigation_establishments"."evaluator_identifier")) > 0),
	CONSTRAINT "investigation_establishments_basis_case_version_check" CHECK("investigation_establishments"."basis_case_version" > 0),
	CONSTRAINT "investigation_establishments_basis_material_revision_check" CHECK("investigation_establishments"."basis_material_revision" > 0),
	CONSTRAINT "investigation_establishments_demo_check" CHECK("investigation_establishments"."demo" = 1)
);
--> statement-breakpoint
CREATE INDEX `investigation_establishments_case_question_created_idx` ON `investigation_establishments` (`case_id`,`question_ref`,`created_at`);