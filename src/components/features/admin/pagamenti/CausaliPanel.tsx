'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Pencil, Receipt, Save, Star } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import {
  CHIAVE_CAUSALE_DEFAULT,
  DEFAULT_CAUSALE_TEMPLATE,
  PLACEHOLDER_CAUSALE,
  renderCausale,
  type DatiCausale,
  type SegnapostoCausale,
} from '@/lib/pagamenti/causale';
import {
  CHIAVE_CONFIG_CAUSALI_FATTURA,
  DEFAULT_CAUSALE_FATTURA_TEMPLATE,
  VINCOLO_CAUSALE_FATTURAPA,
} from '@/lib/pagamenti/causale-fattura';
import { hdr, card, h3, input, label, hint } from '../settings/ui';
import { BTN_PRIMARY_AA } from './ui';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';

interface Props {
  userId: string;
  scuolaId: string;
}

interface CategoriaRaw {
  nome: string;
  slug?: string | null;
  icona?: string | null;
}
interface Categoria {
  slug: string;
  nome: string;
  icona: string;
}

/** Chiave della riga «Predefinito» nel JSONB flat dei modelli (le altre sono slug). */
const CHIAVE_DEFAULT = CHIAVE_CAUSALE_DEFAULT;

/**
 * Dati d'esempio dell'anteprima. CF SINTETICO (mai un CF reale di un minore):
 * coincide con l'esempio di `PLACEHOLDER_CAUSALE`.
 *
 * «Sintetico» qui ha il metro scritto in fondo a `@/lib/fiscale/codice-fiscale`, e non
 * è una formalità: fino al 2026-08-10 l'esempio era `RSSMRA85T10A562S`, che ha il
 * CARATTERE DI CONTROLLO VALIDO e un codice catastale reale (A562 = Ferrara) — cioè un
 * codice pienamente assegnabile a una persona esistente, reso a schermo due volte per
 * pagina dentro un repository PUBBLICO. Ora il codice catastale è `Z999` (non assegnato)
 * e il carattere di controllo è `X` dove la checksum vorrebbe `S`: il codice resta
 * leggibile dal parser (data e sesso), ma non può appartenere a nessuno. È la stessa
 * convenzione dei test (`__tests__/lib/pagamenti-causale-fattura.test.ts`).
 *
 * La sede è un SEGNAPOSTO, non un plesso: qui c'era «Kidville Giugliano», e dal
 * 2026-07-29 le sedi sono tre. Un admin di Aversa che configura le causali del suo
 * plesso non deve vedere l'anteprima finire con «GIUGLIANO» — a runtime `{sede}`
 * viene dal dato (`sedeCausale`, causale.ts), qui basta che si veda DOVE finisce.
 * `sedeCausale('Kidville <Sede>')` → «<SEDE>».
 *
 * Il CF sintetico è al MASCHILE (giorno 10, non maggiorato di 40): è da lì che
 * `{minore}` ricava «del minore» nell'anteprima.
 */
const DATI_ESEMPIO: DatiCausale = {
  descrizione: 'Retta Settembre 2026',
  nome: 'Mario',
  cognome: 'Rossi',
  codiceFiscale: 'RSSMRA85T10Z999X',
  sede: 'Kidville <Sede>',
  mese: 'settembre',
  anno: '2026',
  importo: '€ 150,00',
  scadenza: '30/09/2026',
};

/** I testi che cambiano da un editor all'altro. Il resto della cornice è condiviso. */
interface TestiEditorCausali {
  /** Titolo della sezione. */
  titolo: string;
  /** Frase d'aiuto, prima del nome della riga «Predefinito». */
  aiutoPre: string;
  /** Nota in fondo alla sezione. */
  nota: string;
}

