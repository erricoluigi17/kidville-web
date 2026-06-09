'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { AlertTriangle, BarChart3 } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

interface Alunno { id: string; nome: string; cognome: string }
interface Materia { id: string; nome: string }
interface ValBreve { id: string; tipo: string; modalita: string; giudizio_sintetico: string | null; giudizio_testo: string | null; creato_il: string }
interface GruppoObiettivo { obiettivo: { id: string; codice: string | null; descrizione: string }; valutazioni: ValBreve[] }
interface PanoramicaVoce { materiaId: string; nome: string; media: number | null; nValutazioni: number }

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
  const [panoramica, setPanoramica] = useState<PanoramicaVoce[] | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) { setAlunni(d.data.alunni ?? []); setMaterie(d.data.materie ?? []); setApiError(null); }
        else setApiError(d.error ?? 'Impossibile caricare gli alunni');
      });
  }, [sectionId, userId]);

  const load = useCallback(async () => {
    if (!alunnoId) { setGruppi([]); setMedia(null); setPanoramica(null); return; }
    if (!materiaId) {
      // Panoramica tutte le materie
      const r = await fetch(`/api/primaria/prospetto?alunnoId=${alunnoId}&userId=${userId}`);
      const d = await r.json();
      if (d.success) { setPanoramica(d.panoramica ?? []); setGruppi([]); setMedia(null); }
      return;
    }
    const r = await fetch(`/api/primaria/prospetto?alunnoId=${alunnoId}&materiaId=${materiaId}&userId=${userId}`);
    const d = await r.json();
    if (d.success) { setGruppi(d.data); setMedia(d.media ?? null); setPanoramica(null); }
  }, [alunnoId, materiaId, userId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rounded-card bg-white p-5 shadow-sm">
      <h2 className="font-barlow text-lg font-bold text-gray-800 mb-1 flex items-center gap-2">
        <BarChart3 size={18} className="text-kidville-green" /> Prospetto valutazioni
      </h2>
      <p className="font-maven text-xs text-gray-400 mb-4">
        Seleziona solo l&apos;alunno per vedere la panoramica di tutte le materie. Seleziona anche la materia per il dettaglio per obiettivo.
      </p>

      {apiError && (
        <div className="mb-3 flex items-center gap-2 rounded-card bg-red-50 px-3 py-2 font-maven text-sm text-red-600">
          <AlertTriangle size={14} /> {apiError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 mb-4">
        <select value={alunnoId} onChange={(e) => { setAlunnoId(e.target.value); setMateriaId(''); }} className="font-maven rounded-pill border border-gray-200 px-3 py-2 text-sm">
          <option value="">Alunno…</option>
          {alunni.map((a) => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}
        </select>
        <select value={materiaId} onChange={(e) => setMateriaId(e.target.value)} className="font-maven rounded-pill border border-gray-200 px-3 py-2 text-sm" disabled={!alunnoId}>
          <option value="">Tutte le materie</option>
          {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
        </select>
      </div>

      {/* ── Panoramica medie per tutte le materie ───────────── */}
      {alunnoId && !materiaId && panoramica && (
        panoramica.length === 0 ? (
          <p className="font-maven text-sm text-gray-400">Nessuna valutazione registrata.</p>
        ) : (
          <div>
            <p className="font-maven text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Media per materia</p>
            <table className="w-full font-maven text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-1.5 text-xs font-semibold text-gray-500">Materia</th>
                  <th className="text-center py-1.5 text-xs font-semibold text-gray-500">Media</th>
                  <th className="text-right py-1.5 text-xs font-semibold text-gray-500">Valutazioni</th>
                </tr>
              </thead>
              <tbody>
                {panoramica.map((v) => (
                  <tr key={v.materiaId} className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                    onClick={() => setMateriaId(v.materiaId)}>
                    <td className="py-2 text-gray-700">{v.nome}</td>
                    <td className="py-2 text-center">
                      {v.media !== null
                        ? <span className="font-bold text-kidville-green">{v.media.toFixed(2)}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="py-2 text-right text-gray-500">{v.nValutazioni}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="font-maven text-[10px] text-gray-400 mt-2">Tocca una riga per vedere il dettaglio per obiettivo.</p>
          </div>
        )
      )}

      {/* ── Dettaglio singola materia ────────────────────────── */}
      {alunnoId && materiaId && (
        gruppi.length === 0 ? (
          <p className="font-maven text-sm text-gray-400">Nessuna valutazione registrata per questa materia.</p>
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
        )
      )}

      {!alunnoId && <p className="font-maven text-sm text-gray-400">Seleziona un alunno.</p>}
    </div>
  );
}
