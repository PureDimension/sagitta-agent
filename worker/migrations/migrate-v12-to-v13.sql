-- ============================================================================
-- Sagitta 记忆模块 v1.2 → v1.3 迁移（存量库升级专用，2026-08-26）
-- 使用方法：D1 Console → 全部选中本文件内容 → 单个事务提交
-- （D1 默认单条执行，多语句必须整体事务提交——老规矩）
-- 全新库不需要本文件：直接用完整 schema.sql 建库。
-- 重复执行会报 duplicate column name，只跑一次。
-- ============================================================================

-- ① entries 表新增三列（v1.3 信任机制）-------------------------------------
ALTER TABLE entries ADD COLUMN origin TEXT NOT NULL DEFAULT 'sagitta';
ALTER TABLE entries ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN oppose_count INTEGER NOT NULL DEFAULT 0;

-- ② validation_events 表（validated 事件化 + replace/archive 审计留痕）------
CREATE TABLE IF NOT EXISTS validation_events (
  id                    TEXT PRIMARY KEY,              -- 工具生成（UUID）
  entry_id              TEXT NOT NULL,                 -- 关联条目 entries.id
  event_type            TEXT NOT NULL,                 -- validated | replaced | archived
  explanation           TEXT,                          -- 解释（validated 可作 few-shot 示例；replaced 为更换原因）
  old_content           TEXT,                          -- 仅 replaced/archived 审计用：被更换/归档前的完整内容
  blind_spot            TEXT,                          -- 该经验未涉及的盲点（validated 必填——worker 缺失即 422）
  linked_delegation_id  TEXT,                          -- 可空，关联 delegation 验证结果
  created               TEXT NOT NULL,                 -- ISO-8601

  CHECK (event_type IN ('validated','replaced','archived'))
);

-- ③ 新索引 ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_entries_score   ON entries(score);
CREATE INDEX IF NOT EXISTS idx_entries_origin  ON entries(origin);
CREATE INDEX IF NOT EXISTS idx_validation_events_entry  ON validation_events(entry_id);
CREATE INDEX IF NOT EXISTS idx_validation_events_created ON validation_events(created);

-- ④ 存量分数回填（v1.2 已积累的认可计数 → v1.3 信任分）----------------------
-- 公式与 worker 三态计分一致：2*explicit + 1*unobjected - 3*oppose，钳制 0~3
UPDATE entries SET score = MIN(3, MAX(0, 2*explicit_ack_count + unobjected_ack_count - 3*oppose_count));
UPDATE entries SET status = CASE
  WHEN status IN ('captured','digested','corroborated') AND score >= 2 THEN 'corroborated'
  WHEN status IN ('captured','digested') AND score >= 1 THEN 'digested'
  ELSE status END;

-- ============================================================================
-- 迁移完成。之后贴新版 worker.js（VERSION=1.3.0）并 Deploy。
-- ============================================================================