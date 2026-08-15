#!/usr/bin/env node
/**
 * Anteprima locale delle dodici email transazionali.
 *
 *     npm run email:anteprima
 *     open scratch/anteprima-email/index.html
 *
 * ─── PERCHÉ UNO SCRIPT E NON UNA ROTTA `/dev/email` ───────────────────────────────────
 * Una rotta costerebbe un `withRoute`, una voce in `PUBBLICHE` col motivo scritto o un
 * gate, una guardia `NODE_ENV !== 'production'` che prima o poi qualcuno sbaglia — e
 * finirebbe comunque nel bundle di produzione. In cambio darebbe l'hot reload, che per
 * template fatti di concatenazione di stringhe vale quasi niente: questo script gira in
 * meno di un secondo.
 *
 * E c'è una ragione più seria: una pagina d'anteprima che rende l'email 01 rende **un
 * riquadro con dentro una password**. Anche con dati finti, una pagina che esiste in
 * produzione e mostra qualcosa che ha la forma di credenziali è una pagina di cui bisogna
 * rendere conto a ogni verifica. Uno script sul portatile non è raggiungibile da nessuno.
 *
 * ─── PERCHÉ L'USCITA STA IN `scratch/` ───────────────────────────────────────────────
 * Perché è già in `.gitignore`. I venticinque HTML sono artefatti generati: invecchiano al
 * primo hex cambiato, e uno di loro contiene una stringa con la forma di una password —
 * cioè esattamente ciò che il lock `niente-password-nel-repo` esiste per tenere fuori dai
 * file tracciati.
 *
 * ─── LE VENTICINQUE VARIANTI ─────────────────────────────────────────────────────────
 * Sono le stesse del pacchetto di consegna, così l'anteprima si può mettere accanto agli
 * HTML del design e confrontare a vista. I dati sono inventati: nessun nome, nessuna
 * email e nessun importo di questo file appartiene a una persona vera.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { register } from 'node:module'

register('./lib/risolvi-alias.mjs', import.meta.url)

const RADICE = dirname(dirname(fileURLToPath(import.meta.url)))
const USCITA = join(RADICE, 'scratch', 'anteprima-email')

const { messaggioCredenziali } = await import('../src/lib/email/messaggi/credenziali.ts')
const { messaggioCodiceVerifica } = await import('../src/lib/email/messaggi/codice-verifica.ts')
const { messaggioSollecito } = await import('../src/lib/email/messaggi/sollecito.ts')
const { messaggioDocumentoDipendente, messaggioDocumentoSegreteria } = await import('../src/lib/email/messaggi/documento-personale.ts')
const { messaggioEsitoCandidatura } = await import('../src/lib/email/messaggi/esito-candidatura.ts')
const { messaggioCancellazioneAccount } = await import('../src/lib/email/messaggi/cancellazione-account.ts')
const { messaggioDigestNews } = await import('../src/lib/email/messaggi/digest-news.ts')
const { messaggioRicevutaIscrizione } = await import('../src/lib/email/messaggi/ricevuta-iscrizione.ts')
const { messaggioConfermaCandidatura } = await import('../src/lib/email/messaggi/conferma-candidatura.ts')

/** Il contesto di Kidville Giugliano, con i dati veri di sede ma nessun dato di persona. */
const SEDE = {
    nome: 'Kidville Giugliano',
    indirizzo: 'Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA)',
    email: 'giugliano@kidville.it',
    telefono: null,
    app: 'https://app.kidville.it',
    privacy: 'https://app.kidville.it/privacy',
}
const SENZA_SEDE = { ...SEDE, nome: 'Kidville', indirizzo: null, email: null }

const IBAN_FINTO = 'IT60X0542811101000000123456'
const PASSWORD_FINTA = 'Kv7-Rana-finta'

const VOCE_UNA = [{ descrizione: 'Retta di marzo 2026', scadenza: '05/03/2026', giorniRitardo: 3, importo: 235 }]
const VOCI_QUATTRO = [
    { descrizione: 'Retta di gennaio 2026', scadenza: '05/01/2026', giorniRitardo: 68, importo: 235 },
    { descrizione: 'Retta di febbraio 2026', scadenza: '05/02/2026', giorniRitardo: 40, importo: 235 },
    { descrizione: 'Mensa — febbraio 2026', scadenza: '20/02/2026', giorniRitardo: 25, importo: 62 },
    { descrizione: 'Uscita didattica del 14/02/2026', scadenza: '20/02/2026', giorniRitardo: 25, importo: 24.5 },
]

