'use client';

// ─── I video allegati a una comunicazione ─────────────────────────────────────
// Un video NON passa da `/api/news/upload` come una fotografia, e non è una
// scelta di stile: il corpo di una Function su Vercel si ferma intorno ai 4,5 MB
// e qui gli originali arrivano a 2 GB. I byte vanno diritti allo Storage in TUS
// (`@/lib/media/video/upload`), il server converte in una MicroVM, e solo alla
// fine il filmato diventa un allegato di bozza come tutti gli altri.
//
// ⚠️ UN VIDEO CARICATO NON È UN VIDEO PRONTO, e fra le due cose passano minuti.
// Metà di questo componente esiste per quella distinzione: chi ha appena caricato
// deve leggere che il lavoro prosegue sul server e che può chiudere la pagina —
// altrimenti resta lì ad aspettare, oppure se ne va credendo di aver perso tutto.
//
// ⚠️ I VIDEO NON PASSANO DAL GATE DEL CONSENSO FOTO, ed è la decisione del piano
// («consenso foto attuale invariato, video esenti»). Non è un'omissione di questo
// componente: `contieneFoto` guarda la copertina e i nodi `image` del rich-text, e
// un collegamento non è né l'una né gli altri. Per la stessa ragione qui non si
// carica NESSUNA copertina: la copertina resta una fotografia.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Film, Upload, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { BTN_SECONDARY } from '@/components/features/admin/pagamenti/ui';
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';
import { logClient, nomeErrore } from '@/lib/logging/client';
import {
  avanzamentoDaStatoVideo,
  CHIAVI_MESSAGGIO_VIDEO,
  type CodiceMostratoVideo,
  type StatoJobVideo,
} from '@/lib/media/video/contratto';
import {
  accodaCaricamentoVideo,
  caricaVideo,
  creaArchivioCaricamenti,
  jobDaSeguire,
  potaArchivioCaricamenti,
  type ArchivioCaricamentiVideo,
  type DipendenzeCaricamentoVideo,
} from '@/lib/media/video/upload';
import { cx } from '@/lib/ui/cx';

import { urlAllegatoBozzaVideo } from './video/allegato-bozza';
import {
  ACCEPT_VIDEO_NEWS,
  apriIntentoVideoNews,
  confermaIntentoVideoNews,
  leggiStatoIntentoVideoNews,
  preflightVideoNews,
  segnalaVideoCaricato,
  type DipendenzeFlussoVideoNews,
} from './video/flusso';

interface Props {
  userId: string;
  /** La sede della comunicazione: ogni scrittura dichiara la sua. */
  scuolaId: string;
  /** «Tutte le sedi»: l'intento nasce senza plesso e con l'ambito globale. */
  tuttiSedi: boolean;
  /** Il filmato è pronto: l'editor lo collega in fondo al testo dell'articolo. */
  onPronto: (url: string, etichetta: string) => void;
}

/** Le fasi che una persona distingue davvero. Non sono gli stati del server. */
type Fase = 'preparazione' | 'caricamento' | 'in_coda' | 'conversione' | 'pronto' | 'errore';

interface Allegato {
  /** La chiave di idempotenza: identifica il file fra un tentativo e l'altro. */
  chiave: string;
  intentId: string | null;
  jobId: string | null;
  revisione: number;
  fase: Fase;
  /** Byte spediti su byte totali, in percentuale. Solo per la barra. */
  pct: number;
  codice: CodiceMostratoVideo | null;
  /** Il collegamento è già finito nell'articolo? Due righe non le ha chieste nessuno. */
  collegato: boolean;
  /** Veniva da un rientro nella pagina, non da un file scelto adesso. */
  riaperto: boolean;
}

/** Le fasi in cui non c'è più niente da chiedere al server. */
const TERMINALI = new Set<Fase>(['pronto', 'errore']);

/** Ogni quanto si chiede al server a che punto è. Solo mentre qualcuno guarda. */
const RITMO_MS = 5_000;

/** Quanto si aspetta il browser prima di rinunciare a misurare la durata. */
const ATTESA_DURATA_MS = 1_500;

function faseDaStato(stato: StatoJobVideo): Fase {
  switch (stato) {
    case 'awaiting_upload':
      return 'caricamento';
    case 'queued':
      return 'in_coda';
    case 'processing':
      return 'conversione';
    case 'ready':
      return 'pronto';
    default:
      return 'errore';
  }
}

