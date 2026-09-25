'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Trash2, Lock } from 'lucide-react';
import { dataCivile } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';
import { Btn } from '@/components/ui/Btn';
import { Modal } from '@/components/ui/Modal';
import { logClient } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { MOTIVO_MAX_CARATTERI } from '@/lib/presenze/limiti-testo';
import { BottoneSblocca } from '@/components/features/primaria/BottoneSblocca';

/**
 * «Valutazioni recenti» della primaria: valutazioni e impreparati INSIEME, con
 * «Modifica», «Elimina» e — oltre il termine — «Sblocca» (spec 2026-09-24,
 * compito V3).
 *
 * Il server decide tutto (permesso, termine, sblocchi): le due GET dicono per
 * ogni voce `modificabile` e `bloccata`, PATCH e DELETE rifiutano con un codice.
 * Qui si decide solo che cosa mostrare e che cosa mandare:
 *
 *  · VALUTAZIONE → la modale ha gli stessi campi della creazione; `tipoProva`
 *    parte SOLO se cambia (assente = il server lascia tipo e termine com'erano);
 *  · IMPREPARATO → tipo, motivo, materia e data; partono solo i campi cambiati.
 *    Quello dichiarato dal genitore resta sempre «giustificato»: il tipo non si
 *    offre nemmeno (il server risponderebbe 400);
 *  · BLOCCATA → niente Modifica/Elimina, il messaggio «Bloccata: superato il
 *    termine» e, per la sola Direzione, «Sblocca» (`BottoneSblocca`, modo voce).
 */

export type TipoImpreparato = 'impreparato' | 'giustificato';
export const TIPI_IMPREPARATO: readonly TipoImpreparato[] = ['impreparato', 'giustificato'];

export interface ObiettivoSelezionabile {
  id: string;
  codice: string | null;
  descrizione: string;
}

export interface MateriaSelezionabile {
  id: string;
  nome: string;
}

type Embed<T> = T | T[] | null | undefined;

/** Una valutazione come la restituisce `GET /api/primaria/valutazioni`. */
export interface ValutazioneRecente {
  id: string;
  maestra_id?: string | null;
  tipo: string | null;
  modalita: string;
  argomento: string | null;
  dim_autonomia?: boolean | null;
  dim_continuita?: boolean | null;
  dim_tipologia?: string | null;
  dim_risorse?: string | null;
  giudizio_sintetico: string | null;
  giudizio_testo: string | null;
  annotazione_numerica: number | null;
  creato_il: string;
  valutazione_obiettivi?: { obiettivo_id: string; obiettivi_apprendimento?: Embed<ObiettivoSelezionabile> }[] | null;
  /** Autorizzato E (entro il termine O sbloccato). Assente = no (fail-closed). */
  modificabile?: boolean;
  /** Oltre il termine e senza sblocco. */
  bloccata?: boolean;
  giorniLimite?: number | null;
}

/** Un impreparato come lo restituisce `GET /api/primaria/giustifiche-didattiche` (forma per alunno). */
export interface ImpreparatoRecente {
  id: string;
  alunno_id?: string;
  materia_id: string | null;
  data: string;
  motivo: string | null;
  origine: string;
  tipo?: string | null;
  creato_il?: string | null;
  modificabile?: boolean;
  bloccata?: boolean;
  giorniLimite?: number | null;
}

export type VoceRecente =
  | { genere: 'valutazione'; giorno: string; istante: number; voce: ValutazioneRecente }
  | { genere: 'impreparato'; giorno: string; istante: number; voce: ImpreparatoRecente };

/** Il tipo di un impreparato letto: se la colonna manca (DB non migrato) vale l'origine. */
export function tipoImpreparato(g: Pick<ImpreparatoRecente, 'tipo' | 'origine'>): TipoImpreparato {
  if (g.tipo === 'impreparato' || g.tipo === 'giustificato') return g.tipo;
  return g.origine === 'genitore' ? 'giustificato' : 'impreparato';
}

function istanteDi(s: string | null | undefined): number {
  const n = s ? Date.parse(s) : Number.NaN;
  return Number.isNaN(n) ? 0 : n;
}

/** La data di ROMA di un istante; stringa vuota se illeggibile (`Intl` lancerebbe su una data non valida). */
function giornoDiRoma(s: string | null | undefined): string {
  const n = s ? Date.parse(s) : Number.NaN;
  return Number.isNaN(n) ? '' : dataCivile(new Date(n));
}

/**
 * Valutazioni e impreparati in UN elenco, dal più recente. Il giorno di una
 * valutazione è la data di Roma di `creato_il` (la stessa del termine), quello di
 * un impreparato la sua `data`; a parità di giorno decide l'istante di creazione.
 */
