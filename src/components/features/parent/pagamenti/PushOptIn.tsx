'use client';

import { useState, useEffect } from 'react';
import { Bell, BellOff } from 'lucide-react';

interface Props { userId: string }

function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

export function PushOptIn({ userId }: Props) {
    const [supported, setSupported] = useState(false);
    const [subscribed, setSubscribed] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const ok = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
        if (ok) {
            navigator.serviceWorker.getRegistration().then(async (reg) => {
                const sub = await reg?.pushManager.getSubscription();
                setSupported(true);
                setSubscribed(!!sub);
            });
        }
    }, []);

    const enable = async () => {
        setBusy(true);
        try {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') { setBusy(false); return; }
            const reg = await navigator.serviceWorker.register('/sw.js');
            await navigator.serviceWorker.ready;
            const keyRes = await fetch('/api/push/vapid-public-key').then((r) => r.json());
            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(keyRes.data.publicKey) as BufferSource,
            });
            await fetch('/api/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ subscription: sub.toJSON() }),
            });
            setSubscribed(true);
        } catch (e) {
            console.error('Errore opt-in push', e);
        } finally {
            setBusy(false);
        }
    };

    const disable = async () => {
        setBusy(true);
        try {
            const reg = await navigator.serviceWorker.getRegistration();
            const sub = await reg?.pushManager.getSubscription();
            if (sub) {
                await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}&userId=${userId}`, {
                    method: 'DELETE', headers: { 'x-user-id': userId },
                });
                await sub.unsubscribe();
            }
            setSubscribed(false);
        } finally {
            setBusy(false);
        }
    };

    if (!supported) return null;

    return (
        <button
            onClick={subscribed ? disable : enable}
            disabled={busy}
            className={`flex items-center gap-2 px-4 py-2 rounded-full font-maven text-sm font-bold disabled:opacity-50 ${subscribed ? 'bg-kidville-green text-white' : 'border-2 border-kidville-green text-kidville-green'}`}
        >
            {subscribed ? <Bell size={15} /> : <BellOff size={15} />}
            {subscribed ? 'Promemoria attivi' : 'Attiva promemoria pagamenti'}
        </button>
    );
}
