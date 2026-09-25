'use client';

import { useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Pencil, Trash2, Lock } from 'lucide-react';
import { formattaIstante } from '@/i18n/config';
import { Btn } from '@/components/ui/Btn';
import { Modal } from '@/components/ui/Modal';
import { logClient } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { BottoneSblocca } from '@/components/features/primaria/BottoneSblocca';

/**
 * «Modifica» ed «Elimina» di una nota di primaria (spec 2026-09-24, compito NO2).
 *
 * Il server (`PATCH`/`DELETE /api/primaria/note`, compito NO1) decide tutto:
 * permesso, termine, sblocchi, firma azzerata. Qui si decide solo COSA chiedere
 * prima di mandare la richiesta, e le tre regole della spec sono queste:
 *
 *  1. NOTA DI GRUPPO → si chiede SEMPRE «solo questo alunno / tutti». Il server
 *     pretende `ambito` e non sceglie al posto di chi scrive: nemmeno la UI lo fa,
 *     né con un valore predefinito né ricordando la scelta di prima.
 *  2. NOTA FIRMATA → la modale lo dice PRIMA: la modifica azzera la firma del
 *     genitore (va rifirmata sul testo nuovo), l'eliminazione la fa sparire.
 *  3. NOTA BLOCCATA (oltre il termine, senza sblocco) → niente bottoni, un
 *     messaggio e, per la Direzione, «Sblocca».
 */

/**
 * Le categorie di nota, con il loro stile: UNA fonte per il modulo «Nuova nota»,
 * il badge dell'elenco e la modale di modifica. `key` è anche il valore di
 * `categoria` lato API; l'etichetta si traduce al render con
 * `t(\`noteCategoria_${key}\`)`.
 */
export const CATEGORIE_NOTA: readonly { key: string; cls: string }[] = [
  { key: 'disciplinare', cls: 'bg-kidville-error/10 text-kidville-error' },
  { key: 'didattica', cls: 'bg-kidville-info-soft text-kidville-info' },
  { key: 'compiti_non_svolti', cls: 'bg-kidville-warn-soft text-kidville-warn' },
];

/**
 * Chi può modificare/eliminare anche le note ALTRUI, una volta sbloccate: gli
 * stessi ruoli di `RUOLI_STAFF` in `src/lib/primaria/permesso-voce.ts` (modulo
 * server, non importabile qui). Serve solo a non promettere uno sblocco a chi,
 * a sblocco avvenuto, riceverebbe comunque 403 `VOCE_NON_AUTORE`.
 */
const RUOLI_STAFF_VOCE = new Set(['segreteria', 'admin', 'coordinator']);

/** Una nota come la restituisce `GET /api/primaria/note`. */
export interface NotaElenco {
  id: string;
  alunno_id: string;
  /** L'autore della nota: con la sede e il ruolo decide chi può agire dopo uno sblocco. */
  maestra_id?: string | null;
  categoria: string;
  testo: string;
  richiede_firma: boolean;
  firmata_il: string | null;
  creato_il: string;
  nota_gruppo_id?: string | null;
  alunni?: { nome: string; cognome: string } | null;
  /** Autorizzato E (entro il termine O sbloccato). Assente = no (fail-closed). */
  modificabile?: boolean;
  /** Oltre il termine e senza sblocco. */
  bloccata?: boolean;
  giorni_limite?: number | null;
  /** Quanti alunni ha il gruppo della nota (1 = nota singola). */
  n_alunni_gruppo?: number;
  /** Vero solo se OGNI nota del gruppo si può toccare: senza, «Tutti» non si offre. */
  gruppo_modificabile?: boolean;
}

export type Ambito = 'alunno' | 'gruppo';

/** Vero se prima di salvare o eliminare si deve chiedere «solo questo alunno / tutti». */
export function serveSceltaAmbito(nota: Pick<NotaElenco, 'nota_gruppo_id' | 'n_alunni_gruppo'>): boolean {
  return !!nota.nota_gruppo_id && (nota.n_alunni_gruppo ?? 1) > 1;
}

