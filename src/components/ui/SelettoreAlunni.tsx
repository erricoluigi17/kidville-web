'use client';

import { useMemo, useState } from 'react';
import { cx } from '@/lib/ui/cx';
import { testoCorrisponde } from '@/lib/ui/testo-ricerca';
import {
  alunniBersaglio,
  classiDi,
  nomeCompleto,
  type AlunnoSceglibile,
  type SelezioneAlunni,
} from '@/lib/pagamenti/selezione-alunni';

// =============================================================================
// SCEGLI CHI GENERARE — tutti, una classe, o certi bambini
//
// ⚠️ L'elenco che riceve dev'essere quello dei CANDIDATI dell'anteprima, non un
// elenco alunni generico: l'anteprima ha già tolto chi ha la retta a carico di un
// fratello, chi si è iscritto dopo quel mese e chi la retta ce l'ha già. Partendo
// da un elenco grezzo si potrebbe spuntare un bambino che poi la generazione
// scarta, e anteprima e conferma tornerebbero a dire numeri diversi.
//
// ⚠️ I TESTI ARRIVANO PER PROP, e non è pignoleria: è la disciplina di
// `components/ui` (vedi `Combobox`). Il mock di next-intl nei test restituisce la
// chiave grezza, quindi un componente che traduce da sé rende il collaudo cieco;
// e il plurale del conteggio lo deve fare l'ICU del catalogo, non una `if`.
//
// Regge le 314 iscritte di Giugliano senza virtualizzazione: il precedente è
// dichiarato in `Combobox`, 484 nodi nel pannello dei comuni.
// =============================================================================

export interface TestiSelettoreAlunni {
  legenda: string;
  modoTutti: string;
  modoClasse: string;
  modoScelti: string;
  classeEtichetta: string;
  classeTutte: string;
  cercaEtichetta: string;
  cercaSegnaposto: string;
  selezionaMostrati: string;
  svuota: string;
  vuoto: string;
  /** Funzioni, perché il plurale lo fa l'ICU del catalogo. */
  conteggio: (n: number) => string;
  bersaglio: (n: number) => string;
}

interface Props {
  id: string;
  /** I candidati dell'anteprima. */
  alunni: readonly AlunnoSceglibile[];
  valore: SelezioneAlunni;
  onChange: (s: SelezioneAlunni) => void;
  testi: TestiSelettoreAlunni;
  disabled?: boolean;
}

const PILL = 'rounded-pill border-[1.5px] px-3 py-1.5 font-maven text-xs transition-colors min-h-[38px]';
const PILL_ON = 'border-kidville-green bg-kidville-green text-kidville-white';
const PILL_OFF = 'border-kidville-line bg-kidville-white text-kidville-green hover:border-kidville-green';

