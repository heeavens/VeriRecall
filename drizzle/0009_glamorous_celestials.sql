CREATE TABLE `investigation_questions` (
	`question_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`subject_ref` text NOT NULL,
	`question_type` text NOT NULL,
	`origin_case_version` integer NOT NULL,
	`origin_material_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`demo` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_ref`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "investigation_questions_question_ref_check" CHECK(length(trim("investigation_questions"."question_ref")) > 0),
	CONSTRAINT "investigation_questions_question_type_check" CHECK("investigation_questions"."question_type" = 'AFFECTED_BATCH_LOT'),
	CONSTRAINT "investigation_questions_origin_case_version_check" CHECK("investigation_questions"."origin_case_version" > 0),
	CONSTRAINT "investigation_questions_origin_material_revision_check" CHECK("investigation_questions"."origin_material_revision" > 0),
	CONSTRAINT "investigation_questions_demo_check" CHECK("investigation_questions"."demo" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `investigation_questions_case_created_idx` ON `investigation_questions` (`case_id`,`created_at`);