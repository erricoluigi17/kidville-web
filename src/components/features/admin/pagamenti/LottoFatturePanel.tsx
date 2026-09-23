'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { formatEuro } from '@/lib/format/valuta';
import { cx } from '@/lib/ui/cx';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { logClient, nomeErrore } from '@/lib/logging/client';
// ⚠️ `import type`, e NON un import di valori: `@/lib/fatture-coda/api` tira dentro
// `next/server`, il logger del server e il conteggio orario su Supabase. Un tipo sparisce
// a compilazione e non porta niente nel bundle del browser; un valore li porterebbe tutti.
import type { CorpoAccoda, VoceAccodamento } from '@/lib/fatture-coda/api';
import { CODA_FATTURE_HREF } from '@/components/features/admin/admin-nav-config';
import { BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import type { MovimentoUi } from './riconciliazione-ui';
import {
  TETTO_LOTTO,
  prontaPerIlLotto,
  quoteTutteFatturabili,
  type AnteprimaPerIlLotto,
} from '@/lib/pagamenti/lotto-fatture';
import {
  intestatarioAutomaticoDelLotto,
  propostaBloccataDaiDati,
  CHIAVE_MOTIVO_PROPOSTA,
} from '@/lib/pagamenti/proposta-intestatario';

/**
 * ─── «EMETTI TUTTE»: LA BARRA DI MASSA DELLA RICONCILIAZIONE ────────────────
 *
 * 130 pagamenti saldati aspettano una fattura, e finora si emettevano aprendo
 * 130 popup uno per uno. Questo pannello li mette IN CODA con un gesto solo — ma la
 * parte che lo rende utile invece che dannoso NON è la POST: è il **pre-volo**.
 *
 * ─── PERCHÉ IL PRE-VOLO VIENE PRIMA DI TUTTO ────────────────────────────────
 * Misurato in produzione il 2026-09-04: su 93 pagamenti saldati, 88 rispondevano
 * «Intestatario fattura non impostato» e non emettevano niente. Un «emetti tutte»
 * che partisse alla cieca brucerebbe la quota di Aruba per fallire quasi sempre — e
 * ogni tentativo, anche rifiutato, riazzera per un'ora il secchio dei limiti. Con la
 * coda il costo si sposta ma non sparisce: una voce destinata al rifiuto occupa un
 * posto nel ritmo orario del lavoratore e finisce fra gli «errori» da togliere a mano.
 *
 * `GET /api/pagamenti/fattura/anteprima` **non parla con Aruba**: usa gli stessi
 * `componiCausalePagamento` e `determinaQuoteFatturazione` dell'emissione, tutto
 * in casa. Il pre-volo costa zero quota, e in dieci secondi dice ciò che oggi si
 * scopre aprendo 130 popup. Le righe non pronte NON spariscono: vanno in un
 * secondo elenco col motivo, ed è il valore vero di questa funzione.
 *
 * ─── DAL 2026-09-23 IL LOTTO NON EMETTE: ACCODA ─────────────────────────────
 * Fino al giorno prima, dopo la conferma, questo componente pilotava l'invio da sé:
 * una POST a `/api/pagamenti/fattura/lotto` per blocco da quindici, una pausa di 65 s
 * fra un blocco e l'altro, una barra, una stima, «Interrompi» fra due blocchi — e la
 * scheda doveva restare aperta per tutta la durata (avviso `beforeunload` compreso).
 * Con 500 fatture e un tetto di 50 l'ora sarebbero state dieci ore di PC acceso.
 *
 * Adesso è UNA sola `POST /api/pagamenti/fattura/coda` con le righe confermate, e a
 * inviare è il lavoratore sul server (`src/lib/fatture-coda/giro.ts`), con lo stesso
 * motore blindato del lotto. Il pannello non ha più niente in volo dopo la risposta:
 * niente attese, niente barra, niente avviso alla chiusura della scheda — che adesso
 * è il comportamento giusto, non una perdita. Com'è andata ogni fattura lo dice la
 * pagina «Coda fatture», a cui la schermata finale manda.
 *
 * ─── LE COSE CHE SI MOSTRANO, E QUELLE CHE NON SI LOGGANO ───────────────────
 * A schermo si mostra la causale che uscirà DAVVERO — quella dell'anteprima, mai
 * ricomposta nel browser: far approvare un documento e spedirne un altro si
 * corregge solo con una nota di variazione. Quella causale contiene il codice
 * fiscale di un minore: sta dove sta già oggi (stesso operatore, stessa sede,
 * dietro `assertPagamentoInScope`) e **non entra in nessun log**, né client né
 * server (AGENTS.md, regola 8). Nei log solo conteggi, uuid e status.
 *
 * ─── LO STATO STA NELLA CODA, NON QUI ───────────────────────────────────────
 * Ciò che è stato accodato vive in `fatture_coda` (una voce attiva per pagamento,
 * indice unico parziale): ripremere, o rifare lo stesso lotto domani, non duplica
 * niente — la risposta lo dice in `gia_in_coda`. Per questo un errore di rete sulla
 * POST si può ritentare senza paura, e il testo lo dice.
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
   * «C'è del lavoro in volo»: pre-volo, conferma, o accodamento — cioè tutto ciò
   * che sta fra la prima misura della selezione e la fine.
   *
   * ⚠️ NON È UN DETTAGLIO DI PRESENTAZIONE. Le caselle di selezione vivono nel
   * pannello PADRE, e questo componente è montato su `selezionati.size > 0`:
   * finché il padre non sa che c'è un'operazione in volo, togliere le spunte lo
   * smonta — e con lui il pannello di conferma già misurato o l'esito della POST.
   * Il padre lo usa per BLOCCARE le caselle, che è ciò che impedisce lo smontaggio.
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

/** La route che accoda (nucleo coda fatture, §3). */
const URL_CODA = '/api/pagamenti/fattura/coda';

/**
 * Le fasi del lotto. Il pulsante primario è UNO e cambia mestiere con la fase.
 *
 * `invio` è la sola POST alla coda in volo: dura quanto la verifica di sede delle
 * righe sul server, secondi e non minuti.
 */
type Fase = 'selezione' | 'controllo' | 'conferma' | 'invio' | 'fine';

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
  /**
   * Valorizzati SOLO quando è la proposta del bonifico a sbloccare la riga.
   * `adultId` viaggia fino alla POST; `motivoProposta` è la chiave della frase
   * che spiega perché — la stessa che vede chi emette una fattura per volta.
   * Entrambi assenti = la riga era già emettibile per anagrafica.
   */
  adultId?: string;
  motivoProposta?: keyof typeof CHIAVE_MOTIVO_PROPOSTA;
  /** Il nome che la banca ha scritto come ordinante, per far vedere il confronto. */
  ordinante?: string;
}

