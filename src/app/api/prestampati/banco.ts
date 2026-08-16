/**
 * IL BANCO DEI PRESTAMPATI — ciò che le route dei prestampati condividono.
 *
 * Non è una route: è un modulo COLLOCATO accanto alle due della segreteria (`route.ts` e
 * `genera/route.ts`), che in App Router non produce nessun endpoint — solo `route.ts` lo fa.
 *
 * Il GET e il POST fanno due cose diverse con gli stessi tre pezzi: l'elenco filtrato per
 * banco, il precompilato del soggetto, la composizione del PDF. Duplicarli avrebbe
 * significato due elenchi di ciò che è generabile — e il giorno in cui il primo cambia, il
 * pannello offre un pulsante che la generazione rifiuta.
 *
 * ─── 🔴 QUESTO FILE NON È PIÙ «DELLE DUE ROUTE DELLA SEGRETERIA» ────────────────
 *
 * La testata diceva che il file sta qui invece che in `src/lib/prestampati/` perché «sotto
 * `src/app/api/prestampati/` l'ownership è chiara»: era vero il giorno in cui è stato
 * scritto e **oggi è falso**. `src/app/api/parent/prestampati/firma/route.ts` importa
 * `scadenzaDaRisposte` da qui, cioè questo modulo è già codice condiviso fra due alberi di
 * route scritti da due mani diverse — che è esattamente la situazione per cui `src/lib/`
 * esiste. Chi tocca `scadenzaDaRisposte`, `motivoNonGenerabile`, `voceElenco`,
 * `letturaPerStampa` o `componiPrestampato` cambia il comportamento di TRE route, non di due.
 *
 * ─── E IL PREZZO DELLA COLLOCAZIONE RESTA INTERO ────────────────────────────────
 *
 * Tutto l'accesso al database delle due route della segreteria vive in queste righe —
 * `sections`, `alunni`, `student_parents`, `parents`, `delegates`, `utenti`, `scuole`,
 * `schools` — e il lock dell'isolamento fra sedi NON LE LEGGE:
 * `__tests__/architecture/isolamento-sede-coverage.test.ts` raccoglie i file che si chiamano
 * `route.ts` e basta (`routeFiles`), e lo dichiara di sé stesso — «legge il codice di un
 * file `route.ts`, non il grafo dei moduli». Quel lock è stato però alzato a
 * `routeConServiceRole: 295` / `handlerControllati: 458` contando anche queste due route:
 * le conta, e delle loro query non ne guarda nemmeno una.
 *
 * Non è una sottigliezza: la route gemella della famiglia ha una query su `delegates`
 * identica a quella di `leggiDelegati`, lasciata dentro il suo `route.ts`, e quel lock l'ha
 * vista e l'ha fatta diventare rossa. La stessa query qui dentro non l'ha guardata nessuno.
 *
 * Il presidio sostitutivo NON è questo commento: è
 * `__tests__/api/prestampati-segreteria.test.ts` → «OTTO tabelle, un perimetro solo», che
 * enumera le otto tabelle qui sopra e pretende, per ciascuna, o il filtro di sede o
 * l'aggancio ai soli id usciti dalla query già filtrata — più il suo gemello che prova che
 * una sezione di un'altra sede non arriva nemmeno a leggerli. Chi domani toglie
 * `.eq('scuola_id', …)` da `leggiAlunniDiSezione`, o aggancia una tabella nuova senza
 * perimetro, trova quel test rosso: è ciò che il lock avrebbe fatto se questo file si
 * chiamasse `route.ts`.
 *
 * Le due riparazioni vere non sono di questa mano e sono **segnalate, non fatte**:
 * estendere `routeFiles` ai moduli fratelli sotto `src/app/api/**` (il lock è un file
 * d'architettura condiviso, e cambiarne l'enumerazione muove i conti di tutte le corsie
 * aperte), oppure portare le parti pure e già condivise dentro `src/lib/prestampati/` —
 * pacchetto che in questo momento sta scrivendo un'altra mano.
 *
 * ─── COSA QUESTO FILE DECIDE, E COSA NO ─────────────────────────────────────────
 *
 * Decide **quali dei diciassette il banco può davvero produrre oggi** (`motivoNonGenerabile`)
 * e **come si compone ciascuno** (`componiPrestampato`). NON decide chi può: il gate di
 * ruolo è `requireDocente` con i ruoli che il registro dichiara (`cancelloDelModello`), la
 * portata dell'alunno è `caricaPrefillAlunno` → `requireParentOfStudent`, quella della
 * sezione è `assertSezioneInScope` più le sedi attive. Difese che esistono già, nessuna
 * riscritta qui.
 *
 * ─── NIENTE DATI PERSONALI NEI LOG ──────────────────────────────────────────────
 *
 * Le righe di questo file portano uuid, conteggi e codici PostgREST. Mai un nome, mai un
 * codice fiscale, mai un'allergia: fra i diciassette c'è l'elenco delle diete di una
 * sezione, che è l'art. 9 di venticinque minori in un foglio solo.
 */

import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireDocente, type AppRole } from '@/lib/auth/require-staff'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { annoScolasticoCorrente } from '@/lib/anno-scolastico'
import { STATO_ISCRITTO, STATO_SOSPESO } from '@/lib/alunni/stato'
import { buildIntestazioneSede, rigaLuogoData } from '@/lib/certificati/self-service'
import { isoToIt } from '@/lib/format/data'
import { allergeneLabel } from '@/lib/mensa/allergeni'
import { parseAnagraficaSede } from '@/lib/scuole/anagrafica'
import { docentiDiSezione } from '@/lib/sezioni/docenti'
import {
  nucleoAlunno,
  nucleoSede,
  type PrefillPrestampato,
} from '@/lib/prestampati/prefill'
import {
  bloccoFirma,
  prestampatiPerRuolo,
  ruoliAppDelBanco,
  type CampoPrestampato as DescrittoreCampo,
  type RuoloRichiedente,
  type VocePrestampato,
} from '@/lib/prestampati/registro'
import { buildPrestampatoPdf } from '@/lib/prestampati/impaginazione'
import type {
  BloccoPrestampato,
  CampoPrestampato as RigaStampata,
  CasellaPrestampato,
  DocumentoPrestampato,
} from '@/lib/prestampati/tipi'
import {
  modelloGenitore,
  type DatiPrestampato,
  type ModelloPrestampato as ModelloGenitore,
} from '@/lib/prestampati/modelli/genitore'
import {
  modelloCertificatoCompetenze,
  modelloNullaOsta,
  modelloRichiestaDisponibilita,
  modelloStampeSezione,
  type NucleoSede,
  type RigaSezione as RigaStampaSezione,
} from '@/lib/prestampati/modelli/segreteria'
import {
  cartaDaDati,
  renderPrestampatoGenitore,
  renderPrestampatoSegreteria,
  type EsitoRender,
  type OpzioniRender,
} from '@/lib/prestampati/render'
import { logEvento } from '@/lib/logging/logger'

/** Colonna o tabella assente: il DB E2E della CI è un progetto separato e non è migrato. */
const SCHEMA_ASSENTE = new Set(['42703', 'PGRST204', '42P01', 'PGRST205'])

const codicePostgrest = (err: unknown): string | null =>
  (err as { code?: string } | null)?.code ?? null

const testo = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || null
}

// ─── Che cosa il banco può produrre OGGI ────────────────────────────────────────

/**
 * I tre motivi per cui uno dei diciassette non nasce da questo sportello. Tenerli distinti
 * serve a chi guarda il pannello: i primi due dicono «non si fa ancora», il terzo dice
 * «manca un dato, e so quale» — sono lacune diverse, con rimedi diversi.
 *
 * ⚠️ ERANO QUATTRO, E IL QUARTO È SPARITO IL 2026-08-16. Si chiamava
 * `firma_da_raccogliere` e diceva ai sei moduli di famiglia «si genera dal flusso di firma
 * della famiglia, non dallo sportello»: era vero finché l'unico foglio che questo banco
 * sapeva produrre era quello **già firmato**. Oggi i tre modi di lavorare su un modulo di
 * famiglia sono dichiarati (`ModalitaModuloFamiglia`), e due dei tre non attestano nessuna
 * firma elettronica — la copia vuota da firmare a penna e il modulo tornato compilato su
 * carta. Un banco che li rifiuta tutti e tre per non poter dichiarare una firma rifiuta
 * anche i due che una firma non la dichiarano affatto.
 *
 * ⚠️ IL PRIMO È NATO DA UNA BUGIA MISURATA, e vale la pena dire quale. Il motivo sparito
 * diceva a tutti «si genera dal flusso di firma della famiglia»: falso per due dei
 * diciassette. `verbale_infortunio` (`disponibilePer: ['educator', 'coordinator', 'admin',
 * 'segreteria']`) e `valutazione_infanzia` (`['educator', 'coordinator', 'admin']`) NON
 * compaiono in nessun banco «genitore» — quel banco si costruisce con
 * `prestampatiPerRuolo('genitore')`, che li esclude entrambi — quindi l'educatrice che
 * apriva il pannello per il verbale di un infortunio leggeva un'indicazione che la mandava
 * in un flusso incapace di produrlo, e nessuna strada nel prodotto lo produceva. Restano
 * loro due, ed è per loro che `firma_senza_flusso` esiste ancora.
 *
 * 🔴 IL TERZO STA NELLA CONFIGURAZIONE DELLA SEDE, non nel registro: cinque dei fogli che
 * questo sportello produce — `nulla_osta`, `richiesta_disponibilita`,
 * `certificato_competenze`, `certificato_iscrizione_frequenza`, `certificato_bonus_nido` —
 * si chiudono con la firma del legale rappresentante, e `componiFirma`
 * (`src/lib/prestampati/render.ts`) li rifiuta quando quel nome non c'è. Con tre plessi la
 * stessa domanda può avere tre risposte, ed è il motivo per cui si CHIEDE invece di saperlo.
 *
 * ⚠️ IL COMMENTO CHE STAVA QUI DICHIARAVA UN NUMERO, ED È INVECCHIATO IN DUE GIORNI:
 * «`SELECT count(*) FROM scuole` → 4, righe con `config->'anagrafica' ?
 * 'legale_rappresentante'` → 0 — per tutte e tre le sedi vere quel rifiuto è l'unico che
 * accade». Il campo non esisteva in nessun form del prodotto (`zAnagraficaSede` non
 * conosceva la chiave, e `normalizzaAnagraficaSede` RICOSTRUISCE l'oggetto dai soli campi
 * noti: scriverla a mano nel database non serviva, il primo salvataggio la cancellava);
 * dal 2026-08-15 la chiave sta nello schema, il campo sta in Impostazioni → Sede &
 * Intestazione, e i valori veri sono stati scritti. **Quel «0» è quindi falso**, e chi lo
 * leggesse crederebbe rotto un percorso che funziona. Qui non si rimette un numero nuovo,
 * che invecchierebbe allo stesso modo: si lascia la query, che risponde sempre.
 *
 * ```sql
 * SELECT count(*) FILTER (WHERE btrim(coalesce(config->'anagrafica'->>'legale_rappresentante','')) <> '') FROM scuole;
 * ```
 *
 * E arrivava a schermo con la frase sbagliata. Il rifiuto del render porta
 * `PRESTAMPATO_FIRMA_NON_VALIDA`, la cui frase di catalogo è «La firma non risulta raccolta
 * o non è valida: il documento non si genera prima della firma» (`messages/it/shared.json`):
 * manda la segreteria a cercare la firma di un GENITORE mentre a mancare è un campo delle
 * impostazioni di sede. Questo motivo esiste per dire l'altra cosa, e per dirla col codice
 * giusto — `PRESTAMPATO_DATI_MANCANTI`, la cui frase è «completali in anagrafica e riprova».
 */
export type MotivoNonGenerabile =
  /** Vuole la firma di un genitore, e oggi nessuna schermata gliela chiede. */
  | 'firma_senza_flusso'
  /** I dati che deve riportare non stanno in nessuna tabella leggibile oggi. */
  | 'fonte_dati_assente'
  /** Lo firma il legale rappresentante, e il suo nome non è nella configurazione di sede. */
  | 'legale_rappresentante_assente'

/**
 * I tre modelli il cui precompilato NON si può costruire con le sole tabelle che questo
 * lavoro può leggere.
 *
 * · **39 sollecito** vuole la riga di pagamento con scadenza, residuo e giorni di ritardo;
 * · **47 certificato di servizio** vuole i periodi di servizio di una dipendente;
 * · **50 registro presenze** vuole il mese di presenze di una sezione.
 *
 * Nessuna delle tre fonti sta fra le tabelle di questa fase, e il divieto è esplicito:
 * niente migrazioni, niente colonne inventate. Perciò il pannello lo dice PRIMA — un
 * pulsante che porta a un 422 è peggio di un pulsante spento — e la route rifiuta con
 * `PRESTAMPATO_DATI_MANCANTI`. Quando le tre letture arriveranno, questo insieme si
 * accorcia e non cambia nient'altro.
 */
const FONTE_DATI_ASSENTE: ReadonlySet<string> = new Set([
  'sollecito_pagamento',
  'certificato_servizio',
  'registro_presenze',
])

/**
 * Gli slug che il banco della FAMIGLIA contiene davvero.
 *
 * Si CHIEDE al registro invece di elencarli a mano: `prestampatiPerRuolo('genitore')` è la
 * stessa funzione con cui quel banco si costruisce
 * (`src/app/api/parent/prestampati/banco-famiglia.ts`), quindi il giorno in cui il verbale di
 * infortunio entrerà nel flusso della famiglia la frase mostrata qui smetterà di essere
 * falsa da sola. Un elenco scritto a mano resterebbe indietro, e nessuno riaprirebbe questo
 * file per aggiornarlo.
 */
