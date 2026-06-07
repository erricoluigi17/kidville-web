'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

interface Alunno { id: string; nome: string; cognome: string }
interface Materia { id: string; nome: string }

export default function ClasseOverviewPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);

  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setAlunni(d.data.alunni ?? []);
          setMaterie(d.data.materie ?? []);
        }
      })
      .catch(() => {});
  }, [sectionId, userId]);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="rounded-card bg-white p-5 shadow-sm">
        <h2 className="font-barlow text-lg font-bold text-gray-800 mb-3">Alunni ({alunni.length})</h2>
        <ul className="divide-y divide-gray-100">
          {alunni.map((a) => (
            <li key={a.id} className="py-2 font-maven text-sm text-gray-700">{a.cognome} {a.nome}</li>
          ))}
          {alunni.length === 0 && <li className="py-2 font-maven text-sm text-gray-400">Nessun alunno.</li>}
        </ul>
      </section>
      <section className="rounded-card bg-white p-5 shadow-sm">
        <h2 className="font-barlow text-lg font-bold text-gray-800 mb-3">Le mie materie</h2>
        <div className="flex flex-wrap gap-2">
          {materie.map((m) => (
            <span key={m.id} className="rounded-pill bg-kidville-green/10 px-3 py-1 text-sm font-maven text-kidville-green">
              {m.nome}
            </span>
          ))}
          {materie.length === 0 && <span className="font-maven text-sm text-gray-400">Nessuna materia assegnata.</span>}
        </div>
        <p className="mt-4 font-maven text-xs text-gray-400">
          Usa le schede in alto per registro, appello, valutazioni, note e orario.
        </p>
      </section>
    </div>
  );
}
