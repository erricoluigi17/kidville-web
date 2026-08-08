import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { AppBar } from '@/components/features/shell/AppBar';
import BottomNav from '@/components/features/parent/BottomNav';
import { ChildSwitcher } from '@/components/features/parent/ChildSwitcher';
import { CampoNonCoperto } from '@/components/features/shell/CampoNonCoperto';
import { NativePushAutoRegister } from '@/components/providers/NativePushAutoRegister';
import { requireArea } from '@/lib/auth/area-guard';

export default async function ParentLayout({ children }: { children: React.ReactNode }) {
  // Il primo elemento di ogni schermata dell'area riservata — quello che
  // incontra chi naviga da tastiera e chi usa uno screen reader — era l'unico
  // testo dell'interfaccia scritto a mano nel TSX: in inglese sarebbe rimasto in
  // italiano. `skip-link-nel-catalogo.test.ts` ora lo pretende dal catalogo.
  const tNav = await getTranslations('nav');
  // Guardia d'area (M4B.4): solo ruolo attivo `genitore`; un docente che apre
  // /parent finisce su /teacher, un doppio profilo senza scelta torna al login.
  await requireArea('parent');
  return (
    <div className="min-h-screen bg-kidville-cream" data-kv-shell>
      {/* `focus:text-kidville-yellow-ink` e non `focus:text-kidville-yellow`:
          giallo di brand su verde di brand vale 4,05:1 e la soglia per un testo
          16px/400 è 4,5:1. La rete di `globals.css` che rimappa quella coppia
          NON arriva qui: Tailwind genera per le varianti classi con nome diverso
          (`.focus\:text-kidville-yellow`) e il selettore cerca la coppia scritta
          nuda. È lo stesso modo in cui `text-kidville-ink/70` era sfuggito alla
          sidebar desktop. `yellow-ink` (#FFDA5C) su #006A5F = 4,78:1.
          Lock: `__tests__/a11y/contrasto-skip-link-e-selettore-figlio.test.tsx`. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:rounded-lg focus:bg-kidville-green focus:px-3 focus:py-2 focus:text-kidville-yellow-ink"
      >
        {tNav('saltaAlContenuto')}
      </a>
      {/* AppBar full-bleed (fuori dal vincolo 430px); usa useSearchParams → Suspense. */}
      <Suspense fallback={<div className="bg-kidville-green" style={{ height: 'var(--kv-appbar-h, 58px)' }} />}>
        <AppBar area="parent" />
      </Suspense>
      {/* Registrazione push nativa (solo shell Capacitor): usa useSearchParams → Suspense. */}
      <Suspense fallback={null}>
        <NativePushAutoRegister />
      </Suspense>
      {/* Con la tastiera aperta, Chromium allinea il campo a fuoco a `top: 0` —
          cioè sotto l'AppBar sticky — e NON onora lo `scroll-margin-top` che
          globals.css dichiara. Misurato sull'emulatore: 82 px su 112 (73%) del
          campo «Motivo» coperti, e il testo digitato invisibile. */}
      <CampoNonCoperto />
      <div className="relative max-w-[430px] mx-auto">
        {/* Selettore figlio (per genitori con più figli). Usa useSearchParams → Suspense. */}
        <Suspense fallback={null}>
          <ChildSwitcher />
        </Suspense>
        {/* `tabIndex={-1}`: senza, lo skip link porta l'hash a `#content` ma
            lascia `document.activeElement` su `<body>`. In Chrome funziona
            lo stesso perché il browser sposta il punto di ripartenza della
            navigazione sequenziale, ma il comportamento non è uniforme fra
            browser e tecnologie assistive, e uno screen reader non annuncia
            la destinazione. Raggiungibile dal codice, mai dal Tab. */}
        <main id="content" tabIndex={-1} className="outline-none">{children}</main>
        {/* BottomNav usa useSearchParams (via useChildSchoolType): Suspense per il prerender. */}
        <Suspense fallback={null}>
          <BottomNav />
        </Suspense>
      </div>
    </div>
  );
}
