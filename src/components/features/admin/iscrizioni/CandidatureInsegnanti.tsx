'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useDateFormat } from '@/lib/i18n/date'
import {
  AlertTriangle, CheckCircle2, ChevronLeft, Clock, ExternalLink, FileText,
  KeyRound, Loader2, Mail, MapPin, UserCheck, Users, XCircle,
} from 'lucide-react'
import { StatCard } from '@/components/ui/cockpit'
import {
  GRADI_OPTIONS, POSIZIONI_OPTIONS, comprendeInsegnamento,
} from '@/lib/forms/insegnanti-template'
import { LIMITE_ISCRIZIONI_DEFAULT } from '@/lib/api/paginazione'
import { useSediAttive } from '@/lib/context/sede-context'
import { useAdminIdentity } from '@/lib/context/admin-identity'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { messaggioDaCorpo, messaggioErrore } from '@/lib/ui/esito-fetch'
import { AVVISO_FINESTRA_BLOCCATA, apriDocumentoFirmato } from '@/lib/ui/apri-documento-firmato'

/**
 * IL COCKPIT DELLE CANDIDATURE — lato segreteria del modulo `/lavora-con-noi`.
 *
 * ── PERCHÉ L'ELENCO È POVERO ─────────────────────────────────────────────────
 * È la stessa lezione di «Moduli ricevuti» (`ModuliRicevuti.tsx:33-42`), e la
 * route la applica già dal suo lato (`COLONNE_ELENCO`): in lista escono solo i
 * campi che servono a RICONOSCERE una candidatura — chi è, per quali fasce, in
 * quale stato, di quando. Email, telefono, titolo di studio, presentazione e
 * curriculum arrivano da `GET ?id=<uuid>`, cioè quando qualcuno apre QUELLA
 * candidatura: un gesto deliberato, e uno alla volta.
 *
 * Questo componente NON si limita a fidarsi della route: non disegna nemmeno i
 * campi del dettaglio a partire dalla riga d'elenco. Se domani la proiezione del
 * server tornasse generosa, l'elenco resterebbe povero lo stesso — il posto in
 * cui un recapito può comparire è uno solo, ed è il pannello di dettaglio.
 *
 * ── PERCHÉ OGNI RICHIESTA PORTA UN GETTONE ──────────────────────────────────
 * Due clic ravvicinati su due candidature diverse sono due `fetch` in volo, e
 * senza un gettone vince la risposta che arriva per ULTIMA, non il clic fatto
 * per ultimo: il pannello si rimpiazza da solo con la persona sbagliata, mentre
 * il pulsante «Approva» agisce su `selezionata.id`. Qui ogni apertura e ogni
 * caricamento d'elenco incrementano un contatore, e la risposta che non
 * corrisponde all'ultimo gesto viene SCARTATA — compreso lo spegnimento del velo
 * di caricamento, che altrimenti lo spegneva la prima risposta arrivata mentre
 * un'altra era ancora in volo.
 *
 * Il gettone del dettaglio copre anche la `PATCH`, ed è lì che conta di più: la
 * PATCH dura SECONDI veri (crea un'utenza e manda un'email), quindi la finestra
 * in cui si può aprire un'altra candidatura è enorme rispetto a quella di una
 * lettura. Fino al 2026-08-11 non ce l'aveva: la risposta atterrava sul pannello
 * aperto in quel momento, e ci scriveva la password dell'account di un'ALTRA
 * persona, timbrava `approvata` su una riga ancora in attesa e faceva sparire i
 * due pulsanti. Adesso quell'esito viene scartato — e DETTO, perché l'account è
 * stato creato lo stesso e chi ha premuto «Confermo» deve sapere dove guardare.
 *
 * Anche CHIUDERE il pannello («Indietro») avanza il gettone: è un cambio
 * d'apertura come un altro, e senza quella riga la risposta della PATCH tornava
 * su un pannello che non c'era più — cioè `esito` e `avvisi` si scrivevano dentro
 * un componente non montato e a schermo non restava NIENTE. Non un avviso, non la
 * password, non la frase del server che diceva che l'email non era partita:
 * account docente creato, credenziali perse, e nessuno che lo sapesse.
 *
 * ── DOVE FINISCE UN ESITO CHE NON SI PUÒ MOSTRARE ───────────────────────────
 * In un avviso fuori dal pannello, che NOMINA la persona e riporta l'esito per
 * intero, credenziali comprese: la password è monouso e non è archiviata da
 * nessuna parte, quindi buttarla vuol dire una reimpostazione obbligata — e con
 * l'email delle credenziali non partita vuol dire una docente che non entra mai.
 * Le voci si ACCUMULANO e se ne vanno solo con un gesto: fino al 2026-08-11
 * bastava aprire un'altra candidatura per azzerarle, cioè due clic.
 *
 * Le righe dell'elenco NON si spengono durante l'operazione, di proposito: la
 * PATCH dura secondi, e una segreteria che nel frattempo non può nemmeno leggere
 * un'altra candidatura è una schermata che sembra rotta. La difesa sta nella
 * risposta, non nel gesto. Per la stessa ragione l'operazione in corso è legata
 * all'`id` su cui si sta agendo: il pannello di un'ALTRA candidatura non deve
 * ritrovarsi i pulsanti spenti senza sapere perché.
 *
 * ── PERCHÉ «MOSTRA ALTRE» SI SPEGNE DURANTE UNA RILETTURA ───────────────────
 * `caricaAltre` ACCODA a ciò che è a schermo. Se una rilettura d'elenco (cambio
 * sede, o la ricarica dopo un'azione) è ancora in volo, ciò che è a schermo è la
 * lista VECCHIA e l'offset è calcolato su quella: accodare vorrebbe dire mettere
 * la pagina 2 della sede nuova in coda alle righe della sede vecchia. In un repo
 * con tre sedi vere un elenco che mescola plessi è la classe di difetto già
 * pagata dall'audit multi-sede, quindi il pulsante si spegne finché la rilettura
 * non è atterrata. Per la stessa ragione `caricaAltre` LEGGE il gettone senza
 * incrementarlo: un'accodatura non è un'identità d'elenco nuova, e incrementando
 * scartava la rilettura in corso invece di lasciarsi scartare da lei.
 *
 * ── PERCHÉ LE AZIONI SONO DISABILITATE PER LA SEGRETERIA ────────────────────
 * `PATCH` è riservata alla Direzione (`requireStaff(request, ['admin',
 * 'coordinator'])`): approvare CREA UN ACCOUNT DOCENTE, e un account docente
 * legge l'anagrafica dei bambini. Il gate vero è sul server e resta lì; qui i
 * pulsanti si mostrano SPENTI, con scritto il perché — scoprire il 403 dopo il
 * clic è il modo in cui un divieto legittimo si presenta come un guasto.
 *
 * ── PERCHÉ `in_approvazione` NON È AZIONABILE ───────────────────────────────
 * La route risponde `success: true` con `stato: 'in_approvazione'` quando
 * l'account docente È STATO CREATO ma la riga non è stata marcata come approvata
 * (`route.ts:865`). È un successo a metà, e va detto con parole sue: intestare
 * quel riquadro «Candidatura approvata» mentre il badge accanto dice «In
 * approvazione» sono due frasi contraddittorie nello stesso pannello. Da lì in
 * poi i due pulsanti restano SPENTI — «Rifiuta» è accettato dal server anche su
 * `in_approvazione` (`route.ts:893`) e manderebbe un'email di esito negativo a
 * una persona a cui le credenziali sono già state spedite.
 *
 * ── PERCHÉ MAI `alert()` ─────────────────────────────────────────────────────
 * Gli errori si mostrano in pagina, in una regione `role="alert"`, e non fanno
 * perdere quello che si stava scrivendo (il motivo del rifiuto è un testo
 * libero: un `alert` che chiude tutto lo butterebbe via).
 */

/** La riga d'ELENCO: esattamente le colonne che la route proietta in lista. */
interface RigaElenco {
  id: string
  scuola_id?: string | null
  /**
   * I plessi a cui la candidatura è rivolta, con lo stato di CIASCUNO.
   *
   * Dal 2026-08-19 una persona può proporsi a più sedi e ogni sede valuta per
   * conto suo. `scuola_id` qui sopra è la sede di PRIMO ARRIVO — un dato storico
   * — e non dice su quale plesso si sta decidendo.
   */
  sedi?: { scuola_id: string; stato?: string | null; evasa_il?: string | null }[] | null
  /**
   * Le righe di sede DI CHI GUARDA — l'embed filtrato del server.
   *
   * ⚠️ È QUI che vive `motivo_rifiuto`, e non in `sedi`. Quello non è filtrato
   * per sede (è il suo scopo: dire anche i plessi altrui), quindi ogni campo che
   * ci si mette viaggia cross-sede. La nota interna con cui una segreteria
   * giudica una persona non attraversa i plessi.
   */
  candidature_sedi?: { scuola_id: string; stato?: string | null; motivo_rifiuto?: string | null; evasa_il?: string | null }[] | null
  stato: string
  nome?: string | null
  cognome?: string | null
  /**
   * Le POSIZIONI stanno in elenco e le fasce no, dal 2026-08-15, ed è una
   * sostituzione e non un'aggiunta: sono loro il dato che RICONOSCE una
   * candidatura a colpo d'occhio (una cuoca da una maestra), mentre le fasce sono
   * ormai un valore DERIVATO da esse. Mostrarle entrambe farebbe della riga un
   * muro di etichette che dicono due volte la stessa cosa per le insegnanti e una
   * cosa vuota per tutti gli altri. Le fasce restano nel dettaglio.
   */
  posizioni?: unknown
  gradi?: unknown
  creata_il?: string | null
}

/** La candidatura APERTA: la riga d'elenco più tutto ciò che arriva da `?id=`. */
interface Candidatura extends RigaElenco {
  /** Il mestiere scritto a mano: c'è se e solo se fra le posizioni c'è «altro». */
  posizione_altro?: string | null
  email?: string | null
  telefono?: string | null
  residence_city?: string | null
  residence_province?: string | null
  titolo_studio?: string | null
  titolo_dettaglio?: string | null
  anni_esperienza?: number | null
  disponibilita?: string | null
  note?: string | null
  cv_path?: string | null
  motivo_rifiuto?: string | null
}

/**
 * L'esito di un'azione della Direzione, mostrato una volta e poi congedato.
 *
 * `stato` è quello che ha risposto il SERVER, non quello che si era chiesto: è
 * l'unica fonte che distingue un'approvazione chiusa da una rimasta a metà.
 */
interface Esito {
  azione: 'approva' | 'rifiuta'
  stato: string | null
  credentials?: { email: string; password: string } | null
  credentialsEmailSent?: boolean
  esitoEmailInviato?: boolean
  /**
   * QUALE DELLE TRE STORIE raccontare dopo un'approvazione, letto dal server e
   * non dedotto.
   *
   * Fino al 2026-08-15 le storie erano due e si distinguevano da
   * `credentials === null`: password mostrata (account nuovo) oppure «Nessuna
   * password generata: esisteva già un accesso con questa email». Dal giorno in
   * cui il modulo pubblico accoglie cuoche, collaboratrici e segretarie ce n'è
   * una terza — nessun account affatto — e `credentials === null` ne coprirebbe
   * due: la Segreteria leggerebbe che esiste un accesso con quella email, cioè
   * il contrario di quello che è successo, e andrebbe a cercarlo.
   *
   * `undefined` vale `riusato` solo per il rifiuto e per le risposte di un
   * server più vecchio di questo client (un deploy a metà): mai `nessuno`, che è
   * l'unica delle tre a dire «non c'è niente da cercare».
   */
  esitoAccount?: 'creato' | 'riusato' | 'nessuno'
}

/**
 * Un esito che NON si è potuto mostrare nel pannello, perché nel frattempo quel
 * pannello era stato chiuso o ne era stata aperta un'altra candidatura.
 *
 * Non è una notifica di cortesia. Sul ramo «approva» l'account docente ESISTE, e
 * la password monouso non è archiviata da nessuna parte: questo avviso è l'unica
 * copia che ne esista. Fino al 2026-08-11 era una stringa sola, azzerata a ogni
 * apertura successiva — bastavano due clic durante una PATCH che dura secondi per
 * portarsi via account creato, credenziali e avvisi del server, e a schermo non
 * restava niente. Adesso le voci si ACCUMULANO e se ne vanno solo con un gesto.
 *
 * `esito` è quello che ha risposto il SERVER; è `null` quando l'operazione non è
 * riuscita, e allora `guasto` dice quale delle due cose è successa — perché
 * «l'account è stato creato» e «il server ha rifiutato» sono frasi opposte e
 * dirne una per l'altra è il difetto, non la sua correzione.
 */