/**
 * Il vincolo di lunghezza del tracciato di destinazione: **la misura e il limite
 * insieme**, mai il solo numero.
 *
 * `perTracciato` riduce la causale a com'è scritta davvero sul documento e restituisce
 * quella stringa: è su di essa che si contano i caratteri e si disegna l'anteprima.
 * Fino al 2026-08-10 questo componente riceveva il solo `limiteCaratteri` e contava
 * `anteprima.length` — la stringa PRIMA della normalizzazione FatturaPA — dichiarando
 * «200/200» su causali che nel documento ne occupavano 202 ed uscivano tagliate.
 */
interface VincoloTracciato {
  limiteCaratteri: number;
  perTracciato: (testo: string) => string;
}

interface PropsEditorCausali extends Props {
  /** Colonna JSONB di `admin_settings` che tiene i modelli (es. `causali_config`). */
  chiaveConfig: string;
  /** Modello di fabbrica: precompila il «Predefinito» e fa da ripiego alle categorie. */
  modelloPredefinito: string;
  /** Catalogo dei segnaposto proposti come chip. */
  segnaposto: SegnapostoCausale[];
  testi: TestiEditorCausali;
  /**
   * Vincolo del tracciato di destinazione. Assente = nessun limite: la causale di un
   * bonifico non ne ha uno che valga la pena mostrare, quella di una fattura sì.
   */
  tracciato?: VincoloTracciato;
  /** Icona del titolo. */
  Icona: typeof Pencil;
}

/**
 * L'EDITOR dei modelli di causale: una riga per ogni `payment_categories` più un
 * «Predefinito» (chiave `default`), anteprima dal vivo con dati sintetici, chip che
 * inseriscono i segnaposto nel campo attivo.
 *
 * È scritto una volta e istanziato due (bonifico e fattura) perché la configurazione
 * è la stessa cosa scritta su due colonne: un JSONB FLAT per-scuola
 * (`{ default?, <slug>: }`) salvato in shallow-merge lato server, così ogni riga è
 * indipendente. La sola differenza è dove si salva, quale sia il modello di fabbrica
 * e se ci sia un limite di lunghezza da segnalare.
 */
