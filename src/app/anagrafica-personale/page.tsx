import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { PublicPageHeader } from '@/components/ui/PublicPageHeader'
import { AnagraficaPersonaleWizard } from '@/components/features/public/AnagraficaPersonaleWizard'

/**
 * `/anagrafica-personale` — il modulo PUBBLICO dell'anagrafica del personale.
 *
 * Lo compila chi il rapporto di lavoro ce l'ha GIÀ: la Segreteria manda il link
 * alle maestre in servizio, loro compilano, la Segreteria approva. Si apre senza
 * account perché quasi nessuna di loro ne ha uno — misurato l'11/08/2026: dieci
 * insegnanti in tutta la cooperativa hanno un accesso, otto delle quali a
 * Giugliano — e perché l'account, quando serve, nasce DOPO l'approvazione.
 *
 * ⚠️ NON è `/lavora-con-noi`, che resta il modulo delle CANDIDATURE e non si
 * tocca. Là si valuta una proposta di chi la Scuola non conosce, e il codice
 * fiscale non si chiede affatto; qui si raccoglie l'anagrafica di una dipendente
 * — codice fiscale, documento d'identità e la sua scansione — perché senza quei
 * dati nessun adempimento obbligatorio del datore è eseguibile (UNILAV, libro
 * unico, denunce INPS/INAIL, sostituto d'imposta). Il ragionamento per esteso,
 * con le basi giuridiche e l'elenco dei campi che NON si chiedono mai, sta in
 * `src/lib/forms/personale-template.ts`.
 *
 * ── IL PREFISSO PUBBLICO ────────────────────────────────────────────────────
 *
 * `/anagrafica-personale` sta in `PUBLIC_PREFIXES`
 * (`src/lib/auth/middleware-rules.ts`): senza quella riga questa pagina verrebbe
 * reindirizzata a `/auth/login` e non la vedrebbe nessuno — un difetto che da
 * server non si vede, perché lo si scopre solo aprendo la pagina da
 * disconnessi, e a scoprirlo sarebbe una maestra a cui è stato appena mandato il
 * link. Chi tocca questo file non tolga quella voce:
 * `__tests__/architecture/prefissi-pubblici.test.ts` pretende che a un prefisso
 * pubblico corrisponda una pagina VERA, senza deroghe.
 *
 * ── ⚠️ NON C'È NESSUN `?sede=`, ED È UNA DECISIONE ──────────────────────────
 *
 * Il modulo delle candidature accetta un link «targato» per plesso. Qui no: il
 * link è UNO SOLO per tutte e tre le sedi (decisione del titolare dell'11/08/2026)
 * e la sede la sceglie chi compila, al primo passo, che c'è sempre. La ragione è
 * che questo link non si pubblica su un volantino — lo manda la Segreteria a
 * persone che sanno benissimo in quale plesso lavorano — mentre un uuid dentro
 * un URL inoltrato su WhatsApp da una collega all'altra archivierebbe
 * l'anagrafica nel plesso sbagliato senza che nessuno se ne accorga. Aggiungere
 * il parametro qui non costerebbe una riga: costerebbe il passo in cui la sede si
 * legge e si conferma.
 *
 * `?da=<percorso>` invece c'è, e serve al link di ritorno della riga di testa:
 * queste pagine si aprono anche da dentro l'app. `PublicPageHeader` lo filtra —
 * solo percorsi interni — perché è un valore che scrive chiunque sappia comporre
 * un URL.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('public')
  return {
    title: t('persMetaTitolo'),
    description: t('persMetaDescrizione'),
  }
}

export default async function AnagraficaPersonalePage({
  searchParams,
}: {
  searchParams?: Promise<{ da?: string }>
}) {
  const sp = (await searchParams) ?? {}

  return (
    // ── IL PUNTO DI RIFERIMENTO PER CHI NAVIGA PER REGIONI ────────────────────
    // Il `<main>` è ciò che permette a uno screen reader di saltare al contenuto
    // invece di riscorrere la riga di testa a ogni passo. Sta QUI e non dentro il
    // wizard: il wizard è un componente client ridisegnato dai passi, mentre il
    // landmark è una proprietà della PAGINA. E sta FUORI dal guscio `kv-public`
    // per non entrare nella cascata delle regole per superficie, che agganciano
    // classi e non elementi.
    //
    // ⚠️ E la colonna «Come funziona» resta un `<div>`: da qui che il `<main>`
    // c'è, promuoverla ad `<aside>` la renderebbe un landmark `complementary`
    // ANNIDATO dentro `main` — il rilievo axe `landmark-complementary-is-top-level`.
    // Resta navigabile perché ha la sua intestazione.
    <main>
      <AnagraficaPersonaleWizard
        // La riga di testa pubblica è un componente SERVER e viene passata come
        // slot: è l'unico posto in cui vivono insieme il ritorno tradotto e il
        // comando di Alto Contrasto, ed è il motivo per cui non si ricopia in
        // ogni pagina — sei copie sono sei occasioni di divergere.
        intestazione={<PublicPageHeader ritorno={sp.da} />}
      />
    </main>
  )
}
