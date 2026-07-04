'use client';

import { useEffect, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

// =============================================================================
// Conferme di salvataggio riutilizzabili, senza dipendenze nuove (solo
// framer-motion, già in uso). Due varianti:
//  · SaveCheck        — spunta verde con stroke-draw, sobria: per il cockpit
//                       (segreteria/direzione), inline accanto a un'etichetta.
//  · SaveCelebration  — spunta + coriandoli hand-rolled, festosa: lato genitore
//                       (es. prenotazione mensa), overlay auto-dismiss.
// Entrambe rispettano prefers-reduced-motion: niente disegno progressivo né
// particelle, la spunta compare statica e immediata.
// =============================================================================

/** Spunta animata (cerchio + check) che si disegna con lo stroke. Eredita il
 *  colore dal testo (`currentColor`): avvolgila in un `text-kidville-success`. */
export function SaveCheck({ size = 20, stroke = 2.4, className }: { size?: number; stroke?: number; className?: string }) {
  const reduce = useReducedMotion();
  const drawn = { pathLength: 1, opacity: 1 };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} role="img" aria-label="Salvato">
      <motion.circle
        cx={12} cy={12} r={10} stroke="currentColor" strokeWidth={stroke} strokeOpacity={0.25}
        initial={reduce ? false : { pathLength: 0, opacity: 0 }}
        animate={drawn}
        transition={{ duration: reduce ? 0 : 0.4, ease: 'easeInOut' }}
      />
      <motion.path
        d="M6.5 12.5 L10.5 16.5 L17.5 8"
        stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
        initial={reduce ? false : { pathLength: 0, opacity: 0 }}
        animate={drawn}
        transition={{ duration: reduce ? 0 : 0.35, delay: reduce ? 0 : 0.25, ease: 'easeOut' }}
      />
    </svg>
  );
}

const CONFETTI = ['var(--kv-green, #006A5F)', '#FDC400', '#43A047', '#2A6FDB', '#E6720A'];

/** Celebrazione festosa (spunta + coriandoli) in overlay, auto-dismiss.
 *  `show` la attiva; chiama `onDone` allo scadere di `durationMs`. */
export function SaveCelebration({
  show,
  onDone,
  message = 'Fatto!',
  durationMs = 1600,
}: { show: boolean; onDone: () => void; message?: string; durationMs?: number }) {
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!show) return;
    const t = setTimeout(onDone, durationMs);
    return () => clearTimeout(t);
  }, [show, durationMs, onDone]);

  // Coriandoli deterministici (nessun Math.random → nessun mismatch di idratazione):
  // 14 particelle disposte a raggiera, distanza e colore variati per indice.
  const particles = useMemo(() => {
    const N = 14;
    return Array.from({ length: N }, (_, i) => {
      const angle = (i / N) * Math.PI * 2;
      const dist = 62 + (i % 3) * 16;
      return {
        x: Math.round(Math.cos(angle) * dist),
        y: Math.round(Math.sin(angle) * dist),
        color: CONFETTI[i % CONFETTI.length],
        delay: (i % 5) * 0.02,
      };
    });
  }, []);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          <div className="relative flex flex-col items-center">
            {!reduce && particles.map((p, i) => (
              <motion.span
                key={i}
                data-particle
                className="absolute h-2 w-2 rounded-full"
                style={{ background: p.color }}
                initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
                animate={{ x: p.x, y: p.y, opacity: [0, 1, 0], scale: 1 }}
                transition={{ duration: 0.9, delay: p.delay, ease: 'easeOut' }}
              />
            ))}
            <motion.div
              className="flex flex-col items-center gap-2 rounded-3xl bg-white/95 px-7 py-6 shadow-xl"
              initial={{ scale: reduce ? 1 : 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: reduce ? 'tween' : 'spring', stiffness: 320, damping: 18 }}
            >
              <span className="text-kidville-success"><SaveCheck size={46} stroke={2.6} /></span>
              <span className="font-barlow text-base font-black uppercase tracking-wide text-kidville-green">{message}</span>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
