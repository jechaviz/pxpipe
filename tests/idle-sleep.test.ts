import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearRenderCache,
  evictRenderCacheForSleep,
  renderCacheStats,
  renderTextToPngs,
  setRenderCacheMaxBytes,
} from '../src/core/render.js';
import { DashboardState } from '../src/dashboard.js';
import { CertificateAuthority } from '../src/warp/ca.js';

describe('Idle deep-sleep memory hibernation', () => {
  it('evictRenderCacheForSleep frees cached PNG pages while keeping lifetime hit/miss stats', async () => {
    clearRenderCache();
    setRenderCacheMaxBytes(16 * 1024 * 1024);
    const text = 'const x = 42;\n'.repeat(300);
    await renderTextToPngs(text, 120);
    await renderTextToPngs(text, 120);
    const before = renderCacheStats();
    expect(before.entries).toBe(1);
    expect(before.bytes).toBeGreaterThan(0);
    expect(before.hits).toBe(1);
    expect(before.misses).toBe(1);

    const freed = evictRenderCacheForSleep();
    expect(freed).toBe(before.bytes);

    const after = renderCacheStats();
    expect(after.entries).toBe(0);
    expect(after.bytes).toBe(0);
    expect(after.hits).toBe(1);
    expect(after.misses).toBe(1);
  });

  it('DashboardState.hibernate frees PNG and sourceText ring buffers while preserving totals', async () => {
    const dash = new DashboardState();
    dash.update({
      method: 'POST',
      path: '/v1/messages',
      model: 'claude-fable-5',
      accountingProvider: 'anthropic',
      status: 200,
      durationMs: 100,
      info: {
        compressed: true,
        origChars: 10000,
        compressedChars: 10000,
        imageCount: 1,
        imageBytes: 4096,
        staticChars: 10000,
        dynamicChars: 0,
        dynamicBlockCount: 0,
        droppedChars: 0,
        firstImagePng: new Uint8Array(4096),
        firstImageWidth: 312,
        firstImageHeight: 200,
        imageSourceText: 'a'.repeat(8000),
      },
      usage: { input_tokens: 500, output_tokens: 50 },
    });

    expect(dash.servePng().status).toBe(200);
    const { freedImages, freedBytes } = dash.hibernate();
    expect(freedImages).toBe(1);
    expect(freedBytes).toBeGreaterThan(4096);
    expect(dash.servePng().status).toBe(404);

    const stats = (await dash.serveStats().json()) as { compressed_requests: number };
    expect(stats.compressed_requests).toBe(1);
  });

  it('CertificateAuthority.clearLeafCache evicts per-host TLS contexts and re-mints on demand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pxpipe-sleep-ca-'));
    try {
      const ca = CertificateAuthority.loadOrCreate(dir);
      ca.secureContextFor('api.anthropic.com');
      ca.secureContextFor('cloudcode-pa.googleapis.com');
      expect(ca.clearLeafCache()).toBe(2);
      expect(ca.clearLeafCache()).toBe(0);
      expect(ca.secureContextFor('api.anthropic.com')).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
