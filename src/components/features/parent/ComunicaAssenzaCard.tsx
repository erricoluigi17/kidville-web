'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarPlus } from 'lucide-react';
import { useDateFormat } from '@/lib/i18n/date';
import { DateField } from '@/components/ui/DateField';
import { Btn } from '@/components/ui/Btn';
import { RigaAssenzaComunicata } from '@/components/features/parent/RigaAssenzaComunicata';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { logClient } from '@/lib/logging/client';

/**
 * «Comunica un'assenza» — il gesto che il genitore fa PRIMA, non dopo.
 *
 * ─── DA DOVE VIENE ──────────────────────────────────────────────────────────
 * Il codice di questa card esisteva da mesi dentro `PrimariaParentView.tsx`
 * (`AssenzeCard`, righe 258-314): un componente esportato e **mai importato da
 * nessuna pagina**. Cioè una funzione scritta, tradotta in due lingue e mai
 * arrivata a nessuno. Qui è estratta la sola parte «comunica assenza» — pagelle,
 * valutazioni, note e impreparato vivono già in altre pagine — e corretta nei due
 * difetti che portava con sé.
 *
 * ─── DIFETTO 1: IL SUCCESSO DICHIARATO SENZA VERIFICA ───────────────────────
 * L'originale faceva `await onComunicaAssenza(data, motivo)` e subito dopo
 * `setMsg('Assenza comunicata ✓')`, sempre — anche quando il server aveva appena
 * risposto 400 o 403. È il vizio che questo progetto ha già pagato altrove (le
 * email di credenziali «inviate» per mesi con un 403 in mano): un'operazione che
 * dichiara successo senza averlo verificato. Qui la conferma la scrive SOLO
 * `res.ok`; ogni rifiuto diventa una frase italiana presa dal catalogo dei codici
 * (`CODICI_ERRORE`), mai la prosa del server — che è italiana per costruzione e
 * a un'interfaccia in inglese mostrerebbe italiano, nomi di colonne compresi
 * (lock `errori-server-schermate-famiglia`).
 *
 * ─── DIFETTO 2: IL FUSO ─────────────────────────────────────────────────────
 * `oggiIso()` dell'originale era `new Date().toISOString().slice(0,10)`: fra la
 * mezzanotte e le due italiane restituisce IERI. Ora che il server rifiuta le
 * date passate, quel campo sarebbe nato precompilato con una data che il server
 * respinge. Si usa `oggiFiscaleISO()`, che dichiara `Europe/Rome`.
 *
 * ─── PERCHÉ LEGGE `parent/presenze` E NON L'ELENCO DELLA PAGINA ─────────────
 * Le assenze annullabili sono quelle che ha scritto un genitore (`giustificata_da`
 * valorizzato) e su cui l'insegnante non ha ancora fatto l'appello
 * (`registrato_da` nullo): la distinzione la fa il server, in
 * `GET /api/parent/presenze` (campo `comunicate`). La cronologia che le pagine
 * genitore mostrano non porta quelle due colonne, e ricavare da lì «questa si può
 * ancora ritirare» sarebbe indovinare. La card si legge da sé ciò che le serve, e
 * avvisa la pagina ospite con `onAggiornato` perché ricarichi la SUA lista.
 */

/** Una riga di `GET /api/parent/presenze` → `data.comunicate`. */
export interface AssenzaComunicata {
  id: string;
  data: string;
  giustificazione_testo: string | null;
  stato: string;
}

interface Props {
  /** L'alunno a cui si riferisce l'assenza. `null` finché l'identità non è risolta. */
  studentId: string | null;
  /** Il genitore che comunica. `null` finché l'identità non è risolta. */
  parentId: string | null;
  /**
   * Chiamato dopo ogni scrittura RIUSCITA (invio o annullamento): la pagina che
   * ospita la card ricarica il proprio elenco. Non viene mai chiamato dopo un
   * rifiuto — un ricaricamento dopo un errore ridipinge i vecchi valori e fa
   * sparire il gesto senza una parola, che è il difetto da cui nasce questo file.
   */
  onAggiornato?: () => void;
  className?: string;
}

