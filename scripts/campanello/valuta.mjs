// LA LOGICA DEL CAMPANELLO — pura: niente rete, niente orologio, niente variabili d'ambiente.
//
// Roadmap di robustezza, fase 3 (2026-10-06). Questo file decide COSA è un incidente; chi lo apre, lo
// ricorda o lo chiude è `riconcilia()`; chi parla con GitHub e con Resend sta in `allarme.mjs`; chi
// mette tutto in fila ogni quarto d'ora è `campanello.mjs`. Tenere la decisione separata dall'I/O è ciò
// che permette di provarla con numeri letterali (`__tests__/lib/campanello-valuta.test.ts`) invece di
// aspettare che il sito cada.
//
// ⚠️ TUTTO CIÒ CHE ESCE DA QUI FINISCE IN UNA SEGNALAZIONE DI UN REPOSITORY PUBBLICO. Per questo gli
// incidenti portano solo ciò che gli endpoint di salute già espongono al mondo (nomi di controllo, di
// job, di variabile — mai valori —, codici, numeri) e sono tagliati a una lunghezza ragionevole.

/** Oltre quante ore dall'ultimo giro AUTOMATICO riuscito il backup notturno è «non partito».
 *
 *  Il giro è alle 02:23 UTC. 30 ore non sono un tetto scelto a gusto: il 2026-10-06 il PRIMO giro
 *  programmato è partito alle 09:08 UTC, con 6 ore e 45 minuti di ritardo (GitHub ritarda e salta i
 *  giri di un `cron`, ed è proprio il guasto che questo controllo esiste per vedere). Con 26 ore
 *  sarebbe suonato per un ritardo di due ore, che capita; con 30 suona se alle 08:30 UTC il giro di
 *  oggi non è ancora finito, cioè quando un ritardo ha smesso di essere un ritardo.
 *
 *  Si guarda solo `event = schedule`: un giro lanciato a mano può essere in modalità `prova` (scrive
 *  sotto `prove/` e non è un backup), e dall'API dei giri non si distingue dal `completo`. */
export const ORE_ALLARME_BACKUP = 30

/** La regione in cui devono girare le funzioni: quella del database. Copia di `REGIONE_ATTESA` in
 *  `src/lib/health/controlli.ts` (qui non si importa TypeScript); un lock le tiene uguali. */
export const REGIONE_ATTESA = 'dub1'

/** Dopo quanto un incidente ancora aperto riceve un commento di promemoria (e smette di sembrare
 *  dimenticato). Non è un'email: è un commento, che GitHub notifica a chi segue la segnalazione. */
export const PROMEMORIA_DOPO_MS = 24 * 3_600_000

const ORA_MS = 3_600_000
const TETTO_TESTO = 300

/** @typedef {{ chiave: string, titolo: string, dettaglio: string }} Incidente */

/** Taglia un testo per la segnalazione pubblica e toglie ogni a-capo: una riga, una frase. */
function breve(testo) {
    const t = String(testo ?? '').replace(/\s+/g, ' ').trim()
    return t.length > TETTO_TESTO ? `${t.slice(0, TETTO_TESTO - 1)}…` : t
}

/** `nome(esito): dettaglio` per ogni controllo che non è `ok`. Solo ciò che l'endpoint pubblico dice. */
export function elencaControlliRotti(corpo) {
    const controlli = Array.isArray(corpo?.controlli) ? corpo.controlli : []
    return controlli
        .filter((c) => c && c.esito !== 'ok')
        .map((c) => `${breve(c.nome)}(${breve(c.esito)})${c.dettaglio ? `: ${breve(c.dettaglio)}` : ''}`)
}

/**
 * IL VIVO. `risposta` = `{ http, corpo }` dell'ULTIMO tentativo; `http` è `null` se la rete è caduta
 * o il tentativo è scaduto. Un solo incidente, `app-giu`: se il sito non serve i genitori non importa
 * sapere QUALE dei due controlli è caduto per decidere di svegliare qualcuno — importa che il dettaglio
 * lo dica a chi si sveglia.
 * @returns {Incidente | null}
 */
