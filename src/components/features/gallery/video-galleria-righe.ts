import type { CodiceMostratoVideo, VoceVideo as VoceElencoVideo } from '@/lib/media/video/contratto'
import type { CaricamentoNativo, CodiceNativo } from '@/lib/native/caricamenti-nativi-tipi'

import type { FaseVideoUI, RigaVideoLavorazione } from './VideoInLavorazione'

/**
 * COME SI FONDONO LE RIGHE DI QUESTO DISPOSITIVO CON L'ELENCO DEL SERVER.
 *
 * ─── PERCHÉ DUE FONTI, E PERCHÉ UNA FUNZIONE SOLA ────────────────────────────────────────────
 * Un video mandato dall'insegnante ha due vite. Sul TELEFONO c'è la riga dell'archivio locale
 * (`CaricamentoVideoLocale`): sa il nome del file, quanti byte sono partiti, se il trasferimento è
 * fermo — cose che il server non può sapere, e che il server non deve sapere (il nome di un file
 * è anagrafica di un minore). Sul SERVER c'è la voce dell'elenco (`GET /api/video-uploads`): sa a
 * che punto è il video dopo l'arrivo, e vale per qualunque dispositivo l'abbia mandato.
 *
 * Questa funzione decide che cosa si legge a schermo, ed è pura: senza React, senza rete, senza
 * orologio. Il collaudo nel browser in locale qui è impossibile (il middleware rimanda al login e
 * dà falsi verdi), quindi ogni decisione che si può prendere fuori da un componente sta in un posto
 * dove un test la può eseguire davvero.
 *
 * ─── LE REGOLE, DALL'ALTO ────────────────────────────────────────────────────────────────────
 *  1. Un intento che la persona ha tolto (`nascosti`) non torna: il server lo riporta ancora per
 *     una settimana, e una scheda che riappare dopo «Togli» è una scheda che non si può levare.
 *  2. Finché i byte non sono tutti sullo Storage la parola è del TELEFONO: `in-fila` (aspetta il
 *     suo turno), `caricamento` (i byte partono) o `interrotto` (fermo, riprende da solo). Il
 *     server, per quel job, direbbe `da-caricare` e basta.
 *  3. Quando i byte sono arrivati — il trasferimento è concluso, oppure il server dice che il job
 *     ha lasciato `da-caricare` — la parola passa al SERVER: in coda, in conversione, in riprova,
 *     pronto, non pubblicato, fallito. Se la voce non c'è ancora (appena arrivato, elenco non
 *     ancora riletto) si dice `in-coda`: è l'unica cosa vera di un file che ha appena finito di
 *     arrivare.
 *  4. Senza riga locale (un altro dispositivo) un video che aspetta i byte è `altro-dispositivo`.
 *     Un video pubblicato o annullato senza riga locale non si mostra: è in galleria, o l'ha
 *     chiesto qualcuno.
 *  5. Un video pubblicato con una riga locale non si mostra nemmeno lui: la riga si butta altrove
 *     (l'hook), e qui sarebbe una scheda per qualcosa che è già in galleria.
 *  6. Un fallimento LOCALE (il trasferimento non può riprendere) è `fallito`, salvo `VIDEO_RIPROVA`:
 *     lì i byte non ci sono più e l'unica cosa da fare è sceglierlo di nuovo — `da-ricaricare`.
 *  7. (app 1.2) Un video NATIVO ha la sua riga locale come un altro, ma la racconta il plugin: la regola 2
 *     vale uguale (finché i byte non sono sullo Storage la parola è del telefono), con le NOTE del trasporto
 *     nativo al posto di quella del TUS — «puoi bloccare il telefono, non chiudere Kidville dal multitasking»,
 *     «in attesa di rete», «in pausa» — perché il TUS vive quanto la pagina e il nativo no. `statoLocaleDaCaricamentoNativo`
 *     traduce una voce della coda nativa in uno `StatoLocale`, ed è l'unico posto in cui lo fa.
 */

