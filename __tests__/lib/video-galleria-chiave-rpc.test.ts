// @vitest-environment node

/**
 * LA CHIAVE DI IDEMPOTENZA DEL CLIENT, PROVATA CONTRO LA RPC VERA.
 *
 * ─── IL DIFETTO CHE QUESTO FILE TIENE FERMO ──────────────────────────────────────────────
 * `video_galleria_intent_apri` (file A della PR 2, spec §5.3) legge la chiave di idempotenza così:
 *
 *  · stessa chiave, stessi destinatari, stessi byte → una RIPETIZIONE: ritorna lo stesso intento;
 *  · stessa chiave, destinatari diversi (o byte, trasporto…) → `IDEMPOTENCY_CONFLICT`;
 *  · chiave già usata da un intento del flusso VECCHIO → `IDEMPOTENCY_CONFLICT`: quell'intento «non
 *    si adotta», perché non ha i bambini e nessuno potrebbe più pubblicarlo.
 *
 * La route traduce `IDEMPOTENCY_CONFLICT` in 409 `VIDEO_RIPROVA`, e a schermo esce «Qualcosa è
 * cambiato… Ricarica la pagina e riprova: non è andato perso niente». Una frase che NON PUÒ riuscire,
 * se la chiave che il client rimanda è sempre la stessa.
 *
 * Il client aveva ancora la chiave del flusso vecchio, `g-<byte>-<data>-<impronta del nome>`, senza i
 * destinatari. Quindi prendeva 409 ogni volta che rimandava lo stesso file:
 *   · un file già mandato col client in produzione — compresi i video che la scheda dice «questo
 *     video va ricaricato: scegli di nuovo il file e invialo», cioè il gesto che la scheda CHIEDE;
 *   · lo stesso file rimandato con altri bambini, per esempio dopo «Rimuovi».
 * Dove nome, peso e data restano gli stessi — il browser da PC, Android — il gesto falliva sempre.
 *
 * ─── PERCHÉ UN FILE A PARTE ──────────────────────────────────────────────────────────────
 * I server finti dei test del client (l'hook, la pagina) NON hanno questa semantica: rispondono
 * `201` a qualunque chiave, quindi restavano verdi con la chiave sbagliata. Qui la funzione VERA del
 * client (`chiaveIdempotenzaVideo`) parla con la funzione SQL VERA, su PGlite, con le migrazioni lette
 * dal disco: stesso impianto di `video-pubblicazione-automatica-rpc.test.ts`.
 *
 * Il file A si trova per SUFFISSO del nome, non per nome intero: nasce con un timestamp provvisorio e
 * T16 lo rinomina con l'istante vero dell'applicazione.
 *
 * ⚠️ COSA NON DIMOSTRA: PGlite ha una connessione sola, quindi due aperture davvero simultanee con la
 * stessa chiave qui non si possono avere. Si prova la semantica delle risposte, non la concorrenza.
 */

import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

