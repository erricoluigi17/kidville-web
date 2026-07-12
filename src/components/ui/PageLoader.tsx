import styles from './PageLoader.module.css';

/**
 * Overlay di caricamento a pagina intera (variante "Riflesso"): logo Kidville
 * con banda di luce che lo attraversa ogni 2.4s. Presentazionale e riutilizzabile.
 *
 * NON è un boundary Suspense: va montato come *fratello* del contenuto (vedi
 * GlobalLoader in RootProviders), così non interferisce con l'hydration delle
 * pagine client (regressione appello del root app/loading.tsx, ora evitata).
 */
export function PageLoader({ visible }: { visible: boolean }) {
  return (
    <div
      className={styles.overlay}
      data-visible={visible ? 'true' : 'false'}
      role="status"
      aria-live="polite"
      aria-hidden={visible ? undefined : 'true'}
    >
      {/* Testo per screen reader reso SOLO quando visibile: la mutazione dentro
          la live region fa scattare l'annuncio (un testo statico presente dal
          mount non verrebbe annunciato). */}
      {visible ? <span className={styles.srOnly}>Caricamento in corso…</span> : null}
      <span className={`${styles.glow} ${styles.glowA}`} aria-hidden="true" />
      <span className={`${styles.glow} ${styles.glowB}`} aria-hidden="true" />
      <div className={styles.loader}>
        <div className={styles.logobox} aria-hidden="true">
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
