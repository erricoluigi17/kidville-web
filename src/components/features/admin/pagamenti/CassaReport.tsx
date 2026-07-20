'use client';

// ─── Report di cassa (solo admin) ─────────────────────────────────────────────
// Entrate aggregate per CATEGORIA DI PAGAMENTO (con breakdown per metodo, tutti i
// metodi, storni netti) e uscite per categoria di cassa, filtrabili per periodo.
// Selezionando una categoria di pagamento con «Intero importo, tutti i mesi» il
// totale è cross-mese per intero (es. quota «Saggio» in 3 acconti su 3 mesi).
// Export CSV via link diretto (?format=csv, con userId per l'auth del GET).
// Solo token `kidville-*`; importi con formatEuro.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Download } from 'lucide-react';
import { logClient } from '@/lib/logging/client';
import { formatEuro } from '@/lib/format/valuta';
import { cx } from '@/lib/ui/cx';
import { TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { hdr, card, h3, input, label } from '../settings/ui';
import { BTN_SECONDARY } from './ui';
import { metodoLabel, meseItaliano } from '@/lib/cassa/tipi';

interface Props {
  userId: string;
  scuolaId: string;
}

interface EntrataCat {
  categoria_id: string | null;
  categoria_nome: string | null;
  totale: number;
  per_metodo?: Record<string, number>;
}
interface UscitaCat {
  categoria_id: string | null;
  categoria_nome: string | null;
  totale: number;
  contanti?: number;
}
interface MeseRiga {
  mese: string;
  entrate?: number;
  uscite?: number;
}
interface ReportData {
  disponibile: boolean;
  entrate_per_categoria?: EntrataCat[];
  uscite_per_categoria?: UscitaCat[];
  mensile?: MeseRiga[];
}
interface CategoriaPag { id: string; nome: string; slug?: string }

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function CassaReport({ userId, scuolaId }: Props) {
  const [da, setDa] = useState('');
  const [a, setA] = useState('');
  const [categoriaPag, setCategoriaPag] = useState('');
  const [intero, setIntero] = useState(false);
  const [categoriePag, setCategoriePag] = useState<CategoriaPag[]>([]);
  const [dati, setDati] = useState<ReportData | null>(null);
  const [errore, setErrore] = useState(false);

  // Categorie di PAGAMENTO (per il filtro entrate cross-mese).
  useEffect(() => {
    fetch(`/api/admin/settings/categorie?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
      .then((r) => r.json())
      .then((d: { success?: boolean; data?: CategoriaPag[] }) => {
        if (d?.success) {
          const perSlug = new Map<string, CategoriaPag>();
          for (const c of d.data ?? []) perSlug.set(c.slug ?? c.id, c);
          setCategoriePag([...perSlug.values()]);
        }
      })
      .catch((err) => logClient({ livello: 'error', evento: 'fetch', messaggio: `GET categorie pagamento (report) — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 }));
  }, [userId, scuolaId]);

  // Query dei filtri correnti (intero azzera il periodo → totale cross-mese).
  const querystring = useCallback((formatCsv = false) => {
    const p = new URLSearchParams();
    p.set('userId', userId);
    p.set('scuola_id', scuolaId);
    if (!intero && da) p.set('da', da);
    if (!intero && a) p.set('a', a);
    if (categoriaPag) p.set('categoria_pagamento_id', categoriaPag);
    if (formatCsv) p.set('format', 'csv');
    return p.toString();
  }, [userId, scuolaId, da, a, categoriaPag, intero]);

  useEffect(() => {
    let active = true;
    // setState solo DENTRO l'IIFE async (dopo l'await): niente setState sincrono
    // nel corpo dell'effetto (react-hooks/set-state-in-effect).
    (async () => {
      try {
        const r = await fetch(`/api/pagamenti/cassa/report?${querystring()}`, { headers: hdr(userId) });
        const d = (await r.json()) as ReportData;
        if (active) { setDati(d); setErrore(false); }
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `GET report cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) setErrore(true);
      }
    })();
    return () => { active = false; };
  }, [querystring, userId]);

  const csvHref = useMemo(() => `/api/pagamenti/cassa/report?${querystring(true)}`, [querystring]);

  const disponibile = dati?.disponibile !== false;
  const entrate = dati?.entrate_per_categoria ?? [];
  const uscite = dati?.uscite_per_categoria ?? [];
  const mensile = dati?.mensile ?? [];

  return (
    <section className={card}>
      <h3 className={h3}><BarChart3 size={16} /> Report di cassa</h3>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="report-da" className={label}>Dal</label>
          <input id="report-da" type="date" value={da} onChange={(e) => setDa(e.target.value)} disabled={intero} className={cx(input, intero && 'opacity-50')} />
        </div>
        <div>
          <label htmlFor="report-a" className={label}>Al</label>
          <input id="report-a" type="date" value={a} onChange={(e) => setA(e.target.value)} disabled={intero} className={cx(input, intero && 'opacity-50')} />
        </div>
        <div>
          <label htmlFor="report-cat" className={label}>Categoria di pagamento</label>
          <select id="report-cat" value={categoriaPag} onChange={(e) => setCategoriaPag(e.target.value)} className={cx(input, 'cursor-pointer')}>
            <option value="">Tutte</option>
            {categoriePag.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </div>
        {categoriaPag && (
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" checked={intero} onChange={(e) => setIntero(e.target.checked)} className="h-4 w-4 rounded accent-kidville-green" />
            <span className="font-maven text-xs text-kidville-green">Intero importo, tutti i mesi</span>
          </label>
        )}
        <a href={csvHref} className={cx(BTN_SECONDARY, 'ml-auto')}><Download size={14} /> Scarica CSV</a>
      </div>

      {dati === null && !errore ? (
        <p className="py-6 text-center font-maven text-sm text-kidville-sub">Caricamento…</p>
      ) : errore ? (
        <p role="alert" className="font-maven text-sm text-kidville-error-strong">Impossibile caricare il report. Riprova.</p>
      ) : !disponibile ? (
        <p className="font-maven text-sm text-kidville-sub">Modulo cassa non ancora attivo su questo ambiente.</p>
      ) : (
        <div className="space-y-6">
          <TabellaEntrate righe={entrate} />
          <TabellaUscite righe={uscite} />
          {mensile.length > 0 && <TabellaMensile righe={mensile} />}
        </div>
      )}
    </section>
  );
}

function TabellaEntrate({ righe }: { righe: EntrataCat[] }) {
  return (
    <div>
      <h4 className="mb-2 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">Entrate per categoria di pagamento</h4>
      {righe.length === 0 ? (
        <p className="font-maven text-sm text-kidville-sub">Nessuna entrata nel periodo selezionato.</p>
      ) : (
        <div className={TABLE_WRAP}>
          <table className={TABLE}>
            <thead>
              <tr><th scope="col" className={TH}>Categoria</th><th scope="col" className={TH}>Per metodo</th><th scope="col" className={cx(TH, 'text-right')}>Totale</th></tr>
            </thead>
            <tbody>
              {righe.map((r, i) => (
                <tr key={r.categoria_id ?? `e${i}`} className={TROW}>
                  <td className={TD}><span className="font-maven text-sm text-kidville-ink">{r.categoria_nome ?? 'Senza categoria'}</span></td>
                  <td className={TD}>
                    <span className="font-maven text-xs text-kidville-sub">
                      {r.per_metodo && Object.keys(r.per_metodo).length > 0
                        ? Object.entries(r.per_metodo).map(([m, v]) => `${metodoLabel(m)}: ${formatEuro(v)}`).join(' · ')
                        : '—'}
                    </span>
                  </td>
                  <td className={cx(TD, 'text-right')}><span className="font-barlow font-bold text-kidville-green">{formatEuro(r.totale)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TabellaUscite({ righe }: { righe: UscitaCat[] }) {
  return (
    <div>
      <h4 className="mb-2 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">Uscite per categoria</h4>
      {righe.length === 0 ? (
        <p className="font-maven text-sm text-kidville-sub">Nessuna uscita nel periodo selezionato.</p>
      ) : (
        <div className={TABLE_WRAP}>
          <table className={TABLE}>
            <thead>
              <tr><th scope="col" className={TH}>Categoria</th><th scope="col" className={cx(TH, 'text-right')}>Di cui contanti</th><th scope="col" className={cx(TH, 'text-right')}>Totale</th></tr>
            </thead>
            <tbody>
              {righe.map((r, i) => (
                <tr key={r.categoria_id ?? `u${i}`} className={TROW}>
                  <td className={TD}><span className="font-maven text-sm text-kidville-ink">{r.categoria_nome ?? 'Senza categoria'}</span></td>
                  <td className={cx(TD, 'text-right')}><span className="font-maven text-xs text-kidville-sub">{r.contanti != null ? formatEuro(r.contanti) : '—'}</span></td>
                  <td className={cx(TD, 'text-right')}><span className="font-barlow font-bold text-kidville-error-strong">{formatEuro(r.totale)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TabellaMensile({ righe }: { righe: MeseRiga[] }) {
  return (
    <div>
      <h4 className="mb-2 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">Riepilogo mensile</h4>
      <div className={TABLE_WRAP}>
        <table className={TABLE}>
          <thead>
            <tr><th scope="col" className={TH}>Mese</th><th scope="col" className={cx(TH, 'text-right')}>Entrate</th><th scope="col" className={cx(TH, 'text-right')}>Uscite</th></tr>
          </thead>
          <tbody>
            {righe.map((r) => (
              <tr key={r.mese} className={TROW}>
                <td className={TD}><span className="font-maven text-sm text-kidville-ink">{meseItaliano(r.mese)}</span></td>
                <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-green">{formatEuro(r.entrate ?? 0)}</span></td>
                <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-error-strong">{formatEuro(r.uscite ?? 0)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
