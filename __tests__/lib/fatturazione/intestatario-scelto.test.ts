import { describe, it, expect } from 'vitest'
import {
  zIntestatarioScelto,
  anagraficaDaIntestatarioAltro,
  anagraficaDaPersonaScelta,
  anagraficaDaScheda,
  nomeDaAnagrafica,
  type IntestatarioScelto,
} from '@/lib/fatturazione/intestatario-scelto'
import { applicaIntestatarioScelto, type Quota } from '@/lib/pagamenti/intestatari'
import { LIMITI } from '@/lib/aruba/fatturapa-xml'

/**
 * LA SCELTA DELL'INTESTATARIO — la forma dei dati, e la regola che decide.
 *
 * ─── PERCHÉ ESISTE, misurato in produzione il 2026-09-04 ─────────────────────
 * Su 93 pagamenti saldati, 88 rispondono oggi «Intestatario fattura non impostato
 * sull'anagrafica» (422): 579 alunni su 630 non hanno nessun intestatario
 * risolvibile, 2 genitori su 735 sono marcati «intestatario di famiglia», e le
 * fatture emesse in tutto sono TRE. Il selettore non raffina niente: è ciò che
 * sblocca l'emissione. Perciò la scelta deve poter FORNIRE l'intestatario dove
 * non c'è, non solo scavalcarne uno esistente — ed è il caso `quote.length === 0`.
 *
 * ─── I NOMI SONO SINTETICI, E NON È UNA FORMALITÀ ────────────────────────────
 * Repository pubblico, anagrafiche di minori in produzione. `FABBRI`, `BIANCHI` e
 * `PERLINI` sono contati a 0 su `parents.last_name` e `alunni.cognome`; i codici
 * fiscali sono costruiti a tavolino sulla forma del tracciato, non presi da
 * nessuno.
 */

const CF_FABBRI = 'FBBGLI80A41H501Z'
const CF_BIANCHI = 'BNCLCU80A01H501Z'

const persona: IntestatarioScelto = {
  tipo: 'persona',
  codice_fiscale: CF_BIANCHI,
  nome: 'Luca',
  cognome: 'Bianchi',
  indirizzo: 'Via delle Prove',
  cap: '81030',
  comune: 'Cesa',
  provincia: 'CE',
  numero_civico: '9',
}

const quotaSola: Quota[] = [{ adultId: 'parent-fabbri', importo: 150, label: '' }]

describe('applicaIntestatarioScelto — la regola, in una funzione pura', () => {
  it('nessuna scelta → le quote NON si toccano (è il comportamento di oggi, e ha sei chiamanti)', () => {
    const esito = applicaIntestatarioScelto(quotaSola, undefined, 150)
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.quote).toEqual(quotaSola)
  })

  it('quota unica + `adult` → sostituisce l’intestatario, lascia importo ed etichetta', () => {
    const partenza: Quota[] = [{ adultId: 'parent-fabbri', importo: 150, label: 'Divise' }]
    const esito = applicaIntestatarioScelto(partenza, { tipo: 'adult', adult_id: 'parent-bianchi' }, 150)
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.quote).toEqual([{ adultId: 'parent-bianchi', importo: 150, label: 'Divise' }])
  })

  it('NESSUNA quota → la scelta ne CREA una con l’importo totale (gli 88 pagamenti su 93)', () => {
    const esito = applicaIntestatarioScelto([], { tipo: 'adult', adult_id: 'parent-bianchi' }, 150)
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.quote).toEqual([{ adultId: 'parent-bianchi', importo: 150, label: '' }])
  })

  it('`persona` → adultId NULL e l’anagrafica al seguito (non c’è nessuna riga da rileggere)', () => {
    const esito = applicaIntestatarioScelto([], persona, 150)
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.quote).toHaveLength(1)
    expect(esito.quote[0].adultId).toBeNull()
    expect(esito.quote[0].anagrafica).toEqual({
      codice_fiscale: CF_BIANCHI,
      nome: 'Luca',
      cognome: 'Bianchi',
      indirizzo: 'Via delle Prove',
      cap: '81030',
      comune: 'Cesa',
      provincia: 'CE',
      numero_civico: '9',
    })
  })

  it('DUE quote (genitori separati) → si RIFIUTA, non si scavalca', () => {
    const ripartito: Quota[] = [
      { adultId: 'parent-fabbri', importo: 90, label: 'Mamma' },
      { adultId: 'parent-bianchi', importo: 60, label: 'Papà' },
    ]
    const esito = applicaIntestatarioScelto(ripartito, { tipo: 'adult', adult_id: 'parent-bianchi' }, 150)
    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.motivo).toBe('conflitto_quote')
  })

  it('senza scelta, due quote restano due quote: il rifiuto riguarda la SCELTA, non la ripartizione', () => {
    const ripartito: Quota[] = [
      { adultId: 'parent-fabbri', importo: 90, label: 'Mamma' },
      { adultId: 'parent-bianchi', importo: 60, label: 'Papà' },
    ]
    const esito = applicaIntestatarioScelto(ripartito, null, 150)
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.quote).toEqual(ripartito)
  })
})

