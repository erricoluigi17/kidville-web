/**
 * crea-account-tester.mjs — crea gli account di prova mancanti per il collaudo
 * chiuso di Google Play: genitori (con il loro alunno fittizio) e docenti.
 *
 * PERCHÉ TUTTO SU **KIDVILLE CESA**, e non su Giugliano.
 *
 *   Un account `educator` è agganciato alla SEDE (`utenti.scuola_id`), non alla
 *   sezione: vede tutte le classi del plesso. Misurato il 2026-08-05:
 *
 *     Kidville Giugliano  20 alunni TEST  ·  5 REALI      ← docente vede 5 bambini veri
 *     Kidville Aversa      1 alunno  TEST ·  1 REALE      ← docente vede 1 bambino vero
 *     Kidville Cesa        1 alunno  TEST ·  0 REALI      ← unica sede pulita
 *
 *   In più la sezione `TEST 1A` di Giugliano — che il nome fa sembrare finta —
 *   contiene **2 bambini veri**, con codice fiscale e, per uno dei due, dati
 *   sanitari. Creare lì un docente significherebbe consegnare quei dati a un tester.
 *
 *   Perciò: tutto quello che questo script crea vive su **Cesa**, dove oggi non
 *   esiste nessun alunno reale. Il controllo è rifatto A RUNTIME e lo script si
 *   FERMA se nel frattempo a Cesa è comparso un alunno vero.
 *
 * LA PASSWORD NON È IN QUESTO FILE e non viene mai stampata. Viene letta da
 * `docs/collaudo/risultati/messaggi-tester-pronti.md`, che generi tu da terminale.
 * Il repository è pubblico.
 *
 * ⚠️ `test.inf.genitore1@kidville.test` NON viene toccato: è l'account consegnato
 * ad Apple e ha una password dedicata (vedi `allinea-password-revisore.mjs`).
 *
 * Uso (dalla root del repo):
 *   node scripts/crea-account-tester.mjs                      → ANTEPRIMA, non scrive
 *   node scripts/crea-account-tester.mjs --apply              → crea davvero
 *   node scripts/crea-account-tester.mjs --genitori 8 --docenti 4 --apply
 *
 * Env richieste (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const SEDE = 'Kidville Cesa';
const PREFISSO = 'test.cesa.collaudo';
const FILE_PASSWORD = 'docs/collaudo/risultati/messaggi-tester-pronti.md';
const APPLICA = process.argv.includes('--apply');

const arg = (nome, pre) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : pre;
};
const N_GENITORI = arg('genitori', 8);
const N_DOCENTI = arg('docenti', 4);

function caricaEnvLocal() {
  const env = {};
  if (!existsSync('.env.local')) return env;
  for (const riga of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = riga.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = { ...caricaEnvLocal(), ...process.env };
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const CHIAVE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !CHIAVE) {
  console.error('Mancano NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

if (!existsSync(FILE_PASSWORD)) {
  console.error(`Non trovo ${FILE_PASSWORD}.\nLancia prima:  bash docs/collaudo/risultati/genera-messaggi-tester.sh`);
  process.exit(1);
}
const PASSWORD = readFileSync(FILE_PASSWORD, 'utf8').match(/^password:[ \t]*(.+)$/m)?.[1]?.trim();
if (!PASSWORD) {
  console.error('Nessuna password trovata nel file sorgente. Non ho creato niente.');
  process.exit(1);
}

const db = createClient(URL, CHIAVE, { auth: { persistSession: false } });

// ── Guardia: la sede deve essere priva di alunni reali ────────────────────────
const { data: sede, error: eSede } = await db
  .from('scuole').select('id, nome').eq('nome', SEDE).maybeSingle();
if (eSede || !sede) { console.error(`Sede "${SEDE}" non trovata:`, eSede?.message); process.exit(1); }

const { data: alunniSede, error: eAlunni } = await db
  .from('alunni').select('nome, cognome, section_id').eq('scuola_id', sede.id).is('anonimizzato_il', null);
if (eAlunni) { console.error('Lettura alunni fallita:', eAlunni.message); process.exit(1); }

const reali = alunniSede.filter((a) => !`${a.nome} ${a.cognome}`.toUpperCase().includes('TEST'));
if (reali.length > 0) {
  console.error(
    `\n🔴 FERMO. Su "${SEDE}" risultano ${reali.length} alunni NON marcati TEST.\n` +
    `   Un docente creato qui li vedrebbe. Nessun account è stato creato.\n`
  );
  process.exit(2);
}

const { data: sezioni } = await db
  .from('sections').select('id, name').eq('scuola_id', sede.id).order('name');
const sezione = sezioni?.find((s) => s.name.toUpperCase().includes('TEST')) ?? sezioni?.[0];
if (!sezione) { console.error(`Nessuna sezione su "${SEDE}".`); process.exit(1); }

// ── Anteprima ─────────────────────────────────────────────────────────────────
const genitori = Array.from({ length: N_GENITORI }, (_, i) => `${PREFISSO}.genitore${i + 1}@kidville.test`);
const docenti = Array.from({ length: N_DOCENTI }, (_, i) => `${PREFISSO}.docente${i + 1}@kidville.test`);

console.log(`\nSede:    ${sede.nome}  (${reali.length} alunni reali — via libera)`);
console.log(`Sezione: ${sezione.name}`);
console.log(`\nGenitori da creare (${genitori.length}), ognuno con un alunno fittizio:`);
genitori.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2)}. ${e}`));
console.log(`\nDocenti da creare (${docenti.length}), agganciati alla sede:`);
docenti.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2)}. ${e}`));

if (!APPLICA) {
  console.log('\nANTEPRIMA — non ho scritto niente. Rilancia con --apply per creare.\n');
  process.exit(0);
}

// ── Creazione ─────────────────────────────────────────────────────────────────
async function creaUtente(email, ruolo, nome, cognome) {
  const esistente = await db.from('utenti').select('id').eq('email', email).maybeSingle();
  if (esistente.data) return { id: esistente.data.id, gia: true };

  const { data, error } = await db.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error) throw new Error(`auth ${email}: ${error.message}`);

  // `utenti.role` è una colonna GENERATA da `ruolo`: non si scrive mai.
  const { error: eIns } = await db.from('utenti').insert({
    id: data.user.id, email, nome, cognome, ruolo, scuola_id: sede.id, attivo: true,
  });
  if (eIns) throw new Error(`utenti ${email}: ${eIns.message}`);
  return { id: data.user.id, gia: false };
}

let creati = 0, saltati = 0;

for (const [i, email] of genitori.entries()) {
  const n = i + 1;
  try {
    const u = await creaUtente(email, 'genitore', `GENITORE${n}`, 'TEST COLLAUDO');
    if (u.gia) { console.log(`  = ${email} (già presente)`); saltati++; continue; }

    const { data: alunno, error: eA } = await db.from('alunni').insert({
      scuola_id: sede.id, section_id: sezione.id,
      nome: `ALUNNO${n}`, cognome: 'TEST COLLAUDO',
      data_nascita: '2021-09-01', classe_sezione: sezione.name, stato: 'attivo',
    }).select('id').single();
    if (eA) throw new Error(`alunni: ${eA.message}`);

    const { data: genitore, error: eP } = await db.from('parents').insert({
      first_name: `GENITORE${n}`, last_name: 'TEST COLLAUDO', auth_user_id: u.id,
    }).select('id').single();
    if (eP) throw new Error(`parents: ${eP.message}`);

    const { error: eL } = await db.from('student_parents').insert({
      student_id: alunno.id, parent_id: genitore.id, relation_type: 'madre', is_primary: true,
    });
    if (eL) throw new Error(`student_parents: ${eL.message}`);

    console.log(`  ✔ ${email}  →  ALUNNO${n} TEST COLLAUDO`);
    creati++;
  } catch (err) {
    console.error(`  ✘ ${email}: ${err.message}`);
  }
}

for (const [i, email] of docenti.entries()) {
  try {
    const u = await creaUtente(email, 'educator', `MAESTRA${i + 1}`, 'TEST COLLAUDO');
    if (u.gia) { console.log(`  = ${email} (già presente)`); saltati++; continue; }
    console.log(`  ✔ ${email}`);
    creati++;
  } catch (err) {
    console.error(`  ✘ ${email}: ${err.message}`);
  }
}

console.log(`\nFatto — creati ${creati}, già presenti ${saltati}.`);
console.log('Password: la stessa degli altri account di prova (non stampata).\n');
