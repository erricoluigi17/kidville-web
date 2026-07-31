#!/usr/bin/env node
/**
 * seed-test-sedi.mjs — account TEST sulle sedi diverse da Giugliano.
 *
 * PERCHÉ ESISTE. Dal 2026-07-29 la produzione ha tre plessi (Giugliano, Aversa,
 * Cesa), ma tutti i 41 account `test.*@kidville.test` vivono a Giugliano: Cesa
 * non ha NESSUN utente e Aversa ne ha uno solo, una famiglia vera. Con un solo
 * plesso popolato l'isolamento fra sedi non è collaudabile — non esiste un
 * «utente di A» a cui chiedere se vede B — e infatti l'audit del 2026-07-31 ha
 * trovato 140 rilievi col gate formale verde. Questo script crea, su ogni sede
 * indicata, il minimo necessario alla prova incrociata: una segreteria, un
 * docente, un genitore col suo bambino e la sezione che li tiene insieme.
 *
 * LA SEZIONE È OMONIMA DI PROPOSITO. Si chiama «TEST Infanzia» in ogni sede,
 * esattamente come quella che esiste già a Giugliano: il nome-classe usato come
 * identità è la famiglia di difetti F3 dell'audit, e senza due classi omonime in
 * due plessi non si può dimostrare né che è chiusa né che si riapre.
 *
 * QUELLO CHE QUESTO SCRIPT NON FA, ed è il punto: **non scrive `utenti_scuole`**.
 * Quel ponte è ciò che il 29/07 ha portato `admin.e2e@kidville.test` dentro
 * Aversa e Cesa. Un account di collaudo sta nella SUA sede, e in nessun'altra:
 * la vista cross-sede è un privilegio dell'admin vero, non un comodo per i test.
 *
 * USO (dalla radice del repo):
 *   export KV_TEST_PASSWORD='…'                 # gestore di credenziali del titolare
 *   node scripts/seed-test-sedi.mjs             # DRY-RUN: dice cosa farebbe
 *   node scripts/seed-test-sedi.mjs --apply     # scrive DAVVERO (su PRODUZIONE)
 *   node scripts/seed-test-sedi.mjs --apply --sede "Kidville Cesa"
 *
 * ⚠️ `.env.local` punta al database di PRODUZIONE: `--apply` scrive lì. È
 * idempotente (rilanciarlo riallinea, non duplica) e reversibile: come si
 * rimuove tutto è scritto nel PRD, accanto all'elenco degli account.
 *
 * Env richieste: `KV_TEST_PASSWORD`, `NEXT_PUBLIC_SUPABASE_URL`,
 * `SUPABASE_SERVICE_ROLE_KEY` (le ultime due anche da `.env.local`).
 *
 * La logica di questo file è collaudata da `__tests__/lib/seed-test-sedi.test.ts`
 * sul finto client Supabase, che filtra e scrive davvero: le funzioni esportate
 * qui sotto sono pure o ricevono il client come parametro proprio per questo.
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { requireTestPassword, KV_TEST_PASSWORD } from '../e2e/lib/test-password.mjs'

/** Le sedi su cui seminare, PER NOME: nessun uuid di sede vive in questo repo. */
export const SEDI_BERSAGLIO = ['Kidville Aversa', 'Kidville Cesa']

/** Dominio riservato agli account di collaudo (non esiste, non riceve posta). */
export const DOMINIO_TEST = 'kidville.test'

/** Nome della sezione di collaudo — lo stesso in ogni sede, vedi intestazione. */
export const NOME_SEZIONE_TEST = 'TEST Infanzia'

/** Data di nascita del bambino finto: fissa, così il seed è deterministico. */
const NASCITA_ALUNNO_TEST = '2021-09-01'

/** Consensi che l'onboarding reale scrive: senza, la chat risponde 403 (C5). */
const CONSENSI_TEST = { privacy: true, termini: true }

const PER_PAGINA_AUTH = 100

// ── Sedi ─────────────────────────────────────────────────────────────────────

