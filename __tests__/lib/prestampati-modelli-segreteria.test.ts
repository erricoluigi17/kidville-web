/**
 * I nove prestampati della segreteria e delle insegnanti
 * (`src/lib/prestampati/modelli/segreteria.ts`).
 *
 * Cosa si misura qui, e perché queste cose e non altre:
 *
 *  · **il nucleo comune non si chiede** — nessuno dei nove ha fra i propri campi nome,
 *    cognome, nascita, codice fiscale o sezione, e i documenti li stampano lo stesso:
 *    è la prova che arrivano dal prefill e non da un form che li richiede due volte;
 *  · **`zod` rifiuta l'incompleto** — non «accetta il completo», che è la metà facile:
 *    il nulla osta senza conferma di regolarità, il verbale col 118 e senza l'ora della
 *    chiamata, il certificato delle competenze con sette voci su otto;
 *  · **il degrado omette** — un dato che manca fa sparire la riga (o la colonna), e non
 *    produce «N.D.», né un trattino, né una riga vuota che sembri un valore;
 *  · **le date arrivano in DUE forme** — `YYYY-MM-DD` dalle colonne `date` e l'istante
 *    completo dalle `timestamptz` (`firmato_il` lo è in cinque tabelle del baseline), e i
 *    modelli devono leggerle tutte e due: qui le date di prova sono nell'una e nell'altra
 *    forma, perché con le sole date secche si misura metà dello spazio che le interfacce
 *    dichiarano di accettare — e l'altra metà, dove il documento AFFERMA che una firma non
 *    c'è, è quella che conta;
 *  · **i modelli con soggetto diverso lo dichiarano** — sezione e dipendente, perché il
 *    pannello si comporta di conseguenza;
 *  · **i testi che esistevano già sono quelli** — nulla osta, solleciti e competenze non
 *    sono stati riscritti: si confrontano con la loro fonte, e dove la fonte è in un
 *    altro file la si LEGGE (il contesto dei segnaposto dell'email si esegue, non si
 *    ricopia: ribatterlo a mano cristallizzerebbe la divergenza invece di scoprirla);
 *  · **ciò che è vuoto lo dice** — una sezione senza bambini, un certificato senza
 *    periodi, un elenco annunciato e assente.
 *
 * Nessun dato reale: nomi inventati, sedi inventate, uuid finti.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { BloccoPrestampato } from '@/lib/prestampati/tipi'
import { buildDocumentoRichiesta } from '@/lib/protocolli/documenti'
import { DEFAULT_LIVELLI } from '@/lib/pagamenti/solleciti'
import { COMPETENZE_CHIAVE, LIVELLI } from '@/lib/competenze/modello'
import { formatEuro } from '@/lib/format/valuta'
import { formattaIstante } from '@/i18n/config'
import {
  CAMPI_ESPERIENZA,
  MODELLI_SEGRETERIA,
  PERIODI_VALUTAZIONE,
  STAMPE_SEZIONE,
  STATI_PRESENZA,
  VOCI_AUTONOMIA,
  contestoSollecito,
  modelloCertificatoCompetenze,
  modelloCertificatoServizio,
  modelloNullaOsta,
  modelloRegistroPresenze,
  modelloRichiestaDisponibilita,
  modelloSollecito,
  modelloStampeSezione,
  modelloValutazioneInfanzia,
  modelloVerbaleInfortunio,
  type PrefillCertificatoCompetenze,
  type PrefillCertificatoServizio,
  type PrefillNullaOsta,
  type PrefillRegistroPresenze,
  type PrefillSollecito,
  type CampoModulo,
  type PrefillStampeSezione,
  type PrefillValutazioneInfanzia,
  type PrefillVerbaleInfortunio,
} from '@/lib/prestampati/modelli/segreteria'

// ─── Lettura dei blocchi ────────────────────────────────────────────────────────

/** Tutto il testo che finisce sul foglio, blocco per blocco, in ordine di stampa. */
function testi(blocchi: BloccoPrestampato[]): string[] {
  const righe: string[] = []
  for (const b of blocchi) {
    switch (b.tipo) {
      case 'paragrafo':
        righe.push(b.testo)
        break
      case 'sezione':
        righe.push(b.titolo)
        break
      case 'campi':
        for (const c of b.campi) righe.push(`${c.etichetta}: ${c.valore ?? ''}`)
        break
      case 'caselle':
        for (const c of b.caselle) righe.push(c.testo)
        break
      case 'elenco':
        righe.push(...b.voci)
        break
      case 'tabella':
        righe.push(...b.intestazioni)
        for (const r of b.righe) righe.push(...r)
        break
      case 'riquadro':
        righe.push(b.titolo)
        for (const c of b.campi) righe.push(`${c.etichetta}: ${c.valore ?? ''}`)
        break
      case 'spazio':
        break
    }
  }
  return righe
}

const testoIntero = (blocchi: BloccoPrestampato[]) => testi(blocchi).join('\n')

function campiDi(blocchi: BloccoPrestampato[]) {
  return blocchi.flatMap((b) => (b.tipo === 'campi' ? b.campi : []))
}

function etichetteCampi(blocchi: BloccoPrestampato[]) {
  return campiDi(blocchi).map((c) => c.etichetta)
}

function tabelle(blocchi: BloccoPrestampato[]) {
  return blocchi.flatMap((b) => (b.tipo === 'tabella' ? [b] : []))
}

function caselle(blocchi: BloccoPrestampato[]) {
  return blocchi.flatMap((b) => (b.tipo === 'caselle' ? b.caselle : []))
}

/**
 * Il titoletto di un gruppo di caselle: il blocco che sta IMMEDIATAMENTE PRIMA, se è una
 * sezione. `undefined` quando il gruppo esce nudo.
 *
 * Si misura sui blocchi e non sul testo appiattito perché «Altro» è l'ultima voce di tre
 * elenchi diversi del n. 42 e un `indexOf` sul testo troverebbe sempre il primo. Il gruppo
 * si riconosce dalla sua PRIMA voce, che è unica.
 */
function titolettoDelGruppo(blocchi: BloccoPrestampato[], primaVoce: string): string | undefined {
  const i = blocchi.findIndex((b) => b.tipo === 'caselle' && b.caselle[0]?.testo === primaVoce)
  if (i < 0) throw new Error(`Nessun gruppo di caselle che comincia con «${primaVoce}»`)
  const precedente = blocchi[i - 1]
  return precedente?.tipo === 'sezione' ? precedente.titolo : undefined
}

/** I gruppi di caselle appiccicati al successivo: il motore fra due non lascia niente. */
function gruppiAttaccati(blocchi: BloccoPrestampato[]): string[] {
  return blocchi
    .filter((b, i) => b.tipo === 'caselle' && blocchi[i + 1]?.tipo === 'caselle')
    .map((b) => (b.tipo === 'caselle' ? (b.caselle[0]?.testo ?? '(vuoto)') : ''))
}

/** Il primo blocco `paragrafo` che contiene una frase: serve a leggere un capoverso intero. */
function paragrafoCon(blocchi: BloccoPrestampato[], frammento: string): string | undefined {
  return blocchi.find(
    (b): b is Extract<BloccoPrestampato, { tipo: 'paragrafo' }> =>
      b.tipo === 'paragrafo' && b.testo.includes(frammento)
  )?.testo
}

/** Le chiavi dello schema `zod` di un modello (zod 4 conserva `.shape` dopo `superRefine`). */
function chiaviSchema(schema: unknown): string[] {
  return Object.keys((schema as { shape: Record<string, unknown> }).shape)
}

/** Lo stesso oggetto meno una chiave: serve a misurare che cosa `zod` PRETENDE. */
function senzaChiave<T extends object>(oggetto: T, chiave: keyof T): Partial<T> {
  const copia = { ...oggetto }
  delete copia[chiave]
  return copia
}

/**
 * Le due forme che una risposta di griglia può avere: il livello nudo, e il livello con
 * le osservazioni accanto (n. 45, campi di esperienza). Sono dichiarate qui e non dedotte
 * per tentativi — una griglia nuova senza la sua forma fa fallire il test con un
 * messaggio, invece di passare misurando niente.
 */
const FORMA_GRIGLIA: Record<string, (livello: string) => unknown> = {
  'valutazione_infanzia/esperienze': (livello) => ({ livello }),
  'valutazione_infanzia/autonomia': (livello) => livello,
  'certificato_competenze/livelli': (livello) => livello,
}

/** Il sotto-schema `zod` di un solo campo: si misura la griglia senza il resto delle risposte. */
function sottoSchema(schema: unknown, campoId: string) {
  const shape = (schema as { shape: Record<string, { safeParse(v: unknown): { success: boolean } }> })
    .shape
  return shape[campoId]
}

/** La griglia con TUTTE le righe a quel livello: `zod` l'accetta o no. */
function grigliaAccetta(
  modello: { slug: string; schema: unknown },
  campo: CampoModulo,
  livello: string
): boolean {
  const forma = FORMA_GRIGLIA[`${modello.slug}/${campo.id}`]
  if (!forma) throw new Error(`Griglia senza forma dichiarata nel test: ${modello.slug}/${campo.id}`)
  const risposta = Object.fromEntries((campo.opzioni ?? []).map((o) => [o.valore, forma(livello)]))
  return sottoSchema(modello.schema, campo.id).safeParse(risposta).success
}

// ─── Dati di prova, tutti inventati ─────────────────────────────────────────────

// Niente `legaleRappresentante` qui dentro: nessuno dei nove lo legge, perché il suo nome
// arriva dal blocco di firma del motore. Finché stava in `NucleoScuola` era un campo che una
// route avrebbe letto da `scuole.config.anagrafica` per buttarlo via.
const SCUOLA = {
  ragioneSociale: 'Cooperativa di prova',
  piva: '00000000000',
  sedeLegale: 'Via delle Prove 1 — 80000 Cittàfinta (XX)',
  codiciMeccanografici: 'XX0A000001, XX0A000002',
}

const SEDE = { nome: 'Sede di prova', telefono: '081 0000000', codiceMeccanografico: 'XX0A000001' }

const ALUNNO = {
  cognome: 'Verdi',
  nome: 'Anna',
  dataNascita: '2021-03-14',
  luogoNascita: 'Cittàfinta (XX)',
  codiceFiscale: 'AAAAAA00A00A000A',
  sezione: 'PROVA 1',
}

/** Lo stesso alunno con l'archivio a metà: serve a misurare il degrado, non l'errore. */
const ALUNNO_SPOGLIO = { cognome: 'Verdi', nome: 'Anna' }

/**
 * Nessun `scuola` qui dentro, e non è una dimenticanza: dei nove, i dati della cooperativa
 * li chiedono i soli due che li STAMPANO nel corpo (il 39 e il 47). Sugli altri sette
 * ragione sociale e legale rappresentante finiscono nell'intestazione e nel blocco firma,
 * che il motore riceve dalla route. A tenere la linea è `tsc`: quei sette prefill non hanno
 * affatto un campo `scuola`, e passarglielo non compila.
 */
const prefillNullaOsta: PrefillNullaOsta = {
  alunno: ALUNNO,
  annoScolastico: '2025/2026',
}

const risposteNullaOsta = {
  istituto: 'Comprensivo Statale di Prova',
  sede_istituto: 'Via Inventata 2, Cittàfinta',
  decorrenza: '2026-09-01',
  regolarita_confermata: true as const,
}

// ═══════════════════════════════════════════════════════════════════════════════
// Ciò che vale per tutti e nove
// ═══════════════════════════════════════════════════════════════════════════════

/** I nove modelli con il loro schema: `MODELLI_SEGRETERIA` è la sola vista di metadati. */
const MODELLI = [
  modelloNullaOsta,
  modelloRichiestaDisponibilita,
  modelloSollecito,
  modelloVerbaleInfortunio,
  modelloValutazioneInfanzia,
  modelloCertificatoCompetenze,
  modelloCertificatoServizio,
  modelloStampeSezione,
  modelloRegistroPresenze,
]

