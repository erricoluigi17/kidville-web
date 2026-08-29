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
 * all'11/08/2026 mostrava due fatti soli.
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

  it('curriculum caricato ma non allegabile: il messaggio dice il GUASTO, non un’omissione', () => {
    /*
     * ⚠️ IL RAMO «non ne ha caricato uno» SI RAGGIUNGE ANCHE QUANDO IL FILE C'È.
     *
     * `copia-alla-sede.ts` lascia `allegati` a `undefined` sia quando il
     * curriculum non c'è, sia quando lo scaricamento dallo Storage FALLISCE (o
     * risponde `{ data: null, error: null }`) — e l'email parte lo stesso, che è
     * la scelta giusta. Ma il testo che ne usciva accusava una persona di
     * un'omissione mentre il fatto vero era un guasto tecnico.
     *
     * Dal 2026-08-24 il curriculum è OBBLIGATORIO: ogni volta che quella frase
     * comparirà su una candidatura nuova sarà FALSA per costruzione — senza
     * curriculum non ci sarebbe la candidatura. E la segreteria, letta la frase,
     * scarterebbe la persona per una cosa che ha fatto.
     *
     * È la classe di difetto che questo repo ha già pagato con le email: un
     * messaggio che afferma una cosa e ne nasconde un'altra, con i test verdi.
     */
    const m = messaggioCandidaturaAllaSede(
      {
        dati: DATI,
        consensi: { presa_visione_informativa: true },
        sediScelte: ['Kidville Cesa'],
        inviataIl: '24/08/2026, 10:30',
        conCurriculum: false,
        curriculumNonAllegabile: true,
      },
      SEDE,
    )
    expect(m.testo).toContain('non siamo riusciti ad allegarlo')
    // ⚠️ Il controllo che conta: la sede NON deve leggere che la persona non
    // l'ha caricato. Senza questa riga il test resterebbe verde anche
    // AGGIUNGENDO la frase nuova accanto alla vecchia.
    expect(m.testo, 'la sede legge un’accusa sopra un guasto dello Storage').not.toContain('non ne ha caricato uno')
    // E la strada dell'allegato vero non è stata toccata.
    expect(m.html).toContain('non siamo riusciti ad allegarlo')
  })

  it('i due rami STORICI del «nessun curriculum» restano, e restano distinti', () => {
    // ⚠️ NON SI CANCELLANO «PERCHÉ ORMAI IL CV C'È SEMPRE». Servono a due
    // popolazioni diverse di righe già in tabella (quattro su dieci — àncora `MISURA-CV`):
    //  · prima del 2026-08-15 il modulo non permetteva di caricare niente;
    //  · fra il 15 e il 24 agosto il campo c'era ed era facoltativo — e per
    //    quelle candidature «non ne ha caricato uno» è l'unica frase corretta.
    const nonPrevisto = messaggioCandidaturaAllaSede(
      { dati: DATI, consensi: {}, sediScelte: ['Kidville Cesa'], inviataIl: '10/08/2026, 10:30',
        conCurriculum: false, curriculumNonPrevisto: true },
      SEDE,
    )
    expect(nonPrevisto.testo).toContain('prima che il modulo permettesse')

    const nonCaricato = messaggioCandidaturaAllaSede(
      { dati: DATI, consensi: {}, sediScelte: ['Kidville Cesa'], inviataIl: '20/08/2026, 10:30',
        conCurriculum: false },
      SEDE,
    )
    expect(nonCaricato.testo).toContain('non ne ha caricato uno')
    expect(nonCaricato.testo, 'il ramo del guasto ha inghiottito quello dell’omissione').not.toContain('non siamo riusciti ad allegarlo')
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
    // ⚠️ QUI C'ERA `not.toContain('Disponibilità')`, e dal 2026-08-24 non poteva
    // più fallire in nessun caso: il campo è uscito dal template, quindi
    // `righeDellaCopia` non lo stampa nemmeno su una candidatura che lo avesse.
    // Una guardia che non può cadere non guarda niente, e questo test esiste per
    // provare l'OMISSIONE. Sostituita con un'etichetta di un campo che c'è
    // ancora e che nella fixture scarna non è compilato.
    expect(scarno.testo).not.toContain('Dettaglio del titolo')
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
