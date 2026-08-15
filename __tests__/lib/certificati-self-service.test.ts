import { describe, it, expect } from 'vitest'
import { buildCertificatoBody, buildIntestazioneSede, rigaLuogoData } from '@/lib/certificati/self-service'
import { normalizzaAnagraficaSede, zAnagraficaSede } from '@/lib/scuole/anagrafica'

const anna = { nome: 'Anna', cognome: 'Bianchi', classe_sezione: 'TEST 1A' }

describe('buildCertificatoBody', () => {
  it('frequenza: sezione reale, niente partitivo, niente Girasoli', () => {
    const txt = buildCertificatoBody('frequenza', anna, '2025/2026')
    expect(txt).toContain("l'alunno/a Bianchi Anna")
    expect(txt).toContain('nella sezione TEST 1A')
    expect(txt).not.toContain('Girasoli')
    expect(txt).toContain("per l'anno scolastico 2025/2026")
  })
  it('frequenza senza classe: clausola omessa', () => {
    const txt = buildCertificatoBody('frequenza', { nome: 'Anna', cognome: 'Bianchi' }, '2025/2026')
    expect(txt).not.toContain('nella sezione')
    expect(txt).toContain("di questa scuola per l'anno scolastico 2025/2026")
  })
  it('classe vuota/spazi = assente', () => {
    expect(buildCertificatoBody('frequenza', { ...anna, classe_sezione: '  ' }, '2025/2026'))
      .not.toContain('nella sezione')
  })
  it('iscrizione: anno dinamico', () => {
    const txt = buildCertificatoBody('iscrizione', anna, '2025/2026')
    expect(txt).toContain('regolarmente iscritto/a')
    expect(txt).toContain("per l'anno scolastico 2025/2026.")
  })
})

