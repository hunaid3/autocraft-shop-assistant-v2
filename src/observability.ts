/**
 * Error reporting. Sentry (EU region) sees WHAT went wrong — error type, stack, job and shop ids —
 * never shop data: no message text, phone numbers, names, GSTINs or amounts leave India this way.
 * Everything that reaches Sentry passes scrubEvent(), whatever code captured it.
 */
import * as Sentry from '@sentry/node';

export interface ErrorContext {
  /** Low-cardinality labels to group and filter by, e.g. { queue: 'inbound', stage: 'parked' } */
  tags?: Record<string, string>;
  /** Ids only (job, message, tenant): never content */
  ids?: Record<string, string | number | null | undefined>;
  level?: 'error' | 'warning';
}

export interface ErrorReporter {
  capture(err: unknown, ctx?: ErrorContext): void;
  flush(timeoutMs?: number): Promise<void>;
}

export const noopReporter: ErrorReporter = { capture() {}, async flush() {} };

// E.164-ish numbers (8–15 digits, optional +), emails, GSTINs, ₹/Rs amounts.
const PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, '[gstin]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/\+?\b\d{8,15}\b/g, '[phone]'],
  [/(₹|\brs\.?\s*|\binr\s*)\s?[\d,]+(\.\d+)?/gi, '[amount]']
];

export function scrubText(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

const ID_KEY = /^(job|message|outbound|tenant|user)_?id$|^(job|message|outbound|tenant|user)Id$|^queue$|^attempt$/;

/** Applied to every event before it leaves the process. Exported for tests. */
export function scrubEvent<E extends Sentry.ErrorEvent>(event: E): E {
  delete event.request;              // headers and bodies are never sent
  delete event.user;
  if (event.breadcrumbs) event.breadcrumbs = [];   // breadcrumbs can carry SQL params and URLs
  if (event.message) event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value);
    for (const f of ex.stacktrace?.frames ?? []) delete f.vars;   // local variables = data
  }
  if (event.extra) {
    // only ids survive in extra; anything else is dropped
    event.extra = Object.fromEntries(Object.entries(event.extra).filter(([k]) => ID_KEY.test(k)));
  }
  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) if (!['runtime', 'os', 'trace', 'app', 'device', 'culture', 'cloud_resource'].includes(key)) delete event.contexts[key];
  }
  return event;
}

export function initSentry(opts: { dsn?: string; environment: string; release?: string }): ErrorReporter {
  if (!opts.dsn) return noopReporter;
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    release: opts.release,
    sendDefaultPii: false,
    tracesSampleRate: 0,               // errors only for now
    maxBreadcrumbs: 0,
    integrations: (defaults) => defaults.filter((i) => !['Console', 'Http', 'Postgres', 'LocalVariables'].includes(i.name)),
    beforeSend: (event) => scrubEvent(event)
  });

  return {
    capture(err, ctx = {}) {
      Sentry.withScope((scope) => {
        scope.setLevel(ctx.level ?? 'error');
        for (const [k, v] of Object.entries(ctx.tags ?? {})) scope.setTag(k, v);
        for (const [k, v] of Object.entries(ctx.ids ?? {})) if (v !== undefined && v !== null) scope.setExtra(k, String(v));
        if (ctx.ids?.tenant_id) scope.setTag('tenant', String(ctx.ids.tenant_id));
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
      });
    },
    async flush(timeoutMs = 2000) { await Sentry.flush(timeoutMs); }
  };
}
