import styles from './loading.module.css';

/**
 * Loader globale mostrato da Next.js durante il caricamento delle pagine
 * (Suspense boundary del segmento root). Schermata full-page con il logo
 * Kidville: flip 3D + riflesso. Server Component, nessun JS lato client.
 */
export default function Loading() {
  return (
    <div className={styles.overlay} role="status" aria-live="polite">
      <span className={styles.srOnly}>Caricamento in corso…</span>
      <span className={`${styles.glow} ${styles.glowA}`} aria-hidden="true" />
      <span className={`${styles.glow} ${styles.glowB}`} aria-hidden="true" />
      <div className={styles.loader}>
        <div className={styles.flipper} aria-hidden="true">
          <span className={styles.logo} />
          <span className={styles.sweep} />
        </div>
        <p className={styles.caption} aria-hidden="true">
          Caricamento
          <span className={styles.dot}>.</span>
          <span className={styles.dot}>.</span>
          <span className={styles.dot}>.</span>
        </p>
      </div>
    </div>
  );
}
