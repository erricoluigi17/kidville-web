'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, Archive, RotateCcw } from 'lucide-react';
// ⚠️ Da `cosa-distrugge-voci` e NON da `cosa-distrugge`: questo è un componente
// client, e il secondo importa il logger, che tira dentro `supabase/server-client`.
// Con l'import «naturale» l'intera catena del server finisce nel bundle del browser
// e `npm run build` fallisce — misurato il 2026-08-13. Le voci sono le stesse:
// `cosa-distrugge` le ri-esporta per le route.
import { OBLIO_DISTRUGGE, OBLIO_RESTA, type CampoConteggioOblio } from '@/lib/gdpr/cosa-distrugge-voci';

// =============================================================================
// «QUESTA OPERAZIONE DISTRUGGE» — lo stesso riquadro sui DUE canali dell'oblio.
//
// ─── PERCHÉ È UN COMPONENTE E NON DUE BLOCCHI DI JSX ────────────────────────
//
// Su `/admin/gdpr` ci sono due pannelli, uno sopra l'altro, e tutti e due
// lanciano la stessa anonimizzazione irreversibile sugli stessi magazzini:
//  · `RichiesteCancellazionePanel` evade la richiesta ex art. 17 presentata
//    dalla famiglia — in BLOCCO, su tutti i figli non più iscritti insieme;
//  · `OblioPanel` la esercita d'iniziativa su un bambino solo.
//
// Fino al 2026-08-13 l'avviso stava solo nel secondo. Il primo — quello che
// risponde alla richiesta VERA di una famiglia, e che tocca più bambini con una
// conferma sola — faceva digitare «ANONIMIZZA» mostrando quattro conteggi
// (genitore, figli non iscritti, figli mantenuti, figli fuori scope) e nemmeno
// una parola su pagelle, certificati medici, foto o allegati. Peggio: l'avviso
// del pannello di sotto era legato alla selezione del pannello di sotto, quindi
// chi confermava in alto poteva leggere sotto dei numeri **di un altro bambino**.
//
// Un riquadro scritto due volte diverge, e questo riquadro esiste proprio perché
// due copie della stessa regola erano divergute (`sorteDellaFoto`). Uno solo,
// alimentato dal dry-run di chi lo mostra.
//
// ─── LA MISURA FALLITA NON È UNA MISURA A ZERO ──────────────────────────────
//
// `stato` ha quattro valori e non tre. Il quarto — `fallita` — nasce dal difetto
// misurato il 2026-08-13: se il dry-run rispondeva 500, il pannello restava
// visivamente IDENTICO a «non ho ancora scelto nessuno» (etichette con i due
// punti e niente dopo), la parola «non misurato» non compariva proprio nel caso
// in cui nulla era stato misurato, e il bottone rosso restava attivo. Cioè: la
// schermata tornava esattamente allo stato che questo riquadro è nato per
// abolire, e senza dirlo.
//
// Il fallimento non era «inghiottito» come sembra: il patch di `fetch` di
// `installaLoggerClient` scrive già la riga `POST /api/admin/gdpr/erase → 500`
// in `app_log`. Mancava l'altra metà — che di quel guasto si accorgesse la
// persona che stava per premere il bottone rosso, invece di una query fatta il
// giorno dopo da qualcun altro.
// =============================================================================

/** I conteggi che un dry-run può portare. `null` = «non l'ho potuto leggere». */
export type ContiOblio = Partial<Record<CampoConteggioOblio, number | null>>;

/**
 * A che punto è la misura di «che cosa distrugge».
 *
 *  · `assente`  — nessuno è ancora selezionato: l'elenco dice CHE COSA, non QUANTO;
 *  · `in-corso` — il dry-run sta girando: nessun numero, nemmeno un vecchio;
 *  · `ok`       — i numeri sono quelli del dry-run appena tornato;
 *  · `fallita`  — la misura non è riuscita, e si dice. Chi la riceve DEVE
 *                 bloccare la conferma: è il contratto di questo componente.
 */
export type StatoMisuraOblio = 'assente' | 'in-corso' | 'ok' | 'fallita';

