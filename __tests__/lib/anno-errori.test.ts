import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { logEvento, logErrore } = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento, logErrore }))

import { redact } from '@/lib/logging/redact'
import { erroreAnno, CODICI_INTERNI } from '@/lib/anno/errori'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { CODICI_ANNO } from '@/lib/anno/tipi'

beforeEach(() => {
  logEvento.mockClear()
  logErrore.mockClear()
})

async function corpo(r: Response | null) {
  expect(r).not.toBeNull()
  return { stato: r!.status, body: await r!.json() }
}

describe('erroreAnno — i codici dei trigger diventano risposte', () => {
  it('ANNO_CHIUSO → 409 col messaggio per la segreteria', async () => {
    const r = await corpo(erroreAnno({ code: 'P0001', message: 'ANNO_CHIUSO' }))
    expect(r.stato).toBe(409)
    expect(r.body).toEqual({
      error: 'Anno scolastico chiuso: servono i permessi di correzione.',
      codice: 'ANNO_CHIUSO',
    })
  })

  const TABELLA: [string, number, string][] = [
    ['PASSAGGIO_DA_FARE', 409, 'Il passaggio all’anno nuovo non è ancora stato fatto: completalo prima di continuare.'],
    ['CONFINE_CON_RIGHE', 409, 'Non si può spostare la data: ci sono già dati registrati nei giorni che cambierebbero anno.'],
    ['SEZIONE_DI_ALTRO_ANNO', 422, 'La classe scelta appartiene a un altro anno scolastico.'],
    ['SEZIONE_DI_ALTRA_SEDE', 422, 'La classe scelta appartiene a un’altra sede.'],
    ['ANNO_NON_COERENTE', 422, 'I dati non sono coerenti con l’anno scolastico scelto.'],
    ['MODULO_NON_RICHIESTO', 422, 'Questo modulo non è richiesto per questo tipo di iscrizione.'],
    ['CONFINE_NON_VALIDO', 422, 'Le date dell’anno scolastico non sono valide.'],
    ['CALENDARIO_NON_CONTINUO', 422, 'Gli anni scolastici di una sede devono susseguirsi senza buchi né sovrapposizioni.'],
    ['ANNO_DA_SPECIFICARE', 400, 'Scegli l’anno scolastico a cui si riferisce questa operazione.'],
    ['ANNO_NON_DELLA_SEDE', 400, 'L’anno scolastico scelto non appartiene a questa sede.'],
    ['GIORNO_SENZA_ANNO', 500, 'Nessun anno scolastico copre questo giorno: avvisa l’assistenza.'],
    ['ANNO_NON_VISIBILE', 403, 'Questo anno scolastico non è ancora disponibile per te.'],
    ['ANNO_NON_ACCESSIBILE', 403, 'Questo anno scolastico non è disponibile per questa sede.'],
    ['MOTIVO_OBBLIGATORIO', 400, 'Indica il motivo.'],
    // PR 4.2, compito 4.2.4: le funzioni delle impostazioni di sede (20261108052944_anno_impostazioni_sede.sql).
    ['ANNO_NON_TROVATO', 404, 'Questo anno scolastico non esiste più. Aggiorna la pagina.'],
    ['ANNO_IN_CHIUSURA', 409, 'L’anno è in chiusura: l’ultimo giorno aperto non si può più cambiare.'],
    ['DATE_NON_VALIDE', 422, 'Le date scelte non sono valide per questo anno scolastico.'],
    ['STATO_NON_AMMESSO', 409, 'Questa operazione non è possibile nello stato attuale. Aggiorna la pagina e riprova.'],
    ['PREREQUISITI_MANCANTI', 409, 'Per aprire le iscrizioni mancano ancora dei dati: controlla le quote e i moduli dell’anno.'],
    ['PARAMETRO_MANCANTE', 400, 'Manca un dato richiesto. Controlla e riprova.'],
    // PR 4.5, compito 4.5.0: preparare e aprire l'anno prossimo (M45c e M45d).
    ['ANNO_NON_APERTO', 409, 'Le iscrizioni per questo anno scolastico non sono ancora aperte.'],
    ['FREQUENZA_NON_VIVA', 409, 'Questo bambino non ha più un’iscrizione attiva nell’anno di partenza: non si può confermare.'],
    ['SEZIONE_OBBLIGATORIA', 422, 'Scegli la classe per l’anno nuovo: il bambino cambia grado e non può restare senza.'],
    ['SEDE_DIVERSA', 422, 'La scelta riguarda un’altra sede: controlla la sede e riprova.'],
    ['ANNO_NON_MODIFICABILE', 409, 'Questo anno scolastico non si può più modificare da qui.'],
    ['ANNO_NON_OFFERTO', 422, 'Questo anno scolastico non offre quel servizio o quella fascia d’età.'],
    ['ISCRIZIONI_CHIUSE', 409, 'Le iscrizioni per questo anno scolastico sono chiuse.'],
    ['IMPORTO_NON_VALIDO', 422, 'L’importo non è valido: scrivi una cifra maggiore di zero, con al massimo due decimali.'],
  ]

  it('i dettagli della route finiscono nel corpo accanto al codice, senza toccare stato e frase', async () => {
    const r = await corpo(erroreAnno({ message: 'PREREQUISITI_MANCANTI' }, 'x:POST', { mancano: ['quota_nuova'] }))
    expect(r.stato).toBe(409)
    expect(r.body).toEqual({
      error: 'Per aprire le iscrizioni mancano ancora dei dati: controlla le quote e i moduli dell’anno.',
      codice: 'PREREQUISITI_MANCANTI',
      mancano: ['quota_nuova'],
    })
  })

  it('un dettaglio non può sovrascrivere il codice né la frase', async () => {
    const r = await corpo(
      erroreAnno({ message: 'DATE_NON_VALIDE' }, 'x:PATCH', { codice: 'ALTRO', error: 'falso', motivo: 'fuori_periodo' }),
    )
    expect(r.body).toEqual({
      error: 'Le date scelte non sono valide per questo anno scolastico.',
      codice: 'DATE_NON_VALIDE',
      motivo: 'fuori_periodo',
    })
  })

  it.each(TABELLA)('%s → %i con messaggio e codice', async (codice, stato, messaggio) => {
    const r = await corpo(erroreAnno({ code: 'P0001', message: codice }))
    expect(r.stato).toBe(stato)
    expect(r.body).toEqual({ error: messaggio, codice })
  })

  it('CALENDARIO_NON_CONTINUO arriva come 23514 e resta 422', async () => {
    const r = await corpo(erroreAnno({ code: '23514', message: 'CALENDARIO_NON_CONTINUO' }))
    expect(r.stato).toBe(422)
    expect(r.body.codice).toBe('CALENDARIO_NON_CONTINUO')
  })

  it('tutti i codici di CODICI_ANNO sono tradotti, e la tabella del test li copre tutti', () => {
    const tradotti = CODICI_ANNO.filter((c) => erroreAnno({ message: c }) !== null)
    expect([...tradotti].sort()).toEqual([...CODICI_ANNO].sort())
    expect(TABELLA.map((t) => t[0]).concat('ANNO_CHIUSO').sort()).toEqual([...CODICI_ANNO].sort())
  })

  it('ANNO_CHIUSO e PASSAGGIO_DA_FARE: un warn con le sole chiavi tipo, error_code, operazione', () => {
    for (const codice of ['ANNO_CHIUSO', 'PASSAGGIO_DA_FARE']) {
      logEvento.mockClear()
      erroreAnno({ code: 'P0001', message: codice }, 'admin/sections:POST')
      expect(logEvento).toHaveBeenCalledTimes(1)
      const [evento, livello, campi] = logEvento.mock.calls[0]
      expect(evento).toBe('anno-scolastico')
      expect(livello).toBe('warn')
      expect(Object.keys(campi).sort()).toEqual(['error_code', 'operazione', 'tipo'])
      expect(campi.error_code).toBe(codice)
      expect(logEvento.mock.calls[0]).toHaveLength(3) // niente errore allegato, niente details
      expect(logErrore).not.toHaveBeenCalled()
    }
  })

  it('senza operazione il warn porta solo tipo e error_code', () => {
    erroreAnno({ message: 'ANNO_CHIUSO' })
    const campi = logEvento.mock.calls[0][2]
    expect(Object.keys(campi).sort()).toEqual(['error_code', 'tipo'])
  })

  it('il warn passa dalla VERA redact: il codice resta in chiaro e i due codici si distinguono', () => {
    const viste: unknown[] = []
    for (const codice of ['ANNO_CHIUSO', 'PASSAGGIO_DA_FARE']) {
      logEvento.mockClear()
      erroreAnno({ message: codice }, 'admin/sections:POST')
      viste.push(redact(logEvento.mock.calls[0][2]))
    }
    expect(viste).toEqual([
      { tipo: 'anno-protetto', error_code: 'ANNO_CHIUSO', operazione: 'admin/sections:POST' },
      { tipo: 'anno-protetto', error_code: 'PASSAGGIO_DA_FARE', operazione: 'admin/sections:POST' },
    ])
  })

  it('i prefissi e i suffissi strani non sono codici', () => {
    for (const m of ['ANNO_CHIUSO_ALTRO', 'PREFISSO ANNO_CHIUSO', 'ANNO_CHIUSO-x', 'ANNO_CHIUSO.x']) {
      expect(erroreAnno({ message: m }), m).toBeNull()
    }
    expect(erroreAnno({ code: '23505', message: 'duplicate key value violates unique constraint "x"' })).toBeNull()
  })

  it('ANNO_CHIUSO: testo resta 409', () => {
    expect(erroreAnno({ message: 'ANNO_CHIUSO: testo' })?.status).toBe(409)
  })

  it('GIORNO_SENZA_ANNO: logErrore una volta, nessun warn', () => {
    erroreAnno({ message: 'GIORNO_SENZA_ANNO' }, 'x:POST')
    expect(logErrore).toHaveBeenCalledTimes(1)
    expect(logEvento).not.toHaveBeenCalled()
  })

  it('gli altri codici non loggano', () => {
    erroreAnno({ message: 'SEZIONE_DI_ALTRO_ANNO' })
    erroreAnno({ message: 'ANNO_DA_SPECIFICARE' })
    expect(logEvento).not.toHaveBeenCalled()
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('ciò che non è dell’anno → null', () => {
    expect(erroreAnno({ message: 'duplicate key value violates unique constraint' })).toBeNull()
    expect(erroreAnno({ code: '42501' })).toBeNull()
    expect(erroreAnno({ code: 'P0001', message: 'QUALCOSA_DI_ALTRO' })).toBeNull()
    expect(erroreAnno(null)).toBeNull()
    expect(erroreAnno(undefined)).toBeNull()
    expect(logEvento).not.toHaveBeenCalled()
    expect(logErrore).not.toHaveBeenCalled()
  })
})

describe('schemaAnnoIndietro', () => {
  it.each(['PGRST204', 'PGRST205', 'PGRST202', '42P01', '42703', '42883'])('%s → true', (code) => {
    expect(schemaAnnoIndietro({ code })).toBe(true)
  })
  it.each(['23505', 'P0001'])('%s → false', (code) => {
    expect(schemaAnnoIndietro({ code })).toBe(false)
  })
  it('null, undefined, senza code → false', () => {
    expect(schemaAnnoIndietro(null)).toBe(false)
    expect(schemaAnnoIndietro(undefined)).toBe(false)
    expect(schemaAnnoIndietro({})).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Copertura: ogni codice sollevato dalle migrazioni dell'anno è tradotto o dichiarato interno.
// ---------------------------------------------------------------------------------------------

const PRIMA_MIGRAZIONE_ANNO = '20261106200347'
const DIR_MIGRAZIONI = path.join(process.cwd(), 'supabase', 'migrations')

/** I file delle migrazioni dell'anno: `*anno*.sql` dalla PR 1 in poi. */
function fileMigrazioniAnno(): string[] {
  return fs
    .readdirSync(DIR_MIGRAZIONI)
    .filter((f) => f.endsWith('.sql') && f.includes('anno') && f.slice(0, 14) >= PRIMA_MIGRAZIONE_ANNO)
    .sort()
}

/** Codici `[A-Z][A-Z_]+` dopo `RAISE EXCEPTION '…'` o `RAISE EXCEPTION USING MESSAGE = '…'`. */
export function codiciSollevati(sql: string): string[] {
  const re = /RAISE\s+EXCEPTION\s+(?:USING\s+MESSAGE\s*=\s*)?'([A-Z][A-Z_]+)(?=['\s:%])/g
  return [...sql.matchAll(re)].map((m) => m[1])
}

describe('codiciSollevati — la lettura', () => {
  it('legge entrambe le forme e ignora i messaggi in minuscolo', () => {
    const sql = `
      RAISE EXCEPTION 'CODICE_UNO' USING DETAIL = 'x';
      RAISE EXCEPTION USING MESSAGE = 'CODICE_DUE';
      RAISE EXCEPTION 'messaggio libero % ok', 1;
      RAISE EXCEPTION 'CODICE_TRE: %', x;
    `
    expect(codiciSollevati(sql)).toEqual(['CODICE_UNO', 'CODICE_DUE', 'CODICE_TRE'])
  })
})

describe('copertura dei codici delle migrazioni dell’anno', () => {
  const file = fileMigrazioniAnno()
  const codici = new Set(file.flatMap((f) => codiciSollevati(fs.readFileSync(path.join(DIR_MIGRAZIONI, f), 'utf8'))))

  it('legge davvero le migrazioni (un test che legge zero file è rosso)', () => {
    expect(file.length, `file letti: ${file.length}`).toBeGreaterThanOrEqual(6)
    expect(codici.size, `codici letti: ${codici.size}`).toBeGreaterThanOrEqual(15)
  })

  it('ogni codice è tradotto da erroreAnno oppure è in CODICI_INTERNI', () => {
    const interni = new Set<string>(CODICI_INTERNI)
    const scoperti = [...codici].filter((c) => erroreAnno({ message: c }) === null && !interni.has(c))
    expect(
      scoperti,
      'Codice sollevato da una migrazione dell’anno e non gestito: aggiungilo al switch di ' +
        '`erroreAnno` (src/lib/anno/errori.ts) oppure a `CODICI_INTERNI`.',
    ).toEqual([])
  })

  it('CODICI_INTERNI non contiene codici che nessuna migrazione solleva né codici già tradotti', () => {
    const inutili = CODICI_INTERNI.filter((c) => !codici.has(c) || erroreAnno({ message: c }) !== null)
    expect(inutili).toEqual([])
  })

  it('prova del rosso: un codice finto in una stringa di prova non è coperto', () => {
    const finto = codiciSollevati(`RAISE EXCEPTION 'CODICE_FINTO_DELLA_PROVA';`)
    const interni = new Set<string>(CODICI_INTERNI)
    const scoperti = finto.filter((c) => erroreAnno({ message: c }) === null && !interni.has(c))
    expect(scoperti).toEqual(['CODICE_FINTO_DELLA_PROVA'])
  })
})
