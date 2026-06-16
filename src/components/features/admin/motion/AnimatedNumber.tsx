'use client';

import { useEffect } from 'react';
import { useMotionValue, useTransform, animate, useReducedMotion, motion } from 'framer-motion';

interface AnimatedNumberProps {
  value: number;
  /** 'euro' formatta come valuta IT, 'int' come intero. */
  format?: 'euro' | 'int';
  /** Durata in secondi della salita. */
  duration?: number;
  className?: string;
}

const euroFmt = new Intl.NumberFormat('it-IT', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});
const intFmt = new Intl.NumberFormat('it-IT');

/**
 * Numero che sale da 0 al valore con uno spring smorzato (count-up).
 * Rispetta prefers-reduced-motion mostrando direttamente il valore finale.
 */
export function AnimatedNumber({ value, format = 'int', duration = 1.2, className }: AnimatedNumberProps) {
  const reduce = useReducedMotion();
  const count = useMotionValue(0);
  const rounded = useTransform(count, (latest) => {
    const v = Math.round(latest);
    return format === 'euro' ? euroFmt.format(v) : intFmt.format(v);
  });

  useEffect(() => {
    if (reduce) {
      count.set(value);
      return;
    }
    const controls = animate(count, value, {
      duration,
      ease: [0.16, 1, 0.3, 1], // easeOutExpo: parte veloce, atterra morbido
    });
    return () => controls.stop();
  }, [value, duration, reduce, count]);

  return <motion.span className={className}>{rounded}</motion.span>;
}
