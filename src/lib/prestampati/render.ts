/**
 * IL RENDER — modello + precompilato + risposte → i byte del PDF.
 *
 * È l'unico punto in cui le tre cose si incontrano, e l'unico che conosce il motore
 * (`impaginazione.ts`). Sopra c'è la route, che protocolla, archivia e firma; sotto ci
 * sono i modelli, che sono puri e non hanno mai visto un byte di jsPDF.
 *
 * ─── DUE PORTE, E NON UNA, FINCHÉ I CONTRATTI SONO DUE ──────────────────────────
 *
 * `modelli/genitore.ts` e `modelli/segreteria.ts` dichiarano due `ModelloPrestampato`
 * diversi: di là `componi` valida e compone in un colpo solo (ed è il cancello che
 * impedisce di comporre risposte non validate), di qua il titolo è una FUNZIONE delle
 * risposte, c'è un piede alternativo e ci sono i blocchi dopo la firma. Il debito è
 * dichiarato nelle testate dei due file e non si paga qui.
 *
 * Perciò due funzioni, `renderPrestampatoGenitore` e `renderPrestampatoSegreteria`,
 * ognuna TIPIZZATA sul proprio modello: chi chiama passa il modello importato per nome e
 * `tsc` verifica che il precompilato sia quello giusto. **Nessun cast, nessun `unknown`
 * che attraversa il confine**: una firma unica sui diciassette avrebbe richiesto di
 * appiattire nove tipi di precompilato a `unknown` e di riabbassarli con un `as` — cioè
 * di spostare un errore da `tsc` a un PDF che esce con i campi di un altro modello.
 *
 * Ciò che le due porte condividono — la carta intestata, il protocollo, il blocco firma,
 * il riquadro di verifica, i rifiuti — vive in `assembla()`, in un posto solo.
 *
 * ─── COSA NON C'È NEI LOG ───────────────────────────────────────────────────────
 *
 * Le risposte NON si loggano, mai: fra i diciassette ci sono la scheda sanitaria, i
 * farmaci, la dieta e il verbale di infortunio, cioè dati dell'art. 9 GDPR di un minore.
 * Nelle righe di questo file ci sono lo slug (un enumerato), i conteggi e l'esito. Non
 * c'è nemmeno il nome del bambino: lo scrive il PDF, che è il posto giusto.
 */

import { buildPrestampatoPdf } from '@/lib/prestampati/impaginazione'
import {
  intestazionePrestampato,
  luogoDataPrestampato,
  type DatiPrestampato,
  type ErroreCampo,
  type ModelloPrestampato as ModelloGenitore,
} from '@/lib/prestampati/modelli/genitore'
import type { ModelloPrestampato as ModelloSegreteria } from '@/lib/prestampati/modelli/segreteria'
import { bloccoFirma, prestampato, type VocePrestampato } from '@/lib/prestampati/registro'
import type {
  BloccoPrestampato,
  DocumentoPrestampato,
  FirmaPrestampato,
  VerificaPrestampato,
} from '@/lib/prestampati/tipi'
import type { CodiceErrore } from '@/lib/ui/esito-fetch'
import { logEvento } from '@/lib/logging/logger'

// ─── Ciò che la route porta con sé ──────────────────────────────────────────────

/**
 * La carta: le righe di intestazione della sede e la riga «Luogo e data».
 *
 * Si costruisce con `cartaDaDati()` dal precompilato, che è lo stesso per tutti e
 * diciassette — anche per i nove modelli della segreteria, il cui precompilato non porta
 * la sede in una forma che il motore sappia leggere.
 */
export interface CartaPrestampato {
  intestazione: string[]
  luogoData: string
}

/** La carta di un foglio, dalle stesse funzioni dei certificati già in produzione. */
export function cartaDaDati(dati: DatiPrestampato): CartaPrestampato {
  return {
    intestazione: intestazionePrestampato(dati),
    luogoData: luogoDataPrestampato(dati),
  }
}

