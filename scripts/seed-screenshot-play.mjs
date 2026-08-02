/**
 * seed-screenshot-play.mjs — prepara la sezione TEST Infanzia per la cattura
 * degli screenshot della scheda Google Play (C3).
 *
 * Fa due cose molto diverse, e vanno tenute distinte:
 *
 *   1. RIPARA una catena d'identità rotta. `test.inf.genitore1@kidville.test`
 *      — l'account che il dossier indica di consegnare ai revisori Apple e
 *      Google — esiste in `auth.users` ma NON in `utenti`: si autentica e resta
 *      senza identità applicativa. E nessuno dei 10 alunni della sezione TEST
 *      Infanzia è collegato ad alcun genitore, quindi ogni account genitore
 *      Infanzia vede un'app vuota. Questa parte NON si annulla con --revert:
 *      è la correzione di un difetto, non un dato di scena.
 *
 *   2. POPOLA i dati di scena (diario di oggi, presenze, menù della mensa) che
 *      servono a non fotografare schermate vuote. Questa parte è taggata con
 *      uuid dal prefisso 5ee00000 e si annulla con --revert.
 *
 * Il menù mensa è l'unica scrittura che esce dal perimetro della sezione TEST:
 * la rotazione è per SCUOLA, quindi diventa visibile anche alle famiglie reali.
 * Per questo --revert esiste, e per questo va lanciato subito dopo la cattura.
 *
 * Uso (dalla root del repo):
 *   node scripts/seed-screenshot-play.mjs            → ANTEPRIMA, non scrive nulla
 *   node scripts/seed-screenshot-play.mjs --apply    → scrive
 *   node scripts/seed-screenshot-play.mjs --revert   → rimuove i soli dati di scena
 *
 * Env richieste (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnvLocal() {
  const env = {};
  let raw;
  try {
    raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return env;
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

const SEZIONE = '219cab6a-2bf3-48d6-a443-b7aecda40f42';
const EMAIL_DEMO = 'test.inf.genitore1@kidville.test';

/**
 * La sede NON è cablata: si DERIVA dalla sezione TEST su cui lo script lavora
 * (`sections.scuola_id`), e si risolve in `main()`. Fino al 2026-07-31 qui c'era
 * l'uuid di Giugliano scritto a mano: dal 2026-07-29 le sedi sono tre, e una
 * costante che vale per la sede di oggi non vale per nessuna di domani. Ricavarla
 * dal dato la rende giusta per costruzione — soprattutto per il menù mensa, che
 * si scrive PER SCUOLA e lo vedrebbero le famiglie del plesso sbagliato.
 */
let SCUOLA = null;
let NOME_SCUOLA = '';

// uuid dal prefisso riconoscibile: --revert ritrova ed elimina solo questi.
const TAG = '5ee00000';
const uid = (n) => `${TAG}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const MODO = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--revert') ? 'revert'
  : 'anteprima';

const scrive = MODO === 'apply';
const azioni = [];
const nota = (t) => azioni.push(t);

/** PostgREST non lancia: ritorna { error }. Va sempre controllato il valore. */
function must(etichetta, res) {
  if (res?.error) {
    console.error(`  ✗ ${etichetta}: ${res.error.message}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

const ymd = (d) => d.toISOString().slice(0, 10);

