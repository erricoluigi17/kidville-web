// FIXTURE del lock `caricamenti-nativi-agganciati` — VERDE per costruzione (regole 3 e 4, Android).
// `registerPlugin` PRIMA di `super.onCreate`, e `onResume` che riprende i caricamenti dentro un `try` che non lascia cadere l'Activity.
package it.kidville.app.fixture;

import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import it.kidville.app.caricamenti.PianificatoreCaricamenti;

public class MainActivity extends BridgeActivity {

    private static final String TAG_CARICAMENTI = "KidvilleCaricamenti";

    /**
     * Nel commento compaiono di proposito `super.onCreate(savedInstanceState)` e un `if`: il lock non deve leggerli come codice.
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(KidvilleCaricamentiPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        try {
            PianificatoreCaricamenti.riprendiInPrimoPiano(this);
        } catch (Throwable guasto) {
            Log.e(TAG_CARICAMENTI, "ripresa dei caricamenti non riuscita (" + guasto.getClass().getSimpleName() + ")");
        }
    }
}