describe('zIntestatarioScelto — l’unione discriminata rende l’ibrido IRRAPPRESENTABILE', () => {
  it('il ramo `adult` accetta l’id e nient’altro', () => {
    const r = zIntestatarioScelto.safeParse({ tipo: 'adult', adult_id: 'parent-bianchi' })
    expect(r.success).toBe(true)
  })

  it('il ramo `persona` accetta l’anagrafica completa', () => {
    expect(zIntestatarioScelto.safeParse(persona).success).toBe(true)
  })

  it('IBRIDO `adult_id` + campi anagrafici → RIFIUTATO, non ripulito in silenzio', () => {
    // Non basta che i campi vengano scartati: uno `z.object` non-strict li toglie
    // e risponde 200, ed è esattamente il difetto del trasferimento di sede del
    // 2026-09-04 (`patchBodySchema` scartava `scuola_id` e rispondeva «fatto»).
    // Qui il costo sarebbe una fattura intestata a un genitore vero con un codice
    // fiscale scritto dal browser: si rifiuta, e si dice.
    const r = zIntestatarioScelto.safeParse({
      tipo: 'adult',
      adult_id: 'parent-bianchi',
      codice_fiscale: CF_FABBRI,
      nome: 'Giulia',
      cognome: 'Fabbri',
    })
    expect(r.success).toBe(false)
  })

  it('`tipo: \'ente\'` → rifiutato (fuori scope per decisione del titolare)', () => {
    expect(
      zIntestatarioScelto.safeParse({ tipo: 'ente', denominazione: 'Comune di Cesa', id_fiscale_iva: '03394870616' })
        .success,
    ).toBe(false)
  })

  it('`Denominazione` e `IdFiscaleIVA` non entrano nemmeno dal ramo `persona`', () => {
    expect(zIntestatarioScelto.safeParse({ ...persona, denominazione: 'Comune di Cesa' }).success).toBe(false)
    expect(zIntestatarioScelto.safeParse({ ...persona, id_fiscale_iva: '03394870616' }).success).toBe(false)
  })

  it('i massimi vengono da `LIMITI`, non riscritti a mano: un nome più lungo si RIFIUTA', () => {
    // Troncare è il comportamento del generatore XML; qui si rifiuta, perché un
    // troncamento silenzioso su un documento fiscale si corregge solo con una nota
    // di variazione. Due copie dello stesso numero divergono: questo test cade se
    // qualcuno riscrive il 60 a mano e poi `LIMITI` cambia.
    const lungo = 'A'.repeat(LIMITI.nome + 1)
    expect(zIntestatarioScelto.safeParse({ ...persona, nome: lungo }).success).toBe(false)
    expect(zIntestatarioScelto.safeParse({ ...persona, nome: 'A'.repeat(LIMITI.nome) }).success).toBe(true)
    expect(
      zIntestatarioScelto.safeParse({ ...persona, numero_civico: 'A'.repeat(LIMITI.numeroCivico + 1) }).success,
    ).toBe(false)
  })

  it('un CAP di quattro cifre PASSA da zod: a dirlo è `validaCessionario`, che nomina il campo', () => {
    // Se lo rifiutasse qui, l'operatore leggerebbe un 400 di forma invece di
    // «CAP (formato): nessun numero è stato consumato».
    expect(zIntestatarioScelto.safeParse({ ...persona, cap: '8103' }).success).toBe(true)
  })
})

