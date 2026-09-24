import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EsitoEmissione } from '@/lib/aruba/emissione'
import type { AppUser, AppRole } from '@/lib/auth/predicati-ruolo'
import { zIntestatarioScelto, type IntestatarioScelto } from '@/lib/fatturazione/intestatario-scelto'
import { logEvento } from '@/lib/logging/logger'
import { eseguiBloccoFatture, type RigaBlocco } from '@/lib/pagamenti/esegui-blocco-fatture'
import { TETTO_BLOCCO } from '@/lib/pagamenti/lotto-fatture'
import { contaEmesseUltimaOra, posizioniDisponibili } from '@/lib/pagamenti/tetto-orario-aruba'

/**
 * ─── IL LAVORATORE DELLA CODA FATTURE — un giro, un blocco, nessun browser ──────────
 *
 * La segreteria mette in coda fino a 500 fatture e spegne il PC: da lì in poi è questo
 * giro, chiamato dal cron `fatture-coda-tick` ogni cinque minuti (e dalla «sveglia» dopo
 * un accodamento), a mandarle ad Aruba. Spec: `docs/superpowers/specs/2026-09-22-coda-
 * fatture-aruba/nucleo.md`, §2.
 *
 * Il motore è quello del lotto, già blindato, e NON è riscritto qui: il ciclo del blocco
 * sta in `src/lib/pagamenti/esegui-blocco-fatture.ts` e lo usano tutti e due. Questo file
 * aggiunge solo ciò che un browser faceva e un cron deve fare da sé:
 *
 *  1. stare fuori dalle finestre della sync (`fattura-sync` fa il suo `signin`, e Aruba ne
 *     concede UNO al minuto per IP);
 *  2. far passare il bidello, che chiude come «esito incerto» le voci rimaste in volo da
 *     un'invocazione morta;
 *  3. contare i posti del tetto orario — e se il conteggio non si fa, i posti sono ZERO;
 *  4. prendere il lavoratore e un blocco con UNA chiamata atomica (`fatture_coda_prendi`);
 *  5. chiudere ogni voce appena ha un esito, con la mappatura del §2 punto 7;
 *  6. rilasciare il lavoratore, con la pausa che l'esito peggiore del giro impone.
 *
 * ⚠️ NESSUN RITENTATIVO CIECO. Una voce torna in coda da sola solo in due casi, ed entrambi
 * sono certi di non aver consumato un numero: il `429` PRIMA del numero (accesso o ricerca
 * del pavimento) e la voce che il giro non ha nemmeno tentato. Tutto ciò che può aver
 * consumato un numero — trasporto ignoto, 0, 5xx, 401/403, `429` sull'upload — finisce in
 * `errore` con `esito_incerto`, e rimetterla in coda è una decisione di una persona che ha
 * guardato sul pannello Aruba.
 */

/** L'`operazione` dei log del giro. */
export const OPERAZIONE_GIRO = 'fatture-coda/giro'

/**
 * Per quanti secondi il lavoratore e le voci prese restano «in prestito».
 *
 * 330 e non 300: il muro è `maxDuration = 300` della route, e il prestito deve durare PIÙ
 * dell'invocazione più lunga possibile. Se scadesse prima, il giro successivo potrebbe
 * prendere il lavoratore mentre questo sta ancora emettendo — due blocchi in parallelo,
 * cioè due `signin` nello stesso minuto e due letture dello stesso pavimento.
 */
export const PRESTITO_S = 330

/** La pausa dopo un `429` di Aruba: il secchio orario ha TTL di un'ora e ogni tentativo lo riazzera. */
export const PAUSA_429_MINUTI = 60
/** La pausa dopo un esito incerto, uno 0 o un 5xx: il canale ha un problema, non la voce. */
export const PAUSA_INCERTO_MINUTI = 15

/** Il tetto di `fatture_coda.esito_messaggio` (vincolo di colonna). */
const MESSAGGIO_MAX = 500

