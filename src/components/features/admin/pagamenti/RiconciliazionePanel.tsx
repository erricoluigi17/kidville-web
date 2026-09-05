'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { ChevronRight, Landmark, RefreshCw, Upload } from 'lucide-react';
import { SectionTitle } from '@/components/ui/cockpit';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { ChipFatturazione, MovimentoDialog } from './MovimentoDialog';
import type { PrecompilaTransazione } from './TransazioniPanel';
import { BTN_PRIMARY_AA } from './ui';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { LIMITE_UPLOAD_BYTE } from '@/lib/upload/limite-piattaforma';
import {
  SEMAFORO,
  FILTRI,
  FILTRI_FATTURA,
  chipFatturazione,
  suggerimentoPrincipaleCf,
  riepilogoImport,
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

/** Pill dei filtri (stato e fatturazione): stessa pelle, un solo posto. */
const PILL_FILTRO = 'rounded-pill px-3 py-1.5 font-barlow text-[12px] font-extrabold uppercase tracking-[0.03em] transition-colors';
const PILL_FILTRO_ON = 'bg-kidville-green text-kidville-white';
const PILL_FILTRO_OFF = 'bg-kidville-white text-kidville-sub ring-[1.5px] ring-inset ring-kidville-line hover:ring-kidville-green';

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
  const [error, setError] = useState<string | null>(null);
  /**
   * ⚠️ L'ERRORE DI RETE DEI MOVIMENTI È UN FLAG, NON UNA STRINGA — e non è
   * pignoleria: è ciò che ferma un ciclo di richieste senza fine.
   *
   * `load` finiva con `setError(t('reconErroreReteMovimenti'))`, quindi `t`
   * doveva stare fra le sue dipendenze. Ma `t` di next-intl **non è garantito
   * stabile fra un render e l'altro**: quando cambia identità, `load` cambia,
   * l'effetto rigira, il `finally` fa `setLoading(false)`, si ri-renderizza, e
   * si ricomincia. Misurato sul banco di prova (dove `useTranslations` è un mock
   * che ricrea `t` ogni volta): **1.470 GET in 300 ms, senza che nessuno
   * cliccasse niente**. Nessun test se n'era mai accorto, perché nessuno contava
   * le richieste — si guardava solo che ce ne fosse almeno una.
   *
   * Il rimedio è togliere la traduzione dal caricamento: `load` alza un flag, il
   * testo lo sceglie il JSX. Così `load` dipende solo dai suoi veri ingressi.
   */
  const [erroreRete, setErroreRete] = useState(false);
  /**
   * IL CORPO del rifiuto, non il suo testo già tradotto — per la stessa ragione
   * per cui `erroreRete` è un flag: `messaggioDaCorpo` vuole un `fallback`
   * tradotto, e chiamare `t` dentro `load` rimetterebbe `t` fra le dipendenze
   * del `useCallback` (1.470 GET in 300 ms, misurati). Qui si conserva ciò che
   * il server ha detto; la lingua la sceglie il JSX, che si ri-renderizza da sé.
   *
   * Fino a oggi un `success: false` non alzava NIENTE: né errore né log. Un 400
   * sul sottofiltro — cioè un filtro che non ha filtrato — si vedeva come una
   * lista qualunque.
   */
  const [rifiuto, setRifiuto] = useState<{ error?: unknown; codice?: unknown } | null>(null);
  /**
   * Il server sa dire se la fatturazione è filtrabile, e quando non lo è manda
   * le righe NON filtrate (`fatturazione_disponibile: false`). Senza questo
   * campo il degrado arrivava come una lista vuota, e la schermata scriveva
   * «Nessun movimento in questo stato»: cioè «non c'è niente da fatturare».
   */
  const [fatturazioneDisponibile, setFatturazioneDisponibile] = useState(true);
  /** La finestra del server era piena: ci sono altre righe oltre a queste. */
  const [troncato, setTroncato] = useState(false);
  const [filtro, setFiltro] = useState<'' | StatoMovimento>('');
  // Sottofiltro «Fatturazione»: si compone col filtro per stato e vale solo sui
  // confermati (gli unici su cui la fatturazione esista).
  const [fattura, setFattura] = useState<'' | 'da_fatturare' | 'fatturate'>('');
  const [selezionato, setSelezionato] = useState<MovimentoUi | null>(null);

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
        setRifiuto(null);
        setErroreRete(false);
      } else if (movRes === null) {
        setErroreRete(true);
      } else {
        // Il server ha RIFIUTATO. Prima non succedeva niente: nessun messaggio,
        // nessun log, e l'operatore restava davanti a una lista che sembrava
        // filtrata. Il corpo si conserva per il testo, lo `stato` va nel log.
        setRifiuto((movRes.corpo ?? {}) as { error?: unknown; codice?: unknown });
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
      setError(t('reconFileTroppoGrande'));
      return;
    }
    setBusy(true);
    setError(null);
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
      if (!r.ok || !j.success) { setError(messaggioDaCorpo(j, t('reconErroreImport'))); return; }
      setEsito(j.data as EsitoImport);
      await load();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `riconciliazione-import-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError(t('reconErroreLetturaFile'));
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
   * Il rifiuto del server, tradotto qui e non dentro `load` (vedi `rifiuto`).
   * `messaggioDaCorpo` è pura: preferisce il codice di catalogo, poi la prosa del
   * server, e in ultimo il ripiego — che dice cosa fare, non «errore».
   */
  const messaggioRifiuto = rifiuto ? messaggioDaCorpo(rifiuto, t('reconErroreFiltro')) : null;
  /**
   * L'avviso si mostra SOLO col sottofiltro acceso: senza, non c'è nessun filtro
   * sospeso da dichiarare e la fascia sarebbe rumore su una lista già corretta.
   */
  const avvisoFatturazione = !fatturazioneDisponibile && fattura !== '';
  /**
   * ⚠️ «Nessun movimento in questo stato» è una AFFERMAZIONE, e si può fare solo
   * quando si sa che è vera. Con un rifiuto in corso o col filtro non applicato
   * non lo sappiamo: lì parla la fascia, non il vuoto.
   */
  const vuoto = !loading && disponibile && !messaggioRifiuto && !avvisoFatturazione && movimenti.length === 0;

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
          <button onClick={() => { setLoading(true); load(); }} aria-label={t('reconAggiorna')}
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
      {(error || erroreRete || messaggioRifiuto) && (
        <p role="alert" className="mt-3 font-maven text-xs text-kidville-error-strong">
          {error ?? messaggioRifiuto ?? t('reconErroreReteMovimenti')}
        </p>
      )}

      {/* Filtri per stato (sul GET via ?stato=) */}
      <div className="mt-5">
        <span aria-hidden="true" className={OCCHIELLO_FILTRO}>{t('reconGruppoStato')}</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('reconFiltraPerStato')}>
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
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('reconFiltroFatturazione')}>
          {FILTRI_FATTURA.map((f) => {
            const attivo = f.id === fattura;
            return (
              <button key={f.id || 'tutte'} type="button" onClick={() => cambiaFattura(f.id)} aria-pressed={attivo}
                className={cx(PILL_FILTRO, attivo ? PILL_FILTRO_ON : PILL_FILTRO_OFF)}>
                {t(f.labelKey)}
              </button>
            );
          })}
        </div>
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
        <ul className="mt-3 space-y-2">
          {movimenti.map((m) => {
            const s = SEMAFORO[m.stato] ?? SEMAFORO.da_abbinare;
            const cf = suggerimentoPrincipaleCf(m.suggerimenti);
            const fat = chipFatturazione(m);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={(e) => { triggerRef.current = e.currentTarget; setSelezionato(m); }}
                  className={cx('kv-recon-row relative block w-full rounded-card p-3 pr-9 text-left transition hover:brightness-95', s.bg, s.hcClass)}
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
      )}

      {selezionato && (
        <MovimentoDialog
          movimento={selezionato}
          aperti={aperti}
          userId={userId}
          returnFocusRef={triggerRef}
          onClose={() => setSelezionato(null)}
          onDone={() => { void load(); }}
          onIncassoUnico={onIncassoUnico ? gestisciIncassoUnico : undefined}
        />
      )}
    </div>
  );
}