const NEL_FLUSSO_DELLA_FAMIGLIA: ReadonlySet<string> = new Set(
  prestampatiPerRuolo('genitore').map((v) => v.slug),
)

// ─── I tre modi di lavorare su un modulo di famiglia ────────────────────────────

/**
 * I TRE MODI, e il vincolo che li tiene insieme: **un foglio non deve MAI dichiarare una
 * firma elettronica che non è avvenuta.**
 *
 *  · **`copia_firmata`** — non si genera niente: si ripesca dal fascicolo il PDF che il
 *    genitore ha sottoscritto davvero (`student_documents`, `document_type` = lo slug). È
 *    l'unico dei tre che porta il riquadro FEA, e lo porta perché quella firma c'è stata;
 *  · **`copia_vuota`** — il modulo su carta per chi non usa l'app: intestazione, dati
 *    dell'alunno già scritti, e tutto il resto da compilare a penna. Il blocco firma è la
 *    RIGA DA FIRMARE, non il riquadro FEA;
 *  · **`su_carta`** — il modulo tornato compilato e firmato su carta, che la segreteria
 *    trascrive nell'app. Al posto del riquadro FEA c'è la dicitura
 *    «Modulo consegnato su carta il gg/mm/aaaa, firmato in originale agli atti», **senza
 *    nessuna scansione allegata** (decisione esplicita del titolare).
 *
 * ⚠️ CHE DUE DEI TRE NON PORTINO IL RIQUADRO FEA NON È UNA SCELTA GRAFICA. Il riquadro
 * dice «Firmato da …, codice OTP verificato, riferimento …»: su un foglio che nessuno ha
 * firmato elettronicamente è un'attestazione falsa prodotta dalla scuola su sé stessa, e
 * finirebbe nel fascicolo di un minore. Il presidio non è questo commento: è
 * `firma: { tipo: 'nessuna' }` in `componiModuloDiFamiglia`, più i test che leggono il testo
 * del PDF e pretendono che «Firmato da» non ci sia.
 */
export const MODALITA_MODULO_FAMIGLIA = ['copia_firmata', 'copia_vuota', 'su_carta'] as const
export type ModalitaModuloFamiglia = (typeof MODALITA_MODULO_FAMIGLIA)[number]

/**
 * I modi disponibili per questo modello, o `null` se la domanda non si pone.
 *
 * Si CHIEDONO al registro invece di elencare sei slug a mano: la condizione è «il banco
 * della famiglia lo contiene» **e** «il suo blocco di firma è quello del genitore»
 * (`bloccoFirma`, la stessa funzione con cui il render decide cosa disegnare). I due
 * certificati 26·27 e 28 stanno nel banco della famiglia ma li firma il legale
 * rappresentante: nascono già oggi allo sportello e di modi non ne hanno.
 *
 * ⚠️ `verbale_infortunio` e `valutazione_infanzia` NON entrano, e va detto perché non è una
 * dimenticanza: hanno lo stesso blocco di firma ma non stanno nel banco della famiglia, e
 * soprattutto `componiPrestampato` non sa comporli — il loro precompilato vuole l'organico
 * in servizio e le griglie di osservazione, che questo banco non legge. Restano
 * `firma_senza_flusso` finché quel precompilato non arriva.
 */
export function modalitaDelModello(
  voce: VocePrestampato,
): readonly ModalitaModuloFamiglia[] | null {
  return NEL_FLUSSO_DELLA_FAMIGLIA.has(voce.slug) && bloccoFirma(voce.firma) === 'genitore'
    ? MODALITA_MODULO_FAMIGLIA
    : null
}

/**
 * CIÒ CHE SI SA DELLA SEDE quando si fa la domanda — l'unica parte della risposta che il
 * registro dei diciassette non porta con sé.
 *
 * ⚠️ `undefined` E `null` NON SONO LA STESSA COSA, ed è tutto il senso di questo tipo:
 * `undefined` è «non l'ho letta» (l'elenco senza parametri, che nasce prima ancora che una
 * sede sia stata scelta, e in cui rispondere «non generabile» sarebbe un'affermazione su un
 * dato mai guardato), `null` o stringa vuota sono «l'ho letta e non c'è». Un campo
 * facoltativo che vale per tutti e due i casi darebbe la stessa risposta a due domande
 * diverse, e la più cara delle due è dichiarare spento un pulsante che invece funziona.
 */
export interface ContestoSede {
  /**
   * `scuole.config.anagrafica.legale_rappresentante`, nella stessa forma in cui il
   * precompilato lo espone (`PrefillPrestampato.legaleRappresentante`).
   */
  legaleRappresentante?: string | null
}

/**
 * Perché questo foglio non si genera allo sportello, o `null` se si genera.
 *
 * ⚠️ LA FIRMA È IL MOTIVO PIÙ FREQUENTE, e non è un limite di questa route: otto dei
 * diciassette attestano una firma elettronica del genitore (§3a di `00-impaginazione.md`).
 * Un foglio di quel tipo generato dal banco uscirebbe con il riquadro «firmato
 * elettronicamente da …» sopra una firma che nessuno ha apposto — cioè un'attestazione
 * falsa prodotta dalla scuola su sé stessa. Il banco non può dichiararla al posto della
 * famiglia. Di quegli otto, **sei** la firma la raccolgono davvero nel flusso OTP
 * (`forms_submissions`) e **due** — il verbale di infortunio e il documento di valutazione —
 * non ce l'hanno da nessuna parte: è la differenza fra i due motivi qui sopra, e non è
 * accademica, perché la frase che il pannello mostra manda una persona da qualche parte.
 *
 * Il render arriverebbe alla stessa conclusione (`PRESTAMPATO_FIRMA_NON_VALIDA`), e la
 * regola è la sua: qui si anticipa soltanto, perché rifiutare DOPO aver caricato
 * anagrafica, genitori e sede significherebbe leggere i dati di un minore per un documento
 * che non poteva uscire. Ciò che non si legge non si può perdere.
 *
 * ─── IL QUARTO MOTIVO SI CHIEDE, GLI ALTRI TRE SI SANNO ─────────────────────────
 *
 * I primi tre si leggono nella voce di registro, che è la stessa ovunque; il quarto dipende
 * dalla SEDE, e con tre plessi la stessa domanda può avere due risposte. Perciò `contesto`
 * è facoltativo e la sua assenza non è mai un «no»: chi non ha ancora letto la
 * configurazione riceve la risposta statica, chi l'ha letta riceve anche questa. È il motivo
 * per cui la route può chiamare questa funzione DUE volte sulla stessa richiesta — prima di
 * leggere l'anagrafica di un bambino, con quel che sa; e dopo, con il nome in mano — senza
 * che i due elenchi di ciò che è generabile possano divergere.
 */
export function motivoNonGenerabile(
  voce: VocePrestampato,
  contesto: ContestoSede = {},
): MotivoNonGenerabile | null {
  if (FONTE_DATI_ASSENTE.has(voce.slug)) return 'fonte_dati_assente'
  if (voce.firma === 'otp_genitore' || voce.firma === 'otp_due_genitori') {
    // «Chi la firma» e «dove la si firma» sono due domande diverse, e per un po' qui se ne
    // faceva una sola: vedi `NEL_FLUSSO_DELLA_FAMIGLIA`.
    //
    // I sei del banco della famiglia NON sono più un rifiuto: allo sportello nascono in una
    // delle tre modalità, e due delle tre non dichiarano nessuna firma elettronica. Chi
    // chiede la modalità sbagliata — o non la chiede affatto — riceve un rifiuto dalla
    // route, che è il posto in cui quella scelta esiste; qui la domanda è un'altra, ed è
    // «questo foglio può nascere allo sportello?». Per loro, ora, sì.
    if (modalitaDelModello(voce)) return null
    return 'firma_senza_flusso'
  }
  // Il blocco di firma si CHIEDE al registro (`bloccoFirma`) invece di confrontare
  // `voce.firma === 'legale_rappresentante'`: è la stessa funzione che il render usa per
  // decidere quale blocco disegnare, quindi la condizione che rifiuta qui e quella che
  // rifiuterebbe là non possono scollarsi.
  if (
    bloccoFirma(voce.firma) === 'legaleRappresentante' &&
    contesto.legaleRappresentante !== undefined &&
    !contesto.legaleRappresentante?.trim()
  ) {
    return 'legale_rappresentante_assente'
  }
  return null
}

/**
 * La frase che accompagna il rifiuto: dice dove si fa, non solo che qui non si fa — e
 * quando non si fa da nessuna parte lo dice, invece di indicare una porta che non esiste.
 */
export const SPIEGAZIONE_NON_GENERABILE: Record<MotivoNonGenerabile, string> = {
  firma_senza_flusso:
    'Questo documento si chiude con la firma elettronica del genitore, e oggi non c’è ancora una schermata che la raccolga: non è possibile generarlo.',
  fonte_dati_assente:
    'I dati che questo documento deve riportare non sono ancora disponibili in anagrafica: non è possibile generarlo.',
  // Dice DOVE si ripara, che è l'unica parte utile: il rimedio sono due minuti nelle
  // impostazioni della sede, e senza questa frase la stessa persona cerca la firma di un
  // genitore che nessuno ha mai chiesto.
  legale_rappresentante_assente:
    'Questo documento lo firma il legale rappresentante, e il suo nome non è indicato nella configurazione della sede: aggiungilo in Impostazioni → Sede & Intestazione e riprova.',
}

/** Una voce dell'elenco che il pannello disegna. */
export interface VoceElenco {
  slug: string
  etichetta: string
  soggetto: VocePrestampato['soggetto']
  firma: VocePrestampato['firma']
  protocollo: VocePrestampato['protocollo']
  archiviazione: VocePrestampato['archiviazione']
  /** Falso quando il pulsante va spento: `motivo` dice perché, e la frase lo spiega. */
  generabile: boolean
  motivo?: MotivoNonGenerabile
  /**
   * I tre modi di lavorare su un modulo di famiglia, quando il modello ne ha
   * (`modalitaDelModello`). Assente sugli altri undici, e l'assenza è il dato: il pannello
   * chiede la modalità **solo** dove esiste una scelta da fare, invece di mostrare tre
   * pulsanti su un certificato che di modi ne ha uno.
   */
  modalita?: readonly ModalitaModuloFamiglia[]
}

/**
 * La voce come il pannello la legge. Sta qui e non nelle route perché le due la producono
 * tutte e due — l'elenco e la scheda del singolo modello — e due mappature che divergono
 * significano un pulsante acceso in una schermata e spento nell'altra.
 *
 * `contesto` è quello di `motivoNonGenerabile`: chi ha già letto la configurazione della
 * sede lo passa, e la voce esce con `generabile: false` prima che qualcuno prema il
 * pulsante. Chi non l'ha letta lo omette, e la voce dice ciò che si sa.
 */
export function voceElenco(v: VocePrestampato, contesto: ContestoSede = {}): VoceElenco {
  const motivo = motivoNonGenerabile(v, contesto)
  const modalita = modalitaDelModello(v)
  return {
    slug: v.slug,
    etichetta: v.etichetta,
    soggetto: v.soggetto,
    firma: v.firma,
    protocollo: v.protocollo,
    archiviazione: v.archiviazione,
    generabile: motivo === null,
    ...(motivo ? { motivo } : {}),
    ...(modalita ? { modalita } : {}),
  }
}

/**
 * L'elenco di un banco, **senza contesto di sede**, e la scelta va detta perché è una
 * rinuncia: `legale_rappresentante_assente` non compare mai qui.
 *
 * Non è una dimenticanza. Questo elenco risponde alla domanda «cosa posso generare?», che
 * il pannello fa PRIMA di scegliere la sede e il soggetto — e con tre plessi la risposta
 * non è una sola: lo stesso certificato può essere generabile a Giugliano e non a Cesa,
 * perché quel nome sta in `scuole.config.anagrafica` di ciascuna. Rispondere «no» leggendo
 * la configurazione di una sede scelta a caso sarebbe peggio del silenzio, e leggerle tutte
 * e tre per disegnare una tendina sarebbe tre letture per un elenco statico.
 *
 * Il pulsante si spegne dove la sede è nota: sulla scheda del singolo modello, che il GET
 * serve con il precompilato del bambino in mano (`../route.ts`), e sulla generazione, che
 * rifiuta 422 col motivo prima di consumare un numero di protocollo.
 *
 * ⚠️ `.map((v) => voceElenco(v))` E NON `.map(voceElenco)`: il secondo passa l'INDICE come
 * secondo argomento, cioè il contesto di sede sarebbe `0`. Oggi `tsc` lo ferma — `number`
 * non è un `ContestoSede` — ma la riga esplicita dice perché non si torna indietro.
 */
export function elencoPerRuolo(ruolo: RuoloRichiedente): VoceElenco[] {
  return prestampatiPerRuolo(ruolo).map((v) => voceElenco(v))
}