/**
 * Il frammento con cui `emettiFatturaPagamento` dichiara il `429` PRIMA del numero.
 *
 * ⚠️ È UN RICONOSCIMENTO SULLA STRINGA, e va detto che è il punto debole del giro. Il `429`
 * sull'accesso o sulla ricerca del pavimento esce dall'emissione come
 * `numerazione_non_allineata` / 503, identico a ogni altro guasto di numerazione: il codice
 * del provider vive SOLO nel messaggio (`case '429'` in `src/lib/aruba/emissione.ts`), e la
 * spec del nucleo vuole `emettiFatturaPagamento` usata così com'è.
 *
 * Se qualcuno riscrive quella frase il riconoscimento smette di funzionare, e il verso in
 * cui sbaglia è quello SICURO: la voce finisce in `errore` con `esito_incerto` e pausa di 15
 * minuti invece che rimessa in coda con 60 — nessun ritentativo cieco, solo una voce da
 * rimettere a mano. Perché non accada in silenzio, un lock in
 * `__tests__/lib/fatture-coda/giro.test.ts` legge il sorgente dell'emissione e pretende che
 * la frase stia ancora nel ramo `'429'`.
 */
export const FRASE_429_PRIMA_DEL_NUMERO = '«troppe richieste»'

/**
 * Il `429` sull'UPLOAD, dentro il messaggio di trasporto: `messaggioTrasporto` scrive il
 * guasto fra parentesi — «(429)», «(HTTP 429)», «(0034 dopo un 429)». La voce resta un
 * esito incerto (il numero è consumato), ma la pausa è quella del `429`: 60 minuti.
 */
const RE_429_UPLOAD = /\b429\)/

/** Gli status che riguardano SOLO la voce: nascono nei nostri gate, prima del `signin`. */
const RIFIUTI_LOCALI = new Set([400, 404, 409, 422])

/**
 * I motivi di rifiuto locale che diventano, così come sono, il codice d'esito della voce.
 * Un motivo fuori da questa lista diventa `rifiuto_locale`: l'elenco dei codici resta
 * CHIUSO, perché l'interfaccia ne traduce ciascuno (`esiti.<codice>`).
 */
const MOTIVI_LOCALI = new Set<string>([
  'non_saldato',
  'intestatario_mancante',
  'intestatario_in_conflitto',
  'intestatario_non_del_bambino',
  'gia_emessa_altro_intestatario',
  'quota_estranea',
  'partita_non_registrata',
  'periodo_competenza_mancante',
  'dati_minore_mancanti',
])

/**
 * TUTTI i codici d'esito che il giro (e il bidello) possono scrivere su una voce. È
 * l'elenco da tradurre in `adminContabilita.codaFatture.esiti.<codice>`.
 */
export const CODICI_ESITO_CODA = [
  'emessa',
  'gia_emessa',
  'scarto_aruba',
  'esito_incerto',
  'aruba_429',
  'non_tentata',
  'pagamento_non_trovato',
  'trasporto_da_verificare',
  'rifiuto_locale',
  'intestatario_non_valido',
  ...MOTIVI_LOCALI,
] as const

/** La voce di `fatture_coda`, per la sola parte che il giro legge. */
export interface VoceCoda {
  id: string
  pagamento_id: string
  scuola_id: string
  creato_da: string
  intestatario_scelto?: unknown
  conferma_proposta?: boolean | null
  causale_manuale?: string | null
}

/**
 * Cosa ha visto il giro sul canale verso Aruba, per decidere la pausa: `aruba-429` vince
 * su `incerto`, che vince su `nessuno`.
 */
type Segnale = 'nessuno' | 'incerto' | 'aruba-429'

/** Come si chiude una voce: l'argomento di `fatture_coda_chiudi`, più il segnale per la pausa. */
export interface Chiusura {
  esito: 'emessa' | 'errore' | 'riprova'
  codice: string
  messaggio: string | null
  segnale: Segnale
}

