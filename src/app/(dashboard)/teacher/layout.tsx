import { Suspense } from 'react';
import { AppBar } from '@/components/features/shell/AppBar';
import TeacherBottomNav from '@/components/features/teacher/TeacherBottomNav';
import { requireArea } from '@/lib/auth/area-guard';

// Cornice persistente dell'area Insegnante: AppBar verde (wordmark + back +
// campanella) e bottom nav del design (DR) su tutte le rotte /teacher/**.
// Niente vincolo di larghezza globale: ogni pagina mantiene la propria colonna
// (le pagine primaria condivise con /admin restano larghe).
export default async function TeacherLayout({ children }: { children: React.ReactNode }) {
  // Guardia d'area (M4B.4): educator + staff di gestione (eccezione preservata:
  // lo staff ha già permessi di scrittura sulle funzioni docente lato API).
  await requireArea('teacher');
  return (
    // --kv-appbar-h: offset per gli sticky sotto la barra (ClasseShell); il
    // fallback 0px della var mantiene identico il comportamento sotto /admin.
    <div className="min-h-screen bg-kidville-cream" data-kv-shell style={{ '--kv-appbar-h': '58px' } as React.CSSProperties}>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:rounded-lg focus:bg-kidville-green focus:px-3 focus:py-2 focus:text-kidville-yellow"
      >
        Salta al contenuto
      </a>
      {/* AppBar usa useSearchParams (identità) → Suspense per il prerender. */}
      <Suspense fallback={<div className="h-[58px] bg-kidville-green" />}>
        <AppBar area="teacher" />
      </Suspense>
      <main id="content" className="pb-28">
        {children}
      </main>
      {/* TeacherBottomNav usa useSearchParams (?userId=) → Suspense per il prerender. */}
      <Suspense fallback={null}>
        <TeacherBottomNav />
      </Suspense>
    </div>
  );
}
