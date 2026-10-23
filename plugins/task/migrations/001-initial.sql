-- 由 psql 执行：初始化与版本记录一起提交，重复运行保留现有数据。
BEGIN;
SELECT pg_advisory_xact_lock(724861, 1);
SELECT to_regclass('public.schema_migrations') IS NULL AS initialize \gset
\if :initialize
CREATE TABLE schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (btrim(name) <> ''),
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamptz
);
CREATE TABLE tasks (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id),
    kind text NOT NULL CHECK (kind IN ('normal', 'temp')),
    title text NOT NULL CHECK (btrim(title) <> ''),
    description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamptz
);
-- 当前认领独立存储；任务物理删除时同时清除其认领。
CREATE TABLE task_claims (
    task_id bigint PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    claim_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    owner_device_id text NOT NULL CHECK (btrim(owner_device_id) <> ''),
    owner_session_id text NOT NULL CHECK (btrim(owner_session_id) <> ''),
    expires_at timestamptz NOT NULL
);
CREATE INDEX tasks_project_idx ON tasks(project_id, id);
CREATE INDEX claims_owner_idx ON task_claims(owner_device_id, owner_session_id);
CREATE INDEX claims_expiry_idx ON task_claims(expires_at);
INSERT INTO schema_migrations(version) VALUES (1);
\endif
COMMIT;
