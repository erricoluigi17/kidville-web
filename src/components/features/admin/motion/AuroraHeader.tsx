'use client';

import { type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Header con sfondo "aurora": blob mesh sfocati nei colori Kidville che
 * fluttuano lentamente in loop, come firma visiva della dashboard direzione.
 * Si ferma (resta un gradiente statico) con prefers-reduced-motion.
 */
export function AuroraHeader({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();

  return (
    <div
      className={`relative overflow-hidden rounded-[20px] bg-kidville-green text-white ${className}`}
    >
      {/* Strato aurora */}
      <div aria-hidden className="absolute inset-0 -z-0">
        <motion.div
          className="absolute -top-24 -left-16 h-72 w-72 rounded-full blur-3xl"
          style={{ backgroundColor: 'rgba(253,196,0,0.55)' }}
          animate={reduce ? undefined : { x: [0, 60, -20, 0], y: [0, 30, -10, 0], scale: [1, 1.15, 0.95, 1] }}
          transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute top-10 right-0 h-80 w-80 rounded-full blur-3xl"
          style={{ backgroundColor: 'rgba(67,160,71,0.55)' }}
          animate={reduce ? undefined : { x: [0, -50, 20, 0], y: [0, 20, 40, 0], scale: [1, 0.9, 1.1, 1] }}
          transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -bottom-20 left-1/3 h-64 w-64 rounded-full blur-3xl"
          style={{ backgroundColor: 'rgba(254,241,228,0.45)' }}
          animate={reduce ? undefined : { x: [0, 40, -30, 0], y: [0, -25, 15, 0], scale: [1, 1.1, 0.95, 1] }}
          transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>
      {/* Velo per leggibilità del testo */}
      <div aria-hidden className="absolute inset-0 bg-kidville-green/30" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
