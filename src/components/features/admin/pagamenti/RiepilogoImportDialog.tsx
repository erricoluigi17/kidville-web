'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { AlertTriangle, Layers, Loader2, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { MODAL_CARD_QUASI_SCHERMO, MODAL_SHADOW, INPUT, BTN_SECONDARY } from './ui';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * IL RIEPILOGO DELL'IMPORT — che cosa ha chiuso la macchina, e come si disfa.
 *
 * Dopo un import con abbinamenti automatici la segreteria vede l'elenco di ciò
 * che è stato chiuso **senza che nessuno cliccasse**, con il perché di ogni
 * riga, e ha un pulsante che annulla l'intero import in un colpo.
 *
 * ─── LE QUATTRO REGOLE DI QUESTA SCHERMATA ──────────────────────────────────
 *
 * 1. **Si apre solo se c'è qualcosa da vedere.** Un import che non ha chiuso
 *    niente lascia la fascia di oggi, invariata: un modale che si apre a ogni
 *    import diventa un ostacolo da chiudere dodici volte al giorno, e il
 *    tredicesimo lo si chiude senza leggerlo — che è il modo in cui una
 *    schermata di controllo smette di controllare qualcosa.
 *
 * 2. **Resta riapribile.** Il pulsante nella fascia («… chiusi automaticamente —
 *    Vedi e annulla») non scade con la chiusura del popup: finché quell'import è
 *    l'ultimo, ci si può tornare.
 *
 * 3. **Il PERCHÉ sta su ogni riga.** Senza, annullare in blocco è un atto di
 *    fede: l'operatrice vedrebbe dodici righe verdi e un pulsante rosso, e
 *    dovrebbe decidere senza sapere su che cosa la macchina si sia basata. Il
 *    motivo arriva dal server in forma di ENUMERATO (`codice_voce`,
 *    `codice_fiscale`, …) e si traduce qui: sul filo non viaggia mai prosa
 *    italiana, che in interfaccia inglese resterebbe italiana.
 *
 * 4. **La conferma si DIGITA, e si digita il NUMERO.** Non una spunta: una
 *    spunta si clicca di riflesso, e questo è un gesto che storna denaro vero.
 *    Il numero, a differenza di una parola fissa, **cambia da un import
 *    all'altro**: per scriverlo bisogna guardare l'elenco che si sta per
 *    disfare. La grammatica è quella che il repo ha già (`ZonaPericolosaStaff`
 *    fa digitare il COGNOME del bersaglio): campo di testo, confronto
 *    normalizzato, pulsante disabilitato finché non corrisponde. E mai
 *    `confirm()` nativo — vietato nel repo, e dentro la WebView iOS può non
 *    tornare mai, lasciando il pannello bloccato per sempre.
 *
 * ─── LA TAGLIA È QUELLA DEL POPUP DEL MOVIMENTO, E NON PER SIMMETRIA ────────
 *
 * `MODAL_CARD_QUASI_SCHERMO` (~95% dello schermo, tre fasce, **un solo elemento
 * che scorre**) è la card che `MovimentoDialog` ha adottato il 2026-09-19
 * quando si è visto che un banco di lavoro dentro una card da 512px fa scorrere
 * via anche il pulsante «Chiudi». Questa schermata è lo stesso genere di cosa —
 * un elenco da leggere e su cui decidere — e due taglie diverse per la stessa
 * cosa, a due giorni di distanza, sarebbero il difetto che quella revisione ha
 * appena chiuso. `MODAL_CARD` resta ai messaggi brevi.
 *
 * ⚠️ Le tre fasce non sono decorazione: la TESTA porta il conteggio (che è il
 * numero da digitare) e il PIEDE porta i due pulsanti. Dentro un unico blocco
 * che scorre, con duecento righe in mezzo, l'uno e gli altri sarebbero a due
 * schermate di distanza — e la conferma digitata perderebbe il suo senso, che è
 * avere l'elenco sotto gli occhi mentre si scrive il numero.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

const TITLE_ID = 'riepilogo-import-title';

/** L'occhiello di questa schermata: la stessa voce del popup del movimento. */
const OCCHIELLO = 'font-barlow text-[11px] font-extrabold uppercase tracking-[0.08em] text-kidville-green';

