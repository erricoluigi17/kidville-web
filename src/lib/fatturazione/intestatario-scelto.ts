/**
 * L'INTESTATARIO SCELTO A MANO — la forma dei dati che l'operatore può indicare
 * al posto (o in assenza) di quello dedotto dall'anagrafica.
 *
 * ─── PERCHÉ ESISTE, misurato in produzione il 2026-09-04 ─────────────────────
 * Su 93 pagamenti saldati, 88 rispondono «Intestatario fattura non impostato
 * sull'anagrafica» e non emettono niente: 579 alunni su 630 non hanno alcun
 * intestatario risolvibile, due genitori su 735 sono marcati «intestatario di
 * famiglia», e le fatture emesse in tutto sono TRE. La scelta quindi non
 * raffina: deve poter FORNIRE l'intestatario dove non c'è.
 *
 * ─── PERCHÉ UN'UNIONE DISCRIMINATA E NON «UNO DEI DUE CAMPI» ─────────────────
 *  · il ramo `adult` porta SOLO l'id: nome, codice fiscale e residenza si
 *    rileggono server-side con `resolveParentRegistry`. Accettare l'anagrafica
 *    dal client per una persona che abbiamo in archivio vorrebbe dire lasciar
 *    intestare una fattura a un genitore vero con un codice fiscale forgiato dal
 *    browser;
 *  · il ramo `persona` non ha nessuna riga da rileggere: quel payload È la
 *    fonte, e le difese sono `validaCessionario` lato server più lo snapshot in
 *    `fatture_emesse.intestatario`;
 *  · l'unione rende IRRAPPRESENTABILE l'ibrido «adult_id + campi anagrafici»,
 *    che sarebbe l'unico modo di mettere le due difese l'una contro l'altra.
 *
 * Gli oggetti sono STRETTI (`z.strictObject`), non semplicemente non-loose: uno
 * `z.object` scarta le chiavi in più e risponde 200: è alla lettera il difetto
 * del trasferimento di sede del 2026-09-04, dove `patchBodySchema` scartava
 * `scuola_id` in silenzio e la schermata diceva «fatto» senza spostare nessuno.
 *
 * ─── FUORI SCOPE, PER DECISIONE DEL TITOLARE ────────────────────────────────
 * Nessun `Denominazione`, nessun `IdFiscaleIVA`, nessun cessionario ENTE: qui si
 * intesta a una persona fisica e basta. Non è una dimenticanza da colmare al
 * primo che la chiede — un cessionario ente cambia il blocco 1.4 del tracciato e
 * la partita IVA di un ente non è verificabile da qui. Il lock
 * `__tests__/architecture/intestatario-fattura-un-motore-solo.test.ts` sorveglia
 * che quei due elementi non compaiano nel cessionario.
 *
 * ─── PURO ───────────────────────────────────────────────────────────────────
 * Nessun I/O e NESSUN import di `@/lib/logging/logger`: trascina `node:crypto`,
 * e questa forma deve poter girare anche nel browser mentre si compila il modulo
 * (stessa ragione già scritta in `cessionario.ts`). `LIMITI` arriva da
 * `@/lib/aruba/fatturapa-xml`, che non importa niente a sua volta.
 */
import { z } from 'zod'
import { LIMITI } from '@/lib/aruba/fatturapa-xml'
import type { AnagraficaCessionario } from './cessionario'

/**
 * L'anagrafica di un intestatario che NON viene da `parents`: gli stessi sei
 * campi obbligatori di `validaCessionario`, più i due FACOLTATIVI del tracciato
 * (provincia e numero civico) che per un genitore in archivio si leggono a parte
 * con `leggiResidenzaEstesa`, e qui invece arrivano insieme al resto.
 */
export interface AnagraficaFatturabile extends AnagraficaCessionario {
    provincia?: string | null
    numero_civico?: string | null
}

/**
 * ⚠️ I MASSIMI SONO IMPORTATI, NON RISCRITTI.
 *
 * Il generatore XML TRONCA a `LIMITI` come ultima difesa: due copie dello stesso
 * numero divergono prima o poi, e qui divergere significa un troncamento
 * silenzioso sul nome di un documento fiscale. Sopra il limite si RIFIUTA — chi
 * scrive vede l'errore e accorcia, invece di scoprire il taglio sulla fattura.
 *
 * `codice_fiscale` non ha una voce in `LIMITI` e non gliene si aggiunge una: là
 * dentro un numero significa «tronca fin lì», e troncare un codice fiscale
 * produrrebbe un documento formalmente valido intestato a nessuno. I 16 sono il
 * tetto del `pattern` dello XSD (`[A-Za-z0-9]{11,16}`), e a dire se la FORMA va
 * bene è `validaCessionario`, che nomina il campo — per questo il minimo qui è 1
 * e non 11: un CAP di quattro cifre o un codice fiscale corto devono arrivare al
 * messaggio che spiega, non a un 400 di forma.
 */