export type EsitoGiroCodice = 'finestra-sync' | 'quota-oraria' | 'niente-da-fare' | 'eseguito' | 'errore'

export interface EsitoGiro {
  esito: EsitoGiroCodice
  /** Voci chiuse come emesse (comprese quelle già a registro). */
  emesse: number
  /** Voci chiuse in errore. */
  errori: number
  /** Voci rimesse in coda senza essere state emesse. */
  riprova: number
  /** La pausa chiesta alla coda al rilascio, in minuti (0 = nessuna). */
  pausaMinuti: number
}

const NON_TENTATA: Chiusura = { esito: 'riprova', codice: 'non_tentata', messaggio: null, segnale: 'nessuno' }

function tronca(testo: string | null | undefined): string | null {
  if (!testo) return null
  return testo.length > MESSAGGIO_MAX ? `${testo.slice(0, MESSAGGIO_MAX - 1)}…` : testo
}

/**
 * Il minuto Europe/Rome sta in una finestra della sync (`:00–:05` o `:30–:35`)?
 *
 * Il cron `fattura-sync` gira ai minuti 2 e 32 e fa il suo `signin`: Aruba ne concede uno
 * al minuto per IP, e il 2026-09-07 un `signin` del lotto ha preso `429` proprio così. Il
 * cron della coda non tocca mai quei minuti; la finestra protegge dalla SVEGLIA, che parte
 * quando qualcuno accoda e può cadere in qualunque minuto.
 */
export function inFinestraSync(adesso: Date): boolean {
  const parti = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(adesso)
  const minuto = Number(parti.find((p) => p.type === 'minute')?.value)
  // Un minuto illeggibile vale come DENTRO la finestra: meglio saltare un giro che
  // rubare lo slot del `signin` alla sync.
  if (!Number.isFinite(minuto)) return true
  return (minuto >= 0 && minuto <= 5) || (minuto >= 30 && minuto <= 35)
}

/**
 * La mappatura degli esiti del §2 punto 7, pura.
 *
 *  · ok → `emessa` (`emessa`); già a registro → `emessa` (`gia_emessa`);
 *  · `429` prima del numero (accesso o ricerca del pavimento) → `riprova` (`aruba_429`);
 *  · rifiuto locale 400/404/409/422 → `errore` col motivo come codice, e il messaggio;
 *  · scarto di merito di Aruba → `errore` (`scarto_aruba`);
 *  · tutto il resto — trasporto ignoto, `429` sull'upload, 0, 5xx, 401/403 → `errore`
 *    (`esito_incerto`): il numero può essere stato consumato, e nessuno rimanda in coda
 *    una voce così senza aver guardato sul pannello Aruba.
 */
export function classificaEsito(esito: EsitoEmissione): Chiusura {
  if (esito.ok) {
    return esito.gia
      ? { esito: 'emessa', codice: 'gia_emessa', messaggio: null, segnale: 'nessuno' }
      : { esito: 'emessa', codice: 'emessa', messaggio: null, segnale: 'nessuno' }
  }

  // PRIMA dei rifiuti locali e del ramo generico: esce come 503, cioè come un 5xx, ma è
  // l'unico 5xx che dichiara per iscritto «nessun numero è stato consumato» E dice che il
  // canale è saturo. Si rimette in coda, e il giro si ferma per un'ora.
  if (esito.motivo === 'numerazione_non_allineata' && esito.messaggio.includes(FRASE_429_PRIMA_DEL_NUMERO)) {
    return { esito: 'riprova', codice: 'aruba_429', messaggio: null, segnale: 'aruba-429' }
  }

  if (RIFIUTI_LOCALI.has(esito.httpStatus)) {
    return { esito: 'errore', codice: codiceRifiutoLocale(esito), messaggio: tronca(esito.messaggio), segnale: 'nessuno' }
  }

  if (esito.motivo === 'scartata') {
    // Aruba ha risposto sul MERITO del documento: il canale funziona, quindi nessuna
    // pausa. Il blocco si ferma lo stesso (`fermaIlLotto` sul 502 dell'aggregato), e le
    // voci dopo tornano in coda come non tentate.
    return { esito: 'errore', codice: 'scarto_aruba', messaggio: tronca(esito.messaggio), segnale: 'nessuno' }
  }

  return {
    esito: 'errore',
    codice: 'esito_incerto',
    messaggio: tronca(esito.messaggio),
    segnale: RE_429_UPLOAD.test(esito.messaggio) ? 'aruba-429' : 'incerto',
  }
}