/** Il numero consumato dal registro di sede (§4.1), già formattato dal chiamante. */
export interface ProtocolloRender {
  /** `0000123/2026`, come lo scrive `protocolli`. */
  numero: string
  /** `13/08/2026`. */
  data: string
}

/** La firma OTP già raccolta (§3a). Email e indirizzo IP NON entrano qui: sono della ricevuta FEA. */
export interface FirmaRaccolta {
  firmatario: string
  /** Già formattato per la stampa: `13/08/2026 alle 10:24`. */
  istante: string
  /** `Codice OTP verificato`, o come lo chiama il flusso che l'ha raccolta. */
  metodo: string
  /** L'identificativo della ricevuta FEA, mai l'hash dell'OTP. */
  riferimento: string
}

export interface OpzioniRender {
  carta: CartaPrestampato
  /**
   * Il protocollo, quando il documento lo emette la segreteria. **Arriva da fuori**: il
   * render non consuma numerazione e non sa cosa sia `protocolli_numerazione` — un
   * generatore di PDF che prendesse un numero di protocollo da sé ne brucerebbe uno a
   * ogni anteprima.
   */
  protocollo?: ProtocolloRender | null
  /**
   * La copia che il genitore si scarica da sé: al posto del protocollo va la dicitura
   * «Copia a uso della famiglia — non protocollata» (§4.1). Due fogli che si somigliano
   * ma valgono cose diverse devono dirlo, o il primo finisce a un ente al posto del
   * secondo.
   */
  copiaFamiglia?: boolean
  /**
   * Il nome sotto «IL LEGALE RAPPRESENTANTE» (§3b). **Arriva da fuori**, e non è cablato
   * da nessuna parte: il repository è pubblico e il CdA cambia. Lo legge
   * `prefill.legaleRappresentante` da `scuole.config.anagrafica`.
   */
  legaleRappresentante?: string | null
  /** La firma OTP già raccolta, per i modelli che la pretendono. */
  firma?: FirmaRaccolta | null
  /**
   * L'indirizzo del riquadro di verifica (§4.3). Assente, si compone da
   * `NEXT_PUBLIC_APP_URL`; assente anche quella, il riquadro non si stampa e la
   * configurazione mancante viene loggata a livello `error` (AGENTS.md §4).
   */
  indirizzoVerifica?: string | null
}

/**
 * Un rifiuto del render.
 *
 * ⚠️ `codice` È LA PARTE CHE SERVE A CHI CHIAMA, e prima non c'era: i cinque rifiuti di
 * contesto uscivano tutti come `{ campo: '', messaggio }`, cioè come prosa italiana
 * indistinguibile. La route che li riceve deve scegliere uno status e un `codice` — il
 * lock `__tests__/architecture/errori-con-codice.test.ts` glielo impone, e vieta una
 * risposta nuova senza codice in un file nuovo — e l'unico appiglio che il render le
 * lasciava era il confronto fra stringhe. Un `includes('firma')` che decide se rispondere
 * 409 o 500 è un difetto che nessun test vede: la frase si riscrive, il codice no.
 *
 * Assente sui rifiuti di CAMPO (`campo` valorizzato): quelli sono l'esito di `zod` sul
 * modulo, li mostra il form accanto al campo sbagliato, e non hanno un codice di catalogo
 * perché non c'è una frase sola da tradurre — ce n'è una per campo.
 */
export interface RifiutoRender {
  ok: false
  errori: ErroreCampo[]
  codice?: CodiceErrore
}

/**
 * `R` sono le RISPOSTE VALIDATE, restituite sul ramo riuscito.
 *
 * Non è una comodità: `expiry_date` di `student_documents` si ricava dall'`al` del 06 e
 * dell'08 e dalla `validita` del 07, e il render è l'unica strada verso il PDF. Senza
 * questo campo la route avrebbe due sole vie, entrambe difettose — rivalidare le risposte
 * per conto suo (due sorgenti di verità sullo stesso dato, che divergono al primo schema
 * modificato) oppure leggere `al` dal corpo grezzo e archiviare una scadenza che nessuno
 * ha controllato. `modelli/genitore.ts` porta già `risposte` sul proprio esito di
 * composizione, e qui veniva scartato.
 */