/** Confronto fra nomi di sede: spazi normalizzati, maiuscole ignorate. */
function normalizzaNome(nome) {
  return String(nome ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * True se la sede è quella finta del seed E2E.
 * MIRROR di `isScuolaE2E` (src/lib/scuole/reali.ts): due indizi, l'id col
 * prefisso fisso e il nome. Qui è duplicato perché uno script `.mjs` non può
 * importare un modulo TypeScript dell'applicazione; se lì cambia, cambia qui.
 */
export function isSedeE2E(sede) {
  return String(sede?.id ?? '').startsWith('e2e00000') || /e2e/i.test(String(sede?.nome ?? ''))
}

/**
 * Lo slug che finisce nelle email: «Kidville Aversa» → `aversa`.
 * Il prefisso del marchio si toglie (è in tutte le sedi e non distingue niente).
 */
export function slugSede(nome) {
  return String(nome ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // accenti scomposti da NFD
    .replace(/^\s*kidville\s+/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** «Kidville Aversa» → «Test Aversa»: il cognome comune degli account di quella sede. */
function cognomeDiSede(nome) {
  return `Test ${String(nome ?? '').replace(/^\s*kidville\s+/i, '').trim()}`
}

/**
 * Le sedi richieste, risolte PER NOME su una lettura di `scuole`/`schools`.
 *
 * Non trova, o ne trova due con lo stesso nome ⇒ **lancia**. Un seed che
 * «ne prende una» è il difetto che questa intera campagna sta chiudendo: la
 * riga finirebbe nel plesso sbagliato senza che nulla si rompa.
 *
 * @param righe elenco `{ id, nome }` letto dal database
 * @param nomi  nomi richiesti (per default `SEDI_BERSAGLIO`)
 */
export function risolviSedi(righe, nomi = SEDI_BERSAGLIO) {
  return nomi.map((nome) => {
    const chiave = normalizzaNome(nome)
    const trovate = (righe ?? []).filter((r) => normalizzaNome(r?.nome) === chiave)
    if (trovate.length === 0) {
      throw new Error(
        `Sede «${nome}» non trovata: nessuna riga con questo nome. Le sedi note sono: ` +
          `${(righe ?? []).map((r) => r?.nome).join(', ') || '(nessuna)'}. ` +
          'Correggi il nome con --sede, non toccare lo script.',
      )
    }
    if (trovate.length > 1) {
      throw new Error(
        `Nome di sede «${nome}» ambiguo: ${trovate.length} righe lo portano. ` +
          'Rinomina le sedi oppure indica quale, il seed non ne sceglie una a caso.',
      )
    }
    const sede = { id: String(trovate[0].id), nome: String(trovate[0].nome) }
    if (isSedeE2E(sede)) {
      throw new Error(
        `Sede «${sede.nome}» è la scuola finta del collaudo automatico (E2E): non si semina a mano. ` +
          'Il suo seed è scripts/seed-e2e.mjs e gira sul progetto Supabase della CI.',
      )
    }
    return sede
  })
}

// ── Piano (puro: nessun segreto, nessun accesso al database) ─────────────────

/**
 * Che cosa deve esistere, su una sede, perché l'isolamento sia collaudabile.
 * È un valore: si stampa in dry-run, si asserisce nei test, si esegue con
 * `seminaSede`. Non contiene password — quella arriva dall'ambiente.
 */
export function pianoSede(nomeSede) {
  const slug = slugSede(nomeSede)
  const cognome = cognomeDiSede(nomeSede)
  const email = (ruolo) => `test.${slug}.${ruolo}@${DOMINIO_TEST}`
  return {
    nomeSede,
    slug,
    sezione: { name: NOME_SEZIONE_TEST, school_type: 'infanzia' },
    alunno: { nome: 'Alunno1', cognome, data_nascita: NASCITA_ALUNNO_TEST },
    account: [
      // `segreteria` vede l'anagrafica della SUA sede: è l'account con cui si
      // prova che l'anagrafica di un altro plesso non è raggiungibile.
      { chiave: 'segreteria', email: email('segreteria'), nome: 'Segreteria', cognome, ruolo: 'segreteria', gradi: [] },
      // `educator` è vincolato alle sezioni assegnate (decisione del 30/07):
      // gli si assegna la sola «TEST Infanzia» della sua sede.
      { chiave: 'docente', email: email('docente'), nome: 'Docente', cognome, ruolo: 'educator', gradi: ['infanzia'] },
      // Il genitore serve alla prova più delicata: i dati di un minore.
      { chiave: 'genitore', email: email('genitore'), nome: 'Genitore', cognome, ruolo: 'genitore', gradi: [] },
    ],
  }
}

// ── Accesso al database (PostgREST non lancia: si controlla `{ error }`) ─────

async function ok(etichetta, richiesta) {
  const { data, error } = await richiesta
  if (error) {
    const dettaglio = error.message || error.code || JSON.stringify(error)
    throw new Error(`${etichetta}: ${dettaglio}`)
  }
  return data
}

/**
 * Adattatore sull'admin API di Supabase Auth. Isolato perché è l'unico pezzo
 * che il finto client non emula: qui sopra ci sono i test, sotto c'è la rete.
 */
export function creaAuthAdmin(client) {
  const admin = client.auth.admin
  return {
    /** L'admin API non ha `getUserByEmail`: scansione paginata, come `parent-identity.ts`. */
    async trovaPerEmail(email) {
      const chiave = String(email).toLowerCase()
      for (let pagina = 1; ; pagina++) {
        const { data, error } = await admin.listUsers({ page: pagina, perPage: PER_PAGINA_AUTH })
        if (error) throw new Error(`auth.listUsers: ${error.message ?? JSON.stringify(error)}`)
        const utenti = data?.users ?? []
        for (const u of utenti) if (String(u.email ?? '').toLowerCase() === chiave) return u.id
        if (utenti.length < PER_PAGINA_AUTH) return null
      }
    },
    async crea(email, password) {
      const { data, error } = await admin.createUser({ email, password, email_confirm: true })
      if (error) throw new Error(`auth.createUser ${email}: ${error.message ?? JSON.stringify(error)}`)
      const id = data?.user?.id
      if (!id) throw new Error(`auth.createUser ${email}: nessun id restituito`)
      return id
    },
    async reimpostaPassword(id, password) {
      const { error } = await admin.updateUserById(id, { password, email_confirm: true })
      if (error) throw new Error(`auth.updateUserById: ${error.message ?? JSON.stringify(error)}`)
    },
  }
}

/** La sezione di collaudo della sede: esiste ⇒ la si riusa, altrimenti nasce. */
async function assicuraSezione(db, sede, piano) {
  const trovata = await ok(
    `sections (lettura, ${sede.nome})`,
    db.from('sections').select('id').eq('scuola_id', sede.id).eq('name', piano.sezione.name).maybeSingle(),
  )
  if (trovata?.id) return { id: trovata.id, creata: false }
  const creata = await ok(
    `sections (creazione, ${sede.nome})`,
    db
      .from('sections')
      .insert({ scuola_id: sede.id, name: piano.sezione.name, school_type: piano.sezione.school_type })
      .select('id')
      .single(),
  )
  return { id: creata.id, creata: true }
}

/**
 * Un account: `auth.users` + la riga `utenti` con lo STESSO id.
 * `utenti.role` non si scrive mai (colonna generata da `ruolo`), e
 * `utenti_scuole` non si tocca: la sede dell'account è una sola, la sua.
 */
async function assicuraAccount(db, auth, sede, descrizione, password) {
  let id = await auth.trovaPerEmail(descrizione.email)
  let creato = false
  if (!id) {
    id = await auth.crea(descrizione.email, password)
    creato = true
  } else {
    await auth.reimpostaPassword(id, password)
  }

  const esistente = await ok(
    `utenti (lettura, ${descrizione.email})`,
    db.from('utenti').select('id, scuola_id').eq('email', descrizione.email).maybeSingle(),
  )
  if (esistente && esistente.id !== id) {
    throw new Error(
      `utenti (${descrizione.email}): la riga esiste con id ${esistente.id} ma l'account auth è ${id}. ` +
        'Identità incoerente: va sistemata a mano, uno script di seed non la indovina.',
    )
  }

  await ok(
    `utenti (scrittura, ${descrizione.email})`,
    db.from('utenti').upsert(
      {
        id,
        email: descrizione.email,
        nome: descrizione.nome,
        cognome: descrizione.cognome,
        ruolo: descrizione.ruolo,
        scuola_id: sede.id,
        gradi: descrizione.gradi,
        attivo: true,
      },
      { onConflict: 'id' },
    ),
  )
  return { chiave: descrizione.chiave, email: descrizione.email, ruolo: descrizione.ruolo, id, creato }
}

/** Il docente vede solo le sezioni che gli sono assegnate (decisione 30/07). */
async function assicuraSezioneDelDocente(db, docenteId, sezioneId) {
  await ok(
    'utenti_sezioni',
    db
      .from('utenti_sezioni')
      .upsert({ utente_id: docenteId, section_id: sezioneId }, { onConflict: 'utente_id,section_id' }),
  )
}

/**
 * Il bambino finto della sede. `codice_fiscale` resta NULL di proposito: è
 * UNIQUE globale e presidia le iscrizioni pubbliche — un CF inventato che per
 * caso coincidesse con quello di un bambino vero ne bloccherebbe l'iscrizione.
 */
async function assicuraAlunno(db, sede, piano, sezioneId) {
  const trovato = await ok(
    `alunni (lettura, ${sede.nome})`,
    db
      .from('alunni')
      .select('id')
      .eq('scuola_id', sede.id)
      .eq('nome', piano.alunno.nome)
      .eq('cognome', piano.alunno.cognome)
      .maybeSingle(),
  )
  if (trovato?.id) return { id: trovato.id, creato: false }
  const creato = await ok(
    `alunni (creazione, ${sede.nome})`,
    db
      .from('alunni')
      .insert({
        scuola_id: sede.id,
        nome: piano.alunno.nome,
        cognome: piano.alunno.cognome,
        data_nascita: piano.alunno.data_nascita,
        section_id: sezioneId,
        classe_sezione: piano.sezione.name,
        stato: 'iscritto',
      })
      .select('id')
      .single(),
  )
  return { id: creato.id, creato: true }
}

/** L'anagrafica del genitore, legata all'account (`parents.auth_user_id` UNIQUE). */
async function assicuraParent(db, genitore, piano) {
  const trovato = await ok(
    'parents (lettura)',
    db.from('parents').select('id').eq('auth_user_id', genitore.id).maybeSingle(),
  )
  if (trovato?.id) return { id: trovato.id, creato: false }
  // Nome e cognome vengono dal piano, gli stessi della riga `utenti`: due fonti
  // diverse per la stessa persona divergono al primo ritocco.
  const descrizione = piano.account.find((a) => a.chiave === 'genitore')
  const creato = await ok(
    'parents (creazione)',
    db
      .from('parents')
      .insert({
        first_name: descrizione.nome,
        last_name: descrizione.cognome,
        auth_user_id: genitore.id,
        emails: [genitore.email],
        consensi_gdpr: CONSENSI_TEST,
      })
      .select('id')
      .single(),
  )
  return { id: creato.id, creato: true }
}

/**
 * I due legami genitore↔figlio. Sono DUE tabelle diverse perché l'applicazione
 * le usa entrambe: `student_parents` (anagrafica, `parents.id`) e
 * `legame_genitori_alunni` (accesso del genitore ai dati, `utenti.id`).
 */
async function assicuraLegamiGenitore(db, { genitoreId, parentId, alunnoId }) {
  await ok(
    'student_parents',
    db
      .from('student_parents')
      .upsert(
        { student_id: alunnoId, parent_id: parentId, relation_type: 'mother', is_primary: true },
        { onConflict: 'student_id,parent_id' },
      ),
  )
  await ok(
    'legame_genitori_alunni',
    db
      .from('legame_genitori_alunni')
      .upsert({ genitore_id: genitoreId, alunno_id: alunnoId }, { onConflict: 'genitore_id,alunno_id' }),
  )
}

/**
 * Esegue il piano su UNA sede. Idempotente: rilanciarla riallinea (password
 * compresa) e non duplica nulla.
 *
 * @param db       client Supabase service-role (o il finto client dei test)
 * @param auth     adattatore di `creaAuthAdmin`
 * @param sede     `{ id, nome }` già risolta con `risolviSedi`
 * @param password la password comune degli account TEST, dall'ambiente
 */
export async function seminaSede({ db, auth, sede, password }) {
  if (!String(password ?? '').trim()) {
    throw new Error(
      `Password assente: esporta ${KV_TEST_PASSWORD} prima di seminare. ` +
        'Nessun default — un seed che inventa una password la rende nota a chiunque legga il repo.',
    )
  }
  if (isSedeE2E(sede)) {
    throw new Error(`Sede «${sede.nome}» è la scuola finta del collaudo automatico (E2E): non si semina a mano.`)
  }

  const piano = pianoSede(sede.nome)
  const sezione = await assicuraSezione(db, sede, piano)

  const account = []
  for (const descrizione of piano.account) {
    account.push(await assicuraAccount(db, auth, sede, descrizione, password))
  }
  const docente = account.find((a) => a.chiave === 'docente')
  const genitore = account.find((a) => a.chiave === 'genitore')

  await assicuraSezioneDelDocente(db, docente.id, sezione.id)
  const alunno = await assicuraAlunno(db, sede, piano, sezione.id)
  const parent = await assicuraParent(db, genitore, piano)
  await assicuraLegamiGenitore(db, { genitoreId: genitore.id, parentId: parent.id, alunnoId: alunno.id })

  return {
    sede: sede.nome,
    scuolaId: sede.id,
    sezione: { nome: piano.sezione.name, id: sezione.id, creata: sezione.creata },
    alunno: { nome: `${piano.alunno.nome} ${piano.alunno.cognome}`, id: alunno.id, creato: alunno.creato },
    parentId: parent.id,
    account,
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function caricaEnvLocale() {
  const env = {}
  try {
    const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    for (const riga of raw.split('\n')) {
      const m = riga.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].trim()
    }
  } catch {
    // In CI `.env.local` non esiste: si usano le variabili di processo.
  }
  return env
}

function argomenti(argv) {
  const sedi = []
  let applica = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') applica = true
    else if (argv[i] === '--sede') {
      const valore = argv[++i]
      if (!valore) throw new Error('--sede vuole il NOME della sede, per esempio: --sede "Kidville Cesa"')
      sedi.push(valore)
    }
  }
  return { applica, sedi: sedi.length > 0 ? sedi : SEDI_BERSAGLIO }
}

async function main() {
  const { applica, sedi: nomi } = argomenti(process.argv.slice(2))
  const fileEnv = caricaEnvLocale()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL
  const chiave = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !chiave) {
    console.error('Mancano NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ambiente o .env.local)')
    process.exit(1)
  }

  const db = createClient(url, chiave, { auth: { persistSession: false } })
  // `schools` e non `scuole`: è la tabella da cui l'applicazione risolve le sedi
  // (`src/lib/scuole/reali.ts`) ed è il bersaglio delle FK `scuola_id`. `scuole`
  // è il registro amministrativo (porta il flag `attiva`), non la fonte.
  const scuole = await ok('schools (elenco)', db.from('schools').select('id, nome'))
  const sedi = risolviSedi(scuole, nomi)

  if (!applica) {
    console.log('🔎 DRY-RUN — niente viene scritto. Rilancia con --apply per eseguire.\n')
    for (const sede of sedi) {
      const piano = pianoSede(sede.nome)
      console.log(`  ${sede.nome}`)
      console.log(`    sezione  ${piano.sezione.name} (${piano.sezione.school_type})`)
      console.log(`    alunno   ${piano.alunno.nome} ${piano.alunno.cognome}`)
      for (const a of piano.account) console.log(`    account  ${a.email}  [${a.ruolo}]`)
      console.log('    utenti_scuole: NESSUNA riga (l\'account resta nella sua sede)\n')
    }
    return
  }

  const password = requireTestPassword()
  const auth = creaAuthAdmin(db)
  for (const sede of sedi) {
    const esito = await seminaSede({ db, auth, sede, password })
    console.log(`✅ ${esito.sede} (${esito.scuolaId})`)
    console.log(`   sezione «${esito.sezione.nome}» ${esito.sezione.creata ? '✚ creata' : '= già presente'}`)
    console.log(`   alunno  ${esito.alunno.nome} ${esito.alunno.creato ? '✚ creato' : '= già presente'}`)
    for (const a of esito.account) console.log(`   ${a.creato ? '✚' : '='} ${a.email} [${a.ruolo}]`)
  }
  console.log('\nFatto. La password non è stata stampata e non è scritta da nessuna parte.')
}

const eseguitoDirettamente = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (eseguitoDirettamente) {
  main().catch((err) => {
    console.error('❌ seed-test-sedi:', err.message ?? err)
    process.exit(1)
  })
}
