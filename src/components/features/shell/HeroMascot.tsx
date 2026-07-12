'use client';

import { useState } from 'react';
import Image from 'next/image';

interface HeroMascotProps {
  /** Larghezza del ritaglio in px. */
  width: number;
  /** Altezza del ritaglio in px: quando supera l'altezza della card il
   *  cappello sbuca dal bordo alto. Tenerla sotto width × 1,49 (rapporto
   *  della figura), altrimenti l'immagine non riempie il ritaglio in basso. */
  height: number;
  /** Distanza dal bordo destro della card, in px. */
  right?: number;
}

/**
 * Mascotte "a mezzo busto" del prototipo (tab gialla): ritaglio ancorato al
 * fondo della card con overflow-hidden; l'immagine intera è larga quanto il
 * ritaglio e ancorata in alto, così il busto è tagliato ESATTAMENTE al bordo
 * inferiore della card e il cappello sbuca dal bordo alto. Usa la mascotte
 * TRASPARENTE (mascot-hero.png, derivata da mascot.png ufficiale): quella
 * originale ha lo sfondo giallo opaco e creerebbe una cucitura fuori card.
 */
export function HeroMascot({ width, height, right = 20 }: HeroMascotProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 z-[1] flex select-none items-end justify-center text-[64px] opacity-30"
        style={{ right, width, height: Math.min(height, 96) }}
      >
        🎩
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0 z-[1] overflow-hidden"
      style={{ right, width, height }}
    >
      <Image
        src="/mascot-hero.png"
        alt=""
        width={665}
        height={994}
        priority
        draggable={false}
        onError={() => setFailed(true)}
        className="h-auto w-full select-none"
        sizes={`${width}px`}
      />
    </div>
  );
}