/** Come sta andando il trasferimento di QUESTO dispositivo. */
export type TrasferimentoLocale =
  /** Accodato: parte quando finisce quello prima (i trasferimenti vanno uno alla volta). */
  | 'in-fila'
  /** I byte stanno partendo adesso. */
  | 'in-corso'
  /** Fermo, ripescabile: riprende da solo (o col pulsante). */
  | 'interrotto'
  /** Tutti i byte sono sullo Storage. */
  | 'concluso'
  /** Non può riprendere: il peso locale è stato liberato. */
  | 'fallito'
  /** L'ha fermato una persona. */
  | 'annullato'

/** Come viaggiano i byte di una riga: dalla pagina (TUS) o dal sistema operativo (plugin nativo, app 1.2). */
export type TrasportoRiga = 'tus' | 'nativo'

/** Le note del trasporto nativo (spec §7.5): l'invio che prosegue a telefono bloccato, l'attesa di rete, la pausa. */
export type NotaNativa = 'invio' | 'attesa-rete' | 'pausa'

/** Ciò che si sa, su QUESTO dispositivo, di un video. */
export interface StatoLocale {
  jobId: string
  intentId: string
  /** Il nome del file: resta a schermo, non entra in nessun log. */
  nome: string
  /** Quando la riga è nata (ISO). */
  creatoIl: string
  trasferimento: TrasferimentoLocale
  /** Solo durante il caricamento: i byte si contano, la conversione no. */
  percentuale: number | null
  /** Il codice mostrabile dell'ultimo esito negativo del trasferimento, o `null`. */
  codice: CodiceMostratoVideo | null
  /**
   * Come viaggiano i byte di questo video: `tus` dalla pagina (web, app 1.0/1.1, ripiego del selettore del browser)
   * oppure `nativo` dal plugin (app 1.2). Nessun valore predefinito: chi scrive una riga decide.
   */
  trasporto: TrasportoRiga
  /** Solo `nativo`: quale nota leggere sotto la fase. `null` per il TUS, e per un video nativo senza niente da dire. */
  nota: NotaNativa | null
}

/** Una riga già composta, con ciò che serve al gancio per decidere cos'altro fare. */
export interface RigaComposta extends RigaVideoLavorazione {
  intentId: string
  /** Esiste una riga di questo dispositivo? */
  localeDiQuestoDispositivo: boolean
}

export interface IngressoFusione {
  locali: Readonly<Record<string, StatoLocale>>
  /** L'elenco del server, o `null` finché non è arrivato. */
  voci: readonly VoceElencoVideo[] | null
  /** Gli intenti che la persona ha tolto di mezzo. */
  nascosti: ReadonlySet<string>
  /** Il messaggio di un'azione appena fallita («Riprova» negato…): vince sul motivo della scheda. */
  messaggiAzione: Readonly<Record<string, string>>
  /** Il testo di catalogo di un codice mostrabile, mai la prosa del server; mai vuoto. */
  frase: (codice: string | null) => string
  /** «Il caricamento continua finché resti in Galleria…»: la nota onesta del trasporto a blocchi. */
  notaCaricamento: string
  /**
   * Le note del trasporto NATIVO, al posto di `notaCaricamento` per le righe nate dal plugin: l'invio non finisce con la
   * pagina («puoi bloccare il telefono… non chiudere Kidville dal multitasking»), e quando si ferma lo dice (rete, pausa).
   */
  noteNativo: { invio: string; attesaRete: string; pausa: string }
  /** Il browser dice di essere senza rete? Un «non autorizzato» in quel momento è solo la rete. */
  offline: boolean
}

