package it.kidville.app.caricamenti;

import androidx.core.util.AtomicFile;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * Un `AtomicFile` che si comporta COME QUELLO DEL TELEFONO quando la rinomina fallisce: `finishWrite` chiude il file nuovo e NON lancia
 * (sul telefono scrive una riga con `Log.e` e ritorna), ma non lo rinomina sul file base. Nella JVM di JUnit, invece, l'`AtomicFile`
 * vero lancia («Log.e not mocked») e il test vede il fallimento da sé: il comportamento in JVM e sul dispositivo divergevano proprio sul
 * ramo d'errore (secondario n. 45 della PR 3). Con questo si prova il ramo del telefono.
 *
 * `traslocaDavvero` si può spegnere e riaccendere a metà di un test: «le prime scritture riescono, poi il disco dà il numero».
 */
final class AtomicFileCheNonTrasloca extends AtomicFile {

    volatile boolean traslocaDavvero;
    /** Quante `finishWrite` sono state chiamate senza che la rinomina avvenisse. */
    volatile int rinominePerse = 0;

    AtomicFileCheNonTrasloca(File base, boolean traslocaDavvero) {
        super(base);
        this.traslocaDavvero = traslocaDavvero;
    }

    @Override
    public void finishWrite(FileOutputStream uscita) {
        if (traslocaDavvero) {
            super.finishWrite(uscita);
            return;
        }
        rinominePerse++;
        try {
            if (uscita != null) uscita.close();
        } catch (IOException chiusuraNonRiuscita) {
            // Come sul telefono: nessuna eccezione verso chi scrive.
        }
        // NIENTE rinomina: il file base resta quello di prima (o non c'è), e il nuovo resta come `.new`.
    }
}
