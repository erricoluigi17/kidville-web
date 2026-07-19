'use client';

// ─── Popup centrale del movimento bancario (Riconciliazione v2) ───────────────
// Aperto cliccando una riga della lista a semaforo. Dà, in un punto solo:
//   · i suggerimenti ordinati (i CF-match primi, badge «CF») con «Conferma questo»;
//   · la ricerca manuale fra i pagamenti aperti (stessa fonte del pannello);
//   · le azioni sul movimento (Ignora / Riapri);
//   · a saldo avvenuto, Ricevuta + Fattura SdI (come il PagamentoDrawer);
//   · il punto d'innesto «Apri Incasso unico» per i bonifici di famiglia (multi-CF):
//     lo renderizza solo se il chiamante passa `onIncassoUnico` (impl. UI-2).
// Le risposte del server sono gestite senza crash: 409 «già saldato» e 409
// «già riconciliato da un altro operatore» diventano messaggi chiari (+ refetch).

import { useCallback, useEffect, useState } from 'react';
import { Check, Download, FileText, Search, X, Users } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { FatturaButton } from './FatturaButton';
import { MODAL_CARD, MODAL_SHADOW, INPUT, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient } from '@/lib/logging/client';
import {
  labelPagamentoAperto,
  movimentoMultiCf,
  testoRicercaPagamento,
  type MovimentoUi,
  type PagamentoApertoUi,
} from './riconciliazione-ui';

interface Props {
  movimento: MovimentoUi;
  aperti: PagamentoApertoUi[];
  userId: string;
  onClose: () => void;
  /** Refetch della lista dopo un'azione riuscita (o una corsa persa). */
  onDone: () => void;
  /** Ripristino focus WCAG 2.4.3: la riga che ha aperto il dialog. */
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  /**
   * Predisposizione «Apri Incasso unico» per i bonifici di famiglia (multi-CF).
   * Reso SOLO se fornito e il movimento è multi-CF: l'implementazione è di UI-2.
   */
  onIncassoUnico?: (movimento: MovimentoUi) => void;
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const dataIt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('it-IT') : '—');
const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

const TITLE_ID = 'movimento-dialog-title';

/** Pill «CF» dell'aggancio per codice fiscale (su card bianca del dialog). */
function CfPill() {
  return (
    <span className="rounded-pill bg-kidville-green px-1.5 py-0.5 font-barlow text-[10px] font-extrabold uppercase leading-none text-kidville-white">
      CF
    </span>
  );
}

