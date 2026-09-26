'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { BERSAGLIO_TOCCO } from '@/components/ui/FoglioFiltri';
import { etichettaClasse, NOME_CLASSE_ASSENTE, type ClasseFiltro } from '@/lib/pagamenti/filtro-classi';

/**
 * ─── FILTRO PER CLASSE DELLA CONTABILITÀ — selezione MULTIPLA ───────────────
 *
 *   CLASSE
 *   [ Tutte le classi            ▾ ]      ← comando: riepilogo della scelta
 *   ┌───────────────────────────────┐
 *   │ (TUTTE LE CLASSI)             │     ← azzera; premuto se niente è scelto
 *   │ AVERSA                        │     ← un gruppo per sede (solo multi-sede)
 *   │ (SEZIONE A)                   │
 *   │ GIUGLIANO                     │
 *   │ (SEZIONE A) (SEZIONE B)       │
 *   └───────────────────────────────┘
 *
 * ── DA DOVE VIENE ───────────────────────────────────────────────────────────
 * Non inventa un controllo nuovo: è il campo `multi` di `ui/BarraFiltri`
 * (pastiglie `aria-pressed` dentro un `fieldset`/`legend`, stessa geometria,
 * stessi toni) chiuso dentro il pannello a disclosure della stessa barra
 * (`aria-expanded` + `aria-controls`, pannello sempre nel DOM con `hidden`,
 * Escape e clic fuori chiudono, il fuoco torna al comando). Il raggruppamento
 * per sede con l'intestazione è quello di `SezioniMultiSelect`.
 *
 * Perché non `BarraFiltri` intera: quella possiede il PROPRIO stato
 * (`useFiltri`) e la propria card; qui serve un controllo CONTROLLATO da
 * montare dentro la barra già esistente dello Scadenzario, con la selezione
 * tenuta dal genitore (che la manda anche all'export come `section_ids`).
 *
 * ── LE OMONIME RESTANO SEPARATE ─────────────────────────────────────────────
 * Decisione del titolare: con più sedi «Sezione A» di Giugliano e «Sezione A»
 * di Aversa sono due voci. A schermo stanno sotto l'intestazione della loro
 * sede; nel NOME ACCESSIBILE la sede c'è sempre (`aria-label`), perché chi usa uno
 * screen reader e salta da un bottone all'altro non sente l'intestazione del
 * gruppo a ogni voce. Il nome contiene il testo visibile (WCAG 2.5.3).
 *
 * ── TELEFONO ────────────────────────────────────────────────────────────────
 * Sotto `sm` il pannello non galleggia: scende NEL FLUSSO a piena larghezza,
 * così non esce dallo schermo quando il comando è a destra, e sia il comando
 * sia le pastiglie hanno un bersaglio di 44px (WCAG 2.5.5).
 *
 * ── SELEZIONE SCADUTA E SEDE IGNOTA ─────────────────────────────────────────
 * Id selezionati che non sono più fra le `classi` (cambio di sede, righe
 * ricaricate) non contano per il riepilogo né per `aria-pressed`; se nessuno
 * è valido il comando dice «Classi non più disponibili» e resta disegnato
 * anche con `classi` vuote, perché «Tutte le classi» possa azzerare. Una sede
 * senza nome prende «Sede non indicata» (numerata se sono più d'una); una
 * classe senza nome (`NOME_CLASSE_ASSENTE`) prende «Classe senza nome». Gli id
 * ripetuti in `selezionate` contano una volta sola.
 *
 * Contratto: docs/superpowers/specs/2026-09-26-orario-appello-contabilita-cf/contratti/K6.md
 */

// Geometria e pastiglie: le stesse di `ui/BarraFiltri` (niente `outline-none`,
// vedi la nota sul fuoco in quel file). Ricopiate e non importate perché là
// sono costanti interne al modulo.
const GEOMETRIA =
  'h-[42px] rounded-input border-[1.5px] border-kidville-line bg-kidville-white font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';
const ETICHETTA =
  'mb-1 block font-barlow text-[11px] font-bold uppercase tracking-[0.05em] text-kidville-sub';
// Bersaglio di tocco: la costante del design system (`BERSAGLIO_TOCCO`, la
// stessa che `BarraFiltri` usa nel foglio del telefono), applicata mobile-first
// e annullata da `sm` in su. Non `max-sm:${BERSAGLIO_TOCCO}`: Tailwind legge le
// classi dal sorgente come testo, e una classe composta a runtime non
// genererebbe CSS.
const PASTIGLIA = cx(
  'inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 font-barlow text-[13px] font-extrabold uppercase tracking-[0.02em] transition-colors',
  BERSAGLIO_TOCCO,
  'sm:min-h-0 max-sm:px-4',
);
const PASTIGLIA_ON = 'bg-kidville-green text-kidville-white';
const PASTIGLIA_OFF =
  'bg-kidville-white text-kidville-ink/70 ring-[1.5px] ring-inset ring-kidville-line hover:text-kidville-green hover:ring-kidville-green/50';

