import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { noteRateLimitOutcome, resetSessionState } from '../src/core/session-state.js';

const LARGE_INSTRUCTIONS = Array.from(
  { length: 400 },
  (_, i) => `function step_${i}(id="req_${i.toString(16).padStart(8, '0')}") { return { step: ${i}, ok: true }; }\n`,
).join('');

describe('ChatGPT Codex prompt_cache_breakpoint gating (#357)', () => {
  const prevProfiles = process.env.PXPIPE_GPT_PROFILES;

  afterEach(() => {
    setAllowedModelBases(null);
    resetSessionState();
    vi.restoreAllMocks();
    if (prevProfiles === undefined) delete process.env.PXPIPE_GPT_PROFILES;
    else process.env.PXPIPE_GPT_PROFILES = prevProfiles;
  });

  it('omits prompt_cache_breakpoint when disableCacheBreakpoints is true and keeps it otherwise', async () => {
    const reqBody = new TextEncoder().encode(
      JSON.stringify({
        model: 'gpt-6-luna',
        instructions: LARGE_INSTRUCTIONS,
        input: [{ role: 'user', content: 'hi' }],
      }),
    );

    const codex = await transformOpenAIResponses(reqBody, { disableCacheBreakpoints: true });
    expect(codex.info.compressed).toBe(true);
    expect(new TextDecoder().decode(codex.body)).not.toContain('prompt_cache_breakpoint');

    const direct = await transformOpenAIResponses(reqBody, {});
    expect(direct.info.compressed).toBe(true);
    expect(new TextDecoder().decode(direct.body)).toContain('prompt_cache_breakpoint');
  });

  it('honors cacheBreakpoints: false in PXPIPE_GPT_PROFILES overrides', () => {
    expect(resolveGptProfile('gpt-6-luna').cacheBreakpoints).toBe(true);
    process.env.PXPIPE_GPT_PROFILES = JSON.stringify({ 'gpt-6-luna': { cacheBreakpoints: false } });
    expect(resolveGptProfile('gpt-6-luna').cacheBreakpoints).toBe(false);
  });

  it('automatically omits prompt_cache_breakpoint on /backend-api/codex/responses in createProxy', async () => {
    setAllowedModelBases(['gpt-6-luna']);
    let forwardedBody = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      forwardedBody = new TextDecoder().decode(init?.body as Uint8Array);
      return new Response(
        JSON.stringify({ id: 'resp_1', status: 'completed', usage: { input_tokens: 100, output_tokens: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const handle = createProxy({ openAIUpstream: 'https://chatgpt.com' });
    const res = await handle(
      new Request('http://127.0.0.1:47821/backend-api/codex/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig',
        },
        body: JSON.stringify({
          model: 'gpt-6-luna',
          instructions: LARGE_INSTRUCTIONS,
          input: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(forwardedBody).toContain('input_image');
    expect(forwardedBody).not.toContain('prompt_cache_breakpoint');
  });

  it('attributes GET /backend-api/codex/models to openai accountingProvider', async () => {
    const events: ProxyEvent[] = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const handle = createProxy({
      openAIUpstream: 'https://chatgpt.com',
      onRequest: (e) => { events.push(e); },
    });
    const res = await handle(new Request('http://127.0.0.1:47821/backend-api/codex/models', { method: 'GET' }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(events[0]?.accountingProvider).toBe('openai');
  });

  it('applies 429 rate-limit circuit breaker to OpenAI Responses and Google Gemini', async () => {
    const reqBody = new TextEncoder().encode(
      JSON.stringify({
        model: 'gpt-6-luna',
        instructions: LARGE_INSTRUCTIONS,
        input: [{ role: 'user', content: 'unique-codex-session-429-probe' }],
      }),
    );
    const first = await transformOpenAIResponses(reqBody, { disableCacheBreakpoints: true });
    expect(first.info.compressed).toBe(true);
    const key = first.info.sessionKey ?? first.info.firstUserSha8;
    expect(key).toBeTruthy();
    noteRateLimitOutcome(key, 429);
    noteRateLimitOutcome(key, 429);
    noteRateLimitOutcome(key, 429);
    const tripped = await transformOpenAIResponses(reqBody, { disableCacheBreakpoints: true });
    expect(tripped.info.compressed).toBe(false);
    expect(tripped.info.reason).toBe('compress=false (rate_limit_circuit_open)');

    const gBody = new TextEncoder().encode(
      JSON.stringify({
        systemInstruction: { parts: [{ text: LARGE_INSTRUCTIONS }] },
        contents: [{ role: 'user', parts: [{ text: 'unique-gemini-session-429-probe' }] }],
      }),
    );
    const gFirst = await transformGoogleGenerateContent(gBody, 'gemini-4-neon');
    expect(gFirst.info.compressed).toBe(true);
    const gKey = gFirst.info.sessionKey ?? gFirst.info.firstUserSha8;
    expect(gKey).toBeTruthy();
    noteRateLimitOutcome(gKey, 429);
    noteRateLimitOutcome(gKey, 429);
    noteRateLimitOutcome(gKey, 429);
    const gTripped = await transformGoogleGenerateContent(gBody, 'gemini-4-neon');
    expect(gTripped.info.compressed).toBe(false);
    expect(gTripped.info.reason).toBe('compress=false (rate_limit_circuit_open)');
  });
});
