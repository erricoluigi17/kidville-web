'use client';

import { type ReactNode } from 'react';
import { motion, type Variants } from 'framer-motion';

/**
 * Varianti condivise per l'entrata "blur-rise": gli elementi emergono da
 * sfocato + sotto, con scala leggermente ridotta, atterrando con uno spring.
 * Usate con stagger dal contenitore.
 */
export const containerStagger: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.08, delayChildren: 0.05 },
  },
};

export const blurRiseItem: Variants = {
  hidden: { opacity: 0, y: 24, scale: 0.96, filter: 'blur(8px)' },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: { type: 'spring', stiffness: 220, damping: 24, mass: 0.7 },
  },
};

/** Contenitore che orchestra lo stagger dei figli `RevealItem`. */
export function RevealGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={containerStagger}
      initial="hidden"
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Singolo elemento con entrata blur-rise. */
export function RevealItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div variants={blurRiseItem} className={className}>
      {children}
    </motion.div>
  );
}
