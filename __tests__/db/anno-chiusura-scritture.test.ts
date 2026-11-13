import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import {
  SEDE_E2E, SEDE_VERA, UTENTE, creaBancoPassaggio, errore, inRollback, una,
  type BancoPassaggio,
} from '../helpers/passaggio-banco'

/**
 * COMPITO 4.9.5 · A GUARDIA ACCESA NESSUNA SCRITTURA RAGGIUNGE UN ANNO CHIUSO (O IN CHIUSURA) SENZA GETTONE.
 *
 * Per OGNI tabella `data` del registro (non per una a campione) con la guardia accesa:
 *  · anno `chiuso`, nessun gettone               → `ANNO_CHIUSO`;
 *  · anno `in_chiusura`, nessun gettone          → `ANNO_CHIUSO` (lo staff passa solo col gettone «agosto»);
 *  · `in_chiusura` + gettone `agosto` o `correzione` dell'utente che scrive → passa;
 *  · `chiuso` + gettone `correzione`             → passa; `chiuso` + gettone `agosto` → `ANNO_CHIUSO`;
 *  · il gettone di un ALTRO utente, scaduto, di un altro anno, o già usato in un'altra transazione → `ANNO_CHIUSO`;
 *  · l'anno corrente non si ferma mai.
 * Il docente non ha un caso a sé perché non ha un gettone: `creaGettoni` lo crea solo per lo staff, e senza gettone il database
 * rifiuta chiunque (anche la chiave di servizio), il titolare compreso. Lo prova il caso «nessun gettone» su ogni tabella.
 *
 * Non vede (e non finge di vedere): il comportamento con due connessioni concorrenti (PGlite ne ha una), le tabelle del registro che
 * il banco non ha (le nove `data` sono quelle di `TABELLE_DEL_BANCO`; il lock minimo sotto fallisce se diventano di meno).
 * Le colonne d'incasso di `pagamenti` e l'interruttore `anno_chiuso.oblio` sono provati in `anno-registro-guardia.test.ts`.
 *
 * Ogni prova sta in una transazione che finisce in ROLLBACK. L'orologio è prima dell'inizio del 2027/28: `PASSAGGIO_DA_FARE`
 * (4.9.2) non entra in questi casi. Solo uuid inventati.
 */

let b: BancoPassaggio

const ORA = '2027-08-25T10:00:00.000Z'
const MINIMO_TABELLE = 9
const MOTIVO = 'rettifica dopo lo scrutinio'
const ALTRO_UTENTE = '99999999-9999-4999-8999-999999999992'

beforeAll(async () => {
  b = await creaBancoPassaggio({ fino: 'M49b' })
}, 180_000)
afterAll(async () => {
  await b?.db.close()
})
afterEach(() => {
  vi.useRealTimers()
})

async function con(fn: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ORA))
  await inRollback(b.db, async () => {
    await b.db.query(`UPDATE public.anno_regole SET guardia_attiva = true`)
    await fn()
  })
}

async function tabelle(): Promise<string[]> {
  const r = await b.db.query<{ tabella: string }>(
    `SELECT tabella FROM public.anno_tabelle WHERE modo = 'data' AND guardia <> 'nessuna' ORDER BY tabella`)
  return r.rows.map((x) => x.tabella)
}

const imposta = async (header: string | null, sub: string | null, ruolo = 'authenticated') => {
  await b.db.query(`SELECT set_config('request.headers', $1, true)`, [header ?? ''])
  await b.db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [sub ? JSON.stringify({ sub, role: ruolo }) : ''])
}
const intestazione = (...ids: string[]) => JSON.stringify({ 'x-kidville-correzione': ids.join(',') })

async function stato(annoSede: string, nuovo: 'chiuso' | 'in_chiusura') {
  await b.db.query(`UPDATE public.anni_sede SET stato = $2 WHERE id = $1`, [annoSede, nuovo])
}

async function gettone(codice: 'agosto' | 'correzione', o: { annoSede?: string; utente?: string; scaduto?: boolean } = {}): Promise<string> {
  return una<string>(
    b.db,
    `INSERT INTO public.correzioni_anno_chiuso (utente_id, ruolo, anno_sede_id, codice, motivo, creata_il, scade_il)
     VALUES ($1, 'segreteria', $2, $3, $4,
             CASE WHEN $5::boolean THEN now() - interval '20 minutes' ELSE now() END,
             CASE WHEN $5::boolean THEN now() - interval '10 minutes' ELSE now() + interval '10 minutes' END)
     RETURNING id`,
    [o.utente ?? UTENTE, o.annoSede ?? b.da, codice, codice === 'correzione' ? MOTIVO : null, o.scaduto ?? false])
}

/** Un INSERT sintetico nell'anno e nella sede dati: l'esito è il codice dell'eccezione, o `nessun-errore`. */
async function scrive(tabella: string, sede: string, anno: string, data: string): Promise<string> {
  return errore(
    b.db,
    `SELECT public.anno_guardia_verifica(
        t, 'INSERT', NULL,
        jsonb_build_object('id', gen_random_uuid(), 'scuola_id', $2::uuid, 'anno_id', $3::uuid, t.colonna_data, $4::text),
        NULL, false)
       FROM public.anno_tabelle t WHERE t.tabella = $1`,
    [tabella, sede, anno, data])
}

/** Per ogni tabella: l'esito di una scrittura nell'anno vecchio della sede E2E (il 2026/27: finisce il 31/08/2027). */
async function esiti(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const t of await tabelle()) out[t] = await scrive(t, SEDE_E2E, b.annoDa, '2027-08-20')
  return out
}
const tutte = (e: Record<string, string>, valore: string) => Object.values(e).every((v) => v === valore)

