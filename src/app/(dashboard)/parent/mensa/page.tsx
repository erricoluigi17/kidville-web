'use client';

import { Suspense } from 'react';
import { UtensilsCrossed } from 'lucide-react';
import { MensaCalendar } from '@/components/features/parent/mensa/MensaCalendar';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';

function Inner() {
  const { parentId, studentId, ready } = useParentIdentity();

  return (
    <div className="px-4 pt-6 pb-24">
      <header className="mb-5">
        <h1 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
          <UtensilsCrossed size={22} /> Mensa
        </h1>
        <p className="font-maven text-xs text-gray-500">Prenota il pranzo e consulta il menù della settimana.</p>
      </header>
      {ready
        ? <MensaCalendar userId={parentId} studentId={studentId} />
        : <div className="py-12 flex justify-center"><div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" /></div>
      }
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
