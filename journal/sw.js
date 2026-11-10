const PREFIX='little-days-shared:'+self.registration.scope;
const CACHE=PREFIX+':v5';
const SHELL=["./","./index.html","./manifest.webmanifest","./app.js","./dates.js","./backup.js","./style.css","./icon.svg","./shared-crypto.js","./shared-model.js","./shared-api.js","./shared-store.js","./shared-ui.js","./shared.css"].map(path=>new URL(path,self.registration.scope).href);
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL.map(url=>new Request(url,{cache:'reload'}))))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(PREFIX+':')&&key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||!SHELL.includes(event.request.url))return;event.respondWith(fetch(event.request).catch(()=>caches.match(event.request.url)));});
