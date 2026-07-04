'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { Package, Users, Boxes, Truck, PlusCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  CockpitPage, PageHeader, StatCard, CockpitSelect, Tabs,
  TABLE, TABLE_WRAP, TD, TH, TROW,
} from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { LoadStockModal } from '@/components/features/teacher/locker/LoadStockModal';
import { MonthlyLockerTable, type StudentInfo } from '@/components/features/teacher/locker/MonthlyLockerTable';

// Armadietto nido/infanzia nel cockpit (segreteria/direzione): selettore
// sede/sezione dai plessi consentiti, scorte per alunno e consegne del giorno
// affiancate, vista mensile e registrazione carico (riuso LoadStockModal).
// Il consumo materiali (PATCH) resta alle maestre: qui è supervisione + carico.

interface SezioneScoped { id: string; name: string; school_type: string }
interface ScuolaScoped { scuolaId: string; scuolaNome: string; sezioni: SezioneScoped[] }

interface StockItem { materiale: string; stock: number }
interface StockAlunno { id: string; nome: string; cognome: string; stocks: StockItem[] }
interface InventarioRecord { date: string; nome_oggetto: string; materiale?: string; quantita?: number }
interface CaricoAlunno { id: string; nome: string; cognome: string; inventario: InventarioRecord[] }

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(ym: string, delta: number) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function AdminArmadiettoInner() {
  const { userId } = useSessionIdentity();
  const [scuole, setScuole] = useState<ScuolaScoped[]>([]);
  const [scuolaId, setScuolaId] = useState('');
  const [sezione, setSezione] = useState<string | null>(null);
  const [scopedLoaded, setScopedLoaded] = useState(false);

  const [tab, setTab] = useState<'giornata' | 'mensile'>('giornata');
  const [stock, setStock] = useState<StockAlunno[]>([]);
  const [caricoOggi, setCaricoOggi] = useState<CaricoAlunno[]>([]);
  const [dayLoading, setDayLoading] = useState(true);

  const [month, setMonth] = useState(currentYearMonth());
  const [mensile, setMensile] = useState<StudentInfo[]>([]);
  const [mensileLoading, setMensileLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [preStudent, setPreStudent] = useState('');

  // ── Scoping: plessi/sezioni nido-infanzia consentiti ──────────────────────
  useEffect(() => {
    if (!userId) return;
    let active = true;
    fetch(`/api/admin/sections/scoped?grado=nido,infanzia&userId=${userId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!active || !d?.success) return;
        const list: ScuolaScoped[] = (d.data ?? []).filter((g: ScuolaScoped) => g.sezioni.length > 0);
        setScuole(list);
        const first = list[0];
        setScuolaId(cur => cur || (first?.scuolaId ?? ''));
        setSezione(cur => cur ?? first?.sezioni[0]?.name ?? null);
      })
      .catch(() => {})
      .finally(() => { if (active) setScopedLoaded(true); });
    return () => { active = false; };
  }, [userId]);

  // ── Scorte + consegne del giorno per la sezione selezionata ───────────────
  const loadGiornata = (sez: string | null, uid: string | null) => {
    if (!sez || !uid) return;
    const enc = encodeURIComponent(sez);
    fetch(`/api/locker/inventory?classe_sezione=${enc}&mode=stock&userId=${uid}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (Array.isArray(d)) setStock(d); })
      .catch(() => {})
      .finally(() => setDayLoading(false));
    const today = todayISO();
    fetch(`/api/locker/inventory?classe_sezione=${enc}&mode=carico&month=${today.slice(0, 7)}&userId=${uid}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!Array.isArray(d)) return;
        setCaricoOggi((d as CaricoAlunno[]).map(s => ({
          ...s,
          inventario: (s.inventario ?? []).filter(r => r.date === today),
        })));
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadGiornata(sezione, userId);
  }, [sezione, userId]);

  // ── Vista mensile (solo quando il tab è attivo) ───────────────────────────
  const loadMensile = (sez: string | null, uid: string | null, ym: string) => {
    if (!sez || !uid) return;
    const enc = encodeURIComponent(sez);
    fetch(`/api/locker/inventory?classe_sezione=${enc}&mode=carico&month=${ym}&userId=${uid}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!Array.isArray(d)) return;
        setMensile((d as CaricoAlunno[]).map(s => ({
          id: s.id, nome: s.nome, cognome: s.cognome,
          inventario: (s.inventario ?? []).map(r => ({
            id: r.nome_oggetto + r.date,
            alunno_id: s.id,
            materiale: r.materiale ?? r.nome_oggetto,
            quantita: r.quantita ?? 0,
            date: r.date ?? '',
            portato: true,
          })),
        })));
      })
      .catch(() => {})
      .finally(() => setMensileLoading(false));
  };

  useEffect(() => {
    if (tab === 'mensile') loadMensile(sezione, userId, month);
  }, [tab, sezione, userId, month]);

  const scuola = useMemo(() => scuole.find(s => s.scuolaId === scuolaId) ?? null, [scuole, scuolaId]);

  const pickScuola = (id: string) => {
    setScuolaId(id);
    const g = scuole.find(s => s.scuolaId === id);
    setSezione(g?.sezioni[0]?.name ?? null);
    setStock([]); setCaricoOggi([]); setDayLoading(true);
    setMensile([]); setMensileLoading(true);
  };
  const pickSezione = (name: string) => {
    setSezione(name);
    setStock([]); setCaricoOggi([]); setDayLoading(true);
    setMensile([]); setMensileLoading(true);
  };

  const handleLoadStock = async (body: { alunno_id: string; materiale: string; quantita: number }) => {
    const res = await fetch(`/api/locker/inventory?userId=${userId ?? ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Errore salvataggio'); }
    loadGiornata(sezione, userId);
    if (tab === 'mensile') loadMensile(sezione, userId, month);
  };

  const students = useMemo(() => stock.map(s => ({ id: s.id, nome: s.nome, cognome: s.cognome })), [stock]);
  const pezziInStock = useMemo(() => stock.reduce((tot, s) => tot + s.stocks.reduce((a, i) => a + i.stock, 0), 0), [stock]);
  const consegneOggi = useMemo(() => caricoOggi.reduce((tot, s) => tot + s.inventario.length, 0), [caricoOggi]);

  return (
    <CockpitPage max={1200}>
      <PageHeader
        icon={Package}
        title="Armadietto"
        subtitle="Scorte e consegne dei materiali nido/infanzia. Il consumo giornaliero resta alle maestre."
        actions={
          <button
            onClick={() => { setPreStudent(''); setShowModal(true); }}
            disabled={!sezione}
            className="flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2.5 font-barlow text-sm font-bold uppercase text-kidville-yellow transition-all active:scale-[0.98] disabled:opacity-50"
          >
            <PlusCircle size={16} strokeWidth={1.8} /> Registra carico
          </button>
        }
      />

      {scopedLoaded && scuole.length === 0 ? (
        <div className="rounded-card bg-kidville-white p-8 text-center shadow-sm">
          <p className="font-maven text-sm text-kidville-muted">
            Nessuna sezione nido/infanzia nei tuoi plessi. Se non è quello che ti aspetti,
            verifica che il tuo profilo utente abbia una sede associata (Anagrafica → Staff).
          </p>
        </div>
      ) : (
        <>
          {/* Selettori sede/sezione */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {scuole.length > 1 && (
              <label className="flex items-center gap-2">
                <span className="font-maven text-sm text-kidville-ink/70">Sede:</span>
                <CockpitSelect
                  value={scuolaId}
                  onChange={pickScuola}
                  options={scuole.map(s => ({ value: s.scuolaId, label: s.scuolaNome }))}
                />
              </label>
            )}
            <label className="flex items-center gap-2">
              <span className="font-maven text-sm text-kidville-ink/70">Sezione:</span>
              <CockpitSelect
                value={sezione ?? ''}
                onChange={pickSezione}
                options={(scuola?.sezioni ?? []).map(s => ({ value: s.name, label: `${s.name} (${s.school_type})` }))}
              />
            </label>
          </div>

          {/* Stat del giorno */}
          <div className="mb-5 grid gap-3 sm:grid-cols-3 lg:max-w-[720px]">
            <StatCard icon={Users} label="Alunni sezione" value={dayLoading ? '…' : stock.length} />
            <StatCard icon={Boxes} label="Pezzi in stock" value={dayLoading ? '…' : pezziInStock} tone="info" />
            <StatCard icon={Truck} label="Consegne oggi" value={dayLoading ? '…' : consegneOggi} tone="yellow" sub="portate" />
          </div>

          <Tabs
            value={tab}
            onChange={(v) => setTab(v as 'giornata' | 'mensile')}
            options={[
              { id: 'giornata', label: 'Giornata', icon: Truck },
              { id: 'mensile', label: 'Mensile', icon: Package },
            ]}
          />

          {tab === 'giornata' ? (
            dayLoading ? (
              <div className="flex items-center gap-3 rounded-card bg-kidville-white p-6 shadow-sm">
                <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
                <p className="font-maven text-sm text-kidville-muted">Caricamento scorte…</p>
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {/* Scorte attuali */}
                <div className="rounded-card bg-kidville-white p-4 shadow-sm">
                  <p className="font-barlow mb-3 text-xs font-bold uppercase tracking-wide text-kidville-green">Scorte attuali</p>
                  {stock.length === 0 ? (
                    <p className="font-maven text-sm text-kidville-muted">Nessun alunno in questa sezione.</p>
                  ) : (
                    <div className={TABLE_WRAP}>
                      <table className={TABLE}>
                        <thead>
                          <tr>
                            <th className={TH}>Alunno</th>
                            <th className={TH}>Materiali in giacenza</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stock.map(s => {
                            const attivi = s.stocks.filter(i => i.stock > 0);
                            return (
                              <tr key={s.id} className={TROW}>
                                <td className={`${TD} font-maven text-sm font-semibold text-kidville-ink`}>
                                  {s.nome} {s.cognome}
                                </td>
                                <td className={TD}>
                                  {attivi.length === 0 ? (
                                    <span className="font-maven text-xs text-kidville-muted">— esaurito</span>
                                  ) : (
                                    <div className="flex flex-wrap gap-1.5">
                                      {attivi.map(i => (
                                        <span key={i.materiale} className="rounded-pill bg-kidville-green-soft px-2.5 py-1 font-maven text-xs font-semibold text-kidville-green">
                                          {i.materiale}: <strong>{i.stock}</strong>
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Consegne di oggi */}
                <div className="rounded-card bg-kidville-white p-4 shadow-sm">
                  <p className="font-barlow mb-3 text-xs font-bold uppercase tracking-wide text-kidville-warn">Consegnato oggi</p>
                  {consegneOggi === 0 ? (
                    <p className="font-maven text-sm text-kidville-muted">
                      Nessuna consegna registrata oggi. Usa «Registra carico» per annotare i materiali portati dalle famiglie.
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {caricoOggi.filter(s => s.inventario.length > 0).map(s => (
                        <div key={s.id} className="rounded-input border border-kidville-line px-3 py-2.5">
                          <p className="font-maven text-sm font-semibold text-kidville-ink">{s.nome} {s.cognome}</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {s.inventario.map((r, idx) => (
                              <span key={idx} className="rounded-pill bg-kidville-warn-soft px-2.5 py-1 font-maven text-xs font-semibold text-kidville-warn">
                                {r.materiale ?? r.nome_oggetto} +{r.quantita}
                              </span>
                            ))}
                          </div>
                          <button
                            onClick={() => { setPreStudent(s.id); setShowModal(true); }}
                            className="mt-2 font-maven text-xs font-semibold text-kidville-green hover:underline"
                          >
                            + Aggiungi carico
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          ) : (
            <div className="rounded-card bg-kidville-white p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <button
                  onClick={() => setMonth(m => shiftMonth(m, -1))}
                  className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-kidville-cream text-kidville-green transition-colors hover:bg-kidville-green-soft"
                  aria-label="Mese precedente"
                >
                  <ChevronLeft size={18} />
                </button>
                <span className="font-barlow text-sm font-bold uppercase text-kidville-green">Consegne mensili</span>
                <button
                  onClick={() => setMonth(m => shiftMonth(m, 1))}
                  className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-kidville-cream text-kidville-green transition-colors hover:bg-kidville-green-soft"
                  aria-label="Mese successivo"
                >
                  <ChevronRight size={18} />
                </button>
              </div>
              {mensileLoading ? (
                <div className="flex items-center justify-center gap-3 py-12">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-kidville-green/30 border-t-kidville-green" />
                  <span className="font-maven text-sm text-kidville-muted">Caricamento…</span>
                </div>
              ) : (
                <MonthlyLockerTable students={mensile} month={month} hideStudentColumn={false} />
              )}
            </div>
          )}
        </>
      )}

      <LoadStockModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        students={students}
        preselectedStudent={preStudent}
        preselectedMateriale=""
        classeSezione={sezione ?? undefined}
        onConfirm={handleLoadStock}
      />
    </CockpitPage>
  );
}

export default function AdminArmadiettoPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <AdminArmadiettoInner />
    </Suspense>
  );
}
