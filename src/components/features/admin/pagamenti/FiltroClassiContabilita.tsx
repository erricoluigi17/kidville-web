'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { SceltaMultiplaContabilita, type GruppoSceltaMultipla } from './SceltaMultiplaContabilita';
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

// Il comando, il pannello, lo stile e l'accessibilità stanno in
// `SceltaMultiplaContabilita` (generico, senza testi propri): qui restano solo
// i gruppi per sede, le etichette delle classi e i testi del dominio.

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

  // Con più sedi il nome accessibile porta la sede (`nomeAccessibile` →
  // `aria-label`); comincia col testo visibile, quindi WCAG 2.5.3 regge.
  const gruppiScelta: GruppoSceltaMultipla[] = gruppi.map((g) => ({
    chiave: g.chiave,
    titolo: g.titolo,
    voci: g.classi.map((c) => ({
      id: c.id,
      testo: nomeDi(c),
      nomeAccessibile: conSede ? etichetta(c) : undefined,
    })),
  }));

  return (
    <SceltaMultiplaContabilita
      etichetta={t('filtroClassiEtichetta')}
      riepilogo={riepilogo}
      testoTutte={t('filtroClassiTutte')}
      tutteAttiva={selezionate.length === 0}
      etichettaPannello={t('filtroClassiPannello')}
      legendaPredefinita={t('filtroClassiLegenda')}
      gruppi={gruppiScelta}
      attive={scelte}
      onCommuta={commuta}
      onTutte={() => onChange([])}
      className={className}
    />
  );
}