describe('registro dei nove modelli', () => {
  it('nove modelli, slug distinti, e il registro li elenca tutti', () => {
    const slug = MODELLI.map((m) => m.slug)
    expect(slug).toHaveLength(9)
    expect(new Set(slug).size).toBe(9)
    expect(MODELLI_SEGRETERIA.map((m) => m.slug).sort()).toEqual([...slug].sort())
  })

  it('nessun modello chiede un dato del nucleo comune', () => {
    // I nomi esatti delle chiavi che l'app ha già (README dei prestampati, tabella «Il
    // nucleo comune»). Confronto per id ESATTO: `sede_istituto` del nulla osta è
    // l'indirizzo della scuola di destinazione, non la sede di Kidville, e una regola a
    // sottostringa lo boccerebbe dicendo il falso.
    const gia = [
      'nome',
      'cognome',
      'data_nascita',
      'luogo_nascita',
      'codice_fiscale',
      'sezione',
      'classe_sezione',
      'anno_scolastico',
      'alunno',
      'genitore',
      'sede',
      'scuola',
      'allergie',
      'protocollo',
    ]
    for (const modello of MODELLI) {
      const chiesti = modello.campi.map((c) => c.id)
      expect(chiesti.filter((id) => gia.includes(id)), modello.slug).toEqual([])
    }
  })

  it('ogni campo del form ha la sua voce nello schema, e viceversa', () => {
    for (const modello of MODELLI) {
      expect(modello.campi.map((c) => c.id).sort(), modello.slug).toEqual(
        chiaviSchema(modello.schema).sort()
      )
    }
  })

  it('un elenco chiuso porta con sé le proprie opzioni; quelli aperti sono dichiarati', () => {
    // Le uniche scelte senza elenco cablato sono quelle che si popolano dall'archivio:
    // il personale in servizio (n. 42) e i periodi di servizio del dipendente (n. 47).
    const dallArchivio = ['soccorritore', 'altro_personale', 'periodi_inclusi']
    for (const modello of MODELLI) {
      for (const campo of modello.campi) {
        if (!['scelta', 'sceltaMultipla', 'griglia'].includes(campo.tipo)) continue
        if (dallArchivio.includes(campo.id)) {
          expect(campo.opzioni, `${modello.slug}/${campo.id}`).toBeUndefined()
          continue
        }
        expect(campo.opzioni?.length, `${modello.slug}/${campo.id}`).toBeGreaterThan(0)
      }
    }
  })

  it('una griglia non è una scelta multipla: le righe hanno un valore ciascuna', () => {
    // Le otto competenze del D.M. non sono otto caselle da spuntare, e un pannello che
    // leggesse `sceltaMultipla` le disegnerebbe così.
    const griglie = MODELLI.flatMap((m) =>
      m.campi.filter((c) => c.tipo === 'griglia').map((c) => `${m.slug}/${c.id}`)
    )
    expect(griglie.sort()).toEqual([
      'certificato_competenze/livelli',
      'valutazione_infanzia/autonomia',
      'valutazione_infanzia/esperienze',
    ])
  })

  it('una griglia dichiara anche i valori delle righe, e sono quelli che lo schema accetta', () => {
    // Il descrittore deve BASTARE a costruire il campo: righe in `opzioni`, livelli in
    // `valoriAmmessi`. Senza, un pannello dovrebbe cablare la scala campo per campo — e
    // la misura qui non è che l'elenco esista, ma che coincida con ciò che `zod` accetta:
    // due elenchi che divergono sono un form che propone un valore poi rifiutato.
    for (const modello of MODELLI) {
      for (const campo of modello.campi.filter((c) => c.tipo === 'griglia')) {
        const ammessi = campo.valoriAmmessi ?? []
        expect(ammessi.length, `${modello.slug}/${campo.id}`).toBeGreaterThan(0)
        for (const valore of ammessi) {
          expect(
            grigliaAccetta(modello, campo, valore.valore),
            `${modello.slug}/${campo.id} → ${valore.valore}`
          ).toBe(true)
        }
        expect(
          grigliaAccetta(modello, campo, 'livello-che-non-esiste'),
          `${modello.slug}/${campo.id}`
        ).toBe(false)
      }
    }
  })

  it('la firma di ciascuno è quella della tabella del README', () => {
    // `docs/prestampati/README.md`, colonna «Firma», riga per riga. Il 39 ha «—», e
    // §3.b di `00-impaginazione.md` elenca chi porta il blocco del legale rappresentante
    // (26·27, 28, 30, 31, 47): il sollecito non c'è, e il suo corpo si chiude già da sé
    // con `{scuola}` — con la firma del motore il foglio si chiuderebbe due volte.
    // Il 46 in quell'elenco non compare perché §3.b enumera i prestampati cartacei, ma
    // la sua riga del README dice «legale rappr.» ed è un certificato che esce verso un
    // ente: vale la colonna, che è la fonte più specifica.
    // Il 42 e il 50 sono le due deviazioni dichiarate: la colonna dice «direzione», che
    // fra i tre tipi del motore non esiste — la controfirma è una riga del corpo, e il
    // blocco di firma attesta ciò che la specifica del 42 chiede davvero (la presa
    // visione della famiglia con OTP) o niente (50, registro interno).
    const atteso: Record<string, string> = {
      nulla_osta: 'legaleRappresentante',
      richiesta_disponibilita: 'legaleRappresentante',
      certificato_competenze: 'legaleRappresentante',
      certificato_servizio: 'legaleRappresentante',
      sollecito_pagamento: 'nessuna',
      stampe_sezione: 'nessuna',
      registro_presenze: 'nessuna',
      verbale_infortunio: 'genitore',
      valutazione_infanzia: 'genitore',
    }
    for (const modello of MODELLI) expect(modello.firma, modello.slug).toBe(atteso[modello.slug])
  })

  it('i soggetti diversi da «alunno» sono dichiarati', () => {
    expect(modelloCertificatoServizio.soggetto).toBe('dipendente')
    expect(modelloStampeSezione.soggetto).toBe('sezione')
    expect(modelloRegistroPresenze.soggetto).toBe('sezione')
    const suAlunno = MODELLI.filter((m) => m.soggetto === 'alunno').map((m) => m.slug)
    expect(suAlunno.sort()).toEqual(
      [
        'nulla_osta',
        'richiesta_disponibilita',
        'sollecito_pagamento',
        'verbale_infortunio',
        'valutazione_infanzia',
        'certificato_competenze',
      ].sort()
    )
  })

  it('ciò che esce dalla scuola porta protocollo E firma del legale rappresentante', () => {
    const inUscita = MODELLI.filter((m) => m.protocollo === 'uscita')
    expect(inUscita.map((m) => m.slug).sort()).toEqual(
      ['certificato_competenze', 'certificato_servizio', 'nulla_osta', 'richiesta_disponibilita'].sort()
    )
    for (const modello of inUscita) {
      expect(modello.firma, modello.slug).toBe('legaleRappresentante')
    }
  })

  it('le stampe di servizio non si firmano e non si archiviano', () => {
    expect(modelloStampeSezione.firma).toBe('nessuna')
    expect(modelloStampeSezione.archiviazione).toBe('nessuna')
    expect(modelloStampeSezione.protocollo).toBe('nessuno')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 30 — nulla osta
// ═══════════════════════════════════════════════════════════════════════════════

describe('30 — nulla osta al trasferimento', () => {
  it('riusa il titolo e il testo già in produzione', () => {
    const atteso = buildDocumentoRichiesta('nulla_osta', { nome: 'Anna', cognome: 'Verdi' }, '2025/2026')
    expect(modelloNullaOsta.titolo(prefillNullaOsta, risposteNullaOsta)).toBe(atteso.titolo)
    const testo = testoIntero(modelloNullaOsta.componi(prefillNullaOsta, risposteNullaOsta))
    expect(testo).toContain('si concede il nulla osta al trasferimento')
    expect(testo).toContain('per gli usi consentiti dalla legge')
  })

  it('aggiunge i quattro elementi che al testo in app mancano', () => {
    const blocchi = modelloNullaOsta.componi(prefillNullaOsta, risposteNullaOsta)
    const testo = testoIntero(blocchi)
    expect(testo).toContain('AAAAAA00A00A000A')
    expect(testo).toContain('Cittàfinta (XX)')
    expect(testo).toContain('14/03/2021')
    expect(testo).toContain('Comprensivo Statale di Prova')
    expect(testo).toContain('Via Inventata 2, Cittàfinta')
    expect(testo).toContain('a decorrere dal 01/09/2026')
    expect(testo).toContain('la posizione amministrativa dell\'alunno/a risulta regolare a tutti gli effetti')
  })

  it('col nome dell\'istituto sparisce «presso altro istituto»: una destinazione, una frase', () => {
    // Il testo in produzione chiude alla cieca — non sa dove va il bambino. Riusarlo e
    // aggiungere sotto la destinazione dava un atto che si contraddice: «presso altro
    // istituto», e due righe dopo quale, su un foglio che legge un'altra scuola.
    const blocchi = modelloNullaOsta.componi(prefillNullaOsta, risposteNullaOsta)
    const testo = testoIntero(blocchi)
    expect(testo).not.toContain('presso altro istituto')
    expect(testo.match(/Comprensivo Statale di Prova/g)).toHaveLength(1)

    // E la destinazione sta DENTRO la frase del rilascio, non in un capoverso a parte.
    const rilascio = paragrafoCon(blocchi, 'si concede il nulla osta al trasferimento')
    expect(rilascio).toContain(
      "presso l'Istituto Comprensivo Statale di Prova, con sede in Via Inventata 2, Cittàfinta, a decorrere dal 01/09/2026."
    )
  })

  it('la coda generica del testo in produzione è ancora quella che il modello toglie', () => {
    // Lock sull'accoppiamento: se `buildDocumentoRichiesta` cambiasse quella chiusura, il
    // taglio non aggancerebbe più e la destinazione tornerebbe a essere un capoverso a sé
    // (il ripiego). Nessuno se ne accorgerebbe leggendo il PDF, quindi lo si misura qui.
    const primoCapoverso = buildDocumentoRichiesta(
      'nulla_osta',
      { nome: 'Anna', cognome: 'Verdi' },
      '2025/2026'
    ).corpo.split(/\n{2,}/)[0]
    expect(primoCapoverso.endsWith(', presso altro istituto.')).toBe(true)
  })

  it('la dichiarazione di regolarità sta DOPO il rilascio e PRIMA della chiusura', () => {
    const righe = testi(modelloNullaOsta.componi(prefillNullaOsta, risposteNullaOsta))
    const rilascio = righe.findIndex((r) => r.includes('si concede il nulla osta'))
    const regolarita = righe.findIndex((r) => r.includes('posizione amministrativa'))
    const chiusura = righe.findIndex((r) => r.includes('usi consentiti dalla legge'))
    expect(rilascio).toBeGreaterThanOrEqual(0)
    expect(regolarita).toBeGreaterThan(rilascio)
    expect(chiusura).toBeGreaterThan(regolarita)
  })

  it('senza conferma della regolarità non si genera', () => {
    expect(modelloNullaOsta.schema.safeParse({ ...risposteNullaOsta, regolarita_confermata: false }).success)
      .toBe(false)
    expect(modelloNullaOsta.schema.safeParse(senzaChiave(risposteNullaOsta, 'regolarita_confermata')).success)
      .toBe(false)
  })

  it('rifiuta l\'istituto vuoto e una data che non esiste', () => {
    expect(modelloNullaOsta.schema.safeParse({ ...risposteNullaOsta, istituto: '   ' }).success).toBe(false)
    expect(modelloNullaOsta.schema.safeParse({ ...risposteNullaOsta, decorrenza: '2026-02-30' }).success)
      .toBe(false)
  })

  it('la nascita è una riga sola: con la sola data non resta un «il» senza antecedente', () => {
    // `campiSeValorizzati` compatta, e con «Nato/a a» e «il» come campi distinti un bambino
    // di cui l'archivio ha la data ma non il luogo — combinazione tutt'altro che rara qui —
    // usciva con una riga «il: 14/03/2021» senza niente prima, per giunta ripaginata
    // nell'altra colonna. È lo stesso difetto che il n. 47 evita in prosa.
    const completo = campiDi(modelloNullaOsta.componi(prefillNullaOsta, risposteNullaOsta))
    expect(completo.find((c) => c.etichetta === 'Nato/a a')?.valore).toBe(
      'Cittàfinta (XX) il 14/03/2021'
    )
    expect(completo.map((c) => c.etichetta)).not.toContain('il')

    const soloData = campiDi(
      modelloNullaOsta.componi(
        { ...prefillNullaOsta, alunno: { ...ALUNNO_SPOGLIO, dataNascita: '2021-03-14' } },
        risposteNullaOsta
      )
    )
    expect(soloData.map((c) => c.etichetta)).not.toContain('il')
    expect(soloData.find((c) => c.etichetta === 'Nato/a il')?.valore).toBe('14/03/2021')

    // E col solo luogo la data non si inventa: resta la preposizione che regge il luogo.
    const soloLuogo = campiDi(
      modelloNullaOsta.componi(
        { ...prefillNullaOsta, alunno: { ...ALUNNO_SPOGLIO, luogoNascita: 'Cittàfinta (XX)' } },
        risposteNullaOsta
      )
    )
    expect(soloLuogo.find((c) => c.etichetta === 'Nato/a a')?.valore).toBe('Cittàfinta (XX)')
  })

  it('una decorrenza che non è una data non stampa la parola «null» sull\'atto', () => {
    // `componi` è pubblica e non ha cancelli: TypeScript in `decorrenza` vede una `string`
    // qualunque, e `dataIt` su ciò che data non è torna `null` — che dentro un template
    // literal DIVENTA la parola «null». «a decorrere dal null», su un nulla osta firmato dal
    // legale rappresentante e protocollato in uscita. Meglio la frase senza la coda: il
    // documento resta incompleto invece di dichiarare una decorrenza che nessuno ha scritto.
    const blocchi = modelloNullaOsta.componi(prefillNullaOsta, {
      ...risposteNullaOsta,
      decorrenza: 'quando ci trasferiamo',
    })
    const testo = testoIntero(blocchi)
    // Parola intera: «nulla osta» contiene «null» e un `toContain` nudo qui sarebbe rosso
    // sempre, cioè non misurerebbe niente.
    expect(testo).not.toMatch(/\bnull\b/)
    expect(testo).not.toContain('a decorrere dal')
    // La destinazione, che è il resto della frase, non si perde con la data.
    expect(paragrafoCon(blocchi, 'si concede il nulla osta al trasferimento')).toContain(
      "presso l'Istituto Comprensivo Statale di Prova, con sede in Via Inventata 2, Cittàfinta."
    )
  })

  it('degrado: i dati che l\'archivio non ha spariscono, non diventano «N.D.»', () => {
    const blocchi = modelloNullaOsta.componi(
      { ...prefillNullaOsta, alunno: ALUNNO_SPOGLIO },
      risposteNullaOsta
    )
    const etichette = etichetteCampi(blocchi)
    expect(etichette).toContain('Cognome e nome')
    expect(etichette).not.toContain('Codice fiscale')
    expect(etichette).not.toContain('Nato/a a')
    expect(etichette).not.toContain('Nato/a il')
    expect(testoIntero(blocchi)).not.toMatch(/N\.D\.|non disponibile/i)
    // Nessun campo senza valore: sarebbe il filetto da riempire a penna, su un atto firmato.
    expect(campiDi(blocchi).every((c) => (c.valore ?? '').trim().length > 0)).toBe(true)
    // E la clausola della sezione, che il testo riusato costruisce, sparisce con lei.
    expect(testoIntero(blocchi)).not.toContain('nella sezione')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 31 — richiesta di disponibilità
// ═══════════════════════════════════════════════════════════════════════════════

describe('31 — richiesta di disponibilità a istituto terzo', () => {
  const prefill = { alunno: ALUNNO, annoScolastico: '2025/2026' }
  const risposte = {
    istituto: 'Comprensivo Statale di Prova',
    indirizzo_istituto: 'Via Inventata 2',
    decorrenza: '2026-09-01',
  }
  const lettera = (extra: Record<string, unknown> = {}) =>
    modelloRichiestaDisponibilita.componi(
      prefill,
      modelloRichiestaDisponibilita.schema.parse({ ...risposte, ...extra })
    )
  const tagliando = () =>
    modelloRichiestaDisponibilita.blocchiDopoFirma?.(
      prefill,
      modelloRichiestaDisponibilita.schema.parse(risposte)
    ) ?? []

  it('è una lettera da scuola a scuola, col tagliando di risposta', () => {
    expect(testoIntero(lettera())).toContain('Oggetto: Richiesta di disponibilità ad accogliere')
    const coda = tagliando()
    expect(testoIntero(coda)).toContain('Tagliando di risposta')
    const voci = caselle(coda).map((c) => c.testo)
    expect(voci.some((v) => v.startsWith('Si conferma la disponibilità'))).toBe(true)
    expect(voci).toContain('Non si conferma la disponibilità')
    // Il tagliando nomina l'alunno/a: chi lo rispedisce lo stacca dal resto della lettera.
    expect(testoIntero(coda)).toContain('Verdi Anna')
  })

  it('la linea di taglio sta SOTTO la firma, non sopra: chi ritaglia non si porta via la firma', () => {
    // Il motore disegna il blocco di firma dopo tutti i blocchi di `componi`, sempre
    // (`impaginazione.ts`, `disegnaFirma`). Finché il tagliando stava lì dentro, sul foglio
    // usciva: lettera → linea di taglio → tagliando → IL LEGALE RAPPRESENTANTE. All'istituto
    // che ritagliava il tagliando per rispedirlo restava in mano la metà NON firmata di una
    // lettera fra scuole. Da qui il tagliando vive in `blocchiDopoFirma`, e `componi` non lo
    // contiene più: una route che non sa renderlo stampa una lettera firmata e senza
    // tagliando — incompleta, non sbagliata.
    const corpo = testoIntero(lettera())
    expect(corpo).not.toContain('Tagliando di risposta')
    expect(corpo).not.toContain('— — —')
    expect(caselle(lettera())).toHaveLength(0)

    // E nella coda la linea di taglio c'è davvero, e precede il tagliando: senza il primo
    // controllo un tagliando SENZA linea passerebbe (`findIndex` → -1, che è minore di tutto).
    const righe = testi(tagliando())
    const taglio = righe.findIndex((r) => r.includes('— — —'))
    expect(taglio).toBeGreaterThanOrEqual(0)
    expect(taglio).toBeLessThan(righe.indexOf('Tagliando di risposta — da restituire a Kidville'))
  })

  it('la linea di taglio dice a parole ciò che le forbici non possono dire', () => {
    // La specifica disegna la riga come «✂ - - - - -», ma il motore stampa con l'Helvetica
    // di serie di jsPDF (WinAnsi) e `✂` (U+2702) lì non esiste: generando il PDF e
    // rileggendolo con PDF.js, dove il sorgente dice `✂` il testo estratto dice `'`. Un
    // apostrofo davanti ai trattini non dice a chi riceve la lettera che quella riga si
    // taglia; la didascalia sì. Il giorno in cui il motore incorporerà un font Unicode, il
    // glifo torna e questo test va riscritto — non tolto.
    const linea = testi(tagliando()).find((r) => r.includes('— — —'))
    expect(linea).toBeDefined()
    expect(linea).toContain('Tagliare lungo la linea')
    expect(linea).not.toContain('✂')
  })

  it('il tagliando lascia i filetti da compilare a penna — e sono gli UNICI del foglio', () => {
    const senzaValore = (blocchi: BloccoPrestampato[]) =>
      campiDi(blocchi)
        .filter((c) => !(c.valore ?? '').trim())
        .map((c) => c.etichetta)
    // Sulla lettera firmata nessun filetto: sarebbe un buco da riempire a penna su un atto
    // che esce dalla scuola col protocollo.
    expect(senzaValore(lettera())).toEqual([])
    expect(senzaValore(tagliando())).toEqual(['Note', 'Istituto', 'Data', 'Timbro e firma'])
  })

  it('email facoltativa: se non c\'è, la riga non compare; se è malformata, si rifiuta', () => {
    expect(etichetteCampi(lettera())).not.toContain('Email/PEC')
    expect(modelloRichiestaDisponibilita.schema.safeParse({ ...risposte, email_istituto: 'non-una-email' }).success)
      .toBe(false)
    expect(testoIntero(lettera({ email_istituto: 'protocollo@istituto.test' }))).toContain(
      'protocollo@istituto.test'
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 39 — solleciti
// ═══════════════════════════════════════════════════════════════════════════════

describe('39 — sollecito di pagamento', () => {
  const prefill: PrefillSollecito = {
    alunno: ALUNNO,
    scuola: SCUOLA,
    denominazione: 'La Segreteria di prova',
    pagamento: {
      descrizione: 'Retta di ottobre',
      scadenza: '2026-10-05',
      importo: 250,
      residuo: 120.5,
      giorniRitardo: 12,
    },
  }

  it('riusa i testi di DEFAULT_LIVELLI invece di riscriverli', () => {
    const testo = testoIntero(modelloSollecito.componi(prefill, { livello: 2 }))
    // Frase caratteristica del secondo livello, presa dalla fonte e non ricopiata qui.
    const attesa = DEFAULT_LIVELLI[1].testo.split('\n\n')[1].split('{')[0].trim()
    expect(testo).toContain(attesa)
    expect(modelloSollecito.titolo(prefill, { livello: 2 })).toBe(
      'SOLLECITO DI PAGAMENTO — RETTA DI OTTOBRE'
    )
  })

  it('il contesto dei segnaposto è quello dell\'email, eseguito e non ricopiato', () => {
    // ─── PERCHÉ IL SORGENTE SI ESEGUE ───────────────────────────────────────────
    // Il contesto vive in due file (qui e in `solleciti-invio.ts`) e alla nascita
    // divergeva già: la lettera diceva «Verdi Anna», l'email «Anna Verdi». Ribattere qui
    // i valori attesi a mano avrebbe cristallizzato la divergenza invece di scoprirla.
    // Quindi l'oggetto `ctx` dell'invio si legge dal sorgente, si VALUTA con gli stessi
    // ingressi e si confronta: se là qualcuno tocca un campo, questo test diventa rosso.
    const sorgente = readFileSync(join(process.cwd(), 'src/lib/pagamenti/solleciti-invio.ts'), 'utf8')
    const inizio = sorgente.indexOf('const ctx = {')
    expect(inizio, 'il contesto dell\'email non è più dove il lock lo cerca').toBeGreaterThan(0)
    // Conteggio delle graffe: nessuna stringa dell'oggetto ne contiene, e un `indexOf('}')`
    // si fermerebbe alla prima annidata il giorno in cui ne comparisse una.
    let profondita = 0
    let fine = inizio
    for (let i = sorgente.indexOf('{', inizio); i < sorgente.length; i++) {
      if (sorgente[i] === '{') profondita++
      if (sorgente[i] === '}') profondita--
      if (profondita === 0) {
        fine = i + 1
        break
      }
    }
    const letterale = sorgente.slice(sorgente.indexOf('{', inizio), fine)

    const pag = {
      alunni: { nome: ALUNNO.nome, cognome: ALUNNO.cognome },
      descrizione: prefill.pagamento.descrizione,
      importo: prefill.pagamento.importo,
      scadenza: prefill.pagamento.scadenza,
    }
    const costruisci = new Function(
      'pag',
      'residuo',
      'giorniRitardo',
      'scuolaNome',
      'formatEuro',
      'formattaIstante',
      `return ${letterale}`
    ) as (...a: unknown[]) => Record<string, unknown>
    const contestoEmail = costruisci(
      pag,
      prefill.pagamento.residuo,
      prefill.pagamento.giorniRitardo,
      prefill.denominazione,
      formatEuro,
      formattaIstante
    )

    expect(contestoSollecito(prefill)).toEqual(contestoEmail)
    // La prova che il confronto qui sopra non sta mettendo a paragone due oggetti vuoti:
    // i sette segnaposto ci sono tutti, e quello che divergeva si misura per nome.
    expect(Object.keys(contestoEmail).sort()).toEqual([
      'alunno',
      'descrizione',
      'giorni_ritardo',
      'importo',
      'residuo',
      'scadenza',
      'scuola',
    ])
    expect(contestoEmail.alunno).toBe('Anna Verdi')
  })

  it('risolve tutti i segnaposto: nella lettera non resta una graffa', () => {
    for (let livello = 1; livello <= DEFAULT_LIVELLI.length; livello++) {
      const testo = testoIntero(modelloSollecito.componi(prefill, { livello }))
      expect(testo, `livello ${livello}`).not.toMatch(/\{[a-z_]+\}/)
      // Nome e poi cognome, come nell'email: sul foglio la famiglia legge le stesse parole.
      expect(testo).toContain('Gentile famiglia di Anna Verdi,')
      expect(testo).not.toContain('Verdi Anna')
      expect(testo).toContain('€ 120,50')
    }
  })

  it('è una lettera, non un modulo: nessun riquadro di dati sopra il testo', () => {
    // I quattro dati del riquadro (alunno, voce, scadenza, residuo) il testo li dice già
    // in prosa: ripeterli sopra era anche il modo di stampare la stessa data in due
    // formati diversi.
    const blocchi = modelloSollecito.componi(prefill, { livello: 1 })
    expect(campiDi(blocchi)).toEqual([])
    expect(blocchi.every((b) => b.tipo === 'paragrafo')).toBe(true)
  })

  it('senza descrizione il titolo non resta col trattino appeso', () => {
    const senzaVoce: PrefillSollecito = {
      ...prefill,
      pagamento: { ...prefill.pagamento, descrizione: null },
    }
    expect(modelloSollecito.titolo(senzaVoce, { livello: 1 })).toBe('PROMEMORIA PAGAMENTO')
    // Il corpo invece resta quello dell'email, trattino compreso: è la stessa frase che
    // la famiglia ha già letto, e allinearla solo qui vorrebbe dire divergere di nuovo.
    expect(testoIntero(modelloSollecito.componi(senzaVoce, { livello: 1 }))).toContain('"—"')
  })

  it('la configurazione di sede vince sui testi predefiniti, `{importo}` compreso', () => {
    const testo = testoIntero(
      modelloSollecito.componi(
        {
          ...prefill,
          config: { livelli: [{ oggetto: 'Avviso — {descrizione}', testo: 'Totale {importo}, residuo {residuo}.' }] },
        },
        { livello: 1 }
      )
    )
    expect(testo).toContain('Totale € 250,00, residuo € 120,50.')
  })

  it('i livelli sono tre: zero e quattro non esistono', () => {
    expect(modelloSollecito.schema.safeParse({ livello: 0 }).success).toBe(false)
    expect(modelloSollecito.schema.safeParse({ livello: DEFAULT_LIVELLI.length + 1 }).success).toBe(false)
    expect(modelloSollecito.schema.safeParse({ livello: '2' }).data?.livello).toBe(2)
  })

  it('la riga di causale col codice fiscale c\'è solo se il chiamante la passa', () => {
    expect(testoIntero(modelloSollecito.componi(prefill, { livello: 1 }))).not.toContain('Causale')
    const conCausale = testoIntero(
      modelloSollecito.componi({ ...prefill, rigaCausale: 'Causale: RETTA OTT — AAAAAA00A00A000A' }, { livello: 1 })
    )
    expect(conCausale).toContain('Causale: RETTA OTT — AAAAAA00A00A000A')
  })

  it('senza denominazione la lettera resta firmata: prima la ragione sociale, poi «La Segreteria»', () => {
    const conRagioneSociale = testi(
      modelloSollecito.componi({ ...prefill, denominazione: null }, { livello: 1 })
    )
    expect(conRagioneSociale.at(-1)).toBe('Cooperativa di prova')

    // Ultimo gradino: quello dell'email, che una lettera senza mittente non si manda.
    const spoglio = testi(
      modelloSollecito.componi(
        { ...prefill, denominazione: null, scuola: { ...SCUOLA, ragioneSociale: null } },
        { livello: 1 }
      )
    )
    expect(spoglio.at(-1)).toBe('La Segreteria')
    expect(spoglio.every((riga) => riga.trim().length > 0)).toBe(true)
  })

  it('una scadenza che porta dentro anche l\'ora resta una data, non diventa un trattino', () => {
    // È il punto in cui la trappola delle due forme ISO era già stata vista e riparata (con
    // `formattaIstante`): il lock serve perché qualcuno, «uniformando», potrebbe rimetterci
    // `isoToIt` — e la lettera stampata direbbe «—» dove la mail dice una data.
    const testo = testoIntero(
      modelloSollecito.componi(
        { ...prefill, pagamento: { ...prefill.pagamento, scadenza: '2026-10-05T22:30:00+00:00' } },
        { livello: 1 }
      )
    )
    expect(testo).toContain('con scadenza 06/10/2026')
    expect(testo).not.toContain('scadenza —')
  })

  it('non porta la firma del motore: il corpo si chiude già da sé', () => {
    // README, colonna «Firma»: «—». Con `legaleRappresentante` il foglio si chiuderebbe
    // due volte — `{scuola}` in fondo al testo e sotto il blocco del D.Lgs 39/93, su una
    // lettera che non esce verso nessun ente.
    expect(modelloSollecito.firma).toBe('nessuna')
    expect(modelloSollecito.protocollo).toBe('nessuno')
    // Il registro di questo documento è la tabella `solleciti`, non il fascicolo.
    expect(modelloSollecito.archiviazione).toBe('nessuna')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 42 — verbale di infortunio
// ═══════════════════════════════════════════════════════════════════════════════

describe('42 — verbale di infortunio', () => {
  const prefill: PrefillVerbaleInfortunio = {
    alunno: ALUNNO,
    sede: SEDE,
    annoScolastico: '2025/2026',
    numeroVerbale: '7',
    dataVerbale: '2026-10-12',
    operatore: { nomeCompleto: 'Educatrice Finta', firmatoIl: '2026-10-12' },
    direzione: { nome: 'Direzione Finta' },
    genitore: { nomeCompleto: 'Genitore Finto', telefono: '333 0000000' },
    personale: [
      { id: '00000000-0000-4000-8000-000000000001', nomeCompleto: 'Collega Finta' },
      {
        id: '00000000-0000-4000-8000-000000000002',
        nomeCompleto: 'Soccorritrice Finta',
        abilitatoPrimoSoccorso: true,
      },
    ],
  }

  const risposteBase = {
    data: '2026-10-12',
    ora: '10:24',
    luogo: 'giardino',
    attivita: 'Gioco libero',
    dinamica: 'Caduta durante una corsa.',
    parte_corpo: 'testa',
    tipo_lesione: 'contusione',
    descrizione_lesione: 'Arrossamento sulla fronte, nessuna perdita di coscienza.',
    primo_soccorso: ['ghiaccio'],
    provvedimenti: ['rientro'],
    ora_avviso: '10:40',
    modalita_avviso: 'telefono',
  }

  it('118 o pronto soccorso senza l\'ora della chiamata: rifiutato', () => {
    expect(
      modelloVerbaleInfortunio.schema.safeParse({ ...risposteBase, provvedimenti: ['centodiciotto'] }).success
    ).toBe(false)
    expect(
      modelloVerbaleInfortunio.schema.safeParse({
        ...risposteBase,
        provvedimenti: ['pronto_soccorso'],
        ora_118: '10:30',
      }).success
    ).toBe(true)
    // Senza urgenza l'ora non serve, e il verbale resta valido.
    expect(modelloVerbaleInfortunio.schema.safeParse(risposteBase).success).toBe(true)
  })

  it('un\'ora scritta male non passa', () => {
    expect(modelloVerbaleInfortunio.schema.safeParse({ ...risposteBase, ora: '25:00' }).success).toBe(false)
    expect(modelloVerbaleInfortunio.schema.safeParse({ ...risposteBase, ora: '7' }).success).toBe(false)
  })

  it('le caselle con la freccia pretendono il testo che segue la freccia', () => {
    // «☐ Fuori dalla struttura → [LUOGO]», «☐ Altro → [PARTE_CORPO]»: senza il testo
    // accanto uscirebbe un verbale che dice «Altro» tre volte e non documenta niente —
    // e a leggerlo sono la famiglia e l'assicurazione.
    const conFreccia: [Record<string, unknown>, string][] = [
      [{ luogo: 'fuori' }, 'luogo_altro'],
      [{ parte_corpo: 'altro' }, 'parte_corpo_altro'],
      [{ tipo_lesione: 'altro' }, 'tipo_lesione_altro'],
      [{ primo_soccorso: ['altro'] }, 'primo_soccorso_altro'],
    ]
    for (const [scelta, campo] of conFreccia) {
      const senza = modelloVerbaleInfortunio.schema.safeParse({ ...risposteBase, ...scelta })
      expect(senza.success, campo).toBe(false)
      // Il rifiuto arriva sul campo giusto: è ciò che il form evidenzia.
      expect(senza.error?.issues.map((i) => i.path.join('.')), campo).toContain(campo)

      const con = modelloVerbaleInfortunio.schema.safeParse({
        ...risposteBase,
        ...scelta,
        [campo]: 'Testo di prova',
      })
      expect(con.success, campo).toBe(true)
    }
  })

  it('il testo libero non serve quando la casella non è quella — e sul foglio non lascia una riga', () => {
    // La regola è condizionale, non un obbligo in più: col luogo «Giardino» e la parte del
    // corpo «Testa/viso» il verbale è valido senza nessun «Quale, se altro» (già misurato
    // sopra). Qui si misura l'altra metà, che è quella che si vede: quei campi non devono
    // nemmeno COMPARIRE fra le righe del foglio composto. Una riga «Quale:» col filetto,
    // sotto le caselle di un verbale di infortunio già consegnato alla famiglia, è lo spazio
    // in cui chiunque può scrivere a penna una lesione che nessuno ha rilevato.
    const blocchi = modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    )
    const etichette = etichetteCampi(blocchi)
    expect(etichette).not.toContain('Quale')
    expect(etichette).not.toContain('Dove')
    // E nessun campo del foglio resta senza valore: sarebbe il filetto da riempire a penna.
    expect(campiDi(blocchi).every((c) => (c.valore ?? '').trim().length > 0)).toBe(true)
  })

  it('«Nessuno necessario» non convive con un soccorso prestato', () => {
    expect(
      modelloVerbaleInfortunio.schema.safeParse({
        ...risposteBase,
        primo_soccorso: ['nessuno', 'ghiaccio'],
      }).success
    ).toBe(false)
    expect(
      modelloVerbaleInfortunio.schema.safeParse({ ...risposteBase, primo_soccorso: ['nessuno'] }).success
    ).toBe(true)
  })

  it('il testo della casella «altro» finisce davvero sul foglio', () => {
    const blocchi = modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse({
        ...risposteBase,
        luogo: 'fuori',
        luogo_altro: 'Cortile del plesso vicino',
        parte_corpo: 'altro',
        parte_corpo_altro: 'Ginocchio destro',
        tipo_lesione: 'altro',
        tipo_lesione_altro: 'Graffio profondo',
        primo_soccorso: ['altro'],
        primo_soccorso_altro: 'Lavaggio con acqua corrente',
      })
    )
    const testo = testoIntero(blocchi)
    for (const atteso of [
      'Cortile del plesso vicino',
      'Ginocchio destro',
      'Graffio profondo',
      'Lavaggio con acqua corrente',
    ]) {
      expect(testo).toContain(atteso)
    }
  })

  it('il nome di un altro bambino non ha dove entrare, e non entra', () => {
    const risposte = modelloVerbaleInfortunio.schema.parse({
      ...risposteBase,
      altri_bambini_coinvolti: true,
      altri_bambini_nomi: 'Bianchi Marco',
    })
    expect(Object.keys(risposte)).not.toContain('altri_bambini_nomi')
    const testo = testoIntero(modelloVerbaleInfortunio.componi(prefill, risposte))
    expect(testo).not.toContain('Bianchi Marco')
    expect(testo).toContain('Altri bambini coinvolti')
    expect(testo).toContain('non compaiono in questo verbale')
  })

  it('le note sanitarie stanno in TESTA, prima di come e dove', () => {
    const blocchi = modelloVerbaleInfortunio.componi(
      { ...prefill, noteSanitarie: 'Allergia nota — vedi scheda sanitaria' },
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    )
    const riquadro = blocchi.findIndex((b) => b.tipo === 'riquadro')
    const quandoEDove = blocchi.findIndex((b) => b.tipo === 'sezione' && b.titolo === 'Quando e dove')
    expect(riquadro).toBeGreaterThanOrEqual(0)
    expect(riquadro).toBeLessThan(quandoEDove)
    // Senza scheda sanitaria non compare un riquadro che dica «nessuna allergia».
    const senza = modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    )
    expect(senza.some((b) => b.tipo === 'riquadro')).toBe(false)
  })

  it('spunta il luogo scelto e solo quello', () => {
    const blocchi = modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    )
    const luoghi = caselle(blocchi).filter((c) => ['Giardino', 'Aula/sezione', 'Palestra'].includes(c.testo))
    expect(luoghi.find((c) => c.testo === 'Giardino')?.spuntata).toBe(true)
    expect(luoghi.filter((c) => c.spuntata)).toHaveLength(1)
  })

  it('un id di personale che non risulta in servizio non diventa un nome', () => {
    const blocchi = modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse({
        ...risposteBase,
        soccorritore: '00000000-0000-4000-8000-000000000009',
        altro_personale: ['00000000-0000-4000-8000-000000000001'],
      })
    )
    expect(etichetteCampi(blocchi)).not.toContain('Prestato da')
    expect(testoIntero(blocchi)).toContain('Collega Finta')
    expect(testoIntero(blocchi)).not.toContain('00000000-0000-4000-8000-000000000009')
  })

  it('l\'abilitazione al primo soccorso è di chi ha soccorso, non di chi scrive', () => {
    const abilitata = modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse({
        ...risposteBase,
        soccorritore: '00000000-0000-4000-8000-000000000002',
      })
    )
    expect(testoIntero(abilitata)).toContain('Prestato da: Soccorritrice Finta')
    expect(testoIntero(abilitata)).toContain('risulta addetto al primo soccorso')

    // Stessa educatrice che redige, ma chi ha medicato è una collega che addetta NON
    // risulta: l'abilitazione non si eredita da chi tiene la penna.
    const nonAbilitata = modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse({
        ...risposteBase,
        soccorritore: '00000000-0000-4000-8000-000000000001',
      })
    )
    expect(testoIntero(nonAbilitata)).toContain('Prestato da: Collega Finta')
    expect(testoIntero(nonAbilitata)).not.toContain('primo soccorso.')
  })

  it('la controfirma della Direzione non si dichiara finché non c\'è', () => {
    const blocchi = modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    )
    const direzione = campiDi(blocchi).find((c) => c.etichetta === 'La Direzione')
    expect(direzione?.valore).toBe('Direzione Finta')
    const operatore = campiDi(blocchi).find((c) => c.etichetta === "L'operatore che ha redatto")
    expect(operatore?.valore).toBe('Educatrice Finta — firmato il 12/10/2026')
  })

  it('firme che arrivano come ISTANTE: un verbale firmato non si stampa come non firmato', () => {
    // È la forma con cui PostgREST restituisce una colonna `timestamp with time zone` —
    // `firmato_il` lo è in cinque tabelle del baseline — quindi non è un caso di scuola: è
    // il modo normale in cui quelle date arrivano. Con la sola `isoToIt`, ancorata a
    // `YYYY-MM-DD`, tornavano stringa vuota e il verbale usciva senza «— firmato il …»:
    // che su questo foglio non è un buco, dichiara che nessuno l'ha firmato.
    const blocchi = modelloVerbaleInfortunio.componi(
      {
        ...prefill,
        dataVerbale: '2026-10-12T09:24:31.123456+00:00',
        operatore: { nomeCompleto: 'Educatrice Finta', firmatoIl: '2026-10-12T09:24:31.123456+00:00' },
        direzione: { nome: 'Direzione Finta', controfirmatoIl: '2026-10-13T18:05:00+02:00' },
      },
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    )
    const campi = campiDi(blocchi)
    expect(campi.find((c) => c.etichetta === 'del')?.valore).toBe('12/10/2026')
    expect(campi.find((c) => c.etichetta === "L'operatore che ha redatto")?.valore).toBe(
      'Educatrice Finta — firmato il 12/10/2026'
    )
    expect(campi.find((c) => c.etichetta === 'La Direzione')?.valore).toBe(
      'Direzione Finta — controfirmato il 13/10/2026'
    )
  })

  it('l\'istante si legge nel fuso italiano, non a Greenwich', () => {
    // Una firma apposta alle 23:30 UTC del 12 è del 13 in Italia: l'istante si riduce alla
    // data CIVILE (`Europe/Rome`), non tagliando i primi dieci caratteri della stringa.
    const blocchi = modelloVerbaleInfortunio.componi(
      {
        ...prefill,
        operatore: { nomeCompleto: 'Educatrice Finta', firmatoIl: '2026-10-12T23:30:00+00:00' },
      },
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    )
    expect(campiDi(blocchi).find((c) => c.etichetta === "L'operatore che ha redatto")?.valore).toBe(
      'Educatrice Finta — firmato il 13/10/2026'
    )
  })

  it('la descrizione della lesione è un campo suo, non il seguito delle caselle', () => {
    // Senza titoletto il capoverso si legge come la coda delle caselle del tipo di lesione:
    // la specifica etichetta la riga («Descrizione: …»), e la dinamica ha già la sua.
    const righe = testi(modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    ))
    const titolo = righe.indexOf('Descrizione della lesione')
    expect(titolo).toBeGreaterThan(righe.indexOf('Contusione'))
    expect(righe[titolo + 1]).toBe(risposteBase.descrizione_lesione)
  })

  it('ogni gruppo di caselle porta il proprio titoletto, e ce l\'ha subito sopra', () => {
    // `disegnaCaselle` parte sempre da `MARGINE_SX` e avanza di un passo per riga, senza
    // spazio né titolo fra un blocco e il successivo: due `caselleDa` di fila escono come
    // quattro righe di quadratini indistinguibili — sette voci di parte del corpo e otto di
    // tipo di lesione, tutte e due che finiscono con «Altro» — e chi legge il verbale non sa
    // dove finisce l'una e comincia l'altra. La specifica le etichetta una per una («Luogo:
    // ☐ Aula/sezione …», «Parte del corpo: ☐ Testa/viso …», «Tipo: ☐ Contusione …»).
    const blocchi = modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    )
    expect(titolettoDelGruppo(blocchi, 'Aula/sezione')).toBe('Luogo')
    expect(titolettoDelGruppo(blocchi, 'Testa/viso')).toBe('Parte del corpo')
    expect(titolettoDelGruppo(blocchi, 'Contusione')).toBe('Tipo di lesione')
    expect(titolettoDelGruppo(blocchi, 'Disinfezione')).toBe('Primo soccorso prestato')
    expect(titolettoDelGruppo(blocchi, 'Rientro in sezione')).toBe('Provvedimenti')

    // L'unica eccezione, e si nomina da sé: le due caselle degli altri bambini sono frasi
    // intere, e un titoletto sopra sarebbe la stessa frase due volte.
    expect(titolettoDelGruppo(blocchi, 'Nessun altro bambino coinvolto')).toBeUndefined()

    // E nessun gruppo resta appiccicato al successivo, nemmeno quando i campi «Quale» che
    // stanno in mezzo spariscono tutti perché la scelta non è «Altro» — che è il caso
    // NORMALE, e quello in cui il difetto si vedeva.
    expect(gruppiAttaccati(blocchi)).toEqual([])
  })

  it('«Lesione rilevata» ha lasciato il posto ai due titoletti veri, non a una sezione vuota', () => {
    // Il motore ha un solo livello di titolo: tenere l'ombrello e aggiungere sotto i due
    // nomi avrebbe stampato «LESIONE RILEVATA» col suo filetto e, dieci millimetri più giù
    // senza una riga in mezzo, «PARTE DEL CORPO» — una sezione visibilmente vuota.
    const blocchi = modelloVerbaleInfortunio.componi(
      prefill,
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    )
    expect(testoIntero(blocchi)).not.toContain('Lesione rilevata')
    const titoli = blocchi.flatMap((b) => (b.tipo === 'sezione' ? [b.titolo] : []))
    expect(titoli).toContain('Parte del corpo')
    expect(titoli).toContain('Tipo di lesione')
    // Nessuna sezione seguita da un'altra sezione: sarebbe un titolo senza contenuto.
    expect(blocchi.filter((b, i) => b.tipo === 'sezione' && blocchi[i + 1]?.tipo === 'sezione')).toEqual([])
  })

  it('senza il nome della Direzione la riga sparisce: su questo foglio non c\'è un filetto da riempire', () => {
    // È la scelta OPPOSTA a quella del n. 50 («le firme non ancora apposte restano righe da
    // firmare»), e la differenza sta nel destinatario: il registro presenze resta in sede e
    // si stampa apposta per essere firmato a penna, questo PDF esce e va alla famiglia (app
    // ed email). Un filetto vuoto accanto a «La Direzione» su un verbale di infortunio di un
    // minore già uscito dalla scuola è lo spazio in cui chiunque può scrivere a penna. Che la
    // controfirma manchi lo dice il cruscotto della Direzione («un verbale non controfirmato
    // resta in evidenza»), non una riga bianca su una copia.
    const senzaDirezione = modelloVerbaleInfortunio.componi(
      { ...prefill, direzione: undefined },
      modelloVerbaleInfortunio.schema.parse(risposteBase)
    )
    expect(etichetteCampi(senzaDirezione)).not.toContain('La Direzione')
    // E su tutto il verbale non resta una sola riga-campo senza valore.
    expect(campiDi(senzaDirezione).filter((c) => !(c.valore ?? '').trim())).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 45 — documento di valutazione, infanzia
// ═══════════════════════════════════════════════════════════════════════════════

describe('45 — documento di valutazione dell\'infanzia', () => {
  const prefill: PrefillValutazioneInfanzia = {
    alunno: ALUNNO,
    annoScolastico: '2025/2026',
    annoFrequenza: 2,
    insegnanti: ['Insegnante Finta', 'Insegnante Inventata'],
    coordinatrice: 'Coordinatrice Finta',
  }

  const esperienze = {
    se_e_altro: { livello: 'consolidato', osservazioni: 'Gioca volentieri con i compagni.' },
    corpo_movimento: { livello: 'in_consolidamento' },
    immagini_suoni_colori: { livello: 'in_acquisizione' },
    discorsi_parole: { livello: 'consolidato' },
    conoscenza_mondo: { livello: 'in_consolidamento' },
  }
  const autonomia = {
    autonomia_personale: 'consolidato',
    relazione_pari: 'consolidato',
    relazione_adulto: 'in_consolidamento',
    partecipazione: 'consolidato',
    rispetto_regole: 'in_consolidamento',
  }
  const risposte = {
    periodo: 'primo',
    esperienze,
    autonomia,
    osservazione_globale: 'Percorso sereno, con progressi nella relazione con i pari.',
  }

  it('vuole tutti e cinque i campi di esperienza e tutte e cinque le voci di autonomia', () => {
    expect(modelloValutazioneInfanzia.schema.safeParse(risposte).success).toBe(true)
    expect(
      modelloValutazioneInfanzia.schema.safeParse({
        ...risposte,
        esperienze: senzaChiave(esperienze, 'conoscenza_mondo'),
      }).success
    ).toBe(false)
    expect(
      modelloValutazioneInfanzia.schema.safeParse({
        ...risposte,
        autonomia: senzaChiave(autonomia, 'rispetto_regole'),
      }).success
    ).toBe(false)
  })

  it('tre livelli, non quattro: la scala della primaria non è ammessa', () => {
    expect(
      modelloValutazioneInfanzia.schema.safeParse({
        ...risposte,
        esperienze: { ...esperienze, se_e_altro: { livello: 'base' } },
      }).success
    ).toBe(false)
  })

  it('l\'osservazione complessiva è obbligatoria: è il documento', () => {
    expect(modelloValutazioneInfanzia.schema.safeParse({ ...risposte, osservazione_globale: '  ' }).success)
      .toBe(false)
  })

  it('la tabella segue l\'ordine canonico dei campi di esperienza', () => {
    const blocchi = modelloValutazioneInfanzia.componi(
      prefill,
      modelloValutazioneInfanzia.schema.parse(risposte)
    )
    const tabella = tabelle(blocchi)[0]
    expect(tabella.righe.map((r) => r[0])).toEqual([
      "Il sé e l'altro",
      'Il corpo e il movimento',
      'Immagini, suoni, colori',
      'I discorsi e le parole',
      'La conoscenza del mondo',
    ])
    expect(tabella.righe[0][1]).toBe('Consolidato')
    expect(tabella.righe[1][2]).toBe('') // osservazioni non scritte: cella vuota, non «—»
  })

  it('senza proposte la sezione non compare affatto', () => {
    const blocchi = modelloValutazioneInfanzia.componi(
      prefill,
      modelloValutazioneInfanzia.schema.parse(risposte)
    )
    expect(testoIntero(blocchi)).not.toContain('Proposte per il periodo successivo')
    const conProposte = modelloValutazioneInfanzia.componi(
      prefill,
      modelloValutazioneInfanzia.schema.parse({ ...risposte, proposte: 'Proseguire il lavoro sui gruppi.' })
    )
    expect(testoIntero(conProposte)).toContain('Proposte per il periodo successivo')
  })

  it('anno di frequenza e periodo sono due gruppi distinti, e ognuno porta il suo nome', () => {
    // Stessa misura del n. 42: fra due `caselleDa` il motore non mette niente, e la
    // specifica etichetta tutti e due i gruppi («Anno di frequenza: ☐ 1° …», «Periodo:
    // ☐ Primo periodo …»). Senza titoletti, sotto i dati anagrafici uscivano due righe di
    // quadratini di fila e «1° anno (3 anni)» e «Primo periodo» sembravano lo stesso elenco.
    const blocchi = modelloValutazioneInfanzia.componi(
      prefill,
      modelloValutazioneInfanzia.schema.parse(risposte)
    )
    expect(titolettoDelGruppo(blocchi, '1° anno (3 anni)')).toBe('Anno di frequenza')
    expect(titolettoDelGruppo(blocchi, 'Primo periodo')).toBe('Periodo')
    expect(gruppiAttaccati(blocchi)).toEqual([])

    // Le insegnanti stanno SOPRA i due gruppi: sotto sarebbero finite dentro il titoletto
    // «PERIODO», che non le riguarda.
    const righe = testi(blocchi)
    expect(righe.indexOf('Insegnanti di sezione: Insegnante Finta, Insegnante Inventata')).toBeLessThan(
      righe.indexOf('Anno di frequenza')
    )
  })

  it('spunta l\'anno di frequenza che l\'anagrafica conosce, senza chiederlo', () => {
    const blocchi = modelloValutazioneInfanzia.componi(
      prefill,
      modelloValutazioneInfanzia.schema.parse(risposte)
    )
    const anni = caselle(blocchi).filter((c) => c.testo.includes('anno ('))
    expect(anni.find((c) => c.spuntata)?.testo).toBe('2° anno (4 anni)')
    const senzaAnno = modelloValutazioneInfanzia.componi(
      { ...prefill, annoFrequenza: null },
      modelloValutazioneInfanzia.schema.parse(risposte)
    )
    expect(caselle(senzaAnno).filter((c) => c.testo.includes('anno (') && c.spuntata)).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 46 — certificato delle competenze
// ═══════════════════════════════════════════════════════════════════════════════

describe('46 — certificato delle competenze', () => {
  const prefill: PrefillCertificatoCompetenze = {
    alunno: ALUNNO,
    sede: SEDE,
    annoScolastico: '2025/2026',
    classe: 'PROVA 5',
  }
  const livelli = Object.fromEntries(COMPETENZE_CHIAVE.map((c, i) => [c.codice, 'ABCD'[i % 4]]))

  it('le otto competenze sono quelle del D.M., prese dal modello che esiste già', () => {
    const blocchi = modelloCertificatoCompetenze.componi(
      prefill,
      modelloCertificatoCompetenze.schema.parse({ livelli })
    )
    const tabella = tabelle(blocchi)[0]
    expect(tabella.righe.map((r) => r[0])).toEqual(COMPETENZE_CHIAVE.map((c) => c.etichetta))
    expect(tabella.righe[0][2]).toBe(LIVELLI[0].etichetta)
  })

  it('una competenza senza livello ferma il certificato, invece di stampare un trattino', () => {
    const sette = senzaChiave(livelli, COMPETENZE_CHIAVE[0].codice)
    expect(modelloCertificatoCompetenze.schema.safeParse({ livelli: sette }).success).toBe(false)
    expect(
      modelloCertificatoCompetenze.schema.safeParse({
        livelli: { ...livelli, [COMPETENZE_CHIAVE[0].codice]: 'E' },
      }).success
    ).toBe(false)
  })

  it('la legenda porta i quattro livelli con i loro descrittori', () => {
    const blocchi = modelloCertificatoCompetenze.componi(
      prefill,
      modelloCertificatoCompetenze.schema.parse({ livelli })
    )
    const elenco = blocchi.find((b) => b.tipo === 'elenco')
    expect(elenco?.tipo === 'elenco' && elenco.voci).toHaveLength(LIVELLI.length)
    expect(testoIntero(blocchi)).toContain(LIVELLI[3].descrittore)
  })

  it('c\'è la proposizione che CERTIFICA, e sta prima della tabella', () => {
    // Senza, la tabella dei livelli è un prospetto e il certificato non certifica niente.
    // È il capoverso del generatore già in produzione (`certificato-pdf.ts`), col solo
    // soggetto cambiato: in calce firma il legale rappresentante, non un dirigente.
    const righe = testi(
      modelloCertificatoCompetenze.componi(
        prefill,
        modelloCertificatoCompetenze.schema.parse({ livelli })
      )
    )
    const premessa = righe.findIndex((r) =>
      r.includes("si certifica che l'alunno/a ha raggiunto i livelli di competenza di seguito riportati")
    )
    expect(premessa).toBeGreaterThanOrEqual(0)
    expect(righe[premessa]).toContain("Visti gli atti d'ufficio")
    expect(premessa).toBeLessThan(righe.indexOf('Competenza chiave'))
  })

  it('le note già scritte dall\'insegnante non si buttano via — e senza note non c\'è una colonna vuota', () => {
    // `certificato_competenza_livelli.note` esiste, `certificato-store.ts` la legge e il PDF
    // in produzione la stampa sotto ogni competenza: rigenerare il certificato col motore
    // dei prestampati non deve far sparire il commento che l'insegnante ha già scritto.
    const senza = tabelle(
      modelloCertificatoCompetenze.componi(
        prefill,
        modelloCertificatoCompetenze.schema.parse({ livelli })
      )
    )[0]
    expect(senza.intestazioni).toEqual(['Competenza chiave', 'Discipline che concorrono', 'Livello'])

    const con = tabelle(
      modelloCertificatoCompetenze.componi(
        { ...prefill, noteCompetenze: { [COMPETENZE_CHIAVE[1].codice]: 'Segue le consegne in inglese.' } },
        modelloCertificatoCompetenze.schema.parse({ livelli })
      )
    )[0]
    expect(con.intestazioni).toContain('Osservazioni')
    expect(con.larghezze).toHaveLength(con.intestazioni.length)
    expect(con.righe[1][3]).toBe('Segue le consegne in inglese.')
    // Le altre sette restano celle vuote, non «—»: la nota manca, non è un giudizio.
    expect(con.righe[0][3]).toBe('')
    expect(con.righe.filter((r) => r[3] === '')).toHaveLength(COMPETENZE_CHIAVE.length - 1)
  })

  it('la nascita è una riga sola, come sul nulla osta e nel certificato di servizio', () => {
    // Stesso difetto del n. 30: due campi «Nato/a a» e «il» che `campiSeValorizzati`
    // compatta lasciavano, con la sola data in archivio, una riga «il: 14/03/2021» senza
    // antecedente — su un certificato che esce dalla scuola col protocollo.
    const completo = campiDi(
      modelloCertificatoCompetenze.componi(
        prefill,
        modelloCertificatoCompetenze.schema.parse({ livelli })
      )
    )
    expect(completo.find((c) => c.etichetta === 'Nato/a a')?.valore).toBe(
      'Cittàfinta (XX) il 14/03/2021'
    )
    expect(completo.map((c) => c.etichetta)).not.toContain('il')

    const soloData = campiDi(
      modelloCertificatoCompetenze.componi(
        { ...prefill, alunno: { cognome: 'Verdi', nome: 'Anna', dataNascita: '2021-03-14' } },
        modelloCertificatoCompetenze.schema.parse({ livelli })
      )
    )
    expect(soloData.map((c) => c.etichetta)).not.toContain('il')
    expect(soloData.find((c) => c.etichetta === 'Nato/a il')?.valore).toBe('14/03/2021')
  })

  it('le competenze significative sono facoltative', () => {
    const senza = modelloCertificatoCompetenze.componi(
      prefill,
      modelloCertificatoCompetenze.schema.parse({ livelli })
    )
    expect(testoIntero(senza)).not.toContain('Competenze significative')
    const con = modelloCertificatoCompetenze.componi(
      prefill,
      modelloCertificatoCompetenze.schema.parse({ livelli, competenze_significative: 'Suona il pianoforte.' })
    )
    expect(testoIntero(con)).toContain('Suona il pianoforte.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 47 — certificato di servizio
// ═══════════════════════════════════════════════════════════════════════════════

describe('47 — certificato di servizio', () => {
  const periodi = [
    {
      id: 'p1',
      dal: '2023-09-01',
      al: '2024-06-30',
      qualifica: 'Insegnante',
      ordine: "Scuola dell'infanzia",
      sede: 'Sede di prova',
      tipoRapporto: 'Tempo determinato',
    },
    {
      id: 'p2',
      dal: '2024-09-01',
      inCorso: true,
      qualifica: 'Insegnante',
      ordine: "Scuola dell'infanzia",
      sede: 'Sede di prova',
      tipoRapporto: 'Tempo indeterminato',
    },
  ]

  const prefill: PrefillCertificatoServizio = {
    dipendente: {
      cognome: 'Bianchi',
      nome: 'Lucia',
      dataNascita: '1990-05-02',
      luogoNascita: 'Cittàfinta (XX)',
      codiceFiscale: 'BBBBBB00B00B000B',
    },
    scuola: SCUOLA,
    sede: SEDE,
    periodi,
  }

  it('il soggetto è un dipendente e il prefill non viene da `alunni`', () => {
    expect(modelloCertificatoServizio.soggetto).toBe('dipendente')
    expect(modelloCertificatoServizio.archiviazione).toBe('fascicolo_personale')
  })

  it('omette la COLONNA che l\'anagrafica non sa riempire per nessun periodo', () => {
    const blocchi = modelloCertificatoServizio.componi(
      prefill,
      modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1', 'p2'] })
    )
    const tabella = tabelle(blocchi)[0]
    expect(tabella.intestazioni).not.toContain('Ore settimanali')
    expect(tabella.intestazioni).toEqual(['Dal', 'Al', 'Qualifica', 'Ordine di scuola', 'Sede', 'Tipo di rapporto'])
    expect(tabella.larghezze).toHaveLength(tabella.intestazioni.length)

    const conOre = modelloCertificatoServizio.componi(
      { ...prefill, periodi: [{ ...periodi[0], oreSettimanali: 25 }, periodi[1]] },
      modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1', 'p2'] })
    )
    expect(tabelle(conOre)[0].intestazioni).toContain('Ore settimanali')
  })

  it('un periodo che arriva come ISTANTE non fa sparire la colonna «Dal»', () => {
    // L'anagrafica del personale non ha una tabella di periodi: la route li compone da
    // colonne che possono essere `date` o `timestamptz`. E qui una data persa non lascia una
    // cella vuota — la colonna senza dati si TOGLIE, poche righe più sotto — quindi
    // resterebbe un certificato protocollato che certifica un servizio senza data d'inizio.
    const tabella = tabelle(
      modelloCertificatoServizio.componi(
        { ...prefill, periodi: [{ ...periodi[0], dal: '2023-09-01T07:00:00+00:00' }] },
        modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
      )
    )[0]
    expect(tabella.intestazioni[0]).toBe('Dal')
    expect(tabella.righe[0][0]).toBe('01/09/2023')
  })

  it('il prospetto porta le tre righe vuote che §2 chiede per nome su questo modulo', () => {
    // `00-impaginazione.md` §2 elenca «periodi di servizio (n. 47)» fra le tabelle
    // ripetibili e ne chiede «almeno tre righe vuote anche quando i dati sono meno». La
    // specifica è vincolante e questo modulo lo nomina: il numero è tre.
    //
    // ⚠️ L'obiezione resta scritta nel modello e non è chiusa qui: su un atto firmato dal
    // legale rappresentante e protocollato in uscita, tre righe libere sotto l'ultimo
    // periodo sono lo spazio dove aggiungere servizio dopo la firma. Se chi possiede
    // `docs/prestampati/` toglierà il n. 47 da quell'elenco, questo lock torna a 0 — ma
    // insieme al documento, non da solo e non in silenzio.
    const tabella = tabelle(
      modelloCertificatoServizio.componi(
        prefill,
        modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1', 'p2'] })
      )
    )[0]
    expect(tabella.righeVuote).toBe(3)
  })

  it('le ore settimanali si scrivono per intero: «12,75» non diventa «12,8», e mai col punto', () => {
    // Due difetti nello stesso posto. Il punto inglese — `numero()` è `String(valore)` e su
    // un foglio firmato dal legale rappresentante che vale punteggio di servizio scriveva
    // «12.5». E l'ARROTONDAMENTO: `formattaDecimale` senza precisione tiene una cifra sola
    // (default nato per i megabyte dentro una frase), e un part-time da 12,75 ore si
    // stampava «12,8» — un numero che dall'archivio non viene. 12,5 passava per
    // coincidenza, essendo l'unico frazionario che sopravvive a un decimale.
    const ore = (oreSettimanali: number | string) => {
      const tabella = tabelle(
        modelloCertificatoServizio.componi(
          { ...prefill, periodi: [{ ...periodi[0], oreSettimanali }] },
          modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
        )
      )[0]
      const colonna = tabella.intestazioni.indexOf('Ore settimanali')
      expect(colonna, String(oreSettimanali)).toBeGreaterThanOrEqual(0)
      return tabella.righe[0][colonna]
    }

    expect(ore(12.75)).toBe('12,75')
    expect(ore(18.25)).toBe('18,25')
    expect(ore(12.5)).toBe('12,5')
    // Un orario intero non prende un decimale che nessuno ha scritto.
    expect(ore(25)).toBe('25')

    // L'anagrafica può darlo anche come testo («25 (part-time)»): passa com'è, non finisce
    // in un formattatore di numeri. Ma il numero PURO col punto — la forma in cui arriva una
    // colonna `numeric` letta come testo — si riporta alla virgola: la difesa contro il
    // punto inglese non può valere per metà dei valori che l'interfaccia ammette.
    expect(ore('25 (part-time)')).toBe('25 (part-time)')
    expect(ore('12.75')).toBe('12,75')
  })

  it('il rapporto ancora in corso non prende una data di fine inventata', () => {
    const tabella = tabelle(
      modelloCertificatoServizio.componi(
        prefill,
        modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1', 'p2'] })
      )
    )[0]
    expect(tabella.righe[0][1]).toBe('30/06/2024')
    expect(tabella.righe[1][1]).toBe('in servizio alla data odierna')
  })

  it('certifica solo i periodi selezionati', () => {
    const tabella = tabelle(
      modelloCertificatoServizio.componi(
        prefill,
        modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p2'] })
      )
    )[0]
    expect(tabella.righe).toHaveLength(1)
    expect(modelloCertificatoServizio.schema.safeParse({ periodi_inclusi: [] }).success).toBe(false)
  })

  it('un id che in archivio non esiste ferma il certificato invece di svuotarlo', () => {
    // Lo schema non può accorgersene — controlla che l'elenco non sia vuoto, non che
    // quegli id ci siano — e un certificato protocollato che non certifica nessun periodo
    // vale punteggio e non dice niente.
    expect(() =>
      modelloCertificatoServizio.componi(
        prefill,
        modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['periodo-inventato'] })
      )
    ).toThrow(/nessuno dei periodi selezionati/i)
  })

  it('senza prospetto non si annuncia un elenco che non c\'è', () => {
    // Periodo in archivio ma senza un solo campo: nessuna colonna ha dati, la tabella non
    // si stampa. Prima di questa regola il capoverso finiva con i due punti e sotto il
    // vuoto — su un foglio che esce dalla scuola.
    const blocchi = modelloCertificatoServizio.componi(
      { ...prefill, periodi: [{ id: 'vuoto' }] },
      modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['vuoto'] })
    )
    expect(tabelle(blocchi)).toHaveLength(0)
    const apertura = paragrafoCon(blocchi, 'si certifica che')
    expect(apertura).toContain('ha prestato servizio presso questa istituzione scolastica.')
    expect(apertura).not.toContain('di seguito indicati:')

    // Col prospetto, invece, l'annuncio c'è e la tabella lo segue.
    const conProspetto = modelloCertificatoServizio.componi(
      prefill,
      modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
    )
    expect(paragrafoCon(conProspetto, 'si certifica che')).toContain('di seguito indicati:')
    expect(tabelle(conProspetto)).toHaveLength(1)
  })

  it('la riga disciplinare è spenta finché qualcuno non la accende', () => {
    const spenta = modelloCertificatoServizio.componi(
      prefill,
      modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
    )
    expect(testoIntero(spenta)).not.toContain('profilo disciplinare')
    const accesa = modelloCertificatoServizio.componi(
      prefill,
      modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'], riga_disciplinare: true })
    )
    expect(testoIntero(accesa)).toContain('nulla osta sotto il profilo disciplinare')
  })

  it('l\'uso dichiarato si aggiunge alla formula di legge, non la sostituisce', () => {
    const testo = testoIntero(
      modelloCertificatoServizio.componi(
        prefill,
        modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'], uso: 'per graduatorie' })
      )
    )
    expect(testo).toContain('per gli usi consentiti dalla legge')
    expect(testo).toContain('Uso dichiarato: per graduatorie.')
  })

  it('degrado: senza nascita e senza codice fiscale la frase resta una frase', () => {
    const testo = testoIntero(
      modelloCertificatoServizio.componi(
        { ...prefill, dipendente: { cognome: 'Bianchi', nome: 'Lucia' } },
        modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
      )
    )
    // Nessuna virgola orfana dove stava l'inciso anagrafico.
    expect(testo).toContain('si certifica che Bianchi Lucia ha prestato servizio')
    expect(testo).not.toContain('codice fiscale')
    expect(testo).not.toContain('nato/a a')

    // E con l'anagrafica completa l'inciso si apre e si chiude come si deve.
    const completo = testoIntero(
      modelloCertificatoServizio.componi(
        prefill,
        modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
      )
    )
    expect(completo).toContain(
      'si certifica che Bianchi Lucia, nato/a a Cittàfinta (XX) il 02/05/1990, codice fiscale BBBBBB00B00B000B, ha prestato servizio'
    )

    // E con la sola data di nascita in archivio non esce «nato/a a il 02/05/1990».
    const soloData = testoIntero(
      modelloCertificatoServizio.componi(
        { ...prefill, dipendente: { cognome: 'Bianchi', nome: 'Lucia', dataNascita: '1990-05-02' } },
        modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
      )
    )
    expect(soloData).toContain('si certifica che Bianchi Lucia, nato/a il 02/05/1990, ha prestato servizio')
  })

  it('il codice meccanografico della sede c\'è, ed è quello che dà il punteggio', () => {
    const conCodice = modelloCertificatoServizio.componi(
      prefill,
      modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
    )
    expect(testoIntero(conCodice)).toContain('XX0A000001')
    const senzaCodice = modelloCertificatoServizio.componi(
      { ...prefill, sede: { ...SEDE, codiceMeccanografico: null } },
      modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
    )
    expect(etichetteCampi(senzaCodice)).not.toContain('Codice meccanografico della sede di servizio')
  })

  it('i dati identificativi dicono che la scuola è PARITARIA, che è la parola che dà il punteggio', () => {
    // Il testo della specifica scrive «Scuola paritaria — codici meccanografici: …»: la
    // parità è la condizione per cui il servizio prestato qui vale in graduatoria, ed è
    // l'unica riga del certificato che la afferma. Ridotta a «Codici meccanografici» si
    // perdeva senza che niente lo dicesse.
    const blocchi = modelloCertificatoServizio.componi(
      prefill,
      modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
    )
    const etichette = etichetteCampi(blocchi)
    expect(etichette).toContain('Scuola paritaria — codici meccanografici')
    expect(etichette).toContain('Denominazione')
    expect(etichette).toContain('P.IVA/C.F.')
    expect(etichette).toContain('Sede legale')
    expect(campiDi(blocchi).find((c) => c.etichetta.startsWith('Scuola paritaria'))?.valore).toBe(
      SCUOLA.codiciMeccanografici
    )

    // Nessun codice in archivio: la riga sparisce insieme al valore, e con essa
    // l'affermazione — che senza i codici non è dimostrata da niente.
    const senzaCodici = modelloCertificatoServizio.componi(
      { ...prefill, scuola: { ...SCUOLA, codiciMeccanografici: null } },
      modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
    )
    expect(testoIntero(senzaCodici)).not.toContain('Scuola paritaria')
  })

  it('con la configurazione di sede vuota il titoletto dei dati della scuola non compare', () => {
    // I quattro campi vengono tutti da `scuole.config.anagrafica` e sono tutti facoltativi:
    // col titoletto incondizionato, una sede che non ne porti nessuno stampava «DATI
    // IDENTIFICATIVI DELLA SCUOLA» col suo filetto verde e sotto il vuoto, subito sopra il
    // blocco di firma. È la stessa sezione visibilmente vuota che il n. 42 ha eliminato.
    const risposte = modelloCertificatoServizio.schema.parse({ periodi_inclusi: ['p1'] })
    const spoglio = modelloCertificatoServizio.componi({ ...prefill, scuola: {} }, risposte)
    expect(testoIntero(spoglio)).not.toContain('Dati identificativi della scuola')
    // Il certificato però resta un certificato: la frase che certifica e il prospetto ci sono.
    expect(paragrafoCon(spoglio, 'si certifica che')).toBeDefined()
    expect(tabelle(spoglio)).toHaveLength(1)

    // Con un solo dato in configurazione il titoletto torna, perché sotto c'è qualcosa.
    const conSoloPiva = modelloCertificatoServizio.componi(
      { ...prefill, scuola: { piva: '00000000000' } },
      risposte
    )
    expect(testoIntero(conSoloPiva)).toContain('Dati identificativi della scuola')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 49 — stampe di sezione
// ═══════════════════════════════════════════════════════════════════════════════

describe('49 — stampe di sezione', () => {
  const prefill: PrefillStampeSezione = {
    sezione: { nome: 'Pulcini' },
    sede: SEDE,
    annoScolastico: '2025/2026',
    dataStampa: '2026-10-12',
    stampatoDa: 'Segreteria Finta',
    direzioneTelefono: '081 1111111',
    alunni: [
      { cognome: 'Verdi', nome: 'Anna', dataNascita: '2021-03-14', allergie: 'Arachidi', motivoDieta: 'Allergia' },
      { cognome: 'Bianchi', nome: 'Luca', dataNascita: '2020-11-02', contattiGenitori: 'Madre 333 0000000' },
      { cognome: 'Azzurri', nome: 'Mia', attivo: false, allergie: 'Lattosio' },
    ],
  }

  it('il soggetto è la sezione: il pannello chiede la classe, non un alunno', () => {
    expect(modelloStampeSezione.soggetto).toBe('sezione')
  })

  it('tre stampe, tre titoli — e senza nome di sezione niente trattino a vuoto', () => {
    const titolo = (stampa: string, sezione: string | null) =>
      modelloStampeSezione.titolo(
        { ...prefill, sezione: { nome: sezione } },
        modelloStampeSezione.schema.parse({ stampa })
      )
    expect(titolo('elenco', 'Pulcini')).toBe('ELENCO ALUNNI — SEZIONE PULCINI')
    expect(titolo('allergie', 'Pulcini')).toBe('ALLERGIE, INTOLLERANZE E DIETE SPECIALI — SEZIONE PULCINI')
    expect(titolo('emergenze', 'Pulcini')).toBe("CONTATTI D'EMERGENZA — SEZIONE PULCINI")
    expect(titolo('elenco', null)).toBe('ELENCO ALUNNI')
  })

  it('elenco: i sospesi restano fuori finché non li si chiede', () => {
    const blocchi = modelloStampeSezione.componi(prefill, modelloStampeSezione.schema.parse({ stampa: 'elenco' }))
    expect(tabelle(blocchi)[0].righe).toHaveLength(2)
    expect(testoIntero(blocchi)).toContain('Totale iscritti: 2')
    const conSospesi = modelloStampeSezione.componi(
      prefill,
      modelloStampeSezione.schema.parse({ stampa: 'elenco', includi_sospesi: true })
    )
    expect(tabelle(conSospesi)[0].righe).toHaveLength(3)
  })

  it('elenco: l\'ordinamento per data di nascita mette in fondo chi non ce l\'ha', () => {
    const perNascita = modelloStampeSezione.componi(
      prefill,
      modelloStampeSezione.schema.parse({ stampa: 'elenco', ordinamento: 'nascita', includi_sospesi: true })
    )
    expect(tabelle(perNascita)[0].righe.map((r) => r[1])).toEqual(['Bianchi Luca', 'Verdi Anna', 'Azzurri Mia'])
    const perCognome = modelloStampeSezione.componi(
      prefill,
      modelloStampeSezione.schema.parse({ stampa: 'elenco', includi_sospesi: true })
    )
    expect(tabelle(perCognome)[0].righe.map((r) => r[1])).toEqual(['Azzurri Mia', 'Bianchi Luca', 'Verdi Anna'])
  })

  it('allergie: una riga per bambino, la data che invalida le copie e il conteggio', () => {
    const blocchi = modelloStampeSezione.componi(prefill, modelloStampeSezione.schema.parse({ stampa: 'allergie' }))
    const testo = testoIntero(blocchi)
    expect(testo).toContain('Aggiornato al 12/10/2026 — sostituisce ogni copia precedente')
    expect(tabelle(blocchi)[0].righe).toHaveLength(1)
    expect(testo).toContain('Bambini con dieta speciale: 1 su 2')
    expect(testo).toContain('In caso di dubbio non somministrare e contattare la segreteria: 081 0000000')
  })

  it('allergie: nessuna dieta si dice a parole, non con una tabella vuota', () => {
    const blocchi = modelloStampeSezione.componi(
      { ...prefill, alunni: [{ cognome: 'Bianchi', nome: 'Luca' }] },
      modelloStampeSezione.schema.parse({ stampa: 'allergie' })
    )
    expect(tabelle(blocchi)).toHaveLength(0)
    expect(testoIntero(blocchi)).toContain('Nessun bambino della sezione ha allergie')
  })

  it('una sezione senza righe si dice a parole, in tutte e tre le stampe', () => {
    // Una tabella con la sola banda di intestazione non distingue «non c'è nessuno» da
    // «non è stato caricato niente»: sui contatti d'emergenza è la differenza fra un
    // elenco che non serve e un elenco che manca.
    for (const stampa of ['elenco', 'allergie', 'emergenze']) {
      const blocchi = modelloStampeSezione.componi(
        { ...prefill, alunni: [] },
        modelloStampeSezione.schema.parse({ stampa })
      )
      expect(tabelle(blocchi), stampa).toHaveLength(0)
      expect(testoIntero(blocchi), stampa).toContain('Nessun bambino risulta iscritto in questa sezione.')
      expect(testoIntero(blocchi), stampa).not.toContain('Totale iscritti: 0')
    }
  })

  it('«non c\'è nessuno» e «ci sono ma sono sospesi» non si dicono con la stessa frase', () => {
    const soloSospesi = modelloStampeSezione.componi(
      { ...prefill, alunni: [{ cognome: 'Azzurri', nome: 'Mia', attivo: false }] },
      modelloStampeSezione.schema.parse({ stampa: 'emergenze' })
    )
    expect(testoIntero(soloSospesi)).toContain(
      'Nessun bambino attivo in questa sezione: un bambino risulta sospeso e non compare in questa stampa.'
    )

    const dueSospesi = modelloStampeSezione.componi(
      {
        ...prefill,
        alunni: [
          { cognome: 'Azzurri', nome: 'Mia', attivo: false },
          { cognome: 'Bianchi', nome: 'Luca', attivo: false },
        ],
      },
      modelloStampeSezione.schema.parse({ stampa: 'elenco' })
    )
    expect(testoIntero(dueSospesi)).toContain('2 bambini risultano sospesi e non compaiono')

    // Chiedendoli, la stampa torna a essere una tabella: la frase non è uno stato fisso.
    const conSospesi = modelloStampeSezione.componi(
      { ...prefill, alunni: [{ cognome: 'Azzurri', nome: 'Mia', attivo: false }] },
      modelloStampeSezione.schema.parse({ stampa: 'elenco', includi_sospesi: true })
    )
    expect(tabelle(conSospesi)[0].righe).toHaveLength(1)
  })

  it('emergenze: i numeri utili ci sono, e quelli che mancano non lasciano un separatore', () => {
    const blocchi = modelloStampeSezione.componi(
      prefill,
      modelloStampeSezione.schema.parse({ stampa: 'emergenze' })
    )
    expect(testoIntero(blocchi)).toContain('Numeri utili: 118 · 081 0000000 · Direzione 081 1111111')
    const spoglio = modelloStampeSezione.componi(
      { ...prefill, sede: { ...SEDE, telefono: null }, direzioneTelefono: null },
      modelloStampeSezione.schema.parse({ stampa: 'emergenze' })
    )
    expect(testoIntero(spoglio)).toContain('Numeri utili: 118')
    expect(testoIntero(spoglio)).not.toContain('118 ·')
  })

  it('ogni pagina porta chi ha stampato e quando', () => {
    const piede = modelloStampeSezione.piePagina?.(prefill, modelloStampeSezione.schema.parse({ stampa: 'elenco' }))
    expect(piede).toContain('12/10/2026')
    expect(piede).toContain('Segreteria Finta')
    expect(piede).toContain('dati di minori')
  })

  it('il piede resta a sinistra del numero di pagina, e questa è la stampa che va su più pagine', async () => {
    // MISURA, non stima. `disegnaPiedi` (`impaginazione.ts`) centra il piede a x=105 e, con
    // più di una pagina, scrive «Pagina n di m» allineato a destra a x=188. Il piede lungo
    // di prima cresceva col nome di chi stampa: passava con «Segreteria Finta» (16
    // caratteri, il nome di questo test) e finiva SOPRA il numero di pagina con nomi di 28.
    // Qui si misura con lo stesso jsPDF e lo stesso font del motore — Helvetica corsivo
    // 8 pt — perché una regressione di lunghezza non si vede leggendo il codice, e su questo
    // foglio si vede solo dalla seconda pagina in poi.
    //
    // ⚠️ I NOMI QUI SOTTO SONO INVENTATI, come tutti quelli di questo file, e sono più lunghi
    // di qualunque nome vero: `max(length(nome || ' ' || cognome))` misurato in sola lettura
    // sull'archivio vale 23 su `utenti` — la tabella da cui `stampatoDa` arriva — 21 su
    // `alunni` e 13 su `pratiche_personale`. Il lock misura quindi il caso peggiore e non un
    // caso reale, che è ciò che deve fare: si tara sul limite, non sulla media.
    //
    // ⚠️ Il lock vive qui e non in `impaginazione.ts` perché il difetto lo introduce il
    // CONTENUTO scelto dal modello. La riparazione definitiva è del motore (piede allineato
    // a sinistra, o larghezza massima con `splitTextToSize`) ed è segnalata in `piePagina`.
    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(8)
    // Due cifre per pagina: un elenco di sezione può passare la decima pagina, e il numero
    // più largo è quello che decide. I 3 mm sono aria: due righe che si sfiorano si leggono
    // come una sola, e un lock che accettasse il contatto misurerebbe la sovrapposizione
    // invece della leggibilità.
    const xNumeroPagina = 188 - doc.getTextWidth('Pagina 10 di 12') - 3

    const risposte = modelloStampeSezione.schema.parse({ stampa: 'emergenze' })
    for (const nome of [
      'Segreteria Finta',
      'Maria Antonietta Della Ratta',
      'Giuseppina Di Costanzo Aveta',
      'MARIA ANTONIETTA DELLA RATTA ESPOSITO',
      'Anna Maria Concetta Della Ragione Esposito',
      // Una route che passasse una frase invece di un nome: il taglio a 40 caratteri le mette
      // un tetto, e il piede resta dentro l'ingombro.
      "Segreteria di sede — utenza condivisa dell'ufficio di Cittàfinta",
    ]) {
      const piede = modelloStampeSezione.piePagina?.({ ...prefill, stampatoDa: nome }, risposte) ?? ''
      expect(piede.length, nome).toBeGreaterThan(0)
      expect(105 + doc.getTextWidth(piede) / 2, nome).toBeLessThan(xNumeroPagina)
    }
  })

  it('un nome lungo si tronca invece di sfondare, e si vede che è troncato', () => {
    const lungo = modelloStampeSezione.piePagina?.(
      { ...prefill, stampatoDa: "Segreteria di sede — utenza condivisa dell'ufficio di Cittàfinta" },
      modelloStampeSezione.schema.parse({ stampa: 'elenco' })
    )
    expect(lungo).toContain('…')
    expect(lungo).toContain('Segreteria di sede')
    // Il taglio è sul NOME: la data e la dicitura non si perdono per fargli posto.
    expect(lungo).toContain('Riservato — dati di minori · 12/10/2026 · ')

    // Un nome che ci sta non viene toccato.
    const corto = modelloStampeSezione.piePagina?.(
      { ...prefill, stampatoDa: 'Giuseppina Di Costanzo Aveta' },
      modelloStampeSezione.schema.parse({ stampa: 'elenco' })
    )
    expect(corto).toBe('Riservato — dati di minori · 12/10/2026 · Giuseppina Di Costanzo Aveta')
  })

  it('la data della stampa arriva come ISTANTE — la cosa più naturale che faccia una route', () => {
    // `new Date().toISOString()`: con la sola `isoToIt` il foglio della cucina usciva senza
    // «Aggiornato al … — sostituisce ogni copia precedente» e col piede senza data. È
    // esattamente il difetto che la specifica del 49 chiama il rischio principale: «il
    // rischio non è che manchi, è che sia vecchio».
    const conIstante = { ...prefill, dataStampa: '2026-10-12T09:24:31.123456+00:00' }
    const risposte = modelloStampeSezione.schema.parse({ stampa: 'allergie' })
    expect(testoIntero(modelloStampeSezione.componi(conIstante, risposte))).toContain(
      'Aggiornato al 12/10/2026 — sostituisce ogni copia precedente'
    )
    expect(modelloStampeSezione.piePagina?.(conIstante, risposte)).toContain('12/10/2026')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 50 — registro delle presenze
// ═══════════════════════════════════════════════════════════════════════════════

describe('50 — registro presenze mensile', () => {
  const giorni = [1, 2, 3, 4, 5]
  const prefill: PrefillRegistroPresenze = {
    sede: SEDE,
    annoScolastico: '2025/2026',
    sezione: { nome: 'Pulcini', livello: 'Infanzia' },
    giorni,
    righe: [
      {
        cognome: 'Verdi',
        nome: 'Anna',
        stati: { 1: 'presente', 2: 'ritardo', 3: 'assente', 4: 'uscita_anticipata', 5: 'nessun_dato' },
      },
      { cognome: 'Bianchi', nome: 'Luca', stati: { 1: 'assente', 2: 'assente', 3: 'presente' } },
    ],
  }

  it('è un documento di sezione e non porta la firma del legale rappresentante', () => {
    expect(modelloRegistroPresenze.soggetto).toBe('sezione')
    expect(modelloRegistroPresenze.firma).toBe('nessuna')
  })

  it('una presenza è il solo «presente», come nella schermata dell\'insegnante', () => {
    // ─── UNA DEFINIZIONE SOLA ───────────────────────────────────────────────────
    // `calcSummary` (MonthlyAttendanceTable) conta come presenza il solo `presente`: i
    // quattro contatori si escludono a vicenda. Il registro sommava anche R e U, e per
    // lo stesso mese schermo e stampa dichiaravano due «presenze totali» diverse — sono
    // i numeri con cui si rendicontano voucher 0-3, PON, PNRR e SIEI.
    const blocchi = modelloRegistroPresenze.componi(
      prefill,
      modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
    )
    const riepilogo = tabelle(blocchi).find((t) => t.intestazioni.includes('Entrate posticipate'))
    // Anna: 1 presente, 1 assente, 1 ritardo, 1 uscita anticipata, 1 giorno senza dato.
    expect(riepilogo?.righe.find((r) => r[0] === 'Verdi Anna')).toEqual(['Verdi Anna', '1', '1', '1', '1'])
    expect(riepilogo?.righe.find((r) => r[0] === 'Bianchi Luca')).toEqual(['Bianchi Luca', '1', '2', '0', '0'])

    const testo = testoIntero(blocchi)
    expect(testo).toContain('Presenze totali: 2')
    expect(testo).toContain('Assenze: 3')
    expect(testo).toContain('Media giornaliera di frequenza: 0,4')

    // E la regola sta scritta accanto ai numeri, per chi rendiconta e non legge il codice.
    expect(testo).toContain('una presenza è una giornata registrata come presente')
    expect(testo).toContain('non sono assenze e non entrano nelle presenze')
  })

  it('la nota afferma solo ciò che il modello garantisce: il perimetro è la griglia', () => {
    // ─── PERCHÉ LA NOTA NON DICE PIÙ «È LO STESSO CONTEGGIO DELLA SCHERMATA» ─────
    //
    // Perché non è il modello a poterlo garantire: `calcSummary` filtra le sole giornate
    // marcate `fattoDelRegistro` — l'assenza che il genitore comunica per un giorno non
    // ancora arrivato resta FUORI dal riepilogo dello schermo — mentre `componi` conta
    // qualunque stato riceva per i `giorni` che gli passa la route. Qui la divergenza si
    // MISURA: la stessa bambina, gli stessi stati, due perimetri diversi e due numeri
    // diversi. La frase in calce a un foglio con cui si rendicontano voucher 0-3, PON,
    // PNRR e SIEI non può dipendere da come una route riempie il prefill; il contratto
    // che le tiene allineate è dichiarato su `PrefillRegistroPresenze.giorni`.
    const bambina = { cognome: 'Neri', nome: 'Sara', stati: { 1: 'presente', 2: 'assente' } } as const
    const registro = (giorni: number[]) =>
      testoIntero(
        modelloRegistroPresenze.componi(
          { ...prefill, giorni, righe: [bambina] },
          modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
        )
      )

    // Il giorno 2 è un'assenza comunicata in anticipo: fuori dal registro non conta…
    expect(registro([1])).toContain('Assenze: 0')
    // …dentro sì. Due fogli, due numeri, e nessuno dei due è un errore del modello.
    expect(registro([1, 2])).toContain('Assenze: 1')

    // Quindi il foglio dichiara il proprio perimetro — che è vero per costruzione — e non
    // un'identità con una schermata che non ha davanti.
    expect(registro([1])).toContain('Il conteggio comprende soltanto i giorni elencati nella griglia')
    expect(registro([1])).not.toContain('schermata delle presenze')
  })

  it('entrata posticipata e uscita anticipata restano fuori dalle assenze', () => {
    // L'altra metà della regola: non contano come presenza, ma non diventano un'assenza.
    const blocchi = modelloRegistroPresenze.componi(
      {
        ...prefill,
        righe: [{ cognome: 'Rossi', nome: 'Ivo', stati: { 1: 'ritardo', 2: 'uscita_anticipata' } }],
      },
      modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
    )
    const riepilogo = tabelle(blocchi).find((t) => t.intestazioni.includes('Entrate posticipate'))
    expect(riepilogo?.righe[0]).toEqual(['Rossi Ivo', '0', '0', '1', '1'])
    expect(testoIntero(blocchi)).toContain('Assenze: 0')
  })

  it('il giorno senza registrazione resta vuoto: non diventa un\'assenza', () => {
    const blocchi = modelloRegistroPresenze.componi(
      prefill,
      modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
    )
    const griglia = tabelle(blocchi)[0]
    expect(griglia.righe.find((r) => r[0] === 'Verdi Anna')).toEqual(['Verdi Anna', 'P', 'R', 'A', 'U', ''])
    // Luca non ha registrazioni al 4° e 5° giorno: due celle vuote, e una sola assenza in più.
    expect(griglia.righe.find((r) => r[0] === 'Bianchi Luca')).toEqual(['Bianchi Luca', 'A', 'A', 'P', '', ''])
  })

  it('la legenda usa gli stessi simboli della griglia', () => {
    const blocchi = modelloRegistroPresenze.componi(
      prefill,
      modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
    )
    const legenda = testi(blocchi).find((r) => r.startsWith('Legenda:')) ?? ''
    for (const stato of STATI_PRESENZA.filter((s) => s.simbolo)) {
      expect(legenda).toContain(`${stato.simbolo} = ${stato.etichetta.toLowerCase()}`)
    }
    expect(legenda).toContain('Cella vuota')
  })

  it('un mese lungo si spezza in due tabelle invece di uscire dal foglio', () => {
    const lungo = modelloRegistroPresenze.componi(
      { ...prefill, giorni: Array.from({ length: 22 }, (_, i) => i + 1) },
      modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
    )
    // Le griglie sono le tabelle intestate a un GIORNO; il riepilogo per alunno no.
    const griglie = tabelle(lungo).filter((t) => /^\d+$/.test(t.intestazioni[1] ?? ''))
    expect(griglie).toHaveLength(2)
    expect(griglie[0].intestazioni).toEqual(['Alunno/a', ...Array.from({ length: 16 }, (_, i) => String(i + 1))])
    expect(griglie[1].intestazioni).toEqual(['Alunno/a', '17', '18', '19', '20', '21', '22'])
  })

  it('il mese si scrive per esteso, e un mese inesistente non passa', () => {
    const testo = testoIntero(
      modelloRegistroPresenze.componi(prefill, modelloRegistroPresenze.schema.parse({ mese: '2026-10' }))
    )
    expect(testo).toContain('Mese: ottobre 2026')
    expect(modelloRegistroPresenze.schema.safeParse({ mese: '2026-13' }).success).toBe(false)
    expect(modelloRegistroPresenze.schema.safeParse({ mese: 'ottobre' }).success).toBe(false)
  })

  it('le firme non ancora apposte restano righe da firmare, non date inventate', () => {
    const blocchi = modelloRegistroPresenze.componi(
      prefill,
      modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
    )
    const firme = campiDi(blocchi).filter((c) => c.etichetta.includes('insegnante') || c.etichetta === 'La Direzione')
    expect(firme).toHaveLength(2)
    expect(firme.every((c) => !(c.valore ?? '').trim())).toBe(true)
    expect(etichetteCampi(blocchi)).not.toContain('Chiuso il')

    const chiuso = modelloRegistroPresenze.componi(
      {
        ...prefill,
        chiusura: {
          data: '2026-11-03',
          insegnante: 'Insegnante Finta',
          firmatoIl: '2026-11-03',
          direzione: 'Direzione Finta',
        },
      },
      modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
    )
    expect(testoIntero(chiuso)).toContain('Insegnante Finta — firmato il 03/11/2026')
    expect(testoIntero(chiuso)).toContain('Chiuso il: 03/11/2026')
    // La Direzione non ha ancora controfirmato: nome sì, data no.
    expect(campiDi(chiuso).find((c) => c.etichetta === 'La Direzione')?.valore).toBe('Direzione Finta')
  })

  it('chiusura e firme che arrivano come ISTANTE: un registro chiuso non si stampa come aperto', () => {
    // È il foglio con cui si rendicontano voucher 0-3, PON, PNRR e SIEI: con la sola
    // `isoToIt` spariva «Chiuso il» e le due firme restavano senza data, cioè un registro
    // chiuso e firmato usciva identico a uno ancora aperto e non firmato.
    const chiuso = modelloRegistroPresenze.componi(
      {
        ...prefill,
        chiusura: {
          data: '2026-11-03T08:15:00+00:00',
          insegnante: 'Insegnante Finta',
          firmatoIl: '2026-11-03T08:15:00+00:00',
          direzione: 'Direzione Finta',
          controfirmatoIl: '2026-11-04T17:00:00+01:00',
        },
      },
      modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
    )
    const testo = testoIntero(chiuso)
    expect(testo).toContain('Chiuso il: 03/11/2026')
    expect(testo).toContain('Insegnante Finta — firmato il 03/11/2026')
    expect(testo).toContain('Direzione Finta — firmato il 04/11/2026')
  })
})


// ═══════════════════════════════════════════════════════════════════════════════
// Lock d'impaginazione — le etichette dei blocchi a due colonne
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PERCHÉ ESISTE QUESTO LOCK, e perché misura col font vero invece di contare i caratteri.
 *
 * In un blocco `campi` a due colonne il motore dà a ogni cella 78 mm (`LARGHEZZA_COLONNA`),
 * scrive l'etichetta a sinistra e il valore subito dopo, a `x + larghezzaEtichetta + 2`. Se
 * l'etichetta da sola è più larga della colonna quel calcolo non se ne accorge:
 * `preparaCella` ripiega sullo spazio minimo di 12 mm e il VALORE finisce stampato oltre la
 * larghezza utile — nella colonna di destra, fuori dal margine del foglio, e §1 e §5.2 di
 * `00-impaginazione.md` fissano quella larghezza in 166 mm. È successo al n. 50 con
 * «Bambini con frequenza superiore al 50% dei giorni:» (79,2 mm su 78) e non se n'era
 * accorto nessuno dei test, perché i nove modelli qui dentro non vengono mai impaginati: si
 * collauda ciò che i blocchi DICONO, non i millimetri che occupano.
 *
 * Contare i caratteri non basterebbe — «Bambini iscritti nel mese» ne ha 25 e misura 38,8 mm,
 * «Anno scolastico» ne ha 15 e ne misura 25,5 — quindi qui si carica lo stesso jsPDF del
 * motore e si misura con lo stesso font e lo stesso corpo di `preparaCella` (Helvetica
 * normale, 10 pt), riproducendone anche i due punti in coda, che è lui a mettere.
 */

/** Il limite: `LARGHEZZA_COLONNA` di `impaginazione.ts`, dove i millimetri stanno tutti. */
const LARGHEZZA_COLONNA_MM = 78

/** Le etichette dei soli blocchi `campi` a DUE colonne: le altre hanno 166 mm e non rischiano. */
function etichetteADueColonne(blocchi: BloccoPrestampato[]): string[] {
  return blocchi.flatMap((b) =>
    b.tipo === 'campi' && b.colonne === 2 ? b.campi.map((c) => c.etichetta) : []
  )
}

/**
 * Ogni foglio che i nove modelli sanno produrre, con prefill VOLUTAMENTE PIENI.
 *
 * Sono fissi diversi da quelli dei `describe` qui sopra e la differenza è il loro scopo: là
 * si misura il degrado — che cosa succede quando un dato manca — e un valore assente fa
 * SPARIRE la riga, cioè nasconde la sua etichetta proprio a questo lock. Qui serve il caso
 * opposto: tutto valorizzato, tutte le varianti, così ogni etichetta che il motore può
 * stampare passa sotto il righello. Ci sono anche i `blocchiDopoFirma` (il tagliando del
 * n. 31), che sul foglio sono blocchi come gli altri.
 */
function fogliDiProva(): { slug: string; nome: string; blocchi: BloccoPrestampato[] }[] {
  const fogli: { slug: string; nome: string; blocchi: BloccoPrestampato[] }[] = []
  const aggiungi = (slug: string, nome: string, blocchi: BloccoPrestampato[]) =>
    fogli.push({ slug, nome, blocchi })

  aggiungi(
    modelloNullaOsta.slug,
    'nulla osta',
    modelloNullaOsta.componi(prefillNullaOsta, modelloNullaOsta.schema.parse(risposteNullaOsta))
  )

  const risposteRichiesta = modelloRichiestaDisponibilita.schema.parse({
    istituto: 'Comprensivo Statale di Prova',
    indirizzo_istituto: 'Via Inventata 2, Cittàfinta',
    email_istituto: 'protocollo@istituto-di-prova.test',
    decorrenza: '2026-09-01',
  })
  const prefillRichiesta = { alunno: ALUNNO, annoScolastico: '2025/2026' }
  aggiungi(
    modelloRichiestaDisponibilita.slug,
    'richiesta di disponibilità',
    modelloRichiestaDisponibilita.componi(prefillRichiesta, risposteRichiesta)
  )
  // Il tagliando è l'unico blocco che vive fuori da `componi`: se sparisse, un `?? []`
  // silenzioso farebbe misurare meno di prima a lock verde. Meglio un errore con la sua frase.
  const tagliando = modelloRichiestaDisponibilita.blocchiDopoFirma?.(prefillRichiesta, risposteRichiesta)
  if (!tagliando?.length) throw new Error('Il n. 31 non produce più il tagliando di risposta')
  aggiungi(modelloRichiestaDisponibilita.slug, 'richiesta di disponibilità — tagliando', tagliando)

  const prefillSollecito: PrefillSollecito = {
    alunno: ALUNNO,
    scuola: SCUOLA,
    denominazione: 'La Segreteria di prova',
    rigaCausale: 'Causale: RETTA OTT — AAAAAA00A00A000A',
    pagamento: {
      descrizione: 'Retta di ottobre',
      scadenza: '2026-10-05',
      importo: 250,
      residuo: 120.5,
      giorniRitardo: 12,
    },
  }
  for (let livello = 1; livello <= DEFAULT_LIVELLI.length; livello++) {
    aggiungi(
      modelloSollecito.slug,
      `sollecito di livello ${livello}`,
      modelloSollecito.componi(prefillSollecito, modelloSollecito.schema.parse({ livello }))
    )
  }

  const prefillVerbale: PrefillVerbaleInfortunio = {
    alunno: ALUNNO,
    sede: SEDE,
    annoScolastico: '2025/2026',
    numeroVerbale: '7',
    dataVerbale: '2026-10-12',
    operatore: { nomeCompleto: 'Educatrice Finta', firmatoIl: '2026-10-12' },
    direzione: { nome: 'Direzione Finta', controfirmatoIl: '2026-10-13' },
    genitore: { nomeCompleto: 'Genitore Finto', telefono: '333 0000000' },
    noteSanitarie: 'Nota sanitaria di prova',
    personale: [
      { id: '00000000-0000-4000-8000-000000000001', nomeCompleto: 'Collega Finta' },
      {
        id: '00000000-0000-4000-8000-000000000002',
        nomeCompleto: 'Soccorritrice Finta',
        abilitatoPrimoSoccorso: true,
      },
    ],
  }
  // Tutte le caselle «Altro» accese insieme: è la composizione con più righe possibile, e
  // quindi quella con più etichette da misurare.
  aggiungi(
    modelloVerbaleInfortunio.slug,
    'verbale di infortunio',
    modelloVerbaleInfortunio.componi(
      prefillVerbale,
      modelloVerbaleInfortunio.schema.parse({
        data: '2026-10-12',
        ora: '10:24',
        luogo: 'fuori',
        luogo_altro: 'Cortile del parco di prova',
        attivita: 'Uscita didattica',
        dinamica: 'Caduta durante una corsa.',
        altro_personale: ['00000000-0000-4000-8000-000000000001'],
        altri_bambini_coinvolti: true,
        parte_corpo: 'altro',
        parte_corpo_altro: 'Caviglia',
        tipo_lesione: 'altro',
        tipo_lesione_altro: 'Distorsione',
        descrizione_lesione: 'Gonfiore alla caviglia destra.',
        primo_soccorso: ['ghiaccio', 'altro'],
        primo_soccorso_altro: 'Bendaggio',
        soccorritore: '00000000-0000-4000-8000-000000000002',
        ora_soccorso: '10:30',
        provvedimenti: ['pronto_soccorso', 'rientro'],
        ora_118: '10:35',
        ora_avviso: '10:40',
        modalita_avviso: 'telefono',
        note_famiglia: 'Consegnata copia del verbale.',
      })
    )
  )

  const prefillValutazione: PrefillValutazioneInfanzia = {
    alunno: ALUNNO,
    annoScolastico: '2025/2026',
    annoFrequenza: 2,
    insegnanti: ['Insegnante Finta', 'Insegnante Inventata'],
    coordinatrice: 'Coordinatrice Finta',
  }
  for (const periodo of PERIODI_VALUTAZIONE) {
    aggiungi(
      modelloValutazioneInfanzia.slug,
      `valutazione infanzia — ${periodo.valore}`,
      modelloValutazioneInfanzia.componi(
        prefillValutazione,
        modelloValutazioneInfanzia.schema.parse({
          periodo: periodo.valore,
          esperienze: Object.fromEntries(
            CAMPI_ESPERIENZA.map((c) => [
              c.valore,
              { livello: 'consolidato', osservazioni: 'Osservazione di prova.' },
            ])
          ),
          autonomia: Object.fromEntries(VOCI_AUTONOMIA.map((v) => [v.valore, 'consolidato'])),
          osservazione_globale: 'Percorso sereno.',
          proposte: 'Proseguire con il gioco simbolico.',
        })
      )
    )
  }

  aggiungi(
    modelloCertificatoCompetenze.slug,
    'certificato delle competenze',
    modelloCertificatoCompetenze.componi(
      {
        alunno: ALUNNO,
        sede: SEDE,
        annoScolastico: '2025/2026',
        classe: 'PROVA 5',
        noteCompetenze: Object.fromEntries(COMPETENZE_CHIAVE.map((c) => [c.codice, 'Nota di prova.'])),
      },
      modelloCertificatoCompetenze.schema.parse({
        livelli: Object.fromEntries(COMPETENZE_CHIAVE.map((c) => [c.codice, LIVELLI[0].codice])),
        competenze_significative: 'Ha condotto un laboratorio di lettura.',
      })
    )
  )

  aggiungi(
    modelloCertificatoServizio.slug,
    'certificato di servizio',
    modelloCertificatoServizio.componi(
      {
        dipendente: {
          cognome: 'Bianchi',
          nome: 'Lucia',
          dataNascita: '1990-05-02',
          luogoNascita: 'Cittàfinta (XX)',
          codiceFiscale: 'BBBBBB00B00B000B',
        },
        scuola: SCUOLA,
        sede: SEDE,
        periodi: [
          {
            id: 'p1',
            dal: '2023-09-01',
            al: '2024-06-30',
            qualifica: 'Insegnante',
            ordine: "Scuola dell'infanzia",
            sede: 'Sede di prova',
            tipoRapporto: 'Tempo determinato',
            oreSettimanali: 25,
          },
        ],
      },
      modelloCertificatoServizio.schema.parse({
        periodi_inclusi: ['p1'],
        uso: 'Uso consentito dalla legge',
        riga_disciplinare: true,
      })
    )
  )

  const prefillSezione: PrefillStampeSezione = {
    sezione: { nome: 'Pulcini' },
    sede: SEDE,
    annoScolastico: '2025/2026',
    dataStampa: '2026-10-12',
    stampatoDa: 'Segreteria Finta',
    direzioneTelefono: '081 1111111',
    alunni: [
      {
        cognome: 'Verdi',
        nome: 'Anna',
        dataNascita: '2021-03-14',
        sezione: 'Pulcini',
        insegnanti: 'Insegnante Finta',
        note: 'Nota di prova',
        allergie: 'Alimento di prova',
        alimentiDaEscludere: 'Alimento di prova',
        sostituzioni: 'Alternativa di prova',
        motivoDieta: 'Motivo di prova',
        documentoDieta: 'Certificato del 01/09/2026',
        contattiGenitori: 'Madre 333 0000000',
        altriContatti: 'Nonna 333 1111111',
        pediatra: 'Pediatra Finto 081 2222222',
        noteSanitarie: 'Nota di prova',
      },
    ],
  }
  for (const stampa of STAMPE_SEZIONE) {
    aggiungi(
      modelloStampeSezione.slug,
      `stampe di sezione — ${stampa.valore}`,
      modelloStampeSezione.componi(
        prefillSezione,
        modelloStampeSezione.schema.parse({ stampa: stampa.valore, includi_sospesi: true })
      )
    )
  }

  const prefillRegistro: PrefillRegistroPresenze = {
    sede: SEDE,
    annoScolastico: '2025/2026',
    sezione: { nome: 'Pulcini', livello: 'Infanzia' },
    giorni: Array.from({ length: 22 }, (_, i) => i + 1),
    righe: [{ cognome: 'Verdi', nome: 'Anna', stati: { 1: 'presente', 2: 'assente' } }],
    chiusura: {
      data: '2026-11-03',
      insegnante: 'Insegnante Finta',
      firmatoIl: '2026-11-03',
      direzione: 'Direzione Finta',
      controfirmatoIl: '2026-11-04',
    },
  }
  aggiungi(
    modelloRegistroPresenze.slug,
    'registro presenze',
    modelloRegistroPresenze.componi(
      prefillRegistro,
      modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
    )
  )

  return fogli
}

describe('lock — nessuna etichetta a due colonne sfonda la colonna', () => {
  it('tutti e nove i modelli passano sotto il righello, e nessuno ne resta fuori', () => {
    // Il lock vale quanto la sua copertura: se un modello non componesse nessun foglio,
    // le sue etichette non verrebbero misurate e il test passerebbe lo stesso.
    const composti = new Set(fogliDiProva().map((f) => f.slug))
    expect([...composti].sort()).toEqual(MODELLI.map((m) => m.slug).sort())
  })

  it('ogni etichetta a due colonne sta dentro i 78 mm, misurati col font del motore', async () => {
    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    // Gli stessi due di `preparaCella`: cambiarli qui e non là misurerebbe un altro foglio.
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)

    const conDueColonne = new Set<string>()
    let misurate = 0
    for (const foglio of fogliDiProva()) {
      for (const etichetta of etichetteADueColonne(foglio.blocchi)) {
        conDueColonne.add(foglio.slug)
        misurate++
        // `preparaCella` toglie i due punti che il modello avesse già scritto e li rimette
        // lui: la larghezza da misurare è quella dell'etichetta COME ESCE dal motore.
        const larghezza = doc.getTextWidth(`${etichetta.trim().replace(/:+$/, '')}:`)
        expect(
          larghezza,
          `${foglio.nome} — «${etichetta}» misura ${larghezza.toFixed(1)} mm`
        ).toBeLessThanOrEqual(LARGHEZZA_COLONNA_MM)
      }
    }

    // Anti-vuoto, la seconda metà: i sette modelli che oggi usano le due colonne devono
    // aver contribuito almeno un'etichetta ciascuno. Se un giorno un blocco a due colonne
    // sparisse — o se un prefill di prova smettesse di valorizzare le sue righe — questo
    // test tornerebbe verde misurando meno di prima, che è il modo in cui un lock muore.
    expect([...conDueColonne].sort()).toEqual(
      [
        'certificato_competenze',
        'nulla_osta',
        'registro_presenze',
        'richiesta_disponibilita',
        'stampe_sezione',
        'valutazione_infanzia',
        'verbale_infortunio',
      ].sort()
    )
    // Oggi ne misura 70. La soglia sta sotto perché aggiungere una riga non deve costare una
    // modifica al test, ma un blocco intero che sparisse dai fissi la farebbe scattare.
    expect(misurate).toBeGreaterThan(60)
  })

  it('la riga che ha fatto nascere il lock: a due colonne non ci starebbe', async () => {
    // La prova che il righello misura davvero. «Bambini con frequenza superiore al 50% dei
    // giorni:» è l'etichetta che usciva fuori dal foglio: 79,2 mm contro i 78 della colonna.
    // Oggi sta in un blocco a UNA colonna — dove ha 166 mm e non tocca niente — ma se
    // qualcuno la riportasse fra le due colonne il lock qui sopra diventerebbe rosso, e
    // questo test dice perché.
    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    expect(doc.getTextWidth('Bambini con frequenza superiore al 50% dei giorni:')).toBeGreaterThan(
      LARGHEZZA_COLONNA_MM
    )

    const blocchi = modelloRegistroPresenze.componi(
      {
        sede: SEDE,
        annoScolastico: '2025/2026',
        sezione: { nome: 'Pulcini' },
        giorni: [1, 2, 3, 4],
        righe: [{ cognome: 'Verdi', nome: 'Anna', stati: { 1: 'presente', 2: 'presente', 3: 'presente' } }],
      },
      modelloRegistroPresenze.schema.parse({ mese: '2026-10' })
    )
    // La riga c'è, col suo numero: si è spostata, non è stata tolta.
    expect(testoIntero(blocchi)).toContain('Bambini con frequenza superiore al 50% dei giorni: 1')
    expect(etichetteADueColonne(blocchi)).not.toContain('Bambini con frequenza superiore al 50% dei giorni')
  })
})
