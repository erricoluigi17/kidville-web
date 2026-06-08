import { Suspense } from 'react';
import BottomNav from '@/components/features/parent/BottomNav';
import { ChildSwitcher } from '@/components/features/parent/ChildSwitcher';

export default function ParentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-kidville-cream">
      <div className="relative max-w-[430px] mx-auto min-h-screen">
        {/* Selettore figlio (per genitori con più figli). Usa useSearchParams → Suspense. */}
        <Suspense fallback={null}>
          <ChildSwitcher />
        </Suspense>
        <main>{children}</main>
        {/* BottomNav usa useSearchParams (via useChildSchoolType): Suspense per il prerender. */}
        <Suspense fallback={null}>
          <BottomNav />
        </Suspense>
      </div>
    </div>
  );
}