const prosa = (livello) => ({
    1: 'Gentile famiglia,\n\nla retta di marzo per Luca risulta ancora da saldare. Se hai già pagato, ignora questo messaggio: l\'accredito può richiedere qualche giorno per comparire.',
    2: 'Gentile famiglia,\n\nla retta di marzo per Luca risulta non saldata da dieci giorni. Ti chiediamo di provvedere nei prossimi giorni con i dati qui sotto.',
    3: 'Gentile famiglia,\n\nla retta di marzo per Luca risulta non saldata da venti giorni.',
}[livello])

const ARTICOLI = [
    ['Avvisi', 'Chiusura per il ponte del 25 aprile', 'La sede resta chiusa venerdì 24 e sabato 25 aprile. Le attività riprendono lunedì 27 con il consueto orario di ingresso.'],
    ['Avvisi', 'Nuovo orario di ingresso dal 6 aprile', 'L\'ingresso si allarga di quindici minuti: dalle 7:45 alle 9:15, per distribuire meglio l\'arrivo delle famiglie al cancello.'],
    ['Avvisi', 'Ritiro dei cambi di stagione', 'Entro venerdì chiediamo di portare a casa i sacchetti con i vestiti pesanti e di lasciare due cambi leggeri negli armadietti.'],
    ['Didattica', 'Il progetto orto arriva nel giardino grande', 'Le sezioni primavera hanno seminato fagioli e pomodori. Ogni gruppo segue una fila e annota la crescita sul quaderno di bordo.'],
    ['Didattica', 'Letture ad alta voce, il calendario di aprile', 'Ogni martedì pomeriggio una lettura condivisa nell\'angolo morbido. I titoli del mese sono nel diario di sezione.'],
    ['Didattica', 'Inglese in sezione: cosa stiamo facendo', 'Canzoni, routine e nomi degli oggetti quotidiani. L\'obiettivo di questo trimestre è l\'ascolto, non la produzione.'],
    ['Didattica', 'Laboratorio di musica, secondo ciclo', 'Sei incontri con strumenti a percussione. Le date sono pubblicate nell\'agenda dell\'area genitori.'],
    ['Eventi', 'Festa di primavera, sabato 18 aprile', 'Dalle 10 alle 13 in giardino, con laboratori aperti e merenda condivisa. La partecipazione si conferma in app.'],
    ['Eventi', 'Colloqui individuali, iscrizioni aperte', 'Le fasce disponibili sono visibili in app fino a esaurimento. Ogni colloquio dura venti minuti.'],
    ['Eventi', 'Open day del nido, sabato 9 maggio', 'Visita guidata degli spazi 0-3 con le educatrici di riferimento. Ingressi ogni mezz\'ora, su prenotazione.'],
    ['Eventi', 'Spettacolo di fine anno: si cerca una mano', 'Serve aiuto per scenografie e costumi. Chi vuole partecipare può segnalarsi in segreteria entro il 20 aprile.'],
    ['Cucina', 'Il menu di primavera parte lunedì', 'Quattro settimane di rotazione con verdure di stagione. Il menù completo è nell\'area genitori, sezione Cucina.'],
    ['Cucina', 'Merende: cosa portare e cosa no', 'Frutta fresca e pane sono sempre bene accetti. Ricordiamo di non inviare prodotti sfusi senza etichetta.'],
    ['Cucina', 'Visita HACCP superata senza rilievi', 'Il controllo di marzo si è chiuso senza prescrizioni. Il verbale è consultabile in segreteria su richiesta.'],
    ['Amministrazione', 'Rette di aprile disponibili in app', 'L\'avviso di pagamento è già visibile nella sezione Pagamenti, con causale precompilata.'],
    ['Amministrazione', 'Voucher comunale 0-3, domande entro il 30', 'Chi ha diritto al contributo può presentare la domanda in segreteria. Serve l\'ISEE in corso di validità.'],
    ['Amministrazione', 'Deleghe per il ritiro: aggiornamento annuale', 'Chiediamo di verificare in app i nomi delle persone delegate e di aggiornarli se qualcosa è cambiato.'],
    ['Amministrazione', 'Assicurazione infortuni: copertura 2026', 'La polizza è stata rinnovata. Le condizioni sono pubblicate nella sezione Documenti dell\'area genitori.'],
    ['Sedi', 'Nuovi giochi nel giardino', 'Sono arrivate due strutture per l\'arrampicata, montate e collaudate. L\'area sabbia resta chiusa una settimana.'],
    ['Sedi', 'Lavori di tinteggiatura nel fine settimana', 'Interventi previsti sabato e domenica, a scuola chiusa. Lunedì le sezioni tornano regolarmente agibili.'],
].map(([categoria, titolo, estratto]) => ({ categoria, titolo, estratto, url: 'https://app.kidville.it/parent/news' }))

