'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { FolderLock, Upload, Download, ShieldAlert, FileText, ChevronDown, ChevronRight, Trash2, ArrowLeft } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { DateField } from '@/components/ui/DateField';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { apriDocumento, scaricaDocumento } from '@/lib/native/scarica';
import { avvisoDocumento } from '@/lib/native/documento-genitore';
import { isNativeApp } from '@/lib/push/native-register';
import { fileDocumentoFascicolo, nomeFilePagellaFascicolo } from '@/lib/primaria/fascicolo-scarico';
import { AzioniDocumentoFascicolo } from '@/components/features/primaria/fascicolo/AzioniDocumentoFascicolo';
import { CestinoFascicolo } from '@/components/features/primaria/fascicolo/CestinoFascicolo';
import {
  LIMITE_UPLOAD_FASCICOLO_BYTE as LIMITE_UPLOAD_BYTE,
  TIPI_DOCUMENTO_FASCICOLO,
  puoGestireDocumentoUi,
} from '@/lib/primaria/fascicolo-ui';

interface Alunno { id: string; nome: string; cognome: string }
interface Documento {
  id: string; document_type: string; descrizione: string | null; file_name: string | null; expiry_date: string | null; created_at: string;
  /** Chi l'ha caricato: con il ruolo decide se si mostrano Modifica/Sostituisci/Elimina. */
  caricato_da?: string | null;
}
interface PagellaVoce {
  scrutinioId: string; annoScolastico: string; periodoNome: string;
  dataChiusura: string | null; dataPubblicazione: string | null;
}
interface AnnoPagelle { annoScolastico: string; pagelle: PagellaVoce[] }

// L'etichetta del tipo documento è tradotta al render via t(`fascicoloTipo_${v}`):
// l'array tiene solo il valore stabile inviato all'API (`documentType`). Una sola
// lista con la modale «Modifica» (`TIPI_DOCUMENTO_FASCICOLO`).
const TIPI: { v: string }[] = TIPI_DOCUMENTO_FASCICOLO.map((v) => ({ v }));