/**
 * I ruoli dell'app ammessi a QUESTO foglio, da dare a `requireDocente`.
 *
 * Non è esportata: la sola porta è `cancelloDelModello` qui sotto, perché l'elenco dei
 * ruoli serve a una cosa sola — richiamare il gate con quello — e due chiamanti che se lo
 * passano da soli sono due modi di negare.
 *
 * La regola di lettura asimmetrica (la segreteria vede anche ciò che è del genitore) sta
 * in `prestampatiPerRuolo`, quindi si ricava da lì e non da `voce.disponibilePer`.
 *
 * ⚠️ IL CANCELLO È SUL BANCO, NON SUL RUOLO, e chi legge deve saperlo: i ruoli si ricavano
 * dai BANCHI in cui il modello compare, e ogni banco si riespande in tutti i suoi ruoli.
 * `valutazione_infanzia` dichiara `['educator','coordinator','admin']` → banchi `insegnante`
 * e `segreteria` → ruoli `['admin','coordinator','segreteria']`: il ruolo `segreteria`, che
 * quel modello NON nomina, passa di qui. È voluto — allo sportello i tre ruoli sono la
 * stessa persona per la modulistica, ed è tutto il senso di `RuoloRichiedente` — ma è anche
 * la ragione per cui non si può scrivere «questo gate impedisce alla segreteria di …»: non
 * lo fa. Chi volesse davvero il ruolo dichiarato intersechi qui `voce.disponibilePer`
 * mappato sui ruoli dell'app, in un punto solo.
 */
function ruoliAppDelModello(voce: VocePrestampato): AppRole[] {
  const banchi: RuoloRichiedente[] = ['segreteria', 'insegnante']
  const ammessi = new Set<string>()
  for (const banco of banchi) {
    if (prestampatiPerRuolo(banco).some((v) => v.slug === voce.slug)) {
      for (const ruolo of ruoliAppDelBanco(banco)) ammessi.add(ruolo)
    }
  }
  return [...ammessi] as AppRole[]
}

/**
 * IL CANCELLO DEI RUOLI DEL MODELLO, in un posto solo: `null` se passa, la risposta del
 * gate se non passa.
 *
 * Stava scritto due volte — nel GET e nel POST — e le due copie erano già divergenti: una
 * aveva in fondo un `if (negato.user) user = negato.user` che l'altra non aveva, e che non
 * poteva eseguirsi mai (ci si arriva solo quando il ruolo NON è fra gli ammessi, e la
 * seconda chiamata con quell'elenco può quindi soltanto negare). Due copie dello stesso
 * blocco che divergono sono il modo in cui un giorno un ruolo passa da una porta e non
 * dall'altra.
 *
 * Il diniego lo emette il GATE — con la sua frase, il suo 403 e la sua riga `ruolo-negato` —
 * invece di una risposta scritta a mano: per «questo prestampato non è del tuo banco» un
 * codice d'errore non esiste, e il lock `errori-con-codice` vieta a un file nuovo di
 * rispondere senza codice.
 */
export async function cancelloDelModello(
  request: NextRequest,
  voce: VocePrestampato,
  ruoloUtente: AppRole,
): Promise<NextResponse | null> {
  const ammessi = ruoliAppDelModello(voce)
  if (ammessi.includes(ruoloUtente)) return null
  const negato = await requireDocente(request, ammessi)
  // `negato.response` assente qui significherebbe che il gate ha ammesso un ruolo che
  // l'elenco non contiene: non accade, e in quel caso si prosegue come prima — la portata
  // del soggetto (alunno o sezione) resta comunque davanti.
  return negato.response ?? null
}

// ─── Il soggetto: un bambino, oppure una sezione ────────────────────────────────

/** La sezione, già letta e già dentro la portata di chi chiede. */
export interface ContestoSezione {
  sezioneId: string
  scuolaId: string
  nome: string | null
  livello: string | null
  /** Le righe della stampa: nomi, e — solo dove servono — diete e contatti. */
  alunni: RigaStampaSezione[]
  /**
   * Gli id dei bambini dell'elenco, nello stesso ordine delle righe.
   *
   * Non finiscono sul foglio — `RigaStampaSezione` non ha un campo `id`, e non deve
   * averlo — e servono a una cosa sola: la riga di `fascicolo_accessi_audit` che la §49
   * punto 2 pretende per ogni stampa («chi ha stampato l'elenco di quale sezione e
   * quando»). Quel registro è per ALUNNO, quindi l'estrazione di venticinque bambini si
   * traccia con venticinque righe: senza gli id, la route non saprebbe di chi parlare.
   */
  idAlunni: readonly string[]
  sede: NucleoSede
  /**
   * La data CIVILE italiana di questa generazione (`YYYY-MM-DD`), letta UNA volta sola.
   *
   * ⚠️ ERANO DUE LETTURE DELLO STESSO OROLOGIO, e su un foglio solo. La riga «Luogo e data»
   * nasce qui dentro (`carta.luogoData`), il piede del n. 49 — «Riservato — dati di
   * minori · 14/08/2026 · Rossi Maria» — nasceva in `componiPrestampato` da una seconda
   * chiamata a `isoDiOggi()`: fra le due passano le query dei venticinque bambini, dei
   * genitori e dei delegati, e a cavallo della mezzanotte le due date sullo stesso foglio
   * non sono la stessa. Sul foglio della cucina la data è il dato che conta più di tutti —
   * «il rischio non è che manchi: è che sia vecchio» (specifica n. 49) — e due date
   * discordi su una stampa che si appende è il modo peggiore di romperlo: si legge quella
   * che capita.
   *
   * La cucitura NON si fa iniettando l'orologio dall'esterno. Un parametro `oggi` c'era, in
   * questa firma, e non lo passava nessuno: chiudeva il buco solo per chi si ricordava di
   * usarlo, cioè per nessuno. Si legge una volta e si porta con sé.
   */
  dataIso: string
  /** Righe di carta intestata e riga «Luogo e data», già composte. */
  carta: { intestazione: string[]; luogoData: string }
}

export type ContestoPrestampato =
  | { soggetto: 'alunno'; prefill: PrefillPrestampato }
  | { soggetto: 'sezione'; sezione: ContestoSezione }

interface RigaSezioneDb {
  id: string
  name: string | null
  school_type: string | null
  scuola_id: string | null
}

interface RigaAlunnoSezione {
  id: string
  nome: string | null
  cognome: string | null
  data_nascita: string | null
  classe_sezione: string | null
  stato: string | null
  /**
   * Le tre colonne dell'art. 9, OPZIONALI nel tipo perché lo sono nella query: quando la
   * stampa non le stampa non vengono nemmeno chieste, e il tipo lo dice invece di lasciar
   * credere che ci siano sempre. E sono chieste in DUE gruppi distinti, non in blocco:
   * vedi `LetturaSezione`.
   *
   * ⚠️ `allergeni` È UN ARRAY, non una stringa: `text[] DEFAULT '{}'` nel baseline
   * (`20260704120000_baseline.sql`), e `SELECT pg_typeof(allergeni) FROM alunni` in
   * produzione risponde `text[]` (misurato in sola lettura il 2026-08-14). Dichiararlo
   * `string | null` non era un refuso di tipo: leggerlo con `testo()` — che per un array
   * torna `null` — cancellava dal foglio della cucina i bambini le cui allergie sono
   * registrate SOLO lì, e se nessun altro aveva `allergies` in testo libero il PDF usciva
   * dichiarando «Nessun bambino della sezione ha allergie, intolleranze o diete speciali
   * registrate». Una negazione esplicita, appesa in cucina, su un dato mai letto.
   */
  allergies?: string | null
  allergeni?: string[] | null
  note_mediche?: string | null
}

const COLONNE_ALUNNO_SEZIONE_BASE = 'id, nome, cognome, data_nascita, classe_sezione, stato'
/** 49.b — le DUE registrazioni della dieta, quella strutturata e quella in testo libero. */
const COLONNE_DIETE = 'allergies, allergeni'
/** 49.c — la nota sanitaria, che il foglio della cucina non stampa in nessuna colonna. */
const COLONNE_NOTE_SANITARIE = 'note_mediche'

/**
 * Le colonne OPZIONALI di quella query, cioè quelle che un ambiente non migrato può non
 * avere: le tre sanitarie e quella dell'oblio. Le sei di base ci sono dal baseline, e se
 * mancassero quelle non sarebbe una lacuna di schema ma un altro database.
 *
 * L'ordine conta solo perché la ricerca si ferma alla prima: sono nomi disgiunti, nessuno
 * è sottostringa di un altro.
 */
const COLONNE_FRAGILI = ['anonimizzato_il', 'note_mediche', 'allergeni', 'allergies'] as const
type ColonnaFragile = (typeof COLONNE_FRAGILI)[number]

/**
 * QUALE colonna manca davvero, letta dal `message` di PostgREST.
 *
 * È l'unica fonte che lo sa: il `code` dice solo «lo schema non regge» (`42703` la colonna,
 * `PGRST204` la cache dello schema, `42P01`/`PGRST205` la tabella), e il chiamante non può
 * dedurlo da ciò che ha chiesto — chiede quattro colonne fragili in una volta sola.
 *
 * `null` quando il messaggio non nomina nessuna di quelle: è il caso della TABELLA assente,
 * e chi lo riceve lo dichiara invece di indovinare una colonna.
 */
function colonnaMancante(err: unknown): ColonnaFragile | null {
  const messaggio = (err as { message?: unknown } | null)?.message
  if (typeof messaggio !== 'string') return null
  return COLONNE_FRAGILI.find((c) => messaggio.includes(c)) ?? null
}

/** L'`esito` da scrivere in `app_log`: il GRUPPO a cui appartiene la colonna che manca. */
function esitoColonnaAssente(err: unknown): string {
  switch (colonnaMancante(err)) {
    case 'allergeni':
    case 'allergies':
      return 'colonne-diete-assenti'
    case 'note_mediche':
      return 'colonne-note-sanitarie-assenti'
    // `anonimizzato_il` non arriva mai qui — il ripiego dell'oblio la intercetta prima — e
    // `null` è la tabella che non esiste: in tutti e due i casi la colonna non si nomina.
    default:
      return 'colonne-sanitarie-non-identificate'
  }
}

/** La `select` di un bambino di sezione, composta su ciò che la stampa stampa davvero. */
function colonneAlunnoSezione(lettura: LetturaSezione): string {
  return [
    COLONNE_ALUNNO_SEZIONE_BASE,
    ...(lettura.conDiete ? [COLONNE_DIETE] : []),
    ...(lettura.conNoteSanitarie ? [COLONNE_NOTE_SANITARIE] : []),
  ].join(', ')
}

/**
 * Il 503 di una lettura che non è riuscita ADESSO, e che una seconda volta può riuscire.
 *
 * ⚠️ NON PORTA IL MOTIVO NELLA FRASE, e prima lo faceva. Il pannello non mostra il campo
 * `error`: `esito-fetch` traduce per `codice`, e i tre rifiuti di questo file avevano lo
 * stesso codice — quindi «(sezione)», «(elenco alunni)» e «(colonne sanitarie assenti)»
 * viaggiavano fino al client per non essere letti da nessuno, mentre un test li asseriva
 * come se fossero visibili. Ciò che distingue i casi sta dove serve a chi indaga: il campo
 * `esito` delle righe di `logEvento` qui sotto, che è persistito e si interroga in SQL.
 */
function rifiutoLetturaTransitoria(): NextResponse {
  return NextResponse.json(
    {
      error: 'Non è stato possibile leggere i dati della sezione. Riprova fra qualche minuto.',
      codice: 'PRESTAMPATI_ELENCO_NON_LETTO',
    },
    { status: 503 },
  )
}

/**
 * Il rifiuto di una lacuna dello SCHEMA, che domani risponderà uguale.
 *
 * Codice e status diversi dal precedente, e la distinzione è la stessa che le due route
 * fanno nel loro `catch` finale: `PRESTAMPATI_ELENCO_NON_LETTO` si traduce in «Riprova fra
 * qualche minuto» (`messages/it/shared.json`), e mandare qualcuno a ripremere un pulsante
 * per una colonna che non esiste è peggio che non dirgli niente. `PRESTAMPATO_DATI_MANCANTI`
 * è già il codice con cui questo sportello rifiuta i tre modelli la cui fonte dati non
 * esiste ancora (`SPIEGAZIONE_NON_GENERABILE.fonte_dati_assente`), ed è esattamente questo
 * caso: il dato che il foglio deve riportare non c'è da nessuna parte.
 *
 * Un codice suo — «colonne sanitarie assenti su questo ambiente» — sarebbe più preciso, ma
 * `CODICI_ERRORE` vive in `src/lib/ui/esito-fetch.ts`, che non è di questa mano: segnalato,
 * non scritto.
 */
function rifiutoColonneAssenti(): NextResponse {
  return NextResponse.json(
    {
      error:
        'I dati sanitari che questa stampa deve riportare non sono disponibili su questo ambiente: non è stato generato niente.',
      codice: 'PRESTAMPATO_DATI_MANCANTI',
    },
    { status: 422 },
  )
}

/**
 * La sezione c'è ma non dice a quale plesso appartiene.
 *
 * Stesso codice di `rifiutoColonneAssenti`, e non è un riuso distratto: sono lo stesso
 * fatto — «un dato che il foglio deve riportare non c'è, e non ci sarà nemmeno fra cinque
 * minuti» — con lo stesso rimedio, completarlo in anagrafica. Un codice nuovo per dire la
 * stessa cosa sarebbe la trappola del codice DUPLICATO che `esito-fetch.ts` documenta;
 * quello che cambia fra i due casi vive dove serve a chi indaga, cioè nel campo `esito`
 * delle righe di `logEvento`.
 */
function rifiutoSezioneSenzaSede(): NextResponse {
  return NextResponse.json(
    {
      error: 'Questa sezione non risulta associata a nessuna sede: non è stato generato niente.',
      codice: 'PRESTAMPATO_DATI_MANCANTI',
    },
    { status: 422 },
  )
}