/** Le fasi in cui un video non è ancora arrivato a una fine: tengono viva la lettura dell'elenco. */
export const FASI_UI_ATTIVE: ReadonlySet<FaseVideoUI> = new Set<FaseVideoUI>([
  'caricamento',
  'in-fila',
  'interrotto',
  'altro-dispositivo',
  'in-coda',
  'conversione',
  'in-riprova',
  'pronto',
])

/** Il job ha lasciato `da-caricare`: i suoi byte sono arrivati, comunque sia finito il resto. */
function byteArrivati(locale: StatoLocale | undefined, voce: VoceElencoVideo | undefined): boolean {
  if (locale?.trasferimento === 'concluso') return true
  // Il trasferimento che sta girando adesso lo chiude da sé: una voce che «sorpassa» di un istante
  // la riga non deve far scomparire la barra a metà.
  if (locale?.trasferimento === 'in-corso') return false
  return voce !== undefined && voce.fase !== 'da-caricare'
}

/** Ciò che una riga dice di sé, prima di sapere di quale video si parla. */
interface Corpo {
  fase: FaseVideoUI
  messaggio: string | null
  percentuale: number | null
  riprovaPossibile: boolean
}

const semplice = (fase: FaseVideoUI): Corpo => ({ fase, messaggio: null, percentuale: null, riprovaPossibile: false })

/** La fase e il messaggio di una voce del server. `null` per un pubblicato: non è più «in lavorazione». */
function dalServer(voce: VoceElencoVideo, frase: IngressoFusione['frase']): Corpo | null {
  switch (voce.fase) {
    case 'pubblicato':
      return null
    case 'annullato':
      return semplice('annullato')
    case 'da-caricare':
      return semplice('altro-dispositivo')
    case 'in-coda':
      return semplice('in-coda')
    case 'in-conversione':
      return semplice('conversione')
    case 'in-riprova':
      return semplice('in-riprova')
    case 'pronto':
      return semplice('pronto')
    case 'non-pubblicato':
      return { ...semplice('non-pubblicato'), messaggio: frase(voce.codice), riprovaPossibile: voce.riprovaPossibile }
    case 'fallito':
      return { ...semplice('fallito'), messaggio: frase(voce.codice) }
    case 'da-ricaricare':
      return semplice('da-ricaricare')
  }
}

/** La riga di un video che questo dispositivo conosce. */
function daLocale(locale: StatoLocale, voce: VoceElencoVideo | undefined, dati: IngressoFusione): Corpo | null {
  if (locale.trasferimento === 'annullato') return semplice('annullato')

  if (locale.trasferimento === 'fallito') {
    // I byte non ci sono più (la copia in background non era finita, o il deposito è rotto): non
    // è un errore da leggere, è un invio da rifare.
    if (locale.codice === 'VIDEO_RIPROVA') return semplice('da-ricaricare')
    return { ...semplice('fallito'), messaggio: dati.frase(locale.codice) }
  }

  if (!byteArrivati(locale, voce)) {
    // Il trasporto nativo ha le sue note: l'invio non finisce con la pagina, e quando si ferma dice perché.
    const nativo = locale.trasporto === 'nativo'
    switch (locale.trasferimento) {
      case 'in-fila':
        return { ...semplice('in-fila'), messaggio: nativo ? dati.noteNativo.invio : dati.notaCaricamento }
      case 'in-corso':
        return {
          ...semplice('caricamento'),
          percentuale: locale.percentuale ?? 0,
          messaggio: nativo ? dati.noteNativo.invio : dati.notaCaricamento,
        }
      default:
        // Fermo del nativo (`in-attesa` o `in-pausa`): la nota dice perché, e che cosa si aspetta. Senza codice mostrabile:
        // il motivo vero sta nella nota, e un «non autorizzato» qui non avrebbe senso (la firma non la chiede la pagina).
        if (nativo) {
          return {
            ...semplice('interrotto'),
            messaggio: locale.nota === 'pausa' ? dati.noteNativo.pausa : dati.noteNativo.attesaRete,
          }
        }
        // `interrotto`. Il codice, se c'è, si legge solo quando il browser crede di avere la rete:
        // «non autorizzato» mentre si è offline è soltanto la firma che non si è potuta chiedere.
        return {
          ...semplice('interrotto'),
          messaggio: locale.codice !== null && !(locale.codice === 'VIDEO_NON_AUTORIZZATO' && dati.offline)
            ? dati.frase(locale.codice)
            : null,
        }
    }
  }

  // I byte sono sul server: la parola è sua. Se la voce non c'è ancora, o dice ancora `da-caricare`
  // (il server non ha ancora registrato l'arrivo che questo dispositivo ha appena finito), l'unica
  // cosa vera è «in coda»: NON «da un altro dispositivo», che sarebbe una bugia sul video appena
  // mandato da qui.
  if (!voce || voce.fase === 'da-caricare') return semplice('in-coda')
  return dalServer(voce, dati.frase)
}

