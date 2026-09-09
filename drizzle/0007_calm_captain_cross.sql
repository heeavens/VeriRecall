CREATE TABLE `investigation_assessments` (
	`assessment_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`question_ref` text NOT NULL,
	`target_claim_ref` text,
	`verdict` text NOT NULL,
	`evidence_refs_json` text NOT NULL,
	`related_claim_refs_json` text NOT NULL,
	`assessor_kind` text NOT NULL,
	`assessor_identifier` text NOT NULL,
	`rule_identifier` text,
	`rule_version` text,
	`rationale` text NOT NULL,
	`basis_case_version` integer NOT NULL,
	`supersedes_assessment_ref` text,
	`created_at` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_claim_ref`) REFERENCES `investigation_claims`(`claim_ref`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supersedes_assessment_ref`) REFERENCES `investigation_assessments`(`assessment_ref`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "investigation_assessments_verdict_check" CHECK("investigation_assessments"."verdict" in ('SUPPORTED', 'INSUFFICIENT', 'REJECTED', 'CONTRADICTED')),
	CONSTRAINT "investigation_assessments_assessor_kind_check" CHECK("investigation_assessments"."assessor_kind" in ('RULE', 'HUMAN', 'AI')),
	CONSTRAINT "investigation_assessments_rule_pair_check" CHECK(("investigation_assessments"."rule_identifier" is null and "investigation_assessments"."rule_version" is null)
          or ("investigation_assessments"."rule_identifier" is not null and "investigation_assessments"."rule_version" is not null)),
	CONSTRAINT "investigation_assessments_rule_required_check" CHECK("investigation_assessments"."assessor_kind" = 'HUMAN'
          or ("investigation_assessments"."rule_identifier" is not null and "investigation_assessments"."rule_version" is not null)),
	CONSTRAINT "investigation_assessments_target_check" CHECK(("investigation_assessments"."verdict" in ('SUPPORTED', 'REJECTED') and "investigation_assessments"."target_claim_ref" is not null)
          or ("investigation_assessments"."verdict" = 'INSUFFICIENT')
          or ("investigation_assessments"."verdict" = 'CONTRADICTED' and "investigation_assessments"."target_claim_ref" is null)),
	CONSTRAINT "investigation_assessments_assessor_identifier_check" CHECK(length(trim("investigation_assessments"."assessor_identifier")) > 0),
	CONSTRAINT "investigation_assessments_rationale_check" CHECK(length(trim("investigation_assessments"."rationale")) > 0),
	CONSTRAINT "investigation_assessments_basis_case_version_check" CHECK("investigation_assessments"."basis_case_version" > 0),
	CONSTRAINT "investigation_assessments_demo_check" CHECK("investigation_assessments"."demo" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `investigation_assessments_case_question_created_idx` ON `investigation_assessments` (`case_id`,`question_ref`,`created_at`);