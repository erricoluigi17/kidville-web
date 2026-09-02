'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useProfili } from '@/lib/auth/use-profili';
import { useLabelRuolo } from '@/lib/auth/ruoli';
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
/**
 * IL CHIP DELLA VESTE — «in che veste sto guardando questa schermata?».
 *
 * Compare SOLO a chi ha davvero più di un profilo (cinque persone su 622,
 * misurate in produzione il 2026-09-01): per tutti gli altri sarebbe
 * un'etichetta che ripete la stessa parola per sempre. È ciò che rende il cambio
 * di profilo *visibile* e non solo *avvenuto*.
 *
 * ⚠️ NIENTE GIALLO DI BRAND QUI. `#FDC400` su `#006A5F` vale **4,05:1**, sotto la
 * soglia AA di 4,5:1 — misurato e scritto in `globals.css` intorno alle righe
 * 24-37, ed è la stessa trappola in cui erano già caduti gli skip link. Il chip
 * è bianco su un velo bianco al 15%: **4,73:1** sul verde di brand (miscela
 * `#268077`) e **15,13:1** in Alto Contrasto (miscela `#262626`), dove
 * `.kv-appbar` diventa nera. Le due misure vivono in
 * `__tests__/a11y/contrasto-chip-veste.test.ts`, che le rifà dal foglio di stile
 * invece di fidarsi di questo commento.
 */
function ChipVeste() {
  const t = useTranslations('shared');
  const labelRuolo = useLabelRuolo();
  const reduce = useReducedMotion();
  const { profili, ruoloAttivo, pronta } = useProfili();

  if (!pronta || profili.length < 2 || !ruoloAttivo) return null;

  return (
    <motion.span
      initial={reduce ? false : { opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.18, ease: 'easeOut' }}
      className="shrink-0 rounded-pill bg-white/15 px-2.5 py-1 font-barlow text-[10px] font-bold uppercase tracking-wider text-white"
    >
      {/* Il testo visibile è la sola parola: è quello che l'occhio deve leggere
          in una pillola larga poche decine di pixel. La frase intera è per chi
          non la vede — e resta FUORI dal nodo con il `data-testid`, così il
          contenuto testuale del chip continua a essere «Docente»/«Genitore». */}
      <span className="sr-only">{t('profiloAttivo')} </span>
      <span data-testid="chip-ruolo-attivo">{labelRuolo(ruoloAttivo)}</span>
    </motion.span>
  );
}

export function AppBar({ area }: AppBarProps) {
  const t = useTranslations('shared');
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
            aria-label={t('indietro')}
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-transform active:scale-95"
          >
            <ArrowLeft size={20} strokeWidth={2.2} />
          </Link>
        )}
        <Link href={withUser(root)} aria-label={t('homeKidville')}>
          <Image
            src="/logo-light.png"
            alt="Kidville"
            width={620}
            height={209}
            priority
            style={{ height: 19, width: 'auto', display: 'block' }}
          />
        </Link>
        {/* A destra del wordmark: è il primo posto in cui l'occhio cade dopo il
            marchio, e il `mr-auto` è passato da lì a qui perché la campanella
            resti all'estremità. */}
        <div className="mr-auto flex min-w-0 items-center">
          <ChipVeste />
        </div>
        {!isOnboarding && <NotificationsPanel area={area} userId={userId} />}
      </div>
    </header>
  );
}