/**
 * La chiave di idempotenza del file.
 *
 * Nasce casuale e vive nell'archivio su IndexedDB accanto ai byte: è ciò che
 * permette di riaprire lo STESSO job invece di crearne un secondo quando la rete
 * cade a metà. Non si costruisce dal nome del file, che è anagrafica di un minore
 * (`recita-di-mario.mov`) e che di qui uscirebbe verso il server in due campi
 * invece che in uno.
 */
function chiaveCaricamento(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // WebView vecchie: `randomUUID` non c'è. Basta che sia unica su questo
  // dispositivo, perché il vincolo è `(proprietario, canale, chiave)`.
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * La durata del filmato, quando il browser sa dirla.
 *
 * Best-effort per scelta: `schemaFileVideoDichiarato` ammette `null` perché la
 * misura vera la fa ffprobe dopo l'upload, e rifiutare un file solo perché il
 * browser non sa dire quanto dura sarebbe un rifiuto ingiusto. Quando invece la
 * sa, sapere SUBITO che un filmato è troppo lungo risparmia a un genitore due
 * gigabyte di rete mobile spesi per un rifiuto.
 */
function misuraDurata(file: File): Promise<number | null> {
  return new Promise((risolvi) => {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      risolvi(null);
      return;
    }
    let indirizzo: string;
    try {
      indirizzo = URL.createObjectURL(file);
    } catch {
      risolvi(null);
      return;
    }
    const video = document.createElement('video');
    let concluso = false;
    const chiudi = (valore: number | null) => {
      if (concluso) return;
      concluso = true;
      clearTimeout(orologio);
      video.removeAttribute('src');
      try {
        URL.revokeObjectURL(indirizzo);
      } catch {
        // Un indirizzo già revocato non è un guasto: non c'è niente da dire e
        // niente da fare. La misura è comunque conclusa.
      }
      risolvi(valore);
    };
    // Un metadato che non arriva non deve tenere fermo il caricamento: dopo
    // l'attesa si prosegue senza durata, che il contratto ammette.
    const orologio = setTimeout(() => chiudi(null), ATTESA_DURATA_MS);
    video.preload = 'metadata';
    video.onloadedmetadata = () => chiudi(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => chiudi(null);
    video.src = indirizzo;
  });
}

export function NewsVideoAllegati({ userId, scuolaId, tuttiSedi, onPronto }: Props) {
  const t = useTranslations('adminComunicazioni');
  const tShared = useTranslations('shared');

  const inputRef = useRef<HTMLInputElement>(null);
  const archivioRif = useRef<ArchivioCaricamentiVideo | null>(null);
  const [allegati, setAllegati] = useState<Allegato[]>([]);
  const [errore, setErrore] = useState<CodiceMostratoVideo | null>(null);

  /**
   * LO SPECCHIO DELLA LISTA.
   *
   * Il battito è una funzione asincrona, non un render: deve poter leggere lo
   * stato di ADESSO e decidere se un filmato è appena diventato pronto. Con la
   * sola `setAllegati` quella decisione finirebbe dentro l'aggiornatore — che
   * React può eseguire due volte — e il collegamento all'articolo verrebbe
   * aggiunto due volte.
   */
  const rif = useRef<Allegato[]>([]);
  const aggiorna = useCallback((f: (prec: Allegato[]) => Allegato[]) => {
    rif.current = f(rif.current);
    setAllegati(rif.current);
  }, []);

  const dipFlusso = useMemo<DipendenzeFlussoVideoNews>(
    () => ({
      // Risolto a ogni chiamata e non catturato: il `fetch` giusto è quello del
      // momento in cui si spedisce.
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
      userId,
    }),
    [userId],
  );

  const etichettaLink = t('videoEtichettaLink');

  /* ── IL BATTITO: a che punto è il server ──────────────────────────────── */

  const battito = useCallback(async () => {
    const intenti = [
      ...new Set(
        rif.current
          .filter((a) => a.intentId !== null && !TERMINALI.has(a.fase))
          .map((a) => a.intentId as string),
      ),
    ];

    for (const intentId of intenti) {
      const esito = await leggiStatoIntentoVideoNews(dipFlusso, intentId);
      if (!esito.ok) {
        aggiorna((prec) =>
          prec.map((a) => (a.intentId === intentId ? { ...a, fase: 'errore', codice: esito.codice } : a)),
        );
        continue;
      }

      for (const job of esito.job) {
        const prima = rif.current.find((a) => a.jobId === job.jobId);
        if (!prima) continue;
        const fase = faseDaStato(job.stato);

        if (fase === 'pronto' && !prima.collegato) {
          const url = urlAllegatoBozzaVideo(userId, job.jobId);
          if (!url) {
            // Non può succedere con un job vero (gli id sono uuid), ma se
            // succedesse il filmato resterebbe pronto e scollegato: è un difetto
            // NOSTRO e non può passare in silenzio.
            logClient({
              livello: 'error',
              evento: 'fetch',
              messaggio: 'video-news-allegato-senza-indirizzo',
              route: '/admin/news',
              campi: { esito: 'url-nullo' },
            });
            aggiorna((prec) =>
              prec.map((a) =>
                a.jobId === job.jobId ? { ...a, fase: 'errore', codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' } : a,
              ),
            );
            continue;
          }
          aggiorna((prec) =>
            prec.map((a) => (a.jobId === job.jobId ? { ...a, fase: 'pronto', pct: 100, codice: null, collegato: true } : a)),
          );
          onPronto(url, etichettaLink);
          continue;
        }

        aggiorna((prec) =>
          prec.map((a) =>
            a.jobId === job.jobId && !a.collegato
              ? {
                  ...a,
                  fase,
                  // L'AVANZAMENTO DELLE FASI DI SERVER VIENE DAL SERVER, non da
                  // qui: è `avanzamentoDaStatoVideo`, la scala che il contratto
                  // dichiara. Su un fallimento il server manda `null`, e allora la
                  // barra non si disegna affatto — una barra ferma a metà sopra un
                  // messaggio d'errore continuerebbe a promettere qualcosa.
                  pct: job.avanzamento ?? a.pct,
                  codice: fase === 'errore' ? job.codice : null,
                }
              : a,
          ),
        );
      }
    }
  }, [aggiorna, dipFlusso, etichettaLink, onPronto, userId]);

  /** Il battito vive in un ref: l'orologio non deve ricrearsi a ogni render. */
  const battitoRif = useRef(battito);
  useEffect(() => {
    battitoRif.current = battito;
  });

  const daSeguire = allegati.some((a) => !TERMINALI.has(a.fase) && a.intentId !== null);
  usePollingVisibile(() => battitoRif.current(), RITMO_MS, { attivo: daSeguire });

  /* ── AL RIENTRO NELLA PAGINA ──────────────────────────────────────────── */

  useEffect(() => {
    let vivo = true;
    void (async () => {
      let archivio: ArchivioCaricamentiVideo;
      try {
        archivio = await creaArchivioCaricamenti();
      } catch (err) {
        // L'archivio è già tollerante (ripiega in memoria e lo dice): se anche
        // quello fallisce, il caricamento nuovo resta possibile e la ripresa no.
        logClient({
          livello: 'error',
          evento: 'offline',
          messaggio: `video-news-archivio-non-disponibile: ${nomeErrore(err)}`,
          route: '/admin/news',
        });
        return;
      }
      if (!vivo) return;
      archivioRif.current = archivio;

      const dip: DipendenzeCaricamentoVideo = { archivio, intestazioni: () => ({}) };
      // La potatura non è un di più: senza, l'unico modo che ha un deposito di
      // Blob da due gigabyte di sparire è che il browser sfratti tutto.
      await potaArchivioCaricamenti(dip);
      const seguire = (await jobDaSeguire(dip)).filter((j) => j.canale === 'news');
      if (!vivo || seguire.length === 0) return;

      aggiorna((prec) => [
        ...prec,
        ...seguire
          .filter((j) => !prec.some((a) => a.jobId === j.jobId))
          .map<Allegato>((j) => ({
            chiave: j.jobId,
            intentId: j.intentId,
            jobId: j.jobId,
            revisione: 1,
            fase: 'conversione',
            pct: avanzamentoDaStatoVideo('queued') ?? 0,
            codice: null,
            collegato: false,
            riaperto: true,
          })),
      ]);
      void battitoRif.current();
    })();
    return () => {
      vivo = false;
    };
  }, [aggiorna]);

  /* ── IL GIRO DI UN VIDEO NUOVO ────────────────────────────────────────── */

  const avvia = useCallback(
    async (file: File) => {
      setErrore(null);

      const durata = await misuraDurata(file);
      const pre = preflightVideoNews(file, durata);
      if (!pre.ok) {
        // Il rifiuto avviene QUI, prima che parta un solo byte: il contrario
        // costerebbe a un genitore due gigabyte di rete mobile per sentirsi dire
        // la stessa cosa dieci minuti dopo.
        setErrore(pre.codice);
        return;
      }

      const chiave = chiaveCaricamento();
      aggiorna((prec) => [
        ...prec,
        {
          chiave,
          intentId: null,
          jobId: null,
          revisione: 1,
          fase: 'preparazione',
          pct: 0,
          codice: null,
          collegato: false,
          riaperto: false,
        },
      ]);

      const fallisci = (codice: CodiceMostratoVideo) =>
        aggiorna((prec) => prec.map((a) => (a.chiave === chiave ? { ...a, fase: 'errore', codice } : a)));

      const apertura = await apriIntentoVideoNews(dipFlusso, {
        scuolaId: tuttiSedi ? null : scuolaId,
        ambitoGlobale: tuttiSedi,
        chiaveIdempotenza: chiave,
        file,
        mime: pre.mime,
        durataSecondi: durata,
      });
      if (!apertura.ok) {
        fallisci(apertura.codice);
        return;
      }

      const archivio = archivioRif.current ?? (await creaArchivioCaricamenti());
      archivioRif.current = archivio;
      // La firma è di QUESTO job e scade: si chiede al momento di spedire, e non
      // si conserva accanto ai byte (sarebbe una credenziale su IndexedDB).
      const dip: DipendenzeCaricamentoVideo = {
        archivio,
        intestazioni: () => ({ 'x-signature': apertura.firma }),
      };

      const messo = await accodaCaricamentoVideo(dip, {
        jobId: apertura.jobId,
        intentId: apertura.intentId,
        canale: 'news',
        chiaveIdempotenza: apertura.chiaveIdempotenza,
        coordinate: apertura.coordinate,
        file,
      });
      if (!messo.ok) {
        fallisci(messo.codice);
        return;
      }

      aggiorna((prec) =>
        prec.map((a) =>
          a.chiave === chiave
            ? { ...a, intentId: apertura.intentId, jobId: apertura.jobId, revisione: apertura.revisione, fase: 'caricamento' }
            : a,
        ),
      );

      const esito = await caricaVideo(dip, apertura.jobId, {
        alProgresso: (fatti, totali) => {
          const pct = totali > 0 ? Math.min(100, Math.round((fatti / totali) * 100)) : 0;
          aggiorna((prec) => prec.map((a) => (a.chiave === chiave ? { ...a, pct } : a)));
        },
      });

      if (esito.esito !== 'caricato') {
        // `interrotto` non è un fallimento: i byte restano sul dispositivo e la
        // riga è ripescabile. Ma la persona deve saperlo, non indovinarlo.
        fallisci(
          ('codice' in esito && esito.codice) || 'VIDEO_OPERAZIONE_NON_RIUSCITA',
        );
        return;
      }

      const segnalato = await segnalaVideoCaricato(dipFlusso, apertura.intentId, apertura.jobId, {
        byte: file.size,
        mime: pre.mime,
      });
      if (!segnalato.ok) {
        fallisci(segnalato.codice);
        return;
      }

      // LA CONFERMA È L'ISTANTE IN CUI CI SI PUÒ ANDARE. Senza, l'intento
      // resterebbe in attesa e il video non verrebbe mai convertito: chi chiude
      // la pagina troverebbe un filmato fermo per sempre, senza saperlo.
      const confermato = await confermaIntentoVideoNews(dipFlusso, apertura.intentId, apertura.revisione);
      if (!confermato.ok) {
        fallisci(confermato.codice);
        return;
      }

      // La barra passa dalla scala dei BYTE a quella delle FASI: i due numeri
      // misurano cose diverse, e tenere il 100 % del trasporto mentre la
      // conversione non è iniziata direbbe «finito» di un lavoro appena entrato in
      // coda. Il valore è quello del contratto, non un numero scelto qui.
      aggiorna((prec) =>
        prec.map((a) =>
          a.chiave === chiave
            ? { ...a, fase: 'conversione', pct: avanzamentoDaStatoVideo('queued') ?? 0 }
            : a,
        ),
      );
      void battitoRif.current();
    },
    [aggiorna, dipFlusso, scuolaId, tuttiSedi],
  );

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    void avvia(file);
  };

  const togli = (chiave: string) => {
    aggiorna((prec) => prec.filter((a) => a.chiave !== chiave));
  };

  /* ── COSA SI LEGGE ────────────────────────────────────────────────────── */

  const testoFase = (a: Allegato): string => {
    switch (a.fase) {
      case 'preparazione':
        return t('videoStatoPreparazione');
      case 'caricamento':
        return t('videoStatoCaricamento', { pct: a.pct });
      case 'in_coda':
        return t('videoStatoInCoda');
      case 'conversione':
        return t('videoStatoConversione');
      case 'pronto':
        return t('videoStatoPronto');
      case 'errore':
        return tShared(CHIAVI_MESSAGGIO_VIDEO[a.codice ?? 'VIDEO_OPERAZIONE_NON_RIUSCITA']);
    }
  };

  const labelCls = 'mb-1.5 block font-maven text-xs font-bold uppercase tracking-wide text-kidville-sub';

  return (
    <div className="mt-3 rounded-card border-[1.5px] border-kidville-line bg-kidville-cream/40 p-3.5">
      <span className={labelCls}>
        <Film size={13} strokeWidth={2.5} className="mr-1 inline align-[-2px]" />
        {t('videoAllegatiTitolo')}
      </span>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_VIDEO_NEWS}
        onChange={onFile}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-2 rounded-pill border-[1.5px] border-dashed border-kidville-line bg-kidville-white px-4 py-2.5 font-maven text-sm font-bold text-kidville-green transition-colors hover:border-kidville-green disabled:opacity-50"
      >
        <Upload size={15} strokeWidth={2} /> {t('videoAggiungi')}
      </button>

      <p className="mt-2 font-maven text-[11px] text-kidville-sub">{t('videoNota')}</p>
      <p className="font-maven text-[11px] text-kidville-sub">{t('videoSoloNelTesto')}</p>

      {errore && (
        <p role="alert" className="mt-2 font-maven text-xs text-kidville-error-strong">
          {tShared(CHIAVI_MESSAGGIO_VIDEO[errore])}
        </p>
      )}

      {allegati.some((a) => a.riaperto) && (
        <p className="mt-3 font-maven text-xs text-kidville-sub">{t('videoRiapertura')}</p>
      )}

      {allegati.length > 0 && (
        <ul className="mt-3 space-y-2">
          {allegati.map((a) => (
            <li
              key={a.chiave}
              className="flex items-center gap-3 rounded-input border border-kidville-line bg-kidville-white px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                {/* `alert` quando è andata male, `status` mentre procede: un
                    avanzamento che interrompe lo screen reader a ogni punto
                    percentuale è rumore, un fallimento che non lo interrompe
                    passa inosservato. */}
                <span
                  role={a.fase === 'errore' ? 'alert' : 'status'}
                  className={cx(
                    'block font-maven text-xs',
                    a.fase === 'errore' ? 'text-kidville-error-strong' : 'text-kidville-ink',
                  )}
                >
                  {testoFase(a)}
                </span>
                {(a.fase === 'caricamento' || a.fase === 'conversione' || a.fase === 'in_coda') && (
                  <span
                    role="progressbar"
                    aria-valuenow={a.pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={t('videoAllegatiTitolo')}
                    className="mt-1 block h-1.5 w-full overflow-hidden rounded-pill bg-kidville-cream"
                  >
                    <span
                      className="block h-full rounded-pill bg-kidville-green transition-[width]"
                      style={{ width: `${a.pct}%` }}
                    />
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => togli(a.chiave)}
                className={cx(BTN_SECONDARY, 'shrink-0')}
                aria-label={t('videoTogli')}
              >
                <X size={14} /> {t('videoTogli')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
