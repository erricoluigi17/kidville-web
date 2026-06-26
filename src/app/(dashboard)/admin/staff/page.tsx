'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Users } from 'lucide-react';
import { StaffPanel } from '@/components/features/admin/settings/StaffPanel';

const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

function StaffInner() {
  const userId = useSearchParams().get('userId') || DEV_ADMIN;
  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6">
          <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
            <Users size={24} /> Gestione Staff
          </h1>
          <p className="font-maven text-sm text-gray-500">Ruoli, sede e classi del personale. Azione riservata alla Direzione.</p>
        </header>
        <StaffPanel userId={userId} />
      </div>
    </div>
  );
}

export default function AdminStaffPage() {
  return (
    <Suspense fallback={null}>
      <StaffInner />
    </Suspense>
  );
}