/**
 * Le righe da mostrare, dalla più vecchia alla più recente: in cima c'è ciò che sta partendo, e le
 * schede non si rimescolano a ogni lettura dell'elenco (che il server restituisce al contrario).
 */
export function fondiRighe(dati: IngressoFusione): RigaComposta[] {
  const vociPerJob = new Map<string, VoceElencoVideo>((dati.voci ?? []).map((v) => [v.jobId, v]))
  const ids = new Set<string>([...Object.keys(dati.locali), ...vociPerJob.keys()])
  const righe: RigaComposta[] = []

  for (const jobId of ids) {
    const locale = dati.locali[jobId]
    const voce = vociPerJob.get(jobId)
    const intentId = locale?.intentId ?? voce?.intentId
    if (!intentId || dati.nascosti.has(intentId)) continue

    let corpo: Corpo | null
    if (locale) {
      corpo = daLocale(locale, voce, dati)
    } else if (voce) {
      corpo = dalServer(voce, dati.frase)
      // Senza riga locale uno `annullato` non si mostra: l'ha chiesto qualcuno, e senza nome non c'è
      // nulla da riconoscere né da togliere.
      if (corpo?.fase === 'annullato') corpo = null
    } else {
      corpo = null
    }
    // Un pubblicato (`null` da `dalServer`) non è più un video «in lavorazione».
    if (!corpo) continue

    const azione = dati.messaggiAzione[jobId]
    righe.push({
      jobId,
      intentId,
      nome: locale?.nome ?? null,
      creatoIl: locale?.creatoIl ?? voce?.creatoIl ?? null,
      fase: corpo.fase,
      percentuale: corpo.percentuale,
      messaggio: azione ?? corpo.messaggio,
      riprovaPossibile: corpo.riprovaPossibile,
      // Senza riga locale (un altro dispositivo) vale quello che il server dice del trasporto: non cambia niente di ciò
      // che la scheda offre (nessun gesto dipende dal trasporto di un video che questo telefono non ha), ma la riga è sincera.
      trasporto: locale?.trasporto ?? (voce?.trasporto === 'put-nativo' ? 'nativo' : 'tus'),
      localeDiQuestoDispositivo: locale !== undefined,
    })
  }

  return righe.sort((a, b) => {
    const ta = Date.parse(a.creatoIl ?? '')
    const tb = Date.parse(b.creatoIl ?? '')
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0
  })
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * IL TRASPORTO NATIVO (app 1.2): una voce della coda del plugin diventa uno `StatoLocale`
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Perché un invio nativo è FALLITO, ridotto a ciò che la scheda sa dire (spec §7.5). Due strade:
 *  · il video non si può più mandare e va SCELTO DI NUOVO — il token è scaduto o non vale, l'URL non si rinnova più, la
 *    copia sul telefono non c'è più o pesa diverso: i byte che si erano scelti non esistono. È `VIDEO_RIPROVA`, che la
 *    scheda legge come «da ricaricare»;
 *  · il video è oltre il tetto: `VIDEO_TROPPO_GRANDE`, con la sua frase.
 * Ogni altro codice (e l'assenza di codice) non ha una frase sua: resta `null`, e la scheda dice il ripiego generico.
 */
const CODICE_MOSTRATO_DA_FALLIMENTO_NATIVO: Readonly<Partial<Record<CodiceNativo, CodiceMostratoVideo>>> = {
  TOKEN_NON_VALIDO: 'VIDEO_RIPROVA',
  TOKEN_SCADUTO: 'VIDEO_RIPROVA',
  RINNOVO_CICLICO: 'VIDEO_RIPROVA',
  FILE_ASSENTE: 'VIDEO_RIPROVA',
  PESO_DIVERSO: 'VIDEO_RIPROVA',
  TROPPO_GRANDE: 'VIDEO_TROPPO_GRANDE',
}

/**
 * Lo stato di QUESTO telefono per un video che sta nella coda del plugin (spec §7.5):
 *  · `in-coda` → `in-fila`;
 *  · `in-invio` → `in-corso`, con la percentuale vera (i byte inviati sui totali);
 *  · `in-attesa` → `interrotto` con la nota «in attesa di rete»; `in-pausa` → `interrotto` con la nota «in pausa»;
 *  · `inviato` → `concluso` (i byte sono sullo Storage: da qui la parola è del server);
 *  · `fallito` → `fallito`, col codice mostrabile di `CODICE_MOSTRATO_DA_FALLIMENTO_NATIVO`;
 *  · `annullato` → `annullato`.
 *
 * Pura, e senza dati personali nei campi che non siano il nome (che resta a schermo di chi ha scelto il file).
 */
export function statoLocaleDaCaricamentoNativo(voce: CaricamentoNativo): StatoLocale {
  const base = {
    jobId: voce.jobId,
    intentId: voce.intentId,
    nome: voce.nome,
    creatoIl: voce.creatoIl,
    trasporto: 'nativo' as const,
  }
  switch (voce.stato) {
    case 'in-coda':
      return { ...base, trasferimento: 'in-fila', percentuale: null, codice: null, nota: 'invio' }
    case 'in-invio':
      return {
        ...base,
        trasferimento: 'in-corso',
        percentuale: voce.byteTotali > 0 ? Math.min(100, Math.round((voce.byteInviati / voce.byteTotali) * 100)) : null,
        codice: null,
        nota: 'invio',
      }
    case 'in-attesa':
      return { ...base, trasferimento: 'interrotto', percentuale: null, codice: null, nota: 'attesa-rete' }
    case 'in-pausa':
      return { ...base, trasferimento: 'interrotto', percentuale: null, codice: null, nota: 'pausa' }
    case 'inviato':
      return { ...base, trasferimento: 'concluso', percentuale: null, codice: null, nota: null }
    case 'fallito':
      return {
        ...base,
        trasferimento: 'fallito',
        percentuale: null,
        codice: (voce.codice !== null ? CODICE_MOSTRATO_DA_FALLIMENTO_NATIVO[voce.codice] : undefined) ?? null,
        nota: null,
      }
    case 'annullato':
      return { ...base, trasferimento: 'annullato', percentuale: null, codice: null, nota: null }
  }
}

/** Due stati locali dicono la stessa cosa? Serve a non rifare il disegno a ogni avanzamento che non cambia niente. */
export function stessoStatoLocale(a: StatoLocale | undefined, b: StatoLocale): boolean {
  return (
    a !== undefined
    && a.jobId === b.jobId
    && a.intentId === b.intentId
    && a.nome === b.nome
    && a.creatoIl === b.creatoIl
    && a.trasferimento === b.trasferimento
    && a.percentuale === b.percentuale
    && a.codice === b.codice
    && a.trasporto === b.trasporto
    && a.nota === b.nota
  )
}
