'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Check, X, Clock, LogOut, Users, BarChart2 } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { saveLocalAppello, syncPendingAppello } from '@/lib/offline/syncEngine';

type Stato = 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';
interface Riga {
  id: string; nome: string; cognome: string; stato: Stato | null;
  orario_entrata: string | null; orario_uscita: string | null;
  presenza_id: string | null; giustificata: boolean;
  giustificazione_testo: string | null; giust_vista_il: string | null;
}
interface AlunnoLight { id: string; nome: string; cognome: string }
interface RiepilogoMateria { nome: string; minutiMancati: number; oreMancate: number }
interface RiepilogoAssenze {
  alunnoId: string; nome: string; cognome: string;
  oreAssenza: number; oreRitardo: number; orePermesso: number; oreTotali: number;
  perMateria?: Record<string, RiepilogoMateria>;
}

function annoScolasticoDefault(): { from: string; to: string } {
  const oggi = new Date();
  const anno = oggi.getMonth() >= 8 ? oggi.getFullYear() : oggi.getFullYear() - 1;
  return { from: `${anno}-09-01`, to: `${anno + 1}-06-30` };
}

// Estrae HH:MM da un timestamp ISO; '' se assente.
function oraDaTs(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function oraCorrente(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const STATI: { key: Stato; label: string; icon: React.ReactNode; cls: string }[] = [
  { key: 'presente', label: 'Presente', icon: <Check size={14} />, cls: 'bg-kidville-success text-white' },
  { key: 'assente', label: 'Assente', icon: <X size={14} />, cls: 'bg-kidville-error text-white' },
  { key: 'ritardo', label: 'Ritardo', icon: <Clock size={14} />, cls: 'bg-kidville-warn text-white' },
  { key: 'uscita_anticipata', label: 'Uscita', icon: <LogOut size={14} />, cls: 'bg-kidville-info text-white' },
];

function oggiIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function AppelloPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);
  const [data, setData] = useState(oggiIso());
  const [righe, setRighe] = useState<Riga[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Riepilogo ore assenze
  const defaultPeriodo = annoScolasticoDefault();
  const [alunniList, setAlunniList] = useState<AlunnoLight[]>([]);
  const [riepilogoAlunnoId, setRiepilogoAlunnoId] = useState('');
  const [riepilogoDal, setRiepilogoDal] = useState(defaultPeriodo.from);
  const [riepilogoAl, setRiepilogoAl] = useState(defaultPeriodo.to);
  const [riepilogo, setRiepilogo] = useState<RiepilogoAssenze | null>(null);
  const [riepilogoLoading, setRiepilogoLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/primaria/appello?sectionId=${sectionId}&data=${data}&userId=${userId}`);
      const d = await r.json();
      if (d.success) setRighe(d.data);
    } finally {
      setLoading(false);
    }
  }, [sectionId, data, userId]);

  // Carica lista alunni per il selettore riepilogo
  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setAlunniList(d.data.alunni ?? []); });
  }, [sectionId, userId]);

  const caricaRiepilogo = useCallback(async () => {
    if (!riepilogoAlunnoId) { setRiepilogo(null); return; }
    setRiepilogoLoading(true);
    const r = await fetch(
      `/api/primaria/ore-assenza?sectionId=${sectionId}&alunnoId=${riepilogoAlunnoId}&from=${riepilogoDal}&to=${riepilogoAl}&includiMaterie=true&userId=${userId}`
    );
    const d = await r.json();
    setRiepilogoLoading(false);
    if (d.success && d.data.length > 0) setRiepilogo(d.data[0]);
    else setRiepilogo(null);
  }, [sectionId, riepilogoAlunnoId, riepilogoDal, riepilogoAl, userId]);

  useEffect(() => { caricaRiepilogo(); }, [caricaRiepilogo]);

  useEffect(() => {
    load();
  }, [load]);

  // Flush della coda offline al ritorno della connessione.
  useEffect(() => {
    const flush = () => syncPendingAppello().then(load);
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [load]);

  // Invia (o riprova offline) lo stato di un alunno, con eventuali orari.
  const invia = async (alunnoId: string, stato: Stato, orarioEntrata?: string, orarioUscita?: string) => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await saveLocalAppello({ id: `${alunnoId}|${data}`, section_id: sectionId, alunno_id: alunnoId, data, stato, aggiornato_il: new Date().toISOString() });
      return;
    }
    try {
      const res = await fetch(`/api/primaria/appello?userId=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ sectionId, data, alunnoId, stato, orarioEntrata, orarioUscita }),
      });
      if (!res.ok) throw new Error('save failed');
    } catch {
      await saveLocalAppello({ id: `${alunnoId}|${data}`, section_id: sectionId, alunno_id: alunnoId, data, stato, aggiornato_il: new Date().toISOString() });
    }
  };

  const setStato = async (alunnoId: string, stato: Stato) => {
    // Per ritardo/uscita anticipata propone l'ora corrente come default modificabile.
    const oraEntrata = stato === 'ritardo' ? oraCorrente() : '';
    const oraUscita = stato === 'uscita_anticipata' ? oraCorrente() : '';
    setRighe((prev) => prev.map((r) => (r.id === alunnoId
      ? { ...r, stato, orario_entrata: oraEntrata ? `${data}T${oraEntrata}:00` : null, orario_uscita: oraUscita ? `${data}T${oraUscita}:00` : null }
      : r)));
    await invia(alunnoId, stato, oraEntrata || undefined, oraUscita || undefined);
  };

  // Aggiorna l'orario (entrata/uscita) di una riga già in stato ritardo/uscita.
  const setOrario = async (alunnoId: string, ora: string) => {
    const riga = righe.find((r) => r.id === alunnoId);
    if (!riga || !riga.stato) return;
    const isEntrata = riga.stato === 'ritardo';
    setRighe((prev) => prev.map((r) => (r.id === alunnoId
      ? { ...r, [isEntrata ? 'orario_entrata' : 'orario_uscita']: ora ? `${data}T${ora}:00` : null }
      : r)));
    await invia(alunnoId, riga.stato, isEntrata ? ora : undefined, isEntrata ? undefined : ora);
  };

  // Presa visione della giustifica inserita dal genitore.
  const presaVisione = async (presenzaId: string) => {
    await fetch(`/api/primaria/presenze/giust-vista?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ presenzaId }),
    });
    load();
  };

  const tuttiPresenti = async () => {
    setSaving(true);
    setRighe((prev) => prev.map((r) => ({ ...r, stato: 'presente', orario_entrata: null, orario_uscita: null })));
    await fetch(`/api/primaria/appello?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        sectionId,
        data,
        records: righe.map((r) => ({ alunnoId: r.id, stato: 'presente' })),
      }),
    });
    setSaving(false);
  };

  return (
    <div className="space-y-4">
    <div className="rounded-card bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-barlow text-lg font-bold text-kidville-ink">Appello</h2>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={data}
            onChange={(e) => setData(e.target.value)}
            className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
          />
          <button
            onClick={tuttiPresenti}
            disabled={saving || righe.length === 0}
            className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50"
          >
            <Users size={14} /> Tutti presenti
          </button>
        </div>
      </div>

      {loading ? (
        <p className="font-maven text-kidville-muted text-sm">Caricamento…</p>
      ) : (
        <ul className="divide-y divide-kidville-line">
          {righe.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="font-maven text-kidville-ink">{r.cognome} {r.nome}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {STATI.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setStato(r.id, s.key)}
                    title={s.label}
                    className={`font-maven inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs transition ${
                      r.stato === s.key ? s.cls : 'bg-kidville-cream text-kidville-muted hover:bg-kidville-cream-dark'
                    }`}
                  >
                    {s.icon}
                    <span className="hidden sm:inline">{s.label}</span>
                  </button>
                ))}
                {/* Orario di entrata (ritardo) / uscita (uscita anticipata). */}
                {(r.stato === 'ritardo' || r.stato === 'uscita_anticipata') && (
                  <label className="font-maven inline-flex items-center gap-1 text-xs text-kidville-muted">
                    {r.stato === 'ritardo' ? 'Entrata' : 'Uscita'}
                    <input
                      type="time"
                      value={oraDaTs(r.stato === 'ritardo' ? r.orario_entrata : r.orario_uscita)}
                      onChange={(e) => setOrario(r.id, e.target.value)}
                      className="rounded-pill border border-kidville-line px-2 py-0.5 text-xs"
                    />
                  </label>
                )}
                {/* Stato giustificazione genitore + presa visione del docente. */}
                {r.giustificata && (
                  r.giust_vista_il ? (
                    <span className="font-maven text-[11px] text-kidville-success" title={r.giustificazione_testo ?? undefined}>✓ giustif. vista</span>
                  ) : (
                    <button
                      onClick={() => r.presenza_id && presaVisione(r.presenza_id)}
                      title={r.giustificazione_testo ?? 'Giustificata dal genitore'}
                      className="font-maven rounded-pill bg-kidville-warn-soft px-2.5 py-1 text-[11px] text-kidville-warn"
                    >
                      Giustificata · presa visione
                    </button>
                  )
                )}
              </div>
            </li>
          ))}
          {righe.length === 0 && <li className="py-3 font-maven text-kidville-muted text-sm">Nessun alunno nella classe.</li>}
        </ul>
      )}
    </div>

    {/* ── Riepilogo ore assenze per materia ───────────────────────── */}
    <div className="rounded-card bg-white p-5 shadow-sm">
      <h3 className="font-barlow text-base font-bold text-kidville-ink mb-1 flex items-center gap-2">
        <BarChart2 size={16} className="text-kidville-green" /> Riepilogo ore assenze
      </h3>
      <p className="font-maven text-xs text-kidville-muted mb-3">Monte ore mancate totali e per materia, in base all&apos;orario settimanale.</p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
        <select
          value={riepilogoAlunnoId}
          onChange={(e) => setRiepilogoAlunnoId(e.target.value)}
          className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm"
        >
          <option value="">Alunno…</option>
          {alunniList.map((a) => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}
        </select>
        <input type="date" value={riepilogoDal} onChange={(e) => setRiepilogoDal(e.target.value)}
          className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm" />
        <input type="date" value={riepilogoAl} onChange={(e) => setRiepilogoAl(e.target.value)}
          className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm" />
      </div>

      {!riepilogoAlunnoId ? (
        <p className="font-maven text-sm text-kidville-muted">Seleziona un alunno.</p>
      ) : riepilogoLoading ? (
        <p className="font-maven text-sm text-kidville-muted">Calcolo in corso…</p>
      ) : !riepilogo ? (
        <p className="font-maven text-sm text-kidville-muted">Nessuna assenza registrata nel periodo.</p>
      ) : (
        <div className="space-y-3">
          {/* Totale */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'Ore assenze', val: riepilogo.oreAssenza },
              { label: 'Ore ritardi', val: riepilogo.oreRitardo },
              { label: 'Ore permessi', val: riepilogo.orePermesso },
              { label: 'Totale ore', val: riepilogo.oreTotali },
            ].map((s) => (
              <div key={s.label} className="rounded-card bg-kidville-green/5 border border-kidville-green/20 px-3 py-2 text-center">
                <p className="font-maven text-[10px] text-kidville-muted mb-0.5">{s.label}</p>
                <p className="font-barlow text-xl font-bold text-kidville-green">{s.val.toFixed(1)}h</p>
              </div>
            ))}
          </div>
          {/* Per materia */}
          {riepilogo.perMateria && Object.keys(riepilogo.perMateria).length > 0 && (
            <table className="w-full font-maven text-sm">
              <thead>
                <tr className="border-b border-kidville-line">
                  <th className="text-left py-1.5 text-xs font-semibold text-kidville-muted">Materia</th>
                  <th className="text-right py-1.5 text-xs font-semibold text-kidville-muted">Ore mancate</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(riepilogo.perMateria)
                  .sort((a, b) => b[1].oreMancate - a[1].oreMancate)
                  .map(([id, m]) => (
                    <tr key={id} className="border-b border-kidville-line">
                      <td className="py-1.5 text-kidville-ink">{m.nome}</td>
                      <td className="py-1.5 text-right font-semibold text-kidville-green">{m.oreMancate.toFixed(1)}h</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
