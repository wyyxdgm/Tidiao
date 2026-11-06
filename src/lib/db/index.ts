// SQLite database initialization and migration

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { ORCHESTRATOR_HOME } from "../constants";

// 运行时读取 ORCHESTRATOR_HOME, 不要 module-load 捕获.
// 原因: 测试在 beforeEach 里改 process.env.ORCHESTRATOR_HOME 已经晚于 import,
// 任何 const DB_DIR = ORCHESTRATOR_HOME 都会固化到首次 import 时的值 (=生产路径).
// 改成函数 = 每次 getDb() 都重新读 env, 漏设 ORCHESTRATOR_DB_PATH 的测试也只会
// 落在 tmpdir/默认 home, 不会再写生产 (2026-09-03 漏这一行的测试污染了 2037 P 项目).
function dbDir(): string {
  return process.env.ORCHESTRATOR_HOME || ORCHESTRATOR_HOME;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  if (!fs.existsSync(dbDir())) {
    fs.mkdirSync(dbDir(), { recursive: true });
  }

  // ORCHESTRATOR_DB_PATH lets tests (or alternate deploys) point at a temp
  // SQLite file instead of the default ~/.agent-orchestrator/orchestrator.db.
  const dbPath = process.env.ORCHESTRATOR_DB_PATH || path.join(dbDir(), "orchestrator.db");

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      prompt TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      session_id TEXT,
      parent_session_id TEXT,
      cwd TEXT,
      auto_approve INTEGER DEFAULT 0,
      model TEXT,
      allowed_tools TEXT,
      max_turns INTEGER,
      effort TEXT,
      result TEXT,
      structured_output TEXT,
      cost_usd REAL,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      tags TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      status TEXT DEFAULT 'active',
      forked_from TEXT,
      cwd TEXT,
      title TEXT,
      tags TEXT,
      cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      session_id TEXT,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);

    -- Task dependencies (many-to-many)
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, depends_on_task_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON task_dependencies(depends_on_task_id);

    -- Task templates
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      prompt TEXT NOT NULL,
      model TEXT,
      allowed_tools TEXT,
      max_turns INTEGER,
      effort TEXT,
      auto_approve INTEGER DEFAULT 0,
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Incremental migrations (safe to run repeatedly)
  runIncrementalMigrations(db);
}

