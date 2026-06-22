'use client';

// =============================================================================
// STUB — Hub Segreteria/Direzione (da rifinire con Claude Design)
// =============================================================================
// Unica UI nuova del lavoro Segreteria: punto d'ingresso che riusa le schermate
// del docente via deep-link (?userId=<segreteria>). Le classi sono filtrate per
// plesso da /api/primaria/classi (gated requireDocente + scope), così la
// Segreteria vede solo le proprie e la Direzione i plessi associati.
//
// NB conformità: creare nuove valutazioni/note/firme dalla Segreteria richiede
// la selezione del docente titolare (vincolo FEA): la UI di selezione docente è
// un TODO per Claude Design; senza, gli endpoint rispondono 422 (mai forgiano la
// firma). Lettura e operazioni operative (es. appello) funzionano già.
// =============================================================================

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ClipboardList, CheckSquare, Star, AlertTriangle, CalendarDays, BarChart3, GraduationCap, FolderLock } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

interface Classe { id: string; name: string; school_type: string; numAlunni?: number }

const FUNZIONI = [
  { seg: 'registro', label: 'Registro di classe', icon: ClipboardList, desc: 'Lezioni, argomenti, compiti, firme' },
  { seg: 'appello', label: 'Appello / Presenze', icon: CheckSquare, desc: 'Presenze, ritardi, uscite, giustifiche' },
  { seg: 'valutazioni', label: 'Valutazioni', icon: Star, desc: 'Valutazioni in itinere per alunno/materia' },
  { seg: 'note', label: 'Note', icon: AlertTriangle, desc: 'Note disciplinari/didattiche' },
  { seg: 'orario', label: 'Orario', icon: CalendarDays, desc: 'Orario settimanale della classe' },
  { seg: 'prospetto', label: 'Prospetto', icon: BarChart3, desc: 'Riepilogo valutazioni e medie' },
  { seg: 'scrutinio', label: 'Scrutinio', icon: GraduationCap, desc: 'Giudizi, chiusura, pagelle' },
  { seg: 'fascicolo', label: 'Fascicolo', icon: FolderLock, desc: 'Documenti riservati (accesso tracciato)' },
];

function SegreteriaHub() {
  const search = useSearchParams();
  const userId = getCurrentTeacherId(search);
  const [classi, setClassi] = useState<Classe[]>([]);
  const [sezioneId, setSezioneId] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let active = true;
    fetch(`/api/primaria/classi?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        if (d.success) {
          setClassi(d.data ?? []);
          if ((d.data ?? []).length) setSezioneId((p) => p || d.data[0].id);
        } else {
          setErr(d.error || 'Errore nel caricamento delle classi');
        }
      })
      .catch(() => { if (active) setErr('Errore di rete'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  const suffix = `?userId=${userId}`;

  return (
    <div className="min-h-screen bg-kidville-cream/40">
      <header className="border-b border-gray-100 bg-white/95 px-4 py-4">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-2">
            <h1 className="font-barlow text-2xl font-bold uppercase tracking-wide text-kidville-green">Segreteria</h1>
            <span className="rounded-pill bg-amber-100 px-2.5 py-0.5 text-[11px] font-maven text-amber-700">stub · Claude Design</span>
          </div>
          <p className="font-maven mt-1 text-xs text-gray-400">
            Accedi a tutte le funzioni del docente, per qualsiasi classe del tuo plesso, riusando le stesse schermate.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-5">
        {loading && <p className="font-maven text-sm text-gray-400">Caricamento classi…</p>}
        {err && <p className="font-maven text-sm text-red-500">{err}</p>}

        {!loading && !err && (
          <>
            <div className="mb-5 flex items-center gap-3">
              <label className="font-maven text-sm text-gray-600">Classe/Sezione:</label>
              <select
                value={sezioneId}
                onChange={(e) => setSezioneId(e.target.value)}
                className="font-maven rounded-pill border border-gray-200 bg-white px-4 py-2 text-sm"
              >
                {classi.length === 0 && <option value="">Nessuna classe nel tuo plesso</option>}
                {classi.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{typeof c.numAlunni === 'number' ? ` · ${c.numAlunni} alunni` : ''}
                  </option>
                ))}
              </select>
            </div>

            {sezioneId && (
              <div className="grid gap-3 sm:grid-cols-2">
                {FUNZIONI.map(({ seg, label, icon: Icon, desc }) => (
                  <Link
                    key={seg}
                    href={`/teacher/primaria/${sezioneId}/${seg}${suffix}`}
                    className="flex items-start gap-3 rounded-card border border-gray-100 bg-white p-3 transition hover:border-kidville-green/40 hover:bg-kidville-green/5"
                  >
                    <span className="mt-0.5 text-kidville-green"><Icon size={18} /></span>
                    <span>
                      <span className="font-maven block text-sm font-semibold text-gray-800">{label}</span>
                      <span className="font-maven block text-xs text-gray-400">{desc}</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}

            <p className="font-maven mt-6 rounded-card bg-amber-50 p-3 text-xs text-amber-700">
              Nota conformità: creare nuove valutazioni/note/firme dalla Segreteria richiede la selezione del
              docente titolare (la firma resta del docente — vincolo FEA). La UI di selezione docente è in
              carico a Claude Design; nel frattempo lettura e appello sono pienamente operativi.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

export default function SegreteriaPage() {
  return (
    <Suspense fallback={<div className="p-6 font-maven text-sm text-gray-400">Caricamento…</div>}>
      <SegreteriaHub />
    </Suspense>
  );
}
