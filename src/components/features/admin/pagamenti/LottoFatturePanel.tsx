'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { formatEuro } from '@/lib/format/valuta';
import { cx } from '@/lib/ui/cx';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import type { MovimentoUi } from './riconciliazione-ui';
import {
  CODICE_TRASPORTO_IGNOTO,
  TETTO_BLOCCO,
  TETTO_LOTTO,
  corpoEmissione,
  bloccoHaToccatoAruba,
  numeroInDubbio,
  // ⚠️ `fermaIlLotto` e `pausaDopo` NON servono più QUI, e vale la pena dire perché
  // invece di lasciarli importati per abitudine. Decidevano riga per riga: «questo
  // status ferma il lotto?» e «quanto aspetto dopo questa risposta?». Adesso la
  // decisione riga-per-riga vive sul server (`fattura/lotto`, che `fermaIlLotto` lo usa
  // ancora), e qui la regola è più stretta: una POST di blocco che non torna 2xx ferma
  // sempre — un esito che non si è potuto leggere può nascondere quindici documenti
  // fiscali, non uno. L'attesa la decide il CONTENUTO del blocco, non il suo status.
  pausaDopoBlocco,
  stimaRimanenteMs,
  prontaPerIlLotto,
  type AnteprimaPerIlLotto,
} from '@/lib/pagamenti/lotto-fatture';

/**
 * ─── «EMETTI TUTTE»: LA BARRA DI MASSA DELLA RICONCILIAZIONE ────────────────
 *
 * 130 pagamenti saldati aspettano una fattura, e finora si emettevano aprendo
 * 130 popup uno per uno. Questo pannello li manda in un lotto — ma la parte che
 * lo rende utile invece che dannoso NON è il ciclo di POST: è il **pre-volo**.
 *
 * ─── PERCHÉ IL PRE-VOLO VIENE PRIMA DI TUTTO ────────────────────────────────
 * Misurato in produzione il 2026-09-04: su 93 pagamenti saldati, 88 rispondevano
 * «Intestatario fattura non impostato» e non emettevano niente. Rimisurato il
 * 2026-09-07 sui 130 da fatturare: **uno solo** ha un intestatario risolvibile.
 * Un «emetti tutte» che parte alla cieca brucerebbe la quota di Aruba per
 * fallire quasi sempre — e ogni tentativo, anche rifiutato, riazzera per un'ora
 * il secchio dei limiti.
 *
 * `GET /api/pagamenti/fattura/anteprima` **non parla con Aruba**: usa gli stessi
 * `componiCausalePagamento` e `determinaQuoteFatturazione` dell'emissione, tutto
 * in casa. Il pre-volo costa zero quota, e in dieci secondi dice ciò che oggi si
 * scopre aprendo 130 popup. Le righe non pronte NON spariscono: vanno in un
 * secondo elenco col motivo, ed è il valore vero di questa funzione.
 *
 * ─── LE COSE CHE SI MOSTRANO, E QUELLE CHE NON SI LOGGANO ───────────────────
 * A schermo si mostra la causale che uscirà DAVVERO — quella dell'anteprima, mai
 * ricomposta nel browser: far approvare un documento e spedirne un altro si
 * corregge solo con una nota di variazione. Quella causale contiene il codice
 * fiscale di un minore: sta dove sta già oggi (stesso operatore, stessa sede,
 * dietro `assertPagamentoInScope`) e **non entra in nessun log**, né client né
 * server (AGENTS.md, regola 8). Nei log solo conteggi, uuid e status.
 *
 * ─── LA RIPRESA NON HA UNA TABELLA SUA ──────────────────────────────────────
 * Non esiste nessuna «tabella dei lotti», e non deve esistere: lo stato è già
 * persistito in `pagamenti.fattura_stato` + `fatture_emesse`, con doppia
 * idempotenza (codice e indice unico parziale). Una fattura con trasporto ignoto
 * è scritta con `sdi_stato: null` e il registro la conta fra le VIVE, quindi esce
 * dal bidone «da fatturare» e un lotto successivo non la ripesca — misurato in
 * `__tests__/api/riconciliazione-ripresa-trasporto.test.ts`. Una tabella di lotto
 * sarebbe una SECONDA scrittura dello stesso fatto, cioè un posto in più da cui
 * un giorno diverge.
 */

interface Props {
  userId: string;
  /** Le righe selezionate, nell'ordine della lista. */
  selezionate: MovimentoUi[];
  /** Svuota la selezione nel pannello padre (smonta questo). */
  onChiudi: () => void;
  /** Il mondo è cambiato: la lista e i conteggi vanno riletti. */
  onDone: () => void;
  /**
   * «C'è del lavoro in volo»: pre-volo, conferma, o lotto vero — cioè tutto ciò
   * che sta fra la prima misura della selezione e la fine.
   *
   * ⚠️ NON È UN DETTAGLIO DI PRESENTAZIONE. Le caselle di selezione vivono nel
   * pannello PADRE, e questo componente è montato su `selezionati.size > 0`:
   * finché il padre non sa che c'è un ciclo in volo, togliere le spunte lo
   * smonta — e un ciclo `async` già partito continuerebbe a emettere documenti
   * fiscali senza barra, senza `role="status"` e senza riepilogo. Il padre lo
   * usa per BLOCCARE le caselle, che è ciò che impedisce lo smontaggio; il
   * cleanup qui sotto è la seconda difesa, indipendente da questa.
   *
   * ⚠️ La fase `conferma` è dentro, e non lo era: v. l'effetto che lo dichiara.
   */
  onLavoro: (inCorso: boolean) => void;
}

/**
 * Quante anteprime si chiedono insieme.
 *
 * Quattro e non dodici: l'anteprima non tocca Aruba, ma apre comunque una
 * connessione e una lettura sul nostro database per riga. Dodici insieme, su una
 * scheda che ne ha già due in volo (lista e conteggi), è il modo di far sembrare
 * lento il pezzo che costa meno.
 */
const BLOCCO_ANTEPRIME = 4;