async function main() {
  console.log(`\n── seed screenshot Play — modo: ${MODO.toUpperCase()} ──`);
  console.log(`   sezione TEST Infanzia ${SEZIONE}`);

  // ── Sede: derivata dalla sezione, mai cablata ────────────────────────────
  const { data: sezione, error: errSezione } = await db
    .from('sections').select('id, name, scuola_id').eq('id', SEZIONE).maybeSingle();
  if (errSezione) { console.error('lettura sezione:', errSezione.message); process.exit(1); }
  if (!sezione) { console.error(`la sezione ${SEZIONE} non esiste`); process.exit(1); }
  if (!sezione.scuola_id) {
    console.error(`la sezione ${SEZIONE} non dichiara la sua sede (sections.scuola_id vuoto): non si indovina`);
    process.exit(1);
  }
  SCUOLA = sezione.scuola_id;
  const { data: scuolaRow, error: errScuola } = await db
    .from('schools').select('nome').eq('id', SCUOLA).maybeSingle();
  if (errScuola) { console.error('lettura sede:', errScuola.message); process.exit(1); }
  NOME_SCUOLA = scuolaRow?.nome ?? SCUOLA;
  console.log(`   sede: ${NOME_SCUOLA} (${SCUOLA})`);
  if (!scrive && MODO !== 'revert') console.log('   (nessuna scrittura: passa --apply per applicare)\n');

  // ── Alunni della sezione TEST ────────────────────────────────────────────
  const { data: alunni, error: errAlunni } = await db
    .from('alunni').select('id').eq('section_id', SEZIONE).order('id');
  if (errAlunni) { console.error('lettura alunni:', errAlunni.message); process.exit(1); }
  if (!alunni?.length) { console.error('nessun alunno nella sezione TEST'); process.exit(1); }
  console.log(`   ${alunni.length} alunni nella sezione`);

  // ── Genitori di test Infanzia in auth.users ──────────────────────────────
  const { data: authList, error: errAuth } = await db.auth.admin.listUsers({ perPage: 200 });
  if (errAuth) { console.error('lettura auth.users:', errAuth.message); process.exit(1); }
  const authInf = authList.users
    .filter((u) => /^test\.inf\.genitore\d+@kidville\.test$/.test(u.email ?? ''))
    .sort((a, b) => {
      const n = (e) => Number(e.email.match(/genitore(\d+)@/)[1]);
      return n(a) - n(b);
    });
  const authDemo = authInf.find((u) => u.email === EMAIL_DEMO);
  if (!authDemo) { console.error(`${EMAIL_DEMO} non esiste nemmeno in auth.users`); process.exit(1); }

  if (MODO === 'revert') return revert(alunni);

  // ══ 1. RIPARAZIONE — righe `utenti` mancanti ═════════════════════════════
  const { data: utentiEsistenti } = await db
    .from('utenti').select('id, email').in('email', authInf.map((u) => u.email));
  const emailConUtente = new Set((utentiEsistenti ?? []).map((u) => u.email));
  const daCreare = authInf.filter((u) => !emailConUtente.has(u.email));

  if (daCreare.length) {
    nota(`RIPARA ${daCreare.length} riga/e 'utenti' mancante/i: ${daCreare.map((u) => u.email).join(', ')}`);
    if (scrive) {
      // `utenti.role`/`first_name`/`last_name` sono GENERATE: non si scrivono mai.
      const righe = daCreare.map((u) => {
        const n = u.email.match(/genitore(\d+)@/)[1];
        return {
          id: u.id, email: u.email, nome: 'Genitore', cognome: `TEST ${n}`,
          ruolo: 'genitore', scuola_id: SCUOLA, attivo: true,
        };
      });
      must('utenti', await db.from('utenti').upsert(righe, { onConflict: 'id' }));
    }
  } else {
    nota("nessuna riga 'utenti' da riparare");
  }

  // ══ 2. RIPARAZIONE — righe `parents` mancanti ════════════════════════════
  const { data: utentiOra } = await db
    .from('utenti').select('id, email').in('email', authInf.map((u) => u.email));
  const perEmail = new Map((utentiOra ?? []).map((u) => [u.email, u.id]));

  const { data: parentsEsistenti } = await db
    .from('parents').select('id, auth_user_id').in('auth_user_id', [...perEmail.values()]);
  const authConParent = new Set((parentsEsistenti ?? []).map((p) => p.auth_user_id));

  const parentsDaCreare = authInf
    .filter((u) => perEmail.has(u.email) && !authConParent.has(perEmail.get(u.email)))
    .map((u, i) => {
      const n = u.email.match(/genitore(\d+)@/)[1];
      return {
        id: uid(900 + i), first_name: 'Genitore', last_name: `TEST ${n}`,
        auth_user_id: perEmail.get(u.email), emails: [u.email],
        // Senza questi due il genitore finisce sul flusso di onboarding e non
        // sulla home: per la cattura serve la home, e il gate Termini (C5)
        // altrimenti blocca la chat.
        consensi_gdpr: { privacy: true, termini: true },
        onboarded_at: new Date().toISOString(),
      };
    });

  if (parentsDaCreare.length) {
    nota(`RIPARA ${parentsDaCreare.length} riga/e 'parents' mancante/i`);
    if (scrive) must('parents', await db.from('parents').upsert(parentsDaCreare, { onConflict: 'id' }));
  } else {
    nota("nessuna riga 'parents' da riparare");
  }

  // I consensi servono anche ai `parents` che esistevano già.
  const idsParent = [...(parentsEsistenti ?? []).map((p) => p.id), ...parentsDaCreare.map((p) => p.id)];
  nota(`imposta consensi GDPR + onboarding su ${idsParent.length} genitori di test`);
  if (scrive && idsParent.length) {
    must('consensi', await db.from('parents')
      .update({ consensi_gdpr: { privacy: true, termini: true }, onboarded_at: new Date().toISOString() })
      .in('id', idsParent));
  }

  // ══ 3. RIPARAZIONE — legami alunno↔genitore ══════════════════════════════
  const { data: parentsOra } = await db
    .from('parents').select('id, auth_user_id').in('auth_user_id', [...perEmail.values()]);
  const parentPerAuth = new Map((parentsOra ?? []).map((p) => [p.auth_user_id, p.id]));

  const legami = [];
  authInf.forEach((u, i) => {
    const pid = parentPerAuth.get(perEmail.get(u.email));
    const alunno = alunni[i];
    if (pid && alunno) legami.push({ student_id: alunno.id, parent_id: pid, relation_type: 'madre', is_primary: true });
  });

  const { data: legamiEsistenti } = await db
    .from('student_parents').select('student_id, parent_id')
    .in('student_id', alunni.map((a) => a.id));
  const giaLegati = new Set((legamiEsistenti ?? []).map((l) => `${l.student_id}|${l.parent_id}`));
  const legamiNuovi = legami.filter((l) => !giaLegati.has(`${l.student_id}|${l.parent_id}`));

  nota(`COLLEGA ${legamiNuovi.length} alunni ai rispettivi genitori di test (oggi ne risultano collegati ${legamiEsistenti?.length ?? 0})`);
  if (scrive && legamiNuovi.length) {
    must('student_parents', await db.from('student_parents')
      .upsert(legamiNuovi, { onConflict: 'student_id,parent_id' }));
  }

  // Il bambino dell'account demo: il primo della sezione.
  const alunnoDemo = alunni[0].id;

  // ══ 4. DATI DI SCENA — diario di oggi ════════════════════════════════════
  // `creato_il` retrodatato di 3 ore: il genitore vede una voce solo dopo
  // `admin_settings.diario_config.buffer_visibilita_min` (assente per Giugliano
  // → fallback 10'). Tre ore è margine abbondante.
  const ora = new Date();
  const creato = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  const alle = (h, m) => {
    const d = new Date(ora); d.setHours(h, m, 0, 0); return d.toISOString();
  };

  const { data: docente } = await db
    .from('utenti').select('id').eq('ruolo', 'docente').eq('scuola_id', SCUOLA).limit(1).maybeSingle();

  const diario = [
    { id: uid(1), tipo_evento: 'umore', orario_inizio: alle(9, 15), dettagli: { umore: 'sereno' } },
    { id: uid(2), tipo_evento: 'merenda', orario_inizio: alle(10, 0), dettagli: { corsi: { merenda: 'tutto' } } },
    { id: uid(3), tipo_evento: 'attivita', orario_inizio: alle(10, 30), dettagli: { activities: [
      { tipo: 'pittura', descrizione: 'i colori dell’estate', partecipazione: 'autonomia' },
      { tipo: 'musica', descrizione: 'canzoncine con le maracas', partecipazione: 'aiuto' },
    ] }, nota_libera: 'Giornata serena, ha partecipato volentieri alle attività di gruppo.' },
    { id: uid(4), tipo_evento: 'pranzo', orario_inizio: alle(12, 15), dettagli: { corsi: { primo: 'tutto', secondo: 'quasi', contorno: 'meta', frutta: 'tutto' } } },
    { id: uid(5), tipo_evento: 'bagno', orario_inizio: alle(13, 0), dettagli: { pipi: 2, cacca: 1, vasino: 1 } },
  ].map((e) => ({ ...e, alunno_id: alunnoDemo, maestra_id: docente?.id ?? null, creato_il: creato, pubblicato: true }));

  nota(`SCRIVE ${diario.length} voci di diario per oggi (creato_il retrodatato di 3 ore)`);
  if (scrive) must('eventi_diario', await db.from('eventi_diario').upsert(diario, { onConflict: 'id' }));

  // ══ 5. DATI DI SCENA — presenze ══════════════════════════════════════════
  const presenze = [];
  for (let i = 0, giorni = 0; giorni < 10 && i < 21; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    giorni++;
    const assente = giorni === 4;
    presenze.push({
      alunno_id: alunnoDemo, data: ymd(d), scuola_id: SCUOLA, section_id: SEZIONE,
      stato: assente ? 'assente' : 'presente',
      giustificata: assente, // NOT NULL: va valorizzata sempre, non solo sulle assenze
      ...(assente
        ? { giustificazione_testo: 'Visita medica programmata.' }
        : { orario_entrata: '08:45', orario_uscita: '16:00' }),
    });
  }
  nota(`SCRIVE ${presenze.length} presenze (ultimi 10 giorni di scuola, una giustificata)`);
  if (scrive) must('presenze', await db.from('presenze').upsert(presenze, { onConflict: 'alunno_id,data' }));

  // ══ 6. DATI DI SCENA — menù mensa (ATTENZIONE: per SCUOLA) ═══════════════
  // `mensa_class_menu_assignment` è vuota: la scuola lavora in «menù unico» e il
  // server filtra `menu_config_id IS NULL`. Una riga con menu_config_id
  // valorizzato viene esclusa IN SILENZIO e la pagina continua a dire
  // «menu non ancora pubblicato».
  const PORTATE = [
    { primo: 'Pasta al pomodoro', secondo: 'Bocconcini di pollo', contorno: 'Carote julienne', frutta: 'Mela' },
    { primo: 'Riso alle verdure', secondo: 'Merluzzo al forno', contorno: 'Fagiolini', frutta: 'Pera' },
    { primo: 'Pasta e ceci', secondo: 'Frittata di zucchine', contorno: 'Insalata mista', frutta: 'Banana' },
    { primo: 'Gnocchi al pesto', secondo: 'Prosciutto cotto', contorno: 'Purè di patate', frutta: 'Macedonia' },
    { primo: 'Minestrone', secondo: 'Mozzarella', contorno: 'Pomodori', frutta: 'Uva' },
  ];
  // `settimana` NON è la settimana dell'anno: è l'indice di rotazione 1..N
  // (`rotationWeekIndex` = ((settimanaISO - 1) % N) + 1, vincolo CHECK 1..8).
  // Riempiendo tutte le settimane della rotazione e tutti i giorni attivi, il
  // menù si risolve qualunque sia la data della cattura.
  const { data: cfg } = await db.from('admin_settings')
    .select('mensa_settimane_rotazione, mensa_giorni_attivi').eq('scuola_id', SCUOLA).maybeSingle();
  const nSettimane = cfg?.mensa_settimane_rotazione ?? 4;
  const giorniAttivi = cfg?.mensa_giorni_attivi ?? [1, 2, 3, 4, 5];

  const menu = [];
  for (let s = 1; s <= nSettimane; s++) {
    for (const g of giorniAttivi) {
      menu.push({
        id: uid(100 + s * 10 + g), scuola_id: SCUOLA, settimana: s, giorno_settimana: g,
        portate: PORTATE[(s + g) % PORTATE.length], ingredienti: {}, allergeni: {},
        menu_config_id: null, note: null,
      });
    }
  }
  nota(`SCRIVE ${menu.length} righe di menù (${nSettimane} settimane di rotazione × ${giorniAttivi.length} giorni) — ⚠️ è per SCUOLA: lo vedranno tutte le famiglie di ${NOME_SCUOLA}, non solo la sezione TEST. Rimuoverlo con --revert subito dopo la cattura.`);
  if (scrive) must('mensa_menu_rotazione', await db.from('mensa_menu_rotazione').upsert(menu, { onConflict: 'id' }));

  console.log('\n── cosa fa ──');
  azioni.forEach((a) => console.log(`   • ${a}`));
  console.log(scrive ? '\n✅ applicato.\n' : '\n(anteprima: nulla è stato scritto. Aggiungi --apply)\n');
}

async function revert(alunni) {
  console.log('\n   rimuove i soli DATI DI SCENA (la riparazione dell’identità resta)\n');
  const like = `${TAG}-%`;
  must('menù mensa', await db.from('mensa_menu_rotazione').delete().like('id', like));
  must('diario', await db.from('eventi_diario').delete().like('id', like));
  // Solo il bambino dell'account demo, non l'intera sezione: le altre presenze
  // non le ha scritte questo script.
  const { count } = await db.from('presenze').delete({ count: 'exact' })
    .eq('alunno_id', alunni[0].id)
    .gte('data', ymd(new Date(Date.now() - 21 * 86400000)));
  console.log(`   presenze rimosse: ${count ?? 0}`);
  console.log('\n✅ dati di scena rimossi.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
