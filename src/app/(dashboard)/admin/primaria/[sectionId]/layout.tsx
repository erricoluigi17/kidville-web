import { Suspense } from 'react';
import { ClasseShell } from '@/components/features/primaria/ClasseShell';

// Cornice per-classe dentro il cockpit Direzione/Segreteria. Stesso ClasseShell
// del flusso docente, con prefisso /admin/primaria (back-arrow + tab restano
// dentro la shell). {children} avvolto in Suspense: le pagine montate (re-export
// delle pagine teacher) usano useSearchParams.
export default function AdminPrimariaClasseLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClasseShell basePrefix="/admin/primaria">
      <Suspense fallback={<div className="font-maven text-sm text-gray-400">Caricamento…</div>}>
        {children}
      </Suspense>
    </ClasseShell>
  );
}
