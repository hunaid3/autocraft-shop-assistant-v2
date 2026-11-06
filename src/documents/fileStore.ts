/**
 * Where PDFs, bill photos and uploads are kept. Production: Supabase Storage, private bucket
 * 'shop-files', Mumbai, one folder per shop (the files table enforces `<tenant_id>/…`).
 * Tests: in memory.
 */

export interface FileStore {
  put(path: string, bytes: Buffer, mime: string): Promise<void>;
  get(path: string): Promise<Buffer>;
  readonly bucket: string;
}

export class MemoryFileStore implements FileStore {
  readonly bucket = 'shop-files';
  readonly files = new Map<string, { bytes: Buffer; mime: string }>();
  async put(path: string, bytes: Buffer, mime: string) { this.files.set(path, { bytes, mime }); }
  async get(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`no file at ${path}`);
    return f.bytes;
  }
}

/** Supabase Storage over its REST API. The secret key is used for storage only, never for the database. */
export class SupabaseFileStore implements FileStore {
  constructor(private readonly opts: { url: string; secretKey: string; bucket?: string; timeoutMs?: number }) {}
  get bucket() { return this.opts.bucket ?? 'shop-files'; }

  private obj(path: string) {
    return `${this.opts.url.replace(/\/$/, '')}/storage/v1/object/${this.bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  private headers(extra: Record<string, string> = {}) {
    return { apikey: this.opts.secretKey, authorization: `Bearer ${this.opts.secretKey}`, ...extra };
  }

  async put(path: string, bytes: Buffer, mime: string) {
    const res = await fetch(this.obj(path), {
      method: 'POST', body: new Uint8Array(bytes),
      headers: this.headers({ 'content-type': mime, 'x-upsert': 'true', 'cache-control': 'no-store' }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000)
    });
    if (!res.ok) throw new Error(`storage upload failed (${res.status})`);
  }

  async get(path: string) {
    const res = await fetch(this.obj(path), { headers: this.headers(), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000) });
    if (!res.ok) throw new Error(`storage download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}
