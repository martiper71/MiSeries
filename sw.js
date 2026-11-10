// Subir la versión solo hace falta si cambia la lista de ASSETS: el código de la
// app se pide siempre primero a la red, así que los cambios llegan solos.
const VERSION = 'v5';
const SHELL_CACHE = `mis-series-shell-${VERSION}`;
const DATA_CACHE = `mis-series-data-${VERSION}`;
const IMG_CACHE = `mis-series-img-${VERSION}`;
const CACHES_ACTUALES = [SHELL_CACHE, DATA_CACHE, IMG_CACHE];

const MAX_DATA_ENTRIES = 200;
const MAX_IMG_ENTRIES = 300;

const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './config.js',
    './icon-192.png',
    './icon-512.png',
    './manifest.json'
];

// Instalación: cachear el esqueleto de la app
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activación: borrar cachés de versiones anteriores y tomar el control
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => !CACHES_ACTUALES.includes(key)).map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// Mantener una caché por debajo de un número máximo de entradas (borra las más antiguas)
async function recortarCache(nombre, maximo) {
    const cache = await caches.open(nombre);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - maximo; i++) {
        await cache.delete(keys[i]);
    }
}

async function guardarEnCache(nombre, request, response, maximo) {
    // Solo respuestas correctas (o imágenes opacas de otros dominios)
    if (!response || !(response.ok || response.type === 'opaque')) return;
    const cache = await caches.open(nombre);
    await cache.put(request, response);
    if (maximo) await recortarCache(nombre, maximo);
}

// Red primero, caché como respaldo sin conexión
function networkFirst(event, cacheName, maximo) {
    return fetch(event.request)
        .then(response => {
            event.waitUntil(guardarEnCache(cacheName, event.request, response.clone(), maximo));
            return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || Response.error()));
}

// Caché primero (para imágenes, que no cambian)
function cacheFirst(event, cacheName, maximo) {
    return caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
            event.waitUntil(guardarEnCache(cacheName, event.request, response.clone(), maximo));
            return response;
        });
    });
}

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Peticiones de PocketBase en tiempo real u otras no cacheables
    if (url.pathname.startsWith('/api/realtime')) return;

    if (url.host === 'image.tmdb.org' || event.request.destination === 'image') {
        event.respondWith(cacheFirst(event, IMG_CACHE, MAX_IMG_ENTRIES));
    } else if (url.origin === self.location.origin) {
        // Código de la app: siempre la versión más reciente si hay red
        event.respondWith(networkFirst(event, SHELL_CACHE));
    } else {
        // Datos (TMDB, PocketBase): frescos si hay red, caché sin conexión
        event.respondWith(networkFirst(event, DATA_CACHE, MAX_DATA_ENTRIES));
    }
});
