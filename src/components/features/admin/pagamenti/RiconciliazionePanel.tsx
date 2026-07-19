'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Landmark, RefreshCw, Upload } from 'lucide-react';
import { SectionTitle } from '@/components/ui/cockpit';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient } from '@/lib/logging/client';
import { MovimentoDialog } from './MovimentoDialog';
import type { PrecompilaTransazione } from './TransazioniPanel';
import { BTN_PRIMARY_AA } from './ui';
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
const dataIt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('it-IT') : '—');
const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Vista Riconciliazione bancaria — lista a SEMAFORO del registro cumulativo.
 * Import CSV dell'estratto conto, poi ogni movimento è una riga colorata per stato
 * (verde=confermato · giallo=suggerito · rosso=da abbinare · grigio=ignorato):
 * cliccando si apre il popup centrale (MovimentoDialog) con suggerimenti, ricerca
 * manuale, conferma/ignora/riapri e — a saldo avvenuto — ricevuta/fattura.
 */
export function RiconciliazionePanel({ userId, scuolaId, onIncassoUnico }: Props) {
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
  // Import CSV: il trigger è un <button> (A1) che aziona via ref l'input file, così
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
      logClient({ livello: 'error', evento: 'fetch', messaggio: `GET riconciliazione/pagamenti — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
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
        setError('Errore di rete nel caricamento dei movimenti');
      }
      if (apRes?.success) {
        setAperti(((apRes.data ?? []) as PagamentoApertoUi[]).filter((p) => p.tipo !== 'padre'));
      }
    } finally {
      setLoading(false);
    }
  }, [userId, scuolaId, filtro]);

  useEffect(() => { load(); }, [load]);

  const cambiaFiltro = (id: '' | StatoMovimento) => {
    if (id === filtro) return;
    setLoading(true);
    setFiltro(id);
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setEsito(null);
    try {
      const contenuto = await file.text();
      const r = await fetch('/api/pagamenti/riconciliazione', {
        method: 'POST',
        headers: hdr(userId),
        body: JSON.stringify({ filename: file.name, contenuto, scuola_id: scuolaId }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) { setError(j.error || "Errore nell'import"); return; }
      setEsito(j.data as EsitoImport);
      await load();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `POST riconciliazione import — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError('Errore di lettura del file');
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
        logClient({ livello: 'error', evento: 'fetch', messaggio: `GET pagante-comune — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      }
    }
    onIncassoUnico?.({ parent, rif, tot: m.importo, alunni });
    setSelezionato(null);
  }, [userId, onIncassoUnico]);

  const vuoto = !loading && disponibile && movimenti.length === 0;

  return (
    <div>
      <SectionTitle icon={Landmark} title="Riconciliazione bancaria"
        sub="Importa l'estratto conto (CSV): ogni movimento è una riga a semaforo, la conferma è sempre tua."
        action={
          <button onClick={() => { setLoading(true); load(); }} aria-label="Aggiorna"
            className="rounded-pill border-[1.5px] border-kidville-line p-2 text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
            <RefreshCw size={14} />
          </button>
        } />

      {/* A1: trigger = <button> (Tab-reachable, attivabile da Invio/Spazio) che
          aziona l'input file via ref. L'input è `sr-only` (non `hidden`): resta
          fuori dal focus (aria-hidden + tabIndex -1) ma resta cliccabile via ref.
          A5: CTA bianco-su-verde (BTN_PRIMARY_AA, ≈6,5:1) invece del giallo (~4:1). */}
      <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy} className={BTN_PRIMARY_AA}>
        <Upload size={14} /> {busy ? 'Elaboro…' : 'Importa CSV estratto conto'}
      </button>
      <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="sr-only" tabIndex={-1} aria-hidden="true" disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
      <p className="mt-1 font-maven text-[11px] text-kidville-sub">
        Colonne riconosciute automaticamente (Data/Valuta · Importo/Entrate/Accrediti · Causale/Descrizione · Ordinante). Solo gli accrediti. Il file non viene salvato.
      </p>

      {esito && (
        <p role="status" className="mt-3 flex items-center gap-1.5 rounded-card bg-kidville-success-soft px-3 py-2 font-maven text-sm text-kidville-success">
          <SaveCheck size={16} />
          {riepilogoImport(esito)}
        </p>
      )}
      {error && <p role="alert" className="mt-3 font-maven text-xs text-kidville-error-strong">{error}</p>}

      {/* Filtri per stato (sul GET via ?stato=) */}
      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Filtra per stato">
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
        <p className="py-8 text-center font-maven text-sm text-kidville-sub">Caricamento…</p>
      ) : !disponibile ? (
        <p className="py-8 text-center font-maven text-sm text-kidville-sub">Riconciliazione non ancora disponibile.</p>
      ) : vuoto ? (
        <p className="py-8 text-center font-maven text-sm text-kidville-sub">
          {filtro ? 'Nessun movimento in questo stato.' : 'Nessun movimento: importa un estratto conto per iniziare.'}
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
                        {m.causale || 'Nessuna causale'}{m.controparte ? ` · ${m.controparte}` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {cf && (
                        <span className="inline-flex items-center rounded-pill bg-kidville-white px-1.5 py-0.5 font-barlow text-[10px] font-extrabold uppercase leading-none text-kidville-green ring-[1.5px] ring-inset ring-kidville-green">
                          CF
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
