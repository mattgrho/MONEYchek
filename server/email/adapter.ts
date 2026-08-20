import { getEnv } from '../config/env';

/**
 * Email delivery adapter. Fail-closed like auth and storage: when no
 * provider is configured, nothing pretends to send — outbox events simply
 * wait, and the product never shows a "sent" state it cannot back up.
 *
 * Providers:
 *  - resend: real HTTPS call to api.resend.com (needs RESEND_API_KEY and
 *    EMAIL_FROM). No delivery claim is made beyond the provider accepting
 *    the message (2xx + id).
 *  - test capture: NODE_ENV=test only; records messages in memory so tests
 *    can assert on them without any network.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailAdapter {
  readonly kind: 'resend' | 'test' | 'unavailable';
  readonly available: boolean;
  /** Returns the provider message id. Throws on any failure. */
  send(message: OutgoingEmail): Promise<{ providerMessageId: string }>;
}

const unavailableAdapter: EmailAdapter = {
  kind: 'unavailable',
  available: false,
  send() {
    return Promise.reject(
      Object.assign(new Error('EMAIL_NOT_CONFIGURED: no email provider is configured'), {
        code: 'EMAIL_NOT_CONFIGURED',
      }),
    );
  },
};

/** Test-only capture store, inspectable from tests. */
export const capturedTestEmails: (OutgoingEmail & { providerMessageId: string })[] = [];

function testAdapter(): EmailAdapter {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('The capture email adapter refuses to load outside NODE_ENV=test');
  }
  return {
    kind: 'test',
    available: true,
    send(message) {
      const providerMessageId = `test-${capturedTestEmails.length + 1}`;
      capturedTestEmails.push({ ...message, providerMessageId });
      return Promise.resolve({ providerMessageId });
    },
  };
}

function resendAdapter(apiKey: string, from: string, replyTo?: string): EmailAdapter {
  return {
    kind: 'resend',
    available: true,
    async send(message) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Resend rejected the message (${res.status}): ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as { id?: string };
      if (!json.id) throw new Error('Resend returned no message id');
      return { providerMessageId: json.id };
    },
  };
}

let adapter: EmailAdapter | null = null;

export function getEmailAdapter(): EmailAdapter {
  if (adapter) return adapter;
  const env = getEnv();
  if (env.NODE_ENV === 'test') {
    adapter = testAdapter();
  } else if (env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY && env.EMAIL_FROM) {
    adapter = resendAdapter(env.RESEND_API_KEY, env.EMAIL_FROM, env.EMAIL_REPLY_TO);
  } else {
    adapter = unavailableAdapter;
  }
  return adapter;
}