function codiceRifiutoLocale(esito: Extract<EsitoEmissione, { ok: false }>): string {
  if (MOTIVI_LOCALI.has(esito.motivo)) return esito.motivo
  if (esito.motivo === 'errore' && esito.httpStatus === 404) return 'pagamento_non_trovato'
  // Il 409 con `motivo: 'errore'` è la riga «Trasporto fallito» già a registro: un tentativo
  // precedente ha consumato un numero con esito ignoto, e va chiuso a mano dopo aver
  // guardato sul pannello Aruba.
  if (esito.motivo === 'errore' && esito.httpStatus === 409) return 'trasporto_da_verificare'
  return 'rifiuto_locale'
}

/** La pausa da chiedere al rilascio: l'esito peggiore del giro decide. */
function pausaDaiSegnali(segnali: readonly Segnale[]): { minuti: number; motivo: string | null } {
  if (segnali.includes('aruba-429')) return { minuti: PAUSA_429_MINUTI, motivo: 'aruba-429' }
  if (segnali.includes('incerto')) return { minuti: PAUSA_INCERTO_MINUTI, motivo: 'esito-incerto' }
  return { minuti: 0, motivo: null }
}

const vuoto = (esito: EsitoGiroCodice): EsitoGiro => ({ esito, emesse: 0, errori: 0, riprova: 0, pausaMinuti: 0 })

/** Una riga del blocco che si porta dietro la sua voce. */
type RigaCoda = RigaBlocco & { voce: VoceCoda }

/**
 * Un giro della coda. Non lancia: ogni guasto diventa un esito e una riga di log.
 *
 * @param sb client con service role (la coda non ha policy: si scrive solo dalle RPC)
 * @param adesso l'istante del giro, per la finestra della sync e il tetto orario
 */
