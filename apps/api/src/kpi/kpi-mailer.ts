/**
 * M11 FDD 周报订阅投递 SMTP 客户端（M11-kpi-dashboard.md §6.4；IMPL-22 / DAT-246）。
 *
 * SMTP = 客户侧 relay（私有化环境依赖，PRD 卡 R6）：env 五项 SMTP_HOST/PORT/USER/
 * PASS/FROM（RUNBOOK §5.1 配置与连通自检）。未配置（SMTP_HOST 空）→ 停用形态：
 * 投递落 delivery failed + failure_msg（不影响报告本体与看板）；投递失败错误摘要
 * 不含收件人地址全文（PII 纪律 CODE-LOG-01）。
 */
import type { Logger } from 'pino';
import type { FddDigestRecipient } from '@thermio/shared-types';

export interface DigestMail {
  readonly subject: string;
  readonly html: string;
  readonly pdfBytes: Uint8Array;
  readonly pdfFilename: string;
  readonly recipients: readonly FddDigestRecipient[];
}

export type DigestSendResult =
  | { readonly kind: 'sent'; readonly delivered_at: string }
  | { readonly kind: 'failed'; readonly failure_msg: string };

/** 投递客户端出口（KPI_MAILER token；e2e 覆写为可控 fake）。 */
export interface DigestMailer {
  send(mail: DigestMail): Promise<DigestSendResult>;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

export function smtpEnabled(config: SmtpConfig): boolean {
  return config.host.length > 0;
}

/** nodemailer 实现（STARTTLS 优先端口语义交由 port 值：465 → implicit TLS）。 */
export function nodemailerDigestMailer(config: SmtpConfig, logger: Logger): DigestMailer {
  return {
    async send(mail: DigestMail): Promise<DigestSendResult> {
      try {
        const nodemailer = await import('nodemailer');
        const transporter = nodemailer.createTransport({
          host: config.host,
          port: config.port,
          secure: config.port === 465,
          auth: config.user.length > 0 ? { user: config.user, pass: config.pass } : undefined,
        });
        await transporter.sendMail({
          from: config.from.length > 0 ? config.from : 'thermio@localhost',
          to: mail.recipients.map((r) => r.email).join(', '),
          subject: mail.subject,
          html: mail.html,
          attachments: [
            {
              filename: mail.pdfFilename,
              content: Buffer.from(mail.pdfBytes),
              contentType: 'application/pdf',
            },
          ],
        });
        transporter.close();
        return { kind: 'sent', delivered_at: new Date().toISOString() };
      } catch (err) {
        // 错误摘要不含收件地址全文（PII 纪律）；结构化日志留全量排障凭据
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ msg: 'kpi_digest_smtp_failed', reason: message });
        return { kind: 'failed', failure_msg: message.slice(0, 300) };
      }
    },
  };
}

/** 停用形态（SMTP_HOST 空）：不可达语义 = failed + 明确 failure_msg。 */
export function disabledDigestMailer(reason: string): DigestMailer {
  return {
    send(): Promise<DigestSendResult> {
      return Promise.resolve({ kind: 'failed', failure_msg: reason });
    },
  };
}
