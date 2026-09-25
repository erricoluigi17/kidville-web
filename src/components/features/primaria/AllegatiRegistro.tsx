'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Image as ImageIcon, Lock, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { Btn } from '@/components/ui/Btn';
import { Modal } from '@/components/ui/Modal';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';
import { BottoneSblocca, puoSbloccare } from '@/components/features/primaria/BottoneSblocca';
import { LinkAllegatoRegistro } from '@/components/features/primaria/LinkAllegatoRegistro';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { GIORNI_CESTINO_REGISTRO } from '@/lib/primaria/cestino-registro';

/**
 * GLI ALLEGATI DI UNA LEZIONE DEL REGISTRO — «Rinomina», «Sostituisci file» ed
 * «Elimina» (spec 2026-09-24, compito R4).
 *
 * Il server (R2, `/api/primaria/allegati` e `./sostituisci`) decide tutto: chi
 * (l'autore, Segreteria e Direzione), fino a quando (il termine sulla data della
 * lezione, poi lo sblocco della Direzione), e se l'allegato è ancora vivo. Qui si
 * decide soltanto cosa OFFRIRE, e lo si decide con la risposta del server, non con
 * una copia della regola:
 *
 *  · la GET del registro porta gli allegati SENZA autore né permessi; la GET degli
 *    allegati della lezione (`?registroId=`) li porta con `modificabile`, `bloccata`
 *    e `giorniLimite` per ciascuno (`statoVoci`, la stessa funzione che poi giudica
 *    PATCH e DELETE). Si chiede SOLO per le lezioni che hanno allegati: un giorno
 *    senza allegati non costa nessuna richiesta in più;
 *  · i comandi compaiono solo sulle voci `modificabile`; su quelle `bloccata` il
 *    messaggio del termine e, alla sola Direzione, «Sblocca» (voce `allegato`).
 *    `bloccata` vale per chiunque guardi: l'avviso lo vede solo chi potrebbe
 *    agire (Direzione, Segreteria, autore — `avvisoBloccoPertinente`);
 *  · permessi non letti = nessun comando (fail-closed), e lo si dice;
 *  · «Elimina» chiede SEMPRE conferma e dice dove va l'allegato: nel cestino della
 *    classe per `GIORNI_CESTINO_REGISTRO` giorni, la stessa costante della purga.
 *
 * Il link al file resta quello di prima; se la GET degli allegati ha firmato un
 * indirizzo fresco (link a 10'), si usa quello.
 */

/** Un allegato come lo restituisce la GET del registro (`allegati_registro(...)`). */
export interface AllegatoLezione {
  id: string;
  ambito: string;
  tipo: string;
  file_url: string;
  file_name: string | null;
}

/** Quello che la GET degli allegati della lezione aggiunge a ciascuno. */
export interface GestioneAllegato {
  id: string;
  file_url: string | null;
  file_name: string | null;
  modificabile: boolean;
  /** Oltre il termine e senza sblocco: vale per CHIUNQUE guardi, non dice chi può agire. */
  bloccata: boolean;
  giorniLimite: number | null;
  /** Chi l'ha caricato (la GET fa `select('*')` e poi `...riga`). */
  caricato_da: string | null;
}

/**
 * L'avviso «bloccato» ha senso solo per chi, dopo lo sblocco, potrebbe agire:
 * la Direzione (sblocca), la Segreteria e l'autore. A una collega che non l'ha
 * caricato il server risponderebbe comunque 403 `VOCE_NON_AUTORE`: dirle «chiedi
 * lo sblocco» sarebbe un'indicazione falsa, e le basta il link.
 */
export function avvisoBloccoPertinente(g: GestioneAllegato, userId: string, ruolo: string | null): boolean {
  if (!g.bloccata) return false;
  return puoSbloccare(ruolo) || ruolo === 'segreteria' || (!!g.caricato_da && g.caricato_da === userId);
}

