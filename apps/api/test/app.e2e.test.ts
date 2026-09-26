/**
 * api 骨架 e2e（supertest；platform.md §5.4 契约测试矩阵）：
 * 端点 × {正路径 / 负路径 / 边界}，断言信封形状与 reason_code。
 *
 * 覆盖验收点：
 * - 错误信封与 §5.1 逐字段一致（含 gate_clamped 2xx 语义，§5.2 注 *）；
 * - HTTP 状态语义正确（API-ERR-03）；details 不泄露内部（API-ERR-04）；
 * - request_id 贯穿 + 响应头同写（API-ERR-06）；
 * - /healthz + /metrics（§8 #4），/metrics 含 §7 三指标与闸门 label。
 *
 * 测试专用探针控制器仅注册于测试模块，不随骨架交付。
 */
import { Body, Controller, Get, Post, UsePipes } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  ApiErrorEnvelopeSchema,
  ProposalEnvelopeSchema,
  parseApiError,
  type ProposalEnvelope,
} from '@thermio/shared-types';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { ROUTE_NOT_FOUND_REASON_CODE } from '../src/infrastructure/errors/http-exception.filter.js';
import {
  GateClampedResult,
  ReasonCodeException,
} from '../src/infrastructure/errors/reason-code.exception.js';
import { ZodValidationPipe } from '../src/infrastructure/validation/zod-validation.pipe.js';

/** 校验探针：直接复用 shared-types 提案信封 schema（§5.3 单源纪律）。 */
const ProbeSchema = ProposalEnvelopeSchema;
type ProbeBody = ProposalEnvelope;

@Controller('probe')
class ErrorProbeController {
  @Post('proposals')
  @UsePipes(new ZodValidationPipe(ProbeSchema))
  submit(@Body() body: ProbeBody): ProbeBody {
    return body;
  }

  @Get('gate-rate-limited')
  gateRateLimited(): never {
    throw new ReasonCodeException(
      'proposal.gate_rate_limited',
      '该点位写入频率已达上限（闸门 3：频率限制）',
      { point_id: 1024, limit_per_hour: 6 },
    );
  }

  @Get('gate-clamped')
  gateClamped(): GateClampedResult {
    return new GateClampedResult({ requested_value: 4.5, clamped_value: 5, point_id: 1024 });
  }

  @Get('asset-not-found')
  assetNotFound(): never {
    throw new ReasonCodeException('asset.not_found', '楼栋不存在', { building_id: 'b01' });
  }

  @Get('boom')
  boom(): never {
    throw new Error('内部秘密：connection string postgres://user:pass@internal/db');
  }
}

const VALID_PROBE: ProposalEnvelope = {
  proposal_id: 'pp_test01',
  algo: 'optimizer/chiller-sequencer',
  algo_version: '1.3.2',
  target: { equipment_id: 'chiller_01', point: 'chw_supply_temp_setpoint' },
  action: { op: 'set', value: 7.5, unit: 'degC' },
  previous_value: 6.0,
  rationale: '测试提案：负荷预测低于 60% 设计负荷',
  expected_saving_kw: 42.3,
  confidence: 0.86,
  evidence: { forecast_horizon_h: 2 },
  expires_at: '2026-09-26T15:30:00+08:00',
};