export interface BozzaNota {
  categoria: string;
  testo: string;
  richiedeFirma: boolean;
}

/**
 * I soli campi che la bozza cambia rispetto alla nota. Si manda solo quello che
 * cambia: con «Tutti», un campo rimandato uguale sovrascriverebbe sugli ALTRI
 * alunni un valore che qualcuno aveva cambiato solo per loro. Il testo si
 * confronta rifilato, come fa il server: un a capo in coda non è una modifica.
 */
export function campiCambiati(
  nota: Pick<NotaElenco, 'categoria' | 'testo' | 'richiede_firma'>,
  bozza: BozzaNota,
): Partial<{ categoria: string; testo: string; richiedeFirma: boolean }> {
  const out: Partial<{ categoria: string; testo: string; richiedeFirma: boolean }> = {};
  if (bozza.categoria !== nota.categoria) out.categoria = bozza.categoria;
  if (bozza.testo.trim() !== String(nota.testo ?? '').trim()) out.testo = bozza.testo;
  if (bozza.richiedeFirma !== !!nota.richiede_firma) out.richiedeFirma = bozza.richiedeFirma;
  return out;
}

/**
 * Vero se chi guarda potrebbe agire sulla nota una volta sbloccata: l'autore, o
 * lo staff. Il messaggio «serve lo sblocco della Direzione» si mostra solo a
 * loro: a un altro docente della classe prometterebbe un'azione che non esiste.
 */
export function puoAgireDopoSblocco(
  nota: Pick<NotaElenco, 'maestra_id'>,
  userId: string,
  ruolo: string | null | undefined,
): boolean {
  if (!!userId && !!nota.maestra_id && nota.maestra_id === userId) return true;
  return !!ruolo && RUOLI_STAFF_VOCE.has(ruolo);
}