const MAX_CODICE_FISCALE = 16
/** `ProvinciaType` è `[A-Z]{2}`: il generatore omette una sigla di forma diversa. */
const MAX_PROVINCIA = 2

const testo = (max: number) => z.string().trim().min(1).max(max)

const zPersonaScelta = z.strictObject({
    tipo: z.literal('persona'),
    codice_fiscale: testo(MAX_CODICE_FISCALE),
    nome: testo(LIMITI.nome),
    cognome: testo(LIMITI.cognome),
    indirizzo: testo(LIMITI.indirizzo),
    cap: testo(5),
    comune: testo(LIMITI.comune),
    provincia: z.string().trim().max(MAX_PROVINCIA).optional(),
    numero_civico: z.string().trim().max(LIMITI.numeroCivico).optional(),
})

const zAdultScelto = z.strictObject({
    tipo: z.literal('adult'),
    adult_id: z.string().trim().min(1),
})

export const zIntestatarioScelto = z.discriminatedUnion('tipo', [zAdultScelto, zPersonaScelta])

export type IntestatarioScelto = z.infer<typeof zIntestatarioScelto>
export type PersonaScelta = z.infer<typeof zPersonaScelta>

function s(v: unknown): string {
    return typeof v === 'string' ? v.trim() : ''
}

/**
 * Il payload `persona` → l'anagrafica da validare e da scrivere sul documento.
 * Copia, non deduce: nessuno spezza «Della Valle Ottavio» in nome e cognome, che
 * è il motivo per cui il contratto con l'interfaccia tiene i due campi distinti.
 */
export function anagraficaDaPersonaScelta(p: PersonaScelta): AnagraficaFatturabile {
    return {
        codice_fiscale: p.codice_fiscale,
        nome: p.nome,
        cognome: p.cognome,
        indirizzo: p.indirizzo,
        cap: p.cap,
        comune: p.comune,
        provincia: s(p.provincia),
        numero_civico: s(p.numero_civico),
    }
}

/**
 * `alunni.intestatario_fatture.dati` (ramo `tipo: 'altro'`) → la stessa anagrafica.
 *
 * ⚠️ QUI NON C'È NESSUN RIPIEGO, ED È IL PUNTO. Un `altro` incompleto non ricade
 * sul default di famiglia: passa di qui con i campi vuoti che ha, e il gate
 * `validaCessionario` lo ferma nominandoli. Ricadere sulla famiglia sarebbe
 * rifare in un posto nuovo il difetto che questo lotto chiude — una scelta
 * esplicita dell'operatore ignorata senza dire niente.
 *
 * `email` è nel contratto con l'interfaccia ma NON nel tracciato del cessionario:
 * resta fuori di proposito, e non si aggiunge «perché c'è».
 */
/**
 * `alunni.intestatario_fatture` → l'anagrafica digitata, o `null` se quella
 * scheda punta a un genitore in archivio (che si rilegge da `parents`).
 *
 * ⚠️ ESISTE PERCHÉ I DOCUMENTI SONO QUATTRO, NON UNO. Chi paga la retta riceve
 * nell'arco di un anno la fattura elettronica, la ricevuta, l'attestazione per
 * il 730 e una riga nella comunicazione all'Agenzia delle Entrate. Fino al
 * 2026-09-04 gli ultimi tre leggevano `intestatario_fatture.adult_id` — un
 * campo che sul ramo `'altro'` non esiste — e ripiegavano su «Famiglia
 * ⟨cognome⟩», o escludevano la riga per «codice fiscale del pagatore mancante».
 * La stessa famiglia avrebbe ricevuto quattro documenti con due intestatari
 * diversi, e sui due che vanno al fisco l'intestatario decide chi ottiene la
 * detrazione.
 */
export function anagraficaDaScheda(intestatarioFatture: unknown): AnagraficaFatturabile | null {
    const i = (intestatarioFatture && typeof intestatarioFatture === 'object' ? intestatarioFatture : {}) as {
        tipo?: unknown
        dati?: unknown
    }
    if (i.tipo !== 'altro') return null
    return anagraficaDaIntestatarioAltro(i.dati)
}

/** Il nome intero di un intestatario digitato, vuoto se non ce n'è uno. */
export function nomeDaAnagrafica(a: AnagraficaFatturabile | null | undefined): string {
    if (!a) return ''
    return [a.nome, a.cognome].filter(Boolean).join(' ').trim()
}

export function anagraficaDaIntestatarioAltro(dati: unknown): AnagraficaFatturabile {
    const d = (dati && typeof dati === 'object' ? dati : {}) as Record<string, unknown>
    return {
        codice_fiscale: s(d.cf),
        nome: s(d.nome),
        cognome: s(d.cognome),
        indirizzo: s(d.indirizzo),
        cap: s(d.cap),
        comune: s(d.comune),
        provincia: s(d.provincia),
        numero_civico: s(d.civico),
    }
}
