'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UserX } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { fetchEsitoFigli } from '@/lib/auth/use-parent-identity';

/**
 * Le uniche schermate dell'area famiglia che hanno senso SENZA un bambino: il profilo
 * (da lì si esce, si cambia la password e si rientra con un altro indirizzo) e il
 * primo accesso. Tutte le altre — diario, galleria, armadietto, pagelle, rette… —
 * si costruiscono su uno `studentId`, e senza restavano in uno spinner senza fine.
 */
const ROTTE_SENZA_FIGLIO = ['/parent/profilo', '/parent/onboarding'];

export function eRottaSenzaFiglio(pathname: string | null): boolean {
  if (!pathname) return false;
  return ROTTE_SENZA_FIGLIO.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

/**
 * Chiede ai figli dell'account — dalla STESSA cache di `useParentIdentity`, quindi
 * senza una richiesta in più — e riferisce una cosa sola: «il server ha letto tutti i
 * legami e non ce n'è nessuno».
 *
 * Sta dentro un `Suspense` perché `useSessionIdentity` legge `useSearchParams`; è un
 * componente a parte, e non il guardiano stesso, proprio per questo: se a sospendersi
 * fosse il guardiano, con lui sparirebbe dal prerender l'intera pagina che avvolge.
 */
function SondaSenzaFigli({ onEsito }: { onEsito: (senzaFigli: boolean) => void }) {
  const session = useSessionIdentity();
  useEffect(() => {
    if (!session.ready || !session.userId) return;
    let annullato = false;
    // `fetchEsitoFigli` non rifiuta mai: `null` = non determinabile (rete giù,
    // risposta non ok). In quel caso NON si dice «nessun figlio»: l'assenza di una
    // risposta non è una risposta.
    void fetchEsitoFigli(session.userId).then((esito) => {
      if (!annullato) onEsito(esito !== null && esito.senzaFigli);
    });
    return () => { annullato = true; };
  }, [session.ready, session.userId, onEsito]);
  return null;
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
 * Avvolge i contenuti dell'area famiglia e li SOSTITUISCE solo quando il server ha
 * dichiarato `senza_figli`. Fino ad allora, e offline, rende i figli come sempre:
 * nessun lampo di pannello per chi un bambino ce l'ha.
 */
export function GuardiaSenzaFigli({ children }: { children: ReactNode }) {
  const t = useTranslations('parentServizi');
  const pathname = usePathname();
  const [senzaFigli, setSenzaFigli] = useState(false);
  const mostraPannello = senzaFigli && !eRottaSenzaFiglio(pathname);

  return (
    <>
      <Suspense fallback={null}>
        <SondaSenzaFigli onEsito={setSenzaFigli} />
      </Suspense>
      {mostraPannello ? (
        <div className="min-h-screen bg-kidville-cream px-4 pb-[100px] pt-5" data-kv-senza-figli>
          <div className="rounded-[22px] bg-white px-5 py-8 text-center" style={{ boxShadow: '0 4px 12px -8px rgba(0,0,0,0.18)' }}>
            <span className="mx-auto flex h-[52px] w-[52px] items-center justify-center rounded-[18px] bg-kidville-yellow-soft text-kidville-yellow-dark">
              <UserX size={24} strokeWidth={1.9} aria-hidden="true" />
            </span>
            <h1 className="pt-4 font-barlow text-[19px] font-bold uppercase leading-[1.1] tracking-[0.02em] text-kidville-green">
              {t('senzaFigliTitolo')}
            </h1>
            <p className="pt-2 font-maven text-[13.5px] leading-[1.5] text-kidville-sub">
              {t('senzaFigliTesto')}
            </p>
            <Link
              href="/parent/profilo"
              className="mt-4 inline-flex min-h-[44px] items-center font-barlow text-[13px] font-bold uppercase tracking-[0.02em] text-kidville-green underline"
            >
              {t('senzaFigliProfilo')}
            </Link>
          </div>
        </div>
      ) : (
        children
      )}
    </>
  );
}
