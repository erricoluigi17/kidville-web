'use client';

import { useState } from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { useClientValue } from '@/lib/hooks/use-client-value';

interface HeroCardProps {
  /** Contenuto dell'`<h1>` (saluto): lo fornisce la pagina perché gli e2e
   *  vincolano l'h1 (nome figlio lato genitore, regex saluto lato docente). */
  title: React.ReactNode;
  /** true → placeholder pulse al posto dell'h1 (anti-flash finché il nome
   *  del figlio non è risolto, comportamento della home genitore). */
  loading?: boolean;
  subtitle?: React.ReactNode;
  /** Riga data "venerdì 29 maggio" sopra il saluto (SSR-safe). */
  showDate?: boolean;
  /** Altezza mascotte in px: più alta della card, il cappello sbuca dal bordo. */
  mascotHeight?: number;
  /** Entrata framer-motion (comportamento home genitore, ora anche docente). */
  animate?: boolean;
}

/**
 * Hero gialla delle home (DR yellow card): data, saluto Barlow 900, sottotitolo
 * e mascotte grande che scavalca il bordo alto (mockup utente). Wordmark e
 * campanella NON vivono più qui: stanno nella AppBar persistente. Usa la
 * mascotte TRASPARENTE (mascot-hero.png): quella ufficiale mascot.png ha lo
 * sfondo giallo opaco e creerebbe una cucitura visibile fuori dalla card.
 */
export function HeroCard({
  title,
  loading = false,
  subtitle,
  showDate = true,
  mascotHeight = 178,
  animate = true,
}: HeroCardProps) {
  const [mascotFailed, setMascotFailed] = useState(false);

  // Data locale calcolata SOLO client-side (hydration-safe, come il saluto).
  const oggi = useClientValue(
    () => new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }),
    '',
  );

  const body = (
    <>
      <div className="relative z-[2] px-5 pb-6 pt-5" style={{ maxWidth: '60%' }}>
        {showDate && (
          <p className="mb-0.5 font-maven text-xs font-semibold capitalize text-kidville-green/70">
            {oggi || ' '}
          </p>
        )}
        {loading ? (
          // Placeholder discreto: evita il flash del fallback prima che il
          // titolo (es. nome del figlio) sia risolto.
          <div className="h-9 w-44 max-w-full animate-pulse rounded-lg bg-black/5" aria-hidden="true" />
        ) : (
          <h1
            className="whitespace-pre-line font-barlow font-black uppercase leading-[0.98] tracking-tight text-kidville-green"
            style={{ fontSize: 30 }}
          >
            {title}
          </h1>
        )}
        {subtitle && <p className="mt-1.5 font-maven text-[13px] text-kidville-green/80">{subtitle}</p>}
      </div>

      {/* mascotte trasparente (665×994): ancorata in basso, più alta della
          card → il cappello scavalca il bordo (overflow visibile voluto) */}
      <div className="pointer-events-none absolute bottom-0 right-2 z-[1] flex items-end justify-end">
        {!mascotFailed ? (
          <Image
            src="/mascot-hero.png"
            alt=""
            width={133}
            height={199}
            priority
            draggable={false}
            onError={() => setMascotFailed(true)}
            className="select-none object-contain object-bottom"
            style={{ height: mascotHeight, width: 'auto' }}
          />
        ) : (
          <div className="flex select-none items-center justify-center text-[80px] opacity-30" style={{ width: 150, height: 150 }}>
            🎩
          </div>
        )}
      </div>
    </>
  );

  const cardClass = 'relative rounded-[28px] bg-kidville-yellow';
  const cardStyle = { minHeight: 160, boxShadow: '0 14px 30px -16px rgba(230,177,0,.7)' } as const;

  if (!animate) {
    return (
      <div className={cardClass} style={cardStyle}>
        {body}
      </div>
    );
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className={cardClass}
      style={cardStyle}
    >
      {body}
    </motion.div>
  );
}
