// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * JOB NOTTURNO DEI DATI SANITARI · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Fino al 2026-10-09 `iscrizioni_sanitari_tick` toglieva allergie e note mediche
 * da ogni domanda accolta, anche quando la re-iscrizione non le aveva portate in
 * scheda: il dato della famiglia spariva (276 bambini con la domanda svuotata, 148
 * con la scheda senza dati sanitari). Da oggi le toglie SOLO se la scheda le ha.
 *
 * Lo schema qui sotto è un MINIMO: le sole colonne che la funzione legge e scrive.
 * Il file della migrazione è LETTO DAL DISCO e applicato DUE volte. In fondo, il
 * controllo negativo: la funzione VECCHIA, letta dal suo file, deve far cadere il
 * caso «scheda vuota». Se non cadesse, questo test non misurerebbe niente.
 *
 * Solo dati finti: uuid inventati, nomi e testi di prova.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
const NUOVA = migrazione('_sanitari_solo_con_copia_presente.sql')

/** La funzione com'era: solo il suo CREATE, tagliato dal file del 2026-08-01. */
function funzioneVecchia(): string {
  const testo = migrazione('_retention_iscrizioni_e_audit.sql')
  const inizio = testo.indexOf('CREATE OR REPLACE FUNCTION public.iscrizioni_sanitari_tick()')
  const fine = testo.indexOf('END $$;', inizio)
  if (inizio < 0 || fine < 0) throw new Error('corpo della funzione vecchia non trovato')
  return testo.slice(inizio, fine + 'END $$;'.length)
}

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const ALTRA_SEDE = 'a0000000-0000-4000-8000-000000000002'
const CF_PIENA = 'AAAAAA10A01H501A'
const CF_VUOTA = 'BBBBBB10A01H501B'
const CF_ALTROVE = 'CCCCCC10A01H501C'
const CF_ANONIMA = 'DDDDDD10A01H501D'
const CF_MEZZA = 'EEEEEE10A01H501E'

let db: PGlite

async function schema(): Promise<void> {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE TABLE public.alunni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id uuid NOT NULL,
      codice_fiscale character(16),
      nome text, cognome text, data_nascita date,
      allergies text, note_mediche text,
      anonimizzato_il timestamptz
    );
    CREATE TABLE public.enrollment_submissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id uuid NOT NULL,
      data jsonb NOT NULL,
      status text NOT NULL,
      imported_at timestamptz,
      updated_at timestamptz
    );
    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL CHECK (livello IN ('info','warn','error')),
      evento text NOT NULL,
      sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL,
      fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1,
      visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);
  `)
}

type Figlio = Record<string, string | null>

async function domanda(id: string, figli: Figlio[], status = 'approved', sede = SEDE): Promise<void> {
  await db.query(
    `INSERT INTO public.enrollment_submissions (id, scuola_id, data, status, imported_at)
     VALUES ($1, $2, $3::jsonb, $4, CASE WHEN $4 = 'approved' THEN now() END)`,
    [id, sede, JSON.stringify({ children: figli, adults: [{ first_name: 'Adulta' }] }), status],
  )
}

async function scheda(cf: string | null, campi: Record<string, string | null>, sede = SEDE): Promise<void> {
  await db.query(
    `INSERT INTO public.alunni (scuola_id, codice_fiscale, nome, cognome, data_nascita, allergies, note_mediche, anonimizzato_il)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8::timestamptz)`,
    [sede, cf, campi.nome ?? 'Bimbo', campi.cognome ?? 'DiProva', campi.data_nascita ?? '2022-01-01',
      campi.allergies ?? null, campi.note_mediche ?? null, campi.anonimizzato_il ?? null],
  )
}

async function figli(id: string): Promise<Figlio[]> {
  const { rows } = await db.query<{ c: Figlio[] }>(
    `SELECT data->'children' AS c FROM public.enrollment_submissions WHERE id = $1`, [id],
  )
  return rows[0].c
}

async function tick(): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT public.iscrizioni_sanitari_tick() AS n')
  return rows[0].n
}

async function riga(fingerprint: string): Promise<{ livello: string; contesto: Record<string, unknown> } | undefined> {
  const { rows } = await db.query<{ livello: string; contesto: Record<string, unknown> }>(
    'SELECT livello, contesto FROM public.app_log WHERE fingerprint = $1', [fingerprint],
  )
  return rows[0]
}

const D = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`
const ALLERGIA = 'Arachidi   e FRUTTA a guscio'

beforeAll(async () => {
  db = new PGlite()
  await schema()
  await db.exec(NUOVA)
  await db.exec(NUOVA) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('DELETE FROM public.alunni; DELETE FROM public.enrollment_submissions; DELETE FROM public.app_log;')
})