export function unisciVociRecenti(
  valutazioni: readonly ValutazioneRecente[],
  impreparati: readonly ImpreparatoRecente[],
): VoceRecente[] {
  const voci: VoceRecente[] = [
    ...valutazioni.map((v) => ({
      genere: 'valutazione' as const,
      giorno: giornoDiRoma(v.creato_il),
      istante: istanteDi(v.creato_il),
      voce: v,
    })),
    ...impreparati.map((g) => ({
      genere: 'impreparato' as const,
      giorno: String(g.data ?? '').slice(0, 10),
      istante: istanteDi(g.creato_il),
      voce: g,
    })),
  ];
  return voci.sort((a, b) => b.giorno.localeCompare(a.giorno) || b.istante - a.istante);
}

// ─── Modifica della valutazione: bozza e corpo della PATCH ───────────────────

export interface BozzaValutazione {
  tipoProva: string;
  modalita: 'dimensioni' | 'sintetico';
  autonomia: boolean;
  continuita: boolean;
  tipologia: 'nota' | 'non_nota';
  risorse: 'interne' | 'esterne' | 'entrambe';
  giudizioSintetico: string;
  giudizioTesto: string;
  annotazioneNumerica: string;
  argomento: string;
  obiettiviIds: string[];
}

export function obiettiviCollegati(v: Pick<ValutazioneRecente, 'valutazione_obiettivi'>): string[] {
  return (v.valutazione_obiettivi ?? []).map((o) => o.obiettivo_id).filter(Boolean);
}

/** La bozza di partenza: i valori della voce, e per ciò che manca i predefiniti della creazione. */
export function bozzaDaValutazione(v: ValutazioneRecente, scala: readonly string[]): BozzaValutazione {
  const tipologia = v.dim_tipologia === 'non_nota' ? 'non_nota' : 'nota';
  const risorse = v.dim_risorse === 'esterne' || v.dim_risorse === 'entrambe' ? v.dim_risorse : 'interne';
  return {
    tipoProva: v.tipo ?? 'orale',
    modalita: v.modalita === 'sintetico' ? 'sintetico' : 'dimensioni',
    autonomia: v.dim_autonomia ?? true,
    continuita: v.dim_continuita ?? true,
    tipologia,
    risorse,
    giudizioSintetico: v.giudizio_sintetico ?? scala[0] ?? '',
    giudizioTesto: v.giudizio_testo ?? '',
    annotazioneNumerica:
      v.annotazione_numerica === null || v.annotazione_numerica === undefined ? '' : String(v.annotazione_numerica),
    argomento: v.argomento ?? '',
    obiettiviIds: obiettiviCollegati(v),
  };
}

/**
 * Vero se la bozza «per dimensioni» non ha più le dimensioni salvate: ne è
 * cambiata almeno una, oppure la voce era sintetica e ora è per dimensioni.
 */
export function dimensioniCambiate(v: ValutazioneRecente, b: BozzaValutazione): boolean {
  if (b.modalita !== 'dimensioni') return false;
  if (v.modalita === 'sintetico') return true;
  return dimensioniDiverse(bozzaDaValutazione(v, []), b);
}

/**
 * Confronto delle quattro dimensioni fra due bozze. Si confronta SEMPRE con la
 * bozza normalizzata della voce (`bozzaDaValutazione`): i `dim_*` grezzi possono
 * essere null, e `true !== null` farebbe sembrare cambiata una voce intatta.
 */
function dimensioniDiverse(prima: BozzaValutazione, b: BozzaValutazione): boolean {
  return (
    b.autonomia !== prima.autonomia ||
    b.continuita !== prima.continuita ||
    b.tipologia !== prima.tipologia ||
    b.risorse !== prima.risorse
  );
}

/** Vero se il docente non ha toccato il testo descrittivo salvato. */
function testoIntatto(v: ValutazioneRecente, b: BozzaValutazione): boolean {
  return b.giudizioTesto.trim() === (v.giudizio_testo ?? '').trim();
}

/**
 * Applica un cambio di dimensioni o di modalità alla bozza. Il testo salvato di
 * solito il server l'ha GENERATO dalle dimensioni vecchie: se il docente non
 * l'ha toccato e le dimensioni cambiano, si svuota SUBITO nella modale (lo vede,
 * e può riscriverlo), e il server lo rigenera come nella creazione. Un testo
 * scritto dal docente resta il suo.
 */
export function conCambioDimensioni(
  v: ValutazioneRecente,
  b: BozzaValutazione,
  cambio: Partial<Pick<BozzaValutazione, 'modalita' | 'autonomia' | 'continuita' | 'tipologia' | 'risorse'>>,
): BozzaValutazione {
  const nuova: BozzaValutazione = { ...b, ...cambio };
  if (testoIntatto(v, b) && dimensioniCambiate(v, nuova)) nuova.giudizioTesto = '';
  return nuova;
}

/**
 * Il corpo della PATCH. Gli stessi campi della POST; `tipoProva` SOLO se cambia:
 * assente, il server lascia tipo e termine com'erano (una modifica che non tocca
 * il tipo non deve ricalcolare il termine di una voce storica).
 */
