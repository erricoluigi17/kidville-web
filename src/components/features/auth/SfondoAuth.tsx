import styles from './sfondo-auth.module.css'

/**
 * LO SFONDO DELLE SCHERMATE SOTTO `/auth` — blob angolari e iconcine del design
 * «Kidville · Login (standalone)».
 *
 * ─── PERCHÉ NON VIVE PIÙ DENTRO LA LOGIN ────────────────────────────────────
 *
 * Ci ha vissuto finché la schermata sotto `/auth` era una. Con l’interstiziale del
 * primo accesso diventano due, e la seconda deve avere lo STESSO linguaggio visivo
 * della prima: le vede la stessa persona, nello stesso minuto, e una differenza di
 * scenografia fra le due si legge come «sono finito da un’altra parte» — proprio nel
 * momento in cui le si sta chiedendo di scrivere una password.
 *
 * «Stesso» ricopiato è due cose che si somigliano finché qualcuno non ne tocca una.
 * Perciò il componente e le sue regole CSS sono stati SPOSTATI qui, non duplicati:
 * path, coordinate e colori sono quelli di prima, byte per byte.
 *
 * ─── È DECORAZIONE, E SI COMPORTA COME TALE ─────────────────────────────────
 *
 * `aria-hidden` e `pointer-events: none`: non è contenuto e non è un bersaglio. In
 * Alto Contrasto NON si monta affatto — chi lo usa lo avvolge in `!highContrast` —
 * perché in quella modalità il fondo è nero e questi colori pieni sarebbero rumore
 * sopra il testo, non contorno.
 *
 * Nessun `'use client'`: qui non c’è stato né hook. La decisione di mostrarlo o no
 * la prende la pagina, che il contrasto lo conosce già.
 */
export function SfondoAuth() {
  return (
    <div className={styles.deco} aria-hidden="true">
      {/* cuneo verde in alto a destra */}
      <svg className={`${styles.blob} ${styles.blobTop}`} viewBox="318 0 84 250">
        <path
          className={styles.fillGreen}
          d="M402,0 L402,250 C 358,246 336,224 326,186 C 317,152 324,100 318,52 C 315,30 318,12 326,0 Z"
        />
      </svg>

      {/* collina verde/teal in basso a sinistra */}
      <svg className={`${styles.blob} ${styles.blobBottomLeft}`} viewBox="0 742 190 132">
        <path className={styles.fillTeal} d="M0,874 L0,742 C 40,724 100,732 146,772 C 176,798 188,840 190,874 Z" />
        <path className={styles.fillGreen} d="M0,874 L0,792 C 30,780 76,786 108,812 C 132,831 144,854 146,874 Z" />
      </svg>

      {/* collina gialla + onda verde in basso a destra */}
      <svg className={`${styles.blob} ${styles.blobBottomRight}`} viewBox="234 718 168 156">
        <path className={styles.fillYellow} d="M402,874 L402,762 C 362,766 306,776 270,810 C 246,832 236,856 234,874 Z" />
        <path className={styles.fillGreen} d="M402,720 C 348,728 298,750 272,788 C 306,760 356,752 402,768 Z" />
      </svg>

      <div className={styles.icons}>
        <svg className={`${styles.ico} ${styles.icoStar}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
          <path d="M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 17.8 6.4 20.1l1.4-6.3L3 9.5l6.4-.6L12 3z" />
        </svg>
        <svg className={`${styles.ico} ${styles.icoCloud}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
          <path d="M7 18h10a3.8 3.8 0 0 0 .5-7.6 5.4 5.4 0 0 0-10.5-1.3A3.7 3.7 0 0 0 7 18z" />
        </svg>
        <svg className={`${styles.ico} ${styles.icoRing}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <circle cx="12" cy="12" r="9" />
        </svg>
        <svg className={`${styles.ico} ${styles.icoHouse}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 11l8-6 8 6" />
          <path d="M6 10v9h12v-9" />
          <path d="M10 19v-5h4v5" />
        </svg>
      </div>
    </div>
  )
}
