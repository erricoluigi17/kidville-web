import { useTranslations } from 'next-intl';
import styles from './PageLoader.module.css';

/**
 * Overlay di caricamento a pagina intera (variante "Riflesso"): logo Kidville
 * con banda di luce che lo attraversa ogni 2.4s. Presentazionale e riutilizzabile.
 *
 * NON è un boundary Suspense: va montato come *fratello* del contenuto (vedi
 * GlobalLoader in RootProviders), così non interferisce con l'hydration delle
 * pagine client (regressione appello del root app/loading.tsx, ora evitata).
 *
 * `ref` ESPONE IL NODO RADICE, e serve a chi lo monta per rendere inerte tutto ciò
 * che sta FUORI dall'overlay mentre è a schermo (T09-F1: senza, il `Tab` continuava
 * a girare sui comandi coperti — WCAG 2.2 §2.4.11). Sta qui e non in GlobalLoader
 * perché è questo componente a possedere il proprio nodo radice; React 19 accetta
 * `ref` come prop normale, senza `forwardRef`.
 */
export function PageLoader({ visible, ref }: { visible: boolean; ref?: React.Ref<HTMLDivElement> }) {
  const t = useTranslations('shared');
  return (
    <div
      ref={ref}
      className={styles.overlay}
      data-visible={visible ? 'true' : 'false'}
      role="status"
      aria-live="polite"
      aria-hidden={visible ? undefined : 'true'}
    >
      {/* Testo per screen reader reso SOLO quando visibile: la mutazione dentro
          la live region fa scattare l'annuncio (un testo statico presente dal
          mount non verrebbe annunciato). */}
      {visible ? <span className={styles.srOnly}>{t('caricamentoInCorso')}</span> : null}
      <span className={`${styles.glow} ${styles.glowA}`} aria-hidden="true" />
      <span className={`${styles.glow} ${styles.glowB}`} aria-hidden="true" />
      <div className={styles.loader}>
        <div className={styles.logobox} aria-hidden="true">
          <span className={styles.logo} />
          <span className={styles.sweep} />
        </div>
        <p className={styles.caption} aria-hidden="true">
          {t('caricamento')}
          <span className={styles.dot}>.</span>
          <span className={styles.dot}>.</span>
          <span className={styles.dot}>.</span>
        </p>
      </div>
    </div>
  );
}
