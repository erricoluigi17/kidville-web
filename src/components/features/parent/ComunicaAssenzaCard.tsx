'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarPlus } from 'lucide-react';
import { useDateFormat } from '@/lib/i18n/date';
import { Btn } from '@/components/ui/Btn';
import { RigaAssenzaComunicata } from '@/components/features/parent/RigaAssenzaComunicata';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { FUOCO_ESITO } from '@/lib/ui/fuoco';
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
  /** Le frasi condivise con la schermata gemella: namespace `parentAssenze`. */
  const ta = useTranslations('parentAssenze');
  const f = useDateFormat();
  const uid = useId();
  const idData = `comunica-assenza-data-${uid}`;
  const idDataAiuto = `comunica-assenza-data-aiuto-${uid}`;
  const idMotivo = `comunica-assenza-motivo-${uid}`;
  const idMotivoNota = `comunica-assenza-motivo-nota-${uid}`;
  const idModulo = `comunica-assenza-modulo-${uid}`;

  /** «Oggi» nel fuso dell'istituto: è anche il PAVIMENTO del campo del giorno. */
  const oggi = oggiFiscaleISO();

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
   * L'elenco non è ancora stato letto — che NON è «letto e vuoto».
   *
   * Fino al 2026-08-07 i due stati erano lo stesso `useState([])`, e il render
   * trattava `length === 0` come «non ne hai»: aprendo la pagina, per tutta la
   * durata della GET (≈2s sul server di collaudo, di più su 3G o all'avvio
   * dell'app nativa), la card affermava «Non hai comunicato assenze per i
   * prossimi giorni» a un genitore che ne aveva due — e che quindi poteva
   * ricomunicarle. Il ciclo 1 aveva modellato il guasto di lettura
   * (`elencoRotto`) e non l'attesa: sono tre stati, e ne mancava uno.
   * La schermata sorella lo modella dal ciclo 1 (`caricandoElenco`).
   */
  const [caricando, setCaricando] = useState(true);
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
      // L'attesa finisce QUI, e in tutti i modi in cui può finire — risposta
      // buona, rifiuto, rete caduta (l'eccezione nasce dentro il `try`, quindi
      // il `finally` gira prima che risalga a chi chiama). Lo spegnimento sta
      // dopo un `await`, che è ciò che `react-hooks/set-state-in-effect`
      // pretende: prima del primo await questa funzione non tocca lo stato.
      setCaricando(false);
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

  /**
   * La comunicazione GIÀ ARCHIVIATA per il giorno scelto — e la ragione per cui
   * il campo «Motivo» non riparte mai da vuoto su un giorno che un motivo ce
   * l'ha. Il perché per esteso sta nella pagina gemella
   * (`parent/attendance/page.tsx`, `giaComunicata`): in due parole, il campo è
   * facoltativo, il client lo mandava comunque vuoto e la route lo normalizzava
   * a NULL sull'UPDATE — cancellando un dato sanitario di un minore per il solo
   * fatto che non era stato riscritto.
   */
  const giaComunicata = comunicate.find((a) => a.data === data) ?? null;

  /**
   * Cambia il giorno e riallinea il motivo a QUEL giorno. Non azzera ciò che il
   * genitore ha digitato se né il giorno lasciato né quello scelto hanno una
   * comunicazione in archivio: correggere la data non deve costare il testo.
   */
  const cambiaGiorno = (giorno: string) => {
    const partenza = comunicate.find((a) => a.data === data);
    const arrivo = comunicate.find((a) => a.data === giorno);
    setData(giorno);
    if (arrivo || partenza) setMotivo(arrivo?.giustificazione_testo ?? '');
  };

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
      // «Comunicata» e «aggiornata» sono due fatti diversi: il secondo ha appena
      // sovrascritto ciò che c'era, motivo compreso. Si decide con l'elenco
      // ancora quello di PRIMA della rilettura, che è l'unico momento in cui la
      // differenza esiste ancora.
      setMsg(giaComunicata ? ta('aggiornataTitolo') : t('comunicaFatta'));
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
          {/* È anche l'ISTRUZIONE del campo del giorno: il campo la referenzia
              con `aria-describedby` (WCAG 3.3.2). Scritta UNA volta — ripeterla
              identica otto righe più giù, sotto il campo, sarebbe la stessa
              frase due volte nella stessa card. Resta a schermo sia col modulo
              aperto sia chiuso, quindi è persistente per davvero. */}
          <p id={idDataAiuto} className="font-maven text-xs text-kidville-sub mt-1">{t('comunicaHint')}</p>
        </div>
        <Btn
          variant={aperto ? 'ghost' : 'primary'}
          size="sm"
          onClick={() => {
            const apre = !aperto;
            setAperto(apre);
            // APRIRE il modulo è un riallineamento come cambiare giorno: dopo un
            // invio riuscito il campo viene svuotato e il modulo chiuso, quindi
            // riaprendolo sullo stesso giorno — che ORA una comunicazione ce
            // l'ha — il motivo sarebbe vuoto, e il prossimo invio lo
            // cancellerebbe. Il campo mostra sempre ciò che risulta archiviato.
            if (apre) setMotivo(comunicate.find((a) => a.data === data)?.giustificazione_testo ?? '');
            setMsg('');
            setErr('');
          }}
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
              LO STESSO CAMPO DELLA SCHERMATA GEMELLA — e la ragione per cui è
              questo e non l'altro.

              Qui c'era un `DateField`: un `type="text"` mascherato `gg/mm/aaaa`,
              con l'aiuto persistente sul formato. La pagina di nido·infanzia
              usava (e usa) l'`<input type="date">` nativo. Due campi diversi per
              la stessa funzione, e un genitore con due figli di grado diverso li
              vedeva tutti e due.

              La coerenza si è fatta portando QUESTO sul campo nativo, e non il
              contrario, per una misura che esiste già: il collaudo iOS del
              2026-08-07 (vedi `refIntro` in `parent/attendance/page.tsx`) ha
              stabilito che su telefono il selettore nativo è il gesto migliore —
              si tocca invece di digitare — e che `min` dà un PAVIMENTO che un
              campo mascherato non può imporre. Ribaltare quella decisione una
              settimana dopo, senza una misura nuova, sarebbe stato un
              ping-pong, non una correzione.

              Guadagno che il rilievo non chiedeva: questa card non aveva NESSUN
              pavimento. Si poteva digitare una data passata e scoprirlo solo dal
              rifiuto del server.

              L'aiuto persistente RESTA (WCAG 3.3.2), ma dice ciò che è vero di
              questo controllo: non il formato — su un campo nativo lo disegna il
              sistema, e dichiararlo sarebbe falso appena il browser è in inglese
              — bensì l'intervallo ammesso, che è esattamente ciò che `min`
              impone.
            */}
            <input
              id={idData}
              type="date"
              value={data}
              min={oggi}
              onChange={(e) => cambiaGiorno(e.target.value)}
              aria-describedby={idDataAiuto}
              className="font-maven w-full rounded-full border border-kidville-line bg-white px-3 py-1.5 text-sm text-kidville-ink placeholder-kidville-sub focus:border-kidville-green focus:outline-none"
            />
          </div>
          {/* Il giorno scelto è GIÀ stato comunicato: inviando si sovrascrive,
              motivo compreso. Senza questa riga il modulo si comporta come se
              stesse creando qualcosa. */}
          {giaComunicata && (
            <p role="status" className="rounded-2xl border border-kidville-warn/30 bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn">
              {ta('giaComunicataAvviso')}
            </p>
          )}
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
              aria-describedby={idMotivoNota}
              // `placeholder-kidville-sub`: senza, il segnaposto lo dipinge
              // l'agente utente con `currentColor` al 50% di alfa — 2,79:1 su
              // bianco. Un segnaposto è testo, e 1.4.3 si applica.
              className="font-maven w-full rounded-full border border-kidville-line bg-white px-3 py-1.5 text-sm text-kidville-ink placeholder-kidville-sub focus:border-kidville-green focus:outline-none"
            />
            {/* Il campo sollecita un dato di salute di un MINORE (art. 9 GDPR):
                chi lo legge, per quanto resta e dove sta l'informativa vanno
                detti QUI, nell'istante in cui il dato si scrive — non solo
                nell'informativa generale, che nessuno sta leggendo mentre
                digita «febbre». Stesse parole della schermata gemella. */}
            <p id={idMotivoNota} className="font-maven text-xs text-kidville-sub">
              {ta('motivoPrivacy')}{' '}
              <a href="/privacy" target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                {ta('motivoPrivacyLink')}
              </a>
            </p>
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
          className={`mt-3 rounded-2xl bg-kidville-success-soft px-3 py-2 font-maven text-sm text-kidville-success-strong ${FUOCO_ESITO}`}
        >
          {msg}
        </p>
      )}
      {err && (
        <p
          ref={refErr}
          role="alert"
          tabIndex={-1}
          className={`mt-3 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong ${FUOCO_ESITO}`}
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
      {/* L'ATTESA si dichiara, e viene PRIMA di tutto il resto: finché la
          risposta non è arrivata non si sa né che l'elenco è vuoto né che è
          rotto, e dirlo lo stesso sarebbe inventare. */}
      {caricando && (
        <p role="status" className="font-maven text-xs text-kidville-sub mt-1">{t('caricamento')}</p>
      )}
      {!caricando && elencoRotto && (
        <p role="alert" className="mt-1 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
          {t('comunicaElencoNonLetto')}
        </p>
      )}
      {!caricando && !elencoRotto && comunicate.length === 0 && (
        <p className="font-maven text-xs text-kidville-sub mt-1">{t('comunicaElencoVuoto')}</p>
      )}
      {!caricando && comunicate.length > 0 && (
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
