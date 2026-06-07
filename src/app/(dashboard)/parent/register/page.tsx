'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Baby, RefreshCw } from 'lucide-react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { PrimariaParentView } from '@/components/features/parent/PrimariaParentView';

interface PrimariaData {
  schoolType: string | null;
  child: { nome: string; cognome: string } | null;
  lezioni: never[];
  valutazioni: never[];
  note: { id: string; richiede_firma: boolean; firmata_il: string | null }[];
}

function RegisterInner() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [data, setData] = useState<PrimariaData | null>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ready || !studentId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/parent/primaria?studentId=${studentId}&userId=${parentId}`, {
        headers: { 'x-user-id': parentId },
      });
      const d = await r.json();
      if (d.success) setData(d.data);
    } finally {
      setLoading(false);
    }
  }, [ready, studentId, parentId]);

  useEffect(() => { load(); }, [load]);

  const onSign = async (notaId: string) => {
    setSigning(notaId);
    await fetch('/api/notes/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ notaId }),
    });
    setSigning(null);
    load();
  };

  if (!ready || loading) {
    return <div className="p-8 font-maven text-gray-400 flex items-center gap-2"><RefreshCw className="animate-spin" size={16} /> Caricamento…</div>;
  }

  // Vista adattiva: se il figlio non è in primaria, rimanda al Diario 0-6.
  if (data && data.schoolType !== 'primaria') {
    return (
      <div className="min-h-screen bg-kidville-cream/40 p-6">
        <div className="max-w-md mx-auto rounded-card bg-white p-8 text-center shadow-sm">
          <Baby className="mx-auto mb-3 text-kidville-green" size={40} />
          <h2 className="font-barlow text-xl font-bold text-gray-800">Diario 0-6</h2>
          <p className="font-maven text-sm text-gray-500 mt-1 mb-4">
            Per {data.child?.nome} è attivo il Diario di Nido/Infanzia.
          </p>
          <Link href="/parent/diary" className="font-maven inline-block rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow">
            Vai al Diario
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-5">
          <h1 className="font-barlow text-3xl font-bold text-kidville-green uppercase tracking-wide">Registro</h1>
          {data?.child && <p className="font-maven text-gray-500 text-sm">{data.child.nome} {data.child.cognome}</p>}
        </header>
        {data && (
          <PrimariaParentView
            lezioni={data.lezioni}
            valutazioni={data.valutazioni}
            note={data.note as never[]}
            onSign={onSign}
            signing={signing}
          />
        )}
      </div>
    </div>
  );
}

export default function ParentRegisterPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <RegisterInner />
    </Suspense>
  );
}