function paginaCorrente(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

export interface AzioniNotaProps {
  nota: NotaElenco;
  /** Il nome dell'alunno GIÀ formattato: entra nei nomi accessibili dei bottoni. */
  nomeAlunno: string;
  /** Quante note del gruppo (compresa questa) risultano firmate nell'elenco. */
  firmateNelGruppo: number;
  userId: string;
  ruolo: string | null;
  /** Il server ha calcolato i permessi (`statoVociDisponibile`). Senza, niente bottoni. */
  permessiDisponibili: boolean;
  /** Dopo un esito (riuscito o rifiutato): la pagina rilegge l'elenco. */
  onCambiato: () => void;
  /**
   * L'esito da mostrare sopra l'elenco. Anche un RIFIUTO che fa rileggere
   * l'elenco passa di qui: la rilettura può togliere la modale (nota sparita, o
   * diventata bloccata), e con lei il messaggio che spiegava perché.
   */
  onEsito: (testo: string, tipo: 'ok' | 'errore') => void;
  /** Si apre una modale: l'esito vecchio sopra l'elenco non riguarda più niente. */
  onApri: () => void;
  /** Uno sblocco della Direzione è andato a buon fine: la pagina azzera l'esito e rilegge. */
  onSbloccato: () => void;
}

type Operazione = 'modifica' | 'elimina';

export function AzioniNota({
  nota,
  nomeAlunno,
  firmateNelGruppo,
  userId,
  ruolo,
  permessiDisponibili,
  onCambiato,
  onEsito,
  onApri,
  onSbloccato,
}: AzioniNotaProps) {
  const t = useTranslations('teacherPrimaria');
  const locale = useLocale();
  const [aperta, setAperta] = useState<Operazione | null>(null);

  // La `<li key={n.id}>` tiene viva questa istanza da una rilettura all'altra:
  // se la nota smette di essere azionabile (bloccata, permessi non calcolati,
  // non più modificabile) la modale si smonta, ma `aperta` resterebbe e la
  // riaprirebbe da sola il giorno in cui la nota torna azionabile (uno sblocco,
  // una rilettura qualsiasi). Si azzera nel momento in cui smette di esserlo
  // (lo «stato aggiustato durante il render» della documentazione di React).
  const azionabile = permessiDisponibili && !nota.bloccata && !!nota.modificabile;
  const [azionabilePrima, setAzionabilePrima] = useState(azionabile);
  if (azionabile !== azionabilePrima) {
    setAzionabilePrima(azionabile);
    if (!azionabile) setAperta(null);
  }

  if (!permessiDisponibili) return null;

  // Data e ora della nota nei nomi accessibili: lo stesso alunno ha spesso più
  // note in elenco, e «Elimina la nota di …» ripetuto uguale non dice QUALE.
  const quando = {
    alunno: nomeAlunno,
    data: formattaIstante(nota.creato_il, locale, { day: '2-digit', month: '2-digit', year: 'numeric' }),
    ora: formattaIstante(nota.creato_il, locale, { hour: '2-digit', minute: '2-digit' }),
  };

  if (nota.bloccata) {
    // Il messaggio promette uno sblocco: solo a chi, sbloccata, potrebbe agire.
    if (!puoAgireDopoSblocco(nota, userId, ruolo)) return null;
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2" data-testid={`nota-bloccata-${nota.id}`}>
        <p className="flex items-center gap-1 font-maven text-xs text-kidville-warn">
          <Lock size={12} aria-hidden="true" />
          {typeof nota.giorni_limite === 'number'
            ? t('noteBloccata', { giorni: nota.giorni_limite })
            : t('noteBloccataSenzaGiorni')}
        </p>
        <BottoneSblocca
          bersaglio={{ modo: 'voce', entitaTipo: 'nota', entitaId: nota.id }}
          userId={userId}
          ruolo={ruolo}
          onSbloccato={onSbloccato}
          descrizioneAccessibile={t('noteSbloccaNome', quando)}
        />
      </div>
    );
  }

  if (!nota.modificabile) return null;

  const apri = (op: Operazione) => {
    onApri();
    setAperta(op);
  };

  return (
    <>
      <div className="mt-1 flex gap-2">
        <Btn
          variant="ghost"
          size="sm"
          aria-haspopup="dialog"
          aria-label={t('noteModificaNome', quando)}
          onClick={() => apri('modifica')}
        >
          <Pencil size={13} aria-hidden="true" /> {t('noteModifica')}
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          aria-haspopup="dialog"
          aria-label={t('noteEliminaNome', quando)}
          onClick={() => apri('elimina')}
        >
          <Trash2 size={13} aria-hidden="true" /> {t('noteElimina')}
        </Btn>
      </div>
      {aperta === 'modifica' && (
        <ModaleModificaNota
          nota={nota}
          nomeAlunno={nomeAlunno}
          firmateNelGruppo={firmateNelGruppo}
          userId={userId}
          onChiudi={() => setAperta(null)}
          onCambiato={onCambiato}
          onEsito={onEsito}
        />
      )}
      {aperta === 'elimina' && (
        <ModaleEliminaNota
          nota={nota}
          nomeAlunno={nomeAlunno}
          firmateNelGruppo={firmateNelGruppo}
          userId={userId}
          onChiudi={() => setAperta(null)}
          onCambiato={onCambiato}
          onEsito={onEsito}
        />
      )}
    </>
  );
}

interface ModaleProps {
  nota: NotaElenco;
  nomeAlunno: string;
  firmateNelGruppo: number;
  userId: string;
  onChiudi: () => void;
  onCambiato: () => void;
  onEsito: (testo: string, tipo: 'ok' | 'errore') => void;
}

/**
 * Manda la richiesta e ne legge l'esito: il corpo se è riuscita, altrimenti il
 * messaggio d'errore già tradotto. `ricarica` = rifiuto motivato (termine
 * scaduto nel frattempo, nota sparita, non autore): lo stato a schermo era
 * vecchio e l'elenco va riletto.
 */