/** La rotta della PAGINA per i log: il luogo dell'incidente, non la fetch. */
function rottaPagina(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

/** L'esito di una scrittura sugli allegati: mai un'eccezione. */
export type EsitoScritturaAllegato =
  | { tipo: 'ok'; corpo: unknown }
  | { tipo: 'rete' }
  | { tipo: 'rifiuto'; stato: number; codice: string | null; corpo: unknown };

/**
 * Manda la richiesta e ne classifica l'esito. Ogni ramo che non è un successo si
 * LOGGA qui (senza il corpo: può portare il nome di un file scritto su una classe
 * di minori): la rete che cade, il corpo non JSON, il rifiuto del server.
 */
export async function inviaScritturaAllegato(
  url: string,
  init: RequestInit,
  operazione: string,
): Promise<EsitoScritturaAllegato> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `registro-allegato-${operazione}-non-inviato: ${nomeErrore(err)}`,
      route: rottaPagina(),
      stato: 0,
    });
    return { tipo: 'rete' };
  }
  let corpo: unknown = null;
  try {
    corpo = await res.json();
  } catch (errJson) {
    // 413/502 rispondono HTML: si prosegue col testo generico, ma non in silenzio.
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `registro-allegato-${operazione}-risposta-non-json: ${nomeErrore(errJson)}`,
      route: rottaPagina(),
      stato: res.status,
    });
  }
  if (!res.ok || (corpo as { success?: boolean } | null)?.success === false) {
    const codice = (corpo as { codice?: unknown } | null)?.codice;
    logClient({
      // Oltre il termine non è un guasto, è la regola: `warn`.
      livello: res.status === 423 ? 'warn' : 'error',
      evento: 'fetch',
      messaggio: `registro-allegato-${operazione}-rifiutato`,
      route: rottaPagina(),
      stato: res.status,
    });
    return { tipo: 'rifiuto', stato: res.status, codice: typeof codice === 'string' ? codice : null, corpo };
  }
  return { tipo: 'ok', corpo };
}

/**
 * Il rifiuto dice che lo stato a schermo è VECCHIO: l'allegato non c'è più o è
 * cambiato (404/409), non è più di chi guarda (403), o il termine è passato (423).
 * La modale si chiude, il messaggio va sopra la griglia, la pagina rilegge — e con
 * la rilettura l'allegato bloccato mostra il suo «Sblocca».
 */
export function rifiutoRendeVecchio(stato: number): boolean {
  return stato === 403 || stato === 404 || stato === 409 || stato === 423;
}

/** La URL con l'identità legacy (`?userId=`), come le altre chiamate della pagina. */
function conUtente(percorso: string, userId: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ ...extra, userId });
  return `${percorso}?${q.toString()}`;
}

export interface AllegatiLezioneProps {
  registroId: string;
  /** Gli allegati VIVI della lezione, dalla GET del registro. */
  allegati: AllegatoLezione[];
  /** `null` = identità non risolta: solo i link, nessuna richiesta e nessun comando. */
  userId: string | null;
  /** Il ruolo reale di chi guarda (per «Sblocca», solo Direzione). */
  ruolo: string | null;
  /** Cambia quando qualcosa sugli allegati è cambiato: i permessi si rileggono. */
  versione: number;
  /** Un allegato è cambiato (o lo stato era vecchio): la pagina rilegge. */
  onCambiato: () => void;
  onEsito: (testo: string, tipo: 'ok' | 'errore') => void;
}

type Aperta = { modo: 'rinomina' | 'sostituisci' | 'elimina'; allegato: AllegatoLezione; nome: string } | null;

