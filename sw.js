// Service worker do PWA "Satélite — Fazenda Santa Rosa"
// Estratégia:
//  - App shell (HTML/manifest/ícones): cache-first, com atualização em segundo plano
//  - Imagens de satélite (/api/satelite): network-first, caindo pro cache se offline
//    (o front-end já guarda um fallback em localStorage, isso aqui é uma camada extra)

const VERSAO_CACHE = 'satelite-fsr-v1';
const ARQUIVOS_APP_SHELL = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSAO_CACHE).then((cache) => cache.addAll(ARQUIVOS_APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((chaves) =>
      Promise.all(
        chaves
          .filter((chave) => chave !== VERSAO_CACHE)
          .map((chave) => caches.delete(chave))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Imagens de satélite: tenta rede primeiro (imagem mais atual), cai pro cache se offline
  if (url.pathname.startsWith('/api/satelite')) {
    event.respondWith(
      fetch(event.request)
        .then((resposta) => {
          const copia = resposta.clone();
          caches.open(VERSAO_CACHE).then((cache) => cache.put(event.request, copia));
          return resposta;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell: cache-first
  event.respondWith(
    caches.match(event.request).then((respostaCache) => {
      return (
        respostaCache ||
        fetch(event.request).then((resposta) => {
          const copia = resposta.clone();
          caches.open(VERSAO_CACHE).then((cache) => cache.put(event.request, copia));
          return resposta;
        })
      );
    })
  );
});