interface EsitoScartato {
  chiave: number
  nome: string
  esito: Esito | null
  avvisi: string[]
  guasto: 'respinta' | 'senzaRisposta' | null
}

const ROUTE_LOG = '/admin/modulistica'
const API = '/api/admin/candidature-insegnanti'

/** Gli stati che il server usa in colonna, e la chiave i18n del loro badge. */
const CHIAVE_STATO: Record<string, string> = {
  pending: 'candStatoAttesa',
  in_approvazione: 'candStatoInApprovazione',
  approvata: 'candStatoApprovata',
  rifiutata: 'candStatoRifiutata',
}

/** Il colore del badge di stato: solo token, mai un hex (Alto Contrasto). */
const TINTA_STATO: Record<string, string> = {
  pending: 'bg-kidville-warn-soft text-kidville-warn-strong',
  in_approvazione: 'bg-kidville-info-soft text-kidville-info-strong',
  approvata: 'bg-kidville-success-soft text-kidville-success-strong',
  rifiutata: 'bg-kidville-error-soft text-kidville-error-strong',
}

/** Le fasce, con la chiave i18n di ciascuna: l'ordine è quello del template. */
const CHIAVE_GRADO: Record<string, string> = {
  nido: 'candGradoNido',
  infanzia: 'candGradoInfanzia',
  primaria: 'candGradoPrimaria',
}

/**
 * Titolo di studio e disponibilità: enum in tabella, ETICHETTE a schermo.
 *
 * Sono due dei campi da cui dipende la decisione, e fino al 2026-08-11 in
 * segreteria si leggevano come valori di database — `laurea_magistrale`,
 * `tempo_pieno`, con l'underscore — in italiano come in inglese, mentre le fasce
 * accanto erano tradotte. Le etichette del template sono italiane per
 * costruzione: servono al modulo pubblico, non a un cockpit bilingue. Quindi qui
 * si passa dal catalogo, come per i gradi.
 *
 * ⚠️ LA DISPONIBILITÀ NON SI CHIEDE PIÙ dal 2026-08-24 — in Kidville si lavora
 * solo a tempo pieno — e con lei è sparita la costante `DISPONIBILITA` da
 * `insegnanti-template.ts`, da cui queste etichette discendevano. `CHIAVE_TITOLO`
 * continua quindi a tradurre un enum VIVO, `CHIAVE_DISPONIBILITA` un enum
 * STORICO: la colonna resta, piena dei valori scritti dalle candidature arrivate
 * prima, e la scheda continua a leggerli. Ogni candidatura nuova nasce invece
 * con quel valore NULL, e la riga sparisce dal pannello (vedi il blocco «Profilo»).
 *
 * ⚠️ E cambia CHI le difende. Il lock in coda al test derivava il perimetro dal
 * template: col campo fuori, sulla disponibilità avrebbe smesso di guardare
 * qualunque cosa. Non subito, però, e non in silenzio: il conteggio in testa a
 * quel lock — `toBe(20)` — sarebbe diventato rosso e avrebbe chiesto di
 * aggiornarlo, che è esattamente il suo mestiere. È DOPO quell'aggiornamento che
 * le cinque etichette sarebbero rimaste senza nessuno a guardarle, in silenzio e
 * col verde. Ora quel lock importa `CHIAVE_DISPONIBILITA` da qui, quindi è questa
 * mappa la fonte, e toglierne una riga fa rosso — misurato togliendo `tirocinio`,
 * non promesso. Per il titolo di studio la fonte resta il template.
 *
 * Un valore FUORI enum resta grezzo: nasconderlo direbbe che il campo è vuoto.
 */
const CHIAVE_TITOLO: Record<string, string> = {
  // Aggiunta il 2026-08-15 insieme alla voce nel template: l'elenco cominciava
  // dal diploma perché l'unica candidatura possibile era quella di
  // un'insegnante. Senza questa riga il valore uscirebbe grezzo — con
  // l'underscore — proprio sulle candidature non docenti che il modulo ha appena
  // cominciato ad accogliere.
  licenza_media: 'candTitoloLicenzaMedia',
  diploma: 'candTitoloDiploma',
  magistrale: 'candTitoloMagistrale',
  laurea_triennale: 'candTitoloLaureaTriennale',
  laurea_magistrale: 'candTitoloLaureaMagistrale',
  formazione_primaria: 'candTitoloFormazionePrimaria',
  master: 'candTitoloMaster',
  altro: 'candTitoloAltro',
}

// Esportata, e non per comodità: dal 2026-08-24 il campo non è più nel template,
// quindi il lock dei cataloghi (`CandidatureInsegnanti.test.tsx`) non può più
// derivare queste cinque voci di lì e le legge QUI. Cancellare la mappa, o una
// sua riga, fa rosso quel test — che è l'unica cosa che tiene in vita le chiavi
// `candDisp*` nei due cataloghi.
export const CHIAVE_DISPONIBILITA: Record<string, string> = {
  tempo_pieno: 'candDispTempoPieno',
  part_time_mattina: 'candDispPartTimeMattina',
  part_time_pomeriggio: 'candDispPartTimePomeriggio',
  supplenze: 'candDispSupplenze',
  tirocinio: 'candDispTirocinio',
}

/**
 * Le POSIZIONI, con la chiave i18n di ciascuna: l'ordine è quello del template.
 *
 * ⚠️ Le etichette del template (`POSIZIONI_OPTIONS`) sono italiane per
 * costruzione — servono al modulo pubblico, non a un cockpit bilingue — e i loro
 * `value` sono token con l'underscore (`insegnante_nido`). Senza queste chiavi la
 * Segreteria leggerebbe a schermo il valore di database, che è precisamente il
 * difetto corretto l'11/08/2026 per titolo di studio e disponibilità. Il lock in
 * coda al test del pannello verifica che OGNI valore dell'enum abbia la sua
 * chiave, in italiano e in inglese: una posizione aggiunta al modulo pubblico e
 * dimenticata qui è un test rosso, non una scoperta a schermo.
 */
const CHIAVE_POSIZIONE: Record<string, string> = {
  insegnante_nido: 'candPosInsegnanteNido',
  insegnante_infanzia: 'candPosInsegnanteInfanzia',
  insegnante_primaria: 'candPosInsegnantePrimaria',
  collaboratrice: 'candPosCollaboratrice',
  cuoca: 'candPosCuoca',
  segreteria: 'candPosSegreteria',
  altro: 'candPosAltro',
}

const ORDINE_GRADI = GRADI_OPTIONS.map((o) => String(o.value))
const ORDINE_POSIZIONI = POSIZIONI_OPTIONS.map((o) => String(o.value))

/**
 * Un elenco che arriva grezzo dal database, ordinato come nel modulo pubblico e
 * senza doppioni.
 *
 * Un valore FUORI dall'elenco noto non si butta: si mostra in coda, perché
 * nasconderlo direbbe alla Direzione che quella candidatura non ha quel dato
 * mentre in tabella c'è un valore che qualcuno dovrà sistemare.
 *
 * ⚠️ È una funzione sola con l'ordine come parametro, e non due copie: fasce e
 * posizioni hanno la stessa identica regola, e in questo repo la stessa regola
 * scritta due volte diverge alla prima modifica. La differenza fra le due sta
 * tutta nell'elenco che si passa.
 */
function ordinatiComeIlModulo(grezzi: unknown, ordine: string[]): string[] {
  if (!Array.isArray(grezzi)) return []
  const presenti = [...new Set(grezzi.map((g) => String(g)).filter((g) => g !== ''))]
  return [
    ...ordine.filter((v) => presenti.includes(v)),
    ...presenti.filter((v) => !ordine.includes(v)),
  ]
}

const gradiOrdinati = (grezzi: unknown): string[] => ordinatiComeIlModulo(grezzi, ORDINE_GRADI)
const posizioniOrdinate = (grezzi: unknown): string[] =>
  ordinatiComeIlModulo(grezzi, ORDINE_POSIZIONI)

/**
 * L'esito e gli avvisi, letti dal corpo della PATCH.
 *
 * Vivono qui, in un posto solo, perché li leggono DUE strade — il riquadro nel
 * pannello e l'avviso dell'esito scartato — e una regola valida per due strade
 * che se ne sta in due copie diverge alla prima modifica.
 */
function esitoDaRisposta(
  azione: 'approva' | 'rifiuta',
  stato: string | null,
  json: unknown,
): Esito {
  const corpo = (json ?? {}) as Record<string, unknown>
  return {
    azione,
    stato,
    credentials: (corpo.credentials as Esito['credentials']) ?? null,
    credentialsEmailSent: corpo.credentialsEmailSent === true,
    esitoEmailInviato: corpo.esitoEmailInviato === true,
    // Solo i tre valori dichiarati: una stringa qualunque arrivata da un corpo
    // inatteso non deve poter scegliere quale storia si racconta.
    esitoAccount:
      corpo.esitoAccount === 'creato' || corpo.esitoAccount === 'riusato' || corpo.esitoAccount === 'nessuno'
        ? corpo.esitoAccount
        : undefined,
  }
}

function avvisiDaRisposta(json: unknown): string[] {
  const w = ((json ?? {}) as Record<string, unknown>).warnings
  return Array.isArray(w) ? (w as string[]) : []
}

/** Accoda una pagina DEDUPLICANDO per `id`: l'offset conta le righe già viste. */
function accoda(precedenti: RigaElenco[], nuove: RigaElenco[]): RigaElenco[] {
  const perId = new Map(precedenti.map((r) => [r.id, r]))
  for (const riga of nuove) perId.set(riga.id, riga)
  return [...perId.values()]
}

