-- 0004_control_fuse_touch.sql
-- control_fuse.updated_at 维护口径成文与统一（DAT-92 评审建议 3 / DAT-102）：
--   0003 只给 import_job / import_row / fdd_finding 建了 touch 触发器，
--   control_fuse 沿 0001 仅 point 的先例未建——但该表是「每系统一行」的共享当前态
--   表（评估任务触发、人工解除、运维脚本都可能 UPDATE），M8 熔断状态页以它为展示
--   主数据源，应用层各自记得带 updated_at = now() 的口头约定迟早漂移。
--   技术路线取补触发器（非应用层文档）：多源写入的共享表，把不变量落成 DB 结构，
--   沿 0003 对 import_job / import_row / fdd_finding 的既定先例复用 set_updated_at()。
-- control_fuse 三类时间戳的口径分工（本文件即成文载体）：
--   triggered_at / released_at —— 语义时间戳（状态机翻转时刻），应用层维护
--     （open 态 triggered_at 必填、解除写 released_at，ddl.md §9.3）；
--   updated_at —— 行维护时间戳，DB touch 触发器统一推进（任何 UPDATE，含纯
--     metadata 列变更），写入方无需各自携带；
--   control_fuse_event.at —— 追加型事件表时间戳（该表无 updated_at，不适用 touch，
--     「最近触发/恢复记录」以事件表 at 为准，updated_at 不承载该语义）。
-- 前置：0001（set_updated_at 函数与 point 先例）、0003（control_fuse 建表）已执行。

-- +goose Up

CREATE TRIGGER control_fuse_touch BEFORE UPDATE ON control_fuse
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +goose Down

DROP TRIGGER IF EXISTS control_fuse_touch ON control_fuse;