export function AvvisoOblio({
  stato,
  conti,
  genitoriAnonimizzati,
  onRiprova,
}: {
  stato: StatoMisuraOblio;
  conti: ContiOblio | null;
  /**
   * Quanti genitori verranno anonimizzati da QUESTA operazione.
   *
   * Sotto zero le voci del canale GENITORE non si mostrano: `obliaPdfCredenziali`
   * gira solo dentro `anonimizzaParent`, cioè solo sugli adulti rimasti senza
   * altri figli iscritti. Con zero orfani il riquadro annunciava comunque «PDF
   * delle credenziali dei genitori anonimizzati» mentre non ne spariva nessuno —
   * e il pannello quel numero ce l'aveva già in mano. `null` = non lo sappiamo,
   * e allora si dice (tacere una distruzione è l'errore più caro dei due).
   */
  genitoriAnonimizzati: number | null;
  /** Rimette in moto il dry-run dopo un fallimento. */
  onRiprova?: () => void;
}) {
  const t = useTranslations('adminAltro');
  const misurato = stato === 'ok' || stato === 'fallita';

  // Il numero accanto a una voce, con le tre risposte tenute distinte: niente
  // ancora da dire (nessuno selezionato, o misura in corso), «non misurato» (la
  // lettura è fallita — `null`, campo assente, oppure l'intero dry-run caduto) e
  // il conteggio vero. Scrivere `0` dove la risposta è «non lo so» sarebbe la
  // stessa rassicurazione falsa per cui esiste questo riquadro.
  const conteggio = (campo?: CampoConteggioOblio, stima?: boolean) => {
    if (!campo || !misurato) return null;
    const n = stato === 'fallita' ? undefined : conti?.[campo];
    if (typeof n !== 'number') {
      return <em className="font-semibold text-kidville-error-strong">{t('oblioDistruggeNonMisurato')}</em>;
    }
    // «almeno N», non «N»: il dry-run di `file_da_rimuovere` conta i documenti
    // d'identità, e gli allegati che solo la domanda d'iscrizione conosce si
    // scoprono eseguendo. La route lo chiamava «una STIMA» in un commento;
    // adesso lo legge chi conferma.
    //
    // La parola e il numero sono accostati invece di stare in un `{n}` ICU: il
    // mock di `next-intl` dei test NON interpola i valori (`test/setup.ts`), e un
    // «almeno {n}» a schermo renderebbe l'asserzione impossibile — cioè
    // lascerebbe senza prova proprio la riga che dichiara il numero incompleto.
    return (
      <strong>
        {stima ? `${t('oblioDistruggeAlmeno')} ` : ''}
        {n}
      </strong>
    );
  };

  // Le voci del canale GENITORE spariscono quando si sa che nessun adulto verrà
  // anonimizzato: annunciare la distruzione di file che restano fa rifiutare
  // obliqui legittimi, ed è l'errore opposto e non più leggero.
  const voci = OBLIO_DISTRUGGE.filter(
    (v) => v.canale !== 'genitore' || genitoriAnonimizzati === null || genitoriAnonimizzati > 0,
  );

  const trattenute = stato === 'ok' ? conti?.foto_non_rimovibili : undefined;

  return (
    <div className="rounded-2xl border border-kidville-error/30 bg-kidville-error-soft p-4">
      <h3 className="flex items-center gap-2 font-barlow text-sm font-black uppercase tracking-wide text-kidville-error-strong">
        <AlertTriangle size={16} className="shrink-0" aria-hidden="true" /> {t('oblioDistruggeTitolo')}
      </h3>

      {/* LA MISURA È CADUTA, E SI VEDE. Senza questo riquadro la schermata era
          indistinguibile da «non ho ancora scelto nessuno»: stesse etichette,
          stesso vuoto dopo i due punti. `role="alert"` perché chi usa uno screen
          reader non «vede» che i numeri non sono arrivati. */}
      {stato === 'fallita' && (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-kidville-error/40 bg-kidville-white px-3 py-2"
        >
          <p className="font-maven text-[13px] font-semibold leading-relaxed text-kidville-error-strong">
            {t('oblioMisuraFallita')}
          </p>
          {onRiprova && (
            <button
              type="button"
              onClick={onRiprova}
              className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-error/40 px-3 py-1 font-maven text-xs font-semibold text-kidville-error-strong hover:bg-kidville-error-soft"
            >
              <RotateCcw size={13} aria-hidden="true" /> {t('oblioMisuraRiprova')}
            </button>
          )}
        </div>
      )}

      <ul className="mt-2 list-disc space-y-1 pl-5 font-maven text-[13px] leading-relaxed text-kidville-ink/80">
        {voci.map((voce) => (
          <li key={voce.chiave}>
            {t(voce.chiave)} {conteggio(voce.campo, voce.stima)}
          </li>
        ))}
      </ul>

      {/* Le foto di GRUPPO non stanno nell'elenco di sopra e non è una svista:
          dentro c'è l'immagine di altri bambini, quindi il file resta e se ne va
          soltanto il collegamento «questo è X». Metterle fra le distruzioni
          sarebbe un numero gonfiato; tacerle, una domanda senza risposta.
          `ink/80` e non `ink/70`: su `error-soft` il primo vale 5,87:1 e il
          secondo 4,46:1, cioè sotto i 4,5:1 di WCAG 1.4.3 AA — e la regola axe
          del contrasto non gira in jsdom, quindi nessun test lo avrebbe visto. */}
      <p className="mt-2 font-maven text-[12px] leading-relaxed text-kidville-ink/80">
        {t('oblioDistruggeFotoGruppo')} {conteggio('foto_di_gruppo')}
      </p>

      {/* Una foto in cui è l'unico ritratto e che l'oblio NON riesce a togliere è
          un oblio parziale: si dice solo quando c'è, e in rosso, perché è
          l'unica riga del riquadro che promette il contrario di una distruzione. */}
      {typeof trattenute === 'number' && trattenute > 0 && (
        <p className="mt-1 font-maven text-[12px] font-semibold leading-relaxed text-kidville-error-strong">
          {t('oblioDistruggeFotoTrattenute')} <strong>{trattenute}</strong>
        </p>
      )}

      <h3 className="mt-4 flex items-center gap-2 font-barlow text-sm font-black uppercase tracking-wide text-kidville-green">
        <Archive size={16} className="shrink-0" aria-hidden="true" /> {t('oblioRestaTitolo')}
      </h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 font-maven text-[13px] leading-relaxed text-kidville-ink/80">
        {OBLIO_RESTA.map((chiave) => (
          <li key={chiave}>{t(chiave)}</li>
        ))}
      </ul>
    </div>
  );
}