export type EsitoRender<R = unknown> =
  | {
      ok: true
      pdf: Uint8Array
      /** Il titolo stampato in testa: serve al nome del file e all'oggetto del protocollo. */
      titolo: string
      /** Le risposte come lo schema del modello le ha accettate, non le grezze. */
      risposte: R
      /**
       * Quanti blocchi il modello produceva DOPO la firma e il motore non ha stampato.
       *
       * Oggi può essere solo 0 o il tagliando del n. 31: `DocumentoPrestampato` non ha il
       * campo gemello di `blocchiDopoFirma` e `buildPrestampatoPdf` disegna la firma per
       * ultima. Non si aggiungono in fondo ai blocchi normali, e non è pigrizia: la
       * lettera uscirebbe con la firma del legale rappresentante SOTTO la linea di
       * taglio, e chi ritaglia il tagliando per rispedirlo si porterebbe via la firma.
       *
       * Un numero maggiore di zero significa «foglio incompleto, non sbagliato»: la
       * route che lo riceve non lo dichiari «completo» e lo logghi. È un numero, quindi
       * passa la lista bianca di `redact` e si può contare in SQL.
       */
      blocchiDopoFirmaNonStampati: number
    }
  | RifiutoRender

/**
 * Un rifiuto che non riguarda un campo del modulo ma il CONTESTO della generazione.
 *
 * Il codice viene prima del messaggio nella firma, e non è estetica: è l'informazione che
 * chi chiama consuma davvero, e metterla per seconda l'avrebbe resa la cosa facile da
 * dimenticare in un `rifiuto('…')` scritto di fretta. Qui non si può: `tsc` non compila.
 */
function rifiuto(codice: CodiceErrore, messaggio: string): RifiutoRender {
  return { ok: false, errori: [{ campo: '', messaggio }], codice }
}

// ─── Le due porte ───────────────────────────────────────────────────────────────

/**
 * Gli otto della famiglia (05…10, 26·27, 28).
 *
 * `modello.componi()` valida E compone: i due passi non si separano di proposito — un
 * documento composto da risposte non validate è un foglio firmato che dichiara cose che
 * nessuno ha controllato.
 */
export function renderPrestampatoGenitore<R>(
  modello: ModelloGenitore<R>,
  dati: DatiPrestampato,
  risposteGrezze: unknown,
  opzioni: OpzioniRender,
): EsitoRender<R> {
  const voce = prestampato(modello.slug)
  if (!voce) return rifiuto('PRESTAMPATO_SCONOSCIUTO', `Prestampato sconosciuto: ${modello.slug}`)

  const composto = modello.componi(dati, risposteGrezze)
  // Errori di CAMPO: niente `codice`, e il commento di `RifiutoRender` dice perché.
  if (!composto.ok) return { ok: false, errori: composto.errori }

  return assembla(voce, modello.titolo, composto.blocchi, composto.risposte, opzioni, {
    blocchiDopoFirma: 0,
  })
}

/**
 * I nove della segreteria e delle insegnanti (30…50).
 *
 * Qui la validazione è un passo a sé perché il contratto di là la tiene fuori da
 * `componi`, e va fatta lo stesso e prima: `componi` di quei modelli si fida delle
 * risposte, e con un `mese` malformato comporrebbe una griglia di giorni inventata.
 */
export function renderPrestampatoSegreteria<P, R>(
  modello: ModelloSegreteria<P, R>,
  prefill: P,
  risposteGrezze: unknown,
  opzioni: OpzioniRender,
): EsitoRender<R> {
  const voce = prestampato(modello.slug)
  if (!voce) return rifiuto('PRESTAMPATO_SCONOSCIUTO', `Prestampato sconosciuto: ${modello.slug}`)

  const esito = modello.schema.safeParse(risposteGrezze)
  if (!esito.success) {
    return {
      ok: false,
      errori: esito.error.issues.map((problema) => ({
        campo: problema.path.join('.'),
        messaggio: problema.message,
      })),
    }
  }

  const risposte = esito.data
  const dopoFirma = modello.blocchiDopoFirma?.(prefill, risposte) ?? []
  return assembla(
    voce,
    modello.titolo(prefill, risposte),
    modello.componi(prefill, risposte),
    risposte,
    opzioni,
    {
      blocchiDopoFirma: dopoFirma.length,
      piePagina: modello.piePagina?.(prefill, risposte),
    },
  )
}