describe('iscrizioni_sanitari_tick — si toglie solo ciò che è in scheda', () => {
  it('scheda con lo stesso testo (spazi e maiuscole a parte): la domanda perde i sanitari e tiene il resto', async () => {
    await scheda(CF_PIENA, { allergies: 'arachidi e frutta a guscio', note_mediche: 'Asma lieve; inalatore' })
    await domanda(D(1), [{ nome: 'Bimbo', codice_fiscale: CF_PIENA, allergies: ALLERGIA, note_mediche: 'asma  lieve' }])

    expect(await tick()).toBe(1)
    const [f] = await figli(D(1))
    expect(f.allergies).toBeNull()
    expect(f.note_mediche).toBeNull()
    expect(f.sanitari_rimossi_il).toBeTruthy()
    expect(f.nome).toBe('Bimbo') // controllo positivo: il resto della domanda resta
    expect(f.codice_fiscale).toBe(CF_PIENA)
  })

  it('scheda VUOTA: i sanitari restano nella domanda, e si contano con una riga warn', async () => {
    await scheda(CF_VUOTA, {})
    await domanda(D(2), [{ codice_fiscale: CF_VUOTA, allergies: ALLERGIA, note_mediche: null }])

    expect(await tick()).toBe(0)
    const [f] = await figli(D(2))
    expect(f.allergies).toBe(ALLERGIA)
    expect(f.sanitari_rimossi_il).toBeUndefined()

    const info = await riga('cron:iscrizioni-sanitari')
    expect(info?.livello).toBe('info')
    expect(info?.contesto).toMatchObject({ n_domande: 0, n_conservati: 1 })
    const warn = await riga('cron:iscrizioni-sanitari-conservati')
    expect(warn?.livello).toBe('warn')
    expect(warn?.contesto).toMatchObject({ n_conservati: 1 })
  })

  it('scheda con le allergie ma SENZA le note della domanda: il bambino resta intero', async () => {
    await scheda(CF_MEZZA, { allergies: ALLERGIA })
    await domanda(D(3), [{ codice_fiscale: CF_MEZZA, allergies: ALLERGIA, note_mediche: 'Epilessia, terapia al bisogno' }])

    expect(await tick()).toBe(0)
    const [f] = await figli(D(3))
    expect(f.allergies).toBe(ALLERGIA)
    expect(f.note_mediche).toBe('Epilessia, terapia al bisogno')
  })

  it('la scheda con quel codice fiscale è in UN\'ALTRA sede: non conta', async () => {
    await scheda(CF_ALTROVE, { allergies: ALLERGIA }, ALTRA_SEDE)
    await domanda(D(4), [{ codice_fiscale: CF_ALTROVE, allergies: ALLERGIA }])

    expect(await tick()).toBe(0)
    expect((await figli(D(4)))[0].allergies).toBe(ALLERGIA)
  })

  it('scheda anonimizzata: non conta', async () => {
    await scheda(CF_ANONIMA, { allergies: ALLERGIA, anonimizzato_il: '2026-09-01T00:00:00Z' })
    await domanda(D(5), [{ codice_fiscale: CF_ANONIMA, allergies: ALLERGIA }])

    expect(await tick()).toBe(0)
    expect((await figli(D(5)))[0].allergies).toBe(ALLERGIA)
  })

  it('senza codice fiscale: vale la scheda con nome, cognome e data di nascita uguali', async () => {
    await scheda(null, { nome: 'Lia', cognome: 'Prova', data_nascita: '2021-05-06', allergies: ALLERGIA })
    await domanda(D(6), [
      { nome: 'Lia', cognome: 'Prova', data_nascita: '2021-05-06', codice_fiscale: null, allergies: ALLERGIA },
      { nome: 'Lia', cognome: 'Prova', data_nascita: '2021-05-07', codice_fiscale: '', allergies: ALLERGIA },
    ])

    expect(await tick()).toBe(1)
    const [stessa, altraData] = await figli(D(6))
    expect(stessa.allergies).toBeNull()
    expect(altraData.allergies, 'una data diversa non è lo stesso bambino').toBe(ALLERGIA)
  })

  it('domanda NON accolta, o bambino senza dati sanitari: nessuna riscrittura', async () => {
    await scheda(CF_PIENA, { allergies: ALLERGIA })
    await domanda(D(7), [{ codice_fiscale: CF_PIENA, allergies: ALLERGIA }], 'pending')
    await domanda(D(8), [{ codice_fiscale: CF_PIENA, allergies: '   ', note_mediche: null }])

    expect(await tick()).toBe(0)
    expect((await figli(D(7)))[0].allergies).toBe(ALLERGIA)
    expect((await figli(D(8)))[0].sanitari_rimossi_il).toBeUndefined()
  })

  it('una seconda notte non riscrive ciò che è già stato tolto', async () => {
    await scheda(CF_PIENA, { allergies: ALLERGIA })
    await domanda(D(9), [{ codice_fiscale: CF_PIENA, allergies: ALLERGIA }])
    expect(await tick()).toBe(1)
    expect(await tick()).toBe(0)
  })

  it('i permessi: la funzione non è eseguibile da anon né da authenticated', async () => {
    const { rows } = await db.query<{ anon: boolean; auth: boolean; servizio: boolean }>(`
      SELECT has_function_privilege('anon', 'public.iscrizioni_sanitari_tick()', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'public.iscrizioni_sanitari_tick()', 'EXECUTE') AS auth,
             has_function_privilege('service_role', 'public.iscrizioni_sanitari_tick()', 'EXECUTE') AS servizio`)
    expect(rows[0]).toEqual({ anon: false, auth: false, servizio: true })
  })

  it('CONTROLLO NEGATIVO: con la funzione di prima la scheda vuota perde il dato (è il difetto)', async () => {
    await db.exec(funzioneVecchia())
    try {
      await scheda(CF_VUOTA, {})
      await domanda(D(2), [{ codice_fiscale: CF_VUOTA, allergies: ALLERGIA }])
      await tick()
      expect((await figli(D(2)))[0].allergies, 'la funzione vecchia non toglie più il dato: il test non discrimina').toBeNull()
    } finally {
      await db.exec(NUOVA)
    }
  })
})
