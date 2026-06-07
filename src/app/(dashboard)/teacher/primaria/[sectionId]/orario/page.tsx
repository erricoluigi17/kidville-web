'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { OrarioGrid } from '@/components/features/primaria/OrarioGrid';

export default function OrarioPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);
  const [data, setData] = useState<{ campanelle: never[]; orario: never[] }>({ campanelle: [], orario: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/primaria/orario?sectionId=${sectionId}&userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setData(d.data);
      })
      .finally(() => setLoading(false));
  }, [sectionId, userId]);

  return (
    <div className="rounded-card bg-white p-5 shadow-sm">
      <h2 className="font-barlow text-lg font-bold text-gray-800 mb-4">Orario settimanale</h2>
      {loading ? (
        <p className="font-maven text-gray-400 text-sm">Caricamento…</p>
      ) : (
        <OrarioGrid campanelle={data.campanelle} orario={data.orario} />
      )}
    </div>
  );
}