// ─── Il pezzo comune ────────────────────────────────────────────────────────────

interface Extra {
  blocchiDopoFirma: number
  piePagina?: string
}

function assembla<R>(
  voce: VocePrestampato,
  titolo: string,
  blocchi: BloccoPrestampato[],
  risposte: R,
  opzioni: OpzioniRender,
  extra: Extra,
): EsitoRender<R> {
  const firma = componiFirma(voce, opzioni)
  if ('messaggio' in firma) return rifiuto(firma.codice, firma.messaggio)

  const testata = componiTestata(voce, opzioni)
  if ('messaggio' in testata) return rifiuto(testata.codice, testata.messaggio)

  const documento: DocumentoPrestampato = {
    intestazione: opzioni.carta.intestazione,
    titolo,
    protocollo: testata.riga,
    blocchi,
    luogoData: opzioni.carta.luogoData,
    firma: firma.blocco,
    verifica: testata.verifica,
    ...(extra.piePagina ? { piePagina: extra.piePagina } : {}),
  }

  let pdf: Uint8Array
  try {
    // ⚠️ UNA SOLA SEDE PER IL NUMERO DI PROTOCOLLO. Un documento protocollato riceve la
    // segnatura sulla carta intestata — «SCUOLA … · Prot. n. 0000123/2026 · Uscita · del
    // 15/08/2026 ore 10:24», a 34 mm — e allora la riga di corpo del §4.1 tace: per un
    // giorno ci sono state tutte e due, a diciotto millimetri di distanza, sul certificato
    // che va all'INPS e al datore di lavoro. Il flag NON tocca «Copia a uso della famiglia
    // — non protocollata», che passa dallo stesso campo ma non è un numero.
    pdf = buildPrestampatoPdf(documento, { protocolloInSegnatura: Boolean(opzioni.protocollo) })
  } catch (err) {
    // jsPDF lancia per davvero (un'immagine illeggibile, un font mancante), e senza
    // questo ramo l'eccezione risalirebbe alla route come 500 nudo. Nel log lo slug e il
    // numero di blocchi: mai le risposte, che qui dentro possono essere una diagnosi.
    logEvento('modulistica', 'error', {
      operazione: 'prestampati/render',
      esito: 'pdf-non-generato',
      tipo: voce.slug,
      n: blocchi.length,
    }, err)
    return rifiuto('PRESTAMPATO_NON_GENERATO', 'Non è stato possibile generare il documento.')
  }

  if (extra.blocchiDopoFirma > 0) {
    // `warn` → persistito: è l'unico segnale che quel foglio è uscito incompleto, e
    // nessuno se ne accorgerebbe guardando il PDF — manca una parte che il destinatario
    // si aspetta, non una parte che il mittente vede.
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/render',
      esito: 'blocchi-dopo-firma-non-stampati',
      tipo: voce.slug,
      n: extra.blocchiDopoFirma,
    })
  }

  return { ok: true, pdf, titolo, risposte, blocchiDopoFirmaNonStampati: extra.blocchiDopoFirma }
}

