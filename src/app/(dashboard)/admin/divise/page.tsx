'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { Shirt, Package, ShoppingBag, Euro, Save, Trash2, Pencil, X } from 'lucide-react';
import {
  CockpitPage, PageHeader, StatCard, Tabs,
  TABLE, TABLE_WRAP, TD, TH, TROW,
} from '@/components/ui/cockpit';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

// Catalogo divise + ordini nel cockpit (segreteria/direzione). Il catalogo è per
// plesso (scoping server-side); il genitore ordina dallo shop /parent/divise e
// l'ordine genera un pagamento da saldare offline. Qui: gestione articoli e
// avanzamento stato degli ordini.

interface Articolo {
  id: string;
  scuola_id: string;
  nome: string;
  descrizione: string | null;
  taglie: string[];
  prezzo: number;
  attivo: boolean;
  ordine: number;
}
interface RigaOrdine {
  id: string;
  articolo_id: string | null;
  articolo_nome: string;
  taglia: string;
  quantita: number;
  prezzo_unitario: number;
}
interface Ordine {
  id: string;
  alunno_id: string;
  stato: 'inviato' | 'confermato' | 'consegnato' | 'annullato';
  totale: number;
  pagamento_id: string | null;
  note: string | null;
  creato_il: string;
  alunni: { nome: string; cognome: string; classe_sezione: string | null } | null;
  righe: RigaOrdine[];
}

const STATI: Ordine['stato'][] = ['inviato', 'confermato', 'consegnato', 'annullato'];
const STATO_TONE: Record<Ordine['stato'], string> = {
  inviato: 'bg-kidville-warn-soft text-kidville-warn',
  confermato: 'bg-kidville-info-soft text-kidville-info',
  consegnato: 'bg-kidville-green-soft text-kidville-green',
  annullato: 'bg-kidville-line/50 text-kidville-muted',
};

function euro(n: number) {
  return `€ ${Number(n).toFixed(2)}`;
}

interface FormState {
  id: string | null;
  nome: string;
  descrizione: string;
  taglie: string;
  prezzo: string;
  attivo: boolean;
}
const EMPTY_FORM: FormState = { id: null, nome: '', descrizione: '', taglie: 'S, M, L, XL', prezzo: '', attivo: true };