export async function eseguiGiroCoda(sb: SupabaseClient, adesso: Date = new Date()): Promise<EsitoGiro> {
  const inizio = Date.now()

  // ── 1. LA FINESTRA DELLA SYNC ──────────────────────────────────────────────────
  if (inFinestraSync(adesso)) return vuoto('finestra-sync')

  // ── 2. IL BIDELLO ──────────────────────────────────────────────────────────────
  // Non è bloccante: le voci in volo scadute restano dove sono fino al giro dopo, e
  // quelle nuove non dipendono da lui. Ma un fallimento non si tace.
  const bidello = await sb.rpc('fatture_coda_bidello')
  if (bidello.error) {
    logEvento('fattura', 'error', { operazione: OPERAZIONE_GIRO, esito: 'bidello-fallito' }, bidello.error)
  } else if (typeof bidello.data === 'number' && bidello.data > 0) {
    // Ogni voce qui è una fattura di cui NON si sa se sia partita: `warn`, e il numero.
    logEvento('fattura', 'warn', {
      operazione: OPERAZIONE_GIRO,
      esito: 'voci-interrotte',
      voci: bidello.data,
      msg: 'voci rimaste in invio oltre il prestito: chiuse come esito incerto, da verificare sul pannello Aruba',
    })
  }

  // ── 3. I POSTI DEL TETTO ORARIO, FAIL-CLOSED ───────────────────────────────────
  // ⚠️ L'OPPOSTO DEL LOTTO, e di proposito. Il lotto parte anche senza conteggio perché
  // davanti c'è una persona che vede l'esito di ogni blocco; qui non c'è nessuno, e un
  // giro ogni cinque minuti senza guardia sarebbe il modo più rapido di svuotare il
  // secchio di Aruba per tutti. Senza conteggio i posti sono ZERO.
  const emesseUltimaOra = await contaEmesseUltimaOra(sb, adesso)
  let posti: number
  if (emesseUltimaOra === null) {
    logEvento('fattura', 'warn', {
      operazione: OPERAZIONE_GIRO,
      esito: 'tetto-non-misurato',
      msg: 'fatture dell’ultima ora non contate: la coda non parte in questo giro (fail-closed)',
    })
    posti = 0
  } else {
    posti = posizioniDisponibili(emesseUltimaOra)
  }
  const max = Math.min(TETTO_BLOCCO, posti)
  if (max <= 0) return vuoto('quota-oraria')

  // ── 4. IL LAVORATORE E IL BLOCCO, IN UNA CHIAMATA SOLA ─────────────────────────
  const token = randomUUID()
  const presa = await sb.rpc('fatture_coda_prendi', { p_token: token, p_max: max, p_prestito_s: PRESTITO_S })
  if (presa.error) {
    logEvento('fattura', 'error', { operazione: OPERAZIONE_GIRO, esito: 'prendi-fallita', max }, presa.error)
    // Difensivo: la RPC è una transazione, e fallita non ha preso niente. Ma se l'errore
    // fosse arrivato DOPO il commit, il lavoratore resterebbe preso fino alla scadenza del
    // prestito: col token giusto il rilascio non costa nulla.
    await rilascia(sb, token, 0, null)
    return vuoto('errore')
  }
  const voci = (Array.isArray(presa.data) ? presa.data : []) as VoceCoda[]
  if (voci.length === 0) {
    // Vuoto per coda sospesa, pausa o altro lavoratore (e allora il token non combacia e il
    // rilascio non tocca niente), oppure perché non c'era niente da fare — e allora il
    // lavoratore l'abbiamo preso noi e va restituito.
    await rilascia(sb, token, 0, null)
    return vuoto('niente-da-fare')
  }

  // ── 5. IL BLOCCO ───────────────────────────────────────────────────────────────
  const conteggi = { emesse: 0, errori: 0, riprova: 0 }
  const segnali: Segnale[] = []
  const chiuse = new Set<string>()

  const chiudi = async (voce: VoceCoda, c: Chiusura): Promise<void> => {
    chiuse.add(voce.id)
    segnali.push(c.segnale)
    if (c.esito === 'emessa') conteggi.emesse++
    else if (c.esito === 'errore') conteggi.errori++
    else conteggi.riprova++
    try {
      const { error } = await sb.rpc('fatture_coda_chiudi', {
        p_id: voce.id,
        p_token: token,
        p_esito: c.esito,
        p_codice: c.codice,
        p_messaggio: c.messaggio,
      })
      if (error) {
        // La voce resta `in_invio`: quando il prestito scade il bidello la chiude come
        // esito incerto. È il verso sicuro — mai una seconda emissione — ma una fattura
        // partita apparirebbe «da verificare», e va detto qui.
        logEvento(
          'fattura',
          'error',
          {
            operazione: OPERAZIONE_GIRO,
            esito: 'chiudi-fallita',
            azione: c.esito,
            tipo: c.codice,
            pagamento_id: voce.pagamento_id,
            scuola_id: voce.scuola_id,
          },
          error,
          { distingui: ['pagamento_id'] },
        )
      }
    } catch (err) {
      logEvento(
        'fattura',
        'error',
        {
          operazione: OPERAZIONE_GIRO,
          esito: 'chiudi-fallita',
          azione: c.esito,
          tipo: c.codice,
          pagamento_id: voce.pagamento_id,
          scuola_id: voce.scuola_id,
        },
        err,
        { distingui: ['pagamento_id'] },
      )
    }
    // Una riga per voce (AGENTS.md, regola 5: anche il successo). Solo uuid e codici: il
    // messaggio dell'emissione resta nella colonna della voce, che vede chi ha la sede.
    // Il codice sta dentro `esito` (in lista bianca di `redact`): sotto una chiave sua
    // uscirebbe `[redatto]`, e la riga direbbe «una voce è andata male» senza dire come.
    // Il successo non distingue la voce (il battito `inviata` dell'emissione c'è già);
    // i fallimenti sì, perché ciascuno è una fattura da guardare.
    logEvento(
      'fattura',
      c.esito === 'emessa' ? 'info' : c.codice === 'esito_incerto' ? 'error' : 'warn',
      {
        operazione: OPERAZIONE_GIRO,
        esito: `voce-${c.codice}`,
        azione: c.esito,
        pagamento_id: voce.pagamento_id,
        scuola_id: voce.scuola_id,
      },
      undefined,
      c.esito === 'emessa' ? undefined : { distingui: ['pagamento_id'] },
    )
  }

  const righe: RigaCoda[] = []
  const attori = await leggiAttori(sb, voci)
  for (const voce of voci) {
    let intestatario: IntestatarioScelto | undefined
    if (voce.intestatario_scelto !== null && voce.intestatario_scelto !== undefined) {
      const letto = zIntestatarioScelto.safeParse(voce.intestatario_scelto)
      if (!letto.success) {
        // Mai emettere con un intestatario che non si sa leggere: la cascata del server
        // intesterebbe la fattura a qualcun altro, in silenzio.
        await chiudi(voce, {
          esito: 'errore',
          codice: 'intestatario_non_valido',
          messaggio:
            'L’intestatario scelto per questa fattura non è leggibile: toglila dalla coda e rifalla dal lotto o da «Invia fattura».',
          segnale: 'nessuno',
        })
        continue
      }
      intestatario = letto.data
    }
    righe.push({
      voce,
      pagamento_id: voce.pagamento_id,
      // `null` toglie la correzione salvata, come facevano il lotto e il pulsante singolo
      // quando non c'era una causale scritta a mano: `fattura_causale` è appiccicoso.
      causale: voce.causale_manuale ?? null,
      intestatario,
      attoreId: voce.creato_da,
      attoreAudit: attori.get(voce.creato_da) ?? null,
      ricordaSullaScheda: voce.conferma_proposta === true,
    })
  }

  let fermato: 'budget' | 'errore' | 'eccezione' | null = null
  try {
    const blocco = await eseguiBloccoFatture(sb, righe, {
      operazione: OPERAZIONE_GIRO,
      inizioMs: inizio,
      dopoRiga: async (riga, esito) => chiudi(riga.voce, classificaEsito(esito)),
    })
    fermato = blocco.fermato
    const perPagamento = new Map(righe.map((r) => [r.pagamento_id, r.voce]))
    for (const pagamentoId of blocco.restanti) {
      const voce = perPagamento.get(pagamentoId)
      if (voce && !chiuse.has(voce.id)) await chiudi(voce, NON_TENTATA)
    }
  } catch (err) {
    // Un'eccezione a metà blocco: la voce in volo è la prima non ancora chiusa, e di lei
    // non si sa se sia partita — è il caso «0» del lotto. Le altre non sono state tentate.
    fermato = 'eccezione'
    logEvento('fattura', 'error', { operazione: OPERAZIONE_GIRO, esito: 'blocco-interrotto' }, err)
    let inVolo = true
    for (const riga of righe) {
      if (chiuse.has(riga.voce.id)) continue
      if (inVolo) {
        inVolo = false
        await chiudi(riga.voce, {
          esito: 'errore',
          codice: 'esito_incerto',
          messaggio: 'Invio interrotto da un errore imprevisto: controlla sul pannello Aruba prima di rimetterla in coda.',
          segnale: 'incerto',
        })
      } else {
        await chiudi(riga.voce, NON_TENTATA)
      }
    }
  }
  // Una voce presa e non passata dal blocco (non dovrebbe esistere) non resta in volo.
  for (const voce of voci) if (!chiuse.has(voce.id)) await chiudi(voce, NON_TENTATA)

  // ── 6. IL RILASCIO, CON LA PAUSA CHE L'ESITO PEGGIORE IMPONE ──────────────────
  const pausa = pausaDaiSegnali(segnali)
  await rilascia(sb, token, pausa.minuti, pausa.motivo)

  logEvento(
    'fattura',
    conteggi.errori > 0 ? 'warn' : 'info',
    {
      operazione: OPERAZIONE_GIRO,
      esito: 'giro-concluso',
      voci: voci.length,
      emesse: conteggi.emesse,
      errori: conteggi.errori,
      riprova: conteggi.riprova,
      pausa_minuti: pausa.minuti,
      // `stato` e non `fermato`: è in lista bianca di `redact`, e un enumerato sotto una
      // chiave che non lo è uscirebbe `[redatto]`.
      stato: fermato ?? 'completo',
      ms: Date.now() - inizio,
    },
    undefined,
    // Come il blocco del lotto: senza, i giri di un pomeriggio diventerebbero UNA riga
    // coi contatori del primo.
    { distingui: ['emesse', 'errori', 'riprova', 'stato'] },
  )

  return { esito: 'eseguito', ...conteggi, pausaMinuti: pausa.minuti }
}

