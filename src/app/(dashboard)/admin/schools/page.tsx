'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { SchoolsPanel } from '@/components/features/admin/settings/SchoolsPanel';

const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

function SchoolsInner() {
  const userId = useSearchParams().get('userId') || DEV_ADMIN;
  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6">
          <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
            <Building2 size={24} /> Multi-Sede
          </h1>
          <p className="font-maven text-sm text-gray-500">Aggiungi, rinomina o disattiva le sedi. Azione riservata alla Direzione.</p>
        </header>
        <SchoolsPanel userId={userId} />
      </div>
    </div>
  );
}

export default function AdminSchoolsPage() {
  return (
    <Suspense fallback={null}>
      <SchoolsInner />
    </Suspense>
  );
}
