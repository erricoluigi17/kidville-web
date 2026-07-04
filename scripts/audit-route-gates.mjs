#!/usr/bin/env node
/**
 * audit-route-gates.mjs
 * Scansiona ogni src/app/api/**\/route.ts e segnala le route che NON hanno un
 * gate di autorizzazione riconoscibile. Serve perché le route usano service_role
 * (RLS bypassata): l'unica difesa è il gate nel codice, quindi una route "scoperta"
 * = potenziale fuga di dati.
 *
 * Uso:   node scripts/audit-route-gates.mjs
 * Exit:  0 se nessuna route scoperta con metodi mutanti, 1 altrimenti (CI-friendly).
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = 'src/app/api';

// Marker che contano come "gate riconoscibile" (identità + authz + scope + cron/otp).
const GATE = new RegExp(
  [
    // helper di identità/authz
    'requireStaff', 'requireDocente', 'requireUser', 'requireKitchenRead',
    'requireArea', 'requireFunzione', 'loadAppUser', 'requireGrado',
    'resolveIdentity', 'resolveSessionAppId', 'getRequestUserId',
    'getCurrentParentId', 'getCurrentStudentId', 'getCurrentTeacherId',
    'getSessionProfili', 'getProfiliForAuthUid', 'withIdentity', 'scuoleDiUtente',
    // scope (di solito dopo l'identità, ma vale come segnale di authz)
    'assertAlunnoInScope', 'assertSezioneInScope', 'assertAlunniInSezione',
    'assertClasseNomeInScope',
    // auth inline via sessione supabase
    'auth\\.getUser\\(', 'auth\\.getSession\\(',
    // service-to-service / firma
    'CRON_SECRET', 'verifyTicket', 'makeTicket',
    // sigillo endpoint pericolosi: in prod → 404, fuori prod → ruolo admin
    'sealDangerous',
  ].join('|')
);

// Route legittimamente pubbliche o service-to-service (categorizzate, non flaggate).
const PUBLIC_HINT = /\/api\/(public|auth|health|cron)\//;

// La route tocca il DB con privilegio? (createClient = service_role, o admin client)
const USES_DB = /createClient\(|createAdminClient\(|SERVICE_ROLE/;

const METHOD_RE = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const files = execSync(`find ${ROOT} -name route.ts`, { encoding: 'utf8' })
  .split('\n').filter(Boolean).sort();

const covered = [];
const publicIntentional = [];
const uncovered = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const methods = [...src.matchAll(METHOD_RE)].map((m) => m[1]);
  const hasGate = GATE.test(src);
  const usesDb = USES_DB.test(src);
  const isPublic = PUBLIC_HINT.test(file);
  const route = file.replace('src/app', '').replace('/route.ts', '') || '/';
  const mutating = methods.filter((m) => MUTATING.has(m));

  const rec = { route, methods, mutating, usesDb };

  if (hasGate) covered.push(rec);
  else if (isPublic) publicIntentional.push(rec);
  else uncovered.push(rec);
}

const line = (r) =>
  `  ${r.route}\n      metodi: [${r.methods.join(', ') || '—'}]` +
  `${r.usesDb ? '  · tocca il DB (service_role)' : ''}` +
  `${r.mutating.length ? `  · ⚠ mutanti: ${r.mutating.join(', ')}` : ''}`;

console.log(`\n📋 Audit gate di autorizzazione — ${files.length} route\n`);
console.log(`✅ Con gate riconoscibile:      ${covered.length}`);
console.log(`🌐 Pubbliche intenzionali:      ${publicIntentional.length}  (/api/public|auth|health|cron)`);
console.log(`⚠️  SENZA gate riconoscibile:    ${uncovered.length}\n`);

if (publicIntentional.length) {
  console.log('— Pubbliche/intenzionali (verifica che siano davvero da esporre):');
  for (const r of publicIntentional) console.log(line(r));
  console.log('');
}

if (uncovered.length) {
  console.log('— ⚠️  DA CONTROLLARE A MANO (nessun marker di auth trovato):');
  // Prima le più rischiose: quelle che mutano dati o toccano il DB.
  const risk = (r) => (r.mutating.length ? 2 : 0) + (r.usesDb ? 1 : 0);
  uncovered.sort((a, b) => risk(b) - risk(a));
  for (const r of uncovered) console.log(line(r));
  console.log('');
}

// Fallisci solo se una route scoperta muta dati o tocca il DB: quelle sono il vero rischio.
const hardFails = uncovered.filter((r) => r.mutating.length || r.usesDb);
if (hardFails.length) {
  console.log(`❌ ${hardFails.length} route scoperte che mutano dati o toccano il DB — rivedere prima del go-live.`);
  process.exit(1);
}
console.log('✔ Nessuna route scoperta con accesso al DB o metodi mutanti.');