/**
 * Il blocco di firma, e i due soli casi in cui il render RIFIUTA invece di degradare.
 *
 * Ovunque altrove un dato che manca fa sparire una riga. Qui no, e la differenza è il
 * §3 della specifica: il blocco di firma dice **chi risponde di quel foglio**.
 *
 *  · un documento della famiglia SENZA la firma raccolta non è un modulo da firmare a
 *    penna: è un foglio che attesta una firma elettronica che nessuno ha apposto;
 *  · un certificato per l'INPS senza il nome del legale rappresentante esce con la
 *    dicitura del D.Lgs 39/93 sopra il vuoto — cioè dichiara che la firma autografa è
 *    «sostituita a mezzo stampa» dal nominativo di nessuno.
 *
 * Il motore sa già lasciare il vuoto invece di stampare una riga bianca che sembri un
 * nome (`disegnaFirma`), e il suo commento dice dove sta il rifiuto vero: qui.
 *
 * I due rifiuti portano lo STESSO codice, `PRESTAMPATO_FIRMA_NON_VALIDA`, ed è una scelta
 * dichiarata in `esito-fetch.ts`: a schermo il fatto è lo stesso — «questo foglio non può
 * uscire senza una firma» — e la differenza è in chi deve intervenire, che il messaggio
 * dice e la frase tradotta no.
 */
function componiFirma(
  voce: VocePrestampato,
  opzioni: OpzioniRender,
): { blocco: FirmaPrestampato } | { codice: CodiceErrore; messaggio: string } {
  const tipo = bloccoFirma(voce.firma)

  if (tipo === 'legaleRappresentante') {
    const nome = opzioni.legaleRappresentante?.trim()
    if (!nome) {
      return {
        codice: 'PRESTAMPATO_FIRMA_NON_VALIDA',
        messaggio:
          'Manca il nome del legale rappresentante nella configurazione della sede: senza, il documento uscirebbe firmato da nessuno.',
      }
    }
    return { blocco: { tipo: 'legaleRappresentante', nome } }
  }

  if (tipo === 'genitore') {
    const f = opzioni.firma
    if (!f?.firmatario.trim() || !f.istante.trim() || !f.riferimento.trim()) {
      return {
        codice: 'PRESTAMPATO_FIRMA_NON_VALIDA',
        messaggio:
          'La firma non risulta raccolta: il documento attesta una firma elettronica e non si genera prima di averla.',
      }
    }
    return {
      blocco: {
        tipo: 'genitore',
        firmatario: f.firmatario.trim(),
        istante: f.istante.trim(),
        metodo: f.metodo.trim(),
        riferimento: f.riferimento.trim(),
      },
    }
  }

  return { blocco: { tipo: 'nessuna' } }
}

/**
 * La riga sopra il titolo e il riquadro di verifica in fondo (§4).
 *
 * Sui sei fogli che escono dalla scuola una delle due cose è OBBLIGATORIA — il numero di
 * protocollo oppure la dicitura della copia di famiglia — e il rifiuto è la ragione per
 * cui questa funzione può fallire: un certificato senza né l'uno né l'altra è
 * indistinguibile a occhio da quello protocollato, e finisce a un ente al posto suo.
 *
 * Tutti e tre i rifiuti portano `PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE` e NON
 * `PRESTAMPATO_DATI_MANCANTI`, che pure avrebbe lo status giusto: quello manda a
 * completare l'anagrafica, e qui in anagrafica non manca niente — è chi chiama che non ha
 * detto quale dei due fogli sta generando. Mandare una segretaria a cercare un dato che
 * c'è già è il modo più caro di dire «riprova».
 */
