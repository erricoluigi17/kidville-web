/**
 * IL REGISTRO DEI DICIASSETTE, IL RENDER E LE PARTI PURE DEL PRECOMPILATO
 * (`src/lib/prestampati/registro.ts`, `render.ts`, `prefill.ts`).
 *
 * Quattro cose si misurano qui, e sono le quattro che si rompono in silenzio:
 *
 *  1. **il cancello tiene** — uno slug che non è fra i diciassette viene respinto, e non
 *     «quasi»: `document_type` finisce dentro `student_documents`, dentro il nome del file
 *     nel bucket e dentro l'oggetto del protocollo, e una stringa inventata da chi chiama
 *     diventerebbe una riga d'archivio che nessun elenco saprà più mostrare;
 *  2. **il filtro per ruolo è ASIMMETRICO** — la segreteria vede anche ciò che è del
 *     genitore, il genitore no e l'insegnante nemmeno. È una regola che si legge in una
 *     riga e si sbaglia in un carattere (`||` al posto di `&&`), e sbagliata darebbe a un
 *     genitore il certificato di servizio di una dipendente;
 *  3. **il render RIFIUTA invece di degradare, ma solo dove deve** — senza firma raccolta,
 *     senza il nome del legale rappresentante, e su un documento che esce dalla scuola
 *     senza né protocollo né la dicitura della copia di famiglia. Ovunque altrove un dato
 *     che manca fa sparire una riga; qui farebbe uscire un atto firmato da nessuno;
 *  4. **le etichette esistono in tutte e due le lingue** — non che siano uguali (sono
 *     traduzioni), ma che la CHIAVE ci sia: quando manca, next-intl mostra il nome della
 *     chiave al posto del testo, e lo si scopre soltanto guardando lo schermo di qualcuno;
 *  5. **ogni rifiuto di contesto porta un CODICE**, e non solo una frase italiana. Senza,
 *     la route che deve scegliere uno status non ha altro appiglio che confrontare
 *     stringhe — e un `includes('firma')` che decide fra un 409 e un 500 è un difetto che
 *     nessun test vede, perché la frase si riscrive e il codice no;
 *  6. **le risposte VALIDATE escono insieme al PDF** — `expiry_date` si ricava da lì, e
 *     senza questo campo la route rivaliderebbe per conto suo (due sorgenti di verità) o
 *     archivierebbe una scadenza mai controllata;
 *  7. **le decisioni pure del precompilato** — la parola stampata accanto al nome di un
 *     genitore, il cancello «nido o niente certificato», la parentesi della provincia che
 *     non deve restare vuota, il 409 dell'anonimizzato che non è quello dell'archiviato.
 *     Sono funzioni senza I/O: se cambiano comportamento e nessuna riga diventa rossa,
 *     cambia una parola su un atto e non se ne accorge nessuno.
 *
 * Nessun dato reale: bambini, tutori, sedi, P.IVA e uuid sono inventati.
 */

import { describe, it, expect } from 'vitest'
import {
  PRESTAMPATI,
  SLUG_PRESTAMPATI,
  bloccoFirma,
  chiaveEtichetta,
  prestampatiPerRuolo,
  prestampato,
  ruoliAppDelBanco,
  ruoloRichiedente,
  slugPrestampato,
  type RuoloRichiedente,
  type SlugPrestampato,
  type SlugPrestampatoSegreteria,
  type VocePrestampato,
} from '@/lib/prestampati/registro'
import {
  MODELLI_GENITORE,
  modelloCertificatoIscrizioneFrequenza,
  modelloPermessoOrario,
  type DatiPrestampato,
  type ModelloPrestampato as ModelloGenitore,
} from '@/lib/prestampati/modelli/genitore'
import {
  MODELLI_SEGRETERIA,
  modelloStampeSezione,
  type PrefillStampeSezione,
} from '@/lib/prestampati/modelli/segreteria'
import {
  cartaDaDati,
  renderPrestampatoGenitore,
  renderPrestampatoSegreteria,
  type OpzioniRender,
} from '@/lib/prestampati/render'
import {
  alunnoNonStampabile,
  componiAlunno,
  componiScuola,
  leggiAutorizzazioneNido,
  livelloDaSezione,
  nucleoAlunno,
  nucleoScuola,
  nucleoSede,
  ruoloDaRelazione,
  type PrefillPrestampato,
  type RigaAlunno,
} from '@/lib/prestampati/prefill'
import { STATO_ISCRITTO, STATO_RITIRATO, STATO_SOSPESO } from '@/lib/alunni/stato'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { estraiTesto } from '@/lib/protocolli/estrai'
import itGenitore from '../../messages/it/prestampatiGenitore.json'
import enGenitore from '../../messages/en/prestampatiGenitore.json'
import itSegreteria from '../../messages/it/prestampatiSegreteria.json'
import enSegreteria from '../../messages/en/prestampatiSegreteria.json'

// ─── Dati di prova (tutti inventati) ────────────────────────────────────────────

const DATI: DatiPrestampato = {
  alunno: {
    nome: 'Nadia',
    cognome: 'Sanniti',
    dataNascita: '2021-03-14',
    luogoNascita: 'Cittàfinta (XX)',
    codiceFiscale: 'SNNNDA21C54X000Q',
    sezione: 'PRIMAVERA A',
    livello: 'infanzia',
  },
  genitori: [{ nomeCompleto: 'Sanniti Marco', ruolo: 'padre', telefono: '081 0000001' }],
  sede: {
    scuola_nome: 'Sede di prova',
    scuola_indirizzo: 'Via Inventata 1',
    scuola_cap: '80000',
    scuola_citta: 'Cittàfinta',
    scuola_provincia: 'XX',
    scuola_codice_meccanografico: 'XX0A000000',
  },
  scuola: {
    ragioneSociale: 'Cooperativa di prova',
    piva: '00000000000',
    sedeLegale: 'Via Inventata 1 — 80000 Cittàfinta (XX)',
  },
  annoScolastico: '2026/2027',
  dataOggi: '2026-08-14',
}

const CARTA = cartaDaDati(DATI)

const LEGALE = 'Cognomefinto Nomefinto'

function opzioni(extra: Partial<OpzioniRender> = {}): OpzioniRender {
  return { carta: CARTA, ...extra }
}

const FIRMA_RACCOLTA = {
  firmatario: 'Sanniti Marco',
  istante: '14/08/2026 alle 10:24',
  metodo: 'Codice OTP verificato',
  riferimento: 'a3f9c1e0',
}

/** Un permesso di sola entrata posticipata: `verificaContesto` non chiede l'accompagnatore. */
const PERMESSO_VALIDO = { giorno: '2026-09-15', tipo: 'entrata_posticipata', oraArrivo: '09:30' }

const PREFILL_SEZIONE: PrefillStampeSezione = {
  sezione: { nome: 'PRIMAVERA A' },
  sede: { nome: 'Sede di prova', telefono: null, codiceMeccanografico: 'XX0A000000' },
  annoScolastico: '2026/2027',
  dataStampa: '2026-08-14',
  stampatoDa: 'Cognomefinto Nomefinto',
  alunni: [
    { cognome: 'Sanniti', nome: 'Nadia', dataNascita: '2021-03-14', attivo: true },
    { cognome: 'Ferrone', nome: 'Bruno', dataNascita: '2021-11-02', attivo: true },
  ],
}

const PREFILL: PrefillPrestampato = {
  alunnoId: '11111111-2222-3333-4444-555555555555',
  scuolaId: '66666666-7777-8888-9999-000000000000',
  sezioneId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  dati: DATI,
  legaleRappresentante: LEGALE,
}