async function invia(
  url: string,
  init: RequestInit,
  operazione: Operazione,
  fallback: string,
  fallbackRete: string,
): Promise<{ ok: true; corpo: Record<string, unknown> } | { ok: false; messaggio: string; ricarica: boolean }> {
  try {
    const res = await fetch(url, init);
    let corpo: unknown = null;
    try {
      corpo = await res.json();
    } catch (errJson) {
      logClient({
        livello: 'warn',
        evento: 'fetch',
        messaggio: `nota-${operazione}-risposta-non-json: ${errJson instanceof Error ? errJson.name : 'errore'}`,
        route: paginaCorrente(),
        stato: res.status,
      });
    }
    if (!res.ok) {
      // Il corpo non entra nel log: può contenere il testo della nota.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `nota-${operazione}-rifiutata`,
        route: paginaCorrente(),
        stato: res.status,
      });
      return {
        ok: false,
        messaggio: messaggioDaCorpo(corpo, fallback),
        ricarica: res.status === 403 || res.status === 404 || res.status === 423,
      };
    }
    return { ok: true, corpo: (corpo ?? {}) as Record<string, unknown> };
  } catch (err) {
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `nota-${operazione}-non-inviata: ${err instanceof Error ? err.name : 'errore'}`,
      route: paginaCorrente(),
    });
    return { ok: false, messaggio: fallbackRete, ricarica: false };
  }
}

function numero(v: unknown, predefinito: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : predefinito;
}

/** La scelta «solo questo alunno / tutti», identica in modifica ed eliminazione. */
function SceltaAmbito({
  nota,
  domanda,
  avvisoFirmeGruppo,
  inVolo,
  onScegli,
}: {
  nota: NotaElenco;
  domanda: string;
  avvisoFirmeGruppo: string | null;
  inVolo: boolean;
  onScegli: (a: Ambito) => void;
}) {
  const t = useTranslations('teacherPrimaria');
  const n = nota.n_alunni_gruppo ?? 1;
  const tuttiPossibile = nota.gruppo_modificabile === true;
  const idHint = useId();
  return (
    <fieldset className="mt-3" data-testid="nota-scelta-ambito">
      <legend className="font-maven text-sm font-semibold text-kidville-ink">{domanda}</legend>
      <div className="mt-2 flex flex-col gap-2">
        <Btn variant="secondary" size="sm" aria-disabled={inVolo} onClick={() => !inVolo && onScegli('alunno')}>
          {t('noteAmbitoSolo')}
        </Btn>
        <Btn
          variant="secondary"
          size="sm"
          aria-disabled={inVolo || !tuttiPossibile}
          aria-describedby={tuttiPossibile ? undefined : idHint}
          onClick={() => !inVolo && tuttiPossibile && onScegli('gruppo')}
        >
          {t('noteAmbitoTutti', { n })}
        </Btn>
      </div>
      {!tuttiPossibile && (
        <p id={idHint} className="mt-1 font-maven text-xs text-kidville-sub">
          {t('noteAmbitoTuttiNonDisponibile')}
        </p>
      )}
      {avvisoFirmeGruppo && tuttiPossibile && (
        <p className="mt-2 rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn">
          {avvisoFirmeGruppo}
        </p>
      )}
    </fieldset>
  );
}