export default function FascicoloPage() {
  const t = useTranslations('teacherPrimaria');
  const ts = useTranslations('shared');
  const f = useDateFormat();
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [alunnoId, setAlunnoId] = useState('');
  /** L'alunno scelto ADESSO, per scartare le risposte arrivate dopo un cambio. */
  const alunnoCorrenteRef = useRef('');
  /**
   * `null` = lettura in volo: a schermo «Caricamento…», NON «Nessun documento» (su
   * rete lenta un docente ci crederebbe e ricaricherebbe un PEI che c'è già).
   */
  const [docs, setDocs] = useState<Documento[] | null>(null);
  /**
   * L'ultima lettura dei documenti è fallita: a schermo un avviso, NON «Nessun
   * documento» (sarebbe un fascicolo vuoto finto) né l'elenco di prima (righe forse
   * già eliminate, con i loro bottoni attivi).
   */
  const [erroreLetturaDocs, setErroreLetturaDocs] = useState(false);
  const [denied, setDenied] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState('pei');
  const [descrizione, setDescrizione] = useState('');
  const [expiry, setExpiry] = useState('');
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState('');
  const [finalita, setFinalita] = useState('');
  const finalitaRef = useRef('');
  const fileRef = useRef<HTMLInputElement>(null);
  // Foto scattata con la fotocamera nativa (additiva all'<input> che accetta anche
  // PDF). Se presente vince sul file dell'input in `carica`; l'input la azzera se
  // l'utente sceglie invece un file dal dispositivo.
  const [fotoScattata, setFotoScattata] = useState<File | null>(null);

  // Gestione dei documenti (F2): chi guarda, quale vista, l'esito dell'ultima azione.
  // `ruolo`/`meUserId` da `/api/primaria/me`; finché non arrivano nessun bottone di
  // gestione compare (fail-closed): il gate vero resta sul server.
  const [ruolo, setRuolo] = useState<string | null>(null);
  const [meUserId, setMeUserId] = useState<string | null>(null);
  const [meRisolto, setMeRisolto] = useState(false);
  const [vista, setVista] = useState<'documenti' | 'cestino'>('documenti');
  const [versioneDocs, setVersioneDocs] = useState(0);
  const [esitoGestione, setEsitoGestione] = useState<{ testo: string; tipo: 'ok' | 'errore' } | null>(null);
  /** Getter STABILE della finalità: le modali e il cestino la leggono al momento dell'invio. */
  const leggiFinalita = useCallback(() => finalitaRef.current, []);

  // Pagelle
  const [anniPagelle, setAnniPagelle] = useState<AnnoPagelle[]>([]);
  const [anniAperti, setAnniAperti] = useState<Set<string>>(new Set());

  // Apertura e scarico (F3). Gli id in volo: un secondo tocco durante un'apertura
  // nell'app lancerebbe una seconda anteprima (o un secondo foglio) sullo stesso file
  // in Cache, che il sistema rifiuta — e il suo «non riuscito» smentirebbe il primo.
  const aperturaInCorsoRef = useRef<Set<string>>(new Set());
  const [aperturaInCorso, setAperturaInCorso] = useState<string[]>([]);
  const pagellaInCorsoRef = useRef<Set<string>>(new Set());
  const [pagellaInCorso, setPagellaInCorso] = useState<string[]>([]);
  /** L'avviso dell'ultimo scarico di pagella non riuscito (nell'app). */
  const [avvisoPagella, setAvvisoPagella] = useState<string | null>(null);

  // `t` NON è una dipendenza: il testo di ripiego si traduce al render (`''` = ripiego).
  // Con `t` fra le dipendenze, un traduttore con identità nuova a ogni render (quello
  // dei test, ma basta un provider rimontato) rileggeva gli alunni in un giro senza fine.
  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) { setAlunni(d.data.alunni ?? []); setApiError(null); }
        else setApiError(typeof d.error === 'string' ? d.error : '');
      })
      .catch((err) => {
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `fascicolo-alunni-non-caricati: ${nomeErrore(err)}`,
          route: typeof window !== 'undefined' ? window.location.pathname : undefined,
        });
        setApiError('');
      });
  }, [sectionId, userId]);

  const loadDocs = useCallback(async () => {
    if (!alunnoId) return;
    const richiesto = alunnoId;
    const fz = finalitaRef.current ? `&finalita=${encodeURIComponent(finalitaRef.current)}` : '';
    const route = typeof window !== 'undefined' ? window.location.pathname : undefined;
    /**
     * Lettura dei documenti fallita: non è un fascicolo vuoto, e l'elenco a schermo
     * (magari di prima di un'eliminazione) non è più affidabile. Niente dati nel log.
     */
    const letturaFallita = (motivo: string) => {
      // Il log viene PRIMA della guardia: un guasto su una lettura resa vecchia da un
      // cambio di alunno si registra comunque, a livello `warn`: lo stato non si tocca,
      // e `info` il canale client non lo accetta (`/api/logs` prende solo warn/error).
      // La guardia protegge solo lo schermo del nuovo alunno.
      if (alunnoCorrenteRef.current !== richiesto) {
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `fascicolo-documenti-non-caricati-scartata: ${motivo} (risposta di un alunno non più selezionato)`, route });
        return;
      }
      logClient({ livello: 'error', evento: 'fetch', messaggio: `fascicolo-documenti-non-caricati: ${motivo}`, route });
      setErroreLetturaDocs(true);
    };

    // Gli errori si prendono col `.catch` della promessa, NON con un `try/catch`
    // attorno agli await: quello fa scattare `react-hooks/set-state-in-effect`
    // (il `catch` è raggiungibile in modo sincrono dall'effetto che chiama `loadDocs`).
    // Rete, o un 5xx in HTML su cui `r.json()` lancia: finiscono entrambi qui.
    const risposta = await fetch(`/api/primaria/fascicolo?alunnoId=${alunnoId}&userId=${userId}${fz}`)
      .then(async (r) => ({ status: r.status, d: r.status === 403 ? null : await r.json() }))
      .catch((e: unknown) => { letturaFallita(nomeErrore(e)); return null; });
    if (!risposta) return;
    // Una risposta arrivata DOPO un cambio di alunno è dell'alunno di prima: non
    // deve finire sotto il nome del nuovo, con i suoi bottoni di gestione attivi.
    if (alunnoCorrenteRef.current !== richiesto) return;
    if (risposta.status === 403) {
      setDenied(true);
      setErroreLetturaDocs(false);
      setDocs([]);
      return;
    }
    setDenied(false);
    const d = risposta.d;
    if (!d?.success) {
      // Lettura rifiutata (es. 500 `LETTURA_FALLITA`). Solo un codice in forma di
      // codice: nel log non entra prosa del server.
      letturaFallita(typeof d?.codice === 'string' && /^[A-Z0-9_]{1,64}$/.test(d.codice) ? d.codice : `http-${risposta.status}`);
      return;
    }
    setDocs(d.data);
    setErroreLetturaDocs(false);

    // Le pagelle: una loro lettura fallita non oscura i documenti già arrivati.
    const dp = await fetch(`/api/primaria/fascicolo/pagelle?alunnoId=${alunnoId}&userId=${userId}`)
      .then((rp) => rp.json())
      .catch((e: unknown) => {
        // Sempre un log: `warn` se l'alunno è cambiato nel frattempo (risposta scartata).
        if (alunnoCorrenteRef.current === richiesto) {
          logClient({ livello: 'error', evento: 'fetch', messaggio: `fascicolo-pagelle-non-caricate: ${nomeErrore(e)}`, route });
        } else {
          logClient({ livello: 'warn', evento: 'fetch', messaggio: `fascicolo-pagelle-non-caricate-scartata: ${nomeErrore(e)} (risposta di un alunno non più selezionato)`, route });
        }
        return null;
      });
    if (alunnoCorrenteRef.current !== richiesto) return;
    if (dp?.success) {
      setAnniPagelle(dp.data ?? []);
      // Apri automaticamente l'anno più recente
      if (dp.data?.length > 0) setAnniAperti(new Set([dp.data[0].annoScolastico]));
    }
  }, [alunnoId, userId]);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  useEffect(() => {
    let vivo = true;
    fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!vivo) return;
        if (d?.success) {
          if (typeof d.data?.ruolo === 'string') setRuolo(d.data.ruolo);
          if (typeof d.data?.userId === 'string') setMeUserId(d.data.userId);
        }
        setMeRisolto(true);
      })
      .catch((err) => {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `fascicolo-ruolo-non-risolto: ${nomeErrore(err)}`,
          route: typeof window !== 'undefined' ? window.location.pathname : undefined,
        });
        if (vivo) setMeRisolto(true);
      });
    return () => { vivo = false; };
  }, [userId]);

  /** Dopo modifica, sostituzione, eliminazione o ripristino: si rileggono documenti e cestino. */
  const dopoGestione = useCallback(() => {
    loadDocs();
    setVersioneDocs((v) => v + 1);
  }, [loadDocs]);

  const mostraEsito = useCallback((testo: string, tipo: 'ok' | 'errore') => setEsitoGestione({ testo, tipo }), []);

  /**
   * L'identità con cui confrontare `caricato_da`: quella che il SERVER ha risolto
   * (`/api/primaria/me`, sessione prima di tutto). Se `/me` non risponde si ripiega
   * sull'identità della pagina; prima della risposta, nessuna (fail-closed).
   */
  const identitaGestione = meRisolto ? (meUserId ?? userId) : null;

  const toggleAnno = (anno: string) => setAnniAperti((prev) => {
    const next = new Set(prev);
    if (next.has(anno)) next.delete(anno); else next.add(anno);
    return next;
  });

  const carica = async () => {
    setMsg('');
    const file = fotoScattata ?? fileRef.current?.files?.[0];
    if (!alunnoId) { setMsg(t('fascicoloMsgSelezionaAlunno')); return; }
    if (!file) { setMsg(t('fascicoloMsgSelezionaFile')); return; }
    if (!userId) { setMsg(t('comuneIdentitaNonRisolta')); return; }
    // Il collo di bottiglia NON è MAX_SIZE della route: è il limite di body
    // della funzione serverless. Dirlo subito, invece che dopo venti secondi di
    // upload su rete mobile e un errore che non arriva.
    if (file.size > LIMITE_UPLOAD_BYTE) { setMsg(t('fascicoloMsgFileTroppoGrande')); return; }
    setUploading(true);
    // try/catch/finally: senza, un 413 (che risponde HTML, non JSON) faceva
    // LANCIARE `r.json()`, quindi `setUploading(false)` non veniva mai eseguito
    // e lo spinner restava appeso per sempre, senza alcun messaggio.
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('alunnoId', alunnoId);
      fd.append('documentType', documentType);
      if (descrizione) fd.append('descrizione', descrizione);
      if (expiry) fd.append('expiryDate', expiry);
      if (finalitaRef.current) fd.append('finalita', finalitaRef.current);
      fd.append('userId', userId);
      const r = await fetch(`/api/primaria/fascicolo?userId=${userId}`, { method: 'POST', headers: { 'x-user-id': userId }, body: fd });
      const d = await r.json().catch(() => ({} as { error?: string }));
      if (!r.ok) {
        setMsg(r.status === 413 ? t('fascicoloMsgFileTroppoGrande') : (d.error || t('comuneErrore')));
        return;
      }
      setMsg(t('fascicoloDocumentoCaricato'));
      setDescrizione(''); setExpiry('');
      if (fileRef.current) fileRef.current.value = '';
      setFotoScattata(null);
      loadDocs();
    } catch {
      // Nessun dato nel messaggio: è il fascicolo di un minore.
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'fascicolo-upload-fallito', route: '/teacher/primaria/fascicolo' });
      setMsg(t('fascicoloMsgUploadFallito'));
    } finally {
      setUploading(false);
    }
  };

  /**
   * «Apri» un documento (F3). La route dà un indirizzo FIRMATO a tempo (60 s, altra
   * origine), poi l'helper unico `apriDocumento`: nell'app 1.1 il file va in Cache
   * con `FileTransfer` e si apre nell'anteprima di sistema DENTRO l'app — prima era
   * un `window.open` dopo un `await`, che nella WebView non apriva niente. Sul web è
   * lo stesso `window.open` di prima (con in più lo scarico se il browser blocca la
   * scheda). L'esito lo registra l'helper, successo compreso.
   */
  const apriDocumentoFascicolo = async (doc: Documento) => {
    if (aperturaInCorsoRef.current.has(doc.id)) return;
    aperturaInCorsoRef.current.add(doc.id);
    setAperturaInCorso(Array.from(aperturaInCorsoRef.current));
    // L'alunno di QUESTO tocco: un esito arrivato dopo un cambio non va sotto l'altro.
    const richiesto = alunnoCorrenteRef.current;
    const route = typeof window !== 'undefined' ? window.location.pathname : undefined;
    try {
      const fz = finalitaRef.current ? `&finalita=${encodeURIComponent(finalitaRef.current)}` : '';
      let indirizzo: { url: string; fileName: string | null } | null = null;
      /** Lo stato HTTP della route, se è arrivata una risposta (anche in HTML). */
      let stato: number | null = null;
      let motivo = '';
      try {
        const r = await fetch(`/api/primaria/fascicolo/file?documentoId=${doc.id}&userId=${userId}${fz}`);
        stato = r.status;
        // Un 5xx in HTML fa lanciare `json()`: finisce nel `catch` qui sotto, con un log.
        const d = await r.json();
        if (r.ok && typeof d?.data?.url === 'string' && d.data.url) {
          indirizzo = { url: d.data.url, fileName: typeof d.data.fileName === 'string' ? d.data.fileName : null };
        } else {
          motivo = `http-${r.status}`;
        }
      } catch (e) {
        motivo = nomeErrore(e);
      }
      // Gli avvisi di QUESTO bottone, tutti nello stesso posto (la sezione Documenti,
      // accanto al tocco): un'apertura riuscita li toglie, e solo loro.
      const avvisiApertura = [
        ts('documentoNonAperto'),
        ts('documentoAppDaAggiornare'),
        t('fascicoloNonAutorizzato'),
        t('fascicoloDownloadNonRiuscito'),
      ];
      if (!indirizzo) {
        // Niente dati nel log: solo lo stato o il nome dell'errore.
        logClient({ livello: 'error', evento: 'fetch', messaggio: `fascicolo-apertura-indirizzo-non-ottenuto: ${motivo}`, route });
        // Il testo dipende dallo STATO, tradotto: mai la prosa del server (sempre in
        // italiano, e in due rami il messaggio grezzo di Storage o di un'eccezione).
        if (alunnoCorrenteRef.current === richiesto) {
          mostraEsito(stato === 403 ? t('fascicoloNonAutorizzato') : t('fascicoloDownloadNonRiuscito'), 'errore');
        }
        return;
      }
      // Il mime prima dall'indirizzo firmato (estensione dal MIME validato), poi dal nome.
      const { nomeFile, mime } = fileDocumentoFascicolo(doc, indirizzo.url, indirizzo.fileName ?? doc.file_name);
      const esito = await apriDocumento({
        sorgente: indirizzo.url,
        nomeFile,
        ...(mime ? { mime } : {}),
        titolo: t('fascicoloDocumento'),
        etichetta: 'fascicolo',
      });
      if (alunnoCorrenteRef.current !== richiesto) return;
      const avviso = avvisoDocumento(esito);
      if (avviso) {
        mostraEsito(avviso === 'aggiorna' ? ts('documentoAppDaAggiornare') : ts('documentoNonAperto'), 'errore');
      } else {
        // Un'apertura riuscita toglie l'avviso di un'apertura precedente — e SOLO quello.
        setEsitoGestione((prec) => (prec && avvisiApertura.includes(prec.testo) ? null : prec));
      }
    } finally {
      aperturaInCorsoRef.current.delete(doc.id);
      setAperturaInCorso(Array.from(aperturaInCorsoRef.current));
    }
  };

  /**
   * La pagella: nell'app 1.1 passa da `scaricaDocumento` — la route è della stessa
   * origine, l'helper la legge con la `fetch` della WebView (coi cookie) e consegna
   * il PDF al foglio «Salva su File». Sul web resta com'era: scheda nuova.
   */
  const scaricaPagella = (scrutinioId: string) => {
    const indirizzo = `/api/primaria/pagella?scrutinioId=${scrutinioId}&alunnoId=${alunnoId}&userId=${userId}`;
    if (!isNativeApp()) {
      window.open(indirizzo, '_blank');
      return;
    }
    const alunnoDelTocco = alunnoId;
    const chiave = `${alunnoDelTocco}:${scrutinioId}`;
    if (pagellaInCorsoRef.current.has(chiave)) return;
    pagellaInCorsoRef.current.add(chiave);
    setPagellaInCorso(Array.from(pagellaInCorsoRef.current));
    // L'helper non lancia mai: il `.then` arriva sempre, e sblocca il bottone.
    void scaricaDocumento({
      sorgente: indirizzo,
      nomeFile: nomeFilePagellaFascicolo(alunnoDelTocco, scrutinioId),
      mime: 'application/pdf',
      titolo: t('fascicoloPagelle'),
      etichetta: 'pagella',
    }).then((esito) => {
      pagellaInCorsoRef.current.delete(chiave);
      setPagellaInCorso(Array.from(pagellaInCorsoRef.current));
      if (alunnoCorrenteRef.current !== alunnoDelTocco) return;
      const avviso = avvisoDocumento(esito);
      setAvvisoPagella(
        avviso === 'aggiorna' ? ts('documentoAppDaAggiornare') : avviso === 'riprova' ? ts('documentoNonSalvato') : null,
      );
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-card bg-white p-5 shadow-sm">
        <h2 className="font-barlow text-lg font-bold text-kidville-ink mb-1 flex items-center gap-2">
          <FolderLock size={18} className="text-kidville-green" /> {t('fascicoloTitolo')}
        </h2>
        {/* Banner conformità: accesso tracciato + finalità (DR) */}
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-kidville-info/20 bg-kidville-info-soft px-3.5 py-3">
          <FolderLock size={15} className="mt-0.5 shrink-0 text-kidville-info" />
          <span className="font-maven text-[11.5px] leading-snug text-kidville-info">
            {t.rich('fascicoloBanner', { strong: (c) => <strong>{c}</strong> })}
          </span>
        </div>

        {apiError !== null && (
          <div className="mb-3 flex items-center gap-2 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error">
            <ShieldAlert size={14} /> {apiError || t('comuneImpossibileCaricareAlunni')}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <select
            value={alunnoId}
            onChange={(e) => {
              // Via subito i documenti e le pagelle dell'alunno di prima: finché la
              // nuova GET non risponde, sotto il nome nuovo non resta niente dell'altro.
              // `null` = in caricamento; e via anche il 403 dell'alunno di prima.
              alunnoCorrenteRef.current = e.target.value;
              setAlunnoId(e.target.value);
              setDocs(null);
              setDenied(false);
              setErroreLetturaDocs(false);
              setAnniPagelle([]);
              setAvvisoPagella(null);
              setEsitoGestione(null);
            }}
            className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm">
            <option value="">{t('comuneAlunnoPlaceholder')}</option>
            {alunni.map((a) => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}
          </select>
          <input
            value={finalita}
            onChange={(e) => { setFinalita(e.target.value); finalitaRef.current = e.target.value; }}
            placeholder={t('fascicoloFinalitaPlaceholder')}
            title={t('fascicoloFinalitaTitle')}
            className="font-maven flex-1 min-w-[12rem] rounded-pill border border-kidville-line px-3 py-2 text-sm"
          />
        </div>

        {alunnoId && denied && (
          <div className="mt-3 flex items-center gap-2 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error">
            <ShieldAlert size={15} /> {t('fascicoloNonAutorizzato')}
          </div>
        )}
      </div>

      {alunnoId && !denied && (
        <>
          {/* ── Pagelle raggruppate per anno scolastico ─────────── */}
          {anniPagelle.length > 0 && (
            <div className="rounded-card bg-white p-5 shadow-sm">
              <h3 className="font-barlow text-base font-bold text-kidville-ink mb-3 flex items-center gap-2">
                <FileText size={16} className="text-kidville-green" /> {t('fascicoloPagelle')}
              </h3>
              <div className="space-y-2">
                {anniPagelle.map((anno) => (
                  <div key={anno.annoScolastico} className="rounded-card border border-kidville-line">
                    <button
                      onClick={() => toggleAnno(anno.annoScolastico)}
                      className="flex w-full items-center justify-between px-4 py-3 font-maven text-sm font-semibold text-kidville-ink"
                    >
                      <span>{t('fascicoloAnnoScolastico', { anno: anno.annoScolastico })}</span>
                      {anniAperti.has(anno.annoScolastico)
                        ? <ChevronDown size={15} className="text-kidville-muted" />
                        : <ChevronRight size={15} className="text-kidville-muted" />}
                    </button>
                    {anniAperti.has(anno.annoScolastico) && (
                      <ul className="divide-y divide-kidville-line border-t border-kidville-line">
                        {anno.pagelle.map((p) => (
                          <li key={p.scrutinioId} className="flex items-center justify-between gap-2 px-4 py-2.5">
                            <div>
                              <p className="font-maven text-sm text-kidville-ink">{p.periodoNome}</p>
                              <p className="font-maven text-xs text-kidville-muted">
                                {t('fascicoloPubblicataIl', { data: p.dataPubblicazione ? f.dataBreve(p.dataPubblicazione) : '—' })}
                              </p>
                            </div>
                            <button
                              onClick={() => scaricaPagella(p.scrutinioId)}
                              disabled={pagellaInCorso.includes(`${alunnoId}:${p.scrutinioId}`)}
                              className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green disabled:opacity-50"
                            >
                              <Download size={13} /> {t('fascicoloApriPdf')}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
              {avvisoPagella && (
                <p role="alert" className="mt-3 font-maven text-sm text-kidville-error">{avvisoPagella}</p>
              )}
            </div>
          )}

          {/* ── Carica documento ────────────────────────────────── */}
          <div className="rounded-card bg-white p-5 shadow-sm">
            <h3 className="font-barlow text-base font-bold text-kidville-ink mb-3">{t('fascicoloCaricaDocumento')}</h3>
            <div className="grid gap-2 md:grid-cols-2">
              <select value={documentType} onChange={(e) => setDocumentType(e.target.value)} className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm">
                {TIPI.map((tipo) => <option key={tipo.v} value={tipo.v}>{t(`fascicoloTipo_${tipo.v}`)}</option>)}
              </select>
              <DateField value={expiry} onChange={setExpiry} aria-label={t('fascicoloScadenzaAria')} className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm" />
            </div>
            <input value={descrizione} onChange={(e) => setDescrizione(e.target.value)} placeholder={t('fascicoloDescrizionePlaceholder')} className="font-maven mt-2 w-full rounded-pill border border-kidville-line px-3 py-2 text-sm" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept="application/pdf,image/*" onChange={() => setFotoScattata(null)} className="font-maven block flex-1 min-w-[12rem] text-sm text-kidville-ink file:mr-3 file:rounded-pill file:border-0 file:bg-kidville-green/10 file:px-4 file:py-1.5 file:text-kidville-green" />
              {/* Nativo: scatta la foto del documento cartaceo. Su web non compare. */}
              <ScattaFotoButton
                onFile={setFotoScattata}
                className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm font-semibold text-kidville-green transition-colors hover:border-kidville-green"
              />
            </div>
            {fotoScattata && <p className="font-maven text-xs mt-1.5 text-kidville-green">📷 {fotoScattata.name}</p>}
            {msg && <p className={`font-maven text-sm mt-2 ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</p>}
            <button onClick={carica} disabled={uploading} className="mt-3 font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
              <Upload size={15} /> {uploading ? t('comuneCaricamento') : t('fascicoloCarica')}
            </button>
          </div>

          {/* ── Documenti ufficiali (PEI/PDP/ecc.) ───────────────── */}
          <div className="rounded-card bg-white p-5 shadow-sm">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-barlow text-base font-bold text-kidville-ink">{t('fascicoloDocumentiUfficiali')}</h3>
              {vista === 'documenti' ? (
                <button
                  type="button"
                  onClick={() => { setVista('cestino'); setEsitoGestione(null); }}
                  className="font-maven inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-3 py-1.5 text-xs text-kidville-ink hover:border-kidville-green"
                >
                  <Trash2 size={13} /> {t('fascicoloCestino')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setVista('documenti'); setEsitoGestione(null); }}
                  className="font-maven inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-3 py-1.5 text-xs text-kidville-ink hover:border-kidville-green"
                >
                  <ArrowLeft size={13} /> {t('fascicoloTornaAiDocumenti')}
                </button>
              )}
            </div>
            {esitoGestione && (
              <p
                role={esitoGestione.tipo === 'errore' ? 'alert' : 'status'}
                className={`mb-3 font-maven text-sm ${esitoGestione.tipo === 'ok' ? 'text-kidville-success' : 'text-kidville-error'}`}
              >
                {esitoGestione.testo}
              </p>
            )}
            {vista === 'cestino' ? (
              // `key`: cambiando alunno il cestino si RIMONTA da vuoto. Senza, restava
              // l'elenco dell'alunno di prima (con i suoi «Ripristina» attivi) finché
              // la nuova GET non rispondeva.
              <CestinoFascicolo
                key={alunnoId}
                alunnoId={alunnoId}
                userId={userId ?? ''}
                finalita={leggiFinalita}
                versione={versioneDocs}
                onRipristinato={dopoGestione}
                onEsito={mostraEsito}
              />
            ) : erroreLetturaDocs ? (
              <p role="alert" className="flex flex-wrap items-center gap-2 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error">
                <ShieldAlert size={14} /> {t('fascicoloErroreLetturaDocumenti')}
                {/* Senza questo bottone l'avviso chiedeva di riprovare senza offrire il modo:
                    riscegliere lo stesso alunno non fa scattare l'onChange, e il cestino non
                    rilegge i documenti. `setDocs(null)`: durante la rilettura compare
                    «Caricamento…», non un fascicolo vuoto finto. */}
                <button
                  type="button"
                  onClick={() => {
                    setErroreLetturaDocs(false);
                    setDocs(null);
                    loadDocs();
                  }}
                  className="rounded-pill border border-kidville-error px-3 py-1 font-maven text-xs font-semibold text-kidville-error hover:bg-kidville-error hover:text-white"
                >
                  {t('fascicoloRiprova')}
                </button>
              </p>
            ) : docs === null ? (
              <p className="font-maven text-sm text-kidville-sub">{t('comuneCaricamento')}</p>
            ) : docs.length === 0 ? (
              <p className="font-maven text-sm text-kidville-muted">{t('fascicoloNessunDocumento')}</p>
            ) : (
              <ul className="divide-y divide-kidville-line">
                {docs.map((doc) => {
                  const nome = doc.file_name || doc.descrizione || t('fascicoloDocumento');
                  const gestibile = !!userId && puoGestireDocumentoUi({ ruolo, caricatoDa: doc.caricato_da, utenteId: identitaGestione });
                  return (
                    <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <div className="min-w-0">
                        <p className="font-maven text-sm font-semibold text-kidville-ink break-words">
                          <span className="rounded-pill bg-kidville-green/10 px-2 py-0.5 text-[11px] text-kidville-green uppercase">{doc.document_type}</span>
                          <span className="ml-1 inline-flex items-center gap-1 rounded-pill bg-kidville-error-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-kidville-error">
                            <ShieldAlert size={10} /> {t('fascicoloSensibile')}
                          </span>
                          {' '}{nome}
                        </p>
                        <p className="font-maven text-xs text-kidville-sub">
                          {f.dataBreve(doc.created_at)}
                          {doc.expiry_date ? ` · ${t('fascicoloScade', { data: f.dataBreve(doc.expiry_date) })}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          onClick={() => { void apriDocumentoFascicolo(doc); }}
                          disabled={aperturaInCorso.includes(doc.id)}
                          className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green disabled:opacity-50"
                        >
                          <Download size={13} /> {t('fascicoloApri')}
                        </button>
                        {gestibile && userId && (
                          <AzioniDocumentoFascicolo
                            documento={doc}
                            nomeDocumento={nome}
                            userId={userId}
                            finalita={leggiFinalita}
                            onCambiato={dopoGestione}
                            onEsito={mostraEsito}
                          />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
