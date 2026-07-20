'use client';

// ─── Tab «Cassa» della Contabilità: registro di cassa contanti ─────────────────
// Contenitore della vista `?vista=cassa`. Ruolo client da `useAdminIdentity()`,
// puramente COSMETICO: il gate vero sono le API. La UI NON mostra saldo/totali se
// il payload di GET movimenti non contiene `totali` (il server decide chi vede i
// KPI). Su ambiente non migrato (disponibile:false) mostra un empty-state.
//
// Tutti gli staff: «Registra uscita» / «Entrata manuale» + lista movimenti
// (tabella desktop / card mobile) con storno SOLO sulle righe di cassa reali.
// Solo admin (server-confirmed via `totali`): StatCard KPI, «Svuota cassa»,
// report, storico svuotamenti, categorie e impostazioni.
// Solo token `kidville-*`; importi con formatEuro.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Wallet, TrendingDown, TrendingUp, Coins, CalendarDays, ArrowDownCircle, RotateCcw, Paperclip } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { StatCard, SectionTitle, TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient } from '@/lib/logging/client';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { MODAL_CARD, MODAL_SHADOW, INPUT, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import { CassaMovimentoModal } from './CassaMovimentoModal';
import { CassaChiusuraModal } from './CassaChiusuraModal';
import { CassaReport } from './CassaReport';
import { CassaCategorieManager } from './CassaCategorieManager';
import { CassaImpostazioni } from './CassaImpostazioni';
import { metodoLabel } from '@/lib/cassa/tipi';
import type { RigaMovimentoCassa, SaldoCassa, CassaChiusura, EntratoOggiVoce } from '@/lib/cassa/tipi';

interface Props {
  userId: string;
  scuolaId: string;
}

/** Totali della GET movimenti — presenti SOLO per l'admin (server decide). */
interface TotaliCassa {
  entrate: number;
  uscite_contanti: number;
  uscite_altre: number;
  prelievi: number;
  rettifiche: number;
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dataIt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('it-IT') : '—');

const TIPO_INFO: Record<string, { label: string; tone: BadgeTone }> = {
  entrata: { label: 'Entrata', tone: 'success' },
  uscita: { label: 'Uscita', tone: 'error' },
  prelievo: { label: 'Prelievo', tone: 'neutral' },
  rettifica: { label: 'Rettifica', tone: 'warn' },
};

const stornabile = (r: RigaMovimentoCassa) =>
  r.origine === 'cassa' && !r.stornato_il && !r.storno_di && !r.chiusura_id;

/**
 * Direzione VISIVA del movimento (true = «−», denaro che esce dalla cassa).
 * I contro-movimenti di storno hanno lo STESSO `tipo` ma importo già NEGATO
 * (§3.1): lo storno di un'uscita è quindi una restituzione (segno «+»). Il segno
 * si deriva con uno XOR tipo×segno, mai anteponendo un «−»/«+» fisso a un importo
 * che porta già il proprio segno (era il doppio segno del ciclo 1, RC6).
 */
export function direzioneNegativa(r: Pick<RigaMovimentoCassa, 'tipo' | 'importo'>): boolean {
  if (r.tipo === 'rettifica') return r.importo < 0;
  const inUscita = r.tipo === 'uscita' || r.tipo === 'prelievo';
  return inUscita !== (r.importo < 0);
}

/** Importo con un solo segno derivato dalla direzione, valore sempre assoluto. */
export function importoSegnato(r: Pick<RigaMovimentoCassa, 'tipo' | 'importo'>): string {
  return `${direzioneNegativa(r) ? '−' : '+'} ${formatEuro(Math.abs(r.importo))}`;
}

/** Tono AA coerente col segno: entrate/restituzioni verdi, uscite rosse, rettifiche gialle. */
export function importoTone(r: Pick<RigaMovimentoCassa, 'tipo' | 'importo'>): string {
  if (r.tipo === 'rettifica') return 'text-kidville-warn-strong';
  return direzioneNegativa(r) ? 'text-kidville-error-strong' : 'text-kidville-success-strong';
}

