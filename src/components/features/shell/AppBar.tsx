'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { NotificationsPanel } from './NotificationsPanel';

interface AppBarProps {
  area: 'teacher' | 'parent';
}

// Sottopagine il cui "padre" logico non coincide col padre dell'URL.
const BACK_EXCEPTIONS: Record<string, string> = {
  '/parent/forms': '/parent/modulistica',
  '/teacher/settings/locker': '/teacher/locker',
};

// Padre statico del percorso (trim dell'ultimo segmento, clamp alla root
// d'area). NIENTE router.back(): con deep link/riavvii Capacitor la history
// può uscire dall'app; "indietro" nel design è sempre "su di un livello".
function backTarget(pathname: string, root: string): string | null {
  if (pathname === root) return null;
  for (const [prefix, target] of Object.entries(BACK_EXCEPTIONS)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return target;
  }
  const parent = pathname.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  return parent.length < root.length ? root : parent || root;
}

/**
 * Barra app verde persistente (export Claude Design): wordmark Kidville bianco
 * sempre presente, back pill sulle sottopagine, campanella = centro notifiche
 * (NotificationsPanel: badge non lette + dropdown, genitore E docente).
 * Montata nei layout d'area dentro <Suspense> (i hook identità usano
 * useSearchParams). L'identità viaggia come nelle bottom nav: ?userId= lato
 * docente, rotte nude lato genitore (risolte da localStorage).
 */
export function AppBar({ area }: AppBarProps) {
  const pathname = usePathname();
  const { userId } = useSessionIdentity();

  const root = area === 'teacher' ? '/teacher' : '/parent';
  // Onboarding genitore: primo accesso, niente navigazione (resta il wordmark).
  const isOnboarding = pathname.startsWith('/parent/onboarding');
  // Le pagine classe primaria hanno già il back nella ClasseShell (condivisa
  // con /admin): la AppBar non ne aggiunge un secondo.
  const suppressBack = /^\/teacher\/primaria\/[^/]+/.test(pathname);
  const back = isOnboarding || suppressBack ? null : backTarget(pathname, root);

  const withUser = (href: string) => (area === 'teacher' && userId ? `${href}?userId=${userId}` : href);

  return (
    <header className="kv-appbar sticky top-0 z-30 bg-kidville-green">
      <div
        className={`mx-auto flex w-full items-center gap-2.5 px-4 pb-3 pt-2 ${
          area === 'teacher' ? 'max-w-[460px]' : 'max-w-[430px]'
        }`}
      >
        {back && (
          <Link
            href={withUser(back)}
            aria-label="Indietro"
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-transform active:scale-95"
          >
            <ArrowLeft size={20} strokeWidth={2.2} />
          </Link>
        )}
        <Link href={withUser(root)} aria-label="Home Kidville" className="mr-auto">
          <Image
            src="/logo-light.png"
            alt="Kidville"
            width={620}
            height={209}
            priority
            style={{ height: 19, width: 'auto', display: 'block' }}
          />
        </Link>
        {!isOnboarding && <NotificationsPanel area={area} userId={userId} />}
      </div>
    </header>
  );
}