/**
 * Il comando distruttivo: rosso pieno, alto 44 (WCAG 2.5.8).
 *
 * Non è `BTN_SECONDARY` con un colore diverso e non sta in `ui.ts`: è l'unico
 * comando di tutta la Contabilità che storni denaro in blocco, e un bottone
 * rosso messo in una libreria condivisa è un bottone rosso che finisce, prima o
 * poi, accanto a una matita in una riga di lista.
 */
const BTN_ROSSO =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-pill bg-kidville-error-strong px-5 py-2.5 font-maven text-sm font-bold text-kidville-white transition-opacity hover:opacity-90 disabled:opacity-40';

/**
 * I motivi come arrivano dal server: ENUMERATI, mai prosa.
 *
 * Gli stessi nomi di `MotivoAbbinamentoUi` (`@/lib/pagamenti/motivo-abbinamento`),
 * ridichiarati qui e non importati: quel modulo importa
 * `@/lib/pagamenti/riconciliazione`, che a sua volta importa `crypto` di Node —
 * trascinarlo in un componente `'use client'` romperebbe `next build`, e il
 * difetto non lo vede né `vitest` né `tsc`. È lo stesso vincolo, misurato, per
 * cui `ZonaPericolosaStaff` riscrive i suoi tre valori invece di importarli.
 */
type MotivoAbbinamento =
  | 'codice_voce'
  | 'codice_fiscale'
  | 'residuo_esatto'
  | 'somma_esatta'
  | 'non_ricostruito';

export interface RigaRiepilogo {
  id: string;
  data_operazione: string;
  importo: number;
  causale: string | null;
  /** «Nome Cognome · descrizione», o `null` (fuori dalle proprie sedi, o non letta). */
  voce: string | null;
  motivi: MotivoAbbinamento[];
  /** Il codice voce riconosciuto in causale (`#K7MXN3P`), o `null`. */
  codice: string | null;
  composita: boolean;
  fuori_perimetro: boolean;
}

interface Riepilogo {
  import_id: string;
  righe: RigaRiepilogo[];
  n: number;
  oltre_tetto: boolean;
  tetto: number;
  annullabile: boolean;
  fuori_perimetro: number;
}

interface Props {
  importId: string;
  userId: string;
  /**
   * Chiusura SENZA annullo, e **dice se l'elenco è stato davvero mostrato**.
   *
   * ⚠️ È il gesto umano da cui parte la notifica alle famiglie, e per questo
   * non è un `onClose` qualunque: la fase automatica NON avvisa nessuno apposta
   * (un avviso mandato non si disfa, e la macchina potrebbe aver sbagliato).
   * L'avviso aspetta che una persona abbia guardato il riepilogo e non l'abbia
   * annullato. Il pannello lo trasforma in una POST a `riepilogo-visto`.
   *
   * 🔴 IL BOOLEANO NON È UN DETTAGLIO, ed è la correzione di un difetto vero.
   * Finché la chiusura era una sola («si è chiuso il popup»), `onChiudi` non
   * distingueva **«ho letto l'elenco e l'ho lasciato stare»** da **«non sono
   * riuscito a leggerlo»** — e le due uscite che non mostrano NIENTE (il guasto
   * di lettura, e l'Escape/sfondo mentre l'elenco è ancora in volo) mandavano
   * comunque gli avvisi «Pagamento registrato» a tutte le famiglie
   * dell'import. Avvisi che nessun annullo riprende: è l'unica cosa
   * irreversibile di tutto questo meccanismo, e partiva proprio quando nessuno
   * aveva guardato. `visto` è `true` solo se a schermo c'era l'elenco.
   */
  onChiudi: (visto: boolean) => void;
  /** Annullo riuscito (anche parziale): il pannello ricarica e mostra l'esito. */
  onAnnullato: (esito: EsitoAnnullo) => void;
}

export interface EsitoAnnullo {
  riaperti: number;
  falliti: { movimento_id: string; stato: number; codice: string }[];
  credito_gia_speso: number;
  incassi_stornati: number;
  transazioni_annullate: number;
  fatture: { movimento_id: string; numeri: string[] }[];
}