/**
 * Che cosa la stampa chiesta stampa DAVVERO, gruppo per gruppo.
 *
 * Quattro interruttori e non uno, perché le tre stampe del n. 49 non chiedono le stesse
 * cose e trattarle come se lo facessero è il modo silenzioso di far attraversare l'art. 9
 * di venticinque minori a un foglio che porta solo nomi.
 *
 * ⚠️ `conDiete` E `conNoteSanitarie` SONO DUE, e per un po' sono stati uno solo
 * (`conSanitari`). Il foglio della cucina ha sette colonne — nome, sezione, allergie,
 * alimenti, sostituzioni, motivo, documento — e `note_mediche` non è nessuna di quelle:
 * il modello non la legge (`modelloStampeSezione`, ramo `allergie`) e nemmeno `haDieta()`
 * la guarda. Con un interruttore solo, l'anamnesi di venticinque bambini attraversava la
 * query, la mappatura e il render per finire nel nulla. Il costo di leggerla era intero,
 * il beneficio zero.
 */
export interface LetturaSezione {
  /** 49.c — i recapiti delle famiglie e le persone autorizzate al ritiro. */
  conContatti: boolean
  /** 49.b — `allergies` + `allergeni`: il foglio della cucina. */
  conDiete: boolean
  /** 49.c — `note_mediche`: allergia grave, epilessia, terapia salvavita. */
  conNoteSanitarie: boolean
  /** 49.a — le insegnanti della sezione, l'unica delle tre stampe che le riporta. */
  conInsegnanti: boolean
}

/**
 * Il minimo assoluto: nomi, date e stato. È ciò che basta a CONTARE i bambini di una
 * sezione, che è la sola cosa che il GET del pannello deve rispondere.
 */
export const SOLO_CONTEGGIO: LetturaSezione = {
  conContatti: false,
  conDiete: false,
  conNoteSanitarie: false,
  conInsegnanti: false,
}

/**
 * Quanto di una sezione serve leggere per la stampa che è stata chiesta.
 *
 *  · `elenco` → nomi, date e le insegnanti della sezione. Niente diete, niente recapiti;
 *  · `allergie` → il foglio della cucina: le due colonne della dieta, e nient'altro;
 *  · `emergenze` → recapiti delle famiglie, persone autorizzate al ritiro **e** le note
 *    sanitarie che servono in emergenza.
 *
 * `risposte` è il corpo GREZZO — lo schema del modello lo validerà poco più avanti — e per
 * questo ogni interruttore nasce spento: un valore malformato fa leggere di MENO, mai di
 * più. Se era un refuso, il rifiuto arriva comunque dallo schema; se era un tentativo, non
 * ha portato via niente.
 */
export function letturaPerStampa(risposte: unknown): LetturaSezione {
  const stampa =
    typeof risposte === 'object' && risposte !== null
      ? (risposte as { stampa?: unknown }).stampa
      : undefined
  return {
    conContatti: stampa === 'emergenze',
    conDiete: stampa === 'allergie',
    conNoteSanitarie: stampa === 'emergenze',
    conInsegnanti: stampa === 'elenco',
  }
}

/**
 * Carica la sezione e i suoi bambini.
 *
 * @param opzioni i quattro interruttori di `LetturaSezione` — ciascun gruppo di dati sta
 *   nella `select` (o in una query in più), non in un filtro applicato dopo: chiederli
 *   sempre li fa attraversare il processo anche quando il chiamante vuole un CONTEGGIO —
 *   che è ciò che fa il GET del pannello — e ciò che non si legge non si può perdere.
 *
 * @param opzioni.sediAmmesse le sedi entro cui la sezione deve stare, quando il chiamante
 *   ne ha un elenco. Il gate del PLESSO è `assertSezioneInScope` e viene prima; questo è
 *   l'altro strato, quello che il ramo dell'alunno ha sempre avuto (`resolveScuoleAttive`):
 *   dice «questa sezione non è nella sede che hai davanti» a chi ne ha tre e ne ha
 *   selezionata una sola. Sta QUI e non nella route perché il posto giusto per rifiutare è
 *   prima di leggere i venticinque bambini, non dopo.
 *
 * ⚠️ `stato` è DICHIARATO nella query e non filtrato dopo: si leggono gli iscritti e i
 * sospesi, mai i ritirati. Il modello sa già escludere i sospesi (`includi_sospesi`) e per
 * saperlo ha bisogno di vederli — ma un bambino ritirato in un elenco di sezione è un
 * bambino che la cucina prepara e la maestra aspetta.
 */
export async function caricaSezione(
  supabase: SupabaseClient,
  sezioneId: string,
  opzioni: LetturaSezione & {
    sediAmmesse?: readonly string[]
  },
): Promise<{ sezione: ContestoSezione; response?: undefined } | { response: NextResponse }> {
  const { data: sezioneRaw, error: errSezione } = await supabase
    .from('sections')
    .select('id, name, school_type, scuola_id')
    .eq('id', sezioneId)
    .maybeSingle()
  if (errSezione) {
    logEvento('modulistica', 'error', {
      operazione: 'prestampati/banco',
      esito: 'sezione-non-letta',
      sezione_id: sezioneId,
      error_code: codicePostgrest(errSezione),
    }, errSezione)
    return { response: rifiutoLetturaTransitoria() }
  }
  // ⚠️ DUE CASI, DUE RIFIUTI, e per un po' sono stati uno solo — con il codice sbagliato.
  // Rispondevano insieme `ALUNNO_NON_APRIBILE`, la cui frase tradotta dice «Questo bambino
  // non è più nell'elenco di questa postazione»: il pannello mostra la frase del CODICE e
  // non il campo `error` (è il principio che questo stesso file argomenta due volte, in
  // `rifiutoLetturaTransitoria` e in `rifiutoColonneAssenti`), quindi chi sta allo sportello
  // leggeva una frase su un BAMBINO mentre il problema era la SEZIONE, e andava a cercare
  // il bambino sbagliato.
  const sezione = (sezioneRaw as unknown as RigaSezioneDb | null) ?? null
  if (!sezione) {
    // La riga non c'è ADESSO, e un istante fa c'era: `assertSezioneInScope` gira prima di
    // questa funzione in tutte e due le route, e per una sezione inesistente risponde già
    // 404 con la sua frase. Arrivarci qui vuol dire che la riga è sparita fra le due
    // letture — cioè un caso transitorio, in cui «riprova» è l'istruzione giusta: il
    // secondo tentativo incontra il 404 del gate, che è il posto in cui quel rifiuto vive.
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/banco',
      esito: 'sezione-sparita-fra-le-due-letture',
      sezione_id: sezioneId,
    })
    return { response: rifiutoLetturaTransitoria() }
  }
  const scuolaId = sezione.scuola_id?.trim()
  if (!scuolaId) {
    // Una sezione senza sede non è un guasto e non si aggiusta aspettando: è un dato
    // incompleto in archivio, e su questo foglio pesa davvero — la carta intestata si
    // COMPONE dalla sede (`leggiSede`), quindi senza uscirebbe una stampa che non dice da
    // quale plesso viene. `PRESTAMPATO_DATI_MANCANTI` dice esattamente questo e manda a
    // completare l'anagrafica, che è il rimedio vero; non nomina nessun bambino.
    logEvento('modulistica', 'error', {
      operazione: 'prestampati/banco',
      esito: 'sezione-senza-sede',
      sezione_id: sezioneId,
    })
    return { response: rifiutoSezioneSenzaSede() }
  }

  // La sede della sezione dentro quelle che il chiamante ammette, PRIMA di leggere i
  // bambini: un elenco che non si può consegnare non si legge nemmeno.
  if (opzioni.sediAmmesse && !opzioni.sediAmmesse.includes(scuolaId)) {
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/banco',
      esito: 'sezione-fuori-dalle-sedi-attive',
      sezione_id: sezioneId,
      scuola_id: scuolaId,
      n: opzioni.sediAmmesse.length,
    })
    return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') }
  }

  const alunni = await leggiAlunniDiSezione(supabase, sezioneId, scuolaId, opzioni)
  if (alunni.response) return { response: alunni.response }

  const idAlunni = alunni.righe.map((a) => a.id)
  // I due contorni della stampa delle emergenze: chi si chiama, e chi è autorizzato a
  // portare via il bambino. Nessuno dei due ferma il foglio se non si legge — il degrado
  // è previsto e loggato dentro le due funzioni.
  const contatti = opzioni.conContatti
    ? await leggiContatti(supabase, idAlunni)
    : new Map<string, string>()
  const delegati = opzioni.conContatti
    ? await leggiDelegati(supabase, idAlunni)
    : new Map<string, string>()
  // Le insegnanti sono della SEZIONE, non del singolo bambino: una lettura sola, ripetuta
  // su ogni riga perché la tabella del n. 49.a ha quella colonna per riga.
  const insegnanti = opzioni.conInsegnanti ? await leggiInsegnanti(supabase, sezioneId) : null

  const sede = await leggiSede(supabase, scuolaId)
  // L'UNICA lettura dell'orologio di questa generazione: da qui escono sia la riga «Luogo e
  // data» qui sotto sia il piede del foglio, che la compone `componiPrestampato` da
  // `dataIso`. Vedi il commento del campo in `ContestoSezione`.
  const oggiIso = isoDiOggi()

  return {
    sezione: {
      sezioneId,
      scuolaId,
      nome: testo(sezione.name),
      livello: testo(sezione.school_type),
      alunni: alunni.righe.map((a) =>
        componiRigaSezione(a, {
          contattiGenitori: contatti.get(a.id) ?? null,
          altriContatti: delegati.get(a.id) ?? null,
          insegnanti,
        }),
      ),
      idAlunni,
      sede: {
        nome: sede.nome,
        codiceMeccanografico: sede.codiceMeccanografico,
        telefono: sede.telefono,
      },
      dataIso: oggiIso,
      carta: {
        intestazione: buildIntestazioneSede({
          scuola_nome: sede.nome,
          scuola_indirizzo: sede.indirizzo,
          scuola_cap: sede.cap,
          scuola_citta: sede.citta,
          scuola_provincia: sede.provincia,
          scuola_codice_meccanografico: sede.codiceMeccanografico,
        }),
        luogoData: rigaLuogoData(sede.citta, isoToIt(oggiIso)),
      },
    },
  }
}

