/** Fails if anything shaped like a live credential is committed. Secrets live in Vault / Secrets Manager only. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PATTERNS: Array<[string, RegExp]> = [
  ['OpenAI key', /\bsk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/],
  ['Meta access token', /\bEAA[A-Za-z0-9]{40,}/],
  ['Razorpay live key', /\brzp_live_[A-Za-z0-9]{10,}/],
  ['AWS secret key', /aws_secret_access_key\s*=\s*[A-Za-z0-9/+]{30,}/i],
  ['Private key', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Postgres URL with a real password', /postgres(ql)?:\/\/(?!app_engine:app_engine_local@|postgres:postgres@|postgres@)[^:\s/]+:[^@\s]{6,}@/]
];

function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
      .split('\n').filter((f) => f && !f.startsWith('node_modules/') && !/\.(png|jpg|pdf|lock)$/.test(f) && f !== 'package-lock.json');
  } catch {
    return [];
  }
}

describe('no secrets in the repo', () => {
  const files = trackedFiles();
  it('finds the files to scan', () => expect(files.length).toBeGreaterThan(10));
  it('contains no live credentials', () => {
    const hits: string[] = [];
    for (const f of files) {
      if (f === 'test/unit/no-secrets.test.ts') continue;
      let text: string;
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      for (const [what, re] of PATTERNS) if (re.test(text)) hits.push(`${f}: ${what}`);
    }
    expect(hits).toEqual([]);
  });
});