export function MovimentoDialog({ movimento, aperti, userId, onClose, onDone, returnFocusRef, onIncassoUnico }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ricerca, setRicerca] = useState('');
  // Stato del pagamento collegato: serve solo ai movimenti confermati per capire
  // se mostrare Ricevuta (saldato) o la nota «Disponibile a saldo avvenuto».
  const [pagamentoStato, setPagamentoStato] = useState<string | null>(null);
  const [loadingPag, setLoadingPag] = useState(movimento.stato === 'confermato' && !!movimento.pagamento_id);

  const stato = movimento.stato;
  const puoAbbinare = stato !== 'confermato';
  const isConfermato = stato === 'confermato';
  const isIgnorato = stato === 'ignorato';
  const suggerimenti = movimento.suggerimenti ?? [];
  const multiCf = movimentoMultiCf(suggerimenti);

  // Dettaglio del pagamento (solo movimenti confermati): stesso pattern di
  // PagamentoDrawer — setState solo in try (guardato da `active`) e in finally,
  // MAI nel catch (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (stato !== 'confermato' || !movimento.pagamento_id) return;
    let active = true;
    (async () => {
      try {
        const r = await fetch(`/api/pagamenti/${movimento.pagamento_id}?userId=${userId}`, { headers: hdr(userId) });
        const j = await r.json();
        if (active && j?.success) setPagamentoStato((j.data as { stato?: string } | null)?.stato ?? null);
      } catch (err) {
        // Il dialog resta usabile senza lo stato: si logga, non si rompe.
        logClient({ livello: 'error', evento: 'fetch', messaggio: `GET pagamento (stato ricevuta) — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      } finally {
        if (active) setLoadingPag(false);
      }
    })();
    return () => { active = false; };
  }, [stato, movimento.pagamento_id, userId]);

  const azione = useCallback(async (az: 'conferma' | 'ignora' | 'riapri', pagamentoId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/pagamenti/riconciliazione/${movimento.id}`, {
        method: 'PATCH',
        headers: hdr(userId),
        body: JSON.stringify({ azione: az, pagamento_id: pagamentoId }),
      });
      // Nessun catch muto sul parse: un corpo non-JSON risale al catch che LOGGA.
      const j = (await r.json()) as { error?: string; success?: boolean };
      if (r.status === 409) {
        const msg = j.error || 'Operazione non possibile in questo momento';
        setError(msg);
        // Corsa persa / stato già cambiato da un altro operatore → risincronizza la lista.
        if (/operatore|confermato/i.test(msg)) onDone();
        return;
      }
      if (!r.ok || !j.success) {
        setError(j.error || "Errore nell'operazione");
        return;
      }
      onDone();
      onClose();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `PATCH riconciliazione (${az}) — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError('Errore di rete: riprova');
    } finally {
      setBusy(false);
    }
  }, [movimento.id, userId, onDone, onClose]);

  const q = ricerca.trim().toLowerCase();
  const apertiFiltrati = (q.length === 0 ? aperti : aperti.filter((p) => testoRicercaPagamento(p).includes(q))).slice(0, 25);

  const saldato = isConfermato && pagamentoStato === 'pagato';

  return (
    <Modal
      open
      onClose={onClose}
      title={`Movimento del ${dataIt(movimento.data_operazione)}`}
      labelledBy={TITLE_ID}
      className={cx(MODAL_CARD, 'max-w-lg')}
      style={{ boxShadow: MODAL_SHADOW }}
      returnFocusRef={returnFocusRef}
    >
      {/* Intestazione: importo + data, con chiusura */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id={TITLE_ID} className="font-barlow text-lg font-black uppercase text-kidville-green">
            {formatEuro(movimento.importo)}
          </h2>
          <p className="font-maven text-xs text-kidville-sub">Bonifico del {dataIt(movimento.data_operazione)}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Chiudi" className="rounded-pill p-1 text-kidville-muted transition-colors hover:text-kidville-ink">
          <X size={20} />
        </button>
      </div>

      {/* Causale / controparte */}
      <div className="mb-4 rounded-card bg-kidville-cream/60 p-3">
        <p className="font-maven text-sm text-kidville-ink" title={movimento.causale ?? ''}>{movimento.causale || 'Nessuna causale'}</p>
        {movimento.controparte && <p className="mt-0.5 font-maven text-xs text-kidville-sub">Ordinante: {movimento.controparte}</p>}
      </div>

      {error && <p role="alert" className="mb-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">{error}</p>}

      {/* ── Abbinamento (movimenti non confermati) ─────────────────────────── */}
      {puoAbbinare && (
        <div className="space-y-4">
          {/* Bonifico di famiglia: innesto «Incasso unico» (impl. UI-2) */}
          {multiCf && onIncassoUnico && (
            <div className="rounded-card border-[1.5px] border-kidville-green-soft bg-kidville-green-soft p-3">
              <p className="flex items-center gap-1.5 font-maven text-sm font-bold text-kidville-green">
                <Users size={15} /> Bonifico di famiglia: più figli agganciati per codice fiscale.
              </p>
              <button type="button" onClick={() => onIncassoUnico(movimento)} disabled={busy} className={cx(BTN_PRIMARY_AA, 'mt-2 py-1.5 px-3 text-xs')}>
                Apri Incasso unico
              </button>
            </div>
          )}

          {/* Suggerimenti ordinati (CF-match primi) */}
          {suggerimenti.length > 0 && (
            <div>
              <h3 className="mb-1.5 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">Suggerimenti</h3>
              <div className="space-y-1.5">
                {suggerimenti.map((s, i) => (
                  <div key={`${s.pagamento_id}-${i}`} className="flex items-center justify-between gap-2 rounded-input border border-kidville-line px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      {s.cf_match && <CfPill />}
                      <span className="min-w-0 truncate font-maven text-sm text-kidville-ink">{s.label || s.pagamento_id}</span>
                    </span>
                    <button type="button" onClick={() => azione('conferma', s.pagamento_id)} disabled={busy}
                      className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-kidville-green px-3 py-1.5 font-maven text-xs font-bold text-kidville-white transition-colors hover:bg-kidville-green-dark disabled:opacity-50">
                      <Check size={13} /> Conferma questo
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Ricerca manuale fra i pagamenti aperti (stessa fonte del pannello) */}
          <div>
            <h3 className="mb-1.5 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">Cerca un altro pagamento</h3>
            <div className="relative mb-2">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" />
              <input type="text" value={ricerca} onChange={(e) => setRicerca(e.target.value)} placeholder="Nome dell'alunno o descrizione…"
                className={cx(INPUT, 'pl-9')} aria-label="Cerca un pagamento aperto da abbinare" />
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {apertiFiltrati.length === 0 ? (
                <p className="px-1 py-2 font-maven text-xs text-kidville-sub">Nessun pagamento aperto corrisponde.</p>
              ) : apertiFiltrati.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 rounded-input bg-kidville-cream/40 px-3 py-2">
                  <span className="min-w-0 truncate font-maven text-xs text-kidville-ink">{labelPagamentoAperto(p)}</span>
                  <button type="button" onClick={() => azione('conferma', p.id)} disabled={busy}
                    className="inline-flex shrink-0 items-center gap-1 rounded-pill border-[1.5px] border-kidville-green px-2.5 py-1 font-maven text-xs font-bold text-kidville-green transition-colors hover:bg-kidville-green hover:text-kidville-white disabled:opacity-50">
                    <Check size={12} /> Abbina
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Movimento confermato: ricevuta / fattura ───────────────────────── */}
      {isConfermato && (
        <div className="space-y-3">
          {loadingPag ? (
            <p className="font-maven text-sm text-kidville-sub">Caricamento…</p>
          ) : saldato && movimento.pagamento_id ? (
            <div className="flex flex-wrap items-center gap-2">
              <a href={`/api/pagamenti/ricevuta?pagamento_id=${movimento.pagamento_id}&userId=${userId}`}
                className="inline-flex items-center gap-1 rounded-pill bg-kidville-green-soft px-3 py-1.5 font-maven text-xs font-bold text-kidville-green transition-colors hover:bg-kidville-green/20">
                <Download size={13} /> Ricevuta
              </a>
              <FatturaButton pagamentoId={movimento.pagamento_id} userId={userId} descrizione={movimento.causale ?? undefined} />
            </div>
          ) : (
            <p className="flex items-center gap-1.5 rounded-card bg-kidville-cream/60 px-3 py-2 font-maven text-xs text-kidville-sub">
              <FileText size={14} /> Ricevuta e fattura disponibili a saldo avvenuto.
            </p>
          )}
        </div>
      )}

      {/* ── Azioni sul movimento ───────────────────────────────────────────── */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {(stato === 'da_abbinare' || stato === 'suggerito') && (
          <button type="button" onClick={() => azione('ignora')} disabled={busy} className={cx(BTN_SECONDARY, 'py-2 px-4 text-xs')}>
            <X size={13} /> Ignora
          </button>
        )}
        {(isConfermato || isIgnorato) && (
          <button type="button" onClick={() => azione('riapri')} disabled={busy} className={cx(BTN_SECONDARY, 'py-2 px-4 text-xs')}>
            Riapri
          </button>
        )}
        <button type="button" onClick={onClose} className={cx(BTN_SECONDARY, 'ml-auto py-2 px-4 text-xs')}>Chiudi</button>
      </div>
    </Modal>
  );
}
