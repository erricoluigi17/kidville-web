'use client';

import { Inbox, SearchX, TriangleAlert } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { Badge } from '@/components/ui/Badge';
import type { FiltroAttivo, StatoElencoTipo, Traduttore } from '@/lib/ui/filtri/tipi';

/**
 * ─── I QUATTRO STATI DI UN ELENCO, E PERCHÉ NON SONO DUE ─────────────────────
 *
 * | stato            | quando                          | cosa dice                                   |
 * |------------------|---------------------------------|---------------------------------------------|
 * | `caricamento`    | prima lettura                   | spinner, e si annuncia (`role="status"`)     |
 * | `vuoto`          | `totale === 0`                  | «Non c’è ancora nulla qui» + il passo da fare |
 * | `senzaRisultati` | `totale > 0 && mostrati === 0`  | «Nessun risultato con questi filtri» + chip  |
 * | `errore`         | la lettura è fallita            | «Non è stato possibile leggere» + «Riprova»  |
 *
 * ── LE DUE REGOLE CHE FANNO LA DIFFERENZA ───────────────────────────────────
 *
 * 1. **`vuoto` non nomina i filtri.** Dire «nessun risultato con questi filtri»
 *    su una tabella che non ha mai avuto una riga accusa i filtri di una colpa
 *    che non hanno, e manda la segreteria a cercare un filtro che non esiste. In
 *    questo progetto 5 linguette su 13 hanno zero righe in produzione: è il caso
 *    NORMALE, non il caso limite. Al suo posto ci va il passo costruttivo — il
 *    comando che quella riga la crea.
 *
 * 2. **Una lettura FALLITA non è mai `senzaRisultati`,** nemmeno con i filtri
 *    attivi: manderebbe a togliere filtri per un guasto che non è dell'utente.
 *    Perciò lo stato `errore` non mostra né i chip né «Pulisci filtri»: mostra
 *    «Riprova». La decisione sta in `decidiStatoElenco` (`lib/ui/filtri/motore`),
 *    che è pura e si prova senza montare niente.
 *
 * `pronto` non rende NIENTE: le righe sono già a schermo, ed è lo stato in cui
 * un elenco passa la vita.
 */

export interface TestiStatoElenco {
  /** Detto mentre gira lo spinner: uno spinner muto non annuncia niente. */
  caricamento: string;
  /** Il titolo dello stato vuoto. Le pagine lo sostituiscono col proprio. */
  vuotoTitolo: string;
  vuotoCorpo?: string;
  senzaRisultatiTitolo: string;
  senzaRisultatiCorpo?: string;
  pulisciFiltri: string;
  erroreTitolo: string;
  erroreCorpo?: string;
  riprova: string;
}

/**
 * I testi generici dal catalogo `shared`. Ogni chiave scritta per esteso (mai
 * costruita da un dato), e `vuotoTitolo` va quasi sempre sostituito con quello
 * della linguetta: «Non c'è ancora nulla qui» è vero ma non aiuta, «Non c'è
 * ancora nessun protocollo» sì.
 */
export function testiStatoElenco(t: Traduttore): TestiStatoElenco {
  return {
    caricamento: t('caricamentoInCorso'),
    vuotoTitolo: t('filtriVuotoTitolo'),
    senzaRisultatiTitolo: t('filtriSenzaRisultatiTitolo'),
    senzaRisultatiCorpo: t('filtriSenzaRisultatiCorpo'),
    pulisciFiltri: t('filtriPulisci'),
    erroreTitolo: t('filtriErroreTitolo'),
    erroreCorpo: t('filtriErroreCorpo'),
    riprova: t('paginaErroreRiprova'),
  };
}

const TITOLO = 'font-barlow text-lg font-extrabold uppercase text-kidville-green';
const CORPO = 'max-w-md font-maven text-sm text-kidville-sub';
const BOTTONE =
  'inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-3.5 py-2 font-maven text-sm font-semibold text-kidville-ink/80 transition-colors hover:border-kidville-green';

interface StatoElencoProps {
  stato: StatoElencoTipo;
  testi: TestiStatoElenco;
  /** Il passo costruttivo dello stato vuoto: il comando che crea la prima riga. */
  azione?: React.ReactNode;
  /** I filtri attivi, da mostrare in `senzaRisultati`. */
  attivi?: readonly FiltroAttivo[];
  onPulisci?: () => void;
  onRiprova?: () => void;
  className?: string;
}

export function StatoElenco({
  stato,
  testi,
  azione,
  attivi,
  onPulisci,
  onRiprova,
  className,
}: StatoElencoProps) {
  if (stato === 'pronto') return null;

  if (stato === 'caricamento') {
    return (
      <div role="status" className={cx('flex items-center justify-center gap-3 py-12', className)}>
        {/* `animate-spin` è onorato da `prefers-reduced-motion` in globals.css
            (la durata va a 0,001ms): niente giostra per chi soffre di
            vestibolarità, e nessuna regola in più da ricordare qui. */}
        <span
          aria-hidden="true"
          className="h-5 w-5 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green"
        />
        <p className="font-maven text-sm text-kidville-sub">{testi.caricamento}</p>
      </div>
    );
  }

  if (stato === 'errore') {
    return (
      <div className={cx('flex flex-col items-center gap-2 py-12 text-center', className)}>
        <TriangleAlert size={34} aria-hidden="true" className="text-kidville-error-strong" />
        <p className={TITOLO}>{testi.erroreTitolo}</p>
        {testi.erroreCorpo && <p className={CORPO}>{testi.erroreCorpo}</p>}
        {onRiprova && (
          <button type="button" onClick={onRiprova} className={cx(BOTTONE, 'mt-1')}>
            {testi.riprova}
          </button>
        )}
      </div>
    );
  }

  if (stato === 'vuoto') {
    return (
      <div className={cx('flex flex-col items-center gap-2 py-12 text-center', className)}>
        <Inbox size={34} aria-hidden="true" className="text-kidville-neutral" />
        <p className={TITOLO}>{testi.vuotoTitolo}</p>
        {testi.vuotoCorpo && <p className={CORPO}>{testi.vuotoCorpo}</p>}
        {azione && <div className="mt-1">{azione}</div>}
      </div>
    );
  }

  return (
    <div className={cx('flex flex-col items-center gap-2 py-12 text-center', className)}>
      <SearchX size={34} aria-hidden="true" className="text-kidville-neutral" />
      <p className={TITOLO}>{testi.senzaRisultatiTitolo}</p>
      {testi.senzaRisultatiCorpo && <p className={CORPO}>{testi.senzaRisultatiCorpo}</p>}
      {attivi && attivi.length > 0 && (
        <ul className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {attivi.map((a) => (
            <li key={`${a.chiave}:${a.valore ?? ''}`}>
              {/* Gli stessi toni dei chip della barra e dei badge dell'elenco:
                  chi guarda deve riconoscere QUI i filtri che ha messo LÌ. */}
              <Badge tone={a.tono ?? 'neutral'}>{a.testo}</Badge>
            </li>
          ))}
        </ul>
      )}
      {onPulisci && (
        <button type="button" onClick={onPulisci} className={cx(BOTTONE, 'mt-1')}>
          {testi.pulisciFiltri}
        </button>
      )}
    </div>
  );
}
