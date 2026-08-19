import { describe, it, expect } from 'vitest'

import { messaggioCandidaturaAllaSede } from '@/lib/email/messaggi/candidatura-alla-sede'
import { contestoSenzaSede } from '@/lib/email/contesto'
import { INSEGNANTE_FIELDS, CONSENSI_INSEGNANTI_FIELDS } from '@/lib/forms/insegnanti-template'

/**
 * LA COPIA COMPLETA CHE ARRIVA ALLA CASELLA DEL PLESSO.
 *
 * ─── IL TEST CHE CONTA È IL TERZO ────────────────────────────────────────────
 * Non quelli sull'oggetto o sull'impaginazione: quello che itera
 * `INSEGNANTE_FIELDS` e pretende che OGNI campo compilato compaia nella copia.
 *
 * Il generatore costruisce il corpo iterando il template invece di elencare i
 * campi a mano, e questo test è ciò che rende quella scelta verificabile. Un
 * elenco scritto a mano diverge al primo campo aggiunto al modulo, e diverge IN
 * SILENZIO: la sede riceve una copia «completa» a cui manca esattamente il campo
 * nuovo, nessun test è rosso, e il difetto lo scopre una segreteria fra sei mesi
 * chiedendosi perché di quella candidata non sappia il titolo di studio.
 *
 * È lo stesso difetto di famiglia del riepilogo del wizard, che fino
 * all'11/08/2026 mostrava due fatti su tredici campi compilabili.
 */

const SEDE = { ...contestoSenzaSede('Kidville Giugliano'), email: 'giugliano@kidville.it' }

const DATI: Record<string, unknown> = {
  nome: 'Maria',
  cognome: 'Rossi',
  email: 'maria.rossi@email.com',
  telefono: '+39 333 1234567',
  residence_city: 'Giugliano in Campania',
  residence_province: 'NA',
  posizioni: ['insegnante_infanzia', 'cuoca'],
  titolo_studio: 'laurea_magistrale',
  titolo_dettaglio: 'Scienze della formazione',
  anni_esperienza: 3,
  disponibilita: 'tempo_pieno',
  note: 'Mi piacerebbe lavorare con voi.',
}

function messaggio(): ReturnType<typeof messaggioCandidaturaAllaSede> {
  return messaggioCandidaturaAllaSede(
    {
      dati: DATI,
      consensi: { presa_visione_informativa: true, consenso_conservazione_candidatura: false },
      sediScelte: ['Kidville Giugliano', 'Kidville Aversa'],
      inviataIl: '19/08/2026, 10:30',
      conCurriculum: true,
    },
    SEDE,
  )
}

describe('messaggioCandidaturaAllaSede', () => {
  it('l’oggetto nomina la persona e la sede: in quella casella arriva anche altro', () => {
    const m = messaggio()
    expect(m.oggetto).toContain('Rossi')
    expect(m.oggetto).toContain('Kidville Giugliano')
  })

  it('traduce i valori in codice nelle etichette leggibili del modulo', () => {
    const t = messaggio().testo
    // Chi legge deve trovare «Laurea magistrale», non `laurea_magistrale`: il
    // secondo è un valore di database, e in una casella di posta è rumore.
    expect(t).toContain('Laurea magistrale')
    expect(t).not.toContain('laurea_magistrale')
    expect(t).toContain('Tempo pieno')
    expect(t).not.toContain('tempo_pieno')
    expect(t).toContain('Cuoca / aiuto cucina')
    expect(t).not.toContain('insegnante_infanzia')
  })

  it('rende TUTTI i campi compilati, e li rende con l’etichetta del template', () => {
    const t = messaggio().testo
    for (const f of INSEGNANTE_FIELDS) {
      // Il curriculum si annuncia a parte: `cv_path` è un percorso, non un dato.
      if (f.id === 'cv_path') continue
      if (DATI[f.id] === undefined) continue
      expect(t, `manca il campo «${f.label}» (id: ${f.id})`).toContain(f.label)
    }
  })

  it('dice l’esito di OGNI consenso, anche di quello NON dato', () => {
    const t = messaggio().testo
    for (const c of CONSENSI_INSEGNANTI_FIELDS) {
      expect(t, `manca il consenso «${c.label}»`).toContain(c.label)
    }
    // «Non gliel'ho chiesto» e «ha detto no» non sono la stessa cosa, e la
    // differenza conta il giorno in cui si decide se ricontattare qualcuno.
    const rigaConservazione = t
      .split('\n')
      .find((r) => r.includes('Conservate la mia candidatura'))
    expect(rigaConservazione).toBeDefined()
    expect(rigaConservazione).toMatch(/\bNo\b/)
  })

  it('dice a QUALI sedi è stata inviata: chi valuta deve sapere che è in gioco anche altrove', () => {
    const t = messaggio().testo
    expect(t).toContain('Kidville Aversa')
    expect(t).toContain('Kidville Giugliano')
  })

  it('annuncia il curriculum come allegato, MAI il suo percorso nel bucket', () => {
    const t = messaggio().testo
    expect(t.toLowerCase()).toContain('curriculum')
    expect(t).not.toContain('candidature/')
  })

  it('senza curriculum lo DICE: «non allegato» e «non guardato» non sono la stessa cosa', () => {
    const senza = messaggioCandidaturaAllaSede(
      {
        dati: DATI,
        consensi: {},
        sediScelte: ['Kidville Giugliano'],
        inviataIl: '19/08/2026, 10:30',
        conCurriculum: false,
      },
      SEDE,
    )
    expect(senza.testo.toLowerCase()).toContain('nessun curriculum')
  })

  it('OMETTE i campi non compilati invece di stampare l’etichetta col vuoto accanto', () => {
    const scarno = messaggioCandidaturaAllaSede(
      {
        dati: { nome: 'Ada', cognome: 'Bianchi', email: 'ada@b.it', posizioni: ['cuoca'] },
        consensi: { presa_visione_informativa: true },
        sediScelte: ['Kidville Cesa'],
        inviataIl: '19/08/2026, 10:30',
        conCurriculum: false,
      },
      SEDE,
    )
    // È la regola dell'omissione già scritta in `lib/scuole/anagrafica.ts`: ciò
    // che manca si omette, non si stampa vuoto. Un'etichetta seguita dal nulla
    // non è un dato mancante, è una riga rotta.
    expect(scarno.testo).not.toContain('Anni di esperienza')
    expect(scarno.testo).not.toContain('Disponibilità')
  })

  it('l’HTML fa scappare i metacaratteri: un nome col « < » non apre un tag', () => {
    const cattivo = messaggioCandidaturaAllaSede(
      {
        dati: { ...DATI, nome: '<script>alert(1)</script>' },
        consensi: {},
        sediScelte: ['Kidville Giugliano'],
        inviataIl: '19/08/2026, 10:30',
        conCurriculum: false,
      },
      SEDE,
    )
    // I valori vengono da un modulo PUBBLICO: non sono mai fidati.
    expect(cattivo.html).not.toContain('<script>')
    expect(cattivo.html).toContain('&lt;script&gt;')
  })

  it('il corpo di testo è sostanzioso quanto gli altri generatori', () => {
    // La soglia che `dodici-generatori.test.ts` applica a tutti: sotto i 120
    // caratteri un'email non è un'email.
    expect(messaggio().testo.length).toBeGreaterThan(120)
    expect(messaggio().oggetto.length).toBeGreaterThan(5)
  })
})
