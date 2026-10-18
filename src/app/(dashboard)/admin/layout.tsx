import { AdminSidebar } from '@/components/features/admin/AdminSidebar';
import { AdminBinario } from '@/components/features/admin/AdminBinario';
import { AdminTopBar } from '@/components/features/admin/AdminTopBar';
import { AdminTopBarMobile } from '@/components/features/admin/AdminTopBarMobile';
import { AdminBottomNav } from '@/components/features/admin/AdminBottomNav';
import { CampoNonCoperto } from '@/components/features/shell/CampoNonCoperto';
import { SedeProvider, SedeScopeBoundary } from '@/lib/context/sede-context';
import { AdminIdentityProvider } from '@/lib/context/admin-identity';
import { requireArea } from '@/lib/auth/area-guard';

// Shell cockpit Direzione/Segreteria, in tre forme (dal 2026-10-18, iPad PR 3):
// TELEFONO (<744 px): topbar verde del brand (`AdminTopBarMobile`, wordmark + sede +
//   campanella, NIENTE hamburger) in cima e bottom-nav a pillola (`AdminBottomNav`:
//   Home · Avvisi · Contabilità · Mensa + «Menu» → bottom-sheet) in fondo.
// TABLET (744–1279 px): TopBar desktop (`AdminTopBar`) e, nella riga [nav | contenuto],
//   il binario a icone da 88 px (`AdminBinario`), il cui «Menu» apre lo stesso contenuto
//   del foglio in un pannello accanto.
// SCRIVANIA (≥1280 px): TopBar e sidebar piena da 256 px (`AdminSidebar`, `xl:`).
// `data-kv-guscio-admin` porta `--kv-rail-w` (0 / 88px / 16rem, globals.css): lo legge la
// regola che fa partire gli overlay del contenuto dopo la navigazione.
// L'attributo di shell sul wrapper porta le regole safe-area native (`.cap-native`
// in globals.css: altezza AppBar e padding-top della barra verde). Il `pb-28
// tablet:pb-0` del <main> libera lo spazio della bottom-nav flottante sul telefono.
// Nessun componente qui usa useSearchParams (userId è letto client-side): niente
// Suspense → inline su ogni route, anche le dinamiche /admin/primaria/[sectionId]/*.
// Il contenuto (e SOLO il contenuto: non la topbar, non la sidebar, non la
// bottom-nav) sta dentro `SedeScopeBoundary`, che lo rimonta quando l'utente
// cambia sede: senza, ogni pagina con `useEffect(…, [userId])` — cioè quasi
// tutte — resterebbe sui dati della sede precedente senza dirlo.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Guardia d'area (M4B.4): staff di gestione e cuoca (report /admin/mensa/cucina).
  await requireArea('admin');
  return (
    <AdminIdentityProvider>
      <SedeProvider>
        <div className="min-h-screen bg-kidville-cream" data-kv-shell data-kv-guscio-admin>
          <AdminTopBarMobile />
          <AdminTopBar />
          {/* La topbar mobile è sticky come l'AppBar delle altre due shell, e
              con la tastiera aperta copre allo stesso modo il campo a fuoco —
              qui i moduli sono quelli della segreteria, che scrive tutto il
              giorno. Il componente riconosce entrambe le classi di barra
              (`.kv-appbar` e `.kv-appbar-admin`) e su desktop non fa nulla,
              perché lì la tastiera non riduce la viewport. */}
          <CampoNonCoperto />
          <div className="tablet:flex">
            <AdminBinario />
            <AdminSidebar />
            <main className="flex-1 min-w-0 pb-28 tablet:pb-0" data-cockpit-content>
              <SedeScopeBoundary>{children}</SedeScopeBoundary>
            </main>
          </div>
          <AdminBottomNav />
        </div>
      </SedeProvider>
    </AdminIdentityProvider>
  );
}
