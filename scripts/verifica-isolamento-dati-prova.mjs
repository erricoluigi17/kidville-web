/**
 * verifica-isolamento-dati-prova.mjs — controlla che nessun dato di collaudo sia
 * tornato dentro una sede VERA.
 *
 * PERCHÉ ESISTE. Il 2026-08-24 tutti i dati di prova sono stati spostati in una
 * sede dedicata, perché fino a quel giorno vivevano dentro le sedi vere: il KPI
 * «Studenti iscritti» che vede la segreteria contava 22 bambini inesistenti a
 * Giugliano, 2 ad Aversa e 1 a Cesa, e `Collaudo ProvaAversa` sedeva nella
 * sezione REALE «3 ANNI» di Aversa — nel registro di una maestra vera.
 *
 * Lo spostamento è stato un'operazione una-tantum. Questo file NON la ripete:
 * verifica che regga. Un account di collaudo creato domani dentro Giugliano
 * rimetterebbe il problema dov'era, e nessun test unitario può accorgersene
 * perché il difetto vive nei DATI, non nel codice.
 *
 * COME RICONOSCE UNA SEDE FINTA. Solo dal PREFISSO `e2e00000` dell'uuid, lo
 * stesso segnale di `isScuolaE2E` (src/lib/scuole/reali.ts). Nessun uuid di sede
 * è scritto qui dentro, di proposito: un uuid in un letterale vale per la sede
 * di oggi e per nessuna di domani, e il lock
 * `__tests__/architecture/migrazioni-senza-sede-cablata.test.ts` lo vieta.
 *
 * SOLA LETTURA. Non scrive niente, mai.
 *
 * USO
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     node scripts/verifica-isolamento-dati-prova.mjs
 *
 * USCITA
 *   0 = pulito · 1 = errore di lettura · 3 = dati di prova trovati in sedi vere
 */
import { createClient } from '@supabase/supabase-js';

/** Il prefisso che marca una sede non reale. È un PREDICATO, non un uuid. */
const PREFISSO_NON_REALE = 'e2e00000';
/** Dominio di autenticazione degli account di collaudo. */
const DOMINIO_TEST = '@kidville.test';
/** I marcatori che tradiscono un record inventato in mezzo a bambini veri. */
const MARCATORI = /(^|\W)(test|collaudo|demo|e2e)(\W|$)|^alunno\d/i;

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const CHIAVE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !CHIAVE) {
  console.error('✗ Servono NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nell\'ambiente.');
  process.exit(1);
}
const db = createClient(URL, CHIAVE, { auth: { persistSession: false } });

/**
 * PostgREST NON lancia: ritorna `{ error }`. Senza questo controllo un guasto di
 * lettura diventerebbe un elenco vuoto, cioè «tutto pulito» — che è il modo
 * esatto in cui un verificatore smette di verificare senza dirlo a nessuno.
 */
function esito(cosa, res) {
  if (res.error) {
    console.error(`✗ ${cosa}: [${res.error.code ?? '—'}] ${res.error.message}`);
    process.exit(1);
  }
  return res.data ?? [];
}

const eNonReale = (id) => String(id ?? '').startsWith(PREFISSO_NON_REALE);

/** Gli id di autenticazione degli account di collaudo, presi da `auth.users`. */
async function idDiCollaudo() {
  const ids = new Set();
  for (let pagina = 1; ; pagina++) {
    const { data, error } = await db.auth.admin.listUsers({ page: pagina, perPage: 200 });
    if (error) {
      console.error(`✗ auth.admin.listUsers (pagina ${pagina}): ${error.message}`);
      process.exit(1);
    }
    for (const u of data.users) {
      if ((u.email ?? '').toLowerCase().endsWith(DOMINIO_TEST)) ids.add(u.id);
    }
    // L'email di autenticazione NON coincide sempre con `utenti.email`: cinque
    // account di collaudo hanno in `utenti` una casella personale vera. Chi
    // cerca da `utenti.email` ne salta cinque e conclude «pulito».
    if (data.users.length < 200) return ids;
  }
}

const collaudo = await idDiCollaudo();
const nomiSede = new Map(esito('schools', await db.from('schools').select('id, nome')).map((s) => [s.id, s.nome]));
const rilievi = [];

const sedeDi = (id) => `${nomiSede.get(id) ?? id}`;

// 1. Account di collaudo agganciati a una sede vera.
for (const u of esito('utenti', await db.from('utenti').select('id, scuola_id'))) {
  if (collaudo.has(u.id) && !eNonReale(u.scuola_id)) {
    rilievi.push(`utente di collaudo nella sede reale «${sedeDi(u.scuola_id)}»  (id ${u.id})`);
  }
}

// 2. Ponte multi-sede: un account di collaudo che vede un plesso vero.
for (const r of esito('utenti_scuole', await db.from('utenti_scuole').select('utente_id, scuola_id'))) {
  if (collaudo.has(r.utente_id) && !eNonReale(r.scuola_id)) {
    rilievi.push(`account di collaudo agganciato via utenti_scuole a «${sedeDi(r.scuola_id)}»`);
  }
}

// 3. Classi di prova dentro una sede vera.
for (const s of esito('sections', await db.from('sections').select('id, name, scuola_id'))) {
  if (!eNonReale(s.scuola_id) && MARCATORI.test(String(s.name ?? ''))) {
    rilievi.push(`classe di prova «${s.name}» nella sede reale «${sedeDi(s.scuola_id)}»`);
  }
}

// 4. Bambini inventati fra i bambini veri: è il rilievo che conta di più,
//    perché è quello che gonfia il KPI della segreteria e riempie un registro.
for (const a of esito('alunni', await db.from('alunni').select('id, nome, cognome, scuola_id, stato'))) {
  if (eNonReale(a.scuola_id)) continue;
  if (MARCATORI.test(`${a.nome ?? ''} ${a.cognome ?? ''}`)) {
    rilievi.push(`alunno con nome di prova nella sede reale «${sedeDi(a.scuola_id)}» (stato ${a.stato}, id ${a.id})`);
  }
}

// 5. Avvisi scritti da un account di collaudo dentro una sede vera: li vedono
//    famiglie reali. Il 2026-08-24 uno di questi era stato APERTO da 43 famiglie.
for (const v of esito('avvisi', await db.from('avvisi').select('id, author_id, scuola_id'))) {
  if (collaudo.has(v.author_id) && !eNonReale(v.scuola_id)) {
    rilievi.push(`avviso di un account di collaudo pubblicato in «${sedeDi(v.scuola_id)}» (id ${v.id})`);
  }
}

if (rilievi.length === 0) {
  console.log('✓ Nessun dato di collaudo dentro una sede reale.');
  process.exit(0);
}
console.error(`\n✗ ${rilievi.length} rilievi — dati di collaudo dentro sedi reali:\n`);
for (const r of rilievi) console.error(`  · ${r}`);
console.error('\nVanno spostati nella sede demo, non cancellati: sono agganciati agli account che Apple e Google usano.\n');
process.exit(3);
