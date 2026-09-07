'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { ChevronRight, Landmark, RefreshCw, Upload } from 'lucide-react';
import { SectionTitle } from '@/components/ui/cockpit';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { ChipFatturazione, MovimentoDialog } from './MovimentoDialog';
import { LottoFatturePanel } from './LottoFatturePanel';
import type { PrecompilaTransazione } from './TransazioniPanel';
import { BTN_PRIMARY_AA } from './ui';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { LIMITE_UPLOAD_BYTE } from '@/lib/upload/limite-piattaforma';
// ⚠️ IL PREDICATO SI IMPORTA DAL MOTORE, non si riscrive qui: «questa riga è da
// fatturare» ha UNA definizione sola, e una copia locale tornerebbe a divergere
// dal chip e dal filtro esattamente come è già successo il 2026-09-06.
import { daFatturareInListaDiLavoro } from '@/lib/pagamenti/fatturazione-riga';
import { TETTO_LOTTO } from '@/lib/pagamenti/lotto-fatture';
import {
  SEMAFORO,
  FILTRI,
  FILTRI_FATTURA,
  chipFatturazione,
  classiChipAltraSede,
  etichettaConteggio,
  numeroPillolaFattura,
  suggerimentoPrincipaleCf,
  riepilogoImport,
  type ConteggiFattura,
  type MovimentoUi,
  type PagamentoApertoUi,
  type EsitoImport,
  type RispostaMovimenti,
  type StatoMovimento,
} from './riconciliazione-ui';

