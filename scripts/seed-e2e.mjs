/**
 * seed-e2e.mjs — seed deterministico per la suite Playwright (M8.2).
 *
 * Crea una scuola E2E dedicata (UUID fissi, prefisso e2e00000-…) con 2 sezioni,
 * 4 alunni, 4 utenti Auth reali (password fissa) e i dati di contorno che gli
 * spec E2E si aspettano (avviso, evento agenda, presenze, pagamenti, armadietto,
 * diario, notifica, modello+submission). Idempotente: upsert su UUID fissi +
 * reset dei soli dati E2E mutati dai test. NON tocca i dati delle altre scuole.
 *
 * Uso (dalla root del repo): node scripts/seed-e2e.mjs
 * Env richieste (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ── Env: process.env (CI) con fallback a .env.local (dev locale) ────────────
function loadEnvLocal() {
  const env = {};
  let raw;
  try {
    raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return env; // in CI .env.local non esiste: si usano le env di processo
  }
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
  console.error('Mancano NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env di processo o .env.local)');
  process.exit(1);
}

const db = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } });

// ── UUID fissi (prefisso e2e00000 = non-demo, esadecimale valido) ───────────
export const IDS = {
  SCUOLA: 'e2e00000-0000-4000-8000-000000000001',
  SEC_GIRASOLI: 'e2e00000-0000-4000-8000-000000000011',
  SEC_TULIPANI: 'e2e00000-0000-4000-8000-000000000012',
  A1: 'e2e00000-0000-4000-8000-000000000101', // Aurora Arcobaleno-E2E (Girasoli)
  A2: 'e2e00000-0000-4000-8000-000000000102', // Bruno Baleno-E2E (Girasoli)
  A3: 'e2e00000-0000-4000-8000-000000000103', // Clara Cometa-E2E (Tulipani)
  A4: 'e2e00000-0000-4000-8000-000000000104', // Dino Delfino-E2E (Tulipani)
  ADMIN: 'e2e00000-0000-4000-8000-000000000201',
  DOCENTE: 'e2e00000-0000-4000-8000-000000000202',
  GENITORE: 'e2e00000-0000-4000-8000-000000000203',
  DOPPIO: 'e2e00000-0000-4000-8000-000000000204',
  P_GENITORE: 'e2e00000-0000-4000-8000-000000000301',
  P_DOPPIO: 'e2e00000-0000-4000-8000-000000000302',
  AVVISO: 'e2e00000-0000-4000-8000-000000000401',
  EVENTO: 'e2e00000-0000-4000-8000-000000000501',
  NOTIFICA: 'e2e00000-0000-4000-8000-000000000601',
  PAG_APERTO: 'e2e00000-0000-4000-8000-000000000701',
  PAG_PAGATO: 'e2e00000-0000-4000-8000-000000000702',
  FORM_MODEL: 'e2e00000-0000-4000-8000-000000000801',
  FORM_SUB: 'e2e00000-0000-4000-8000-000000000802',
  DIARIO_UMORE: 'e2e00000-0000-4000-8000-000000000901',
  DIARIO_ATTIVITA: 'e2e00000-0000-4000-8000-000000000902',
};

export const CREDENZIALI = {
  password: 'KidvilleE2E.2026!',
  admin: 'admin.e2e@kidville.test',
  docente: 'docente.e2e@kidville.test',
  genitore: 'genitore.e2e@kidville.test',
  doppio: 'doppio.e2e@kidville.test',
};

// Artefatti del flusso pubblico di iscrizione (creati DAI TEST, puliti qui).
export const ISCRIZIONE_E2E = {
  cfChild: 'TSTBNE20A01H501X',
  cfAdult: 'TSTDLT80A01H501Y',
  email: 'iscrizione.e2e@kidville.test',
};

const ALUNNI_E2E = [IDS.A1, IDS.A2, IDS.A3, IDS.A4];
const UTENTI_E2E = [IDS.ADMIN, IDS.DOCENTE, IDS.GENITORE, IDS.DOPPIO];

function ymdUTC(offsetGiorni = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetGiorni);
  return d.toISOString().slice(0, 10);
}

function must(label, { error }) {
  if (error) throw new Error(`${label}: ${error.message ?? JSON.stringify(error)}`);
}

// Auth user con UUID fisso: createUser accetta `id`; se esiste già, reset password.
async function ensureAuthUser(id, email) {
  const { error } = await db.auth.admin.createUser({
    id,
    email,
    password: CREDENZIALI.password,
    email_confirm: true,
  });
  if (!error) return console.log(`  auth ✚ ${email}`);
  const testo = `${error.message ?? ''} ${error.code ?? ''}`;
  if (/already|exists|registered/i.test(testo)) {
    const upd = await db.auth.admin.updateUserById(id, {
      password: CREDENZIALI.password,
      email_confirm: true,
    });
    must(`auth update ${email}`, upd);
    return console.log(`  auth = ${email}`);
  }
  throw new Error(`auth create ${email}: ${error.message}`);
}

async function main() {
  console.log('🌱 Seed E2E — scuola dedicata', IDS.SCUOLA);
  const oggi = ymdUTC(0);

  // 1. Scuola (schools = tabella referenziata dalle FK; scuole = registry admin)
  must('schools', await db.from('schools').upsert(
    { id: IDS.SCUOLA, nome: 'Kidville E2E', citta: 'Testville' }, { onConflict: 'id' }));
  must('scuole', await db.from('scuole').upsert(
    { id: IDS.SCUOLA, nome: 'Kidville E2E', citta: 'Testville', attiva: true }, { onConflict: 'id' }));

  // 2. Config moduli della SOLA scuola E2E: umore attivo nel diario docente,
  //    pubblicazione avvisi consentita anche ai docenti.
  must('admin_settings', await db.from('admin_settings').upsert({
    scuola_id: IDS.SCUOLA,
    diario_config: {
      routine_attive: ['attivita', 'merenda', 'pranzo', 'nanna_inizio', 'nanna_fine', 'bagno', 'umore'],
    },
    avvisi_config: { ruoli_pubblicazione: ['admin', 'teacher'] },
  }, { onConflict: 'scuola_id' }));

  // 3. Sezioni (l'appello/diario docente sono agganciati al nome "Girasoli")
  must('sections', await db.from('sections').upsert([
    { id: IDS.SEC_GIRASOLI, scuola_id: IDS.SCUOLA, name: 'Girasoli', school_type: 'infanzia' },
    { id: IDS.SEC_TULIPANI, scuola_id: IDS.SCUOLA, name: 'Tulipani', school_type: 'infanzia' },
  ], { onConflict: 'id' }));

  // 4. Utenti Auth reali (login UI con password) + righe utenti (id == auth.users.id)
  await ensureAuthUser(IDS.ADMIN, CREDENZIALI.admin);
  await ensureAuthUser(IDS.DOCENTE, CREDENZIALI.docente);
  await ensureAuthUser(IDS.GENITORE, CREDENZIALI.genitore);
  await ensureAuthUser(IDS.DOPPIO, CREDENZIALI.doppio);

  // NB: live `utenti.role` è colonna GENERATA da `ruolo` → mai scriverla.
  must('utenti', await db.from('utenti').upsert([
    { id: IDS.ADMIN, email: CREDENZIALI.admin, nome: 'Alba', cognome: 'Admin-E2E', ruolo: 'admin', scuola_id: IDS.SCUOLA, gradi: [], attivo: true },
    { id: IDS.DOCENTE, email: CREDENZIALI.docente, nome: 'Dora', cognome: 'Docente-E2E', ruolo: 'educator', scuola_id: IDS.SCUOLA, gradi: ['infanzia'], attivo: true },
    { id: IDS.GENITORE, email: CREDENZIALI.genitore, nome: 'Gaia', cognome: 'Genitore-E2E', ruolo: 'genitore', scuola_id: IDS.SCUOLA, gradi: [], attivo: true },
    { id: IDS.DOPPIO, email: CREDENZIALI.doppio, nome: 'Duccio', cognome: 'Doppio-E2E', ruolo: 'educator', scuola_id: IDS.SCUOLA, gradi: ['infanzia'], attivo: true },
  ], { onConflict: 'id' }));

  // Docente SOLO su Girasoli (activeSection deterministica); doppio su Tulipani.
  must('utenti_sezioni', await db.from('utenti_sezioni').upsert([
    { utente_id: IDS.DOCENTE, section_id: IDS.SEC_GIRASOLI },
    { utente_id: IDS.DOPPIO, section_id: IDS.SEC_TULIPANI },
  ], { onConflict: 'utente_id,section_id' }));

  // Bridge parents.auth_user_id: per il genitore puro e per il profilo doppio
  // (utenti educator + parents → picker multi-profilo al login).
  must('parents', await db.from('parents').upsert([
    { id: IDS.P_GENITORE, first_name: 'Gaia', last_name: 'Genitore-E2E', auth_user_id: IDS.GENITORE },
    { id: IDS.P_DOPPIO, first_name: 'Duccio', last_name: 'Doppio-E2E', auth_user_id: IDS.DOPPIO },
  ], { onConflict: 'id' }));

  // 5. Alunni + legami (legame_genitori_alunni.genitore_id → utenti.id)
  must('alunni', await db.from('alunni').upsert([
    { id: IDS.A1, scuola_id: IDS.SCUOLA, nome: 'Aurora', cognome: 'Arcobaleno-E2E', data_nascita: '2022-04-10', section_id: IDS.SEC_GIRASOLI, classe_sezione: 'Girasoli', stato: 'iscritto' },
    { id: IDS.A2, scuola_id: IDS.SCUOLA, nome: 'Bruno', cognome: 'Baleno-E2E', data_nascita: '2022-07-21', section_id: IDS.SEC_GIRASOLI, classe_sezione: 'Girasoli', stato: 'iscritto' },
    { id: IDS.A3, scuola_id: IDS.SCUOLA, nome: 'Clara', cognome: 'Cometa-E2E', data_nascita: '2021-11-03', section_id: IDS.SEC_TULIPANI, classe_sezione: 'Tulipani', stato: 'iscritto' },
    { id: IDS.A4, scuola_id: IDS.SCUOLA, nome: 'Dino', cognome: 'Delfino-E2E', data_nascita: '2021-02-14', section_id: IDS.SEC_TULIPANI, classe_sezione: 'Tulipani', stato: 'iscritto' },
  ], { onConflict: 'id' }));

  must('legami', await db.from('legame_genitori_alunni').upsert([
    { genitore_id: IDS.GENITORE, alunno_id: IDS.A1 },
    { genitore_id: IDS.DOPPIO, alunno_id: IDS.A3 },
  ], { onConflict: 'genitore_id,alunno_id' }));

  // 6. Reset dei dati E2E mutabili (solo entità della scuola/utenti E2E)
  must('reset presenze', await db.from('presenze').delete().in('alunno_id', ALUNNI_E2E));
  must('reset diario', await db.from('eventi_diario').delete().in('alunno_id', ALUNNI_E2E));
  must('reset agenda', await db.from('eventi_agenda').delete().eq('scuola_id', IDS.SCUOLA));
  must('reset notifiche', await db.from('notifiche').delete().in('utente_id', UTENTI_E2E));
  must('reset risposte avviso', await db.from('avvisi_risposte').delete().eq('avviso_id', IDS.AVVISO));
  must('reset avvisi docente', await db.from('avvisi').delete().eq('author_id', IDS.DOCENTE));
  must('reset pagamenti', await db.from('pagamenti').delete().in('alunno_id', ALUNNI_E2E));
  must('reset armadietto', await db.from('armadietto').delete().in('alunno_id', ALUNNI_E2E));

  // Chat: thread e messaggi del genitore E2E
  const threads = await db.from('chat_threads').select('id').eq('parent_id', IDS.GENITORE);
  must('lettura thread', threads);
  const threadIds = (threads.data ?? []).map((t) => t.id);
  if (threadIds.length > 0) {
    must('reset chat_messages', await db.from('chat_messages').delete().in('thread_id', threadIds));
    must('reset chat_threads', await db.from('chat_threads').delete().in('id', threadIds));
  }

  // Artefatti del flusso pubblico d'iscrizione dei run precedenti
  must('reset iscrizione alunni', await db.from('alunni').delete().eq('codice_fiscale', ISCRIZIONE_E2E.cfChild));
  must('reset iscrizione parents', await db.from('parents').delete().eq('fiscal_code', ISCRIZIONE_E2E.cfAdult));
  const utenteIscr = await db.from('utenti').select('id').eq('email', ISCRIZIONE_E2E.email).maybeSingle();
  if (utenteIscr.data?.id) {
    must('reset iscrizione utenti', await db.from('utenti').delete().eq('id', utenteIscr.data.id));
    await db.auth.admin.deleteUser(utenteIscr.data.id).catch(() => {});
  }
  must('reset enrollment_submissions', await db.from('enrollment_submissions').delete()
    .contains('data', { children: [{ codice_fiscale: ISCRIZIONE_E2E.cfChild }] }));

  // 7. Presenze di oggi: SOLO Tulipani (Girasoli resta "appello mancante")
  must('presenze', await db.from('presenze').insert([
    { alunno_id: IDS.A3, data: oggi, stato: 'presente', orario_entrata: '08:45', scuola_id: IDS.SCUOLA, section_id: IDS.SEC_TULIPANI },
    { alunno_id: IDS.A4, data: oggi, stato: 'assente', scuola_id: IDS.SCUOLA, section_id: IDS.SEC_TULIPANI },
  ]));

  // 8. Diario di oggi per Aurora (timeline + umore per il diario genitore)
  const now = new Date().toISOString();
  must('eventi_diario', await db.from('eventi_diario').insert([
    { id: IDS.DIARIO_UMORE, alunno_id: IDS.A1, maestra_id: IDS.DOCENTE, tipo_evento: 'umore', orario_inizio: now, dettagli: { umore: 'felice' } },
    { id: IDS.DIARIO_ATTIVITA, alunno_id: IDS.A1, maestra_id: IDS.DOCENTE, tipo_evento: 'attivita', orario_inizio: now, dettagli: { activities: [{ tipo: 'Pittura', descrizione: 'Pittura con le dita', partecipazione: 'autonomia' }] }, nota_libera: 'Nota E2E per i genitori' },
  ]));

  // 9. Avviso (adesione ⇒ massima priorità nella card della home genitore)
  must('avvisi', await db.from('avvisi').upsert({
    id: IDS.AVVISO, author_id: IDS.ADMIN, titolo: 'Avviso E2E: uscita al parco',
    contenuto: 'Gita della sezione Girasoli: serve la vostra adesione entro venerdì.',
    tipo: 'adesione', target_scope: 'classe', target_classes: ['Girasoli'],
    scuola_id: IDS.SCUOLA, scadenza: ymdUTC(60),
  }, { onConflict: 'id' }));

  // 10. Evento agenda futuro, visibile ai genitori (sezione Girasoli)
  must('eventi_agenda', await db.from('eventi_agenda').insert({
    id: IDS.EVENTO, scuola_id: IDS.SCUOLA, section_id: IDS.SEC_GIRASOLI,
    titolo: 'Gita al museo E2E', tipo: 'uscita', data: ymdUTC(7),
    orario_inizio: '09:30', visibile_genitori: true, creato_da: IDS.ADMIN,
  }));

  // 11. Notifica non letta per l'admin (centro notifiche)
  must('notifiche', await db.from('notifiche').insert({
    id: IDS.NOTIFICA, utente_id: IDS.ADMIN, tipo: 'sistema',
    titolo: 'Notifica E2E', corpo: 'Notifica seminata per la suite Playwright.', letta_il: null,
  }));

  // 12. Pagamenti di Aurora (uno aperto + uno pagato)
  must('pagamenti', await db.from('pagamenti').insert([
    { id: IDS.PAG_APERTO, alunno_id: IDS.A1, scuola_id: IDS.SCUOLA, descrizione: 'Retta E2E luglio', importo: 150, importo_pagato: 0, scadenza: ymdUTC(10), stato: 'da_pagare', tipo: 'singolo', obbligatorio: true },
    { id: IDS.PAG_PAGATO, alunno_id: IDS.A1, scuola_id: IDS.SCUOLA, descrizione: 'Gita E2E', importo: 25, importo_pagato: 25, scadenza: ymdUTC(-5), stato: 'pagato', tipo: 'singolo', obbligatorio: false },
  ]));

  // 13. Armadietto di Aurora: stock 1 ⇒ bottone "Avvisa" visibile in home
  must('armadietto', await db.from('armadietto').insert({
    alunno_id: IDS.A1, nome_oggetto: 'Pannolini', materiale: 'Pannolini',
    quantita: 1, quantita_residua: 1, portato: true, date: oggi,
    livello_allerta: 5, livello_emergenza: 2,
  }));

  // 14. Modello form + submission "completed" non gestita (per "Segna gestita")
  must('form_models', await db.from('form_models').upsert({
    id: IDS.FORM_MODEL, title: 'Modulo E2E Gita', is_active: true,
    schema: { pages: [{ title: 'Dati', fields: [{ id: 'note', type: 'text', label: 'Note' }] }] },
  }, { onConflict: 'id' }));
  must('form_submissions', await db.from('form_submissions').upsert({
    id: IDS.FORM_SUB, model_id: IDS.FORM_MODEL, status: 'completed',
    data: { note: 'Compilazione E2E' }, gestita_il: null, gestita_da: null,
  }, { onConflict: 'id' }));

  console.log('✅ Seed E2E completato (idempotente). Oggi UTC:', oggi);
}

main().catch((err) => {
  console.error('❌ Seed E2E fallito:', err.message ?? err);
  process.exit(1);
});