const OPERAZIONI = [
    'firmare la domanda d\'iscrizione',
    'firmare il modulo',
    'confermare la giustifica dell\'assenza',
    'confermare la presa visione della nota',
    'confermare la ricezione della pagella',
]

const VARIANTI = [
    ['01-credenziali-iscrizione-approvata', 'Credenziali · iscrizione approvata', messaggioCredenziali({ nome: 'Maria Esposito', email: 'maria.esposito@example.it', password: PASSWORD_FINTA, occasione: 'iscrizione-approvata' }, SEDE)],
    ['01-credenziali-inserimento-anagrafica', 'Credenziali · inserimento in anagrafica (senza nome)', messaggioCredenziali({ nome: null, email: 'famiglia@example.it', password: PASSWORD_FINTA, occasione: 'inserimento-anagrafica' }, SEDE)],
    ['01-credenziali-password-rigenerata', 'Credenziali · password rigenerata', messaggioCredenziali({ nome: 'Maria Esposito', email: 'maria.esposito@example.it', password: PASSWORD_FINTA, occasione: 'password-rigenerata' }, SEDE)],
    ['01-credenziali-candidatura-accolta', 'Credenziali · candidatura accolta (personale)', messaggioCredenziali({ nome: 'Anna Ricci', email: 'anna.ricci@example.it', password: PASSWORD_FINTA, occasione: 'candidatura-accolta' }, SEDE)],
    ...OPERAZIONI.map((op, i) => [`02-codice-verifica-${i + 1}`, `Codice di verifica · ${op}`, messaggioCodiceVerifica({ codice: '418 297', operazione: op, minuti: 10 }, SEDE)]),
    ['03-promemoria-una-voce', 'Promemoria · una voce', messaggioSollecito({ livello: 1, oggetto: 'Promemoria pagamento — Retta di marzo 2026', prosa: prosa(1), alunno: 'Luca Esposito', voci: VOCE_UNA, causale: 'Retta marzo 2026 — Luca Esposito', iban: IBAN_FINTO, intestatario: 'Scuola dell\'infanzia La Favola soc. coop.' }, SEDE)],
    ['03-promemoria-quattro-voci', 'Promemoria · quattro arretrati con totale', messaggioSollecito({ livello: 1, oggetto: 'Promemoria pagamento — 4 pagamenti arretrati', prosa: prosa(1), alunno: 'Luca Esposito', voci: VOCI_QUATTRO, causale: 'Pagamenti arretrati — Luca Esposito', iban: IBAN_FINTO, intestatario: 'Scuola dell\'infanzia La Favola soc. coop.' }, SEDE)],
    ['04-sollecito-una-voce', 'Sollecito · una voce', messaggioSollecito({ livello: 2, oggetto: 'Sollecito di pagamento — Retta di marzo 2026', prosa: prosa(2), alunno: 'Luca Esposito', voci: VOCE_UNA, causale: 'Retta marzo 2026 — Luca Esposito', iban: IBAN_FINTO, intestatario: 'Scuola dell\'infanzia La Favola soc. coop.' }, SEDE)],
    ['04-sollecito-quattro-voci', 'Sollecito · quattro arretrati con totale', messaggioSollecito({ livello: 2, oggetto: 'Sollecito di pagamento — 4 pagamenti arretrati', prosa: prosa(2), alunno: 'Luca Esposito', voci: VOCI_QUATTRO, causale: 'Pagamenti arretrati — Luca Esposito', iban: IBAN_FINTO, intestatario: 'Scuola dell\'infanzia La Favola soc. coop.' }, SEDE)],
    ['05-secondo-sollecito-una-voce', 'Secondo sollecito · una voce', messaggioSollecito({ livello: 3, oggetto: 'Secondo sollecito — Retta di marzo 2026', prosa: prosa(3), alunno: 'Luca Esposito', voci: VOCE_UNA, causale: 'Retta marzo 2026 — Luca Esposito', iban: IBAN_FINTO, intestatario: 'Scuola dell\'infanzia La Favola soc. coop.' }, SEDE)],
    ['05-secondo-sollecito-senza-iban', 'Secondo sollecito · senza IBAN configurato', messaggioSollecito({ livello: 3, oggetto: 'Secondo sollecito — 4 pagamenti arretrati', prosa: prosa(3), alunno: 'Luca Esposito', voci: VOCI_QUATTRO, causale: 'Pagamenti arretrati — Luca Esposito', iban: null, intestatario: 'Scuola dell\'infanzia La Favola soc. coop.' }, SEDE)],
    ['06-documento-dipendente-in-scadenza', 'Documento · alla dipendente, in scadenza', messaggioDocumentoDipendente({ nome: 'Anna Ricci', tipoDocumento: 'Carta d\'identità', scadenza: '12/03/2026', scaduto: false }, SEDE)],
    ['06-documento-dipendente-scaduto', 'Documento · alla dipendente, scaduto', messaggioDocumentoDipendente({ nome: 'Anna Ricci', tipoDocumento: 'Carta d\'identità', scadenza: '12/03/2026', scaduto: true }, SEDE)],
    ['07-documento-segreteria-in-scadenza', 'Documento · alla segreteria, in scadenza', messaggioDocumentoSegreteria({ nome: 'Anna Ricci', tipoDocumento: 'Carta d\'identità', scadenza: '12/03/2026', scaduto: false, urlAnagrafica: 'https://app.kidville.it/admin/staff' }, SEDE)],
    ['07-documento-segreteria-scaduto', 'Documento · alla segreteria, scaduto', messaggioDocumentoSegreteria({ nome: 'Anna Ricci', tipoDocumento: 'Carta d\'identità', scadenza: '12/03/2026', scaduto: true, urlAnagrafica: 'https://app.kidville.it/admin/staff' }, SEDE)],
    ['08-esito-candidatura', 'Esito negativo di una candidatura', messaggioEsitoCandidatura({ nome: 'Anna Ricci' }, SEDE)],
    ['09-cancellazione-account', 'Cancellazione account · IT + EN', messaggioCancellazioneAccount({ urlConferma: 'https://app.kidville.it/cancellazione-account/conferma?t=9f2c1a', oreValidita: 1 }, SENZA_SEDE)],
    ['10-digest-news-un-articolo', 'Digest news · un articolo', messaggioDigestNews({ mese: 'marzo', anno: 2026, articoli: [ARTICOLI[7]] }, SEDE)],
    ['10-digest-news-venti-articoli', 'Digest news · venti articoli', messaggioDigestNews({ mese: 'marzo', anno: 2026, articoli: ARTICOLI }, SEDE)],
    ['11-ricevuta-iscrizione', 'Ricevuta d\'iscrizione', messaggioRicevutaIscrizione({ riferimento: 'ISC-4F2C1A88', inviataIl: '12/03/2026 alle 18:42', nomeBambino: 'Luca Esposito', sezione: 'Sezione primavera (2-3 anni)', genitore: 'Maria Esposito' }, SEDE)],
    ['12-conferma-candidatura', 'Conferma di candidatura', messaggioConfermaCandidatura({ nome: 'Anna Ricci', inviataIl: '12/03/2026 alle 18:42', ruolo: 'Educatrice nido', numeroAllegati: 2, giorniRisposta: 30 }, SEDE)],
    // Le stesse credenziali con un'altra sede: è la prova a vista che la sede è
    // un parametro e non una costante.
    ['13-altra-sede-cesa', 'Prova multi-sede · le stesse credenziali da Cesa', messaggioCredenziali({ nome: 'Maria Esposito', email: 'maria.esposito@example.it', password: PASSWORD_FINTA, occasione: 'iscrizione-approvata' }, { ...SEDE, nome: 'Kidville Cesa', indirizzo: 'Via Filippo Turati 2, 81030 Cesa (CE)', email: 'cesa@kidville.it' })],
    // Un piè di pagina che degrada: nessun recapito, nessun indirizzo.
    ['14-sede-senza-recapiti', 'Prova di degrado · sede senza indirizzo né casella', messaggioCredenziali({ nome: 'Maria Esposito', email: 'maria.esposito@example.it', password: PASSWORD_FINTA, occasione: 'iscrizione-approvata' }, { ...SEDE, indirizzo: null, email: null })],
]

