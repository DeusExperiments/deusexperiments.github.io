/* deusexperiments.com service worker: repeat-visit cache, pages always network-first. */
'use strict';

var VERSION = 'v1';
var PREFIX = 'deus-';
var PAGES = PREFIX + 'pages-' + VERSION;
var ASSETS = PREFIX + 'assets-' + VERSION;
var MAX_CACHEABLE_BYTES = 4 * 1024 * 1024;
var REVALIDATE_GAP_MS = 30 * 1000;
var lastRevalidated = new Map();

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keep = [PAGES, ASSETS];
    var keys = await caches.keys();
    await Promise.all(keys.map(function (key) {
      if (key.indexOf(PREFIX) === 0 && keep.indexOf(key) === -1) return caches.delete(key);
    }));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) {}
    }
    await self.clients.claim();
  })());
});

function isVersioned(url) {
  if (/[?&](v|ver|version|hash|rev)=[^&]+/i.test(url.search)) return true;
  return /[.\-_][0-9a-f]{8,}(\.[a-z0-9]+)$/i.test(url.pathname);
}

function cacheable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  if ((response.headers.get('Cache-Control') || '').indexOf('no-store') !== -1) return false;
  var len = Number(response.headers.get('Content-Length'));
  return !(len > MAX_CACHEABLE_BYTES);
}

function store(cacheName, request, response) {
  if (!cacheable(response)) return Promise.resolve();
  var copy = response.clone();
  return caches.open(cacheName).then(function (cache) {
    return cache.put(request, copy);
  }).catch(function () {});
}

async function networkFirstPage(event) {
  var request = event.request;
  try {
    var response = (await event.preloadResponse) || (await fetch(request));
    event.waitUntil(store(PAGES, request, response));
    return response;
  } catch (err) {
    var cache = await caches.open(PAGES);
    var cached = (await cache.match(request)) || (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(event) {
  var cache = await caches.open(ASSETS);
  var cached = await cache.match(event.request, { ignoreVary: true });
  if (cached) return cached;
  var response = await fetch(event.request);
  event.waitUntil(store(ASSETS, event.request, response));
  return response;
}

async function staleWhileRevalidate(event) {
  var request = event.request;
  var cache = await caches.open(ASSETS);
  var cached = await cache.match(request, { ignoreVary: true });
  if (cached) {
    var now = Date.now();
    var last = lastRevalidated.get(request.url) || 0;
    if (now - last > REVALIDATE_GAP_MS) {
      lastRevalidated.set(request.url, now);
      event.waitUntil(fetch(request).then(function (fresh) {
        return store(ASSETS, request, fresh);
      }).catch(function () {}));
    }
    return cached;
  }
  var response = await fetch(request);
  lastRevalidated.set(request.url, Date.now());
  event.waitUntil(store(ASSETS, request, response));
  return response;
}

function isMediaPath(pathname) {
  return /\.(avif|webp|png|jpe?g|gif|svg|ico|woff2?)$/i.test(pathname);
}

/* After the first (uncontrolled) visit the page sends the same-origin image and
   font URLs it already loaded; copying them in here makes the next visit hit
   the cache. Fetches go through the HTTP cache, so this costs revalidations,
   not re-downloads. */
self.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || data.type !== 'warm' || !Array.isArray(data.urls)) return;
  event.waitUntil((async function () {
    var cache = await caches.open(ASSETS);
    var seen = new Set();
    for (var i = 0; i < data.urls.length && seen.size < 60; i++) {
      var url;
      try { url = new URL(String(data.urls[i]), self.location.href); } catch (e) { continue; }
      if (url.origin !== self.location.origin || url.pathname.indexOf('/cdn-cgi/') === 0) continue;
      if (!isMediaPath(url.pathname)) continue;
      url.hash = '';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      if (await cache.match(url.href, { ignoreVary: true })) continue;
      try {
        var response = await fetch(url.href, { credentials: 'same-origin' });
        lastRevalidated.set(url.href, Date.now());
        await store(ASSETS, url.href, response);
      } catch (e) {}
    }
  })());
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/cdn-cgi/') === 0) return;
  if (url.pathname === '/sw.js') return;

  var dest = request.destination;
  if (dest === 'video' || dest === 'audio' || dest === 'track') return;
  if (/\.(mp4|webm|mov|m4v|mp3|m4a|ogg|vtt)$/i.test(url.pathname)) return;

  if (request.mode === 'navigate' || dest === 'document' || dest === 'iframe') {
    event.respondWith(networkFirstPage(event));
    return;
  }

  var isMedia = dest === 'image' || dest === 'font' || isMediaPath(url.pathname);
  if (isMedia) {
    event.respondWith(isVersioned(url) ? cacheFirst(event) : staleWhileRevalidate(event));
    return;
  }

  if ((dest === 'script' || dest === 'style') && isVersioned(url)) {
    event.respondWith(cacheFirst(event));
  }
});
