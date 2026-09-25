'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { ImpreparatoForm, type MateriaOpzione } from '@/components/features/parent/ImpreparatoForm';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { useDateFormat } from '@/lib/i18n/date';
import { erroreDaRisposta } from '@/lib/ui/esito-fetch';
import { logClient } from '@/lib/logging/client';
import { FUOCO_ESITO } from '@/lib/ui/fuoco';
import type { ImpreparatoGenitore } from '@/lib/primaria/visibilita-genitore';

interface ValBreve {
  id: string; tipo: string; modalita: string;
  giudizio_sintetico: string | null; giudizio_testo: string | null;
  creato_il: string; argomento: string | null;
}
interface MateriaVoce {
  materiaId: string; nome: string; valutazioni: ValBreve[];
}

/**
 * Una riga della card di una materia: un voto o un impreparato, in ordine di
 * data. `annullata` è il SEGNAPOSTO della dichiarazione appena annullata: resta
 * dove stava la riga, con la conferma, finché il genitore non fa altro.
 */
type Voce =
  | { genere: 'valutazione'; quando: string; v: ValBreve }
  | { genere: 'impreparato'; quando: string; i: ImpreparatoGenitore }
  | { genere: 'annullata'; quando: string; id: string };

/**
 * L'esito di un'azione sulla riga di UNA dichiarazione (`id`): si mostra lì, non
 * in cima alla pagina, dove su un telefono resterebbe fuori dallo schermo.
 *  · `annullamento-rifiutato`: dentro il riquadro di conferma, che resta aperto;
 *  · `annullata`: al posto della riga, nella card dov'era (`chiave`, `nome`);
 *  · `modificata`: sotto i pulsanti della riga, ovunque la riga sia finita.
 */
type Esito =
  | { id: string; genere: 'annullamento-rifiutato'; testo: string }
  | { id: string; genere: 'annullata'; chiave: string; nome: string; quando: string }
  | { id: string; genere: 'modificata' };

/** Il giorno di un impreparato a mezzogiorno: confrontabile con i `creato_il`. */
const quandoImpreparato = (data: string) => `${data}T12:00:00`;

interface Gruppo {
  chiave: string;
  nome: string;
  anteprima: string | null;
  numValutazioni: number;
  numImpreparati: number;
  voci: Voce[];
}

/** La card degli impreparati senza materia: una chiave che nessun uuid può avere. */
const SENZA_MATERIA = '__senza-materia__';

// Colore per giudizio sintetico (DR VotiTab GIUDIZIO_STYLE). Copre la scala a 6
// livelli e quella O.M. 3/2025 a 4 livelli. Solo giudizi, mai numeri.
const GIUDIZIO_TINT: Record<string, string> = {
  'Ottimo': 'bg-kidville-success-soft text-kidville-success',
  'Distinto': 'bg-kidville-green-soft text-kidville-green',
  'Buono': 'bg-kidville-info-soft text-kidville-info',
  'Discreto': 'bg-kidville-warn-soft text-kidville-warn',
  'Sufficiente': 'bg-kidville-yellow-soft text-kidville-yellow-dark',
  'Non sufficiente': 'bg-kidville-error-soft text-kidville-error',
  'Avanzato': 'bg-kidville-success-soft text-kidville-success',
  'Intermedio': 'bg-kidville-info-soft text-kidville-info',
  'Base': 'bg-kidville-warn-soft text-kidville-warn',
  'In via di prima acquisizione': 'bg-kidville-error-soft text-kidville-error',
};
const giudizioCls = (g: string | null) =>
  (g && GIUDIZIO_TINT[g]) || 'bg-kidville-green/10 text-kidville-green';

// Le etichette per esteso, non composte da un dato: una chiave costruita a
// runtime è invisibile a chi cerca le chiavi orfane del catalogo.
const ETICHETTA_TIPO = {
  impreparato: 'impreparatoTipo_impreparato',
  giustificato: 'impreparatoTipo_giustificato',
} as const;
const ETICHETTA_ORIGINE = {
  genitore: 'impreparatoOrigine_genitore',
  docente: 'impreparatoOrigine_docente',
} as const;

/**
 * Le card per materia: quelle con voti (nell'ordine del server, che è l'ordine
 * delle materie della classe), poi le materie che hanno SOLO impreparati, poi
 * gli impreparati senza materia. Dentro ogni card, voti e impreparati insieme,
 * dal più recente.
 */
