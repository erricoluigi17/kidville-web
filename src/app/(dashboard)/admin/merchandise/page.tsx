'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { formatData } from '@/lib/i18n/date';
import { useRouter, useSearchParams } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import {
  ShoppingBag, Package, Truck, PackageCheck, ClipboardList, Boxes, Factory, ListChecks,
  Plus, Minus, Search, Save, Trash2, Pencil, X, FileText, AlertTriangle, RefreshCw, Warehouse, Check, Repeat, Download,
} from 'lucide-react';
import {
  CockpitPage, PageHeader, StatCard, Tabs, Drawer, Toolbar, CockpitSelect,
  TABLE, TABLE_WRAP, TD, TH, TROW, TONE,
} from '@/components/ui/cockpit';
import { SaveCheck, SaveCelebration } from '@/components/ui/SaveConfirmation';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';

// ============================ Tipi ============================
type StatoRiga = 'da_ordinare' | 'ordinato' | 'arrivato' | 'consegnato' | 'annullato';
type Categoria = 'divisa' | 'materiale' | 'libri' | 'gadget' | 'altro';

interface Fornitore { id: string; nome: string; referente: string | null; email: string | null; telefono: string | null; piva: string | null; indirizzo: string | null; note: string | null; attivo: boolean }
interface Articolo { id: string; scuola_id: string; nome: string; descrizione: string | null; taglie: string[]; prezzo: number; categoria?: Categoria; fornitore_id?: string | null; prezzo_acquisto?: number | null; attivo: boolean; ordine: number }
interface Riga { id: string; articolo_id: string | null; articolo_nome: string; taglia: string; quantita: number; prezzo_unitario: number; stato?: StatoRiga; origine?: string; ordine_fornitore_id?: string | null }
interface Pagamento { id: string; stato: string; importo: number; importo_pagato?: number | null }
interface Ordine { id: string; alunno_id: string; stato: string; totale: number; pagamento_id: string | null; note: string | null; creato_il: string; alunni: { nome: string; cognome: string; classe_sezione: string | null } | null; pagamento?: Pagamento | null; righe: Riga[] }
interface POrighe { id: string; articolo_nome: string; taglia: string; quantita: number; stato: StatoRiga; ordine_id: string }
interface PO { id: string; fornitore_nome: string; numero: string; stato: string; creato_il: string; chiuso_il: string | null; righe: POrighe[] }
interface DaOrdTaglia { taglia: string; quantita: number; righe_ids: string[] }
interface DaOrdArticolo { articolo_id: string | null; nome: string; taglie: DaOrdTaglia[]; quantita: number }
interface DaOrdGruppo { fornitore: { id: string; nome: string } | null; quantita: number; articoli: DaOrdArticolo[] }
interface GiacenzaCell { articolo_id: string | null; nome: string; taglia: string; caricato: number; impegnato: number; disponibile: number; inArrivo: number; daConsegnare: number }

// ============================ Helper ============================
// La valuta ha UNA sola casa nell'app: `formatEuro` (it-IT). L'helper locale
// concatenava a mano il simbolo e due decimali, e stampava «€ 1234.50» — punto
// decimale, migliaia non raggruppate — mentre il resto dell'app diceva «€ 1.234,50».
const euro = (n: number) => formatEuro(n);
// Data breve localizzata (IT identica a `toLocaleDateString('it-IT')`); il `locale`
// arriva dai call-site (componenti con `useLocale()`).
function dataIt(s: string | null | undefined, locale: string) { return s ? formatData(s, locale, 'breve') : ''; }
function url(userId: string | null, path: string) {
  const sep = path.includes('?') ? '&' : '?';
  return `/api/admin/merch/${path}${userId ? `${sep}userId=${encodeURIComponent(userId)}` : ''}`;
}
async function jget<T = unknown>(userId: string | null, path: string): Promise<T | null> {
  try { const r = await fetch(url(userId, path)); return r.ok ? ((await r.json()).data as T) : null; } catch { return null; }
}
async function jsend(userId: string | null, path: string, method: string, body: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const r = await fetch(url(userId, path), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, data: j.data, error: j.error };
  } catch { return { ok: false, error: 'Errore di rete' }; }
}

const CATEGORIE: Categoria[] = ['divisa', 'materiale', 'libri', 'gadget', 'altro'];
// Colori dei chip di stato derivati dal tono cockpit (`TONE`): un'unica sorgente
// per la pelle dei chip in tutto il cockpit (softBg + testo del tono), niente hex.
const STATO_RIGA_TONE: Record<StatoRiga, string> = {
  da_ordinare: cx(TONE.neutral.softBg, TONE.neutral.text),
  ordinato: cx(TONE.info.softBg, TONE.info.text),
  arrivato: cx(TONE.warn.softBg, TONE.warn.text),
  consegnato: cx(TONE.green.softBg, TONE.green.text),
  annullato: cx(TONE.error.softBg, TONE.error.text),
};

// ============================ Nav ============================
type Vista = 'ordini' | 'nuovo' | 'da_ordinare' | 'arrivi' | 'consegne' | 'catalogo' | 'giacenze' | 'fornitori';
const VISTE: { id: Vista; icon: LucideIcon }[] = [
  { id: 'ordini', icon: ClipboardList },
  { id: 'nuovo', icon: Plus },
  { id: 'da_ordinare', icon: ListChecks },
  { id: 'arrivi', icon: Truck },
  { id: 'consegne', icon: PackageCheck },
  { id: 'catalogo', icon: Package },
  { id: 'giacenze', icon: Boxes },
  { id: 'fornitori', icon: Factory },
];

function MerchNav({ value, onChange }: { value: Vista; onChange: (v: Vista) => void }) {
  const t = useTranslations('adminContabilita');
  const VISTA_LABEL: Record<Vista, string> = {
    ordini: t('merchVistaOrdini'), nuovo: t('merchVistaNuovoOrdine'), da_ordinare: t('merchVistaDaOrdinare'),
    arrivi: t('merchVistaArrivi'), consegne: t('merchVistaConsegne'), catalogo: t('merchVistaCatalogo'),
    giacenze: t('merchVistaGiacenze'), fornitori: t('merchVistaFornitori'),
  };
  return (
    <>
      <div className="lg:hidden -mx-4 mb-4 overflow-x-auto px-4">
        <div className="flex w-max gap-2">
          {VISTE.map((v) => {
            const Icon = v.icon; const on = value === v.id;
            return (
              <button key={v.id} type="button" aria-pressed={on} onClick={() => onChange(v.id)}
                className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-3.5 py-2 font-barlow text-[12.5px] font-extrabold uppercase tracking-[0.03em] transition-colors',
                  'outline-none focus-visible:ring-2 focus-visible:ring-kidville-green focus-visible:ring-offset-1',
                  on ? 'bg-kidville-green text-kidville-white' : 'bg-kidville-white text-kidville-ink/70 ring-[1.5px] ring-inset ring-kidville-line hover:text-kidville-green hover:ring-kidville-green/50')}>
                <Icon size={14} strokeWidth={2.2} /> {VISTA_LABEL[v.id]}
              </button>
            );
          })}
        </div>
      </div>
      <div className="hidden lg:block">
        <Tabs value={value} onChange={(id) => onChange(id as Vista)} options={VISTE.map(({ id, icon }) => ({ id, label: VISTA_LABEL[id], icon }))} />
      </div>
    </>
  );
}