export function AllegatiLezione({ registroId, allegati, userId, ruolo, versione, onCambiato, onEsito }: AllegatiLezioneProps) {
  const t = useTranslations('teacherPrimaria');
  const [gestione, setGestione] = useState<Map<string, GestioneAllegato> | null>(null);
  const [permessiNonLetti, setPermessiNonLetti] = useState(false);
  const [aperta, setAperta] = useState<Aperta>(null);
  // La chiave degli allegati a schermo: la GET riparte quando cambiano, non a ogni
  // nuova identità dell'array (ogni rilettura del registro ne crea una).
  const chiaveAllegati = allegati.map((a) => a.id).join(',');

  useEffect(() => {
    if (!chiaveAllegati || !userId) return;
    let vivo = true;
    (async () => {
      let res: Response | null = null;
      try {
        res = await fetch(conUtente('/api/primaria/allegati', userId, { registroId }), { headers: { 'x-user-id': userId } });
      } catch (err) {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `registro-allegati-permessi-non-letti: ${nomeErrore(err)}`,
          route: rottaPagina(),
          stato: 0,
        });
      }
      let corpo: { success?: boolean; data?: GestioneAllegato[] } | null = null;
      if (res) {
        try {
          corpo = await res.json();
        } catch (errJson) {
          logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `registro-allegati-permessi-non-json: ${nomeErrore(errJson)}`,
            route: rottaPagina(),
            stato: res.status,
          });
        }
      }
      if (!vivo) return;
      if (!res?.ok || !corpo?.success || !Array.isArray(corpo.data)) {
        if (res) {
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'registro-allegati-permessi-rifiutati', route: rottaPagina(), stato: res.status });
        }
        // Fail-closed: senza permessi letti non si offre nessun comando.
        setGestione(null);
        setPermessiNonLetti(true);
        return;
      }
      setGestione(new Map(corpo.data.map((g) => [g.id, g])));
      setPermessiNonLetti(false);
    })();
    return () => { vivo = false; };
  }, [registroId, chiaveAllegati, userId, versione]);

  if (allegati.length === 0) return null;

  const comando =
    'inline-flex min-h-6 items-center gap-0.5 px-1 font-maven text-[11px] font-semibold underline-offset-2 hover:underline';

  return (
    <div className="mt-1.5" data-testid="registro-allegati">
      <ul className="space-y-1">
        {allegati.map((a) => {
          const g = gestione?.get(a.id);
          const nome = g?.file_name || a.file_name || t('registroAllegato');
          const href = g?.file_url || a.file_url;
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-1" data-testid={`registro-allegato-${a.id}`}>
              {/* R5: sul web la stessa ancora di prima; nell'app l'anteprima di sistema. */}
              <LinkAllegatoRegistro
                allegato={a}
                href={href}
                etichetta="registro-allegato"
                titolo={t('registroAllegato')}
                className="inline-flex items-center gap-1 rounded-pill bg-kidville-cream px-2 py-0.5 text-[11px] text-kidville-ink hover:bg-kidville-cream-dark"
              >
                {a.tipo === 'pdf' ? <FileText size={11} aria-hidden="true" /> : <ImageIcon size={11} aria-hidden="true" />}
                {nome}
              </LinkAllegatoRegistro>
              {g?.modificabile && (
                <>
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-label={t('registroAllegatoRinominaNome', { nome })}
                    onClick={() => setAperta({ modo: 'rinomina', allegato: a, nome })}
                    className={`${comando} text-kidville-green`}
                  >
                    <Pencil size={11} aria-hidden="true" /> {t('registroAllegatoRinomina')}
                  </button>
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-label={t('registroAllegatoSostituisciNome', { nome })}
                    onClick={() => setAperta({ modo: 'sostituisci', allegato: a, nome })}
                    className={`${comando} text-kidville-green`}
                  >
                    <RefreshCw size={11} aria-hidden="true" /> {t('registroAllegatoSostituisci')}
                  </button>
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-label={t('registroAllegatoEliminaNome', { nome })}
                    onClick={() => setAperta({ modo: 'elimina', allegato: a, nome })}
                    className={`${comando} text-kidville-error-strong`}
                  >
                    <Trash2 size={11} aria-hidden="true" /> {t('registroAllegatoElimina')}
                  </button>
                </>
              )}
              {g && userId && avvisoBloccoPertinente(g, userId, ruolo) && (
                <AllegatoBloccato
                  allegatoId={a.id}
                  nome={nome}
                  giorniLimite={g.giorniLimite}
                  userId={userId}
                  ruolo={ruolo}
                  onSbloccato={() => {
                    onEsito(t('registroAllegatoSbloccato', { nome }), 'ok');
                    onCambiato();
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      {permessiNonLetti && (
        <p role="status" data-testid="registro-allegati-permessi-non-letti" className="mt-1 font-maven text-[11px] text-kidville-sub">
          {t('registroAllegatoPermessiNonLetti')}
        </p>
      )}

      {aperta && userId && aperta.modo === 'rinomina' && (
        <ModaleRinomina key={aperta.allegato.id} {...{ userId, onCambiato, onEsito }} allegato={aperta.allegato} nome={aperta.nome} onChiudi={() => setAperta(null)} />
      )}
      {aperta && userId && aperta.modo === 'sostituisci' && (
        <ModaleSostituisci key={aperta.allegato.id} {...{ userId, onCambiato, onEsito }} allegato={aperta.allegato} nome={aperta.nome} onChiudi={() => setAperta(null)} />
      )}
      {aperta && userId && aperta.modo === 'elimina' && (
        <ModaleElimina key={aperta.allegato.id} {...{ userId, onCambiato, onEsito }} allegato={aperta.allegato} nome={aperta.nome} onChiudi={() => setAperta(null)} />
      )}
    </div>
  );
}

/**
 * L'allegato oltre il termine: il messaggio e, alla sola Direzione, «Sblocca» come
 * VOCE `allegato`. Agli altri l'indicazione di chiedere lo sblocco. Un testid suo e
 * non quello della riga (`registro-voce-bloccata`): sono due blocchi diversi.
 */
function AllegatoBloccato({
  allegatoId,
  nome,
  giorniLimite,
  userId,
  ruolo,
  onSbloccato,
}: {
  allegatoId: string;
  nome: string;
  giorniLimite: number | null;
  userId: string;
  ruolo: string | null;
  onSbloccato: () => void;
}) {
  const t = useTranslations('teacherPrimaria');
  const testo = giorniLimite !== null ? t('registroVoceBloccata', { giorni: giorniLimite }) : t('registroVoceBloccataSenzaGiorni');
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="registro-allegato-bloccato">
      <span role="status" className="inline-flex items-center gap-1 font-maven text-[11px] text-kidville-warn-strong">
        <Lock size={11} aria-hidden="true" />
        {testo} {puoSbloccare(ruolo) ? null : t('registroChiediSblocco')}
      </span>
      <BottoneSblocca
        bersaglio={{ modo: 'voce', entitaTipo: 'allegato', entitaId: allegatoId }}
        userId={userId}
        ruolo={ruolo}
        onSbloccato={onSbloccato}
        descrizioneAccessibile={t('registroAllegatoSbloccaNome', { nome })}
      />
    </span>
  );
}

interface ModaleProps {
  allegato: AllegatoLezione;
  /** Il nome mostrato (quello della GET, se c'è). */
  nome: string;
  userId: string;
  onChiudi: () => void;
  onCambiato: () => void;
  onEsito: (testo: string, tipo: 'ok' | 'errore') => void;
}

/**
 * La richiesta di una modale. `true` = riuscita. Un rifiuto che rende vecchio lo
 * stato chiude la modale, porta il messaggio alla pagina e la fa rileggere; gli
 * altri restano nella modale, che dice perché. La rete che cade lascia l'esito
 * IGNOTO (la risposta può essersi persa dopo la scrittura): si chiude e si rilegge.
 */
function useInvio(props: ModaleProps, operazione: string) {
  const t = useTranslations('teacherPrimaria');
  const [inVolo, setInVolo] = useState(false);
  // Copia SINCRONA: lo stato arriva al `Modal` solo al render dopo, e un Escape nel
  // frattempo userebbe ancora la chiusura libera, perdendo l'esito.
  const inVoloRef = useRef(false);
  const [errore, setErrore] = useState<string | null>(null);

  const chiudiSeLibera = () => {
    if (inVoloRef.current) return;
    props.onChiudi();
  };

  const invia = async (url: string, init: RequestInit): Promise<unknown | false> => {
    if (inVoloRef.current) return false;
    inVoloRef.current = true;
    setInVolo(true);
    setErrore(null);
    try {
      const esito = await inviaScritturaAllegato(url, init, operazione);
      if (esito.tipo === 'ok') return esito.corpo ?? true;
      if (esito.tipo === 'rete') {
        props.onEsito(t('comuneErroreRete'), 'errore');
        props.onChiudi();
        props.onCambiato();
        return false;
      }
      const testo = messaggioDaCorpo(esito.corpo, t('registroAllegatoErrore'));
      if (rifiutoRendeVecchio(esito.stato)) {
        props.onEsito(testo, 'errore');
        props.onChiudi();
        props.onCambiato();
        return false;
      }
      setErrore(testo);
      return false;
    } finally {
      inVoloRef.current = false;
      setInVolo(false);
    }
  };

  return { inVolo, errore, setErrore, invia, chiudiSeLibera };
}

function Errore({ testo }: { testo: string | null }) {
  if (!testo) return null;
  return (
    <p role="alert" className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
      {testo}
    </p>
  );
}

/** Il tetto del nome mostrato: lo stesso dello schema zod della PATCH. */
export const NOME_ALLEGATO_MAX = 200;

function ModaleRinomina(props: ModaleProps) {
  const t = useTranslations('teacherPrimaria');
  const { allegato, nome, userId, onChiudi, onCambiato, onEsito } = props;
  const titoloId = useId();
  const campoId = useId();
  const [valore, setValore] = useState(nome);
  const { inVolo, errore, setErrore, invia, chiudiSeLibera } = useInvio(props, 'rinomina');

  const salva = async () => {
    const nuovo = valore.trim();
    if (!nuovo) { setErrore(t('registroAllegatoNomeVuoto')); return; }
    if (nuovo === nome.trim()) { setErrore(t('registroAllegatoNomeUguale')); return; }
    const ok = await invia(conUtente('/api/primaria/allegati', userId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ id: allegato.id, nome: nuovo }),
    });
    if (ok === false) return;
    onEsito(t('registroAllegatoRinominato'), 'ok');
    onChiudi();
    onCambiato();
  };

  return (
    <Modal open onClose={chiudiSeLibera} closeOnBackdrop={false} title={t('registroAllegatoRinominaTitolo')} labelledBy={titoloId} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl" data-testid="registro-allegato-rinomina">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('registroAllegatoRinominaTitolo')}
        </h2>
        <label htmlFor={campoId} className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
          {t('registroAllegatoNomeLabel')}
        </label>
        <input
          id={campoId}
          value={valore}
          onChange={(e) => setValore(e.target.value)}
          maxLength={NOME_ALLEGATO_MAX}
          className="font-maven mt-1 w-full rounded-card border border-kidville-line bg-kidville-white px-3 py-2 text-sm text-kidville-ink"
        />
        <Errore testo={errore} />
        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" size="sm" onClick={chiudiSeLibera} aria-disabled={inVolo}>{t('registroAllegatoAnnulla')}</Btn>
          <Btn size="sm" aria-disabled={inVolo} onClick={() => void salva()}>
            {inVolo ? t('comuneSalvataggio') : t('registroAllegatoSalva')}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function ModaleSostituisci(props: ModaleProps) {
  const t = useTranslations('teacherPrimaria');
  const { allegato, nome, userId, onChiudi, onCambiato, onEsito } = props;
  const titoloId = useId();
  const fileId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fotoScattata, setFotoScattata] = useState<File | null>(null);
  const { inVolo, errore, setErrore, invia, chiudiSeLibera } = useInvio(props, 'sostituzione');

  const sostituisci = async () => {
    const file = fotoScattata ?? fileRef.current?.files?.[0];
    if (!file) { setErrore(t('registroAllegatoScegliFile')); return; }
    const fd = new FormData();
    fd.append('id', allegato.id);
    fd.append('file', file);
    const ok = await invia(conUtente('/api/primaria/allegati/sostituisci', userId), {
      method: 'POST',
      headers: { 'x-user-id': userId },
      body: fd,
    });
    if (ok === false) return;
    onEsito(t('registroAllegatoSostituito', { giorni: GIORNI_CESTINO_REGISTRO }), 'ok');
    onChiudi();
    onCambiato();
  };

  return (
    <Modal open onClose={chiudiSeLibera} closeOnBackdrop={false} title={t('registroAllegatoSostituisciTitolo')} labelledBy={titoloId} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl" data-testid="registro-allegato-sostituisci">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('registroAllegatoSostituisciTitolo')}
        </h2>
        <p className="font-maven mt-1 break-words text-sm font-semibold text-kidville-ink">{nome}</p>
        <p className="mt-3 rounded-card bg-kidville-info-soft px-3 py-2 font-maven text-xs text-kidville-info">
          {t('registroAllegatoSostituisciSpiega', { giorni: GIORNI_CESTINO_REGISTRO })}
        </p>
        <label htmlFor={fileId} className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
          {t('registroAllegatoNuovoFile')}
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            id={fileId}
            ref={fileRef}
            type="file"
            accept="application/pdf,image/*"
            onChange={() => { setFotoScattata(null); setErrore(null); }}
            className="font-maven block min-w-0 flex-1 text-sm text-kidville-ink file:mr-3 file:rounded-pill file:border-0 file:bg-kidville-green/10 file:px-4 file:py-1.5 file:text-kidville-green"
          />
          {/* Nativo: la foto scattata al posto del file. Su web non compare. */}
          <ScattaFotoButton
            onFile={(f) => { setFotoScattata(f); setErrore(null); }}
            className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm font-semibold text-kidville-green"
          />
        </div>
        {fotoScattata && <p className="font-maven mt-1.5 break-words text-xs text-kidville-green">{fotoScattata.name}</p>}
        <Errore testo={errore} />
        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" size="sm" onClick={chiudiSeLibera} aria-disabled={inVolo}>{t('registroAllegatoAnnulla')}</Btn>
          <Btn size="sm" aria-disabled={inVolo} onClick={() => void sostituisci()}>
            {inVolo ? t('registroAllegatoInCorso') : t('registroAllegatoSostituisciConferma')}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function ModaleElimina(props: ModaleProps) {
  const t = useTranslations('teacherPrimaria');
  const { allegato, nome, userId, onChiudi, onCambiato, onEsito } = props;
  const titoloId = useId();
  const { inVolo, errore, invia, chiudiSeLibera } = useInvio(props, 'eliminazione');

  const elimina = async () => {
    const ok = await invia(conUtente('/api/primaria/allegati', userId, { id: allegato.id }), {
      method: 'DELETE',
      headers: { 'x-user-id': userId },
    });
    if (ok === false) return;
    onEsito(t('registroAllegatoEliminato', { giorni: GIORNI_CESTINO_REGISTRO }), 'ok');
    onChiudi();
    onCambiato();
  };

  return (
    <Modal
      open
      onClose={chiudiSeLibera}
      // Un click distratto sullo sfondo non vale come risposta.
      closeOnBackdrop={false}
      title={t('registroAllegatoEliminaTitolo')}
      labelledBy={titoloId}
      className="w-full max-w-md"
    >
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl" data-testid="registro-allegato-elimina">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('registroAllegatoEliminaTitolo')}
        </h2>
        <p data-testid="registro-allegato-elimina-spiega" className="mt-3 break-words rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-sm text-kidville-warn-strong">
          {t('registroAllegatoEliminaSpiega', { nome, giorni: GIORNI_CESTINO_REGISTRO })}
        </p>
        <Errore testo={errore} />
        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" size="sm" onClick={chiudiSeLibera} aria-disabled={inVolo}>{t('registroAllegatoAnnulla')}</Btn>
          <Btn variant="danger" size="sm" aria-disabled={inVolo} onClick={() => void elimina()}>
            {inVolo ? t('registroAllegatoInCorso') : t('registroAllegatoEliminaConferma')}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
