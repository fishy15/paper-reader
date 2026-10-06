CREATE TABLE `papers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`authors` text NOT NULL,
	`year` integer,
	`abstract` text,
	`url` text,
	`external_id` text,
	`source` text NOT NULL,
	`pdf_path` text,
	`full_text` text,
	`summary` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "source_external_id" CHECK(("papers"."source" = 'search') = ("papers"."external_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `papers_external_id_unique` ON `papers` (`external_id`);--> statement-breakpoint
CREATE TABLE `qa_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`paper_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`paper_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade
);