interface Props {
  userId: string;
  scuolaId: string;
  /**
   * Aggancio «Incasso unico» dei bonifici di famiglia (multi-CF): il pannello
   * risolve il pagante comune agli alunni riconosciuti e chiama questo callback
   * (fornito dalla pagina) per aprire il wizard precompilato. Se assente, il
   * bottone nel MovimentoDialog non compare.
   */
  onIncassoUnico?: (pre: PrecompilaTransazione) => void;
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

/**
 * ⚠️ GLI HEADER DI UN UPLOAD: SOLO L'IDENTITÀ, MAI IL `Content-Type`.
 *
 * `hdr()` qui sopra imposta `Content-Type: application/json`. Passarlo insieme a un
 * `FormData` è il modo più rapido di rompere un upload: il browser, vedendo l'header già
 * scritto, NON aggiunge il proprio `boundary=…`, e il server riceve un multipart senza
 * delimitatore — cioè niente. E non si vede: la richiesta parte, il tipo è quello che si è
 * chiesto, e in un test con un mock piatto lo status resta 200.
 *
 * Per questo è una funzione a sé e non un `hdr()` con un flag: due chiamate diverse per due
 * cose diverse, invece di un parametro che un giorno qualcuno dimentica.
 */
const hdrFile = (u: string) => ({ 'x-user-id': u });

/**
 * ⚠️ UNA FASCIA SOLA ⇒ UNO STATO SOLO. I TRE ERRORI NON POSSONO PIÙ DIVERGERE.
 *
 * A schermo il guasto si dice in un posto: il `<p role="alert">` qui sotto. Dietro
 * però ce n'erano TRE, e indipendenti — `error` (l'import dell'estratto conto),
 * `rifiuto` (il server ha risposto e ha detto di no), `erroreRete` (la risposta
 * non è arrivata) — con la fascia che sceglieva `error ?? messaggioRifiuto ??
 * «errore di rete»`. Tre sorgenti, una gerarchia implicita e nessuna regola che le
 * rendesse mutuamente esclusive: ogni ramo doveva ricordarsi di spegnere gli altri
 * DUE, e bastava dimenticarne uno perché la fascia mostrasse la diagnosi sbagliata.
 *
 * È già successo due volte. Il 2026-09-05 fu `rifiuto` a sopravvivere a un errore
 * di rete («cambia il filtro» invece di «riprova fra un attimo») e la correzione
 * aggiunse gli azzeramenti incrociati — ma solo fra quei due. Il 2026-09-06 il
 * collaudo ha misurato il terzo: un 422 sull'import restava appeso a un filtro
 * andato a buon fine e poi COPRIVA la caduta della rete, perché `error` sta in
 * testa alla catena.
 *
 * Qui i tre diventano un valore solo: assegnarne uno cancella l'altro per
 * costruzione, non per disciplina di chi scrive il prossimo ramo. I MESSAGGI
 * VISIBILI non cambiano — `testoGuasto` rende esattamente le stesse tre frasi.
 *
 * La traduzione resta FUORI da `load`, ed è la ragione per cui l'import porta un
 * testo già tradotto e gli altri due no: `t` di next-intl non è garantito stabile
 * fra un render e l'altro, e chiamarlo dentro `load` lo rimetterebbe fra le
 * dipendenze del `useCallback` — 1.470 GET in 300 ms, misurati. L'import invece
 * nasce in un gestore di eventi, dove `t` si può usare senza legare niente.
 */
type Guasto =
  /** L'import dell'estratto conto è fallito: testo già tradotto (nasce in un handler). */
  | { tipo: 'import'; testo: string }
  /** Il server ha RIFIUTATO il GET: si conserva il corpo, la lingua la sceglie il JSX. */
  | { tipo: 'rifiuto'; corpo: { error?: unknown; codice?: unknown } }
  /** La risposta non è arrivata affatto. */
  | { tipo: 'rete' };

/**
 * Il guasto di rete è senza dati, quindi è una COSTANTE e non un oggetto nuovo a
 * ogni giro: due `setGuasto` con lo stesso riferimento non fanno ri-renderizzare
 * (React fa bail-out), esattamente come faceva `setErroreRete(true)` sul flag di
 * prima. Un oggetto letterale qui dentro rimetterebbe in circolo un render per
 * ogni tentativo fallito, cioè il primo anello del ciclo che quel flag chiudeva.
 */
const GUASTO_RETE: Guasto = { tipo: 'rete' };

/** Pill dei filtri (stato e fatturazione): stessa pelle, un solo posto. */
const PILL_FILTRO = 'rounded-pill px-3 py-1.5 font-barlow text-[12px] font-extrabold uppercase tracking-[0.03em] transition-colors';
const PILL_FILTRO_ON = 'bg-kidville-green text-kidville-white';
const PILL_FILTRO_OFF = 'bg-kidville-white text-kidville-sub ring-[1.5px] ring-inset ring-kidville-line hover:ring-kidville-green';

/**
 * IL NUMERO SULLA PILLOLA: eredita l'inchiostro, e si stacca con un filetto.
 *
 * ⚠️ NESSUN COLORE PROPRIO, e non è pigrizia. La pillola cambia pelle quando è
 * premuta (bianco su verde) e la cambia di nuovo in Alto Contrasto: un colore
 * scritto qui sarebbe giusto in uno dei tre stati e sotto AA negli altri due —
 * è la lezione già pagata dai chip di questa stessa schermata. `border-current`
 * e l'inchiostro ereditato sono corretti in tutti e tre per costruzione.
 *
 * ⚠️ E NESSUNA OPACITÀ (`/70`): su un fondo pieno abbassa il contrasto sotto AA.
 * Il filetto basta a dire che il numero non è parte dell'etichetta.
 *
 * `tabular-nums` perché il numero cambia — dopo un'emissione scende — e con le
 * cifre proporzionali l'etichetta accanto ballerebbe a ogni aggiornamento.
 */
const PILL_CONTEGGIO = 'ml-1.5 border-l border-current pl-1.5 tabular-nums';

/**
 * L'OCCHIELLO CHE DICE DI CHE FILTRO SI TRATTA.
 *
 * I due gruppi di pillole hanno la stessa pelle e stanno uno sotto l'altro: a
 * schermo sembravano una fila sola andata a capo, e i due assi si distinguevano
 * per una lettera — «Tutti» (stato) contro «Tutte» (fatturazione). L'unica cosa
 * che diceva quale fosse quale era l'`aria-label` del gruppo: un testo che chi
 * vede non legge mai.
 *
 * È `aria-hidden` di proposito: il gruppo ha già la sua etichetta accessibile,
 * più esplicita di questa, e sentirsi annunciare due volte lo stesso concetto è
 * rumore. Sta FUORI dal `role="group"`, perché non è uno dei filtri.
 */
const OCCHIELLO_FILTRO = 'mb-1.5 block font-barlow text-[11px] font-extrabold uppercase tracking-[0.08em] text-kidville-green';

/**
 * L'id della descrizione del gruppo «Fatturazione»: sta in una costante e non
 * scritto due volte, perché un `aria-describedby` che punta a un id inesistente
 * NON è un errore per nessuno — non per React, non per `tsc`, non per il
 * browser: è semplicemente una descrizione che non viene letta. Il guasto è
 * muto, e un guasto muto sull'accessibilità non lo vede nessuno per mesi.
 */
const ID_ASIMMETRIA = 'recon-conteggi-asimmetria';

/**
 * Vista Riconciliazione bancaria — lista a SEMAFORO del registro cumulativo.
 * Import dell'estratto conto (.xls/.xlsx/.csv), poi ogni movimento è una riga colorata per stato
 * (verde=confermato · giallo=suggerito · rosso=da abbinare · grigio=ignorato):
 * cliccando si apre il popup centrale (MovimentoDialog) con suggerimenti, ricerca
 * manuale, conferma/ignora/riapri e — a saldo avvenuto — ricevuta/fattura.
 */
export function RiconciliazionePanel({ userId, scuolaId, onIncassoUnico }: Props) {
  const t = useTranslations('adminContabilita');
  const f = useDateFormat();
  // Data breve localizzata (IT identica a `toLocaleDateString('it-IT')`); '—' se assente.
  const dataIt = (d?: string | null) => (d ? f.dataBreve(d) : '—');
  const [movimenti, setMovimenti] = useState<MovimentoUi[]>([]);
  const [aperti, setAperti] = useState<PagamentoApertoUi[]>([]);
  const [disponibile, setDisponibile] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [esito, setEsito] = useState<EsitoImport | null>(null);
  /**
   * IL GUASTO IN CORSO — uno solo, di uno dei tre tipi (v. `Guasto` qui sopra).
   *
   * Il tipo `rete` è un caso senza testo e il tipo `rifiuto` conserva il CORPO
   * grezzo invece della frase già tradotta: `messaggioDaCorpo` vuole un `fallback`
   * tradotto, e chiamare `t` dentro `load` lo rimetterebbe fra le dipendenze del
   * `useCallback` — **1.470 GET in 300 ms**, misurati sul banco di prova, dove
   * `useTranslations` ricrea `t` a ogni render. La lingua la sceglie il JSX, che
   * si ri-renderizza da sé.
   *
   * Fino al 2026-09-05 un `success: false` non alzava NIENTE: né messaggio né log.
   * Un 400 sul sottofiltro — cioè un filtro che non ha filtrato — si vedeva come
   * una lista qualunque.
   */
  const [guasto, setGuasto] = useState<Guasto | null>(null);
  /**
   * Il server sa dire se la fatturazione è filtrabile, e quando non lo è manda
   * le righe NON filtrate (`fatturazione_disponibile: false`). Senza questo
   * campo il degrado arrivava come una lista vuota, e la schermata scriveva
   * «Nessun movimento in questo stato»: cioè «non c'è niente da fatturare».
   */
  const [fatturazioneDisponibile, setFatturazioneDisponibile] = useState(true);
  /** La finestra del server era piena: ci sono altre righe oltre a queste. */
  const [troncato, setTroncato] = useState(false);
  /**
   * I DUE NUMERI DELLE PILLOLE — `null` finché non si sanno, e `null` anche dopo,
   * se il server non ha potuto contarli.
   *
   * ⚠️ NON è uno `0` di partenza, e la differenza è tutto il punto: uno zero su
   * una pillola è un'AFFERMAZIONE («non ne resta nessuna da fare») ed è la stessa
   * bugia di «Nessun movimento in questo stato», detta dalla schermata che esiste
   * per non far saltare una fattura. Finché non si sa, non si scrive niente.
   */
  const [conteggi, setConteggi] = useState<ConteggiFattura | null>(null);
  /**
   * IL CONTATORE CHE DECIDE QUANDO RICONTARE — ed è deliberatamente sordo ai
   * filtri.
   *
   * I numeri rispondono a «quante ne restano in tutto», non a «quante ce n'è in
   * ciò che sto guardando»: se il conteggio dipendesse dalla pillola premuta,
   * premere «Da fatturare» cambierebbe il numero scritto SOPRA «Da fatturare» —
   * un contatore che si sposta mentre lo si guarda. Cambia solo quando cambia il
   * mondo: primo montaggio, «Aggiorna», import riuscito, e la chiusura del popup
   * dopo un'azione (`onDone`) — che è il momento in cui una fattura è appena
   * partita e il numero DEVE scendere.
   */
  const [generazione, setGenerazione] = useState(0);
  const [filtro, setFiltro] = useState<'' | StatoMovimento>('');
  // Sottofiltro «Fatturazione»: si compone col filtro per stato e vale solo sui
  // confermati (gli unici su cui la fatturazione esista).
  const [fattura, setFattura] = useState<'' | 'da_fatturare' | 'fatturate'>('');
  const [selezionato, setSelezionato] = useState<MovimentoUi | null>(null);
  /**
   * LE RIGHE SPUNTATE PER IL LOTTO DI FATTURE — per `movimento.id`, come i
   * solleciti (`SollecitiPanel`, ~righe 74-86).
   *
   * ⚠️ NON si svuota da sola quando la lista si ricarica: dopo un lotto le righe
   * emesse cambiano chip e possono uscire dal filtro, e un riepilogo che vivesse
   * della selezione svanirebbe nel momento in cui serve leggerlo. Lo svuota
   * l'operatore, premendo «Chiudi» o «Annulla selezione».
   */
  const [selezionati, setSelezionati] = useState<Set<string>>(new Set());

  /**
   * ─── C'È UN CICLO IN VOLO: LE CASELLE SI BLOCCANO ──────────────────────────
   *
   * La barra del lotto è montata su `selezionati.size > 0`, quindi togliere le
   * spunte a lotto in corso la SMONTA — e il ciclo di emissione, che è una
   * funzione `async` già partita, continuerebbe a emettere fatture vere senza
   * barra di avanzamento, senza `role="status"` e senza riepilogo: nessuna traccia
   * a schermo di quali documenti fiscali siano usciti. Misurato il 2026-09-07: tre
   * righe selezionate, spunte tolte dopo la prima POST, e le altre due partivano
   * comunque, una ogni 90 s.
   *
   * Il pannello del lotto lo dichiara con `onLavoro`; qui le caselle diventano
   * `disabled` finché dura. È il gemello del pulsante «Annulla selezione», che a
   * lotto in corso già spariva: l'unica uscita è «Interrompi», che ferma prima
   * della POST successiva invece di lasciare un ciclo orfano.
   */
  const [lottoInVolo, setLottoInVolo] = useState(false);

  /**
   * L'ultima generazione per cui è partito un conteggio: serve a buttare via la
   * risposta di una richiesta SORPASSATA. Due «Aggiorna» ravvicinati fanno partire
   * due conteggi, e niente garantisce che tornino nell'ordine in cui sono partiti:
   * senza questa guardia il numero vecchio potrebbe atterrare per ultimo e restare
   * a schermo — un contatore fermo su un valore che non è più vero.
   */
  const generazioneVista = useRef(0);

  // Ref alla riga cliccata: ripristino del focus alla chiusura del dialog (WCAG 2.4.3).
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Import estratto conto: il trigger è un <button> (A1) che aziona via ref l'input file, così
  // il controllo resta raggiungibile e attivabile da tastiera (Tab + Invio/Spazio).
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Loader: setState SOLO dopo il primo await (mai sincrono nell'effetto → evita
  // react-hooks/set-state-in-effect). Il registro è cumulativo/globale; i filtri
  // passano al GET come `?stato=`. La fonte dei pagamenti aperti è quella usata
  // anche dalla ricerca manuale del dialog.
  const load = useCallback(async () => {
    // try/FINALLY (mai try/catch): un catch sarebbe sincronamente raggiungibile
    // nell'effetto e violerebbe react-hooks/set-state-in-effect. Gli errori di
    // rete li assorbe (e LOGGA) il `.catch` di ogni fetch, restituendo null.
    const onErr = (err: unknown): null => {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `riconciliazione-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      return null;
    };
    try {
      const statoQ = filtro ? `&stato=${filtro}` : '';
      const fatturaQ = fattura ? `&fattura=${fattura}` : '';
      const [movRes, apRes] = await Promise.all([
        // ⚠️ LO STATO HTTP NON SI BUTTA VIA. Con `.then((r) => r.json())` il numero
        // che distingue un 400 (filtro sbagliato) da un 500 (server rotto) spariva
        // prima di poter essere né mostrato né loggato.
        fetch(`/api/pagamenti/riconciliazione?userId=${userId}${statoQ}${fatturaQ}`, { headers: hdr(userId) })
          .then(async (r) => ({ stato: r.status, corpo: (await r.json()) as RispostaMovimenti }))
          .catch(onErr),
        fetch(`/api/pagamenti?userId=${userId}&scuola_id=${scuolaId}&solo_aperti=true`, { headers: hdr(userId) }).then((r) => r.json()).catch(onErr),
      ]);
      if (movRes?.corpo?.success) {
        setMovimenti((movRes.corpo.data ?? []) as MovimentoUi[]);
        setDisponibile(movRes.corpo.disponibile !== false);
        // Assente = disponibile: una risposta che non parla di fatturazione non è
        // una risposta che l'ha persa (rotte vecchie, cache, ramo «schema assente»).
        setFatturazioneDisponibile(movRes.corpo.fatturazione_disponibile !== false);
        setTroncato(movRes.corpo.troncato === true);
        // ⚠️ IL CARICAMENTO RIUSCITO SPEGNE LA FASCIA, QUALUNQUE COSA DICESSE —
        // COMPRESO L'ERRORE DELL'IMPORT.
        //
        // Era l'unico dei tre a sopravvivere qui, e siccome stava in testa alla
        // catena della fascia (`error ?? …`) copriva tutto ciò che veniva dopo:
        // misurato in collaudo, un 422 sull'import restava appeso a un cambio di
        // filtro andato a buon fine e poi mostrava «Colonne non riconosciute nel
        // file» mentre era caduta la rete. Adesso non è un azzeramento in più da
        // ricordarsi: lo stato è UNO, e assegnarlo cancella il precedente.
        setGuasto(null);
      } else if (movRes === null) {
        // La risposta non è arrivata affatto: `GUASTO_RETE` è una costante, quindi
        // due tentativi falliti di fila non producono un render (v. la sua nota).
        setGuasto(GUASTO_RETE);
      } else {
        // Il server ha RIFIUTATO. Prima del 2026-09-05 non succedeva niente:
        // nessun messaggio, nessun log, e l'operatore restava davanti a una lista
        // che sembrava filtrata. Il corpo si conserva per il testo, lo `stato` va
        // nel log — è un numero, passa la lista bianca di `redact`.
        setGuasto({ tipo: 'rifiuto', corpo: (movRes.corpo ?? {}) as { error?: unknown; codice?: unknown } });
        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'riconciliazione-movimenti-rifiutati', route: '/admin/pagamenti', stato: movRes.stato });
      }
      if (apRes?.success) {
        setAperti(((apRes.data ?? []) as PagamentoApertoUi[]).filter((p) => p.tipo !== 'padre'));
      }
    } finally {
      setLoading(false);
    }
  }, [userId, scuolaId, filtro, fattura]);

  useEffect(() => { load(); }, [load]);

  /**
   * ─── IL CONTEGGIO È UNA RICHIESTA SUA, E LA CHIAVE NON È IL FILTRO ──────────
   *
   * `?conteggi=1` non porta a casa nessuna riga: il server conta i due bidoni con
   * lo STESSO motore del filtro e risponde due interi. Sta fuori da `load` per una
   * ragione sola, e non è il risparmio di banda: le dipendenze di `load` sono
   * `[userId, scuolaId, filtro, fattura]`, quindi un conteggio agganciato lì
   * ripartirebbe a ogni pillola premuta — e il numero scritto SOPRA «Da fatturare»
   * cambierebbe nel momento in cui si preme «Da fatturare». Le due domande sono
   * diverse: «che cosa sto guardando» e «quante ne restano in tutto».
   *
   * ⚠️ `t` NON entra qui dentro, come non entra in `load`: `useTranslations` non
   * garantisce un `t` stabile fra un render e l'altro, e metterlo fra le dipendenze
   * di un `useCallback` chiamato da un effetto chiude il ciclo effetto → fetch →
   * render → nuovo `t` → nuovo callback → effetto. Misurato una volta su questo
   * componente: **1.470 GET in 300 ms** di quiete assoluta. Qui non serve: non c'è
   * nessun testo da comporre, solo due numeri da riporre.
   *
   * Il degrado è `null` in tutti e tre i modi in cui può andar male (rete caduta,
   * server che rifiuta, campo assente perché la lettura di fatturazione è caduta) —
   * e `null` a schermo è NIENTE, mai uno zero.
   */
  const caricaConteggi = useCallback(async (gen: number) => {
    generazioneVista.current = gen;
    const esito = await fetch(`/api/pagamenti/riconciliazione?userId=${userId}&conteggi=1`, { headers: hdr(userId) })
      .then(async (r) => ({ stato: r.status, corpo: (await r.json()) as RispostaMovimenti }))
      .catch((err): null => {
        // Un catch che non logga è un bug: qui il sintomo a schermo è l'ASSENZA di
        // un numero, cioè la cosa più silenziosa che questa schermata possa fare.
        logClient({ livello: 'error', evento: 'fetch', messaggio: `riconciliazione-conteggi-falliti: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        return null;
      });
    // Una generazione più recente è già partita: questa risposta è una fotografia
    // vecchia, e scriverla lascerebbe a schermo un numero che non è più vero.
    if (generazioneVista.current !== gen) return;
    if (esito !== null && esito.corpo?.success !== true) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: 'riconciliazione-conteggi-rifiutati', route: '/admin/pagamenti', stato: esito.stato });
    }
    setConteggi(esito?.corpo?.success === true ? esito.corpo.conteggi ?? null : null);
  }, [userId]);

  // `generazione` è letta QUI e passata come argomento: è la chiave del ricalcolo
  // (montaggio · «Aggiorna» · import riuscito · `onDone` del popup) e insieme il
  // biglietto con cui la risposta si fa riconoscere quando torna.
  useEffect(() => { void caricaConteggi(generazione); }, [caricaConteggi, generazione]);

  /** Il mondo è cambiato: i due numeri vanno riletti (mai al cambio di un filtro). */
  const riconta = () => setGenerazione((g) => g + 1);

  /**
   * Cambio del filtro per STATO. Se il nuovo stato non è «confermato», il
   * sottofiltro di fatturazione si azzera: «suggeriti da fatturare» non esiste —
   * la fatturazione vive solo sui confermati — e un filtro che non trova mai
   * niente si legge come un guasto del prodotto, non come una scelta.
   * I due `setState` stanno nello stesso gestore: React li accorpa in un render
   * solo, quindi il GET riparte UNA volta (nessun refetch doppio).
   */
  const cambiaFiltro = (id: '' | StatoMovimento) => {
    if (id === filtro) return;
    setLoading(true);
    setFiltro(id);
    if (id !== 'confermato') setFattura('');
  };

  /**
   * Cambio del sottofiltro FATTURAZIONE. Sceglierne uno forza `stato=confermato`
   * nel GET (e accende la pill corrispondente: la lista mostra davvero quelli).
   * «Tutte» toglie solo il parametro e lascia lo stato dov'è.
   */
  const cambiaFattura = (id: '' | 'da_fatturare' | 'fatturate') => {
    if (id === fattura) return;
    setLoading(true);
    setFattura(id);
    if (id) setFiltro('confermato');
  };

  /**
   * Il file della banca parte COM'È: `.xls`, `.xlsx` o `.csv`, in multipart.
   *
   * Prima c'era `await file.text()` e un JSON: il `.xls` vero è un binario BIFF8 da 2,1 MB,
   * letto come testo diventava spazzatura, e in JSON (o peggio in base64, 2,91 MB) sfondava
   * il tetto di 4 MB della piattaforma. Il file non si legge più qui: lo legge il server.
   */
  const upload = async (file: File) => {
    // ⚠️ La guardia sta PRIMA della partenza, e non è un doppione di quella del server:
    // oltre il tetto di piattaforma la risposta non è nostra — è un 413 di Vercel in
    // `text/plain`, senza JSON da leggere — quindi il messaggio dovrebbe uscire da qui
    // comunque. Meglio non partire affatto.
    if (file.size > LIMITE_UPLOAD_BYTE) {
      setEsito(null);
      setGuasto({ tipo: 'import', testo: t('reconFileTroppoGrande') });
      return;
    }
    setBusy(true);
    setGuasto(null);
    setEsito(null);
    try {
      const corpo = new FormData();
      corpo.append('file', file);
      corpo.append('scuola_id', scuolaId);
      const r = await fetch('/api/pagamenti/riconciliazione', {
        method: 'POST',
        // ⚠️ `hdrFile`, MAI `hdr`: con un `Content-Type` scritto a mano il browser non
        // aggiunge il boundary e il multipart arriva illeggibile. Vedi la nota su `hdrFile`.
        headers: hdrFile(userId),
        body: corpo,
      });
      const j = await r.json();
      if (!r.ok || !j.success) { setGuasto({ tipo: 'import', testo: messaggioDaCorpo(j, t('reconErroreImport')) }); return; }
      setEsito(j.data as EsitoImport);
      await load();
      // L'import porta righe nuove: quante ne restino da fatturare è cambiato.
      riconta();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `riconciliazione-import-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setGuasto({ tipo: 'import', testo: t('reconErroreLetturaFile') });
    } finally {
      setBusy(false);
    }
  };

  // Bonifico di famiglia (multi-CF): risolve il pagante COMUNE agli alunni
  // riconosciuti per CF e apre il wizard «Incasso unico» precompilato. Se il ponte
  // non risolve un pagante (parent null) si apre comunque, allo step «scegli
  // pagante», con riferimento e totale già impostati (degradazione graziosa).
  const gestisciIncassoUnico = useCallback(async (m: MovimentoUi) => {
    const alunni = [...new Set(
      (m.suggerimenti ?? [])
        .filter((s) => s.cf_match && s.alunno_id)
        .map((s) => s.alunno_id as string),
    )];
    const rif = (m.causale?.trim() || m.controparte?.trim() || '') || null;
    let parent: string | null = null;
    if (alunni.length > 0) {
      try {
        const r = await fetch(`/api/pagamenti/pagante-comune?alunni=${alunni.join(',')}`, { headers: hdr(userId) });
        const j = await r.json();
        if (r.ok && j?.success) parent = (j.data?.parent_id as string | null) ?? null;
      } catch (err) {
        // Ponte non raggiungibile: si apre comunque «scegli pagante» (parent null).
        logClient({ livello: 'error', evento: 'fetch', messaggio: `riconciliazione-pagante-comune-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      }
    }
    onIncassoUnico?.({ parent, rif, tot: m.importo, alunni });
    setSelezionato(null);
  }, [userId, onIncassoUnico]);

  /**
   * IL TESTO DELLA FASCIA, tradotto qui e non dentro `load` (vedi `guasto`).
   *
   * Le tre frasi sono le stesse di prima, una per tipo: l'unificazione dello stato
   * non doveva cambiare una parola di ciò che l'operatore legge — solo impedire che
   * due di quelle frasi esistano insieme. Su un rifiuto, `messaggioDaCorpo` è pura:
   * preferisce il codice di catalogo, poi la prosa del server, e in ultimo il
   * ripiego — che dice cosa fare, non «errore».
   */
  const testoGuasto = guasto === null
    ? null
    : guasto.tipo === 'import'
      ? guasto.testo
      : guasto.tipo === 'rifiuto'
        ? messaggioDaCorpo(guasto.corpo, t('reconErroreFiltro'))
        : t('reconErroreReteMovimenti');
  /**
   * IL NUMERO DETTO IN PAROLE, per chi la pillola la SENTE e non la vede.
   *
   * Quattro chiavi e non due composte a pezzi: «Almeno» + un plurale è una frase
   * intera in italiano e un'altra in inglese, e spezzarla in due `t()` concatenati
   * è il modo classico di ottenere una traduzione che in una delle due lingue non
   * sta in piedi. Le quattro sono anche letterali dentro `t('…')`, che è la forma
   * con cui il lock delle chiavi orfane le vede
   * (`__tests__/pagamenti/riconciliazione-ui.test.ts`): una chiave costruita a
   * runtime non la troverebbe, e una chiave mancante non esplode — scrive il
   * proprio NOME a schermo.
   *
   * Sta fuori da ogni `useCallback`: è pura resa, chiamata in fase di render, e
   * `t` qui si può usare senza legare nessuna dipendenza (v. `caricaConteggi`).
   */
  const descrizioneConteggio = (id: (typeof FILTRI_FATTURA)[number]['id'], n: number): string => {
    const parziale = conteggi?.parziale === true;
    if (id === 'da_fatturare') {
      return parziale ? t('reconConteggioDaFatturareParziale', { n }) : t('reconConteggioDaFatturare', { n });
    }
    return parziale ? t('reconConteggioFatturateParziale', { n }) : t('reconConteggioFatturate', { n });
  };

  /**
   * L'avviso si mostra SOLO col sottofiltro acceso: senza, non c'è nessun filtro
   * sospeso da dichiarare e la fascia sarebbe rumore su una lista già corretta.
   */
  const avvisoFatturazione = !fatturazioneDisponibile && fattura !== '';
  /**
   * ⚠️ «Nessun movimento in questo stato» è una AFFERMAZIONE, e si può fare solo
   * quando si sa che è vera. Con un rifiuto in corso o col filtro non applicato
   * non lo sappiamo: lì parla la fascia, non il vuoto. L'errore di RETE è il caso
   * in cui si sa meno di tutti — la risposta non è arrivata affatto — e la lista è
   * vuota per assenza di dati, non per assenza di movimenti: la schermata scriveva
   * «Nessun movimento: importa un estratto conto per iniziare», un invito a
   * lavorare, proprio sotto la fascia rossa del caricamento fallito.
   *
   * ⚠️ L'IMPORT FALLITO NON ENTRA IN QUESTO ELENCO, ed è l'unico dei tre a restarne
   * fuori: lì il caricamento della lista è andato benissimo: se la lista è vuota, è
   * vuota davvero, e «importa un estratto conto per iniziare» è esattamente il
   * consiglio giusto per chi ha appena visto rifiutare il proprio file.
   */
  const guastoDelCaricamento = guasto !== null && guasto.tipo !== 'import';
  const vuoto = !loading && disponibile && !guastoDelCaricamento && !avvisoFatturazione && movimenti.length === 0;

  /**
   * ─── QUALI RIGHE SI POSSONO SPUNTARE, E PERCHÉ SOLO QUESTE ─────────────────
   *
   * Quattro condizioni insieme, e sono **le stesse quattro del server**: movimento
   * CONFERMATO, un pagamento abbinato, il pagamento SALDATO, e la fattura ancora
   * da fare. Non «le stesse» perché qualcuno le ha ricopiate uguali: sono
   * letteralmente la stessa funzione, `daFatturareInListaDiLavoro`, importata dal
   * motore e chiamata anche da `filtraFattura` nella rotta.
   *
   * ⚠️ Fino al 2026-09-07 questa riga riscriveva la congiunzione a mano, parola per
   * parola come la rotta. Le due copie coincidevano — ed è esattamente lo stato in
   * cui si trovavano il chip e la rotta il giorno prima di divergere, che è la
   * storia che il lock `fatturazione-riconciliazione-un-motore-solo` racconta di sé
   * stesso. Il lock non la vedeva: sorveglia il corpo di `chipFatturazione` e gli
   * import della rotta, non questa funzione. Adesso ha una quarta regola che la
   * guarda.
   *
   * ⚠️ `pagamento_stato === 'pagato'` NON È RIDONDANTE, e fino al 2026-09-07 qui
   * c'era scritto che lo fosse — «su una riga di un'altra sede quel campo è `null`
   * per minimizzazione, e il chip di fatturazione non compare affatto». È falso, e
   * lo dice la rotta stessa: la minimizzazione per sede tocca i due campi DERIVATI
   * (`pagamento_stato`, `fattura_stato`), mentre i DOCUMENTI (`m.fattura`) restano
   * cross-sede per progetto — il registro è l'estratto conto unico del titolare.
   * Su una riga confermata di un ALTRO plesso con `fattura: { stato: 'scartata' }`
   * il tono arriva dai documenti, `fatturaDaFare` risponde `true`, e la casella
   * compariva. Stessa cosa su un pagamento della propria sede non ancora saldato.
   *
   * Il costo era doppio: «Seleziona tutte le da fatturare (n)» contava e spuntava
   * righe che il filtro «Da fatturare» non mostra, occupando con esse gli slot del
   * tetto; e quelle righe arrivavano all'emissione per essere respinte da
   * `assertPagamentoInScope` (altra sede) o con 400 `non_saldato` — dopo essere
   * state dichiarate «pronte» dal pre-volo, che sul saldo non ha nessuna guardia.
   * Due definizioni di «da fatturare», una nel browser e una nel server, sono
   * esattamente ciò che il lock `fatturazione-riconciliazione-un-motore-solo`
   * esiste per impedire.
   *
   * ⚠️ Le righe non selezionabili NON hanno una casella disabilitata: non hanno
   * casella. Una casella che non si può spuntare è un comando che non si sa
   * perché non funziona, e su una lista di quattro stati sarebbe la maggioranza
   * delle righe. (Il `disabled` a lotto in volo è un'altra cosa: lì la casella
   * esiste e il divieto dura quanto l'operazione.)
   */
  const selezionabile = (m: MovimentoUi): boolean => daFatturareInListaDiLavoro(m);

  const selezionabili = movimenti.filter(selezionabile);
  const selezionate = movimenti.filter((m) => selezionati.has(m.id));
  const tutteSpuntate =
    selezionabili.length > 0 &&
    selezionabili.slice(0, TETTO_LOTTO).every((m) => selezionati.has(m.id));

  /**
   * ⚠️ IL TETTO SI APPLICA QUI, non nel lotto: troncare in silenzio dodici righe
   * su venti al momento dell'emissione significherebbe non emettere otto fatture
   * che l'operatore crede partite. Il rifiuto della tredicesima spunta è
   * spiegato a schermo dalla riga «si emette al massimo N per volta», che la
   * barra mostra sempre.
   */
  const spunta = (id: string) => {
    setSelezionati((prima) => {
      const dopo = new Set(prima);
      if (dopo.has(id)) dopo.delete(id);
      else if (dopo.size < TETTO_LOTTO) dopo.add(id);
      return dopo;
    });
  };

  const spuntaTutte = () => {
    setSelezionati(
      tutteSpuntate ? new Set() : new Set(selezionabili.slice(0, TETTO_LOTTO).map((m) => m.id)),
    );
  };

  return (
    <div>
      <SectionTitle icon={Landmark} title={t('reconTitolo')}
        sub={t('reconSottotitolo')}
        /* Bottone-icona: 44×44 (era 30) e inchiostro `sub` (6,46:1) al posto di
           `muted`, che su bianco vale 3,80:1 — sotto AA, e con l'aria di un
           comando spento. Sta fuori dalla `ul`, cioè fuori dal ritaglio che la
           sonda misura: nessuna misura l'aveva mai guardato, ed è esattamente il
           posto in cui un difetto sopravvive.

           ⚠️ `shrink-0` NON È DECORATIVO: è un figlio del flex di `SectionTitle`,
           e un figlio flex si stringe di default. MISURATO sul PNG a pagina intera
           del collaudo: 20×44 css px su telefono — rapporto 0,45, cioè una capsula
           verticale schiacciata dove il codice chiede un cerchio. `h-11 w-11`
           dichiara la taglia, `shrink-0` è ciò che gliela lascia. */
        action={
          <button onClick={() => { setLoading(true); load(); riconta(); }} aria-label={t('reconAggiorna')}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-kidville-line text-kidville-sub transition-colors hover:border-kidville-green hover:text-kidville-green">
            <RefreshCw size={16} />
          </button>
        } />

      {/* A1: trigger = <button> (Tab-reachable, attivabile da Invio/Spazio) che
          aziona l'input file via ref. L'input è `sr-only` (non `hidden`): resta
          fuori dal focus (aria-hidden + tabIndex -1) ma resta cliccabile via ref.
          A5: CTA bianco-su-verde (BTN_PRIMARY_AA, ≈6,5:1) invece del giallo (~4:1). */}
      <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy} className={BTN_PRIMARY_AA}>
        <Upload size={14} /> {busy ? t('reconElaboro') : t('reconImportaCsv')}
      </button>
      {/* I tre formati in cui una banca esporta davvero, per estensione E per MIME: su un
          `.xls` scaricato dall'home banking il browser dichiara spesso
          `application/octet-stream`, e un `accept` solo-MIME lo nasconderebbe dal selettore. */}
      <input ref={fileInputRef} type="file"
        accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr-only" tabIndex={-1} aria-hidden="true" disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
      <p className="mt-1 font-maven text-[11px] text-kidville-sub">
        {t('reconColonne')}
      </p>

      {esito && (
        <p role="status" className="mt-3 flex items-center gap-1.5 rounded-card bg-kidville-success-soft px-3 py-2 font-maven text-sm text-kidville-success">
          <SaveCheck size={16} />
          {riepilogoImport(esito)}
        </p>
      )}
      {testoGuasto !== null && (
        <p role="alert" className="mt-3 font-maven text-xs text-kidville-error-strong">
          {testoGuasto}
        </p>
      )}

      {/* Filtri per stato (sul GET via ?stato=) */}
      <div className="mt-5">
        <span aria-hidden="true" className={OCCHIELLO_FILTRO}>{t('reconGruppoStato')}</span>
        {/* `kv-cockpit-tabs`: la regola di Alto Contrasto delle pill con `aria-pressed` esiste
            già in globals.css e disegna il contorno che qui, in HC, restava a 1,23:1. */}
        <div className="kv-cockpit-tabs flex flex-wrap gap-1.5" role="group" aria-label={t('reconFiltraPerStato')}>
          {FILTRI.map((f) => {
            const attivo = f.id === filtro;
            return (
              <button key={f.id || 'tutti'} type="button" onClick={() => cambiaFiltro(f.id)} aria-pressed={attivo}
                className={cx(PILL_FILTRO, attivo ? PILL_FILTRO_ON : PILL_FILTRO_OFF)}>
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Sottofiltro «Fatturazione» (?fattura=), componibile col precedente: è la
          risposta a «quali confermati restano da fatturare?», che su un registro
          di righe verdi indistinguibili non aveva nessuna risposta. */}
      <div className="mt-3">
        <span aria-hidden="true" className={OCCHIELLO_FILTRO}>{t('reconGruppoFatturazione')}</span>
        {/* ── IL NOME DEL GRUPPO NON CAMBIA MAI. L'ASIMMETRIA È UNA DESCRIZIONE ──
            L'asimmetria è vera e va detta: «Da fatturare» pretende
            `pagamento_stato === 'pagato'`, che fuori dalle proprie sedi è `null`
            — è la lista di lavoro della PROPRIA sede — mentre «Fatturate» guarda
            i DOCUMENTI ed è cross-sede. Due NUMERI accostati si leggono come
            parti di uno stesso totale, e non lo sono: la loro somma non è
            «quanti movimenti ci sono».

            ⚠️ MA NON SI DICE NEL NOME, e il primo tentativo lo faceva: l'`aria-label`
            del gruppo diventava la frase lunga appena i numeri arrivavano. Due guasti
            in uno. Per chi ascolta, il NOME è l'identificatore del gruppo — quello che
            un lettore di schermo rilegge a ogni ingresso — e un identificatore che
            muta sotto l'utente, per giunta in una frase di trenta parole, non
            identifica più niente. Per chi collauda è peggio: in produzione i numeri
            ci sono SEMPRE (il server risponde `conteggi` ogni volta che la fatturazione
            è leggibile), quindi il ramo corto era irraggiungibile fuori dai test — e
            i sette casi che cercavano il gruppo per nome restavano verdi solo perché
            il loro finto server non contava. Codice modellato attorno ai test, cioè
            un collaudo che non guardava più lo stato reale.

            La regola giusta questa schermata la applicava già alle singole pillole:
            il numero non entra nel nome, entra in un `aria-describedby`. Qui si fa
            la stessa cosa un piano più su — nome STABILE, spiegazione come
            descrizione, montata solo quando i numeri da disambiguare ci sono. */}
        <div className="kv-cockpit-tabs flex flex-wrap gap-1.5" role="group"
          aria-label={t('reconFiltroFatturazione')}
          aria-describedby={conteggi ? ID_ASIMMETRIA : undefined}>
          {FILTRI_FATTURA.map((f) => {
            const attivo = f.id === fattura;
            /* `null` = nessun numero da scrivere, e i due casi che ci finiscono
               sono opposti a bella posta: «Tutte» (non è un bidone) e «il server
               non ha potuto contare». A schermo la cosa giusta da fare è la
               stessa — niente — ed è l'unica onesta: uno «0» direbbe «non ne
               resta nessuna da fare» su un dato che nessuno ha letto. */
            const n = numeroPillolaFattura(f.id, conteggi);
            const idDescrizione = `recon-conteggio-${f.id || 'tutte'}`;
            return (
              <Fragment key={f.id || 'tutte'}>
                <button type="button" onClick={() => cambiaFattura(f.id)} aria-pressed={attivo}
                  /* ⚠️ `aria-describedby` e MAI un testo dentro il bottone: una
                     descrizione non entra nel NOME accessibile, un `sr-only`
                     figlio sì — e il nome della pillola è ciò con cui la si
                     trova, a mano e nei test. */
                  aria-describedby={n === null ? undefined : idDescrizione}
                  className={cx(PILL_FILTRO, attivo ? PILL_FILTRO_ON : PILL_FILTRO_OFF)}>
                  {t(f.labelKey)}
                  {/* `aria-hidden`: il numero è la forma BREVE, per chi vede.
                      Chi ascolta riceve la frase intera dalla descrizione, che
                      dice anche di che numero si tratta — «12» da solo, letto ad
                      alta voce in coda a un'etichetta, non significa niente. */}
                  {n !== null && (
                    <span aria-hidden="true" className={PILL_CONTEGGIO}>
                      {etichettaConteggio(n, conteggi?.parziale === true)}
                    </span>
                  )}
                </button>
                {n !== null && (
                  <span id={idDescrizione} className="sr-only">{descrizioneConteggio(f.id, n)}</span>
                )}
              </Fragment>
            );
          })}
        </div>
        {/* La frase che disambigua i due numeri: MONTATA SOLO QUANDO I NUMERI CI
            SONO, perché senza non c'è niente da disambiguare e sarebbe rumore.
            Sta fuori dal `role="group"` — non è un filtro — ed è `sr-only`: chi
            vede i due numeri accostati ha già il contesto della schermata, chi
            ascolta no. */}
        {conteggi && (
          <span id={ID_ASIMMETRIA} className="sr-only">{t('reconFiltroFatturazioneAsimmetria')}</span>
        )}
      </div>

      {/* Il filtro chiesto NON è stato applicato: la lista che segue è intera.
          Dirlo è l'unica alternativa onesta a un elenco vuoto che significherebbe
          «non c'è niente da fatturare» — che è il falso negativo peggiore di questa
          schermata: una fattura saltata non la ferma nessuna guardia. */}
      {avvisoFatturazione && (
        <p role="alert" className="mt-3 rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn-strong">
          {t('reconFatturazioneNonDisponibile')}
        </p>
      )}
      {/* La finestra del server era piena: ce ne sono altre. Senza questa riga
          l'elenco sembrerebbe completo, ed è esattamente come si salta una fattura
          vecchia — quelle in fondo, cioè quelle che nessuno ha ancora fatto. */}
      {troncato && !loading && (
        <p role="status" className="mt-2 font-maven text-[11px] text-kidville-sub">
          {t('reconFatturazioneTroncata', { n: movimenti.length })}
        </p>
      )}

      {loading ? (
        <p className="py-8 text-center font-maven text-sm text-kidville-sub">{t('reconCaricamento')}</p>
      ) : !disponibile ? (
        <p className="py-8 text-center font-maven text-sm text-kidville-sub">{t('reconNonDisponibile')}</p>
      ) : vuoto ? (
        <p className="py-8 text-center font-maven text-sm text-kidville-sub">
          {filtro ? t('reconVuotoFiltro') : t('reconVuoto')}
        </p>
      ) : (
        <>
        {/* «Seleziona tutte le da fatturare»: stesso schema dei solleciti, e il
            numero fuori dalla chiave di traduzione — una parentesi con un intero
            dentro non è una frase da tradurre. */}
        {selezionabili.length > 0 && (
          <label className="mt-3 flex w-fit cursor-pointer items-center gap-2">
            <input type="checkbox" checked={tutteSpuntate} onChange={spuntaTutte} disabled={lottoInVolo}
              className="h-5 w-5 rounded border-kidville-neutral text-kidville-green focus:ring-kidville-green disabled:cursor-not-allowed disabled:opacity-60" />
            <span className="font-maven text-xs font-bold text-kidville-green">
              {t('reconLottoSelezionaTutte')} ({Math.min(selezionabili.length, TETTO_LOTTO)})
            </span>
          </label>
        )}
        <ul className="mt-3 space-y-2">
          {movimenti.map((m) => {
            const s = SEMAFORO[m.stato] ?? SEMAFORO.da_abbinare;
            const cf = suggerimentoPrincipaleCf(m.suggerimenti);
            // Una funzione sola per i due dati che raccontano la fattura: i DOCUMENTI
            // registrati (`m.fattura`, col numero) e il riassunto scritto sul pagamento
            // (`m.fattura_stato`). Dentro sta anche la guardia su `pagamento_id`: su una
            // riga ancora da lavorare non esiste nessun pagamento da fatturare, e la
            // lettura fallita (`null`) non diventa un chip — non si dichiara ciò che non
            // si sa.
            const fat = chipFatturazione(m);
            return (
              <li key={m.id} className="flex items-stretch gap-1">
                {/* ── LA CASELLA È FRATELLO DEL BOTTONE, MAI DENTRO ──────────
                    Un `<input>` dentro un `<button>` è HTML non valido e rompe
                    il bersaglio «apri il popup»: il browser annida i due
                    controlli e il click finisce sul più interno. Qui sono due
                    fratelli dentro il `<li>`, con lo `stopPropagation` che
                    impedisce alla spunta di aprire anche la scheda — lo stesso
                    schema di `StudentRowCard.tsx`.

                    ⚠️ `aria-label` con IMPORTO e DATA, mai la causale: la
                    causale può contenere il codice fiscale di un minore, e un
                    `aria-label` è testo come un altro — lo legge lo screen
                    reader e finisce negli alberi di accessibilità. */}
                {selezionabile(m) && (
                  <label
                    className="-my-1 flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selezionati.has(m.id)}
                      onChange={() => spunta(m.id)}
                      /* ⚠️ A lotto in volo la selezione NON si tocca: cambiarla
                         smonterebbe la barra da sotto un ciclo che sta emettendo
                         documenti fiscali. Qui il `disabled` è legittimo perché
                         dura quanto l'operazione e il motivo è a schermo, sulla
                         barra che avanza — non è una casella spenta per sempre. */
                      disabled={lottoInVolo}
                      aria-label={t('reconLottoSelezionaRiga', { importo: formatEuro(m.importo), data: dataIt(m.data_operazione) })}
                      className="h-5 w-5 rounded border-kidville-neutral text-kidville-green focus:ring-kidville-green disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={(e) => { triggerRef.current = e.currentTarget; setSelezionato(m); }}
                  className={cx('kv-recon-row relative block w-full min-w-0 flex-1 rounded-card p-3 pr-9 text-left transition hover:brightness-95', s.bg, s.hcClass)}
                >
                  {/* ── IL CHEVRON HA UN CORRIDOIO SUO, E UNO SOLO ───────────
                      Stava nel flusso, quindi ogni riga gli cedeva una fetta
                      diversa: su mobile si portava via 24px alla causale della
                      riga della cifra, su desktop si infilava fra la colonna di
                      stato e il bordo. Adesso è FUORI dal flusso, centrato
                      sull'altezza della card (l'affordance «questa riga si apre»
                      appartiene alla riga intera, non a una delle sue tre righe di
                      testo), e il corridoio glielo riserva il `pr-9` del bottone:
                      24px dal contenuto al bordo, identici per tutte le righe.
                      MISURATO: su telefono la colonna del testo resta 262px, cioè
                      esattamente quella di prima — il corridoio unico non si paga
                      con la causale — e su desktop passa da 568 a 672px.
                      `pointer-events-none` perché il bersaglio è il bottone. */}
                  <ChevronRight size={16} aria-hidden="true"
                    className={cx('pointer-events-none absolute right-3 top-1/2 -translate-y-1/2', s.testo)} />
                  {/* ── IL RITMO DELLA RIGA, IN UNA STRUTTURA SOLA ───────────
                      Due fratelli soli: il testo e il gruppo di stato. Non due
                      copie per due breakpoint — due copie dello stesso chip
                      sarebbero due posti da cui un giorno diverge.

                      MOBILE (`flex-wrap`): riga 1 = testo, riga 2 = il gruppo di
                      stato, che va a capo da solo perché `basis-full`.

                      DESKTOP (`sm:flex-nowrap`): il gruppo di stato è una colonna
                      di larghezza dichiarata, così la causale si tronca sempre
                      allo stesso punto invece che a un punto diverso per riga —
                      su quella con «IN ATTESA SDI» spariva il cognome della
                      famiglia, che è il dato con cui si decide.

                      ⚠️ 176px (`sm:min-w-44`) E NON PIÙ 280. MISURATO sul server
                      di collaudo a 1280px: il gruppo più largo dell'intera lista —
                      chip «IN ATTESA SDI» + «CONFERMATO» — occupa 167px. I 113
                      restanti erano fondo verde vuoto fra la causale troncata e il
                      chip: una riga tagliata con un quarto di riga libera accanto
                      non si legge come una scelta, si legge come un guasto. Con
                      176 la colonna resta unica e allineata, e la causale passa da
                      568 a 672px — sono i cento pixel in cui sta il cognome della
                      famiglia.

                      È un MINIMO e non una larghezza fissa, di proposito: con
                      `w-44` un'etichetta più lunga (una traduzione, uno stato
                      nuovo) traboccherebbe dalla sua colonna sopra la causale,
                      in silenzio. Il minimo compra l'allineamento su tutte le
                      righe di oggi e lascia crescere quella che un giorno non ci
                      starà — perdendo un po' di causale, non la leggibilità.

                      `min-w-0` sulla colonna del testo non è ornamentale: senza,
                      un figlio `truncate` tiene la colonna larga quanto il testo
                      intero e il troncamento non avviene mai. */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-2 sm:flex-nowrap sm:gap-x-4">
                    <span className="min-w-0 flex-1">
                      <span className={cx('block whitespace-nowrap font-maven text-sm font-bold', s.testo)}>
                        {formatEuro(m.importo)} · {dataIt(m.data_operazione)}
                      </span>
                      <span className={cx('mt-1 block truncate font-maven text-xs', s.sub)} title={m.causale ?? ''}>
                        {m.causale || t('reconNessunaCausale')}{m.controparte ? ` · ${m.controparte}` : ''}
                      </span>
                    </span>
                    <span className="flex basis-full items-center gap-2 sm:min-w-44 sm:basis-auto sm:shrink-0 sm:justify-end">
                      {cf && (
                        /* `kv-recon-badge-cf` è l'àncora dell'Alto Contrasto: senza,
                           il badge resta carta bianca con inchiostro verde (3,23:1
                           una volta che la riga è nera) mentre tutto il resto è
                           passato a carta/inchiostro netti. */
                        <span className="kv-recon-badge-cf inline-flex items-center rounded-pill bg-kidville-white px-2 py-1 font-barlow text-[10px] font-extrabold uppercase leading-none text-kidville-green ring-[1.5px] ring-inset ring-kidville-green">
                          {t('reconBadgeCf')}
                        </span>
                      )}
                      {/* ── «SEMBRA DI UN'ALTRA SEDE», SULLA RIGA ────────────
                          Il popup lo diceva già; la lista no — e la lista è dove
                          si sbaglia: si scorre, si apre una riga e si preme.
                          MISURATO in produzione il 2026-09-07 applicando la
                          regola COME È IMPLEMENTATA, cioè sulle sole righe NON
                          confermate — le uniche su cui questo chip può comparire:
                          su 236 movimenti con suggerimenti il verdetto scatta su
                          165 righe per Aversa, 166 per Cesa, 72 per Giugliano, e
                          per due segreterie su tre non c'è nemmeno un candidato
                          di casa da proporre (162, 162 e 8). I numeri di prima
                          (169/168/76) erano la somma con le 5 righe confermate
                          che portano ancora suggerimenti: righe senza chip.

                          ⚠️ UN CHIP, NON UN COLORE NUOVO SULLA RIGA: il fondo è il
                          semaforo dello STATO e non si tocca — «di un'altra sede»
                          è un'altra domanda, su un altro asse. Mai giallo né
                          rosso: qui non si chiede un'azione a chi guarda.
                          La pelle (carta bianca, inchiostro, àncora
                          `kv-recon-chip` per l'Alto Contrasto) sta in
                          `riconciliazione-ui`, accanto a quella dei chip di
                          fatturazione, così le due non possono divergere. */}
                      {m.altra_sede && (
                        <span className={classiChipAltraSede()}>{t('reconChipAltraSede')}</span>
                      )}
                      {/* Chip di fatturazione: LO STESSO componente del popup, così
                          lo stesso stato non può avere due facce. Fondo PIENO (mai
                          opacità) perché vive sopra il verde della riga confermata,
                          e senza filetto: qui a staccarlo basta il fondo. */}
                      {fat && <ChipFatturazione fat={fat} />}
                      <span className={cx('font-barlow text-[11px] font-extrabold uppercase tracking-wide', s.testo)}>{s.label}</span>
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        {/* La barra del lotto è FISSA in fondo allo schermo: senza questo
            respiro coprirebbe le ultime righe della lista, cioè le più vecchie —
            quelle che nessuno ha ancora fatturato. */}
        {selezionati.size > 0 && <div aria-hidden="true" className="h-56" />}
        </>
      )}

      {/* ⚠️ MONTATO SOLO CON UNA SELEZIONE VIVA, e non svuotato da `load()`: il
          riepilogo del lotto vive qui dentro, e sparirebbe proprio nel momento in
          cui la lista si ricarica per mostrare le fatture appena partite. */}
      {selezionati.size > 0 && (
        <LottoFatturePanel
          userId={userId}
          selezionate={selezionate}
          onChiudi={() => setSelezionati(new Set())}
          onDone={() => { void load(); riconta(); }}
          onLavoro={setLottoInVolo}
        />
      )}

      {selezionato && (
        <MovimentoDialog
          movimento={selezionato}
          aperti={aperti}
          userId={userId}
          returnFocusRef={triggerRef}
          onClose={() => setSelezionato(null)}
          /* È il momento in cui una fattura è appena partita (o un abbinamento è
             stato fatto): il numero DEVE scendere, o resterebbe a schermo un
             conteggio che l'operatore ha appena smentito con le proprie mani. */
          onDone={() => { void load(); riconta(); }}
          onIncassoUnico={onIncassoUnico ? gestisciIncassoUnico : undefined}
        />
      )}
    </div>
  );
}
