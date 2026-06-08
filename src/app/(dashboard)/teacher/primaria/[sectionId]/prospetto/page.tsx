'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { BarChart3 } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

interface Alunno { id: string; nome: string; cognome: string }
interface Materia { id: string; nome: string }
interface ValBreve { id: string; tipo: string; modalita: string; giudizio_sintetico: string | null; giudizio_testo: string | null; creato_il: string }
interface GruppoObiettivo { obiettivo: { id: string; codice: string | null; descrizione: string }; valutazioni: ValBreve[] }

export default function ProspettoPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [alunnoId, setAlunnoId] = useState('');
  const [materiaId, setMateriaId] = useState('');
  const [gruppi, setGruppi] = useState<GruppoObiettivo[]>([]);
  const [media, setMedia] = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) { setAlunni(d.data.alunni ?? []); setMaterie(d.data.materie ?? []); }
      });
  }, [sectionId, userId]);

  const load = useCallback(async () => {
    if (!alunnoId || !materiaId) { setGruppi([]); setMedia(null); return; }
    const r = await fetch(`/api/primaria/prospetto?alunnoId=${alunnoId}&materiaId=${materiaId}&userId=${userId}`);
    const d = await r.json();
    if (d.success) { setGruppi(d.data); setMedia(d.media ?? null); }
  }, [alunnoId, materiaId, userId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rounded-card bg-white p-5 shadow-sm">
      <h2 className="font-barlow text-lg font-bold text-gray-800 mb-1 flex items-center gap-2">
        <BarChart3 size={18} className="text-kidville-green" /> Prospetto per obiettivi
      </h2>
      <p className="font-maven text-xs text-gray-400 mb-4">Valutazioni in itinere aggregate per obiettivo, con media matematica dei giudizi sintetici (valori configurabili in Impostazioni → Giudizi).</p>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <select value={alunnoId} onChange={(e) => setAlunnoId(e.target.value)} className="font-maven rounded-pill border border-gray-200 px-3 py-2 text-sm">
          <option value="">Alunno…</option>
          {alunni.map((a) => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}
        </select>
        <select value={materiaId} onChange={(e) => setMateriaId(e.target.value)} className="font-maven rounded-pill border border-gray-200 px-3 py-2 text-sm">
          <option value="">Materia…</option>
          {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
        </select>
      </div>

      {!alunnoId || !materiaId ? (
        <p className="font-maven text-sm text-gray-400">Seleziona alunno e materia.</p>
      ) : gruppi.length === 0 ? (
        <p className="font-maven text-sm text-gray-400">Nessuna valutazione registrata.</p>
      ) : (
        <div className="space-y-4">
          {media !== null && (
            <div className="flex items-center justify-between rounded-card bg-kidville-green/5 border border-kidville-green/20 px-4 py-3">
              <span className="font-maven text-sm text-gray-600">Media matematica (giudizi sintetici)</span>
              <span className="font-barlow text-2xl font-bold text-kidville-green">{media.toFixed(2)}</span>
            </div>
          )}
          {gruppi.map((g) => (
            <div key={g.obiettivo.id} className="rounded-card border border-gray-100 p-3">
              <p className="font-maven text-sm font-semibold text-gray-800">
                {g.obiettivo.codice && <b className="text-kidville-green mr-1">{g.obiettivo.codice}</b>}
                {g.obiettivo.descrizione}
              </p>
              <ul className="mt-2 space-y-1">
                {g.valutazioni.map((v) => (
                  <li key={v.id} className="flex items-center gap-2 font-maven text-xs text-gray-500">
                    <span className="rounded-pill bg-kidville-green/10 px-2 py-0.5 text-kidville-green">
                      {v.giudizio_sintetico || 'descrittivo'}
                    </span>
                    <span className="capitalize">{v.tipo}</span>
                    <span className="text-gray-300">{new Date(v.creato_il).toLocaleDateString('it-IT')}</span>
                    {v.giudizio_testo && <span className="truncate">— {v.giudizio_testo}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
