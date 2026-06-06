'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { UtensilsCrossed } from 'lucide-react';
import { MensaCalendar } from '@/components/features/parent/mensa/MensaCalendar';
import { getCurrentParentId, getCurrentStudentId } from '@/lib/auth/current-user';

function Inner() {
  const params = useSearchParams();
  const userId = getCurrentParentId(params);
  const studentId = getCurrentStudentId(params);
  return (
    <div className="px-4 pt-6 pb-24">
      <header className="mb-5">
        <h1 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
          <UtensilsCrossed size={22} /> Mensa
        </h1>
        <p className="font-maven text-xs text-gray-500">Prenota il pranzo e consulta il menù della settimana.</p>
      </header>
      <MensaCalendar userId={userId} studentId={studentId} />
    </div>
  );
}

export default function ParentMensaPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <Inner />
    </Suspense>
  );
}
