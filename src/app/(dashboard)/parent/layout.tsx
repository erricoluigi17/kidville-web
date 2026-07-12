import { Suspense } from 'react';
import { AppBar } from '@/components/features/shell/AppBar';
import BottomNav from '@/components/features/parent/BottomNav';
import { ChildSwitcher } from '@/components/features/parent/ChildSwitcher';
import { NativePushAutoRegister } from '@/components/providers/NativePushAutoRegister';
import { requireArea } from '@/lib/auth/area-guard';

export default async function ParentLayout({ children }: { children: React.ReactNode }) {
  // Guardia d'area (M4B.4): solo ruolo attivo `genitore`; un docente che apre
  // /parent finisce su /teacher, un doppio profilo senza scelta torna al login.
  await requireArea('parent');
  return (
    <div className="min-h-screen bg-kidville-cream" data-kv-shell>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:rounded-lg focus:bg-kidville-green focus:px-3 focus:py-2 focus:text-kidville-yellow"
      >
        Salta al contenuto
      </a>
      {/* AppBar full-bleed (fuori dal vincolo 430px); usa useSearchParams → Suspense. */}
      <Suspense fallback={<div className="bg-kidville-green" style={{ height: 'var(--kv-appbar-h, 58px)' }} />}>
        <AppBar area="parent" />
      </Suspense>
      {/* Registrazione push nativa (solo shell Capacitor): usa useSearchParams → Suspense. */}
      <Suspense fallback={null}>
        <NativePushAutoRegister />
      </Suspense>
      <div className="relative max-w-[430px] mx-auto">
        {/* Selettore figlio (per genitori con più figli). Usa useSearchParams → Suspense. */}
        <Suspense fallback={null}>
          <ChildSwitcher />
        </Suspense>
        <main id="content">{children}</main>
        {/* BottomNav usa useSearchParams (via useChildSchoolType): Suspense per il prerender. */}
        <Suspense fallback={null}>
          <BottomNav />
        </Suspense>
      </div>
    </div>
  );
}
