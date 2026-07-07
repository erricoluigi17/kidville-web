/**
 * seed-primaria-360.mjs — prerequisiti dati per il test 360° della PRIMARIA.
 *
 * Opera SOLO sulla sezione di test TEST 1A (prod) e su account *.test. Idempotente.
 *   1. Account: crea (se mancanti) la segreteria + i 3 docenti mancanti (→ 5 docenti),
 *      e FORZA la password nota su tutti i 16 account di test (segreteria/5 docenti/10
 *      genitori). L'admin reale (erricoluigi17) NON viene mai toccato.
 *   2. utenti_sezioni: assegna i 5 docenti a TEST 1A.
 *   3. utenti_sezioni_materie: assegna ogni materia a un titolare (5 docenti).
 *   4. alunni: completa l'anagrafica dei 10 "AlunnoN" (CF, sesso, nascita, residenza).
 *   5. parents + student_parents: crea le anagrafiche genitore visibili in Segreteria
 *      e le collega agli alunni (il legame runtime legame_genitori_alunni è già presente).
 *   6. Stampa la LISTA CREDENZIALI (email · password · ruolo · alunno collegato).
 *
 * Uso (dalla root): node e2e/primaria-360/scripts/seed-primaria-360.mjs
 * Env (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

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
if (!URL_ || !SERVICE_KEY) {
  console.error('Mancano NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } });

const SECTION = 'bb4e9f8a-c737-4d41-8634-02f8f8e48601';
const SCUOLA = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529';
const PASSWORD = 'KidvilleTest.2026!';

// Città/CAP di comodo per i dati anagrafici di test (Giugliano in Campania).
const RES = { city: 'Giugliano in Campania', prov: 'NA', zip: '80014', nation: 'Italia', cittad: 'Italiana' };
function fakeCF(prefix, n) {
  // 16 char, formato plausibile (NON valido come checksum: dati di test).
  const nn = String(n).padStart(2, '0');
  return `${prefix}L${nn}A01F839${String.fromCharCode(65 + (n % 26))}`.toUpperCase().slice(0, 16);
}

// ── map email → auth uid (listUsers paginato) ───────────────────────────────
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

async function ensureAccount(authMap, { email, nome, cognome, ruolo }) {
  const key = email.toLowerCase();
  let id = authMap.get(key);
  if (id) {
    // forza la password nota (login deterministico per Playwright)
    const { error } = await db.auth.admin.updateUserById(id, { password: PASSWORD, email_confirm: true });
    if (error) console.warn(`  ! updateUser ${email}: ${error.message}`);
  } else {
    const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`createUser ${email}: ${error.message}`);
    id = data.user.id;
    authMap.set(key, id);
  }
  // upsert riga utenti (id = auth uid); `role`/`first_name`/`last_name` sono colonne
  // GENERATE (da ruolo/nome/cognome) → non scriverle.
  const { error: upErr } = await db.from('utenti').upsert({
    id, email, nome, cognome,
    ruolo, gradi: ['primaria'], scuola_id: SCUOLA, attivo: true,
  }, { onConflict: 'id' });
  if (upErr) throw new Error(`utenti upsert ${email}: ${upErr.message}`);
  return id;
}

async function main() {
  console.log('▸ Carico gli utenti Auth…');
  const authMap = await buildAuthMap();

  // 1. Account (segreteria + 5 docenti)
  console.log('▸ Account segreteria + docenti (forzo password nota)…');
  const segreteriaId = await ensureAccount(authMap, {
    email: 'test.pri.segreteria@kidville.test', nome: 'Segreteria', cognome: 'Test PRI', ruolo: 'coordinator',
  });
  const docenteIds = [];
  for (let n = 1; n <= 5; n++) {
    const id = await ensureAccount(authMap, {
      email: `test.pri.docente${n}@kidville.test`, nome: `Docente${n}`, cognome: 'Test PRI', ruolo: 'educator',
    });
    docenteIds.push(id);
  }

  // Genitori: forzo la password nota su quelli esistenti (1..10)
  console.log('▸ Forzo password nota sui 10 genitori…');
  const { data: genitoriRows } = await db.from('utenti')
    .select('id,email,nome').like('email', 'test.pri.genitore%@kidville.test');
  const genitori = (genitoriRows ?? []).map((g) => ({
    ...g, n: Number((g.email.match(/genitore(\d+)@/) || [])[1] || 0),
  })).sort((a, b) => a.n - b.n);
  for (const g of genitori) {
    const { error } = await db.auth.admin.updateUserById(g.id, { password: PASSWORD, email_confirm: true });
    if (error) console.warn(`  ! updateUser ${g.email}: ${error.message}`);
  }

  // 2. utenti_sezioni (5 docenti → TEST 1A)
  console.log('▸ Assegno i 5 docenti alla sezione…');
  await db.from('utenti_sezioni').delete().eq('section_id', SECTION).in('utente_id', docenteIds);
  await db.from('utenti_sezioni').insert(docenteIds.map((utente_id) => ({ utente_id, section_id: SECTION })));

  // 3. Materie → titolare
  console.log('▸ Assegno le materie ai docenti…');
  const { data: materie } = await db.from('materie').select('id,nome').eq('section_id', SECTION);
  const byName = (nm) => materie.find((m) => m.nome === nm)?.id;
  const assign = [
    ['Italiano', 0], ['Storia', 0], ['Geografia', 0],
    ['Matematica', 1], ['Scienze', 1], ['Tecnologia', 1],
    ['Inglese', 2], ['Musica', 2],
    ['Arte e Immagine', 3], ['Educazione Fisica', 3],
    ['Religione/Alternativa', 4], ['Educazione Civica', 4],
  ];
  await db.from('utenti_sezioni_materie').delete().eq('section_id', SECTION).in('utente_id', docenteIds);
  const usmRows = assign
    .map(([nm, di]) => ({ materia: byName(nm), utente: docenteIds[di] }))
    .filter((r) => r.materia)
    .map((r) => ({ utente_id: r.utente, section_id: SECTION, materia_id: r.materia, e_contitolare: false }));
  await db.from('utenti_sezioni_materie').insert(usmRows);

  // 4. Alunni: completa anagrafica dei 10 "AlunnoN"
  console.log('▸ Completo le anagrafiche alunni…');
  const { data: alunniRows } = await db.from('alunni')
    .select('id,nome,cognome').eq('section_id', SECTION).ilike('nome', 'Alunno%');
  const alunni = (alunniRows ?? []).map((a) => ({
    ...a, n: Number((a.nome.match(/Alunno(\d+)/) || [])[1] || 0),
  })).sort((a, b) => a.n - b.n);
  for (const a of alunni) {
    const male = a.n % 2 === 1;
    await db.from('alunni').update({
      codice_fiscale: fakeCF('TSP', a.n),
      gender: male ? 'M' : 'F',
      birth_city: RES.city, birth_province: RES.prov, birth_nation: RES.nation, citizenship: RES.cittad,
      residence_address: `Via delle Scuole ${a.n}`, residence_street_number: String(a.n),
      residence_city: RES.city, residence_province: RES.prov, zip_code: RES.zip,
    }).eq('id', a.id);
  }

  // 5. parents + student_parents (anagrafica genitore visibile in Segreteria)
  console.log('▸ Creo/collego le anagrafiche genitore (parents + student_parents)…');
  // Genitore{n} ↔ Alunno{n} secondo il legame runtime già esistente.
  const alunnoByN = new Map(alunni.map((a) => [a.n, a]));
  const parentUuid = (n) => `e2e36000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`;
  // Pulisco eventuali legami student_parents di questi alunni (idempotenza)
  const alunnoIds = alunni.map((a) => a.id);
  await db.from('student_parents').delete().in('student_id', alunnoIds);
  for (const g of genitori) {
    const a = alunnoByN.get(g.n);
    if (!a) continue;
    const male = g.n % 3 === 0; // mix padre/madre
    const pid = parentUuid(g.n);
    await db.from('parents').upsert({
      id: pid, first_name: `Genitore${g.n}`, last_name: 'Test PRI',
      gender: male ? 'M' : 'F', birth_date: '1985-05-15',
      citizenship: RES.cittad, birth_nation: RES.nation, birth_province: RES.prov, birth_city: RES.city,
      fiscal_code: fakeCF('GNT', g.n),
      residence_address: `Via delle Scuole ${g.n}`, residence_street_number: String(g.n),
      residence_city: RES.city, residence_province: RES.prov, zip_code: RES.zip,
      phone_numbers: [`33300000${String(g.n).padStart(2, '0')}`],
      emails: [g.email],
    }, { onConflict: 'id' });
    await db.from('student_parents').insert({
      student_id: a.id, parent_id: pid,
      relation_type: male ? 'father' : 'mother', is_primary: true,
    });
  }

  // 6. Lista credenziali
  const creds = [
    { email: 'test.pri.segreteria@kidville.test', ruolo: 'Segreteria (coordinator)', alunno: '—' },
    ...docenteIds.map((_, i) => ({ email: `test.pri.docente${i + 1}@kidville.test`, ruolo: 'Docente (educator)', alunno: '—' })),
    ...genitori.map((g) => ({ email: g.email, ruolo: 'Genitore', alunno: (alunnoByN.get(g.n) ? `Alunno${g.n} Test PRI` : '—') })),
  ].map((c) => ({ ...c, password: PASSWORD }));

  console.log('\n=== LISTA CREDENZIALI (TEST 1A) ===');
  for (const c of creds) console.log(`${c.email}  |  ${PASSWORD}  |  ${c.ruolo}  |  ${c.alunno}`);

  const outPath = new URL('../run-credentials.json', import.meta.url);
  writeFileSync(outPath, JSON.stringify({ section: SECTION, password: PASSWORD, accounts: creds }, null, 2));
  console.log(`\n✓ Seed completo. Credenziali salvate in ${outPath.pathname}`);
}

main().catch((e) => { console.error('SEED FALLITO:', e); process.exit(1); });
