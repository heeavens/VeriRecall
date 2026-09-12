CREATE TABLE `alert_field_assertions` (
	`assertion_ref` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`source_observation_ref` text NOT NULL,
	`field_kind` text NOT NULL,
	`raw_value` text NOT NULL,
	`normalized_value` text NOT NULL,
	`origin_kind` text NOT NULL,
	`source_locator` text,
	`producer_identifier` text NOT NULL,
	`producer_version` text NOT NULL,
	`model_identifier` text,
	`basis_assertion_refs_json` text NOT NULL,
	`supporting_evidence_refs_json` text NOT NULL,
	`human_actor_identifier` text,
	`rationale` text,
	`semantic_digest` text NOT NULL,
	`created_at` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_observation_ref`) REFERENCES `alert_source_observations`(`observation_ref`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "alert_field_assertions_field_kind_check" CHECK("alert_field_assertions"."field_kind" in ('PRODUCT_NAME', 'BRAND', 'EAN_GTIN', 'BATCH_LOT', 'CATEGORY')),
	CONSTRAINT "alert_field_assertions_origin_kind_check" CHECK("alert_field_assertions"."origin_kind" in ('SOURCE_ASSERTED', 'DETERMINISTIC_DERIVED', 'AI_PROPOSAL', 'HUMAN_CONFIRMED', 'LEGACY_UNVERIFIED')),
	CONSTRAINT "alert_field_assertions_value_check" CHECK(length(trim("alert_field_assertions"."raw_value")) > 0 and length(trim("alert_field_assertions"."normalized_value")) > 0),
	CONSTRAINT "alert_field_assertions_producer_check" CHECK(length(trim("alert_field_assertions"."producer_identifier")) > 0
          and length(trim("alert_field_assertions"."producer_version")) > 0),
	CONSTRAINT "alert_field_assertions_origin_metadata_check" CHECK(("alert_field_assertions"."origin_kind" = 'SOURCE_ASSERTED'
            and "alert_field_assertions"."source_locator" is not null
            and "alert_field_assertions"."model_identifier" is null
            and "alert_field_assertions"."human_actor_identifier" is null)
          or ("alert_field_assertions"."origin_kind" = 'DETERMINISTIC_DERIVED'
            and ("alert_field_assertions"."source_locator" is not null or "alert_field_assertions"."basis_assertion_refs_json" <> '[]')
            and "alert_field_assertions"."model_identifier" is null
            and "alert_field_assertions"."human_actor_identifier" is null)
          or ("alert_field_assertions"."origin_kind" = 'AI_PROPOSAL'
            and "alert_field_assertions"."model_identifier" is not null
            and "alert_field_assertions"."human_actor_identifier" is null)
          or ("alert_field_assertions"."origin_kind" = 'HUMAN_CONFIRMED'
            and "alert_field_assertions"."model_identifier" is null
            and "alert_field_assertions"."human_actor_identifier" is not null
            and "alert_field_assertions"."rationale" is not null
            and "alert_field_assertions"."supporting_evidence_refs_json" <> '[]')
          or ("alert_field_assertions"."origin_kind" = 'LEGACY_UNVERIFIED'
            and "alert_field_assertions"."model_identifier" is null
            and "alert_field_assertions"."human_actor_identifier" is null)),
	CONSTRAINT "alert_field_assertions_semantic_digest_check" CHECK(length("alert_field_assertions"."semantic_digest") = 71
          and substr("alert_field_assertions"."semantic_digest", 1, 7) = 'sha256:'
          and substr("alert_field_assertions"."semantic_digest", 8) not glob '*[^0-9a-f]*'),
	CONSTRAINT "alert_field_assertions_demo_check" CHECK("alert_field_assertions"."demo" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_field_assertions_semantic_digest_unique` ON `alert_field_assertions` (`semantic_digest`);--> statement-breakpoint
CREATE INDEX `alert_field_assertions_alert_observation_idx` ON `alert_field_assertions` (`alert_id`,`source_observation_ref`);--> statement-breakpoint
CREATE TABLE `alert_match_bases` (
	`match_id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`source_observation_ref` text NOT NULL,
	`catalogue_product_snapshot_json` text NOT NULL,
	`matching_policy_identifier` text NOT NULL,
	`matching_policy_version` text NOT NULL,
	`discovery_assertion_refs_json` text NOT NULL,
	`authoritative_identity_assertion_refs_json` text NOT NULL,
	`authoritative_scope_assertion_refs_json` text NOT NULL,
	`explanation_origin` text NOT NULL,
	`explanation_generator_identifier` text NOT NULL,
	`explanation_generator_version` text NOT NULL,
	`explanation_model_identifier` text,
	`basis_digest` text NOT NULL,
	`created_at` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_observation_ref`) REFERENCES `alert_source_observations`(`observation_ref`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "alert_match_bases_catalogue_snapshot_check" CHECK(json_valid("alert_match_bases"."catalogue_product_snapshot_json")),
	CONSTRAINT "alert_match_bases_policy_check" CHECK(length(trim("alert_match_bases"."matching_policy_identifier")) > 0
          and length(trim("alert_match_bases"."matching_policy_version")) > 0),
	CONSTRAINT "alert_match_bases_explanation_origin_check" CHECK("alert_match_bases"."explanation_origin" in ('DETERMINISTIC', 'AI_GENERATED')),
	CONSTRAINT "alert_match_bases_explanation_metadata_check" CHECK(length(trim("alert_match_bases"."explanation_generator_identifier")) > 0
          and length(trim("alert_match_bases"."explanation_generator_version")) > 0
          and (("alert_match_bases"."explanation_origin" = 'DETERMINISTIC' and "alert_match_bases"."explanation_model_identifier" is null)
            or ("alert_match_bases"."explanation_origin" = 'AI_GENERATED' and "alert_match_bases"."explanation_model_identifier" is not null))),
	CONSTRAINT "alert_match_bases_digest_check" CHECK(length("alert_match_bases"."basis_digest") = 71
          and substr("alert_match_bases"."basis_digest", 1, 7) = 'sha256:'
          and substr("alert_match_bases"."basis_digest", 8) not glob '*[^0-9a-f]*'),
	CONSTRAINT "alert_match_bases_demo_check" CHECK("alert_match_bases"."demo" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `alert_match_bases_alert_observation_idx` ON `alert_match_bases` (`alert_id`,`source_observation_ref`);--> statement-breakpoint
CREATE TABLE `alert_source_observations` (
	`observation_ref` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`record_kind` text NOT NULL,
	`source` text NOT NULL,
	`provider` text NOT NULL,
	`source_reference` text NOT NULL,
	`source_url` text NOT NULL,
	`source_version_identifier` text NOT NULL,
	`predecessor_observation_ref` text,
	`payload_format` text NOT NULL,
	`raw_payload` text NOT NULL,
	`content_sha256` text NOT NULL,
	`published_at` text NOT NULL,
	`source_updated_at` text,
	`observed_at` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`predecessor_observation_ref`) REFERENCES `alert_source_observations`(`observation_ref`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "alert_source_observations_record_kind_check" CHECK("alert_source_observations"."record_kind" in ('RAW_SOURCE', 'LEGACY_SNAPSHOT')),
	CONSTRAINT "alert_source_observations_source_check" CHECK("alert_source_observations"."source" in ('safety_gate', 'rasff')),
	CONSTRAINT "alert_source_observations_nonblank_check" CHECK(length(trim("alert_source_observations"."provider")) > 0
          and length(trim("alert_source_observations"."source_reference")) > 0
          and length(trim("alert_source_observations"."source_url")) > 0
          and length(trim("alert_source_observations"."source_version_identifier")) > 0
          and length(trim("alert_source_observations"."payload_format")) > 0),
	CONSTRAINT "alert_source_observations_payload_size_check" CHECK(length("alert_source_observations"."raw_payload") between 1 and 262144),
	CONSTRAINT "alert_source_observations_content_sha256_check" CHECK(length("alert_source_observations"."content_sha256") = 64
          and "alert_source_observations"."content_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "alert_source_observations_not_self_parent_check" CHECK("alert_source_observations"."predecessor_observation_ref" is null
          or "alert_source_observations"."predecessor_observation_ref" <> "alert_source_observations"."observation_ref"),
	CONSTRAINT "alert_source_observations_demo_check" CHECK("alert_source_observations"."demo" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_source_observations_source_version_unique` ON `alert_source_observations` (`source`,`source_reference`,`source_version_identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `alert_source_observations_source_content_unique` ON `alert_source_observations` (`source`,`source_reference`,`content_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `alert_source_observations_predecessor_unique` ON `alert_source_observations` (`predecessor_observation_ref`);--> statement-breakpoint
CREATE INDEX `alert_source_observations_alert_idx` ON `alert_source_observations` (`alert_id`);