/**
 * Che cosa è andato storto, in forma di TIPO — mai di frase.
 *
 *  · `lettura`  — l'elenco non è arrivato: si dice nel CORPO, dove l'elenco
 *    sarebbe stato;
 *  · `annullo`  — lo storno è stato rifiutato: si dice nel PIEDE, accanto al
 *    pulsante che l'ha tentato;
 *  · `non-disponibile` — su questo ambiente la marca non esiste, quindi non
 *    esiste l'elenco. Non è un guasto, ma va detto lo stesso: una lista vuota
 *    si leggerebbe come «non ha chiuso niente», che è un'altra affermazione.
 *
 * Il tipo decide anche DOVE si mostra: così la stessa frase non può comparire
 * due volte nella stessa finestra — un lettore di schermo la leggerebbe due
 * volte, e chi guarda penserebbe a due guasti diversi.
 */
type Guasto =
  | { tipo: 'lettura'; corpo?: unknown }
  | { tipo: 'annullo'; corpo?: unknown }
  | { tipo: 'non-disponibile' };

/** La causale, troncata per la riga: l'intera sta nel popup del movimento. */
const TAGLIO_CAUSALE = 90;

function causaleBreve(c: string | null): string {
  const testo = (c ?? '').trim();
  if (testo === '') return '—';
  return testo.length > TAGLIO_CAUSALE ? `${testo.slice(0, TAGLIO_CAUSALE)}…` : testo;
}

