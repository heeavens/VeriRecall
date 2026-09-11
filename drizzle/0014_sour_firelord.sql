CREATE TABLE `investigation_challenge_establishments` (
	`establishment_ref` text PRIMARY KEY NOT NULL,
	`challenge_ref` text NOT NULL,
	FOREIGN KEY (`establishment_ref`) REFERENCES `investigation_establishments`(`establishment_ref`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`challenge_ref`) REFERENCES `investigation_challenges`(`challenge_ref`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `investigation_challenge_establishments_challenge_idx` ON `investigation_challenge_establishments` (`challenge_ref`);