/** La data CIVILE italiana: su Vercel il processo gira in UTC, e alle 00:30 sarebbe ieri. */
function isoDiOggi(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

async function leggiAlunniDiSezione(
  supabase: SupabaseClient,
  sezioneId: string,
  scuolaId: string,
  lettura: LetturaSezione,
): Promise<
  { righe: RigaAlunnoSezione[]; response?: undefined } | { response: NextResponse; righe?: undefined }
> {
  const conSanitari = lettura.conDiete || lettura.conNoteSanitarie
  // Il filtro di SEDE sta nella stessa query del filtro di sezione, e non è ridondante:
  // da quando le sedi sono tre il nome di una classe non è più una chiave univoca, e un
  // `section_id` da solo si fida di un id che arriva dal client.
  const query = (colonne: string, conOblio: boolean) => {
    const q = supabase
      .from('alunni')
      .select(colonne)
      .eq('section_id', sezioneId)
      .eq('scuola_id', scuolaId)
      .in('stato', [STATO_ISCRITTO, STATO_SOSPESO])
    return (conOblio ? q.is('anonimizzato_il', null) : q)
      .order('cognome', { ascending: true })
      .limit(300)
  }

  // Le colonne sanitarie entrano nella `select` solo se la stampa le stampa, e a GRUPPI:
  // è la differenza fra «l'elenco non le mostra» e «l'elenco non le ha mai lette».
  let { data, error } = await query(colonneAlunnoSezione(lettura), true)

  // ⚠️ PRIMO RIPIEGO: MANCA SOLO LA COLONNA DELL'OBLIO, e le sanitarie ci sono.
  //
  // 🔴 Prima non esisteva, e il ramo qui sotto lo copriva con la risposta sbagliata: la
  // query chiede `anonimizzato_il` INSIEME alle colonne della stampa, quindi su un ambiente
  // dove manca solo quella — che è precisamente il DB E2E della CI, il caso per cui questi
  // rami esistono — il foglio della cucina riceveva un 422 «i dati sanitari non sono
  // disponibili su questo ambiente» mentre `allergies` e `allergeni` c'erano entrambe.
  // Un rifiuto che accusa una colonna che c'è manda chi indaga a cercare la migrazione
  // sbagliata.
  //
  // Rileggere senza il filtro dell'oblio non è un allentamento: dove `anonimizzato_il` non
  // esiste non esiste nemmeno un bambino anonimizzato. `info` e non `warn` — è il DB della
  // CI, e un `warn` a ogni stampa renderebbe illeggibile il canale proprio dove servirebbe.
  if (error && SCHEMA_ASSENTE.has(codicePostgrest(error) ?? '') && colonnaMancante(error) === 'anonimizzato_il') {
    logEvento('modulistica', 'info', {
      operazione: 'prestampati/banco',
      esito: 'colonna-oblio-assente',
      error_code: codicePostgrest(error),
    })
    ;({ data, error } = await query(colonneAlunnoSezione(lettura), false))
  }

  if (error && SCHEMA_ASSENTE.has(codicePostgrest(error) ?? '')) {
    if (conSanitari) {
      // 🔴 NON SI RIPIEGA QUANDO LA STAMPA È QUELLA DELLA CUCINA O DELLE EMERGENZE.
      // Rileggere senza le colonne del gruppo chiesto farebbe uscire il foglio 49.b con la
      // frase «Nessun bambino della sezione ha allergie, intolleranze o diete speciali
      // registrate» — che a quel punto non descriverebbe l'archivio ma il fatto che
      // l'archivio non è stato interrogato. È lo stesso difetto che il ramo qui sotto
      // dichiara di voler evitare per la lettura fallita, e un foglio appeso in cucina non
      // distingue le due cose. Meglio non stampare niente e dirlo.
      //
      // ⚠️ `esito` DICE QUALE COLONNA MANCA, e per un giro ha detto un'altra cosa: era
      // `lettura.conDiete ? … : …`, cioè quale STAMPA era stata chiesta, sotto un commento
      // che prometteva «quale dei due gruppi mancava». Il nome vero si legge dal `message`
      // di PostgREST (`column alunni.allergeni does not exist`), che è l'unica fonte che lo
      // sa; quando il messaggio non nomina nessuna delle colonne chieste — `42P01`, la
      // TABELLA che non c'è — l'esito lo dichiara invece di indovinare.
      //
      // In produzione le tre colonne esistono (baseline `20260704120000`), quindi questo
      // ramo è la trappola disarmata, non un caso quotidiano: scatta sul DB della CI, che è
      // un progetto separato e non migrato.
      logEvento('modulistica', 'error', {
        operazione: 'prestampati/banco',
        esito: esitoColonnaAssente(error),
        sezione_id: sezioneId,
        error_code: codicePostgrest(error),
      }, error)
      // 422 e non 503: una colonna che non esiste non esisterà nemmeno fra cinque minuti,
      // e il codice del 503 si traduce in «Riprova fra qualche minuto». Vedi
      // `rifiutoColonneAssenti`.
      return { response: rifiutoColonneAssenti() }
    }
    // Ambiente non migrato e stampa che non stampa niente di sanitario: si riprova col
    // minimo assoluto — sei colonne, nessun filtro dell'oblio. Non è un allentamento: dove
    // `anonimizzato_il` non esiste non esiste nemmeno un bambino anonimizzato. `info` e non
    // `warn` — è il DB della CI, e un `warn` a ogni stampa renderebbe illeggibile il canale
    // proprio dove servirebbe.
    logEvento('modulistica', 'info', {
      operazione: 'prestampati/banco',
      esito: 'colonne-alunno-assenti',
      error_code: codicePostgrest(error),
    })
    ;({ data, error } = await query(COLONNE_ALUNNO_SEZIONE_BASE, false))
  }
  if (error) {
    // PostgREST non lancia: senza questo ramo una lettura fallita uscirebbe come «sezione
    // vuota», cioè un elenco di cucina che dichiara che nessuno ha allergie.
    logEvento('modulistica', 'error', {
      operazione: 'prestampati/banco',
      esito: 'alunni-sezione-non-letti',
      sezione_id: sezioneId,
      error_code: codicePostgrest(error),
    }, error)
    return { response: rifiutoLetturaTransitoria() }
  }
  return { righe: (data ?? []) as unknown as RigaAlunnoSezione[] }
}

/**
 * `alunno_id → «Cognome Nome — telefono; …»`, per la sola stampa delle emergenze.
 *
 * ⚠️ L'ORDINE È IL DATO, non un dettaglio di presentazione: l'intestazione stampata su quel
 * foglio dice «Genitori (in ordine di chiamata)» (§49.c, `modelli/segreteria.ts`), e per un
 * po' i genitori finivano nella cella nell'ordine arbitrario in cui PostgREST li
 * restituisce — cioè un'intestazione che afferma una priorità che i dati non portano, su un
 * foglio che si legge mentre un bambino sta male. La colonna che quell'ordine lo esprime
 * esiste dal baseline: `student_parents.is_primary boolean DEFAULT false`.
 *
 * Il `.order` qui sotto è quindi parte del contenuto del foglio, e l'ordine si conserva fino
 * alla cella: `perAlunno` accumula nell'ordine delle righe lette e la composizione finale lo
 * ripercorre.
 *
 * ─── 🔴 QUANTO VALE DAVVERO, MISURATO SUI DUE SCRITTORI ─────────────────────────
 *
 * Poco, nel caso ordinario, e il commento che stava qui lo lasciava credere di più.
 * `is_primary` non è «il referente»: i due soli punti del repo che scrivono
 * `student_parents` lo mettono a `true` **sia alla madre sia al padre**
 * (`src/lib/anagrafiche/parents.ts` e `src/app/api/admin/import/anagrafiche/route.ts`, tutti
 * e due `role === 'mother' || role === 'father'`). Per la famiglia con due genitori —
 * cioè quasi tutte — questa clausola non muove niente, e la fila resta quella dell'archivio
 * esattamente come prima. Dove muove: quando accanto ai genitori c'è un delegato o un
 * tutore, che `is_primary` non ce l'ha, e allora i genitori vengono comunque prima.
 *
 * L'ordine di chiamata VERO vorrebbe una colonna sua, e sta in «Cosa manca al database»
 * (`docs/prestampati/README.md`) insieme ai contatti d'emergenza della 05: la stessa lacuna
 * che la §49.c dichiara poco più sotto per `leggiDelegati`. Finché non c'è, questo è il
 * criterio più vicino che l'archivio porta, e non si finge che sia quello.
 *
 * ⚠️ `nullsFirst: false` NON È UN ORNAMENTO: `is_primary` è `nullable`, e in Postgres il
 * `DESC` mette i NULL PER PRIMI. Senza quella riga una riga col legame nullo — un import
 * a metà, una riga scritta a mano — precederebbe il genitore, cioè l'unico caso in cui
 * questa clausola serve sarebbe anche l'unico in cui sbaglia.
 *
 * ⚠️ `is_primary` si ORDINA ma non si LEGGE, ed è la stessa disciplina con cui `prefill.ts`
 * dichiara di non selezionarlo affatto: qui serve a mettere in fila, non a comparire, e un
 * campo scaricato per non usarlo su una rotta che tratta l'art. 9 di venticinque bambini è
 * la stessa regola rotta.
 */
async function leggiContatti(
  supabase: SupabaseClient,
  idAlunni: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (idAlunni.length === 0) return out

  const { data: legami, error: errLegami } = await supabase
    .from('student_parents')
    .select('student_id, parent_id')
    .in('student_id', idAlunni)
    .order('is_primary', { ascending: false, nullsFirst: false })
  if (errLegami) {
    // Non ferma la stampa: il foglio esce senza i recapiti, che è il degrado previsto —
    // ma la riga si scrive, perché un elenco d'emergenza senza numeri è indistinguibile
    // da uno in cui le famiglie non hanno lasciato un recapito.
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/banco',
      esito: 'legami-famiglia-non-letti',
      n: idAlunni.length,
      error_code: codicePostgrest(errLegami),
    }, errLegami)
    return out
  }

  const perAlunno = new Map<string, string[]>()
  const idGenitori = new Set<string>()
  for (const r of (legami ?? []) as { student_id?: unknown; parent_id?: unknown }[]) {
    if (typeof r.student_id !== 'string' || typeof r.parent_id !== 'string') continue
    idGenitori.add(r.parent_id)
    perAlunno.set(r.student_id, [...(perAlunno.get(r.student_id) ?? []), r.parent_id])
  }
  if (idGenitori.size === 0) return out

  const { data: anagrafiche, error: errAnagrafiche } = await supabase
    .from('parents')
    .select('id, first_name, last_name, phone_numbers')
    .in('id', [...idGenitori])
  if (errAnagrafiche) {
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/banco',
      esito: 'anagrafiche-famiglia-non-lette',
      n: idGenitori.size,
      error_code: codicePostgrest(errAnagrafiche),
    }, errAnagrafiche)
    return out
  }

  const perGenitore = new Map<string, string>()
  for (const g of (anagrafiche ?? []) as unknown as {
    id: string
    first_name: string | null
    last_name: string | null
    phone_numbers: unknown
  }[]) {
    const nome = [g.last_name, g.first_name].map((p) => testo(p)).filter(Boolean).join(' ')
    const telefono = primoTelefono(g.phone_numbers)
    const riga = [nome, telefono].filter(Boolean).join(' — ')
    if (riga) perGenitore.set(g.id, riga)
  }

  for (const [alunnoId, genitori] of perAlunno) {
    const righe = genitori.map((id) => perGenitore.get(id)).filter(Boolean) as string[]
    if (righe.length > 0) out.set(alunnoId, righe.join(' · '))
  }
  return out
}

/** `parents.phone_numbers` è un array Postgres: si prende la prima voce non vuota. */
function primoTelefono(valore: unknown): string | null {
  if (!Array.isArray(valore)) return testo(valore)
  for (const v of valore) {
    const t = testo(v)
    if (t) return t
  }
  return null
}

/**
 * `alunno_id → «Cognome Nome (nonna); …»` — la colonna «Altri contatti autorizzati» del
 * foglio delle emergenze, presa da `delegates`.
 *
 * ⚠️ NON È LA FONTE CHE LA SPECIFICA PREVEDE, e va detto perché il giorno in cui quella
 * arriva questa riga vada tolta e non affiancata. La §49.c dice che la colonna «si alimenta
 * dai contatti d'emergenza raccolti con la 05 — scheda sanitaria», che vogliono una tabella
 * con l'ORDINE DI CHIAMATA e che oggi non esiste (`docs/prestampati/README.md`, «Cosa manca
 * al database»). `delegates` è l'unica registrazione di persone autorizzate che l'archivio
 * abbia davvero, ed è vera: sono le persone che possono portare via il bambino.
 *
 * ⚠️ QUESTA COLONNA NON PORTA UN NUMERO DA CHIAMARE, e nemmeno può: `delegates` ha
 * `first_name`, `last_name`, `relation`, `document_number`, `document_url` — nessun
 * telefono (baseline `20260704120000_baseline.sql`). Un nome senza numero in un foglio
 * d'emergenza è meno di quanto la specifica vuole; è però molto più della colonna vuota che
 * c'era prima, perché dice all'educatrice CHI può presentarsi a prendere il bambino mentre
 * lei sta al telefono con qualcun altro. I numeri veri sono nella colonna accanto, quella
 * dei genitori.
 *
 * `document_number` NON si legge: è il numero di un documento d'identità e su questo foglio
 * non serve a niente. Ciò che non si legge non si può perdere — e questo foglio, per
 * costruzione, finisce appeso.
 */
async function leggiDelegati(
  supabase: SupabaseClient,
  idAlunni: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (idAlunni.length === 0) return out

  const { data, error } = await supabase
    .from('delegates')
    .select('student_id, first_name, last_name, relation')
    .in('student_id', idAlunni)
  if (error) {
    // Non ferma la stampa — il foglio esce con la colonna vuota, che è il degrado previsto
    // — ma la riga si scrive: «nessun delegato» e «non ho potuto guardare» hanno lo stesso
    // aspetto su carta e rimedi opposti.
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/banco',
      esito: 'delegati-non-letti',
      n: idAlunni.length,
      error_code: codicePostgrest(error),
    }, error)
    return out
  }

  const perAlunno = new Map<string, string[]>()
  for (const d of (data ?? []) as unknown as {
    student_id: unknown
    first_name: string | null
    last_name: string | null
    relation: string | null
  }[]) {
    if (typeof d.student_id !== 'string') continue
    // Cognome prima del nome, come nella colonna dei genitori e come nel piede del foglio:
    // due convenzioni dentro lo stesso PDF si leggono come due elenchi diversi.
    const nome = [d.last_name, d.first_name].map((p) => testo(p)).filter(Boolean).join(' ')
    if (!nome) continue
    const relazione = testo(d.relation)
    const riga = relazione ? `${nome} (${relazione})` : nome
    perAlunno.set(d.student_id, [...(perAlunno.get(d.student_id) ?? []), riga])
  }
  for (const [alunnoId, righe] of perAlunno) out.set(alunnoId, righe.join(' · '))
  return out
}

/**
 * Le insegnanti della sezione, per la colonna «Insegnanti» del n. 49.a.
 *
 * Il legame è `utenti_sezioni`, e si legge con `docentiDiSezione` invece che con una query
 * scritta qui: quella funzione scarta già i docenti cessati (`utenti.attivo = false`, e
 * `!== false` perché la colonna è nullable) e controlla il `{ error }` che PostgREST non
 * lancia. Una regola valida per due strade deve vivere in un posto solo — e l'elenco di chi
 * sta in una sezione è esattamente quella regola.
 *
 * ⚠️ COSTA TRE ANDATE E RITORNO, detto invece che taciuto: `docentiDiSezione` ne fa due
 * (`utenti_sezioni`, poi `utenti` per `attivo`) e qui se ne aggiunge una terza per i nomi.
 * Con una query sola — `utenti_sezioni` join `utenti` — se ne farebbe una, al prezzo di
 * riscrivere qui la regola dei cessati: due copie che un giorno divergono, e un elenco di
 * sezione che nomina una maestra che non lavora più lì. Una sola volta per stampa, non per
 * bambino.
 *
 * È un valore di SEZIONE ripetuto su ogni riga, e non un dato per bambino: la tabella del
 * 49.a ha quella colonna per riga perché nasce come foglio da compilare a mano, dove capita
 * che un bambino abbia un sostegno suo. Finché quel legame non esiste in archivio, la
 * colonna dice il vero per tutti.
 *
 * `null` quando non c'è nessun legame: il modello omette da sé le celle vuote, e una riga
 * di log per «questa sezione non ha docenti assegnati» sarebbe rumore — `docentiDiSezione`
 * scrive già la sua quando la lettura FALLISCE, che è l'altro caso.
 */
