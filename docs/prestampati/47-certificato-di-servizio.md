# 47 — Certificato di servizio (personale)

**Genera** la segreteria da `/admin` · **Firma** legale rappresentante · **Protocollo** in uscita
**Archivia** fascicolo del dipendente · **Fonte** ➕ **nuovo**

L'unico dei diciassette che non riguarda un bambino. È il documento che ogni insegnante chiede
almeno una volta l'anno — per le graduatorie MIUR, per un concorso, per un altro istituto — e che
oggi si scrive a mano, ogni volta da capo.

---

## Testo del modello

> **CERTIFICATO DI SERVIZIO**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> Prot. n. `{{protocollo.numero}}` del `{{protocollo.data}}`
>
> Visti gli atti d'ufficio, si certifica che `{{dipendente.cognome}} {{dipendente.nome}}`, nato/a a
> `{{dipendente.luogo_nascita}}` il `{{dipendente.data_nascita}}`, codice fiscale
> `{{dipendente.codice_fiscale}}`, ha prestato servizio presso questa istituzione scolastica nei
> periodi e con le qualifiche di seguito indicati:
>
> | Dal | Al | Qualifica | Ordine di scuola | Sede | Tipo di rapporto | Ore settimanali |
> |---|---|---|---|---|---|---|
> | `{{periodo.dal}}` | `{{periodo.al}}` | `{{periodo.qualifica}}` | `{{periodo.ordine}}` | `{{periodo.sede}}` | `{{periodo.tipo}}` | `{{periodo.ore}}` |
>
> Codice meccanografico della sede di servizio: `{{sede.codice_meccanografico}}`
>
> Si certifica altresì che il servizio è stato prestato con regolarità e che nulla osta sotto il
> profilo disciplinare. *(riga condizionale — vedi nota)*
>
> Il presente certificato viene rilasciato, in carta libera, su richiesta dell'interessato/a per gli
> usi consentiti dalla legge.
>
> **DATI IDENTIFICATIVI DELLA SCUOLA**
> Denominazione: `{{scuola.ragione_sociale}}`
> P.IVA/C.F.: `{{scuola.piva}}` · Sede legale: `{{scuola.sede_legale}}`
> Scuola paritaria — codici meccanografici: `{{scuola.codici_meccanografici}}`
>
> `{{luogo_data}}`
> Il Legale Rappresentante
> `{{scuola.legale_rappresentante}}`

---

## Il form chiede

| Campo | Tipo | Obbligatorio | Nota |
|---|---|---|---|
| Dipendente | scelta da anagrafica personale | sì | |
| Periodi da certificare | selezione dai periodi in archivio | sì | precompilati, spuntabili |
| Uso dichiarato | testo | no | «per graduatorie», «per concorso», … |
| Includere la riga disciplinare | sì/no | sì | vedi sotto |

## Da dove vengono i periodi

L'anagrafica del personale in servizio esiste già (PR #82) e contiene le pratiche del dipendente.
I periodi di servizio vanno letti da lì, non digitati: qualifica, ordine di scuola, sede, tipo di
rapporto e ore sono già dati che la segreteria ha inserito una volta.

Dove l'anagrafica non basta, il certificato **omette la colonna** invece di lasciarla vuota o di
inventarla — stessa disciplina di degrado dei certificati per gli alunni.

Il **codice meccanografico della sede** è il dato che rende il certificato valido per il punteggio:
le tre sedi ne hanno di diversi, e alcune ne hanno due (infanzia e primaria). Un certificato con il
codice sbagliato fa perdere il punteggio a chi lo presenta.

## La riga disciplinare è opzionale, e per un motivo

«Nulla osta sotto il profilo disciplinare» è una dichiarazione che il legale rappresentante fa
sotto la propria responsabilità. Va scritta solo se è vera e solo se serve: molte domande non la
richiedono.

Il form la propone spenta. Chi la accende sta dichiarando qualcosa, e deve accorgersene. E dove i
provvedimenti disciplinari esistono, il sistema non li espone né li commenta: quella pratica non
sta in app.

## Dopo la generazione

1. Protocollo in uscita.
2. PDF nel fascicolo del dipendente + copia all'interessato/a via email.
3. Nessuna scadenza: certifica un servizio prestato, che non cambia.
4. Se il rapporto è ancora in corso, il periodo si chiude con «in servizio alla data odierna»
   invece di una data di fine inventata.