/** Le chiavi annidate di un catalogo, in forma `a.b.c` — come le legge next-intl. */
function chiavi(catalogo: unknown, prefisso = ''): string[] {
  if (catalogo === null || typeof catalogo !== 'object') return [prefisso]
  return Object.entries(catalogo as Record<string, unknown>).flatMap(([k, v]) =>
    chiavi(v, prefisso ? `${prefisso}.${k}` : k),
  )
}

const CHIAVI = {
  itGenitore: chiavi(itGenitore),
  enGenitore: chiavi(enGenitore),
  itSegreteria: chiavi(itSegreteria),
  enSegreteria: chiavi(enSegreteria),
}

describe('registro — l’elenco dei diciassette', () => {
  it('contiene tutti e diciassette i modelli, una volta ciascuno', () => {
    expect(PRESTAMPATI).toHaveLength(17)
    expect(new Set(SLUG_PRESTAMPATI).size).toBe(17)
    // Otto della famiglia e nove della segreteria: se una delle due sponde perde un
    // modello, il totale resta sbagliato ma il messaggio dice subito da che parte.
    expect(PRESTAMPATI.filter((v) => v.famiglia === 'genitore')).toHaveLength(8)
    expect(PRESTAMPATI.filter((v) => v.famiglia === 'segreteria')).toHaveLength(9)
    expect(MODELLI_GENITORE).toHaveLength(8)
    expect(MODELLI_SEGRETERIA).toHaveLength(9)
  })

  it('gli slug dichiarati e i modelli veri coincidono, nei DUE versi', () => {
    // `SlugPrestampatoSegreteria` è una copia scritta a mano di ciò che `MODELLI_SEGRETERIA`
    // dichiara come `string`: senza questo confronto, un modello nuovo di là resterebbe
    // fuori dal registro — o una riga di qua proteggerebbe un modello che non esiste.
    const dallElenco = [...SLUG_PRESTAMPATI].sort()
    const daiModelli = [
      ...MODELLI_GENITORE.map((m) => m.slug as SlugPrestampato),
      ...MODELLI_SEGRETERIA.map((m) => m.slug as SlugPrestampato),
    ].sort()
    expect(dallElenco).toEqual(daiModelli)
  })

  it('ogni voce ha etichetta e campi con una chiave non vuota', () => {
    for (const voce of PRESTAMPATI) {
      expect(voce.etichetta.trim(), `${voce.slug} senza etichetta`).not.toBe('')
      for (const campo of voce.campi) {
        expect(campo.nome.trim(), `${voce.slug}: campo senza chiave`).not.toBe('')
        expect(campo.etichetta.trim(), `${voce.slug}.${campo.nome} senza etichetta`).not.toBe('')
      }
    }
  })

  it('la chiave di ogni campo è quella dello schema del modello (`nome` di là, `id` di qua)', () => {
    // L'unificazione dei due descrittori è il punto in cui si perde una chiave senza che
    // niente diventi rosso: il pannello disegnerebbe un campo che le risposte non hanno.
    for (const modello of MODELLI_GENITORE) {
      const voce = prestampato(modello.slug) as VocePrestampato
      expect(voce.campi.map((c) => c.nome)).toEqual(modello.campi.map((c) => c.nome))
    }
    for (const modello of MODELLI_SEGRETERIA) {
      const voce = prestampato(modello.slug) as VocePrestampato
      expect(voce.campi.map((c) => c.nome)).toEqual(modello.campi.map((c) => c.id))
    }
  })

  it('le colonne di una tabella ripetibile sopravvivono all’unificazione', () => {
    // Il n. 08 (delega al ritiro) porta una tabella `righe` con le sue colonne: sono
    // campi dentro un campo, e una normalizzazione che si fermasse al primo livello le
    // perderebbe in silenzio — il pannello disegnerebbe una tabella senza colonne.
    const conColonne = PRESTAMPATI.flatMap((v) => v.campi).filter((c) => c.tipo === 'righe')
    expect(conColonne.length).toBeGreaterThan(0)
    for (const campo of conColonne) {
      expect(campo.colonne?.length, `${campo.nome}: tabella senza colonne`).toBeGreaterThan(0)
      for (const colonna of campo.colonne ?? []) {
        expect(colonna.nome.trim()).not.toBe('')
      }
    }
  })
})

describe('registro — il cancello', () => {
  it('respinge uno slug sconosciuto invece di lasciarlo passare', () => {
    for (const ignoto of [
      'certificato_bonus',
      'scheda',
      'nulla_osta_2',
      '',
      '   ',
      'DROP TABLE alunni',
      null,
      undefined,
    ]) {
      expect(prestampato(ignoto), `slug accettato: ${String(ignoto)}`).toBeNull()
      expect(slugPrestampato(ignoto)).toBe(false)
    }
  })

  it('lo slug si accetta ESATTO: nessuna normalizzazione di comodo', () => {
    // Gli spazi attorno sì (un input HTML li porta dietro), il maiuscolo no: il valore
    // finisce in `student_documents.document_type`, dove `Scheda_Sanitaria` e
    // `scheda_sanitaria` sarebbero due tipi diversi in due righe che si somigliano.
    expect(prestampato('  scheda_sanitaria  ')?.slug).toBe('scheda_sanitaria')
    expect(prestampato('Scheda_Sanitaria')).toBeNull()
    expect(prestampato('scheda-sanitaria')).toBeNull()
  })

  it('riconosce tutti e diciassette gli slug veri', () => {
    for (const slug of SLUG_PRESTAMPATI) {
      expect(prestampato(slug)?.slug, `slug respinto: ${slug}`).toBe(slug)
      expect(slugPrestampato(slug)).toBe(true)
    }
  })
})