async function leggiInsegnanti(
  supabase: SupabaseClient,
  sezioneId: string,
): Promise<string | null> {
  const ids = await docentiDiSezione(supabase, sezioneId)
  if (ids.length === 0) return null

  const { data, error } = await supabase.from('utenti').select('id, cognome, nome').in('id', ids)
  if (error) {
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/banco',
      esito: 'nomi-insegnanti-non-letti',
      sezione_id: sezioneId,
      n: ids.length,
      error_code: codicePostgrest(error),
    }, error)
    return null
  }

  const nomi = ((data ?? []) as unknown as { cognome: string | null; nome: string | null }[])
    .map((u) => [u.cognome, u.nome].map((p) => testo(p)).filter(Boolean).join(' '))
    .filter(Boolean)
  return nomi.length > 0 ? nomi.join(' · ') : null
}

/**
 * La colonna «Allergie / intolleranze» del foglio della cucina: le DUE registrazioni
 * insieme, quella strutturata e quella in testo libero.
 *
 * `alunni.allergeni` è l'array delle chiavi canoniche (i 14 dell'allegato II Reg. UE
 * 1169/2011) e `alunni.allergies` è il testo che la segreteria ha scritto a mano: sono le
 * stesse due colonne che leggono `mensa/allergie-check`, `mensa/report` e
 * `mensa/prenotazioni`, e l'etichetta da mostrare la sa già `allergeneLabel` — chiave nota →
 * «Arachidi», chiave ignota → la chiave così com'è, che è ciò che serve qui: da un elenco
 * di cucina non deve sparire niente.
 *
 * ⚠️ NON si usa `allergeniAlunno()`, che è la regola gemella e serve a un'altra domanda.
 * Quella sceglie UNA delle due fonti — strutturata se c'è, altrimenti inferita dal testo —
 * ed è giusta per confrontare un bambino col menu del giorno, dove le chiavi devono
 * combaciare. Qui no: `inferisciAllergeniDaTesto('lattosio, fragole')` restituisce solo
 * `latte`, e «fragole» — che fra i 14 non c'è — sparirebbe dal foglio di chi prepara i
 * piatti. Le due fonti si sommano, e nessuna copre l'altra.
 */
function colonnaAllergie(a: RigaAlunnoSezione): string | null {
  const strutturati = (Array.isArray(a.allergeni) ? a.allergeni : [])
    .map((k) => testo(k))
    .filter((k): k is string => k !== null)
    .map(allergeneLabel)
  return [...strutturati, testo(a.allergies)].filter(Boolean).join(' · ') || null
}

/**
 * Una riga del database → una riga del foglio.
 *
 * ─── I CINQUE CAMPI CHE `RigaSezione` DICHIARA E QUI RESTANO VUOTI ──────────────
 *
 * Il modello ne dichiara dodici e questa funzione ne valorizza sette. Gli altri cinque non
 * sono una dimenticanza: sono colonne stampate e vuote, e una colonna vuota su un foglio
 * appeso dev'essere vuota per una ragione DETTA, non perché nessuno ci è arrivato.
 *
 *  · `note` (49.a) — non esiste in archivio, e non è un caso: sul cartaceo è la colonna che
 *    l'insegnante riempie a penna durante l'appello. `alunni` non ha una colonna «note»
 *    (baseline `20260704120000_baseline.sql`), e l'unico testo libero che ci somiglia è
 *    `note_mediche`, che è art. 9 e su un elenco di NOMI non deve passare nemmeno per
 *    sbaglio;
 *  · `pediatra` (49.c) — è la prima riga di «Cosa manca al database» in
 *    `docs/prestampati/README.md`: pediatra, ASL, vaccinazioni sono colonne da aggiungere ad
 *    `alunni`, e le migrazioni su questo database sono vietate. Finché non ci sono, la 05
 *    chiede il dato al genitore ogni volta e nessuna stampa può ripescarlo;
 *  · `alimentiDaEscludere`, `sostituzioni`, `motivoDieta`, `documentoDieta` (49.b) — sono
 *    le righe «alimento → sostituzione» del modulo 07, che per la stessa pagina del README
 *    vogliono una tabella nuova. La colonna «Allergie / intolleranze» accanto a loro NON è
 *    vuota, e regge il foglio da sola: `haDieta()` conta un bambino come «con dieta» anche
 *    quando solo quella è valorizzata.
 *
 * Quando quelle due fonti arriveranno, si valorizzano qui e nient'altro cambia.
 */
function componiRigaSezione(
  a: RigaAlunnoSezione,
  contorni: {
    contattiGenitori: string | null
    altriContatti: string | null
    /** Della SEZIONE, non del bambino: la stessa stringa su ogni riga. */
    insegnanti: string | null
  },
): RigaStampaSezione {
  return {
    cognome: testo(a.cognome) ?? '',
    nome: testo(a.nome) ?? '',
    dataNascita: a.data_nascita,
    sezione: testo(a.classe_sezione),
    // `attivo: false` è il bambino SOSPESO, che il modello esclude salvo richiesta
    // esplicita. I ritirati non arrivano fin qui: li ha già tolti la query.
    attivo: a.stato === STATO_ISCRITTO,
    insegnanti: contorni.insegnanti,
    allergie: colonnaAllergie(a),
    // Le note mediche entrano SOLO nel foglio delle emergenze, che è il loro posto: il
    // modello le stampa in quella colonna e non in altre.
    noteSanitarie: testo(a.note_mediche),
    contattiGenitori: contorni.contattiGenitori,
    altriContatti: contorni.altriContatti,
  }
}

interface SedeLetta {
  nome: string | null
  indirizzo: string | null
  citta: string | null
  cap: string | null
  provincia: string | null
  codiceMeccanografico: string | null
  /**
   * Il numero della segreteria. Non è un ornamento dell'intestazione: il n. 49 lo stampa in
   * DUE punti che sono quelli che si leggono nel momento peggiore — «In caso di dubbio non
   * somministrare e contattare la segreteria: {{sede.telefono}}» in fondo al foglio della
   * cucina, e «Numeri utili: 118 · {{sede.telefono}}» in fondo a quello delle emergenze.
   * Senza, il primo si chiude con «contattare la segreteria.» e il secondo con «Numeri
   * utili: 118» e basta.
   */
  telefono: string | null
}

/**
 * La sede, con lo stesso ripiego di `admin/protocolli/genera-documento`: `scuole` prima,
 * `schools` poi. Sono due tabelle che convivono da prima del multi-sede, e una carta
 * intestata vuota è un foglio che non si sa da dove venga.
 */
async function leggiSede(supabase: SupabaseClient, scuolaId: string): Promise<SedeLetta> {
  const { data, error } = await supabase
    .from('scuole')
    .select('nome, citta, indirizzo, config')
    .eq('id', scuolaId)
    .maybeSingle()
  if (error) {
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/banco',
      esito: 'sede-non-letta',
      scuola_id: scuolaId,
      error_code: codicePostgrest(error),
    }, error)
  }
  const riga = data as unknown as {
    nome: string | null
    citta: string | null
    indirizzo: string | null
    config: unknown
  } | null
  if (riga) {
    const anagrafica = parseAnagraficaSede(riga.config)
    return {
      nome: testo(anagrafica.denominazione) ?? testo(riga.nome),
      indirizzo: testo(riga.indirizzo),
      citta: testo(riga.citta),
      cap: anagrafica.cap ?? null,
      provincia: anagrafica.provincia ?? null,
      codiceMeccanografico: anagrafica.codice_meccanografico ?? null,
      telefono: anagrafica.telefono ?? null,
    }
  }

  const { data: ripiego, error: errRipiego } = await supabase
    .from('schools')
    .select('nome, citta, indirizzo')
    .eq('id', scuolaId)
    .maybeSingle()
  if (errRipiego) {
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/banco',
      esito: 'sede-ripiego-non-letto',
      scuola_id: scuolaId,
      error_code: codicePostgrest(errRipiego),
    }, errRipiego)
  }
  const s = ripiego as unknown as { nome: string | null; citta: string | null; indirizzo: string | null } | null
  return {
    nome: testo(s?.nome),
    indirizzo: testo(s?.indirizzo),
    citta: testo(s?.citta),
    cap: null,
    provincia: null,
    codiceMeccanografico: null,
    // `schools` non ha `config`: il ripiego è la tabella di prima del multi-sede, e lì
    // l'anagrafica non c'è. Il modello omette da sé la voce quando è `null`.
    telefono: null,
  }
}

// ─── La composizione ────────────────────────────────────────────────────────────

/**
 * ⚠️ `nucleoAlunno` E `nucleoSede` SI IMPORTANO, e per un giro sono state riscritte qui.
 *
 * Vivono in `@/lib/prestampati/prefill` — esportate, con il loro commento («la conversione
 * vive qui … invece che dentro ognuna delle route che comporranno quei nove») e con i loro
 * test di degrado (`__tests__/lib/prestampati-registro.test.ts`, «ciò che manca resta
 * `null`, e non diventa una stringa vuota») — e la route della famiglia le importa davvero.
 * Le due copie erano già divergenti dopo un giorno solo: la versione condivisa dichiara
 * `telefono: null` con la ragione scritta, la copia il campo lo ometteva e basta.
 *
 * Nessun ostacolo tecnico c'era: questo file importava GIÀ `PrefillPrestampato` da quel
 * modulo. È esattamente il difetto che `cancelloDelModello` argomenta poche righe più su —
 * due copie dello stesso blocco che divergono — applicato a sé stesso.
 */

/**
 * Modello + precompilato + risposte → i byte del PDF, per i sei fogli che oggi nascono
 * allo sportello.
 *
 * La firma è larga (`EsitoRender<unknown>`) e non generica, e la scelta va detta: chi
 * chiama non conosce il tipo delle risposte — arrivano da un `unknown` di `parseBody` — e
 * ogni ramo qui dentro è invece TIPIZZATO sul proprio modello, perché `renderPrestampato*`
 * lo pretende. È il confine giusto: dentro lo switch `tsc` verifica che il precompilato sia
 * quello del modello, fuori resta `unknown` e nessuno può leggerlo per sbaglio.
 *
 * ⚠️ Il ramo `default` NON è un caso impossibile da annotare: è dove finiscono gli undici
 * che `motivoNonGenerabile` ha già escluso. Chi chiama deve averlo interrogato PRIMA — se
 * non l'ha fatto, qui trova un rifiuto e non un PDF sbagliato.
 */
export function componiPrestampato(
  voce: VocePrestampato,
  contesto: ContestoPrestampato,
  risposte: unknown,
  opzioni: OpzioniRender,
  /**
   * Chi sta stampando, COGNOME e nome in quest'ordine. Lo pretende il piede del n. 49 —
   * «Riservato — dati di minori · 14/08/2026 · Rossi Maria» — che è ciò che rende
   * rintracciabile un elenco di allergie se finisce dove non deve. Non è il legale
   * rappresentante e non è il firmatario: quel foglio non si firma, si attribuisce.
   *
   * L'ordine è quello dell'archivio, ed è lo stesso con cui poche righe più su si compone
   * il nome di un genitore nella colonna dei recapiti (`leggiContatti`): due nomi scritti
   * al contrario dentro lo stesso PDF si leggono come due convenzioni, e chi cerca una
   * persona in un elenco cerca il cognome.
   */
  operatore: string | null,
  /**
   * La modalità scelta allo sportello, per i sei moduli di famiglia. Assente sugli altri
   * undici — che una scelta non ce l'hanno — e assente anche su `copia_firmata`, che non
   * passa di qui: quel foglio non si compone, si ripesca dal fascicolo.
   */
  moduloFamiglia?: OpzioniModuloFamiglia,
): EsitoRender<unknown> {
  // Gli otto della famiglia (05…10, 26·27, 28): il loro contratto valida e compone in un
  // colpo solo, e il registro garantisce che parlino tutti di un bambino.
  const famiglia = modelloGenitore(voce.slug)
  if (famiglia) {
    if (contesto.soggetto !== 'alunno') return rifiutoSoggetto()
    // I SEI CON LA FIRMA DEL GENITORE non passano dal render comune, e la deviazione va
    // detta perché è l'unica di questo file. `renderPrestampatoGenitore` → `assembla()` →
    // `componiFirma()` legge `bloccoFirma(voce.firma)` dal REGISTRO: per questi sei vale
    // sempre `'genitore'`, quindi o gli si passa una firma OTP raccolta — che allo sportello
    // non esiste — o il render rifiuta. Non c'è nessun modo, da qui, di chiedergli un foglio
    // «senza riquadro FEA»: la riparazione vera è una variante di `FirmaPrestampato`
    // (`src/lib/prestampati/tipi.ts`) e una `OpzioniRender.modalita` in `render.ts`, che non
    // sono file di questa mano — segnalata, non fatta.
    if (modalitaDelModello(voce)) {
      return componiModuloDiFamiglia(famiglia, contesto.prefill, risposte, opzioni, moduloFamiglia)
    }
    return renderPrestampatoGenitore(famiglia, contesto.prefill.dati, risposte, opzioni)
  }

  if (voce.slug === 'stampe_sezione') {
    if (contesto.soggetto !== 'sezione') return rifiutoSoggetto()
    const s = contesto.sezione
    return renderPrestampatoSegreteria(
      modelloStampeSezione,
      {
        sezione: { nome: s.nome },
        sede: s.sede,
        annoScolastico: annoScolasticoCorrente(),
        // La stessa data della riga «Luogo e data», non una seconda lettura dell'orologio:
        // il perché è nel commento di `ContestoSezione.dataIso`.
        dataStampa: s.dataIso,
        stampatoDa: operatore,
        alunni: s.alunni,
      },
      risposte,
      opzioni,
    )
  }

  if (contesto.soggetto !== 'alunno') return rifiutoSoggetto()
  const prefill = contesto.prefill
  const annoScolastico = prefill.dati.annoScolastico

  if (voce.slug === 'nulla_osta') {
    return renderPrestampatoSegreteria(
      modelloNullaOsta,
      { alunno: nucleoAlunno(prefill), annoScolastico },
      risposte,
      opzioni,
    )
  }
  if (voce.slug === 'richiesta_disponibilita') {
    return renderPrestampatoSegreteria(
      modelloRichiestaDisponibilita,
      { alunno: nucleoAlunno(prefill), annoScolastico },
      risposte,
      opzioni,
    )
  }
  if (voce.slug === 'certificato_competenze') {
    return renderPrestampatoSegreteria(
      modelloCertificatoCompetenze,
      {
        alunno: nucleoAlunno(prefill),
        sede: nucleoSede(prefill),
        annoScolastico,
        classe: prefill.dati.alunno.sezione,
      },
      risposte,
      opzioni,
    )
  }

  return {
    ok: false,
    errori: [{ campo: '', messaggio: SPIEGAZIONE_NON_GENERABILE.fonte_dati_assente }],
    codice: 'PRESTAMPATO_DATI_MANCANTI',
  }
}

