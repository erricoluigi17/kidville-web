'use client';

// ─── Popup centrale del movimento bancario (Riconciliazione v2) ───────────────
// Aperto cliccando una riga della lista a semaforo. Dà, in un punto solo:
//   · i suggerimenti ordinati (i CF-match primi, badge «CF») con «Conferma questo»;
//   · la ricerca manuale fra i pagamenti aperti (stessa fonte del pannello);
//   · le azioni sul movimento (Ignora / Riapri);
//   · a saldo avvenuto, la Fattura SdI (come il PagamentoDrawer);
//   · il punto d'innesto «Apri Incasso unico» per i bonifici di famiglia (multi-CF):
//     lo renderizza solo se il chiamante passa `onIncassoUnico` (impl. UI-2).
// Le risposte del server sono gestite senza crash: 409 «già saldato» e 409
// «già riconciliato da un altro operatore» diventano messaggi chiari (+ refetch).

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { AlertTriangle, Check, Clock, FileCheck, FileText, Layers, Receipt, Search, X, Users } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { FatturaButton } from './FatturaButton';
import { ComposizioneBonifico } from './ComposizioneBonifico';
// Ricerca dei bambini, frasi della regione viva e «che cosa si legge accanto al
// nome» (classe, plesso, e `voci_aperte: null` che NON è zero): stanno tutte in
// `use-ricerca-alunni`, una volta sola, perché due copie divergono in silenzio.
import { dettaglioAlunno, fraseRicercaAlunni, useRicercaAlunni } from './use-ricerca-alunni';
import type { MotivoRinuncia } from '@/lib/pagamenti/riconciliazione-auto';
import type { MotivoStato } from '@/lib/pagamenti/riconciliazione';
import { MODAL_CARD_QUASI_SCHERMO, MODAL_SHADOW, INPUT, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { CODA_FATTURE_HREF } from '../admin-nav-config';
import { azioneConCoda } from '@/lib/pagamenti/fatturazione-riga';
// `import type`: `@/lib/fatture-coda/api` tira dentro `next/server` e il logger del server.
import type { StatoCodaAttivo } from '@/lib/fatture-coda/api';
import {
  chipFatturazione,
  classiChipFatturazione,
  CHIP_CODA,
  classiChipCoda,
  apertiDiPiuSedi,
  labelPagamentoAperto,
  movimentoMultiCf,
  testoRicercaPagamento,
  FRASE_FATTURAZIONE,
  type EsitoComposizione,
  type MovimentoUi,
  type PagamentoApertoUi,
  type PelleCoda,
  type StatoFattura,
  type TonoFatturazione,
} from './riconciliazione-ui';

interface Props {
  movimento: MovimentoUi;
  aperti: PagamentoApertoUi[];
  userId: string;
  onClose: () => void;
  /**
   * Refetch della lista dopo un'azione riuscita (o una corsa persa).
   *
   * ⚠️ L'ARGOMENTO È FACOLTATIVO DI PROPOSITO, e «assente» non è «andata male».
   * Le azioni di questo popup sono più d'una — conferma, ignora, riapri, emissione
   * della fattura — e **una sola** produce un riepilogo che vale la pena leggere:
   * la COMPOSIZIONE, che spalma il denaro su righe che nella lista non si vedono.
   * Tutte le altre chiamano `onDone()` nudo, e la fascia di riepilogo dell'elenco
   * non si monta affatto. Trattare «non me l'hanno detto» come «è andata male»
   * farebbe comparire un avviso su ogni conferma riuscita.
   */
  onDone: (esito?: EsitoComposizione) => void;
  /** Ripristino focus WCAG 2.4.3: la riga che ha aperto il dialog. */
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  /**
   * Predisposizione «Apri Incasso unico» per i bonifici di famiglia (multi-CF).
   * Reso SOLO se fornito e il movimento è multi-CF: l'implementazione è di UI-2.
   */
  onIncassoUnico?: (movimento: MovimentoUi) => void;
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

const TITLE_ID = 'movimento-dialog-title';

/**
 * Occhiello: la parolina in Barlow che dice CHE COSA si sta guardando. Sta qui e
 * non in `ui.ts` perché è la voce di questa schermata (intestazione del popup,
 * etichette dei campi, titoletto dei documenti) e non una primitiva dell'app.
 */
const OCCHIELLO_TIPO = 'font-barlow text-[11px] font-extrabold uppercase tracking-[0.08em]';
const OCCHIELLO = `${OCCHIELLO_TIPO} text-kidville-green`;

/**
 * Il glifo di ogni chip di fatturazione. Mappa STATICA — nessuna icona costruita
 * da un dato. Sta in questo file, e non in `riconciliazione-ui.ts`, perché quello
 * è un modulo `.ts` di logica pura che non importa componenti React.
 */
export const ICONA_CHIP: Record<TonoFatturazione, typeof FileCheck> = {
  fatturata: FileCheck,
  attesa: Clock,
  scartata: AlertTriangle,
  da_fatturare: Receipt,
};

/**
 * IL CHIP DI FATTURAZIONE — UNO SOLO, per la riga della lista e per questo popup.
 *
 * Prima erano due: la riga usava la pelle di `CHIP_FATTURAZIONE` (carta bianca,
 * inchiostro di funzione, glifo), il popup un `Badge` generico senza glifo — e
 * «Da fatturare», che sulla riga è giallo pieno perché è l'unico stato che chiede
 * di agire, nel popup diventava grigio. Lo stesso dato, a due centimetri di
 * distanza, con due significati diversi.
 *
 * `suCarta` aggiunge il solo filetto: il chip «Fatturata» ha fondo bianco e senza
 * contorno sparirebbe dentro la card bianca del popup (sulla riga non serve,
 * perché lì sotto c'è il verde pieno).
 *
 * Esportato perché `RiconciliazionePanel` — che già importa questo file — lo usa
 * sulle righe: la dipendenza va dal pannello al popup, mai al contrario.
 */
export function ChipFatturazione({ fat, suCarta = false }: {
  fat: NonNullable<ReturnType<typeof chipFatturazione>>;
  suCarta?: boolean;
}) {
  const t = useTranslations('adminContabilita');
  const Icona = ICONA_CHIP[fat.tono];
  return (
    <span className={classiChipFatturazione(fat, suCarta)}>
      <Icona size={13} aria-hidden="true" />
      {/* `params` c'è solo quando l'etichetta ha un segnaposto («Fattura {numeri}»):
          passarli sempre è innocuo, ometterli quando servono farebbe LANCIARE
          next-intl — cioè l'intera lista al posto di un chip. */}
      {t(fat.labelKey, fat.params)}
    </span>
  );
}

/**
 * IL CHIP DELLA CODA — UNO SOLO, per la riga e per il popup (consegna 2b, D6/D7). Con
 * `collegamento`, «Errore in coda» è il collegamento alla pagina «Coda fatture». Dentro il
 * `<button>` della riga non si passa MAI `collegamento`: un `<a>` lì dentro è HTML non valido.
 * La riga rende dentro il bottone le etichette («In coda», «In invio») e FUORI, fratello come
 * la casella del lotto, il collegamento dell'errore (`RiconciliazionePanel`).
 */
export function ChipCoda({ stato, suCarta = false, collegamento = false }: {
  stato: StatoCodaAttivo | null | undefined;
  suCarta?: boolean;
  collegamento?: boolean;
}) {
  const t = useTranslations('adminContabilita');
  // Uno stato fuori dai tre non ha pelle e non si mostra (la guardia che stava nel pannello).
  const pelle: PelleCoda | undefined = stato ? (CHIP_CODA as Partial<Record<string, PelleCoda>>)[stato] : undefined;
  if (!pelle) return null;
  if (collegamento && azioneConCoda(stato) === 'vai_alla_coda') {
    return (
      <Link href={CODA_FATTURE_HREF} data-testid="coda-chip" aria-label={t('fatChip_coda_errore_link')}
        className={cx(classiChipCoda(pelle, suCarta), 'min-h-6 underline underline-offset-2')}>
        {t(pelle.labelKey)}
      </Link>
    );
  }
  return <span data-testid="coda-chip" className={classiChipCoda(pelle, suCarta)}>{t(pelle.labelKey)}</span>;
}

/**
 * I due vestiti del «Conferma questo» — e perché ce ne sono due.
 *
 * Normalmente il suggerimento è LA cosa da fare: verde pieno, il CTA della
 * schermata. Quando però l'aggancio forte è su un altro plesso (`altra_sede`),
 * questi candidati sono i deboli di casa: restano — sono l'unica via d'uscita se
 * il segnale sbaglia, un omonimo o un CF finito per errore in un'altra causale — e
 * restano PREMIBILI, ma smettono di essere il CTA. È il peso visivo a rendere
 * facile l'errore, non la loro presenza.
 *
 * Il vestito secondario è quello che «Abbina» usa già qui sotto — LO STESSO, e
 * adesso davvero: contorno verde a riposo, VERDE PIENO in hover.
 *
 * ⚠️ E NON `hover:bg-kidville-green-soft`, che è ciò che c'era scritto qui il
 * 2026-09-07 mentre il commento diceva «Abbina». MISURATO: in Alto Contrasto
 * `hover:bg-kidville-green-soft` non è coperto da NIENTE — la regola
 * `[data-contrast="high"] .kv-recon-dialog .bg-kidville-green-soft` guarda un
 * token di classe DIVERSO e non lo raggiunge — mentre l'inchiostro è già forzato
 * al bianco dalla regola del popup: bianco su verde tenue, **1,19:1**, e il
 * pulsante spariva proprio sotto il puntatore. Col verde PIENO l'inchiostro resta
 * bianco (la regola del popup batte la utility) e sale a 6,5:1, senza toccare
 * `globals.css`, che è condiviso con altri lavori.
 * Lock: `__tests__/pagamenti/riconciliazione-a11y-css.test.ts`, che rifiuta ogni
 * `hover:bg-*` di questo file che non sia scuro o non abbia la sua regola HC — ed
 * è lì che stanno i due numeri, perché in questo file gli hex sono vietati
 * (`__tests__/architecture/design-tokens-admin.test.ts`, commenti compresi).
 */
const CTA_SUGGERIMENTO = 'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill bg-kidville-green px-4 font-maven text-sm font-bold text-kidville-white transition-colors hover:bg-kidville-green-dark disabled:opacity-50';
const CTA_SUGGERIMENTO_DEBOLE = 'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill border-[1.5px] border-kidville-green px-4 font-maven text-sm font-bold text-kidville-green transition-colors hover:bg-kidville-green hover:text-kidville-white disabled:opacity-50';

/**
 * ─── L'AVVISO CHE VIAGGIA SU UNA RISPOSTA 200 ────────────────────────────────
 *
 * `riconciliazione/[id]:PATCH` lo mette accanto a `success: true` quando riapre un
 * bonifico che ha ancora fatture vive. **Non è un errore travestito**: la decisione
 * del titolare (n. 17) è «si riapre SEMPRE, avvisando», non «si vieta». Perciò il
 * server risponde 200 — e finché il popup buttava via il corpo, l'avviso non lo
 * leggeva nessuno. Misurato sul database vivo: 167 riaperture su 174 (96%) hanno
 * una fattura viva, cioè **nessuna** delle riaperture di oggi avviserebbe.
 *
 * I `numeri` stanno in un campo LORO e non solo dentro la frase: si elencano senza
 * fare il parsing di una prosa, che è esattamente il difetto che questo file chiude
 * dall'altra parte (v. `vaRisincronizzato`). `codice` c'è perché la frase sia
 * traducibile come tutte le altre; `messaggio` porta il dettaglio che il catalogo
 * non può conoscere ed è il ripiego se il codice non è riconosciuto.
 */
interface AvvisoRiapertura {
  codice?: string;
  messaggio?: string;
  numeri?: string[];
}

/** Il corpo di una risposta della PATCH, per intero: niente finisce nel cestino. */
interface CorpoAzione {
  success?: boolean;
  error?: string;
  codice?: string;
  data?: {
    stato?: string;
    transazione_annullata?: boolean;
    movimenti_riaperti?: number;
    incassi_stornati?: number;
  } | null;
  avviso?: AvvisoRiapertura | null;
}

/**
 * Che cosa è appena successo, quando c'è qualcosa da RACCONTARE **QUI DENTRO**.
 *
 * Finché è `null` il popup è quello di sempre. Quando è valorizzato, l'abbinamento
 * sparisce: lasciare a schermo «Conferma questo» o la ricerca manuale su un
 * bonifico appena riaperto vorrebbe dire lavorare su uno stato che non c'è più.
 *
 * ⚠️ UN TIPO SOLO, ED È LA RIAPERTURA. La COMPOSIZIONE non passa di qui, ed è una
 * decisione di coordinamento: tre fette sanno raccontarla — il pannello, questo
 * popup, la fascia dell'elenco — e se parlassero insieme la stessa cosa si
 * leggerebbe due volte. Andata bene → parla la fascia dell'elenco (e il popup si
 * chiude); incasso scritto ma riga non legata → parla il pannello, che resta
 * montato. In tutt'e due i casi questo riquadro non c'entra.
 *
 * Resta un'unione con un ramo solo perché la riapertura è ciò che il popup è
 * l'unico a sapere: `movimenti_riaperti`, `incassi_stornati` e l'avviso delle
 * fatture vive arrivano sulla risposta della PATCH e non hanno nessun'altra strada
 * per arrivare all'operatrice.
 */
type EsitoAzione = { tipo: 'riapertura'; righeRiaperte: number; incassiStornati: number; avviso: AvvisoRiapertura | null };

/**
 * ─── QUANDO LA LISTA VA RILETTA, E PERCHÉ NON LO DECIDE PIÙ UNA FRASE ───────
 *
 * Fino al 2026-09-13 qui c'era `/operatore|confermato/i.test(msg)`: la lista si
 * risincronizzava solo se la frase MOSTRATA conteneva una di quelle due parole.
 * Era un'euristica sul testo TRADOTTO, con tre difetti misurati:
 *
 *  · era già cieca in inglese — «Someone else has just changed this bank transfer»
 *    non contiene «operatore»;
 *  · è cieca sulla frase nuova `RIAPERTURA_STORNATA_NON_RIAPERTA` in TUTT'E DUE le
 *    lingue, ed è la peggiore su cui essere ciechi: dichiara uno storno GIÀ
 *    REGISTRATO, cioè proprio il caso in cui la lista a schermo è falsa;
 *  · e legava una decisione di programma alle parole di un file di traduzione, che
 *    cambia per ragioni che non c'entrano niente con questo codice.
 *
 * Adesso decide lo STATO HTTP, che è il posto dove quel fatto è dichiarato: **409
 * significa «la richiesta è in conflitto con lo stato attuale della risorsa»**, e
 * ogni 409 di questa rotta è esattamente quello — la corsa persa del CAS, il
 * movimento già confermato, la transazione sparita, lo storno registrato senza
 * riapertura, la voce già saldata sotto ai piedi. In tutti, ciò che il popup ha in
 * mano è vecchio. Rileggere è gratis e non toglie nulla: l'errore resta a schermo e
 * il popup non si chiude.
 *
 * ⚠️ NON è «rileggi sempre»: un 500 o un 503 non dicono che lo stato è cambiato,
 * dicono che non si è potuto fare. Lì la lista resta quella che è. E la
 * distinzione avviene DAVVERO: questa funzione è chiamata su ogni risposta non-ok,
 * non dentro un ramo che ha già scelto il 409 al posto suo. Vedi `azione`.
 *
 * ⚠️ E PERCHÉ LO STATO E NON IL `codice`, visto che la consegna diceva «guarda il
 * codice». Perché un elenco di codici sarebbe stato la stessa euristica con un
 * vestito migliore: **CINQUE dei nove 409 di questa rotta non hanno nessun
 * codice**. Contati uno per uno su `riconciliazione/[id]/route.ts`, col loro
 * indirizzo, perché un numero scritto a memoria è il difetto che questo blocco
 * racconta:
 *   · `:356` «Movimento già confermato: stornare prima l'incasso»
 *   · `:788` «Movimento già confermato»
 *   · `:917` «Pagamento già saldato: ignora la riga o scegli un'altra voce»
 *   · `:923` «L'importo del bonifico supera il residuo»
 *   · `:962` «Movimento già riconciliato da un altro operatore»
 * Gli altri quattro (`:539`, `:550`, `:719`, `:878`) ce l'hanno. I due che la
 * frase pescava per caso, in italiano, sono `:788` e `:962`: sono fra i ciechi.
 * Su tutti e cinque un controllo sul codice sarebbe nato cieco il giorno stesso, e
 * la prova sarebbe stata verde perché i test li avrebbero scritti con il codice.
 * Lo stato c'è sempre, lo manda il server, e nessuna traduzione lo può cambiare.
 *
 * ⚠️ E SUL ROVESCIO — «risincronizzare su un 409 che non l'ha chiesto fa danno?» —
 * la risposta è no, su tutti e nove: `onDone()` nudo è una rilettura della lista e
 * nient'altro, l'errore resta a schermo e il popup non si chiude. Il costo è una
 * GET; il costo di non farlo è lavorare su uno stato che non c'è più.
 *
 * Contro-prova eseguita, non dedotta: rimessa l'euristica vecchia, i tre test del
 * blocco «il 409 si risincronizza sul CODICE, mai sulla frase» diventano rossi con
 * «expected onDone to be called at least once», e gli altri due restano verdi.
 */
const vaRisincronizzato = (stato: number): boolean => stato === 409;

/**
 * ─── IL GIALLO CHE NON HA NESSUN'ALTRA STRADA ────────────────────────────────
 *
 * «Alunno riconosciuto, nessuna voce aperta» è l'unico esito su cui la
 * composizione NASCE APERTA. Non è una preferenza di comodo: su quella riga il
 * bambino è noto e le voci non ci sono, quindi non c'è nessun suggerimento da
 * confermare e la ricerca fra le voci aperte non può restituire niente. Comporre
 * è l'unica strada, e il pannello chiuso la nasconde dietro un pulsante.
 *
 * ⚠️ OVUNQUE ALTROVE RESTA CHIUSO, e il motivo sta scritto su `componiAperto`:
 * il pannello si carica da sé (contesto, figli, categorie, pacchetti mensa), e
 * montarlo sempre vorrebbe dire pagare quella lettura su ogni riga aperta,
 * comprese le novantanove su cento che si chiudono con un «Conferma questo».
 *
 * ⚠️ IL RAMO È DIETRO UN CONTROLLO DIFENSIVO PERCHÉ IL CAMPO NON È ANCORA SULLA
 * RIGA — ma il suo NOME, dal 2026-09-20, NON si indovina più: si legge.
 * `RisultatoMatch` lo dichiara in `src/lib/pagamenti/riconciliazione.ts`
 * (`motivo_stato?: MotivoStato`, UNA stringa; `alunni_senza_voci?: string[]`), e
 * il commento del terzo parametro di quel file dichiara testualmente a che cosa
 * serve: «così che il pannello possa aprirsi sulla composizione già puntata su
 * quel bambino». Quel pannello è questo. Fino a quel giorno qui si leggevano
 * quattro nomi PLAUSIBILI e nessuno dei due veri: il campo sarebbe atterrato con
 * il lotto tutto verde e la funzione non sarebbe partita — il «segnale falso» di
 * `silenzio_assente_vs_segnale_falso.md`.
 *
 * Perciò il literal qui sotto è tipato contro TUTT'E DUE i tipi veri:
 * `MotivoRinuncia` del motore (`valutaCertezza`) e `MotivoStato` del matcher. Un
 * rinominio da una qualunque delle due parti diventa rosso in `tsc`, non un
 * giallo che smette in silenzio di aprirsi.
 *
 * ⚠️ E SI LEGGONO SOLO I DUE NOMI VERI. Per un giro qui ne stavano accanto altri
 * quattro (`certezza.motivi`, `motivi_certezza`, `certezza.alunni`,
 * `alunni_riconosciuti`), tenuti «perché costano una riga». Costavano di più: un
 * `grep` su `src/` e `__tests__/` li trovava soltanto qui e nella prova che se li
 * fabbricava da sola, cioè erano letture morte esercitate da prove su dati che
 * nessun produttore scrive — conteggio gonfiato, copertura zero. Il campo vero è
 * tipato e `tsc` lo difende: un ripiego non tipato accanto a un nome tipato non è
 * una rete di sicurezza, è il posto dove un rinominio si nasconde. Finché il campo
 * non viaggia fin qui, `motiviDelVerdetto` ritorna un elenco vuoto, la condizione
 * è falsa e il popup si comporta esattamente come prima: nessun cambiamento di
 * comportamento e nessun `any`.
 */
const MOTIVO_SENZA_VOCI: MotivoRinuncia & MotivoStato = 'alunno_senza_voci_aperte';

/** Le stringhe di un array sconosciuto, senza `any` e senza fidarsi della forma. */
const soloStringhe = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];

/** Una stringa sola, dove il campo ne porta UNA e non un elenco (`motivo_stato`). */
const soloStringa = (v: unknown): string[] => (typeof v === 'string' && v !== '' ? [v] : []);

/** I motivi del verdetto automatico, se la riga li porta. Vuoto = non lo so. */
function motiviDelVerdetto(m: MovimentoUi): string[] {
  const riga = m as unknown as {
    /** Il nome VERO, da `RisultatoMatch`: una stringa sola, non un elenco. */
    motivo_stato?: unknown;
  };
  return soloStringa(riga.motivo_stato);
}

/**
 * La composizione nasce aperta? Solo sul giallo «alunno riconosciuto, nessuna
 * voce aperta», e solo se si sa SU CHI puntarla: aprirla senza bambini
 * rimetterebbe in piedi il difetto di partenza (contesto vuoto → nessun candidato
 * → «Conferma» spento) con in più la lettura pagata su una riga qualunque.
 */
function nasceAperta(m: MovimentoUi): boolean {
  if (m.stato === 'confermato' || m.stato === 'ignorato') return false;
  if (!motiviDelVerdetto(m).includes(MOTIVO_SENZA_VOCI)) return false;
  return alunniDelVerdetto(m).length > 0;
}

/**
 * I bambini che il verdetto ha riconosciuto su questa riga. Dai suggerimenti —
 * che è il campo che esiste oggi — più l'elenco del verdetto, se arriva.
 * Deduplicati, perché su un bonifico di famiglia lo stesso bambino compare in più
 * di un candidato.
 *
 * Il nome VERO è `alunni_senza_voci` (`RisultatoMatch`, stesso file del motivo), e
 * porta SOLO gli uuid: il codice fiscale che li ha fatti riconoscere non esce da
 * lì, come non esce da `…/riconciliazione/alunni`. È l'unico nome letto, per la
 * ragione scritta sopra su `motivo_stato`.
 */
function alunniDelVerdetto(m: MovimentoUi): string[] {
  const riga = m as unknown as {
    /** Il nome VERO, da `RisultatoMatch`: uuid, mai il CF. */
    alunni_senza_voci?: unknown;
  };
  const daiSuggerimenti = (m.suggerimenti ?? [])
    .map((s) => s.alunno_id)
    .filter((a): a is string => typeof a === 'string' && a !== '');
  return [...new Set([...soloStringhe(riga.alunni_senza_voci), ...daiSuggerimenti])];
}

/** Pill «CF» dell'aggancio per codice fiscale (su card bianca del dialog). */
function CfPill() {
  const t = useTranslations('adminContabilita');
  return (
    <span className="rounded-pill bg-kidville-green px-2 py-1 font-barlow text-[10px] font-extrabold uppercase leading-none text-kidville-white">
      {t('movdlgBadgeCf')}
    </span>
  );
}

/**
 * IL VESTITO DI UN AVVISO, dentro un riquadro che sta già raccontando un successo.
 *
 * Stessa ricetta del riquadro «questo bonifico sembra di un'altra sede», e per la
 * stessa ragione: il peso lo danno un FILETTO da 4px, un GLIFO e l'INCHIOSTRO
 * d'avviso — non il fondo, che resta quello del riquadro che lo ospita. Un avviso
 * col vestito di ciò che informa è una nota, non un avviso.
 *
 * ⚠️ MAI il rosso: qui non è fallito niente. La composizione è stata registrata e
 * la riapertura è avvenuta; ciò che resta da sapere è una CONSEGUENZA, non un
 * errore. Dipingerla di rosso inviterebbe a ripremere, che è precisamente il gesto
 * da cui l'avviso del «non legato» mette in guardia.
 *
 * ⚠️ E PORTA `kv-recon-avviso-sede`, che fino al 2026-09-13 questo commento
 * dichiarava di NON volere. La ragione scritta allora era: «in Alto Contrasto il
 * fondo crema diventa il grigio scurissimo e `warn-strong` ci vale 5,62:1, sopra
 * i 4,5:1 di WCAG 1.4.3». **Quel 5,62 non era di questa coppia.** Ricalcolato con
 * la formula del lock `riconciliazione-a11y-css.test.ts`, `warn-strong` sulla
 * superficie scura del popup vale **3,10:1** — SOTTO soglia — e l'etichetta dei
 * numeri qui sotto è a 11px extra-grassetto, cioè testo NORMALE per WCAG (il
 * «testo grande» parte da 18pt, o 14pt in grassetto): i 3:1 del testo grande non
 * la riguardano. Il 5,62 è il rapporto di `error-strong` sul BIANCO, ed era già
 * scritto sbagliato in `globals.css`: una decisione appoggiata su un numero che
 * nessuno aveva misurato, preso per buono perché stava scritto.
 *
 * La classe non è un'appropriazione: quella regola dipinge d'ambra il filetto e
 * l'inchiostro d'avviso di QUALUNQUE riquadro del popup che la porti — **10,12:1**
 * sul nero — ed è esattamente ciò che serve qui. I due riquadri non coesistono mai
 * a schermo (l'altra sede vive nell'abbinamento, questo lo sostituisce), e
 * `globals.css` — condiviso con altri lavori — non si tocca: era la ragione
 * dichiarata per non farlo, e resta soddisfatta.
 */
function AvvisoEsito({ testo, etichettaNumeri, numeri }: {
  testo: string;
  etichettaNumeri?: string;
  numeri?: string[];
}) {
  const elenco = numeri ?? [];
  return (
    <div className="kv-recon-avviso-sede mt-4 flex gap-3 border-l-4 border-kidville-warn-strong pl-3">
      {/* `aria-hidden`: il glifo ripete ciò che la frase dice per esteso. */}
      <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-kidville-warn-strong" />
      <div className="min-w-0">
        {/* Mai `text-kidville-muted` (2,51:1): c'è un lock, e il motivo è che non si legge. */}
        <p className="font-maven text-xs leading-relaxed text-kidville-sub">{testo}</p>
        {/* I NUMERI, elencati perché arrivano in un campo loro: nessun parsing di
            prosa, e nessun elenco vuoto quando il server non ha potuto leggerli. */}
        {elenco.length > 0 && (
          <>
            {/* L'occhiello prende l'inchiostro dell'avviso, non il verde: in Alto
                Contrasto il verde di questo popup diventa il giallo di segnale, e
                quel giallo qui dentro è di ciò che si preme. */}
            {etichettaNumeri && (
              <p className={cx(OCCHIELLO_TIPO, 'mt-4 block text-kidville-warn-strong')}>{etichettaNumeri}</p>
            )}
            {/* ⚠️ IL FILETTO NON È UN ORNAMENTO: È CIÒ CHE TIENE IN VITA LA
                PILLOLA IN ALTO CONTRASTO. `bg-kidville-white` dentro il popup
                diventa il grigio scurissimo, e la sezione che ospita questo
                elenco è già quel grigio: **1,00:1**, cioè la pillola sparisce e
                l'elenco dei documenti diventa una fila di parole. Il testo si
                legge lo stesso (l'inchiostro passa a bianco), ma perde la forma
                che dice «questi sono numeri di documento, uno per uno».
                Il criterio è già scritto in `globals.css` accanto alle fasce
                piene di stato — «due neri vicini si separano col filetto e non
                più col colore» — e `border-kidville-line` è il solo filetto che
                la regola di Alto Contrasto del popup ridipinge (a bianco, 17,4:1
                su quel fondo). Nessuna riga nuova nel foglio condiviso. */}
            <ul className="mt-2 flex flex-wrap gap-2">
              {elenco.map((n) => (
                <li key={n} className="rounded-pill border border-kidville-line bg-kidville-white px-2 py-1 font-maven text-xs font-bold text-kidville-ink">{n}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * IL RIQUADRO DELL'ESITO — ciò che il popup, fino al 2026-09-13, buttava via.
 *
 * Due specie, un solo posto: la composizione appena registrata e la riapertura
 * appena avvenuta. Vivono qui e non dentro `MovimentoDialog` perché quel corpo è
 * già lungo, e perché questo riquadro non ha bisogno di nient'altro che del proprio
 * esito — nessuno stato, nessuna fetch.
 *
 * ⚠️ La composizione NON ha un occhiello suo: la sua frase si apre già con
 * «Pagamento registrato», e un titolo che ripetesse quelle due parole direbbe lo
 * stesso stato due volte a due centimetri di distanza. La riapertura invece ha un
 * occhiello, perché le sue righe sono CONTEGGI e da soli non dicono di che cosa
 * siano il conto.
 */
function PannelloEsito({ esito }: { esito: EsitoAzione }) {
  const t = useTranslations('adminContabilita');
  const { righeRiaperte, incassiStornati, avviso } = esito;
  return (
    <section role={avviso ? 'alert' : 'status'} className="rounded-card bg-kidville-cream p-4">
      <h3 className={OCCHIELLO}>{t('reconComponiEsitoRiaperto')}</h3>
      {/* I due conteggi che il server manda e che nessuno leggeva. Si mostrano solo
          se dicono qualcosa: «0 incassi stornati» è rumore su una riga che non
          aveva incassi. */}
      {(righeRiaperte > 0 || incassiStornati > 0) && (
        <ul className="mt-2 space-y-1 font-maven text-sm text-kidville-ink">
          {righeRiaperte > 0 && <li>{t('reconComponiEsitoRigheRiaperte', { n: righeRiaperte })}</li>}
          {incassiStornati > 0 && <li>{t('reconComponiEsitoIncassiStornati', { n: incassiStornati })}</li>}
        </ul>
      )}
      {/* La decisione n. 17 è «riapri comunque, AVVISANDO»: ecco l'avvisando.
          Frase dal `codice` (traducibile come tutte le altre), numeri dal campo
          `numeri` — che il server tiene separato dalla prosa apposta. */}
      {avviso && (
        <AvvisoEsito
          testo={messaggioDaCorpo({ error: avviso.messaggio, codice: avviso.codice }, t('reconComponiEsitoFattureVive'))}
          etichettaNumeri={t('reconComponiEsitoFattureVive')}
          numeri={avviso.numeri}
        />
      )}
    </section>
  );
}

export function MovimentoDialog({ movimento, aperti, userId, onClose, onDone, returnFocusRef, onIncassoUnico }: Props) {
  const t = useTranslations('adminContabilita');
  const f = useDateFormat();
  // Data breve localizzata (IT identica a `toLocaleDateString('it-IT')`); '—' se assente.
  const dataIt = (d?: string | null) => (d ? f.dataBreve(d) : '—');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ricerca, setRicerca] = useState('');
  // Stato del pagamento collegato: serve solo ai movimenti confermati per capire
  // se mostrare la Fattura (saldato) o la nota «Disponibile a saldo avvenuto».
  const [pagamentoStato, setPagamentoStato] = useState<string | null>(null);
  /**
   * Stato di FATTURAZIONE del pagamento collegato. Arrivava già nella stessa
   * risposta e veniva buttato via: senza, `FatturaButton` riparte da
   * `'non_richiesta'` e dice «Invia fattura» anche su un pagamento già
   * fatturato — chi lo preme riceve un 409 che non spiega niente.
   */
  const [pagamentoFattura, setPagamentoFattura] = useState<string | null>(null);
  const [loadingPag, setLoadingPag] = useState(movimento.stato === 'confermato' && !!movimento.pagamento_id);
  /**
   * ⚠️ IL SEGNALE DI RILETTURA — perché il popup possa rileggere CIÒ CHE HA APPENA
   * CAMBIATO.
   *
   * `pagamentoStato` e `pagamentoFattura` sono stato locale caricato una volta al
   * montaggio, e `onEmessa` era cablato dritto a `onDone`: quello ricarica la
   * LISTA, e la lista non riscrive `selezionato` — cioè la prop da cui questo
   * popup è nato. Risultato misurato in collaudo: emessa la fattura, il popup
   * restava a «Da fatturare», con la frase «non è ancora stata emessa» e il
   * pulsante dipinto da CTA, a due centimetri dal badge «In attesa SDI» che il
   * pulsante stesso aveva appena mostrato. Lo stesso stato, detto due volte e in
   * due modi opposti.
   *
   * Un contatore, e non un secondo `fetch` scritto dentro `onEmessa`: la lettura
   * esiste già qui sotto, con la sua guardia `active`, il suo `catch` che LOGGA e
   * il suo `finally`. Duplicarla vorrebbe dire due copie della stessa richiesta da
   * tenere allineate. E non costa una richiesta in più all'apertura: l'effetto
   * riparte solo quando questo numero cambia, cioè dopo un'emissione riuscita
   * (lock: «aprire il popup costa UNA lettura sola»).
   */
  const [ricarica, setRicarica] = useState(0);
  /**
   * Il pannello «Componi il pagamento» è CHIUSO all'apertura, e non è pigrizia:
   * si carica da sé (contesto, figli, categorie, pacchetti mensa) e montarlo
   * sempre vorrebbe dire pagare quella lettura su ogni riga aperta, comprese le
   * novantanove su cento che si chiudono con un «Conferma questo».
   */
  const [componiAperto, setComponiAperto] = useState(() => nasceAperta(movimento));
  /**
   * I bambini su cui puntare la composizione: l'IDENTITÀ di ciò su cui si lavora,
   * non un dato (vedi la testata di `ComposizioneBonifico`). Nasce dal verdetto —
   * il giallo «alunno riconosciuto, nessuna voce aperta» apre già puntato — e
   * cambia quando si preme «Componi per questo bambino» su una riga della ricerca.
   */
  const [alunniComponi, setAlunniComponi] = useState<readonly string[]>(() =>
    nasceAperta(movimento) ? alunniDelVerdetto(movimento) : [],
  );
  /**
   * «Su questo bonifico il denaro è già stato scritto», e serve a una cosa sola: a
   * non riportare all'abbinamento chi chiude il pannello dopo una composizione
   * registrata ma non legata. Vedi `onChiudi`, più sotto.
   */
  const [composto, setComposto] = useState(false);
  /** Che cosa è appena successo. Vedi `EsitoAzione`: finché è `null`, popup di sempre. */
  const [esito, setEsito] = useState<EsitoAzione | null>(null);
  /**
   * ⚠️ IL RIENTRO DEL FUOCO, CHIUSO IL PANNELLO (WCAG 2.4.3).
   *
   * MISURATO: premuto «Chiudi» dentro il pannello, il pulsante che aveva il fuoco
   * viene smontato e `document.activeElement` finisce su `<body>`. Il focus-trap
   * del `Modal` lo recupera al primo Tab — quindi non si esce dalla finestra — ma
   * chi naviga da tastiera riparte dall'inizio del dialog, e l'unico posto sensato
   * dove tornare è il pulsante da cui si era entrati.
   *
   * ⚠️ E SOLO PER QUELLA VIA D'USCITA, che è il motivo del flag. Quando la
   * composizione riesce il popup si CHIUDE, e lì il fuoco è del `returnFocusRef`
   * del `Modal` (la riga della lista): prenderglielo per darlo a un pulsante che
   * sta smontando sarebbe una seconda regressione al posto della prima. Il flag è
   * un `ref` e non uno stato perché non deve far ridisegnare niente — e perché un
   * `setState` dentro l'effetto che lo consuma è proprio ciò che
   * `react-hooks/set-state-in-effect` vieta in questo repo.
   */
  const componiBtnRef = useRef<HTMLButtonElement | null>(null);
  const rientraSuComponi = useRef(false);
  useEffect(() => {
    if (componiAperto || !rientraSuComponi.current) return;
    rientraSuComponi.current = false;
    componiBtnRef.current?.focus();
  }, [componiAperto]);

  const stato = movimento.stato;
  const puoAbbinare = stato !== 'confermato';
  const isConfermato = stato === 'confermato';
  const isIgnorato = stato === 'ignorato';
  /**
   * C'È DAVVERO QUALCOSA DA FARE, IN QUESTA FINESTRA?
   *
   * Le due colonne hanno una premessa: «il FATTO a sinistra, il LAVORO a destra».
   * Su un movimento già confermato il lavoro non esiste — `puoAbbinare` è falso e
   * la colonna di destra resta un guscio: un `region` annunciato «Abbina» con
   * dentro NIENTE. Chi naviga per landmark ci finisce dentro e trova il vuoto, col
   * nome di un comando che lì non c'è; e a `lg` il binario `1fr` resta vuoto anche
   * lui, così il riquadro Documenti vive nei 22rem del binario sinistro — più
   * stretto di com'era nella card da 512px, dentro un popup grande quanto lo
   * schermo. Dove il lavoro non c'è, i binari tornano uno solo e l'`aside` prende
   * tutta la larghezza.
   *
   * `error` ed `esito` sono di stato e arrivano DOPO: su un confermato si può
   * premere «Riapri», e la frase che ne racconta l'esito vive in questa colonna.
   * Perciò la premessa si ricalcola a ogni render, non si decide sullo stato
   * iniziale del movimento.
   */
  const haLavoro = Boolean(error) || Boolean(esito) || puoAbbinare;
  const suggerimenti = movimento.suggerimenti ?? [];
  const multiCf = movimentoMultiCf(suggerimenti);
  /**
   * «Questo bonifico sembra di un'altra sede»: il verdetto lo calcola il server
   * (`agganciaFuoriSede`, stesse soglie del matcher) sui candidati di TUTTE le
   * sedi — cioè su un'informazione che qui non c'è più, perché la lista che
   * arriva è già minimizzata per sede. `null`/assente = no, o non si è potuto
   * guardare: in entrambi i casi la schermata è quella di sempre.
   */
  const altraSede = movimento.altra_sede ?? null;

  // Dettaglio del pagamento (solo movimenti confermati): stesso pattern di
  // PagamentoDrawer — setState solo in try (guardato da `active`) e in finally,
  // MAI nel catch (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (stato !== 'confermato' || !movimento.pagamento_id) return;
    let active = true;
    (async () => {
      try {
        const r = await fetch(`/api/pagamenti/${movimento.pagamento_id}?userId=${userId}`, { headers: hdr(userId) });
        const j = await r.json();
        if (active && j?.success) {
          const d = j.data as { stato?: string; fattura_stato?: string } | null;
          setPagamentoStato(d?.stato ?? null);
          // Assente su una risposta più vecchia: si degrada a `null` e il
          // pulsante torna a comportarsi come prima, senza rompersi.
          setPagamentoFattura(d?.fattura_stato ?? null);
        }
      } catch (err) {
        // Il dialog resta usabile senza lo stato: si logga, non si rompe.
        logClient({ livello: 'error', evento: 'fetch', messaggio: `pagamento-stato-fattura-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      } finally {
        if (active) setLoadingPag(false);
      }
    })();
    return () => { active = false; };
  }, [stato, movimento.pagamento_id, userId, ricarica]);

  const azione = useCallback(async (az: 'conferma' | 'ignora' | 'riapri', pagamentoId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/pagamenti/riconciliazione/${movimento.id}`, {
        method: 'PATCH',
        headers: hdr(userId),
        body: JSON.stringify({ azione: az, pagamento_id: pagamentoId }),
      });
      // Nessun catch muto sul parse: un corpo non-JSON risale al catch che LOGGA.
      const j = (await r.json()) as CorpoAzione;
      /**
       * ⚠️ UN RAMO SOLO PER TUTTE LE RISPOSTE CHE NON SONO ANDATE, ed è ciò che
       * rende `vaRisincronizzato` una DECISIONE invece di una tautologia. Fino al
       * 2026-09-13 il 409 aveva un `if` tutto suo e la funzione veniva chiamata
       * DENTRO, cioè in un punto dove lo stato poteva essere solo 409: su un 500
       * non veniva invocata affatto. MISURATO: mutandola in `stato >= 400`
       * restavano 82 test su 82 verdi, e toglierla del tutto pure. Il suo ⚠️ qui
       * sotto descriveva una distinzione che in quel punto non avveniva.
       * Ora la valuta ogni risposta non-ok, e il test del 500 diventa rosso se la
       * soglia si allarga.
       *
       * Il RIPIEGO resta diverso per i due casi, e non è un dettaglio: «operazione
       * non possibile in questo momento» dice che lo stato del server non la
       * permette — su un guasto sarebbe falso; «errore nell'operazione» su un
       * conflitto direbbe «qualcosa si è rotto» a chi deve solo ricaricare. Si
       * vede solo col corpo muto: appena c'è una prosa o un codice riconosciuto,
       * `messaggioDaCorpo` non arriva mai fin qui.
       */
      if (!r.ok || !j.success) {
        setError(messaggioDaCorpo(j, r.status === 409 ? t('movdlgOperazioneNonPossibile') : t('movdlgErroreOperazione')));
        // Lo stato sul server non è più quello che questo popup crede: si rilegge.
        // Il PERCHÉ — e perché non è più la frase a deciderlo — sta su `vaRisincronizzato`.
        if (vaRisincronizzato(r.status)) onDone();
        return;
      }
      onDone();
      /**
       * ⚠️ IL CORPO DI UNA RIAPERTURA NON SI BUTTA VIA. Qui c'era `onClose()` e
       * basta: `data` (quante righe bancarie sono tornate in coda, quanti incassi
       * sono stati stornati) e `avviso` (le fatture rimaste vive) esistevano, e non
       * li leggeva nessuno — con il popup che si chiudeva un istante dopo.
       * Chiudere è giusto solo quando non c'è niente da dire: è il caso del
       * movimento IGNORATO, che torna in coda senza storni e risponde `{ success:
       * true }` nudo. Un avviso che comparisse sempre smetterebbe di essere un
       * avviso; uno che non compare mai non è mai esistito.
       */
      if (az === 'riapri' && (j.data || j.avviso)) {
        setEsito({
          tipo: 'riapertura',
          righeRiaperte: Number(j.data?.movimenti_riaperti ?? 0),
          incassiStornati: Number(j.data?.incassi_stornati ?? 0),
          avviso: j.avviso ?? null,
        });
        return;
      }
      onClose();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `riconciliazione-${az}-fallita: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError(t('movdlgErroreRete'));
    } finally {
      setBusy(false);
    }
  }, [movimento.id, userId, onDone, onClose, t]);

  /**
   * «Componi per questo bambino»: apre il pannello PUNTATO su di lui.
   *
   * ⚠️ SOSTITUISCE, non somma. Il bersaglio dichiarato da qui è uno — quello che
   * si è appena premuto — e un elenco che cresce a ogni click farebbe comporre su
   * bambini scelti tre ricerche fa, senza che si veda. Aggiungerne altri si fa
   * DENTRO il pannello, dove l'elenco di chi è in composizione è a schermo e si
   * può togliere.
   */
  const componiPerAlunno = useCallback((alunnoId: string) => {
    setAlunniComponi([alunnoId]);
    setComponiAperto(true);
  }, []);

  const q = ricerca.trim().toLowerCase();
  const apertiFiltrati = (q.length === 0 ? aperti : aperti.filter((p) => testoRicercaPagamento(p).includes(q))).slice(0, 25);
  // P5b: con i pagamenti aperti di più sedi nella stessa lista la voce nomina il
  // plesso. Si decide sull'elenco INTERO e non su quello filtrato: la sede non deve
  // comparire e sparire mentre si digita.
  const opzioniLabel = {
    sede: apertiDiPiuSedi(aperti),
    senzaNome: t('reconFiltroSedeSenzaNome'),
    senzaSede: t('reconFiltroSedeNonRiconosciuta'),
  };

  /**
   * ─── UNA CASELLA SOLA, DUE GRUPPI ────────────────────────────────────────
   *
   * Il filtro sulle VOCI APERTE resta quello di prima — locale, istantaneo, sulla
   * lista che la pagina ha già in mano — ed è il 90% del lavoro: non deve
   * rallentare di un millisecondo perché accanto è comparso un secondo gruppo. La
   * ricerca degli ALUNNI passa dalla rotta, con la sua soglia e il suo debounce
   * (`use-ricerca-alunni`), e serve al caso opposto: il bambino che una voce
   * aperta non ce l'ha, e che quindi in quella lista non potrebbe comparire mai.
   *
   * Due caselle sarebbero state due posti dove cercare la stessa cosa.
   */
  const ricercaAlunni = useRicercaAlunni(ricerca, userId);
  const uid = useId();
  const idAiutoRicerca = `${uid}-aiuto-ricerca`;

  /**
   * La frase della regione viva del gruppo «Alunni». QUALI frasi — quattro, non
   * tre — sta in `use-ricerca-alunni`, accanto alla ricerca che le produce: era
   * scritta due volte, identica, anche nel pannello (`ComposizioneBonifico`), e le
   * due copie divergevano già in silenzio (misurato: cambiato «Sto cercando» in
   * tutt'e due, centodiciannove prove restavano verdi). Si chiama al render e
   * prende `t`, che quindi non entra in nessuna dipendenza.
   */
  const fraseRicerca = fraseRicercaAlunni(ricercaAlunni, t);

  const saldato = isConfermato && pagamentoStato === 'pagato';
  /**
   * Il chip di questo popup nasce dalla STESSA funzione della riga della lista:
   * una sola tabella di verità, quindi il popup non può dire «Da fatturare» dove
   * la riga dice altro. `pagamentoFattura` arriva dal dettaglio del pagamento e
   * su una risposta vecchia è `null` → nessun chip, nessuna frase, e le azioni
   * restano quelle di prima (degradazione pulita).
   */
  // Gli stessi campi della riga: così il popup dice «Fattura FPR 1947/26» come la lista,
  // e non un generico «Fatturata» a due centimetri dal numero del documento.
  const fat = chipFatturazione({
    fattura_stato: (pagamentoFattura as StatoFattura | null) ?? null,
    pagamento_stato: pagamentoStato,
    fattura: movimento.fattura ?? null,
    pagamento_id: movimento.pagamento_id ?? null,
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t('movdlgTitoloMovimento')} ${dataIt(movimento.data_operazione)}`}
      labelledBy={TITLE_ID}
      /* ⚠️ `safeArea` NASCE CON LA CARD GRANDE, e non è una svista rimediata: a
         512px e centrata, la card stava lontana dal notch e dall'home indicator
         per costruzione: nessuna imbottitura serviva. Al 95% dello schermo tocca
         i bordi, e su iPhone il bordo di sopra è coperto dal notch e quello di
         sotto dalla barra di gesto — cioè la ✕ della testa e i pulsanti del piede,
         che sono le due cose da cui si esce. La prop esiste già su `Modal`: qui
         la si usa, non la si aggiunge. */
      safeArea
      /* `kv-recon-dialog` è l'àncora dell'Alto Contrasto (globals.css): senza,
         in HC il popup resta la stessa carta bianca della luce normale, perché
         `@theme inline` inlina gli hex e nessun rimappaggio di token lo tocca.

         ⚠️ QUESTO POPUP NON È UN MESSAGGIO, È UN BANCO DI LAVORO, e fino al
         2026-09-19 aveva la card dei messaggi: `max-w-md` + `sm:max-w-lg`, cioè
         **512px anche su un monitor da 2560**. Dentro ci stavano causale,
         avvisi, suggerimenti, l'INTERO form di composizione con le sue griglie e
         una lista con un secondo scorrimento annidato: tutto in colonna, tutto
         dentro la stessa card che scorreva — «Chiudi» compreso, che era in fondo
         a quel rotolo. Ora la card è quasi a tutto schermo (decisione del
         titolare: ~95%, margine sottile, **resta un popup**) e dentro ha tre
         fasce: testa e piede fissi, il corpo che scorre.

         Il tetto d'altezza NON è sparito, ha cambiato forma: sta in
         `MODAL_CARD_QUASI_SCHERMO` (`h-[95dvh] max-h-full`) e insieme
         all'`overflow-hidden` della card è ciò che tiene il piede dove si vede.
         Il `calc(100dvh-2rem)` che c'era qui non si poteva tenere: sottraeva a
         mano il `p-4` del contenitore di `Modal`, e con `safeArea` quella
         imbottitura non è più 2rem — è `max(1rem, env(safe-area-inset-*))`, un
         numero che dipende dal telefono. Il perché per esteso sta sulla costante. */
      className={cx(MODAL_CARD_QUASI_SCHERMO, 'kv-recon-dialog')}
      style={{ boxShadow: MODAL_SHADOW }}
      returnFocusRef={returnFocusRef}
    >
      {/* ── Intestazione: UN punto focale, la cifra ──────────────────────────
          L'occhiello «Movimento bancario» che stava qui sopra è stato tolto, e
          non per fare spazio: diceva ciò che la riga sotto dice meglio
          («Bonifico del 04/09/2026»), e in Alto Contrasto era uno dei sei
          elementi gialli che avevano tolto al giallo il suo significato.
          Toglierlo sistema anche l'allineamento della ✕, che con tre righe di
          testo a sinistra finiva otticamente in mezzo a due di esse: adesso la ✕
          vive nella STESSA riga flex della cifra, quindi è allineata per
          costruzione e non per una misura da riazzeccare a ogni modifica.

          ⚠️ ED È UNA FASCIA FISSA, non più il primo pezzo di ciò che scorre.
          La cifra è l'unica cosa che dice QUANTO si sta incassando: scorreva via
          al primo suggerimento, e con lei la ✕. `shrink-0` perché in una colonna
          flex una fascia si lascia comprimere dal corpo se il corpo cresce. */}
      <div data-testid="movdlg-testa" className="shrink-0 border-b border-kidville-line p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 id={TITLE_ID} className="min-w-0 font-barlow text-2xl font-black uppercase leading-none text-kidville-green">
            {formatEuro(movimento.importo)}
          </h2>
          {/* 44×44 (WCAG 2.5.8): era 28×28. E l'etichetta è «Chiudi il movimento»,
              non «Chiudi»: il piede ha già un bottone «Chiudi», e due comandi con
              lo stesso nome accessibile nella stessa finestra non si distinguono.
              `-mr-2` riporta il glifo all'angolo: cresce l'area toccabile, non il
              vuoto attorno. Mai `text-kidville-muted` (3,80:1). */}
          <button type="button" onClick={onClose} aria-label={t('movdlgChiudiDettaglio')}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-kidville-sub transition-colors hover:bg-kidville-neutral-soft hover:text-kidville-ink">
            <X size={20} />
          </button>
        </div>
        <p className="mt-2 font-maven text-xs text-kidville-sub">{t('movdlgBonificoDel')} {dataIt(movimento.data_operazione)}</p>
      </div>

      {/* ── IL CORPO: l'unica cosa che scorre ────────────────────────────
          `min-h-0` non è decorativo: senza, un figlio flex non si comprime
          sotto il proprio contenuto (`min-height: auto`), la fascia cresce
          quanto ciò che contiene e a scorrere torna la card intera — cioè
          esattamente il difetto che queste tre fasce chiudono. */}
      <div data-testid="movdlg-corpo" className="min-h-0 flex-1 overflow-y-auto p-5">
        {/* ── IL FATTO A SINISTRA, IL LAVORO A DESTRA (da `lg` in su) ──────
            `minmax(0,…)` su ENTRAMBI i binari, non `22rem 1fr`: il minimo
            implicito di una traccia di griglia è `auto`, quindi una causale
            lunghissima senza spazi allargherebbe il binario invece di andare
            a capo, e la colonna di destra si stringerebbe per farle posto.

            Sotto `lg` è una colonna sola e l'`aside` viene PRIMO, nell'ordine
            in cui sta scritto: niente `order-*`. Un ordine visuale diverso da
            quello di tabulazione è un difetto di accessibilità (WCAG 1.3.2),
            non un dettaglio di impaginazione.

            ⚠️ IL SECONDO BINARIO ESISTE SOLO SE C'È QUALCOSA DA METTERCI: vedi
            `haLavoro`. Su un movimento confermato la colonna di destra è vuota, e
            un `1fr` vuoto lascerebbe il FATTO schiacciato nei 22rem del binario
            sinistro con mezzo schermo di niente accanto. */}
        <div className={cx('grid grid-cols-1 gap-4 lg:gap-6', haLavoro && 'lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]')}>
          {/* Il FATTO: ciò che la banca ha mandato, più i documenti che ne
              sono nati. Resta a vista mentre si lavora a destra — è il motivo
              dello `sticky`: la causale si legge mentre si compone, e prima
              scorreva via. `self-start` perché una colonna alta quanto la
              griglia non ha margine per incollarsi a niente. */}
          <aside
            aria-label={`${t('movdlgTitoloMovimento')} ${dataIt(movimento.data_operazione)}`}
            className="min-w-0 lg:sticky lg:top-0 lg:self-start"
          >
            {/* Causale / ordinante: etichettati come nelle email di sollecito, dove la
                stessa famiglia legge «Causale» e «Intestato a» — che è il testo di
                `movdlgOrdinante` dal 2026-09-05: prima c'era «Ordinante:», cioè una
                parola diversa da quella che la stessa persona legge nel sollecito, e
                l'unico occhiello della schermata coi due punti.
                Fondo crema PIENO e non `cream/60`: con l'alfa dentro il nome della
                classe, la regola di Alto Contrasto `.bg-kidville-cream` non lo
                raggiungerebbe nemmeno.
                Spaziature sulla scala 4/8 (erano 14px e 6px, mezzi passi): il popup è
                alto una decina di pixel in più e ha un ritmo che si legge. */}
            <div className="mb-4 rounded-card bg-kidville-cream p-4">
              <p className={OCCHIELLO}>{t('movdlgCausale')}</p>
              <p className="mt-2 font-maven text-sm leading-snug break-words text-kidville-ink" title={movimento.causale ?? ''}>
                {movimento.causale || t('movdlgNessunaCausale')}
              </p>
              {movimento.controparte && (
                <>
                  <p className={cx(OCCHIELLO, 'mt-4')}>{t('movdlgOrdinante')}</p>
                  <p className="mt-2 font-maven text-sm leading-snug break-words text-kidville-ink">{movimento.controparte}</p>
                </>
              )}
            </div>

            {/* ── «Questo bonifico sembra di un'altra sede» ────────────────────
                Sopra i suggerimenti, perché è la cosa da sapere PRIMA di premerne
                uno.

                ⚠️ E NON È PIÙ LA STESSA CARTA CREMA DEGLI ALTRI RIQUADRI, come
                questo commento diceva fino al 2026-09-07. MISURATO sullo
                screenshot: aveva lo stesso identico vestito della card «CAUSALE /
                ORDINANTE» che gli sta due centimetri sopra — due rettangoli uguali,
                uno che riporta dei dati e uno che dice «se premi qui sotto registri
                l'incasso sulla voce di un bambino di un altro plesso». Un avviso col
                vestito di ciò che informa non è un avviso: è una nota.

                Il peso lo danno TRE cose, e nessuna è il fondo: un FILETTO laterale
                da 4px, un GLIFO e l'INCHIOSTRO d'avviso sul titolo. I numeri —
                cioè gli hex, che in questo file sono vietati anche nei commenti
                (`__tests__/architecture/design-tokens-admin.test.ts`) — stanno nel
                lock che li ricalcola, `riconciliazione-a11y-css.test.ts`:
                  · `warn-strong` sul crema vale **5,05:1**, sopra i 4,5:1 di WCAG
                    1.4.3 — ed è anche il colore del FILETTO, dove basterebbero i
                    3:1 di 1.4.11. `warn` sul crema si ferma a 2,79:1 e sarebbe
                    stato sotto soglia: misurato prima di scartarlo, non dopo;
                  · il fondo resta crema APPOSTA. `warn-soft` e crema distano tre
                    punti per canale: cambiarlo non avrebbe separato niente, e
                    avrebbe portato il riquadro fuori dalla regola di Alto Contrasto
                    che il popup ha già su `.bg-kidville-cream`;
                  · fondi PIENI, mai `bg-…/70`: con l'alfa dentro il nome della
                    classe quella regola HC non lo raggiungerebbe nemmeno. È la
                    stessa lezione scritta due volte qui sopra.

                In Alto Contrasto le superfici crema di questo popup diventano il
                grigio scurissimo, dove `warn-strong` varrebbe 5,62:1 — legge, ma
                smette di gridare. Filetto e inchiostro passano all'AMBRA (10,12:1)
                con la regola `.kv-recon-avviso-sede` in `globals.css`, fuori da
                ogni `@layer`: `@theme inline` INLINA l'hex nelle utility, quindi
                ridefinire un token sotto `[data-contrast="high"]` non tocca una
                sola classe già generata.

                Mai il giallo dei comandi né il rosso, in nessuno dei due: qui
                dentro quei colori sono di ciò che si preme (e c'è un lock che lo
                verifica sulle regole nuove), e
                questo riquadro non chiede un'azione a QUESTO operatore — chiede di
                non farne una. L'ambra dell'avviso non è quel giallo.

                ⚠️ Variante SENZA nome quando il server non ha potuto leggerlo: si
                dice comunque, senza nominare il plesso. Mai un nome inventato, e
                mai un `null` a schermo.

                ⚠️ Privacy, dichiarata: questa frase rivela l'ESISTENZA di una voce
                aperta in un altro plesso, mai CHI. È meno del nome dell'ordinante
                che la riga bancaria mostra già a tutte e tre le segreterie. Il nome
                del minore resta oscurato: i suggerimenti qui sotto sono quelli
                minimizzati dal server, e non è cambiato niente.

                ⚠️ DUE FRASI, PERCHÉ I CASI SONO DUE E IL DOMINANTE ERA L'ALTRO. Il
                riquadro dipende da `altraSede`, la lista dei candidati da
                `suggerimenti.length > 0`: le due condizioni NON coincidono, e la
                frase dei «deboli qui sotto» finiva sopra il vuoto. MISURATO in
                produzione il 2026-09-07 applicando la regola COME È IMPLEMENTATA —
                cioè sulle sole righe NON confermate, le uniche su cui il verdetto si
                calcola — e contando i candidati che RESTANO dopo la minimizzazione:
                dei 403 casi in cui il verdetto scatta, **332 non hanno nessun
                candidato di casa** — Aversa 162 su 165, Cesa 162 su 166, Giugliano 8
                su 72. Per due segreterie su tre la frase era falsa quasi sempre.

                ⚠️ QUESTI NUMERI SONO DOPO LA GUARDIA SULLE CONFERMATE; i primi qui
                scritti (338 su 413 — Aversa 166/169, Cesa 164/168, Giugliano 8/76)
                erano PRIMA, cioè la somma con le 5 righe `confermato` che portano
                ancora suggerimenti e su cui questo riquadro non compare mai. Non
                cambiava nessuna decisione, ma è la specie esatta di riga — un
                commento che descrive ciò che il codice non fa — che questo
                repository ha già pagato due volte.

                ⚠️ LA FRASE NON ATTRIBUISCE IL LAVORO A NESSUNO, e prima lo faceva:
                diceva «lo lavorerà l'altra segreteria». Non è verificato. Il verdetto
                si calcola contro `sediAttive`, che è `resolveScuoleAttive` — le sedi
                ACCESSIBILI intersecate con quelle selezionate nel cookie del selettore
                — quindi a un utente multi-sede che ha filtrato su Giugliano basta un
                aggancio su Cesa, sede SUA, per sentirsi annunciare una segreteria che
                non esiste. La schermata resta coerente (il PATCH risponde 404 sullo
                stesso insieme), ed è la frase a doversi limitare a ciò che è vero:
                parla di QUESTA schermata e di dove si abbina, non di chi lo farà. */}
            {!composto && altraSede && (
              <section className="kv-recon-avviso-sede flex gap-3 rounded-card border-l-4 border-kidville-warn-strong bg-kidville-cream p-4">
                {/* `aria-hidden`: il glifo ripete ciò che la frase accanto dice per
                    esteso, e uno screen reader non deve sentire due volte la stessa
                    cosa. Il peso visivo è tutto suo, il significato è del testo. */}
                <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-kidville-warn-strong" />
                <div className="min-w-0">
                  <p className="font-maven text-sm font-bold leading-snug text-kidville-warn-strong">
                    {altraSede.nome
                      ? t('movdlgAltraSedeTitolo', { sede: altraSede.nome })
                      : t('movdlgAltraSedeTitoloSenzaNome')}
                  </p>
                  <p className="mt-2 font-maven text-xs leading-relaxed text-kidville-sub">
                    {suggerimenti.length > 0 ? t('movdlgAltraSedeSpiega') : t('movdlgAltraSedeSpiegaSenzaCandidati')}
                  </p>
                </div>
              </section>
            )}

            {/* ── Movimento confermato: i DOCUMENTI ──────────────────────────────────
                Un riquadro solo, con un ordine di lettura: a che punto è la fattura
                (chip) → che cosa vuol dire (frase) → che cosa si può fare (azioni).
                Prima erano tre pillole in fila della stessa forma e dello stesso peso —
                «Ricevuta», «FATTURATA», «Fattura» — di cui una non era premibile.

                È una SUPERFICIE crema, gemella del riquadro della causale, e non più
                una card bianca con un filetto `border-kidville-line`: su fondo bianco
                quel filetto non si leggeva, e il blocco non aveva deciso se essere un
                contenitore — chip, frase e pulsanti sembravano galleggiare. Ora i due
                riquadri sono la stessa cosa e li separa lo spazio.
                Crema PIENO, mai `bg-kidville-cream/50`: con l'alfa dentro il nome della
                classe la regola di Alto Contrasto `.bg-kidville-cream` non lo
                raggiungerebbe, e il riquadro resterebbe chiaro sulla card nera. */}
            {!esito && isConfermato && (
              <section className="rounded-card bg-kidville-cream p-4">
                {/* Lo stato sta SULLA RIGA DELL'OCCHIELLO — «DOCUMENTI … FATTURATA» — e
                    non più sopra i pulsanti: lì era il terzo di tre pillole identiche di
                    cui una sola non si preme. Un titolo di riquadro e il suo stato sono
                    la stessa informazione, e stanno sulla stessa riga.
                    Dal 2026-09-24 (consegna 2b, D6) gli stati sono due, fatturazione e coda,
                    in un contenitore che li porta a destra e a capo INSIEME: con tre figli,
                    `justify-between` porterebbe il primo chip a metà riga. Il chip della coda
                    non dipende da `fat`, `saldato` o `loadingPag`: i suoi dati sono della riga
                    (fotografia del caricamento, come `movimento` intero). */}
                <div className="flex items-center justify-between gap-3">
                  <h3 className={OCCHIELLO}>{t('movdlgDocumenti')}</h3>
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    {!loadingPag && saldato && movimento.pagamento_id && fat && <ChipFatturazione fat={fat} suCarta />}
                    {movimento.pagamento_id && <ChipCoda stato={movimento.coda_stato} suCarta collegamento />}
                  </span>
                </div>
                {loadingPag ? (
                  <p className="mt-2 font-maven text-sm text-kidville-sub">{t('movdlgCaricamento')}</p>
                ) : saldato && movimento.pagamento_id ? (
                  <>
                    {/* Una frase per stato, mai una sola per due: «già emessa» su una
                        fattura in attesa era falso, e su una scartata non c'era niente —
                        cioè nessuna istruzione proprio dove qualcuno deve rifare il
                        lavoro. */}
                    {fat && (
                      <p className="mt-2 font-maven text-xs leading-relaxed text-kidville-sub">{t(FRASE_FATTURAZIONE[fat.tono])}</p>
                    )}
                    {/* ⚠️ IL CONTENITORE È CONDIZIONALE QUANTO IL SUO UNICO FIGLIO.
                        Da quando la ricevuta non si scarica più da qui, dentro resta il
                        solo pulsante della fattura: lasciare il div sempre montato
                        significava, su una fattura «in attesa SDI», un `mt-4` alto e
                        vuoto sotto la frase — uno spazio morto che sembra un pulsante
                        che non è arrivato. Si rende il contenitore solo quando c'è
                        qualcosa da metterci dentro.

                        «In attesa SDI» NON ha un pulsante: in quello stato FatturaButton
                        rende solo un badge con una rotella che gira, cioè la stessa
                        parola del chip qui sopra più un'animazione che non annuncia
                        niente. Lo stato si dice una volta.
                        Il guscio è ciò che dà la pelle al pulsante senza toccare
                        `FatturaButton`, che è condiviso con altre viste: `data-tono`
                        decide CTA pieno (c'è da emettere) o secondario (c'è già).

                        ⚠️ «UNA VOLTA» VALE ANCHE UN ISTANTE DOPO L'EMISSIONE, ed è ciò
                        che questa riga ha smesso di dare per scontato. Il ramo qui sopra
                        guarda `pagamentoFattura`, che era una fotografia del montaggio:
                        emessa la fattura restava `non_richiesta`, quindi il CTA giallo
                        sopravviveva accanto al badge «In attesa SDI» reso dal pulsante
                        stesso. `onEmessa` adesso alza PRIMA il segnale di rilettura e
                        POI avvisa la lista: quando la risposta arriva, questo ramo
                        sparisce da sé e il chip è l'unico a parlare.

                        Consegna 2b (D5): con una voce che aspetta o parte (`in_coda`,
                        `in_invio`) il pulsante non ha niente da rendere, e il contenitore
                        non si monta — salvo su emessa (i documenti) e scartata (i motivi),
                        che restano. Su «Errore in coda» il pulsante c'è e rende il
                        collegamento alla coda. La regola è del motore (`azioneConCoda`). */}
                    {pagamentoFattura !== 'in_attesa' && (pagamentoFattura === 'emessa' || pagamentoFattura === 'scartata' || azioneConCoda(movimento.coda_stato) !== 'nessuna') && (
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <span className="kv-recon-azione-fattura" data-tono={fat?.tono ?? 'da_fatturare'}>
                          <FatturaButton
                            pagamentoId={movimento.pagamento_id}
                            userId={userId}
                            fatturaStato={pagamentoFattura ?? undefined}
                            codaStato={movimento.coda_stato ?? null}
                            onEmessa={() => { setRicarica((n) => n + 1); onDone(); }}
                          />
                        </span>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="mt-2 flex items-center gap-1.5 font-maven text-xs leading-relaxed text-kidville-sub">
                    <FileText size={14} className="shrink-0" /> {t('movdlgFatturaSaldo')}
                  </p>
                )}
              </section>
            )}
          </aside>

          {/* Il LAVORO: tutto ciò che si preme per chiudere questa riga —
              suggerimenti, composizione, ricerca manuale — più ciò che è
              appena successo, che qui SOSTITUISCE l'abbinamento invece di
              affiancarglisi. `min-w-0`: senza, una riga lunga di questa colonna
              sfonderebbe il binario `1fr` invece di andare a capo.

              ⚠️ O C'È, O NON C'È: un landmark vuoto è peggio di un landmark
              assente. Tutto ciò che sta qui dentro è già condizionato a `error`,
              `esito` o `puoAbbinare` — cioè esattamente a `haLavoro` — quindi
              senza questa guardia sui confermati restava una `region` annunciata
              «Abbina» con `childElementCount = 0`: chi naviga per regioni la
              trova, ci entra e non c'è niente, sotto il nome di un comando che lì
              non esiste. */}
          {haLavoro && (
          <section
            data-testid="movdlg-lavoro"
            aria-label={t('movdlgAbbina')}
            className="min-w-0"
          >
            {error && <p role="alert" className="mb-4 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">{error}</p>}

            {/* ── L'ESITO, quando c'è qualcosa da raccontare ───────────────────────
                Sta PRIMA dell'abbinamento e lo SOSTITUISCE, non gli si affianca: dopo
                una composizione registrata, «Conferma questo» e la ricerca manuale
                sarebbero due modi di incassare una seconda volta lo stesso bonifico —
                e nel caso «incasso registrato, riga non legata» il ritentativo è
                esattamente il gesto che il server chiede di NON fare. Vedi `EsitoAzione`. */}
            {esito && <PannelloEsito esito={esito} />}

            {/* ── Abbinamento (movimenti non confermati) ─────────────────────────── */}
            {!esito && puoAbbinare && (
              <div className="space-y-4">
                {/* Bonifico di famiglia: innesto «Incasso unico» (impl. UI-2) */}
                {!composto && multiCf && onIncassoUnico && (
                  <div className="rounded-card border-[1.5px] border-kidville-green-soft bg-kidville-green-soft p-4">
                    <p className="flex items-center gap-1.5 font-maven text-sm font-bold text-kidville-green">
                      <Users size={15} /> {t('movdlgBonificoFamiglia')}
                    </p>
                    <button type="button" onClick={() => onIncassoUnico(movimento)} disabled={busy} className={cx(BTN_PRIMARY_AA, 'mt-3 min-h-11')}>
                      {t('movdlgApriIncassoUnico')}
                    </button>
                  </div>
                )}

                {/* Suggerimenti ordinati (CF-match primi) */}
                {!composto && suggerimenti.length > 0 && (
                  <div>
                    <h3 className={cx(OCCHIELLO, 'mb-2 block')}>{t('movdlgSuggerimenti')}</h3>
                    <div className="space-y-2">
                      {suggerimenti.map((s, i) => (
                        <div key={`${s.pagamento_id}-${i}`} className="flex items-center justify-between gap-2 rounded-input border border-kidville-line px-3 py-2">
                          <span className="flex min-w-0 items-center gap-2">
                            {s.cf_match && <CfPill />}
                            <span className="min-w-0 truncate font-maven text-sm text-kidville-ink">{s.label || s.pagamento_id}</span>
                          </span>
                          {/* Declassato — non disabilitato — quando l'aggancio forte è
                              altrove: si preme ancora, e la protezione vera resta il
                              404 fuori sede del PATCH. */}
                          <button type="button" onClick={() => azione('conferma', s.pagamento_id)} disabled={busy}
                            className={altraSede ? CTA_SUGGERIMENTO_DEBOLE : CTA_SUGGERIMENTO}>
                            <Check size={15} /> {t('movdlgConfermaQuesto')}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── «COMPONI IL PAGAMENTO» — il terzo modo, e sta SOTTO i suggerimenti
                    (decisione n. 1 del titolare: il pannello vive dentro questo popup).

                    Perché sotto e non sopra: i suggerimenti sono la risposta al caso
                    normale — un bonifico, una voce — e restano il primo posto dove
                    guardare. Questo è il caso dell'altro bonifico, quello di famiglia,
                    che paga la retta di due fratelli più i ticket mensa: lì nessun
                    suggerimento è giusto, perché nessuno da solo lo è.

                    ⚠️ I DUE PERCORSI DI PRIMA NON SI TOCCANO. «Conferma questo» e la
                    ricerca manuale restano dove sono, con la stessa pelle e la stessa
                    PATCH: il caso a voce singola è la maggioranza del lavoro, e
                    spostarlo per far posto a una funzione nuova lo renderebbe più
                    lento per tutti. Il pannello si apre solo se qualcuno lo chiede, e
                    `onChiudi` rimette la schermata com'era.

                    ⚠️ E il pulsante è SECONDARIO, non un CTA: il verde pieno in questa
                    schermata è dell'abbinamento suggerito. Se «Componi» fosse l'unico
                    pulsante pieno, sarebbe lui a sembrare la cosa da fare anche sui
                    nove bonifici su dieci che hanno un suggerimento buono.

                    Il pannello NON riceve dati da qui: si carica e si registra da sé
                    (contratto fissato dall'orchestratore). Questo popup gli passa
                    l'identità del bonifico e riceve indietro l'esito. */}
                {componiAperto ? (
                  <ComposizioneBonifico
                    movimentoId={movimento.id}
                    importoMovimento={movimento.importo}
                    dataOperazione={movimento.data_operazione}
                    /* I bambini su cui puntare la composizione: identità, non dati
                       (v. la testata del pannello). Vuoto sui casi normali, dove il
                       bonifico i suoi bambini li nomina da sé. */
                    alunniIniziali={alunniComponi}
                    onFatto={(r) => {
                      /**
                       * ─── DUE ESITI, DUE POSTI, E NESSUNA FRASE DETTA DUE VOLTE ─────
                       *
                       * Tre fette di questo lavoro sanno raccontare la stessa cosa — il
                       * pannello qui dentro, questo popup, la fascia dell'elenco — e se
                       * parlassero insieme l'operatrice leggerebbe lo stesso fatto due
                       * volte a due centimetri di distanza. La divisione, decisa dal
                       * coordinamento, è netta:
                       *
                       * ANDATA BENE → il popup si CHIUDE e il riepilogo lo mostra la
                       * FASCIA DELL'ELENCO, che è il vestito del riepilogo d'import: uno
                       * che l'operatrice conosce già, e che resta a schermo mentre guarda
                       * la riga appena diventata verde. «Conferma questo» non può
                       * riapparire, perché non c'è più la finestra.
                       *
                       * NON LEGATA → il denaro è scritto, la riga bancaria no. Parla il
                       * PANNELLO, che è rimasto montato e mostra la frase che la rotta
                       * dichiara col proprio codice (`CONCILIAZIONE_MOVIMENTO_NON_LEGATO`
                       * → `shared.erroreConciliazioneMovimentoNonLegato`, quella che dice
                       * «non ripetere l'operazione»); il suo pulsante di conferma è già
                       * sparito da sé. Qui non si scrive una seconda frase e non si
                       * chiude niente: un avviso che se ne va da solo è un avviso che non
                       * è stato letto. All'elenco va `onDone()` NUDO, così il ramo
                       * d'avviso della fascia — che si accende su `movimentoLegato ===
                       * false` — resta spento e non ripete la stessa cosa più in là.
                       *
                       * I quattro campi si inoltrano COM'È: questo strato non li
                       * interpreta e non li converte. `ticket` in particolare è già la
                       * QUANTITÀ di pasti — non il numero di righe — perché il pannello
                       * la somma alla fonte, dove le quantità ci sono; qui non ci
                       * sarebbero, e ricalcolarla significherebbe inventarla.
                       */
                      if (r.movimentoConfermato) {
                        setComponiAperto(false);
                        onDone({ voci: r.voci, ticket: r.ticket, totale: r.totale, movimentoLegato: true });
                        onClose();
                        return;
                      }
                      // Il denaro è a registro: da qui in poi questo popup non ha più
                      // niente da offrire su questa riga (v. `composto`, sotto).
                      setComposto(true);
                      onDone();
                    }}
                    /**
                     * ⚠️ LA VIA D'USCITA DEL PANNELLO CAMBIA SIGNIFICATO UNA VOLTA CHE IL
                     * DENARO È SCRITTO. Prima di comporre, «Chiudi» riporta
                     * all'abbinamento, ed è giusto: si è cambiato idea. Dopo, quel ritorno
                     * significherebbe «Conferma questo» e la ricerca manuale SU UN
                     * BONIFICO IL CUI INCASSO È GIÀ A REGISTRO — il secondo incasso,
                     * offerto dalla stessa schermata che ha appena avvisato di non farlo.
                     * Perciò si esce dal popup, non dal pannello.
                     */
                    onChiudi={() => {
                      if (composto) { onClose(); return; }
                      // Il solo caso «sono tornato indietro»: qui il fuoco ha un posto
                      // dove rientrare. Vedi `rientraSuComponi`, in cima al componente.
                      rientraSuComponi.current = true;
                      // ⚠️ E IL BERSAGLIO SI AZZERA CON IL PANNELLO. Senza questa riga
                      // «Componi per questo bambino» → indietro → «Componi il
                      // pagamento» riapriva la composizione ANCORA PUNTATA su quel
                      // bambino, senza che niente a schermo dicesse perché: è il
                      // pericolo scritto in `componiPerAlunno` («comporre su bambini
                      // scelti tre ricerche fa, senza che si veda») rientrato da
                      // un'altra porta. Non si scrive niente di sbagliato — `?alunni=`
                      // ALLARGA il contesto e i figli in più si vedono in elenco — ma
                      // il pannello non nasce nello stato che l'operatrice ha chiesto.
                      // Il ramo `composto` qui sopra resta intatto: lì il popup chiude.
                      setAlunniComponi([]);
                      setComponiAperto(false);
                    }}
                  />
                ) : !composto && (
                  <button type="button" ref={componiBtnRef} onClick={() => setComponiAperto(true)} disabled={busy} className={cx(BTN_SECONDARY, 'min-h-11')}>
                    <Layers size={15} /> {t('reconComponiTitolo')}
                  </button>
                )}

                {/* ── Ricerca manuale fra i pagamenti aperti (stessa fonte del pannello)
                    ⚠️ `!composto`, come i suggerimenti qui sopra: una volta che la
                    composizione ha SCRITTO il denaro, questi due percorsi non sono più
                    «l'altra strada», sono un SECONDO incasso sullo stesso bonifico — e
                    starebbero a schermo accanto all'avviso che dice di non rifarlo.
                    Prima di quel momento restano intatti, ed è il loro caso: il bonifico
                    che paga una voce sola. */}
                {!composto && (
                <div>
                  <h3 className={cx(OCCHIELLO, 'mb-2 block')}>{t('movdlgCercaAltroPagamento')}</h3>
                  <div className="relative mb-2">
                    <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub" />
                    {/* ⚠️ IL NOME ACCESSIBILE NON CAMBIA, e non è pigrizia: è il nome
                        con cui questa casella è documentata, collaudata e conosciuta
                        da chi la usa da mesi. Quello che è cambiato è che adesso
                        cerca anche fra i BAMBINI, e lo dice la frase qui sotto, che
                        la casella porta come `aria-describedby` — una descrizione si
                        aggiunge al nome, non lo sostituisce. */}
                    <input type="text" value={ricerca} onChange={(e) => setRicerca(e.target.value)} placeholder={t('movdlgCercaPlaceholder')}
                      className={cx(INPUT, 'pl-9')} aria-label={t('movdlgCercaAriaLabel')} aria-describedby={idAiutoRicerca} />
                  </div>
                  <p id={idAiutoRicerca} className="mb-4 font-maven text-xs text-kidville-sub">{t('movdlgCercaAncheBambini')}</p>

                  <h4 className={cx(OCCHIELLO, 'mb-2 block')}>{t('movdlgGruppoVociAperte')}</h4>
                  {/* ⚠️ NIENTE `max-h-56 overflow-y-auto` QUI: era uno scorrimento
                      DENTRO lo scorrimento del popup, cioè due rotelle sovrapposte
                      in 224px — e su trackpad la rotella prende quella interna, che
                      finisce, e poi la pagina sotto sussulta. Ora la lista scorre
                      con il corpo del popup, che è l'unico scorrevole.
                      Il tetto dei 25 risultati resta (`apertiFiltrati`): quello è un
                      TETTO sui risultati, non uno scorrimento, e serve a non
                      disegnare 700 righe su una ricerca vuota. */}
                  <div className="space-y-1">
                    {apertiFiltrati.length === 0 ? (
                      <p className="px-1 py-2 font-maven text-xs text-kidville-sub">{t('movdlgNessunPagamentoCorrisponde')}</p>
                    ) : apertiFiltrati.map((p) => (
                      <div key={p.id} className="flex items-center justify-between gap-2 rounded-input bg-kidville-cream px-3 py-2">
                        <span className="min-w-0 truncate font-maven text-xs text-kidville-ink">{labelPagamentoAperto(p, opzioniLabel)}</span>
                        <button type="button" onClick={() => azione('conferma', p.id)} disabled={busy}
                          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill border-[1.5px] border-kidville-green px-4 font-maven text-sm font-bold text-kidville-green transition-colors hover:bg-kidville-green hover:text-kidville-white disabled:opacity-50">
                          <Check size={14} /> {t('movdlgAbbina')}
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* ── IL SECONDO GRUPPO: I BAMBINI ────────────────────────────
                      Serve al bonifico che paga un bambino SENZA voci aperte — un
                      arretrato, una ricarica mensa, una voce che ancora non
                      esiste. Nel gruppo qui sopra non potrebbe comparire mai: là
                      dentro ci sono i pagamenti, e di pagamenti non ne ha. */}
                  <h4 className={cx(OCCHIELLO, 'mb-2 mt-4 block')}>{t('movdlgGruppoAlunni')}</h4>

                  {/* La regione viva: è l'unica cosa che dice a chi non vede lo
                      schermo che la lista è cambiata — o che non è cambiata, e
                      perché.

                      ⚠️ `aria-live="polite"` + `aria-atomic`, e NON un secondo
                      `role="status"` — che è quello che c'era fino al
                      2026-09-20, con accanto un commento che guardava il vicino
                      sbagliato («l'esito e l'abbinamento non coesistono mai»).
                      Il concorrente non è l'esito: è la BARRA DI QUADRATURA del
                      pannello («Totale … · manca ancora …», `role="status"` in
                      `ComposizioneBonifico`), e con `componiAperto` i due stanno
                      a schermo INSIEME, perché questo blocco è guardato da
                      `!composto` e non da `!componiAperto` — è fratello del
                      ternario del pannello, dentro lo stesso `div`. MISURATO col
                      pannello vero montato: due `status` a schermo, non uno.
                      Per un lettore di schermo i due attributi qui sotto sono la
                      stessa cosa (`status` implica esattamente loro), e lasciano
                      UNA sola regione `status` per superficie: quella che dice
                      se si può confermare. */}
                  <p aria-live="polite" aria-atomic="true" data-testid="movdlg-ricerca-stato" className="mb-2 font-maven text-xs text-kidville-sub">
                    {fraseRicerca}
                  </p>

                  {/* ⚠️ UNA RICERCA FALLITA NON DIVENTA UN ELENCO VUOTO. «Non l'ho
                      trovato» e «non ho potuto guardare» hanno rimedi opposti, e
                      il secondo travestito da primo manda a creare una scheda per
                      un bambino che esiste già. La frase è quella che la rotta
                      dichiara col proprio codice. */}
                  {ricercaAlunni.stato === 'errore' && (
                    <p role="alert" className="mb-2 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
                      {messaggioDaCorpo(ricercaAlunni.errore?.corpo, t('reconRicercaAlunniErrore'))}
                    </p>
                  )}

                  {ricercaAlunni.stato === 'pronta' && (
                    <div className="space-y-1">
                      {ricercaAlunni.righe.length === 0 ? (
                        <p className="px-1 py-2 font-maven text-xs text-kidville-sub">{t('reconRicercaAlunniVuoto')}</p>
                      ) : ricercaAlunni.righe.map((a) => (
                        <div key={a.alunno_id} className="flex items-center justify-between gap-2 rounded-input bg-kidville-cream px-3 py-2">
                          <span className="min-w-0 font-maven text-xs text-kidville-ink">
                            {a.nome}
                            <span className="ml-2 text-kidville-sub">{dettaglioAlunno(a, ricercaAlunni.sedi, t)}</span>
                          </span>
                          {/* Lo STESSO vestito di «Abbina» qui sopra — contorno verde
                              a riposo, verde PIENO in hover — e non uno nuovo: in
                              Alto Contrasto l'inchiostro del popup è forzato al
                              bianco, quindi un `hover:bg-*` chiaro farebbe sparire il
                              pulsante sotto il puntatore (misurato: 1,19:1). Il lock
                              `riconciliazione-a11y-css` rifiuta ogni fondo in hover
                              che non sia scuro o che non abbia la sua regola HC. */}
                          <button type="button" disabled={busy} onClick={() => componiPerAlunno(a.alunno_id)}
                            className={CTA_SUGGERIMENTO_DEBOLE}>
                            <Layers size={14} /> {t('movdlgComponiPerQuesto')}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                )}
              </div>
            )}
          </section>
          )}
        </div>
      </div>

      {/* ── Azioni sul movimento: un PIEDE, non due pillole che galleggiano ───
          ⚠️ A COSE FATTE RESTA IL SOLO «Chiudi», e le due condizioni sono DUE
          perché i due modi di «fatto» sono diversi: `esito` è la riapertura appena
          avvenuta, `composto` è il denaro appena scritto da una composizione. In
          entrambi la prop `movimento` è la FOTOGRAFIA DI PRIMA, quindi `stato`
          direbbe ancora di sì.

          ⚠️ «IGNORA» DOPO UNA COMPOSIZIONE NON LEGATA È IL PEGGIORE DEI DUE, ed è
          il motivo per cui `composto` compare anche qui. `ignora` porta il
          movimento a `ignorato`, cioè FUORI dalla coda: su una riga il cui incasso
          è già scritto e che non si è legata, nasconderla significa non legarla mai
          più — resterebbe un incasso senza la riga bancaria che lo giustifica, e
          nessuno a cercarla. La riga deve restare visibile e rossa finché qualcuno
          non la lega.

          ⚠️ IL PIEDE È FRATELLO DEL CORPO, NON UN SUO DISCENDENTE — ed è la
          ragione per cui il tetto d'altezza di prima esisteva. Stando DENTRO
          l'area che scorre, «Chiudi» era in fondo al rotolo: su un movimento con
          suggerimenti e ricerca bisognava scorrere tutto per uscire, e finché la
          card non ebbe un `max-h` non ci si arrivava affatto. Fuori dal corpo
          resta dov'è, qualunque cosa ci si metta dentro. `shrink-0` per lo stesso
          motivo della testa. */}
      <div data-testid="movdlg-piede" className="shrink-0 flex flex-wrap items-center gap-2 border-t border-kidville-line p-5">
        {!esito && !composto && (stato === 'da_abbinare' || stato === 'suggerito') && (
          <button type="button" onClick={() => azione('ignora')} disabled={busy} className={cx(BTN_SECONDARY, 'min-h-11')}>
            <X size={15} /> {t('movdlgIgnora')}
          </button>
        )}
        {!esito && !composto && (isConfermato || isIgnorato) && (
          <button type="button" onClick={() => azione('riapri')} disabled={busy} className={cx(BTN_SECONDARY, 'min-h-11')}>
            {t('movdlgRiapri')}
          </button>
        )}
        <button type="button" onClick={onClose} className={cx(BTN_SECONDARY, 'ml-auto min-h-11')}>{t('movdlgChiudi')}</button>
      </div>
    </Modal>
  );
}
