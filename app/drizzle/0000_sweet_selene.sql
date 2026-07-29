CREATE TABLE "commits" (
	"repo_id" bigint NOT NULL,
	"sha" varchar NOT NULL,
	"author_name" varchar,
	"authored_at" timestamp,
	"message" varchar,
	"first_ingested_run_id" varchar NOT NULL,
	CONSTRAINT "commits_repo_id_sha_pk" PRIMARY KEY("repo_id","sha")
);
--> statement-breakpoint
CREATE TABLE "fetch_failures" (
	"run_id" varchar NOT NULL,
	"repo_id" bigint NOT NULL,
	"data_type" varchar NOT NULL,
	"error_message" varchar,
	"occurred_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fetch_watermarks" (
	"repo_id" bigint NOT NULL,
	"data_type" varchar NOT NULL,
	"last_fetched_at" timestamp NOT NULL,
	"last_success_run_id" varchar NOT NULL,
	CONSTRAINT "fetch_watermarks_repo_id_data_type_pk" PRIMARY KEY("repo_id","data_type")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"repo_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"title" varchar,
	"state" varchar,
	"created_at" timestamp,
	"closed_at" timestamp,
	"labels" text[],
	"last_updated_run_id" varchar NOT NULL,
	CONSTRAINT "issues_repo_id_number_pk" PRIMARY KEY("repo_id","number")
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"repo_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"title" varchar,
	"state" varchar,
	"created_at" timestamp,
	"merged_at" timestamp,
	"last_updated_run_id" varchar NOT NULL,
	CONSTRAINT "pull_requests_repo_id_number_pk" PRIMARY KEY("repo_id","number")
);
--> statement-breakpoint
CREATE TABLE "repo_assessments" (
	"assessment_id" bigserial PRIMARY KEY NOT NULL,
	"repo_id" bigint NOT NULL,
	"run_id" varchar NOT NULL,
	"input_hash" varchar NOT NULL,
	"pct" integer,
	"band" varchar,
	"label" varchar,
	"text" varchar,
	"gaps" text[],
	"input_snapshot" jsonb,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_discoveries" (
	"run_id" varchar NOT NULL,
	"repo_id" bigint NOT NULL,
	"seen_at" timestamp NOT NULL,
	CONSTRAINT "repo_discoveries_run_id_repo_id_pk" PRIMARY KEY("run_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"repo_id" bigint PRIMARY KEY NOT NULL,
	"full_name" varchar NOT NULL,
	"description" varchar,
	"html_url" varchar,
	"default_branch" varchar,
	"language" varchar,
	"stargazers_count" integer,
	"is_private" boolean,
	"is_fork" boolean,
	"is_archived" boolean,
	"is_ignored" boolean DEFAULT false NOT NULL,
	"ignore_source" varchar DEFAULT 'auto' NOT NULL,
	"assessment_source" varchar DEFAULT 'auto' NOT NULL,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"run_id" varchar PRIMARY KEY NOT NULL,
	"started_at" timestamp NOT NULL,
	"finished_at" timestamp,
	"status" varchar,
	"repos_discovered" integer,
	"repos_fetched_ok" integer,
	"repos_failed" integer,
	"llm_calls_made" integer,
	"llm_calls_skipped" integer
);
