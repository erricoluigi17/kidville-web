'use client';

import { useRef, type ReactNode, type MouseEvent } from 'react';
import { motion, useMotionValue, useSpring, useTransform, useReducedMotion } from 'framer-motion';

interface TiltCardProps {
  children: ReactNode;
  className?: string;
  /** Ampiezza massima del tilt in gradi. */
  intensity?: number;
}

/**
 * Card con tilt 3D "magnetico" che segue il cursore + glare/highlight che si
 * muove sulla superficie. Smorzamento via spring. Disabilitato (statico) se
 * l'utente preferisce ridurre il movimento. Pensata per le KPI card.
 */
export function TiltCard({ children, className = '', intensity = 8 }: TiltCardProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const glareOpacity = useSpring(0, { stiffness: 200, damping: 25 });

  const springCfg = { stiffness: 220, damping: 18, mass: 0.4 };
  const rotateX = useSpring(useTransform(py, [0, 1], [intensity, -intensity]), springCfg);
  const rotateY = useSpring(useTransform(px, [0, 1], [-intensity, intensity]), springCfg);

  // Glare: gradiente radiale che insegue il puntatore.
  const glare = useTransform(
    [px, py],
    ([x, y]: number[]) =>
      `radial-gradient(220px circle at ${x * 100}% ${y * 100}%, rgba(255,255,255,0.5), transparent 60%)`
  );

  function handleMove(e: MouseEvent<HTMLDivElement>) {
    if (reduce || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    px.set((e.clientX - rect.left) / rect.width);
    py.set((e.clientY - rect.top) / rect.height);
  }

  function handleEnter() {
    glareOpacity.set(1);
  }

  function handleLeave() {
    px.set(0.5);
    py.set(0.5);
    glareOpacity.set(0);
  }

  if (reduce) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      ref={ref}
      onMouseMove={handleMove}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{ rotateX, rotateY, transformPerspective: 900, transformStyle: 'preserve-3d' }}
      whileHover={{ scale: 1.025 }}
      transition={{ scale: { type: 'spring', stiffness: 300, damping: 20 } }}
      className={`relative ${className}`}
    >
      {children}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{ background: glare, opacity: glareOpacity }}
      />
    </motion.div>
  );
}
