package it.kidville.app.caricamenti;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Il cifrario dei TEST: AES-256-GCM con una chiave in memoria, e lo STESSO formato del blocco che produce il cifrario di produzione
 * (`CifrarioKeystore`): `[lunghezza dell'IV: 1 byte][IV][testo cifrato + tag di 16 byte]`. L'AndroidKeyStore non esiste sulla JVM di
 * JUnit; tutto il resto di `SegretiCaricamenti` — la forma del file, i dati associati, la manomissione, la sostituzione, la cancellazione —
 * si prova con questo, e il file che ne esce è un file vero.
 */
final class CifrarioSoftware implements SegretiCaricamenti.Cifrario {

    private final SecretKey chiave;
    private final SecureRandom casuale = new SecureRandom();
    /** Quante volte si è cifrato e decifrato: i test lo guardano per dimostrare che il cifrario è stato davvero usato. */
    int cifrature = 0;
    int decifrature = 0;

    CifrarioSoftware() {
        try {
            KeyGenerator generatore = KeyGenerator.getInstance("AES");
            generatore.init(256);
            chiave = generatore.generateKey();
        } catch (GeneralSecurityException impossibile) {
            throw new IllegalStateException("AES-256 non disponibile", impossibile);
        }
    }

    @Override
    public byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws GeneralSecurityException, IOException {
        cifrature++;
        byte[] iv = new byte[12];
        casuale.nextBytes(iv);
        Cipher cifrario = Cipher.getInstance("AES/GCM/NoPadding");
        cifrario.init(Cipher.ENCRYPT_MODE, chiave, new GCMParameterSpec(128, iv));
        cifrario.updateAAD(datiAssociati);
        byte[] testoCifrato = cifrario.doFinal(chiaro);
        byte[] risultato = new byte[1 + iv.length + testoCifrato.length];
        risultato[0] = (byte) iv.length;
        System.arraycopy(iv, 0, risultato, 1, iv.length);
        System.arraycopy(testoCifrato, 0, risultato, 1 + iv.length, testoCifrato.length);
        return risultato;
    }

    @Override
    public byte[] decifra(byte[] cifrato, byte[] datiAssociati) throws GeneralSecurityException, IOException {
        decifrature++;
        if (cifrato.length < 2) throw new GeneralSecurityException("blocco troppo corto");
        int lunghezzaIv = cifrato[0] & 0xFF;
        if (lunghezzaIv == 0 || cifrato.length < 1 + lunghezzaIv + 1) throw new GeneralSecurityException("blocco malformato");
        Cipher cifrario = Cipher.getInstance("AES/GCM/NoPadding");
        cifrario.init(Cipher.DECRYPT_MODE, chiave, new GCMParameterSpec(128, cifrato, 1, lunghezzaIv));
        cifrario.updateAAD(datiAssociati);
        return cifrario.doFinal(cifrato, 1 + lunghezzaIv, cifrato.length - 1 - lunghezzaIv);
    }
}