describe('registro — chi può generare che cosa', () => {
  const perRuolo = (r: RuoloRichiedente) => prestampatiPerRuolo(r).map((v) => v.slug)

  it('il genitore vede soltanto i moduli della famiglia', () => {
    const suoi = perRuolo('genitore')
    expect(suoi.length).toBeGreaterThan(0)
    for (const slug of suoi) {
      expect(prestampato(slug)?.famiglia, `${slug} non è un modulo della famiglia`).toBe('genitore')
    }
    // I nove della segreteria non compaiono MAI di là: il certificato di servizio di una
    // dipendente e il verbale di infortunio non nascono dal telefono di un genitore.
    for (const modello of MODELLI_SEGRETERIA) {
      expect(suoi).not.toContain(modello.slug as SlugPrestampatoSegreteria)
    }
  })

  it('la segreteria vede ANCHE ciò che è del genitore (la regola asimmetrica)', () => {
    const segreteria = perRuolo('segreteria')
    for (const slug of perRuolo('genitore')) {
      expect(segreteria, `la segreteria non vede ${slug}`).toContain(slug)
    }
    expect(segreteria.length).toBeGreaterThan(perRuolo('genitore').length)
  })

  it('e non viceversa: l’eredità va in una direzione sola', () => {
    const genitore = perRuolo('genitore')
    const soloSegreteria = perRuolo('segreteria').filter((s) => !genitore.includes(s))
    expect(soloSegreteria.length).toBeGreaterThan(0)
    for (const slug of soloSegreteria) {
      expect(genitore, `${slug} è arrivato al genitore`).not.toContain(slug)
    }
  })

  it('l’insegnante non eredita niente: vede solo ciò che la nomina', () => {
    const insegnante = perRuolo('insegnante')
    expect(insegnante.length).toBeGreaterThan(0)
    for (const slug of insegnante) {
      expect(
        prestampato(slug)?.disponibilePer,
        `${slug} è arrivato all’insegnante senza dichiararla`,
      ).toContain('insegnante')
    }
    // La scheda sanitaria è del genitore: la segreteria la eredita, l'insegnante no.
    expect(insegnante).not.toContain('scheda_sanitaria')
    expect(perRuolo('segreteria')).toContain('scheda_sanitaria')
  })

  it('il filtro per soggetto separa il bambino, la sezione e il dipendente', () => {
    const perSezione = prestampatiPerRuolo('segreteria', { soggetto: 'sezione' })
    expect(perSezione.map((v) => v.slug).sort()).toEqual(['registro_presenze', 'stampe_sezione'])

    const perDipendente = prestampatiPerRuolo('segreteria', { soggetto: 'dipendente' })
    expect(perDipendente.map((v) => v.slug)).toEqual(['certificato_servizio'])

    const perAlunno = prestampatiPerRuolo('segreteria', { soggetto: 'alunno' })
    expect(perAlunno.length).toBe(
      prestampatiPerRuolo('segreteria').length - perSezione.length - perDipendente.length,
    )
  })

  it('il filtro per protocollo isola i fogli che escono dalla scuola', () => {
    const inUscita = prestampatiPerRuolo('segreteria', { protocollo: 'uscita' })
    expect(inUscita.length).toBeGreaterThan(0)
    for (const voce of inUscita) expect(voce.protocollo).toBe('uscita')
  })

  /**
   * I DUE ASSI AGGIUNTI PER IL CATALOGO A SCHERMO — e perché stanno QUI.
   *
   * Il pannello della segreteria mostra diciassette voci in una griglia, e per trovarne una
   * servono le stesse quattro domande che questa funzione sa già rispondere per metà: di chi
   * parla, se esce dalla scuola, **da quale delle due famiglie viene** e **che firma
   * pretende**. Scrivere le ultime due nel browser avrebbe voluto dire una seconda
   * definizione di «famiglia» accanto a quella del registro — e due definizioni divergono
   * alla prima modifica, con il gate verde.
   */
  it('il filtro per famiglia separa i moduli della famiglia da quelli dello sportello', () => {
    const dellaFamiglia = prestampatiPerRuolo('segreteria', { famiglia: 'genitore' })
    expect(dellaFamiglia.map((v) => v.slug).sort()).toEqual(
      [
        'autorizzazione_farmaci',
        'autorizzazione_uscita',
        'certificato_bonus_nido',
        'certificato_iscrizione_frequenza',
        'delega_ritiro',
        'dieta_speciale',
        'permesso_orario',
        'scheda_sanitaria',
      ].sort(),
    )
    for (const voce of dellaFamiglia) expect(voce.famiglia).toBe('genitore')

    const delloSportello = prestampatiPerRuolo('segreteria', { famiglia: 'segreteria' })
    for (const voce of delloSportello) expect(voce.famiglia).toBe('segreteria')
    // Le due famiglie sono una PARTIZIONE: nessuna voce fuori, nessuna contata due volte.
    expect(dellaFamiglia.length + delloSportello.length).toBe(
      prestampatiPerRuolo('segreteria').length,
    )
  })

  it('il filtro per firma isola i fogli che nessuno deve sottoscrivere', () => {
    const senzaFirma = prestampatiPerRuolo('segreteria', { firma: 'nessuna' })
    expect(senzaFirma.length).toBeGreaterThan(0)
    for (const voce of senzaFirma) expect(voce.firma).toBe('nessuna')

    const delLegale = prestampatiPerRuolo('segreteria', { firma: 'legale_rappresentante' })
    expect(delLegale.length).toBeGreaterThan(0)
    for (const voce of delLegale) expect(voce.firma).toBe('legale_rappresentante')

    // `otp_due_genitori` NON si confonde con `otp_genitore`: sono due requisiti diversi
    // (una firma o due), ed è l'unica informazione che il blocco disegnato perde.
    const dueGenitori = prestampatiPerRuolo('segreteria', { firma: 'otp_due_genitori' })
    for (const voce of dueGenitori) expect(voce.firma).toBe('otp_due_genitori')
    expect(prestampatiPerRuolo('segreteria', { firma: 'otp_genitore' })).not.toEqual(
      expect.arrayContaining(dueGenitori),
    )
  })

  it('i quattro assi si combinano in AND, non in OR', () => {
    // Un filtro che sommasse invece di restringere mostrerebbe PIÙ righe man mano che si
    // scelgono criteri: è il difetto che si nota solo contando, e per questo si conta.
    const solo = prestampatiPerRuolo('segreteria', { famiglia: 'genitore' })
    const combinato = prestampatiPerRuolo('segreteria', {
      famiglia: 'genitore',
      protocollo: 'uscita',
    })
    expect(combinato.length).toBeLessThan(solo.length)
    for (const voce of combinato) {
      expect(voce.famiglia).toBe('genitore')
      expect(voce.protocollo).toBe('uscita')
    }
    // Una combinazione impossibile dà l'insieme vuoto, non l'elenco intero.
    expect(
      prestampatiPerRuolo('segreteria', { soggetto: 'dipendente', famiglia: 'genitore' }),
    ).toEqual([])
  })

  it('i ruoli dell’app finiscono al banco giusto, e la cuoca non ne ha uno', () => {
    expect(ruoloRichiedente('admin')).toBe('segreteria')
    expect(ruoloRichiedente('coordinator')).toBe('segreteria')
    expect(ruoloRichiedente('segreteria')).toBe('segreteria')
    expect(ruoloRichiedente('educator')).toBe('insegnante')
    expect(ruoloRichiedente('genitore')).toBe('genitore')
    // `cuoca` è un ruolo vero dell'app: il suo posto è l'assenza di un banco, non un
    // ripiego sulla segreteria — le stamperebbe i verbali di infortunio.
    expect(ruoloRichiedente('cuoca')).toBeNull()
    expect(ruoloRichiedente('amministratore')).toBeNull()
    expect(ruoloRichiedente('')).toBeNull()
    expect(ruoloRichiedente(null)).toBeNull()
  })

  it('`ruoliAppDelBanco` è l’inverso esatto della mappa', () => {
    for (const banco of ['genitore', 'segreteria', 'insegnante'] as const) {
      const ruoli = ruoliAppDelBanco(banco)
      expect(ruoli.length, `nessun ruolo per ${banco}`).toBeGreaterThan(0)
      for (const ruolo of ruoli) expect(ruoloRichiedente(ruolo)).toBe(banco)
    }
    expect(ruoliAppDelBanco('segreteria').sort()).toEqual(['admin', 'coordinator', 'segreteria'])
  })
})