export function SelettoreAlunni({ id, alunni, valore, onChange, testi, disabled }: Props) {
  const [cerca, setCerca] = useState('');
  const classi = useMemo(() => classiDi(alunni), [alunni]);

  // Il filtro della casella di ricerca, con lo stesso motore delle altre ricerche
  // del cockpit: due ricerche che cercano in modo diverso sono un difetto che si
  // vede solo con un termine accentato.
  const mostrati = useMemo(
    // ⚠️ `testoCorrisponde` e NON `rangoDiMatch`: il secondo pretende testo GIÀ
    // normalizzato e confronta con `indexOf`, quindi cercare «bianchi» su
    // «Bianchi Lia» non trovava niente — misurato, non dedotto. E un filtro non
    // ordina: tiene o scarta, che è esattamente ciò che quella funzione fa,
    // normalizzando accenti e maiuscole per conto suo.
    () => alunni.filter((a) => testoCorrisponde([nomeCompleto(a), a.classe_sezione], cerca)),
    [alunni, cerca],
  );

  const scelti = new Set(valore.ids);
  const bersaglio = alunniBersaglio(alunni, valore).length;

  const cambiaModo = (modo: SelezioneAlunni['modo']) => {
    if (modo === valore.modo) return;
    // Cambiando modo si azzera ciò che apparteneva all'altro: lasciare la classe
    // scelta mentre si spuntano i bambini fa credere che valgano tutt'e due.
    onChange({ modo, classe: modo === 'classe' ? valore.classe : '', ids: modo === 'scelti' ? valore.ids : [] });
  };

  const spunta = (idAlunno: string) => {
    const dopo = new Set(valore.ids);
    if (dopo.has(idAlunno)) dopo.delete(idAlunno);
    else dopo.add(idAlunno);
    onChange({ ...valore, ids: [...dopo] });
  };

  return (
    <fieldset id={id} disabled={disabled} className="rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3">
      <legend className="px-1 font-barlow text-[11px] font-extrabold uppercase tracking-[0.08em] text-kidville-green">
        {testi.legenda}
      </legend>

      <div className="flex flex-wrap gap-1.5">
        {([
          ['tutti', testi.modoTutti],
          ['classe', testi.modoClasse],
          ['scelti', testi.modoScelti],
        ] as const).map(([modo, etichetta]) => (
          <button key={modo} type="button" onClick={() => cambiaModo(modo)}
            aria-pressed={valore.modo === modo}
            className={cx(PILL, valore.modo === modo ? PILL_ON : PILL_OFF)}>
            {etichetta}
          </button>
        ))}
      </div>

      {valore.modo === 'classe' && (
        <label className="mt-3 flex flex-col">
          <span className="font-maven text-[11px] text-kidville-sub">{testi.classeEtichetta}</span>
          <select value={valore.classe} onChange={(e) => onChange({ ...valore, classe: e.target.value })}
            className="min-h-[38px] w-48 rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-1.5 font-maven text-sm text-kidville-ink transition-colors hover:border-kidville-green/50 focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15">
            <option value="">{testi.classeTutte}</option>
            {classi.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      )}

      {valore.modo === 'scelti' && (
        <div className="mt-3">
          <label className="flex flex-col">
            <span className="font-maven text-[11px] text-kidville-sub">{testi.cercaEtichetta}</span>
            <input type="search" value={cerca} onChange={(e) => setCerca(e.target.value)}
              placeholder={testi.cercaSegnaposto}
              className="min-h-[38px] w-full max-w-sm rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-1.5 font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15" />
          </label>

          {/* La regione live nasce PRIMA del contenuto: un `aria-live` creato
              insieme al testo che deve annunciare non annuncia niente. */}
          <p role="status" className="mt-1 font-maven text-[11px] text-kidville-sub">
            {testi.conteggio(mostrati.length)}
          </p>

          <div className="mt-1 flex flex-wrap gap-2">
            <button type="button"
              onClick={() => onChange({ ...valore, ids: [...new Set([...valore.ids, ...mostrati.map((a) => a.id)])] })}
              className="font-maven text-xs underline decoration-kidville-green/40 underline-offset-2 hover:decoration-kidville-green">
              {/* «i mostrati», non «tutti»: agisce su ciò che la ricerca ha
                  filtrato, che è l'unica cosa che chi preme sta guardando. */}
              {testi.selezionaMostrati}
            </button>
            <button type="button" onClick={() => onChange({ ...valore, ids: [] })}
              className="font-maven text-xs underline decoration-kidville-green/40 underline-offset-2 hover:decoration-kidville-green">
              {testi.svuota}
            </button>
          </div>

          <div className="mt-2 max-h-72 overflow-y-auto rounded-input border-[1.5px] border-kidville-line">
            {mostrati.length === 0 ? (
              <p className="px-3 py-6 text-center font-maven text-sm text-kidville-sub">{testi.vuoto}</p>
            ) : (
              <ul>
                {mostrati.map((a) => (
                  <li key={a.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 font-maven text-sm text-kidville-ink hover:bg-kidville-cream/50">
                      <input type="checkbox" checked={scelti.has(a.id)} onChange={() => spunta(a.id)}
                        className="h-4 w-4 shrink-0 accent-kidville-green" />
                      <span className="truncate">{nomeCompleto(a)}</span>
                      {a.classe_sezione ? <span className="shrink-0 text-xs text-kidville-sub">{a.classe_sezione}</span> : null}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <p className="mt-2 font-maven text-xs font-bold text-kidville-ink">{testi.bersaglio(bersaglio)}</p>
    </fieldset>
  );
}