// piccoli mattoni UI
const CARD = 'rounded-card bg-kidville-white p-4 shadow-sm';
const INPUT = 'w-full rounded-input border border-kidville-line px-3 py-2 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green';
const LABEL = 'font-maven text-xs font-semibold text-kidville-ink/70';
const BTN_PRIMARY = 'inline-flex items-center justify-center gap-2 rounded-pill bg-kidville-green px-4 py-2.5 font-barlow text-sm font-bold uppercase text-kidville-yellow transition-all active:scale-[0.98] disabled:opacity-50';
const BTN_GHOST = 'inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-3 py-1.5 font-maven text-xs font-semibold text-kidville-ink/80 hover:border-kidville-green disabled:opacity-50';

function Spinner() {
  const t = useTranslations('adminContabilita');
  return <div className="flex items-center gap-3 py-6"><div className="h-5 w-5 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" /><p className="font-maven text-sm text-kidville-muted">{t('merchCaricamento')}</p></div>;
}
function StatoBadge({ s }: { s: StatoRiga }) {
  const t = useTranslations('adminContabilita');
  const LABEL: Record<StatoRiga, string> = { da_ordinare: t('merchStatoDaOrdinare'), ordinato: t('merchStatoOrdinato'), arrivato: t('merchStatoArrivato'), consegnato: t('merchStatoConsegnato'), annullato: t('merchStatoAnnullato') };
  return <span className={cx('rounded-pill px-2 py-0.5 font-maven text-[11px] font-semibold', STATO_RIGA_TONE[s])}>{LABEL[s]}</span>;
}
// Stato vuoto nello stile dell'app (cerchio crema + emoji + testo), come le aree
// genitore/docente. Il testo resta invariato: l'emoji è decorativa.
function EmptyState({ emoji, children }: { emoji: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-kidville-cream text-2xl">{emoji}</div>
      <p className="font-maven text-sm text-kidville-muted">{children}</p>
    </div>
  );
}

