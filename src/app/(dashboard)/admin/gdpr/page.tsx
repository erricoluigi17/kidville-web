'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { OblioPanel } from '@/components/features/admin/settings/OblioPanel';

const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

function GdprInner() {
  const userId = useSearchParams().get('userId') || DEV_ADMIN;
  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6">
          <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
            <ShieldAlert size={24} /> Privacy &amp; Diritto all&apos;Oblio
          </h1>
          <p className="font-maven text-sm text-gray-500">Cancellazione (anonimizzazione) dei dati personali degli alunni non iscritti. Azione riservata alla Direzione.</p>
        </header>
        <OblioPanel userId={userId} />
      </div>
    </div>
  );
}

export default function AdminGdprPage() {
  return (
    <Suspense fallback={null}>
      <GdprInner />
    </Suspense>
  );
}