/**
 * Soggetto sbagliato per questo modello: una scheda di sezione chiesta su un bambino, o
 * viceversa. Non è raggiungibile dalle due route — lo schema `zod` esige l'id che il
 * soggetto dichiara — e resta qui perché lo switch non si fidi di quella garanzia: il
 * giorno in cui una terza route chiamasse questa funzione, il rifiuto c'è già.
 */
function rifiutoSoggetto(): EsitoRender<unknown> {
  return {
    ok: false,
    errori: [{ campo: '', messaggio: 'Il soggetto indicato non è quello che questo prestampato descrive.' }],
    codice: 'PRESTAMPATO_DATI_MANCANTI',
  }
}

// ─── I moduli di famiglia allo sportello ────────────────────────────────────────

/**
 * LO STILE CHE IL CODICE CHIEDE E LA PAGINA NON MOSTRA.
 *
 * `disegnaParagrafo` (`src/lib/prestampati/impaginazione.ts`) traduce `'corsivo'` in
 * `setFont('helvetica', 'italic')`, e jsPDF lo scrive davvero nel PDF: misurato il
 * 2026-08-16 sul flusso di contenuto del modulo vuoto della delega, la riga d'introduzione
 * esce selezionata con `/F3 12 Tf` e `/F3` è `Helvetica-Oblique`. Solo che **i caratteri
 * arrivano sul foglio perfettamente dritti**: i quattordici font standard non sono
 * incorporati, e il rasterizzatore sostituisce una faccia non inclinata. Ritagliato a 400
 * dpi, «Modulo da compilare e firmare a penna…» non ha un grado di inclinazione.
 *
 * Il grassetto invece arriva. Quindi, finché quel difetto vive nel motore — che non è di
 * questa mano, ed è segnalato all'orchestratore — **`corsivo` non può essere l'unico
 * portatore di un significato**: un testo subordinato marcato solo così è, sulla carta,
 * indistinguibile dal corpo del testo. Qui non si usa, e il lock lo tiene fermo.
 */
export const STILE_NON_RESO = 'corsivo' as const

/**
 * LA RIGA DA FIRMARE A PENNA, e il motivo per cui viaggia dentro `luogoData` invece che
 * come blocco di contenuto.
 *
 * ⚠️ È LA RIPARAZIONE DI UNA PAGINA ORFANA, misurata il 2026-08-16 sui PDF veri: su 4 dei 6
 * moduli di famiglia la copia vuota usciva con un'ultima pagina che conteneva soltanto
 * «Data della firma ___ / Firma del genitore/tutore ___» in cima e «Luogo e data / Napoli,
 * lì …» sospeso a metà foglio, con sotto un terzo di pagina di bianco. Sulla delega il
 * contenuto di pagina 1 finiva a 219,5 mm e la riga di firma andava comunque sul foglio
 * dopo.
 *
 * LA CAUSA non era lo spazio: erano DUE MECCANISMI per un blocco solo. La riga da firmare
 * era un blocco di contenuto e scorreva col testo; «Luogo e data» non scorre affatto —
 * `disegnaFirma` lo ancora fra y=150 e y=240 — e l'impaginatore riserva quello spazio
 * togliendolo all'ULTIMO blocco di contenuto (`limitePerUltimoBlocco`, 235 mm). Cioè: la
 * riga da firmare competeva con la riserva fatta per la firma di cui è parte. Appena
 * traboccava, il gruppo si spezzava in due pagine.
 *
 * Qui le due metà tornano UNA COSA SOLA, disegnata da un meccanismo solo, nel posto che
 * l'impaginatore ha già riservato. Il foglio non ha più una coda che possa traboccare, e
 * l'orfano non è «meno probabile»: non ha più il modo di nascere.
 *
 * ⚠️ E LA DATA STAMPATA SPARISCE, che è un guadagno e non un effetto collaterale. Su un
 * modulo in bianco «Napoli, lì 16/08/2026» è la data in cui la segreteria ha STAMPATO il
 * foglio, messa accanto a una firma che la famiglia darà chissà quando: una data
 * pre-stampata su una sottoscrizione futura. Qui il luogo resta stampato e la data la
 * scrive chi firma, che è l'unico che la sa.
 *
 * ⚠️ I filetti sono trattini bassi e non i filetti grigi di `disegnaCella`, e va detto
 * perché non è una preferenza: `luogoData` è una stringa che `disegnaFirma` stampa con
 * `doc.text`, e da lì non si disegnano linee. La riparazione elegante è una variante
 * `{tipo:'penna'}` di `FirmaPrestampato` (`src/lib/prestampati/tipi.ts`) che disegni la
 * riga con i filetti veri accanto a «Luogo e data» — file non di questa mano, **segnalata
 * all'orchestratore**. Fra un foglio corretto con i trattini e uno elegante con una pagina
 * orfana, il modulo che la famiglia si porta a casa è il primo.
 *
 * La città NON è cablata: viene dal precompilato, come in `rigaLuogoData`, perché le sedi
 * sono tre e un nome scritto in un `.ts` è un nome che un giorno sarà sbagliato su venti
 * fogli nello stesso momento. La lunghezza sta nei 166 mm fra i margini
 * (`CARTA.margineSx` 22 → `margineDx` 188) a 11 pt, e il lock «la riga da firmare a penna
 * non va a capo» lo verifica sul PDF invece di fidarsi di questo conto.
 */
function rigaDaFirmareAPenna(citta: string | null | undefined): string {
  return `${rigaLuogoData(citta, '____________')}     Firma del genitore/tutore ____________________`
}

/** La scelta fatta allo sportello su un modulo di famiglia. */
export interface OpzioniModuloFamiglia {
  modalita: ModalitaModuloFamiglia
  /**
   * Il giorno in cui il modulo firmato è arrivato in segreteria, `YYYY-MM-DD`. Serve solo a
   * `su_carta`, ed è ciò che la dicitura stampa: senza, quella frase direbbe «consegnato su
   * carta il —», cioè un'attestazione senza data su un documento che va nel fascicolo.
   */
  consegnatoIl?: string | null
}

/**
 * LA DICITURA DEL MODULO TORNATO SU CARTA, parola per parola.
 *
 * ⚠️ NON SI RIFORMULA. È la frase che il titolare ha dettato, ed è l'unica cosa che sul
 * foglio dice perché lì non c'è né una firma elettronica né un tratto autografo: l'originale
 * firmato sta in archivio, di carta. Una scansione allegata NON c'è, ed è una decisione
 * esplicita — il PDF rimanda all'originale, non lo sostituisce.
 */
export function dicituraModuloSuCarta(dataIt: string): string {
  return `Modulo consegnato su carta il ${dataIt}, firmato in originale agli atti`
}

/**
 * I sei moduli di famiglia, allo sportello: **senza riquadro FEA, in nessuno dei due casi
 * che passano di qui.**
 *
 * `firma: { tipo: 'nessuna' }` è il presidio, e non è una scelta di stile. Il riquadro del
 * §3a stampa «Firmato da …», il metodo e il riferimento della ricevuta: su un foglio che
 * nessuno ha firmato elettronicamente sarebbe un'attestazione falsa prodotta dalla scuola su
 * sé stessa, dentro il fascicolo di un minore. `disegnaFirma` con `'nessuna'` stampa solo
 * «Luogo e data»: la riga da firmare a penna e la dicitura del modulo cartaceo arrivano come
 * BLOCCHI, cioè dallo stesso canale con cui i modelli scrivono tutto il resto.
 *
 * ⚠️ NON PASSA DA `assembla()` DI `render.ts`, e la deviazione è misurata invece che
 * preferita: quella funzione chiede la firma al REGISTRO (`bloccoFirma(voce.firma)`), che per
 * questi sei dice sempre `'genitore'`, e senza una firma OTP raccolta rifiuta. Ciò che
 * `assembla()` fa in più — la riga di protocollo e il riquadro di verifica — qui non si
 * perde: tutti e sei hanno `protocollo: 'nessuno'` nel registro, quindi `componiTestata()`
 * restituirebbe `{ riga: null, verifica: null }` e nient'altro. Il giorno in cui uno di loro
 * uscisse dalla scuola, questa funzione va rifatta passando dal render — e il test
 * «nessuno dei sei consuma numerazione» è ciò che lo farebbe notare.
 */
function componiModuloDiFamiglia(
  modello: ModelloGenitore,
  prefill: PrefillPrestampato,
  risposte: unknown,
  opzioni: OpzioniRender,
  scelta: OpzioniModuloFamiglia | undefined,
): EsitoRender<unknown> {
  if (!scelta) {
    // Irraggiungibile dalla route — lo schema `zod` la pretende su questi sei — e resta
    // perché la funzione non si fidi di una garanzia scritta in un altro file.
    return {
      ok: false,
      errori: [{ campo: 'modalita', messaggio: 'Indicare come si sta lavorando su questo modulo.' }],
      codice: 'PRESTAMPATO_DATI_MANCANTI',
    }
  }
  if (scelta.modalita === 'copia_firmata') {
    // La copia firmata non si COMPONE: si ripesca dal fascicolo, ed è la route a farlo.
    // Comporla qui vorrebbe dire rigenerare un foglio che dichiara una firma leggendola da
    // nessuna parte.
    return {
      ok: false,
      errori: [
        {
          campo: '',
          messaggio:
            'La copia firmata non si genera: si riprende dal fascicolo del bambino, dov’è archiviata dopo la firma della famiglia.',
        },
      ],
      codice: 'PRESTAMPATO_DATI_MANCANTI',
    }
  }

  let blocchi: BloccoPrestampato[]
  let risposteValidate: unknown = {}

  if (scelta.modalita === 'copia_vuota') {
    // Le risposte NON si validano, e non è una svista: questo foglio esiste perché nessuno
    // ha risposto niente — lo compilerà la famiglia a penna. Validarle rifiuterebbe il
    // modulo proprio nell'unico caso in cui deve uscire vuoto.
    blocchi = blocchiModuloVuoto(modello, prefill.dati)
  } else {
    const composto = modello.componi(prefill.dati, risposte)
    // Errori di CAMPO: niente `codice`, e la route li rimanda al form accanto al campo
    // sbagliato. Vedi `RifiutoRender` in `render.ts`.
    if (!composto.ok) return { ok: false, errori: composto.errori }
    risposteValidate = composto.risposte

    const dataIt = isoToIt(scelta.consegnatoIl?.trim() ?? '')
    if (!dataIt) {
      return {
        ok: false,
        errori: [
          {
            campo: 'consegnatoIl',
            messaggio: 'Indicare il giorno in cui il modulo firmato è arrivato in segreteria.',
          },
        ],
      }
    }
    if ((scelta.consegnatoIl ?? '') > isoDiOggi()) {
      // Una consegna nel futuro non è un refuso qualunque: finisce STAMPATA su un documento
      // che entra nel fascicolo di un minore e dichiara che un originale firmato esiste già.
      return {
        ok: false,
        errori: [
          {
            campo: 'consegnatoIl',
            messaggio: 'La data di consegna non può essere nel futuro: il modulo è già arrivato.',
          },
        ],
      }
    }

    blocchi = [
      ...composto.blocchi,
      { tipo: 'spazio', mm: 4 },
      { tipo: 'paragrafo', testo: dicituraModuloSuCarta(dataIt), stile: 'grassetto' },
    ]
  }

  const documento: DocumentoPrestampato = {
    intestazione: opzioni.carta.intestazione,
    titolo: modello.titolo,
    // Tutti e sei hanno `protocollo: 'nessuno'` nel registro: nessun numero, nessuna
    // dicitura di copia, nessun riquadro di verifica. Vedi il commento della funzione.
    protocollo: null,
    blocchi,
    luogoData:
      scelta.modalita === 'copia_vuota'
        ? rigaDaFirmareAPenna(prefill.dati.sede.scuola_citta)
        : opzioni.carta.luogoData,
    firma: { tipo: 'nessuna' },
    verifica: null,
  }

  let pdf: Uint8Array
  try {
    pdf = buildPrestampatoPdf(documento)
  } catch (err) {
    // jsPDF lancia per davvero. Nel log lo slug, la modalità e il numero di blocchi: mai le
    // risposte, che qui dentro possono essere una diagnosi o un'allergia.
    logEvento('modulistica', 'error', {
      operazione: 'prestampati/banco',
      esito: 'modulo-famiglia-non-generato',
      tipo: modello.slug,
      evento: `modalita:${scelta.modalita}`,
      n: blocchi.length,
    }, err)
    return {
      ok: false,
      errori: [{ campo: '', messaggio: 'Non è stato possibile generare il documento.' }],
      codice: 'PRESTAMPATO_NON_GENERATO',
    }
  }

  return {
    ok: true,
    pdf,
    titolo: modello.titolo,
    risposte: risposteValidate,
    blocchiDopoFirmaNonStampati: 0,
  }
}