function componiTestata(
  voce: VocePrestampato,
  opzioni: OpzioniRender,
):
  | { riga: string | null; verifica: VerificaPrestampato | null }
  | { codice: CodiceErrore; messaggio: string } {
  const protocollo = opzioni.protocollo

  if (voce.protocollo === 'nessuno') {
    if (protocollo) {
      // Non si ignora in silenzio: un chiamante che passa un numero su un foglio che non
      // esce dalla scuola ha consumato numerazione per niente, e crede di averla usata.
      return {
        codice: 'PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE',
        messaggio: 'Questo prestampato non esce dalla scuola e non consuma un numero di protocollo.',
      }
    }
    // `copiaFamiglia` qui si IGNORA, e non è una svista: la dicitura esiste per
    // distinguere due fogli che si somigliano (§4.1), e su un modulo che non esce dalla
    // scuola non c'è nessun gemello protocollato da cui distinguerlo. Rifiutare
    // renderebbe impossibile la forma naturale del pannello della famiglia, che quel
    // flag lo mette sempre e vale davvero solo sui due certificati.
    return { riga: null, verifica: null }
  }

  if (protocollo) {
    if (opzioni.copiaFamiglia) {
      // Le due cose si escludono: o il foglio è nel registro di protocollo, o è la copia
      // che il genitore si è scaricato. Un documento che dicesse tutte e due sarebbe
      // proprio l'ambiguità che la dicitura esiste per togliere.
      return {
        codice: 'PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE',
        messaggio:
          'Un documento protocollato non è una copia a uso della famiglia: scegli l’una o l’altra cosa.',
      }
    }
    const numero = protocollo.numero.trim()
    const data = protocollo.data.trim()
    if (!numero || !data) {
      return {
        codice: 'PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE',
        messaggio: 'Numero o data di protocollo mancanti.',
      }
    }
    return {
      riga: `Prot. n. ${numero} del ${data}`,
      verifica: componiVerifica(voce, numero, data, opzioni.indirizzoVerifica),
    }
  }

  if (opzioni.copiaFamiglia) {
    return { riga: 'Copia a uso della famiglia — non protocollata', verifica: null }
  }

  return {
    codice: 'PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE',
    messaggio:
      'Questo documento esce dalla scuola: va protocollato, oppure marcato come copia a uso della famiglia.',
  }
}

/**
 * Il riquadro di verifica, o `null` quando non si sa a quale indirizzo mandare chi riceve
 * il documento.
 *
 * ⚠️ Configurazione mancante = livello `error` (AGENTS.md §4), non una nota a piè di
 * pagina: senza `NEXT_PUBLIC_APP_URL` il certificato esce PRIVO del terzo dei tre presidi
 * che lo reggono (§4.4) — la formula del D.Lgs 39/93 e il numero di protocollo restano,
 * la verificabilità no — e nessuno se ne accorge guardandolo, perché un riquadro assente
 * non somiglia a un errore.
 *
 * Il ripiego è NON stamparlo. L'alternativa sarebbe stampare un indirizzo cablato qui:
 * un dominio scritto in un `.ts` è un dominio che un giorno manderà a una pagina che non
 * esiste chi tiene in mano un certificato.
 *
 * ─── 🔴 LA PAGINA `/verifica` OGGI NON ESISTE, ED È UNA DIPENDENZA APERTA ────────
 *
 * `${NEXT_PUBLIC_APP_URL}/verifica` è ciò che il motore stampa sotto «Verificabile su …
 * indicando il numero di protocollo» (`impaginazione.ts`), sui sei fogli che escono verso
 * un ente. Misurato il 2026-08-14: in `src/app` non c'è nessuna rotta `verifica` pubblica
 * — l'unica che porta quel nome è `src/app/api/admin/protocolli/verifica/route.ts`, un
 * `POST` dietro il gate della segreteria. Un certificato consegnato all'INPS rimanderebbe
 * quindi **a un 404**.
 *
 * Il codice qui non sbaglia — §4.3 della specifica chiede quel riquadro — ma la fase che
 * porta route e interfaccia deve portare ANCHE la pagina pubblica di verifica per numero
 * di protocollo, o i sei certificati non si rilasciano. È un debito della stessa natura di
 * `blocchiDopoFirma` e del `legale_rappresentante` mancante in configurazione, e va letto
 * insieme a quelli: nessuno dei tre si vede guardando il PDF.
 */
function componiVerifica(
  voce: VocePrestampato,
  numero: string,
  data: string,
  indirizzo: string | null | undefined,
): VerificaPrestampato | null {
  const esplicito = indirizzo?.trim()
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '')
  const indirizzoVerifica = esplicito || (base ? `${base}/verifica` : '')
  if (!indirizzoVerifica) {
    logEvento('config', 'error', {
      operazione: 'prestampati/render',
      esito: 'indirizzo-verifica-non-configurato',
      tipo: voce.slug,
    })
    return null
  }
  return { numeroProtocollo: numero, dataProtocollo: data, indirizzoVerifica }
}