describe('registro — firma, protocollo e archiviazione', () => {
  it('ciò che ESCE dalla scuola lo firma il legale rappresentante, e viceversa', () => {
    // I due assi sono dichiarati separatamente (uno dai modelli, uno dalla tabella delle
    // scelte del registro) proprio perché non si deducano l'uno dall'altro: questa è
    // l'unica riga che verifica che continuino a dire la stessa cosa.
    for (const voce of PRESTAMPATI) {
      expect(
        voce.protocollo === 'uscita',
        `${voce.slug}: protocollo=${voce.protocollo}, firma=${voce.firma}`,
      ).toBe(voce.firma === 'legale_rappresentante')
    }
    expect(PRESTAMPATI.filter((v) => v.protocollo === 'uscita')).toHaveLength(6)
  })

  it('il requisito di firma si traduce nel blocco che il motore sa disegnare', () => {
    expect(bloccoFirma('otp_genitore')).toBe('genitore')
    expect(bloccoFirma('otp_due_genitori')).toBe('genitore')
    expect(bloccoFirma('legale_rappresentante')).toBe('legaleRappresentante')
    expect(bloccoFirma('nessuna')).toBe('nessuna')
    // La doppia firma esiste, ed è l'informazione che il tipo del motore NON porta: se
    // sparisse, l'08 uscirebbe firmato da un genitore solo senza che niente lo dica.
    expect(PRESTAMPATI.find((v) => v.slug === 'delega_ritiro')?.firma).toBe('otp_due_genitori')
  })

  it('ogni voce dichiara dove finisce il PDF', () => {
    const ammesse = ['student_documents', 'fascicolo_personale', 'protocolli', 'nessuna']
    for (const voce of PRESTAMPATI) {
      expect(ammesse, `${voce.slug}: archiviazione ${voce.archiviazione}`).toContain(voce.archiviazione)
    }
    // Le due stampe di servizio non si archiviano: un elenco di cucina non è un documento
    // del fascicolo di nessuno.
    expect(prestampato('stampe_sezione')?.archiviazione).toBe('nessuna')
    expect(prestampato('certificato_servizio')?.archiviazione).toBe('fascicolo_personale')
  })
})

describe('registro — le etichette esistono in entrambe le lingue', () => {
  it('tutti e diciassette hanno la loro voce in `prestampatiSegreteria`', () => {
    for (const slug of SLUG_PRESTAMPATI) {
      const chiave = chiaveEtichetta(slug)
      expect(CHIAVI.itSegreteria, `manca it/${chiave}`).toContain(chiave)
      expect(CHIAVI.enSegreteria, `manca en/${chiave}`).toContain(chiave)
    }
  })

  it('gli otto della famiglia hanno anche la voce (e la descrizione) in `prestampatiGenitore`', () => {
    const suoi = prestampatiPerRuolo('genitore').map((v) => v.slug)
    for (const slug of suoi) {
      const chiave = chiaveEtichetta(slug)
      expect(CHIAVI.itGenitore, `manca it/${chiave}`).toContain(chiave)
      expect(CHIAVI.enGenitore, `manca en/${chiave}`).toContain(chiave)
      const descrizione = chiave.replace(/^modelli\./, 'descrizioni.')
      expect(CHIAVI.itGenitore, `manca it/${descrizione}`).toContain(descrizione)
      expect(CHIAVI.enGenitore, `manca en/${descrizione}`).toContain(descrizione)
    }
    // E nessuna etichetta di troppo: una voce nel catalogo del genitore per un modulo che
    // il genitore non può generare è una promessa che la schermata non mantiene.
    const modelliNelCatalogo = CHIAVI.itGenitore.filter((k) => k.startsWith('modelli.'))
    expect(modelliNelCatalogo).toHaveLength(suoi.length)
  })

  it('la chiave si ricava dallo slug in camelCase, senza tabelle da tenere allineate', () => {
    expect(chiaveEtichetta('scheda_sanitaria')).toBe('modelli.schedaSanitaria')
    expect(chiaveEtichetta('certificato_iscrizione_frequenza')).toBe('modelli.certificatoIscrizioneFrequenza')
    expect(chiaveEtichetta('nulla_osta')).toBe('modelli.nullaOsta')
  })
})

describe('render — i rifiuti che tengono in piedi il foglio', () => {
  it('respinge un modello il cui slug non è nel registro', () => {
    // Il cast è deliberato: dal lato dei tipi questo modello non può esistere, ed è
    // esattamente il caso in cui il cancello a runtime serve — un modello arrivato da un
    // `JSON.parse`, da un test, da un file di un'altra mano.
    const finto = { ...modelloPermessoOrario, slug: 'modulo_inventato' } as unknown as ModelloGenitore<unknown>
    const esito = renderPrestampatoGenitore(finto, DATI, PERMESSO_VALIDO, opzioni({ firma: FIRMA_RACCOLTA }))
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.errori[0].messaggio).toContain('sconosciuto')
      expect(esito.codice).toBe('PRESTAMPATO_SCONOSCIUTO')
    }
  })

  it('non compone niente se le risposte non reggono lo schema', () => {
    const esito = renderPrestampatoGenitore(
      modelloPermessoOrario,
      DATI,
      { giorno: '15/09/2026', tipo: 'entrata_posticipata' },
      opzioni({ firma: FIRMA_RACCOLTA }),
    )
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.errori.map((e) => e.campo)).toContain('giorno')
      // Gli errori di CAMPO non portano un codice di catalogo, e non è una dimenticanza:
      // non c'è una frase sola da tradurre, ce n'è una per campo, e la mostra il form
      // accanto al campo sbagliato.
      expect(esito.codice).toBeUndefined()
    }
  })

  it('un documento della famiglia NON si genera senza la firma raccolta', () => {
    const esito = renderPrestampatoGenitore(modelloPermessoOrario, DATI, PERMESSO_VALIDO, opzioni())
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.errori[0].messaggio).toContain('firma')
      expect(esito.codice).toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    }
  })

  it('una firma monca vale come firma assente', () => {
    const esito = renderPrestampatoGenitore(
      modelloPermessoOrario,
      DATI,
      PERMESSO_VALIDO,
      opzioni({ firma: { ...FIRMA_RACCOLTA, riferimento: '  ' } }),
    )
    expect(esito.ok).toBe(false)
  })

  it('un certificato NON si genera senza il nome del legale rappresentante', () => {
    const esito = renderPrestampatoGenitore(
      modelloCertificatoIscrizioneFrequenza,
      DATI,
      {},
      opzioni({ copiaFamiglia: true }),
    )
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.errori[0].messaggio).toContain('legale rappresentante')
      // Stesso codice della firma OTP mancante: a schermo il fatto è lo stesso — questo
      // foglio non può uscire senza una firma — e chi deve intervenire lo dice il
      // messaggio, che resta diverso.
      expect(esito.codice).toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    }
  })

  it('un documento che esce dalla scuola non può uscire senza dire che cos’è', () => {
    // Né protocollo né dicitura della copia: i due fogli si somigliano e valgono cose
    // diverse (§4.1). Senza questo rifiuto il secondo finisce a un ente al posto del primo.
    const esito = renderPrestampatoGenitore(
      modelloCertificatoIscrizioneFrequenza,
      DATI,
      {},
      opzioni({ legaleRappresentante: LEGALE }),
    )
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.errori[0].messaggio).toContain('protocollato')
      expect(esito.codice).toBe('PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE')
    }
  })

  it('protocollato E copia di famiglia insieme è una contraddizione, non una preferenza', () => {
    const esito = renderPrestampatoGenitore(
      modelloCertificatoIscrizioneFrequenza,
      DATI,
      {},
      opzioni({
        legaleRappresentante: LEGALE,
        copiaFamiglia: true,
        protocollo: { numero: '0000123/2026', data: '14/08/2026' },
      }),
    )
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.errori[0].messaggio).toContain('copia a uso della famiglia')
      expect(esito.codice).toBe('PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE')
    }
  })

  it('sui moduli che NON escono dalla scuola la dicitura della copia si ignora, e il foglio esce', () => {
    // È la forma naturale del pannello della famiglia, che quel flag lo mette sempre:
    // rifiutarlo renderebbe ingenerabili sei moduli su otto.
    const esito = renderPrestampatoGenitore(
      modelloPermessoOrario,
      DATI,
      PERMESSO_VALIDO,
      opzioni({ firma: FIRMA_RACCOLTA, copiaFamiglia: true }),
    )
    expect(esito.ok).toBe(true)
  })

  it('un numero di protocollo su un foglio che non esce dalla scuola è un rifiuto, non un dettaglio', () => {
    const esito = renderPrestampatoGenitore(
      modelloPermessoOrario,
      DATI,
      PERMESSO_VALIDO,
      opzioni({ firma: FIRMA_RACCOLTA, protocollo: { numero: '0000123/2026', data: '14/08/2026' } }),
    )
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.errori[0].messaggio).toContain('protocollo')
      expect(esito.codice).toBe('PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE')
    }
  })

  it('i cinque rifiuti di contesto sono DISTINGUIBILI senza leggere la prosa', () => {
    // È la ragione per cui il codice esiste. Il render conosce cinque motivi diversi di
    // rifiuto; prima uscivano tutti come `{ campo: '', messaggio }`, e la route che deve
    // scegliere fra un 404, un 409 e un 500 non aveva altro appiglio che confrontare
    // frasi italiane. Qui si contano i codici DISTINTI, non i rifiuti: due frasi che
    // collassano sullo stesso codice sono una scelta (firma OTP e legale rappresentante),
    // cinque frasi che collassano su nessun codice erano il difetto.
    const rifiuti = [
      renderPrestampatoGenitore(
        { ...modelloPermessoOrario, slug: 'modulo_inventato' } as unknown as ModelloGenitore<unknown>,
        DATI,
        PERMESSO_VALIDO,
        opzioni({ firma: FIRMA_RACCOLTA }),
      ),
      renderPrestampatoGenitore(modelloPermessoOrario, DATI, PERMESSO_VALIDO, opzioni()),
      renderPrestampatoGenitore(modelloCertificatoIscrizioneFrequenza, DATI, {}, opzioni({ copiaFamiglia: true })),
      renderPrestampatoGenitore(
        modelloCertificatoIscrizioneFrequenza,
        DATI,
        {},
        opzioni({ legaleRappresentante: LEGALE }),
      ),
    ]
    const codici = rifiuti.map((e) => (e.ok ? null : e.codice))
    expect(codici).toEqual([
      'PRESTAMPATO_SCONOSCIUTO',
      'PRESTAMPATO_FIRMA_NON_VALIDA',
      'PRESTAMPATO_FIRMA_NON_VALIDA',
      'PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE',
    ])
    // E ogni codice che esce da qui è dichiarato: un codice inventato dal render sarebbe
    // intraducibile a schermo, cioè ricadrebbe sulla prosa italiana — il difetto che i
    // codici esistono per chiudere. `tsc` lo impedisce già; questa riga lo dice a runtime,
    // dove finiscono anche i valori che un `as` avesse fatto passare.
    for (const codice of new Set(codici)) {
      expect(Object.keys(CODICI_ERRORE), `codice non dichiarato: ${codice}`).toContain(codice)
    }
  })
})