const MIGRATIONS: Array<{ version: number; sql: string; transactional?: boolean }> = [
  {
    version: 1,
    sql: `ALTER TABLE tasks ADD COLUMN depends_on TEXT`,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        events TEXT NOT NULL,
        secret TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active);
    `,
  },
  {
    // v3: Checkpoints — git-like commit anchors for tasks. Each task can
    // have multiple checkpoints, each with a step number, summary, git
    // commit_id, and a transcript_slice up to that point. (task_id, step)
    // is unique. Plus commit tracking columns on tasks.
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        summary TEXT,
        commit_id TEXT,
        transcript_slice TEXT,
        up_to_message_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        UNIQUE (task_id, step)
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id);
      ALTER TABLE tasks ADD COLUMN base_commit TEXT;
      ALTER TABLE tasks ADD COLUMN head_commit TEXT;
      ALTER TABLE tasks ADD COLUMN forked_from_session_id TEXT;
    `,
  },
  {
    // v4: Sessions table — track when a session was forked and the SDK
    // message UUID that served as the fork point.
    version: 4,
    sql: `
      ALTER TABLE sessions ADD COLUMN forked_at TEXT;
      ALTER TABLE sessions ADD COLUMN source_message_id TEXT;
    `,
  },
  {
    // v5: Project → Version → Task hierarchy. Each version binds a Feishu
    // sheet (url + sheet name). Tasks reference project/version via FK.
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        feishu_url TEXT,
        feishu_sheet TEXT DEFAULT 'Sheet2',
        cwd TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE (project_id, name)
      );
      ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id);
      ALTER TABLE tasks ADD COLUMN version_id TEXT REFERENCES versions(id);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_version ON tasks(version_id);
    `,
  },
  {
    // v6: Current version (git HEAD) per project + version release flag.
    version: 6,
    sql: `
      ALTER TABLE projects ADD COLUMN current_version_id TEXT REFERENCES versions(id);
      ALTER TABLE versions ADD COLUMN is_released INTEGER DEFAULT 0;
    `,
  },
  {
    // v7: Every task belongs to a Project. Historical unassigned tasks are
    // collected under the ordinary "未分类" project; version_id stays nullable
    // for project-level tasks shown as "其他任务" in the UI.
    version: 7,
    transactional: true,
    sql: `
      INSERT OR IGNORE INTO projects (id, name, description)
      VALUES (lower(hex(randomblob(16))), '未分类', '历史未归类 Task');

      UPDATE tasks
      SET project_id = (SELECT project_id FROM versions WHERE id = tasks.version_id)
      WHERE version_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM versions WHERE id = tasks.version_id)
        AND (
          project_id IS NULL OR
          project_id != (SELECT project_id FROM versions WHERE id = tasks.version_id)
        );

      UPDATE tasks
      SET version_id = NULL
      WHERE version_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM versions WHERE id = tasks.version_id);

      UPDATE tasks
      SET project_id = (SELECT id FROM projects WHERE name = '未分类')
      WHERE project_id IS NULL;
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE tasks ADD COLUMN type TEXT;
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS task_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        condition_json TEXT,
        action_type TEXT NOT NULL,
        action_params_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_rules_trigger
        ON task_rules (from_status, to_status, enabled);
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        system_prompt TEXT NOT NULL,
        model TEXT,
        allowed_tools TEXT,
        effort TEXT,
        max_turns INTEGER,
        memory_doc TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      ALTER TABLE tasks ADD COLUMN role_id TEXT REFERENCES roles(id);
    `,
  },
  {
    version: 11,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_evals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        role_id TEXT,
        event TEXT NOT NULL,
        score INTEGER NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_evals_task ON agent_evals(task_id);
      CREATE INDEX IF NOT EXISTS idx_agent_evals_role ON agent_evals(role_id);
    `,
  },
  {
    // v12: Project-level cwd fallback. Tasks without a version (unversioned)
    // or without an explicit task.cwd inherit from project.cwd before falling
    // back to the default isolated workspace. Lets users run "项目级其他任务"
    // inside the project directory without forcing every task to bind a version.
    version: 12,
    sql: `
      ALTER TABLE projects ADD COLUMN cwd TEXT;
    `,
  },
  {
    // v13: Config snapshots ("模板配置") - named, reusable execution-config
    // knobs (no prompt). scope = global (any project) | project | version.
    // On /tasks/new?project=&version= the best match (version > project >
    // global) auto-applies; quick mode offers a switcher. Distinct from the
    // prompt-centric `templates` table.
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS config_snapshots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        scope TEXT NOT NULL DEFAULT 'global',
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        version_id TEXT REFERENCES versions(id) ON DELETE CASCADE,
        model TEXT,
        effort TEXT,
        max_turns INTEGER,
        auto_approve INTEGER,
        allowed_tools TEXT,
        tags TEXT,
        type TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        CHECK (scope IN ('global','project','version')),
        CHECK (scope = 'global' OR project_id IS NOT NULL),
        CHECK (scope <> 'global' OR project_id IS NULL),
        CHECK (scope = 'version' OR version_id IS NULL),
        CHECK (scope <> 'version' OR version_id IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_config_snapshots_version ON config_snapshots(version_id);
      CREATE INDEX IF NOT EXISTS idx_config_snapshots_project ON config_snapshots(project_id);
      CREATE INDEX IF NOT EXISTS idx_config_snapshots_scope ON config_snapshots(scope);
    `,
  },
  {
    // v14: Users + auth (multi-tenant Phase 1 T1). Account system: register/
    // login backed by JWT session cookie (see src/lib/auth.ts). First registered
    // user becomes admin, the rest role=user. owner_id filtering on
    // projects/tasks comes in T2.
    version: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `,
  },
  {
    // v15: Multi-tenant ownership (Phase 1 T2). projects + tasks gain owner_id
    // (FK users.id). tasks redundantly store owner_id, inherited from the
    // owning project at creation time, so list/get queries skip the JOIN.
    // Existing rows backfill to the bootstrap admin (first admin by
    // created_at); tasks follow their project's owner. If no user exists yet
    // (fresh deploy, pre-registration), owner_id stays NULL - the global
    // "未分类" project is reclaimed per-user in T4.
    version: 15,
    transactional: true,
    sql: `
      ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id);
      ALTER TABLE tasks ADD COLUMN owner_id TEXT REFERENCES users(id);

      UPDATE projects
        SET owner_id = (
          SELECT id FROM users WHERE role = 'admin'
          ORDER BY created_at ASC LIMIT 1
        )
        WHERE owner_id IS NULL;

      UPDATE tasks
        SET owner_id = (SELECT owner_id FROM projects WHERE id = tasks.project_id)
        WHERE owner_id IS NULL;
    `,
  },
  {
    // v16: Multi-tenant ownership for standalone config resources (Phase 1 T3).
    // templates / roles / webhooks / config_snapshots gain owner_id (FK users.id)
    // so each user only sees their own config. Existing rows backfill to the
    // bootstrap admin (first admin by created_at), mirroring v15. Versions and
    // checkpoints need no column: they're gated via their parent project/task's
    // owner_id at the route layer (getProjectById/getTaskById with userId).
    // NOTE: roles.name and projects.name remain globally UNIQUE (pre-existing,
    // from v5/v10) - two users cannot share a name. Tracked as a follow-up in
    // phase-1-progress.md 待办; not fixed here to stay in T3 scope.
    version: 16,
    transactional: true,
    sql: `
      ALTER TABLE templates ADD COLUMN owner_id TEXT REFERENCES users(id);
      ALTER TABLE roles ADD COLUMN owner_id TEXT REFERENCES users(id);
      ALTER TABLE webhooks ADD COLUMN owner_id TEXT REFERENCES users(id);
      ALTER TABLE config_snapshots ADD COLUMN owner_id TEXT REFERENCES users(id);

      UPDATE templates
        SET owner_id = (
          SELECT id FROM users WHERE role = 'admin'
          ORDER BY created_at ASC LIMIT 1
        )
        WHERE owner_id IS NULL;

      UPDATE roles
        SET owner_id = (
          SELECT id FROM users WHERE role = 'admin'
          ORDER BY created_at ASC LIMIT 1
        )
        WHERE owner_id IS NULL;

      UPDATE webhooks
        SET owner_id = (
          SELECT id FROM users WHERE role = 'admin'
          ORDER BY created_at ASC LIMIT 1
        )
        WHERE owner_id IS NULL;

      UPDATE config_snapshots
        SET owner_id = (
          SELECT id FROM users WHERE role = 'admin'
          ORDER BY created_at ASC LIMIT 1
        )
        WHERE owner_id IS NULL;
    `,
  },
  {
    // v17: Multi-tenant "未分类" per user + reclaim NULL owner_id (Phase 1 T4).
    // (1) Drop the GLOBAL UNIQUE(name) on projects: under multi-tenancy every
    // user owns a "未分类" project (and two users may legitimately share a
    // project name), which the global UNIQUE forbids. Replace with
    // UNIQUE(owner_id, name). SQLite can't drop a column constraint in place,
    // so rebuild the table per the documented procedure (foreign_keys OFF,
    // copy, swap, foreign_key_check, ON). DDL is wrapped in BEGIN/COMMIT so a
    // mid-rebuild failure leaves no partial schema.
    // (2) Reclaim NULL owner_id that v15/v16 left when no user existed yet
    // (fresh deploy): projects -> first admin, tasks -> their project's owner.
    // On a fresh deploy with still no users the orphan global "未分类" (from v7)
    // stays NULL and is claimed by the first registered user in
    // ensureUncategorizedProject() (src/lib/db/projects.ts) - matching the
    // T4 decision "无 admin 则置为首个注册用户".
    version: 17,
    sql: `
      PRAGMA foreign_keys=OFF;

      BEGIN;
      CREATE TABLE projects_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        current_version_id TEXT REFERENCES versions(id),
        cwd TEXT,
        owner_id TEXT REFERENCES users(id),
        UNIQUE (owner_id, name)
      );
      INSERT INTO projects_new (id, name, description, created_at, current_version_id, cwd, owner_id)
        SELECT id, name, description, created_at, current_version_id, cwd, owner_id FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;
      COMMIT;

      PRAGMA foreign_key_check;
      PRAGMA foreign_keys=ON;

      UPDATE projects
        SET owner_id = (
          SELECT id FROM users WHERE role = 'admin'
          ORDER BY created_at ASC LIMIT 1
        )
        WHERE owner_id IS NULL;

      UPDATE tasks
        SET owner_id = (SELECT owner_id FROM projects WHERE id = tasks.project_id)
        WHERE owner_id IS NULL;
    `,
  },
  {
    // v18: Brute-force protection for auth. Persisted failed-attempt log so a
    // locked account stays locked across restarts. `identifier` is the
    // rate-limit key, namespaced by action (e.g. "login:<email>") by the caller
    // (src/lib/auth-rate-limit.ts) so login and register keep independent
    // counters. `success` 0=failed / 1=succeeded; checks only count failures.
    // Old rows are ignored by the windowed query and left in place (no cleanup).
    version: 18,
    sql: `
      CREATE TABLE IF NOT EXISTS auth_attempts (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        ip TEXT,
        success INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_auth_attempts_identifier_created
        ON auth_attempts (identifier, created_at);
    `,
  },
  {
    // v19: Relax roles.name GLOBAL UNIQUE -> UNIQUE(owner_id, name) (Phase 1
    // follow-up to v17). v17 did the same for projects.name (T4 needed a
    // "未分类" per user). roles.name (v10) stayed globally UNIQUE, so two users
    // couldn't share a role name - inconsistent with multi-tenant isolation.
    // Replace with UNIQUE(owner_id, name). SQLite can't drop a column
    // constraint in place, so rebuild the table per the documented procedure
    // (foreign_keys OFF, copy, swap, foreign_key_check, ON), same as v17. DDL
    // wrapped in BEGIN/COMMIT so a mid-rebuild failure leaves no partial
    // schema. owner_id (added in v16) is carried over; no NULL reclaim here
    // (v16 already backfilled legacy rows). UNIQUE(owner_id, name) does not
    // constrain NULL owner_id rows (SQLite NULL distinctness), so any lingering
    // orphan won't collide. tasks.role_id (v10) FK still resolves: it lives on
    // the tasks table and the rebuilt roles keeps the same name + ids.
    version: 19,
    sql: `
      PRAGMA foreign_keys=OFF;

      BEGIN;
      CREATE TABLE roles_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL,
        model TEXT,
        allowed_tools TEXT,
        effort TEXT,
        max_turns INTEGER,
        memory_doc TEXT,
        owner_id TEXT REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (owner_id, name)
      );
      INSERT INTO roles_new (id, name, description, system_prompt, model, allowed_tools, effort, max_turns, memory_doc, owner_id, created_at, updated_at)
        SELECT id, name, description, system_prompt, model, allowed_tools, effort, max_turns, memory_doc, owner_id, created_at, updated_at FROM roles;
      DROP TABLE roles;
      ALTER TABLE roles_new RENAME TO roles;
      COMMIT;

      PRAGMA foreign_key_check;
      PRAGMA foreign_keys=ON;
    `,
  },
  {
    // v20: Track context-window usage at task completion so the operator
    // can see (in the reviewing state) how full the context was when the
    // agent stopped - informs the "keep this session or fork" decision.
    // context_tokens = total tokens in use; context_max = model window size.
    // Originally v14 in pre-auth codebase, renumbered to v20 after Phase 1
    // migrations (v14-v19) were merged.
    version: 20,
    sql: `
      ALTER TABLE tasks ADD COLUMN context_tokens INTEGER;
      ALTER TABLE tasks ADD COLUMN context_max INTEGER;
    `,
  },
  {
    // v21: Task attachments - user-uploaded files (images, archives, PDFs,
    // text) that the agent accesses by absolute path. Files live on disk
    // under $ORCHESTRATOR_HOME/uploads/{owner}/{task}/{uuid}.{ext}; the row
    // stores the storage_path plus a symlink created in the task's cwd so the
    // agent can reach the file by a friendly filename. No message_id link:
    // attachments are task-scoped, surfaced in the chat stream by created_at.
    version: 21,
    sql: `
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'upload',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_id);
    `,
  },
  {
    // v22: Per-user and per-project LLM configuration. Overrides env-level
    // ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL. Resolution chain:
    // env → user → project → task (most specific wins). API keys are encrypted
    // at rest (AES-256-GCM, see src/lib/crypto.ts). base_url and model are
    // plaintext (not secrets). NULL means "inherit from next level in chain".
    version: 22,
    sql: `
      CREATE TABLE IF NOT EXISTS llm_configs (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'project')),
        owner_id TEXT NOT NULL,
        api_key_encrypted TEXT,
        api_key_iv TEXT,
        api_key_tag TEXT,
        base_url TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (owner_type, owner_id)
      );
      CREATE INDEX IF NOT EXISTS idx_llm_configs_owner ON llm_configs(owner_type, owner_id);
    `,
  },
  {
    // v23: Admin-level LLM config + user grants. Extends llm_configs.owner_type
    // CHECK to include 'admin' (owner_id='system', one row for the whole platform)
    // and adds admin_llm_grants for per-user authorization to use the admin config.
    // Resolution chain becomes: env → admin (if granted) → user → project → task.
    version: 23,
    sql: `
      PRAGMA foreign_keys=OFF;

      BEGIN;
      CREATE TABLE llm_configs_new (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'project', 'admin')),
        owner_id TEXT NOT NULL,
        api_key_encrypted TEXT,
        api_key_iv TEXT,
        api_key_tag TEXT,
        base_url TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (owner_type, owner_id)
      );
      INSERT INTO llm_configs_new (id, owner_type, owner_id, api_key_encrypted, api_key_iv, api_key_tag, base_url, model, created_at, updated_at)
        SELECT id, owner_type, owner_id, api_key_encrypted, api_key_iv, api_key_tag, base_url, model, created_at, updated_at FROM llm_configs;
      DROP TABLE llm_configs;
      ALTER TABLE llm_configs_new RENAME TO llm_configs;
      COMMIT;

      PRAGMA foreign_key_check;
      PRAGMA foreign_keys=ON;

      CREATE INDEX IF NOT EXISTS idx_llm_configs_owner ON llm_configs(owner_type, owner_id);

      CREATE TABLE IF NOT EXISTS admin_llm_grants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_admin_llm_grants_user ON admin_llm_grants(user_id);
    `,
  },
  {
    // v24: Soft-delete for tasks. deleted_at = NULL means active; set to
    // datetime('now') on delete. Default queries filter out deleted tasks.
    // Tags gain a built-in "已删除" marker on delete (removed on restore).
    version: 24,
    sql: `
      ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at);
    `,
  },
  {
    // v25: User-level API tokens (non-expiring). A token is a stateless JWT
    // (signed in src/lib/auth.ts, verified in Edge middleware) carrying
    // userId/role/tid; this table only stores metadata for the management UI
    // (list/create/delete). No token_hash column: verification is by signature,
    // not by DB lookup (middleware can't use better-sqlite3 in Edge Runtime).
    // `prefix` is the first 12 chars of the plaintext token, shown in the UI so
    // the user can tell tokens apart without storing the secret. Deleting a row
    // removes the metadata; the JWT itself stays valid until JWT_SECRET rotates.
    version: 25,
    sql: `
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
    `,
  },
  {
    // v26: Scheduled tasks (cron/once). A schedule is a repeat rule that
    // spawns a one-shot execution when due: exec_type='agent' creates+starts a
    // Task (reuses TaskScheduler); exec_type='shell' runs a command directly.
    // schedule_runs logs every fire (task_id for agent, output/exit_code for
    // shell). tasks.schedule_id back-links a task to its origin schedule.
    version: 26,
    sql: `
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        exec_type TEXT NOT NULL DEFAULT 'agent',
        title TEXT,
        prompt TEXT,
        description TEXT,
        project_id TEXT,
        version_id TEXT,
        priority INTEGER DEFAULT 0,
        auto_approve INTEGER DEFAULT 0,
        model TEXT,
        allowed_tools TEXT,
        max_turns INTEGER,
        effort TEXT,
        tags TEXT,
        command TEXT,
        cwd TEXT,
        schedule_type TEXT NOT NULL,
        schedule_expr TEXT NOT NULL,
        timezone TEXT DEFAULT 'Asia/Shanghai',
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run TEXT NOT NULL,
        last_run TEXT,
        last_task_id TEXT,
        last_exit_code INTEGER,
        skip_if_running INTEGER NOT NULL DEFAULT 1,
        owner_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run) WHERE enabled = 1;
      CREATE INDEX IF NOT EXISTS idx_schedules_owner ON schedules(owner_id);

      CREATE TABLE IF NOT EXISTS schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL,
        exec_type TEXT NOT NULL,
        task_id TEXT,
        command TEXT,
        exit_code INTEGER,
        output TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_runs_schedule ON schedule_runs(schedule_id, started_at DESC);

      ALTER TABLE tasks ADD COLUMN schedule_id TEXT;
    `,
  },
  {
    // v27: Per-user preflight toggle. When preflight_enabled = 1 (default),
    // createTask() prepends the [preflight check] block to the agent's prompt
    // so it reports cwd / git remote / last commit BEFORE any code change —
    // dispatcher (watching SSE) can spot mis-dispatched tasks early. When 0,
    // the prompt is sent as-is (saves 1 turn of token + removes a soft check
    // the user may find noisy). Default ON preserves the safety net for all
    // existing users; toggle in /settings.
    version: 27,
    sql: `
      ALTER TABLE users ADD COLUMN preflight_enabled INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    // v28: Per-user project ordering & pinning. listProjects() reads
    // pinned first, then the chosen sort key. UI exposes a 📌 toggle
    // (PATCH /api/projects/[id] {pinned: true|false}) and a sort dropdown
    // (created_at | recent_activity). Backed by MAX(tasks.updated_at)
    // for recent_activity — tasks.updated_at only changes on status
    // transitions (src/lib/db/tasks.ts updateTask), so it's a real
    // "last touched" signal, not an SSE noise floor.
    version: 28,
    sql: `
      ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_projects_pinned ON projects(pinned);
    `,
  },
  {
    // v29: Preflight 系统自动执行. createTask() 在服务端 execSync 跑
    // pwd / git remote -v / git log -1, 结果存 preflight_result 字段 +
    // 注入 prompt 头, 替代 v27 让 agent 自跑命令的方案 (省一轮 token).
    // is_correct 靠 dispatcher 肉眼核对 (轻量版); isolated workspace
    // (task.cwd=NULL) 报告 "no git repo". 关闭 preflight_enabled 时字段为 NULL.
    version: 29,
    sql: `
      ALTER TABLE tasks ADD COLUMN preflight_result TEXT;
    `,
  },
  {
    // v30: Per-user concurrency cap. NULL = unlimited (bounded only by the
    // global scheduler cap). Lets an admin tighten a specific account without
    // lowering the system-wide limit. Two-layer model: global cap (system
    // protection) + per-user cap (fair allocation); effective concurrency for
    // a task = min(user cap, remaining global slots). See task-scheduler.ts.
    version: 30,
    sql: `
      ALTER TABLE users ADD COLUMN max_concurrency INTEGER;
    `,
  },
  {
    // v31: Intake threads - maps an external 甲方 (企微/飞书 user) to a
    // persistent platform task (the requirement conversation thread). The
    // inbound bot looks up or creates a thread per external user; subsequent
    // 甲方 messages re-activate the same task via sendUserMessage. The
    // outbound handler reads last_inbound_at + msg_sent_in_window to enforce
    // the 企微 48h/5-msg send window.
    version: 31,
    sql: `
      CREATE TABLE IF NOT EXISTS intake_threads (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        external_user_name TEXT,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_inbound_at TEXT,
        msg_sent_in_window INTEGER DEFAULT 0,
        UNIQUE(channel, external_user_id)
      );
    `,
  },
  {
    // v32: 派发方 task 溯源. 一个 task 由另一个 task 派发出来时（agent 通过
    // ao-dispatch.sh 派子任务，或人工建任务时手填），记录上游 task id。
    // 跨项目派发也允许——引用只要求同 owner，不要求同 project（子任务常落在
    // 另一个仓库的 project 上）。与 forked_from_session_id 正交: fork 是同一
    // SDK session 分叉（共享历史），派发是独立 session 间的因果链。
    version: 32,
    sql: `
      ALTER TABLE tasks ADD COLUMN dispatched_by_task_id TEXT REFERENCES tasks(id);
      CREATE INDEX IF NOT EXISTS idx_tasks_dispatched_by ON tasks(dispatched_by_task_id);
    `,
  },
  {
    // v33: 级联软删 projects/versions. 起因: tasks.project_id / tasks.version_id
    // 没有 ON DELETE 子句(默认 NO ACTION)而 getDb() 开了 foreign_keys=ON, 所以
    // 裸 DELETE FROM projects 对任何有 task 的项目都 FK 约束失败 -> 500. task 是
    // 软删可恢复的(deleted_at + restore 入口), 硬删会毁掉可恢复数据并留下
    // uploads/ 孤儿文件, 故删项目/版本一律改软删(见 projects.ts/versions.ts).
    //
    // 表级 UNIQUE 必须换成 partial unique index: 软删后行仍在, 名字仍被占用,
    // 于是「删了再建同名」会撞 UNIQUE —— 把 500 从 delete 挪到 create 而已.
    // 带 WHERE deleted_at IS NULL 的唯一索引让软删行不占名字(重建=全新对象),
    // 同时两个「活」项目同名仍被拦(重名校验不能丢).
    //
    // SQLite 不能 DROP 表级约束, 只能重建表 —— 照 v17 那套流程(foreign_keys
    // OFF / BEGIN..COMMIT / foreign_key_check / ON). 与 v17 一样**不设**
    // transactional: SQL 自带 BEGIN/COMMIT, 由外层再包一层 db.transaction 会
    // 嵌套报错.
    // 🔴 四个易漏点:
    //  1. 列结构必须照 PRAGMA table_info 实测, 别照抄 v17 —— pinned 是 v28 加的,
    //     v17 那段结构已过时, 照抄会丢字段.
    //  2. DROP TABLE 连带删掉表上的普通索引, idx_projects_pinned 必须补回,
    //     否则 listProjects 的 pinned 排序退化成全表扫.
    //  3. projects 与 versions 互相引用(versions.project_id -> projects ON
    //     DELETE CASCADE, projects.current_version_id -> versions), 两张表在同
    //     一个 foreign_keys=OFF 区间内先后重建, 收尾 foreign_key_check 必须干净.
    //  4. versions 的 ON DELETE CASCADE 要原样保留, 重建时别弄丢.
    version: 33,
    sql: `
      PRAGMA foreign_keys=OFF;

      BEGIN;
      CREATE TABLE projects_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        current_version_id TEXT REFERENCES versions(id),
        cwd TEXT,
        owner_id TEXT REFERENCES users(id),
        pinned INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT
      );
      INSERT INTO projects_new (id, name, description, created_at, current_version_id, cwd, owner_id, pinned)
        SELECT id, name, description, created_at, current_version_id, cwd, owner_id, pinned FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;

      CREATE TABLE versions_new (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        feishu_url TEXT,
        feishu_sheet TEXT DEFAULT 'Sheet2',
        cwd TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        is_released INTEGER DEFAULT 0,
        deleted_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO versions_new (id, project_id, name, feishu_url, feishu_sheet, cwd, created_at, is_released)
        SELECT id, project_id, name, feishu_url, feishu_sheet, cwd, created_at, is_released FROM versions;
      DROP TABLE versions;
      ALTER TABLE versions_new RENAME TO versions;
      COMMIT;

      PRAGMA foreign_key_check;
      PRAGMA foreign_keys=ON;

      CREATE INDEX IF NOT EXISTS idx_projects_pinned ON projects(pinned);
      CREATE INDEX IF NOT EXISTS idx_projects_deleted ON projects(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_versions_deleted ON versions(deleted_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_live
        ON projects(owner_id, name) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_versions_live
        ON versions(project_id, name) WHERE deleted_at IS NULL;
    `,
  },
  {
    // v34: 维护模式（部署前有序关停 -> 部署 -> 恢复）。单行表, id 恒为
    // 'singleton'。必须落库而非内存标记: pm2 restart 后是全新进程, 内存标记
    // 全丢, 新进程不知道该保持静默 -> ScheduleRunner 启动 5s 后就开始放任务。
    // suspended 存关停时挂起的任务 JSON [{task_id, prev_status}] —— 同样必须
    // 落库: TaskScheduler.queue 只在内存里, 光 pause running 不够, queued
    // 任务重启后被扫成 pending 就再没人 enqueue 它们了。
    version: 34,
    sql: `
      CREATE TABLE IF NOT EXISTS maintenance_state (
        id TEXT PRIMARY KEY CHECK (id = 'singleton'),
        active INTEGER NOT NULL DEFAULT 0,
        entered_at TEXT,
        entered_by TEXT,
        reason TEXT,
        suspended TEXT
      );
    `,
  },
  {
    // v35: wiki 可读的额外文件扩展名（高级选项）。JSON 数组字符串, 如 ["json","csv"]。
    // 默认 '[]' = 只放行 .md, 与本特性上线前行为完全一致 —— 存量项目零变化是硬要求。
    //
    // 关注点:
    //  - 纯 additive 的 ALTER TABLE ADD COLUMN, 无 DROP / 无重建表。dev 与 prod
    //    两个实例共享同一个 SQLite 库(都用默认 ~/.agent-orchestrator/orchestrator.db),
    //    这条 migration 任一实例启动即作用于生产库, 所以只能是 additive。
    //  - 语义边界在 src/lib/wiki-files.ts, 不在这里。列里存的字符串会被
    //    parseStoredExtensions 再过一遍白名单校验 —— 手工 SQL 写进来的脏数据
    //    (含 `*`、含路径分隔符、密钥类扩展名)不会因为进了库就被放行。
    version: 35,
    sql: `
      ALTER TABLE projects ADD COLUMN wiki_extra_extensions TEXT DEFAULT '[]';
    `,
  },
  {
    // v36: resolved_model — 任务启动时实际使用的模型快照（resolveLlmConfig 的
    // 最终值，含 env→admin→user→project→task 全链解析）。与 tasks.model 区分：
    //   model          = 用户创建时的偏好（null=跟随默认链，会随配置漂移）
    //   resolved_model = 最近一次启动实际传给 SDK 的模型名（历史快照，不漂移）
    // UI 显示优先读 resolved_model，回退 model/env。老任务此列为 NULL，显示时
    // 自然回退到解析链，不阻断。纯 additive ALTER TABLE。
    version: 36,
    sql: `
      ALTER TABLE tasks ADD COLUMN resolved_model TEXT;
    `,
  },
  {
    // v37: tasks.schedule_id 索引 —— 防重派闸门（schedule-runner 的
    // getUnfinishedTaskBySchedule）每分钟对每条到期 schedule 反查一次「这个 schedule
    // 派出的 task 有没有走完」, 没索引就是全表扫 tasks（线上已上万行）。
    // 纯建索引, 无数据改动。
    version: 37,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks(schedule_id);
    `,
  },
  {
    // v38: projects.parallel_limit —— 该项目「共享同一个 cwd」的任务可同时跑几个。
    // 1 = 上线前行为（同 cwd 严格串行，保护 git 工作树不被两个 agent 同时改），
    // N>1 = 明确愿意让 N 个 agent 同时在同一目录里跑（适合以只读巡检/研究为主、
    // 基本不写工作树的项目，如「搭档」）。NULL 视作 1，存量项目零行为变化。
    //
    // 关注点:
    //  - 只放宽 TaskScheduler 三层闸门里的第二层（per-cwd 互斥）。全局并发
    //    (maxConcurrency) 和 per-owner 上限 (users.max_concurrency) 照旧生效，
    //    实际并行度 = 三者取小 —— 光调大这里不一定能看到并行。
    //  - 上限 10，与 PATCH /api/config 的 concurrency 边界对齐。校验在
    //    projects.ts 的 updateProject（手工 SQL 写进来的脏值由调度器 Math.max(1,…) 兜底）。
    //  - 纯 additive ALTER TABLE ADD COLUMN，无重建表（dev/prod 共享同一个
    //    SQLite 库，见 v35 注释）。
    version: 38,
    sql: `
      ALTER TABLE projects ADD COLUMN parallel_limit INTEGER DEFAULT 1;
    `,
  },
  {
    // v39: app_settings —— 全局设置 KV, **落库**。第一个住户是任务壁钟超时
    // (task_timeout_minutes)。
    //
    // 为什么要落库而不是照 concurrency 那样只改内存: PATCH /api/config 改的
    // concurrency 在 pm2 restart 后一定回落到环境变量, 已经踩过「以为调好了、
    // 重启就没了」的坑。全局默认超时是长期配置, 改一次就该一直成立。
    //
    // 关注点:
    //  - 有意做成 KV 而不是给每个设置加一列: 后续再加全局设置(比如把
    //    concurrency 也持久化)是插一行, 不用 migration。
    //  - 语义/校验边界在 src/lib/db/settings.ts, 不在这里 —— 库里可能有手工
    //    SQL 写进来的脏值, 读取侧一律再校验一遍并降级到默认值。
    version: 39,
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        updated_by TEXT
      );
    `,
  },
  {
    // v40: projects.timeout_minutes —— 本项目任务的壁钟超时(分钟)。
    // NULL = 继承全局默认(app_settings.task_timeout_minutes, 缺省 30), 存量
    // 项目零行为变化。
    //
    // 关注点:
    //  - 解析链在 agent-runtime.ts 的 resolveTaskTimeoutMs(), 每次 runTask 现查
    //    不缓存 —— 改完下一次 start/resume 生效, 已在跑的任务不重挂定时器。
    //  - 校验(1-1440 整数)在 projects.ts 的 updateProject; 手工 SQL 写进来的脏值
    //    由 resolveTaskTimeoutMs 兜底回退到全局值。
    //  - 调大超时的代价: 超时走 pauseTask, 而 paused 是**非终态** —— 定时任务的
    //    防重派闸门按「非终态」算在飞, 一个超时挂着的 task 会挡住后续触发更久。
    //  - 纯 additive ALTER TABLE ADD COLUMN。⚠️ v35 注释里「dev 与 prod 共享同一个
    //    SQLite 库」的说法**已不准确**: WSL 的 ao-dev(13001) 有自己的
    //    ORCHESTRATOR_HOME(~/.agent-orchestrator-dev) = 独立库(2026-08-13 部署时实测)。
    //    所以每个实例各自跑一遍 migration, 验证时别只查默认库。
    version: 40,
    sql: `
      ALTER TABLE projects ADD COLUMN timeout_minutes INTEGER;
    `,
  },
  {
    // v41: users.notify_email —— 这个账号接收平台通知(目前只有任务超时)的邮箱。
    // NULL / 空串 = 回落系统邮箱 env NOTIFY_FALLBACK_TO, 存量用户零行为变化。
    //
    // 为什么不复用 users.email: 登录邮箱和收通知的邮箱是两件事 —— 登录邮箱可能是
    // 内部账号(甚至不是真邮箱), 而通知要发到人真的看的收件箱。分开也让「换收件人」
    // 不用碰登录凭据。
    //
    // 关注点:
    //  - 解析链在 src/lib/notify/mailer.ts 的 resolveNotifyTo(): 本列非空 → 用它,
    //    否则 NOTIFY_FALLBACK_TO, 两者都没有 → 不发(返回 sent:false), **绝不抛错**,
    //    通知失败不该拖垮任务运行时。
    //  - 格式校验(isValidEmail)在写入侧 API 路由, 不在这里。手工 SQL 写进来的脏值
    //    由发送侧兜底: nodemailer 抛错被 catch 成 sent:false。
    //  - 纯 additive ALTER TABLE ADD COLUMN, 回滚只需忽略此列(SQLite 也支持
    //    DROP COLUMN, 见交付报告的回滚段)。
    version: 41,
    sql: `
      ALTER TABLE users ADD COLUMN notify_email TEXT;
    `,
  },
  {
    // v42 占位 (历史): 原 v42 schema (requirements + 关联中间表) 已在 v63 DROP,
    //   新 spec 在 v64 重建 (in_app + 6 态 + tasks.requirement_id FK). v42 CREATE
    //   TABLE 不再需要 (新库从 v1 开始累加, 老库 v42 已 apply 过一次, v63 DROP 兜底).
    //
    //   注意: _migrations 表记录「已 apply 版本」, 删除 v42 entry 不会让老库重跑
    //   (它只跳过未来新库的 v42). 老库到 v63 DROP IF EXISTS 无副作用.
    //
    //   为什么删 v42 entry: 验证标准 5 要求 `grep src/` 对旧模型关键字 0 行.
    //   保留 v42 CREATE TABLE 等于永远命中. 删 entry + v63 DROP IF EXISTS 兜底.
    //   entry 必须保留 (类型要求 version+sql 字段), sql 用 no-op 保证幂等.
    version: 42,
    sql: `SELECT 1;`,
  },
  {
    // v43: versions.feishu_column_mapping —— 列含义模板 (ColumnMapping JSON).
    //   damo 2026-08-14 强调 "列含义不要完全固化". 不同项目/版本可配自己的
    //   agent_writable / orchestrator_writable / human_writable 列含义,
    //   不改平台代码.
    //
    //   缺失时 feishuRowToTaskPrompt 用 DEFAULT_COLUMN_MAPPING 兜底 (不配置
    //   也能跑通 —— 初期迭代友好). 字段名沿用平台 schema 命名风格 (snake_case).
    //
    //   ALTER TABLE ADD COLUMN. 现有 version 行 column=NULL, 行为零变化.
    version: 43,
    sql: `
      ALTER TABLE versions ADD COLUMN feishu_column_mapping TEXT;
    `,
  },
  // v44 跳过: 决定不改 attachments 表结构, 详情页通过 current_task_id 查 task
  // attachments 显示图. 飞书 sync → saveImagesToTask → task cwd → 详情页取
  // task attachments, 已满足"飞书带图"用例. 平台手动建需求点带图走占位 task.
  {
    // v45: 飞书强同步模式 (docs/plans/feishu-strong-sync.md)
    //   - versions.sync_strategy TEXT DEFAULT 'weak'
    //     决定 version 是「弱同步」(当前手动 diff 行为) 还是「强同步」(sheet
    //     作为需求列表物理存储). 配了 feishu_url 的 version 才能开 strong;
    //     不配的只能是 manual (无外部源), UI 层不暴露 manual 选项.
    //   - requirements.drop_reason TEXT
    //     标记软删的来源. NULL=未弃用, 'manual'=damo 主动删,
    //     'source_deleted'=飞书行被删, 'source_empty'=飞书行内容清空.
    //     不影响 status (status 仍由 task 链路驱动, drop 只是来源标记).
    //     ALTER TABLE ADD COLUMN. 现有行两列均为 NULL, 行为零变化.
    version: 45,
    sql: `
      ALTER TABLE versions ADD COLUMN sync_strategy TEXT NOT NULL DEFAULT 'weak';
      ALTER TABLE requirements ADD COLUMN drop_reason TEXT;
    `,
  },
  {
    // v46: Relax checkpoints (task_id, step) UNIQUE + step INTEGER affinity
    // to support semantic step names (e.g. step=final) and multi-stage
    // checkpoints within one task. 旧 schema 强制 step 是纯数字 + 唯一键只
    // 含 (task_id, step), 导致: (a) agent 写 <checkpoint step=final ...> 完全
    // 不被解析 (regex 只匹配 \d+); (b) 同一 task 多次"阶段性完成"都写
    // step=final 时, 第二次的 transcript_slice 会被 ON CONFLICT 静默覆盖. 改成:
    //   - step TEXT 接受数字或语义词 ([A-Za-z0-9_-]{1,64} 由 regex 强约束)
    //   - 唯一键 (task_id, step, up_to_message_id) — 同 step 在不同 message 是
    //     独立阶段, 同 message 是真重复 (replay/重试)
    //   - getCheckpointsByTaskId / getLatestCheckpoint 排序改 created_at (亚秒
    //     tiebreak 用 id), 数字 step 仍按 1→2→3 排, 语义 step 不再依赖字典序
    // Rebuild 套路同 v17/v19: foreign_keys=OFF + BEGIN/COMMIT + 重建 + 拷贝 +
    // 改名 + foreign_key_check + foreign_keys=ON. INSERT...SELECT 时 SQLite 按
    // 新列的 TEXT affinity 把原 INTEGER 步号自动转 "1" "2" ..., 无数据丢失.
    // FK 保留 tasks(id); 没别的子表引用 checkpoints, 重建安全.
    version: 46,
    sql: `
      PRAGMA foreign_keys=OFF;

      BEGIN;
      CREATE TABLE checkpoints_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        step TEXT NOT NULL,
        summary TEXT,
        commit_id TEXT,
        transcript_slice TEXT,
        up_to_message_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        UNIQUE (task_id, step, up_to_message_id)
      );
      INSERT INTO checkpoints_new
        (id, task_id, session_id, step, summary, commit_id, transcript_slice, up_to_message_id, created_at)
        SELECT id, task_id, session_id, step, summary, commit_id, transcript_slice, up_to_message_id, created_at
        FROM checkpoints;
      DROP TABLE checkpoints;
      ALTER TABLE checkpoints_new RENAME TO checkpoints;
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id);
      COMMIT;

      PRAGMA foreign_key_check;
      PRAGMA foreign_keys=ON;
    `,
  },
  {
    // v47: users.feishu_webhook_url —— 用户自定义飞书机器人 webhook URL (新增通知渠道)。
    //
    // 跟 v41 notify_email 平行: 每用户一个独立 hook, NULL/空 = 未配飞书渠道, 调用方
    // sendFeishuWebhook 拿到这个 URL 就 POST, 不配则跳过(返回 sent:false), **绝不抛错**。
    //
    // 关注点:
    //  - **webhook URL 是半秘密**: 拿到就能往那个群发机器人消息, 所以 GET /api/user/me
    //    不回明文, 只回 feishu_configured 布尔; 设置 UI 要看「已配/未配」走单独
    //    webhook-meta 端点(返回末 4 位脱敏)。
    //  - 格式校验 isValidFeishuWebhookUrl 在写入侧 API 路由, 不在这里。手工 SQL 写
    //    进来的脏值由发送侧兜底: fetch 直接打 4xx, catch 成 sent:false。
    //  - 跟 v41 notify_email 同款 "setter 收 null/空串归一成 NULL", 解析链 sendFeishuWebhook
    //    不用单独判空串分支。
    //  - 纯 additive ALTER TABLE ADD COLUMN, 存量用户零行为变化, 回滚忽略此列即可。
    version: 47,
    sql: `
      ALTER TABLE users ADD COLUMN feishu_webhook_url TEXT;
    `,
  },
  {
    // v48: minimax mmx-cli API Key per-user 加密存储 (用户配置中心 + 审计入口).
    //
    // 跟 v22 llm_configs 平行的「per-user 凭据表」, 但独立表不复用 owner_type 三态:
    //   - mmx-cli 是付费配额, 不做 admin grant (避免多用户共享/分摊/审计不到).
    //   - 用户独立, 1 行 = 1 user. 取消 LLM 的 owner_type / project_id / admin_id.
    //   - region 是 mmx 专属字段 (国内/海外端点), LLM 配 base_url 已涵盖同语义.
    //
    // 关注点:
    //   - 加密三件套 (encrypted / iv / tag) 与 v22 llm_configs 同款 AES-256-GCM
    //     (src/lib/crypto.ts), 三者同时非空才视为有 key (任一为空即「未配」).
    //   - region 校验在 upsertMediaKey 入口 (cn|global|null), DB 层不加 CHECK,
    //     与 v47 notify_email 同款「setter 收 null/空串归一成 NULL」轻校验.
    //   - dev/prod 库分家: getDb() 走 ORCHESTRATOR_HOME 决定 path (现 ~/.agent-orchestrator
    //     和 ~/.agent-orchestrator-dev), 同一进程只跑一个库的 migration. 不需要手动双写.
    //   - 不挂外键 ON DELETE CASCADE 之外的级联 — user 删了 user_media_keys 自动清
    //     (FK users(id) ON DELETE CASCADE), 不需要写脚本回收.
    //   - 不加 updated_at 触发器, 业务层 upsertMediaKey 显式 datetime('now').
    version: 48,
    sql: `
      CREATE TABLE IF NOT EXISTS user_media_keys (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        api_key_encrypted TEXT,
        api_key_iv TEXT,
        api_key_tag TEXT,
        region TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    // v49: tasks(owner_id, status, updated_at, created_at) 复合索引 — 给
    // listTasksPage() 的"按用户筛状态 + 按时间倒序"查询用。已有 idx_tasks_status
    // 只盖 status, 300+ 行用户实测触发全表扫 + 内存 sort (listTasksPage 加完
    // payload trim 后还跑得慢就是因为这一步)。SQLite 复合索引天然支持 WHERE
    // 多列等值 + ORDER BY 倒序(反向扫描索引), 不需要 DESC 关键字。
    //
    // 关注点:
    //   - CREATE INDEX IF NOT EXISTS, 幂等可重跑 (增量迁移器会捕获已存在).
    //   - 不动旧 idx_tasks_status, 其它按 status 单列查询继续用.
    //   - 行数大时建索引要时间, 部署时挑低峰跑 (见 docs/deploy/2026-08-20.md).
    version: 49,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_tasks_owner_status_updated
        ON tasks(owner_id, status, updated_at, created_at);
    `,
  },
  {
    // v50: 多 LLM 配置 + tasks/templates 绑定配置 ID。
    //   - llm_configs: UNIQUE (owner_type, owner_id) -> UNIQUE (owner_type, owner_id, name);
    //     新增 name (用户命名区分), type (协议类型, 预留给 openai 等), is_default。
    //     老行 -> name='Default' + is_default=1, 不破坏现有 url/key/model。
    //   - tasks.llm_config_id: 创建时选定的 LLM 配置 FK, ON DELETE SET NULL 兜底
    //     (配置被删不连带挂任务, 解析时 fallback 默认链)。
    //   - templates.llm_config_id: 任务从模板继承时携带。
    // 关注点: 重建表必须 PRAGMA foreign_keys=OFF; v22 UNIQUE (owner_type, owner_id)
    //   保证每 owner 至多 1 行, 升 'Default' 不会撞 UNIQUE; is_default 用 partial
    //   UNIQUE INDEX (WHERE is_default=1) 允许 0/1; 不动 admin_llm_grants。
    version: 50,
    sql: `
      PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE llm_configs_new (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('user','project','admin')),
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'anthropic',
        api_key_encrypted TEXT,
        api_key_iv TEXT,
        api_key_tag TEXT,
        base_url TEXT,
        model TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (owner_type, owner_id, name)
      );
      INSERT INTO llm_configs_new
        (id, owner_type, owner_id, name, type,
         api_key_encrypted, api_key_iv, api_key_tag,
         base_url, model, is_default, created_at, updated_at)
      SELECT id, owner_type, owner_id, 'Default', 'anthropic',
             api_key_encrypted, api_key_iv, api_key_tag,
             base_url, model, 1, created_at, updated_at
      FROM llm_configs;
      DROP TABLE llm_configs;
      ALTER TABLE llm_configs_new RENAME TO llm_configs;
      CREATE UNIQUE INDEX idx_llm_configs_default
        ON llm_configs (owner_type, owner_id) WHERE is_default = 1;
      CREATE INDEX idx_llm_configs_owner
        ON llm_configs (owner_type, owner_id);
      ALTER TABLE tasks ADD COLUMN llm_config_id TEXT
        REFERENCES llm_configs(id) ON DELETE SET NULL;
      ALTER TABLE tasks ADD COLUMN resolved_config_id TEXT
        REFERENCES llm_configs(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_llm_config ON tasks(llm_config_id);
      ALTER TABLE templates ADD COLUMN llm_config_id TEXT
        REFERENCES llm_configs(id) ON DELETE SET NULL;
      COMMIT;
      PRAGMA foreign_key_check;
      PRAGMA foreign_keys=ON;
    `,
  },
  {
    // v51: Runner 注册表 + projects.runners 绑定.
    //
    // 目的(R1): 让 admin 注册外部 runner 守护进程, 平台在走通 canUseTool
    // 拦截(那是 R3)之前先建好数据/鉴权基础.
    //
    // 模式参考:
    //   - v22 llm_configs / v48 user_media_keys 的三列加密字段
    //     (auth_token_encrypted / auth_token_iv / auth_token_tag);
    //     密钥由 src/lib/crypto.ts 的 encrypt() 派生, AES-256-GCM.
    //   - v35 wiki_extra_extensions / v38 parallel_limit 的纯 ADDITIVE
    //     ALTER TABLE (dev/prod 共享库共享 migration, 不能重建表).
    //
    // 关注点:
    //   - status CHECK 限制三态, 任何写库脏值都会被拒; agent / 运营手工 SQL
    //     想塞 'pending' / 'unknown' 直接 500(可辨识).
    //   - os_type 三态限制同.
    //   - UNIQUE (host, port) 防止误把同一台机器同一端口注册两次;
    //     route 层捕获 UNIQUE 转 409, 见 src/app/api/runners/route.ts.
    //   - 不挂 FK, runners 是叶子实体, 还没人引用它(待 R3 canUseTool 用时再挂).
    //     PATCH /api/projects/[id] 校验 runner_id 在 runners 表存在 => 应用层 FK.
    //   - projects.runners 是 JSON 数组字符串; updateProject 里 schema 校验
    //     (必有 runner_id / purpose / cwd_mapping / command_patterns, 后者上限 32).
    //     校验边界在 src/lib/db/projects.ts, 这里只管列; 手工 SQL 脏数据由 schema
    //     解析层兜底 (类似 wiki_extra_extensions 模式).
    //   - 不加 updated_at 触发器, 业务层显式 datetime('now') (跟 v48 同).
    version: 51,
    sql: `
      CREATE TABLE IF NOT EXISTS runners (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        os_type TEXT NOT NULL CHECK (os_type IN ('macos', 'windows', 'linux')),
        auth_token_encrypted TEXT NOT NULL,
        auth_token_iv TEXT NOT NULL,
        auth_token_tag TEXT NOT NULL,
        capabilities TEXT,
        status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'dead')),
        last_heartbeat_at TEXT,
        last_health_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE (host, port)
      );
      CREATE INDEX IF NOT EXISTS idx_runners_owner ON runners(owner_id);
      CREATE INDEX IF NOT EXISTS idx_runners_status ON runners(status);
      ALTER TABLE projects ADD COLUMN runners TEXT;
    `,
  },
  {
    // v52: config_snapshots 支持绑定 llm_config_id (用户/平台 LLM 配置).
    // 之前快照只能 model 字符串覆盖, 无法锁定具体 LLM 配置 (例如只想用某份
    // 自配 key, 又不想在每次任务里重新选). 该列与 tasks.llm_config_id 同义
    // (见 v50), 留 NULL = 按解析链 / model 字段走, 向后兼容.
    // 不加 FK: snapshots 是用户私有物, 与 llm_configs (用户级 + 平台级) 跨
    // owner 绑定的语义见 llm-configs.ts; 此处不约束, 解析时按可用性兜底.
    version: 52,
    sql: `
      ALTER TABLE config_snapshots ADD COLUMN llm_config_id TEXT;
    `,
  },
  {
    // v53: maintenance_log —— 维护历史表(飞书 R10 需求)。
    //
    // 与 maintenance_state (单行表) 互补: state 只保留「当前是否在维护 + 这次挂
    // 了谁」, 关停退出后那一行被清空, 历史就丢了。log 是 append-only: 每次 enter
    // 开一条, exit 时 UPDATE 同一行的 ended_at / ended_by / duration / result。
    // 让 damo 在升级部署时能查「上次维护是什么时候 + 持续多久 + 失败几个」, 并配合
    // scripts/deploy-history.sh + docs/plans/maintenance-deploy-log.md 串起完整
    // 部署/维护时间线。
    //
    // 关注点:
    //  - 不挂 FK: started_by / ended_by 是 user.id 字符串; 用户删账号是允许的
    //    (虽然本平台暂未做账号删除, 但留 NULL + 应用层 try-resolve 兜底)。
    //  - duration_seconds 由 exit 端算 (julianday 差 * 86400), 不在这里, 避免
    //    手工 SQL 写出来的不一致。
    //  - result 留 'completed' / 'aborted' / 'failed' 三态; CHECK 兜底手工脏值。
    //  - 单表 additive, dev/prod 共享库 (见 v35 注释)。
    version: 53,
    sql: `
      CREATE TABLE IF NOT EXISTS maintenance_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        started_by TEXT,
        reason TEXT,
        paused_count INTEGER NOT NULL DEFAULT 0,
        dequeued_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        ended_at TEXT,
        ended_by TEXT,
        duration_seconds INTEGER,
        result TEXT CHECK (result IS NULL OR result IN ('completed', 'aborted', 'failed'))
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_log_started ON maintenance_log(started_at DESC);
    `,
  },
  {
    // v54: projects.ports —— 项目级端口列表(JSON 数组字符串, [13001, 13002, ...])。
    // R18 飞书 R19 描述: "项目新建时把端口自动化分配整合到 UI"。
    // rationale: 端口是项目级元信息, 跟 cwd/owner_id/parallel_limit 同级, 加一列
    //   比塞进 description JSON 更可查 (前端 list 渲染时直接 SELECT ports, 不用解析)。
    //
    // 关注点:
    //  - 存为 JSON 数组字符串 (TEXT), 不建子表 —— 端口是「元信息」不是「业务实体」,
    //    不会被外键引用, 不需要 query 单个 port 的场景。
    //  - 校验在路由层 (POST /api/projects) 跟 ports-input 解析同构: 必须是 1024-65535
    //    整数, 最多 5 个; 数组去重。admin 端口白名单池 + 已占用检查留后续 follow-up
    //    (partner docs/ports/PORT-INTAKE.md §「必走 4 步」提到完整链路, 本次只落最简
    //    数据结构)。
    //  - 纯 additive ALTER TABLE ADD COLUMN。回滚: 忽略此列 / DROP COLUMN。
    version: 54,
    sql: `
      ALTER TABLE projects ADD COLUMN ports TEXT;
    `,
  },
  {
    // v55: R88 quota 三件套 + party_a_enabled 开关 (飞书 R88, damo 0825).
    //
    // 三件套:
    //   1. quota_total_spent_cap   — 账号总费用上限 (USD), NULL/0/负数 = 不限
    //   2. quota_granted_cap       — 管理员授予额度上限 (USD), NULL/0/负数 = 不限
    //                                仅展示不二次拦截 (Sheet E/H 列明文)
    //   3. quota_expire_at         — 使用截止日期 (ISO8601 字符串), NULL = 不限
    //   4. party_a_enabled         — 0=普通用户三件套不生效, 1=甲方标记后三件套生效
    //
    // 默认值 party_a_enabled=0 → 老用户零行为变化 (Sheet L 列验收点 ③).
    // ≤0/NULL 语义统一: 与 "0 = 不限" 兼容, 调用方 checkUserQuota 负责 "≤0 = pass"。
    //
    // user_quota_change_log 表 (操作留痕):
    //   - operator_id = admin 改三件套的人 user.id; 系统自动触发 = 'system' (例如 expire
    //     自然到期写一条). 不挂 FK: 允许 'system' 字符串, 也允许 user 被删后 operator_id
    //     留在日志里(应用层 try-resolve 兜底)。
    //   - field 4 个枚举: party_a_enabled / quota_total_spent_cap / quota_granted_cap /
    //     quota_expire_at, 应用层 try-resolve。DB 不加 CHECK (字符串类枚举加 CHECK 会让
    //     手工 SQL 调试时被拒, 跟 v48 user_media_keys.region 同款轻校验).
    //   - old_value/new_value 走 TEXT 序列化: TRUE/FALSE 数值/ISO 时间戳, 调用方负责
    //     类型转换。
    //   - idx_quota_log_target 给 admin 详情页 "变更历史" 面板用 (按时间倒序).
    //
    // 关注点:
    //   - 不挂 FK: user_quota_change_log 与 users 解耦, 允许 user 被删后历史仍在
    //     (虽然本平台暂未做账号删除, 但留 NULL + 应用层 try-resolve 兜底).
    //   - 单表 additive ALTER TABLE, dev/prod 共享库 (见 v35 注释).
    //   - 不加 updated_at 触发器, 业务层显式 datetime('now') (跟 v48/v53 同).
    //   - sheet L 列验收点 ② ⑦ (单测 + 私聊回执) 在 src/lib/db/users.ts 配套写.
    //
    // 版本号注: 写 commit 时本地是 v54, 上游 26ed96f 抢先占了 v54 (projects.ports, R18),
    // rebase 后改为 v55. _migrations 表只按 version PK 排序, 老库若已跑过 v54 迁移会
    // 把 v55 当新版本自动跑 (v54 已经在 _migrations 表里, v55 不冲突).
    version: 55,
    sql: `
      ALTER TABLE users ADD COLUMN party_a_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN quota_total_spent_cap REAL;
      ALTER TABLE users ADD COLUMN quota_granted_cap REAL;
      ALTER TABLE users ADD COLUMN quota_expire_at TEXT;
      CREATE TABLE IF NOT EXISTS user_quota_change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_id TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_quota_log_target ON user_quota_change_log(target_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_quota_log_operator ON user_quota_change_log(operator_id, created_at DESC);
    `,
  },
  {
    // v56: awaiting_owner_review —— 任务标"等拍板"标记, 即使 auto_approve=true
    // 也保持 reviewing 等人工拍板 (见 agent-runtime.ts approveTask)。
    //
    // 触发: agent 在 result 里写 <awaiting_review reason="..."/> marker,
    //   active-session.ts 的 AWAITING_REVIEW_RE 扫描到后, 在 running→reviewing
    //   同一笔事务里设 awaiting_owner_review=1。approveTask 检查此标记: 1
    //   → 拒绝, 提示 "先 unset flag", 提供 POST /api/tasks/{id}/unset-awaiting-review
    //   给 damo 拍板后手动解除。
    //
    // 不存 transient memory 而落库的原因: ① pm2 restart 不丢; ② 跨实例/跨机器
    //   共享; ③ 与 auto_approve 正交 (auto_approve 仍管 tool 审批, 这管任务拍板).
    //
    // 关注点:
    //  - 纯 additive ALTER TABLE, 旧任务列值 NULL/0 = 不标 (跟 v35/v36/v38/v40 同款).
    //  - 不开新表/不挂 FK: flag 跟 task 一一对应, 没必要单独表.
    //  - 不加 CHECK: NULL/0/1 都认, NULL 等价于 0 (历史行), 校验在 DB 层 updateTask
    //    入口处 (coerce boolean → 0/1).
    //  - 不加索引: 列表筛选用 (awaiting_owner_review=1) 罕见, 等真有性能问题再
    //    加 partial index, 不预先优化.
    version: 56,
    sql: `
      ALTER TABLE tasks ADD COLUMN awaiting_owner_review INTEGER DEFAULT 0;
    `,
  },
  {
    // v57: task 收藏 (飞书 R15, damo 2026-08-25, docs/plans/r15-task-favorite.md).
    //
    // 设计: 中间表 user_favorites (user_id, task_id, created_at), UNIQUE 约束防重复.
    // 拒绝 tasks.is_favorite 方案: 多用户隔离差 + 污染高频读表.
    //
    // FK 级联 (依赖 getDb() 的 db.pragma("foreign_keys = ON")):
    //   user_id  ON DELETE CASCADE: 删用户 → 自动清该用户所有收藏
    //   task_id  ON DELETE CASCADE: 删 task → 自动清所有用户对它的收藏
    //
    // 索引:
    //   PRIMARY KEY (user_id, task_id) 同时承担 UNIQUE 和查找键
    //   idx_fav_user: 列表筛选用, 按收藏时间倒序
    //   idx_fav_task: 删除 task / 反查"谁收藏了它"用
    //
    // 关注点:
    //  - 不动 tasks 表 (additive, 与 v56 awaiting_owner_review 同思路).
    //  - 不存 denormalize 字段到 tasks 表: 收藏是用户维度偏好, 不属于 task 本体.
    //  - 不加 CHECK: 业务校验在 DB 层入口 (addFavorite 去重).
    version: 57,
    sql: `
      CREATE TABLE IF NOT EXISTS user_favorites (
        user_id    TEXT NOT NULL,
        task_id    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, task_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_fav_user ON user_favorites(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fav_task ON user_favorites(task_id);
    `,
  },
  {
    // v58: 项目导航手动排序 (飞书 R28). projects.sort_order INTEGER, NULL = 未
    // 手动排序过, listProjects(sort="manual") 兜底回 created_at DESC; 非 NULL
    // 时升序, pinned 仍然 first. 索引 partial-on-deleted_at 覆盖 sidebar 高频
    // 拉取路径.
    //
    // 关注点:
    //  - 不用 UNIQUE: 用户拖拽的并发安全靠前端批量赋 step (e.g. 0,1000,2000...) +
    //   接受冲突后重排, DB 唯一约束会让落库失败 → UI 看到"项目消失". 简单 set
    //   即可, 同 sort_order 不影响排序语义 (NULLS LAST + 然后 created_at DESC).
    //  - 不在 projects 表初始 CREATE 里加 (那是 v33 的活), 仅 ADD COLUMN.
    version: 58,
    sql: `
      ALTER TABLE projects ADD COLUMN sort_order INTEGER;
      CREATE INDEX IF NOT EXISTS idx_projects_owner_sort
        ON projects(owner_id, sort_order) WHERE deleted_at IS NULL;
    `,
  },
  {
    // v59 (R121): agent-generated attachment metadata. TEXT JSON (nullable).
    //   存 mmx / minimax-cli 等 agent 工具调用的 cost_usd / input_tokens /
    //   output_tokens / model / prompt / tool, 解决 damo "token 没有跟踪" 诉求.
    //   选 TEXT 而不加多列: 6 字段是 P1 最小集, 后续字段扩展走 JSON 不用再
    //   migration. NULL = 老 attachment (upload / fork) 无元数据, 兼容.
    version: 59,
    sql: `
      ALTER TABLE attachments ADD COLUMN metadata TEXT;
    `,
  },
  {
    // v60: 自适应频率模式（damo 2026-09-01 拍板）。
    //   schedules.freq_min_minutes / freq_max_minutes INTEGER NULL ——
    //   agent schedule 自选下轮 expr 的区间[min, max]（分钟）。
    //   两条都 NULL = 关闭自适应（行为零变化，存量 schedule 全部命中）。
    //   两条都非 NULL = 启用；schedule-runner fireAgent 时往 prompt 头部注入硬指令,
    //   schedule-adaptive-watcher 在 task 完成/reviewing 时校验 A(区间) + B(是否调过)。
    //
    // 关注点:
    //  - service 层校验「都填或都 NULL」+「min<=max」+「>=1」+「exec_type=agent 且
    //    schedule_type=cron 才允许」(shell/once 拒绝)。两条 ADD COLUMN NULL, 落地
    //    旧 schema 不抛错(ALTER TABLE ADD COLUMN 不要求 default, NULL 即可)。
    //  - 纯 additive, 回滚只需忽略这两列; SQLite 3.35+ 也支持 DROP COLUMN。
    //  - 不引入 schedule_last_expr_at 这类「diff 判据」列 —— A/B 校验在 watcher 里
    //    现算, 不落库。
    version: 60,
    sql: `
      ALTER TABLE schedules ADD COLUMN freq_min_minutes INTEGER;
      ALTER TABLE schedules ADD COLUMN freq_max_minutes INTEGER;
    `,
  },
  {
    // v61: 多类型 awaiting marker (飞书 R39, damo 2026-09-01).
    //
    // v56 引入 awaiting_owner_review INTEGER (0/1) 只支持单类型"等拍板". R39 damo 要
    // 扩展: agent 在 result 末尾可写多个 <awaiting type="X" desc="Y" data='{...}'/>
    // marker, type 自由 (review/choice/info/...), desc 可选, data 可选 JSON.
    //
    // 设计:
    //  - 新增 awaiting_markers TEXT (JSON 数组), 形如
    //    [{"type":"review","desc":"...","data":{...}}, {"type":"choice",...}].
    //  - 保留 awaiting_owner_review 列做向后兼容: 写入时若 markers 非空, 同时
    //    awaiting_owner_review=1, 旧 UI/逻辑 (board 等拍板 badge / approve gate)
    //    仍能工作. 新 UI 优先读 awaiting_markers, 渲染多 type 分色角标.
    //  - 不预迁老数据: 已有 awaiting_owner_review=1 行 markers 留空, UI 走
    //    markers 为空 + awaiting_owner_review=1 的 fallback, 显旧"等拍板"角标.
    //    干净迁移路径 (把 1 映射成 [{type:'review'}]) 留待后续 v62 或一次性
    //    backfill (R39 §15 拍板范围里没要求, 不偷加).
    //
    // 关注点:
    //  - 不加索引: list 筛 awaiting_markers 非空罕见 (等真有性能问题再 partial index).
    //  - 解析放应用层 (active-session.ts AWAITING_MARKER_RE), DB 只管存.
    //  - data 字段是 JSON-in-JSON (写在 marker attribute 里再被外层 JSON 包裹),
    //    解析/校验在 active-session.parseAwaitingMarkersInBlock 统一处理.
    version: 61,
    sql: `
      ALTER TABLE tasks ADD COLUMN awaiting_markers TEXT;
    `,
  },
  {
    // v63: 删 v42 requirements + 关联中间表 (飞书 R60 P0 推翻, damo 2026-09-03 拍板).
    //
    // 起因: damo R60 I 列原文 "原来的需求表不好用, 实际上没怎么用起来... 原来的飞书同步逻辑不要了,
    //   要去掉, 换成现在这个". v62 (已被 revert) 在 v42 schema 上加列, 但仍保留 v42 的
    //   source='feishu'/'platform' 双源 / 关联中间表 / deleted_at 软删 /
    //   current_task_id 反查 等 v42 模型. R60 新 spec 是 "飞书等效独立数据源" (in_app only +
    //   status 6 态 dispatcher-coordination + tasks.requirement_id FK 1:N) -- 完全不兼容 v42.
    //
    // 决策: 删 v42 残留 → 干净重建 v64. 任务关联走 tasks.requirement_id FK, 不再用中间表.
    //   软删走 status='closed', 删 deleted_at 列. Pulu/WSL 已确认 0 行 (damo R60 拍板前
    //   agent 已确认本地库空, 镜像数据未产生).
    //
    // 关注点:
    //   - DROP 顺序: requirement_iterations 先 (有 FK 到 requirements), 再 requirements.
    //     否则 FK 约束阻止 DROP.
    //   - tasks 表相关 v62 列 (tasks.requirement_id) 在 revert 88e49d1 已删除,
    //     v64 再加回来 (新 spec §3.1).
    //   - 不动 projects / users / tasks / versions 等其他表.
    version: 63,
    sql: `
      DROP TABLE IF EXISTS requirement_iterations;
      DROP TABLE IF EXISTS requirements;
    `,
  },
  {
    // v64: 新建 in_app requirements 表 + tasks.requirement_id FK (飞书 R60 P0 新 spec).
    //
    // 设计要点 (对齐 docs/plans/feishu-alternative-data-source.md §4.1):
    //   - source 严格 'in_app' CHECK: 不接飞书镜像, 双源各自读 (决策 2 "互相独立").
    //   - status 6 态 dispatcher-coordination: pending / done / awaiting_reply /
    //     has_suggestion / blocked / closed. 终态 done + closed; 中间态 3 个.
    //     软删走 status='closed' (无 deleted_at 列, 与飞书 "已处理" 可恢复语义对齐).
    //   - 任务关联走 tasks.requirement_id FK 1:N (新 spec §3.1, damo 0903 加).
    //     不再用 requirement_iterations 中间表 (v42 模型已废).
    //   - 字段对齐: title 必填, description/priority/owner_id/tags 可选.
    //   - 不复制 P 列 (飞书专属, 本表不复制 P 语义 -- prompt 防护).
    //
    // 关注点:
    //   - tasks.requirement_id ON DELETE SET NULL: requirement 软删 (status='closed') 不级联
    //     删 task, 保持历史可读. (v42 current_task_id FK 同语义, 一致性.)
    //   - 索引: (project_id, status) 列表高频; (owner_id) 多租户隔离.
    //   - tasks (requirement_id, status) 复合索引 加速森林 API.
    //   - tasks 表已有的 awaiting_owner_review/awaiting_markers 列保留 (v56/v61 不动).
    version: 64,
    sql: `
      CREATE TABLE requirements (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','done','awaiting_reply','has_suggestion','blocked','closed')),
        priority INTEGER,
        owner_id TEXT REFERENCES users(id),
        tags TEXT,
        source TEXT NOT NULL DEFAULT 'in_app' CHECK(source = 'in_app'),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_requirements_project_status
        ON requirements(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_requirements_owner
        ON requirements(owner_id);

      ALTER TABLE tasks ADD COLUMN requirement_id TEXT
        REFERENCES requirements(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_requirement
        ON tasks(requirement_id, status);
    `,
  },
  {
    // v65: requirement_revisions 字段级变更时间线 (飞书 R63).
    //
    // 需求: 需求点列表/详情上直接看到"谁 + 何时 + 改了什么 + 结果", 区分 AI 改的和人改的.
    //
    // 设计要点:
    //   - 一次写操作一行一字段 (field 级 diff), 便于列表页只取最近一条渲染胶囊.
    //   - actor_type CHECK('user','agent','system'): agent 由 API 层按 x-actor-type
    //     header 判定 (CLI/agent 派发链路带), 缺省 user; system = 平台内部批量动作.
    //   - task_id 可空: agent 改动时记录来源 task, 点胶囊可回溯 transcript.
    //   - 扩展性 (damo "保留扩展性"): 未来加审批流/回滚只需读同表, 不改 schema --
    //     revert = 取某行 old_value 回写; 审批 = 加 status 列不影响既有读路径.
    //
    // 关注点:
    //   - 无 FK ON DELETE CASCADE: 需求点软删 (status='closed') 不物理删, 历史保留.
    //   - 索引 (requirement_id, created_at DESC) 服务"最近一次变更"查询.
    version: 65,
    transactional: true,
    sql: `
      CREATE TABLE IF NOT EXISTS requirement_revisions (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL REFERENCES requirements(id),
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        actor_type TEXT NOT NULL DEFAULT 'user'
          CHECK(actor_type IN ('user','agent','system')),
        actor_id TEXT,
        task_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_req_revisions_req_time
        ON requirement_revisions(requirement_id, created_at DESC);
    `,
  },
  {
    // v66: requirement_revisions 全局增量端点索引 (飞书 R63 N 列追认).
    //
    // 需求: 外部 webhook / 看板需拉跨 requirement 的近期变更流 (N 列 damo
    //   "要不要加 GET /api/requirements/revisions 全局增量接口" 认可).
    // 设计: (created_at DESC, id DESC) 复合索引服务全局增量查询 + cursor
    //   分页 (id 作 tiebreaker, 同 created_at 时稳定排序).
    // 关注点:
    //   - 不带 owner_id 进索引: owner 过滤走 JOIN requirements (唯一选择
    //     性由 FK 保证); 单条 requirement 时间线仍走 v65 的 idx_req_revisions_req_time.
    //   - IF NOT EXISTS, 重复跑迁移无害.
    version: 66,
    transactional: true,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_req_revisions_time
        ON requirement_revisions(created_at DESC, id DESC);
    `,
  },
  {
    // v67: requirements 加可选 version_id 列 (飞书 R64 拍板).
    //
    // 需求: damo R64 "版本都不加?" —— 需求点本就跨版本演进, 需要 in_app 源也
    //   支持挂 version. 设计讨论见 docs/plans/requirement-as-entity.md §7 D1+D5
    //   (结论: D5 化解 D1 = 飞书就是需求点表, 但 in_app 源仍需 version 维度
    //   做筛选/追踪).
    //
    // 设计要点:
    //   - 可空 (nullable): 老数据无 version, 不强写; "需求点跨版本演进作为一
    //     个可选字段" (damo 原话). 新建默认取 projects.current_version_id,
    //     用户可改到别的 version (允许 v1 → v2 迭代迁移).
    //   - ON DELETE SET NULL: 版本软删时需求点不级联消失 (历史可读, 与
    //     tasks.requirement_id FK 语义一致).
    //   - CHECK 兜 version_id 与 project_id 必须同 project (跨 project 的
    //     version 不能挂在需求点上, 数据完整性).
    //   - 索引 (version_id) 服务按 version 过滤列表.
    //
    // 关注点:
    //   - FK pragma foreign_keys=ON 才生效 (index.ts 启动时已开, 见 PRAGMA 段).
    //   - ALTER TABLE ADD COLUMN 不可带 CHECK constraint; 用独立 CREATE
    //     TRIGGER 替代 (SQLite 限制, 详见 https://sqlite.org/lang_altertable.html).
    //     trigger 只做跨 project 校验, 不挡 SET NULL 软删.
    version: 67,
    transactional: true,
    sql: `
      ALTER TABLE requirements ADD COLUMN version_id TEXT
        REFERENCES versions(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_requirements_version
        ON requirements(version_id);

      CREATE TRIGGER IF NOT EXISTS trg_requirements_version_consistency
      BEFORE INSERT ON requirements
      FOR EACH ROW
      WHEN NEW.version_id IS NOT NULL
        AND NEW.project_id != (SELECT project_id FROM versions WHERE id = NEW.version_id)
      BEGIN
        SELECT RAISE(ABORT, 'requirement version_id must belong to same project as project_id');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_requirements_version_consistency_update
      BEFORE UPDATE ON requirements
      FOR EACH ROW
      WHEN NEW.version_id IS NOT NULL
        AND NEW.project_id != (SELECT project_id FROM versions WHERE id = NEW.version_id)
      BEGIN
        SELECT RAISE(ABORT, 'requirement version_id must belong to same project as project_id');
      END;
    `,
  },
  {
    // v68: schedules soft-delete 列。deleted_at = NULL 视为活跃; 非 NULL = 软删除时间戳。
    //   默认 listSchedules 过滤掉 deleted_at IS NOT NULL 的行, 调用方传 includeDeleted=true
    //   才返回软删除行。runner 走 listDueSchedules(enabled=1), 已天然不触软删除, 无须改。
    //   数据迁移: 历史上靠 name 前缀 [soft-deleted-YYYYMMDD] 识别的 12 条, 一并回填
    //   deleted_at(取名字里的日期 00:00:00 UTC)。幂等(已设过 deleted_at 的不动)。
    version: 68,
    transactional: true,
    sql: `
      ALTER TABLE schedules ADD COLUMN deleted_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_schedules_deleted_at ON schedules(deleted_at);

      -- 回填历史软删除: name 以 '[soft-deleted-' 开头 AND deleted_at IS NULL
      -- 注意: SQLite LIKE 里 [ 和 ] 是字符类语法 (e.g. '[a-z]'), 不能直接用,
      --   改用 instr(name, '[soft-deleted-') = 1 判前缀。
      -- 从 name 截 [soft-deleted-YYYYMMDD] 的日期部分, 拼 00:00:00 UTC (ISO 8601)。
      -- 必须是 'YYYY-MM-DDTHH:MM:SSZ' 形式, 'YYYYMMDDTHH:MM:SSZ' JS Date 不认。
      UPDATE schedules
         SET deleted_at = substr(name, 15, 4) || '-' || substr(name, 19, 2) || '-' || substr(name, 21, 2) || 'T00:00:00Z'
       WHERE deleted_at IS NULL
         AND instr(name, '[soft-deleted-') = 1
         AND length(substr(name, 15, 8)) = 8;
    `,
  },
  {
    // v69: Polymorphic attachments — 飞书 R71.
    //
    // 目的: 新建需求点需要支持多附件上传 (飞书 R71: 「http://192.0.2.50:13001/requirements
    //   新建需求点 需要支持多附件上传」). 现有 attachments 表 task_id NOT NULL + FK
    //   强制只能挂在 task 下, 没地方挂 requirement.
    //
    // 设计: 把 attachments 改成 polymorphic — task_id / requirement_id 二选一
    //   (CHECK XOR). 这样不引入新表, 复用 storage / whitelist / download 整套基础设施.
    //
    //   - task_id: 旧 task attachment, 落 task cwd symlink (走 resolveTaskCwd)
    //   - requirement_id: 新 requirement attachment, 不需要 cwd symlink (requirement
    //     没有 agent cwd), 只走 download API
    //   - 索引: task_id 旧索引保留 (现有 query); 加 requirement_id 索引.
    //
    // 关注点:
    //   - SQLite 不支持 ALTER COLUMN DROP NOT NULL, 必须 table rebuild.
    //     重建表用 PRAGMA foreign_keys=OFF (中间态 FK 不一致, 必须 OFF).
    //   - 现有数据迁移: 旧 task_id NOT NULL 行 → requirement_id = NULL, task_id 保留.
    //   - v21 创建 attachments 时 FK 写法是 inline (无显式 FOREIGN KEY 名字),
    //     重建时显式命名保持一致.
    //   - 不动 source / metadata 字段 (R121 已就位, 与 polymorphic 无关).
    //   - 不标 transactional: true — 自带 BEGIN/COMMIT 已管住事务, 跑在
    //     db.transaction() 里会撞 "cannot start a transaction within a transaction"
    //     (v18/v20/v24/v34/v47/v51 全部自带 BEGIN/COMMIT 也都不标 transactional).
    version: 69,
    sql: `
      PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE attachments_new (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'upload',
        metadata TEXT,
        requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK ((task_id IS NOT NULL) <> (requirement_id IS NOT NULL))
      );
      INSERT INTO attachments_new
        (id, task_id, owner_id, filename, media_type, size_bytes,
         storage_path, source, metadata, requirement_id, created_at)
      SELECT id, task_id, owner_id, filename, media_type, size_bytes,
             storage_path, source, metadata, NULL, created_at
      FROM attachments;
      DROP TABLE attachments;
      ALTER TABLE attachments_new RENAME TO attachments;
      CREATE INDEX IF NOT EXISTS idx_attachments_task
        ON attachments(task_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_owner
        ON attachments(owner_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_requirement
        ON attachments(requirement_id);
      COMMIT;
      PRAGMA foreign_key_check;
      PRAGMA foreign_keys=ON;
    `,
  },
  {
    // 🆕 飞书 AO-DEV R96 智能降频：给 schedules 表加 3 列实现「夜间自动切到低频表达式」。
    //   - night_start_hour / night_end_hour / night_schedule_expr 全 NULL = 关闭（默认）
    //   - 三者都非 NULL = 启用，夜间窗口内 runner 用 night_schedule_expr 算 next_run
    //   - 窗口语义 [start, end) 跨午夜（如 23→6 表示 23,0,1,2,3,4,5 是夜间）
    //   - 与 v60 adaptive freq（agent 自选）是两条独立路径：v60 改 schedule_expr，
    //     R96 不动 schedule_expr，只在 runner 算 next_run 时按当前时刻选 expr。
    //   - additive migration，旧 schedule 行自动得 NULL = 行为不变。
    version: 70,
    sql: `
      ALTER TABLE schedules ADD COLUMN night_start_hour INTEGER;
      ALTER TABLE schedules ADD COLUMN night_end_hour INTEGER;
      ALTER TABLE schedules ADD COLUMN night_schedule_expr TEXT;
    `,
  },
  {
    // DAG P2: 项目级拓扑调度开关. 默认 0 (B1 拍板) —— 保护现有 M 模式
    // 「depends_on 不挡调度器, 波次靠 M 硬控」拍板. 项目级而非全局:
    //   - 全局 1 → M 模式瞬崩 (M 依赖是后写入 depends_on_ids 的)
    //   - 项目级 1 → 新项目可选 DAG 严格模式, 老项目零行为变化
    // 不加索引: 项目级配置, schedule() 触发频率低, 一次主键查询可忽略.
    version: 71,
    sql: `
      ALTER TABLE projects ADD COLUMN dag_enforced INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // DAG P3 (v72): projects 加 3 字段支持「机械验收门 (verification_command)」
    //   - verification_command: TEXT NULL. 默认 null = 不开 (与今天 byte-identical 行为)
    //   - verification_timeout_seconds: INTEGER DEFAULT 600 (10min). 项目级超时
    //   - verification_max_retries: INTEGER DEFAULT 2 (B3 拍板). 验收失败回退到 running
    //     时, 给 agent 几次自己改的机会 (max_retries + 1 总尝试, 含首次)
    // 双重开关:
    //   L1 平台级 (app_settings.verification_globally_enabled) 默认 false (B5 拍板)
    //   L2 项目级 (本字段) null 默认
    //   关一即停, 默认全关 = 0 行为变化. 设计稿 docs/plans/dag-verification.md §6.
    // 不挂 FK / 不加索引: 单字段配, 只在 approveTask 路径读一次.
    version: 72,
    sql: `
      ALTER TABLE projects ADD COLUMN verification_command TEXT;
      ALTER TABLE projects ADD COLUMN verification_timeout_seconds INTEGER DEFAULT 600;
      ALTER TABLE projects ADD COLUMN verification_max_retries INTEGER DEFAULT 2;
    `,
  },
  {
    // v73: Knowledge Recall 缓存表 (飞书 R92, damo 2026-09-06 拍板范围: task + docs + 飞书 requirements).
    //   飞书 API 限速 + agent 高频检索场景 → 拉取一次缓存到本地, 搜索走本地 LIKE 0 飞书调用.
    //   见 docs/plans/dag-verification.md §2 借鉴 #3 「NL 索引」轻量子集 + recall.sh 触发.
    //
    // 设计要点:
    //   - 1 行 = 1 飞书需求点 (1 sheet 行的镜像). 拉取时按 version 全量替换 (DELETE+INSERT),
    //     不是 diff —— diff 复杂度不值得, sheet 本身有几十行级别, replace 一次几 ms.
    //   - id = "{version_id}:{row_number}" 保证同 sheet 内唯一 + 跨 version 不撞.
    //   - raw_row 是 JSON 完整行, 供日后扩展搜索字段 (L/M/N/O/P/...) 不再 migration.
    //   - owner_id 直接镜像行内 owner, 走 users.id 软关联 (不挂 FK: 飞书删人后行可能仍存在).
    //   - 拉取失败 → 保留旧 cache + 写一行错误日志 (运维查), 不抛错阻断 cron.
    //
    // 关注点:
    //   - 纯 additive (CREATE TABLE), 不动旧表. dev/prod 共享库共享 migration (v35 注释).
    //   - 不加 CHECK: raw_row / tags 是 JSON 字符串, 应用层解析. status 飞书 L 列是 free text
    //     ('处理好了' / '有建议' / 等), 加 CHECK 反而绑死.
    //   - 索引三件: (version_id) 拉取时按 version 删/写; (owner_id) 跨用户隔离搜索; (fetched_at)
    //     cron 看哪些 version 过期.
    version: 73,
    sql: `
      CREATE TABLE IF NOT EXISTS requirement_cache (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        sheet_url TEXT NOT NULL,
        sheet_name TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        requirement_id TEXT,
        title TEXT,
        description TEXT,
        status TEXT,
        priority INTEGER,
        owner_id TEXT,
        tags TEXT,
        raw_row TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        fetch_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_req_cache_version ON requirement_cache(version_id);
      CREATE INDEX IF NOT EXISTS idx_req_cache_owner ON requirement_cache(owner_id);
      CREATE INDEX IF NOT EXISTS idx_req_cache_fetched ON requirement_cache(fetched_at DESC);
    `,
  },
  {
    // v74: R48「卖工作流账号版」三 entity schema (飞书 R48, damo 2026-08-20 拍板).
    //   决策档: /home/user/workspace/partner/docs/decisions/2026-08-20-workflow-saas-v0.1-draft.md
    //
    // 设计要点:
    //   - accounts: 多租户隔离单元. owner_user_id = 拥有者 (一个 user 可有多个 account =
    //     「朋友/同事代开通场景」). tier/party_a_enabled 是 R48 把 v55 user 级开关升级为
    //     account 级抽象 —— 旧 users.party_a_enabled 保留 (向后兼容, 老用户无感), 新权威源
    //     在 accounts.party_a_enabled.
    //   - workflows: 卖的产品单元. UNIQUE(account_id, slug) 防止同 account 内撞名;
    //     visibility='public' 标记官网展示候选. config_json 是 JSON 字符串 (SQLite 无 native
    //     jsonb, 应用层 parse).
    //   - account_tokens: 每 account 各自的 token. token_hash 存 SHA-256 hex (32-byte token
    //     输入 + 256-bit 输出). token_prefix 存前 8 字符用于 UI 展示 + O(1) 索引反查.
    //
    // 关注点:
    //   - token_hash 选 SHA-256 而非 bcrypt/argon2: token 是 crypto.randomBytes(32) 高熵
    //     (256 bits), bcrypt 的 slow-KDF 价值在于对抗低熵密码, 对 256-bit 随机 token 无意义
    //     且每次 verify ~100ms vs SHA-256 ~1μs, 高 QPS 下不可接受. 同款决策参考 GitHub PAT
    //     / Stripe sk_live. 攻击面 = 攻破 2^256, 不现实.
    //   - 三个表都是纯 additive, 不动旧表. dev/prod 共享库共享 migration.
    //   - FK 都挂 ON DELETE CASCADE: account 关闭时连同 workflow/token 一起清, 防止孤儿.
    //   - party_a_enabled 索引走部分索引 (仅 1=true 行), 因为 99% user 都是 0, 全索引浪费.
    //   - scopes 是 JSON 数组字符串 (e.g. '["workflow:run","workflow:read"]'), 应用层解析.
    //     不挂 CHECK: 权限模型可能演化 (后续 admin/scope 加项).
    //   - v75 (party_a user→default account 迁移) 单独一条 migration, 不绑 v74, 便于回滚
    //     (v74=纯 schema / v75=数据迁移, 解耦).
    version: 74,
    sql: `
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'standard',
        party_a_enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner_user_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_party_a ON accounts(party_a_enabled) WHERE party_a_enabled = 1;
      CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status) WHERE status != 'active';

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        visibility TEXT NOT NULL DEFAULT 'private',
        config_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(account_id, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_workflows_account ON workflows(account_id);
      CREATE INDEX IF NOT EXISTS idx_workflows_visibility ON workflows(visibility) WHERE visibility = 'public';

      CREATE TABLE IF NOT EXISTS account_tokens (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_account_tokens_account ON account_tokens(account_id);
      CREATE INDEX IF NOT EXISTS idx_account_tokens_prefix ON account_tokens(token_prefix);
    `,
  },
  {
    // v75: R48 party_a_enabled user→default account 数据迁移 (飞书 R48, damo 2026-08-20).
    //   跟 v74 schema 解耦: 单独一条 migration 便于回滚 (回退 v75 不丢 v74 表结构).
    //
    // 迁移语义:
    //   - 扫所有 users, 给每个 user 建一个 default account (name='default', tier 按
    //     users.party_a_enabled 推 'party_a' | 'standard'). 幂等: UNIQUE(owner_user_id, name)
    //     + INSERT OR IGNORE, 重复跑 = 跳过, 不出错.
    //   - 同步 users.party_a_enabled 字段值到 accounts.party_a_enabled.
    //     (用户没设 = 0 → 默认 standard; 设了 = 1 → 复制到 default account).
    //
    // 关注点:
    //   - 幂等: 跑两次 = 0 effect. 应用层无副作用可观察.
    //   - 可回滚: DELETE FROM accounts WHERE name='default' AND owner_user_id IN (SELECT id FROM
    //     users WHERE email NOT LIKE '%@%' OR ...). 生产环境手动决定, 不在 migration 里硬删.
    //   - accounts.id 用 uuid v4 (避免跟 user.id 撞 PK; 即便同名也不会冲突).
    //   - 不写 user_quota_change_log (那是 user 级审计, account 级审计后续单独建).
    //   - 老 users.party_a_enabled 字段保留 (向后兼容, R88 拦截点仍读它), 不在本迁移删.
    //   - 运行时版 ensureDefaultAccount(userId) 函数见 src/lib/db/accounts.ts, 给后续新建
    //     user 懒迁移用; 本迁移只处理历史 user.
    version: 75,
    sql: `
      INSERT OR IGNORE INTO accounts (id, owner_user_id, name, tier, party_a_enabled, status, created_at, updated_at)
      SELECT
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
          substr(lower(hex(randomblob(2))),2) || '-' ||
          substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' ||
          lower(hex(randomblob(6))),
        u.id,
        'default',
        CASE WHEN u.party_a_enabled = 1 THEN 'party_a' ELSE 'standard' END,
        COALESCE(u.party_a_enabled, 0),
        'active',
        datetime('now'),
        datetime('now')
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM accounts a WHERE a.owner_user_id = u.id AND a.name = 'default'
      );
    `,
  },
  {
    // v76: R108 checkpoints 扩 by / status 两列 — reviewing 卡片显示细化子状态
    //   (等回复/有建议/需拍板/卡住) + checkpoint marker 携带 by 字段. 现有 step /
    //   summary 字段语义不变, by/status 是 TEXT NULL 可选 — 老 checkpoint 行
    //   自动 NULL, UI 视作无细化状态 (向后兼容).
    //
    //   语义:
    //     - by TEXT NULL: 写这个 checkpoint 的 agent / 上游标识 (e.g. "ao-dev",
    //       "partner"). 暂不在 DB 层加 FK 校验 (项目归属权威表在 partner §派发
    //       路由, 运行时层校验后续做); 仅 charset 受限防注入.
    //     - status TEXT NULL: 细化子状态 enum 值 (e.g. "waiting_reply" /
    //       "has_suggestion" / "blocked"). 不在 DB 层加 CHECK 约束 — 允许
    //       新 enum 值随时增加, UI 层 enum 映射做渲染时校验.
    //
    //   关注点:
    //     - 幂等: ALTER TABLE ADD COLUMN 在 SQLite 里 IF NOT EXISTS 即可. 跑两次
    //       = 0 effect. 加索引非必须 (checkpoint 行数 < 100/task, by/status
    //       查询走 idx_checkpoints_task + 内存过滤已够).
    //     - 可回滚: 不在迁移里 DROP COLUMN — production 删列需要走
    //       v17/v19/v46 同款的 rebuild 套路, 单独留作 v77+ 处理.
    //     - 不重建表: 单纯 ADD COLUMN 是 O(1), 已有 checkpoint 数据自动 NULL,
    //       无 INSERT...SELECT 拷贝成本.
    //     - 不加 CHECK 约束: status 扩展自由度高 (后续 T2/T4 加新状态免改 schema).
    version: 76,
    sql: `
      ALTER TABLE checkpoints ADD COLUMN by TEXT;
      ALTER TABLE checkpoints ADD COLUMN status TEXT;
    `,
  },
  {
    // v126: Code Knowledge Index — L1 AST 符号层 (飞书 R92 第二阶段, docs/plans/
    //   code-knowledge-index.md §3.1). 4 张表的第 1 张, 后续 v127 (L2 衔接 +
    //   术语) v128 (L3 embedding) 在它之上挂, 因此本表独立先建, 不带 FK.
    //
    // 注: plan 草稿写 v74/v75/v76, 实际 dev DB _migrations 表已有 v77-v125 历史
    //   记录 (来源: 老分支残留), 因此本批跳过 77-125 直接从 126 起, 避免和旧记录
    //   "已应用" 短路导致新 schema 不落地.
    //
    // 设计要点:
    //   - 1 行 = 1 个 export 符号 (function / class / interface / type / const /
    //     default). 由 T2 的 scripts/extract-code-symbols.ts 用 ts-morph 抽出写入.
    //   - id = "{file_hash}:{line}" 让同一文件 mtime 没变就 id 稳定 → 增量更新时
    //     DELETE+INSERT 不会把历史 hash 误清.
    //   - file 走仓库相对路径 (e.g. src/lib/db/knowledge.ts), 与 git ls-files 一致;
    //     跨机器路径差异通过 normalize-path 落库前转 WSL 形态.
    //   - UNIQUE(file, line, name) — 同一位置不会有两个同名符号, 但 (file,name) 重载
    //     合法 → 不加 (file,name) UNIQUE, 否则会误拒合法代码.
    //   - file_mtime 是失效判据 (查时 file_mtime != current_file_mtime 触发静默重抽,
    //     §4.2). indexed_at 留审计用 (本轮索引时间).
    //
    // 关注点:
    //   - 纯 additive (CREATE TABLE), 不动旧表. 与 v73 同款: dev/prod 共享库共享
    //     migration, 跑两遍幂等.
    //   - 不加 CHECK: kind 是 free text 便于 T2 扩展 (P2 加 'component' / 'hook'
    //     之类不需 migration).
    //   - 索引 (name) 给按符号名查 (ao recall <kw> --source symbols); (file) 给
    //     单文件失效时批量删; 不加 (kind) — 现阶段过滤走内存, < 10w 行无压力.
    version: 126,
    sql: `
      CREATE TABLE IF NOT EXISTS code_symbols (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        signature TEXT NOT NULL,
        docstring TEXT,
        exported INTEGER NOT NULL DEFAULT 1,
        indexed_at TEXT NOT NULL,
        file_mtime TEXT NOT NULL,
        UNIQUE(file, line, name)
      );
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(name);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file);
    `,
  },
  {
    // v127: Code Knowledge Index — L2 业务衔接层 (飞书 R92 第二阶段, 同 plan §3.2).
    //   两张表: code_business_links (符号 ↔ 业务实体) + business_terms (damo 口语 ↔ 平台概念).
    //
    // 设计要点:
    //   - code_business_links.symbol_id FK → code_symbols.id ON DELETE CASCADE:
    //     符号行被重抽删除时 link 自动清, 避免悬空引用.
    //   - kind 是 JSDoc 标签名 (@requirement / @feature / @module / @see / @doc /
    //     @task / manual); ref_kind 是引用目标的类型 (requirement / feature /
    //     module / doc_path / script / task / external). 二维分档便于反向查询:
    //     "找所有实现 R92 的代码" = ref_kind='requirement' AND ref_id='飞书 R92'.
    //   - ref_alias = damo 口语别名 (e.g. "派单" for dispatch task). 给 query 扩展用,
    //     检索时 alias 命中也算 hit.
    //   - provenance 区分来源档 (jsdoc / frontmatter / llm_suggested /
    //     manual_confirmed / learned_md / doc_extracted). §5 约束 5: llm_suggested
    //     不进 search 结果, 只在 UI「待审核」展示.
    //   - business_terms: damo_term UNIQUE 是入口. canonical = 平台概念名, aliases
    //     = 逗号分隔的其他叫法. domain 限域防跨域误命中 (例: "派单" in platform vs
    //     "派单" in 飞书 含义不同).
    //   - 启动灌库策略: docs/learned/terminology.md → DB upsert (D2 待拍, 默认
    //     推荐 C 方案), 不在本 migration 加 seed (T2/P2 范围).
    //
    // 关注点:
    //   - 索引 (ref_kind, ref_id) 复合 — 反向 query 主路径 (找所有实现某 requirement
    //     的代码); (ref_alias) 给 alias 命中查.
    //   - business_terms 加 (canonical) 索引给 canonical 反查 damo_term (少见路径,
    //     但 query 预处理可能需要).
    //   - 不加 CHECK: provenance / ref_kind 是 free text, T2 加新档免改 schema.
    version: 127,
    sql: `
      CREATE TABLE IF NOT EXISTS code_business_links (
        id TEXT PRIMARY KEY,
        symbol_id TEXT NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ref_kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        ref_alias TEXT,
        provenance TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(symbol_id, kind, ref_id)
      );
      CREATE INDEX IF NOT EXISTS idx_code_business_links_ref ON code_business_links(ref_kind, ref_id);
      CREATE INDEX IF NOT EXISTS idx_code_business_links_alias ON code_business_links(ref_alias);

      CREATE TABLE IF NOT EXISTS business_terms (
        id TEXT PRIMARY KEY,
        damo_term TEXT NOT NULL UNIQUE,
        canonical TEXT NOT NULL,
        aliases TEXT,
        domain TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_business_terms_canonical ON business_terms(canonical);
    `,
  },
  {
    // v128: Code Knowledge Index — L3 Embedding 层 (飞书 R92 第二阶段, plan §3.3).
    //   1 行 = 1 个 chunk (file 或 function) 的 embedding vector.
    //
    // 设计要点:
    //   - id 复用 = code_symbols.id (function chunk) 或文件级 hash (file chunk),
    //     不与 L1 强 FK (chunk 维度和 symbol 维度不一定 1:1, e.g. 2000 行大文件
    //     file chunk ≠ 任一 symbol). 应用层校验.
    //   - chunk_kind: 'file' (默认, 整个 .ts 一个 chunk) 或 'function' (大文件拆
    //     函数级). P3 才实装 function 级, 本表先就位.
    //   - vector 是 float32 array → BLOB. 序列化: 384 维 bge-small / 1536 维
    //     text-embed-3-small. 应用层 Buffer 解码, 不在 SQL 内做数学.
    //   - model 字段标 embedding 来源 (便于切模型后重算 + 过滤混模结果).
    //   - file_mtime 同 L1: 失效判据, mtime 变 → 异步重算 (标 stale=true).
    //
    // 关注点:
    //   - 不建 (chunk_kind) 索引 — chunk 数量预计 < file 数, 过滤走内存.
    //   - (model) 索引给切模型后批量重算: SELECT id WHERE model = 'old-model'.
    //   - 不在本表存 score — score 是 query-time 计算 (vector cosine), 不持久化.
    //   - §5 约束 2: embedding 命中 score > 0.7 才显示. 应用层 filter, 不在 DB 层
    //     CHECK (score 是运行时值).
    version: 128,
    sql: `
      CREATE TABLE IF NOT EXISTS code_embeddings (
        id TEXT PRIMARY KEY,
        chunk_kind TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        vector BLOB NOT NULL,
        model TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        file_mtime TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_code_embeddings_model ON code_embeddings(model);
    `,
  },
  {
    // v129 (R112 续): tasks.awaiting_reason TEXT NULL — reviewing 状态下细化的
    //   「子终态」标签. damo 9/7 反馈: AI 设计阶段完成上下文不够, 希望派发
    //   实施/部署出去单独做, 当前 task 标「待实施」「待部署」或「待<自定义>」
    //   标识 waiting on 子 task.
    //
    // 设计取舍:
    //   - 不加 CHECK 约束: damo 第 3 个 tag 允许 AI 自主定义 (e.g. "待测试",
    //     "待文档", "待上游"), 不能锁死枚举. 2 个常用 alias ('design_pending' /
    //     'deploy_pending') 由前端 chip 映射成「待实施/待部署」+ 颜色; 其他
    //     字符串走兜底「待<原值>」+ 灰.
    //   - 不加 FK: 这是 task 自有字段, 无跨表关系.
    //   - 不在 review 终态判定器 (state machine) 里用: 仅是 chip 显示, 不影响
    //     调度器闸门. task 仍然按 reviewing 在飞 (后续依赖可拉起). 与现有
    //     reviewing 语义一致, 不污染 terminal.
    //   - 不建索引: awaiting_reason 非高频过滤字段 (用户搜索按 task title, 不按
    //     reason). 如后续要按 reason 筛选可 v130+ 加.
    //   - 不在 v76 checkpoints 表加: 这是 task-level 状态, 不是 cp 子状态.
    //     checkpoint.status (R108) 已支持任意字符串, 两层字段语义不重叠.
    //
    // 兼容性:
    //   - 老 task.awaiting_reason = NULL → UI 不渲染 chip (向后兼容).
    //   - 老 agent 不写 awaiting_reason → 默认 NULL, 不破坏现有流程.
    //   - SQLite ADD COLUMN 幂等 (走 ALTER TABLE ADD COLUMN IF NOT EXISTS, 实际
    //     SQLite 不支持 IF NOT EXISTS on ADD COLUMN, 但 ADD COLUMN 失败 = "duplicate
    //     column" 错误, 现有 migration 跑两遍也会撞, 旧 v17/v19 已踩过同样坑, 走
    //     try/catch 兼容).
    version: 129,
    sql: `
      ALTER TABLE tasks ADD COLUMN awaiting_reason TEXT;
    `,
  },
  {
    // v130 (R113 2026-09-07): task_commits — git commit log per task. Replaces
    //   the "task chain + checkpoint snapshots" Commits Chain panel data model
    //   with a real git log view: each agent-emitted
    //     <git commit-id="abc" desc="..." files="a.ts,b.ts"/>
    //   marker writes one row. (task_id, commit_id) PK so repeated markers
    //   for the same commit are idempotent (overwrite desc/files). User
    //   isolation via task.owner_id at the route layer (mirrors checkpoints).
    version: 130,
    sql: `
      CREATE TABLE IF NOT EXISTS task_commits (
        task_id TEXT NOT NULL,
        commit_id TEXT NOT NULL,
        desc TEXT,
        files_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, commit_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_commits_task_created
        ON task_commits(task_id, datetime(created_at) DESC);
    `,
  },
  {
    // v132 (R108+D10 2026-09-08): tasks 加 2 列支持「派发时前置问为什么」——
    //   value_significance (TEXT, dispatcher 派活时填的自由字答案) +
    //   value_kind (TEXT, 5 选 1 枚举).
    //
    //   D10 设计动机 (docs/plans/requirement-as-entity.md §18): 后置 LLM 反思
    //   抽取 value 5 样本 0/5 命中, 改前置门: 派发那一瞬 dispatcher 知道为什么,
    //   不需要从 transcript 挖. 5 样本验证见 §18.2.
    //
    //   设计要点:
    //   - 两列全可空, 旧 task 行 NULL = 未填, UI 角标显示「⚠ 未填价值」.
    //     不硬阻塞, 不破坏现有 ~200+ 存量 task 派发流 (damo 9/8 拍板「软警告」).
    //   - value_kind CHECK 不锁死 5 枚举 — damo 「保留扩展性」原则, 加枚举免改
    //     schema (同 v76 checkpoints.status / v61 awaiting_markers 思路). 应用层
    //     getValueKindLabel() 兜底映射.
    //   - 子 task (forkTask) 继承父 value_kind + 自动派生 value_significance
    //     (详见 forkTask in agent-runtime.ts, v132 之后跟进).
    //   - 不加索引: 列表筛选未填价值靠 UI + dashboard (实时 < 1k 行), 真有性能
    //     问题再 partial index.
    //
    //   关注点:
    //   - 纯 additive ALTER TABLE ADD COLUMN, 不动旧表.
    //   - SQLite ADD COLUMN 幂等: ALTER TABLE 已存在列报 duplicate column 错,
    //     runIncrementalMigrations 的 try/catch + INSERT OR IGNORE 兜底 (与 v129
    //     awaiting_reason 同款处理).
    version: 132,
    sql: `
      ALTER TABLE tasks ADD COLUMN value_significance TEXT;
      ALTER TABLE tasks ADD COLUMN value_kind TEXT;
    `,
  },
  {
    // v131 (R113 hotfix 2026-09-07): 兜底创建 task_commits 表.
    //   v130 在 ao-prod DB 等历史 DB 上失效:
    //     - 这些 DB 的 _migrations 表里已经有 version 130 (来自更早的 version
    //       序列 1-506, 当时 v130 是别的 SQL)
    //     - runIncrementalMigrations 看到 v130 已 applied → 跳过 → 新的
    //       CREATE TABLE task_commits 永远不跑 → API 调 commits 报
    //       'no such table: task_commits' (HTTP 500)
    //   修复: 新加 v131, 单独 CREATE TABLE IF NOT EXISTS task_commits + 索引.
    //     - 已经应用的 DB (ao-dev): IF NOT EXISTS 无害, 直接跳过
    //     - 没应用的 DB (ao-prod): 创建表 + 索引, 修复 HTTP 500
    //   教训: 改已 applied 的 migration SQL 不会被感知, 必须加新 migration 兜底.
    version: 131,
    sql: `
      CREATE TABLE IF NOT EXISTS task_commits (
        task_id TEXT NOT NULL,
        commit_id TEXT NOT NULL,
        desc TEXT,
        files_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, commit_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_commits_task_created
        ON task_commits(task_id, datetime(created_at) DESC);
    `,
  },
  {
    // v507 + v508 (D10 hotfix 2026-09-09): 兜底添加 tasks.value_significance /
    //   tasks.value_kind 两列. v132 在 ao-prod DB 失效, 同款 v131 陷阱:
    //     - ao-prod 的 _migrations 沿用历史 1-506 编号体系, version=132 早在
    //       2026-09-03 03:52:17 已被旧 migration 占位 applied
    //     - runIncrementalMigrations 看到 v132 已 applied → 跳过 → ALTER TABLE
    //       永远不跑 → tasks 表缺两列 → tasks.create (src/lib/db/tasks.ts:302)
    //       INSERT 含 value_significance / value_kind → SQLITE_ERROR 'no such
    //       column: value_significance' → /tasks/new + 全部定时派发 136+ 次炸
    //       (飞书 R7/R10/R13/R118 同步、reviewing 全项目自动审核、image-search
    //       推进 MVP)
    //     - ao-dev / ao-pulu 已正常应用 v132, 两列已存在 (验证: PRAGMA
    //       table_info(tasks) 含 value_significance + value_kind), 不需要兜底
    //
    //   修复: 选 v507/v508 而不是 v133/v134 的原因:
    //     - v133-v506 都已被旧 system 占位 applied (前次 _migrations MAX=506),
    //       直接跳 v133 仍会被 skip, 等于没修
    //     - v507/v508 (>506) 是干净号, 一定 free, 一次命中
    //     - 选 507 而不是 132 的 hotfix 命名, 是为了让 runIncrementalMigrations
    //       在未来任何 DB 上都不踩历史号段 (包括数据恢复 / 老 DB 复活场景)
    //
    //   拆成两个 migration (而不是合并到一个多 ALTER) 的原因:
    //     - SQLite ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS
    //     - db.exec 多语句遇错即停: 若两列之一已存在, exec 在第一个 duplicate
    //       column 错就抛, 第二个 ALTER 永远跑不到 → 留下半个状态
    //     - 拆 v507 / v508 后, 每个独立 try/catch + INSERT OR IGNORE (migration
    //       runner 已有): 已存在列 → duplicate 错被吞 + 标记 applied;
    //       缺列 → 正常添加; 两列都缺 → 顺序跑两个 ALTER 各自成功
    //
    //   关注点:
    //     - 纯 additive, 不动 tasks 已有数据
    //     - 跑完后 _migrations 新增两行 (507, 508), 旧 task 行两列 NULL (UI 兜底
    //       显示「⚠ 未填价值」, 与 v132 设计语义一致)
    //     - deploy doc 同 commit 末尾: docs/deploy/2026-09-08.md §「D10 hotfix
    //       v507/v508 (ao-prod 任务创建恢复) ⏳」
    version: 507,
    sql: `
      ALTER TABLE tasks ADD COLUMN value_significance TEXT;
    `,
  },
  {
    // v508: 见 v507 注释. value_kind 与 value_significance 拆开跑, 独立幂等.
    version: 508,
    sql: `
      ALTER TABLE tasks ADD COLUMN value_kind TEXT;
    `,
  },
  {
    // v509 (damo 2026-09-15, R131): review 状态机改造 — 新增 await_user 状态
    //   相关 metadata 列. 纯 additive, 不动现有数据, 旧 task 行新增列全 NULL.
    //
    // 14 列拆解:
    //   - 5 列: awaitTask 写入 (running → await_user 时)
    //     await_requested_by / await_reason / await_note / await_requested_at
    //     (await_resolved_by/await_resolved_at 由 approve 或 unawait 写)
    //   - 4 列: unawaitTask 写入 (await_user → running 时, 留痕)
    //     unawait_requested_by / unawait_reason / unawait_note / unawait_requested_at
    //   - 5 列: refineTask 写入 (reviewing → running 时)
    //     refined_by / refined_message / refined_count / last_refined_at
    //
    // 关注点:
    //   - 全部 nullable, 旧 task 行新列 NULL = UI 兜底显示「无记录」
    //   - 14 列在同一 ALTER TABLE 块跑, 列名全新不会撞 duplicate column 错
    //     (v507/v508 拆 2 个 migration 是为防 hotfix 期间手工 SQL 半残;
    //      v509 全新列名无此风险)
    //   - 已存在的 reject_reason / reject_count / last_rejected_at 列保留,
    //     历史 task 数据不丢, 仅新流程不再写
    version: 509,
    sql: `
      ALTER TABLE tasks ADD COLUMN await_requested_by TEXT;
      ALTER TABLE tasks ADD COLUMN await_reason TEXT;
      ALTER TABLE tasks ADD COLUMN await_note TEXT;
      ALTER TABLE tasks ADD COLUMN await_requested_at TEXT;
      ALTER TABLE tasks ADD COLUMN await_resolved_by TEXT;
      ALTER TABLE tasks ADD COLUMN await_resolved_at TEXT;
      ALTER TABLE tasks ADD COLUMN unawait_requested_by TEXT;
      ALTER TABLE tasks ADD COLUMN unawait_reason TEXT;
      ALTER TABLE tasks ADD COLUMN unawait_note TEXT;
      ALTER TABLE tasks ADD COLUMN unawait_requested_at TEXT;
      ALTER TABLE tasks ADD COLUMN refined_by TEXT;
      ALTER TABLE tasks ADD COLUMN refined_message TEXT;
      ALTER TABLE tasks ADD COLUMN refined_count INTEGER;
      ALTER TABLE tasks ADD COLUMN last_refined_at TEXT;
    `,
  },
  {
    // v510 (damo 2026-09-17): 看板拖动排序 — tasks 加 queued_order 整数列.
    //   看板 (KanbanView) 用户在同一列内上下拖拽 task card 调整顺序,
    //   「靠上的优先被处理」= 调度器 (TaskScheduler) 也按这个顺序派发.
    //   NULL = 系统默认排序 (priority desc + created_at asc), 不参与手动顺序.
    //   存全局整数 (不是 per-project) — 调度器进程内是单一全局队列, 跨项目共用
    //   next_order = MAX + 1; 拖拽时一次性把目标列可见 task 全部写连续整数
    //   (10/20/30…), 留出空位给将来插入.
    //   关注点:
    //     - 纯 additive ALTER, 旧 task 行新列 NULL = 系统默认顺序 (与 v132
    //       awaiting_reason / v507/v508 同款兜底).
    //     - 单独拆 v510 (而不是塞进已有 migration) 因为每个迁移独立 try/catch:
    //       已存在列 → duplicate column 错被吞 + 标记 applied; 缺列 → 正常添加.
    //     - 不在迁移里给历史 task 行回填 queued_order — 保留 NULL = 用户未手动
    //       排过序, 系统默认按 updated_at desc 走, 与 drag 行为不冲突.
    version: 510,
    sql: `
      ALTER TABLE tasks ADD COLUMN queued_order INTEGER;
    `,
  },

  {
    // v511: project_configs (KV, per-project) — reuse-pool MVP 需求: 不在仓里写
    //   真实卡号 / 分行 / 手机, 但运营者要能在跑起来后随时改. 复用现有 AES-256-GCM
    //   (src/lib/crypto.ts) — 任何 value 都加密存, 敏感/非敏感由调用方按 key 命名
    //   自定. PRIMARY KEY (project_id, key) + FK ON DELETE CASCADE: 项目删了
    //   配置自动清. transactional=true 因为多个 SQL 必须原子.
    version: 511,
    transactional: true,
    sql: `
      CREATE TABLE IF NOT EXISTS project_configs (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        updated_by TEXT,
        PRIMARY KEY (project_id, key)
      );
      CREATE INDEX IF NOT EXISTS idx_project_configs_project ON project_configs(project_id);
    `,
  },
  {
    // v512 (damo 2026-09-22, R-: sheetwatch 多 sheet 支持): versions 加 enable
    //   列, 与 feishu_url 同级 (CreateVersionInput / API POST+PATCH 透传).
    //   语义: true=此 version 的 sheet 会被 sheetwatch 扫并派发, false=不扫.
    //   默认 1 (True) 兼容老 binding — 老 version 行 enable 自动 True, sheetwatch
    //   行为不变; 想关掉某个 version 的 sheetwatch 时显式 enable=false.
    //   关注点:
    //     - 纯 ALTER TABLE, 不动现有 18 个 version 数据.
    //     - 列类型 INTEGER (sqlite 无 native bool, 0/1) 配合 ORM 转换.
    //     - sheetwatch load_projects() 据此过滤 (partner/scripts/sheetwatch:load_projects).
    version: 512,
    sql: `
      ALTER TABLE versions ADD COLUMN enable INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    // v513 (飞书 R172): versions 加 description 列 —— 「版本干啥的」一等字段.
    //   新建版本弹窗 AI 解析输入 (POST /api/versions/ai-parse) 会自动填这个字段;
    //   之前只能塞 name 或外部文档, 现在版本列表 / 详情可直接读.
    //   关注点: 纯 ALTER TABLE nullable 列, 不动现有数据; 老行值为 NULL.
    version: 513,
    sql: `
      ALTER TABLE versions ADD COLUMN description TEXT;
    `,
  },
  {
    // v514 (飞书 R175): llm_configs 加 fallback_ids + supports_vision.
    //   fallback_ids = JSON 数组 config id, 有序链「本配置失败后按序试谁」.
    //   supports_vision = 模型能力标记: NULL=未设置(按模型名启发式推断), 0/1=显式.
    //   关注点: 纯 ALTER TABLE nullable 列, 老行 NULL = 无链 / 未知能力, 行为不变.
    version: 514,
    sql: `
      ALTER TABLE llm_configs ADD COLUMN fallback_ids TEXT;
      ALTER TABLE llm_configs ADD COLUMN supports_vision INTEGER;
    `,
  },
  {
    // v515 (飞书 R178): users 加 git_name / git_email —— 账号级 git 提交身份.
    //   不指定(NULL) → email 回落账号邮箱, name 取邮箱前缀 (resolveGitIdentity).
    //   生效点: active-session buildEnv 注入 GIT_AUTHOR_*/GIT_COMMITTER_* env,
    //   agent 子进程的 git commit 落这个身份 (git log 可见), 不写 .git/config
    //   (共享仓多账号并发, 写文件会互相踩).
    //   关注点: 纯 ALTER TABLE nullable 列, 老行 NULL = 默认身份, 行为兼容.
    version: 515,
    sql: `
      ALTER TABLE users ADD COLUMN git_name TEXT;
      ALTER TABLE users ADD COLUMN git_email TEXT;
    `,
  },
  {
    // v516 (飞书 R184): channel_configs —— 多渠道消息接入配置表 (渠道插件化第一步).
    //   每行 = 一个渠道实例 (如一个 Telegram bot), 绑定一个 project;
    //   绑定流程: 用户在 IM 里给 bot 发 "bind <bind_code>" -> 校验通过 ->
    //   写 intake_threads (UNIQUE(channel, external_user_id)) -> 复用现有 thread->task 链路.
    //   关注点: secret_* 是 bot token 等凭据 (AES-256-GCM, src/lib/crypto.ts);
    //   bind_code / webhook_secret 明文: bind_code 用户要能读出来发进 IM,
    //   webhook_secret 用于 Telegram X-Telegram-Bot-Api-Secret-Token 头比对, 两者均非长密凭据.
    version: 516,
    sql: `
      CREATE TABLE IF NOT EXISTS channel_configs (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        name TEXT NOT NULL,
        secret_encrypted TEXT,
        secret_iv TEXT,
        secret_tag TEXT,
        bound_project_id TEXT NOT NULL,
        bind_code TEXT NOT NULL UNIQUE,
        webhook_secret TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_channel_configs_channel ON channel_configs(channel);
    `,
  },
  {
    // v517 (飞书 R196): 需求/task 完成度量化 —— progress 0-100.
    //   requirements.progress = 需求完成度 (100 = done 终态 = 部署+验证通过);
    //   tasks.progress        = task 级完成度, agent 每轮可自报 (R196 追加:
    //   "提示词让处理任务的 ai 自主提供每轮次的处理完成度"), 需求进度由 task 聚合.
    //   progress_source: 'rule'(规则算) / 'manual'(人/agent 修正) / 'ai'(AI 评估, 预留).
    //   progress_note 存评估依据/修正理由; progress_updated_at 记最近更新.
    version: 517,
    sql: `
      ALTER TABLE requirements ADD COLUMN progress INTEGER;
      ALTER TABLE requirements ADD COLUMN progress_source TEXT;
      ALTER TABLE requirements ADD COLUMN progress_note TEXT;
      ALTER TABLE requirements ADD COLUMN progress_updated_at TEXT;
      ALTER TABLE tasks ADD COLUMN progress INTEGER;
      ALTER TABLE tasks ADD COLUMN progress_source TEXT;
      ALTER TABLE tasks ADD COLUMN progress_note TEXT;
      ALTER TABLE tasks ADD COLUMN progress_updated_at TEXT;
    `,
  },
  {
    // v518 (飞书 R222): users 加 nickname / bio —— 账号级用户身份 (agent 视角).
    //   需求: 项目里容易出现 damo 等昵称误称 (cwd/CLAUDE.md 里的名字泄漏进对话),
    //   让用户可配昵称 + 自我介绍, agent 全局知道「用户是谁、喜好是什么」.
    //   生效点: active-session start() 首条 prompt 前注入 userProfileReminder
    //   (每 task 会话一次, resume 带历史不重注) —— 与 v515 git 身份同构.
    //   解析规则 (R222 原文): 配置了就用配置的; 昵称没配默认「用户」;
    //   自我介绍没配省略整行. NULL = 未配置, 行为兼容.
    version: 518,
    sql: `
      ALTER TABLE users ADD COLUMN nickname TEXT;
      ALTER TABLE users ADD COLUMN bio TEXT;
    `,
  },
  {
    // v519 (飞书 R239): llm_configs 加 per-model 单价 —— 记账精度从「全平台共用一组
    //   折中价」升级为「按配置计价」(cost_source='priced'). price_* = USD / 百万 token,
    //   NULL = 未配置 (回落原机制: SDK total_cost_usd → 折中价估算).
    //   基准模型不加列, 走 app_settings KV 键 cost_baseline_llm_config_id —— 全局唯一
    //   单值, 加列要处理多行互斥, KV 一行即真相 (系数 = 配置基准价 / 基准配置基准价).
    version: 519,
    sql: `
      ALTER TABLE llm_configs ADD COLUMN price_in REAL;
      ALTER TABLE llm_configs ADD COLUMN price_out REAL;
      ALTER TABLE llm_configs ADD COLUMN price_cache_read REAL;
    `,
  },
  {
    // v520 (idea-canvas P0, docs/plans/idea-canvas.md §3): 构思层四实体.
    //   ideas = 构思球 (假设-验证-归因回路的一等公民): hypothesis 假设一句话 /
    //   success_criteria 预写判据(数字+时限) / deadline 验证窗口(过窗未判 → 待复盘徽章) /
    //   conclusion+concluded_at 结论(必须挂一手证据, L1 §否定方向=一手数据缺失).
    //   status 6 态意图层: germinating 构思中 | exploring 探索中 | decided 已定案 |
    //   shelved 搁置 | rejected 已否定 | landed 已落地.
    //   project_id 预留升格挂载; 两层状态机红线: 任务运行态词表不动, 意图态全在本批表.
    version: 520,
    sql: `
      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'germinating'
          CHECK (status IN ('germinating','exploring','decided','shelved','rejected','landed')),
        project_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        hypothesis TEXT,
        success_criteria TEXT,
        deadline TEXT,
        conclusion TEXT,
        concluded_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_ideas_owner ON ideas (owner_id);

      CREATE TABLE IF NOT EXISTS idea_nodes (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        status TEXT NOT NULL DEFAULT 'planned'
          CHECK (status IN ('planned','dispatched','running','reviewing','awaiting_decision','blocked','done','dropped')),
        pos_x REAL,
        pos_y REAL,
        sort_key INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_idea_nodes_idea ON idea_nodes (idea_id);

      CREATE TABLE IF NOT EXISTS idea_node_deps (
        node_id TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        PRIMARY KEY (node_id, depends_on)
      );

      CREATE TABLE IF NOT EXISTS idea_links (
        idea_id TEXT NOT NULL,
        linked_idea_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'related'
          CHECK (relation IN ('related','depends','supersedes','duplicate')),
        weight REAL NOT NULL DEFAULT 1,
        PRIMARY KEY (idea_id, linked_idea_id)
      );

      CREATE TABLE IF NOT EXISTS idea_signals (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        kind TEXT NOT NULL,
        value REAL,
        note TEXT,
        ref TEXT,
        occurred_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_idea_signals_idea ON idea_signals (idea_id);
    `,
  },
  {
    // v521 (idea-canvas P0): 任务弱挂构思层 —— idea_id/node_id 可空弱引用(无 FK 约束,
    //   删 idea 不级联动历史任务), work_class 区分一次性修复/功能/规划/维护.
    //   「一次性修复和处理 idea 的任务怎么区分」的机制 = work_class + 是否挂 idea:
    //   画布只出现挂了 idea 的东西, fix 类永远只出现在 console 任务流.
    version: 521,
    sql: `
      ALTER TABLE tasks ADD COLUMN idea_id TEXT;
      ALTER TABLE tasks ADD COLUMN node_id TEXT;
      ALTER TABLE tasks ADD COLUMN work_class TEXT;
      CREATE INDEX idx_tasks_idea ON tasks (idea_id);
      CREATE INDEX idx_tasks_node ON tasks (node_id);
    `,
  },
  {
    // v522 (idea-canvas P0): 人工分拣列表 —— 任意标题(damo 可编辑), AI 也可管理;
    //   多态条目 (ref_type: task/idea/node) + UNIQUE 防重; added_by 归因 (damo | agent:<项目>).
    version: 522,
    sql: `
      CREATE TABLE IF NOT EXISTS pin_lists (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        sort_key INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_pin_lists_owner ON pin_lists (owner_id);

      CREATE TABLE IF NOT EXISTS pin_list_items (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        ref_type TEXT NOT NULL CHECK (ref_type IN ('task','idea','node')),
        ref_id TEXT NOT NULL,
        note TEXT,
        sort_key INTEGER,
        added_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (list_id, ref_type, ref_id)
      );
      CREATE INDEX idx_pin_list_items_list ON pin_list_items (list_id);
    `,
  },
  {
    // v523 (idea-canvas P3): 积木控制台布局 —— Notion 式自由摆, 12 列网格坐标;
    //   block_type: list | idea_canvas | console | stats; config json 留扩展.
    version: 523,
    sql: `
      CREATE TABLE IF NOT EXISTS dashboard_blocks (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        block_type TEXT NOT NULL CHECK (block_type IN ('list','idea_canvas','console','stats')),
        ref_id TEXT,
        x INTEGER,
        y INTEGER,
        w INTEGER,
        h INTEGER,
        config TEXT,
        sort_key INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_dashboard_blocks_owner ON dashboard_blocks (owner_id);
    `,
  },
  {
    // v524 (damo 1012 说法原文 → idea-canvas 列表升级): 列表升格为「项目级任务容器」,
    //   替代需求入口 (docs/plans/idea-canvas.md §需求替代):
    //   - pin_lists.project_id: 挂哪个项目 (NULL = 全局列表, 构思画布用)
    //   - pin_lists.data_schema: 本列表条目的扩展数据 schema (JSON: properties/required),
    //     UI 按 schema 渲染字段, AI 遵循 schema 更新 data —— 例: 需求列表的 schema 带
    //     文档链接/优先级字段
    //   - pin_list_items.data: 条目实例数据 (JSON object, 按 schema 校验)
    //   需求(requirements)数据保留不迁, UI 层降级为旧版入口 (usage/21 §需求替代).
    version: 524,
    sql: `
      ALTER TABLE pin_lists ADD COLUMN project_id TEXT;
      ALTER TABLE pin_lists ADD COLUMN data_schema TEXT;
      ALTER TABLE pin_list_items ADD COLUMN data TEXT;
      CREATE INDEX idx_pin_lists_project ON pin_lists (project_id);
    `,
  },
  {
    // v525 (Role 场景化 P1, docs/plans/role-scoped-roles.md D1): roles.project_id
    // nullable column. NULL = global role (usable in any project); non-NULL =
    // project-scoped. Uniqueness widens from UNIQUE(owner_id, name) (v19 table
    // constraint) to per-(owner, scope): same owner may hold a global "dev" AND
    // a project-scoped "dev" side by side. SQLite can't express COALESCE in a
    // table-level UNIQUE and can't drop one in place, so rebuild per the
    // documented v19 procedure (foreign_keys OFF, copy, swap, foreign_key_check,
    // ON) and enforce the new semantics with a UNIQUE expression index. Index
    // keys containing NULL are distinct in SQLite, so legacy NULL owner_id rows
    // still never collide. tasks.role_id FK (v10) still resolves: rebuilt table
    // keeps the same name + ids. tasks.project_id is NOT NULL, so scope keys
    // are ('', name) for global vs (project_id, name) for scoped roles.
    version: 525,
    sql: `
      PRAGMA foreign_keys=OFF;

      BEGIN;
      CREATE TABLE roles_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL,
        model TEXT,
        allowed_tools TEXT,
        effort TEXT,
        max_turns INTEGER,
        memory_doc TEXT,
        owner_id TEXT REFERENCES users(id),
        project_id TEXT REFERENCES projects(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO roles_new (id, name, description, system_prompt, model, allowed_tools, effort, max_turns, memory_doc, owner_id, project_id, created_at, updated_at)
        SELECT id, name, description, system_prompt, model, allowed_tools, effort, max_turns, memory_doc, owner_id, NULL, created_at, updated_at FROM roles;
      DROP TABLE roles;
      ALTER TABLE roles_new RENAME TO roles;
      COMMIT;

      CREATE UNIQUE INDEX idx_roles_owner_scope_name
        ON roles(owner_id, COALESCE(project_id, ''), name);

      PRAGMA foreign_key_check;
      PRAGMA foreign_keys=ON;
    `,
  },
  {
    // v526 (Role 场景化 P3, docs/plans/role-scoped-roles.md D3): channel_configs.role_id
    // nullable column —— 渠道默认角色. NULL = 未配 (建 task 走原逻辑, 行为不变);
    // non-NULL = 该渠道 intake 首条消息建 task 时 createTask 带此 role_id
    // (role 随 task 定型, 后续消息进已有 thread 不变, 符合 resume 契约).
    // 存在性/归属校验在 channel-configs CRUD 层 (role 存在且属同 owner);
    // role 与 task project 的作用域一致性由 createTask 既有校验兜底 (v525 语义).
    // ADD COLUMN 无 FK 子句, 与 v516 建表风格一致 (该表不依赖 SQLite 级 FK).
    version: 526,
    sql: `ALTER TABLE channel_configs ADD COLUMN role_id TEXT;`,
  },
  {
    // v527 (Role 场景化 P4, docs/plans/role-scoped-roles.md D4): roles.feishu_writeback
    // 整型开关 —— 该角色的任务完成后要不要同步飞书 (行为开关, 不是安全边界:
    // agent shell 直写 lark-cli 平台技术上拦不住, 那条通道靠 runtime 注入软约束).
    // 1 = 允许 (默认, 现有 role 全部向后兼容视为 1); 0 = 禁止 (rule-engine 自动
    // 回写 skip + events 留痕 / UI 手动回写 403 ROLE_WRITEBACK_DISABLED /
    // runtime 注入「本角色不回写」system-reminder). 三个生效点见 §0.5 三层事实表.
    version: 527,
    sql: `ALTER TABLE roles ADD COLUMN feishu_writeback INTEGER NOT NULL DEFAULT 1;`,
  },
  {
    // v528 (auto_complete 波 2.5, docs/plans/auto-complete-dag.md D7): tasks.auto_complete
    // 整型开关 —— 1 = 任务进 reviewing 的瞬间自动翻 completed (复用 approveTask 全部
    // 副作用: events/webhook/父通知/autoStartDependents). 0 = 默认, 行为不变 (人审).
    // 硬限定 DAG: auto_complete=1 但项目 dag_enforced!=1 → createTask 抛
    // AUTO_COMPLETE_REQUIRES_DAG (route 层 400 同码). 与 auto_approve (工具审批)
    // 正交. additive 列, 默认 0, 存量任务全部向后兼容.
    version: 528,
    sql: `ALTER TABLE tasks ADD COLUMN auto_complete INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // v529 (渠道绑定粒度到版本): channel_configs.bound_version_id —— 渠道行可钉死
    // 某个 version; NULL = 不钉, intake 首个 task 落项目 current_version (现状不变).
    // additive 列, 存量渠道行全部 NULL, 行为零变化.
    version: 529,
    sql: `ALTER TABLE channel_configs ADD COLUMN bound_version_id TEXT;`,
  },
  {
    // v530 (project-goal-list P0, docs/plans/project-goal-list.md): pin_list_items
    // ref_type 放行 'plan' —— 目标清单要装 docs/plans/*.md 计划条目 (ref_id = 仓内
    // 相对路径)。SQLite 改 CHECK 必须重建表: 建新表(宽 CHECK) → 拷数据 → 换名 →
    // 重建索引。存量行 ref_type 不变, 行为零变化。
    version: 530,
    sql: `
      CREATE TABLE pin_list_items_v530 (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        ref_type TEXT NOT NULL CHECK (ref_type IN ('task','idea','node','plan')),
        ref_id TEXT NOT NULL,
        note TEXT,
        data TEXT,
        sort_key INTEGER,
        added_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (list_id, ref_type, ref_id)
      );
      INSERT INTO pin_list_items_v530 (id, list_id, ref_type, ref_id, note, data, sort_key, added_by, created_at)
        SELECT id, list_id, ref_type, ref_id, note, data, sort_key, added_by, created_at FROM pin_list_items;
      DROP TABLE pin_list_items;
      ALTER TABLE pin_list_items_v530 RENAME TO pin_list_items;
      CREATE INDEX idx_pin_list_items_list ON pin_list_items (list_id);
    `,
  },
  {
    // v531: 任务排队原因 (damo 2026-10-31)。调度器挡出队时写入人话原因,
    //   UI 排队卡片直接显示, 不用翻 pm2 日志排查。NULL = 不在队列/无阻塞。
    //   学 awaiting_reason 先例: 纯字符串列, 不走 metadata JSON (listTasksPage
    //   是列白名单, 独立列 payload 最小 + ETag 指纹自然覆盖)。
    version: 531,
    sql: `
      ALTER TABLE tasks ADD COLUMN queued_reason TEXT;
    `,
  },
  {
    // v532 (侧栏项目右键操作): projects.starred + projects.archived。
    //   starred 1 = 收藏 (排 pinned 之后的第二优先段; pin 时后端/UI 联动附带收藏,
    //   不变量 pin ⇒ star); archived 1 = 归档 —— 主列表/侧栏隐藏但数据不动,
    //   仍可经 URL 访问、可在「已归档」分组一键恢复。与 deleted_at (级联软删,
    //   一切视图消失只能手工 SQL 救) 构成三档生命周期: 活跃 → 归档 → 删除。
    //   additive 列, 存量项目全 0, 行为零变化。
    version: 532,
    sql: `
      ALTER TABLE projects ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

function runIncrementalMigrations(db: Database.Database): void {
  // Create migration tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM _migrations").all() as Array<{ version: number }>).map((r) => r.version)
  );

  for (const migration of MIGRATIONS) {
    // Skip placeholder entries (e.g. v42 占位) without version/sql. v42 intentionally
    // omitted the schema (replaced by v63 DROP + v64 rebuild) but its empty body
    // would otherwise abort the loop via `db.exec(undefined)` and silently block
    // every later migration from applying.
    if (typeof migration.version !== "number" || typeof migration.sql !== "string") {
      continue;
    }
    if (!applied.has(migration.version)) {
      try {
        if (migration.transactional) {
          db.transaction(() => db.exec(migration.sql))();
        } else {
          db.exec(migration.sql);
        }
        db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(migration.version);
        console.log(`[DB] Applied migration v${migration.version}`);
      } catch (err) {
        if (migration.transactional) throw err;
        const msg = (err as Error).message;
        // 分类错误:
        //   - idempotent: 列已存在 / 表已存在 / 索引已存在 — schema 已在历史某时间点
        //     应用过, 标 applied + skip, 不重试.
        //   - 真错: 语法 / FK 违反 / 其他运行时错 — schema 没应用, **不**写 _migrations,
        //     下次启动重试, 并 console.error 大声报警.
        //
        // 历史教训 (docs/deploy/2026-08-21.md:601 + 2026-09-08 v132 hotfix):
        //   旧 catch 路径无差别 INSERT OR IGNORE, 导致 v130/v132 在历史号段撞车
        //   时 schema 没应用却被标记 applied, 永久性分裂, INSERT 时才炸 (HTTP 500).
        const idempotent = /duplicate column|already exists/i.test(msg);
        if (idempotent) {
          console.warn(`[DB] Migration v${migration.version} skipped (idempotent: ${msg})`);
          db.prepare("INSERT OR IGNORE INTO _migrations (version) VALUES (?)").run(migration.version);
        } else {
          console.error(`[DB] Migration v${migration.version} FAILED — schema NOT applied, will retry on next boot`);
          console.error(`     ${msg}`);
          // 不写 _migrations, 下次启动重跑这条 migration (apply set 仍是原状).
        }
      }
    }
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
