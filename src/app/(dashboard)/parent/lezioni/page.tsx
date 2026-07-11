'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Baby, RefreshCw } from 'lucide-react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { LezioniList, type Lezione } from '@/components/features/parent/LezioniCompitiSections';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { btnClass } from '@/components/ui/Btn';

interface Data { schoolType: string | null; child: { nome: string; cognome: string } | null; lezioni: Lezione[] }

function LezioniInner() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!ready || !parentId || !studentId) return;
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
    return <div className="px-4 pt-5 pb-24 font-maven text-kidville-muted flex items-center gap-2"><RefreshCw className="animate-spin" size={16} /> Caricamento…</div>;
  }

  if (data && data.schoolType !== 'primaria') {
    return (
      <div className="px-4 pt-5 pb-24">
        <div className="rounded-card bg-white p-8 text-center shadow-sm">
          <Baby className="mx-auto mb-3 text-kidville-green" size={40} />
          <h2 className="font-barlow text-xl font-bold text-kidville-ink">Sezione non disponibile</h2>
          <p className="font-maven text-sm text-kidville-muted mt-1 mb-4">Le lezioni sono disponibili solo per la scuola primaria.</p>
          <Link href="/parent/diary" className={btnClass('primary', 'sm')}>Vai al Diario</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-5 pb-24">
      <PageHeaderCard
        eyebrow="Didattica · Primaria"
        title="Lezioni"
        subtitle={data?.child ? <>{data.child.nome} {data.child.cognome}</> : undefined}
      />
      {data && <div className="mt-5"><LezioniList lezioni={data.lezioni} /></div>}
    </div>
  );
}

export default function ParentLezioniPage() {
  return (
    <Suspense fallback={<div className="px-4 pt-5 pb-24 font-maven text-kidville-muted">Caricamento…</div>}>
      <LezioniInner />
    </Suspense>
  );
}
