/**
 * 告警域 API 契约（modules M4-alarm.md §2/§3，IMPL-13 / DAT-116）。
 *
 * schema 单源（platform §5.3）：本文件即 M4-alarm.md §3 TS 记法的落码形状；
 * OpenAPI 经 zod-to-openapi 生成，每操作 x-required-capability（§1.6）。
 * 纪律继承：筛选白名单 strict（API-DSN-04，白名单外 422 不静默忽略）；
 * 幂等键 / 批量 ids ≤100 / 207 逐项（API-DSN-01/05，platform §12）。
 */
import { z } from 'zod';
import type { Page } from './asset.js';
import {
  ALARM_CATEGORIES,
  ALARM_EVENT_STATUSES,
  ALARM_RULE_TYPES,
  ALARM_SCOPES,
  ALARM_SEVERITIES,
  ALARM_SUPPRESS_DURATION_S,
  ALARM_SUPPRESSION_END_REASONS,
  type AlarmCategory,
  type AlarmEventStatus,
  type AlarmScope,
  type AlarmSeverity,
  type AlarmSuppressionEndReason,
} from './enums.js';

/** 分页参数（游标分页组件：limit 1–200 默认 50，overview §2）。 */
const LIMIT = z.coerce.number().int().min(1).max(200).default(50);
const CURSOR = z.string().min(1).max(512);

/** RFC3339 时间窗参数（作用于返回行的 opened_at，M4 §3.1）。 */
const RFC3339 = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------
// 视图形状（M4-alarm.md §3.1 AlarmEventView）
// ---------------------------------------------------------------------------

export interface AlarmEventView {
  readonly id: number;
  readonly category: AlarmCategory;
  readonly rule_id: string | null;
  readonly source_type: AlarmScope;
  readonly source_id: string;
  readonly source_name: string | null;
  readonly building_id: string;
  readonly severity: AlarmSeverity;
  readonly status: AlarmEventStatus;
  readonly message: string;
  readonly root_group_id: string | null;
  readonly is_root: boolean;
  readonly child_count_active: number | null;
  readonly child_count_suppressed: number | null;
  readonly suppression: { readonly until_at: string; readonly reason: string } | null;
  readonly opened_at: string;
  readonly acked_at: string | null;
  readonly acked_by: string | null;
  readonly closed_at: string | null;
  readonly closed_by: string | null;
  readonly close_reason: string | null;
}

/** GET /alarms 筛选白名单（M4 §3.1 表逐项；strict = 白名单外面上 422）。 */
export const AlarmListQuerySchema = z
  .object({
    status: z.enum(ALARM_EVENT_STATUSES).optional(),
    severity: z.enum(ALARM_SEVERITIES).optional(),
    building_id: z.uuid().optional(),
    root_group_id: z.uuid().optional(),
    source_type: z.enum(ALARM_SCOPES).optional(),
    /** 须与 source_type 配对（缺配对 422，details.field=source_id，M4 §3.1 R9）。 */
    source_id: z.union([z.uuid(), z.coerce.number().int().positive()]).optional(),
    /** 设备维度聚合（与 source_type/source_id 互斥，同现 422，R9）。 */
    equipment_id: z.uuid().optional(),
    category: z.enum(ALARM_CATEGORIES).optional(),
    from: RFC3339.optional(),
    to: RFC3339.optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.source_id !== undefined && query.source_type === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['source_id'],
        message: 'source_id 须与 source_type 配对使用',
      });
    }
    if (query.equipment_id !== undefined && query.source_type !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['equipment_id'],
        message: 'equipment_id 与 source_type/source_id 互斥',
      });
    }
  });
export type AlarmListQuery = z.infer<typeof AlarmListQuerySchema>;
export type AlarmListResponse = Page<AlarmEventView>;

/** GET /alarms/counts（M4 §3.2：open 含子行不折叠 + critical 红点）。 */
export interface AlarmCounts {
  readonly open: number;
  readonly open_critical: number;
}

// ---------------------------------------------------------------------------
// 详情（M4-alarm.md §3.3 AlarmDetail）
// ---------------------------------------------------------------------------

export interface AlarmRuleSummary {
  readonly id: string;
  readonly rule_type: (typeof ALARM_RULE_TYPES)[number];
  readonly scope: AlarmScope;
  readonly scope_id: string;
  readonly severity: AlarmSeverity;
  readonly sustained_s: number;
  readonly params: Record<string, unknown>;
  readonly enabled: boolean;
}

