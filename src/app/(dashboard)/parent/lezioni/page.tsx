'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Baby, RefreshCw } from 'lucide-react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { LezioniList, type Lezione } from '@/components/features/parent/LezioniCompitiSections';

interface Data { schoolType: string | null; child: { nome: string; cognome: string } | null; lezioni: Lezione[] }

function LezioniInner() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!ready || !studentId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/parent/primaria?studentId=${studentId}&userId=${parentId}`, { headers: { 'x-user-id': parentId } });
      const d = await r.json();
      if (d.success) setData(d.data);
    } finally {
      setLoading(false);
    }
  }, [ready, studentId, parentId]);

  useEffect(() => { load(); }, [load]);

  if (!ready || loading) {
    return <div className="p-8 font-maven text-gray-400 flex items-center gap-2"><RefreshCw className="animate-spin" size={16} /> Caricamento…</div>;
  }

  if (data && data.schoolType !== 'primaria') {
    return (
      <div className="min-h-screen bg-kidville-cream/40 p-6">
        <div className="max-w-md mx-auto rounded-card bg-white p-8 text-center shadow-sm">
          <Baby className="mx-auto mb-3 text-kidville-green" size={40} />
          <h2 className="font-barlow text-xl font-bold text-gray-800">Sezione non disponibile</h2>
          <p className="font-maven text-sm text-gray-500 mt-1 mb-4">Le lezioni sono disponibili solo per la scuola primaria.</p>
          <Link href="/parent/diary" className="font-maven inline-block rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow">Vai al Diario</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-5">
          <h1 className="font-barlow text-3xl font-bold text-kidville-green uppercase tracking-wide">Lezioni</h1>
          {data?.child && <p className="font-maven text-gray-500 text-sm">{data.child.nome} {data.child.cognome}</p>}
        </header>
        {data && <LezioniList lezioni={data.lezioni} />}
      </div>
    </div>
  );
}

export default function ParentLezioniPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <LezioniInner />
    </Suspense>
  );
}
