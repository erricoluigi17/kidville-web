'use client';

import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarClock, Hourglass, Info, UserX } from 'lucide-react';
import { intlDateTime } from '@/i18n/config';
import { getCurrentStudentId } from '@/lib/auth/current-user';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { eMotivoNonPiuIscritto, fetchEsitoFigli, invalidaFigliCache, type EsitoFigli } from '@/lib/auth/use-parent-identity';

/**
 * Quanto si aspetta la risposta sui figli prima di dire che lo stato non è determinabile. Dopo questo tempo chi non ha nessun
 * bambino già noto non vede più una rotella senza fine (il difetto per cui una famiglia ha visto l'app «sempre in caricamento»):
 * vede un messaggio con il pulsante per riprovare. Se la risposta arriva dopo, il messaggio lascia il posto alla pagina.
 */
export const ATTESA_MAX_STATO_FIGLI_MS = 8_000;

/**
 * Le uniche schermate dell'area famiglia che hanno senso SENZA un bambino: il profilo
 * (da lì si esce, si cambia la password e si rientra con un altro indirizzo) e il
 * primo accesso. Tutte le altre — diario, galleria, armadietto, pagelle, rette… —
 * si costruiscono su uno `studentId`, e senza restavano in uno spinner senza fine.
 */
const ROTTE_SENZA_FIGLIO = ['/parent/profilo', '/parent/onboarding'];

/**
 * Con i legami ma nessun figlio ATTIVO (ritirato, archiviato, senza sezione) passano in più le schermate che non
 * aspettano uno `studentId`: restano rette da saldare, conversazioni da rileggere, moduli da firmare e schede di voto.
 * La home è a parte: `/parent` è il prefisso di tutto, e lo stesso pannello lo mostra da sé.
 *
 * È l'elenco di chi PASSA, non di chi si ferma: una rotta nuova mostra il pannello, mai uno spinner senza fine.
 */
const ROTTE_SENZA_FIGLIO_ATTIVO = [
  ...ROTTE_SENZA_FIGLIO,
  '/parent/pagamenti',
  '/parent/chat',
  '/parent/avvisi',
  '/parent/news',
  '/parent/modulistica',
  '/parent/forms',
  '/parent/votazioni',
];