export interface AlarmSource {
  readonly type: AlarmScope;
  readonly id: string;
  readonly name: string;
  readonly building: { readonly id: string; readonly name: string };
}

export interface AlarmGroupMember {
  readonly id: number;
  readonly severity: AlarmSeverity;
  readonly status: AlarmEventStatus;
  readonly message: string;
  readonly opened_at: string;
}

export interface AlarmGroup {
  readonly root_group_id: string;
  readonly is_root: boolean;
  readonly root: {
    readonly id: number;
    readonly severity: AlarmSeverity;
    readonly status: AlarmEventStatus;
    readonly message: string;
  } | null;
  readonly members: readonly AlarmGroupMember[];
}

export interface AlarmSuppressionSegment {
  readonly id: string;
  readonly reason: string;
  readonly suppressed_by: string;
  readonly started_at: string;
  readonly until_at: string;
  readonly ended_at: string | null;
  readonly ended_reason: AlarmSuppressionEndReason | null;
}

export type AlarmTimelineEntry =
  | { readonly type: 'opened'; readonly at: string }
  | { readonly type: 'acked'; readonly at: string; readonly by: string }
  | {
      readonly type: 'suppressed';
      readonly at: string;
      readonly until_at: string;
      readonly reason: string;
      readonly by: string;
      readonly ended_at: string | null;
      readonly ended_reason: string | null;
    }
  | {
      readonly type: 'closed';
      readonly at: string;
      readonly by: string | null;
      readonly reason: string;
    };

export interface AlarmDetail {
  readonly alarm: AlarmEventView;
  readonly rule: AlarmRuleSummary | null;
  readonly source: AlarmSource;
  readonly group: AlarmGroup | null;
  readonly suppressions: readonly AlarmSuppressionSegment[];
  readonly timeline: readonly AlarmTimelineEntry[];
}

// ---------------------------------------------------------------------------
// 处置动作（M4-alarm.md §3.4–§3.6）
// ---------------------------------------------------------------------------

export const AlarmAckSchema = z.object({ reason: z.string().min(1).max(1024).optional() });
export type AlarmAck = z.infer<typeof AlarmAckSchema>;

export const AlarmBatchAckSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});
export type AlarmBatchAck = z.infer<typeof AlarmBatchAckSchema>;

export interface AlarmBatchAckItem {
  readonly alarm_id: number;
  readonly ok: boolean;
  readonly error?: { readonly reason_code: string };
}

export interface AlarmBatchAckResponse {
  readonly items: readonly AlarmBatchAckItem[];
}

export const AlarmCloseSchema = z.object({ reason: z.string().min(1).max(1024) });
export type AlarmClose = z.infer<typeof AlarmCloseSchema>;

export interface AlarmCloseResponse {
  readonly alarm: AlarmEventView;
  readonly cascade_closed: number;
}

export const AlarmSuppressSchema = z.object({
  duration_s: z
    .number()
    .int()
    .min(ALARM_SUPPRESS_DURATION_S.min)
    .max(ALARM_SUPPRESS_DURATION_S.max),
  reason: z.string().min(1).max(1024),
  cascade: z.boolean().optional(),
});
export type AlarmSuppress = z.infer<typeof AlarmSuppressSchema>;

export interface AlarmSuppressResponse {
  readonly alarm: AlarmEventView;
  readonly suppression: { readonly id: string; readonly until_at: string };
  readonly cascade_suppressed: number;
}

export const AlarmUnsuppressSchema = z.object({ cascade: z.boolean().optional() });
export type AlarmUnsuppress = z.infer<typeof AlarmUnsuppressSchema>;

export interface AlarmUnsuppressResponse {
  readonly alarm: AlarmEventView;
  readonly cascade_unsuppressed: number;
}

// ---------------------------------------------------------------------------
// 抑制记录（M4-alarm.md §3.7）
// ---------------------------------------------------------------------------

export interface AlarmSuppressionView {
  readonly id: string;
  readonly alarm_event_id: number;
  readonly reason: string;
  readonly suppressed_by: string;
  readonly started_at: string;
  readonly until_at: string;
  readonly ended_at: string | null;
  readonly ended_reason: AlarmSuppressionEndReason | null;
}

export interface AlarmSuppressionListItem {
  readonly suppression: AlarmSuppressionView;
  readonly alarm: {
    readonly id: number;
    readonly severity: AlarmSeverity;
    readonly status: AlarmEventStatus;
    readonly message: string;
    readonly source_type: AlarmScope;
    readonly source_id: string;
    readonly source_name: string | null;
  };
}