function raggruppa(
  materie: MateriaVoce[],
  impreparati: ImpreparatoGenitore[],
  materieClasse: MateriaOpzione[],
  nomeSenzaMateria: string,
  annullata: Extract<Esito, { genere: 'annullata' }> | null = null,
): Gruppo[] {
  const gruppi = new Map<string, Gruppo>();
  for (const m of materie) {
    gruppi.set(m.materiaId, {
      chiave: m.materiaId,
      nome: m.nome,
      anteprima: m.valutazioni.find((v) => v.giudizio_sintetico)?.giudizio_sintetico ?? null,
      numValutazioni: m.valutazioni.length,
      numImpreparati: 0,
      voci: m.valutazioni.map((v) => ({ genere: 'valutazione' as const, quando: v.creato_il, v })),
    });
  }
  const aggiunti: Gruppo[] = [];
  for (const i of impreparati) {
    const chiave = i.materiaId ?? SENZA_MATERIA;
    let g = gruppi.get(chiave);
    if (!g) {
      const nome =
        chiave === SENZA_MATERIA
          ? nomeSenzaMateria
          : i.materiaNome ?? materieClasse.find((m) => m.id === chiave)?.nome ?? nomeSenzaMateria;
      g = { chiave, nome, anteprima: null, numValutazioni: 0, numImpreparati: 0, voci: [] };
      gruppi.set(chiave, g);
      aggiunti.push(g);
    }
    g.numImpreparati++;
    g.voci.push({ genere: 'impreparato', quando: quandoImpreparato(i.data), i });
  }
  // Il segnaposto dell'annullamento, nella card dov'era la riga — anche se era
  // l'ultima voce di quella card. Se il server rimanda la dichiarazione (non è
  // stata tolta davvero), vince la riga vera e il segnaposto non si mostra.
  if (annullata && !impreparati.some((i) => i.id === annullata.id)) {
    let g = gruppi.get(annullata.chiave);
    if (!g) {
      g = { chiave: annullata.chiave, nome: annullata.nome, anteprima: null, numValutazioni: 0, numImpreparati: 0, voci: [] };
      gruppi.set(annullata.chiave, g);
      aggiunti.push(g);
    }
    g.voci.push({ genere: 'annullata', quando: annullata.quando, id: annullata.id });
  }
  for (const g of gruppi.values()) g.voci.sort((a, b) => (a.quando < b.quando ? 1 : a.quando > b.quando ? -1 : 0));
  const posizione = (chiave: string) => {
    if (chiave === SENZA_MATERIA) return Number.MAX_SAFE_INTEGER;
    const k = materieClasse.findIndex((m) => m.id === chiave);
    return k === -1 ? Number.MAX_SAFE_INTEGER - 1 : k;
  };
  aggiunti.sort((a, b) => posizione(a.chiave) - posizione(b.chiave));
  return [...materie.map((m) => gruppi.get(m.materiaId)!), ...aggiunti];
}

function ValutazioniGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const t = useTranslations('parentPrimaria');
  const f = useDateFormat();
  const [materie, setMaterie] = useState<MateriaVoce[]>([]);
  const [impreparati, setImpreparati] = useState<ImpreparatoGenitore[]>([]);
  const [materieClasse, setMaterieClasse] = useState<MateriaOpzione[] | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * `null` = nessun errore. `testo` vuoto = errore senza codice: la frase
   * generica si sceglie al render, così `carica` non dipende da `t` (che può
   * cambiare identità a ogni render e farebbe ripartire la lettura).
   */
  const [erroreElenco, setErroreElenco] = useState<{ testo: string } | null>(null);
  /** `undefined` = il genitore non ha ancora scelto: con una card sola la si apre. */
  const [aperta, setAperta] = useState<string | null | undefined>(undefined);
  const [inModifica, setInModifica] = useState<string | null>(null);
  const [daAnnullare, setDaAnnullare] = useState<string | null>(null);
  const [annullando, setAnnullando] = useState<string | null>(null);
  const [esito, setEsito] = useState<Esito | null>(null);

  /**
   * IL FUOCO (WCAG 2.4.3). «Modifica», «Annulla», «No, tienila», «Chiudi» e
   * «Sì, annulla» SMONTANO il pulsante appena premuto: senza uno spostamento
   * esplicito il fuoco cade su `<body>` e chi usa tastiera o lettore di schermo
   * riparte dall'inizio della pagina. Chi agisce scrive qui DOVE deve andare (il
   * `data-fuoco` di un elemento della riga) e l'effetto qui sotto ce lo porta
   * dopo il render che monta quell'elemento. Una richiesta si consuma a ogni
   * render: se il bersaglio non c'è, non resta in agguato a rubare il fuoco dopo.
   * `data-fuoco` e non un `ref`: `Btn` non inoltra i ref.
   */
  const radice = useRef<HTMLDivElement | null>(null);
  const fuocoDopo = useRef<string | null>(null);
  useEffect(() => {
    const bersaglio = fuocoDopo.current;
    if (!bersaglio) return;
    fuocoDopo.current = null;
    radice.current?.querySelector<HTMLElement>(`[data-fuoco="${bersaglio}"]`)?.focus();
  });

  /**
   * Una riga di log per ogni esito negativo: `stato` è un numero, `cosa` una
   * costante. Il corpo NON si logga (può portare il motivo, testo su un minore).
   */
  const segnala = useCallback((cosa: string, stato?: number, errore?: unknown) => {
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `parent/voti: ${cosa}${errore instanceof Error ? ` (${errore.name})` : ''}`,
      stato,
    });
  }, []);

  // `try/finally` e non `try/catch`: è la forma che `react-hooks/set-state-in-effect`
  // accetta per una funzione async chiamata da un effetto. Il fallimento della
  // rete lo raccoglie chi chiama, che lo logga e lo dice a schermo.
  const carica = useCallback(async () => {
    if (!parentId || !studentId) return;
    try {
      const r = await fetch(`/api/parent/primaria/valutazioni?studentId=${studentId}&userId=${parentId}`, {
        headers: { 'x-user-id': parentId },
      });
      if (!r.ok) {
        // Prima di questo compito un rifiuto diventava «Nessuna valutazione
        // disponibile»: uno stato che finge il successo.
        const e = await erroreDaRisposta(r, '');
        setErroreElenco({ testo: e.testo });
        segnala(e.corpoLetto ? 'elenco-respinto' : 'elenco-respinto-senza-corpo', e.stato);
        return;
      }
      const d = await r.json();
      if (!d?.success) {
        setErroreElenco({ testo: '' });
        segnala('elenco-senza-successo', r.status);
        return;
      }
      setMaterie(Array.isArray(d.data) ? d.data : []);
      setImpreparati(Array.isArray(d.impreparati) ? d.impreparati : []);
      setMaterieClasse(Array.isArray(d.materieClasse) ? d.materieClasse : null);
      setErroreElenco(null);
    } finally {
      setLoading(false);
    }
  }, [parentId, studentId, segnala]);

  const caricaSegnalando = useCallback(() => {
    void carica().catch((e) => {
      segnala('elenco-non-letto', undefined, e);
      setErroreElenco({ testo: '' });
    });
  }, [carica, segnala]);

  useEffect(() => {
    if (!ready) return;
    caricaSegnalando();
  }, [ready, caricaSegnalando]);

  const gruppi = raggruppa(
    materie,
    impreparati,
    materieClasse ?? [],
    t('impreparatoSenzaMateria'),
    esito?.genere === 'annullata' ? esito : null,
  );
  const apertaOra = aperta === undefined ? (gruppi.length === 1 ? gruppi[0].chiave : null) : aperta;
  // Se il server non manda le materie della classe (versione precedente), il
  // modulo offre almeno quelle già valutate: la materia resta facoltativa.
  const opzioniMaterie: MateriaOpzione[] = materieClasse ?? materie.map((m) => ({ id: m.materiaId, nome: m.nome }));

  const giorno = (iso: string) => f.dataBreve(`${iso}T12:00:00`) || iso;

  const annulla = async (i: ImpreparatoGenitore, g: Gruppo) => {
    if (!parentId || annullando) return;
    setAnnullando(i.id);
    setEsito(null);
    const rifiuto = (testo: string) => setEsito({ id: i.id, genere: 'annullamento-rifiutato', testo });
    try {
      const r = await fetch(`/api/parent/giustifiche-didattiche?id=${i.id}&userId=${parentId}`, {
        method: 'DELETE',
        headers: { 'x-user-id': parentId },
      });
      if (!r.ok) {
        // Il riquadro di conferma resta aperto, col rifiuto DENTRO: il fuoco è
        // ancora su «Sì, annulla», che non si smonta.
        const e = await erroreDaRisposta(r, t('impreparatoAnnullaNonRiuscito'));
        rifiuto(e.testo);
        segnala(e.corpoLetto ? 'annullamento-respinto' : 'annullamento-respinto-senza-corpo', e.stato);
        return;
      }
      // Il server ha confermato: la riga si toglie SUBITO (senza aspettare la
      // rilettura) e al suo posto resta la conferma, che prende il fuoco.
      setDaAnnullare(null);
      setImpreparati((prima) => prima.filter((x) => x.id !== i.id));
      setEsito({ id: i.id, genere: 'annullata', chiave: g.chiave, nome: g.nome, quando: quandoImpreparato(i.data) });
      fuocoDopo.current = `esito-${i.id}`;
      caricaSegnalando();
    } catch (e) {
      rifiuto(t('impreparatoAnnullaNonRiuscito'));
      segnala('annullamento-non-riuscito', undefined, e);
    } finally {
      setAnnullando(null);
    }
  };

  const dopoNuova = ({ materiaId }: { materiaId: string | null }) => {
    setEsito(null);
    // La card dove la dichiarazione ora vive si apre: è lì che il genitore la cerca.
    setAperta(materiaId ?? SENZA_MATERIA);
    caricaSegnalando();
  };

  const dopoModifica =
    (i: ImpreparatoGenitore) =>
    ({ materiaId, data, motivo }: { materiaId: string | null; data: string; motivo: string | null }) => {
      // Il server ha accettato QUESTI valori: la riga li prende subito, così è
      // già nella card giusta quando il fuoco torna sul suo «Modifica» (se la
      // riga cambiasse card dopo, alla rilettura, il fuoco andrebbe perso).
      const materiaNome =
        materiaId === null
          ? null
          : materiaId === i.materiaId
            ? i.materiaNome
            : opzioniMaterie.find((m) => m.id === materiaId)?.nome ?? null;
      setImpreparati((prima) => prima.map((x) => (x.id === i.id ? { ...x, materiaId, materiaNome, data, motivo } : x)));
      setInModifica(null);
      setEsito({ id: i.id, genere: 'modificata' });
      setAperta(materiaId ?? SENZA_MATERIA);
      fuocoDopo.current = `modifica-${i.id}`;
      caricaSegnalando();
    };

  const rigaImpreparato = (i: ImpreparatoGenitore, g: Gruppo) => {
    const rifiuto = esito?.genere === 'annullamento-rifiutato' && esito.id === i.id ? esito.testo : null;
    return (
      <div key={`imp-${i.id}`} className="px-4 py-3" data-impreparato={i.id}>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="rounded-full bg-kidville-warn-soft px-2.5 py-0.5 font-maven text-xs font-semibold text-kidville-warn">
            {t(ETICHETTA_TIPO[i.tipo])}
          </span>
          <span className="font-maven text-xs text-kidville-sub">{t(ETICHETTA_ORIGINE[i.origine])}</span>
          <span className="font-maven text-xs text-kidville-sub ml-auto">{giorno(i.data)}</span>
        </div>
        {i.motivo && <p className="font-maven text-xs text-kidville-sub">{t('impreparatoMotivo', { value: i.motivo })}</p>}
        {i.modificabile_dal_genitore && (
          inModifica === i.id ? (
            <ImpreparatoForm
              studentId={studentId}
              parentId={parentId}
              materie={opzioniMaterie}
              modifica={{ id: i.id, data: i.data, materiaId: i.materiaId, materiaNome: i.materiaNome, motivo: i.motivo }}
              onSalvato={dopoModifica(i)}
              onChiudi={() => {
                setInModifica(null);
                fuocoDopo.current = `modifica-${i.id}`;
              }}
            />
          ) : daAnnullare === i.id ? (
            <div className="mt-2 rounded-card bg-kidville-cream/50 p-3" role="group" aria-label={t('impreparatoAnnullaAria', { giorno: giorno(i.data) })}>
              <p
                tabIndex={-1}
                data-fuoco={`conferma-${i.id}`}
                className={`mb-2 rounded-sm font-maven text-xs text-kidville-ink ${FUOCO_ESITO}`}
              >
                {t('impreparatoAnnullaConferma', { giorno: giorno(i.data) })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Btn size="sm" variant="danger" onClick={() => annulla(i, g)} aria-disabled={annullando === i.id || undefined}>
                  {annullando === i.id ? t('impreparatoAnnullamento') : t('impreparatoAnnullaSi')}
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDaAnnullare(null);
                    setEsito(null);
                    fuocoDopo.current = `annulla-${i.id}`;
                  }}
                  disabled={annullando === i.id}
                >
                  {t('impreparatoAnnullaNo')}
                </Btn>
              </div>
              {rifiuto && (
                <p role="alert" className="mt-2 font-maven text-xs text-kidville-error">
                  {rifiuto}
                </p>
              )}
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Btn
                size="sm"
                variant="secondary"
                data-fuoco={`modifica-${i.id}`}
                aria-label={t('impreparatoModificaAria', { giorno: giorno(i.data) })}
                onClick={() => { setEsito(null); setDaAnnullare(null); setInModifica(i.id); }}
              >
                {t('impreparatoModifica')}
              </Btn>
              <Btn
                size="sm"
                variant="danger"
                data-fuoco={`annulla-${i.id}`}
                aria-label={t('impreparatoAnnullaAria', { giorno: giorno(i.data) })}
                onClick={() => {
                  setEsito(null);
                  setInModifica(null);
                  setDaAnnullare(i.id);
                  fuocoDopo.current = `conferma-${i.id}`;
                }}
              >
                {t('impreparatoAnnulla')}
              </Btn>
            </div>
          )
        )}
        {esito?.genere === 'modificata' && esito.id === i.id && inModifica !== i.id && (
          <p role="status" className="mt-2 font-maven text-xs text-kidville-success">
            {t('impreparatoModificata')}
          </p>
        )}
      </div>
    );
  };

  const rigaAnnullata = (id: string) => (
    <div key={`annullata-${id}`} className="px-4 py-3">
      <p
        role="status"
        tabIndex={-1}
        data-fuoco={`esito-${id}`}
        className={`rounded-sm font-maven text-xs text-kidville-success ${FUOCO_ESITO}`}
      >
        {t('impreparatoAnnullata')}
      </p>
    </div>
  );

  const rigaValutazione = (v: ValBreve) => (
    <div key={`val-${v.id}`} className="px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        {v.giudizio_sintetico && (
          <span className={`rounded-full px-2.5 py-0.5 font-maven text-xs font-semibold ${giudizioCls(v.giudizio_sintetico)}`}>
            {v.giudizio_sintetico}
          </span>
        )}
        <span className="font-maven text-xs capitalize text-kidville-sub">{v.tipo}</span>
        <span className="font-maven text-xs text-kidville-sub ml-auto">
          {f.dataBreve(v.creato_il)}
        </span>
      </div>
      {v.argomento && <p className="font-maven text-xs text-kidville-sub">{v.argomento}</p>}
      {v.giudizio_testo && <p className="font-maven text-xs text-kidville-sub mt-1 italic">{v.giudizio_testo}</p>}
    </div>
  );

  return (
    <div ref={radice} className="px-4 pt-5 pb-24">
      <PageHeaderCard eyebrow={t('eyebrow')} title={t('valutazioniTitolo')} className="mb-4" />

      {ready && parentId && studentId && (
        <div className="mb-4">
          <ImpreparatoForm
            studentId={studentId}
            parentId={parentId}
            materie={opzioniMaterie}
            onSalvato={dopoNuova}
          />
        </div>
      )}

      {loading ? (
        <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>
      ) : erroreElenco ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="font-maven text-sm text-kidville-error">{erroreElenco.testo || t('valutazioniNonCaricate')}</p>
          <Btn size="sm" variant="secondary" onClick={caricaSegnalando}>{t('valutazioniRiprova')}</Btn>
        </div>
      ) : gruppi.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">{t('valutazioniVuoto')}</p>
      ) : (
        <div className="space-y-3">
          {gruppi.map((g) => {
            const isOpen = apertaOra === g.chiave;
            const conteggio = [
              g.numValutazioni > 0 ? t('valutazioniConteggio', { count: g.numValutazioni }) : null,
              g.numImpreparati > 0 ? t('impreparatiConteggio', { count: g.numImpreparati }) : null,
            ].filter(Boolean).join(' · ');
            return (
              <div key={g.chiave} className="rounded-card border border-kidville-line bg-white shadow-sm overflow-hidden">
                <button
                  onClick={() => setAperta(isOpen ? null : g.chiave)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3.5"
                >
                  <div className="text-left">
                    <p className="font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green">{g.nome}</p>
                    <p className="font-maven text-xs text-kidville-sub">{conteggio}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {g.anteprima && !isOpen && (
                      <span className={`rounded-full px-2.5 py-0.5 font-maven text-xs font-semibold ${giudizioCls(g.anteprima)}`}>
                        {g.anteprima}
                      </span>
                    )}
                    <ChevronDown size={18} className={`text-kidville-sub transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-kidville-line divide-y divide-kidville-line">
                    {g.voci.map((voce) =>
                      voce.genere === 'valutazione'
                        ? rigaValutazione(voce.v)
                        : voce.genere === 'impreparato'
                          ? rigaImpreparato(voce.i, g)
                          : rigaAnnullata(voce.id),
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ValutazioniGenitorePage() {
  const t = useTranslations('parentPrimaria');
  return (
    <Suspense fallback={<div className="px-4 pt-5 pb-24 font-maven text-kidville-muted">{t('caricamento')}</div>}>
      <ValutazioniGenitore />
    </Suspense>
  );
}