function ModaleModificaNota({ nota, nomeAlunno, firmateNelGruppo, userId, onChiudi, onCambiato, onEsito }: ModaleProps) {
  const t = useTranslations('teacherPrimaria');
  const idBase = useId();
  const [categoria, setCategoria] = useState(nota.categoria);
  const [testo, setTesto] = useState(nota.testo);
  const [richiedeFirma, setRichiedeFirma] = useState(!!nota.richiede_firma);
  const [passo, setPasso] = useState<'form' | 'ambito'>('form');
  const [errore, setErrore] = useState('');
  const [inVolo, setInVolo] = useState(false);

  const chiudi = () => {
    if (inVolo) return;
    onChiudi();
  };

  const campi = () => campiCambiati(nota, { categoria, testo, richiedeFirma });

  const manda = async (ambito: Ambito) => {
    if (inVolo) return;
    const c = campi();
    setInVolo(true);
    setErrore('');
    const esito = await invia(
      `/api/primaria/note?userId=${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ id: nota.id, ambito, ...c }),
      },
      'modifica',
      t('noteErroreModifica'),
      t('noteErroreRete'),
    );
    setInVolo(false);
    if (!esito.ok) {
      if (esito.ricarica) {
        // Lo stato a schermo era vecchio: la modale si chiude, il messaggio va
        // SOPRA l'elenco (uno solo: dentro la modale sarebbe un secondo `alert`
        // con lo stesso testo) e l'elenco si rilegge.
        onEsito(esito.messaggio, 'errore');
        onChiudi();
        onCambiato();
        return;
      }
      setErrore(esito.messaggio);
      return;
    }
    const modificate = numero(esito.corpo.modificate, 1);
    const firme = numero(esito.corpo.firme_azzerate, 0);
    onEsito(
      modificate === 0
        ? t('noteNessunCambio')
        : firme > 0
          ? `${t('noteModificata', { n: modificate })} · ${t('noteFirmeAzzerate', { n: firme })}`
          : t('noteModificata', { n: modificate }),
      'ok',
    );
    onChiudi();
    onCambiato();
  };

  const salva = () => {
    if (inVolo) return;
    setErrore('');
    if (!testo.trim()) {
      setErrore(t('noteTestoObbligatorio'));
      return;
    }
    if (Object.keys(campi()).length === 0) {
      setErrore(t('noteNessunCambio'));
      return;
    }
    // Nota di gruppo: la scelta si chiede OGNI volta, prima di mandare niente.
    if (serveSceltaAmbito(nota)) {
      setPasso('ambito');
      return;
    }
    void manda('alunno');
  };

  const titoloId = `${idBase}-titolo`;
  const testoId = `${idBase}-testo`;

  return (
    <Modal open onClose={chiudi} title={t('noteModificaTitolo')} labelledBy={titoloId} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('noteModificaTitolo')}
        </h2>
        <p className="font-maven mt-1 text-sm font-semibold text-kidville-ink">{nomeAlunno}</p>

        {nota.firmata_il && (
          <p
            data-testid="nota-avviso-firma"
            className="mt-3 rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn"
          >
            {t('noteAvvisoFirmaAzzerata')}
          </p>
        )}

        {errore && (
          <p role="alert" className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
            {errore}
          </p>
        )}

        {passo === 'form' ? (
          <>
            <p className="mt-3 font-maven text-xs font-semibold text-kidville-sub">{t('noteCategoria')}</p>
            <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label={t('noteCategoria')}>
              {CATEGORIE_NOTA.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={categoria === c.key}
                  onClick={() => setCategoria(c.key)}
                  className={`font-maven rounded-pill px-3 py-1 text-xs ${categoria === c.key ? `${c.cls} ring-1 ring-current` : 'bg-kidville-cream text-kidville-sub'}`}
                >
                  {t(`noteCategoria_${c.key}`)}
                </button>
              ))}
            </div>
            <label htmlFor={testoId} className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
              {t('noteTesto')}
            </label>
            <textarea
              id={testoId}
              value={testo}
              onChange={(e) => setTesto(e.target.value)}
              rows={4}
              className="font-maven mt-1 w-full rounded-card border border-kidville-line px-3 py-2 text-sm"
            />
            <label className="mt-2 flex items-center gap-2 font-maven text-sm text-kidville-ink">
              <input type="checkbox" checked={richiedeFirma} onChange={(e) => setRichiedeFirma(e.target.checked)} />
              {t('noteRichiediFirma')}
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <Btn variant="ghost" size="sm" onClick={chiudi}>
                {t('noteAnnulla')}
              </Btn>
              <Btn variant="primary" size="sm" aria-disabled={inVolo} onClick={salva}>
                {inVolo ? t('comuneSalvataggio') : t('noteSalva')}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <SceltaAmbito
              nota={nota}
              domanda={t('noteAmbitoDomandaModifica', { n: nota.n_alunni_gruppo ?? 1 })}
              avvisoFirmeGruppo={firmateNelGruppo > 0 ? t('noteAvvisoFirmeGruppoAzzerate', { n: firmateNelGruppo }) : null}
              inVolo={inVolo}
              onScegli={(a) => void manda(a)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Btn variant="ghost" size="sm" onClick={() => !inVolo && setPasso('form')}>
                {t('noteIndietro')}
              </Btn>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ModaleEliminaNota({ nota, nomeAlunno, firmateNelGruppo, userId, onChiudi, onCambiato, onEsito }: ModaleProps) {
  const t = useTranslations('teacherPrimaria');
  const idBase = useId();
  const [errore, setErrore] = useState('');
  const [inVolo, setInVolo] = useState(false);
  const gruppo = serveSceltaAmbito(nota);

  const chiudi = () => {
    if (inVolo) return;
    onChiudi();
  };

  const elimina = async (ambito: Ambito) => {
    if (inVolo) return;
    setInVolo(true);
    setErrore('');
    const qs = new URLSearchParams({ id: nota.id, ambito, userId });
    const esito = await invia(
      `/api/primaria/note?${qs.toString()}`,
      { method: 'DELETE', headers: { 'x-user-id': userId } },
      'elimina',
      t('noteErroreEliminazione'),
      t('noteErroreRete'),
    );
    setInVolo(false);
    if (!esito.ok) {
      if (esito.ricarica) {
        // Lo stato a schermo era vecchio: la modale si chiude, il messaggio va
        // SOPRA l'elenco (uno solo: dentro la modale sarebbe un secondo `alert`
        // con lo stesso testo) e l'elenco si rilegge.
        onEsito(esito.messaggio, 'errore');
        onChiudi();
        onCambiato();
        return;
      }
      setErrore(esito.messaggio);
      return;
    }
    const eliminate = numero(esito.corpo.eliminate, 1);
    const firme = numero(esito.corpo.firme_rimosse, 0);
    onEsito(
      firme > 0
        ? `${t('noteEliminata', { n: eliminate })} · ${t('noteFirmeRimosse', { n: firme })}`
        : t('noteEliminata', { n: eliminate }),
      'ok',
    );
    onChiudi();
    onCambiato();
  };

  const titoloId = `${idBase}-titolo`;

  return (
    <Modal open onClose={chiudi} title={t('noteEliminaTitolo')} labelledBy={titoloId} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('noteEliminaTitolo')}
        </h2>
        <p className="font-maven mt-1 text-sm text-kidville-ink">{t('noteEliminaDomanda', { alunno: nomeAlunno })}</p>
        <p className="font-maven mt-1 text-xs text-kidville-sub">{nota.testo}</p>

        {nota.firmata_il && (
          <p
            data-testid="nota-avviso-firma"
            className="mt-3 rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn"
          >
            {t('noteAvvisoFirmaSparisce')}
          </p>
        )}

        {errore && (
          <p role="alert" className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
            {errore}
          </p>
        )}

        {gruppo ? (
          <>
            <SceltaAmbito
              nota={nota}
              domanda={t('noteAmbitoDomandaElimina', { n: nota.n_alunni_gruppo ?? 1 })}
              avvisoFirmeGruppo={firmateNelGruppo > 0 ? t('noteAvvisoFirmeGruppoSpariscono', { n: firmateNelGruppo }) : null}
              inVolo={inVolo}
              onScegli={(a) => void elimina(a)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Btn variant="ghost" size="sm" onClick={chiudi}>
                {t('noteAnnulla')}
              </Btn>
            </div>
          </>
        ) : (
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" size="sm" onClick={chiudi}>
              {t('noteAnnulla')}
            </Btn>
            <Btn variant="danger" size="sm" aria-disabled={inVolo} onClick={() => void elimina('alunno')}>
              {inVolo ? t('noteEliminazioneInCorso') : t('noteElimina')}
            </Btn>
          </div>
        )}
      </div>
    </Modal>
  );
}
