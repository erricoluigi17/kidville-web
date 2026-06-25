import { Suspense } from 'react';
import BottomNav from '@/components/features/parent/BottomNav';
import { ChildSwitcher } from '@/components/features/parent/ChildSwitcher';

export default function ParentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-kidville-cream">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:rounded-lg focus:bg-kidville-green focus:px-3 focus:py-2 focus:text-kidville-yellow"
      >
        Salta al contenuto
      </a>
      <div className="relative max-w-[430px] mx-auto min-h-screen">
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