/** Una riga-campo stampata solo quando il valore c'è: mai un'etichetta senza niente sotto. */
function rigaSeValorizzata(etichetta: string, valore: string | null | undefined): RigaStampata[] {
  const v = testo(valore)
  return v ? [{ etichetta, valore: v }] : [{ etichetta }]
}

/**
 * IL MODULO VUOTO — intestazione e dati del bambino già scritti, tutto il resto da compilare
 * a penna.
 *
 * I blocchi si costruiscono dai DESCRITTORI del modello (`modello.campi`), non dalle
 * risposte: è l'unica fonte che sappia quali domande quel modulo fa, ed è la stessa che il
 * pannello usa per disegnare il form a schermo. Un elenco scritto a mano qui resterebbe
 * indietro al primo campo aggiunto — e resterebbe indietro in silenzio, perché un modulo di
 * carta a cui manca una domanda somiglia a un modulo di carta.
 *
 * ⚠️ I campi condizionali (`mostraSe`) SI STAMPANO TUTTI. A schermo si nascondono perché la
 * risposta di un altro campo li rende inutili; sulla carta nessuno sa ancora cosa la famiglia
 * risponderà, e una domanda tolta è una domanda che non tornerà più.
 *
 * È **esportata** per una ragione sola, e non è la comodità: i due presidi che questo foglio
 * ha — «nessuna microcopy dello schermo» e «nessuno stile che la pagina non rende» — si
 * verificano sull'albero dei blocchi, non sul PDF. Sul PDF si può provare che una frase non
 * c'è; non si può provare che uno STILE non è stato chiesto, perché `corsivo` e `normale`
 * arrivano sulla pagina identici (vedi `STILE_NON_RESO`), ed è precisamente la ragione per
 * cui il difetto è passato inosservato.
 */
export function blocchiModuloVuoto(modello: ModelloGenitore, dati: DatiPrestampato): BloccoPrestampato[] {
  const a = dati.alunno
  const nomeSede = testo(dati.sede.scuola_nome)

  const blocchi: BloccoPrestampato[] = [
    {
      tipo: 'paragrafo',
      testo:
        'Modulo da compilare e firmare a penna, e da riconsegnare in segreteria. I dati del bambino sono già stampati: controllali e correggili se qualcosa non torna.',
      // `grassetto` e non `corsivo`: vedi `STILE_NON_RESO`. È l'unica riga del foglio che
      // dice cosa farne, e deve staccarsi dalle domande.
      stile: 'grassetto',
    },
    { tipo: 'sezione', titolo: "Dati dell'alunno/a" },
    ...(nomeSede
      ? ([
          { tipo: 'caselle', caselle: [{ testo: `Sede: ${nomeSede}`, spuntata: true }] },
        ] satisfies BloccoPrestampato[])
      : []),
    {
      tipo: 'campi',
      colonne: 2,
      campi: [
        ...rigaSeValorizzata('Cognome', a.cognome),
        ...rigaSeValorizzata('Nome', a.nome),
        ...rigaSeValorizzata('Data di nascita', isoToIt(a.dataNascita ?? '')),
        ...rigaSeValorizzata('Luogo di nascita', a.luogoNascita),
        ...rigaSeValorizzata('Codice fiscale', a.codiceFiscale),
        ...rigaSeValorizzata('Sezione/Classe', a.sezione),
        ...rigaSeValorizzata('Anno scolastico', dati.annoScolastico),
      ],
    },
  ]

  // I campi «riservati all'ufficio» non stanno in mezzo alle domande della famiglia: vanno
  // nel riquadro in fondo, che è il blocco che il motore disegna apposta per la parte che la
  // segreteria compila DOPO la consegna.
  const perLaFamiglia = modello.campi.filter((c) => c.chiestoA !== 'segreteria')
  const perLUfficio = modello.campi.filter((c) => c.chiestoA === 'segreteria')

  for (const campo of perLaFamiglia) blocchi.push(...blocchiDelCampo(campo))

  // ⚠️ QUI NON C'È PIÙ LA RIGA DA FIRMARE A PENNA, e la riga tolta vale il commento: era un
  // BLOCCO di contenuto e per questo scorreva col testo, mentre l'altra metà della stessa
  // firma — «Luogo e data» — non scorre affatto. Due meccanismi per un blocco solo, che si
  // spezzava in due pagine appena il contenuto arrivava in fondo. Ora la riga viaggia dentro
  // `luogoData` e la disegna `disegnaFirma`, in un pezzo solo: vedi `rigaDaFirmareAPenna`.

  if (perLUfficio.length > 0) {
    blocchi.push({
      tipo: 'riquadro',
      titolo: 'Riservato all’ufficio',
      campi: perLUfficio.map((c) => ({ etichetta: c.etichetta })),
    })
  }

  return blocchi
}

/**
 * Un descrittore di campo → i blocchi che lo stampano vuoto.
 *
 * Ogni tipo di campo ha la sua forma sulla carta, e sbagliarla non è un difetto estetico: una
 * scelta fra cinque voci stampata come una riga vuota chiede alla famiglia di indovinare
 * quali fossero le cinque voci.
 *
 * ⚠️ TRE RAMI OGGI NON SI ESEGUONO, e vanno dichiarati invece di lasciar credere il
 * contrario: `conferma`, `sceltaMultipla` e `griglia` appartengono al contratto di
 * `modelli/segreteria.ts`, e nessuno dei sei moduli di famiglia li usa. Restano perché il
 * parametro è `CampoPrestampato` del REGISTRO — l'unione dei due contratti — e un ramo
 * mancante lì dentro non è un errore di compilazione: è un campo che sparisce dal foglio.
 *
 * ─── 🔴 `campo.aiuto` NON SI STAMPA, ED È UNA DECISIONE, NON UNA DIMENTICANZA ────
 *
 * Fino al 2026-08-16 questa funzione stampava `campo.aiuto` parola per parola, in coda a
 * ogni domanda. Ma `aiuto` è la **microcopy della schermata**, scritta per il form dentro
 * l'app, e riusarla su carta senza rileggerla ci porta frasi che parlano del canale
 * sbagliato. Letto sui PDF veri, non nel sorgente:
 *
 *  · permesso d'orario → «Sul cartaceo si dava per scontato "oggi": in app va detto, perché
 *    il permesso si compila anche la sera prima.» — una frase che, stampata sul cartaceo, si
 *    contraddice da sola;
 *  · scheda sanitaria → «… È il motivo per cui questa scheda esiste.» — una giustificazione
 *    interna di progetto, su un foglio che una madre compila a penna;
 *  · delega al ritiro → «I delegati diventano attivi solo dopo la firma di questo modulo,
 *    non prima.» — vero dell'app, non del foglio che sta per firmare.
 *
 * Un modulo di carta che dice «in app va detto» fa esattamente ciò che questo ramo esiste
 * per evitare: dichiara sul foglio qualcosa che sul foglio non è vero. E c'era un secondo
 * danno, misurato: l'aiuto usciva come paragrafo a 12 pt in nero a tutta larghezza, cioè più
 * vistoso dell'etichetta della domanda a cui si riferiva — chi riempiva il foglio leggeva
 * prima la nota e poi la domanda.
 *
 * La riparazione vera è un campo distinto nel descrittore (`aiutoStampa`, l'istruzione di
 * compilazione che vale anche su carta), che vive in `src/lib/prestampati/modelli/` e non in
 * questo file: **segnalata all'orchestratore, non fatta qui**. Finché non c'è, sul foglio
 * restano la domanda e lo spazio per rispondere — che è comunque un modulo, mentre un modulo
 * con addosso la microcopy di uno schermo è un modulo sbagliato.
 */
function blocchiDelCampo(campo: DescrittoreCampo): BloccoPrestampato[] {
  const etichetta = campo.etichetta.trim()

  if (campo.tipo === 'siNo' || campo.tipo === 'conferma') {
    return [
      { tipo: 'paragrafo', testo: `${etichetta}:`, stile: 'grassetto' },
      { tipo: 'caselle', caselle: [{ testo: 'Sì' }, { testo: 'No' }] },
    ]
  }

  if (campo.tipo === 'scelta' || campo.tipo === 'sceltaMultipla') {
    const caselle: CasellaPrestampato[] = (campo.opzioni ?? []).map((o) => ({ testo: o.etichetta }))
    // Un elenco CHIUSO rimasto senza voci è quello che l'app costruisce a runtime dai
    // delegati attivi: sulla carta non c'è un runtime, quindi si scrive a penna.
    if (caselle.length === 0) {
      return [{ tipo: 'campi', colonne: 1, campi: [{ etichetta }] }]
    }
    return [
      { tipo: 'paragrafo', testo: `${etichetta}:`, stile: 'grassetto' },
      { tipo: 'caselle', caselle },
    ]
  }

  if (campo.tipo === 'griglia') {
    const righe = (campo.opzioni ?? []).map((o) => [o.etichetta, ...(campo.valoriAmmessi ?? []).map(() => '')])
    return [
      { tipo: 'paragrafo', testo: `${etichetta}:`, stile: 'grassetto' },
      {
        tipo: 'tabella',
        intestazioni: ['', ...(campo.valoriAmmessi ?? []).map((v) => v.etichetta)],
        righe,
      },
    ]
  }

  if (campo.tipo === 'righe') {
    return [
      { tipo: 'paragrafo', testo: `${etichetta}:`, stile: 'grassetto' },
      {
        tipo: 'tabella',
        intestazioni: (campo.colonne ?? []).map((c) => c.etichetta),
        righe: [],
        // Tre righe libere: è il minimo che la specifica chiede sulle tabelle ripetibili,
        // perché un modulo consegnato deve poter essere completato a penna.
        righeVuote: 3,
      },
    ]
  }

  if (campo.tipo === 'file') {
    // `grassetto` come le altre domande, e NON `corsivo`: vedi `STILE_NON_RESO`.
    return [{ tipo: 'paragrafo', testo: `${etichetta}: da allegare al modulo.`, stile: 'grassetto' }]
  }

  if (campo.tipo === 'testoLungo') {
    // Tre righe e non una: un testo lungo scritto su un filetto solo finisce nel margine.
    return [
      { tipo: 'campi', colonne: 1, campi: [{ etichetta }, { etichetta: '' }, { etichetta: '' }] },
    ]
  }

  return [{ tipo: 'campi', colonne: 1, campi: [{ etichetta }] }]
}

/** La carta intestata del soggetto, qualunque esso sia. */
export function cartaDelContesto(contesto: ContestoPrestampato): OpzioniRender['carta'] {
  return contesto.soggetto === 'alunno'
    ? cartaDaDati(contesto.prefill.dati)
    : contesto.sezione.carta
}

/**
 * La scadenza da scrivere in `student_documents.expiry_date`, letta dalle risposte GIÀ
 * VALIDATE.
 *
 * Sono le risposte che lo schema del modello ha accettato — non il corpo grezzo — quindi i
 * campi letti qui hanno la forma `YYYY-MM-DD` per costruzione (`zDataYMD`). È ciò che il
 * cron `notifiche/scadenze-documenti` legge per avvisare la famiglia: un documento a
 * termine archiviato senza scadenza non scade mai, e nessuno se ne accorge.
 *
 * ─── CHI DICHIARA LA PROPRIA SCADENZA, E CON QUALE CAMPO ────────────────────────
 *
 *  · **06 autorizzazione farmaci** → `al`, «Durata del trattamento — al», obbligatorio;
 *  · **08 delega al ritiro** → `al`, che sulla delega a periodo è la fine e su quella per
 *    una singola occasione è il giorno stesso;
 *  · **09 permesso entrata/uscita** → `ricorrenzaFino` quando il permesso è ricorrente,
 *    altrimenti `giorno`. **Nessuno dei due si chiama `al`**, e per un po' questa funzione
 *    ha letto solo quello: ogni permesso finiva in archivio con `expiry_date: null`, cioè
 *    valido per sempre, contro la §09 che dice testualmente «`expiry_date` = giorno del
 *    permesso (o fine ricorrenza)». Un permesso di uscita anticipata che non scade è
 *    un'autorizzazione permanente firmata per un pomeriggio.
 *
 * **07 dieta speciale resta senza scadenza, ed è una scelta.** Il suo `validita` è
 * `z.string().trim().max(120)` — testo libero, perché sul certificato del medico c'è scritto
 * «per l'anno scolastico in corso» o «fino a nuovo controllo» tanto quanto una data. Non è
 * una data e non si può fingere che lo sia. Il ripiego che la §07 propone («o fine anno se
 * assente») vorrebbe una decisione di prodotto — quale fine anno, quella scolastica? — e
 * inventare una scadenza su un certificato medico è peggio di non averne una: la dieta
 * sparirebbe dalla cucina un giorno scelto da questo codice.
 *
 * `null` per tutti gli altri, che non scadono.
 */
export function scadenzaDaRisposte(risposte: unknown): string | null {
  if (typeof risposte !== 'object' || risposte === null) return null
  const r = risposte as { al?: unknown; ricorrenzaFino?: unknown; giorno?: unknown }
  // L'ordine è quello della precedenza: la fine della ricorrenza batte il singolo giorno,
  // perché un permesso «tutti i martedì fino al 30 novembre» vale fino a novembre.
  return dataIso(r.al) ?? dataIso(r.ricorrenzaFino) ?? dataIso(r.giorno)
}

/** `YYYY-MM-DD`, o `null`. Il vaglio della forma resta anche su risposte già validate. */
function dataIso(valore: unknown): string | null {
  return typeof valore === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valore) ? valore : null
}