describe('render — i fogli che escono davvero', () => {
  it('il permesso firmato produce un PDF con la sua attestazione di firma', async () => {
    const esito = renderPrestampatoGenitore(
      modelloPermessoOrario,
      DATI,
      PERMESSO_VALIDO,
      opzioni({ firma: FIRMA_RACCOLTA }),
    )
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(new TextDecoder().decode(esito.pdf.slice(0, 5))).toBe('%PDF-')
    expect(esito.blocchiDopoFirmaNonStampati).toBe(0)
    const testo = await estraiTesto(esito.pdf)
    expect(testo).toContain('RICHIESTA DI PERMESSO')
    expect(testo).toContain(FIRMA_RACCOLTA.riferimento)
    expect(testo).not.toContain('Prot. n.')
  })

  it('la copia del genitore porta la dicitura «non protocollata», il certificato protocollato il numero', async () => {
    const copia = renderPrestampatoGenitore(
      modelloCertificatoIscrizioneFrequenza,
      DATI,
      {},
      opzioni({ legaleRappresentante: LEGALE, copiaFamiglia: true }),
    )
    expect(copia.ok).toBe(true)
    if (!copia.ok) return
    const testoCopia = await estraiTesto(copia.pdf)
    expect(testoCopia).toContain('Copia a uso della famiglia')
    expect(testoCopia).not.toContain('Prot. n.')
    // Il nome viene dal parametro, mai dal codice: è il senso del §3b.
    expect(testoCopia).toContain(LEGALE)

    const protocollato = renderPrestampatoGenitore(
      modelloCertificatoIscrizioneFrequenza,
      DATI,
      {},
      opzioni({
        legaleRappresentante: LEGALE,
        protocollo: { numero: '0000123/2026', data: '14/08/2026' },
        indirizzoVerifica: 'esempio.invalid/verifica',
      }),
    )
    expect(protocollato.ok).toBe(true)
    if (!protocollato.ok) return
    const testoProtocollato = await estraiTesto(protocollato.pdf)

    // ⚠️ Il numero c'è, e c'è UNA VOLTA SOLA. L'asserzione che stava qui pretendeva la
    // riga di corpo «Prot. n. 0000123/2026 del 14/08/2026» del §4.1: era giusta finché
    // quella riga era l'unico posto in cui il numero compariva. Sulla carta intestata la
    // segnatura di protocollo si stampa a 34 mm — «SCUOLA … · Prot. n. 0000123/2026 ·
    // Uscita · del 14/08/2026 ore 10:24» — e per un giorno le due cose sono uscite
    // insieme, a diciotto millimetri di distanza, sullo stesso certificato per l'INPS.
    // Ora il corpo tace (`OpzioniStampa.protocolloInSegnatura`) e il numero viaggia nella
    // segnatura, che lo dice per intero e nel posto che il DPR 445 gli assegna.
    expect(testoProtocollato).not.toContain('Prot. n. 0000123/2026 del 14/08/2026')
    // Ma il numero NON sparisce dal foglio: il riquadro di verifica (§4.3) lo porta, ed è
    // la rete che impedisce all'altro difetto — un certificato senza il proprio numero —
    // di prendere il posto di quello appena tolto.
    expect(testoProtocollato).toContain('protocollo n. 0000123/2026 del 14/08/2026')
    expect(testoProtocollato).toContain('esempio.invalid/verifica')
  })

  it('una stampa di sezione esce senza firma e senza protocollo, col titolo che il modello decide', async () => {
    const esito = renderPrestampatoSegreteria(
      modelloStampeSezione,
      PREFILL_SEZIONE,
      { stampa: 'elenco' },
      opzioni(),
    )
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.titolo.length).toBeGreaterThan(0)
    const testo = await estraiTesto(esito.pdf)
    expect(testo).toContain(esito.titolo)
    expect(testo).toContain('Sanniti')
    expect(testo).not.toContain('IL LEGALE RAPPRESENTANTE')
  })

  it('anche dal lato segreteria le risposte si validano PRIMA di comporre', () => {
    const esito = renderPrestampatoSegreteria(
      modelloStampeSezione,
      PREFILL_SEZIONE,
      { stampa: 'elenco_di_fantasia' },
      opzioni(),
    )
    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.errori.map((e) => e.campo)).toContain('stampa')
  })

  it('le risposte VALIDATE escono insieme al PDF, e non quelle grezze', () => {
    // Serve a `expiry_date`: l'`al` del 06 e dell'08, la `validita` del 07. Il render è
    // l'unica strada verso il PDF, quindi senza questo campo la route avrebbe due sole
    // vie — rivalidare per conto suo (due sorgenti di verità sullo stesso dato) o leggere
    // il corpo grezzo e archiviare una scadenza che nessuno ha controllato.
    const genitore = renderPrestampatoGenitore(
      modelloPermessoOrario,
      DATI,
      { ...PERMESSO_VALIDO, motivo: '  visita di controllo  ' },
      opzioni({ firma: FIRMA_RACCOLTA }),
    )
    expect(genitore.ok).toBe(true)
    if (!genitore.ok) return
    expect(genitore.risposte.giorno).toBe('2026-09-15')
    // `zod` ha ripulito il motivo: ciò che esce è il valore accettato, non l'input.
    expect(genitore.risposte.motivo).toBe('visita di controllo')

    const segreteria = renderPrestampatoSegreteria(
      modelloStampeSezione,
      PREFILL_SEZIONE,
      { stampa: 'elenco' },
      opzioni(),
    )
    expect(segreteria.ok).toBe(true)
    if (!segreteria.ok) return
    // I due valori predefiniti dello schema ci sono, e nel corpo della richiesta non
    // c'erano: è la prova che a uscire sono le risposte dopo `safeParse`.
    expect(segreteria.risposte).toEqual({
      stampa: 'elenco',
      ordinamento: 'cognome',
      includi_sospesi: false,
    })
  })

  it('la carta intestata si costruisce dal precompilato, e le righe assenti non lasciano buchi', () => {
    expect(CARTA.intestazione.length).toBeGreaterThan(0)
    expect(CARTA.luogoData).toBe('Cittàfinta, lì 14/08/2026')
    const nuda = cartaDaDati({ ...DATI, sede: {} })
    expect(nuda.intestazione).toEqual([])
    expect(nuda.luogoData).toBe('Lì 14/08/2026')
  })
})