export function valutaVivo(risposta) {
    const { http, corpo } = risposta
    if (http === 200 && corpo?.stato === 'ok') return null
    const rotti = elencaControlliRotti(corpo)
    let dettaglio
    if (http === null || http === undefined) dettaglio = 'nessuna risposta (rete o tempo scaduto)'
    else if (rotti.length > 0) dettaglio = `HTTP ${http}: ${rotti.join(' | ')}`
    else dettaglio = `HTTP ${http} senza un corpo leggibile`
    return {
        chiave: 'app-giu',
        titolo: 'Il sito non risponde (database o login)',
        dettaglio: breve(dettaglio),
    }
}

/**
 * LA SALUTE. Un incidente per controllo non `ok`, con chiave `salute:<nome>`: chi riceve la
 * segnalazione sa SUBITO di che cosa si tratta (un cron muto non è una variabile sparita, e le due
 * urgenze svegliano persone diverse), e le segnalazioni si chiudono una per una quando il controllo
 * rientra. Una risposta illeggibile è `salute:illeggibile` — un campanello che tace perché non capisce
 * la risposta è peggio di uno spento.
 * @returns {Incidente[]}
 */
export function valutaSalute(risposta) {
    const { http, corpo } = risposta
    if (!Array.isArray(corpo?.controlli)) {
        return [
            {
                chiave: 'salute:illeggibile',
                titolo: 'La salute dell\'app non è leggibile',
                dettaglio: breve(http === null || http === undefined ? 'nessuna risposta' : `HTTP ${http} senza un corpo leggibile`),
            },
        ]
    }
    return corpo.controlli
        .filter((c) => c && c.esito !== 'ok' && typeof c.nome === 'string' && /^[a-z0-9-]+$/.test(c.nome))
        .map((c) => ({
            chiave: `salute:${c.nome}`,
            titolo: `Salute: ${c.nome} ${c.esito}`,
            dettaglio: breve(c.dettaglio ?? 'nessun dettaglio'),
        }))
}

/**
 * IL BACKUP. `giri` = i giri RIUSCITI e AUTOMATICI di `backup-notturno.yml`, dal più recente
 * (`GET …/runs?event=schedule&status=success`). Nessun giro, o il più recente più vecchio di
 * `ORE_ALLARME_BACKUP` ore → `backup-vecchio`.
 * @returns {Incidente | null}
 */
export function valutaBackup({ giri, adesso }) {
    const ultimo = (giri ?? []).find((g) => g && g.conclusion === 'success' && Number.isFinite(Date.parse(g.updated_at)))
    if (!ultimo) {
        return {
            chiave: 'backup-vecchio',
            titolo: 'Il backup notturno non è mai riuscito in automatico',
            dettaglio: 'Nessun giro automatico riuscito di backup-notturno.yml. Un giro manuale non basta: la copia di ogni notte è quella che conta.',
        }
    }
    const etaMs = adesso - Date.parse(ultimo.updated_at)
    if (etaMs <= ORE_ALLARME_BACKUP * ORA_MS) return null
    const ore = Math.floor(etaMs / ORA_MS)
    return {
        chiave: 'backup-vecchio',
        titolo: `Il backup notturno è fermo da ${ore} ore`,
        dettaglio: `L'ultimo giro automatico riuscito è di ${ore} ore fa (soglia ${ORE_ALLARME_BACKUP}). Il giro delle 02:23 UTC non è partito o non è finito: vedi i giri di backup-notturno.yml.`,
    }
}

/**
 * LA VERIFICA DOPO IL DEPLOY. Restituisce l'elenco dei guasti (vuoto = rilascio buono) e, a parte, le
 * note che non fermano niente.
 *
 * `vivo`/`salute` = `{ http, corpo }`; `intestazioneVercelId` = valore di `x-vercel-id` della risposta
 * del vivo (`fra1::dub1::…`: il SECONDO pezzo è la regione della funzione).
 *
 * Solo il vivo e la regione FERMANO il rilascio. `degraded` della salute (un cron muto, una variabile)
 * è una nota: non lo ha causato il deploy, e bloccare ogni rilascio per un guasto che c'era già
 * insegnerebbe a ignorare la verifica.
 * @returns {{ guasti: string[], note: string[] }}
 */