// ============================ Panello Ordini ============================
function OrdiniPanel({ userId, ordini, loading, reload }: { userId: string | null; ordini: Ordine[]; loading: boolean; reload: () => void }) {
  const t = useTranslations('adminContabilita');
  const locale = useLocale();
  const STATO_LABEL: Record<StatoRiga, string> = { da_ordinare: t('merchStatoDaOrdinare'), ordinato: t('merchStatoOrdinato'), arrivato: t('merchStatoArrivato'), consegnato: t('merchStatoConsegnato'), annullato: t('merchStatoAnnullato') };
  const [q, setQ] = useState('');
  const [filtro, setFiltro] = useState('');
  const [sel, setSel] = useState<Ordine | null>(null);
  const [busy, setBusy] = useState(false);

  const filtrati = useMemo(() => ordini.filter((o) => {
    const nome = `${o.alunni?.nome ?? ''} ${o.alunni?.cognome ?? ''}`.toLowerCase();
    if (q && !nome.includes(q.toLowerCase())) return false;
    if (filtro && !o.righe.some((r) => (r.stato ?? 'da_ordinare') === filtro)) return false;
    return true;
  }), [ordini, q, filtro]);

  const selCorrente = sel ? ordini.find((o) => o.id === sel.id) ?? sel : null;

  const azione = async (path: string, method: string, body: unknown) => {
    setBusy(true);
    const res = await jsend(userId, path, method, body);
    setBusy(false);
    if (res.ok) reload(); else alert(res.error ?? t('merchOperazioneNonRiuscita'));
  };
  const cambioTaglia = async (r: Riga) => {
    const nuova = window.prompt(`${t('merchNuovaTagliaPer')} ${r.articolo_nome} (${t('merchAttuale')} ${r.taglia || '—'})`);
    if (nuova == null || !nuova.trim()) return;
    const reso = window.confirm(t('merchResoStock'));
    await azione('cambio-taglia', 'POST', { riga_id: r.id, nuova_taglia: nuova.trim(), reso_a_stock: reso });
  };

  return (
    <div className={CARD}>
      <Toolbar search={q} onSearch={setQ} placeholder={t('merchCercaAlunno')}>
        <CockpitSelect value={filtro} onChange={setFiltro} options={[{ value: '', label: t('merchTuttiGliStati') }, ...(['da_ordinare', 'ordinato', 'arrivato', 'consegnato', 'annullato'] as StatoRiga[]).map((s) => ({ value: s, label: STATO_LABEL[s] }))]} />
        <button type="button" className={BTN_GHOST} onClick={reload}><RefreshCw size={14} /> {t('merchAggiorna')}</button>
        <button type="button" className={BTN_GHOST} onClick={() => window.open(url(userId, 'export'), '_blank')}><Download size={14} /> {t('merchEsportaXLSX')}</button>
      </Toolbar>

      {loading ? <Spinner /> : filtrati.length === 0 ? (
        <EmptyState emoji="🛍️">{t('merchNessunOrdine')}</EmptyState>
      ) : (
        <div className="space-y-2">
          {filtrati.map((o) => {
            const nonPagato = o.pagamento && o.pagamento.stato !== 'pagato';
            return (
              <button key={o.id} type="button" onClick={() => setSel(o)} className="block w-full rounded-input border border-kidville-line p-3 text-left transition-colors hover:bg-kidville-cream">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-maven text-sm font-semibold text-kidville-ink">
                      {o.alunni ? `${o.alunni.nome} ${o.alunni.cognome}` : t('merchAlunno')}
                      {o.alunni?.classe_sezione && <span className="ml-2 font-normal text-kidville-muted">· {o.alunni.classe_sezione}</span>}
                    </p>
                    <p className="font-maven text-xs text-kidville-muted">{dataIt(o.creato_il, locale)} · {o.righe.length} {t('merchArticoli')}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {nonPagato && <span className="rounded-pill bg-kidville-warn-soft px-2 py-0.5 font-maven text-[11px] font-semibold text-kidville-warn">{t('merchNonSaldato')}</span>}
                    <span className="font-maven text-sm font-bold text-kidville-ink">{euro(o.totale)}</span>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {o.righe.map((r) => <span key={r.id} className={cx('rounded-pill px-2 py-0.5 font-maven text-[11px]', STATO_RIGA_TONE[(r.stato ?? 'da_ordinare')])}>{r.quantita}× {r.articolo_nome}{r.taglia ? ` (${r.taglia})` : ''}</span>)}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <Drawer open={!!selCorrente} onClose={() => setSel(null)} title={t('merchOrdine')} subtitle={selCorrente?.alunni ? `${selCorrente.alunni.nome} ${selCorrente.alunni.cognome}` : ''} width={480}>
        {selCorrente && (
          <div className="space-y-3">
            {selCorrente.pagamento && selCorrente.pagamento.stato !== 'pagato' && (
              <div className="flex items-start gap-2 rounded-input border border-kidville-warn/40 bg-kidville-warn-soft p-3">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-kidville-warn" />
                <p className="font-maven text-xs text-kidville-warn">{t('merchPagamentoNonSaldato1')} ({euro(selCorrente.pagamento.importo)}). {t('merchPagamentoNonSaldato2')}</p>
              </div>
            )}
            {selCorrente.righe.map((r) => {
              const s = (r.stato ?? 'da_ordinare') as StatoRiga;
              return (
                <div key={r.id} className="rounded-input border border-kidville-line p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-maven text-sm text-kidville-ink"><strong>{r.quantita}×</strong> {r.articolo_nome}{r.taglia ? ` (${r.taglia})` : ''}</p>
                    <StatoBadge s={s} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {s === 'da_ordinare' && <button type="button" disabled={busy} className={BTN_GHOST} onClick={() => azione('evadi-magazzino', 'POST', { riga_id: r.id })}><Warehouse size={13} /> {t('merchEvadiMagazzino')}</button>}
                    {s === 'ordinato' && <button type="button" disabled={busy} className={BTN_GHOST} onClick={() => azione('ordini-fornitore/checkin', 'POST', { righe_ids: [r.id] })}><Truck size={13} /> {t('merchRegistraArrivo')}</button>}
                    {s === 'arrivato' && <button type="button" disabled={busy} className={BTN_GHOST} onClick={() => azione('consegna', 'POST', { righe_ids: [r.id] })}><PackageCheck size={13} /> {t('merchConsegna')}</button>}
                    {s !== 'annullato' && <button type="button" disabled={busy} className={BTN_GHOST} onClick={() => cambioTaglia(r)}><Repeat size={13} /> {t('merchCambiaTaglia')}</button>}
                    {s !== 'consegnato' && s !== 'annullato' && <button type="button" disabled={busy} className={BTN_GHOST} onClick={() => { if (window.confirm(`${t('merchAnnullare')} ${r.quantita}× ${r.articolo_nome}${r.taglia ? ` (${r.taglia})` : ''}?`)) azione('righe', 'PATCH', { riga_id: r.id, stato: 'annullato' }); }}><X size={13} /> {t('merchAnnullaRiga')}</button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Drawer>
    </div>
  );
}

// ============================ Nuovo ordine ============================
interface AlunnoLite { id: string; label: string; sub: string }
function NuovoOrdinePanel({ userId, articoli, onCreated }: { userId: string | null; articoli: Articolo[]; onCreated: () => void }) {
  const t = useTranslations('adminContabilita');
  const [q, setQ] = useState('');
  const [risultati, setRisultati] = useState<AlunnoLite[]>([]);
  const [risultatiPer, setRisultatiPer] = useState('');
  const [alunno, setAlunno] = useState<AlunnoLite | null>(null);
  const [righe, setRighe] = useState<{ articolo_id: string; taglia: string; quantita: number }[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [celebra, setCelebra] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // chiave di idempotenza per invio: evita ordine+addebito doppi su retry/doppio click
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const term = q.trim();
    if (alunno || term.length < 2) return; // niente setState sincrono: il dropdown è gated in render
    const t = setTimeout(() => {
      fetch(`/api/admin/search?q=${encodeURIComponent(term)}${userId ? `&userId=${encodeURIComponent(userId)}` : ''}`)
        .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.success) { setRisultati(d.data.alunni ?? []); setRisultatiPer(term); } }).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [q, userId, alunno]);
  // il dropdown appare solo se i risultati sono della query corrente (niente
  // match della query precedente mostrati durante il debounce)
  const mostraRisultati = !alunno && q.trim().length >= 2 && risultati.length > 0 && risultatiPer === q.trim();

  const attivi = useMemo(() => articoli.filter((a) => a.attivo), [articoli]);
  const totale = righe.reduce((t, r) => { const a = articoli.find((x) => x.id === r.articolo_id); return t + (a ? a.prezzo * r.quantita : 0); }, 0);

  const addRiga = () => setRighe((rs) => [...rs, { articolo_id: attivi[0]?.id ?? '', taglia: attivi[0]?.taglie[0] ?? '', quantita: 1 }]);
  const setRiga = (i: number, patch: Partial<{ articolo_id: string; taglia: string; quantita: number }>) =>
    setRighe((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const delRiga = (i: number) => setRighe((rs) => rs.filter((_, j) => j !== i));

  const submit = async () => {
    if (!alunno || righe.length === 0) return;
    setSaving(true); setError(null);
    const res = await jsend(userId, 'ordini', 'POST', { alunno_id: alunno.id, righe: righe.map((r) => ({ articolo_id: r.articolo_id, taglia: r.taglia, quantita: r.quantita })), note: note.trim() || null, idempotency_key: idemKey });
    setSaving(false);
    if (!res.ok) { setError(res.error ?? t('merchOrdineNonRiuscito')); return; }
    setAlunno(null); setQ(''); setRighe([]); setNote('');
    setIdemKey(crypto.randomUUID()); // nuova chiave per il prossimo ordine
    setCelebra(t('merchOrdineCreato'));
    onCreated();
  };

  return (
    <div className={cx(CARD, 'max-w-[640px]')}>
      <SaveCelebration show={!!celebra} message={celebra ?? ''} onDone={() => setCelebra(null)} />
      <p className="font-barlow mb-3 text-xs font-bold uppercase tracking-wide text-kidville-green">{t('merchNuovoOrdineSegreteria')}</p>

      {/* Alunno */}
      {alunno ? (
        <div className="mb-4 flex items-center justify-between rounded-input border border-kidville-green/40 bg-kidville-green-soft px-3 py-2">
          <span className="font-maven text-sm text-kidville-green"><strong>{alunno.label}</strong> · {alunno.sub}</span>
          <button type="button" onClick={() => setAlunno(null)} aria-label={t('merchCambiaAlunno')} className="text-kidville-green"><X size={16} /></button>
        </div>
      ) : (
        <div className="relative mb-4">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-neutral"><Search size={16} /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('merchCercaAlunnoMin')} className={cx(INPUT, 'pl-9')} />
          {mostraRisultati && (
            <div className="absolute z-10 mt-1 w-full rounded-input border border-kidville-line bg-kidville-white shadow-lg">
              {risultati.map((a) => (
                <button key={a.id} type="button" onClick={() => { setAlunno(a); setRisultati([]); setQ(''); if (righe.length === 0) addRiga(); }} className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-kidville-cream">
                  <span className="font-maven text-sm text-kidville-ink">{a.label}</span>
                  <span className="font-maven text-xs text-kidville-muted">{a.sub}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Righe */}
      <div className="space-y-2">
        {righe.map((r, i) => {
          const a = articoli.find((x) => x.id === r.articolo_id);
          const taglie = a?.taglie ?? [];
          return (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-input border border-kidville-line p-2">
              <select value={r.articolo_id} onChange={(e) => { const na = articoli.find((x) => x.id === e.target.value); setRiga(i, { articolo_id: e.target.value, taglia: na?.taglie[0] ?? '' }); }} className={cx(INPUT, 'flex-1 min-w-[140px]')}>
                {attivi.map((x) => <option key={x.id} value={x.id}>{x.nome} — {euro(x.prezzo)}</option>)}
              </select>
              {taglie.length > 0 && (
                <select value={r.taglia} onChange={(e) => setRiga(i, { taglia: e.target.value })} className={cx(INPUT, 'w-24')}>
                  {taglie.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setRiga(i, { quantita: Math.max(1, r.quantita - 1) })} aria-label={t('merchDiminuisciQuantita')} className="flex h-8 w-8 items-center justify-center rounded-full border border-kidville-line"><Minus size={14} /></button>
                <span className="w-6 text-center font-maven text-sm font-bold">{r.quantita}</span>
                <button type="button" onClick={() => setRiga(i, { quantita: Math.min(200, r.quantita + 1) })} aria-label={t('merchAumentaQuantita')} className="flex h-8 w-8 items-center justify-center rounded-full border border-kidville-line"><Plus size={14} /></button>
              </div>
              <button type="button" onClick={() => delRiga(i)} aria-label={t('merchRimuovi')} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={15} /></button>
            </div>
          );
        })}
        {attivi.length === 0 && <p className="font-maven text-xs text-kidville-muted">{t('merchNessunArticoloAttivo1')}<strong>{t('merchCatalogo')}</strong>{t('merchNessunArticoloAttivo2')}</p>}
        <button type="button" onClick={addRiga} disabled={attivi.length === 0} className={BTN_GHOST}><Plus size={14} /> {t('merchAggiungiArticolo')}</button>
      </div>

      <label className="mt-3 block">
        <span className={LABEL}>{t('merchNoteFacoltative')}</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={cx(INPUT, 'mt-1')} placeholder={t('merchNotePlaceholder')} />
      </label>

      <div className="mt-4 flex items-center justify-between">
        <span className="font-maven text-sm text-kidville-muted">{t('merchTotale')} <strong className="text-kidville-ink">{euro(totale)}</strong></span>
        <button type="button" onClick={submit} disabled={saving || !alunno || righe.length === 0} className={BTN_PRIMARY}>{saving ? <RefreshCw size={16} className="animate-spin" /> : <ShoppingBag size={16} />} {t('merchCreaOrdine')}</button>
      </div>
      {error && <p className="mt-2 font-maven text-xs text-kidville-error">{error}</p>}
    </div>
  );
}

// ============================ Da ordinare ============================
function DaOrdinarePanel({ userId, onChanged }: { userId: string | null; onChanged: () => void }) {
  const t = useTranslations('adminContabilita');
  const [gruppi, setGruppi] = useState<DaOrdGruppo[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const d = await jget<{ gruppi: DaOrdGruppo[] }>(userId, 'da-ordinare'); setGruppi(d?.gruppi ?? []); } finally { setLoading(false); }
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const toggle = (ids: string[]) => setSel((prev) => { const n = new Set(prev); const all = ids.every((i) => n.has(i)); ids.forEach((i) => (all ? n.delete(i) : n.add(i))); return n; });

  const generaPO = async (fornitoreId: string | null, righeIds: string[]) => {
    const ids = righeIds.filter((i) => sel.has(i));
    const daInviare = ids.length > 0 ? ids : righeIds;
    if (daInviare.length === 0) return;
    setBusy(true);
    const res = await jsend(userId, 'ordini-fornitore', 'POST', { fornitore_id: fornitoreId, righe_ids: daInviare });
    setBusy(false);
    if (res.ok) {
      const po = (res.data as { po?: { id: string } | null })?.po;
      if (po?.id) window.open(url(userId, `ordini-fornitore/pdf?id=${po.id}`), '_blank');
      setSel(new Set()); load(); onChanged();
    } else alert(res.error ?? t('merchOperazioneNonRiuscita'));
  };

  const evadi = async (righeIds: string[]) => {
    if (righeIds.length === 0) return;
    if (!window.confirm(`${t('merchEvadereMagazzino')} ${righeIds.length} ${righeIds.length === 1 ? t('merchRigaSing') : t('merchRigaPlur')}? ${t('merchStockScalato')}`)) return;
    setBusy(true);
    for (const id of righeIds) { const r = await jsend(userId, 'evadi-magazzino', 'POST', { riga_id: id }); if (!r.ok) { alert(r.error ?? t('merchStockInsufficiente')); break; } }
    setBusy(false); load(); onChanged();
  };

  if (loading) return <div className={CARD}><Spinner /></div>;
  if (gruppi.length === 0) return <div className={CARD}><EmptyState emoji="🎉">{t('merchNessunaRigaOrdinare')}</EmptyState></div>;

  return (
    <div className="space-y-4">
      {gruppi.map((g, gi) => {
        const tutteIds = g.articoli.flatMap((a) => a.taglie.flatMap((t) => t.righe_ids));
        return (
          <div key={gi} className={CARD}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="font-barlow text-sm font-bold uppercase tracking-wide text-kidville-green">{g.fornitore ? g.fornitore.nome : t('merchSenzaFornitore')} <span className="ml-1 font-maven text-xs font-normal text-kidville-muted">· {g.quantita} {t('merchPezzi')}</span></p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} className={BTN_GHOST} onClick={() => { const s = tutteIds.filter((i) => sel.has(i)); evadi(s.length ? s : tutteIds); }}><Warehouse size={13} /> {t('merchEvadiMagazzino')}</button>
                {g.fornitore
                  ? <button type="button" disabled={busy} className={BTN_PRIMARY} onClick={() => generaPO(g.fornitore!.id, tutteIds)}><FileText size={15} /> {t('merchGeneraOrdinePDF')}</button>
                  : <button type="button" disabled={busy} className={BTN_GHOST} onClick={() => generaPO(null, tutteIds)}><Check size={13} /> {t('merchSegnaOrdinato')}</button>}
              </div>
            </div>
            <div className={TABLE_WRAP}>
              <table className={TABLE}>
                <thead><tr><th className={TH}></th><th className={TH}>{t('merchColArticolo')}</th><th className={TH}>{t('merchColTaglia')}</th><th className={TH}>{t('merchColQta')}</th></tr></thead>
                <tbody>
                  {g.articoli.map((a) => a.taglie.map((tg) => {
                    const on = tg.righe_ids.every((i) => sel.has(i));
                    return (
                      <tr key={`${a.articolo_id}-${tg.taglia}`} className={TROW}>
                        <td className={TD}><input type="checkbox" aria-label={`${a.nome} ${t('merchTaglia')} ${tg.taglia || t('merchUnica')}`} checked={on} onChange={() => toggle(tg.righe_ids)} className="accent-kidville-green" /></td>
                        <td className={cx(TD, 'font-maven text-sm text-kidville-ink')}>{a.nome}</td>
                        <td className={cx(TD, 'font-maven text-sm')}>{tg.taglia || '—'}</td>
                        <td className={cx(TD, 'font-maven text-sm font-semibold')}>{tg.quantita}</td>
                      </tr>
                    );
                  }))}
                </tbody>
              </table>
            </div>
            {!g.fornitore && <p className="mt-2 font-maven text-xs text-kidville-muted">{t('merchAssociaFornitore')}</p>}
          </div>
        );
      })}
    </div>
  );
}

// ============================ Arrivi ============================
function ArriviPanel({ userId, onChanged }: { userId: string | null; onChanged: () => void }) {
  const t = useTranslations('adminContabilita');
  const locale = useLocale();
  const [po, setPo] = useState<PO[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const d = await jget<PO[]>(userId, 'ordini-fornitore'); setPo(d ?? []); } finally { setLoading(false); }
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const aperti = po.filter((p) => p.stato === 'aperto');
  const toggle = (id: string) => setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const checkin = async (righeIds: string[]) => {
    const selezionate = righeIds.filter((i) => sel.has(i));
    const ids = selezionate.length > 0 ? selezionate : righeIds; // nessuna selezione = tutte le righe da ricevere
    if (ids.length === 0) return;
    setBusy(true);
    const res = await jsend(userId, 'ordini-fornitore/checkin', 'POST', { righe_ids: ids });
    setBusy(false);
    if (res.ok) { setSel(new Set()); load(); onChanged(); } else alert(res.error ?? t('merchOperazioneNonRiuscita'));
  };

  if (loading) return <div className={CARD}><Spinner /></div>;
  if (aperti.length === 0) return <div className={CARD}><EmptyState emoji="🚚">{t('merchNessunOrdineFornitore')}</EmptyState></div>;

  return (
    <div className="space-y-4">
      {aperti.map((p) => {
        const daRicevere = p.righe.filter((r) => r.stato === 'ordinato');
        return (
          <div key={p.id} className={CARD}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-barlow text-sm font-bold uppercase tracking-wide text-kidville-green">{p.numero}</p>
                <p className="font-maven text-xs text-kidville-muted">{p.fornitore_nome} · {dataIt(p.creato_il, locale)}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" className={BTN_GHOST} onClick={() => window.open(url(userId, `ordini-fornitore/pdf?id=${p.id}`), '_blank')}><FileText size={13} /> {t('merchRistampaPDF')}</button>
                <button type="button" disabled={busy || daRicevere.length === 0} className={BTN_PRIMARY} onClick={() => checkin(daRicevere.map((r) => r.id))}><Truck size={15} /> {t('merchRegistraArrivo')}</button>
              </div>
            </div>
            {daRicevere.length === 0 ? <p className="font-maven text-xs text-kidville-muted">{t('merchTutteRigheArrivate')}</p> : (
              <div className="space-y-1.5">
                {daRicevere.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 rounded-input border border-kidville-line px-3 py-2">
                    <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} className="accent-kidville-green" />
                    <span className="font-maven text-sm text-kidville-ink">{r.quantita}× {r.articolo_nome}{r.taglia ? ` (${r.taglia})` : ''}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================ Consegne ============================
function ConsegnePanel({ userId, ordini, reload }: { userId: string | null; ordini: Ordine[]; reload: () => void }) {
  const t = useTranslations('adminContabilita');
  const [busy, setBusy] = useState(false);
  const daConsegnare = ordini.map((o) => ({ o, righe: o.righe.filter((r) => (r.stato ?? 'da_ordinare') === 'arrivato') })).filter((x) => x.righe.length > 0);

  const consegna = async (righeIds: string[]) => {
    setBusy(true);
    const res = await jsend(userId, 'consegna', 'POST', { righe_ids: righeIds });
    setBusy(false);
    if (res.ok) reload(); else alert(res.error ?? t('merchOperazioneNonRiuscita'));
  };

  if (daConsegnare.length === 0) return <div className={CARD}><EmptyState emoji="📦">{t('merchNienteConsegnare')}</EmptyState></div>;
  return (
    <div className="space-y-3">
      {daConsegnare.map(({ o, righe }) => {
        const nonPagato = o.pagamento && o.pagamento.stato !== 'pagato';
        return (
          <div key={o.id} className={CARD}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-maven text-sm font-semibold text-kidville-ink">{o.alunni ? `${o.alunni.nome} ${o.alunni.cognome}` : t('merchAlunno')}{o.alunni?.classe_sezione && <span className="ml-2 font-normal text-kidville-muted">· {o.alunni.classe_sezione}</span>}</p>
              <button type="button" disabled={busy} className={BTN_PRIMARY} onClick={() => consegna(righe.map((r) => r.id))}><PackageCheck size={15} /> {t('merchConfermaConsegna')}</button>
            </div>
            {nonPagato && (
              <div className="mt-2 flex items-start gap-2 rounded-input border border-kidville-warn/40 bg-kidville-warn-soft p-2.5">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-kidville-warn" />
                <p className="font-maven text-xs text-kidville-warn">{t('merchPagamentoNonSaldatoC1')} ({euro(o.pagamento!.importo)}). {t('merchPagamentoNonSaldatoC2')}</p>
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {righe.map((r) => <span key={r.id} className="rounded-pill bg-kidville-warn-soft px-2 py-0.5 font-maven text-[11px] text-kidville-warn">{r.quantita}× {r.articolo_nome}{r.taglia ? ` (${r.taglia})` : ''}</span>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================ Catalogo ============================
interface CatForm { id: string | null; nome: string; descrizione: string; taglie: string; prezzo: string; categoria: Categoria; fornitore_id: string; prezzo_acquisto: string; attivo: boolean }
const CAT_EMPTY: CatForm = { id: null, nome: '', descrizione: '', taglie: 'S, M, L, XL', prezzo: '', categoria: 'divisa', fornitore_id: '', prezzo_acquisto: '', attivo: true };
function CatalogoPanel({ userId, articoli, fornitori, reload }: { userId: string | null; articoli: Articolo[]; fornitori: Fornitore[]; reload: () => void }) {
  const t = useTranslations('adminContabilita');
  const [form, setForm] = useState<CatForm>(CAT_EMPTY);
  const [saving, setSaving] = useState(false);
  const [tick, setTick] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nomeFornitore = (id?: string | null) => fornitori.find((f) => f.id === id)?.nome ?? '—';
  const edit = (a: Articolo) => setForm({ id: a.id, nome: a.nome, descrizione: a.descrizione ?? '', taglie: a.taglie.join(', '), prezzo: String(a.prezzo), categoria: (a.categoria ?? 'divisa'), fornitore_id: a.fornitore_id ?? '', prezzo_acquisto: a.prezzo_acquisto != null ? String(a.prezzo_acquisto) : '', attivo: a.attivo });
  const reset = () => { setForm(CAT_EMPTY); setError(null); };

  const submit = async () => {
    const taglie = form.taglie.split(',').map((t) => t.trim()).filter(Boolean);
    const prezzo = Number(form.prezzo.replace(',', '.')); // accetta la virgola decimale italiana
    if (!form.nome.trim()) { setError(t('merchNomeObbligatorio')); return; }
    if (!Number.isFinite(prezzo) || prezzo < 0) { setError(t('merchPrezzoNonValido')); return; }
    setSaving(true); setError(null);
    const body: Record<string, unknown> = { nome: form.nome.trim(), descrizione: form.descrizione.trim() || null, taglie, prezzo, categoria: form.categoria, fornitore_id: form.fornitore_id || null, prezzo_acquisto: form.prezzo_acquisto ? Number(form.prezzo_acquisto.replace(',', '.')) : null, attivo: form.attivo };
    const res = form.id ? await jsend(userId, 'articoli', 'PATCH', { id: form.id, ...body }) : await jsend(userId, 'articoli', 'POST', body);
    setSaving(false);
    if (!res.ok) { setError(res.error ?? t('merchSalvataggioNonRiuscito')); return; }
    reset(); reload(); setTick(true); window.setTimeout(() => setTick(false), 1600);
  };
  const toggleAttivo = async (a: Articolo) => {
    setTogglingId(a.id); setError(null);
    const res = await jsend(userId, 'articoli', 'PATCH', { id: a.id, attivo: !a.attivo });
    setTogglingId(null);
    if (res.ok) reload(); else setError(res.error ?? t('merchAggiornamentoNonRiuscito'));
  };
  const del = async (a: Articolo) => { if (!window.confirm(`${t('merchEliminare')} "${a.nome}"? ${t('merchOrdiniRestano')}`)) return; await jsend(userId, `articoli?id=${a.id}`, 'DELETE', {}); if (form.id === a.id) reset(); reload(); };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className={CARD}>
        <p className="font-barlow mb-3 text-xs font-bold uppercase tracking-wide text-kidville-green">{t('merchCatalogoArticoli')}</p>
        {articoli.length === 0 ? <EmptyState emoji="👕">{t('merchNessunArticolo')}</EmptyState> : (
          <div className={TABLE_WRAP}>
            <table className={TABLE}>
              <thead><tr><th className={TH}>{t('merchColArticolo')}</th><th className={TH}>{t('merchColCat')}</th><th className={TH}>{t('merchColFornitore')}</th><th className={TH}>{t('merchColTaglie')}</th><th className={TH}>{t('merchColPrezzo')}</th><th className={TH}>{t('merchColStato')}</th><th className={TH}></th></tr></thead>
              <tbody>
                {articoli.map((a) => (
                  <tr key={a.id} className={TROW}>
                    <td className={cx(TD, 'font-maven text-sm text-kidville-ink')}><span className="font-semibold">{a.nome}</span>{a.descrizione && <span className="block text-xs text-kidville-muted">{a.descrizione}</span>}</td>
                    <td className={cx(TD, 'font-maven text-xs capitalize text-kidville-muted')}>{a.categoria ?? 'divisa'}</td>
                    <td className={cx(TD, 'font-maven text-xs text-kidville-muted')}>{nomeFornitore(a.fornitore_id)}</td>
                    <td className={TD}><div className="flex flex-wrap gap-1">{a.taglie.length === 0 ? <span className="font-maven text-xs text-kidville-muted">—</span> : a.taglie.map((t) => <span key={t} className="rounded-pill bg-kidville-cream px-2 py-0.5 font-maven text-xs font-semibold text-kidville-ink">{t}</span>)}</div></td>
                    <td className={cx(TD, 'font-maven text-sm font-semibold text-kidville-ink')}>{euro(a.prezzo)}</td>
                    <td className={TD}><button onClick={() => toggleAttivo(a)} disabled={togglingId === a.id} className={cx('rounded-pill px-2.5 py-1 font-maven text-xs font-semibold disabled:opacity-50', a.attivo ? 'bg-kidville-green-soft text-kidville-green' : 'bg-kidville-line/50 text-kidville-muted')}>{a.attivo ? t('merchAttivo') : t('merchNascosto')}</button></td>
                    <td className={TD}><div className="flex items-center gap-2"><button onClick={() => edit(a)} aria-label={t('merchModifica')} className="text-kidville-muted hover:text-kidville-green"><Pencil size={15} /></button><button onClick={() => del(a)} aria-label={t('merchElimina')} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={15} /></button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={cx(CARD, 'h-fit')}>
        <div className="mb-3 flex items-center justify-between">
          <p className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">{form.id ? t('merchModificaArticolo') : t('merchNuovoArticolo')}</p>
          {form.id && <button onClick={reset} aria-label={t('merchAnnulla')} className="text-kidville-muted hover:text-kidville-ink"><X size={16} /></button>}
        </div>
        <div className="space-y-3">
          <label className="block"><span className={LABEL}>{t('merchNome')}</span><input value={form.nome} onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))} placeholder={t('merchNomePlaceholder')} className={cx(INPUT, 'mt-1')} /></label>
          <label className="block"><span className={LABEL}>{t('merchDescrizione')}</span><input value={form.descrizione} onChange={(e) => setForm((f) => ({ ...f, descrizione: e.target.value }))} className={cx(INPUT, 'mt-1')} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className={LABEL}>{t('merchCategoria')}</span>
              <select value={form.categoria} onChange={(e) => setForm((f) => ({ ...f, categoria: e.target.value as Categoria }))} className={cx(INPUT, 'mt-1 capitalize')}>{CATEGORIE.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </label>
            <label className="block"><span className={LABEL}>{t('merchFornitore')}</span>
              <select value={form.fornitore_id} onChange={(e) => setForm((f) => ({ ...f, fornitore_id: e.target.value }))} className={cx(INPUT, 'mt-1')}><option value="">—</option>{fornitori.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}</select>
            </label>
          </div>
          <label className="block"><span className={LABEL}>{t('merchTaglieLabel')}</span><input value={form.taglie} onChange={(e) => setForm((f) => ({ ...f, taglie: e.target.value }))} className={cx(INPUT, 'mt-1')} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className={LABEL}>{t('merchPrezzoVendita')}</span><input value={form.prezzo} onChange={(e) => setForm((f) => ({ ...f, prezzo: e.target.value }))} inputMode="decimal" className={cx(INPUT, 'mt-1')} /></label>
            <label className="block"><span className={LABEL}>{t('merchPrezzoAcquisto')}</span><input value={form.prezzo_acquisto} onChange={(e) => setForm((f) => ({ ...f, prezzo_acquisto: e.target.value }))} inputMode="decimal" placeholder={t('merchOpz')} className={cx(INPUT, 'mt-1')} /></label>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.attivo} onChange={(e) => setForm((f) => ({ ...f, attivo: e.target.checked }))} className="accent-kidville-green" /><span className="font-maven text-sm text-kidville-ink">{t('merchAttivoOrdinabile')}</span></label>
          {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}
          <button onClick={submit} disabled={saving} className={cx(BTN_PRIMARY, 'w-full')}>{tick ? <SaveCheck className="text-kidville-yellow" /> : <Save size={16} />} {form.id ? t('merchSalvaModifiche') : t('merchAggiungiArticolo')}</button>
        </div>
      </div>
    </div>
  );
}

// ============================ Giacenze ============================
function GiacenzePanel({ userId, articoli }: { userId: string | null; articoli: Articolo[] }) {
  const t = useTranslations('adminContabilita');
  const [matrice, setMatrice] = useState<GiacenzaCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [artId, setArtId] = useState('');
  const [taglia, setTaglia] = useState('');
  const [delta, setDelta] = useState('');
  const [motivo, setMotivo] = useState<'carico' | 'reso' | 'scarico' | 'inventario' | 'correzione'>('carico');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const d = await jget<{ matrice: GiacenzaCell[] }>(userId, 'giacenze'); setMatrice(d?.matrice ?? []); } finally { setLoading(false); }
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const art = articoli.find((a) => a.id === artId);
  const submit = async () => {
    const d = Number(delta);
    if (!artId) { setError(t('merchScegliArticolo')); return; }
    if (!Number.isInteger(d) || d === 0) { setError(t('merchQuantitaIntera')); return; }
    setSaving(true); setError(null);
    const res = await jsend(userId, 'giacenze', 'POST', { articolo_id: artId, taglia, quantita_delta: d, motivo });
    setSaving(false);
    if (!res.ok) { setError(res.error ?? t('merchRettificaNonRiuscita')); return; }
    setDelta(''); load();
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className={CARD}>
        <p className="font-barlow mb-3 text-xs font-bold uppercase tracking-wide text-kidville-green">{t('merchGiacenzeAuto')}</p>
        {loading ? <Spinner /> : matrice.length === 0 ? <EmptyState emoji="📦">{t('merchNessunaGiacenza')}</EmptyState> : (
          <div className={TABLE_WRAP}>
            <table className={TABLE}>
              <thead><tr><th className={TH}>{t('merchColArticolo')}</th><th className={TH}>{t('merchColTaglia')}</th><th className={TH}>{t('merchColDisponibile')}</th><th className={TH}>{t('merchColInArrivo')}</th><th className={TH}>{t('merchColDaConsegnare')}</th></tr></thead>
              <tbody>
                {matrice.map((c, i) => (
                  <tr key={i} className={TROW}>
                    <td className={cx(TD, 'font-maven text-sm text-kidville-ink')}>{c.nome || '—'}</td>
                    <td className={cx(TD, 'font-maven text-sm')}>{c.taglia || '—'}</td>
                    <td className={cx(TD, 'font-maven text-sm font-bold', c.disponibile <= 0 ? 'text-kidville-error' : 'text-kidville-green')}>{c.disponibile}</td>
                    <td className={cx(TD, 'font-maven text-sm text-kidville-info')}>{c.inArrivo}</td>
                    <td className={cx(TD, 'font-maven text-sm text-kidville-warn')}>{c.daConsegnare}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className={cx(CARD, 'h-fit')}>
        <p className="font-barlow mb-3 text-xs font-bold uppercase tracking-wide text-kidville-green">{t('merchRettificaMagazzino')}</p>
        <div className="space-y-3">
          <label className="block"><span className={LABEL}>{t('merchColArticolo')}</span>
            <select value={artId} onChange={(e) => { setArtId(e.target.value); const a = articoli.find((x) => x.id === e.target.value); setTaglia(a?.taglie[0] ?? ''); }} className={cx(INPUT, 'mt-1')}><option value="">—</option>{articoli.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}</select>
          </label>
          {art && art.taglie.length > 0 && (
            <label className="block"><span className={LABEL}>{t('merchColTaglia')}</span><select value={taglia} onChange={(e) => setTaglia(e.target.value)} className={cx(INPUT, 'mt-1')}>{art.taglie.map((tg) => <option key={tg} value={tg}>{tg}</option>)}</select></label>
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className={LABEL}>{t('merchDelta')}</span><input value={delta} onChange={(e) => setDelta(e.target.value)} inputMode="numeric" placeholder={t('merchDeltaPlaceholder')} className={cx(INPUT, 'mt-1')} /></label>
            <label className="block"><span className={LABEL}>{t('merchMotivo')}</span><select value={motivo} onChange={(e) => setMotivo(e.target.value as typeof motivo)} className={cx(INPUT, 'mt-1')}>{['carico', 'reso', 'scarico', 'inventario', 'correzione'].map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          </div>
          {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}
          <button onClick={submit} disabled={saving} className={cx(BTN_PRIMARY, 'w-full')}><Save size={16} /> {t('merchRegistraRettifica')}</button>
        </div>
      </div>
    </div>
  );
}

// ============================ Fornitori ============================
interface FornForm { id: string | null; nome: string; referente: string; email: string; telefono: string; piva: string; indirizzo: string; note: string; attivo: boolean }
const FORN_EMPTY: FornForm = { id: null, nome: '', referente: '', email: '', telefono: '', piva: '', indirizzo: '', note: '', attivo: true };
function FornitoriPanel({ userId, fornitori, reload }: { userId: string | null; fornitori: Fornitore[]; reload: () => void }) {
  const t = useTranslations('adminContabilita');
  const [form, setForm] = useState<FornForm>(FORN_EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edit = (f: Fornitore) => setForm({ id: f.id, nome: f.nome, referente: f.referente ?? '', email: f.email ?? '', telefono: f.telefono ?? '', piva: f.piva ?? '', indirizzo: f.indirizzo ?? '', note: f.note ?? '', attivo: f.attivo });
  const reset = () => { setForm(FORN_EMPTY); setError(null); };
  const submit = async () => {
    if (!form.nome.trim()) { setError(t('merchNomeObbligatorio')); return; }
    setSaving(true); setError(null);
    const body = { nome: form.nome.trim(), referente: form.referente.trim() || null, email: form.email.trim() || null, telefono: form.telefono.trim() || null, piva: form.piva.trim() || null, indirizzo: form.indirizzo.trim() || null, note: form.note.trim() || null, attivo: form.attivo };
    const res = form.id ? await jsend(userId, 'fornitori', 'PATCH', { id: form.id, ...body }) : await jsend(userId, 'fornitori', 'POST', body);
    setSaving(false);
    if (!res.ok) { setError(res.error ?? t('merchSalvataggioNonRiuscito')); return; }
    reset(); reload();
  };
  const del = async (f: Fornitore) => { if (!window.confirm(`${t('merchEliminareFornitore')} "${f.nome}"?`)) return; await jsend(userId, `fornitori?id=${f.id}`, 'DELETE', {}); if (form.id === f.id) reset(); reload(); };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className={CARD}>
        <p className="font-barlow mb-3 text-xs font-bold uppercase tracking-wide text-kidville-green">{t('merchFornitori')}</p>
        {fornitori.length === 0 ? <EmptyState emoji="🏭">{t('merchNessunFornitore')}</EmptyState> : (
          <div className="space-y-2">
            {fornitori.map((f) => (
              <div key={f.id} className="flex items-start justify-between gap-2 rounded-input border border-kidville-line p-3">
                <div className="min-w-0">
                  <p className="font-maven text-sm font-semibold text-kidville-ink">{f.nome}{!f.attivo && <span className="ml-2 rounded-pill bg-kidville-line/50 px-2 py-0.5 font-maven text-[10px] font-semibold text-kidville-muted">{t('merchInattivo')}</span>}</p>
                  <p className="font-maven text-xs text-kidville-muted">{[f.referente, f.email, f.telefono].filter(Boolean).join(' · ') || '—'}</p>
                </div>
                <div className="flex items-center gap-2"><button onClick={() => edit(f)} aria-label={t('merchModifica')} className="text-kidville-muted hover:text-kidville-green"><Pencil size={15} /></button><button onClick={() => del(f)} aria-label={t('merchElimina')} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={15} /></button></div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={cx(CARD, 'h-fit')}>
        <div className="mb-3 flex items-center justify-between">
          <p className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">{form.id ? t('merchModificaFornitore') : t('merchNuovoFornitore')}</p>
          {form.id && <button onClick={reset} aria-label={t('merchAnnulla')} className="text-kidville-muted hover:text-kidville-ink"><X size={16} /></button>}
        </div>
        <div className="space-y-3">
          <label className="block"><span className={LABEL}>{t('merchNomeAst')}</span><input value={form.nome} onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))} className={cx(INPUT, 'mt-1')} /></label>
          <label className="block"><span className={LABEL}>{t('merchReferente')}</span><input value={form.referente} onChange={(e) => setForm((f) => ({ ...f, referente: e.target.value }))} className={cx(INPUT, 'mt-1')} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className={LABEL}>{t('merchEmail')}</span><input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className={cx(INPUT, 'mt-1')} /></label>
            <label className="block"><span className={LABEL}>{t('merchTelefono')}</span><input value={form.telefono} onChange={(e) => setForm((f) => ({ ...f, telefono: e.target.value }))} className={cx(INPUT, 'mt-1')} /></label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className={LABEL}>{t('merchPIVA')}</span><input value={form.piva} onChange={(e) => setForm((f) => ({ ...f, piva: e.target.value }))} className={cx(INPUT, 'mt-1')} /></label>
            <label className="flex items-end gap-2 pb-2"><input type="checkbox" checked={form.attivo} onChange={(e) => setForm((f) => ({ ...f, attivo: e.target.checked }))} className="accent-kidville-green" /><span className="font-maven text-sm text-kidville-ink">{t('merchAttivo')}</span></label>
          </div>
          <label className="block"><span className={LABEL}>{t('merchIndirizzo')}</span><input value={form.indirizzo} onChange={(e) => setForm((f) => ({ ...f, indirizzo: e.target.value }))} className={cx(INPUT, 'mt-1')} /></label>
          <label className="block"><span className={LABEL}>{t('merchNote')}</span><input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} className={cx(INPUT, 'mt-1')} /></label>
          {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}
          <button onClick={submit} disabled={saving} className={cx(BTN_PRIMARY, 'w-full')}><Save size={16} /> {form.id ? t('merchSalva') : t('merchAggiungi')}</button>
        </div>
      </div>
    </div>
  );
}

// ============================ Shell ============================
function MerchandiseInner() {
  const t = useTranslations('adminContabilita');
  const { userId } = useSessionIdentity();
  const router = useRouter();
  const params = useSearchParams();
  const vista = (params.get('vista') as Vista) || 'ordini';
  const setVista = (v: Vista) => router.replace(`?vista=${v}`, { scroll: false });

  const [ordini, setOrdini] = useState<Ordine[]>([]);
  const [articoli, setArticoli] = useState<Articolo[]>([]);
  const [fornitori, setFornitori] = useState<Fornitore[]>([]);
  const [loadingOrd, setLoadingOrd] = useState(true);

  const reloadOrdini = useCallback(async () => {
    try { const d = await jget<Ordine[]>(userId, 'ordini'); setOrdini(d ?? []); } finally { setLoadingOrd(false); }
  }, [userId]);
  const reloadArticoli = useCallback(async () => { const d = await jget<Articolo[]>(userId, 'articoli'); setArticoli(d ?? []); }, [userId]);
  const reloadFornitori = useCallback(async () => { const d = await jget<Fornitore[]>(userId, 'fornitori'); setFornitori(d ?? []); }, [userId]);
  const reloadAll = useCallback(async () => {
    try {
      const [o, a, f] = await Promise.all([jget<Ordine[]>(userId, 'ordini'), jget<Articolo[]>(userId, 'articoli'), jget<Fornitore[]>(userId, 'fornitori')]);
      setOrdini(o ?? []); setArticoli(a ?? []); setFornitori(f ?? []);
    } finally { setLoadingOrd(false); }
  }, [userId]);

  useEffect(() => { if (userId) reloadAll(); }, [userId, reloadAll]);

  const kpi = useMemo(() => {
    let daOrd = 0, inArr = 0, daCons = 0;
    for (const o of ordini) for (const r of o.righe) {
      const s = r.stato ?? 'da_ordinare';
      if (s === 'da_ordinare') daOrd += r.quantita;
      else if (s === 'ordinato') inArr += r.quantita;
      else if (s === 'arrivato') daCons += r.quantita;
    }
    const aperti = ordini.filter((o) => o.stato === 'inviato' || o.stato === 'confermato').length;
    return { daOrd, inArr, daCons, aperti };
  }, [ordini]);

  return (
    <CockpitPage max={1280}>
      <PageHeader eyebrow={t('merchEyebrow')} icon={ShoppingBag} title={t('merchTitolo')} subtitle={t('merchSottotitolo')} />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={ListChecks} label={t('merchKpiDaOrdinare')} value={loadingOrd ? '…' : kpi.daOrd} tone="neutral" />
        <StatCard icon={Truck} label={t('merchKpiInArrivo')} value={loadingOrd ? '…' : kpi.inArr} tone="info" />
        <StatCard icon={PackageCheck} label={t('merchKpiDaConsegnare')} value={loadingOrd ? '…' : kpi.daCons} tone="warn" />
        <StatCard icon={ClipboardList} label={t('merchKpiOrdiniAperti')} value={loadingOrd ? '…' : kpi.aperti} tone="green" />
      </div>

      <MerchNav value={vista} onChange={setVista} />

      {vista === 'ordini' && <OrdiniPanel userId={userId} ordini={ordini} loading={loadingOrd} reload={reloadOrdini} />}
      {vista === 'nuovo' && <NuovoOrdinePanel userId={userId} articoli={articoli} onCreated={reloadOrdini} />}
      {vista === 'da_ordinare' && <DaOrdinarePanel userId={userId} onChanged={reloadOrdini} />}
      {vista === 'arrivi' && <ArriviPanel userId={userId} onChanged={reloadOrdini} />}
      {vista === 'consegne' && <ConsegnePanel userId={userId} ordini={ordini} reload={reloadOrdini} />}
      {vista === 'catalogo' && <CatalogoPanel userId={userId} articoli={articoli} fornitori={fornitori} reload={reloadArticoli} />}
      {vista === 'giacenze' && <GiacenzePanel userId={userId} articoli={articoli} />}
      {vista === 'fornitori' && <FornitoriPanel userId={userId} fornitori={fornitori} reload={reloadFornitori} />}
    </CockpitPage>
  );
}

export default function MerchandisePage() {
  const t = useTranslations('adminContabilita');
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">{t('merchCaricamento')}</div>}>
      <MerchandiseInner />
    </Suspense>
  );
}