function AdminDiviseInner() {
  const { userId } = useSessionIdentity();
  const [tab, setTab] = useState<'catalogo' | 'ordini'>('catalogo');

  const [articoli, setArticoli] = useState<Articolo[]>([]);
  const [ordini, setOrdini] = useState<Ordine[]>([]);
  const [loadingCat, setLoadingCat] = useState(true);
  const [loadingOrd, setLoadingOrd] = useState(true);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadArticoli = (uid: string) => {
    fetch(`/api/admin/merch/articoli?userId=${uid}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.success) setArticoli(d.data ?? []); })
      .catch(() => {})
      .finally(() => setLoadingCat(false));
  };
  const loadOrdini = (uid: string) => {
    fetch(`/api/admin/merch/ordini?userId=${uid}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.success) setOrdini(d.data ?? []); })
      .catch(() => {})
      .finally(() => setLoadingOrd(false));
  };

  useEffect(() => {
    if (!userId) return;
    loadArticoli(userId);
    loadOrdini(userId);
  }, [userId]);

  const startEdit = (a: Articolo) => {
    setError(null);
    setForm({
      id: a.id,
      nome: a.nome,
      descrizione: a.descrizione ?? '',
      taglie: a.taglie.join(', '),
      prezzo: String(a.prezzo),
      attivo: a.attivo,
    });
  };
  const resetForm = () => { setForm(EMPTY_FORM); setError(null); };

  const submitArticolo = async () => {
    if (!userId) return;
    const taglie = form.taglie.split(',').map(t => t.trim()).filter(Boolean);
    const prezzo = Number(form.prezzo);
    if (!form.nome.trim()) { setError('Il nome è obbligatorio'); return; }
    if (!Number.isFinite(prezzo) || prezzo < 0) { setError('Prezzo non valido'); return; }
    setSaving(true);
    setError(null);
    try {
      const isEdit = !!form.id;
      const body = isEdit
        ? { id: form.id, nome: form.nome.trim(), descrizione: form.descrizione.trim() || null, taglie, prezzo, attivo: form.attivo }
        : { nome: form.nome.trim(), descrizione: form.descrizione.trim() || null, taglie, prezzo, attivo: form.attivo };
      const res = await fetch(`/api/admin/merch/articoli?userId=${userId}`, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(e.error || 'Salvataggio non riuscito');
        return;
      }
      resetForm();
      loadArticoli(userId);
      setSavedTick(true);
      window.setTimeout(() => setSavedTick(false), 1600);
    } finally {
      setSaving(false);
    }
  };

  const toggleAttivo = async (a: Articolo) => {
    if (!userId) return;
    await fetch(`/api/admin/merch/articoli?userId=${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: a.id, attivo: !a.attivo }),
    }).catch(() => null);
    loadArticoli(userId);
  };

  const deleteArticolo = async (a: Articolo) => {
    if (!userId) return;
    if (!window.confirm(`Eliminare "${a.nome}" dal catalogo? Gli ordini già effettuati restano.`)) return;
    await fetch(`/api/admin/merch/articoli?id=${a.id}&userId=${userId}`, { method: 'DELETE' }).catch(() => null);
    if (form.id === a.id) resetForm();
    loadArticoli(userId);
  };

  const changeStato = async (o: Ordine, stato: Ordine['stato']) => {
    if (!userId) return;
    setOrdini(prev => prev.map(x => (x.id === o.id ? { ...x, stato } : x)));
    const res = await fetch(`/api/admin/merch/ordini?userId=${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: o.id, stato }),
    }).catch(() => null);
    if (!res || !res.ok) loadOrdini(userId); // rollback via refetch
  };

  const attivi = useMemo(() => articoli.filter(a => a.attivo).length, [articoli]);
  const ordiniAperti = useMemo(() => ordini.filter(o => o.stato === 'inviato' || o.stato === 'confermato').length, [ordini]);

  return (
    <CockpitPage max={1200}>
      <PageHeader
        icon={Shirt}
        title="Divise"
        subtitle="Catalogo divise/uniformi e ordini delle famiglie. Gli ordini generano un pagamento da saldare."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3 lg:max-w-[720px]">
        <StatCard icon={Package} label="Articoli attivi" value={loadingCat ? '…' : attivi} />
        <StatCard icon={ShoppingBag} label="Ordini da evadere" value={loadingOrd ? '…' : ordiniAperti} tone="warn" />
        <StatCard icon={Euro} label="Ordini totali" value={loadingOrd ? '…' : ordini.length} tone="info" />
      </div>

      <Tabs
        value={tab}
        onChange={(v) => setTab(v as 'catalogo' | 'ordini')}
        options={[
          { id: 'catalogo', label: 'Catalogo', icon: Package, count: articoli.length },
          { id: 'ordini', label: 'Ordini', icon: ShoppingBag, count: ordini.length },
        ]}
      />

      {tab === 'catalogo' ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* Tabella catalogo */}
          <div className="rounded-card bg-kidville-white p-4 shadow-sm">
            <p className="font-barlow mb-3 text-xs font-bold uppercase tracking-wide text-kidville-green">Articoli a catalogo</p>
            {loadingCat ? (
              <div className="flex items-center gap-3 py-6">
                <div className="h-5 w-5 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
                <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>
              </div>
            ) : articoli.length === 0 ? (
              <p className="font-maven text-sm text-kidville-muted">
                Nessun articolo. Aggiungi la prima divisa dal pannello a destra.
              </p>
            ) : (
              <div className={TABLE_WRAP}>
                <table className={TABLE}>
                  <thead>
                    <tr>
                      <th className={TH}>Articolo</th>
                      <th className={TH}>Taglie</th>
                      <th className={TH}>Prezzo</th>
                      <th className={TH}>Stato</th>
                      <th className={TH}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {articoli.map(a => (
                      <tr key={a.id} className={TROW}>
                        <td className={`${TD} font-maven text-sm text-kidville-ink`}>
                          <span className="font-semibold">{a.nome}</span>
                          {a.descrizione && <span className="block text-xs text-kidville-muted">{a.descrizione}</span>}
                        </td>
                        <td className={TD}>
                          <div className="flex flex-wrap gap-1">
                            {a.taglie.length === 0 ? (
                              <span className="font-maven text-xs text-kidville-muted">—</span>
                            ) : a.taglie.map(t => (
                              <span key={t} className="rounded-pill bg-kidville-cream px-2 py-0.5 font-maven text-xs font-semibold text-kidville-ink">{t}</span>
                            ))}
                          </div>
                        </td>
                        <td className={`${TD} font-maven text-sm font-semibold text-kidville-ink`}>{euro(a.prezzo)}</td>
                        <td className={TD}>
                          <button
                            onClick={() => toggleAttivo(a)}
                            className={`rounded-pill px-2.5 py-1 font-maven text-xs font-semibold ${a.attivo ? 'bg-kidville-green-soft text-kidville-green' : 'bg-kidville-line/50 text-kidville-muted'}`}
                          >
                            {a.attivo ? 'Attivo' : 'Nascosto'}
                          </button>
                        </td>
                        <td className={TD}>
                          <div className="flex items-center gap-2">
                            <button onClick={() => startEdit(a)} className="text-kidville-muted hover:text-kidville-green" aria-label="Modifica"><Pencil size={15} /></button>
                            <button onClick={() => deleteArticolo(a)} className="text-kidville-muted hover:text-kidville-error" aria-label="Elimina"><Trash2 size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Form crea/modifica */}
          <div className="rounded-card bg-kidville-white p-4 shadow-sm h-fit">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">
                {form.id ? 'Modifica articolo' : 'Nuovo articolo'}
              </p>
              {form.id && (
                <button onClick={resetForm} className="text-kidville-muted hover:text-kidville-ink" aria-label="Annulla modifica"><X size={16} /></button>
              )}
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="font-maven text-xs font-semibold text-kidville-ink/70">Nome</span>
                <input
                  value={form.nome}
                  onChange={e => setForm(f => ({ ...f, nome: e.target.value }))}
                  placeholder="Polo Kidville"
                  className="mt-1 w-full rounded-input border border-kidville-line px-3 py-2 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green"
                />
              </label>
              <label className="block">
                <span className="font-maven text-xs font-semibold text-kidville-ink/70">Descrizione (facoltativa)</span>
                <input
                  value={form.descrizione}
                  onChange={e => setForm(f => ({ ...f, descrizione: e.target.value }))}
                  placeholder="Cotone piqué, logo ricamato"
                  className="mt-1 w-full rounded-input border border-kidville-line px-3 py-2 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green"
                />
              </label>
              <label className="block">
                <span className="font-maven text-xs font-semibold text-kidville-ink/70">Taglie (separate da virgola)</span>
                <input
                  value={form.taglie}
                  onChange={e => setForm(f => ({ ...f, taglie: e.target.value }))}
                  placeholder="S, M, L, XL"
                  className="mt-1 w-full rounded-input border border-kidville-line px-3 py-2 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green"
                />
              </label>
              <label className="block">
                <span className="font-maven text-xs font-semibold text-kidville-ink/70">Prezzo (€)</span>
                <input
                  value={form.prezzo}
                  onChange={e => setForm(f => ({ ...f, prezzo: e.target.value }))}
                  inputMode="decimal"
                  placeholder="18.00"
                  className="mt-1 w-full rounded-input border border-kidville-line px-3 py-2 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green"
                />
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.attivo} onChange={e => setForm(f => ({ ...f, attivo: e.target.checked }))} className="accent-kidville-green" />
                <span className="font-maven text-sm text-kidville-ink">Visibile nello shop genitori</span>
              </label>

              {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}

              <button
                onClick={submitArticolo}
                disabled={saving}
                className="flex w-full items-center justify-center gap-2 rounded-pill bg-kidville-green px-4 py-2.5 font-barlow text-sm font-bold uppercase text-kidville-yellow transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {savedTick ? <SaveCheck className="text-kidville-yellow" /> : <Save size={16} strokeWidth={1.8} />}
                {form.id ? 'Salva modifiche' : 'Aggiungi articolo'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-card bg-kidville-white p-4 shadow-sm">
          <p className="font-barlow mb-3 text-xs font-bold uppercase tracking-wide text-kidville-green">Ordini delle famiglie</p>
          {loadingOrd ? (
            <div className="flex items-center gap-3 py-6">
              <div className="h-5 w-5 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
              <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>
            </div>
          ) : ordini.length === 0 ? (
            <p className="font-maven text-sm text-kidville-muted">Nessun ordine ricevuto.</p>
          ) : (
            <div className="space-y-3">
              {ordini.map(o => (
                <div key={o.id} className="rounded-input border border-kidville-line p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-maven text-sm font-semibold text-kidville-ink">
                        {o.alunni ? `${o.alunni.nome} ${o.alunni.cognome}` : 'Alunno'}
                        {o.alunni?.classe_sezione && <span className="ml-2 font-normal text-kidville-muted">· {o.alunni.classe_sezione}</span>}
                      </p>
                      <p className="font-maven text-xs text-kidville-muted">{new Date(o.creato_il).toLocaleDateString('it-IT')}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-maven text-sm font-bold text-kidville-ink">{euro(o.totale)}</span>
                      <select
                        value={o.stato}
                        onChange={e => changeStato(o, e.target.value as Ordine['stato'])}
                        className={`rounded-pill px-2.5 py-1 font-maven text-xs font-semibold outline-none ${STATO_TONE[o.stato]}`}
                      >
                        {STATI.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {o.righe.map(r => (
                      <span key={r.id} className="rounded-pill bg-kidville-cream px-2.5 py-1 font-maven text-xs text-kidville-ink">
                        {r.quantita}× {r.articolo_nome} <strong>({r.taglia})</strong>
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 font-maven text-xs text-kidville-muted">
                    Pagamento: {o.pagamento_id ? 'addebitato nello storico famiglia' : '—'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </CockpitPage>
  );
}

export default function AdminDivisePage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <AdminDiviseInner />
    </Suspense>
  );
}