rmSync(USCITA, { recursive: true, force: true })
mkdirSync(USCITA, { recursive: true })

for (const [slug, , m] of VARIANTI) {
    writeFileSync(join(USCITA, `${slug}.html`), m.html)
    writeFileSync(join(USCITA, `${slug}.txt`), m.testo)
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const righe = VARIANTI.map(([slug, etichetta, m]) => `
  <section id="${esc(slug)}">
    <h2>${esc(etichetta)}</h2>
    <p class="oggetto"><strong>Oggetto:</strong> ${esc(m.oggetto)}</p>
    <div class="cornici">
      <div><div class="lbl">600 px</div><iframe src="${esc(slug)}.html" width="620" height="720"></iframe></div>
      <div><div class="lbl">375 px</div><iframe src="${esc(slug)}.html" width="375" height="720"></iframe></div>
      <div><div class="lbl">320 px</div><iframe src="${esc(slug)}.html" width="320" height="720"></iframe></div>
    </div>
    <details><summary>Gemello in testo semplice</summary><pre>${esc(m.testo)}</pre></details>
  </section>`).join('')

const indice = `<!DOCTYPE html>
<html lang="it"><head><meta charset="utf-8"><title>Anteprima email Kidville</title>
<style>
  body{margin:0;padding:24px;background:#FEF1E4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1F2937}
  h1{color:#006A5F;font-size:24px;margin:0 0 4px}
  .barra{position:sticky;top:0;background:#FEF1E4;padding:12px 0;border-bottom:2px solid #E5E7EB;margin-bottom:20px;z-index:9}
  button{background:#006A5F;color:#fff;border:0;border-radius:999px;padding:8px 16px;font-size:14px;font-weight:700;cursor:pointer;margin-right:8px}
  nav a{display:inline-block;margin:0 10px 6px 0;color:#006A5F;font-size:13px}
  section{background:#fff;border-radius:16px;padding:18px;margin-bottom:20px}
  h2{color:#006A5F;font-size:18px;margin:0 0 4px}
  .oggetto{font-size:13px;color:#6B7280;margin:0 0 12px}
  .cornici{display:flex;gap:16px;flex-wrap:wrap}
  .lbl{font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
  iframe{border:1px solid #E5E7EB;border-radius:8px;background:#fff}
  pre{white-space:pre-wrap;font-size:12px;background:#F9FAFB;padding:12px;border-radius:8px;overflow-x:auto}
  summary{cursor:pointer;color:#006A5F;font-size:13px;margin-top:12px}
  .senza-immagini iframe{filter:none}
</style></head><body>
<div class="barra">
  <h1>Anteprima email Kidville — ${VARIANTI.length} varianti</h1>
  <p style="font-size:13px;color:#6B7280;margin:4px 0 10px">Dati inventati. Nessun nome, indirizzo o importo di questa pagina appartiene a una persona vera.</p>
  <button onclick="scuro()">Chiaro / scuro</button>
  <button onclick="immagini()">Immagini attive / bloccate</button>
</div>
<nav>${VARIANTI.map(([slug, etichetta]) => `<a href="#${esc(slug)}">${esc(etichetta)}</a>`).join('')}</nav>
${righe}
<script>
  let buio = false, senzaImg = false;
  function perOgniDoc(fn){ for (const f of document.querySelectorAll('iframe')) { try { fn(f.contentDocument) } catch (e) { /* il documento non è ancora pronto: al prossimo clic ci sarà */ } } }
  function scuro(){ buio = !buio; perOgniDoc(d => { if (d) d.documentElement.toggleAttribute('data-force-dark', buio) }) }
  function immagini(){ senzaImg = !senzaImg; perOgniDoc(d => { if (!d) return; for (const i of d.querySelectorAll('img')) i.style.visibility = senzaImg ? 'hidden' : '' }) }
</script>
</body></html>`

writeFileSync(join(USCITA, 'index.html'), indice)

console.log(`${VARIANTI.length} varianti in scratch/anteprima-email/ (HTML + gemello testuale)`)
console.log(`Apri:  open ${join('scratch', 'anteprima-email', 'index.html')}`)