describe('api skeleton e2e（platform.md §5.1/§5.4）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    process.env.KAFKA_BROKERS = '';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ErrorProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /healthz（§8 #4）', () => {
    it('shouldReportLiveness_outsideTheApiV1Prefix', async () => {
      const res = await request(app.getHttpServer()).get('/healthz').expect(200);
      expect(res.body).toEqual({ status: 'ok', svc: 'thermio-api' });
    });
  });

  describe('GET /metrics（§7 指标 / §8 #4 刮取面）', () => {
    it('shouldExposePrometheusTextFormat_withTheThreeS7Metrics', async () => {
      const res = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('svc_http_request_duration_ms');
      expect(res.text).toContain('thermio_gate_rejections_total');
      expect(res.text).toContain('thermio_proposal_decisions_total');
      // 五闸门 label 预热零值（§5.2 咬合：label = gate_* cause 子串）
      for (const gate of [
        'gate_not_whitelisted',
        'gate_clamped',
        'gate_rate_limited',
        'gate_conflict',
        'gate_circuit_open',
      ]) {
        expect(res.text).toContain(`gate="${gate}"`);
      }
    });
  });

  describe('正路径：zod pipe（§5.3）', () => {
    it('shouldEchoTheValidatedBody_whenProposalEnvelopeIsValid', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/probe/proposals')
        .send(VALID_PROBE)
        .expect(201); // Nest POST 默认 201（骨架不做业务语义，随后续模块定形）
      expect(res.body.proposal_id).toBe('pp_test01');
      expect(res.body.action.value).toBe(7.5);
    });
  });

  describe('负路径：schema 校验失败 → common.validation_failed 422', () => {
    it('shouldReturnTheEnvelopeWithFieldLevelDetails_whenBodyFailsZod', async () => {
      const malformed = { ...VALID_PROBE, confidence: 9, rationale: '' };
      const res = await request(app.getHttpServer())
        .post('/api/v1/probe/proposals')
        .send(malformed)
        .expect(422);
      const parsed = ApiErrorEnvelopeSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(res.body.error.reason_code).toBe('common.validation_failed');
      // details 字段级（§5.2）：指明越界与空串字段
      expect(Object.keys(res.body.error.details ?? {})).toEqual(
        expect.arrayContaining(['confidence', 'rationale']),
      );
      // 信封只有 §5.1 四键（无 details 外的私货）
      expect(Object.keys(res.body.error).sort()).toEqual([
        'details',
        'message',
        'reason_code',
        'request_id',
      ]);
    });

    it('shouldNormalizeFramework400_whenBodyIsNotEvenJson', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/probe/proposals')
        .set('Content-Type', 'application/json')
        .set('x-request-id', 'req_broken_json')
        .send('{"broken": json')
        .expect(422);
      expect(res.body.error.reason_code).toBe('common.validation_failed');
      // QA 阻塞#2 防回归：解析错误路径上下文已先于 body-parser 建立——
      // request_id 头体同值且透传上游（API-ERR-06 / OBS-MT-03），trace 头同在。
      expect(res.body.error.request_id).toBe('req_broken_json');
      expect(res.headers['x-request-id']).toBe('req_broken_json');
      expect(res.headers['x-trace-id']).toMatch(/^trc_/);
    });
  });

  describe('负路径：业务闸门码 → 429 + 信封 + 指标联动', () => {
    it('shouldMatchS51FieldByField_whenGateRateLimited', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/gate-rate-limited')
        .expect(429);
      // §5.1 逐字段：reason_code / message / request_id / details（值即文档示例）
      expect(res.body.error).toEqual({
        reason_code: 'proposal.gate_rate_limited',
        message: '该点位写入频率已达上限（闸门 3：频率限制）',
        request_id: expect.stringMatching(/^req_[0-9a-f]{32}$/),
        details: { point_id: 1024, limit_per_hour: 6 },
      });

      const metrics = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(metrics.text).toContain('thermio_gate_rejections_total{gate="gate_rate_limited"} 1');
    });
  });

  describe('边界：gate_clamped 2xx 语义（§5.2 注 *）', () => {
    it('shouldReturn200WithTheSameEnvelopeShape_whenValueWasClamped', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/probe/gate-clamped').expect(200);
      const parsed = ApiErrorEnvelopeSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(res.body.error.reason_code).toBe('proposal.gate_clamped');
      expect(res.body.error.details).toEqual({
        requested_value: 4.5,
        clamped_value: 5,
        point_id: 1024,
      });
      // 夹紧前后值必带（§5.2 闸门 2）
      expect(res.body.error.request_id).toMatch(/^req_[0-9a-f]{32}$/);

      const metrics = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(metrics.text).toContain('thermio_gate_rejections_total{gate="gate_clamped"} 1');
    });
  });

  describe('负路径：未知异常 → common.internal_error 500（API-ERR-04）', () => {
    it('shouldReturnGenericMessageWithoutInternals_whenUnhandledErrorEscapes', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/probe/boom').expect(500);
      expect(res.body.error.reason_code).toBe('common.internal_error');
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('postgres://');
      expect(raw).not.toContain('secret');
      expect(res.body.error.details).toBeUndefined();
    });
  });

  describe('负路径：资产域 404（种子码直出）', () => {
    it('shouldCarryTheSeededCodeAndDetails_whenAssetNotFound', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/asset-not-found')
        .expect(404);
      expect(res.body.error.reason_code).toBe('asset.not_found');
      expect(res.body.error.details).toEqual({ building_id: 'b01' });
    });
  });

  describe('边界：未知路由 404（信封兜底，§5.1「捕获一切出口」）', () => {
    it('shouldWrapUnknownRoutesInTheEnvelope_withRouteNotFoundCode', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/definitely-not-a-route')
        .expect(404);
      expect(res.body.error.reason_code).toBe(ROUTE_NOT_FOUND_REASON_CODE);
      expect(res.body.error.request_id).toMatch(/^req_/);
    });
  });

  describe('request_id 贯穿（OBS-MT-03 / API-ERR-06）', () => {
    it('shouldEchoIncomingRequestId_inBothBodyAndHeader', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/asset-not-found')
        .set('x-request-id', 'req_echo_me_123')
        .expect(404);
      expect(res.body.error.request_id).toBe('req_echo_me_123');
      expect(res.headers['x-request-id']).toBe('req_echo_me_123');
      expect(res.headers['x-trace-id']).toMatch(/^trc_/);
    });
  });

  describe('入站 id 头硬化（DAT-96 评审#1 / DAT-120）', () => {
    it('shouldPassThrough_whenIncomingIdUsesOnlyWhitelistedChars', async () => {
      // 白名单全字符类各一：字母/数字/`_`-`.`:`（覆盖 W3C traceparent、B3 等网关形状）
      const legal = 'Req_01J8Z-abc.99:1';
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/asset-not-found')
        .set('x-request-id', legal)
        .set('x-trace-id', 'trc_ext-01.2:3')
        .expect(404);
      expect(res.body.error.request_id).toBe(legal);
      expect(res.headers['x-request-id']).toBe(legal);
      expect(res.headers['x-trace-id']).toBe('trc_ext-01.2:3');
    });

    it('shouldPassThrough_atExactly128Chars_andRegenerateAt129', async () => {
      const atCap = 'a'.repeat(128);
      const ok = await request(app.getHttpServer())
        .get('/api/v1/probe/asset-not-found')
        .set('x-request-id', atCap)
        .expect(404);
      expect(ok.headers['x-request-id']).toBe(atCap);

      const overCap = 'b'.repeat(129);
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/asset-not-found')
        .set('x-request-id', overCap)
        .expect(404);
      // 超限：整体重生成，而非截断到 128（截断保留攻击者可控前缀且会制造别名歧义）
      expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]{32}$/);
      expect(res.headers['x-request-id']).not.toBe(overCap.slice(0, 128));
      expect(JSON.stringify(res.body)).not.toContain(overCap.slice(0, 128));
    });

    it('shouldRegenerateAndNeverEcho_whenIncomingIdHasIllegalChars', async () => {
      // 非 ASCII（CJK 等）在 HTTP 协议层即被客户端/llhttp 拒收，到不了应用——
      // 真正能进来的非法面是可见 ASCII 里的白名单外字符：引号/花括号/空格等（单测覆盖全矩阵）
      const illegal = '{"injected":"json"}';
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/asset-not-found')
        .set('x-request-id', illegal)
        .set('x-trace-id', 'trc bad id')
        .expect(404);
      // 信封与响应头都拿到重生成值，且头体同值（三处消费同源：日志亦读同一上下文）
      expect(res.body.error.request_id).toMatch(/^req_[0-9a-f]{32}$/);
      expect(res.headers['x-request-id']).toBe(res.body.error.request_id);
      expect(res.headers['x-trace-id']).toMatch(/^trc_[0-9a-f]{32}$/);
      // 非法原值在响应任何面都不出现（信封体/响应头序列化全查）
      expect(JSON.stringify(res.body)).not.toContain('injected');
      expect(JSON.stringify(res.headers)).not.toContain('injected');
      expect(JSON.stringify(res.headers)).not.toContain('trc bad id');
    });

    it('shouldRegenerateOnTheParserErrorPath_whenIncomingIdIsIllegal', async () => {
      // QA 阻塞#2 同路径（上下文先于 body-parser 就位）：畸形 JSON + 非法入站 id
      // 同时出现——解析错误信封同样只携带重生成值，非法值不借道信封透传
      const res = await request(app.getHttpServer())
        .post('/api/v1/probe/proposals')
        .set('Content-Type', 'application/json')
        .set('x-request-id', 'bad id with spaces')
        .send('{"broken": json')
        .expect(422);
      expect(res.body.error.reason_code).toBe('common.validation_failed');
      expect(res.body.error.request_id).toMatch(/^req_[0-9a-f]{32}$/);
      expect(res.headers['x-request-id']).toBe(res.body.error.request_id);
      expect(res.headers['x-request-id']).not.toContain('bad id');
    });
  });

  describe('畸形响应客户端兜底（§5.4 / API-ERR-02，契约闭环）', () => {
    it('shouldDriveClientFallbacks_whenParsingOurOwnResponsesWithSharedTypes', async () => {
      // 用与 api-client 同源的 parseApiError 消费本服务真实响应：
      // 已知码 known=true；未知路由码不在种子表 → known=false 走通用兜底（API-ERR-02）。
      const known = await request(app.getHttpServer())
        .get('/api/v1/probe/gate-rate-limited')
        .expect(429);
      const parsedKnown = parseApiError(known.body);
      expect(parsedKnown.known).toBe(true);

      const routeNotFound = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
      const parsedUnknown = parseApiError(routeNotFound.body);
      expect(parsedUnknown.known).toBe(false);
      expect(parsedUnknown.reason_code).toBe(ROUTE_NOT_FOUND_REASON_CODE);
    });
  });
});
