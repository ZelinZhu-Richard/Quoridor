import { useSyncExternalStore } from 'react';

type OfflineStatus = 'preparing' | 'ready' | 'unavailable' | 'development';
let status: OfflineStatus = import.meta.env.PROD ? 'preparing' : 'development';
const subscribers = new Set<() => void>();
let registration: ServiceWorkerRegistration | undefined;
let updatesAllowed = false;
export function allowOfflineUpdates(allowed: boolean) {
  updatesAllowed = allowed;
  if (allowed) registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
}
function update(value: OfflineStatus) {
  status = value;
  for (const notify of subscribers) notify();
}
export function useOfflineStatus() {
  return useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => {
        subscribers.delete(notify);
      };
    },
    () => status,
  );
}
export async function prepareOffline() {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) {
    update('unavailable');
    return;
  }
  const timer = setTimeout(() => update('unavailable'), 15000);
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    const activateWhenSafe = () => allowOfflineUpdates(updatesAllowed);
    registration.addEventListener('updatefound', () => {
      registration?.installing?.addEventListener('statechange', activateWhenSafe);
    });
    activateWhenSafe();
    await navigator.serviceWorker.ready;
    clearTimeout(timer);
    update('ready');
  } catch (error) {
    clearTimeout(timer);
    update('unavailable');
    console.warn(
      'Offline caching is unavailable in this browser:',
      error instanceof Error ? error.message : 'Registration failed',
    );
  }
}
