/**
 * SSE 遥测流客户端（M3-monitor §4.2/§4.3：api-client 封装层内实现）。
 *
 * 通道契约（platform §10 / M3 §4.1，消费侧不重定义）：
 * - `GET /api/v1/streams/telemetry?point_ids=`（csv ≤500）；EventSource 不带 Bearer
 *   → fetch 流式 + 手工解析（§4.3 拍板）；
 * - `event: telemetry`，data = 节流窗口内最新值快照批量（幂等覆写，不累计）；
 *   心跳 `: ping` 15s（注释行，解析层天然忽略）；
 * - 生命周期状态机：connecting → open ⇄ (paused | reconnecting) → failed / closed；
 *   退避 1s→2s→5s→10s 上限 30s ±20% 抖动（不雪崩约束）；4xx 同参不可恢复 → failed
 *   不自动重试；503 按 Retry-After；document.hidden → paused（主动断开），恢复可见
 *   先批量快照校准（§3.6，页面层做）再重订阅；
 * - 卸载必断（closed）：AbortController + 读循环退出。
 */
import { tokenStore } from './api-client.js';

export type StreamStatus = 'connecting' | 'open' | 'paused' | 'reconnecting' | 'failed' | 'closed';

/** `event: telemetry` 单点快照（§4.2 data 形状；quality 透传不解释）。 */
export interface StreamPoint {
  readonly point_id: number;
  readonly ts: string;
  readonly value: number | null;
  readonly value_text: string | null;
  readonly quality: number;
}

export interface TelemetryStreamCallbacks {
  readonly onStatus: (status: StreamStatus, detail?: string) => void;
  readonly onPoints: (points: readonly StreamPoint[]) => void;
}

export interface TelemetryStreamHandle {
  close(): void;
}

const BACKOFF_LADDER_MS = [1000, 2000, 5000, 10000] as const;
const BACKOFF_CAP_MS = 30000;

/** 退避序列（纯函数，单测锚点）：1→2→5→10s（§4.3 阶梯），之后 ×2 续涨、上限
 * 30s（不雪崩约束——阶梯封顶会让「上限 30s」不可达），±20% 抖动。 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const last = BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1] ?? BACKOFF_CAP_MS;
  const base =
    attempt < BACKOFF_LADDER_MS.length
      ? (BACKOFF_LADDER_MS[attempt] ?? BACKOFF_CAP_MS)
      : last * 2 ** (attempt - BACKOFF_LADDER_MS.length + 1);
  const jitter = 1 + (random() * 0.4 - 0.2); // ±20%
  return Math.round(Math.min(base, BACKOFF_CAP_MS) * jitter);
}

/** SSE 帧解析（纯函数，单测锚点）：缓冲切整帧，取 event/data，注释行忽略。 */
export function parseSseFrames(buffer: string): {
  events: Array<{ event: string; data: string }>;
  rest: string;
} {
  const events: Array<{ event: string; data: string }> = [];
  let rest = buffer;
  let boundary = rest.indexOf('\n\n');
  while (boundary !== -1) {
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // 心跳/注释
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') });
    boundary = rest.indexOf('\n\n');
  }
  return { events, rest };
}

/** data JSON → StreamPoint[]（畸形帧跳过不中断流——遥测幂等快照语义）。 */
export function parseTelemetryData(data: string): StreamPoint[] {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'points' in parsed &&
      Array.isArray(parsed.points)
    ) {
      return parsed.points.filter(
        (point): point is StreamPoint =>
          typeof point === 'object' &&
          point !== null &&
          typeof (point as StreamPoint).point_id === 'number' &&
          typeof (point as StreamPoint).ts === 'string',
      );
    }
  } catch {
    /* 畸形帧静默跳过 */
  }
  return [];
}

export function openTelemetryStream(
  pointIds: readonly number[],
  callbacks: TelemetryStreamCallbacks,
): TelemetryStreamHandle {
  let closed = false;
  // 经函数读取：闭包字段的 TS 收窄不跨 await 重置，直接判会被误作恒 false
  const isClosed = (): boolean => closed;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 每次连接独立 controller：paused 主动 abort 后 resume 需要全新信号
  let active = new AbortController();

  const connect = async (): Promise<void> => {
    if (closed) return;
    active = new AbortController();
    const controller = active;
    // 重试只发一次 reconnecting：catch 调度时已发（自测门 r1 测试建议②——
    // 建连时再发一次会令状态行重复闪烁），此处仅首连报 connecting。
    if (attempt === 0) callbacks.onStatus('connecting');
    try {
      const response = await fetch(
        `/api/v1/streams/telemetry?point_ids=${encodeURIComponent(pointIds.join(','))}`,
        {
          headers:
            tokenStore.accessToken !== null
              ? { authorization: `Bearer ${tokenStore.accessToken}`, accept: 'text/event-stream' }
              : { accept: 'text/event-stream' },
          signal: controller.signal,
        },
      );
      if (!response.ok || response.body === null) {
        // 4xx 同参不可恢复（越权/超限）→ failed 不重试；503 服务忙 → 退避重试
        if (response.status === 503) throw new Error('server_busy');
        callbacks.onStatus('failed', `SSE 建流失败（HTTP ${String(response.status)}）`);
        return;
      }
      attempt = 0;
      callbacks.onStatus('open');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done || isClosed()) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const frame of events) {
          if (frame.event !== 'telemetry') continue;
          const points = parseTelemetryData(frame.data);
          if (points.length > 0) callbacks.onPoints(points);
        }
      }
      if (!isClosed()) throw new Error('stream_ended');
    } catch {
      if (isClosed() || controller.signal.aborted) return;
      // 读循环中断/网络错误 → 退避重连（±20% 抖动，上限 30s）
      const delay = backoffDelayMs(attempt);
      attempt += 1;
      callbacks.onStatus('reconnecting');
      timer = setTimeout(() => {
        void connect();
      }, delay);
    }
  };

  void connect();

  const onVisibility = (): void => {
    // paused 由页面态驱动：MVP 以 hidden 主动断开、可见即重连（快照校准在页面层）
    if (closed) return;
    if (document.visibilityState === 'hidden') {
      active.abort();
      callbacks.onStatus('paused');
    } else if (tokenStore.accessToken !== null) {
      attempt = 0;
      void connect();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    close(): void {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      active.abort();
      callbacks.onStatus('closed');
    },
  };
}