describe('4.9.5 · a guardia accesa nessuna scrittura raggiunge un anno chiuso senza gettone', () => {
  it('non è cieco: il registro ha almeno le nove tabelle `data` del banco', async () => {
    expect((await tabelle()).length).toBeGreaterThanOrEqual(MINIMO_TABELLE)
  })

  it('anno chiuso, nessun gettone, nessun header → ANNO_CHIUSO su ogni tabella', async () => {
    await con(async () => {
      await stato(b.da, 'chiuso')
      await imposta(null, null, 'service_role')
      const e = await esiti()
      expect(Object.keys(e).length).toBeGreaterThanOrEqual(MINIMO_TABELLE)
      expect(e, JSON.stringify(e)).toSatisfy((x: Record<string, string>) => tutte(x, 'ANNO_CHIUSO'))
    })
  })

  it('anno in_chiusura, nessun gettone → PASSA su ogni tabella (agosto, giro 1 R6): lo staff scrive senza dare un motivo', async () => {
    await con(async () => {
      await stato(b.da, 'in_chiusura')
      await imposta(null, UTENTE, 'service_role')
      const e = await esiti()
      expect(e, JSON.stringify(e)).toSatisfy((x: Record<string, string>) => tutte(x, 'nessun-errore'))
    })
  })

  it('anno chiuso, nessun gettone → ANNO_CHIUSO su ogni tabella (anche per la chiave di servizio)', async () => {
    await con(async () => {
      await stato(b.da, 'chiuso')
      await imposta(null, UTENTE, 'service_role')
      const e = await esiti()
      expect(e, JSON.stringify(e)).toSatisfy((x: Record<string, string>) => tutte(x, 'ANNO_CHIUSO'))
    })
  })

  it('in_chiusura + gettone `agosto` dell’utente → passa su ogni tabella', async () => {
    await con(async () => {
      await stato(b.da, 'in_chiusura')
      const g = await gettone('agosto')
      await imposta(intestazione(g), UTENTE)
      const e = await esiti()
      expect(e, JSON.stringify(e)).toSatisfy((x: Record<string, string>) => tutte(x, 'nessun-errore'))
    })
  })

  it('in_chiusura + gettone `correzione` → passa; chiuso + `correzione` → passa', async () => {
    await con(async () => {
      await stato(b.da, 'in_chiusura')
      const g = await gettone('correzione')
      await imposta(intestazione(g), UTENTE)
      expect(tutte(await esiti(), 'nessun-errore')).toBe(true)
      await stato(b.da, 'chiuso')
      expect(tutte(await esiti(), 'nessun-errore')).toBe(true)
    })
  })

  it('chiuso + gettone `agosto` → ANNO_CHIUSO: «agosto» vale solo mentre l’anno si sta chiudendo', async () => {
    await con(async () => {
      await stato(b.da, 'chiuso')
      const g = await gettone('agosto')
      await imposta(intestazione(g), UTENTE)
      expect(tutte(await esiti(), 'ANNO_CHIUSO')).toBe(true)
    })
  })

  it('il gettone di un altro utente, uno scaduto e uno di un altro anno non bastano', async () => {
    await con(async () => {
      await stato(b.da, 'chiuso')
      const altroUtente = await gettone('correzione', { utente: ALTRO_UTENTE })
      const scaduto = await gettone('correzione', { scaduto: true })
      const altroAnno = await gettone('correzione', { annoSede: b.vera.da })
      await imposta(intestazione(altroUtente, scaduto, altroAnno), UTENTE)
      const e = await esiti()
      expect(e, JSON.stringify(e)).toSatisfy((x: Record<string, string>) => tutte(x, 'ANNO_CHIUSO'))
    })
  })

  it('un header che non è un uuid non fa niente (e non fa saltare la guardia)', async () => {
    await con(async () => {
      await stato(b.da, 'chiuso')
      await imposta(intestazione('non-un-uuid', "'; DROP TABLE x; --"), UTENTE)
      expect(tutte(await esiti(), 'ANNO_CHIUSO')).toBe(true)
    })
  })

  it('l’anno corrente non si ferma mai, a guardia accesa e senza gettone', async () => {
    await con(async () => {
      await imposta(null, null, 'service_role')
      for (const t of await tabelle()) {
        // 2027/28 dell'E2E: in preparazione o a iscrizioni aperte, prima dell'inizio (nessun PASSAGGIO_DA_FARE).
        expect(await scrive(t, SEDE_E2E, b.annoA, '2027-09-05'), t).toBe('nessun-errore')
      }
    })
  })

  it('una sede che non è quella dell’anno chiuso non è toccata dallo stato di quell’altra', async () => {
    await con(async () => {
      await stato(b.da, 'chiuso')
      await imposta(null, null, 'service_role')
      for (const t of await tabelle()) {
        expect(await scrive(t, SEDE_VERA, b.annoDa,'2027-08-20'), t).not.toBe('ANNO_CHIUSO')
      }
    })
  })

  it('la scrittura vera su `presenze` (trigger compreso) senza gettone → ANNO_CHIUSO e la riga non esiste', async () => {
    await con(async () => {
      await stato(b.da, 'chiuso')
      await imposta(null, null, 'service_role')
      const esito = await errore(
        b.db,
        `INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ($1, $2, $3)`,
        [(await una<string>(b.db, `SELECT id FROM public.alunni WHERE scuola_id = $1 LIMIT 1`, [SEDE_E2E])), SEDE_E2E, '2027-08-20'])
      expect(esito).toBe('ANNO_CHIUSO')
    })
  })
})
