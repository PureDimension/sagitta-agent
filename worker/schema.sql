-- ============================================================================
-- Sagitta 记忆模块 — Cloudflare D1 初始化 schema（v1.3）
-- ============================================================================
-- 对应设计文档：memory-system-design.md v1.3
--   §3 半结构化协议（条目骨架字段定义；v1.3 新增 origin/score/oppose_count）
--   §4 分数驱动状态机（score 0~3 钳制；信任分级；validated 事件化）
--   §7 单表 entries + stream 列 + 索引（不做物理分区，千级数据零收益）
--       delegation 独立表（task_id 主键，lesson.source_task_id 软外链）
-- 审查结论：design-review.md（P0：delegation 记录 / 强制复写 / validated 可机检证据）
--          + design-review-v2.md 三、②（delegatee 枚举含 ripple，仅涟漪明确背书）
-- v1.2→v1.3 变更（涟漪拍板）：
--   · entries 新增 origin（谁提出：ripple|sagitta）与 score（信任分 0~3，
--     ripple 先天 score=2 / sagitta 默认 score=0）与 oppose_count（反对信号计数）
--   · 新增 validation_events 表：validated/replaced/archived 事件化留痕
--     （replace 旧内容进 old_content 仅审计；validated 事件承载 validated 事实）
--   · 用法：全新库 → Console（SQL 执行器）→ 粘贴本文件全文执行（幂等）。
--     已有 v1.2 库 → 见文末“v1.2→v1.3 升级”注释段的 ALTER 语句。
-- 约定：worker.js 的字段名必须与本文件完全一致（验收标准）。
-- ============================================================================

