package it.kidville.app.caricamenti;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Le righe che il pacchetto scrive in logcat (`DiagnosticaLocale`), raccolte invece di essere mandate al sistema: in `try (RigheDiLogcat
 * logcat = new RigheDiLogcat()) { ... }` l'uscita si sostituisce all'apertura e si rimette com'era alla chiusura, anche se il test fallisce.
 * Ogni riga è `<livello> <tag> <testo>` con il livello `I`, `W` o `E`: un test può provare che un `catch` ignorabile parli davvero (togliere
 * la riga lo fa diventare rosso) e che non porti mai un percorso, un indirizzo o il messaggio di un'eccezione.
 */
final class RigheDiLogcat implements DiagnosticaLocale.Uscita, AutoCloseable {

    final List<String> righe = Collections.synchronizedList(new ArrayList<String>());
    private final DiagnosticaLocale.Uscita prima;

    RigheDiLogcat() {
        prima = DiagnosticaLocale.sostituisciUscita(this);
    }

    @Override
    public void info(String tag, String testo) {
        righe.add("I " + tag + " " + testo);
    }

    @Override
    public void avviso(String tag, String testo) {
        righe.add("W " + tag + " " + testo);
    }

    @Override
    public void errore(String tag, String testo) {
        righe.add("E " + tag + " " + testo);
    }

    /** Quante righe contengono `frammento`. */
    int conta(String frammento) {
        int n = 0;
        synchronized (righe) {
            for (String riga : righe) if (riga.contains(frammento)) n++;
        }
        return n;
    }

    @Override
    public void close() {
        DiagnosticaLocale.sostituisciUscita(prima);
    }
}