/** Una riga che non si può emettere così com'è, col motivo. */
interface DaCompletare {
  id: string;
  importo: number;
  data: string | null;
  motivo: string;
}

/** Com'è andata la POST alla coda, quando ha risposto 2xx. */
interface EsitoAccodamento {
  /** Quante voci NUOVE sono entrate in coda con questo gesto. */
  accodate: number;
  /**
   * Quante il server ha trovato GIÀ in coda (voce attiva sullo stesso pagamento).
   * È il conteggio della risposta, non delle righe riconosciute qui sotto: se un id
   * tornasse in una forma che il pannello non sa ricondurre a una riga, il numero
   * resta vero lo stesso.
   */
  nGiaInCoda: number;
  /** Le righe già in coda che il pannello sa riconoscere, per mostrarle. */
  giaInCoda: Pronta[];
  /**
   * 2xx ma senza un esito leggibile: la route lo fa quando la RPC ha scritto e ha
   * risposto in una forma inattesa (`gruppo_id: ''`). Le voci sono con ogni
   * probabilità in coda, ma «0 fatture messe in coda» sarebbe un'affermazione falsa.
   */
  incerto: boolean;
}

export function LottoFatturePanel({ userId, selezionate, onChiudi, onDone, onLavoro }: Props) {
  const t = useTranslations('adminContabilita');
  const f = useDateFormat();
  const dataIt = (d?: string | null) => (d ? f.dataBreve(d) : '—');

  const [fase, setFase] = useState<Fase>('selezione');
  const [pronte, setPronte] = useState<Pronta[]>([]);
  const [daCompletare, setDaCompletare] = useState<DaCompletare[]>([]);
  const [esito, setEsito] = useState<EsitoAccodamento | null>(null);
  /** Il rifiuto dell'ultima POST alla coda, già tradotto. Si ritenta dalla conferma. */
  const [erroreCoda, setErroreCoda] = useState<string | null>(null);

  /**
   * L'interruzione del PRE-VOLO è un REF e non uno stato: il ciclo delle anteprime è
   * una funzione `async` che vive un giro solo — legge il valore catturato alla
   * partenza, e uno `useState` letto lì dentro resterebbe per sempre quello del
   * primo render.
   */
  const stopRef = useRef(false);
  /** Una POST alla coda è in volo: il secondo click non ne spara una seconda. */
  const inVoloRef = useRef(false);
  const titoloRiepilogoRef = useRef<HTMLParagraphElement | null>(null);

  /** «Interrompi» ferma il pre-volo PRIMA del blocco di anteprime successivo. */
  const interrompi = () => {
    stopRef.current = true;
  };

  /**
   * Allo smontaggio il pre-volo si ferma: il ciclo delle anteprime è una funzione
   * `async` già in volo, e senza questo continuerebbe a chiedere anteprime per un
   * pannello che non c'è più. (La POST alla coda, invece, è una sola: se è partita,
   * la coda l'ha già ricevuta, e il suo esito si legge nella pagina della coda.)
   */
  useEffect(() => () => {
    stopRef.current = true;
  }, []);

  /**
   * ─── LA SELEZIONE È CONGELATA DAL PRE-VOLO ALLA FINE ────────────────────────
   *
   * Il padre deve sapere che c'è del lavoro in volo: è lui a tenere le caselle di
   * selezione, e finché restano vive questo pannello si può smontare da sotto.
   *
   * ⚠️ VALE ANCHE PER `conferma`, e fino al 2026-09-07 non valeva — era l'unica
   * fase scoperta, e per giunta la sola in cui la lista è GIÀ DECISA e la POST non
   * è ancora partita. Il pre-volo misura `selezionate` e ne fa `pronte`; la POST
   * accoda da lì. Togliendo una spunta in `conferma` la riga usciva dalla selezione
   * ma NON da `pronte`: il piè di pagina scriveva «2 bonifici selezionati», il
   * pulsante «(3)», e ne partivano tre — documenti fiscali che si correggono solo con
   * una nota di variazione, per due righe scelte.
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

  // A lotto accodato il fuoco va sull'intestazione del riepilogo: il pulsante che
  // l'utente ha premuto ha cambiato mestiere, e senza questo il fuoco resterebbe
  // su un comando che ora fa un'altra cosa.
  useEffect(() => {
    if (fase === 'fine') titoloRiepilogoRef.current?.focus();
  }, [fase]);

  /**
   * La spunta che copre le righe intestate su PROPOSTA del bonifico.
   *
   * Serve perché quel nome non l'ha scelto nessuno: l'ha riconosciuto un'euristica
   * che confronta l'ordinante coi genitori del bambino — solo uguaglianza e
   * sottoinsieme, mai somiglianza — e una fattura elettronica intestata alla
   * persona sbagliata si corregge unicamente con una nota di variazione.
   *
   * Il pulsante primario NON si disabilita (butterebbe il fuoco sul `body`): senza
   * la spunta semplicemente non parte, sposta il fuoco sulla casella e dice perché.
   */
  const [confermoProposte, setConfermoProposte] = useState(false);
  const spuntaRef = useRef<HTMLInputElement | null>(null);
  const [mancaSpunta, setMancaSpunta] = useState(false);

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
      const proposta = intestatarioAutomaticoDelLotto(dati.intestatario);
      if (!prontaPerIlLotto(dati.intestatario)) {
        // Tre casi diversi collassavano in «manca l'intestatario» — che per una
        // riga RIPARTITA è semplicemente falso: l'intestatario non manca, sono due,
        // ed è voluto. Chi legge deve sapere quale delle tre cose gli è capitata,
        // perché la mossa successiva è diversa in tutti e tre i casi.
        //
        // ⚠️ `propostaBloccataDaiDati`, e NON `quote.some(…)` come faceva fino al
        // 2026-09-08: su un elenco di quote VUOTO `some` risponde `false`, quindi il
        // caso «so chi ha pagato ma gli mancano i dati» cadeva sul messaggio generico
        // proprio quando le quote non c'erano — cioè sulla maggioranza delle righe
        // misurate quel giorno. La diagnosi si compone col motore condiviso invece di
        // riscriversi qui: è la stessa coppia di funzioni che decide l'ingresso.
        //
        // ⚠️ IL RAMO `ripartito` VIENE PRIMA E ASSORBIVA OGNI ALTRA CAUSA. Una riga
        // ripartita con TUTTE le quote fatturabili il lotto la emette (primo ramo di
        // `prontaPerIlLotto`); quindi se una ripartita finisce qui è perché
        // l'anagrafica di un quotista NON basta — e «va emesso uno per volta»
        // mandava l'operatore a emettere per trovarsi «dati fiscali incompleti»,
        // senza che nessuno gli avesse detto quale campo manca.
        const quoteAnt = (dati.intestatario?.quote ?? []) as { fatturabile?: boolean | null }[];
        const motivo = dati.intestatario?.ripartito === true
          ? (quoteAnt.some((q) => q?.fatturabile !== true)
              ? t('reconLottoMotivoRipartitoIncompleto')
              : t('reconLottoMotivoRipartito'))
          : propostaBloccataDaiDati(dati.intestatario)
            ? t('reconLottoMotivoPropostoIncompleto')
            : t('reconLottoMotivoIntestatario');
        return { daCompletare: { ...base, motivo } };
      }
      const quote = (dati.intestatario?.quote ?? []) as { nome?: string | null; fatturabile?: boolean | null }[];
      const perQuote = quote.map((q) => (q.nome ?? '').trim()).filter(Boolean).join(' · ');
      // Se è la proposta ad aver sbloccato la riga, l'intestatario è il proposto —
      // non la concatenazione dei nomi delle quote, che qui direbbe un'altra cosa.
      //
      // ⚠️ `quoteTutteFatturabili` E NON `quote.every(…)` scritto qui: su un elenco
      // VUOTO `every` risponde `true`, quindi `daProposta` diventava `false` e la POST
      // partiva SENZA l'intestatario. La riga entrava nel lotto e veniva respinta dal
      // 422 del server: il rifiuto si spostava dal browser ad Aruba, a quota spesa.
      // La domanda è la stessa di `prontaPerIlLotto`, quindi è la stessa funzione.
      const daProposta = proposta && !quoteTutteFatturabili(quote);
      return {
        pronta: {
          ...base,
          pagamentoId: String(m.pagamento_id),
          causale: dati.causale,
          intestatario: daProposta ? proposta.nome : perQuote,
          ...(daProposta
            ? {
                adultId: proposta.adult_id,
                motivoProposta: proposta.motivo,
                ordinante: (dati.intestatario?.ordinante ?? '').trim(),
              }
            : {}),
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
    setEsito(null);
    setErroreCoda(null);
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
   * ─── L'ACCODAMENTO: UNA POST SOLA, CON LE RIGHE CONFERMATE ──────────────────
   *
   * Il corpo è il contratto di `zCorpoAccoda` (`src/lib/fatture-coda/api.ts`), una
   * voce per riga pronta, nell'ordine del pre-volo — che è l'ordine in cui la coda
   * le manderà dentro il gruppo.
   *
   * ⚠️ `causale: null` e MAI una causale ricomposta qui: il lotto non personalizza la
   * causale, e `null` fa sì che il lavoratore TOLGA la correzione manuale salvata sul
   * pagamento (`fattura_causale` è appiccicoso e batterebbe il modello della sede),
   * esattamente come faceva il lotto a blocchi.
   *
   * ⚠️ `intestatario` + `conferma_proposta: true` viaggiano SOLO sulle righe sbloccate
   * dalla proposta del bonifico, cioè quelle coperte dalla spunta — che a questo punto
   * è già stata messa (`avviaAccodamento` non parte senza). Dimenticare `adultId` qui
   * lascerebbe decidere la cascata del server, cioè fatture intestate a qualcun altro
   * senza che nessuna schermata lo dica. `conferma_proposta` è ciò che autorizza il
   * lavoratore a salvare quel genitore sulla scheda del bambino, come diceva la nota
   * sotto la spunta; sulle altre righe non c'è niente da confermare, e non si manda.
   */
  const accoda = async () => {
    if (inVoloRef.current) return;
    inVoloRef.current = true;
    setErroreCoda(null);
    setFase('invio');

    const voci: VoceAccodamento[] = pronte.map((r) => ({
      pagamento_id: r.pagamentoId,
      causale: null,
      ...(r.adultId
        ? { intestatario: { tipo: 'adult' as const, adult_id: r.adultId }, conferma_proposta: true }
        : {}),
    }));
    const corpo: CorpoAccoda = { voci };

    let stato = 0;
    let risposta: unknown = null;
    try {
      const res = await fetch(URL_CODA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify(corpo),
      });
      stato = res.status;
      risposta = await res.json();
    } catch (err) {
      // ⚠️ `stato = 0` anche se la risposta era arrivata e a rompersi è stato il suo
      // corpo: un esito che non si è potuto leggere NON è un successo. Il testo che
      // esce lo dice («potrebbero non essere entrate») e invita a riprovare, che qui è
      // sicuro: una voce già attiva non si duplica.
      stato = 0;
      risposta = null;
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `lotto-fatture-accodamento-fallito: ${nomeErrore(err)}`,
        route: '/admin/pagamenti',
        stato: 0,
      });
    } finally {
      inVoloRef.current = false;
    }

    if (stato < 200 || stato >= 300) {
      // Il 503 `CODA_FATTURE_NON_DISPONIBILE` (DB non ancora migrato), il 400
      // `PAGAMENTO_NON_SALDATO`, il 403 di sede, il 500 di scrittura: tutti passano da
      // `messaggioDaCorpo`, che traduce il `codice` nella lingua dell'interfaccia. Si
      // torna alla conferma — la lista misurata resta lì, e «Metti in coda» si ripreme.
      setErroreCoda(messaggioDaCorpo(risposta, t('codaFatture.lotto.errore')));
      setFase('conferma');
      return;
    }

    const letta = risposta as { gruppo_id?: unknown; accodate?: unknown; gia_in_coda?: unknown } | null;
    const giaIds = Array.isArray(letta?.gia_in_coda)
      ? letta.gia_in_coda.filter((x): x is string => typeof x === 'string')
      : [];
    const incerto =
      typeof letta?.gruppo_id !== 'string' ||
      letta.gruppo_id === '' ||
      typeof letta.accodate !== 'number' ||
      !Array.isArray(letta.gia_in_coda);
    const accodate = typeof letta?.accodate === 'number' ? letta.accodate : 0;
    // Il confronto è sulla forma minuscola: un uuid che tornasse in maiuscolo dal
    // database resterebbe lo stesso pagamento, e la riga non sparirebbe dall'elenco.
    const gia = new Set(giaIds.map((id) => id.toLowerCase()));
    const giaInCoda = pronte.filter((r) => gia.has(r.pagamentoId.toLowerCase()));

    setEsito({ accodate, nGiaInCoda: giaIds.length, giaInCoda, incerto });
    // Solo CONTEGGI, come il pre-volo: `warn` perché è l'unico livello del canale
    // client che si conserva, e un accodamento riuscito è un fatto da conservare.
    logClient({
      livello: incerto ? 'error' : 'warn',
      evento: 'fetch',
      messaggio: `lotto-fatture-accodate: accodate=${accodate} gia_in_coda=${giaIds.length} incerto=${incerto}`,
      route: '/admin/pagamenti',
      stato,
    });
    setFase('fine');
    onDone();
  };

  // Le righe che l'app ha sbloccato riconoscendo chi ha fatto il bonifico. Vanno
  // in un elenco SEPARATO e intestato: se restassero mescolate alle altre, il
  // numero della spunta non corrisponderebbe a niente che si vede.
  const pronteProposta = pronte.filter((p) => !!p.motivoProposta);
  const pronteAnagrafica = pronte.filter((p) => !p.motivoProposta);
  const serveSpunta = pronteProposta.length > 0;

  /** Si accoda solo se le proposte sono state confermate. */
  const avviaAccodamento = () => {
    if (serveSpunta && !confermoProposte) {
      setMancaSpunta(true);
      spuntaRef.current?.focus();
      return;
    }
    setMancaSpunta(false);
    void accoda();
  };

  /**
   * IL PULSANTE PRIMARIO È UNO SOLO, E CAMBIA MESTIERE.
   *
   * ⚠️ Non due bottoni che si alternano e non un bottone disabilitato: un nodo
   * che sparisce, o che si disabilita, butta il fuoco sul `body` — e chi naviga
   * da tastiera si ritrova all'inizio della pagina. Durante `invio` resta lo stesso
   * comando, dichiarato occupato: un secondo click non fa niente (`inVoloRef`).
   */
  const mettiInCoda = `${t('codaFatture.lotto.mettiInCoda')} (${pronte.length})`;
  const primario: { etichetta: string; azione: () => void } =
    fase === 'selezione'
      ? { etichetta: `${t('reconLottoControlla')} (${selezionate.length})`, azione: () => { void controlla(); } }
      : fase === 'controllo'
        ? { etichetta: t('reconLottoInterrompi'), azione: interrompi }
        : fase === 'invio'
          ? { etichetta: mettiInCoda, azione: () => {} }
          : fase === 'conferma' && pronte.length > 0
            ? { etichetta: mettiInCoda, azione: avviaAccodamento }
            : { etichetta: t('reconLottoChiudi'), azione: onChiudi };

  // ⚠️ La live region dice SOLO ciò che sta succedendo adesso. A cose fatte resta
  // vuota: a raccontare è il riepilogo, su cui va il fuoco — dirlo due volte
  // farebbe sentire due annunci per un fatto solo.
  const testoAvanzamento =
    fase === 'controllo'
      ? t('reconLottoControlloInCorso')
      : fase === 'invio'
        ? t('codaFatture.lotto.invio')
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
                {serveSpunta && (
                  <div className="mt-2 rounded-input border-[1.5px] border-kidville-line bg-kidville-cream/50 px-3 py-2">
                    <label className="flex items-start gap-2 font-maven text-xs text-kidville-ink">
                      <input
                        ref={spuntaRef}
                        type="checkbox"
                        checked={confermoProposte}
                        onChange={(e) => { setConfermoProposte(e.target.checked); if (e.target.checked) setMancaSpunta(false); }}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-kidville-green"
                        // Senza questo, uno screen reader legge «Confermo gli
                        // intestatari proposti dal bonifico» e NON la frase che dice
                        // cosa si sta autorizzando — cioè proprio quella che porta il
                        // consenso a una scrittura sull'anagrafica di un minore.
                        aria-describedby="lotto-conferma-nota"
                      />
                      <span>{t('reconLottoConfermoProposte', { n: pronteProposta.length })}</span>
                    </label>
                    {/*
                      La spunta non autorizza solo dei documenti: a emissione riuscita
                      l'intestatario confermato viene SCRITTO sulla scheda del bambino
                      (se ne era priva) — dal lavoratore della coda, che lo sa dal
                      `conferma_proposta` della voce. È una scrittura sull'anagrafica di
                      un minore — e quella riga non decide solo le fatture: diventa il
                      «CF pagatore» della comunicazione all'Agenzia delle Entrate e
                      l'intestatario dell'attestazione per il 730. Chi mette la spunta
                      autorizza una DETRAZIONE, e deve poterlo leggere qui.
                    */}
                    <p id="lotto-conferma-nota" className="mt-1 pl-6 font-maven text-[11px] text-kidville-sub">
                      {t('reconLottoConfermoProposteHint')}
                    </p>
                    {mancaSpunta && (
                      <p role="alert" className="mt-1 font-maven text-xs text-kidville-error-strong">
                        {t('reconLottoSpuntaMancante')}
                      </p>
                    )}
                  </div>
                )}
                {pronteProposta.length > 0 && (
                  <p className="mt-2 font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-sub">
                    {t('reconLottoGruppoProposta')}
                  </p>
                )}
                <ul className="mt-1 space-y-1">
                  {[...pronteProposta, ...pronteAnagrafica].map((p) => (
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
                      {/* Il PERCHÉ, con le stesse quattro frasi che legge chi emette
                          una fattura per volta: clonarle in chiavi `reconLotto*`
                          vorrebbe dire due spiegazioni della stessa cosa, libere di
                          divergere. */}
                      {p.motivoProposta && (
                        <span className="mt-0.5 block font-maven text-xs text-kidville-green">
                          {t(CHIAVE_MOTIVO_PROPOSTA[p.motivoProposta], { ordinante: p.ordinante ?? '', nome: p.intestatario })}
                        </span>
                      )}
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

            {/* ── IL RIFIUTO DELLA CODA, sopra il pulsante che lo ritenta ────────
                Il 503 «coda non ancora disponibile», un pagamento non saldato, un
                guasto di scrittura: il testo viene dal `codice` della risposta,
                tradotto. La lista misurata resta sotto gli occhi, e ripremere è
                sicuro — una voce già in coda non si duplica. */}
            {erroreCoda && (
              <p
                role="alert"
                data-testid="lotto-errore-coda"
                className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong"
              >
                {erroreCoda}
              </p>
            )}
          </div>
        )}

        {/* ── IL RIEPILOGO, che NON sparisce quando la lista si ricarica ─────
            È montato sullo stato di questo componente, non sulle righe del
            registro: dopo `onDone()` la lista si rilegge, e un riepilogo che
            vivesse di lei svanirebbe proprio nel momento in cui serve leggerlo. */}
        {fase === 'fine' && esito && (
          <div className="mb-3" data-testid="lotto-riepilogo">
            <p
              ref={titoloRiepilogoRef}
              tabIndex={-1}
              data-testid="lotto-riepilogo-titolo"
              className="font-barlow text-sm font-black uppercase tracking-wide text-kidville-green outline-none"
            >
              {t('reconLottoRiepilogo')}
            </p>

            {/* ⚠️ «0 fatture messe in coda» quando le voci ci sono sarebbe il modo
                più rapido di farle rimettere in coda a mano. Con una risposta che
                non si legge si dice che non si legge, e dove guardare. */}
            {esito.incerto ? (
              <p className="mt-2 font-maven text-xs font-bold text-kidville-warn-strong">
                {t('codaFatture.lotto.esitoIncerto')}
              </p>
            ) : (esito.accodate > 0 || esito.nGiaInCoda === 0) && (
              <p data-testid="lotto-messe-in-coda" className="mt-2 font-maven text-xs font-bold text-kidville-success">
                {t('codaFatture.lotto.messeInCoda', { n: esito.accodate })}
              </p>
            )}

            {/* Quelle già in coda si DICONO, e si elencano: senza, «3 selezionate,
                1 messa in coda» si leggerebbe come due fatture perse. Non sono un
                errore — la coda le aveva già, e partiranno (o sono ferme in errore)
                per conto loro: lo stato di ciascuna è nella pagina della coda. */}
            {!esito.incerto && esito.nGiaInCoda > 0 && (
              <>
                <p data-testid="lotto-gia-in-coda" className="mt-2 font-maven text-xs font-bold text-kidville-warn-strong">
                  {t('codaFatture.lotto.giaInCoda', { n: esito.nGiaInCoda })}
                </p>
                {esito.giaInCoda.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {esito.giaInCoda.map((r) => (
                      <li key={r.id} className="font-maven text-xs text-kidville-sub">
                        {rigaBreve(r.importo, r.data)}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            <Link
              href={CODA_FATTURE_HREF}
              className="mt-3 inline-block font-maven text-xs font-bold text-kidville-green underline"
            >
              {t('codaFatture.lotto.vaiAllaCoda')}
            </Link>
          </div>
        )}

        {/* ⚠️ LIVE REGION MONTATA VUOTA E RIEMPITA DOPO — sempre lo stesso nodo.
            Un `role="status"` inserito nel DOM col contenuto già dentro resta muto
            su NVDA e JAWS, che osservano le mutazioni di quelli già presenti. È la
            stessa regola scritta in `FatturaButton.tsx`. */}
        <p
          role="status"
          data-testid="lotto-avanzamento"
          className="font-maven text-xs font-bold text-kidville-green"
        >
          {testoAvanzamento}
        </p>

        {/* ── IL PIÈ DI PAGINA DICE CIÒ CHE SERVE ALLA FASE IN CUI SI TROVA ──
            · il CONTEGGIO dei selezionati vale finché la selezione è ancora il
              soggetto: si sceglie, si controlla, si conferma. Alla fine lo dice
              il riepilogo;
            · il TETTO spiega perché non si può spuntare la cinquecentunesima: è una
              regola su un gesto, e vale solo dove quel gesto è ancora possibile.
              Dalla fase `controllo` in poi la selezione è congelata. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {(fase === 'selezione' || fase === 'controllo' || fase === 'conferma') && (
            <span className="font-maven text-xs font-bold text-kidville-ink">
              {t('reconLottoSelezionati', { n: selezionate.length })}
            </span>
          )}
          {fase === 'selezione' && (
            <span className="font-maven text-[11px] text-kidville-sub">{t('codaFatture.lotto.tetto', { n: TETTO_LOTTO })}</span>
          )}
          {/* ── «3 selezionati» accanto a «Metti in coda (2)»: SI SPIEGA ───────
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
          <button
            type="button"
            onClick={primario.azione}
            aria-busy={fase === 'invio' || undefined}
            className={cx(BTN_PRIMARY_AA, 'shrink-0')}
          >
            {primario.etichetta}
          </button>
          {/* «Annulla selezione» c'è solo dove la selezione è ancora il soggetto:
              durante il pre-volo l'uscita è «Interrompi», durante la POST non c'è
              niente da annullare, e alla fine l'uscita è «Chiudi». */}
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
