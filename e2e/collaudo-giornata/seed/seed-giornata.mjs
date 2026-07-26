/**
 * seed-giornata.mjs — account opzionali per la campagna «collaudo-giornata».
 * Crea (idempotente) gli account che il roster TEST non ha: cuoca e docente misto.
 * I legami (multi-figlio, infanzia+primaria), i delegati e il dirottamento email OTP
 * sono già applicati via SQL (Supabase MCP). Opera SOLO su account *.test, sede
 * Giugliano. L'admin reale non viene mai toccato.
 *
 * Uso (dalla root): node e2e/collaudo-giornata/seed/seed-giornata.mjs
 * Env (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Env (shell):      KV_TEST_PASSWORD — password comune degli account TEST, non è nel repo.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { requireTestPassword } from '../../lib/test-password.mjs';

function loadEnvLocal() {
  const env = {};
  let raw;
  try { raw = readFileSync(new URL('../../../.env.local', import.meta.url), 'utf8'); }
  catch { return env; }
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const fileEnv = loadEnvLocal();
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !SERVICE_KEY) { console.error('Mancano env Supabase'); process.exit(1); }
const db = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } });

const SCUOLA = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529';
const PASSWORD = requireTestPassword();

const ACCOUNTS = [
  { email: 'test.cuoca@kidville.test', nome: 'Cuoca', cognome: 'Test E2E', ruolo: 'cuoca', gradi: [] },
  { email: 'test.misto.docente@kidville.test', nome: 'Docente Misto', cognome: 'Test E2E', ruolo: 'educator', gradi: ['infanzia', 'primaria'] },
];

async function buildAuthMap() {
  const map = new Map();
  for (let page = 1; page <= 40; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) if (u.email) map.set(u.email.toLowerCase(), u.id);
    if (data.users.length < 200) break;
  }
  return map;
}

async function run() {
  const authMap = await buildAuthMap();
  for (const acc of ACCOUNTS) {
    const key = acc.email.toLowerCase();
    let id = authMap.get(key);
    if (id) {
      const { error } = await db.auth.admin.updateUserById(id, { password: PASSWORD, email_confirm: true });
      if (error) console.warn(`  ! updateUser ${acc.email}: ${error.message}`);
    } else {
      const { data, error } = await db.auth.admin.createUser({ email: acc.email, password: PASSWORD, email_confirm: true });
      if (error) { console.error(`createUser ${acc.email}: ${error.message}`); continue; }
      id = data.user.id;
    }
    // upsert utenti (id = auth uid; mai scrivere role/first_name/last_name — generati)
    const { error: upErr } = await db.from('utenti').upsert({
      id, email: acc.email, nome: acc.nome, cognome: acc.cognome,
      ruolo: acc.ruolo, scuola_id: SCUOLA, gradi: acc.gradi, attivo: true,
    }, { onConflict: 'id' });
    if (upErr) console.error(`  ! upsert utenti ${acc.email}: ${upErr.message}`);
    else console.log(`  ok ${acc.email} (${acc.ruolo}) → ${id}`);
  }
  console.log('seed-giornata completato.');
}
run().catch((e) => { console.error(e); process.exit(1); });
