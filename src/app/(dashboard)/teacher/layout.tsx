import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { AppBar } from '@/components/features/shell/AppBar';
import TeacherBottomNav from '@/components/features/teacher/TeacherBottomNav';
import { NativePushAutoRegister } from '@/components/providers/NativePushAutoRegister';
import { requireArea } from '@/lib/auth/area-guard';

// Cornice persistente dell'area Insegnante: AppBar verde (wordmark + back +
// campanella) e bottom nav del design (DR) su tutte le rotte /teacher/**.
// Niente vincolo di larghezza globale: ogni pagina mantiene la propria colonna
// (le pagine primaria condivise con /admin restano larghe).
export default async function TeacherLayout({ children }: { children: React.ReactNode }) {
  // Il primo elemento di ogni schermata dell'area riservata — quello che
  // incontra chi naviga da tastiera e chi usa uno screen reader — era l'unico
  // testo dell'interfaccia scritto a mano nel TSX: in inglese sarebbe rimasto in
  // italiano. `skip-link-nel-catalogo.test.ts` ora lo pretende dal catalogo.
  const tNav = await getTranslations('nav');
  // Guardia d'area (M4B.4): educator + staff di gestione (eccezione preservata:
  // lo staff ha già permessi di scrittura sulle funzioni docente lato API).
  await requireArea('teacher');
  return (
    // --kv-appbar-h (definita in globals.css su [data-kv-shell]): offset per gli
    // sticky sotto la barra (ClasseShell); fallback 0px → /admin invariato.
    <div className="min-h-screen bg-kidville-cream" data-kv-shell>
      {/* `focus:text-kidville-yellow-ink`: giallo su verde vale 4,05:1, la
          soglia per un testo 16px/400 è 4,5:1, e la rete di `globals.css` non
          aggancia le classi generate dalle varianti. Gemello dello skip link
          dell'area genitore — il rilievo dichiara «vale per entrambi i layout». */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:rounded-lg focus:bg-kidville-green focus:px-3 focus:py-2 focus:text-kidville-yellow-ink"
      >
        {tNav('saltaAlContenuto')}
      </a>
      {/* AppBar usa useSearchParams (identità) → Suspense per il prerender. */}
      <Suspense fallback={<div className="bg-kidville-green" style={{ height: 'var(--kv-appbar-h, 58px)' }} />}>
        <AppBar area="teacher" />
      </Suspense>
      {/* Registrazione push nativa (solo shell Capacitor): usa useSearchParams → Suspense. */}
      <Suspense fallback={null}>
        <NativePushAutoRegister />
      </Suspense>
      <main id="content" tabIndex={-1} className="pb-28 outline-none">
        {children}
      </main>
      {/* TeacherBottomNav usa useSearchParams (?userId=) → Suspense per il prerender. */}
      <Suspense fallback={null}>
        <TeacherBottomNav />
      </Suspense>
    </div>
  );
}
