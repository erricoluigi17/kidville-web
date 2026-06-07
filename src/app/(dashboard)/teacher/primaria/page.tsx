'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, Users, ChevronRight } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { GradeWorldSwitch } from '@/components/features/teacher/GradeWorldSwitch';

interface Classe {
  id: string;
  name: string;
  scholastic_year?: string | null;
  numAlunni: number;
}

function HubInner() {
  const params = useSearchParams();
  const userId = getCurrentTeacherId(params);
  const [classi, setClassi] = useState<Classe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/primaria/classi?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setClassi(d.data);
        else setError(d.error || 'Errore');
      })
      .catch(() => setError('Errore di rete'))
      .finally(() => setLoading(false));
  }, [userId]);

  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="font-barlow text-3xl font-bold text-kidville-green uppercase tracking-wide">Le mie classi</h1>
            <p className="font-maven text-gray-500 text-sm">Scuola Primaria — seleziona una classe per accedere al registro.</p>
          </div>
          <GradeWorldSwitch />
        </div>

        {error && <div className="rounded-card bg-kidville-error/10 text-kidville-error px-4 py-3 text-sm font-maven mb-4">{error}</div>}

        {loading ? (
          <p className="font-maven text-gray-400">Caricamento…</p>
        ) : classi.length === 0 ? (
          <div className="rounded-card bg-white p-8 text-center shadow-sm">
            <BookOpen className="mx-auto mb-3 text-gray-300" size={40} />
            <p className="font-maven text-gray-500">Nessuna classe primaria assegnata.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {classi.map((c) => (
              <Link
                key={c.id}
                href={`/teacher/primaria/${c.id}?userId=${userId}`}
                className="group flex items-center justify-between rounded-card bg-white p-5 shadow-sm transition hover:shadow-md"
              >
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-card bg-kidville-green/10 text-kidville-green">
                    <BookOpen size={22} />
                  </div>
                  <div>
                    <p className="font-barlow text-xl font-bold text-gray-800">{c.name}</p>
                    <p className="font-maven text-xs text-gray-400 flex items-center gap-1">
                      <Users size={12} /> {c.numAlunni} alunni
                      {c.scholastic_year ? ` · ${c.scholastic_year}` : ''}
                    </p>
                  </div>
                </div>
                <ChevronRight className="text-gray-300 group-hover:text-kidville-green" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PrimariaHubPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-500">Caricamento…</div>}>
      <HubInner />
    </Suspense>
  );
}
