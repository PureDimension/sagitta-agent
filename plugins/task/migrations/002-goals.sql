-- 旧任务继续直属项目；只有显式设置 goal_id 才会进入目标。
DO $migration$
BEGIN
    PERFORM pg_advisory_xact_lock(724861, 1);
    IF (SELECT array_agg(version ORDER BY version) FROM schema_migrations) = ARRAY[1, 2] THEN
        RETURN;
    END IF;
    IF (SELECT array_agg(version ORDER BY version) FROM schema_migrations) IS DISTINCT FROM ARRAY[1] THEN
        RAISE EXCEPTION '目标迁移要求任务表结构版本为 1';
    END IF;

    CREATE TABLE goals (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES projects(id),
        title text NOT NULL CHECK (btrim(title) <> ''),
        description text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'open'
            CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
        deleted_at timestamptz,
        UNIQUE (project_id, id)
    );

    CREATE TABLE goal_claims (
        goal_id bigint PRIMARY KEY REFERENCES goals(id) ON DELETE CASCADE,
        claim_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        owner_device_id text NOT NULL CHECK (btrim(owner_device_id) <> ''),
        owner_session_id text NOT NULL CHECK (btrim(owner_session_id) <> ''),
        expires_at timestamptz NOT NULL
    );
    CREATE INDEX goal_claims_expiry_idx ON goal_claims(expires_at);
    CREATE INDEX goal_claims_owner_idx ON goal_claims(owner_device_id, owner_session_id);

    ALTER TABLE tasks ADD COLUMN goal_id bigint,
        ADD FOREIGN KEY (project_id, goal_id) REFERENCES goals(project_id, id);
    CREATE INDEX tasks_goal_idx ON tasks(goal_id, id) WHERE goal_id IS NOT NULL;

    INSERT INTO schema_migrations(version) VALUES (2);
END
$migration$;