export function corpoModificaValutazione(v: ValutazioneRecente, b: BozzaValutazione): Record<string, unknown> {
  const ann = b.annotazioneNumerica.trim();
  const corpo: Record<string, unknown> = {
    id: v.id,
    modalita: b.modalita,
    dims:
      b.modalita === 'dimensioni'
        ? { autonomia: b.autonomia, continuita: b.continuita, tipologia: b.tipologia, risorse: b.risorse }
        : undefined,
    giudizioSintetico: b.modalita === 'sintetico' ? b.giudizioSintetico : null,
    // Per dimensioni: il testo del docente, oppure `null` e il server lo genera.
    // `null` anche quando le dimensioni cambiano e il testo è quello salvato
    // (generato dalle dimensioni VECCHIE): altrimenti il genitore leggerebbe un
    // giudizio che contraddice le dimensioni. In modalità sintetica il testo non
    // si mostra (come nella creazione): resta quello che c'era se la voce era già
    // sintetica, e cade se si passa da «per dimensioni».
    giudizioTesto:
      b.modalita === 'dimensioni'
        ? b.giudizioTesto.trim() && !(dimensioniCambiate(v, b) && testoIntatto(v, b))
          ? b.giudizioTesto
          : null
        : v.modalita === 'sintetico'
          ? v.giudizio_testo ?? null
          : null,
    annotazioneNumerica: ann ? ann.replace(',', '.') : null,
    argomento: b.argomento.trim(),
    obiettiviIds: b.obiettiviIds,
  };
  if (b.tipoProva !== (v.tipo ?? 'orale')) corpo.tipoProva = b.tipoProva;
  return corpo;
}

/** Vero se la bozza cambia qualcosa della voce: senza cambi la PATCH non parte. */
export function valutazioneCambiata(v: ValutazioneRecente, b: BozzaValutazione, scala: readonly string[]): boolean {
  const prima = bozzaDaValutazione(v, scala);
  const numero = (s: string) => (s.trim() === '' ? null : Number(s.trim().replace(',', '.')));
  if (b.tipoProva !== prima.tipoProva) return true;
  if (b.modalita !== prima.modalita) return true;
  if (b.argomento.trim() !== prima.argomento.trim()) return true;
  if (b.modalita === 'dimensioni' && b.giudizioTesto.trim() !== prima.giudizioTesto.trim()) return true;
  if (numero(b.annotazioneNumerica) !== numero(prima.annotazioneNumerica)) return true;
  if (b.modalita === 'sintetico' && b.giudizioSintetico !== (v.giudizio_sintetico ?? '')) return true;
  if (b.modalita === 'dimensioni' && dimensioniDiverse(prima, b)) return true;
  const a = [...new Set(b.obiettiviIds)].sort().join(',');
  const c = [...new Set(prima.obiettiviIds)].sort().join(',');
  return a !== c;
}

// ─── Modifica dell'impreparato: bozza e corpo della PATCH ────────────────────

export interface BozzaImpreparato {
  tipo: TipoImpreparato;
  motivo: string;
  /** `''` = nessuna materia. */
  materiaId: string;
  data: string;
}

export function bozzaDaImpreparato(g: ImpreparatoRecente): BozzaImpreparato {
  return {
    tipo: tipoImpreparato(g),
    motivo: g.motivo ?? '',
    materiaId: g.materia_id ?? '',
    data: String(g.data ?? '').slice(0, 10),
  };
}

/**
 * I SOLI campi che cambiano (`{}` = niente da mandare). Il tipo di un impreparato
 * del GENITORE non parte mai: resta «giustificato», e chiederne un altro è un 400.
 */
export function corpoModificaImpreparato(g: ImpreparatoRecente, b: BozzaImpreparato): Record<string, unknown> {
  const prima = bozzaDaImpreparato(g);
  const out: Record<string, unknown> = {};
  if (g.origine !== 'genitore' && b.tipo !== prima.tipo) out.tipo = b.tipo;
  if (b.motivo.trim() !== prima.motivo.trim()) out.motivo = b.motivo.trim() || null;
  if (b.materiaId !== prima.materiaId) out.materiaId = b.materiaId || null;
  if (b.data !== prima.data) out.data = b.data;
  return out;
}

// ─── Invio e lettura dell'esito ──────────────────────────────────────────────

type Operazione = 'modifica' | 'elimina';

function paginaCorrente(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

/**
 * Manda la richiesta e ne legge l'esito. `ricarica` = rifiuto motivato (voce
 * sparita, non autore, termine scaduto nel frattempo): lo stato a schermo era
 * vecchio e l'elenco va riletto. Il corpo non entra nei log: può contenere il
 * motivo, testo libero su un minore.
 */
async function invia(
  url: string,
  init: RequestInit,
  etichettaLog: string,
  fallback: string,
  fallbackRete: string,
): Promise<{ ok: true } | { ok: false; messaggio: string; ricarica: boolean }> {
  try {
    const res = await fetch(url, init);
    let corpo: unknown = null;
    try {
      corpo = await res.json();
    } catch (errJson) {
      logClient({
        livello: 'warn',
        evento: 'fetch',
        messaggio: `${etichettaLog}-risposta-non-json: ${errJson instanceof Error ? errJson.name : 'errore'}`,
        route: paginaCorrente(),
        stato: res.status,
      });
    }
    if (!res.ok) {
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `${etichettaLog}-rifiutata`,
        route: paginaCorrente(),
        stato: res.status,
      });
      return {
        ok: false,
        messaggio: messaggioDaCorpo(corpo, fallback),
        ricarica: res.status === 403 || res.status === 404 || res.status === 423,
      };
    }
    return { ok: true };
  } catch (err) {
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `${etichettaLog}-non-inviata: ${err instanceof Error ? err.name : 'errore'}`,
      route: paginaCorrente(),
    });
    return { ok: false, messaggio: fallbackRete, ricarica: false };
  }
}