describe('buildIntestazioneSede (multi-sede)', () => {
  it('sede completa → 3 righe con dati reali', () => {
    const righe = buildIntestazioneSede({
      scuola_nome: 'Kidville Giugliano', scuola_indirizzo: 'Via Roma 1', scuola_cap: '80014',
      scuola_citta: 'Giugliano', scuola_provincia: 'NA', scuola_codice_meccanografico: 'NA1E123456',
    })
    expect(righe).toHaveLength(3)
    expect(righe[0]).toBe('Kidville Giugliano')
    expect(righe[1]).toContain('Via Roma 1')
    expect(righe[1]).toContain('80014 Giugliano')
    expect(righe[1]).toContain('(NA)')
    expect(righe[2]).toBe('Cod. Mecc. NA1E123456')
  })
  it('due sedi diverse → intestazioni diverse (multi-sede)', () => {
    const a = buildIntestazioneSede({ scuola_nome: 'Sede A', scuola_citta: 'Giugliano' })
    const b = buildIntestazioneSede({ scuola_nome: 'Sede B', scuola_citta: 'Napoli' })
    expect(a[0]).toBe('Sede A')
    expect(b[0]).toBe('Sede B')
    expect(a).not.toEqual(b)
  })
  it('dati mancanti → righe omesse, mai inventate', () => {
    expect(buildIntestazioneSede({})).toEqual([])
    expect(buildIntestazioneSede({ scuola_nome: 'Solo Nome' })).toEqual(['Solo Nome'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'indirizzo stampato due volte — il difetto che è FINITO SU CARTA
//
// Il 15/08/2026 il titolare ha generato il primo certificato dall'app e la
// seconda riga della testata diceva:
//
//     Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA) — Giugliano
//
// Non è un'ipotesi: è la riga stampata sul PDF reale. La causa NON è in questa
// funzione — che compone `via — CAP CITTÀ (PROV)` correttamente — ma nel dato:
// `scuole.indirizzo` conteneva già CAP, città e provincia, e `scuole.citta`
// diceva «Giugliano» invece di «Giugliano in Campania». La funzione ci appendeva
// la città una seconda volta, che è esattamente il suo mestiere.
//
// La riparazione è ALLA FONTE (spec §2.2): `indirizzo` torna a essere la sola
// via. Nessuna logica di confronto stringhe qui dentro: sarebbe fragile — «Via
// Roma 1, Roma» e «Roma» non si riconoscono con una `includes()` senza falsi
// positivi — e soprattutto NASCONDEREBBE il dato sporco invece di toglierlo,
// lasciandolo intatto per il prossimo lettore (l'email lo legge davvero).
//
// Questi test tengono fermi i due capi del contratto: che cosa deve entrare
// (`scuola_indirizzo` = la sola via) e che cosa deve uscire (la riga esatta che
// va stampata sui certificati delle tre sedi vere).
// ─────────────────────────────────────────────────────────────────────────────
describe("buildIntestazioneSede — l'indirizzo non si stampa due volte", () => {
  it("non ripete città e provincia quando l'indirizzo è la sola via", () => {
    const righe = buildIntestazioneSede({
      scuola_nome: 'Kidville Giugliano',
      scuola_indirizzo: 'Via Prima Traversa Antica Giardini 5',
      scuola_cap: '80014',
      scuola_citta: 'Giugliano in Campania',
      scuola_provincia: 'NA',
      scuola_codice_meccanografico: 'NA1A079004 · NA1E094004',
    })
    expect(righe[1]).toBe('Via Prima Traversa Antica Giardini 5 — 80014 Giugliano in Campania (NA)')
    // il difetto stampato sul certificato reale del 15/08/2026:
    expect(righe[1]).not.toMatch(/\(NA\).*Giugliano/)
  })

  // I valori della spec §2.1, scritti in produzione dalla UI il 2026-08-16.
  // Questa tabella è la testata che esce DAVVERO sui certificati delle tre sedi:
  // se un giorno qualcuno rimette CAP e città dentro `indirizzo`, il carattere
  // in più si vede qui prima che su un documento firmato che va all'INPS.
  const TRE_SEDI = [
    {
      sede: 'Giugliano',
      input: {
        scuola_nome: 'Kidville Giugliano',
        scuola_indirizzo: 'Via Prima Traversa Antica Giardini 5',
        scuola_cap: '80014',
        scuola_citta: 'Giugliano in Campania',
        scuola_provincia: 'NA',
        scuola_codice_meccanografico: 'NA1A079004 · NA1E094004',
      },
      atteso: [
        'Kidville Giugliano',
        'Via Prima Traversa Antica Giardini 5 — 80014 Giugliano in Campania (NA)',
        'Cod. Mecc. NA1A079004 · NA1E094004',
      ],
    },
    {
      sede: 'Aversa',
      input: {
        scuola_nome: 'Kidville Aversa',
        scuola_indirizzo: "Via dell'Archeologia 54",
        scuola_cap: '81031',
        scuola_citta: 'Aversa',
        scuola_provincia: 'CE',
        scuola_codice_meccanografico: 'CE1A178007',
      },
      atteso: [
        'Kidville Aversa',
        "Via dell'Archeologia 54 — 81031 Aversa (CE)",
        'Cod. Mecc. CE1A178007',
      ],
    },
    {
      sede: 'Cesa',
      input: {
        scuola_nome: 'Kidville Cesa',
        scuola_indirizzo: 'Via Filippo Turati 2',
        scuola_cap: '81030',
        scuola_citta: 'Cesa',
        scuola_provincia: 'CE',
        scuola_codice_meccanografico: 'CE1AE75008 · CE1E05400Q',
      },
      atteso: [
        'Kidville Cesa',
        'Via Filippo Turati 2 — 81030 Cesa (CE)',
        'Cod. Mecc. CE1AE75008 · CE1E05400Q',
      ],
    },
  ] as const

  it.each(TRE_SEDI)('$sede: testata esatta, nessun pezzo ripetuto', ({ input, atteso }) => {
    const righe = buildIntestazioneSede(input)
    expect(righe).toEqual(atteso)
    // Nessun pezzo del luogo compare due volte nella riga dell'indirizzo.
    for (const pezzo of [input.scuola_cap, input.scuola_citta, input.scuola_provincia]) {
      expect(righe[1].split(pezzo).length - 1).toBe(1)
    }
  })

  // La diagnosi, tenuta ferma: la funzione è innocente, il dato era colpevole.
  // Se un giorno questo test diventa rosso vuol dire che qualcuno ha messo una
  // deduplicazione a valle — cioè ha curato il sintomo e lasciato in archivio il
  // campo sporco, che l'email continua a leggere per intero (`lib/email/contesto.ts`).
  it('col campo sporco che stava in produzione, la duplicazione ricompare: la colpa era del dato', () => {
    const righe = buildIntestazioneSede({
      scuola_nome: 'Kidville Giugliano',
      // Il valore che `scuole.indirizzo` conteneva DAVVERO fino al 2026-08-16.
      scuola_indirizzo: 'Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA)',
      scuola_citta: 'Giugliano',
    })
    expect(righe[1]).toBe(
      'Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA) — Giugliano'
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Una testata che si stampa dev'essere anche SALVABILE
//
// I test qui sopra dimostrano che `buildIntestazioneSede` sa comporre la terza
// riga — «Cod. Mecc. NA1A079004 · NA1E094004». Non dimostrano che quel valore si
// possa mettere in archivio, e per due sedi su tre NON si poteva: misurato il
// 2026-08-16 compilando Impostazioni → Sede & Intestazione, `PATCH
// /api/admin/schools` rispondeva
//
//     400 {"error":"Dati non validi","details":[{"path":"anagrafica.codice_meccanografico",
//          "message":"Too big: expected string to have <=20 characters"}]}
//
// perché `zAnagraficaSede` fissava il campo a 20 caratteri. Il tetto era giusto
// per UN codice meccanografico (ne sono 10 esatti) e sbagliato per la decisione
// presa in intervista — «i due codici in un campo solo, separati da ` · `» — che
// ne fa 23. Giugliano e Cesa hanno due codici a testa: nido/infanzia e primaria.
//
// Il test vive accanto ai certificati e non accanto allo schema di proposito: il
// tetto non è un vincolo astratto sulla lunghezza di una stringa, è ciò che
// decide se la terza riga della testata esce stampata o sparisce. Un valore che
// il form rifiuta è una riga che il certificato non stampa, e la conseguenza si
// legge qui, non là.
// ─────────────────────────────────────────────────────────────────────────────
describe('il codice meccanografico della testata entra nello schema di sede', () => {
  // I valori veri delle tre sedi (spec §2.1). Giugliano e Cesa ne portano due.
  const CODICI = [
    { sede: 'Giugliano', codice: 'NA1A079004 · NA1E094004' },
    { sede: 'Aversa', codice: 'CE1A178007' },
    { sede: 'Cesa', codice: 'CE1AE75008 · CE1E05400Q' },
  ] as const

  it.each(CODICI)('$sede: il valore che la testata stampa è accettato in scrittura', ({ codice }) => {
    const esito = zAnagraficaSede.safeParse({ codice_meccanografico: codice })
    expect(esito.success).toBe(true)
    // E sopravvive alla normalizzazione, che è lista bianca e RICOSTRUISCE l'oggetto:
    // un campo che non passa di lì non è «ignorato», è cancellato al primo salvataggio.
    expect(normalizzaAnagraficaSede({ codice_meccanografico: codice }).codice_meccanografico).toBe(codice)
  })

  it('la stessa riga esce dalla testata del certificato', () => {
    for (const { codice } of CODICI) {
      expect(buildIntestazioneSede({ scuola_codice_meccanografico: codice })).toEqual([`Cod. Mecc. ${codice}`])
    }
  })

  // Il tetto resta un tetto: si è allargato per due codici, non tolto.
  it('resta un limite: una stringa lunghissima è ancora rifiutata', () => {
    expect(zAnagraficaSede.safeParse({ codice_meccanografico: 'A'.repeat(200) }).success).toBe(false)
  })
})

describe('rigaLuogoData', () => {
  it('con città dal DB', () => {
    expect(rigaLuogoData('Giugliano', '10/07/2026')).toBe('Giugliano, lì 10/07/2026')
  })
  it('degrado senza città', () => {
    expect(rigaLuogoData(null, '10/07/2026')).toBe('Lì 10/07/2026')
    expect(rigaLuogoData(undefined, '10/07/2026')).toBe('Lì 10/07/2026')
    expect(rigaLuogoData('  ', '10/07/2026')).toBe('Lì 10/07/2026')
  })
})