async function rilascia(sb: SupabaseClient, token: string, minuti: number, motivo: string | null): Promise<void> {
  try {
    const { error } = await sb.rpc('fatture_coda_rilascia', {
      p_token: token,
      p_pausa_minuti: minuti,
      p_motivo: motivo,
    })
    // Il lavoratore si libera comunque alla scadenza del prestito; ma una PAUSA persa
    // vuol dire tornare a bussare ad Aruba dopo un `429`, e va gridato.
    if (error) {
      logEvento('fattura', 'error', { operazione: OPERAZIONE_GIRO, esito: 'rilascia-fallita', pausa_minuti: minuti }, error)
    }
  } catch (err) {
    logEvento('fattura', 'error', { operazione: OPERAZIONE_GIRO, esito: 'rilascia-fallita', pausa_minuti: minuti }, err)
  }
}

/**
 * Chi ha accodato, con ruolo e sede: serve SOLO al registro delle scritture quando il
 * blocco ricorda l'intestatario sulla scheda. Si legge solo se c'è almeno una voce che
 * potrebbe farlo: `conferma_proposta` con un adulto (la proposta del bonifico confermata)
 * o, dalla consegna 2b (D1), con la persona scritta a mano (la casella «ricorda sulla
 * scheda» del pulsante).
 *
 * Fallita la lettura, la mappa è vuota e il promemoria salta con un suo log: una
 * scrittura su `alunni` senza la sua riga di audit è peggio di un promemoria mancato.
 */
async function leggiAttori(sb: SupabaseClient, voci: readonly VoceCoda[]): Promise<Map<string, AppUser>> {
  const attori = new Map<string, AppUser>()
  const ids = [
    ...new Set(
      voci
        .filter((v) => {
          const tipo = (v.intestatario_scelto as { tipo?: unknown } | null | undefined)?.tipo
          return v.conferma_proposta === true && (tipo === 'adult' || tipo === 'persona')
        })
        .map((v) => v.creato_da),
    ),
  ]
  if (ids.length === 0) return attori
  const { data, error } = await sb.from('utenti').select('id, role, scuola_id').in('id', ids)
  if (error) {
    logEvento('fattura', 'warn', { operazione: OPERAZIONE_GIRO, esito: 'attori-non-letti', voci: ids.length }, error)
    return attori
  }
  for (const u of (data ?? []) as { id: string; role: AppRole; scuola_id: string | null }[]) {
    attori.set(u.id, { id: u.id, role: u.role, scuola_id: u.scuola_id })
  }
  return attori
}