/**
 * L'ISTANTE, letto FUORI dal corpo del componente.
 *
 * `react-hooks/purity` vieta `Date.now()` dentro un componente, e nel caso
 * generale ha ragione: un valore che cambia a ogni render rende il render non
 * idempotente. Qui serve dentro un gestore asincrono — non nel render — ma la
 * regola non può distinguere i due casi, e zittirla con un `eslint-disable`
 * spegnerebbe la protezione anche per chi scriverà la prossima riga di questo
 * file. Una funzione di modulo costa una riga e non spegne niente: è la stessa
 * scelta di `timeAgo` in `AvvisoCard.tsx`.
 */
const adesso = (): number => Date.now();

/** Le fasi del lotto. Il pulsante primario è UNO e cambia mestiere con la fase. */
type Fase = 'selezione' | 'controllo' | 'conferma' | 'corso' | 'fine';

/** Una riga che l'anteprima dichiara emettibile così com'è. */
interface Pronta {
  id: string;
  pagamentoId: string;
  importo: number;
  data: string | null;
  /** Il testo che finirà sul documento: quello del server, mai ricomposto qui. */
  causale: string;
  /** Chi riceverà la fattura, come lo dicono le quote dell'anteprima. */
  intestatario: string;
}

/** Una riga che non si può emettere così com'è, col motivo. */
interface DaCompletare {
  id: string;
  importo: number;
  data: string | null;
  motivo: string;
}

/**
 * Com'è andata UNA riga del lotto.
 *
 * ⚠️ QUATTRO ESITI E NON TRE, e il quarto è quello che conta: `ignota`. Al 502 di
 * trasporto (`FATTURA_TRASPORTO_IGNOTO`) il numero di fattura È STATO consumato e
 * il documento potrebbe essere partito. Contarla fra le «saltate» direbbe che per
 * quella riga non è successo niente — l'esatto contrario del `role="alert"` che
 * il pannello mostra sotto («non ripremere, verifica sul pannello Aruba») — e chi
 * usa il conteggio delle riuscite per riconciliare i progressivi ne conterebbe
 * una in meno di quelle che potrebbero esistere.
 *
 * ⚠️ A decidere è `numeroInDubbio`, NON `fermaIlLotto` — e fino al 2026-09-07 era
 * `fermaIlLotto`, cioè la domanda sbagliata. «Mi fermo?» è una decisione
 * prudenziale e va bene larga; «il numero è in dubbio?» è un'AFFERMAZIONE che
 * manda l'operatore a cercare un documento sul pannello Aruba. I 503 fermano il
 * lotto e non consumano niente — Aruba non configurata è anzi l'esito più
 * probabile del primo lotto vero — e su quel pannello non ci sarebbe stato niente
 * da trovare.
 */
interface Esito {
  id: string;
  importo: number;
  data: string | null;
  /**
   * ⚠️ `gia` NON è `ok`, e tenerli separati non è pedanteria contabile: `ok`
   * significa «questo documento fiscale è partito ADESSO». Rilanciando un blocco
   * interrotto, contare insieme le due cose direbbe «emesse 15» quando le nuove
   * sono tre — e chi usa quel numero per la quadratura conterebbe dodici documenti
   * mai emessi oggi.
   */
  esito: 'ok' | 'gia' | 'saltata' | 'ignota' | 'non_tentata';
  /** Il progressivo della fattura emessa, quando c'è. */
  numero?: number | null;
  /** Il motivo del rifiuto, già tradotto da `messaggioDaCorpo`. */
  motivo?: string;
}

/** Perché il lotto si è fermato prima della fine. */
interface Fermata {
  tipo: 'trasporto' | 'guasto' | 'interrotto';
  /**
   * C'è un numero di fattura in dubbio? (`numeroInDubbio`, non `fermaIlLotto`.)
   *
   * ⚠️ Decide QUALE testo esce nel `role="alert"`, e i due dicono cose opposte:
   * «Controlla sul pannello Aruba prima di riprovare» ha senso solo se lì c'è
   * qualcosa da trovare. Su un 503 — Aruba non configurata, la prima riga del
   * primo lotto vero — non c'è, e mandarci l'operatore è una caccia al fantasma.
   */
  dubbio: boolean;
  /** La prosa del server: per il trasporto è l'unica cosa che porta il NUMERO. */
  messaggio?: string;
  restanti: number;
}