// ─── Scelta del tipo di impreparato (creazione e modifica) ───────────────────

export function SceltaTipoImpreparato({
  valore,
  onScegli,
  etichetta,
}: {
  valore: TipoImpreparato;
  onScegli: (t: TipoImpreparato) => void;
  etichetta: string;
}) {
  const t = useTranslations('teacherPrimaria');
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={etichetta}>
      {TIPI_IMPREPARATO.map((tp) => (
        <button
          key={tp}
          type="button"
          aria-pressed={valore === tp}
          onClick={() => onScegli(tp)}
          className={`font-maven rounded-pill px-3 py-1 text-xs ${valore === tp ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-sub'}`}
        >
          {t(`valutazioniImpreparatoTipo_${tp}`)}
        </button>
      ))}
    </div>
  );
}

// ─── Le azioni di una voce ───────────────────────────────────────────────────

export interface AzioniVoceProps {
  voce: VoceRecente;
  userId: string;
  ruolo: string | null;
  /** Il server ha calcolato i permessi (`statoVociDisponibile`). Senza, niente bottoni. */
  permessiDisponibili: boolean;
  /** Scala dei giudizi sintetici e obiettivi disponibili della materia (per la modale della valutazione). */
  scala: readonly string[];
  obiettivi: readonly ObiettivoSelezionabile[];
  /** Le materie della classe (per la modale dell'impreparato). */
  materie: readonly MateriaSelezionabile[];
  /** Dopo un esito (riuscito o rifiutato): la pagina rilegge l'elenco. */
  onCambiato: () => void;
  onEsito: (testo: string, tipo: 'ok' | 'errore') => void;
  /** Si apre una modale: l'esito vecchio sopra l'elenco non riguarda più niente. */
  onApri: () => void;
  onSbloccato: () => void;
}

export function AzioniVoce({
  voce,
  userId,
  ruolo,
  permessiDisponibili,
  scala,
  obiettivi,
  materie,
  onCambiato,
  onEsito,
  onApri,
  onSbloccato,
}: AzioniVoceProps) {
  const t = useTranslations('teacherPrimaria');
  const f = useDateFormat();
  const [aperta, setAperta] = useState<Operazione | null>(null);

  // Se la voce smette di essere azionabile (bloccata, riletta senza permessi) la
  // modale si smonta; `aperta` va azzerata subito, o la riaprirebbe da sola il
  // giorno in cui la voce torna azionabile (lo stesso accorgimento di AzioniNota).
  const v = voce.voce;
  const azionabile = permessiDisponibili && !v.bloccata && !!v.modificabile;
  const [azionabilePrima, setAzionabilePrima] = useState(azionabile);
  if (azionabile !== azionabilePrima) {
    setAzionabilePrima(azionabile);
    if (!azionabile) setAperta(null);
  }

  if (!permessiDisponibili) return null;

  // I nomi accessibili dicono QUALE voce: nell'elenco ci sono più «Modifica».
  const nomi =
    voce.genere === 'valutazione'
      ? (() => {
          const p = { data: f.dataBreve(voce.voce.creato_il), argomento: voce.voce.argomento ?? '—' };
          return {
            modifica: t('valutazioniModificaValutazioneNome', p),
            elimina: t('valutazioniEliminaValutazioneNome', p),
            sblocca: t('valutazioniSbloccaValutazioneNome', p),
          };
        })()
      : (() => {
          const p = { data: f.dataBreve(voce.voce.data) };
          return {
            modifica: t('valutazioniModificaImpreparatoNome', p),
            elimina: t('valutazioniEliminaImpreparatoNome', p),
            sblocca: t('valutazioniSbloccaImpreparatoNome', p),
          };
        })();

  if (v.bloccata) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2" data-testid={`voce-bloccata-${v.id}`}>
        <p className="flex items-center gap-1 font-maven text-xs text-kidville-warn">
          <Lock size={12} aria-hidden="true" />
          {typeof v.giorniLimite === 'number'
            ? t('valutazioniVoceBloccata', { giorni: v.giorniLimite })
            : t('valutazioniVoceBloccataSenzaGiorni')}
        </p>
        <BottoneSblocca
          bersaglio={{ modo: 'voce', entitaTipo: voce.genere, entitaId: v.id }}
          userId={userId}
          ruolo={ruolo}
          onSbloccato={onSbloccato}
          descrizioneAccessibile={nomi.sblocca}
        />
      </div>
    );
  }

  if (!v.modificabile) return null;

  const apri = (op: Operazione) => {
    onApri();
    setAperta(op);
  };
  const chiudi = () => setAperta(null);

  return (
    <>
      <div className="mt-1 flex gap-2">
        <Btn variant="ghost" size="sm" aria-haspopup="dialog" aria-label={nomi.modifica} onClick={() => apri('modifica')}>
          <Pencil size={13} aria-hidden="true" /> {t('valutazioniModifica')}
        </Btn>
        <Btn variant="ghost" size="sm" aria-haspopup="dialog" aria-label={nomi.elimina} onClick={() => apri('elimina')}>
          <Trash2 size={13} aria-hidden="true" /> {t('valutazioniElimina')}
        </Btn>
      </div>
      {aperta === 'modifica' && voce.genere === 'valutazione' && (
        <ModaleModificaValutazione
          valutazione={voce.voce}
          scala={scala}
          obiettivi={obiettivi}
          userId={userId}
          onChiudi={chiudi}
          onCambiato={onCambiato}
          onEsito={onEsito}
        />
      )}
      {aperta === 'modifica' && voce.genere === 'impreparato' && (
        <ModaleModificaImpreparato
          impreparato={voce.voce}
          materie={materie}
          userId={userId}
          onChiudi={chiudi}
          onCambiato={onCambiato}
          onEsito={onEsito}
        />
      )}
      {aperta === 'elimina' && (
        <ModaleElimina voce={voce} userId={userId} onChiudi={chiudi} onCambiato={onCambiato} onEsito={onEsito} />
      )}
    </>
  );
}

