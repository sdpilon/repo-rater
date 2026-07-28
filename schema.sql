-- DuckDB schema for the incremental, multi-repo tracker pipeline (design draft).
-- Bronze layer (raw API responses) stays as flat JSON files on disk, keyed by
-- (repo_id, run_id) — this file covers silver/gold/metadata only.

-- ============================================================
-- DIMENSION: repos (current state, upserted)
-- Keyed by GitHub's numeric id, not full_name — survives renames/transfers
-- ============================================================
CREATE TABLE repos (
    repo_id          BIGINT PRIMARY KEY,      -- GitHub's stable repo id
    full_name        VARCHAR NOT NULL,        -- 'owner/repo', can change
    description      VARCHAR,
    html_url         VARCHAR,
    default_branch   VARCHAR,
    language         VARCHAR,
    stargazers_count INTEGER,
    is_private       BOOLEAN,
    is_fork          BOOLEAN,
    is_archived      BOOLEAN,
    is_ignored       BOOLEAN NOT NULL DEFAULT false, -- skips enrichRepo(); see ignore_source
    ignore_source    VARCHAR NOT NULL DEFAULT 'auto', -- 'auto' (pipeline-computed default, recomputed each run) | 'manual' (user toggled, never overwritten)
    first_seen_at    TIMESTAMP NOT NULL,       -- first discovery run
    last_seen_at     TIMESTAMP NOT NULL        -- most recent discovery run
);

-- ============================================================
-- APPEND-ONLY: which repos existed at each discovery run
-- Lets you answer "when did repo X appear/get archived/disappear"
-- ============================================================
CREATE TABLE repo_discoveries (
    run_id     VARCHAR NOT NULL,
    repo_id    BIGINT NOT NULL,
    seen_at    TIMESTAMP NOT NULL,
    PRIMARY KEY (run_id, repo_id)
);

-- ============================================================
-- SILVER: normalized activity data, idempotent upsert by natural key
-- ============================================================
CREATE TABLE commits (
    repo_id           BIGINT NOT NULL,
    sha               VARCHAR NOT NULL,
    author_name       VARCHAR,
    authored_at       TIMESTAMP,
    message           VARCHAR,
    first_ingested_run_id VARCHAR NOT NULL,
    PRIMARY KEY (repo_id, sha)
);

CREATE TABLE issues (
    repo_id        BIGINT NOT NULL,
    number         INTEGER NOT NULL,
    title          VARCHAR,
    state          VARCHAR,
    created_at     TIMESTAMP,
    closed_at      TIMESTAMP,
    labels         VARCHAR[],
    last_updated_run_id VARCHAR NOT NULL,
    PRIMARY KEY (repo_id, number)
);

CREATE TABLE pull_requests (
    repo_id        BIGINT NOT NULL,
    number         INTEGER NOT NULL,
    title          VARCHAR,
    state          VARCHAR,
    created_at     TIMESTAMP,
    merged_at      TIMESTAMP,
    last_updated_run_id VARCHAR NOT NULL,
    PRIMARY KEY (repo_id, number)
);

-- ============================================================
-- Incremental extraction: per-repo, per-datatype watermark
-- Extraction stage reads last_fetched_at as its `since=` cursor
-- ============================================================
CREATE TABLE fetch_watermarks (
    repo_id          BIGINT NOT NULL,
    data_type        VARCHAR NOT NULL,   -- 'commits' | 'issues' | 'prs'
    last_fetched_at  TIMESTAMP NOT NULL,
    last_success_run_id VARCHAR NOT NULL,
    PRIMARY KEY (repo_id, data_type)
);

-- ============================================================
-- Dead-letter manifest: failures don't zero out a repo, they log here
-- ============================================================
CREATE TABLE fetch_failures (
    run_id        VARCHAR NOT NULL,
    repo_id       BIGINT NOT NULL,
    data_type     VARCHAR NOT NULL,
    error_message VARCHAR,
    occurred_at   TIMESTAMP NOT NULL
);

-- ============================================================
-- Append-only assessment history — never overwritten.
-- "Current" assessment for a repo = latest row by created_at.
-- input_hash gates whether enrichment re-runs the LLM at all.
-- ============================================================
CREATE SEQUENCE assessment_seq;

CREATE TABLE repo_assessments (
    assessment_id  BIGINT PRIMARY KEY DEFAULT nextval('assessment_seq'),
    repo_id        BIGINT NOT NULL,
    run_id         VARCHAR NOT NULL,
    input_hash     VARCHAR NOT NULL,   -- hash of the silver rows that fed this
    pct            INTEGER,
    band           VARCHAR,
    label          VARCHAR,
    text           VARCHAR,
    gaps           VARCHAR[],
    created_at     TIMESTAMP NOT NULL
);

-- ============================================================
-- Pipeline observability: one row per run, proves the incremental
-- logic is actually skipping work (llm_calls_skipped > 0 is the tell)
-- ============================================================
CREATE TABLE runs (
    run_id             VARCHAR PRIMARY KEY,
    started_at         TIMESTAMP NOT NULL,
    finished_at        TIMESTAMP,
    status             VARCHAR,   -- 'success' | 'partial' | 'failed'
    repos_discovered   INTEGER,
    repos_fetched_ok   INTEGER,
    repos_failed       INTEGER,
    llm_calls_made     INTEGER,
    llm_calls_skipped  INTEGER
);