// Il modulo del client importa il logger del browser: qui non serve, e non deve scrivere da nessuna parte.
vi.mock('@/lib/logging/client', () => ({
  logClient: vi.fn(),
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))

import { chiaveIdempotenzaVideo, destinatariDaInviare } from '@/lib/gallery/video-galleria-flusso'

const CARTELLA_MIGRAZIONI = join(process.cwd(), 'supabase/migrations')
const leggi = (file: string): string => readFileSync(join(CARTELLA_MIGRAZIONI, file), 'utf8')

/** Il file che finisce con quel suffisso, e uno solo: altrimenti il test non sa quale leggere. */
function trovaPerSuffisso(suffisso: string): string {
  const trovati = readdirSync(CARTELLA_MIGRAZIONI).filter((f) => f.endsWith(suffisso))
  if (trovati.length !== 1) {
    throw new Error(
      `Cerco in supabase/migrations/ UN file che finisce con «${suffisso}» e ne trovo ` +
        `${trovati.length} (${trovati.join(', ') || 'nessuno'}). Se la migrazione è stata rinominata ` +
        `con la version registrata, il suffisso deve restare lo stesso.`,
    )
  }
  return trovati[0]
}

// Le migrazioni già in produzione, nell'ordine di applicazione, e quella di questa PR.
const SCHEMA = leggi('20260916190000_video_jobs.sql')
const TRANSIZIONI = leggi('20260916190100_video_job_transitions.sql')
const INTENTI = leggi('20260916190200_video_intent_lifecycle.sql')
const NEXT = leggi('20260917210000_video_job_next.sql')
const RETENTION = leggi('20260918110000_video_retention_riconciliazione.sql')
const BUCKET = leggi(trovaPerSuffisso('_video_build_bucket.sql'))
const RITENTATIVI = leggi(trovaPerSuffisso('_video_job_ritentativi.sql'))
const MIGRAZIONE_A = leggi(trovaPerSuffisso('_video_pubblicazione_automatica.sql'))

const SEDE = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const A1 = 'a1000000-0000-4000-8000-0000000000a1'
const A2 = 'a2000000-0000-4000-8000-0000000000a2'

/**
 * Il file del collaudo: nome, peso e data sono quelli che il client in produzione ha mandato davvero
 * (un nome da fotocamera, 5000 byte, la data in millisecondi). Il nome non è di nessun bambino.
 */
const FILE = { name: 'VID_20261002_101500.mp4', size: 5000, lastModified: 1759400000000 }

/**
 * La chiave che il client IN PRODUZIONE calcola per `FILE`: `g-<byte>-<data>-<impronta del nome>`.
 * Il valore è quello misurato col client vecchio; non lo si ricalcola qui con la sua formula, perché
 * un test che ripete la formula prova la propria copia.
 */
const CHIAVE_DEL_CLIENT_VECCHIO = 'g-5000-1759400000000-83ce6643'

type Risposta = { ok: boolean; code?: string; [chiave: string]: unknown }
type RispostaApri = Risposta & {
  intent?: { id: string; status: string; revision: number; [k: string]: unknown }
  job?: { id: string; status: string; original_path: string; [k: string]: unknown }
  ripetuta?: boolean
}

let db: PGlite

async function rpc<T = Risposta>(sql: string): Promise<T> {
  const { rows } = await db.query<{ risultato: T }>(`SELECT ${sql} AS risultato`)
  return rows[0].risultato
}

async function conta(tabella: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabella}`)
  return rows[0].n
}

/** Il database senza nessuna migrazione: ruoli, Storage, tabelle d'appoggio, galleria e log. */
async function preparaStub(conn: PGlite) {
  await conn.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL,
      public boolean NOT NULL DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[],
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.utenti (
      id uuid PRIMARY KEY REFERENCES auth.users(id),
      scuola_id uuid NOT NULL REFERENCES public.schools(id)
    );

    CREATE TABLE public.log_migrazioni (payload jsonb NOT NULL);
    CREATE FUNCTION public.app_log_registra(righe jsonb)
    RETURNS int
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO public.log_migrazioni(payload) VALUES (righe);
      RETURN 1;
    END $$;

    -- La galleria com'è in produzione: la tabella di base, la sede, il cestino e l'idempotenza.
    CREATE TABLE public.galleria_media_v2 (
      id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
      uploaded_by uuid NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE,
      file_url text NOT NULL,
      file_type character varying(20) DEFAULT 'foto' NOT NULL,
      caption text,
      tag_students uuid[] DEFAULT '{}' NOT NULL,
      is_broadcast boolean DEFAULT false,
      target_classes text[],
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      scuola_id uuid REFERENCES public.schools(id),
      eliminato_il timestamptz,
      eliminato_da uuid,
      file_rimosso_il timestamptz,
      upload_id uuid,
      upload_payload_hash text
    );
    CREATE UNIQUE INDEX galleria_media_upload_unico_idx
      ON public.galleria_media_v2 (uploaded_by, scuola_id, upload_id);

    INSERT INTO public.schools(id) VALUES ('${SEDE}');
    INSERT INTO auth.users(id) VALUES ('${OWNER}');
    INSERT INTO public.utenti(id, scuola_id) VALUES ('${OWNER}', '${SEDE}');
  `)
}

/** Le migrazioni video già in produzione (PR 1 compresa), nell'ordine in cui sono state applicate. */
async function applicaProduzione(conn: PGlite) {
  await conn.exec(SCHEMA)
  await conn.exec(TRANSIZIONI)
  await conn.exec(INTENTI)
  await conn.exec(NEXT)
  await conn.exec(RETENTION)
  await conn.exec(BUCKET)
  await conn.exec(RITENTATIVI)
}