describe('prefill — le parti pure', () => {
  it('il nucleo dei modelli della segreteria si ricava da quello del genitore', () => {
    expect(nucleoAlunno(PREFILL)).toEqual({
      cognome: 'Sanniti',
      nome: 'Nadia',
      dataNascita: '2021-03-14',
      luogoNascita: 'Cittàfinta (XX)',
      codiceFiscale: 'SNNNDA21C54X000Q',
      sezione: 'PRIMAVERA A',
    })
    expect(nucleoSede(PREFILL)).toEqual({
      nome: 'Sede di prova',
      telefono: null,
      codiceMeccanografico: 'XX0A000000',
    })
    expect(nucleoScuola(PREFILL)).toEqual({
      ragioneSociale: 'Cooperativa di prova',
      piva: '00000000000',
      sedeLegale: 'Via Inventata 1 — 80000 Cittàfinta (XX)',
      // ⚠️ `null` DI PROPOSITO, e la riga esiste per impedire che qualcuno «ripari»
      // rimettendoci il codice della sede. `NucleoScuola.codiciMeccanografici` è al
      // plurale e dichiara i codici della COOPERATIVA, che sono tre: riempirlo con quello
      // della sede dell'alunno faceva uscire il certificato di servizio di una dipendente
      // con un codice su tre, su un atto diretto a un ente. Un dato più stretto del
      // proprio significato non si vede — ha l'aria di essere completo — mentre una riga
      // assente si vede subito. Oggi quell'elenco non ha una fonte in configurazione.
      codiciMeccanografici: null,
    })
    // E il codice della sede non è sparito: sta dov'è vero, cioè nella sede.
    expect(nucleoSede(PREFILL).codiceMeccanografico).toBe('XX0A000000')
  })

  it('ciò che manca resta `null`, e non diventa una stringa vuota', () => {
    // Una stringa vuota supererebbe i controlli di presenza dei modelli e finirebbe sul
    // foglio come una riga con l'etichetta e il nulla accanto: il degrado previsto è
    // l'omissione della riga, e a deciderla è `null`.
    const spoglio: PrefillPrestampato = {
      ...PREFILL,
      dati: {
        ...DATI,
        alunno: { nome: 'Nadia', cognome: 'Sanniti' },
        sede: {},
        scuola: {},
      },
    }
    expect(nucleoAlunno(spoglio).codiceFiscale).toBeNull()
    expect(nucleoAlunno(spoglio).luogoNascita).toBeNull()
    expect(nucleoSede(spoglio).codiceMeccanografico).toBeNull()
    expect(nucleoScuola(spoglio).piva).toBeNull()
  })
})

// ─── Le decisioni pure del precompilato ─────────────────────────────────────────
//
// Sei funzioni senza I/O, ognuna delle quali decide qualcosa che finisce STAMPATO: la
// parola accanto al nome di chi firma, il livello che apre o chiude il certificato INPS,
// la parentesi della provincia, il rifiuto che distingue un bambino archiviato da uno
// cancellato. Restavano tutte fuori dalla misura, e una funzione che nessuno misura è una
// funzione che può cambiare comportamento col gate verde.

/** Una riga di `alunni` inventata: nessun bambino vero, nessun codice fiscale vero. */
function rigaAlunno(extra: Partial<RigaAlunno> = {}): RigaAlunno {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    nome: 'Nadia',
    cognome: 'Sanniti',
    data_nascita: '2021-03-14',
    birth_city: 'Cittàfinta',
    birth_province: 'XX',
    codice_fiscale: 'SNNNDA21C54X000Q',
    classe_sezione: 'PRIMAVERA A',
    section_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    scuola_id: '66666666-7777-8888-9999-000000000000',
    stato: STATO_ISCRITTO,
    ...extra,
  }
}

const ALUNNO_ID = '11111111-2222-3333-4444-555555555555'

describe('prefill — la parola stampata accanto al nome di chi firma', () => {
  it('traduce le voci dell’ETL, accetta anche quelle italiane e non indovina il resto', () => {
    expect(ruoloDaRelazione('mother')).toBe('madre')
    expect(ruoloDaRelazione('father')).toBe('padre')
    expect(ruoloDaRelazione('madre')).toBe('madre')
    expect(ruoloDaRelazione('padre')).toBe('padre')
    expect(ruoloDaRelazione('  MOTHER  ')).toBe('madre')
  })

  it('una relazione che non conosce diventa «tutore», non «padre»', () => {
    // Nonni, affidatari, zii: sul foglio «tutore» è vero per tutti e tre, mentre
    // indovinare «padre» su una nonna è un errore che si legge — e che nessuno correggerà,
    // perché il foglio esce già firmato.
    for (const ignota of ['grandmother', 'nonno', 'affidatario', 'guardian', 'xyz']) {
      expect(ruoloDaRelazione(ignota), `relazione ${ignota}`).toBe('tutore')
    }
  })

  it('una relazione ASSENTE è `null`, che non è «tutore»', () => {
    // La differenza conta: `null` fa scrivere l'etichetta neutra «Genitore/Tutore», mentre
    // «tutore» afferma un rapporto giuridico che nessuno ha dichiarato.
    for (const vuota of ['', '   ', null, undefined, 42, {}, []]) {
      expect(ruoloDaRelazione(vuota), `relazione ${JSON.stringify(vuota)}`).toBeNull()
    }
  })
})

