CREATE TABLE `investigation_challenge_assessments` (
	`assessment_ref` text PRIMARY KEY NOT NULL,
	`challenge_ref` text NOT NULL,
	FOREIGN KEY (`assessment_ref`) REFERENCES `investigation_assessments`(`assessment_ref`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`challenge_ref`) REFERENCES `investigation_challenges`(`challenge_ref`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `investigation_challenge_assessments_challenge_idx` ON `investigation_challenge_assessments` (`challenge_ref`);--> statement-breakpoint
CREATE TABLE `investigation_challenge_claims` (
	`claim_ref` text PRIMARY KEY NOT NULL,
	`challenge_ref` text NOT NULL,
	FOREIGN KEY (`claim_ref`) REFERENCES `investigation_claims`(`claim_ref`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`challenge_ref`) REFERENCES `investigation_challenges`(`challenge_ref`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `investigation_challenge_claims_challenge_idx` ON `investigation_challenge_claims` (`challenge_ref`);--> statement-breakpoint
CREATE TABLE `investigation_challenge_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`challenge_ref` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `evidence_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`challenge_ref`) REFERENCES `investigation_challenges`(`challenge_ref`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `investigation_challenge_requests_challenge_idx` ON `investigation_challenge_requests` (`challenge_ref`);