beforeAll(async () => {
  db = new PGlite()
  await preparaStub(db)
  await applicaProduzione(db)
  await db.exec(MIGRAZIONE_A)
}, 60_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.video_outbox, public.video_jobs, public.video_intents,
             public.galleria_media_v2, public.log_migrazioni
  `)
})

// ─────────────────────────────────────────────────────────────────────────────
// I MATTONI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il percorso dell'originale come lo calcola `percorsoOriginale` in `src/app/api/video-uploads/route.ts`:
 * l'uuid di chi carica e l'impronta della chiave. È DETERMINISTICO per costruzione, quindi due chiavi
 * diverse danno due percorsi diversi (l'indice `video_jobs_originale_unico` non scatta) e la stessa
 * chiave dà lo stesso percorso (una ripetizione non è un «altro originale»).
 */
const percorsoOriginale = (chiave: string): string =>
  `${OWNER}/${createHash('sha256').update(`gallery:${chiave}`).digest('hex').slice(0, 32)}.mp4`

const uuids = (xs: string[]): string => `ARRAY[${xs.map((x) => `'${x}'`).join(', ')}]::uuid[]`
const testi = (xs: string[]): string => `ARRAY[${xs.map((x) => `'${x}'`).join(', ')}]::text[]`

interface Bambini {
  tag: string[]
  broadcast?: boolean
  classi?: string[]
}

/** I destinatari nella forma che la funzione del client si aspetta. */
const destinatari = (b: Bambini) => ({ tagAlunni: b.tag, broadcast: b.broadcast ?? false, classi: b.classi ?? [] })

/**
 * `video_galleria_intent_apri` come la chiama la route per un video `tus` della Galleria: la chiave e
 * il percorso che ne discende, i byte del file, i destinatari — quelli che il client MANDA davvero
 * (`destinatariDaInviare`): in broadcast i tag non partono, e senza broadcast non partono le classi.
 */
function apriConChiave(chiave: string, b: Bambini, byte = FILE.size): Promise<RispostaApri> {
  const d = destinatariDaInviare(destinatari(b))
  return rpc<RispostaApri>(
    `public.video_galleria_intent_apri(
      '${OWNER}', '${SEDE}', '${chiave}', '${percorsoOriginale(chiave)}',
      ${byte}, 'video/mp4', 20,
      ${uuids(d.tagAlunni)}, ${d.broadcast}, ${testi(d.classi)},
      'tus', NULL::bytea, NULL::bytea, NULL::timestamptz
    )`,
  )
}

/** Un invio: la chiave che il CLIENT calcola per `FILE` e per quei bambini, e l'apertura con quella chiave. */
function invia(b: Bambini, file = FILE): Promise<RispostaApri> {
  return apriConChiave(chiaveIdempotenzaVideo(file, destinatari(b)), b, file.size)
}

/** Il ritiro dell'intento («Rimuovi»): lo stesso `video_intent_revoke` che usa `PATCH annulla`. */
async function ritira(aperto: RispostaApri): Promise<void> {
  const esito = await rpc(`public.video_intent_revoke('${aperto.intent!.id}', '${OWNER}', ${aperto.intent!.revision})`)
  expect(esito.ok, `il ritiro doveva riuscire: ${JSON.stringify(esito)}`).toBe(true)
}

// ─────────────────────────────────────────────────────────────────────────────
// (i) UN FILE GIÀ MANDATO COL CLIENT IN PRODUZIONE SI PUÒ RIMANDARE
// ─────────────────────────────────────────────────────────────────────────────

describe('un file già mandato col client in produzione si può rimandare (la scheda «va ricaricato»)', () => {
  it('l’intento del flusso VECCHIO esiste con la chiave di prima: il client nuovo apre un intento NUOVO, non prende IDEMPOTENCY_CONFLICT', async () => {
    // L'invio del client in produzione: `video_intent_open` con la chiave `g-…` e senza destinatari.
    const vecchio = await rpc<RispostaApri>(
      `public.video_intent_open('${OWNER}', '${SEDE}', 'gallery', 'publish', '{"scope":"sede"}'::jsonb,
        '${CHIAVE_DEL_CLIENT_VECCHIO}', '${percorsoOriginale(CHIAVE_DEL_CLIENT_VECCHIO)}', NULL, NULL)`,
    )
    expect(vecchio.ok, `l'invio del flusso vecchio doveva riuscire: ${JSON.stringify(vecchio)}`).toBe(true)

    // Il gesto che la scheda «questo video va ricaricato» chiede: scegliere di nuovo il file e inviarlo.
    const nuovo = await invia({ tag: [A1] })

    expect(nuovo.ok, `il reinvio è stato rifiutato: ${JSON.stringify(nuovo)}`).toBe(true)
    expect(nuovo.code).toBeUndefined()
    expect(nuovo.intent!.id).not.toBe(vecchio.intent!.id)
    expect(nuovo.intent!.status).toBe('confirmed')
    expect(nuovo.ripetuta).toBe(false)
    // Due intenti, due job: quello vecchio non si adotta e non si tocca.
    expect(await conta('public.video_intents')).toBe(2)
    expect(await conta('public.video_jobs')).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (ii) LO STESSO FILE CON ALTRI BAMBINI, DOPO «RIMUOVI»
// ─────────────────────────────────────────────────────────────────────────────

describe('lo stesso file rimandato con altri bambini (per esempio dopo «Rimuovi»)', () => {
  it('apre un intento DIVERSO, e non prende IDEMPOTENCY_CONFLICT', async () => {
    const primo = await invia({ tag: [A1] })
    expect(primo.ok).toBe(true)
    await ritira(primo)

    const secondo = await invia({ tag: [A2] })

    expect(secondo.ok, `il reinvio con altri bambini è stato rifiutato: ${JSON.stringify(secondo)}`).toBe(true)
    expect(secondo.intent!.id).not.toBe(primo.intent!.id)
    expect(secondo.intent!.status).toBe('confirmed')
    expect(secondo.ripetuta).toBe(false)
    expect(await conta('public.video_intents')).toBe(2)
  })

  it('anche senza ritirare il primo: un file, due scelte di bambini, due intenti', async () => {
    const primo = await invia({ tag: [A1] })
    const secondo = await invia({ tag: [A2] })
    expect(primo.ok).toBe(true)
    expect(secondo.ok).toBe(true)
    expect(secondo.intent!.id).not.toBe(primo.intent!.id)
  })

  it('tutta la classe al posto dei bambini scelti è un altro invio, non un conflitto', async () => {
    const primo = await invia({ tag: [A1] })
    const secondo = await invia({ tag: [], broadcast: true, classi: ['3 ANNI'] })
    expect(primo.ok).toBe(true)
    expect(secondo.ok, JSON.stringify(secondo)).toBe(true)
    expect(secondo.intent!.id).not.toBe(primo.intent!.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (iii) LE CONTROPROVE: LA RIPETIZIONE VERA RITROVA IL SUO INTENTO
// ─────────────────────────────────────────────────────────────────────────────

describe('la stessa richiesta ripetuta (la risposta si è persa) ritrova il SUO intento', () => {
  it('stesso file e stessi bambini: stesso intento, `ripetuta`, e nessun intento in più', async () => {
    const primo = await invia({ tag: [A1] })
    const ripetuto = await invia({ tag: [A1] })

    expect(primo.ok).toBe(true)
    expect(ripetuto.ok, JSON.stringify(ripetuto)).toBe(true)
    expect(ripetuto.intent!.id).toBe(primo.intent!.id)
    expect(ripetuto.job!.id).toBe(primo.job!.id)
    expect(ripetuto.ripetuta).toBe(true)
    expect(await conta('public.video_intents')).toBe(1)
    expect(await conta('public.video_jobs')).toBe(1)
  })

  it('i bambini in un altro ordine, o con un doppione, sono lo stesso invio: lo dice anche il server', async () => {
    const primo = await invia({ tag: [A1, A2] })
    const altroOrdine = await invia({ tag: [A2, A1] })
    const conDoppione = await invia({ tag: [A1, A2, A1] })

    expect(primo.ok).toBe(true)
    expect(altroOrdine.ok, JSON.stringify(altroOrdine)).toBe(true)
    expect(conDoppione.ok, JSON.stringify(conDoppione)).toBe(true)
    expect(altroOrdine.intent!.id).toBe(primo.intent!.id)
    expect(conDoppione.intent!.id).toBe(primo.intent!.id)
    expect(await conta('public.video_intents')).toBe(1)
  })

  it('in broadcast i tag che il client non manda non cambiano l’invio: stessa classe, stesso intento', async () => {
    const primo = await invia({ tag: [A1], broadcast: true, classi: ['3 ANNI'] })
    const ripetuto = await invia({ tag: [A2], broadcast: true, classi: ['3 ANNI'] })
    expect(primo.ok, JSON.stringify(primo)).toBe(true)
    expect(ripetuto.ok, JSON.stringify(ripetuto)).toBe(true)
    expect(ripetuto.intent!.id).toBe(primo.intent!.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (iv) PERCHÉ LA CHIAVE PORTA I DESTINATARI: SENZA, IL SERVER RIFIUTA
// ─────────────────────────────────────────────────────────────────────────────

describe('perché la chiave porta i destinatari: senza, il server rifiuta', () => {
  it('la STESSA chiave con altri bambini è IDEMPOTENCY_CONFLICT: il difetto, riprodotto sulla RPC', async () => {
    // La chiave che il client di prima calcolava (la stessa per qualunque scelta di bambini).
    const chiave = chiaveIdempotenzaVideo(FILE, destinatari({ tag: [A1] }))
    const primo = await apriConChiave(chiave, { tag: [A1] })
    const altri = await apriConChiave(chiave, { tag: [A2] })

    expect(primo.ok).toBe(true)
    expect(altri.ok).toBe(false)
    expect(altri.code).toBe('IDEMPOTENCY_CONFLICT')
    // Il rifiuto non ha scritto niente.
    expect(await conta('public.video_intents')).toBe(1)
  })

  it('il ramo «concluso» del client: la chiave col suffisso `-<uuid>` entra nel limite di 128 caratteri e apre un intento nuovo', async () => {
    const b = { tag: [A1] }
    const primo = await invia(b)
    await ritira(primo)

    // Come fa `avviaVideo`: la prima apertura ritrova l'intento CONCLUSO (ripetizione di un intento
    // `cancelled`), e allora il client apre con la chiave di prima più un uuid.
    const ritrovato = await invia(b)
    expect(ritrovato.ok).toBe(true)
    expect(ritrovato.intent!.status).toBe('cancelled')
    expect(ritrovato.intent!.id).toBe(primo.intent!.id)

    const chiaveNuova = `${chiaveIdempotenzaVideo(FILE, destinatari(b))}-${randomUUID()}`
    expect(chiaveNuova.length).toBeLessThanOrEqual(128)
    const nuovo = await apriConChiave(chiaveNuova, b)
    expect(nuovo.ok, JSON.stringify(nuovo)).toBe(true)
    expect(nuovo.intent!.id).not.toBe(primo.intent!.id)
    expect(nuovo.intent!.status).toBe('confirmed')
  })

  it('nel caso peggiore (due gigabyte, data a 13 cifre) la chiave col suffisso sta ancora nel limite della RPC', async () => {
    const peggiore = { name: 'x.mp4', size: 2_000_000_000, lastModified: 9_999_999_999_999 }
    const chiave = `${chiaveIdempotenzaVideo(peggiore, destinatari({ tag: [A1] }))}-${randomUUID()}`
    expect(chiave.length).toBeLessThanOrEqual(128)
    const aperto = await apriConChiave(chiave, { tag: [A1] }, peggiore.size)
    expect(aperto.ok, JSON.stringify(aperto)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (v) IL SALE DEL DISPOSITIVO (#131): IN TABELLA NON RESTANO I BAMBINI, E L'IDEMPOTENZA RESTA
// ─────────────────────────────────────────────────────────────────────────────
//
// `video_jobs.idempotency_key` è scritta in chiaro e sopravvive alla minimizzazione di
// `video_intents.tag_alunni`: un'impronta senza sale dei bambini scelti si ricostruisce provando i
// sottoinsiemi (l'attacco è riprodotto in `gallery-video-flusso.test.ts`). Qui si prova ciò che
// conta sulla funzione SQL vera: la chiave salata arriva intera in tabella, senza le impronte di
// prima, e il sale NON toglie al server la sua idempotenza — lo stesso dispositivo ritrova il suo
// intento — mentre due dispositivi, due sali, aprono due intenti senza prendere un conflitto.

const SALE_A = '0123456789abcdef0123456789abcdef'
const SALE_B = 'fedcba9876543210fedcba9876543210'

/** Un invio dal dispositivo che ha il sale `sale`: la chiave che il CLIENT calcola con quel sale. */
const inviaDa = (sale: string, b: Bambini, file = FILE): Promise<RispostaApri> =>
  apriConChiave(chiaveIdempotenzaVideo(file, destinatari(b), sale), b, file.size)

describe('il sale del dispositivo: la RPC vera vede chiavi salate, e l’idempotenza regge', () => {
  it('lo STESSO dispositivo ritrova il suo intento: un ritentativo (risposta persa) non apre un secondo video', async () => {
    const primo = await inviaDa(SALE_A, { tag: [A1] })
    const ripetuto = await inviaDa(SALE_A, { tag: [A1] })

    expect(primo.ok).toBe(true)
    expect(ripetuto.ok, JSON.stringify(ripetuto)).toBe(true)
    expect(ripetuto.ripetuta).toBe(true)
    expect(ripetuto.intent!.id).toBe(primo.intent!.id)
    expect(await conta('public.video_jobs')).toBe(1)
  })

  it('DUE dispositivi (due sali), stesso file e stessi bambini: due intenti, e nessun IDEMPOTENCY_CONFLICT', async () => {
    const dalTelefono = await inviaDa(SALE_A, { tag: [A1] })
    const dalPc = await inviaDa(SALE_B, { tag: [A1] })

    expect(dalTelefono.ok).toBe(true)
    expect(dalPc.ok, `il secondo dispositivo è stato rifiutato: ${JSON.stringify(dalPc)}`).toBe(true)
    expect(dalPc.code).toBeUndefined()
    expect(dalPc.ripetuta).toBe(false)
    expect(dalPc.intent!.id).not.toBe(dalTelefono.intent!.id)
    expect(await conta('public.video_intents')).toBe(2)
  })

  it('la chiave che resta in `video_jobs.idempotency_key` è quella salata, senza le impronte di prima (bambini e nome)', async () => {
    await inviaDa(SALE_A, { tag: [A1] })
    const { rows } = await db.query<{ idempotency_key: string }>('SELECT idempotency_key FROM public.video_jobs')
    expect(rows).toHaveLength(1)
    const inTabella = rows[0].idempotency_key

    expect(inTabella).toBe(chiaveIdempotenzaVideo(FILE, destinatari({ tag: [A1] }), SALE_A))
    expect(inTabella).toMatch(/^gv2-5000-1759400000000-[0-9a-f]{12}-[0-9a-f]{12}$/)
    // Le impronte di prima, misurate col codice senza sale e scritte qui senza ricalcolarle: quella del JSON
    // dei bambini `[[A1], false, []]` e quella del nome del file (`83ce6643` è anche in `CHIAVE_DEL_CLIENT_VECCHIO`).
    expect(inTabella).not.toContain('4daa669e')
    expect(inTabella).not.toContain('83ce6643')
    // E il sale non c'è, nemmeno a pezzi.
    expect(inTabella).not.toContain(SALE_A)
    expect(inTabella).not.toContain(SALE_A.slice(0, 8))
  })

  it('senza `window` (qui, in Node) il sale è della sessione: due invii dello stesso file e degli stessi bambini si ritrovano', async () => {
    // È la strada predefinita — nessun sale esplicito —: quella che percorre la schermata. Il deposito durevole
    // manca (nessun `localStorage`), quindi vale il sale in memoria, che per tutta la sessione è uno solo.
    const primo = await invia({ tag: [A1] })
    const ripetuto = await invia({ tag: [A1] })
    expect(primo.ok).toBe(true)
    expect(ripetuto.ripetuta).toBe(true)
    expect(ripetuto.intent!.id).toBe(primo.intent!.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL PERCORSO DI QUESTO FILE È QUELLO DELLA ROUTE
// ─────────────────────────────────────────────────────────────────────────────

describe('il percorso dell’originale che questo file calcola è quello della route', () => {
  it('la formula di `percorsoOriginale` in `video-uploads/route.ts` non è stata cambiata sotto questo test', () => {
    // Una route di Next non può esportare altro che i suoi gestori, quindi la funzione non si importa:
    // si legge il CODICE della route (senza i commenti, che citano la formula a parole) e si pretende
    // che la formula sia ancora quella che qui sopra si ripete. Se la cambi, cambia anche `percorsoOriginale`
    // in questo file: serve a far sì che due chiavi diverse siano due percorsi diversi, come in produzione.
    const sorgente = readFileSync(join(process.cwd(), 'src/app/api/video-uploads/route.ts'), 'utf8')
    const codice = sorgente
      .split('\n')
      .filter((riga) => !/^\s*(\/\/|\/\*|\*)/.test(riga))
      .join('\n')
    expect(codice).toContain("createHash('sha256').update(`${canale}:${f.chiaveIdempotenza}`).digest('hex').slice(0, 32)")
    expect(codice).toContain('`${ownerId}/${impronta}.${estensioneVideoDaMime(f.mime)}`')
  })
})