interface ModaleBase {
  userId: string;
  onChiudi: () => void;
  onCambiato: () => void;
  onEsito: (testo: string, tipo: 'ok' | 'errore') => void;
}

/** L'esito di un rifiuto: motivato → sopra l'elenco e rilettura; altrimenti dentro la modale. */
function gestisciRifiuto(
  esito: { messaggio: string; ricarica: boolean },
  { onChiudi, onCambiato, onEsito }: Pick<ModaleBase, 'onChiudi' | 'onCambiato' | 'onEsito'>,
  setErrore: (s: string) => void,
) {
  if (esito.ricarica) {
    onEsito(esito.messaggio, 'errore');
    onChiudi();
    onCambiato();
    return;
  }
  setErrore(esito.messaggio);
}

function Errore({ testo }: { testo: string }) {
  if (!testo) return null;
  return (
    <p role="alert" className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
      {testo}
    </p>
  );
}

function Scelta<T extends string | boolean>({
  etichetta,
  valore,
  opzioni,
  onScegli,
}: {
  etichetta: string;
  valore: T;
  opzioni: { label: string; value: T }[];
  onScegli: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-y-1">
      <span className="font-maven text-sm text-kidville-ink">{etichetta}</span>
      <div className="flex flex-wrap justify-end gap-1" role="group" aria-label={etichetta}>
        {opzioni.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={o.value === valore}
            onClick={() => onScegli(o.value)}
            className={`font-maven rounded-pill px-2.5 py-1 text-xs ${o.value === valore ? 'bg-kidville-green text-kidville-yellow' : 'bg-white text-kidville-sub border border-kidville-line'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ModaleModificaValutazione({
  valutazione,
  scala,
  obiettivi,
  userId,
  onChiudi,
  onCambiato,
  onEsito,
}: ModaleBase & {
  valutazione: ValutazioneRecente;
  scala: readonly string[];
  obiettivi: readonly ObiettivoSelezionabile[];
}) {
  const t = useTranslations('teacherPrimaria');
  const idBase = useId();
  const [b, setB] = useState<BozzaValutazione>(() => bozzaDaValutazione(valutazione, scala));
  const [errore, setErrore] = useState('');
  const [inVolo, setInVolo] = useState(false);
  const set = <K extends keyof BozzaValutazione>(k: K, val: BozzaValutazione[K]) => setB((p) => ({ ...p, [k]: val }));

  // Gli obiettivi offerti: i disponibili della materia PIÙ quelli già collegati
  // (anche se nel frattempo disattivati: il server li accetta, e toglierli senza
  // che nessuno l'abbia chiesto cancellerebbe un collegamento storico).
  const opzioniObiettivi: ObiettivoSelezionabile[] = [...obiettivi];
  for (const o of valutazione.valutazione_obiettivi ?? []) {
    const emb = Array.isArray(o.obiettivi_apprendimento) ? o.obiettivi_apprendimento[0] : o.obiettivi_apprendimento;
    if (!opzioniObiettivi.some((x) => x.id === o.obiettivo_id)) {
      opzioniObiettivi.push({ id: o.obiettivo_id, codice: emb?.codice ?? null, descrizione: emb?.descrizione ?? '—' });
    }
  }
  // La scala della sede, più il giudizio già dato se non c'è più.
  const opzioniScala = [...scala];
  if (valutazione.giudizio_sintetico && !opzioniScala.includes(valutazione.giudizio_sintetico)) {
    opzioniScala.push(valutazione.giudizio_sintetico);
  }

  const chiudi = () => {
    if (!inVolo) onChiudi();
  };

  const salva = async () => {
    if (inVolo) return;
    setErrore('');
    if (!b.argomento.trim()) {
      setErrore(t('valutazioniInserisciArgomento'));
      return;
    }
    if (b.modalita === 'sintetico' && !b.giudizioSintetico) {
      setErrore(t('valutazioniGiudizioObbligatorio'));
      return;
    }
    if (obiettivi.length > 0 && b.obiettiviIds.length === 0) {
      setErrore(t('valutazioniCollegaObiettivo'));
      return;
    }
    if (!valutazioneCambiata(valutazione, b, scala)) {
      setErrore(t('valutazioniNessunCambio'));
      return;
    }
    setInVolo(true);
    const esito = await invia(
      `/api/primaria/valutazioni?userId=${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify(corpoModificaValutazione(valutazione, b)),
      },
      'valutazione-modifica',
      t('valutazioniErroreModifica'),
      t('valutazioniErroreRete'),
    );
    setInVolo(false);
    if (!esito.ok) {
      gestisciRifiuto(esito, { onChiudi, onCambiato, onEsito }, setErrore);
      return;
    }
    onEsito(t('valutazioniValutazioneModificata'), 'ok');
    onChiudi();
    onCambiato();
  };

  const titoloId = `${idBase}-titolo`;
  const argId = `${idBase}-argomento`;
  const annId = `${idBase}-annotazione`;
  const testoId = `${idBase}-testo`;
  const scalaId = `${idBase}-scala`;
  const siNo = [
    { label: t('comuneSi'), value: true },
    { label: t('comuneNo'), value: false },
  ];

  return (
    <Modal open onClose={chiudi} title={t('valutazioniModificaValutazioneTitolo')} labelledBy={titoloId} className="w-full max-w-md">
      <div className="max-h-[85vh] overflow-y-auto rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('valutazioniModificaValutazioneTitolo')}
        </h2>
        <Errore testo={errore} />

        {opzioniObiettivi.length > 0 && (
          <fieldset className="mt-3">
            <legend className="font-maven text-xs font-semibold text-kidville-sub">{t('valutazioniObiettiviLabel')}</legend>
            <div className="mt-1 flex flex-col gap-1.5">
              {opzioniObiettivi.map((o) => (
                <label key={o.id} className="flex items-start gap-2 font-maven text-sm text-kidville-ink">
                  <input
                    type="checkbox"
                    checked={b.obiettiviIds.includes(o.id)}
                    onChange={() =>
                      set(
                        'obiettiviIds',
                        b.obiettiviIds.includes(o.id) ? b.obiettiviIds.filter((x) => x !== o.id) : [...b.obiettiviIds, o.id],
                      )
                    }
                    className="mt-0.5 accent-kidville-green"
                  />
                  <span>
                    {o.codice ? <span className="text-kidville-sub">{o.codice} · </span> : null}
                    {o.descrizione}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <p className="mt-3 font-maven text-xs font-semibold text-kidville-sub">{t('valutazioniTipoProvaLabel')}</p>
        <div className="mt-1 flex gap-1.5" role="group" aria-label={t('valutazioniTipoProvaLabel')}>
          {['orale', 'scritto', 'pratico'].map((tp) => (
            <button
              key={tp}
              type="button"
              aria-pressed={b.tipoProva === tp}
              onClick={() => set('tipoProva', tp)}
              className={`font-maven rounded-pill px-3 py-1 text-xs ${b.tipoProva === tp ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-sub'}`}
            >
              {t(`valutazioniProva_${tp}`)}
            </button>
          ))}
        </div>

        <label htmlFor={annId} className="mt-3 flex items-center gap-1.5 font-maven text-xs font-semibold text-kidville-sub">
          <Lock size={12} aria-hidden="true" className="text-kidville-warn" /> {t('valutazioniAnnotazioneLabel')}
        </label>
        <input
          id={annId}
          type="number"
          min={0}
          max={10}
          step={0.5}
          value={b.annotazioneNumerica}
          onChange={(e) => set('annotazioneNumerica', e.target.value)}
          className="font-maven mt-1 w-24 rounded-pill border border-kidville-line px-3 py-2 text-sm"
        />

        <div className="mt-3 flex gap-1.5" role="group" aria-label={t('valutazioniModalitaLabel')}>
          {(['dimensioni', 'sintetico'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={b.modalita === m}
              onClick={() => setB((p) => conCambioDimensioni(valutazione, p, { modalita: m }))}
              className={`font-maven rounded-pill px-3 py-1.5 text-xs ${b.modalita === m ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-sub'}`}
            >
              {m === 'dimensioni' ? t('valutazioniPerDimensioni') : t('valutazioniGiudizioSintetico')}
            </button>
          ))}
        </div>

        {b.modalita === 'dimensioni' ? (
          <div className="mt-2 space-y-2 rounded-card bg-kidville-cream/40 p-3">
            <Scelta etichetta={t('valutazioniDimAutonomia')} valore={b.autonomia} opzioni={siNo} onScegli={(x) => setB((p) => conCambioDimensioni(valutazione, p, { autonomia: x }))} />
            <Scelta etichetta={t('valutazioniDimContinuita')} valore={b.continuita} opzioni={siNo} onScegli={(x) => setB((p) => conCambioDimensioni(valutazione, p, { continuita: x }))} />
            <Scelta
              etichetta={t('valutazioniDimTipologia')}
              valore={b.tipologia}
              opzioni={[
                { label: t('valutazioniTipologiaNota'), value: 'nota' as const },
                { label: t('valutazioniTipologiaNonNota'), value: 'non_nota' as const },
              ]}
              onScegli={(x) => setB((p) => conCambioDimensioni(valutazione, p, { tipologia: x }))}
            />
            <Scelta
              etichetta={t('valutazioniDimRisorse')}
              valore={b.risorse}
              opzioni={[
                { label: t('valutazioniRisorseInterne'), value: 'interne' as const },
                { label: t('valutazioniRisorseEsterne'), value: 'esterne' as const },
                { label: t('valutazioniRisorseEntrambe'), value: 'entrambe' as const },
              ]}
              onScegli={(x) => setB((p) => conCambioDimensioni(valutazione, p, { risorse: x }))}
            />
            <label htmlFor={testoId} className="block font-maven text-xs font-semibold text-kidville-sub">
              {t('valutazioniGiudizioDescrittivoLabel')}
            </label>
            <textarea
              id={testoId}
              value={b.giudizioTesto}
              onChange={(e) => set('giudizioTesto', e.target.value)}
              rows={3}
              placeholder={t('valutazioniPlaceholderDescrittivo')}
              aria-describedby={`${testoId}-hint`}
              className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm"
            />
            <p id={`${testoId}-hint`} className="font-maven text-[11px] text-kidville-sub">
              {t('valutazioniGiudizioDescrittivoHint')}
            </p>
          </div>
        ) : (
          <div className="mt-2">
            <label htmlFor={scalaId} className="block font-maven text-xs font-semibold text-kidville-sub">
              {t('valutazioniGiudizioSintetico')}
            </label>
            <select
              id={scalaId}
              value={b.giudizioSintetico}
              onChange={(e) => set('giudizioSintetico', e.target.value)}
              className="font-maven mt-1 w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
            >
              {opzioniScala.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
        )}

        <label htmlFor={argId} className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
          {t('valutazioniArgomentoLabel')}
        </label>
        <input
          id={argId}
          type="text"
          value={b.argomento}
          onChange={(e) => set('argomento', e.target.value)}
          className="font-maven mt-1 w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
        />

        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" size="sm" onClick={chiudi}>
            {t('valutazioniAnnulla')}
          </Btn>
          <Btn variant="primary" size="sm" aria-disabled={inVolo} onClick={() => void salva()}>
            {inVolo ? t('comuneSalvataggio') : t('valutazioniSalva')}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function ModaleModificaImpreparato({
  impreparato,
  materie,
  userId,
  onChiudi,
  onCambiato,
  onEsito,
}: ModaleBase & { impreparato: ImpreparatoRecente; materie: readonly MateriaSelezionabile[] }) {
  const t = useTranslations('teacherPrimaria');
  const idBase = useId();
  const [b, setB] = useState<BozzaImpreparato>(() => bozzaDaImpreparato(impreparato));
  const [errore, setErrore] = useState('');
  const [inVolo, setInVolo] = useState(false);
  const set = <K extends keyof BozzaImpreparato>(k: K, val: BozzaImpreparato[K]) => setB((p) => ({ ...p, [k]: val }));
  const delGenitore = impreparato.origine === 'genitore';

  const chiudi = () => {
    if (!inVolo) onChiudi();
  };

  const salva = async () => {
    if (inVolo) return;
    setErrore('');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.data)) {
      setErrore(t('valutazioniDataObbligatoria'));
      return;
    }
    const campi = corpoModificaImpreparato(impreparato, b);
    if (Object.keys(campi).length === 0) {
      setErrore(t('valutazioniNessunCambio'));
      return;
    }
    setInVolo(true);
    const esito = await invia(
      `/api/primaria/giustifiche-didattiche?userId=${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ id: impreparato.id, ...campi }),
      },
      'impreparato-modifica',
      t('valutazioniErroreModifica'),
      t('valutazioniErroreRete'),
    );
    setInVolo(false);
    if (!esito.ok) {
      gestisciRifiuto(esito, { onChiudi, onCambiato, onEsito }, setErrore);
      return;
    }
    onEsito(t('valutazioniImpreparatoModificato'), 'ok');
    onChiudi();
    onCambiato();
  };

  const titoloId = `${idBase}-titolo`;
  const motivoId = `${idBase}-motivo`;
  const materiaId = `${idBase}-materia`;
  const dataId = `${idBase}-data`;
  // La materia salvata, anche se non è (più) fra quelle della classe caricate.
  const materieOfferte = [...materie];
  if (impreparato.materia_id && !materieOfferte.some((m) => m.id === impreparato.materia_id)) {
    materieOfferte.push({ id: impreparato.materia_id, nome: '—' });
  }

  return (
    <Modal open onClose={chiudi} title={t('valutazioniModificaImpreparatoTitolo')} labelledBy={titoloId} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('valutazioniModificaImpreparatoTitolo')}
        </h2>
        <Errore testo={errore} />

        <p className="mt-3 font-maven text-xs font-semibold text-kidville-sub">{t('valutazioniImpreparatoTipoLabel')}</p>
        {delGenitore ? (
          <p className="mt-1 font-maven text-xs text-kidville-sub" data-testid="impreparato-tipo-genitore">
            {t('valutazioniImpreparatoTipoGenitore')}
          </p>
        ) : (
          <div className="mt-1">
            <SceltaTipoImpreparato valore={b.tipo} onScegli={(x) => set('tipo', x)} etichetta={t('valutazioniImpreparatoTipoLabel')} />
          </div>
        )}

        <label htmlFor={motivoId} className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
          {t('valutazioniImpreparatoMotivoLabel')}
        </label>
        <textarea
          id={motivoId}
          value={b.motivo}
          onChange={(e) => set('motivo', e.target.value)}
          rows={2}
          maxLength={MOTIVO_MAX_CARATTERI}
          className="font-maven mt-1 w-full rounded-card border border-kidville-line px-3 py-2 text-sm"
        />

        <label htmlFor={materiaId} className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
          {t('valutazioniImpreparatoMateriaLabel')}
        </label>
        <select
          id={materiaId}
          value={b.materiaId}
          onChange={(e) => set('materiaId', e.target.value)}
          className="font-maven mt-1 w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
        >
          <option value="">{t('valutazioniImpreparatoSenzaMateria')}</option>
          {materieOfferte.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nome}
            </option>
          ))}
        </select>

        <label htmlFor={dataId} className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
          {t('valutazioniImpreparatoDataLabel')}
        </label>
        <input
          id={dataId}
          type="date"
          value={b.data}
          onChange={(e) => set('data', e.target.value)}
          className="font-maven mt-1 rounded-pill border border-kidville-line px-3 py-2 text-sm"
        />

        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" size="sm" onClick={chiudi}>
            {t('valutazioniAnnulla')}
          </Btn>
          <Btn variant="primary" size="sm" aria-disabled={inVolo} onClick={() => void salva()}>
            {inVolo ? t('comuneSalvataggio') : t('valutazioniSalva')}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function ModaleElimina({ voce, userId, onChiudi, onCambiato, onEsito }: ModaleBase & { voce: VoceRecente }) {
  const t = useTranslations('teacherPrimaria');
  const f = useDateFormat();
  const idBase = useId();
  const [errore, setErrore] = useState('');
  const [inVolo, setInVolo] = useState(false);
  const valutazione = voce.genere === 'valutazione';
  const data = f.dataBreve(voce.genere === 'valutazione' ? voce.voce.creato_il : voce.voce.data);
  const titolo = valutazione ? t('valutazioniEliminaValutazioneTitolo') : t('valutazioniEliminaImpreparatoTitolo');

  const chiudi = () => {
    if (!inVolo) onChiudi();
  };

  const elimina = async () => {
    if (inVolo) return;
    setInVolo(true);
    setErrore('');
    const qs = new URLSearchParams({ id: voce.voce.id, userId });
    const esito = await invia(
      `/api/primaria/${valutazione ? 'valutazioni' : 'giustifiche-didattiche'}?${qs.toString()}`,
      { method: 'DELETE', headers: { 'x-user-id': userId } },
      valutazione ? 'valutazione-elimina' : 'impreparato-elimina',
      t('valutazioniErroreEliminazione'),
      t('valutazioniErroreRete'),
    );
    setInVolo(false);
    if (!esito.ok) {
      gestisciRifiuto(esito, { onChiudi, onCambiato, onEsito }, setErrore);
      return;
    }
    onEsito(valutazione ? t('valutazioniValutazioneEliminata') : t('valutazioniImpreparatoEliminato'), 'ok');
    onChiudi();
    onCambiato();
  };

  const titoloId = `${idBase}-titolo`;

  return (
    <Modal open onClose={chiudi} title={titolo} labelledBy={titoloId} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {titolo}
        </h2>
        <p className="font-maven mt-1 text-sm text-kidville-ink">
          {valutazione
            ? t('valutazioniEliminaValutazioneDomanda', { data })
            : t('valutazioniEliminaImpreparatoDomanda', { data })}
        </p>
        <Errore testo={errore} />
        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" size="sm" onClick={chiudi}>
            {t('valutazioniAnnulla')}
          </Btn>
          <Btn variant="danger" size="sm" aria-disabled={inVolo} onClick={() => void elimina()}>
            {inVolo ? t('valutazioniEliminazioneInCorso') : t('valutazioniElimina')}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
