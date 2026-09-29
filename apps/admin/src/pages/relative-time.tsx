/**
 * 列表相对时间（ui/baseline §2.2：列表用相对时间「5 分钟前」，hover 显完整
 * YYYY-MM-DD HH:mm:ss；详情页仍用各域 formatTime 绝对时间）。DAT-157 修单簇 1。
 */
import { Tooltip } from 'antd';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 完整时间戳 YYYY-MM-DD HH:mm:ss（本地时区，§2.2 hover 口径）。 */
export function formatAbsolute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 相对时间文案；≥7 天回落到日期（YYYY-MM-DD），未来时间按「刚刚」呈现（时钟偏差容忍）。 */
export function relativeTimeText(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const delta = now - time;
  if (delta < MINUTE_MS) return '刚刚';
  if (delta < HOUR_MS) return `${String(Math.floor(delta / MINUTE_MS))} 分钟前`;
  if (delta < DAY_MS) return `${String(Math.floor(delta / HOUR_MS))} 小时前`;
  if (delta < 7 * DAY_MS) return `${String(Math.floor(delta / DAY_MS))} 天前`;
  return formatAbsolute(iso).slice(0, 10);
}

/** 表格列相对时间：文本相对 + Tooltip 完整时间戳（§2.2）。 */
export function RelativeTime({ iso }: { iso: string }): React.ReactNode {
  return (
    <Tooltip title={formatAbsolute(iso)}>
      <span>{relativeTimeText(iso)}</span>
    </Tooltip>
  );
}
