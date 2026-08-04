/**
 * allinea-password-revisore.mjs — rimette l'account demo del revisore alla sua
 * password dedicata.
 *
 * PERCHÉ ESISTE. `test.inf.genitore1@kidville.test` è l'account che App Store Connect
 * consegna al revisore Apple. Il 2026-08-04 si è misurato che:
 *
 *   · il campo `demoAccountPassword` su App Store Connect conteneva un valore di
 *     9 caratteri — la lunghezza della vecchia password comune dei 41 account TEST,
 *     ruotata il 2026-07-26;
 *   · la password dedicata creata il 2026-07-28 (24 caratteri, custodita FUORI dal
 *     repository in ~/Documenti/kidville-play/.demo-revisore-pw) **non apriva più**
 *     l'account: `auth.users.updated_at` dice che è stato ritoccato il 2026-08-03;
 *   · quindi né la password scritta nella scheda né quella sul disco funzionavano.
 *     Un revisore avrebbe trovato «credenziali non valide» al primo tentativo, che è
 *     il rigetto 5.1.1 più frequente in assoluto.
 *
 * Questo script chiude il cerchio nell'unica direzione sensata: riporta l'account
 * alla password dedicata (quella che vive fuori dal repo), così che ruotarla dopo la
 * review non rompa nessuno degli altri 40 account TEST.
 *
 * PERIMETRO. Tocca UN SOLO account, indicato per email. Nessun altro utente, nessun
 * dato di famiglie o bambini reali.
 *
 * IL VALORE NON VIENE MAI STAMPATO. Non compare nell'output, non finisce in un log,
 * non viaggia come argomento di riga di comando. Il repository è pubblico.
 *
 * Uso (dalla root del repo):
 *   node scripts/allinea-password-revisore.mjs            → ANTEPRIMA e sola diagnosi
 *   node scripts/allinea-password-revisore.mjs --apply    → riallinea e verifica
 *
 * Env richieste (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const EMAIL_DEMO = 'test.inf.genitore1@kidville.test';
const FILE_PASSWORD = join(homedir(), 'Documenti', 'kidville-play', '.demo-revisore-pw');
const APPLICA = process.argv.includes('--apply');

function caricaEnvLocal() {
  const env = {};
  let raw;
  try {
    raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return env;
  }
  for (const riga of raw.split('\n')) {
    const m = riga.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = { ...caricaEnvLocal(), ...process.env };
const URL_SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL;
const CHIAVE_SERVIZIO = env.SUPABASE_SERVICE_ROLE_KEY;
const CHIAVE_PUBBLICA = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!URL_SUPABASE || !CHIAVE_SERVIZIO) {
  console.error('✗ Mancano NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const password = readFileSync(FILE_PASSWORD, 'utf8').trim();
if (password.length < 12) {
  console.error(`✗ La password in ${FILE_PASSWORD} è troppo corta (${password.length} caratteri).`);
  process.exit(1);
}

const admin = createClient(URL_SUPABASE, CHIAVE_SERVIZIO, { auth: { persistSession: false } });

/** Login vero contro l'ambiente reale: è l'unica prova che la password apra l'account. */
async function provaAccesso() {
  if (!CHIAVE_PUBBLICA) return { provato: false };
  const cliente = createClient(URL_SUPABASE, CHIAVE_PUBBLICA, { auth: { persistSession: false } });
  const { data, error } = await cliente.auth.signInWithPassword({ email: EMAIL_DEMO, password });
  return { provato: true, ok: !error && !!data?.session, errore: error?.message ?? null };
}

console.log(`Account demo del revisore: ${EMAIL_DEMO}`);
console.log(`Password dedicata: ${password.length} caratteri, letta da ${FILE_PASSWORD}`);

// PostgREST e l'API admin non lanciano: restituiscono { error }. Va controllato il valore.
const { data: elenco, error: erroreElenco } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (erroreElenco) {
  console.error('✗ Lettura degli utenti fallita:', erroreElenco.message);
  process.exit(1);
}
const utente = elenco.users.find((u) => u.email?.toLowerCase() === EMAIL_DEMO);
if (!utente) {
  console.error(`✗ Nessun utente con email ${EMAIL_DEMO}.`);
  process.exit(1);
}
console.log(`Trovato: id ${utente.id}, email confermata=${!!utente.email_confirmed_at}, aggiornato ${utente.updated_at}`);

const prima = await provaAccesso();
console.log(`Accesso PRIMA: ${prima.provato ? (prima.ok ? 'riuscito' : `respinto (${prima.errore})`) : 'non provato (manca la chiave pubblica)'}`);

if (prima.ok) {
  console.log('✓ La password dedicata apre già l\'account: niente da riallineare.');
  process.exit(0);
}

if (!APPLICA) {
  console.log('\nANTEPRIMA — nessuna scrittura. Rilancia con --apply per riallineare la password.');
  process.exit(0);
}

const { error: erroreAggiornamento } = await admin.auth.admin.updateUserById(utente.id, { password });
if (erroreAggiornamento) {
  console.error('✗ Aggiornamento fallito:', erroreAggiornamento.message);
  process.exit(1);
}
console.log('Password aggiornata. Verifico con un accesso reale…');

const dopo = await provaAccesso();
if (!dopo.provato) {
  console.error('✗ Impossibile verificare: manca la chiave pubblica in .env.local. NON dichiaro riuscito.');
  process.exit(1);
}
if (!dopo.ok) {
  console.error(`✗ L'accesso è ancora respinto (${dopo.errore}). L'aggiornamento "è riuscito" senza effetto.`);
  process.exit(1);
}
console.log('✓ Accesso DOPO: riuscito. L\'account demo apre con la password dedicata.');