function eSottoUnaDi(rotte: string[], pathname: string): boolean {
  return rotte.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

export function eRottaSenzaFiglio(pathname: string | null): boolean {
  if (!pathname) return false;
  return eSottoUnaDi(ROTTE_SENZA_FIGLIO, pathname);
}

export function eRottaSenzaFiglioAttivo(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === '/parent' || eSottoUnaDi(ROTTE_SENZA_FIGLIO_ATTIVO, pathname);
}

/**
 * Chiede ai figli dell'account — dalla STESSA cache di `useParentIdentity`, quindi
 * senza una richiesta in più — e riferisce l'esito: «il server ha letto tutti i legami e
 * non ce n'è nessuno», oppure «ci sono, ma nessun figlio è attivo».
 *
 * Sta dentro un `Suspense` perché `useSessionIdentity` legge `useSearchParams`; è un
 * componente a parte, e non il guardiano stesso, proprio per questo: se a sospendersi
 * fosse il guardiano, con lui sparirebbe dal prerender l'intera pagina che avvolge.
 */
function SondaSenzaFigli({ onEsito, tentativo }: { onEsito: (esito: EsitoFigli | null) => void; tentativo: number }) {
  const session = useSessionIdentity();
  useEffect(() => {
    if (!session.ready || !session.userId) return;
    let annullato = false;
    // `fetchEsitoFigli` non rifiuta mai: `null` = non determinabile (rete giù,
    // risposta non ok). In quel caso NON si dice «nessun figlio»: l'assenza di una
    // risposta non è una risposta.
    void fetchEsitoFigli(session.userId).then((esito) => {
      if (!annullato) onEsito(esito);
    });
    return () => { annullato = true; };
    // `tentativo` rilancia la lettura dal pulsante «Riprova»: è nelle dipendenze apposta.
  }, [session.ready, session.userId, onEsito, tentativo]);
  return null;
}

/** Le rotte che per una famiglia con un figlio in arrivo restano raggiungibili: il profilo e i pagamenti (la quota), non la home. */
function eRottaCheRestaAperta(pathname: string | null): boolean {
  return eRottaSenzaFiglioAttivo(pathname) && pathname !== '/parent';
}

/** Il giorno `YYYY-MM-DD` come testo, con lingua e fuso espliciti: la data del database non scivola mai di un giorno. */
export function testoDataIngresso(giorno: string, locale: string): string {
  return intlDateTime(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${giorno}T00:00:00Z`));
}

/**
 * «NESSUN BAMBINO COLLEGATO A QUESTO ACCESSO» — il guasto che non faceva rumore.
 *
 * Un account genitore con zero legami entrava senza errori e poi non vedeva niente:
 * la home vuota, le altre schermate in caricamento per sempre. Succede quando il
 * bambino è stato collegato a un ALTRO profilo della stessa persona (due indirizzi
 * email, due schede), e la famiglia non ha modo di saperlo. Ora lo dice, e dice cosa
 * fare: rivolgersi alla segreteria, o rientrare con l'indirizzo giusto.
 *
 * Lo stesso vale per chi i legami li ha ma nessun figlio attivo (`in_attesa`): le schermate
 * costruite su uno `studentId` giravano per sempre. Qui la frase la sceglie il motivo, come
 * nella home: un bambino ritirato non ha una classe da aspettare.
 *
 * Avvolge i contenuti dell'area famiglia e li SOSTITUISCE solo quando il server ha
 * dichiarato `senza_figli` o `in_attesa`. Fino ad allora, e offline, rende i figli come
 * sempre: nessun lampo di pannello per chi un bambino ce l'ha.
 */
export function GuardiaSenzaFigli({ children }: { children: ReactNode }) {
  const t = useTranslations('parentServizi');
  const tAnno = useTranslations('annoFamiglia');
  const locale = useLocale();
  const pathname = usePathname();
  const [esito, setEsito] = useState<EsitoFigli | null>(null);
  // «Non determinabile»: la lettura è fallita (`null`) o non ha risposto entro l'attesa massima. Mai una rotella senza fine.
  const [incerto, setIncerto] = useState(false);
  const [tentativo, setTentativo] = useState(0);
  const [figlioNoto, setFiglioNoto] = useState(false);

  const alEsito = useCallback((e: EsitoFigli | null) => {
    setEsito(e);
    setIncerto(e === null);
    if (e === null) setFiglioNoto(!!getCurrentStudentId(null));
  }, []);

  useEffect(() => {
    if (esito) return;
    const timer = setTimeout(() => {
      setFiglioNoto(!!getCurrentStudentId(null));
      setIncerto(true);
    }, ATTESA_MAX_STATO_FIGLI_MS);
    return () => clearTimeout(timer);
  }, [esito, tentativo]);

  const riprova = () => {
    invalidaFigliCache();
    setIncerto(false);
    setEsito(null);
    setTentativo((n) => n + 1);
  };

  const nessunoCollegato = !!esito?.senzaFigli && !eRottaSenzaFiglio(pathname);
  // Un figlio che entra più avanti: la frase vera, anche sulla home (che altrimenti mostrerebbe il suo pannello generico).
  const ingressoFuturo = esito?.inAttesa && esito.ingressoFuturo ? esito.ingressoFuturo : null;
  const inArrivo = !!ingressoFuturo && !eRottaCheRestaAperta(pathname);
  const nessunoAttivo = !ingressoFuturo && !!esito?.inAttesa && !eRottaSenzaFiglioAttivo(pathname);
  // Senza un bambino già noto le pagine non hanno uno `studentId` da aspettare: il messaggio prende il posto dell'attesa.
  const nonVerificabile = incerto && !esito && !figlioNoto && !eRottaSenzaFiglio(pathname);
  const nonPiuIscritto = eMotivoNonPiuIscritto(esito?.motivoAssenza);
  // La clessidra promette un'attesa: dove non c'è nessuna attesa da fare resta l'informazione, come nella home.
  const Icona = nessunoCollegato ? UserX : inArrivo ? CalendarClock : nonPiuIscritto ? Info : Hourglass;

  return (
    <>
      <Suspense fallback={null}>
        <SondaSenzaFigli onEsito={alEsito} tentativo={tentativo} />
      </Suspense>
      {nonVerificabile ? (
        <div className="min-h-screen bg-kidville-cream px-4 pb-[100px] pt-5" data-kv-stato-figli-incerto>
          <div role="alert" className="rounded-[22px] bg-white px-5 py-8 text-center" style={{ boxShadow: '0 4px 12px -8px rgba(0,0,0,0.18)' }}>
            <span className="mx-auto flex h-[52px] w-[52px] items-center justify-center rounded-[18px] bg-kidville-yellow-soft text-kidville-yellow-dark">
              <Info size={24} strokeWidth={1.9} aria-hidden="true" />
            </span>
            <h1 className="pt-4 font-barlow text-[19px] font-bold uppercase leading-[1.1] tracking-[0.02em] text-kidville-green">
              {tAnno('nonVerificabileTitolo')}
            </h1>
            <p className="pt-2 font-maven text-[13.5px] leading-[1.5] text-kidville-sub">{tAnno('nonVerificabileTesto')}</p>
            <button
              type="button"
              onClick={riprova}
              className="mt-4 inline-flex min-h-[44px] items-center font-barlow text-[13px] font-bold uppercase tracking-[0.02em] text-kidville-green underline"
            >
              {tAnno('nonVerificabileRiprova')}
            </button>
          </div>
        </div>
      ) : nessunoCollegato || nessunoAttivo || inArrivo ? (
        <div
          className="min-h-screen bg-kidville-cream px-4 pb-[100px] pt-5"
          data-kv-senza-figli={nessunoCollegato || undefined}
          data-kv-senza-figli-attivi={nessunoAttivo || undefined}
          data-kv-ingresso-futuro={inArrivo || undefined}
        >
          <div className="rounded-[22px] bg-white px-5 py-8 text-center" style={{ boxShadow: '0 4px 12px -8px rgba(0,0,0,0.18)' }}>
            <span className="mx-auto flex h-[52px] w-[52px] items-center justify-center rounded-[18px] bg-kidville-yellow-soft text-kidville-yellow-dark">
              <Icona size={24} strokeWidth={1.9} aria-hidden="true" />
            </span>
            <h1 className="pt-4 font-barlow text-[19px] font-bold uppercase leading-[1.1] tracking-[0.02em] text-kidville-green">
              {nessunoCollegato
                ? t('senzaFigliTitolo')
                : inArrivo && ingressoFuturo
                  ? tAnno('ingressoFuturoTitolo', { data: testoDataIngresso(ingressoFuturo, locale) })
                  : nonPiuIscritto ? t('nonPiuIscrittoTitolo') : t('inAttesaTitolo')}
            </h1>
            <p className="pt-2 font-maven text-[13.5px] leading-[1.5] text-kidville-sub">
              {nessunoCollegato
                ? t('senzaFigliTesto')
                : inArrivo ? tAnno('ingressoFuturoTesto') : nonPiuIscritto ? t('nonPiuIscrittoTesto') : t('inAttesaTesto')}
            </p>
            <Link
              href={nessunoCollegato ? '/parent/profilo' : '/parent/pagamenti'}
              className="mt-4 inline-flex min-h-[44px] items-center font-barlow text-[13px] font-bold uppercase tracking-[0.02em] text-kidville-green underline"
            >
              {nessunoCollegato ? t('senzaFigliProfilo') : t('inAttesaPagamenti')}
            </Link>
          </div>
        </div>
      ) : (
        children
      )}
    </>
  );
}
