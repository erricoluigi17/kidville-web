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
  TETTO_LOTTO,
  corpoEmissione,
  fermaIlLotto,
  numeroInDubbio,
  pausaDopo,
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
  esito: 'ok' | 'saltata' | 'ignota' | 'non_tentata';
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
   */
  const [avanzamento, setAvanzamento] = useState<{ corrente: number; totale: number; attesaMs: number | null } | null>(null);

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

  /** Il lotto vero: una POST alla volta, col ritmo che detta Aruba. */
  const esegui = async () => {
    stopRef.current = false;
    setFase('corso');
    const lista = pronte;
    const fatti: Esito[] = [];
    let i = 0;
    let stop: Fermata | null = null;

    while (i < lista.length) {
      if (stopRef.current) {
        stop = { tipo: 'interrotto', dubbio: false, restanti: lista.length - i };
        break;
      }
      const riga = lista[i];
      setAvanzamento({ corrente: i + 1, totale: lista.length, attesaMs: null });
      const inizio = adesso();
      let stato = 0;
      let corpo: unknown = null;
      try {
        const res = await fetch('/api/pagamenti/fattura', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
          // ⚠️ `causale: null` e MAI il campo assente: `null` TOGLIE la correzione
          // manuale salvata, l'assenza la lascia congelata su ogni pagamento del
          // lotto. Il corpo lo compone il motore, non questa riga.
          body: JSON.stringify(corpoEmissione(riga.pagamentoId)),
        });
        stato = res.status;
        corpo = await res.json();
      } catch (err) {
        // ⚠️ `stato = 0` anche se la risposta era arrivata e a rompersi è stato il
        // suo corpo: un esito che non si è potuto leggere è un esito IGNOTO, e su
        // un documento fiscale l'ignoto si tratta come il peggio — ci si ferma.
        stato = 0;
        corpo = null;
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `lotto-fatture-emissione-fallita: ${nomeErrore(err)}`,
          route: '/admin/pagamenti',
          stato: 0,
        });
      }

      // Il `codice` dichiarato dal server: è LUI a dire se il numero è in dubbio,
      // non lo status. Letto una volta sola, e riusato per l'esito e per la fermata.
      const codiceGrezzo = (corpo as { codice?: unknown } | null)?.codice;
      const codice = typeof codiceGrezzo === 'string' ? codiceGrezzo : null;
      const dubbio = numeroInDubbio(stato, codice);

      const riuscita = stato >= 200 && stato < 300 && (corpo as { success?: boolean } | null)?.success === true;
      if (riuscita) {
        fatti.push({
          id: riga.id,
          importo: riga.importo,
          data: riga.data,
          esito: 'ok',
          numero: (corpo as { data?: { numero?: number } }).data?.numero ?? null,
        });
      } else {
        fatti.push({
          id: riga.id,
          importo: riga.importo,
          data: riga.data,
          // ⚠️ «Saltata» è un'AFFERMAZIONE: per questa riga non è successo niente.
          // «Ignota» è l'affermazione opposta, ed è altrettanto impegnativa — manda
          // a cercare un documento sul pannello Aruba. A decidere è `numeroInDubbio`
          // e NON `fermaIlLotto`: «mi fermo?» va bene larga, «il numero è in
          // dubbio?» no. Un 503 (Aruba non configurata) ferma il lotto e non
          // consuma niente.
          esito: dubbio ? 'ignota' : 'saltata',
          motivo: messaggioDaCorpo(corpo, t('reconLottoErroreEmissione')),
        });
      }
      setEsiti([...fatti]);

      if (fermaIlLotto(stato)) {
        stop = {
          tipo: codice === CODICE_TRASPORTO_IGNOTO ? 'trasporto' : 'guasto',
          dubbio,
          messaggio: messaggioDaCorpo(corpo, t('reconLottoErroreEmissione')),
          restanti: lista.length - i - 1,
        };
        // Nei log lo STATUS e i conteggi, mai la prosa: quella può echeggiare
        // dati del documento, e `redact` è a lista bianca per una ragione.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `lotto-fatture-fermato: emesse=${fatti.filter((e) => e.esito === 'ok').length} non_tentate=${lista.length - i - 1}`,
          route: '/admin/pagamenti',
          stato,
        });
        i += 1;
        break;
      }

      i += 1;
      if (i < lista.length) {
        // La durata si calcola PRIMA di annunciarla: la live region deve dire
        // l'attesa vera, non quella tipica.
        const pausa = pausaDopo(stato, adesso() - inizio);
        setAvanzamento({ corrente: i, totale: lista.length, attesaMs: pausa });
        await attendi(pausa);
      }
    }

    for (let k = i; k < lista.length; k++) {
      fatti.push({ id: lista[k].id, importo: lista[k].importo, data: lista[k].data, esito: 'non_tentata' });
    }
    setEsiti(fatti);
    setFermata(stop);
    setAvanzamento(null);
    setFase('fine');
    // La lista e i conteggi sono cambiati: qualche fattura è appena partita.
    onDone();
  };

  const riuscite = esiti.filter((e) => e.esito === 'ok');
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

  const testoAvanzamento = avanzamento
    ? avanzamento.attesaMs !== null
      ? t('reconLottoAvanzamentoAttesa', {
          corrente: avanzamento.corrente,
          totale: avanzamento.totale,
          secondi: Math.round(avanzamento.attesaMs / 1000),
        })
      : t('reconLottoAvanzamentoInvio', { corrente: avanzamento.corrente, totale: avanzamento.totale })
    : fase === 'controllo'
      ? t('reconLottoControlloInCorso')
      : '';

  const rigaBreve = (importo: number, data: string | null) => `${formatEuro(importo)} · ${dataIt(data)}`;

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
            <p className="mt-1 font-maven text-xs font-bold text-kidville-success">
              {t('reconLottoRiuscite', { n: riuscite.length })}
            </p>
            <ul className="mt-1 space-y-0.5">
              {riuscite.map((e) => (
                <li key={e.id} className="font-maven text-xs text-kidville-sub">
                  {rigaBreve(e.importo, e.data)}
                  {e.numero != null ? ` · ${t('reconLottoNumero', { numero: e.numero })}` : ''}
                </li>
              ))}
            </ul>

            {/* ── L'ESITO IGNOTO STA DA SOLO, E SOPRA LE SALTATE ────────────────
                Non è una sfumatura delle «saltate»: è la sola riga del riepilogo
                che parla di un numero di fattura già consumato, cioè l'unica per
                cui esiste qualcosa da andare a cercare sul pannello Aruba. Il
                motivo non si ripete — è lo stesso del `role="alert"` in fondo. */}
            {ignote.length > 0 && (
              <>
                <p className="mt-2 font-maven text-xs font-bold text-kidville-error-strong">
                  {t('reconLottoIgnote', { n: ignote.length })}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {ignote.map((e) => (
                    <li key={e.id} className="font-maven text-xs text-kidville-sub">
                      {rigaBreve(e.importo, e.data)}
                      {e.motivo && e.motivo !== fermata?.messaggio ? ` · ${e.motivo}` : ''}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {saltate.length > 0 && (
              <>
                <p className="mt-2 font-maven text-xs font-bold text-kidville-error-strong">
                  {t('reconLottoSaltate', { n: saltate.length })}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {saltate.map((e) => (
                    <li key={e.id} className="font-maven text-xs text-kidville-sub">
                      {rigaBreve(e.importo, e.data)}
                      {/* ⚠️ IL MOTIVO NON SI RIPETE. La riga che ha FERMATO il lotto
                          porta lo stesso testo che sta nel `role="alert"` qui sotto —
                          quello lungo, col numero del documento — e stamparlo due
                          volte nello stesso pannello non aggiunge niente: fa solo
                          sembrare che siano due guasti diversi. */}
                      {e.motivo && e.motivo !== fermata?.messaggio ? ` · ${e.motivo}` : ''}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {nonTentate.length > 0 && (
              <>
                <p className="mt-2 font-maven text-xs font-bold text-kidville-warn-strong">
                  {t('reconLottoNonTentate', { n: nonTentate.length })}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {nonTentate.map((e) => (
                    <li key={e.id} className="font-maven text-xs text-kidville-sub">
                      {rigaBreve(e.importo, e.data)}
                    </li>
                  ))}
                </ul>
              </>
            )}

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

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-maven text-xs font-bold text-kidville-ink">
            {t('reconLottoSelezionati', { n: selezionate.length })}
          </span>
          <span className="font-maven text-[11px] text-kidville-sub">{t('reconLottoTetto', { n: TETTO_LOTTO })}</span>
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
