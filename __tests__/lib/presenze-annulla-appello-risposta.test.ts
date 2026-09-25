/**
 * `@/lib/presenze/annulla-appello-risposta` — il contratto HTTP UNICO dell'annullamento
 * dell'appello, condiviso da `DELETE /api/attendance/daily` e `DELETE /api/primaria/appello`.
 *
 * Qui si verifica, per ogni esito della libreria, lo stato, il `codice` e la prosa: la prosa
 * deve essere quella del catalogo italiano del codice (una frase sola per server e client),
 * e il 200 deve portare le SOLE sei colonne dell'appello anche se l'esito ne contenesse altre.
 * Più un controllo che le due rotte usino davvero questa funzione e non si riscrivano la loro.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import it_ from '../../messages/it/shared.json'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import {
  rispostaAnnullaAppello,
  rispostaAnnullaSoloOggi,
  rispostaAppelloNonAnnullato,
} from '@/lib/presenze/annulla-appello-risposta'
import type { EsitoAnnullaAppello } from '@/lib/presenze/annulla-appello'

const CATALOGO_IT = it_ as Record<string, string>
const PRESENZA = 'cccc0000-0000-4000-8000-00000000c001'
const ALUNNO = '11111111-1111-4111-8111-111111111111'
const SEDE = 'aaaa0000-0000-4000-8000-00000000a001'

describe('rifiuti: stato, codice e la frase del catalogo', () => {
  it.each([
    [{ esito: 'errore', fase: 'lettura' }, 500, 'APPELLO_NON_ANNULLATO'],
    [{ esito: 'errore', fase: 'scrittura' }, 500, 'APPELLO_NON_ANNULLATO'],
    [{ esito: 'non-trovata' }, 404, 'PRESENZA_NON_TROVATA'],
    [{ esito: 'niente-da-annullare' }, 409, 'NIENTE_DA_ANNULLARE'],
    [{ esito: 'cambiata-nel-frattempo' }, 409, 'APPELLO_CAMBIATO_NEL_FRATTEMPO'],
  ] as Array<[EsitoAnnullaAppello, number, keyof typeof CODICI_ERRORE]>)(
    '%o → %i %s',
    async (esito, stato, codice) => {
      const res = rispostaAnnullaAppello(esito)
      expect(res.status).toBe(stato)
      const corpo = await res.json()
      expect(corpo).toEqual({ error: CATALOGO_IT[CODICI_ERRORE[codice]], codice })
      expect(typeof corpo.error).toBe('string')
      expect(corpo.error.length).toBeGreaterThan(0)
    },
  )

  it('«solo oggi» → 409 APPELLO_ANNULLA_SOLO_OGGI', async () => {
    const res = rispostaAnnullaSoloOggi()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: CATALOGO_IT[CODICI_ERRORE.APPELLO_ANNULLA_SOLO_OGGI],
      codice: 'APPELLO_ANNULLA_SOLO_OGGI',
    })
  })

  it('il guasto del `catch` è lo stesso 500 del guasto riconosciuto dalla libreria', async () => {
    const dalCatch = rispostaAppelloNonAnnullato()
    const dallaLibreria = rispostaAnnullaAppello({ esito: 'errore', fase: 'scrittura' })
    expect(dalCatch.status).toBe(500)
    expect(await dalCatch.json()).toEqual(await dallaLibreria.json())
  })
})

describe('riuscite: 200 con le sole sei colonne', () => {
  it('`cancellata` → presenza null', async () => {
    const res = rispostaAnnullaAppello({
      esito: 'cancellata', presenza: null, presenzaId: PRESENZA, scuolaId: SEDE, avvisoRitirato: true,
    })
    expect(res.status).toBe(200)
    // Né la sede né l'esito della revoca escono verso il client.
    expect(await res.json()).toEqual({ success: true, esito: 'cancellata', presenza: null })
  })

  it('`ripristinata-comunicazione` → le sei colonne, niente di più anche se l\'esito ne porta altre', async () => {
    const presenza = {
      id: PRESENZA,
      alunno_id: ALUNNO,
      data: '2026-09-25',
      stato: 'assente',
      orario_entrata: null,
      orario_uscita: undefined as unknown as null,
      // Campi che non devono MAI uscire, se un giorno la libreria li leggesse.
      giustificazione_testo: 'testo sanitario',
      note_appello: 'nota interna',
    }
    const res = rispostaAnnullaAppello({
      esito: 'ripristinata-comunicazione', presenza, presenzaId: PRESENZA, scuolaId: SEDE, avvisoRitirato: false,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      esito: 'ripristinata-comunicazione',
      presenza: {
        id: PRESENZA,
        alunno_id: ALUNNO,
        data: '2026-09-25',
        stato: 'assente',
        orario_entrata: null,
        orario_uscita: null,
      },
    })
  })
})

describe('le due rotte usano questa funzione, non una copia', () => {
  const RADICE = process.cwd()
  const senzaCommenti = (f: string) =>
    fs.readFileSync(path.join(RADICE, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const deleteDi = (f: string) => {
    const src = senzaCommenti(f)
    const i = src.indexOf('export const DELETE')
    expect(i).toBeGreaterThan(-1)
    return src.slice(i)
  }

  it.each([
    'src/app/api/attendance/daily/route.ts',
    'src/app/api/primaria/appello/route.ts',
  ])('%s', (f) => {
    const del = deleteDi(f)
    expect(del).toContain('rispostaAnnullaAppello(')
    expect(del).toContain('rispostaAnnullaSoloOggi()')
    expect(del).toContain('rispostaAppelloNonAnnullato()')
    // Nessun codice dell'annullamento riscritto a mano nella DELETE.
    for (const codice of [
      'APPELLO_ANNULLA_SOLO_OGGI',
      'PRESENZA_NON_TROVATA',
      'NIENTE_DA_ANNULLARE',
      'APPELLO_CAMBIATO_NEL_FRATTEMPO',
      'APPELLO_NON_ANNULLATO',
    ]) {
      expect(del).not.toContain(`'${codice}'`)
    }
  })
})