export function ComunicaAssenzaCard({ studentId, parentId, onAggiornato, className }: Props) {
  const t = useTranslations('parentPrimaria');
  const f = useDateFormat();
  const uid = useId();
  const idData = `comunica-assenza-data-${uid}`;
  const idDataAiuto = `comunica-assenza-data-aiuto-${uid}`;
  const idMotivo = `comunica-assenza-motivo-${uid}`;
  const idModulo = `comunica-assenza-modulo-${uid}`;

  const [aperto, setAperto] = useState(false);
  // Inizializzazione pigra: `oggiFiscaleISO` è deterministica nel fuso italiano,
  // quindi server e client concordano e l'idratazione non diverge.
  const [data, setData] = useState<string>(oggiFiscaleISO);
  const [motivo, setMotivo] = useState('');
  const [inviando, setInviando] = useState(false);
  const [annullando, setAnnullando] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [comunicate, setComunicate] = useState<AssenzaComunicata[]>([]);
  /**
   * La lettura dell'elenco è fallita. È un BOOLEANO e non il testo tradotto, e la
   * differenza non è di stile: il testo verrebbe da `t`, e `t` finirebbe fra le
   * dipendenze dell'effetto che carica. Misurato con un `useTranslations` che
   * restituisce una funzione nuova a ogni render (il finto dei test, più severo di
   * next-intl vero): la card rifaceva la GET **a ogni battito di stato** — quattro
   * richieste per due interazioni, cioè una tempesta di letture sul database a
   * ogni tasto premuto nel campo motivo. Lo stato conserva il FATTO, il render ci
   * mette la lingua.
   */
  const [elencoRotto, setElencoRotto] = useState(false);

  /**
   * DOVE VA IL FUOCO quando l'azione finisce — riuscita o rifiutata.
   *
   * Ogni scrittura di questa card SMONTA il comando che l'ha lanciata: l'invio
   * chiude il modulo (`setAperto(false)`) portandosi via il bottone «Invia la
   * comunicazione», l'annullamento fa sparire la riga con il suo «Annulla». Chi
   * ha premuto da tastiera si ritrova il fuoco su `<body>` — cioè riparte
   * dall'inizio della pagina — e chi usa uno screen reader perde il punto in cui
   * stava: il `role="status"` c'è, quindi la frase viene annunciata, ma il
   * CURSORE resta indietro (WCAG 2.4.3, la stessa ragione per cui `ui/Modal.tsx`
   * ripristina il fuoco alla chiusura).
   *
   * Non è ignoranza del pattern: `parent/attendance/page.tsx` lo applica dal
   * ciclo 1, con tanto di commento. Questo componente è nato nello stesso commit
   * e non l'ha ereditato — la correzione era stata scritta dov'era stato
   * segnalato il sintomo invece che sulla regola. Qui c'è per entrambi gli
   * esiti, compreso il RIFIUTO, che su tutte e due le schermate era rimasto
   * indietro: è proprio quando il server dice di no che serve arrivare al testo.
   *
   * Gli effetti dipendono dal testo di `msg`/`err` e funzionano anche al secondo
   * esito identico, perché i due gestori azzerano ENTRAMBI prima di chiamare il
   * server: lo stato fa comunque '' → frase, e l'effetto riparte.
   */
  const refMsg = useRef<HTMLParagraphElement | null>(null);
  const refErr = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (msg) refMsg.current?.focus();
  }, [msg]);

  useEffect(() => {
    if (err) refErr.current?.focus();
  }, [err]);

  /**
   * Una riga di log per ogni chiamata che non è andata a buon fine. `stato` è un
   * numero e `cosa` una costante di codice: passano la lista bianca della
   * redazione. Il corpo della risposta NON si logga — può contenere il motivo
   * dell'assenza, cioè testo libero sulla salute di un minore.
   */
  const segnala = useCallback((cosa: string, stato?: number, errore?: unknown) => {
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `parent/comunica-assenza: ${cosa}${errore instanceof Error ? ` (${errore.name})` : ''}`,
      stato,
    });
  }, []);

  /**
   * Rilegge le assenze comunicate ancora ritirabili.
   *
   * ⚠️ LA FORMA — `try/finally` e NON `try/catch` — è obbligata, e costa una
   * riga di spiegazione perché sembra un errore. La regola
   * `react-hooks/set-state-in-effect` (React Compiler, `error` in questo repo)
   * boccia una funzione async chiamata da `useEffect` che aggiorni lo stato
   * senza avvolgere i suoi `await` in un `try`: li considera raggiungibili in
   * modo sincrono. Misurato qui: senza il `try` la lint è rossa, con `try/finally`
   * è verde, a parità di logica. Stessa forma di `PagamentiSummary`.
   *
   * Il fallimento (rete giù, corpo illeggibile) NON resta muto: lo raccoglie chi
   * chiama — l'effetto qui sotto e i due gestori di scrittura — e in tutti e tre
   * i casi si logga e si dice a schermo.
   */
  const caricaComunicate = useCallback(async () => {
    if (!studentId || !parentId) return;
    try {
      const r = await fetch(`/api/parent/presenze?studentId=${studentId}&userId=${parentId}`, {
        headers: { 'x-user-id': parentId },
      });
      const corpo = r.ok ? await r.json() : null;
      /**
       * DUE GUASTI, UNA SOLA CONCLUSIONE: l'elenco non lo abbiamo.
       *
       * Il primo è la risposta rifiutata (`!r.ok`). Il secondo è più insidioso e
       * ha vissuto nascosto dietro un 200: `GET /api/parent/presenze` degrada a
       * `comunicate: []` quando la sua query fallisce — scelta giusta, la home
       * non deve rompersi per un elenco accessorio — e risponde comunque 200.
       * Il ramo d'errore qui sotto era scritto e funzionante, e su quel guasto
       * non veniva MAI raggiunto: la card scriveva «Non hai comunicato assenze»
       * a chi ne aveva, e che quindi non poteva nemmeno annullarle.
       *
       * `!== false`, non `Boolean(...)`: un server che il campo non lo manda
       * ancora — rilascio a scaglioni, app dello store più nuova del backend —
       * spedisce `undefined`, e «non lo dichiara» non è «dichiara di no».
       */
      const letto = r.ok && corpo?.data?.comunicateLette !== false;
      if (letto) {
        const righe = corpo?.data?.comunicate;
        setComunicate(Array.isArray(righe) ? (righe as AssenzaComunicata[]) : []);
        setElencoRotto(false);
      } else {
        // Silenzio qui direbbe al genitore «non hai comunicato niente» — che è la
        // bugia peggiore delle due, perché toglie anche il modo di annullare.
        // `r.status` resta quello vero (200 quando è il server a dichiararlo):
        // nel log è l'unica cosa che distingue i due guasti.
        segnala('elenco-non-letto', r.status);
        setElencoRotto(true);
      }
    } finally {
      // Niente da ripulire: questa card non ha uno stato di caricamento proprio.
      // Il blocco esiste solo per la regola del compiler spiegata qui sopra.
    }
  }, [studentId, parentId, segnala]);

  useEffect(() => {
    // La lettura che fallisce del tutto (rete giù) si logga e si dice. Non è un
    // catch muto — quelli sono vietati da AGENTS.md — ed è QUI, fuori dalla
    // funzione, per la stessa regola del compiler.
    void caricaComunicate().catch((e) => {
      segnala('elenco-non-letto', undefined, e);
      setElencoRotto(true);
    });
  }, [caricaComunicate, segnala]);

  const invia = async () => {
    if (!studentId || !parentId || !data || inviando) return;
    setInviando(true);
    setMsg('');
    setErr('');
    try {
      const r = await fetch(`/api/parent/presenze/comunica-assenza?userId=${parentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
        // Il motivo resta FACOLTATIVO (decisione del titolare): si manda com'è,
        // vuoto compreso, e il server lo normalizza a null.
        body: JSON.stringify({ studentId, data, motivo }),
      });
      if (!r.ok) {
        const corpo = await r.json();
        setErr(soloCatalogoDaCorpo(corpo, t('comunicaNonRiuscita')));
        segnala('invio-respinto', r.status);
        return;
      }
      setMotivo('');
      setAperto(false);
      setMsg(t('comunicaFatta'));
      onAggiornato?.();
      // La RILETTURA dell'elenco ha un esito suo, e non può ricadere nel `catch`
      // qui sotto: se cadesse la rete adesso, il genitore leggerebbe «assenza non
      // comunicata» per una scrittura ANDATA A BUON FINE — il difetto speculare a
      // quello che questa card corregge, e altrettanto bugiardo. Riproverebbe, e
      // comunicherebbe due volte la stessa assenza.
      await caricaComunicate().catch((e) => {
        segnala('elenco-non-letto', undefined, e);
        setElencoRotto(true);
      });
    } catch (e) {
      // Rete caduta, oppure un corpo che non è JSON: in entrambi i casi NON
      // sappiamo se l'assenza è stata registrata, e il modulo resta aperto con
      // dentro ciò che il genitore ha scritto.
      setErr(t('comunicaNonRiuscita'));
      segnala('invio-non-riuscito', undefined, e);
    } finally {
      setInviando(false);
    }
  };

  const annullaComunicata = async (a: AssenzaComunicata) => {
    if (!studentId || !parentId || annullando) return;
    setAnnullando(a.id);
    setMsg('');
    setErr('');
    try {
      const r = await fetch(
        `/api/parent/presenze/comunica-assenza?userId=${parentId}&studentId=${studentId}&data=${a.data}`,
        { method: 'DELETE', headers: { 'x-user-id': parentId } },
      );
      if (!r.ok) {
        const corpo = await r.json();
        setErr(soloCatalogoDaCorpo(corpo, t('comunicaAnnullaNonRiuscito')));
        segnala('annullamento-respinto', r.status);
        return;
      }
      setMsg(t('comunicaAnnullata'));
      onAggiornato?.();
      // Stessa ragione dell'invio: l'annullamento è riuscito, e una rilettura
      // caduta non deve travestirlo da fallimento.
      await caricaComunicate().catch((e) => {
        segnala('elenco-non-letto', undefined, e);
        setElencoRotto(true);
      });
    } catch (e) {
      setErr(t('comunicaAnnullaNonRiuscito'));
      segnala('annullamento-non-riuscito', undefined, e);
    } finally {
      setAnnullando(null);
    }
  };

  /**
   * Il giorno, nel formato della schermata gemella: «12/08/2026».
   *
   * Era «mercoledì 12 agosto» — più discorsivo, e senza L'ANNO. Sembra un
   * dettaglio e non lo è: l'anno è il dato per cui la riga esiste. Un genitore
   * che sceglie il giorno a mano e sbaglia l'anno (il campo è mascherato e
   * accetta `gg/mm/aaaa`) non ha, in tutta la schermata, nessun modo di
   * accorgersene. E soprattutto è il formato che l'altra schermata usa già: con
   * due figli di grado diverso lo stesso elenco si leggeva in due modi.
   * `T12:00:00` e non `T00:00:00`: a mezzanotte UTC il giorno italiano è ancora
   * quello prima per una parte dell'anno.
   */
  const giorno = (iso: string) => f.dataBreve(`${iso}T12:00:00`) || iso;

  const senzaIdentita = !studentId || !parentId;

  return (
    <section className={`rounded-2xl bg-white p-4 shadow-sm ${className ?? ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-maven text-sm font-semibold text-kidville-ink flex items-center gap-2">
            <CalendarPlus size={16} className="text-kidville-green shrink-0" />
            {t('comunicaTitolo')}
          </h2>
          <p className="font-maven text-xs text-kidville-sub mt-1">{t('comunicaHint')}</p>
        </div>
        <Btn
          variant={aperto ? 'ghost' : 'primary'}
          size="sm"
          onClick={() => { setAperto((v) => !v); setMsg(''); setErr(''); }}
          aria-expanded={aperto}
          // `aria-controls` solo a modulo aperto: puntare a un id che nel DOM non
          // c'è è una violazione di `aria-valid-attr-value` (axe), e da chiuso
          // `aria-expanded` dice già tutto quello che serve sapere.
          aria-controls={aperto ? idModulo : undefined}
          className="shrink-0"
        >
          {aperto ? t('comunicaChiudi') : t('comunicaApri')}
        </Btn>
      </div>

      {aperto && (
        <div id={idModulo} className="mt-3 space-y-3 rounded-2xl bg-kidville-cream p-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={idData} className="font-maven text-xs font-semibold text-kidville-ink">
              {t('comunicaDataLabel')}
            </label>
            {/*
              IL FORMATO NON VIVE PIÙ SOLO NEL SEGNAPOSTO. Questo campo è
              MASCHERATO e accetta unicamente `gg/mm/aaaa`: finché quel formato
              stava scritto solo nel `placeholder`, l'unica istruzione su come
              compilare il campo era anche la meno leggibile della schermata
              (misurata in Chrome: `rgb(143,158,155)` su bianco = 2,79:1, contro i
              4,5:1 di WCAG 1.4.3) — e spariva al primo carattere digitato, che è
              esattamente il momento in cui serve. Ora c'è due volte: nel
              segnaposto, portato in regola con `placeholder-kidville-sub`
              (6,46:1), e in un aiuto PERSISTENTE legato al campo con
              `aria-describedby` — visibile a chi guarda, annunciato a chi ascolta
              (WCAG 3.3.2).
            */}
            <DateField
              id={idData}
              value={data}
              onChange={setData}
              aria-describedby={idDataAiuto}
              className="font-maven w-full rounded-full border border-kidville-line bg-white px-3 py-1.5 text-sm text-kidville-ink placeholder-kidville-sub focus:border-kidville-green focus:outline-none"
            />
            <p id={idDataAiuto} className="font-maven text-xs text-kidville-sub">
              {t('comunicaDataAiuto')}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={idMotivo} className="font-maven text-xs font-semibold text-kidville-ink">
              {t('comunicaMotivoLabel')}
            </label>
            <input
              id={idMotivo}
              type="text"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={t('comunicaMotivoPlaceholder')}
              // `placeholder-kidville-sub`: senza, il segnaposto lo dipinge
              // l'agente utente con `currentColor` al 50% di alfa — 2,79:1 su
              // bianco. Un segnaposto è testo, e 1.4.3 si applica.
              className="font-maven w-full rounded-full border border-kidville-line bg-white px-3 py-1.5 text-sm text-kidville-ink placeholder-kidville-sub focus:border-kidville-green focus:outline-none"
            />
          </div>
          <Btn variant="primary" size="sm" onClick={invia} disabled={inviando || !data || senzaIdentita}>
            {inviando ? t('comunicaInvio') : t('comunicaInvia')}
          </Btn>
        </div>
      )}

      {msg && (
        <p
          ref={refMsg}
          role="status"
          // Raggiungibile dal codice ma NON dal Tab: non aggiunge una tappa
          // all'ordine di navigazione, ci arriva solo chi viene dal comando
          // appena smontato. `outline-none` non toglie l'indicatore, lo
          // SOSTITUISCE con l'anello verde della casa (`focus:`, non
          // `focus-visible:`: il fuoco arriva da codice).
          tabIndex={-1}
          className="mt-3 rounded-2xl bg-kidville-success-soft px-3 py-2 font-maven text-sm text-kidville-success-strong outline-none focus:ring-2 focus:ring-kidville-green"
        >
          {msg}
        </p>
      )}
      {err && (
        <p
          ref={refErr}
          role="alert"
          tabIndex={-1}
          className="mt-3 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong outline-none focus:ring-2 focus:ring-kidville-green"
        >
          {err}
        </p>
      )}

      <h3 className="font-maven text-xs font-semibold text-kidville-ink mt-4">{t('comunicaElencoTitolo')}</h3>
      {/*
        Elenco illeggibile: si dice, e NON si scrive «non hai comunicato assenze».
        Quella frase, con la lettura fallita, sarebbe falsa nel modo peggiore — il
        genitore crederebbe di non aver avvisato nessuno e comunicherebbe due volte.
      */}
      {elencoRotto && (
        <p role="alert" className="mt-1 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
          {t('comunicaElencoNonLetto')}
        </p>
      )}
      {comunicate.length === 0 ? (
        !elencoRotto && <p className="font-maven text-xs text-kidville-sub mt-1">{t('comunicaElencoVuoto')}</p>
      ) : (
        // La riga è la STESSA della schermata dedicata (`/parent/attendance`):
        // un solo componente, non due copie. Vedi `RigaAssenzaComunicata`.
        <ul className="mt-2 space-y-2">
          {comunicate.map((a) => (
            <RigaAssenzaComunicata
              key={a.id}
              giorno={giorno(a.data)}
              motivo={a.giustificazione_testo}
              // Il nome accessibile dice DI QUALE giorno: due comandi identici
              // nell'annuncio e diversi nell'effetto sono WCAG 4.1.2, ed è un
              // difetto che questo repo ha già trovato e corretto altrove.
              etichettaAnnulla={t('comunicaAnnullaAria', { giorno: giorno(a.data) })}
              testoAnnulla={t('comunicaAnnulla')}
              testoAnnullamento={t('comunicaAnnullamento')}
              inCorso={annullando === a.id}
              bloccato={annullando !== null}
              onAnnulla={() => annullaComunicata(a)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