describe('prefill — il livello, che sul n. 28 è un cancello', () => {
  it('riconosce i tre gradi del repo, senza badare al maiuscolo', () => {
    expect(livelloDaSezione('nido')).toBe('nido')
    expect(livelloDaSezione('infanzia')).toBe('infanzia')
    expect(livelloDaSezione('primaria')).toBe('primaria')
    expect(livelloDaSezione('  Nido ')).toBe('nido')
  })

  it('tutto il resto è `null`, e non un ripiego su «infanzia»', () => {
    // `null` chiude il certificato per il Bonus Asilo Nido (il modello rifiuta un livello
    // ignoto) e toglie la riga «Livello» dal 26·27. Un ripiego lo farebbe uscire con una
    // dichiarazione che nessuno ha verificato, su un foglio diretto all'INPS.
    for (const ignoto of ['primavera', 'sezione primavera', 'materna', '', '   ', null, undefined]) {
      expect(livelloDaSezione(ignoto), `school_type ${String(ignoto)}`).toBeNull()
    }
  })
})

describe('prefill — l’alunno che finisce sul foglio', () => {
  it('compone luogo di nascita, sezione e livello dalle due righe', () => {
    expect(componiAlunno(rigaAlunno(), { name: 'PRIMAVERA A', school_type: 'nido' })).toEqual({
      nome: 'Nadia',
      cognome: 'Sanniti',
      dataNascita: '2021-03-14',
      luogoNascita: 'Cittàfinta (XX)',
      codiceFiscale: 'SNNNDA21C54X000Q',
      sezione: 'PRIMAVERA A',
      livello: 'nido',
      genitoriSeparati: null,
    })
  })

  it('senza provincia resta la sola città: mai una parentesi vuota', () => {
    // «Cittàfinta ()» su un certificato si legge come un dato perso, e chi lo riceve non
    // sa se manca la provincia o se il documento è stato compilato male.
    const senzaProvincia = componiAlunno(rigaAlunno({ birth_province: null }), null)
    expect(senzaProvincia.luogoNascita).toBe('Cittàfinta')
    const senzaCitta = componiAlunno(rigaAlunno({ birth_city: null, birth_province: 'XX' }), null)
    expect(senzaCitta.luogoNascita).toBe('XX')
    const senzaNiente = componiAlunno(rigaAlunno({ birth_city: null, birth_province: null }), null)
    expect(senzaNiente.luogoNascita).toBeNull()
  })

  it('la sezione stampata è `classe_sezione`; `sections.name` è il ripiego', () => {
    // `classe_sezione` è la colonna che la segreteria corregge: se le due divergono, sul
    // foglio va quella che qualcuno ha scritto a mano, non quella dedotta dalla tabella.
    const conEntrambe = componiAlunno(rigaAlunno(), { name: 'ALTRA', school_type: 'nido' })
    expect(conEntrambe.sezione).toBe('PRIMAVERA A')
    const soloTabella = componiAlunno(rigaAlunno({ classe_sezione: '  ' }), {
      name: 'ALTRA',
      school_type: null,
    })
    expect(soloTabella.sezione).toBe('ALTRA')
    expect(soloTabella.livello).toBeNull()
    const nessuna = componiAlunno(rigaAlunno({ classe_sezione: null }), null)
    expect(nessuna.sezione).toBeNull()
  })

  it('i campi vuoti restano `null`, e nome e cognome restano stringhe', () => {
    const spoglio = componiAlunno(
      rigaAlunno({ nome: null, cognome: null, codice_fiscale: '   ', data_nascita: null }),
      null,
    )
    expect(spoglio.nome).toBe('')
    expect(spoglio.cognome).toBe('')
    // Stringa vuota → `null`: una stringa vuota supererebbe i controlli di presenza dei
    // modelli e finirebbe sul foglio come un'etichetta col nulla accanto.
    expect(spoglio.codiceFiscale).toBeNull()
    expect(spoglio.dataNascita).toBeNull()
  })

  it('`genitori_separati` passa così com’è: è il cancello della doppia firma dell’08', () => {
    expect(componiAlunno(rigaAlunno({ genitori_separati: true }), null).genitoriSeparati).toBe(true)
    expect(componiAlunno(rigaAlunno({ genitori_separati: false }), null).genitoriSeparati).toBe(false)
    // ⚠️ `null` e non `false`: sul DB della CI la colonna può non esistere, e «non lo so»
    // non è «non sono separati».
    expect(componiAlunno(rigaAlunno(), null).genitoriSeparati).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LA RAGIONE SOCIALE NON È IL NOME DELLA STRUTTURA
//
// `componiScuola` prendeva `scuole.config.anagrafica.denominazione` come PRIMA
// scelta per la ragione sociale dell'ente gestore. Reggeva finché quel campo era
// vuoto su tre sedi su quattro e il ripiego su `fiscale_config` faceva il lavoro.
//
// Il 2026-08-16 la spec §2.1 ha riempito quel campo con «Kidville Giugliano /
// Aversa / Cesa» — il nome del plesso, che serve alla testata e alla casella
// «Sede del Nido» — e il blocco DATI IDENTIFICATIVI DELLA SCUOLA ha cominciato a
// stampare:
//
//   Denominazione: Kidville Giugliano · P.IVA/C.F.: 03394870616
//   Sede legale: Via Silvio Pellico 7 — 81030 Cesa (CE)
//
// cioè un nome commerciale accostato alla P.IVA e alla sede legale della
// cooperativa, su un foglio firmato dal legale rappresentante — mentre il piede
// della carta intestata, sulla STESSA pagina, diceva «Ragione sociale: Scuola
// dell'infanzia la favola soc. coop.». E la riga sotto il titolo balbettava:
// «Kidville Giugliano – Kidville (Nido · Infanzia · Primaria)».
//
// I due concetti sono due, e da qui in avanti hanno due sorgenti: il nome della
// struttura sta in `DatiSede.scuola_nome`, la ragione sociale in `fiscale_config`.
// `componiScuola` non riceve più il nome della sede: non è una precedenza da
// invertire, è un parametro che non deve esistere — altrimenti torna a vincere il
// giorno in cui `fiscale_config` è vuota su una sede nuova, e ci torna in silenzio.
// ─────────────────────────────────────────────────────────────────────────────
describe('prefill — l’ente gestore, che non è il nome della struttura', () => {
  it('la ragione sociale viene dalla configurazione fiscale, non dal nome del plesso', () => {
    const scuola = componiScuola('11111111111', {
      denominazione: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
      piva: '22222222222',
      indirizzo: 'Via Inventata',
      numero_civico: '1',
      cap: '80000',
      comune: 'Cittàfinta',
      provincia: 'xx',
    })
    expect(scuola.ragioneSociale).toBe("SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA")
    // La P.IVA della sede resta una precedenza legittima: è lo STESSO ente, e
    // `anagrafica.piva_cf` è dichiarata «P.IVA / CF ente gestore».
    expect(scuola.piva).toBe('11111111111')
    // ⚠️ UN TRATTINO SOLO, e prima erano due: «80000 Cittàfinta — (XX)».
    //
    // Le tre parti si univano tutte con ` — `, quindi la sigla di provincia si
    // staccava dal comune a cui appartiene. Sul certificato Bonus Nido generato
    // con i dati veri usciva «Sede legale: Via Silvio Pellico 7 — 81030 Cesa —
    // (CE)», due centimetri sopra «Sede operativa del Nido: … 81030 Cesa (CE)»,
    // scritta bene: due righe della stessa pagina che compongono lo stesso
    // indirizzo in due modi. Ora la riga la costruisce `componiIndirizzoSede`,
    // che è l'unico posto in cui `via — CAP CITTÀ (PROV)` si compone.
    expect(scuola.sedeLegale).toBe('Via Inventata 1 — 80000 Cittàfinta (XX)')
    // Il nome di chi firma NON sta qui: lo porta `legaleRappresentante` e lo consuma il
    // blocco firma. Due sorgenti per lo stesso nome sullo stesso foglio sarebbero una di
    // troppo.
    expect(scuola.legaleRappresentante).toBeNull()
  })

  it('senza configurazione fiscale la riga sparisce: non ripiega sul nome della sede', () => {
    // Il degrado giusto è l'omissione. Stampare «Kidville Aversa» accanto alla P.IVA
    // della cooperativa è un'attestazione sbagliata su un documento firmato, e — a
    // differenza di una riga che manca — ha l'aria di essere completa.
    const scuola = componiScuola('03394870616', {})
    expect(scuola.ragioneSociale).toBeNull()
    expect(scuola.piva).toBe('03394870616')
  })

  it('il codice fiscale è il terzo ripiego della P.IVA', () => {
    const scuola = componiScuola(null, {
      denominazione: 'Cooperativa dal fiscale',
      codice_fiscale: '33333333333',
    })
    expect(scuola.ragioneSociale).toBe('Cooperativa dal fiscale')
    // Una cooperativa che non ha la seconda ha comunque il primo, e su un certificato
    // serve un identificativo.
    expect(scuola.piva).toBe('33333333333')
    expect(scuola.sedeLegale).toBeNull()
  })

  it('senza niente non inventa: quattro `null` e quattro righe che spariscono', () => {
    expect(componiScuola(null, {})).toEqual({
      ragioneSociale: null,
      piva: null,
      sedeLegale: null,
      legaleRappresentante: null,
    })
  })
})

describe('prefill — gli estremi dell’autorizzazione del nido (JSONB non tipizzato)', () => {
  const config = (autorizzazione: unknown) => ({ anagrafica: { autorizzazione_nido: autorizzazione } })

  it('legge i tre pezzi quando ci sono', () => {
    expect(
      leggiAutorizzazioneNido(config({ numero: '123', data: '2024-09-01', ente: 'Comune di Cittàfinta' })),
    ).toEqual({ numero: '123', data: '2024-09-01', ente: 'Comune di Cittàfinta' })
  })

  it('la chiave vecchia `comune` si legge ancora, e finisce in `ente`', () => {
    // ⚠️ NON è cortesia verso il passato. Al momento della rinomina (2026-08-16) le tre
    // sedi di produzione avevano l'autorizzazione salvata sotto `comune`: senza questo
    // ripiego il certificato per il Bonus Nido sarebbe sparito su tutte e tre nello
    // stesso istante, e sarebbe tornato solo dopo che qualcuno avesse riaperto e
    // risalvato il form — cioè dopo che una famiglia se n'era accorta allo sportello.
    expect(
      leggiAutorizzazioneNido(config({ numero: '102A', data: '2025-10-29', comune: 'Comune di Giugliano in Campania' })),
    ).toEqual({ numero: '102A', data: '2025-10-29', ente: 'Comune di Giugliano in Campania' })
    // Con entrambe vince il nome nuovo: è quello che il form manda.
    expect(leggiAutorizzazioneNido(config({ ente: 'Ambito C06', comune: 'Aversa' }))?.ente).toBe('Ambito C06')
  })

  it('con UN pezzo solo restituisce comunque l’oggetto: gli altri due li nega il modello', () => {
    // Il degrado non sta qui: il n. 28 pretende tutti e tre e rifiuta di emettere il
    // certificato. Se questa funzione restituisse `null` con due pezzi su tre, il modello
    // direbbe «autorizzazione assente» invece di «autorizzazione incompleta», e in
    // segreteria si cercherebbe la cosa sbagliata.
    expect(leggiAutorizzazioneNido(config({ numero: '123' }))).toEqual({
      numero: '123',
      data: null,
      ente: null,
    })
  })

  it('con zero pezzi utili è `null`, non un oggetto di `null`', () => {
    for (const vuota of [
      config({}),
      config({ numero: '   ', data: '', ente: null }),
      config({ numero: '   ', data: '', comune: '  ' }),
      config({ numero: 42, data: true }),
      config(null),
      config('non un oggetto'),
      { anagrafica: {} },
      {},
      null,
      undefined,
      'stringa',
    ]) {
      expect(leggiAutorizzazioneNido(vuota), JSON.stringify(vuota)).toBeNull()
    }
  })
})

describe('prefill — i due stati in cui il foglio NON si stampa', () => {
  it('un bambino iscritto si stampa, e un bambino SOSPESO pure', () => {
    expect(alunnoNonStampabile(rigaAlunno(), ALUNNO_ID)).toBeNull()
    // «Sospeso» sta dalla parte protetta del confine (`src/lib/alunni/stato.ts`): frequenta
    // ancora, e negargli un certificato di frequenza sarebbe negarglielo per una pratica
    // amministrativa ferma. È lo stesso confine su cui, il 2026-08-12, un bambino soltanto
    // sospeso era finito fra i candidati all'anonimizzazione.
    expect(alunnoNonStampabile(rigaAlunno({ stato: STATO_SOSPESO }), ALUNNO_ID)).toBeNull()
  })

  it('un bambino ARCHIVIATO ottiene un 409 che dice come si sblocca', async () => {
    const res = alunnoNonStampabile(rigaAlunno({ stato: STATO_RITIRATO }), ALUNNO_ID)
    expect(res).not.toBeNull()
    expect(res?.status).toBe(409)
    const corpo = await res!.json()
    expect(corpo.codice).toBe('PRESTAMPATO_ALUNNO_NON_ISCRITTO')
    expect(corpo.error).toContain('riportalo fra gli iscritti')
  })

  it('un bambino ANONIMIZZATO ottiene un codice DIVERSO, perché non c’è rimedio', async () => {
    // Stesso status, due codici: lì il rimedio è a un click, qui non esiste e non
    // esisterà. Mandare qualcuno a «riportare fra gli iscritti» un bambino cancellato è
    // mandarlo a cercare un bottone che non c'è.
    const res = alunnoNonStampabile(rigaAlunno({ anonimizzato_il: '2026-08-01T10:00:00Z' }), ALUNNO_ID)
    expect(res?.status).toBe(409)
    const corpo = await res!.json()
    expect(corpo.codice).toBe('PRESTAMPATO_ALUNNO_ANONIMIZZATO')
    expect(corpo.error).not.toContain('riportalo')
  })

  it('anonimizzato E archiviato insieme: vince l’anonimizzato', async () => {
    // È l'ordine reale delle cose — si archivia e poi si anonimizza — e l'ordine dei due
    // controlli è ciò che decide quale frase legge la segretaria. Invertito, manderebbe a
    // riattivare un bambino la cui anagrafica non esiste più.
    const res = alunnoNonStampabile(
      rigaAlunno({ stato: STATO_RITIRATO, anonimizzato_il: '2026-08-01T10:00:00Z' }),
      ALUNNO_ID,
    )
    const corpo = await res!.json()
    expect(corpo.codice).toBe('PRESTAMPATO_ALUNNO_ANONIMIZZATO')
  })

  it('i due codici sono dichiarati e quindi traducibili', () => {
    expect(Object.keys(CODICI_ERRORE)).toContain('PRESTAMPATO_ALUNNO_NON_ISCRITTO')
    expect(Object.keys(CODICI_ERRORE)).toContain('PRESTAMPATO_ALUNNO_ANONIMIZZATO')
    // Il 404 del self-service è il terzo: la famiglia non ha una postazione da ricaricare.
    expect(Object.keys(CODICI_ERRORE)).toContain('PRESTAMPATO_ALUNNO_NON_TROVATO')
  })
})