export function RiepilogoImportDialog({ importId, userId, onChiudi, onAnnullato }: Props) {
  const t = useTranslations('adminContabilita');
  const ts = useTranslations('shared');
  const f = useDateFormat();

  const [dati, setDati] = useState<Riepilogo | null>(null);
  const [caricando, setCaricando] = useState(true);
  /**
   * ─── IL GUASTO È UNO STATO STRUTTURATO, NON UNA FRASE GIÀ TRADOTTA ────────
   *
   * 🔴 E NON È UNA PREFERENZA DI STILE: è la correzione di un difetto misurato
   * su questo stesso componente. Con la frase dentro lo stato, `carica` doveva
   * chiamare `t()` per comporla; `t` finiva fra le dipendenze della sua
   * `useCallback`; `useTranslations` ricrea `t` a OGNI render; quindi `carica`
   * cambiava identità a ogni render e l'effetto che la chiama ripartiva ogni
   * volta — una GET dietro l'altra, e ogni risposta azzerava l'errore appena
   * scritto dall'annullo. A schermo si vedeva la cosa peggiore: un rifiuto del
   * server che non compariva MAI.
   *
   * È lo stesso difetto che `RiconciliazionePanel` documenta accanto al proprio
   * stato `guasto` — «1.470 GET in 300 ms, misurati sul banco di prova» — e si
   * chiude allo stesso modo: qui si tiene il TIPO (e il corpo grezzo del
   * rifiuto, quando c'è), la frase la compone il JSX, che si ri-renderizza da
   * sé quando cambia la lingua.
   *
   * `corpo` è il corpo GREZZO della risposta, non un messaggio: `messaggioDaCorpo`
   * è puro e preferisce il codice di catalogo alla prosa italiana del server.
   */
  const [guasto, setGuasto] = useState<Guasto | null>(null);
  const [inCorso, setInCorso] = useState(false);
  const [digitato, setDigitato] = useState('');

  /**
   * Il componente è ancora montato? Le due `fetch` di questa schermata possono
   * tornare dopo che l'operatrice ha chiuso il popup, e uno `setState` su un
   * componente smontato è un avviso di React che nessuno guarda più — ma
   * soprattutto è uno stato scritto su una schermata che non c'è.
   */
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  /**
   * ⚠️ TUTTI I `setState` STANNO NEL `finally`, E NESSUNO PRIMA DEL PRIMO
   * `await`. Non è uno stile: la regola `react-hooks/set-state-in-effect`
   * (react-hooks 7.x, severità *error* in questo repo) considera raggiungibile
   * «sincronicamente» qualunque `setState` che una funzione chiamata
   * dall'effetto possa eseguire prima di cedere il controllo — e un
   * `setCaricando(true)` in cima lo è. Lo stato iniziale è già quello
   * (`caricando: true`, `errore: null`), quindi non si perde niente.
   *
   * L'esito si accumula in una variabile locale e si scrive una volta sola:
   * meno render, e soprattutto nessun momento in cui la schermata mostra «dati
   * vecchi + errore nuovo». Il `catch` c'è e **logga** — un catch muto è un bug,
   * regola 6 — ma non scrive stato: lo scrive il `finally`, che è l'unico punto
   * in cui questa funzione tocca React.
   */
  const carica = useCallback(async () => {
    // ⚠️ NESSUN `t()` QUI DENTRO: è ciò che teneva `t` fra le dipendenze e
    // faceva ripartire l'effetto a ogni render. Vedi il riquadro su `guasto`.
    let esito: { dati: Riepilogo | null; guasto: Guasto | null } = {
      dati: null,
      guasto: { tipo: 'lettura' },
    };
    try {
      const r = await fetch(
        `/api/pagamenti/riconciliazione/annulla-import?import_id=${encodeURIComponent(importId)}`,
        { headers: hdr(userId) },
      );
      const j = await r.json();
      if (!r.ok || !j?.success) {
        esito = { dati: null, guasto: { tipo: 'lettura', corpo: j } };
      } else if (j.disponibile === false || !j.data) {
        // `disponibile: false` non è un guasto: su quell'ambiente la marca non
        // esiste, quindi non esiste nemmeno l'elenco. Si dice, invece di
        // mostrare una lista vuota che si leggerebbe come «non ha chiuso
        // niente» — che è un'altra affermazione, e falsa.
        esito = { dati: null, guasto: { tipo: 'non-disponibile' } };
      } else {
        esito = { dati: j.data as Riepilogo, guasto: null };
      }
    } catch (err) {
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `riepilogo-import-caricamento-fallito: ${nomeErrore(err)}`,
        route: '/admin/pagamenti',
        stato: 0,
      });
    } finally {
      if (vivo.current) {
        setDati(esito.dati);
        setGuasto(esito.guasto);
        setCaricando(false);
      }
    }
  }, [importId, userId]);

  useEffect(() => {
    void carica();
  }, [carica]);

  /**
   * ─── 🔴 L'ELENCO È STATO DAVVERO MOSTRATO? ────────────────────────────────
   *
   * Da questo booleano dipende una cosa che non si disfa: gli avvisi alle
   * famiglie. Tutte e tre le uscite del popup (✕, «Chiudi», Escape/sfondo)
   * passano da `chiudi`, ma **non sono tutte la stessa affermazione**:
   *
   *  · `dati !== null && guasto === null` ⇒ l'elenco era a schermo, e chi ha
   *    chiuso l'ha lasciato stare: è il «ho guardato, va bene così» da cui
   *    partono gli avvisi;
   *  · in CARICAMENTO (`dati === null`) ⇒ non c'era ancora nessuna riga da
   *    guardare. Un Escape in quel mezzo secondo non è un consenso;
   *  · su GUASTO DI LETTURA ⇒ a schermo c'era «Non è stato possibile leggere il
   *    riepilogo», cioè l'esatto contrario di un elenco guardato;
   *  · su GUASTO DELL'ANNULLO ⇒ l'elenco lo si era letto, ma chi guarda aveva
   *    appena chiesto di DISFARLO e il server ha rifiutato. Mandare gli avvisi
   *    di ciò che si stava annullando sarebbe il verso sbagliato: si tace, e il
   *    riepilogo resta riapribile dalla fascia. È il ramo conservativo, ed è
   *    voluto — il costo è un avviso che parte più tardi, non uno che parte per
   *    sbaglio.
   *
   * Il verso in cui si sbaglia è scelto: nel dubbio NON si avvisa. Un avviso
   * mancato si rimedia riaprendo il riepilogo e richiudendolo (la rotta è
   * idempotente); un avviso mandato alle famiglie non si ritira.
   */
  const visto = dati !== null && guasto === null;
  const chiudi = () => onChiudi(visto);

  /**
   * IL NUMERO DIGITATO CORRISPONDE?
   *
   * Si confronta col conteggio che il SERVER ha appena restituito, non con la
   * lunghezza dell'elenco disegnato: sono lo stesso numero (la rotta taglia al
   * tetto prima di rispondere) e restano lo stesso numero solo finché a dirlo è
   * una fonte sola.
   *
   * `trim()` perché una spaziatura incollata non è un errore di valutazione; per
   * il resto il confronto è esatto — un numero non ha maiuscole da normalizzare,
   * e `Number()` accetterebbe `12.0` e `+12`, che qui non si vogliono: chi ha
   * letto «12» scrive «12».
   */
  const atteso = dati ? String(dati.n) : '';
  const numeroOk = atteso !== '' && digitato.trim() === atteso;

  const annulla = async () => {
    if (!dati || !numeroOk) return;
    setInCorso(true);
    setGuasto(null);
    try {
      const r = await fetch('/api/pagamenti/riconciliazione/annulla-import', {
        method: 'POST',
        headers: hdr(userId),
        body: JSON.stringify({ import_id: dati.import_id, conferma: true }),
      });
      const j = await r.json();
      if (!vivo.current) return;
      if (!r.ok || !j?.success) {
        setGuasto({ tipo: 'annullo', corpo: j });
        return;
      }
      onAnnullato(j.data as EsitoAnnullo);
    } catch (err) {
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `riepilogo-import-annullo-fallito: ${nomeErrore(err)}`,
        route: '/admin/pagamenti',
        stato: 0,
      });
      // Errore di RETE: nessun corpo da leggere, quindi nessun codice — la
      // frase sarà quella generica del componente, non la prosa del server.
      if (vivo.current) setGuasto({ tipo: 'annullo' });
    } finally {
      if (vivo.current) setInCorso(false);
    }
  };

  /**
   * LA FRASE DEL GUASTO, composta QUI e non dentro le due funzioni asincrone.
   *
   * È il gemello di `testoGuasto` in `RiconciliazionePanel`, e per la stessa
   * ragione: `t` e `ts` cambiano identità a ogni render, e tenerli fuori dalle
   * `useCallback` è ciò che impedisce all'effetto di ripartire in continuazione.
   * Su un rifiuto si passa da `messaggioDaCorpo`, che è pura: preferisce la
   * frase di CATALOGO del codice dichiarato, poi la prosa del server, e in
   * ultimo il ripiego — che dice che cosa fare, non «errore».
   */
  const testoGuasto =
    guasto === null
      ? null
      : guasto.tipo === 'non-disponibile'
        ? ts('erroreAnnulloImportNonDisponibile')
        : guasto.tipo === 'annullo'
          ? messaggioDaCorpo(guasto.corpo ?? null, t('riepImportErroreAnnullo'))
          : messaggioDaCorpo(guasto.corpo ?? null, t('riepImportErroreLettura'));

  /**
   * Il perché di una riga, in parole.
   *
   * ⚠️ Il codice voce si legge dal CAMPO (`codice`), mai dalla frase: è la
   * stessa disciplina di `codiceDelSuggerimento` in `riconciliazione-ui.ts` —
   * un `motivi.includes('…')` su prosa tradotta diventa muto al primo ritocco
   * del testo, e muto in silenzio.
   */
  const frasePerche = (r: RigaRiepilogo): string => {
    const parti = r.motivi.map((m) => {
      if (m === 'codice_voce') {
        return r.codice ? t('riepImportMotivoCodiceCon', { codice: r.codice }) : t('riepImportMotivoCodice');
      }
      if (m === 'codice_fiscale') return t('riepImportMotivoCf');
      if (m === 'residuo_esatto') return t('riepImportMotivoResiduo');
      if (m === 'somma_esatta') return t('riepImportMotivoSomma');
      return t('riepImportMotivoNonRicostruito');
    });
    return parti.join(' · ');
  };

  const righe = dati?.righe ?? [];

  return (
    <Modal
      open
      /* Escape e sfondo passano di qui — ed è la ragione per cui `chiudi`
         calcola `visto` invece di dire sempre «sì»: quei due percorsi sono
         raggiungibili anche mentre l'elenco è ancora in volo. */
      onClose={chiudi}
      title={t('riepImportTitolo')}
      labelledBy={TITLE_ID}
      /* Come il popup del movimento: al 95% dello schermo la card tocca i bordi,
         e su iPhone sopra c'è il notch e sotto la barra di gesto — cioè proprio
         la ✕ della testa e i pulsanti del piede, che sono le due cose da cui si
         esce. */
      safeArea
      className={cx(MODAL_CARD_QUASI_SCHERMO, 'kv-recon-dialog')}
      style={{ boxShadow: MODAL_SHADOW }}
    >
      {/* ── TESTA FISSA: quanti, e da quale import ─────────────────────────── */}
      <div className="shrink-0 border-b border-kidville-line p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className={OCCHIELLO}>{t('riepImportOcchiello')}</span>
            <h2
              id={TITLE_ID}
              className="mt-1 font-barlow text-2xl font-black uppercase leading-none text-kidville-green"
            >
              {caricando ? t('riepImportCaricamento') : t('riepImportChiusi', { n: dati?.n ?? 0 })}
            </h2>
          </div>
          {/* 44×44 e un nome accessibile DIVERSO da quello del piede: due comandi
              con lo stesso nome nella stessa finestra non si distinguono. */}
          <button
            type="button"
            onClick={chiudi}
            aria-label={t('riepImportChiudiDettaglio')}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-kidville-sub transition-colors hover:bg-kidville-neutral-soft hover:text-kidville-ink"
          >
            <X size={20} />
          </button>
        </div>
        <p className="mt-2 font-maven text-xs text-kidville-sub">{t('riepImportSottotitolo')}</p>
      </div>

      {/* ── IL CORPO: l'unica cosa che scorre ──────────────────────────────
          `min-h-0` non è decorativo: senza, un figlio flex non si comprime sotto
          il proprio contenuto e a scorrere tornerebbe la card intera — cioè il
          difetto che le tre fasce chiudono. */}
      <div data-testid="riepimp-corpo" className="min-h-0 flex-1 overflow-y-auto p-5">
        {caricando && (
          <p role="status" className="flex items-center gap-2 font-maven text-sm text-kidville-sub">
            <Loader2 size={16} className="animate-spin" /> {t('riepImportCaricamento')}
          </p>
        )}

        {/* ⚠️ IL GUASTO SI DICE IN UN POSTO SOLO, e quale dei due dipende da che
            cosa è fallito: qui quando l'elenco non è arrivato (`dati === null`),
            nel piede quando è fallito l'annullo — cioè accanto al pulsante che
            l'ha tentato. Mostrarlo in tutti e due avrebbe messo la stessa frase
            due volte nella stessa finestra: un lettore di schermo la legge due
            volte, e chi guarda pensa a due guasti diversi. */}
        {!caricando && testoGuasto !== null && guasto?.tipo !== 'annullo' && (
          <p role="alert" className="font-maven text-sm text-kidville-error-strong">
            {testoGuasto}
          </p>
        )}

        {!caricando && testoGuasto === null && righe.length === 0 && (
          <p className="font-maven text-sm text-kidville-sub">{t('riepImportVuoto')}</p>
        )}

        {/* ⚠️ NIENTE `overflow-y-auto` QUI DENTRO: un secondo scorrimento
            annidato dentro quello del corpo è la cosa che il lock del popup del
            movimento vieta — si finisce per scorrere la lista credendo di
            scorrere la pagina, e il piede sparisce. */}
        {righe.length > 0 && (
          <ul className="space-y-2">
            {righe.map((r) => (
              <li
                key={r.id}
                className="rounded-card border border-kidville-line bg-kidville-cream px-3 py-2.5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-barlow text-base font-black text-kidville-ink">
                    {formatEuro(r.importo)}
                  </span>
                  <span className="font-maven text-xs text-kidville-sub">
                    {f.dataBreve(r.data_operazione)}
                  </span>
                </div>
                <p className="mt-1 break-words font-maven text-xs text-kidville-sub">
                  {causaleBreve(r.causale)}
                </p>
                <p className="mt-1.5 font-maven text-sm text-kidville-ink">
                  {/* «su quale voce»: senza il nome fuori dalle proprie sedi — il
                      nome di un minore è arricchimento identificante, e il server
                      lo omette. La riga bancaria invece si vede, perché
                      l'estratto conto è uno solo per le tre sedi. */}
                  {r.voce ?? (r.fuori_perimetro ? t('riepImportVoceAltraSede') : t('riepImportVoceIgnota'))}
                  {r.composita && (
                    <span className="ml-1.5 inline-flex items-center gap-1 align-middle font-maven text-[11px] text-kidville-sub">
                      <Layers size={12} /> {t('riepImportComposita')}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 font-maven text-[11px] text-kidville-sub">{frasePerche(r)}</p>
                {r.fuori_perimetro && (
                  <p className="mt-1 font-maven text-[11px] font-bold text-kidville-warn-strong">
                    {t('riepImportFuoriPerimetroRiga')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── PIEDE FISSO: la conferma digitata e i due comandi ───────────────
          Fratello del corpo, non suo discendente: dentro l'area che scorre, con
          duecento righe sopra, «Chiudi» sarebbe in fondo al rotolo. */}
      <div data-testid="riepimp-piede" className="shrink-0 border-t border-kidville-line p-5">
        {dati !== null && !dati.annullabile && dati.n > 0 && (
          /* PERCHÉ IL PULSANTE NON C'È — detto PRIMA di offrirlo, non dopo averlo
             premuto. Sono due motivi diversi e si dicono diversi: righe di sedi
             che non gestisci (annullarle è uno storno su denaro altrui), oppure
             troppe righe per una richiesta sola. */
          <p role="status" className="mb-3 flex items-start gap-2 font-maven text-xs text-kidville-warn-strong">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {dati.oltre_tetto
              ? t('riepImportOltreTetto', { tetto: dati.tetto })
              : t('riepImportFuoriPerimetro', { n: dati.fuori_perimetro })}
          </p>
        )}

        {dati !== null && dati.annullabile && (
          <div className="mb-3 space-y-2">
            {/* ─── CHE COSA SUCCEDE, IN PROSA ────────────────────────────────
                Non «operazione irreversibile», che non dice niente a nessuno: si
                dicono i tre fatti — le righe tornano in coda, gli incassi si
                stornano, i saldi ticket rientrano — e poi il quarto, che è
                l'unico che NON si disfa e va detto per ultimo perché è quello da
                ricordare: le fatture già emesse restano emesse. (Verificato in
                `riapertura-movimento.ts`: la riapertura le LEGGE per avvisare e
                non le tocca — il titolare ha deciso «riapri comunque,
                avvisando», misurato su 167 movimenti su 174 con una fattura
                viva.) */}
            <p className="font-maven text-xs text-kidville-ink">
              {t('riepImportConseguenze', { n: dati.n })}
            </p>
            <p className="font-maven text-xs font-bold text-kidville-ink">
              {t('riepImportFattureRestano')}
            </p>
            <label className="block font-maven text-xs text-kidville-ink" htmlFor="riepimp-conferma">
              {t('riepImportDigitaNumero', { n: dati.n })}
            </label>
            <input
              id="riepimp-conferma"
              type="text"
              /* `inputMode="numeric"` e non `type="number"`: su un campo numerico
                 la rotellina del mouse cambia il valore mentre si scorre l'elenco
                 — cioè proprio mentre si guarda ciò che si sta per disfare. */
              inputMode="numeric"
              autoComplete="off"
              value={digitato}
              onChange={(e) => setDigitato(e.target.value)}
              data-testid="riepimp-conferma"
              className={cx(INPUT, 'max-w-[10rem]')}
            />
          </div>
        )}

        {/* Il guasto dell'ANNULLO, accanto al pulsante che l'ha tentato. Quello
            della lettura sta nel corpo: v. la nota lassù. */}
        {testoGuasto !== null && guasto?.tipo === 'annullo' && (
          <p role="alert" className="mb-3 font-maven text-xs text-kidville-error-strong">
            {testoGuasto}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {dati !== null && dati.annullabile && (
            <button
              type="button"
              disabled={!numeroOk || inCorso}
              onClick={() => void annulla()}
              data-testid="riepimp-annulla"
              className={BTN_ROSSO}
            >
              {inCorso ? <Loader2 size={15} className="animate-spin" /> : null}
              {t('riepImportAnnullaTutti', { n: dati.n })}
            </button>
          )}
          <button
            type="button"
            onClick={chiudi}
            disabled={inCorso}
            data-testid="riepimp-chiudi"
            className={cx(BTN_SECONDARY, 'ml-auto min-h-11')}
          >
            {t('riepImportChiudi')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
