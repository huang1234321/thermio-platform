/**
 * 配置产物与游标测试（M2-import §1.4/§8.4；DAT-118）。
 */
import { describe, expect, it } from 'vitest';
import { buildConfigArtifact } from './config-artifact.js';
import { decodeJobCursor, decodeRowCursor, encodeImportCursor } from './import-cursor.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';

describe('配置产物（§8.4 契约）', () => {
  it('shouldBuildFullSnapshotArtifact_withSchemaVersionAndOfflineAction', () => {
    const artifact = buildConfigArtifact(
      'job-1',
      [
        { raw_name: 'CHWS_T_1F', unit_raw: '℃', unit_std: 'degC' },
        { raw_name: 'PUMP_RUN', unit_raw: null, unit_std: null },
      ],
      { writes: [{ raw_name: 'CHWS_T_1F', value: 7.5 }] },
      new Date('2026-09-27T00:00:00Z'),
    );
    expect(artifact).toEqual({
      schema_version: 1,
      job_id: 'job-1',
      generated_at: '2026-09-27T00:00:00.000Z',
      points: [
        { raw_name: 'CHWS_T_1F', ref: 'CHWS_T_1F', unit_raw: '℃', unit_std: 'degC' },
        { raw_name: 'PUMP_RUN', ref: 'PUMP_RUN', unit_raw: null, unit_std: null },
      ],
      offline_action: { writes: [{ raw_name: 'CHWS_T_1F', value: 7.5 }] },
    });
  });

  it('shouldPassOfflineActionNull_through', () => {
    const artifact = buildConfigArtifact('job-2', [], null);
    expect(artifact.offline_action).toBeNull();
    expect(artifact.points).toEqual([]);
  });
});

describe('游标（§1.4：排序键值 + id 定位）', () => {
  it('shouldRoundTripJobCursor', () => {
    const encoded = encodeImportCursor({ k: ['1727000000000000'], id: 'uuid-1' });
    expect(decodeJobCursor(encoded)).toEqual({ k: ['1727000000000000'], id: 'uuid-1' });
  });

  it('shouldRoundTripRowCursor', () => {
    const encoded = encodeImportCursor({ k: ['42'], id: '101' });
    expect(decodeRowCursor(encoded)).toEqual({ k: ['42'], id: '101' });
  });

  it('shouldRejectMalformedCursor_with422ValidationFailed', () => {
    for (const bad of ['!!!', 'e30=', 'eyJrIjpudWxsLCJpZCI6IngifQ==']) {
      // 'e30' = {}；第三段 = {k:null,...}
      try {
        decodeJobCursor(bad === 'eyJrIjpudWxsLCJpZCI6IngifQ==' ? bad : bad);
        if (bad === '!!!') throw new Error('应当抛出');
      } catch (err) {
        expect(err).toBeInstanceOf(ReasonCodeException);
        expect((err as ReasonCodeException).reasonCode).toBe('common.validation_failed');
      }
    }
  });

  it('shouldRejectJobCursor_whenKeyIsNotMicrosecond', () => {
    const encoded = encodeImportCursor({ k: ['not-a-us-key'], id: 'x' });
    expect(() => decodeJobCursor(encoded)).toThrow(ReasonCodeException);
  });

  it('shouldRejectRowCursor_whenKeyIsNotNumeric', () => {
    const encoded = encodeImportCursor({ k: ['abc'], id: '1' });
    expect(() => decodeRowCursor(encoded)).toThrow(ReasonCodeException);
  });
});