function EditorCausali({
  userId,
  scuolaId,
  chiaveConfig,
  modelloPredefinito,
  segnaposto,
  testi,
  tracciato,
  Icona,
}: PropsEditorCausali) {
  const t = useTranslations('adminContabilita');
  const [categorie, setCategorie] = useState<Categoria[]>([]);
  const [modelli, setModelli] = useState<Record<string, string>>({});
  const [caricato, setCaricato] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Il caricamento è andato storto: la schermata mostra i valori DI FABBRICA e non
  // quelli in archivio. Va detto e va impedito il salvataggio — vedi il commento
  // esteso sull'effetto qui sotto.
  const [caricamentoFallito, setCaricamentoFallito] = useState(false);
  // Chiavi rimaste nel JSONB che non corrispondono più a nessuna categoria.
  const [chiaviObsolete, setChiaviObsolete] = useState<string[]>([]);

  /**
   * L'etichetta di un chip, tradotta. Il catalogo `PLACEHOLDER_CAUSALE` vive in
   * `src/lib` con le etichette in italiano cablate: `label` resta il ripiego (un
   * segnaposto nuovo si vede lo stesso, in italiano, invece di sparire) ma la
   * schermata legge `caus_ph_<chiave>` dai cataloghi, come tutto il resto del pannello.
   */
  const etichettaSegnaposto = (p: SegnapostoCausale): string => {
    const chiave = `caus_ph_${p.chiave}`;
    return t.has(chiave) ? t(chiave) : p.label;
  };

  // Prefisso degli `id`: due editor vivono sulla STESSA pagina, e con gli id cablati
  // («causale-default») il secondo avrebbe duplicato quelli del primo — un `<label>`
  // punta al primo elemento con quell'id, quindi metà dei campi del secondo pannello
  // sarebbero stati inetichettabili da tastiera e da screen reader.
  const uid = useId();
  const idCampo = (chiave: string) => `${uid}-${chiave}`;
  const idTitolo = `${uid}-titolo`;

  // Campo attivo (per l'inserimento dei chip) + riferimenti agli input, così il
  // segnaposto entra al cursore del campo che l'utente sta modificando.
  const campoAttivo = useRef<string>(CHIAVE_DEFAULT);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    let active = true;
    const onErr = (op: string) => (err: unknown): null => {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `${op}: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      return null;
    };
    Promise.all([
      fetch(`/api/admin/settings/categorie?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
        .then((r) => r.json()).catch(onErr('causali-categorie-caricamento-fallito')),
      fetch(`/api/admin/settings?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
        .then((r) => r.json()).catch(onErr(`causali-impostazioni-caricamento-fallito (${chiaveConfig})`)),
    ]).then(([catRes, cfgRes]) => {
      if (!active) return;
      // Le due risposte si guardano SEPARATAMENTE, e il loro esito arriva a schermo.
      // Fino al 2026-08-10 una fetch fallita veniva solo loggata: il pannello si apriva
      // lo stesso sul modello di fabbrica, identico a una scuola che non ha mai
      // configurato niente. Chi salvava in quel momento credeva di partire dal salvato
      // e partiva dal vuoto. Lo shallow-merge lato server limitava il danno, ma la
      // schermata mentiva — ed è la famiglia di difetti che questo repo paga più cara.
      const categorieOk = catRes?.success === true;
      const configOk = cfgRes?.success === true;
      const raw: CategoriaRaw[] = categorieOk ? (catRes.data ?? []) : [];
      // Colonna assente (DB E2E della CI non migrato) → `undefined` → `{}`: l'editor
      // apre sul modello di fabbrica invece di rompersi. È un caso DIVERSO dalla fetch
      // fallita: la risposta è arrivata e dice «non c'è niente», e va creduta.
      const cfg = (configOk ? (cfgRes.data?.[chiaveConfig] as Record<string, string> | undefined) : undefined) ?? {};
      // Dedup per slug (globali + scuola possono ripetersi): l'ultima vince.
      const perSlug = new Map<string, Categoria>();
      for (const c of raw) {
        if (!c.slug) continue;
        perSlug.set(String(c.slug), { slug: String(c.slug), nome: c.nome, icona: c.icona ?? '💶' });
      }
      const cats = [...perSlug.values()];
      setCategorie(cats);
      const iniz: Record<string, string> = {
        [CHIAVE_DEFAULT]: cfg[CHIAVE_DEFAULT] ?? modelloPredefinito,
      };
      for (const c of cats) iniz[c.slug] = cfg[c.slug] ?? '';
      setModelli(iniz);
      // Modelli orfani: la `payment_categories` non esiste più, ma la sua chiave è
      // rimasta nel JSONB e nessuno la vede più a schermo. Se un giorno quello slug
      // venisse riusato, tornerebbe in vita un modello che nessuno ha scritto per la
      // categoria nuova — su una fattura elettronica. Il salvataggio le azzera.
      //
      // ⚠️ Solo se l'elenco delle categorie è ARRIVATO: con la fetch fallita (`raw`
      // vuoto) ogni slug sembrerebbe orfano e il primo «Salva» cancellerebbe l'intera
      // configurazione della scuola.
      const obsolete = categorieOk
        ? Object.keys(cfg).filter((k) => k !== CHIAVE_DEFAULT && !perSlug.has(k))
        : [];
      setChiaviObsolete(obsolete);
      if (obsolete.length > 0) {
        // `warn` e non `error`: non è un guasto, è una configurazione che si porta
        // dietro modelli di categorie cancellate. (`logClient` non ha il livello
        // `info`: la sua politica ammette solo `warn` ed `error`.)
        logClient({
          livello: 'warn',
          evento: 'js',
          messaggio: `causali-modelli-orfani (${chiaveConfig}): ${obsolete.length} chiavi senza categoria, verranno azzerate al salvataggio`,
          route: '/admin/pagamenti',
        });
      }
      if (!categorieOk || !configOk) {
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `causali-caricamento-incompleto (${chiaveConfig}): categorie=${categorieOk} impostazioni=${configOk}`,
          route: '/admin/pagamenti',
          stato: 0,
        });
      }
      setCaricamentoFallito(!categorieOk || !configOk);
      setCaricato(true);
    });
    return () => { active = false; };
  }, [userId, scuolaId, chiaveConfig, modelloPredefinito]);

  const setModello = useCallback((chiave: string, valore: string) => {
    setMsg('');
    setModelli((prev) => ({ ...prev, [chiave]: valore }));
  }, []);

  // Inserisce `{chiave}` nel campo attivo, al cursore (o in coda se il cursore
  // non è determinabile). Ripristina il focus e la posizione del cursore.
  const inserisciSegnaposto = useCallback((chiave: string) => {
    const key = campoAttivo.current || CHIAVE_DEFAULT;
    const token = `{${chiave}}`;
    const el = inputRefs.current[key];
    setMsg('');
    setModelli((prev) => {
      const attuale = prev[key] ?? '';
      if (el && el.selectionStart != null) {
        const start = el.selectionStart;
        const end = el.selectionEnd ?? start;
        const nuovo = attuale.slice(0, start) + token + attuale.slice(end);
        requestAnimationFrame(() => {
          try {
            el.focus();
            const pos = start + token.length;
            el.setSelectionRange(pos, pos);
          } catch {
            // jsdom/WebView senza selection API: il valore è già aggiornato.
            logClient({ livello: 'warn', evento: 'js', messaggio: 'setSelectionRange non disponibile (causali)', route: '/admin/pagamenti' });
          }
        });
        return { ...prev, [key]: nuovo };
      }
      return { ...prev, [key]: attuale + token };
    });
  }, []);

  const salva = useCallback(async () => {
    setSaving(true);
    setMsg('');
    setError(null);
    // Invia TUTTE le righe (anche vuote, come ''): il server tiene solo le stringhe
    // non vuote e RIMUOVE le chiavi svuotate → una riga cancellata torna DAVVERO al
    // Predefinito (lo shallow-merge da solo non potrebbe rimuovere una chiave).
    const config: Record<string, string> = {};
    for (const [chiave, modello] of Object.entries(modelli)) {
      config[chiave] = (modello ?? '').trim();
    }
    // …e azzera le chiavi orfane (categoria cancellata): sono modelli che nessuno vede
    // più a schermo e che il server continuerebbe a servire all'emissione se lo slug
    // tornasse. La lista è vuota se l'elenco delle categorie non è arrivato.
    for (const chiave of chiaviObsolete) config[chiave] = '';
    try {
      const res = await fetch(`/api/admin/settings?userId=${userId}`, {
        method: 'PATCH',
        headers: hdr(userId),
        body: JSON.stringify({ scuola_id: scuolaId, [chiaveConfig]: config }),
      });
      const j = await res.json();
      if (j.success) setMsg(t('caus_msg_salvati'));
      else setError(messaggioDaCorpo(j, t('caus_err_salvataggio')));
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `causali-impostazioni-salvataggio-fallito (${chiaveConfig}): ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError(t('caus_err_rete'));
    } finally {
      setSaving(false);
    }
  }, [modelli, chiaviObsolete, userId, scuolaId, chiaveConfig, t]);

  if (!caricato) {
    return <p className="py-8 text-center font-maven text-sm text-kidville-muted">{t('caus_caricamento')}</p>;
  }

  const righe: { chiave: string; etichetta: string; badge: React.ReactNode }[] = [
    { chiave: CHIAVE_DEFAULT, etichetta: t('caus_predefinito'), badge: <Star size={14} className="text-kidville-green" aria-hidden /> },
    ...categorie.map((c) => ({ chiave: c.slug, etichetta: c.nome, badge: <span aria-hidden>{c.icona}</span> })),
  ];
  const placeholderDefault = (modelli[CHIAVE_DEFAULT] ?? '').trim() || modelloPredefinito;

  return (
    <section className={card} aria-labelledby={idTitolo}>
      <h3 id={idTitolo} className={h3}><Icona size={16} /> {testi.titolo}</h3>
      <p className="font-maven text-[13px] text-kidville-sub mb-4">
        {testi.aiutoPre}<strong>{t('caus_predefinito')}</strong>{t('caus_help_post')}
      </p>

      {/* Chip dei segnaposto: inseriscono {chiave} nel campo attivo. */}
      <div className="flex flex-wrap gap-2 mb-5" role="group" aria-label={t('caus_aria_segnaposto')}>
        {segnaposto.map((p) => (
          <button
            key={p.chiave}
            type="button"
            onClick={() => inserisciSegnaposto(p.chiave)}
            title={`${etichettaSegnaposto(p)} · ${t('caus_es')} ${p.esempio}`}
            className="inline-flex items-center gap-1.5 rounded-pill bg-kidville-cream px-3 py-1.5 font-maven text-xs text-kidville-green ring-[1.5px] ring-inset ring-kidville-green/20 transition-colors hover:ring-kidville-green outline-none focus-visible:ring-2 focus-visible:ring-kidville-green"
          >
            <code className="font-semibold">{`{${p.chiave}}`}</code>
            <span className="text-kidville-sub">{etichettaSegnaposto(p)}</span>
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {righe.map(({ chiave, etichetta, badge }) => {
          const id = idCampo(chiave);
          // Riga vuota → anteprima col modello che il server userà DAVVERO: per una
          // categoria è il «Predefinito» VIVO (non l'hardcoded), così anteprima = runtime.
          const fallback = chiave === CHIAVE_DEFAULT ? modelloPredefinito : placeholderDefault;
          const resa = renderCausale((modelli[chiave] || '').trim() || fallback, DATI_ESEMPIO);
          // L'ANTEPRIMA È LA STRINGA DEL TRACCIATO, non quella resa.
          //
          // Il limite si misura sulla causale RESA e non sul modello — «{descrizione}»
          // sono 13 caratteri sullo schermo e possono diventarne ottanta a runtime — ma
          // nemmeno la resa basta: il generatore XML scrive `testoLatin(causale, 200)`,
          // che prima TRANSLITTERA e poi tronca. `€` diventa `EUR`, `…` diventa `...`,
          // `™` diventa `(TM)`: una causale di 200 caratteri che contiene il chip
          // `{importo}` (esempio: «€ 150,00») nel documento ne occupa 202 e finisce
          // tagliata a `EUR 150,`. Contando qui la stringa pre-normalizzazione il
          // pannello scriveva «200/200» in nero, senza avviso, e nemmeno il log
          // `causale-troncata` scattava, perché misurava lo stesso sbaglio.
          //
          // Quindi l'anteprima MOSTRA ciò che il tracciato scriverà (`perTracciato`) e
          // il conteggio è la lunghezza di quel che si vede: una misura sola, in un
          // posto solo (`causalePerTracciato`, in `@/lib/aruba/fatturapa-xml`).
          const anteprima = tracciato ? tracciato.perTracciato(resa) : resa;
          const oltreIlLimite = tracciato != null && anteprima.length > tracciato.limiteCaratteri;
          const idConteggio = `${id}-conteggio`;
          const idAvviso = `${id}-avviso`;
          return (
            <div key={chiave} className="rounded-xl border-2 border-kidville-line p-3">
              <label htmlFor={id} className={`${label} flex items-center gap-1.5`}>
                {badge} {etichetta}
              </label>
              <input
                id={id}
                ref={(el) => { inputRefs.current[chiave] = el; }}
                value={modelli[chiave] ?? ''}
                onChange={(e) => setModello(chiave, e.target.value)}
                onFocus={() => { campoAttivo.current = chiave; }}
                placeholder={chiave === CHIAVE_DEFAULT ? modelloPredefinito : placeholderDefault}
                // Il conteggio e l'avviso sono LEGATI al campo: senza `aria-describedby`
                // chi naviga da tastiera con uno screen reader sente l'etichetta e
                // basta, e la misura che è il senso di tutto il pannello resta
                // invisibile proprio a chi non può vederla.
                aria-describedby={tracciato ? `${idConteggio} ${idAvviso}` : undefined}
                className={`${input} w-full`}
              />
              <p className="mt-1.5 flex flex-wrap items-baseline gap-1.5">
                <span className="font-barlow text-[10px] font-extrabold uppercase tracking-wide text-kidville-sub">{t('caus_anteprima')}</span>
                <span className="rounded bg-kidville-cream px-2 py-0.5 font-maven text-[12.5px] text-kidville-ink">
                  {anteprima || '—'}
                </span>
              </p>
              {tracciato != null && (
                // Il conteggio è SEMPRE a schermo, non solo quando si sfora: è una misura
                // sui DATI D'ESEMPIO, e chi scrive il modello deve poter vedere quanto
                // margine gli resta prima che una descrizione vera — più lunga di «Retta
                // Settembre 2026» — se lo mangi. Fuori dal live region: il numero cambia a
                // ogni battuta e annunciarlo ogni volta coprirebbe ciò che si sta digitando.
                <p id={idConteggio} className="mt-1.5 flex flex-wrap items-baseline gap-1.5 font-maven text-[11.5px] text-kidville-sub">
                  <span className={`font-semibold whitespace-nowrap ${oltreIlLimite ? 'text-kidville-error' : ''}`}>
                    {anteprima.length}/{tracciato.limiteCaratteri}
                  </span>
                  <span>{t('caus_conteggio_esempio')}</span>
                </p>
              )}
              {tracciato != null && (
                // Il live region è SEMPRE nel DOM e si riempie: montarlo insieme al suo
                // testo — com'era fino al 2026-08-10 — è il modo classico di non farlo
                // annunciare (NVDA e JAWS osservano le mutazioni DEI live region già
                // presenti; uno inserito col contenuto dentro spesso passa muto). Qui
                // cambia solo il testo, e il `className` vuoto tiene il paragrafo a
                // ingombro zero quando non c'è niente da dire.
                //
                // `role="status"` (gentile) e non `alert`: l'avviso compare e sparisce a
                // ogni tasto premuto mentre si scrive il modello, e un annuncio assertivo
                // a ogni battuta coprirebbe ciò che l'utente sta digitando. Il testo è
                // FISSO (il numero sta nel conteggio qui sopra), così il live region
                // annuncia una volta sola invece che a ogni carattere.
                <p
                  id={idAvviso}
                  role="status"
                  className={oltreIlLimite ? 'mt-1.5 flex items-start gap-1.5 font-maven text-[12px] text-kidville-error' : ''}
                >
                  {oltreIlLimite && (
                    <>
                      <AlertTriangle size={13} className="mt-[3px] shrink-0" aria-hidden />
                      <span>{t('caus_avviso_limite')}</span>
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {caricamentoFallito && (
        // Il caricamento è fallito: a schermo ci sono i valori di fabbrica, non quelli
        // in archivio. Salvare da qui sovrascriverebbe una configurazione che l'utente
        // non ha mai visto, quindi il pulsante è disabilitato e il motivo è scritto.
        <p role="alert" className="mt-5 flex items-start gap-1.5 font-maven text-[12.5px] text-kidville-error">
          <AlertTriangle size={14} className="mt-[3px] shrink-0" aria-hidden />
          <span>{t('caus_err_caricamento')}</span>
        </p>
      )}
      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={salva} disabled={saving || caricamentoFallito} className={BTN_PRIMARY_AA}>
          <Save size={14} /> {saving ? t('caus_salvataggio') : t('caus_salva')}
        </button>
        {msg && <span role="status" className="font-maven text-sm text-kidville-success">{msg}</span>}
        {error && <span role="alert" className="font-maven text-sm text-kidville-error">{error}</span>}
      </div>
      <p className={hint}>{testi.nota}</p>
    </section>
  );
}

/**
 * Causali del BONIFICO: la stringa che il genitore ricopia e su cui si regge
 * l'abbinamento automatico degli incassi (riconciliazione).
 */
export function CausaliPanel({ userId, scuolaId }: Props) {
  const t = useTranslations('adminContabilita');
  return (
    <EditorCausali
      userId={userId}
      scuolaId={scuolaId}
      chiaveConfig="causali_config"
      modelloPredefinito={DEFAULT_CAUSALE_TEMPLATE}
      segnaposto={PLACEHOLDER_CAUSALE}
      Icona={Pencil}
      testi={{ titolo: t('caus_titolo'), aiutoPre: t('caus_help_pre'), nota: t('caus_hint') }}
    />
  );
}

/**
 * Causali della FATTURA elettronica, una per tipologia di pagamento.
 *
 * Sostituisce `admin_settings.fattura_causale_template`: un campo unico per tutta la
 * scuola, che l'interfaccia mostrava e l'emissione **scartava**. Qui il modello è per
 * categoria ed è quello che viene davvero emesso.
 *
 * Il difetto è chiuso perché il vecchio campo NON esiste più a schermo: toglierlo dal
 * `SettingsPanel` e da `ALLOWED_FIELDS` è parte dello stesso lavoro. Finché fosse
 * restato lì — modificabile, salvato, ignorato — questo pannello non avrebbe chiuso
 * niente: avrebbe aggiunto una seconda verità accanto alla prima.
 *
 * ⚠️ Sul limite di 200 caratteri, per non promettere più di quanto si misuri: il
 * conteggio dell'anteprima è calcolato sui DATI D'ESEMPIO. Una descrizione più lunga di
 * «Retta Settembre 2026» (20 caratteri) o il suffisso « - quota <genitore>» che
 * `@/lib/aruba/emissione` aggiunge alle quote dei genitori separati possono far sforare
 * un modello che qui appare sotto il limite. In quel caso il documento nasce con una
 * causale mozzata e l'emissione lo scrive nei log (`causale-troncata`).
 *
 * Su COME si conta, invece, il pannello e l'emissione ora usano la stessa misura, e
 * fino al 2026-08-10 non era vero: si contava la stringa PRIMA della normalizzazione
 * FatturaPA, mentre `<Causale>` riceve `testoLatin(causale, 200)` che translittera
 * (`€`→`EUR`) e poi tronca. Un modello con `{importo}` dichiarato «200/200» in nero
 * usciva tagliato a `EUR 150,` — e nemmeno il log scattava, perché anche quel gate
 * misurava la stringa sbagliata. Ora entrambi passano da `causalePerTracciato`
 * (`@/lib/aruba/fatturapa-xml`), che è la sola misura, in un posto solo:
 * `VINCOLO_CAUSALE_FATTURAPA` porta il limite e la misura insieme, così non si può
 * più prendere il numero senza la funzione che lo rende vero.
 */
export function CausaliFatturaPanel({ userId, scuolaId }: Props) {
  const t = useTranslations('adminContabilita');
  return (
    <EditorCausali
      userId={userId}
      scuolaId={scuolaId}
      chiaveConfig={CHIAVE_CONFIG_CAUSALI_FATTURA}
      modelloPredefinito={DEFAULT_CAUSALE_FATTURA_TEMPLATE}
      segnaposto={PLACEHOLDER_CAUSALE}
      tracciato={VINCOLO_CAUSALE_FATTURAPA}
      Icona={Receipt}
      testi={{ titolo: t('causf_titolo'), aiutoPre: t('causf_help_pre'), nota: t('causf_hint') }}
    />
  );
}
