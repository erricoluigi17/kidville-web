// @vitest-environment node
import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

it('bootstrap dry: logger e SDK reali emettono errori redatti, zero RPC app_log; apply/default persistono', () => {
  // Processo Node normale, senza la guardia del runner: logger, sink e client SDK sono reali.
  // La sola rete è un fetch con stato che registra ogni scrittura e rifiuta URL inattesi.
  const source = `
    await import('./scripts/lib/risolvi-ts.mjs');
    const records = [];
    const lines = [];
    console.log = (...args) => lines.push(args.map(String).join(' '));
    console.error = (...args) => lines.push(args.map(String).join(' '));
    globalThis.fetch = async (input, init) => {
      const target = String(input instanceof Request ? input.url : input);
      if (!target.startsWith('https://example.invalid/')) throw new Error('RETE_REALE_VIETATA');
      if (target.includes('/rpc/app_log_registra')) {
        records.push(JSON.parse(init.body));
        return new Response('null', { headers: { 'content-type': 'application/json' } });
      }
      if (target.includes('/storage/v1/')) return new Response(JSON.stringify({ message: 'Object not found', password: 'test-secret-neverprint' }), { status: 404 });
      if (target.includes('/rest/v1/forms_templates') || target.includes('/rest/v1/forms_submissions')) return new Response('[]', { headers: { 'content-type': 'application/json' } });
      throw new Error('ENDPOINT_INATTESO');
    };
    const batch = await import('./scripts/recupera-autorizzazioni-pdf.mjs');
    const scope = batch.conOsservabilitaRecupero ?? ((apply, work) => work());
    const { createClient } = await import('@supabase/supabase-js');
    const { creaFetchStrumentato } = await import('@/lib/logging/supabase-fetch');
    const { logEvento } = await import('@/lib/logging/logger');
    const { validSignatureEvidence, signatureEvidence } = await import('@/lib/forms/signed-document');
    const { downloadSignedSubmissionPdf } = await import('@/lib/forms/signed-archive');
    const work = async (apply) => {
      const fetcher = creaFetchStrumentato();
      const db = createClient('https://example.invalid', 'test-secret-neverprint', { auth: { persistSession: false }, global: { fetch: fetcher } });
      await batch.eseguiRecupero({ db, download: downloadSignedSubmissionPdf, validEvidence: validSignatureEvidence, signatureEvidence, ensure: () => { throw new Error('RECUPERO_INATTESO'); }, countEnrollment: async () => 712, log: logEvento, report: (summary) => console.log(JSON.stringify(summary)) }, { apply });
      const object = await db.storage.from('form_attachments').download('scansioni/prova.pdf');
      if (!object.error) throw new Error('GUASTO_STORAGE_NON_RIPRODOTTO');
    };
    await scope(false, () => work(false));
    await new Promise(setImmediate);
    const dryWrites = records.length;
    await scope(true, () => work(true));
    await new Promise(setImmediate);
    const applyWrites = records.length - dryWrites;
    logEvento('modulistica', 'info', { operazione: 'default', esito: 'normale' });
    await new Promise(setImmediate);
    const defaultWrites = records.length - dryWrites - applyWrites;
    const beforeParallel = records.length;
    await Promise.all([
      scope(false, async () => { await new Promise(setImmediate); logEvento('modulistica', 'info', { operazione: 'parallel-dry', esito: 'normale' }); }),
      scope(true, async () => { await new Promise(setImmediate); logEvento('modulistica', 'info', { operazione: 'parallel-apply', esito: 'normale' }); }),
    ]);
    await new Promise(setImmediate);
    const parallelWrites = records.length - beforeParallel;
    let propagated = false;
    try { await scope(false, async () => { throw new Error('ERRORE_APPLICATIVO'); }); } catch (error) { propagated = error.message === 'ERRORE_APPLICATIVO'; }
    process.stdout.write(JSON.stringify({ dryWrites, applyWrites, defaultWrites, parallelWrites, propagated, lines }));
  `
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'KV_LOG_LEVEL') delete env[key]
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 30000,
    env: { ...env, NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key', SUPABASE_SERVICE_ROLE_KEY: 'test-secret-neverprint' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = JSON.parse(stdout) as { dryWrites: number; applyWrites: number; defaultWrites: number; parallelWrites: number; propagated: boolean; lines: string[] }
  expect(result.dryWrites).toBe(0)
  expect(result.applyWrites).toBeGreaterThan(0)
  expect(result.defaultWrites).toBeGreaterThan(0)
  expect(result.parallelWrites).toBe(1)
  expect(result.propagated).toBe(true)
  expect(result.lines.join(' ')).toContain('KV_ERR')
  expect(result.lines.join(' ')).toContain('Object not found')
  expect(result.lines.join(' ')).toContain('dry-run')
  expect(stdout).not.toContain('test-secret-neverprint')
})
