'use client';

import { useEffect, useRef } from 'react';
import { Drawer } from '@/components/ui/cockpit';
import { useSchermoStretto } from '@/lib/ui/use-schermo-stretto';

/**
 * IL DETTAGLIO DI UN ELENCO LUNGO — accanto alla lista sul computer, sopra di essa sul telefono.
 *
 * Nato il 2026-10-17 per le candidature, e usato anche da «Moduli ricevuti». Prima il pannello
 * stava IN CIMA alla colonna destra della griglia: dopo aver scorso cinquanta curriculum e
 * averne aperto uno, il dettaglio compariva lassù, fuori dallo schermo, e per leggerlo bisognava
 * risalire — e poi ridiscendere a cercare il punto della lista. Sul telefono finiva sotto TUTTO
 * l'elenco.
 *
 * - **Computer (≥ 1024 px)**: la colonna resta ferma accanto alla lista (`sticky`, sotto la
 *   barra in alto `AdminTopBar`, alta `h-16`) e, quando il dettaglio è più alto dello schermo,
 *   scorre per conto suo. A ogni dettaglio nuovo riparte dalla cima.
 * - **Telefono e tablet in verticale**: il dettaglio si apre in un `Drawer` a tutta larghezza
 *   sopra la lista. La lista sotto non si muove, quindi chiudendo si torna esattamente dov'eri;
 *   il fuoco, l'Escape e il ritorno del fuoco alla riga li fa già il `Drawer`.
 *
 * Fra 768 e 1023 px le due colonne non si tengono: lì la barra in alto è quella mobile, ad
 * altezza variabile (e con l'area sicura nell'app nativa), e una colonna `sticky` le finirebbe
 * sotto.
 *
 * ⚠️ `aria-busy` resta un booleano sempre presente nel ramo «colonna»: i test dei pannelli
 * trovano il contenitore del dettaglio con `[aria-busy]` e si aspettano `"false"` a riposo.
 */
export function ColonnaDettaglio({
  aperto,
  onChiudi,
  titolo,
  occupato,
  segnaposto,
  chiaveContenuto,
  children,
}: {
  /** C'è un dettaglio da mostrare, o si sta aprendo. */
  aperto: boolean;
  onChiudi: () => void;
  /** Il nome del foglio sul telefono (`aria-labelledby` del dialogo). */
  titolo: string;
  /** Un dettaglio si sta aprendo. */
  occupato: boolean;
  /** Cosa mostra la colonna quando non c'è niente di aperto (solo sul computer). */
  segnaposto: React.ReactNode;
  /** Cambia a ogni dettaglio diverso: la colonna riparte dalla cima. */
  chiaveContenuto: string | null;
  children: React.ReactNode;
}) {
  const stretto = useSchermoStretto();
  const colonnaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (colonnaRef.current) colonnaRef.current.scrollTop = 0;
  }, [chiaveContenuto]);

  if (stretto) {
    return (
      <Drawer open={aperto} onClose={onChiudi} title={titolo} width={640} pieno>
        {children}
      </Drawer>
    );
  }

  return (
    <div
      ref={colonnaRef}
      aria-busy={occupato}
      className="min-w-0 overscroll-contain lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto"
    >
      {aperto ? children : segnaposto}
    </div>
  );
}