export function CandidatureInsegnanti() {
  const t = useTranslations('adminAltro')
  const f = useDateFormat()
  const { reFetchKey, sedi, sedeCorrente, effettive } = useSediAttive()
  /** Gli uuid dei plessi su cui questa persona ha titolo, adesso. */
  const sediAttive = effettive
  /**
   * Il plesso scelto A MANO nella scheda, quando la candidatura ne ha più d'uno
   * in comune con chi guarda e il selettore in alto non ne indica nessuno.
   * Si azzera cambiando candidatura: è una scelta su QUELLA pratica.
   */
  const [sedeScelta, setSedeScelta] = useState<string | null>(null)

  /**
   * SU QUALE PLESSO SI STA DECIDENDO.
   *
   * Dal 2026-08-19 la stessa candidatura può essere in valutazione a più sedi, e
   * ognuna decide per sé: «approva» senza dire dove chiuderebbe una pratica a
   * caso. Il server risponde 400 a un operatore multi-sede che non lo dichiara.
   *
   * L'ordine delle tre risposte NON è intercambiabile:
   *  1. la sede SCELTA nel selettore in alto, se quella candidatura ce l'ha: è il
   *     plesso su cui questa persona sta lavorando adesso, e ciò che vede nella
   *     scheda è filtrato su quello;
   *  2. altrimenti, se la candidatura è rivolta a UNA sola sede, quella: non c'è
   *     niente da scegliere;
   *  3. altrimenti `undefined`, e il server risponde 400. Meglio un rifiuto
   *     leggibile che una scelta presa dal client — indovinare qui vorrebbe dire
   *     chiudere la pratica di un plesso al posto di un altro, in silenzio.
   */
  function sedeSuCuiDecido(riga: { scuola_id?: string | null; sedi?: { scuola_id: string }[] | null }): string | undefined {
    const sueSedi = (riga.sedi ?? []).map((x) => x.scuola_id)
    // Nessuna riga di sede (ambiente non ancora migrato): si ripiega sulla
    // colonna storica, che lì è ancora l'unica verità.
    if (sueSedi.length === 0) return riga.scuola_id ?? undefined
    // La scelta esplicita di chi guarda, quando l'ha fatta (vedi `sedeScelta`).
    if (sedeScelta && sueSedi.includes(sedeScelta)) return sedeScelta
    // La sede selezionata in alto, se questa candidatura ce l'ha.
    if (sedeCorrente && sueSedi.includes(sedeCorrente)) return sedeCorrente
    /**
     * ⚠️ L'INTERSEZIONE, e non `sueSedi.length === 1`.
     *
     * `sedeCorrente` è `null` appena l'operatore ha più di una sede attiva nel
     * selettore in alto (`sede-context`), e la vecchia condizione guardava solo
     * quante sedi ha la CANDIDATURA. Risultato: chi lavora su tutte e tre —
     * `test.multisede.admin`, e chiunque in Direzione — non poteva decidere
     * NIENTE su una candidatura rivolta a due plessi: il server rispondeva 400 e
     * il pannello non offriva nessun modo di scegliere.
     *
     * Ciò che conta è quante sedi hanno IN COMUNE la candidatura e chi guarda:
     * se è una sola, non c'è niente da scegliere, qualunque sia il selettore.
     */
    const comuni = sueSedi.filter((id) => sediAttive.includes(id))
    if (comuni.length === 1) return comuni[0]
    // Ambiguo per davvero: lo si chiede, non lo si indovina.
    return undefined
  }
  const { ruolo } = useAdminIdentity()

  const [righe, setRighe] = useState<RigaElenco[]>([])
  const [totale, setTotale] = useState(0)
  // «La pagina è tornata più corta del limite», cioè: non ce n'è un'altra. È il
  // secondo segnale, e serve perché dalla pagina 2 in poi `total` può mancare:
  // con il solo `righe.length < totale` un `total` rimasto vecchio lascia
  // «Mostra altre» acceso per sempre su un elenco che non cresce più.
  const [finePagine, setFinePagine] = useState(false)
  const [caricamento, setCaricamento] = useState(true)
  const [caricandoAltre, setCaricandoAltre] = useState(false)
  /**
   * Una rilettura d'elenco è in volo (cambio sede, ritenta, ricarica dopo
   * un'azione). NON è `caricamento`, che è il velo della prima apertura: qui le
   * righe restano a schermo, e l'unica cosa che cambia è che «Mostra altre» si
   * spegne — accodare a una lista che sta per essere sostituita mescolerebbe due
   * plessi. Alzare `caricamento` non è un'alternativa: sostituirebbe l'intera
   * griglia, e quindi anche il riquadro con le credenziali appena generate.
   */
  const [ricaricaInVolo, setRicaricaInVolo] = useState(false)
  /**
   * L'ULTIMA lettura d'elenco è FALLITA. Serve a tenere separati due stati che
   * altrimenti collassano in uno: «l'archivio è vuoto» e «l'archivio non si è
   * riusciti a leggerlo». Con zero righe si disegnava «Nessuna candidatura
   * ricevuta.» anche con la GET a 503 — un'affermazione di fatto FALSA, in
   * inchiostro neutro, accanto all'avviso rosso che diceva il contrario.
   */
  const [letturaFallita, setLetturaFallita] = useState(false)
  const [aprendo, setAprendo] = useState<string | null>(null)
  const [selezionata, setSelezionata] = useState<Candidatura | null>(null)
  const [conferma, setConferma] = useState<'approva' | 'rifiuta' | null>(null)
  const [motivo, setMotivo] = useState('')
  // SPENTA di default, ed è una scelta: l'email di esito negativo si manda
  // quando qualcuno decide di mandarla, non perché la casella era già segnata.
  const [avvisaEmail, setAvvisaEmail] = useState(false)
  /**
   * L'`id` della candidatura su cui una PATCH è in volo — non un booleano.
   *
   * Era `lavorando: boolean`, cioè uno stato CONDIVISO fra tutte le candidature:
   * mentre la PATCH su Anna viaggiava (secondi veri), chi apriva Bruno trovava i
   * suoi due pulsanti spenti, senza `title` e senza una riga che dicesse perché —
   * proprio l'anti-pattern che l'intestazione di questo file si impegna a evitare.
   * Legandolo all'`id`, il pannello di Bruno non risente dell'operazione di Anna,
   * e riaprendo ANNA i pulsanti restano spenti (giusto: non si fa partire due
   * volte la stessa PATCH) ma adesso con il motivo scritto.
   */
  const [lavorandoSu, setLavorandoSu] = useState<string | null>(null)
  const [errore, setErrore] = useState<string | null>(null)
  const [esito, setEsito] = useState<Esito | null>(null)
  /**
   * Gli avvisi del server vivono FUORI dal riquadro congedabile.
   *
   * Prima stavano dentro, e con «Ho preso nota» se ne andava anche la sola frase
   * che diceva che l'account era stato creato lo stesso: l'unica traccia che
   * esiste un docente nuovo spariva insieme al riquadro che la conteneva.
   */
  const [avvisi, setAvvisi] = useState<string[]>([])
  /** La URL firmata del curriculum, quando il browser ha bloccato la finestra. */
  const [cvBloccato, setCvBloccato] = useState<string | null>(null)
  /**
   * Gli esiti che NON si sono potuti mostrare nel pannello. Scartare è giusto;
   * scartare in SILENZIO no: su «approva» l'account docente esiste comunque, e
   * la sua password monouso non esiste da nessun'altra parte.
   *
   * Si ACCUMULANO e non si azzerano aprendo un'altra candidatura: erano l'unica
   * traccia di un account creato, e due clic se la portavano via.
   */
  const [esitiScartati, setEsitiScartati] = useState<EsitoScartato[]>([])

  // I gettoni: uno per l'elenco, uno per il dettaglio. Vedi il commento in cima.
  const gettoneElenco = useRef(0)
  const gettoneDettaglio = useRef(0)
  /** Solo la `key` React delle voci scartate: due esiti possono avere lo stesso nome. */
  const contatoreScartati = useRef(0)

  /** Registra un esito scartato in coda a quelli che sono già a schermo. */
  function annotaScartato(voce: Omit<EsitoScartato, 'chiave'>) {
    setEsitiScartati((prec) => [...prec, { ...voce, chiave: ++contatoreScartati.current }])
  }

  /**
   * La Direzione, lato client. Il gate VERO è il `requireStaff(['admin',
   * 'coordinator'])` della route: questo serve solo a non far scoprire il
   * divieto dopo il clic. `ruolo` nasce vuoto e arriva da una fetch, quindi
   * «non ancora saputo» e «segreteria» sono due cose diverse e si dicono con
   * due frasi diverse.
   */
  const ruoloRisolto = ruolo !== ''
  const isDirezione = ruolo === 'admin' || ruolo === 'coordinator'
  const motivoBlocco = !ruoloRisolto ? t('candRuoloInCorso') : t('candSoloDirezione')

  /**
   * ─── L'INOLTRO AI PLESSI DELLE COPIE MAI PARTITE ──────────────────────────
   *
   * La copia al plesso è nata il 2026-08-20: tutto ciò che è arrivato prima non
   * è mai stato recapitato in posta a nessuna segreteria, e resta il caso in cui
   * un invio fallisce (quota del provider, sede senza email in anagrafica, un
   * difetto come quello del destinatario multiplo).
   *
   * ⚠️ DUE PASSI, E NON È UN VEZZO. Il primo clic CONTA e non spedisce niente;
   * il secondo spedisce. Un solo pulsante che manda decine di email a caselle
   * vere al primo tocco è un pulsante che qualcuno preme per sbaglio, e non
   * esiste un «annulla» per un'email partita. Il conteggio prima serve anche a
   * chi non ha idea di quante siano: senza, il numero si scopre dal resoconto.
   */
  const [arretrato, setArretrato] = useState<{
    fase: 'fermo' | 'conteggio' | 'pronto' | 'invio'
    n: number
    esito: string | null
  }>({ fase: 'fermo', n: 0, esito: null })

  async function contaArretrato() {
    setArretrato({ fase: 'conteggio', n: 0, esito: null })
    try {
      const res = await fetch(`${API}/inoltro-arretrato`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prova: true }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setArretrato({ fase: 'fermo', n: 0, esito: messaggioDaCorpo(json, t('candArretratoNonRiuscito')) })
        return
      }
      setArretrato({ fase: 'pronto', n: Number(json?.da_inviare ?? 0), esito: null })
    } catch (e) {
      logClient({
        livello: 'error', evento: 'react',
        // ⚠️ NIENTE `e.message` nel testo: il messaggio di un errore di rete può
        // portarsi dentro un URL con dei parametri, e da lì dati di una persona.
        // Lo `stack` sì: `EventoClient` ha un campo suo, e la redazione lavora lì.
        messaggio: 'inoltro-arretrato-conteggio-fallito',
        stack: e instanceof Error ? e.stack : undefined,
        route: ROUTE_LOG,
      })
      setArretrato({ fase: 'fermo', n: 0, esito: t('candArretratoNonRiuscito') })
    }
  }

  async function inoltraArretrato() {
    setArretrato((a) => ({ ...a, fase: 'invio' }))
    try {
      const res = await fetch(`${API}/inoltro-arretrato`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setArretrato({ fase: 'fermo', n: 0, esito: messaggioDaCorpo(json, t('candArretratoNonRiuscito')) })
        return
      }
      const inviate = Number(json?.inviate ?? 0)
      const fallite = Number(json?.fallite ?? 0)
      const fermato = typeof json?.fermato === 'string' ? json.fermato : null
      setArretrato({
        fase: 'fermo',
        n: 0,
        // Il resoconto NOMINA ciò che non è andato. «Inviate 25» senza dire che
        // due sono fallite è un successo dichiarato su un guasto.
        esito: fermato
          ? t('candArretratoFermatoQuota', { n: inviate })
          : t('candArretratoFatto', { n: inviate, k: fallite }),
      })
      await carica(reFetchKey)
    } catch (e) {
      logClient({
        livello: 'error', evento: 'react',
        // ⚠️ NIENTE `e.message` nel testo: il messaggio di un errore di rete può
        // portarsi dentro un URL con dei parametri, e da lì dati di una persona.
        // Lo `stack` sì: `EventoClient` ha un campo suo, e la redazione lavora lì.
        messaggio: 'inoltro-arretrato-fallito',
        stack: e instanceof Error ? e.stack : undefined,
        route: ROUTE_LOG,
      })
      setArretrato({ fase: 'fermo', n: 0, esito: t('candArretratoNonRiuscito') })
    }
  }

  // Un uuid non dice niente a nessuno: la sede si risolve nel nome del plesso.
  const nomeSede = (scuolaId?: string | null) =>
    sedi.find((s) => s.id === scuolaId)?.nome ?? t('candSedeSconosciuta')

  const etichettaGrado = (g: string) => (CHIAVE_GRADO[g] ? t(CHIAVE_GRADO[g]) : g)
  const etichettaPosizione = (p: string) => (CHIAVE_POSIZIONE[p] ? t(CHIAVE_POSIZIONE[p]) : p)

  /** L'etichetta di un enum, o il valore grezzo se è fuori dall'elenco chiuso. */
  const daCatalogo = (mappa: Record<string, string>, valore?: string | null) => {
    const grezzo = (valore ?? '').trim()
    if (grezzo === '') return null
    return mappa[grezzo] ? t(mappa[grezzo]) : grezzo
  }

  const nomeCompleto = (r: RigaElenco | Candidatura) =>
    [r.nome ?? '', r.cognome ?? ''].map((s) => s.trim()).filter(Boolean).join(' ')
    || t('candSenzaNome')

  async function carica(sediKey: string) {
    const mio = ++gettoneElenco.current
    setRicaricaInVolo(true)
    try {
      const res = await fetch(`${API}?limit=${LIMITE_ISCRIZIONI_DEFAULT}&offset=0`, {
        headers: { 'x-sedi': sediKey },
      })
      if (!res.ok) {
        const messaggio = await messaggioErrore(res, t('candErroreElenco'))
        if (mio === gettoneElenco.current) {
          setErrore(messaggio)
          setLetturaFallita(true)
        }
        logClient({
          livello: 'error',
          evento: 'react',
          messaggio: `candidature-elenco-non-caricato: http ${res.status}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      const json = await res.json()
      // La risposta di una richiesta SUPERATA non si scrive: se nel frattempo le
      // sedi sono cambiate, l'elenco a schermo sarebbe quello del plesso di prima.
      if (mio !== gettoneElenco.current) return
      if (Array.isArray(json?.data)) {
        setRighe(json.data as RigaElenco[])
        // `total` è il conteggio ESATTO del server: con 60 candidature su 200,
        // la lunghezza della pagina direbbe «60» e nessuno saprebbe delle altre.
        setTotale(typeof json.total === 'number' ? json.total : json.data.length)
        // La prima pagina porta con sé il suo `total`, che è fresco: da qui si
        // riparte fidandosi di quello, e `finePagine` torna a essere una domanda
        // aperta che risponderà la prima pagina successiva.
        setFinePagine(false)
        setErrore(null)
        setLetturaFallita(false)
      } else {
        // 200 con un corpo che non è un elenco: è una lettura FALLITA quanto un
        // 503, e prima finiva in silenzio — nessun avviso, e a schermo lo stesso
        // riquadro dell'archivio vuoto.
        setErrore(t('candErroreElenco'))
        setLetturaFallita(true)
        logClient({
          livello: 'error',
          evento: 'react',
          messaggio: 'candidature-elenco-corpo-inatteso: data non è un elenco',
          route: ROUTE_LOG,
          stato: res.status,
        })
      }
    } catch (e) {
      if (mio === gettoneElenco.current) {
        setErrore(t('candErroreElenco'))
        setLetturaFallita(true)
      }
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `candidature-elenco-fallito: ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    } finally {
      if (mio === gettoneElenco.current) {
        setCaricamento(false)
        setRicaricaInVolo(false)
      }
    }
  }

  /** Il ritenta del riquadro «elenco non letto»: rimette il velo e rilegge. */
  function riprovaElenco() {
    setCaricamento(true)
    void carica(reFetchKey)
  }

  /**
   * Si ricarica quando cambiano le sedi attive, e SOLO per quello.
   *
   * `carica` non è fra le dipendenze e NON serve una deroga: l'effetto chiama la
   * versione più fresca passando da un `ref`, e un ref è stabile per costruzione.
   *
   * Perché non `useCallback`: `carica` usa `t()`, e `t` non è stabile — nel banco
   * di prova `test/setup.ts` `useTranslations` costruisce una funzione NUOVA a
   * ogni chiamata, quindi `useCallback(carica, [t])` produrrebbe un `carica`
   * diverso a ogni render e l'effetto rifarebbe la fetch all'infinito. (La
   * ragione scritta qui fino al 2026-08-11 era sbagliata: diceva che la deroga
   * serviva «perché usa `t()`», mentre una dichiarazione di funzione nel corpo
   * del componente è nuova a ogni render qualunque cosa contenga. Un commento che
   * spiega male una deroga è peggio di nessun commento: il prossimo lo usa come
   * precedente.)
   */
  const caricaRef = useRef(carica)
  const chiudiRef = useRef(chiudiDettaglio)
  useEffect(() => { caricaRef.current = carica })
  useEffect(() => { chiudiRef.current = chiudiDettaglio })
  /**
   * ⚠️ E IL PANNELLO SI CHIUDE, non solo l'elenco si ricarica.
   *
   * Fino al 2026-08-20 questo effetto ricaricava le righe e basta: `selezionata`
   * e `sedeScelta` sopravvivevano. Aperta una candidatura di Cesa, scelta Cesa
   * nel selettore della scheda, e poi tolta Cesa dal selettore in alto, il
   * pannello restava a schermo con email, telefono, curriculum e note di sede di
   * un plesso su cui chi guarda non ha più titolo — e «Rifiuta» spediva
   * `scuola_id = Cesa`, che il server respinge con un 404 accendendo il warn
   * `sede-fuori-scope`.
   *
   * Non è una fuga: quei dati erano stati letti quando il titolo c'era. È una
   * schermata che sopravvive al proprio scope, che è la premessa di una fuga.
   *
   * `reFetchKey` è `effettive.join(',')` (`sede-context.tsx:246`): cambia SOLO
   * quando cambiano le sedi attive, mai per una ricarica dopo una decisione.
   * Non serve distinguere: la chiusura non ruba mai un pannello a chi sta
   * lavorando.
   */
  useEffect(() => {
    chiudiRef.current()
    caricaRef.current(reFetchKey)
  }, [reFetchKey])

  /** Pagina successiva, in coda a quelle già mostrate. */
  async function caricaAltre() {
    // Il gettone si LEGGE, non si incrementa: accodare non crea un'identità
    // d'elenco nuova. Incrementandolo, un clic su «Mostra altre» scartava una
    // rilettura per cambio sede ancora in volo e accodava la pagina della sede
    // nuova alle righe di quella vecchia; così invece è l'accodatura a essere
    // scartata se una rilettura arriva dopo, che è il verso giusto.
    const mio = gettoneElenco.current
    setCaricandoAltre(true)
    try {
      const res = await fetch(`${API}?limit=${LIMITE_ISCRIZIONI_DEFAULT}&offset=${righe.length}`, {
        headers: { 'x-sedi': reFetchKey },
      })
      if (!res.ok) {
        const messaggio = await messaggioErrore(res, t('candErrorePagina'))
        if (mio === gettoneElenco.current) setErrore(messaggio)
        logClient({
          livello: 'error',
          evento: 'react',
          messaggio: `candidature-pagina-non-caricata: http ${res.status}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      const json = await res.json()
      if (mio !== gettoneElenco.current) return
      if (Array.isArray(json?.data)) {
        const nuove = json.data as RigaElenco[]
        // DEDUPLICATO per `id`: l'offset conta le righe già viste, e il modulo
        // pubblico riceve invii di continuo. Una candidatura arrivata fra la
        // prima pagina e la seconda sposta tutto di uno e fa ricomparire una
        // riga — con la stessa `key` React, cioè un doppione a schermo.
        setRighe((prec) => accoda(prec, nuove))
        if (typeof json.total === 'number') setTotale(json.total)
        if (nuove.length < LIMITE_ISCRIZIONI_DEFAULT) setFinePagine(true)
        setErrore(null)
      }
    } catch (e) {
      if (mio === gettoneElenco.current) setErrore(t('candErrorePagina'))
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `candidature-pagina-fallita: ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    } finally {
      setCaricandoAltre(false)
    }
  }

  /**
   * Apre una candidatura: è QUI che si chiedono recapiti, presentazione e
   * curriculum, per una riga sola. L'esito non si butta via — il server
   * risponde 404 anche quando la candidatura è di un'altra sede, e un pannello
   * che resta vuoto senza dire niente è peggio di un errore.
   */
  async function apriDettaglio(riga: RigaElenco) {
    const mio = ++gettoneDettaglio.current
    setSelezionata(null)
    setAprendo(riga.id)
    setConferma(null)
    setMotivo('')
    setAvvisaEmail(false)
    setEsito(null)
    setAvvisi([])
    setCvBloccato(null)
    setErrore(null)
    // Gli esiti scartati NON si azzerano qui, ed è il punto: parlano di
    // un'ALTRA candidatura, quindi non c'entrano con quella che si sta aprendo, e
    // sono l'unica copia di una password monouso. Fino al 2026-08-11 la riga
    // `setEsitoScartato(null)` stava qui: approvata Anna e aperti Bruno e poi
    // Carla, a schermo non restava niente — né l'avviso, né le credenziali, né
    // l'avvertimento del server che l'email non era partita. Se ne vanno solo
    // con «Ho preso nota di questi esiti».
    try {
      const res = await fetch(`${API}?id=${encodeURIComponent(riga.id)}`, {
        headers: { 'x-sedi': reFetchKey },
      })
      const json = await res.json().catch((e: unknown) => {
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `candidatura-dettaglio-corpo-illeggibile: ${nomeErrore(e)}`,
          route: ROUTE_LOG,
        })
        return null
      })
      // Il clic più recente ha già vinto: questa risposta non tocca lo schermo.
      if (mio !== gettoneDettaglio.current) return
      if (!res.ok || !json?.data) {
        setErrore(messaggioDaCorpo(json, t('candDettaglioNonAperto')))
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `candidatura-dettaglio-non-aperto: http ${res.status}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      // La scelta della sede appartiene alla pratica che si sta aprendo: si
      // azzera qui, o si porterebbe dietro il plesso deciso sulla precedente.
      setSedeScelta(null)
      setSelezionata(json.data as Candidatura)
    } catch (e) {
      if (mio === gettoneDettaglio.current) setErrore(t('candDettaglioNonAperto'))
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `candidatura-dettaglio-fallito: ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    } finally {
      // Il velo si spegne solo se non c'è una richiesta più recente in volo:
      // altrimenti lo spegneva la PRIMA risposta arrivata, mostrando il pannello
      // vuoto mentre l'apertura vera stava ancora viaggiando.
      if (mio === gettoneDettaglio.current) setAprendo(null)
    }
  }

  /**
   * Chiude il pannello — ed è un CAMBIO D'APERTURA a tutti gli effetti: il
   * gettone avanza, così l'esito di una PATCH ancora in volo non si ritrova a
   * riaprire da solo un pannello che qualcuno ha appena chiuso.
   */
  function chiudiDettaglio() {
    gettoneDettaglio.current += 1
    setSedeScelta(null)
    setSelezionata(null)
  }

  /**
   * Il curriculum: la URL è firmata dal server e vive dieci minuti.
   *
   * Il COME (finestra aperta dentro il gesto, `opener` a null, ripiego sul link
   * quando il browser blocca) sta in `@/lib/ui/apri-documento-firmato`: era
   * scritto qui e in `ModuliRicevuti`, in due versioni che avevano già smesso di
   * coincidere — la seconda non apriva la finestra nel gesto e non guardava
   * nemmeno lo stato della risposta. Qui resta ciò che solo questo pannello sa:
   * quale frase mostrare.
   *
   * Si resta su `candErroreCv`, e non è una dimenticanza: i codici che la route
   * manda su quel ramo (`CANDIDATURE_OPERAZIONE_NON_RIUSCITA`,
   * `CANDIDATURA_NON_TROVATA`) parlano della CANDIDATURA, non del file, e il loro
   * testo di catalogo («l'operazione non è riuscita») direbbe meno di questa
   * frase — che è già tradotta e non è mai prosa del server.
   */
  async function apriCurriculum(path?: string | null) {
    if (!path) return
    setCvBloccato(null)
    const esito = await apriDocumentoFirmato({
      endpoint: API,
      path,
      headers: { 'x-sedi': reFetchKey },
      route: ROUTE_LOG,
      etichetta: 'candidatura-cv',
    })
    if (esito.esito === 'bloccato') setCvBloccato(esito.url)
    else if (esito.esito === 'errore') setErrore(t('candErroreCv'))
  }

  /** Approva o rifiuta. La conferma è già stata data nel pannello qui sotto. */
  async function esegui(azione: 'approva' | 'rifiuta') {
    if (!selezionata) return
    // Il gettone dell'apertura in corso, LETTO e non incrementato: l'azione non
    // cambia quale candidatura è aperta, ma la sua risposta vale solo se
    // nessun'altra apertura è arrivata nel frattempo. Il nome si cattura adesso,
    // perché è di questa persona che parlerà l'avviso se l'esito va scartato.
    const mio = gettoneDettaglio.current
    const idBersaglio = selezionata.id
    const nomeBersaglio = nomeCompleto(selezionata)
    const attuale = () => mio === gettoneDettaglio.current
    setLavorandoSu(idBersaglio)
    setErrore(null)
    // Gli esiti già scartati NON si azzerano: appartengono a un'altra
    // candidatura, e questa operazione non li rende meno veri.
    try {
      const res = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-sedi': reFetchKey },
        // ⚠️ `scuola_id` DICHIARA SU QUALE PLESSO SI STA DECIDENDO, e senza di
        // esso un operatore con più sedi attive riceve 400. Non è burocrazia: la
        // stessa candidatura può essere in valutazione a Giugliano e ad Aversa, e
        // «approva» senza dire dove chiuderebbe una pratica a caso.
        //
        // Si manda la sede DI CHI GUARDA fra quelle della candidatura, non la
        // prima dell'elenco: è la sola su cui questa persona ha titolo di
        // decidere. Il server la rifiuta comunque se non è sua — un uuid nel
        // corpo lo scrive il client, e un client può scrivere qualunque cosa.
        body: JSON.stringify(
          azione === 'approva'
            ? { id: selezionata.id, action: 'approva', scuola_id: sedeSuCuiDecido(selezionata) }
            : {
                id: selezionata.id,
                action: 'rifiuta',
                scuola_id: sedeSuCuiDecido(selezionata),
                motivo: motivo.trim() || undefined,
                inviaEmailEsito: avvisaEmail,
              },
        ),
      })
      const json = await res.json().catch((e: unknown) => {
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `candidatura-azione-corpo-illeggibile: ${nomeErrore(e)}`,
          route: ROUTE_LOG,
        })
        return null
      })
      if (!res.ok) {
        // L'esito NON si butta via: 403 di sede, 409 «già evasa», 503. Ricaricare
        // e chiudere il pannello senza guardare significherebbe dire «fatto» su
        // un'approvazione che non è mai avvenuta.
        //
        // E si passa dal CATALOGO, non dalla prosa del server: la PATCH è l'unico
        // posto da cui arrivano `CANDIDATURA_GIA_EVASA`,
        // `CANDIDATURA_EMAIL_GIA_STAFF`, `CANDIDATURA_EMAIL_GIA_GENITORE`,
        // `CANDIDATURA_NON_TROVATA` e `CANDIDATURE_OPERAZIONE_NON_RIUSCITA`, e
        // finché il `codice` veniva buttato via le loro traduzioni inglesi erano
        // irraggiungibili — a schermo usciva l'italiano scritto a mano nella route,
        // anche con l'interfaccia in inglese.
        //
        // E anche l'errore appartiene alla candidatura su cui si è agito: se nel
        // frattempo ne è stata aperta un'altra, scriverlo qui vorrebbe dire
        // attribuire il «già evasa» alla persona sbagliata.
        //
        // E quando è scartato si dice che l'operazione è stata RESPINTA, non che
        // un account è stato creato: sono due frasi opposte, e dirne una per
        // l'altra manderebbe la segreteria a cercare credenziali che non esistono.
        if (attuale()) setErrore(messaggioDaCorpo(json, t('candErroreAzione')))
        else annotaScartato({ nome: nomeBersaglio, esito: null, avvisi: [], guasto: 'respinta' })
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `candidatura-azione-respinta: ${azione} http ${res.status}${attuale() ? '' : ' (esito scartato: apertura cambiata)'}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      const statoNuovo = typeof json?.stato === 'string' ? json.stato : null
      if (!attuale()) {
        // L'operazione è AVVENUTA: quello che si scarta è solo il POSTO in cui
        // mostrarla. Il riquadro del pannello non si disegna — ci scriverebbe le
        // credenziali di una persona sotto il nome di un'altra — ma l'esito viene
        // riportato per intero in un avviso che NOMINA la persona: password
        // compresa, perché è monouso, non è archiviata da nessuna parte e
        // buttarla via costringe a una reimpostazione (e con l'email delle
        // credenziali non partita, la docente non entrerebbe mai). L'elenco si
        // ricarica: è da lì che si rilegge lo stato vero.
        annotaScartato({
          nome: nomeBersaglio,
          esito: esitoDaRisposta(azione, statoNuovo, json),
          avvisi: avvisiDaRisposta(json),
          guasto: null,
        })
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `candidatura-azione-esito-scartato: ${azione} apertura cambiata durante la PATCH`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        await carica(reFetchKey)
        return
      }
      setConferma(null)
      setEsito(esitoDaRisposta(azione, statoNuovo, json))
      setAvvisi(avvisiDaRisposta(json))
      /**
       * ⚠️ SI AGGIORNA ANCHE LA RIGA DI SEDE, non solo l'aggregato.
       *
       * Fino al 2026-08-20 qui si scriveva solo `stato`, che è l'AGGREGATO —
       * mentre il pannello, dal 2026-08-19, legge `mia.stato` (la riga della
       * propria sede) per il badge, per `decisa` e per i due pulsanti. Dopo un
       * «Approva» andato a buon fine il badge continuava a dire «in valutazione»
       * e i pulsanti restavano ACCESI: ripremerli prendeva un 409 «già valutata:
       * ricaricare la pagina», e ricaricare non cambiava niente perché non era
       * la pagina a essere vecchia.
       *
       * È parola per parola il difetto che il blocco su `mia` descrive per
       * l'aggregato — «un ordine ineseguibile, dato all'infinito» — rientrato
       * dalla porta dell'aggiornamento ottimistico.
       *
       * ⚠️ Si tocca SOLO la riga della sede su cui si è deciso. Le altre non le
       * ha decise nessuno, e scriverle qui direbbe che una segreteria ha chiuso
       * una pratica di un plesso che non è il suo.
       */
      const sedeDecisa = sedeSuCuiDecido(selezionata)
      if (statoNuovo) {
        setSelezionata((s) => {
          if (!s) return s
          const righe = s.candidature_sedi ?? []
          return {
            ...s,
            stato: statoNuovo,
            candidature_sedi: righe.map((r) =>
              // Senza riga di sede in comune non si indovina: si lascia com'è, e
              // la ricarica dell'elenco resta la fonte.
              sedeDecisa !== undefined && r.scuola_id === sedeDecisa ? { ...r, stato: statoNuovo } : r,
            ),
          }
        })
      }
      await carica(reFetchKey)
    } catch (e) {
      // Qui non si sa nemmeno se l'operazione sia avvenuta: la risposta non è
      // mai arrivata. È diverso da «respinta», e va detto con parole diverse.
      if (attuale()) setErrore(t('candErroreAzione'))
      else annotaScartato({ nome: nomeBersaglio, esito: null, avvisi: [], guasto: 'senzaRisposta' })
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `candidatura-azione-fallita: ${azione} ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    } finally {
      // Solo se è ancora la NOSTRA: se nel frattempo è partita un'operazione su
      // un'altra candidatura, spegnere qui accenderebbe i suoi due pulsanti
      // mentre la sua PATCH è ancora in volo.
      setLavorandoSu((corrente) => (corrente === idBersaglio ? null : corrente))
    }
  }

  /**
   * ⚠️ LO STATO DELLA PROPRIA SEDE, anche nei CONTATORI e nell'elenco.
   *
   * `r.stato` è l'AGGREGATO di tutte le sedi: con Giugliano già approvata e
   * Aversa ancora in valutazione vale `pending`, quindi la segreteria di
   * Giugliano si vedrebbe contare fra «in attesa» una pratica che ha chiuso — e
   * i tre numeri in cima alla pagina, che sono il primo colpo d'occhio, direbbero
   * il falso. La scheda già legge la riga di sede: i contatori la seguono.
   *
   * Ripiego su `r.stato` per l'ambiente non ancora migrato, dove le righe di
   * sede non esistono e la colonna è l'unica verità.
   */
  const statoDiRiga = (r: Candidatura): string =>
    (r.candidature_sedi ?? []).find((x) => x.scuola_id === sedeCorrente)?.stato ??
    (r.candidature_sedi ?? [])[0]?.stato ??
    r.stato
  const inAttesa = righe.filter((r) => statoDiRiga(r) === 'pending' || statoDiRiga(r) === 'in_approvazione')
  // Due domande diverse, e prima erano una sola: «le righe caricate sono TUTTE
  // quelle che esistono?» governa i riquadri per stato (un conteggio parziale
  // spacciato per totale è una bugia scritta in grande), «c'è un'altra pagina?»
  // governa il pulsante.
  const tuttoContato = righe.length >= totale
  const altrePagine = !finePagine && righe.length < totale

  return (
    <>
      <p className="mb-4 max-w-2xl font-maven text-sm text-kidville-sub">{t('candIntro')}</p>

      {errore && (
        <p
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-card border border-kidville-error/30 bg-kidville-error-soft px-4 py-3 font-maven text-sm text-kidville-error-strong"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {errore}
        </p>
      )}

      {/* Gli esiti che non si sono potuti mostrare: stanno QUI, fuori dal pannello,
          perché parlano di candidature che non sono più quella aperta. */}
      {esitiScartati.length > 0 && (
        <AvvisoEsitiScartati voci={esitiScartati} onCongeda={() => setEsitiScartati([])} />
      )}

      {!caricamento && righe.length > 0 && (
        <div className={`mb-6 grid grid-cols-2 gap-3 ${tuttoContato ? 'sm:grid-cols-4' : 'sm:grid-cols-1'}`}>
          <StatCard icon={Users} label={t('candStatTotale')} value={totale} tone="green" />
          {tuttoContato && (
            <>
              <StatCard icon={Clock} label={t('candStatAttesa')} value={inAttesa.length} tone="warn" />
              <StatCard icon={CheckCircle2} label={t('candStatApprovate')} value={righe.filter((r) => statoDiRiga(r) === 'approvata').length} tone="success" />
              <StatCard icon={XCircle} label={t('candStatRifiutate')} value={righe.filter((r) => statoDiRiga(r) === 'rifiutata').length} tone="error" />
            </>
          )}
        </div>
      )}

      {caricamento ? (
        <div role="status" className="flex min-h-[40vh] items-center justify-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-kidville-green" />
          <span className="font-maven text-kidville-sub">{t('caricamento')}</span>
        </div>
      ) : righe.length === 0 ? (
        // Tre stati, non due: «vuoto» è un'affermazione, e si fa solo quando
        // l'elenco è stato letto davvero. Se l'ultima lettura è fallita, qui non
        // si dice che non ci sono candidature: si dice che non si sa.
        letturaFallita ? (
          <div className="rounded-card border border-kidville-warn/40 bg-kidville-warn-soft p-10 text-center">
            <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-kidville-warn-strong" />
            <p className="font-maven text-kidville-warn-strong">{t('candElencoNonLetto')}</p>
            <button
              type="button"
              onClick={riprovaElenco}
              className="mt-4 inline-flex items-center gap-2 rounded-pill border border-kidville-green bg-kidville-white px-4 py-2 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft"
            >
              {t('candElencoRiprova')}
            </button>
          </div>
        ) : (
          <div className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center">
            <UserCheck className="mx-auto mb-3 h-10 w-10 text-kidville-neutral" />
            <p className="font-maven text-kidville-sub">{t('candVuoto')}</p>
          </div>
        )
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {/* Elenco */}
          <div className="space-y-3">
            {/* Un vero titolo, non un `p` vestito da titolo: con uno screen reader
                è l'unico punto di salto che questo frammento offre. */}
            <h2 className="text-xs font-bold uppercase tracking-wider text-kidville-sub">{t('candListaHeader')}</h2>
            {/* ── L'inoltro ai plessi delle copie mai partite ──────────────────
                Solo Direzione, e a due passi: il primo conta, il secondo manda.
                Non esiste un «annulla» per un'email partita. */}
            {isDirezione && (
              <div className="rounded-xl border border-kidville-line bg-white/60 p-3">
                {arretrato.fase === 'pronto' ? (
                  arretrato.n === 0 ? (
                    <p className="font-maven text-xs text-kidville-sub">{t('candArretratoNessuno')}</p>
                  ) : (
                    <div className="space-y-2">
                      <p className="font-maven text-xs text-kidville-ink">
                        {t('candArretratoConferma', { n: arretrato.n })}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={inoltraArretrato}
                          className="rounded-lg bg-kidville-green px-3 py-1.5 font-maven text-xs font-bold text-kidville-white disabled:opacity-50"
                        >
                          {t('candArretratoInvia')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setArretrato({ fase: 'fermo', n: 0, esito: null })}
                          className="rounded-lg border border-kidville-line px-3 py-1.5 font-maven text-xs text-kidville-sub"
                        >
                          {t('candArretratoAnnulla')}
                        </button>
                      </div>
                    </div>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={contaArretrato}
                    disabled={arretrato.fase !== 'fermo'}
                    className="font-maven text-xs font-bold text-kidville-green underline underline-offset-2 disabled:opacity-50"
                  >
                    {arretrato.fase === 'conteggio'
                      ? t('candArretratoConteggio')
                      : arretrato.fase === 'invio'
                        ? t('candArretratoInvioInCorso')
                        : t('candArretratoApri')}
                  </button>
                )}
                {arretrato.esito !== null && (
                  <p role="status" className="mt-2 font-maven text-xs text-kidville-sub">{arretrato.esito}</p>
                )}
              </div>
            )}
            {/* `sub` e non `muted`: questa riga È l'avviso che l'elenco è
                troncato, cioè l'unico segnale che dice che ci sono candidature
                che non si stanno vedendo. */}
            {!tuttoContato && (
              <p className="font-maven text-xs text-kidville-sub">
                {t('candMostrate', { n: righe.length, totale })}
              </p>
            )}
            {righe.map((riga) => (
              <button
                key={riga.id}
                type="button"
                onClick={() => apriDettaglio(riga)}
                className={`w-full rounded-card border bg-kidville-white p-4 text-left transition-all ${
                  selezionata?.id === riga.id
                    ? 'border-kidville-green ring-1 ring-kidville-green/30'
                    : 'border-kidville-line hover:border-kidville-green/40'
                }`}
              >
                <span className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="font-barlow font-bold text-kidville-ink">{nomeCompleto(riga)}</span>
                  {/* Come i contatori: lo stato della PROPRIA sede, non l'aggregato. */}
                  <BadgeStato stato={statoDiRiga(riga)} />
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {/* LE POSIZIONI, non le fasce: sono loro a dire a colpo d'occhio
                      se questa candidatura è di una maestra o di una cuoca — cioè
                      l'unica cosa che serve per riconoscere una riga in un elenco.
                      Le fasce sono un dato DERIVATO da queste, e stanno nel
                      dettaglio. */}
                  {posizioniOrdinate(riga.posizioni).map((p) => (
                    <span key={p} className="rounded-pill bg-kidville-green-soft px-2 py-0.5 font-barlow text-[10px] font-bold uppercase tracking-wider text-kidville-green">
                      {etichettaPosizione(p)}
                    </span>
                  ))}
                </span>
                <span className="mt-1.5 flex flex-wrap items-center gap-3 font-maven text-xs text-kidville-sub">
                  <span className="flex items-center gap-1 font-semibold text-kidville-green">
                    <MapPin size={13} /> {nomeSede(riga.scuola_id)}
                  </span>
                  <span>{riga.creata_il ? f.dataBreve(riga.creata_il) : t('candNonIndicato')}</span>
                </span>
              </button>
            ))}
            {altrePagine && (
              <button
                type="button"
                onClick={caricaAltre}
                // Spento anche mentre una RILETTURA è in volo: accodare alla
                // lista vecchia mescolerebbe due plessi (vedi il commento in cima).
                disabled={caricandoAltre || ricaricaInVolo}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-kidville-line px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-[0.03em] text-kidville-green hover:bg-kidville-green-soft disabled:opacity-50"
              >
                {caricandoAltre && <Loader2 size={14} className="animate-spin" />}
                {t('candMostraAltre')}
              </button>
            )}
          </div>

          {/* Dettaglio */}
          <div aria-busy={aprendo !== null}>
            {aprendo ? (
              <div role="status" className="flex items-center justify-center gap-3 rounded-card border border-kidville-line bg-kidville-white p-10">
                <Loader2 className="h-5 w-5 animate-spin text-kidville-green" />
                <span className="font-maven text-kidville-sub">{t('caricamento')}</span>
              </div>
            ) : !selezionata ? (
              <div className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center font-maven text-kidville-sub">
                {t('candSelezionaDettagli')}
              </div>
            ) : (
              <PannelloDettaglio
                cand={selezionata}
                nomeSede={nomeSede(selezionata.scuola_id)}
                nomeDiSede={nomeSede}
                sedeDecisionale={sedeSuCuiDecido(selezionata)}
                sediSceglibili={(selezionata.sedi ?? [])
                  .map((x) => x.scuola_id)
                  .filter((id) => sediAttive.includes(id))}
                onScegliSede={setSedeScelta}
                nomeCompleto={nomeCompleto(selezionata)}
                posizioni={posizioniOrdinate(selezionata.posizioni)}
                etichettaPosizione={etichettaPosizione}
                gradi={gradiOrdinati(selezionata.gradi)}
                etichettaGrado={etichettaGrado}
                titoloStudio={daCatalogo(CHIAVE_TITOLO, selezionata.titolo_studio)}
                disponibilita={daCatalogo(CHIAVE_DISPONIBILITA, selezionata.disponibilita)}
                isDirezione={isDirezione}
                motivoBlocco={motivoBlocco}
                conferma={conferma}
                setConferma={setConferma}
                motivo={motivo}
                setMotivo={setMotivo}
                avvisaEmail={avvisaEmail}
                setAvvisaEmail={setAvvisaEmail}
                lavorando={lavorandoSu === selezionata.id}
                esito={esito}
                avvisi={avvisi}
                cvBloccato={cvBloccato}
                onChiudiEsito={() => setEsito(null)}
                onEsegui={esegui}
                onApriCv={apriCurriculum}
                onIndietro={chiudiDettaglio}
              />
            )}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * GLI ESITI CHE NON SI SONO POTUTI MOSTRARE NEL PANNELLO.
 *
 * Dice tre cose che il testo precedente non diceva, e che sono la ragione per cui
 * questo avviso esiste:
 *
 *  1. CHE COSA È SUCCESSO DAVVERO. «L'account docente è stato creato» e «il
 *     server ha respinto l'operazione» sono frasi opposte: la prima manda a
 *     cercare un account, la seconda a rileggere lo stato. Il vecchio testo ne
 *     diceva UNA sola per tutti i casi, e rimandava alla riga d'elenco — che dirà
 *     «Approvata» e non contiene niente di ciò che si è perso.
 *  2. LE CREDENZIALI. La password è monouso e non è archiviata da nessuna parte:
 *     buttarla qui vuol dire una reimpostazione obbligata, e con l'email delle
 *     credenziali non partita vuol dire una docente che non entra mai. Compaiono
 *     sotto il NOME della persona giusta — che è esattamente ciò che mancava al
 *     pannello, e il motivo per cui lì l'esito si scarta.
 *  3. PERCHÉ non è stato mostrato: il pannello era stato chiuso **oppure** ne era
 *     stata aperta un'altra. Il testo di prima affermava solo la seconda, e sul
 *     percorso «Indietro» descriveva alla segreteria un fatto mai avvenuto.
 *
 * Se ne vanno solo con il gesto in coda: aprire un'altra candidatura non è una
 * presa d'atto.
 */
function AvvisoEsitiScartati({ voci, onCongeda }: { voci: EsitoScartato[]; onCongeda: () => void }) {
  const t = useTranslations('adminAltro')
  return (
    <div
      role="alert"
      className="mb-4 space-y-3 rounded-card border border-kidville-warn/40 bg-kidville-warn-soft px-4 py-3"
    >
      {voci.map((v) => (
        <div key={v.chiave} className="flex items-start gap-2 font-maven text-sm text-kidville-warn-strong">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p>
              {t('candEsitoScartatoPre')} <strong>{v.nome}</strong> {t('candEsitoScartatoPost')}
            </p>

            {v.guasto === 'respinta' && <p>{t('candScartatoRespinta')}</p>}
            {v.guasto === 'senzaRisposta' && <p>{t('candScartatoSenzaRisposta')}</p>}

            {v.esito?.azione === 'rifiuta' && (
              <p>
                {t('candScartatoRifiutoRegistrato')}{' '}
                {v.esito.esitoEmailInviato ? t('candEsitoEmailInviata') : t('candEsitoEmailNonInviata')}
              </p>
            )}

            {v.esito?.azione === 'approva' && (
              <>
                {/* ⚠️ ANCHE QUI LE STORIE SONO TRE, e questa è la strada che si
                    percorre quando l'esito è andato perso: è l'unica copia di ciò
                    che è successo. Dire «l'account docente È STATO CREATO» dopo
                    l'approvazione di una cuoca manderebbe a cercarlo per sempre. */}
                <p className="font-semibold">
                  {v.esito.esitoAccount === 'nessuno'
                    ? t('candEsitoApprovataSenzaAccount')
                    : v.esito.stato === 'in_approvazione'
                      ? t('candScartatoAccountCreatoAMeta')
                      : t('candScartatoAccountCreato')}
                </p>
                {v.esito.credentials ? (
                  <>
                    <p className="flex items-start gap-1.5 text-kidville-ink">
                      <KeyRound size={14} className="mt-0.5 shrink-0" />
                      <span className="select-all">
                        {t('candCredenziali')} <strong>{v.esito.credentials.email}</strong> /{' '}
                        <code>{v.esito.credentials.password}</code>
                      </span>
                    </p>
                    <p className="text-xs">{t('candCredenzialiAvviso')}</p>
                    {!v.esito.credentialsEmailSent && (
                      <p className="text-xs font-semibold">{t('candCredNonInviate')}</p>
                    )}
                  </>
                ) : v.esito.esitoAccount === 'nessuno' ? null : (
                  <p className="text-xs">{t('candNessunaCredenziale')}</p>
                )}
              </>
            )}

            {/* Gli avvisi del server viaggiano con l'esito: sono la sola traccia
                di ciò che è stato scritto a metà, e qui non c'è un pannello in
                cui andarli a rileggere. */}
            {v.avvisi.length > 0 && (
              <ul className="ml-4 list-disc text-xs">
                {v.avvisi.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={onCongeda}
        className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-green bg-kidville-white px-3.5 py-1.5 font-barlow text-xs font-bold uppercase tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft"
      >
        {t('candEsitoScartatoCongeda')}
      </button>
    </div>
  )
}

function BadgeStato({ stato }: { stato: string }) {
  const t = useTranslations('adminAltro')
  const chiave = CHIAVE_STATO[stato] ?? CHIAVE_STATO.pending
  const tinta = TINTA_STATO[stato] ?? TINTA_STATO.pending
  return (
    <span className={`rounded-pill px-2 py-0.5 font-barlow text-[10px] font-bold uppercase tracking-wider ${tinta}`}>
      {t(chiave)}
    </span>
  )
}

/**
 * Una voce del dettaglio: etichetta + valore, o «Non indicato».
 *
 * Un dato mancante NON è un errore: qui si dice che non c'è, in inchiostro
 * neutro, invece di lasciare una riga vuota che si legge come un guasto. (La
 * residenza è facoltativa nel modulo pubblico, il telefono anche.)
 *
 * Volutamente `div`/`p` e non `dl`/`dt`/`dd`: la lista di definizione con i
 * wrapper `div` che serve alla griglia è terreno incerto per la regola `dlitem`
 * di axe, e un dubbio sull'accessibilità non si spende su una coppia
 * etichetta-valore che il markup semplice rende altrettanto bene.
 */
function Voce({ etichetta, valore }: { etichetta: string; valore?: string | number | null }) {
  const t = useTranslations('adminAltro')
  const testo = valore === null || valore === undefined || String(valore).trim() === ''
    ? t('candNonIndicato')
    : String(valore)
  return (
    <div>
      <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-sub">{etichetta}</p>
      <p className="font-maven text-sm text-kidville-ink">{testo}</p>
    </div>
  )
}

function PannelloDettaglio({
  cand, nomeSede, nomeDiSede, sedeDecisionale, sediSceglibili, onScegliSede, nomeCompleto, posizioni, etichettaPosizione, gradi, etichettaGrado,
  titoloStudio, disponibilita,
  isDirezione, motivoBlocco, conferma, setConferma, motivo, setMotivo, avvisaEmail,
  setAvvisaEmail, lavorando, esito, avvisi, cvBloccato, onChiudiEsito, onEsegui,
  onApriCv, onIndietro,
}: {
  cand: Candidatura
  nomeSede: string
  /** Il nome leggibile di UNA sede qualunque, per l'elenco dei plessi. */
  nomeDiSede: (scuolaId?: string | null) => string
  /** Il plesso su cui questa persona sta decidendo, da evidenziare. */
  sedeDecisionale: string | undefined
  /** I plessi di questa candidatura su cui chi guarda ha titolo di decidere. */
  sediSceglibili: string[]
  /** Sceglie il plesso su cui decidere, quando ce n'è più d'uno possibile. */
  onScegliSede: (scuolaId: string) => void
  nomeCompleto: string
  posizioni: string[]
  etichettaPosizione: (p: string) => string
  gradi: string[]
  etichettaGrado: (g: string) => string
  titoloStudio: string | null
  disponibilita: string | null
  isDirezione: boolean
  motivoBlocco: string
  conferma: 'approva' | 'rifiuta' | null
  setConferma: (v: 'approva' | 'rifiuta' | null) => void
  motivo: string
  setMotivo: (v: string) => void
  avvisaEmail: boolean
  setAvvisaEmail: (v: boolean) => void
  lavorando: boolean
  esito: Esito | null
  avvisi: string[]
  cvBloccato: string | null
  onChiudiEsito: () => void
  onEsegui: (azione: 'approva' | 'rifiuta') => void
  onApriCv: (path?: string | null) => void
  onIndietro: () => void
}) {
  const t = useTranslations('adminAltro')
  const f = useDateFormat()
  /**
   * LA RIGA DI SEDE DI CHI GUARDA, e da qui in giù è LEI a comandare.
   *
   * ⚠️ `cand.stato` è l'AGGREGATO di tutte le sedi, e usarlo per i pulsanti è un
   * difetto vero: con Giugliano già approvata e Aversa ancora in valutazione
   * l'aggregato vale `pending`, quindi l'operatore di Giugliano vedrebbe il
   * badge «in valutazione» e i due pulsanti ACCESI su una pratica che ha già
   * chiuso. Premendoli prenderebbe 409 «già valutata: ricaricare la pagina» —
   * e ricaricare non cambierebbe niente, perché non è la pagina a essere
   * vecchia. Un ordine ineseguibile, dato all'infinito.
   *
   * Il ripiego su `cand.stato` serve all'ambiente non ancora migrato, dove le
   * righe di sede non esistono e la colonna è ancora l'unica verità — ma serve
   * SOLO al badge: vedi `senzaRigheDiSede` qui sotto, e perché i pulsanti in
   * quell'ambiente restano spenti.
   */
  const mia =
    (cand.candidature_sedi ?? []).find((r) => r.scuola_id === sedeDecisionale) ??
    (cand.candidature_sedi ?? [])[0]
  const statoMio = mia?.stato ?? cand.stato
  /**
   * ⚠️ IL BADGE PUÒ RIPIEGARE, I PULSANTI NO.
   *
   * Il ripiego su `cand.stato` era documentato come servizio «all'ambiente non
   * ancora migrato, dove le righe di sede non esistono». In quell'ambiente il
   * badge dice una cosa vera, anche se grossolana — e va bene. Ma `cambiaStato`
   * scrive su `candidature_sedi` e degrada solo sulla COLONNA assente, non sulla
   * TABELLA assente: ogni «Approva» prende `42P01`/`PGRST205` e torna 503.
   *
   * Quindi il ripiego accendeva due pulsanti su un percorso che non può
   * riuscire. È lo stesso difetto che il blocco qui sopra denuncia per
   * l'aggregato — «un ordine ineseguibile, dato all'infinito» — entrato da
   * un'altra porta: là era un 409, qui è un 503.
   */
  const senzaRigheDiSede = (cand.candidature_sedi ?? []).length === 0
  /**
   * La scelta del plesso è DAVVERO ambigua: più di uno in comune fra la
   * candidatura e chi guarda, e nessuno ancora indicato. Solo in questo caso
   * l'elenco diventa scegliibile — altrove sarebbe una domanda con una risposta
   * sola, cioè un ostacolo.
   */
  const deveScegliere = sediSceglibili.length > 1 && sedeDecisionale === undefined
  const decisa = statoMio === 'approvata' || statoMio === 'rifiutata'
  /**
   * Questa approvazione farà nascere un account?
   *
   * Si calcola dalle POSIZIONI con lo STESSO predicato del server
   * (`comprendeInsegnamento`, che vive nel template). Scriverne uno qui — anche
   * solo un `posizioni.some(p => p.startsWith('insegnante_'))` — vorrebbe dire
   * che la conferma e la PATCH possono un giorno rispondere in modo diverso alla
   * stessa domanda, e la conferma è la frase su cui la Direzione preme
   * «Conferma»: se descrive un'altra operazione, il consenso che raccoglie non
   * vale niente.
   */
  const creeraAccount = comprendeInsegnamento(posizioni)
  /**
   * `in_approvazione` = l'account docente ESISTE e la riga non è chiusa. Non è
   * uno stato azionabile da questa schermata: «Approva» ricreerebbe (la route lo
   * respinge, ma il gesto non va nemmeno offerto) e «Rifiuta» è ACCETTATO dal
   * server, scriverebbe `rifiutata` e, con la spunta, manderebbe l'email di
   * rifiuto a chi ha già ricevuto le credenziali.
   */
  const sospesa = statoMio === 'in_approvazione'
  /**
   * I due pulsanti sono spenti per TRE ragioni, e ognuna ha la sua frase.
   *
   * La terza è nuova: `lavorando` è ora legato alla candidatura su cui si sta
   * agendo, e riaprendo QUELLA mentre la sua PATCH è ancora in volo i pulsanti
   * restano spenti — giusto, perché ripremerli farebbe partire due volte la
   * creazione di un account. Prima lo stato era condiviso e spegneva i pulsanti
   * di CHIUNQUE, senza `title` e senza una riga che dicesse perché: cioè un
   * divieto legittimo che si presenta come un guasto, l'anti-pattern che
   * l'intestazione di questo file si impegna a evitare.
   */
  const azioniSpente = !isDirezione || sospesa || lavorando || senzaRigheDiSede
  const motivoAzioniSpente = sospesa
    ? t('candSospesaAzioniSpente')
    : !isDirezione
      ? motivoBlocco
      : senzaRigheDiSede
        ? t('candSenzaRigheDiSede')
        : t('candAzioneInCorso')

  /**
   * Il fuoco si sposta sull'intestazione del pannello a ogni apertura: su schermo
   * stretto il pannello SOSTITUISCE l'elenco, e chi naviga da tastiera restava
   * sul pulsante della riga con il «torna indietro» irraggiungibile senza
   * attraversare tutto.
   */
  const titoloRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { titoloRef.current?.focus() }, [cand.id])

  // Comune e provincia sono DUE colonne e sono entrambe facoltative: si uniscono
  // solo quelle che ci sono. Un `Giugliano ()` a schermo direbbe che manca un
  // dato che non è mai stato chiesto.
  const residenza = [cand.residence_city, cand.residence_province]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' · ')

  const titoloEsito = esito === null
    ? ''
    : esito.azione === 'rifiuta'
      ? t('candEsitoRifiutata')
      : esito.stato === 'in_approvazione'
        ? t('candEsitoPresaInCarico')
        : t('candEsitoApprovata')
  // Il riquadro si tinge di ciò che è successo davvero: verde solo quando la
  // chiusura è riuscita. Prima era verde anche sull'approvazione rimasta a metà.
  const esitoRiuscito = esito !== null && esito.stato !== 'in_approvazione'

  return (
    <div className="space-y-5 rounded-card border border-kidville-line bg-kidville-white p-5">
      <button
        type="button"
        onClick={onIndietro}
        className="flex items-center gap-1 font-maven text-sm text-kidville-sub md:hidden"
      >
        <ChevronLeft size={16} /> {t('candIndietro')}
      </button>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          ref={titoloRef}
          tabIndex={-1}
          className="font-barlow text-lg font-black uppercase tracking-[0.01em] text-kidville-green"
        >
          {nomeCompleto}
        </h2>
        {/* Lo stato DELLA PROPRIA SEDE, non l'aggregato: vedi `statoMio`. Il
            badge sta accanto ai pulsanti, e mostrarne uno che li contraddice è
            il modo più diretto di far premere il gesto sbagliato. */}
        <BadgeStato stato={statoMio} />
      </div>

      {/* ── PER QUALI SCUOLE, E COME STA CIASCUNA ──────────────────────────
          Prima di ogni altro dato, come è sempre stato: chi decide deve sapere
          per quale plesso sta decidendo, prima di leggere il nome della persona.

          ⚠️ DAL 2026-08-19 I PLESSI POSSONO ESSERE PIÙ D'UNO, e la scheda li dice
          TUTTI — anche quelli che non sono di chi guarda. Non è indiscrezione: se
          la stessa persona è in valutazione a Giugliano e ad Aversa e nessuna
          delle due lo sa, le due segreterie istruiscono la stessa pratica in
          parallelo e la convocano due volte con parole diverse. Il nome della
          sede altrui non è un dato sensibile; l'ignoranza reciproca sì, è un
          disservizio.

          Il plesso su cui si sta decidendo È EVIDENZIATO: con tre sedi in
          elenco, «Approva» senza sapere quale riga si sta chiudendo è il gesto
          da cui esce la decisione sbagliata. */}
      {(cand.sedi ?? []).length > 1 ? (
        <div className="rounded-xl bg-kidville-green-soft px-3 py-2">
          <p className="flex items-center gap-1.5 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green">
            <MapPin size={14} /> {t('candSediMultiple')}
          </p>
          {/* ⚠️ QUANDO IL PLESSO NON È DEDUCIBILE, LO SI CHIEDE.
              `sedeCorrente` è `null` appena l'operatore ha più di una sede attiva
              nel selettore in alto, e se la candidatura è rivolta a due dei suoi
              plessi non c'è modo di sapere su quale stia decidendo: il server
              risponde 400 `SEDE_DA_SPECIFICARE`, giustamente. Prima di oggi il
              pannello non offriva NESSUNA via — l'elenco era di sola lettura — e
              chi lavora su tutte e tre le sedi non poteva chiudere niente,
              senza che una riga glielo spiegasse. */}
          <ul className="mt-1.5 space-y-1" {...(deveScegliere ? { role: 'radiogroup', 'aria-label': t('candSediMultiple') } : {})}>
            {(cand.sedi ?? []).map((s) => {
              const propria = s.scuola_id === sedeDecisionale
              const sceglibile = deveScegliere && sediSceglibili.includes(s.scuola_id)
              const etichetta = (
                <>
                  <span>
                    {propria && <span aria-hidden="true">▸ </span>}
                    {nomeDiSede(s.scuola_id)}
                  </span>
                  <BadgeStato stato={s.stato ?? 'pending'} />
                </>
              )
              const classi = `flex items-center justify-between gap-2 font-maven text-sm ${
                propria ? 'font-bold text-kidville-green' : 'text-kidville-sub'
              }`
              return (
                <li key={s.scuola_id} {...(propria ? { 'data-testid': 'sede-propria' } : {})}>
                  {sceglibile ? (
                    <label className={`${classi} min-h-11 cursor-pointer`}>
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="sede-su-cui-decido"
                          value={s.scuola_id}
                          checked={propria}
                          onChange={() => onScegliSede(s.scuola_id)}
                          className="h-4 w-4 accent-kidville-green"
                        />
                        {etichetta}
                      </span>
                    </label>
                  ) : (
                    <span className={classi}>{etichetta}</span>
                  )}
                </li>
              )
            })}
          </ul>
          {deveScegliere && (
            <p className="mt-1.5 font-maven text-xs text-kidville-sub">{t('candScegliSedeSuCuiDecidere')}</p>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 rounded-xl bg-kidville-green-soft px-3 py-2 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green">
          <MapPin size={14} /> {t('candSede')} <strong>{nomeSede}</strong>
        </p>
      )}

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-kidville-sub">
          <Mail size={14} /> {t('candContatti')}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Voce etichetta={t('candEmail')} valore={cand.email} />
          <Voce etichetta={t('candTelefono')} valore={cand.telefono} />
          <Voce etichetta={t('candResidenza')} valore={residenza} />
          <Voce etichetta={t('candRicevutaIl')} valore={cand.creata_il ? f.dataBreve(cand.creata_il) : null} />
        </div>
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-kidville-sub">
          <FileText size={14} /> {t('candProfilo')}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Voce etichetta={t('candTitoloStudio')} valore={titoloStudio} />
          <Voce etichetta={t('candTitoloDettaglio')} valore={cand.titolo_dettaglio} />
          <Voce etichetta={t('candAnni')} valore={cand.anni_esperienza} />
          {/* Dal 2026-08-24 la domanda non si fa più: la riga esiste solo per le
              candidature che quel valore ce l'hanno in tabella. `Voce` non nasconde una
              riga vuota — stampa «Non indicato» — quindi il condizionale sta QUI e non
              dentro di lei, che serve a una dozzina di altre voci dove «Non indicato» è
              informazione voluta. Il predicato basta così com'è: `daCatalogo` torna
              `null` anche sulla stringa vuota o di soli spazi. */}
          {disponibilita && <Voce etichetta={t('candDisponibilita')} valore={disponibilita} />}
        </div>
        {/* LE POSIZIONI VENGONO PRIMA DELLE FASCE, ed è l'ordine della domanda:
            «per quale lavoro si è proposta» precede «per quali fasce d'età». È
            anche l'unico blocco che una candidatura non docente ha davvero. */}
        <div className="mt-3">
          <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-sub">{t('candPosizioni')}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {posizioni.length === 0 ? (
              <span className="font-maven text-sm text-kidville-ink">{t('candNonIndicato')}</span>
            ) : (
              posizioni.map((p) => (
                <span key={p} className="rounded-pill bg-kidville-green-soft px-2.5 py-1 font-barlow text-[11px] font-bold uppercase tracking-wider text-kidville-green">
                  {etichettaPosizione(p)}
                </span>
              ))
            )}
          </div>
        </div>
        {/* Il mestiere scritto a mano: c'è se e solo se fra le posizioni c'è
            «altro» (in tabella lo impone un `CHECK` di coerenza nei due versi).
            Senza questa riga, «Altro» sarebbe un'etichetta che non dice niente. */}
        {cand.posizione_altro && (
          <div className="mt-3">
            <Voce etichetta={t('candPosizioneAltro')} valore={cand.posizione_altro} />
          </div>
        )}
        <div className="mt-3">
          <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-sub">{t('candFasce')}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {/* ⚠️ «Nessuna» e non «Non indicato»: dal 2026-08-15 le fasce si
                DERIVANO dalle posizioni e non si chiedono più, quindi un elenco
                vuoto non è un dato che manca — è ciò che ha una cuoca. «Non
                indicato» manderebbe la Direzione a cercare un'omissione che non
                c'è, sulla schermata da cui si decide un'assunzione. */}
            {gradi.length === 0 ? (
              <span className="font-maven text-sm text-kidville-ink">{t('candNessunaFascia')}</span>
            ) : (
              gradi.map((g) => (
                <span key={g} className="rounded-pill bg-kidville-green-soft px-2.5 py-1 font-barlow text-[11px] font-bold uppercase tracking-wider text-kidville-green">
                  {etichettaGrado(g)}
                </span>
              ))
            )}
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-kidville-sub">{t('candPresentazione')}</h3>
        <p className="whitespace-pre-line rounded-xl border border-kidville-line bg-kidville-cream/50 p-3 font-maven text-sm text-kidville-ink">
          {(cand.note ?? '').trim() || t('candNonIndicato')}
        </p>
      </section>

      <section>
        {cand.cv_path ? (
          <button
            type="button"
            onClick={() => onApriCv(cand.cv_path)}
            className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-green px-3.5 py-1.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft"
          >
            <FileText size={14} /> {t('candApriCv')} <ExternalLink size={12} />
          </button>
        ) : (
          <p className="font-maven text-sm text-kidville-sub">{t('candNessunCv')}</p>
        )}
        {cvBloccato && (
          <p role="alert" className={AVVISO_FINESTRA_BLOCCATA}>
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {t('candCvBloccato')}{' '}
            <a
              href={cvBloccato}
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-kidville-green underline"
            >
              {t('candCvApriManuale')}
            </a>
          </p>
        )}
      </section>

      {/* ⚠️ LO STATO E IL MOTIVO SONO QUELLI DELLA PROPRIA SEDE, non della
          candidatura. Dal 2026-08-19 `cand.stato` è l'AGGREGATO: con Giugliano
          già rifiutata e Aversa ancora in valutazione vale `pending`, e la
          segreteria di Giugliano non vedrebbe più la nota che ha appena scritto.
          E `cand.motivo_rifiuto` non lo scrive più nessuno: il verdetto vive
          sulla riga di sede. Leggere ancora la colonna della candidatura
          significa non mostrare mai più nessun motivo. */}
      {mia?.stato === 'rifiutata' && (mia?.motivo_rifiuto ?? '').trim() !== '' && (
        <section>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-kidville-sub">{t('candMotivoRegistrato')}</h3>
          <p className="whitespace-pre-line rounded-xl border border-kidville-line bg-kidville-cream/50 p-3 font-maven text-sm text-kidville-ink">
            {mia?.motivo_rifiuto}
          </p>
        </section>
      )}

      {/* ── APPROVAZIONE RIMASTA A METÀ: resta finché resta lo stato ────────── */}
      {sospesa && (
        <div className="space-y-1 rounded-xl border border-kidville-warn/40 bg-kidville-warn-soft p-4">
          <p className="flex items-center gap-1.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-warn-strong">
            <AlertTriangle size={16} /> {t('candSospesaTitolo')}
          </p>
          <p className="font-maven text-sm text-kidville-warn-strong">{t('candSospesaTesto')}</p>
        </div>
      )}

      {/* Gli avvisi del server: FUORI dal riquadro congedabile, perché sono la
          sola traccia di ciò che è stato scritto a metà. */}
      {avvisi.length > 0 && (
        <div className="rounded-xl bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn-strong">
          <p className="flex items-center gap-1 font-semibold"><AlertTriangle size={12} /> {t('candAvvisi')}</p>
          <ul className="ml-5 list-disc">
            {avvisi.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* ── ESITO: le credenziali si vedono UNA volta sola ─────────────────── */}
      {esito && (
        <div
          className={`space-y-2 rounded-xl border p-4 ${
            esitoRiuscito
              ? 'border-kidville-success/30 bg-kidville-success-soft'
              : 'border-kidville-warn/40 bg-kidville-warn-soft'
          }`}
        >
          <p
            className={`flex items-center gap-1.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] ${
              esitoRiuscito ? 'text-kidville-success-strong' : 'text-kidville-warn-strong'
            }`}
          >
            {esitoRiuscito ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            {titoloEsito}
          </p>

          {esito.azione === 'approva' && (
            esito.credentials ? (
              <>
                <p className="flex items-start gap-2 font-maven text-sm text-kidville-ink">
                  <KeyRound size={14} className="mt-0.5 shrink-0 text-kidville-success-strong" />
                  <span className="select-all">
                    {t('candCredenziali')} <strong>{esito.credentials.email}</strong> /{' '}
                    <code>{esito.credentials.password}</code>
                  </span>
                </p>
                <p className="font-maven text-xs text-kidville-sub">{t('candCredenzialiAvviso')}</p>
                {esito.credentialsEmailSent ? (
                  <p className="flex items-center gap-1.5 font-maven text-xs text-kidville-success-strong">
                    <CheckCircle2 size={12} /> {t('candCredInviate')}
                  </p>
                ) : (
                  // Se l'email non è partita l'account ESISTE comunque, e chi
                  // guarda deve saperlo: qui si dice tutte e due le cose.
                  <p className="flex items-start gap-1.5 rounded-lg bg-kidville-warn-soft px-2.5 py-2 font-maven text-xs text-kidville-warn-strong">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {t('candCredNonInviate')}
                  </p>
                )}
              </>
            ) : esito.esitoAccount === 'nessuno' ? (
              // LA TERZA STORIA. Prima esistevano solo «password mostrata» e
              // «nessuna password: esisteva già un accesso»: quest'ultima, su una
              // candidatura non docente, manderebbe la Segreteria a cercare un
              // account che non è mai stato creato.
              <p className="font-maven text-xs text-kidville-sub">{t('candEsitoApprovataSenzaAccount')}</p>
            ) : (
              <p className="font-maven text-xs text-kidville-sub">{t('candNessunaCredenziale')}</p>
            )
          )}

          {esito.azione === 'rifiuta' && (
            <p className="font-maven text-xs text-kidville-sub">
              {esito.esitoEmailInviato ? t('candEsitoEmailInviata') : t('candEsitoEmailNonInviata')}
            </p>
          )}

          <button
            type="button"
            onClick={onChiudiEsito}
            className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-green px-3.5 py-1.5 font-barlow text-xs font-bold uppercase tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft"
          >
            {t('candHoPresoNota')}
          </button>
        </div>
      )}

      {/* ── LE AZIONI, solo per la Direzione ──────────────────────────────── */}
      {!decisa && !esito && (
        <div className="space-y-3 border-t border-kidville-line pt-3">
          {/* Il motivo si scrive quando i due pulsanti sono a schermo e spenti.
              Durante la conferma (`conferma !== null`) i pulsanti non ci sono e
              al loro posto gira la rotella del «Confermo»: ripetere lì che
              un'operazione è in corso sarebbe rumore, non informazione. */}
          {azioniSpente && conferma === null && (
            <p className="flex items-start gap-2 rounded-xl bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn-strong">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {motivoAzioniSpente}
            </p>
          )}

          {conferma === null && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setConferma('approva')}
                disabled={azioniSpente}
                title={azioniSpente ? motivoAzioniSpente : undefined}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-kidville-green px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-yellow-ink disabled:border disabled:border-kidville-neutral disabled:bg-kidville-neutral-soft disabled:text-kidville-sub"
              >
                <CheckCircle2 size={16} /> {t('candApprova')}
              </button>
              <button
                type="button"
                onClick={() => setConferma('rifiuta')}
                disabled={azioniSpente}
                title={azioniSpente ? motivoAzioniSpente : undefined}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-kidville-error px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-error-strong disabled:border-kidville-neutral disabled:bg-kidville-neutral-soft disabled:text-kidville-sub"
              >
                <XCircle size={16} /> {t('candRifiuta')}
              </button>
            </div>
          )}

          {/* Conferma di APPROVAZIONE: nomina ciò che sta per succedere. */}
          {conferma === 'approva' && (
            <div className="space-y-2 rounded-xl border border-kidville-green/40 bg-kidville-green-soft p-4">
              <p className="font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-green">
                {t('candConfermaApprovaTitolo')}
              </p>
              {/* ⚠️ LA CONFERMA DEVE DESCRIVERE CIÒ CHE VERRÀ ESEGUITO, e dal
                  2026-08-15 sono due cose diverse: chiedere conferma di una
                  creazione di account per una candidatura da cuoca significa
                  farsi dire di sì a una domanda che non è quella. Il predicato è
                  lo STESSO del server (`comprendeInsegnamento`, dal template),
                  perché una seconda regola qui direbbe una cosa e la PATCH ne
                  farebbe un'altra. */}
              {creeraAccount ? (
                <>
                  <p className="font-maven text-sm text-kidville-ink">
                    {t('candConfermaApprovaAccount')} <strong>{nomeCompleto}</strong>{' '}
                    {t('candConfermaApprovaSede')} <strong>{nomeSede}</strong>
                    {gradi.length > 0 && (
                      <>
                        {', '}
                        {t('candConfermaApprovaFasce')}{' '}
                        <strong>{gradi.map(etichettaGrado).join(', ')}</strong>
                      </>
                    )}
                    {'. '}
                    {t('candConfermaApprovaCredenziali')}{' '}
                    <strong>{(cand.email ?? '').trim() || t('candNonIndicato')}</strong>.
                  </p>
                  {/* L'avviso «nessuna fascia» vale SOLO qui: su una candidatura
                      docente un elenco vuoto è un'anomalia da sistemare a mano.
                      Sul ramo senza account sarebbe un allarme giallo che
                      descrive un problema inesistente — e un avviso che grida
                      sempre smette di essere letto quando dice qualcosa di vero. */}
                  {gradi.length === 0 && (
                    <p className="flex items-start gap-1.5 font-maven text-xs text-kidville-warn-strong">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {t('candConfermaApprovaFasceMancanti')}
                    </p>
                  )}
                </>
              ) : (
                <p className="font-maven text-sm text-kidville-ink">
                  {t('candConfermaApprovaSenzaAccount')}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => onEsegui('approva')}
                  disabled={lavorando}
                  className="inline-flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-yellow-ink disabled:border disabled:border-kidville-neutral disabled:bg-kidville-neutral-soft disabled:text-kidville-sub"
                >
                  {lavorando ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  {t('candConferma')}
                </button>
                <button
                  type="button"
                  onClick={() => setConferma(null)}
                  disabled={lavorando}
                  className="rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-sub hover:bg-kidville-cream disabled:opacity-50"
                >
                  {t('candAnnulla')}
                </button>
              </div>
            </div>
          )}

          {/* Conferma di RIFIUTO: motivo facoltativo, email SPENTA di default. */}
          {conferma === 'rifiuta' && (
            <div className="space-y-3 rounded-xl border border-kidville-error/40 bg-kidville-error-soft p-4">
              <p className="font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-error-strong">
                {t('candConfermaRifiutaTitolo')}
              </p>
              <p className="font-maven text-sm text-kidville-ink">
                {t('candConfermaRifiutaTesto')} <strong>{nomeCompleto}</strong>.
              </p>
              <div>
                <label htmlFor="cand-motivo" className="block font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-sub">
                  {t('candMotivo')}
                </label>
                <textarea
                  id="cand-motivo"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  className="mt-1 w-full rounded-input border border-kidville-line bg-kidville-white p-2.5 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none"
                />
                <p className="mt-1 font-maven text-xs text-kidville-sub">{t('candMotivoAiuto')}</p>
              </div>
              <label className="flex cursor-pointer items-start gap-2 font-maven text-sm text-kidville-ink">
                <input
                  type="checkbox"
                  checked={avvisaEmail}
                  onChange={(e) => setAvvisaEmail(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-kidville-green"
                />
                <span>
                  {t('candAvvisaEmail')}
                  <span className="block font-maven text-xs text-kidville-sub">{t('candAvvisaEmailNota')}</span>
                </span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onEsegui('rifiuta')}
                  disabled={lavorando}
                  className="inline-flex items-center gap-2 rounded-pill border border-kidville-error bg-kidville-white px-4 py-2 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-error-strong disabled:border-kidville-neutral disabled:bg-kidville-neutral-soft disabled:text-kidville-sub"
                >
                  {lavorando ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                  {t('candConferma')}
                </button>
                <button
                  type="button"
                  onClick={() => setConferma(null)}
                  disabled={lavorando}
                  className="rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-sub hover:bg-kidville-cream disabled:opacity-50"
                >
                  {t('candAnnulla')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
