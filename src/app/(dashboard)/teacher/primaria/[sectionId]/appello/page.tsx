'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Check, X, Clock, LogOut, Users } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { saveLocalAppello, syncPendingAppello } from '@/lib/offline/syncEngine';

type Stato = 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';
interface Riga {
  id: string; nome: string; cognome: string; stato: Stato | null;
  orario_entrata: string | null; orario_uscita: string | null;
  presenza_id: string | null; giustificata: boolean;
  giustificazione_testo: string | null; giust_vista_il: string | null;
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
  { key: 'ritardo', label: 'Ritardo', icon: <Clock size={14} />, cls: 'bg-amber-500 text-white' },
  { key: 'uscita_anticipata', label: 'Uscita', icon: <LogOut size={14} />, cls: 'bg-purple-500 text-white' },
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
    <div className="rounded-card bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-barlow text-lg font-bold text-gray-800">Appello</h2>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={data}
            onChange={(e) => setData(e.target.value)}
            className="font-maven rounded-pill border border-gray-200 px-3 py-1.5 text-sm"
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
        <p className="font-maven text-gray-400 text-sm">Caricamento…</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {righe.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="font-maven text-gray-800">{r.cognome} {r.nome}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {STATI.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setStato(r.id, s.key)}
                    title={s.label}
                    className={`font-maven inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs transition ${
                      r.stato === s.key ? s.cls : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                    }`}
                  >
                    {s.icon}
                    <span className="hidden sm:inline">{s.label}</span>
                  </button>
                ))}
                {/* Orario di entrata (ritardo) / uscita (uscita anticipata). */}
                {(r.stato === 'ritardo' || r.stato === 'uscita_anticipata') && (
                  <label className="font-maven inline-flex items-center gap-1 text-xs text-gray-500">
                    {r.stato === 'ritardo' ? 'Entrata' : 'Uscita'}
                    <input
                      type="time"
                      value={oraDaTs(r.stato === 'ritardo' ? r.orario_entrata : r.orario_uscita)}
                      onChange={(e) => setOrario(r.id, e.target.value)}
                      className="rounded-pill border border-gray-200 px-2 py-0.5 text-xs"
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
                      className="font-maven rounded-pill bg-amber-100 px-2.5 py-1 text-[11px] text-amber-700"
                    >
                      Giustificata · presa visione
                    </button>
                  )
                )}
              </div>
            </li>
          ))}
          {righe.length === 0 && <li className="py-3 font-maven text-gray-400 text-sm">Nessun alunno nella classe.</li>}
        </ul>
      )}
    </div>
  );
}
