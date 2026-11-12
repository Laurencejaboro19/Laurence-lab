-- Sextant schema. Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username    TEXT,
    chat_id     INTEGER,
    session     TEXT NOT NULL DEFAULT '{}',   -- small JSON blob: staged images, pending prompts
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL
);

-- Persistent context. Task-specific instructions live on research_tasks, never here.
CREATE TABLE IF NOT EXISTS user_context (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    category   TEXT NOT NULL,
    content    TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'user',  -- user | image | research
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_user ON user_context(user_id, active);

CREATE TABLE IF NOT EXISTS research_tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    chat_id       INTEGER NOT NULL,
    question      TEXT NOT NULL,
    task_context  TEXT NOT NULL DEFAULT '',   -- temporary, this task only
    fingerprint   TEXT NOT NULL,              -- hash(question + task context + images)
    status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED')),
    stage         TEXT NOT NULL DEFAULT '',
    depth         TEXT NOT NULL DEFAULT 'standard',
    origin        TEXT NOT NULL DEFAULT 'telegram',  -- telegram | schedule | fresh
    update_id     INTEGER,
    status_msg_id INTEGER,
    worker_id     TEXT,
    heartbeat_at  REAL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON research_tasks(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_fp ON research_tasks(user_id, fingerprint, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON research_tasks(status);
-- The database itself refuses a second in-flight task for the same request.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_active
    ON research_tasks(user_id, fingerprint) WHERE status IN ('PENDING','PROCESSING');

CREATE TABLE IF NOT EXISTS research_reports (
    task_id    INTEGER PRIMARY KEY REFERENCES research_tasks(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    summary    TEXT NOT NULL DEFAULT '',
    report_md  TEXT NOT NULL,
    meta       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_sources (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id      INTEGER NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
    num          INTEGER NOT NULL,            -- citation number [S<num>]
    url          TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    domain       TEXT NOT NULL DEFAULT '',
    provider     TEXT NOT NULL DEFAULT '',
    source_type  TEXT NOT NULL DEFAULT 'unknown',  -- primary | secondary | aggregator | unknown
    credibility  REAL NOT NULL DEFAULT 0,
    published    TEXT NOT NULL DEFAULT '',
    origin_group TEXT NOT NULL DEFAULT '',    -- sources sharing one are NOT independent
    evidence     TEXT NOT NULL DEFAULT '[]',  -- JSON list of extracted facts
    UNIQUE (task_id, url)
);
CREATE INDEX IF NOT EXISTS idx_sources_task ON research_sources(task_id, num);

CREATE TABLE IF NOT EXISTS research_images (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    telegram_file_id TEXT NOT NULL,
    file_unique_id   TEXT NOT NULL,
    sha256           TEXT NOT NULL DEFAULT '',
    mime             TEXT NOT NULL DEFAULT '',
    size_bytes       INTEGER NOT NULL DEFAULT 0,
    storage_path     TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'RECEIVED'
                     CHECK (status IN ('RECEIVED','ANALYSED','FAILED')),
    extracted_text   TEXT NOT NULL DEFAULT '',
    description      TEXT NOT NULL DEFAULT '{}',  -- structured JSON from the vision model
    provider         TEXT NOT NULL DEFAULT '',
    error            TEXT,
    uploaded_at      TEXT NOT NULL,
    UNIQUE (user_id, file_unique_id)
);
CREATE INDEX IF NOT EXISTS idx_images_sha ON research_images(user_id, sha256);

CREATE TABLE IF NOT EXISTS research_task_images (
    task_id  INTEGER NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
    image_id INTEGER NOT NULL REFERENCES research_images(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, image_id)
);

CREATE TABLE IF NOT EXISTS research_context_links (
    task_id    INTEGER NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
    context_id INTEGER NOT NULL,              -- kept even if the record is later deleted
    category   TEXT NOT NULL,
    content    TEXT NOT NULL,                 -- snapshot of what the research actually saw
    reason     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (task_id, context_id)
);

CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id   INTEGER PRIMARY KEY,
    received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                REAL NOT NULL,
    provider          TEXT NOT NULL,
    kind              TEXT NOT NULL,          -- text | vision | search
    model             TEXT NOT NULL DEFAULT '',
    task_id           INTEGER,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    ok                INTEGER NOT NULL DEFAULT 1,
    error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage ON usage_logs(provider, ts);

CREATE TABLE IF NOT EXISTS search_cache (
    cache_key  TEXT PRIMARY KEY,
    results    TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS page_cache (
    url        TEXT PRIMARY KEY,
    page       TEXT NOT NULL,
    fetched_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
    user_id   INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
    objective TEXT NOT NULL,
    run_time  TEXT NOT NULL DEFAULT '05:00',  -- HH:MM local to timezone
    timezone  TEXT NOT NULL DEFAULT 'Africa/Lagos',
    enabled   INTEGER NOT NULL DEFAULT 1
);

-- One row per user per local calendar day: the idempotency record for automation.
CREATE TABLE IF NOT EXISTS scheduled_runs (
    user_id    INTEGER NOT NULL,
    run_date   TEXT NOT NULL,
    task_id    INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, run_date)
);
