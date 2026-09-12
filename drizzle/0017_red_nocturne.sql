CREATE TABLE `investigation_investigator_recommendation_events` (
	`event_ref` text PRIMARY KEY NOT NULL,
	`recommendation_ref` text NOT NULL,
	`event_kind` text NOT NULL,
	`linked_artifact_kind` text,
	`linked_artifact_ref` text,
	`supporting_evidence_refs_json` text NOT NULL,
	`rationale` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_identifier` text NOT NULL,
	`basis_case_version` integer NOT NULL,
	`basis_material_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`recommendation_ref`) REFERENCES `investigation_investigator_recommendations`(`recommendation_ref`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "investigator_recommendation_events_kind_check" CHECK("investigation_investigator_recommendation_events"."event_kind" in ('DISMISSED', 'ACTED', 'PATH_EXHAUSTED')),
	CONSTRAINT "investigator_recommendation_events_link_check" CHECK(("investigation_investigator_recommendation_events"."linked_artifact_kind" is null and "investigation_investigator_recommendation_events"."linked_artifact_ref" is null)
          or ("investigation_investigator_recommendation_events"."linked_artifact_kind" = 'EVIDENCE_REQUEST'
            and "investigation_investigator_recommendation_events"."linked_artifact_ref" is not null
            and length(trim("investigation_investigator_recommendation_events"."linked_artifact_ref")) > 0)),
	CONSTRAINT "investigator_recommendation_events_evidence_check" CHECK(json_valid("investigation_investigator_recommendation_events"."supporting_evidence_refs_json")
          and ("investigation_investigator_recommendation_events"."event_kind" <> 'PATH_EXHAUSTED'
            or "investigation_investigator_recommendation_events"."supporting_evidence_refs_json" <> '[]')),
	CONSTRAINT "investigator_recommendation_events_actor_check" CHECK("investigation_investigator_recommendation_events"."actor_kind" = 'HUMAN' and length(trim("investigation_investigator_recommendation_events"."actor_identifier")) > 0),
	CONSTRAINT "investigator_recommendation_events_rationale_check" CHECK(length(trim("investigation_investigator_recommendation_events"."rationale")) between 1 and 10000),
	CONSTRAINT "investigator_recommendation_events_version_check" CHECK("investigation_investigator_recommendation_events"."basis_case_version" > 0 and "investigation_investigator_recommendation_events"."basis_material_revision" > 0),
	CONSTRAINT "investigator_recommendation_events_demo_check" CHECK("investigation_investigator_recommendation_events"."demo" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investigator_recommendation_events_kind_unique` ON `investigation_investigator_recommendation_events` (`recommendation_ref`,`event_kind`);--> statement-breakpoint
CREATE INDEX `investigator_recommendation_events_recommendation_idx` ON `investigation_investigator_recommendation_events` (`recommendation_ref`,`created_at`);--> statement-breakpoint
CREATE TABLE `investigation_investigator_recommendations` (
	`recommendation_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`question_ref` text NOT NULL,
	`context_challenge_ref` text,
	`context_kind` text NOT NULL,
	`case_version` integer NOT NULL,
	`material_revision` integer NOT NULL,
	`snapshot_format_version` integer NOT NULL,
	`policy_identifier` text NOT NULL,
	`policy_version` integer NOT NULL,
	`basis_json` text NOT NULL,
	`basis_digest` text NOT NULL,
	`recommendation_kind` text NOT NULL,
	`recommendation_json` text NOT NULL,
	`recommendation_digest` text NOT NULL,
	`action_key` text NOT NULL,
	`provider_identifier` text NOT NULL,
	`client_identifier` text NOT NULL,
	`model_identifier` text NOT NULL,
	`prompt_policy_version` text NOT NULL,
	`generated_at` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_ref`) REFERENCES `investigation_questions`(`question_ref`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`context_challenge_ref`) REFERENCES `investigation_challenges`(`challenge_ref`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "investigator_recommendations_context_kind_check" CHECK("investigation_investigator_recommendations"."context_kind" in ('OPEN_GAP', 'OPEN_CHALLENGE', 'APPLIED_CHALLENGE_CONFLICT')),
	CONSTRAINT "investigator_recommendations_context_challenge_check" CHECK(("investigation_investigator_recommendations"."context_kind" = 'OPEN_GAP' and "investigation_investigator_recommendations"."context_challenge_ref" is null)
          or ("investigation_investigator_recommendations"."context_kind" in ('OPEN_CHALLENGE', 'APPLIED_CHALLENGE_CONFLICT')
            and "investigation_investigator_recommendations"."context_challenge_ref" is not null)),
	CONSTRAINT "investigator_recommendations_version_check" CHECK("investigation_investigator_recommendations"."case_version" > 0 and "investigation_investigator_recommendations"."material_revision" > 0
          and "investigation_investigator_recommendations"."snapshot_format_version" > 0 and "investigation_investigator_recommendations"."policy_version" > 0),
	CONSTRAINT "investigator_recommendations_policy_check" CHECK(length(trim("investigation_investigator_recommendations"."policy_identifier")) > 0
          and length(trim("investigation_investigator_recommendations"."provider_identifier")) > 0
          and length(trim("investigation_investigator_recommendations"."client_identifier")) > 0
          and length(trim("investigation_investigator_recommendations"."model_identifier")) > 0
          and length(trim("investigation_investigator_recommendations"."prompt_policy_version")) > 0),
	CONSTRAINT "investigator_recommendations_json_check" CHECK(json_valid("investigation_investigator_recommendations"."basis_json") and json_valid("investigation_investigator_recommendations"."recommendation_json")),
	CONSTRAINT "investigator_recommendations_kind_check" CHECK("investigation_investigator_recommendations"."recommendation_kind" in ('REQUEST_EVIDENCE', 'REVIEW_EXISTING_EVIDENCE',
          'FOLLOW_UP_RECORDED_REQUEST', 'WAIT_FOR_PENDING_EVIDENCE',
          'ESCALATE_UNRESOLVED_TO_HUMAN', 'NO_ACTION')),
	CONSTRAINT "investigator_recommendations_digest_check" CHECK(length("investigation_investigator_recommendations"."basis_digest") = 71
          and substr("investigation_investigator_recommendations"."basis_digest", 1, 7) = 'sha256:'
          and substr("investigation_investigator_recommendations"."basis_digest", 8) not glob '*[^0-9a-f]*'
          and length("investigation_investigator_recommendations"."recommendation_digest") = 71
          and substr("investigation_investigator_recommendations"."recommendation_digest", 1, 7) = 'sha256:'
          and substr("investigation_investigator_recommendations"."recommendation_digest", 8) not glob '*[^0-9a-f]*'
          and length("investigation_investigator_recommendations"."action_key") = 71
          and substr("investigation_investigator_recommendations"."action_key", 1, 7) = 'sha256:'
          and substr("investigation_investigator_recommendations"."action_key", 8) not glob '*[^0-9a-f]*'),
	CONSTRAINT "investigator_recommendations_demo_check" CHECK("investigation_investigator_recommendations"."demo" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investigator_recommendations_basis_digest_unique` ON `investigation_investigator_recommendations` (`basis_digest`);--> statement-breakpoint
CREATE INDEX `investigator_recommendations_case_question_idx` ON `investigation_investigator_recommendations` (`case_id`,`question_ref`,`case_version`);--> statement-breakpoint
CREATE INDEX `investigator_recommendations_action_key_idx` ON `investigation_investigator_recommendations` (`case_id`,`question_ref`,`action_key`);