export const AlarmSuppressionListQuerySchema = z
  .object({
    state: z.enum(['active', 'ended']).default('active'),
    alarm_event_id: z.coerce.number().int().positive().optional(),
    building_id: z.uuid().optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict();
export type AlarmSuppressionListQuery = z.infer<typeof AlarmSuppressionListQuerySchema>;
export type AlarmSuppressionListResponse = Page<AlarmSuppressionListItem>;

// ---------------------------------------------------------------------------
// 规则 CRUD（M4-alarm.md §2.1/§3.8–§3.10）
// ---------------------------------------------------------------------------

export interface AlarmRule {
  readonly id: string;
  readonly scope: AlarmScope;
  readonly scope_id: string;
  readonly rule_type: (typeof ALARM_RULE_TYPES)[number];
  readonly params: Record<string, unknown>;
  readonly severity: AlarmSeverity;
  readonly sustained_s: number;
  readonly enabled: boolean;
  readonly created_at: string;
}

/** 规则参数 per rule_type（M4-alarm.md §4.1 zod schema，单源）。 */
export const ALARM_RULE_PARAMS_SCHEMA = {
  point_stale: z.object({ recovery_s: z.number().int().min(0).max(86400).optional() }).strict(),
  gateway_offline: z.object({ recovery_s: z.number().int().min(0).max(86400).optional() }).strict(),
  fdd_finding: z.object({ min_severity: z.enum(ALARM_SEVERITIES).optional() }).strict(),
} as const;

export const AlarmRuleCreateSchema = z.object({
  scope: z.enum(ALARM_SCOPES),
  scope_id: z.union([z.uuid(), z.coerce.number().int().positive()]),
  rule_type: z.enum(ALARM_RULE_TYPES),
  params: z.record(z.string(), z.unknown()).optional(),
  severity: z.enum(ALARM_SEVERITIES),
  sustained_s: z.number().int().min(0).max(86400).optional(),
  enabled: z.boolean().optional(),
});
export type AlarmRuleCreate = z.infer<typeof AlarmRuleCreateSchema>;

/** PATCH 白名单（M4 §3.9：scope/scope_id/rule_type 不可变——重定向 = 新建）。 */
export const AlarmRulePatchSchema = z
  .object({
    params: z.record(z.string(), z.unknown()).optional(),
    severity: z.enum(ALARM_SEVERITIES).optional(),
    sustained_s: z.number().int().min(0).max(86400).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: '至少一项可更新字段' });
export type AlarmRulePatch = z.infer<typeof AlarmRulePatchSchema>;

export const AlarmRuleListQuerySchema = z
  .object({
    scope: z.enum(ALARM_SCOPES).optional(),
    rule_type: z.enum(ALARM_RULE_TYPES).optional(),
    enabled: z.enum(['true', 'false']).optional(),
    building_id: z.uuid().optional(),
    limit: LIMIT,
    cursor: CURSOR.optional(),
  })
  .strict();
export type AlarmRuleListQuery = z.infer<typeof AlarmRuleListQuerySchema>;
export type AlarmRuleListResponse = Page<AlarmRule>;

// ---------------------------------------------------------------------------
// 响应 schema（客户端 safeParse 消费 / OpenAPI 生成单源，platform §5.3）
// ---------------------------------------------------------------------------

export const AlarmEventViewSchema = z.object({
  id: z.number().int(),
  category: z.enum(ALARM_CATEGORIES),
  rule_id: z.string().nullable(),
  source_type: z.enum(ALARM_SCOPES),
  source_id: z.string(),
  source_name: z.string().nullable(),
  building_id: z.string(),
  severity: z.enum(ALARM_SEVERITIES),
  status: z.enum(ALARM_EVENT_STATUSES),
  message: z.string(),
  root_group_id: z.string().nullable(),
  is_root: z.boolean(),
  child_count_active: z.number().nullable(),
  child_count_suppressed: z.number().nullable(),
  suppression: z.object({ until_at: z.string(), reason: z.string() }).nullable(),
  opened_at: z.string(),
  acked_at: z.string().nullable(),
  acked_by: z.string().nullable(),
  closed_at: z.string().nullable(),
  closed_by: z.string().nullable(),
  close_reason: z.string().nullable(),
});

export const AlarmListResponseSchema = z.object({
  items: z.array(AlarmEventViewSchema),
  next_cursor: z.string().nullable(),
});

export const AlarmCountsSchema = z.object({
  open: z.number().int(),
  open_critical: z.number().int(),
});

export const AlarmBatchAckResponseSchema = z.object({
  items: z.array(
    z.object({
      alarm_id: z.number().int(),
      ok: z.boolean(),
      error: z.object({ reason_code: z.string() }).optional(),
    }),
  ),
});

export const AlarmCloseResponseSchema = z.object({
  alarm: AlarmEventViewSchema,
  cascade_closed: z.number().int(),
});

export const AlarmSuppressResponseSchema = z.object({
  alarm: AlarmEventViewSchema,
  suppression: z.object({ id: z.string(), until_at: z.string() }),
  cascade_suppressed: z.number().int(),
});

export const AlarmUnsuppressResponseSchema = z.object({
  alarm: AlarmEventViewSchema,
  cascade_unsuppressed: z.number().int(),
});

export const AlarmRuleSchema = z.object({
  id: z.string(),
  scope: z.enum(ALARM_SCOPES),
  scope_id: z.string(),
  rule_type: z.enum(ALARM_RULE_TYPES),
  params: z.record(z.string(), z.unknown()),
  severity: z.enum(ALARM_SEVERITIES),
  sustained_s: z.number().int(),
  enabled: z.boolean(),
  created_at: z.string(),
});

export const AlarmRuleListResponseSchema = z.object({
  items: z.array(AlarmRuleSchema),
  next_cursor: z.string().nullable(),
});

export const AlarmSuppressionListItemSchema = z.object({
  suppression: z.object({
    id: z.string(),
    alarm_event_id: z.number().int(),
    reason: z.string(),
    suppressed_by: z.string(),
    started_at: z.string(),
    until_at: z.string(),
    ended_at: z.string().nullable(),
    ended_reason: z.enum(ALARM_SUPPRESSION_END_REASONS).nullable(),
  }),
  alarm: z.object({
    id: z.number().int(),
    severity: z.enum(ALARM_SEVERITIES),
    status: z.enum(ALARM_EVENT_STATUSES),
    message: z.string(),
    source_type: z.enum(ALARM_SCOPES),
    source_id: z.string(),
    source_name: z.string().nullable(),
  }),
});

export const AlarmSuppressionListResponseSchema = z.object({
  items: z.array(AlarmSuppressionListItemSchema),
  next_cursor: z.string().nullable(),
});

export const AlarmDetailSchema = z.object({
  alarm: AlarmEventViewSchema,
  rule: z
    .object({
      id: z.string(),
      rule_type: z.enum(ALARM_RULE_TYPES),
      scope: z.enum(ALARM_SCOPES),
      scope_id: z.string(),
      severity: z.enum(ALARM_SEVERITIES),
      sustained_s: z.number().int(),
      params: z.record(z.string(), z.unknown()),
      enabled: z.boolean(),
    })
    .nullable(),
  source: z.object({
    type: z.enum(ALARM_SCOPES),
    id: z.string(),
    name: z.string(),
    building: z.object({ id: z.string(), name: z.string() }),
  }),
  group: z
    .object({
      root_group_id: z.string(),
      is_root: z.boolean(),
      root: z
        .object({
          id: z.number().int(),
          severity: z.enum(ALARM_SEVERITIES),
          status: z.enum(ALARM_EVENT_STATUSES),
          message: z.string(),
        })
        .nullable(),
      members: z.array(
        z.object({
          id: z.number().int(),
          severity: z.enum(ALARM_SEVERITIES),
          status: z.enum(ALARM_EVENT_STATUSES),
          message: z.string(),
          opened_at: z.string(),
        }),
      ),
    })
    .nullable(),
  suppressions: z.array(
    z.object({
      id: z.string(),
      reason: z.string(),
      suppressed_by: z.string(),
      started_at: z.string(),
      until_at: z.string(),
      ended_at: z.string().nullable(),
      ended_reason: z.enum(ALARM_SUPPRESSION_END_REASONS).nullable(),
    }),
  ),
  timeline: z.array(
    z.union([
      z.object({ type: z.literal('opened'), at: z.string() }),
      z.object({ type: z.literal('acked'), at: z.string(), by: z.string() }),
      z.object({
        type: z.literal('suppressed'),
        at: z.string(),
        until_at: z.string(),
        reason: z.string(),
        by: z.string(),
        ended_at: z.string().nullable(),
        ended_reason: z.string().nullable(),
      }),
      z.object({
        type: z.literal('closed'),
        at: z.string(),
        by: z.string().nullable(),
        reason: z.string(),
      }),
    ]),
  ),
});