describe('anagraficaDaIntestatarioAltro — un `altro` incompleto NON diventa un ripiego', () => {
  it('`dati` completo → l’anagrafica, campo per campo', () => {
    expect(
      anagraficaDaIntestatarioAltro({
        nome: 'Carlo',
        cognome: 'Perlini',
        cf: 'PRLCRL80A01H501Z',
        indirizzo: 'Via delle Prove',
        cap: '81030',
        comune: 'Cesa',
        provincia: 'CE',
        civico: '9',
      }),
    ).toEqual({
      codice_fiscale: 'PRLCRL80A01H501Z',
      nome: 'Carlo',
      cognome: 'Perlini',
      indirizzo: 'Via delle Prove',
      cap: '81030',
      comune: 'Cesa',
      provincia: 'CE',
      numero_civico: '9',
    })
  })

  it('⛔ `dati` VUOTO → anagrafica vuota, MAI un nome inventato o ripescato altrove', () => {
    // L'unica riga in produzione con `tipo: 'altro'` ha `dati = {}`. Un ripiego
    // qui — sul cognome della famiglia, sul primo genitore — intesterebbe una
    // fattura vera a qualcuno che nessuno ha scelto, e nessuno lo saprebbe.
    const a = anagraficaDaIntestatarioAltro({})
    expect(a).toEqual({
      codice_fiscale: '',
      nome: '',
      cognome: '',
      indirizzo: '',
      cap: '',
      comune: '',
      provincia: '',
      numero_civico: '',
    })
  })

  it('`dati` assente o non un oggetto → stessa anagrafica vuota, nessuna eccezione', () => {
    expect(anagraficaDaIntestatarioAltro(undefined).nome).toBe('')
    expect(anagraficaDaIntestatarioAltro(null).cognome).toBe('')
    expect(anagraficaDaIntestatarioAltro('Della Valle Ottavio').codice_fiscale).toBe('')
  })

  it('la `email` del contratto resta FUORI: non è nel tracciato del cessionario', () => {
    const a = anagraficaDaIntestatarioAltro({ nome: 'Carlo', cognome: 'Perlini', email: 'x@example.invalid' })
    expect(Object.keys(a)).not.toContain('email')
  })
})

describe('anagraficaDaScheda — dice `null` quando la scheda punta a un genitore in archivio', () => {
  it('`tipo: \'adult\'` → null: quell’anagrafica si rilegge da `parents`, non si copia', () => {
    expect(anagraficaDaScheda({ tipo: 'adult', adult_id: 'parent-bianchi' })).toBeNull()
  })

  it('scheda vuota, `null`, o senza `tipo` → null (le righe più vecchie)', () => {
    expect(anagraficaDaScheda(null)).toBeNull()
    expect(anagraficaDaScheda(undefined)).toBeNull()
    expect(anagraficaDaScheda({ adult_id: 'parent-bianchi' })).toBeNull()
  })

  it('`tipo: \'altro\'` → l’anagrafica digitata', () => {
    const a = anagraficaDaScheda({ tipo: 'altro', dati: { nome: 'Carlo', cognome: 'Perlini' } })
    expect(nomeDaAnagrafica(a)).toBe('Carlo Perlini')
  })

  it('`nomeDaAnagrafica` di niente è la stringa vuota, non «undefined undefined»', () => {
    expect(nomeDaAnagrafica(null)).toBe('')
    expect(nomeDaAnagrafica({})).toBe('')
  })
})

describe('anagraficaDaPersonaScelta — il payload del client È la fonte, e si copia intero', () => {
  it('provincia e civico facoltativi assenti → stringa vuota, non `undefined` sparso', () => {
    const a = anagraficaDaPersonaScelta({
      tipo: 'persona',
      codice_fiscale: CF_FABBRI,
      nome: 'Giulia',
      cognome: 'Fabbri',
      indirizzo: 'Via delle Prove',
      cap: '81030',
      comune: 'Cesa',
    })
    expect(a.provincia).toBe('')
    expect(a.numero_civico).toBe('')
    expect(a.cognome).toBe('Fabbri')
  })
})