export function valutaDopoDeploy({ vivo, salute, intestazioneVercelId }) {
    const guasti = []
    const note = []

    const incVivo = valutaVivo(vivo)
    if (incVivo) guasti.push(`vivo: ${incVivo.dettaglio}`)

    const regione = vivo.corpo?.regione
    if (regione !== undefined && regione !== REGIONE_ATTESA) {
        guasti.push(`funzione in ${breve(regione)}, attesa ${REGIONE_ATTESA} (la regione del database)`)
    }
    if (typeof intestazioneVercelId === 'string' && intestazioneVercelId !== '' && !intestazioneVercelId.includes(`::${REGIONE_ATTESA}::`)) {
        guasti.push(`x-vercel-id senza ::${REGIONE_ATTESA}:: (${breve(intestazioneVercelId.split('-')[0])})`)
    }

    if (salute.http === 503 || salute.corpo?.stato === 'down') {
        guasti.push(`salute: ${breve(elencaControlliRotti(salute.corpo).join(' | ') || 'down')}`)
    } else if (salute.corpo?.stato === 'degraded') {
        note.push(`salute degraded (non bloccante): ${breve(elencaControlliRotti(salute.corpo).join(' | '))}`)
    } else if (salute.http === null || salute.http === undefined) {
        note.push('salute non raggiungibile (non bloccante: il vivo è il verdetto)')
    }
    return { guasti, note }
}

/** La chiave di un incidente dal titolo della sua segnalazione: `[chiave] testo`. */
export function chiaveDaTitolo(titolo) {
    const m = /^\[([a-z0-9:_.-]+)\]/.exec(String(titolo ?? ''))
    return m ? m[1] : null
}

/**
 * RICONCILIA le segnalazioni aperte con gli incidenti di adesso.
 *
 *  · `apri`   — incidente senza segnalazione aperta: se ne apre una e parte l'email;
 *  · `ricorda`— segnalazione aperta E incidente ancora presente, non toccata da `PROMEMORIA_DOPO_MS`:
 *               un commento (niente email), perché un incidente aperto da tre giorni non sembri
 *               dimenticato;
 *  · `chiudi` — segnalazione aperta il cui incidente è rientrato: commento e chiusura.
 *
 * Una segnalazione senza `[chiave]` nel titolo non è del campanello e non si tocca.
 *
 * ⚠️ `verificate` dice quali chiavi QUESTO giro ha davvero misurato. Una segnalazione si chiude solo
 * se la sua chiave è stata verificata e non è risultata un incidente: «non l'ho guardato» non è
 * «è rientrato». Il caso vero: se il sito è giù, la salute non si legge, e chiudere le segnalazioni
 * `salute:*` perché «non compaiono più» le farebbe sparire proprio mentre il guasto è in corso. Lo
 * stesso per il backup quando l'API dei giri non risponde.
 * @param {{ aperte: { numero: number, titolo: string, ultimoAggiornamento: string }[], attuali: Incidente[], adesso: number, verificate?: (chiave: string) => boolean }} p
 */
export function riconcilia({ aperte, attuali, adesso, verificate = () => true }) {
    const perChiave = new Map()
    for (const a of aperte) {
        const chiave = chiaveDaTitolo(a.titolo)
        if (chiave) perChiave.set(chiave, a)
    }
    const presenti = new Set(attuali.map((i) => i.chiave))

    const apri = attuali.filter((i) => !perChiave.has(i.chiave))
    const ricorda = attuali
        .filter((i) => perChiave.has(i.chiave))
        .map((i) => ({ incidente: i, numero: perChiave.get(i.chiave).numero, ultimo: Date.parse(perChiave.get(i.chiave).ultimoAggiornamento) }))
        .filter((x) => Number.isFinite(x.ultimo) && adesso - x.ultimo > PROMEMORIA_DOPO_MS)
        .map(({ incidente, numero }) => ({ incidente, numero }))
    const chiudi = [...perChiave.entries()]
        .filter(([chiave]) => !presenti.has(chiave) && verificate(chiave))
        .map(([chiave, a]) => ({ chiave, numero: a.numero }))

    return { apri, ricorda, chiudi }
}
