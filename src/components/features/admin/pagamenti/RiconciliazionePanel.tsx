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
import { MovimentoDialog } from './MovimentoDialog';
import type { PrecompilaTransazione } from './TransazioniPanel';
import { BTN_PRIMARY_AA } from './ui';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { LIMITE_UPLOAD_BYTE } from '@/lib/upload/limite-piattaforma';
import {
  SEMAFORO,
  FILTRI,
  suggerimentoPrincipaleCf,
  riepilogoImport,
  type MovimentoUi,
  type PagamentoApertoUi,
  type EsitoImport,
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
  const [filtro, setFiltro] = useState<'' | StatoMovimento>('');
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
      const [movRes, apRes] = await Promise.all([
        fetch(`/api/pagamenti/riconciliazione?userId=${userId}${statoQ}`, { headers: hdr(userId) }).then((r) => r.json()).catch(onErr),
        fetch(`/api/pagamenti?userId=${userId}&scuola_id=${scuolaId}&solo_aperti=true`, { headers: hdr(userId) }).then((r) => r.json()).catch(onErr),
      ]);
      if (movRes?.success) {
        setMovimenti((movRes.data ?? []) as MovimentoUi[]);
        setDisponibile(movRes.disponibile !== false);
      } else if (movRes === null) {
        setError(t('reconErroreReteMovimenti'));
      }
      if (apRes?.success) {
        setAperti(((apRes.data ?? []) as PagamentoApertoUi[]).filter((p) => p.tipo !== 'padre'));
      }
    } finally {
      setLoading(false);
    }
  }, [userId, scuolaId, filtro, t]);

  useEffect(() => { load(); }, [load]);

  const cambiaFiltro = (id: '' | StatoMovimento) => {
    if (id === filtro) return;
    setLoading(true);
    setFiltro(id);
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

  const vuoto = !loading && disponibile && movimenti.length === 0;

  return (
    <div>
      <SectionTitle icon={Landmark} title={t('reconTitolo')}
        sub={t('reconSottotitolo')}
        action={
          <button onClick={() => { setLoading(true); load(); }} aria-label={t('reconAggiorna')}
            className="rounded-pill border-[1.5px] border-kidville-line p-2 text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
            <RefreshCw size={14} />
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
      {error && <p role="alert" className="mt-3 font-maven text-xs text-kidville-error-strong">{error}</p>}

      {/* Filtri per stato (sul GET via ?stato=) */}
      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label={t('reconFiltraPerStato')}>
        {FILTRI.map((f) => {
          const attivo = f.id === filtro;
          return (
            <button key={f.id || 'tutti'} type="button" onClick={() => cambiaFiltro(f.id)} aria-pressed={attivo}
              className={cx(
                'rounded-pill px-3 py-1.5 font-barlow text-[12px] font-extrabold uppercase tracking-[0.03em] transition-colors',
                attivo ? 'bg-kidville-green text-kidville-white' : 'bg-kidville-white text-kidville-sub ring-[1.5px] ring-inset ring-kidville-line hover:ring-kidville-green',
              )}>
              {f.label}
            </button>
          );
        })}
      </div>

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
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={(e) => { triggerRef.current = e.currentTarget; setSelezionato(m); }}
                  className={cx('kv-recon-row block w-full rounded-card p-3 text-left transition hover:brightness-95', s.bg, s.hcClass)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className={cx('block font-maven text-sm font-bold', s.testo)}>
                        {formatEuro(m.importo)} · {dataIt(m.data_operazione)}
                      </span>
                      <span className={cx('mt-0.5 block truncate font-maven text-xs', s.sub)} title={m.causale ?? ''}>
                        {m.causale || t('reconNessunaCausale')}{m.controparte ? ` · ${m.controparte}` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {cf && (
                        <span className="inline-flex items-center rounded-pill bg-kidville-white px-1.5 py-0.5 font-barlow text-[10px] font-extrabold uppercase leading-none text-kidville-green ring-[1.5px] ring-inset ring-kidville-green">
                          {t('reconBadgeCf')}
                        </span>
                      )}
                      <span className={cx('font-barlow text-[11px] font-extrabold uppercase tracking-wide', s.testo)}>{s.label}</span>
                      <ChevronRight size={16} className={s.testo} aria-hidden="true" />
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