export function CassaPanel({ userId, scuolaId }: Props) {
  const { ruolo } = useAdminIdentity();
  const isAdmin = ruolo === 'admin'; // cosmetico: il gate vero è `mostraKpi` (server)

  const [disponibile, setDisponibile] = useState<boolean | null>(null);
  const [movimenti, setMovimenti] = useState<RigaMovimentoCassa[]>([]);
  const [totali, setTotali] = useState<TotaliCassa | null>(null);
  const [saldo, setSaldo] = useState<SaldoCassa | null>(null);
  const [chiusure, setChiusure] = useState<CassaChiusura[]>([]);
  const [errore, setErrore] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [modalTipo, setModalTipo] = useState<'uscita' | 'entrata' | null>(null);
  const [modalChiusura, setModalChiusura] = useState(false);
  const [stornoTarget, setStornoTarget] = useState<RigaMovimentoCassa | null>(null);

  const uscitaRef = useRef<HTMLButtonElement>(null);
  const entrataRef = useRef<HTMLButtonElement>(null);
  const svuotaRef = useRef<HTMLButtonElement>(null);

  const ricarica = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const rMov = await fetch(`/api/pagamenti/cassa/movimenti?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) });
        const jMov = (await rMov.json()) as { disponibile?: boolean; movimenti?: RigaMovimentoCassa[]; totali?: TotaliCassa };
        if (!active) return;
        const disp = jMov?.disponibile !== false;
        setDisponibile(disp);
        setMovimenti(jMov?.movimenti ?? []);
        const tot = jMov?.totali ?? null;
        setTotali(tot);
        // KPI e sezioni admin SOLO se il server ha inviato `totali` (= admin).
        if (disp && tot) {
          const [rSaldo, rChius] = await Promise.all([
            fetch(`/api/pagamenti/cassa/saldo?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) }),
            fetch(`/api/pagamenti/cassa/chiusura?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) }),
          ]);
          const jSaldo = (await rSaldo.json()) as SaldoCassa | { disponibile: false };
          const jChius = (await rChius.json()) as { disponibile?: boolean; chiusure?: CassaChiusura[] };
          if (!active) return;
          setSaldo(jSaldo && (jSaldo as { disponibile?: boolean }).disponibile === false ? null : (jSaldo as SaldoCassa));
          setChiusure(jChius?.chiusure ?? []);
        } else {
          setSaldo(null);
          setChiusure([]);
        }
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `GET movimenti cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) setErrore('Impossibile caricare i movimenti di cassa.');
      }
    })();
    return () => { active = false; };
  }, [userId, scuolaId, refreshKey]);

  const mostraKpi = disponibile === true && !!totali;
  const usciteMese = totali ? totali.uscite_contanti + totali.uscite_altre : 0;

  const apriGiustificativo = async (path: string) => {
    try {
      const r = await fetch(`/api/pagamenti/cassa/allegato?userId=${userId}&path=${encodeURIComponent(path)}`, { headers: hdr(userId) });
      const j = (await r.json()) as { url?: string };
      if (j?.url) window.open(j.url, '_blank', 'noopener');
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `GET allegato cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
    }
  };

  if (disponibile === null && !errore) {
    return <p className="py-8 text-center font-maven text-sm text-kidville-sub">Caricamento della cassa…</p>;
  }

  if (disponibile === false) {
    return (
      <div className="rounded-card bg-kidville-cream/60 px-4 py-10 text-center">
        <Wallet size={28} className="mx-auto mb-2 text-kidville-sub" />
        <p className="font-maven text-sm text-kidville-sub">Modulo cassa non ancora attivo su questo ambiente.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Intestazione + azioni per tutti gli staff */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-barlow text-[19px] font-extrabold uppercase leading-none tracking-[0.01em] text-kidville-green">
            <Wallet size={20} /> Cassa
          </h2>
          <p className="mt-1 font-maven text-[12.5px] text-kidville-sub">
            {isAdmin
              ? 'Registro dei movimenti di cassa contanti, con report e chiusura.'
              : 'Registra le entrate e le uscite di cassa. I totali e lo svuotamento sono riservati agli amministratori.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button ref={uscitaRef} type="button" onClick={() => setModalTipo('uscita')} className={cx(BTN_PRIMARY_AA, 'min-h-[44px] py-2 px-4 text-xs')}>
            <TrendingDown size={15} /> Registra uscita
          </button>
          <button ref={entrataRef} type="button" onClick={() => setModalTipo('entrata')} className={cx(BTN_SECONDARY, 'min-h-[44px] py-2 px-4 text-xs')}>
            <TrendingUp size={15} /> Entrata manuale
          </button>
          {mostraKpi && isAdmin && (
            <button ref={svuotaRef} type="button" onClick={() => setModalChiusura(true)} className={cx(BTN_SECONDARY, 'min-h-[44px] py-2 px-4 text-xs')}>
              <ArrowDownCircle size={15} /> Svuota cassa
            </button>
          )}
        </div>
      </div>

      {errore && <p role="alert" className="rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">{errore}</p>}

      {/* KPI: SOLO se il payload ha `totali` (server decide) */}
      {mostraKpi && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            icon={Wallet}
            tone="green"
            label="Saldo atteso in cassa"
            value={saldo ? formatEuro(saldo.saldo_atteso) : '…'}
            sub={saldo ? `fondo ${formatEuro(saldo.fondo)}` : undefined}
          />
          <StatCard
            icon={Coins}
            tone="success"
            label="Entrato oggi"
            value={formatEuro(saldo ? saldo.entrato_oggi.reduce((s, v) => s + v.totale, 0) : 0)}
            sub={<EntratoOggiSub voci={saldo?.entrato_oggi ?? []} />}
          />
          <StatCard
            icon={TrendingDown}
            tone="error"
            label="Uscite del mese"
            value={formatEuro(usciteMese)}
          />
        </div>
      )}

      {/* Lista movimenti — tabella desktop + card mobile */}
      <div>
        <SectionTitle icon={CalendarDays} title="Movimenti" sub="Le entrate da incasso in contanti compaiono in automatico." />
        {movimenti.length === 0 ? (
          // Empty-state SOLO quando non c'è un errore di caricamento (l'alert
          // sopra ha già spiegato il fallimento): evita il fuorviante «nessun
          // movimento» quando in realtà la rete è caduta (P4).
          !errore && <p className="rounded-card bg-kidville-cream/40 px-3 py-6 text-center font-maven text-sm text-kidville-sub">Nessun movimento di cassa registrato.</p>
        ) : (
          <>
            <div className="hidden lg:block">
              <div className={TABLE_WRAP}>
                <table className={TABLE}>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>Data</th>
                      <th scope="col" className={TH}>Movimento</th>
                      <th scope="col" className={TH}>Categoria</th>
                      <th scope="col" className={TH}>Metodo</th>
                      <th scope="col" className={TH}>Descrizione</th>
                      <th scope="col" className={cx(TH, 'text-right')}>Importo</th>
                      <th scope="col" className={cx(TH, 'text-right')}>Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movimenti.map((r) => {
                      const info = TIPO_INFO[r.tipo] ?? TIPO_INFO.entrata;
                      return (
                        <tr key={r.id} className={cx(TROW, r.stornato_il && 'opacity-55')}>
                          <td className={TD}><span className="whitespace-nowrap font-maven text-sm text-kidville-ink">{dataIt(r.data)}</span></td>
                          <td className={TD}>
                            <span className="flex items-center gap-1.5">
                              <Badge tone={info.tone}>{info.label}</Badge>
                              {r.origine === 'incasso' && <Badge tone="info">da incasso</Badge>}
                              {r.storno_di && <Badge tone="neutral">storno</Badge>}
                              {r.stornato_il && <Badge tone="neutral">stornato</Badge>}
                            </span>
                          </td>
                          <td className={TD}><span className="font-maven text-sm text-kidville-ink">{r.categoria_nome ?? '—'}</span></td>
                          <td className={TD}><span className="font-maven text-xs text-kidville-sub">{metodoLabel(r.metodo)}</span></td>
                          <td className={TD}>
                            <span className="flex items-center gap-1.5 font-maven text-sm text-kidville-ink">
                              {r.descrizione ?? '—'}
                              {r.allegato_path && (
                                <button type="button" onClick={() => apriGiustificativo(r.allegato_path as string)} aria-label="Apri giustificativo" className="text-kidville-green hover:text-kidville-green-dark"><Paperclip size={13} /></button>
                              )}
                            </span>
                          </td>
                          <td className={cx(TD, 'text-right')}><span className={cx('whitespace-nowrap font-barlow font-bold', importoTone(r))}>{importoSegnato(r)}</span></td>
                          <td className={cx(TD, 'text-right')}>
                            {stornabile(r) ? (
                              <button type="button" onClick={() => setStornoTarget(r)} className="inline-flex min-h-[32px] items-center gap-1 rounded-pill border-[1.5px] border-kidville-line px-2.5 py-1 font-maven text-xs font-bold text-kidville-sub transition-colors hover:border-kidville-error hover:text-kidville-error">
                                <RotateCcw size={12} /> Storna
                              </button>
                            ) : r.origine === 'incasso' ? (
                              <span className="font-maven text-[11px] text-kidville-sub">da incasso</span>
                            ) : (
                              <span className="font-maven text-[11px] text-kidville-sub">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-2 lg:hidden">
              {movimenti.map((r) => {
                const info = TIPO_INFO[r.tipo] ?? TIPO_INFO.entrata;
                return (
                  <div key={r.id} className={cx('rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3', r.stornato_il && 'opacity-55')}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={info.tone}>{info.label}</Badge>
                        {r.origine === 'incasso' && <Badge tone="info">da incasso</Badge>}
                        {r.storno_di && <Badge tone="neutral">storno</Badge>}
                        {r.stornato_il && <Badge tone="neutral">stornato</Badge>}
                      </span>
                      <span className={cx('whitespace-nowrap font-barlow font-bold', importoTone(r))}>{importoSegnato(r)}</span>
                    </div>
                    <p className="mt-1.5 font-maven text-sm text-kidville-ink">{r.descrizione ?? r.categoria_nome ?? '—'}</p>
                    <p className="mt-0.5 font-maven text-xs text-kidville-sub">
                      {dataIt(r.data)} · {metodoLabel(r.metodo)}{r.categoria_nome ? ` · ${r.categoria_nome}` : ''}
                    </p>
                    <div className="mt-2 flex items-center justify-end gap-2">
                      {r.allegato_path && (
                        <button type="button" onClick={() => apriGiustificativo(r.allegato_path as string)} className="inline-flex items-center gap-1 font-maven text-xs font-bold text-kidville-green"><Paperclip size={12} /> Giustificativo</button>
                      )}
                      {stornabile(r) && (
                        <button type="button" onClick={() => setStornoTarget(r)} className="inline-flex min-h-[32px] items-center gap-1 rounded-pill border-[1.5px] border-kidville-line px-2.5 py-1 font-maven text-xs font-bold text-kidville-sub hover:border-kidville-error hover:text-kidville-error">
                          <RotateCcw size={12} /> Storna
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Sezioni admin (server-confirmed via `totali`) */}
      {mostraKpi && (
        <>
          <CassaReport userId={userId} scuolaId={scuolaId} />

          {chiusure.length > 0 && (
            <div>
              <SectionTitle icon={ArrowDownCircle} title="Storico svuotamenti" />
              <div className={TABLE_WRAP}>
                <table className={TABLE}>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>Data</th>
                      <th scope="col" className={cx(TH, 'text-right')}>Saldo atteso</th>
                      <th scope="col" className={cx(TH, 'text-right')}>Contato</th>
                      <th scope="col" className={cx(TH, 'text-right')}>Differenza</th>
                      <th scope="col" className={cx(TH, 'text-right')}>Prelevato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chiusure.map((c) => (
                      <tr key={c.id} className={TROW}>
                        <td className={TD}><span className="whitespace-nowrap font-maven text-sm text-kidville-ink">{dataIt(c.eseguita_il)}</span></td>
                        <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-ink">{formatEuro(c.saldo_atteso)}</span></td>
                        <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-ink">{formatEuro(c.contato)}</span></td>
                        <td className={cx(TD, 'text-right')}>
                          <span className="font-maven text-sm text-kidville-ink">
                            {c.differenza === 0 ? 'Cassa quadrata' : `${c.differenza > 0 ? 'Eccedenza' : 'Ammanco'} ${formatEuro(Math.abs(c.differenza))}`}
                          </span>
                        </td>
                        <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-ink">{formatEuro(c.prelevato)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <CassaCategorieManager userId={userId} scuolaId={scuolaId} />
          <CassaImpostazioni userId={userId} scuolaId={scuolaId} />
        </>
      )}

      {/* Modali */}
      {modalTipo && (
        <CassaMovimentoModal
          userId={userId}
          scuolaId={scuolaId}
          tipoIniziale={modalTipo}
          returnFocusRef={modalTipo === 'uscita' ? uscitaRef : entrataRef}
          onClose={() => setModalTipo(null)}
          onDone={() => { setModalTipo(null); ricarica(); }}
        />
      )}
      {modalChiusura && (
        <CassaChiusuraModal
          userId={userId}
          scuolaId={scuolaId}
          returnFocusRef={svuotaRef}
          onClose={() => setModalChiusura(false)}
          onDone={() => { setModalChiusura(false); ricarica(); }}
        />
      )}
      {stornoTarget && (
        <StornoCassaModal
          userId={userId}
          movimento={stornoTarget}
          onClose={() => setStornoTarget(null)}
          onDone={() => { setStornoTarget(null); ricarica(); }}
        />
      )}
    </div>
  );
}

function EntratoOggiSub({ voci }: { voci: EntratoOggiVoce[] }) {
  if (voci.length === 0) return <>nessun incasso oggi</>;
  return <>{voci.map((v) => `${metodoLabel(v.metodo)} ${formatEuro(v.totale)}`).join(' · ')}</>;
}

/** Modale di storno di un movimento di cassa: motivo obbligatorio (min 3), 409 gestito. */
function StornoCassaModal({ userId, movimento, onClose, onDone }: { userId: string; movimento: RigaMovimentoCassa; onClose: () => void; onDone: () => void }) {
  const STORNO_ERRORE_ID = 'cassa-storno-errore';
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [motivoInvalido, setMotivoInvalido] = useState(false);

  const conferma = async () => {
    setMotivoInvalido(false);
    if (motivo.trim().length < 3) { setError('Indica il motivo dello storno (almeno 3 caratteri).'); setMotivoInvalido(true); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pagamenti/cassa/movimenti/storno?userId=${userId}`, {
        method: 'POST', headers: hdr(userId),
        body: JSON.stringify({ movimento_id: movimento.id, motivo: motivo.trim() }),
      });
      const j = (await res.json()) as { error?: string };
      if (res.status === 409) { setError(j.error ?? 'Questo movimento non può essere stornato.'); return; }
      if (!res.ok) { setError(j.error ?? 'Errore durante lo storno.'); return; }
      onDone();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `POST storno cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError('Errore di rete: riprova.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Storna movimento" labelledBy="cassa-storno-title" className={cx(MODAL_CARD, 'max-w-sm')} style={{ boxShadow: MODAL_SHADOW }}>
      <h3 id="cassa-storno-title" className="mb-2 font-barlow text-base font-black uppercase text-kidville-green">Storna movimento</h3>
      <p className="mb-3 font-maven text-sm text-kidville-ink">
        Verrà creato un contro-movimento di <strong>{formatEuro(movimento.importo)}</strong>. L&apos;operazione è tracciata e non cancella la riga originale.
      </p>
      <label htmlFor="cassa-storno-motivo" className="mb-1 block font-maven text-xs text-kidville-sub">Motivo dello storno</label>
      <input id="cassa-storno-motivo" type="text" value={motivo} onChange={(e) => { setMotivo(e.target.value); if (motivoInvalido) setMotivoInvalido(false); }} className={INPUT} maxLength={300} {...(motivoInvalido ? { 'aria-invalid': true as const, 'aria-describedby': STORNO_ERRORE_ID } : {})} />
      {error && <p id={STORNO_ERRORE_ID} role="alert" className="mt-2 font-maven text-xs text-kidville-error-strong">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>Annulla</button>
        <button onClick={conferma} disabled={busy} className={cx(BTN_PRIMARY_AA, 'flex-1')}>{busy ? 'Storno…' : 'Conferma storno'}</button>
      </div>
    </Modal>
  );
}