export interface FiltroClassiContabilitaProps {
  /** Le classi fra cui scegliere, già ordinate (`classiDaAlunni`). */
  classi: ClasseFiltro[];
  /** Gli id (`section_id`) scelti. Vuoto = tutte le classi. */
  selezionate: string[];
  onChange: (ids: string[]) => void;
  /**
   * Più di una sede visibile (`useSediAttive().effettive.length > 1`, MAI
   * `selezionate`, dove vuoto = tutte): gruppi per sede e sede nelle etichette.
   * Se le `classi` coprono comunque più di una sede, la sede si mostra anche
   * con `false`.
   */
  mostraSede: boolean;
  className?: string;
}

interface Gruppo {
  chiave: string;
  titolo: string | null;
  classi: ClasseFiltro[];
}

export function FiltroClassiContabilita({
  classi,
  selezionate,
  onChange,
  mostraSede,
  className,
}: FiltroClassiContabilitaProps) {
  const t = useTranslations('adminContabilita');
  const idBase = useId();
  const idEtichetta = `${idBase}-etichetta`;
  const idRiepilogo = `${idBase}-riepilogo`;
  const idPannello = `${idBase}-pannello`;
  const [aperto, setAperto] = useState(false);
  const comandoRef = useRef<HTMLButtonElement>(null);
  const contenitoreRef = useRef<HTMLDivElement>(null);

  // Escape e clic fuori chiudono. `setState` sta dentro un ASCOLTATORE, non nel
  // corpo dell'effetto (`react-hooks/set-state-in-effect`): stesso schema di
  // `BarraFiltri`.
  useEffect(() => {
    if (!aperto) return;
    const suTasto = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setAperto(false);
      // WCAG 2.4.3: il fuoco torna al comando, non cade sul `<body>`.
      comandoRef.current?.focus();
    };
    const suClic = (e: MouseEvent) => {
      if (contenitoreRef.current && !contenitoreRef.current.contains(e.target as Node)) setAperto(false);
    };
    document.addEventListener('keydown', suTasto);
    document.addEventListener('mousedown', suClic);
    return () => {
      document.removeEventListener('keydown', suTasto);
      document.removeEventListener('mousedown', suClic);
    };
  }, [aperto]);

  // Il nome di sede da MOSTRARE per ogni `scuolaId`. Una sede assente dalla
  // mappa dei nomi arriva con `scuolaNome: ''` (`classiDaAlunni` non inventa
  // nomi): qui prende «Sede non indicata», numerata quando le sedi ignote sono
  // più d'una, così due «Sezione A» di due sedi ignote restano distinguibili.
  const nomiSedeVisti = useMemo(() => {
    const ignote = [...new Set(classi.filter((c) => c.scuolaNome === '').map((c) => c.scuolaId))];
    const mappa = new Map<string, string>();
    for (const c of classi) {
      if (c.scuolaNome !== '') mappa.set(c.scuolaId, c.scuolaNome);
    }
    ignote.forEach((id, i) =>
      mappa.set(id, ignote.length === 1 ? t('filtroClassiSedeIgnota') : t('filtroClassiSedeIgnotaN', { n: i + 1 })),
    );
    return mappa;
  }, [classi, t]);

  // DIFESA contro un `mostraSede` calcolato male dal genitore (es. dalla
  // `selezionate` di `useSediAttive()`, dove vuoto = TUTTE le sedi): se le
  // classi coprono più di una sede, la sede si mostra comunque. Altrimenti due
  // «Sezione A» di plessi diversi sarebbero due pastiglie identiche, con lo
  // stesso nome accessibile — ciò che la decisione del titolare esclude.
  const conSede = useMemo(
    () => mostraSede || new Set(classi.map((c) => c.scuolaId)).size > 1,
    [classi, mostraSede],
  );

  // Il nome da MOSTRARE: il segnaposto `NOME_CLASSE_ASSENTE` («—») non è un
  // testo, e un bottone che si chiama «—» lo screen reader lo legge come
  // «trattino» o come niente.
  const nomeDi = (c: ClasseFiltro) => (c.nome === NOME_CLASSE_ASSENTE ? t('filtroClassiSenzaNome') : c.nome);

  // Etichetta di una classe: con più sedi porta SEMPRE un nome di sede, vero o
  // di ripiego, mai un trattino appeso.
  const etichetta = (c: ClasseFiltro) =>
    etichettaClasse(
      { ...c, nome: nomeDi(c), scuolaNome: conSede ? (nomiSedeVisti.get(c.scuolaId) ?? '') : c.scuolaNome },
      conSede,
    );

  const gruppi = useMemo<Gruppo[]>(() => {
    if (classi.length === 0) return [];
    if (!conSede) return [{ chiave: 'tutte', titolo: null, classi }];
    const perSede = new Map<string, Gruppo>();
    for (const c of classi) {
      const g = perSede.get(c.scuolaId) ?? {
        chiave: c.scuolaId,
        titolo: nomiSedeVisti.get(c.scuolaId) ?? null,
        classi: [],
      };
      g.classi.push(c);
      perSede.set(c.scuolaId, g);
    }
    return [...perSede.values()];
  }, [classi, conSede, nomiSedeVisti]);

  // Un campo che non ha niente da scegliere non si disegna (come
  // `nascondiSeVuoto` in `BarraFiltri`) — ma SOLO se non c'è nemmeno una
  // selezione da azzerare: con id scaduti (cambio di sede, righe ricaricate) il
  // comando «Tutte le classi» deve restare raggiungibile.
  if (classi.length === 0 && selezionate.length === 0) return null;

  // Solo gli id che corrispondono a una classe in elenco contano per il
  // riepilogo, per `aria-pressed` e per la selezione che si rimanda al
  // genitore: un id scaduto non si vede, quindi non si annuncia, e il primo
  // tocco lo butta via. Deduplicati PRIMA di contare: un id ripetuto (da un
  // parametro URL, da un genitore che accoda) è una classe sola, non «2 classi».
  const presenti = new Set(classi.map((c) => c.id));
  const valide = [...new Set(selezionate)].filter((id) => presenti.has(id));
  const scelte = new Set(valide);
  const commuta = (id: string) => onChange(scelte.has(id) ? valide.filter((v) => v !== id) : [...valide, id]);

  let riepilogo: string;
  if (selezionate.length === 0) {
    riepilogo = t('filtroClassiTutte');
  } else if (valide.length === 0) {
    // C'è un filtro attivo che non corrisponde a nessuna classe visibile.
    riepilogo = t('filtroClassiNonDisponibili');
  } else if (valide.length === 1) {
    const unica = classi.find((c) => c.id === valide[0])!;
    riepilogo = etichetta(unica);
  } else {
    riepilogo = t('filtroClassiSelezionate', { n: valide.length });
  }

  const pastiglia = (attiva: boolean) => cx(PASTIGLIA, attiva ? PASTIGLIA_ON : PASTIGLIA_OFF);

  return (
    <div ref={contenitoreRef} className={cx('relative min-w-0', className)}>
      <span id={idEtichetta} className={ETICHETTA}>
        {t('filtroClassiEtichetta')}
      </span>
      <button
        ref={comandoRef}
        type="button"
        aria-labelledby={`${idEtichetta} ${idRiepilogo}`}
        aria-expanded={aperto}
        aria-controls={idPannello}
        onClick={() => setAperto((v) => !v)}
        className={cx(
          GEOMETRIA,
          // `max-sm:h-[44px]`: sul telefono anche il comando è un bersaglio da
          // 44px, come il campo di `BarraFiltri` nel modo `tocco`.
          'inline-flex w-full min-w-[200px] cursor-pointer items-center justify-between gap-2 px-3 text-left hover:border-kidville-green/50 max-sm:h-[44px] sm:w-auto',
        )}
      >
        <span id={idRiepilogo} className="min-w-0 truncate">
          {riepilogo}
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={cx('shrink-0 text-kidville-sub transition-transform', aperto && 'rotate-180')}
        />
      </button>

      {/* Sempre nel DOM: `aria-controls` punta qui, e un riferimento che sparisce
          a pannello chiuso è un `aria-controls` rotto. Niente `role="menu"`: un
          menu ARIA promette la navigazione con le frecce, che qui non c'è. */}
      <div
        id={idPannello}
        hidden={!aperto}
        role="group"
        aria-label={t('filtroClassiPannello')}
        className={cx(
          'z-40 mt-2 w-full rounded-card border border-kidville-line bg-kidville-white p-4 shadow-xl',
          'sm:absolute sm:left-0 sm:top-full sm:w-[360px] sm:max-w-[92vw]',
          'max-h-[60vh] overflow-y-auto',
        )}
      >
        <div className="flex flex-col gap-4">
          <div>
            <button
              type="button"
              aria-pressed={selezionate.length === 0}
              onClick={() => onChange([])}
              className={pastiglia(selezionate.length === 0)}
            >
              {t('filtroClassiTutte')}
            </button>
          </div>

          {gruppi.map((g) => (
            // `fieldset`/`legend`: le pastiglie sono un GRUPPO di interruttori.
            // Non `role="radiogroup"`: la scelta è multipla e revocabile.
            <fieldset key={g.chiave} className="min-w-0 border-0 p-0">
              <legend className={ETICHETTA}>{g.titolo || t('filtroClassiLegenda')}</legend>
              <div className="flex flex-wrap items-center gap-2">
                {g.classi.map((c) => {
                  const attiva = scelte.has(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={attiva}
                      // Con più sedi il nome accessibile porta la sede. `aria-label`
                      // e non uno `span.sr-only` col separatore: lo spazio in testa
                      // a un nodo figlio viene tagliato da alcuni motori di calcolo
                      // del nome (jsdom scrive «Sezione A— Giugliano»). Il nome
                      // COMINCIA col testo visibile, quindi WCAG 2.5.3 regge.
                      aria-label={conSede ? etichetta(c) : undefined}
                      onClick={() => commuta(c.id)}
                      className={pastiglia(attiva)}
                    >
                      {nomeDi(c)}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </div>
    </div>
  );
}