export function LottoFatturePanel({ userId, selezionate, onChiudi, onDone, onLavoro }: Props) {
  const t = useTranslations('adminContabilita');
  const f = useDateFormat();
  const dataIt = (d?: string | null) => (d ? f.dataBreve(d) : '—');

  const [fase, setFase] = useState<Fase>('selezione');
  const [pronte, setPronte] = useState<Pronta[]>([]);
  const [daCompletare, setDaCompletare] = useState<DaCompletare[]>([]);
  const [esiti, setEsiti] = useState<Esito[]>([]);
  const [fermata, setFermata] = useState<Fermata | null>(null);
  /**
   * `null` = nessun lotto in volo: la live region resta vuota.
   *
   * ⚠️ `attesaMs` E NON UN BOOLEANO, e fino al 2026-09-07 era un booleano: il
   * testo diceva sempre «(~90 s)» mentre `pausaDopo` dopo un rifiuto LOCALE
   * (400/404/409/422) restituisce 5.000 ms. Su un lotto di dodici righe tutte
   * respinte da un gate nostro — lo scenario per cui quella pausa corta esiste —
   * la barra annunciava diciotto minuti a chi ne stava aspettando sessanta
   * secondi, e lo annunciava a uno screen reader.
   *
   * ⚠️ `concluse` È UN CAMPO SUO, e non si ricava da `corrente`: quel numero
   * cambia significato con la fase — durante l'invio è l'indice 1-based della
   * riga IN VOLO (che conclusa non è), durante l'attesa è il conteggio di quelle
   * finite. Una barra che si riempisse su `corrente` direbbe «1 su 3 fatta»
   * mentre la prima è ancora per aria, cioè annuncerebbe un documento fiscale
   * che potrebbe non esistere. È anche il numero che regge la stima.
   */
  const [avanzamento, setAvanzamento] = useState<{ corrente: number; totale: number; attesaMs: number | null; concluse: number } | null>(null);

  /**
   * L'interruzione è un REF e non uno stato, e non è un dettaglio: il ciclo di
   * emissione è una funzione `async` che vive un giro solo — legge il valore
   * catturato alla partenza, e uno `useState` letto lì dentro resterebbe per
   * sempre quello del primo render.
   */
  const stopRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Il modo di svegliare l'attesa PRIMA della sua scadenza (v. `interrompi`). */
  const sbloccaRef = useRef<(() => void) | null>(null);
  const titoloRiepilogoRef = useRef<HTMLParagraphElement | null>(null);

  /** L'attesa fra due emissioni, interrompibile. */
  const attendi = useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        sbloccaRef.current = resolve;
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          sbloccaRef.current = null;
          resolve();
        }, ms);
      }),
    [],
  );

  /**
   * «Interrompi» ferma PRIMA della POST successiva, mai a metà volo: una
   * richiesta già partita ha già consumato il suo numero, e abortirla
   * lascerebbe un documento in dubbio — esattamente il caso che tutto questo
   * codice esiste per non moltiplicare.
   */
  const interrompi = () => {
    stopRef.current = true;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const sblocca = sbloccaRef.current;
    sbloccaRef.current = null;
    if (sblocca) sblocca();
  };

  /**
   * ─── ALLO SMONTAGGIO SI FERMA IL CICLO, NON SOLO IL TIMER ───────────────────
   *
   * ⚠️ Fino al 2026-09-07 qui c'era il solo `clearTimeout`, e NON BASTAVA: il
   * ciclo di `esegui()` è una funzione `async` già in volo, che nel momento dello
   * smontaggio sta tipicamente risolvendo `res.json()`. Cancellare il timer
   * ESISTENTE non la tocca: appena la POST si conclude, il ciclo crea un timer
   * NUOVO — dopo lo smontaggio — e riparte. Misurato: tolte le spunte dopo la
   * prima emissione, le altre due fatture uscivano comunque, una ogni 90 s, senza
   * barra di avanzamento, senza `role="status"`, senza `beforeunload` (rimosso
   * con l'effetto) e **senza riepilogo**: nessuna traccia a schermo di quali
   * documenti fiscali fossero stati emessi.
   *
   * `stopRef.current = true` è ciò che il `while` legge in testa a ogni giro:
   * ferma PRIMA della POST successiva, che è la stessa promessa di «Interrompi».
   * Sbloccare l'attesa in corso serve a non lasciare appesa una promise che
   * nessuno risolverà più.
   */
  useEffect(() => () => {
    stopRef.current = true;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const sblocca = sbloccaRef.current;
    sbloccaRef.current = null;
    if (sblocca) sblocca();
  }, []);

  /**
   * ─── LA SELEZIONE È CONGELATA DAL PRE-VOLO ALLA FINE DEL LOTTO ─────────────
   *
   * Il padre deve sapere che c'è del lavoro in volo: è lui a tenere le caselle di
   * selezione, e finché restano vive questo pannello si può smontare da sotto.
   *
   * ⚠️ VALE ANCHE PER `conferma`, e fino al 2026-09-07 non valeva — era l'unica
   * fase scoperta, e per giunta la sola in cui la lista è GIÀ DECISA e il ciclo
   * non è ancora partito. Il pre-volo misura `selezionate` e ne fa `pronte`;
   * `esegui()` emette da lì. Togliendo una spunta in `conferma` la riga usciva
   * dalla selezione ma NON da `pronte`: il piè di pagina scriveva «2 bonifici
   * selezionati», il pulsante «Emetti ora (3)», e ne partivano tre. Tre documenti
   * fiscali, che si correggono solo con una nota di variazione, per due righe
   * scelte — e nessuna schermata che dichiarasse la divergenza.
   *
   * Si congela invece di riallineare `pronte` perché il pannello di conferma è un
   * SECONDO TEMPO, come i solleciti: lì si legge la causale che uscirà davvero e
   * a chi si intesta, e la lista che si approva dev'essere quella che il pre-volo
   * ha misurato. Cambiare idea si può, e l'uscita è dichiarata a schermo:
   * «Annulla selezione» (che in `conferma` c'è già), poi «Seleziona tutte» e via.
   */
  useEffect(() => {
    const inVolo = fase !== 'selezione' && fase !== 'fine';
    onLavoro(inVolo);
    return () => { if (inVolo) onLavoro(false); };
  }, [fase, onLavoro]);

  /**
   * Chiudere la scheda a lotto in corso significa non sapere più quali fatture
   * siano partite. Il browser ignora il testo che si passa qui — è la richiesta
   * di conferma a contare — ma la richiesta va fatta.
   */
  useEffect(() => {
    if (fase !== 'corso') return;
    const avviso = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', avviso);
    return () => window.removeEventListener('beforeunload', avviso);
  }, [fase]);

  // A lotto finito il fuoco va sull'intestazione del riepilogo: il pulsante che
  // l'utente ha premuto ha cambiato mestiere, e senza questo il fuoco resterebbe
  // su un comando che ora fa un'altra cosa.
  useEffect(() => {
    if (fase === 'fine') titoloRiepilogoRef.current?.focus();
  }, [fase]);

  /** L'anteprima di UNA riga: zero quota Aruba. */
  const anteprimaDi = async (m: MovimentoUi): Promise<{ pronta?: Pronta; daCompletare?: DaCompletare }> => {
    const base = { id: m.id, importo: m.importo, data: m.data_operazione };
    try {
      const res = await fetch(
        `/api/pagamenti/fattura/anteprima?pagamento_id=${m.pagamento_id}&userId=${userId}`,
        { headers: { 'x-user-id': userId } },
      );
      const corpo = await res.json();
      const dati = (corpo as { data?: { causale?: unknown; intestatario?: AnteprimaPerIlLotto } })?.data;
      if (!res.ok || typeof dati?.causale !== 'string' || dati.causale === '') {
        return { daCompletare: { ...base, motivo: messaggioDaCorpo(corpo, t('reconLottoMotivoAnteprima')) } };
      }
      if (!prontaPerIlLotto(dati.intestatario)) {
        return { daCompletare: { ...base, motivo: t('reconLottoMotivoIntestatario') } };
      }
      const quote = (dati.intestatario?.quote ?? []) as { nome?: string | null }[];
      return {
        pronta: {
          ...base,
          pagamentoId: String(m.pagamento_id),
          causale: dati.causale,
          intestatario: quote.map((q) => (q.nome ?? '').trim()).filter(Boolean).join(' · '),
        },
      };
    } catch (err) {
      // Un `catch` che non logga è un bug (AGENTS.md, regola 6). Qui il sintomo a
      // schermo è una riga in più fra le «da completare»: senza questa riga, «non
      // si è potuto calcolare» e «non c'è un intestatario» sarebbero la stessa cosa.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `lotto-fatture-anteprima-fallita: ${nomeErrore(err)}`,
        route: '/admin/pagamenti',
        stato: 0,
      });
      return { daCompletare: { ...base, motivo: t('reconLottoMotivoAnteprima') } };
    }
  };

  /** Il pre-volo: a blocchi di quattro, e senza spendere un colpo di quota. */
  const controlla = async () => {
    stopRef.current = false;
    setFase('controllo');
    setEsiti([]);
    setFermata(null);
    const righe = selezionate.filter((m) => typeof m.pagamento_id === 'string' && m.pagamento_id !== '');
    const ok: Pronta[] = [];
    const ko: DaCompletare[] = [];
    for (let i = 0; i < righe.length; i += BLOCCO_ANTEPRIME) {
      if (stopRef.current) {
        // ⚠️ LE RIGHE NON CONTROLLATE NON SPARISCONO. Uscendo di qui e passando a
        // `conferma` senza versarle da nessuna parte, il pannello mostrava «N
        // pronte» + «M da completare» con N+M MINORE delle righe selezionate, e
        // il piè di pagina continuava a dire «X bonifici selezionati»: la
        // differenza non era spiegata da nessun testo. È l'opposto della promessa
        // che regge tutto il pre-volo — le righe non pronte finiscono in «Da
        // completare» col motivo — e qui il motivo è che il controllo si è fermato.
        for (const m of righe.slice(i)) {
          ko.push({ id: m.id, importo: m.importo, data: m.data_operazione, motivo: t('reconLottoMotivoInterrotto') });
        }
        break;
      }
      const blocco = righe.slice(i, i + BLOCCO_ANTEPRIME);
      const esitiBlocco = await Promise.all(blocco.map(anteprimaDi));
      for (const e of esitiBlocco) {
        if (e.pronta) ok.push(e.pronta);
        if (e.daCompletare) ko.push(e.daCompletare);
      }
    }
    setPronte(ok);
    setDaCompletare(ko);
    // ⚠️ IL SUCCESSO SI LOGGA (AGENTS.md, regola 5): con i soli errori, «nessun
    // log» non distingue «il lotto è andato» da «non è mai partito niente» — ed è
    // l'ambiguità che ha nascosto per mesi il guasto delle email. `warn` e non
    // `info` perché il canale client accetta solo `warn` e `error`
    // (`EventoClient` in `@/lib/logging/client`): non è un allarme, è l'unico
    // livello disponibile per un fatto che va conservato.
    //
    // Solo CONTEGGI: mai la causale (contiene il CF di un minore), mai un nome.
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `lotto-fatture-prevolo: pronte=${ok.length} da_completare=${ko.length}`,
      route: '/admin/pagamenti',
    });
    setFase('conferma');
  };

  /**
   * ─── IL LOTTO VERO: UNA POST PER BLOCCO, NON PER RIGA ───────────────────────
   *
   * ⚠️ FINO AL 2026-09-07 QUI C'ERA UNA POST PER FATTURA, e fra una e l'altra
   * novanta secondi. Non erano gli upload a imporli: era il `signin`. Ogni POST è
   * un'invocazione serverless nuova, quindi ogni fattura si autenticava da capo, e
   * Aruba concede **un accesso al minuto per IP**. Sessanta fatture costavano circa
   * ottantasette minuti di scheda presidiata.
   *
   * Adesso un blocco di `TETTO_BLOCCO` righe parte in una chiamata sola: l'accesso
   * e la lettura del progressivo si fanno una volta per blocco. Sessanta fatture
   * sono quattro blocchi, cioè **circa sei minuti**.
   *
   * ⚠️ COSA SI PERDE, E VA SAPUTO. Con il ciclo sul server, **chiudere questa
   * scheda non ferma più un blocco già partito**: le sue fatture escono comunque,
   * e la traccia resta a registro e nei log invece che sullo schermo.
   * «Interrompi» ferma fra un blocco e l'altro, non a metà — al massimo escono le
   * righe del blocco in volo. È un cambio di promessa, non un dettaglio, ed è il
   * prezzo dei sei minuti.
   *
   * ─── LA CODA, E PERCHÉ NON UN INDICE ───────────────────────────────────────
   * Il server può restituire `fermato: 'budget'` — ha finito il tempo prima di
   * finire il blocco — insieme all'elenco delle righe che non ha tentato. Con un
   * ciclo a indici quelle righe verrebbero saltate. Rimesse in testa alla coda,
   * partono col blocco successivo.
   */
  const esegui = async () => {
    stopRef.current = false;
    setFase('corso');
    const perId = new Map(pronte.map((r) => [r.pagamentoId, r]));
    const coda: Pronta[] = [...pronte];
    const fatti: Esito[] = [];
    const totale = pronte.length;
    let concluse = 0;
    let stop: Fermata | null = null;

    const esitoRiga = (riga: Pronta, esito: Esito['esito'], extra: Partial<Esito> = {}): Esito => ({
      id: riga.id,
      importo: riga.importo,
      data: riga.data,
      esito,
      ...extra,
    });

    while (coda.length > 0) {
      if (stopRef.current) {
        stop = { tipo: 'interrotto', dubbio: false, restanti: coda.length };
        break;
      }
      const blocco = coda.splice(0, TETTO_BLOCCO);
      setAvanzamento({ corrente: concluse + 1, totale, attesaMs: null, concluse });
      const inizio = adesso();
      let stato = 0;
      let corpo: unknown = null;
      try {
        const res = await fetch('/api/pagamenti/fattura/lotto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
          // ⚠️ `causale: null` e MAI il campo assente: `null` TOGLIE la correzione
          // manuale salvata, l'assenza la lascia congelata su ogni pagamento del
          // lotto. Il corpo di ogni riga lo compone il motore, non questa riga.
          body: JSON.stringify({ pagamenti: blocco.map((r) => corpoEmissione(r.pagamentoId)) }),
        });
        stato = res.status;
        corpo = await res.json();
      } catch (err) {
        // ⚠️ `stato = 0` anche se la risposta era arrivata e a rompersi è stato il
        // suo corpo: un esito che non si è potuto leggere è un esito IGNOTO, e su
        // un documento fiscale l'ignoto si tratta come il peggio — ci si ferma.
        // Vale a maggior ragione adesso: un corpo illeggibile può nascondere
        // l'esito di QUINDICI documenti, non di uno.
        stato = 0;
        corpo = null;
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `lotto-fatture-blocco-fallito: ${nomeErrore(err)}`,
          route: '/admin/pagamenti',
          stato: 0,
        });
      }

      const codiceGrezzo = (corpo as { codice?: unknown } | null)?.codice;
      const codice = typeof codiceGrezzo === 'string' ? codiceGrezzo : null;
      const dubbio = numeroInDubbio(stato, codice);
      const riuscita = stato >= 200 && stato < 300 && (corpo as { success?: boolean } | null)?.success === true;

      if (!riuscita) {
        // Il blocco intero non ha un esito leggibile: **tutte** le sue righe
        // ereditano lo stesso verdetto. Dire «saltate» quando il numero è in dubbio
        // sarebbe un'affermazione falsa su quindici documenti fiscali insieme.
        for (const riga of blocco) {
          fatti.push(
            esitoRiga(riga, dubbio ? 'ignota' : 'saltata', {
              motivo: messaggioDaCorpo(corpo, t('reconLottoErroreEmissione')),
            }),
          );
          concluse += 1;
        }
        setEsiti([...fatti]);
        stop = {
          tipo: codice === CODICE_TRASPORTO_IGNOTO ? 'trasporto' : 'guasto',
          dubbio,
          messaggio: messaggioDaCorpo(corpo, t('reconLottoErroreEmissione')),
          restanti: coda.length,
        };
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `lotto-fatture-fermato: emesse=${fatti.filter((e) => e.esito === 'ok').length} non_tentate=${coda.length}`,
          route: '/admin/pagamenti',
          stato,
        });
        break;
      }

      const dati = (corpo as {
        data?: {
          emesse?: { pagamento_id: string; numero?: number }[];
          gia_emesse?: { pagamento_id: string }[];
          fallite?: { pagamento_id: string; messaggio?: string; codice?: string; statoHttp?: number }[];
          restanti?: string[];
          fermato?: 'budget' | 'errore' | null;
        };
      }).data ?? {};

      for (const voce of dati.emesse ?? []) {
        const riga = perId.get(voce.pagamento_id);
        if (riga) { fatti.push(esitoRiga(riga, 'ok', { numero: voce.numero ?? null })); concluse += 1; }
      }
      for (const voce of dati.gia_emesse ?? []) {
        const riga = perId.get(voce.pagamento_id);
        if (riga) { fatti.push(esitoRiga(riga, 'gia')); concluse += 1; }
      }
      let ultimaFallita: { messaggio?: string; codice?: string; statoHttp?: number } | null = null;
      for (const voce of dati.fallite ?? []) {
        const riga = perId.get(voce.pagamento_id);
        if (!riga) continue;
        // Anche dentro un blocco riuscito una riga può avere il numero in dubbio:
        // a deciderlo è il `codice` che il server le ha attaccato, non lo status
        // della POST — che qui è 200 per tutte.
        const dubbioRiga = numeroInDubbio(voce.statoHttp ?? 0, voce.codice ?? null);
        fatti.push(
          esitoRiga(riga, dubbioRiga ? 'ignota' : 'saltata', {
            motivo: voce.messaggio || t('reconLottoErroreEmissione'),
          }),
        );
        concluse += 1;
        ultimaFallita = voce;
      }
      setEsiti([...fatti]);

      // Le righe che il server non ha tentato tornano in TESTA alla coda: un
      // `fermato: 'budget'` non è un guasto, è un blocco che è finito prima del
      // tempo e riprende dal punto in cui si è fermato.
      const restanti = (dati.restanti ?? [])
        .map((id) => perId.get(id))
        .filter((r): r is Pronta => Boolean(r));

      if (dati.fermato === 'errore') {
        coda.length = 0;
        stop = {
          tipo: ultimaFallita?.codice === CODICE_TRASPORTO_IGNOTO ? 'trasporto' : 'guasto',
          dubbio: numeroInDubbio(ultimaFallita?.statoHttp ?? 0, ultimaFallita?.codice ?? null),
          messaggio: ultimaFallita?.messaggio,
          restanti: restanti.length,
        };
        for (const riga of restanti) fatti.push(esitoRiga(riga, 'non_tentata'));
        setEsiti([...fatti]);
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `lotto-fatture-fermato: emesse=${fatti.filter((e) => e.esito === 'ok').length} non_tentate=${restanti.length}`,
          route: '/admin/pagamenti',
          stato,
        });
        break;
      }

      if (restanti.length > 0) {
        // ⚠️ La guardia contro il giro a vuoto: se un blocco non conclude NIENTE e
        // restituisce indietro tutto quello che gli era stato dato, rimetterlo in
        // coda ripeterebbe la stessa richiesta per sempre.
        if (restanti.length >= blocco.length) {
          coda.length = 0;
          stop = { tipo: 'guasto', dubbio: false, messaggio: t('reconLottoErroreEmissione'), restanti: restanti.length };
          for (const riga of restanti) fatti.push(esitoRiga(riga, 'non_tentata'));
          setEsiti([...fatti]);
          break;
        }
        coda.unshift(...restanti);
      }

      if (coda.length > 0) {
        // La durata si calcola PRIMA di annunciarla: la live region deve dire
        // l'attesa vera, non quella tipica. Adesso è l'attesa fra due BLOCCHI, e
        // serve al `signin` del prossimo: uno al minuto per IP.
        // ⚠️ NON `pausaDopo(stato, …)`: qui lo status è 200 anche quando tutte e
        // quindici le righe sono state respinte dai NOSTRI gate, cioè quando ad
        // Aruba non è arrivato niente. Aspettare l'attesa piena lì annuncerebbe
        // minuti a chi ne sta aspettando secondi — e lo annuncerebbe a uno screen
        // reader.
        const pausa = pausaDopoBlocco(
          adesso() - inizio,
          bloccoHaToccatoAruba({ emesse: (dati.emesse ?? []).length, fallite: dati.fallite ?? [] }),
        );
        setAvanzamento({ corrente: concluse, totale, attesaMs: pausa, concluse });
        await attendi(pausa);
      }
    }

    for (const riga of coda) fatti.push(esitoRiga(riga, 'non_tentata'));
    setEsiti(fatti);
    setFermata(stop);
    setAvanzamento(null);
    setFase('fine');
    // La lista e i conteggi sono cambiati: qualche fattura è appena partita.
    onDone();
  };

  const riuscite = esiti.filter((e) => e.esito === 'ok');
  const giaEmesse = esiti.filter((e) => e.esito === 'gia');
  const ignote = esiti.filter((e) => e.esito === 'ignota');
  const saltate = esiti.filter((e) => e.esito === 'saltata');
  const nonTentate = esiti.filter((e) => e.esito === 'non_tentata');

  /**
   * IL PULSANTE PRIMARIO È UNO SOLO, E CAMBIA MESTIERE.
   *
   * ⚠️ Non due bottoni che si alternano e non un bottone disabilitato: un nodo
   * che sparisce, o che si disabilita, butta il fuoco sul `body` — e chi naviga
   * da tastiera si ritrova all'inizio della pagina nel mezzo di un'operazione
   * lunga diciotto minuti.
   */
  const primario: { etichetta: string; azione: () => void } =
    fase === 'selezione'
      ? { etichetta: `${t('reconLottoControlla')} (${selezionate.length})`, azione: () => { void controlla(); } }
      : fase === 'controllo' || fase === 'corso'
        ? { etichetta: t('reconLottoInterrompi'), azione: interrompi }
        : fase === 'conferma' && pronte.length > 0
          ? { etichetta: `${t('reconLottoEmettiOra')} (${pronte.length})`, azione: () => { void esegui(); } }
          : { etichetta: t('reconLottoChiudi'), azione: onChiudi };

  /**
   * ─── QUANTO MANCA, IN MINUTI, DENTRO LA STESSA LIVE REGION ──────────────────
   *
   * Il conto vero è di `stimaRimanenteMs` (modulo puro): qui si traduce, ed è
   * l'unica cosa che questo file deve fare — «da lì escono VERDETTI, non testi».
   *
   * ⚠️ SI AGGIORNA A PASSI, NON CON UN OROLOGIO. La stima si ricalcola quando
   * cambia `avanzamento`, cioè due volte per fattura: un contatore al secondo
   * dentro un `role="status"` sarebbe un annuncio al secondo per uno screen
   * reader, cioè la schermata resa inascoltabile dalla cosa che doveva renderla
   * chiara. Sotto il minuto si dice «meno di un minuto» invece di «circa 0».
   */
  const stimaTesto = (): string => {
    if (!avanzamento) return '';
    const ms = stimaRimanenteMs(avanzamento.concluse, avanzamento.totale, avanzamento.attesaMs);
    if (ms <= 0) return '';
    const minuti = Math.round(ms / 60_000);
    return minuti < 1 ? t('reconLottoStimaBreve') : t('reconLottoStimaMinuti', { minuti });
  };

  const testoAvanzamento = avanzamento
    ? [
        avanzamento.attesaMs !== null
          ? t('reconLottoAvanzamentoAttesa', {
              corrente: avanzamento.corrente,
              totale: avanzamento.totale,
              secondi: Math.round(avanzamento.attesaMs / 1000),
            })
          : t('reconLottoAvanzamentoInvio', { corrente: avanzamento.corrente, totale: avanzamento.totale }),
        stimaTesto(),
      ].filter(Boolean).join(' · ')
    : fase === 'controllo'
      ? t('reconLottoControlloInCorso')
      : '';

  const rigaBreve = (importo: number, data: string | null) => `${formatEuro(importo)} · ${dataIt(data)}`;

  /**
   * UN GRUPPO DI ESITI — la stessa forma per l'elenco che scorre DURANTE il lotto
   * e per il riepilogo finale.
   *
   * Non è una gentilezza estetica: erano due elenchi della stessa cosa, e due
   * elenchi dello stesso fatto sono due posti da cui un giorno diverge. Il motivo
   * non si stampa quando è già quello del `role="alert"` in fondo al riepilogo —
   * stamparlo due volte fa sembrare che i guasti siano due.
   */
  const gruppoEsiti = (titolo: string, classeTitolo: string, righe: Esito[]) =>
    righe.length === 0 ? null : (
      <>
        <p className={classeTitolo}>{titolo}</p>
        <ul className="mt-1 space-y-0.5">
          {righe.map((e) => (
            <li key={e.id} className="font-maven text-xs text-kidville-sub">
              {rigaBreve(e.importo, e.data)}
              {e.esito === 'ok' && e.numero != null ? ` · ${t('reconLottoNumero', { numero: e.numero })}` : ''}
              {e.esito !== 'ok' && e.motivo && e.motivo !== fermata?.messaggio ? ` · ${e.motivo}` : ''}
            </li>
          ))}
        </ul>
      </>
    );

  const TITOLO_OK = 'mt-1 font-maven text-xs font-bold text-kidville-success';
  const TITOLO_ERRORE = 'mt-2 font-maven text-xs font-bold text-kidville-error-strong';
  const TITOLO_NON_TENTATE = 'mt-2 font-maven text-xs font-bold text-kidville-warn-strong';

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-3xl px-3 pb-3">
      <div
        className="max-h-[70vh] overflow-y-auto rounded-card border-[1.5px] border-kidville-green bg-kidville-white p-4 shadow-2xl"
      >
        {/* ── IL PANNELLO DI CONFERMA: si MOSTRA prima di applicare ──────────
            Due tempi, come i solleciti: qui si legge la causale che uscirà
            davvero e a chi si intesta, e solo dopo si preme. */}
        {fase === 'conferma' && (
          <div className="mb-3">
            <p className="font-barlow text-sm font-black uppercase tracking-wide text-kidville-green">
              {t('reconLottoTitoloConferma')}
            </p>
            {pronte.length > 0 ? (
              <>
                <p className="mt-2 font-maven text-xs font-bold text-kidville-ink">
                  {t('reconLottoPronte', { n: pronte.length })}
                </p>
                <ul className="mt-1 space-y-1">
                  {pronte.map((p) => (
                    <li key={p.id} className="rounded-input bg-kidville-cream/50 px-3 py-2">
                      <span className="block font-maven text-sm font-bold text-kidville-ink">
                        {rigaBreve(p.importo, p.data)}
                      </span>
                      {/* ⚠️ LA CAUSALE DELL'ANTEPRIMA, byte per byte. Ricomporla qui
                          vorrebbe dire far approvare un documento e spedirne un
                          altro — e un documento emesso si corregge solo con una
                          nota di variazione. Contiene il CF di un minore: sta a
                          schermo, non nei log. */}
                      <span className="mt-0.5 block font-maven text-xs text-kidville-sub">
                        {t('reconLottoCausale')}: {p.causale}
                      </span>
                      <span className="block font-maven text-xs text-kidville-sub">
                        {t('reconLottoIntestatario')}: {p.intestatario || '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-2 font-maven text-xs text-kidville-warn-strong">{t('reconLottoNessunaPronta')}</p>
            )}

            {/* Le righe non pronte NON spariscono: con un intestatario risolvibile
                su 130, questo è l'elenco per cui la funzione vale la pena. */}
            {daCompletare.length > 0 && (
              <div className="mt-3">
                <p className="font-maven text-xs font-bold text-kidville-warn-strong">
                  {t('reconLottoDaCompletare', { n: daCompletare.length })}
                </p>
                <p className="mt-0.5 font-maven text-[11px] text-kidville-sub">{t('reconLottoDaCompletareSpiega')}</p>
                <ul className="mt-1 space-y-1">
                  {daCompletare.map((d) => (
                    <li key={d.id} className="rounded-input bg-kidville-warn-soft px-3 py-2">
                      <span className="block font-maven text-sm font-bold text-kidville-ink">
                        {rigaBreve(d.importo, d.data)}
                      </span>
                      <span className="mt-0.5 block font-maven text-xs text-kidville-warn-strong">{d.motivo}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* ── IL RIEPILOGO, che NON sparisce quando la lista si ricarica ─────
            È montato sullo stato di questo componente, non sulle righe del
            registro: dopo `onDone()` quelle righe cambiano chip e filtro, e un
            riepilogo che vivesse di loro svanirebbe proprio nel momento in cui
            serve leggerlo. */}
        {fase === 'fine' && (
          <div className="mb-3" data-testid="lotto-riepilogo">
            <p
              ref={titoloRiepilogoRef}
              tabIndex={-1}
              data-testid="lotto-riepilogo-titolo"
              className="font-barlow text-sm font-black uppercase tracking-wide text-kidville-green outline-none"
            >
              {t('reconLottoRiepilogo')}
            </p>
            {gruppoEsiti(t('reconLottoRiuscite', { n: riuscite.length }), TITOLO_OK, riuscite)}
            {/* «Già a registro» sta accanto alle riuscite e NON dentro: rilanciando un
                blocco interrotto, sommarle direbbe che sono partiti oggi documenti
                fiscali partiti ieri. */}
            {gruppoEsiti(t('reconLottoGiaEmesse', { n: giaEmesse.length }), TITOLO_OK, giaEmesse)}

            {/* ── L'ESITO IGNOTO STA DA SOLO, E SOPRA LE SALTATE ────────────────
                Non è una sfumatura delle «saltate»: è la sola riga del riepilogo
                che parla di un numero di fattura già consumato, cioè l'unica per
                cui esiste qualcosa da andare a cercare sul pannello Aruba. Il
                motivo non si ripete — lo stampa già il `role="alert"` in fondo, e
                due volte farebbe sembrare che i guasti siano due (la regola sta
                dentro `gruppoEsiti`, che qui è condiviso con l'elenco in corso). */}
            {gruppoEsiti(t('reconLottoIgnote', { n: ignote.length }), TITOLO_ERRORE, ignote)}
            {gruppoEsiti(t('reconLottoSaltate', { n: saltate.length }), TITOLO_ERRORE, saltate)}
            {gruppoEsiti(t('reconLottoNonTentate', { n: nonTentate.length }), TITOLO_NON_TENTATE, nonTentate)}

            {/* ⚠️ IL TESTO CHE DICE «NON RIPREMERE», e il perché dei 45 minuti.
                Senza, il primo gesto di chiunque davanti a una fattura in dubbio
                è ripremere — e ogni tentativo riazzera per un'ora il TTL del
                secchio di Aruba (nota misurata in `src/lib/aruba/client.ts`). */}
            {fermata && (
              <p role="alert" className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
                {fermata.tipo === 'interrotto'
                  ? t('reconLottoInterrotto', { n: fermata.restanti })
                  : `${fermata.messaggio ?? ''} ${
                      fermata.tipo === 'trasporto'
                        ? t('reconLottoFermatoTrasporto', { n: fermata.restanti })
                        : fermata.dubbio
                          ? t('reconLottoFermatoGuasto', { n: fermata.restanti })
                          : /* Nessun numero consumato: mandare al pannello Aruba
                               sarebbe una caccia al fantasma. Il rimedio è il
                               motivo qui sopra — di solito una configurazione. */
                            t('reconLottoFermatoSenzaNumero', { n: fermata.restanti })
                    }`}
              </p>
            )}
          </div>
        )}

        {/* ── CHE COSA È GIÀ USCITO, MENTRE IL LOTTO GIRA ───────────────────
            MISURATO sullo screenshot del 2026-09-07: le fatture concluse
            comparivano solo nel riepilogo FINALE. Per diciotto minuti l'operatore
            non sapeva se qualcosa fosse andato — e un lotto di documenti fiscali
            è esattamente il posto in cui quel dubbio fa ricaricare la pagina.

            Stessa forma del riepilogo, perché è `gruppoEsiti` a disegnarli tutti e
            due: due elenchi dello stesso fatto con due vestiti sarebbero due
            verità da tenere allineate. «Non tentate» qui non c'è: si sa solo alla
            fine, e prima sarebbe una previsione, non un esito.

            ⚠️ SPARISCE IN `fine`, dove a raccontare resta il riepilogo: lasciarli
            tutti e due vorrebbe dire lo stesso elenco due volte nella stessa
            schermata. */}
        {fase === 'corso' && esiti.length > 0 && (
          <div className="mb-3" data-testid="lotto-in-corso-esiti">
            <p className="font-barlow text-sm font-black uppercase tracking-wide text-kidville-green">
              {t('reconLottoInCorsoTitolo')}
            </p>
            {gruppoEsiti(t('reconLottoRiuscite', { n: riuscite.length }), TITOLO_OK, riuscite)}
            {/* «Già a registro» sta accanto alle riuscite e NON dentro: rilanciando un
                blocco interrotto, sommarle direbbe che sono partiti oggi documenti
                fiscali partiti ieri. */}
            {gruppoEsiti(t('reconLottoGiaEmesse', { n: giaEmesse.length }), TITOLO_OK, giaEmesse)}
            {gruppoEsiti(t('reconLottoIgnote', { n: ignote.length }), TITOLO_ERRORE, ignote)}
            {gruppoEsiti(t('reconLottoSaltate', { n: saltate.length }), TITOLO_ERRORE, saltate)}
          </div>
        )}

        {/* ⚠️ LIVE REGION MONTATA VUOTA E RIEMPITA DOPO — sempre lo stesso nodo.
            Un `role="status"` inserito nel DOM col contenuto già dentro resta muto
            su NVDA e JAWS, che osservano le mutazioni di quelli già presenti. È la
            stessa regola scritta in `FatturaButton.tsx`.

            Il PERCHÉ dell'attesa è nel testo: novanta secondi di silenzio senza
            spiegazione si leggono come un blocco, e chi li legge così ricarica la
            pagina — cioè fa la sola cosa che qui non si deve fare. */}
        <p
          role="status"
          data-testid="lotto-avanzamento"
          className="font-maven text-xs font-bold text-kidville-green"
        >
          {testoAvanzamento}
        </p>

        {/* ── LA BARRA ──────────────────────────────────────────────────────
            Si riempie sulle fatture CONCLUSE, mai su quella in volo: dire «1 su 3
            fatta» mentre la prima è ancora per aria annuncerebbe un documento
            fiscale che potrebbe non esistere.

            ⚠️ `aria-hidden`, e NON `role="progressbar"`: il `role="status"` qui
            sopra dice già «Fattura 2/3», la ragione dell'attesa e quanto manca —
            cioè più di quanto un `aria-valuenow` sappia dire, e lo annuncia da
            solo. Due nodi che raccontano lo stesso avanzamento sono due annunci
            per la stessa cosa. Una delle due, non entrambe.

            I `data-*` non sono decorazione: sono ciò su cui il test misura il
            riempimento, che a occhio nudo in jsdom non esiste. */}
        {avanzamento && (
          <div
            aria-hidden="true"
            data-testid="lotto-barra"
            data-concluse={avanzamento.concluse}
            data-totale={avanzamento.totale}
            className="mt-2 h-1.5 w-full overflow-hidden rounded-pill bg-kidville-neutral-soft"
          >
            <div
              className="h-full rounded-pill bg-kidville-green transition-[width] duration-500"
              style={{ width: `${(avanzamento.concluse / Math.max(1, avanzamento.totale)) * 100}%` }}
            />
          </div>
        )}

        {/* ── IL PIÈ DI PAGINA DICE CIÒ CHE SERVE ALLA FASE IN CUI SI TROVA ──
            MISURATO sullo screenshot del 2026-09-07: «3 bonifici selezionati · Si
            emettono al massimo 12 fatture per volta: il ritmo lo detta Aruba»
            compariva in TUTTE E QUATTRO le fasi, esito finale compreso — dove il
            lotto è finito, non c'è più niente da emettere e quella frase è rumore
            su un riepilogo che si deve leggere.

            · il CONTEGGIO dei selezionati vale finché la selezione è ancora il
              soggetto: si sceglie, si controlla, si conferma. Durante il lotto lo
              dicono la barra e la live region, e alla fine il riepilogo;
            · il TETTO spiega perché non si può spuntare la tredicesima: è una
              regola su un gesto, e vale solo dove quel gesto è ancora possibile.
              Dalla fase `controllo` in poi la selezione è congelata. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {(fase === 'selezione' || fase === 'controllo' || fase === 'conferma') && (
            <span className="font-maven text-xs font-bold text-kidville-ink">
              {t('reconLottoSelezionati', { n: selezionate.length })}
            </span>
          )}
          {fase === 'selezione' && (
            <span className="font-maven text-[11px] text-kidville-sub">{t('reconLottoTetto', { n: TETTO_LOTTO })}</span>
          )}
          {/* ── «3 selezionati» accanto a «Emetti ora (2)»: SI SPIEGA ──────────
              I fatti sono giusti — 3 selezionati, 2 pronte, 1 da completare — e
              proprio per questo la divergenza va detta invece che dedotta: due
              numeri diversi a pochi centimetri, senza una parola che li leghi, si
              leggono come un errore del programma, e chi li legge così non preme.
              Solo quando entrambi i gruppi esistono: se non c'è nessuna pronta il
              pannello lo dice già a lettere sue, e ripeterlo qui sarebbe la stessa
              frase due volte. */}
          {fase === 'conferma' && pronte.length > 0 && daCompletare.length > 0 && (
            <span className="font-maven text-[11px] text-kidville-warn-strong">
              {t('reconLottoSoloLePronte', { n: daCompletare.length })}
            </span>
          )}
          <span className="flex-1" />
          <button type="button" onClick={primario.azione} className={cx(BTN_PRIMARY_AA, 'shrink-0')}>
            {primario.etichetta}
          </button>
          {/* «Annulla selezione» sparisce a lotto in corso: lì l'unica uscita è
              «Interrompi», che ferma prima della POST successiva invece di
              lasciare un ciclo orfano a emettere documenti fiscali. */}
          {(fase === 'selezione' || fase === 'conferma') && (
            <button type="button" onClick={onChiudi} className={cx(BTN_SECONDARY, 'shrink-0')}>
              {t('reconLottoAnnulla')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
