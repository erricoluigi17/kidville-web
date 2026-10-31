# Menu della segreteria a 7 voci, a fisarmonica — design

> Piano: `docs/superpowers/plans/2026-10-31-menu-segreteria-7-voci.md`. Approvato da Luigi il 2026-10-31.

## Contesto

Luigi (31/10/2026): *«Il menu della segreteria è diventato troppo lungo e disordinato. Voglio
poche voci e accorpare quanto più possibile con un menu che poi possa aprire il sottomenu. Non
dobbiamo toccare nessuna pagina, solo il menu.»*

Oggi il gruppo «Amministrazione» da solo contiene 10 voci scollegate (Contabilità, CRM, Privacy,
Moderazione…). Le voci sono cresciute una PR alla volta, ognuna aggiunta dove c'era posto.

## Design (corto)

**Le scelte di Luigi, prese in questa conversazione:**
- **7 voci di primo livello**, raggruppate per tipo di lavoro (scelta fra 7 e 9 voci):

| Voce | Tipo | Contenuto, in quest'ordine |
|---|---|---|
| Home | link diretto | `/admin` |
| Anagrafica | link diretto | `/admin/students` |
| **Registro** | gruppo | Appello · Diario 0–6 · Primaria · Competenze · Galleria |
| **Comunicazione** | gruppo | Messaggi · Avvisi · News · Compiti · Moderazione |
| **Contabilità e servizi** | gruppo | Contabilità · Coda fatture · Mensa · Report Cucina · Armadietto · Merchandise |
| **Segreteria** | gruppo | CRM · Candidature · Modulistica · Documenti firmati · Protocollo · Storici e stampe |
| **Impostazioni** | gruppo | Impostazioni · Strumenti · Privacy & GDPR |

- **Fisarmonica** (scelta al posto della comparsa laterale): le voci si aprono sotto
  l'intestazione e si apre un gruppo alla volta. All'arrivo su una pagina si apre il suo gruppo.
  Stesso comportamento su computer, pannello del tablet e foglio del telefono.

**Approcci considerati:** fisarmonica (scelta), comparsa laterale (scartata: sull'iPad in
orizzontale, cioè il menu che Luigi usa di più, il «passa sopra» non esiste, il riquadro copre la
pagina e sul telefono servirebbe comunque la fisarmonica), barra a icone con seconda colonna
(scartata: cambierebbe la larghezza del menu, messa a posto il 18/10 e sorvegliata da
`menu-desktop-in-orizzontale.test.ts`).

**Scelte mie, da controllare leggendo:**
1. In «Segreteria» l'ordine è **CRM · Candidature · Modulistica**, non CRM · Modulistica ·
   Candidature come nell'anteprima: così restano veri i due lock del 17/10 e del 30/10
   (Candidature subito sopra Modulistica, CRM subito sopra Candidature).
2. **«Dashboard» diventa «Home»** nella sidebar, come nell'anteprima approvata e come già si
   chiama nella barra in basso. Cambia solo il valore di `nav_dashboard`, non la chiave.
3. Toccare l'intestazione **apre o chiude** il gruppo, non porta a nessuna pagina.
4. A gruppo **chiuso**, il gruppo che contiene la pagina aperta ha l'intestazione evidenziata («sei
   qui»). A gruppo **aperto** l'evidenza resta sulla voce, come oggi.
5. Il numero della **Coda fatture** compare sull'intestazione di «Contabilità e servizi» **solo a
   gruppo chiuso**. A gruppo aperto sta accanto alla voce, come oggi, senza doppioni.
6. Il gruppo della pagina si calcola sulla config intera, non sulle voci filtrate per ruolo. Al
   primo render il ruolo vale `null`, e il gruppo non deve «saltare» quando il ruolo arriva.
7. Lo stato aperto/chiuso **non** si salva nel browser: nessun `localStorage`, quindi nessun rischio
   di differenze fra server e client all'idratazione.
8. Nel foglio del telefono le voci già presenti nei tab in basso (Home, Avvisi, Contabilità, Mensa)
   e Anagrafica (in evidenza in cima) restano escluse dai gruppi, come oggi. Se la pagina aperta è
   uno di quei tab, nel foglio non si apre nessun gruppo: la voce accesa è già il tab.
9. I titoli dei gruppi abbandonati spariscono da `etichette` (it ed en) senza riordinare il resto
   del catalogo.

**Fuori perimetro:** le pagine, la barra in basso (`AdminBottomNav`, `tab-admin.ts`), il binario
del tablet (`AdminBinario`), le larghezze del menu, il selettore della sede nel foglio.

## Vincoli globali

- **Lingua:** tutto in italiano (etichette, commenti, messaggi di commit, PRD). Catalogo `en`
  allineato al `it` (lock `messaggi-parita-cataloghi`).
- **Branch:** si continua su `chore/piano-approvato-a-mano` (PR #272 aperta, non mergiata). Regola
  1 di `AGENTS.md`: niente branch nuovo prima di un deploy riuscito. La descrizione della PR #272 va
  aggiornata perché copra anche il menu. Il merge lo fa il titolare.
- **PRD:** voce di changelog datata in cima a `PRD REGISTRO ELETTRONICO.md` (regola 2 di
  `AGENTS.md`).
- **Logging:** questo intervento non aggiunge route, integrazioni esterne né percorsi d'errore, quindi
  non servono log nuovi. Va scritto esplicitamente nel PRD.
- **Colori solo da token** (`bg-kidville-*`, `text-kidville-*`) in `features/admin/**` (lock
  `design-tokens-admin`). Niente hex fuori da `globals.css`.
- **Niente `setState` dentro `useEffect`** (regola `react-hooks/set-state-in-effect`): il cambio di
  pagina si gestisce aggiustando lo stato durante il render, come fa già `AdminBinario.tsx:63-67`.
- **Il gate vero resta nelle API:** i `roles` delle voci non cambiano, si spostano solo le voci.
- **Read, non `cat`**, per leggere i file (le regole di `.claude/rules/` si attivano sul Read).