-- entries：知识层条目单表
CREATE TABLE IF NOT EXISTS entries (
  id                    TEXT PRIMARY KEY,              -- 工具生成（UUID），不可变；AI 无权编造
  stream                TEXT NOT NULL,                 -- 归属流：sagitta | ripple | personal-projects | company-projects（设计 §7 四流；worker 白名单校验）
  type                  TEXT NOT NULL,                 -- timeline | delegation | lesson | decision | method | preference | project | judgment（设计 §3；worker 枚举校验）
  status                TEXT NOT NULL DEFAULT 'captured',
                        -- 分数驱动状态机（设计 §4 v1.3）：
                        --   captured     原始素材（sagitta 起始；score=0，默认单次偶然）
                        --   digested     已归纳 + score ≥ 1（ack 提交时自动联动，无需手动 consolidate）
                        --   corroborated score ≥ 2（自动联动；ripple 提出即 score=2 起步）
                        --   validated    由 validation_events 事件承载（写入 validated 事件 = validated 事实；score=3 固化档）
                        --   superseded   被新条目取代（链式挂接，历史保留）
                        --   archived     软归档（score<0 自动触发；score=0、archived_at=now；或治理归档终态）
  domain                TEXT,                          -- 层级域路径（设计 §3：指挥链域前缀约定 delegation/*、verification/*、supervision/*、cost-timing/*）
  tags                  TEXT,                          -- JSON 数组；检索时用 LIKE 关键词匹配，v1 明令禁 embedding（设计 §6 ③ + design-review.md P2）
  content               TEXT NOT NULL,                 -- 自由正文（markdown），AI 书写
  supersedes            TEXT,                          -- JSON 数组：本条目取代的旧条目 id（设计 §3 取代链）
  superseded_by         TEXT,                          -- JSON 数组：取代本条目的新条目 id
  condition             TEXT,                          -- 适用边界（一句话语义，AI 维护，设计 §3）
  evidence              TEXT NOT NULL DEFAULT 'plausible',
                        -- 证据状态（设计 §3 v1.2 遗留）：verified（可机检证据）| corroborated（多次认可/跨会话复发）| plausible（单次偶然）| unproven（待证）
                        -- v1.3：validated 事件化后 evidence 不再承担“唯一升级通道”职责，保留字段供 v1.2 存量数据与审计
  origin                TEXT NOT NULL DEFAULT 'sagitta',
                        -- 谁提出的（设计 §3 v1.3 新增）：ripple（涟漪想的，先天带信任 score=2）| sagitta（AI 自想，默认无信任 score=0，必须靠认可爬升）
  score                 INTEGER NOT NULL DEFAULT 0,
                        -- 信任分数（设计 §4 v1.3）：0~3 钳制；explicit +2 / unobjected +1 / oppose −3；
                        -- score<0 → 软归档（status=archived、score=0、archived_at=now）；
                        -- score 是派生信任值——平时只记计数（ack_count/explicit/unobjected/oppose），score 由服务端自动联动维护
  ack_count             INTEGER NOT NULL DEFAULT 0,    -- 认可信号累积（设计 §4 认可轨道 v1.2 事实计数：explicit +2 / unobjected +1，继续保留）
  explicit_ack_count    INTEGER NOT NULL DEFAULT 0,    -- 涟漪明确开口认可次数（强信号）+2
  unobjected_ack_count  INTEGER NOT NULL DEFAULT 0,    -- AI 主动陈述后涟漪未反对次数（弱信号）+1，必须带 statement_source（防 AI 虚构"我陈述过"）
  oppose_count          INTEGER NOT NULL DEFAULT 0,    -- 涟漪明确反对次数（v1.3 新增；oppose −3）
  cross_session_count   INTEGER NOT NULL DEFAULT 0,    -- 跨会话复发计数（v1.2 证据升级联动的历史依据；v1.3 保留字段供存量数据）
  source_task_id        TEXT,                          -- 关联 delegation 记录 task_id（lesson 专用，design-review.md P0-1）
  pinned                INTEGER NOT NULL DEFAULT 0,    -- 用户要求"永远记住"（治理永不归档，设计 §5；只允许涟漪设置；v1.3：反对信号不会自动归档 pinned 条目）
  created               TEXT NOT NULL,                 -- ISO-8601，工具时间戳（AI 无权编造）
  updated               TEXT NOT NULL,                 -- ISO-8601，最近一次变更
  tier                  TEXT,                          -- 治理层级（预留：normal 等，设计 §3 治理字段）
  ttl                   INTEGER,                       -- 存活秒数（timeline/preference 走 TTL 治理；lesson/judgment 不按 TTL 退役只被 supersede/counterexample，设计 §5）
  last_access           TEXT,                          -- 最近一次被命中（治理/归档依据）
  archived_at           TEXT,                          -- 归档时间（终态）

  -- 存储层兜底校验（与 worker.js 的校验同源，双保险）
  CHECK (status IN ('captured','digested','corroborated','validated','superseded','archived')),
  CHECK (evidence IN ('verified','corroborated','plausible','unproven')),
  CHECK (origin IN ('ripple','sagitta')),
  CHECK (score BETWEEN 0 AND 3),
  CHECK (pinned IN (0,1)),
  CHECK (ack_count >= 0),
  CHECK (explicit_ack_count >= 0),
  CHECK (unobjected_ack_count >= 0),
  CHECK (oppose_count >= 0),
  CHECK (cross_session_count >= 0)
);

-- tasks：任务事实表（docs/task-api-p1.md §1；DELETE 仅将 archived 置 1）
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,                -- 生成：tsk-YYYYMMDD-<hex6>
  project       TEXT NOT NULL,                   -- 所属项目（对应 TASKS §1A/1B 分类）
  title         TEXT NOT NULL,                   -- 条目一行描述
  status        TEXT NOT NULL DEFAULT 'open',    -- open | in_progress | blocked | waiting | done
  priority      INTEGER NOT NULL DEFAULT 0,      -- 0 普通 / 1 高 / 2 紧急
  checkbox      INTEGER NOT NULL DEFAULT 0,      -- 1=该条是涟漪待处理 checkbox
  stream        TEXT NOT NULL DEFAULT 'company', -- personal-projects | company-projects | sagitta | ripple
  body          TEXT DEFAULT '',                 -- 内嵌描述/notes
  created_at    TEXT NOT NULL,                   -- ISO8601 UTC
  updated_at    TEXT NOT NULL DEFAULT '',        -- ISO8601 UTC
  done_at       TEXT DEFAULT '',
  archived      INTEGER NOT NULL DEFAULT 0,      -- 1=归档（软删，recall 默认排除同 memory 契约）
  blocked_reason TEXT DEFAULT NULL,               -- blocked/pending_blocked 的外部阻塞原因
  pending_status TEXT DEFAULT NULL,              -- pending_done | pending_blocked；终态申请载体
  -- task-ownership-p2 §3：任务认领制四列（可空；owner 对模型无感知，永不下发明文）
  owner_agent_id TEXT DEFAULT NULL,              -- 认领者 agent id（仅服务端使用；调用方标识如 X-Agent-Id，缺省 'unknown'）
  claimed_at     TEXT DEFAULT NULL,              -- 认领时间（ISO8601 UTC；租约起点 = claimed_at + lease_seconds）
  claim_token    TEXT DEFAULT NULL,              -- 认领凭证（不透明 token；只在 claim 成功响应下发一次，列表/详情不下发）
  lease_seconds  INTEGER DEFAULT NULL,           -- 认领租约秒数（1~604800；claim body 逐认领持久化，null=全局默认 24h）
  CHECK (pending_status IS NULL OR pending_status IN ('pending_done', 'pending_blocked'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_stream  ON tasks(stream);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);

-- task_events：任务 round-close、终态申请与确认的不可变审计事实
CREATE TABLE IF NOT EXISTS task_events (
  event_id           TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  event_type         TEXT NOT NULL,       -- round_close | terminal_requested | confirmed | reopened
  round_id           TEXT DEFAULT NULL,
  action             TEXT DEFAULT NULL,  -- update | done | blocked | accept | reopen
  progress           TEXT DEFAULT NULL,
  next               TEXT DEFAULT NULL,
  blocked_reason     TEXT DEFAULT NULL,
  pending_status     TEXT DEFAULT NULL,
  confirmation_id    TEXT DEFAULT NULL,
  expected_updated_at TEXT DEFAULT NULL,
  payload_json       TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_events_round_close
  ON task_events(task_id, agent_id, round_id) WHERE event_type = 'round_close';
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_events_confirmation
  ON task_events(confirmation_id) WHERE confirmation_id IS NOT NULL;

-- delegations：派单任务记录（L2 事实层，指挥者记忆的地基，design-review.md 维度五 P0）
CREATE TABLE IF NOT EXISTS delegations (
  task_id               TEXT PRIMARY KEY,              -- 派单任务 id（如 dlg-20260817-gotest，设计 §9 示例）
  delegatee             TEXT NOT NULL,                 -- codex | subagent | self | ripple（ripple 仅用于"涟漪明确背书"记录：必须由涟漪实际输入触发，AI 无权代填 —— design-review-v2.md 三、②）
  model                 TEXT,                          -- 执行用模型/会话（可空）
  command               TEXT,                          -- 派单命令原文（设计 §3）
  claimed_result        TEXT,                          -- 对方自报结果（不轻信自报：验证先行，防谎报是系统的立身样本）
  verification_method   TEXT,                          -- 独立跑 | 盲审 | 环境核查 | 未验证（设计 §3）
  verification_result   TEXT,                          -- confirmed | contradicted | partial | unverifiable（枚举由 worker 校验；v1.2 作为 validated 四选一证据之一；v1.3 起 validated 改由事件承载，本字段继续作为 delegation 事实）
  artifacts             TEXT,                          -- 日志路径 / 退出码 / 产物
  outcome               TEXT,                          -- 接受 | 打回重做 | 废弃
  cost                  TEXT,                          -- 成本记录（会话数/金额，成本纪律沉淀用）
  created               TEXT NOT NULL,                 -- ISO-8601，工具时间戳

  CHECK (delegatee IN ('codex','subagent','self','ripple')),
  CHECK (verification_result IN ('confirmed','contradicted','partial','unverifiable'))
);

-- validation_events：验证/更换/归档事件表（设计 §4 v1.3 事件化）
--   · 写入 event_type='validated' 事件 = 该条目 validated 的事实；事件 explanation
--     可作召回时的解释性 few-shot；blind_spot（该经验未涉及的盲点）对 validated
--     事件必填（worker 缺 blind_spot 直接 422 拒绝）。
--   · event_type='replaced' 事件：replace 改写时旧版完整内容进 old_content（仅审计用，
--     不参与 recall；涟漪拍板"留痕不参与召回"）。
--   · event_type='archived' 事件：治理归档/软归档留痕（old_content 审计用）。
CREATE TABLE IF NOT EXISTS validation_events (
  id                    TEXT PRIMARY KEY,              -- 工具生成（UUID）
  entry_id              TEXT NOT NULL,                 -- 关联条目 entries.id
  event_type            TEXT NOT NULL,                 -- validated | replaced | archived（worker 枚举校验）
  explanation           TEXT,                          -- 对该条目的解释（validated 可作 few-shot 示例；replaced 为更换原因）
  old_content           TEXT,                          -- 仅 replaced/archived 审计用：被更换/归档前的完整内容（设计 §4 v1.3 §D：留痕不参与 recall）
  blind_spot            TEXT,                          -- 该经验未涉及的盲点（设计 §4 v1.3 §C；validated 事件必填——worker 缺失即 422；
                                                        -- replaced/archived 审计事件可空，表结构不强制以避免 replace 无法落审计）
  linked_delegation_id  TEXT,                          -- 可空，关联 delegation 验证结果（如 dlg-xxx；与 lesson.source_task_id 同源惯例）
  created               TEXT NOT NULL,                 -- ISO-8601，工具时间戳

  CHECK (event_type IN ('validated','replaced','archived'))
);

-- 索引：单表 + stream 列（设计 §7 不做物理分区，个人千级数据索引绰绰有余）
CREATE INDEX IF NOT EXISTS idx_entries_stream  ON entries(stream);
CREATE INDEX IF NOT EXISTS idx_entries_status  ON entries(status);
CREATE INDEX IF NOT EXISTS idx_entries_type    ON entries(type);
CREATE INDEX IF NOT EXISTS idx_entries_domain  ON entries(domain);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created);
-- v1.3 新增：信任分与来源（评分驱动检索/治理）
CREATE INDEX IF NOT EXISTS idx_entries_score   ON entries(score);
CREATE INDEX IF NOT EXISTS idx_entries_origin  ON entries(origin);
CREATE INDEX IF NOT EXISTS idx_validation_events_entry  ON validation_events(entry_id);
CREATE INDEX IF NOT EXISTS idx_validation_events_created ON validation_events(created);
CREATE INDEX IF NOT EXISTS idx_delegations_verification_result ON delegations(verification_result);
CREATE INDEX IF NOT EXISTS idx_delegations_delegatee ON delegations(delegatee);

-- ============================================================================
-- v1.2 → v1.3 升级（已有数据库时在 D1 Console 逐条执行；全新库无需执行）
-- ============================================================================
-- entries 表新增三列（SQLite 不支持 ADD COLUMN IF NOT EXISTS，逐条执行即可，
-- 重复执行会报 duplicate column name——D1 上手动执行一次即可）：
--   ALTER TABLE entries ADD COLUMN origin TEXT NOT NULL DEFAULT 'sagitta';
--   ALTER TABLE entries ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE entries ADD COLUMN oppose_count INTEGER NOT NULL DEFAULT 0;
-- validation_events 表 + 索引（可直接重粘本文件头部建表段，或单独执行）：
--   （上方 CREATE TABLE IF NOT EXISTS validation_events ... 与两个索引）
-- 存量分数回填（可选，建议执行——让 v1.2 已积累的认可计数转化为 v1.3 信任分）：
--   UPDATE entries SET score = MIN(3, MAX(0, 2*explicit_ack_count + unobjected_ack_count - 3*oppose_count));
--   UPDATE entries SET status = CASE
--     WHEN status IN ('captured','digested','corroborated') AND score >= 2 THEN 'corroborated'
--     WHEN status IN ('captured','digested') AND score >= 1 THEN 'digested'
--     ELSE status END;
-- 注意：v1.3 起"认可升级"由 ack 提交自动联动，不再依赖 consolidate 门槛；
--       上述回填仅一次性迁移用。
-- ============================================================================
