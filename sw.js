/* WEB見積書作成：ホーム画面に追加／電波が弱い現場でも開けるようにする Service Worker
   ・index.html と同じフォルダに置いたときだけ働く（scope はこのフォルダ）
   ・アイコン・manifest などは「キャッシュ優先＋裏で更新」(stale-while-revalidate)。index.html は「ネット優先（4秒でキャッシュに切り替え）」で、開くたびに最新を取る
   ・html2canvas / jsPDF / pdf-lib（cdnjs）もキャッシュ。PDFづくりが電波なしでも動く
   ・Firebase など、ほかのサイトへの通信には手を出さない（そのまま通す）
   ・ログイン画面の「新しい版があるか」の確認（?v=…／Range／no-store）は、いつもネットへ通す
     （通さないと、古い版がいつまでも出る）。切れているときは確認が失敗するだけで、キャッシュの版で開く */
'use strict';
var VER = 'wq-pwa-4';            // 作りを変えたら番号を上げる（古いキャッシュは自動で消える）
var CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js'
];
var SCOPE = new URL('./', self.location.href);
var INDEX = new URL('./index.html', SCOPE).href;
var LOCAL = ['./manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'].map(function(p){ return new URL(p, SCOPE).href; });

self.addEventListener('install', function(ev){
  ev.waitUntil((async function(){
    var c = await caches.open(VER);
    // index.html は本体。入らなかったら（まだ置いていない等）、このSWは入れずにやめる
    var r = await fetch(new Request(INDEX, { cache: 'default' }));   // いま開いている版が HTTP キャッシュに残っていればそれを使う（3.9MBを二度ダウンロードしない）
    if(!r.ok) throw new Error('index ' + r.status);
    await c.put(INDEX, r);
    await Promise.all(LOCAL.map(function(u){ return c.add(new Request(u, { cache: 'reload' })).catch(function(){}); }));
    // CDN は 1つ失敗しても続ける（opaque で入れる）
    await Promise.all(CDN.map(function(u){
      return fetch(new Request(u, { mode: 'no-cors' })).then(function(res){ return c.put(u, res); }).catch(function(){});
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function(ev){
  ev.waitUntil((async function(){
    var ks = await caches.keys();
    await Promise.all(ks.filter(function(k){ return k.indexOf('wq-pwa-') === 0 && k !== VER; }).map(function(k){ return caches.delete(k); }));
    await self.clients.claim();
  })());
});

function 更新して入れる(key, req){
  return fetch(req).then(function(res){
    if(res && (res.ok || res.type === 'opaque')){ return caches.open(VER).then(function(c){ return c.put(key, res.clone()); }).then(function(){ return res; }); }
    return res;
  });
}
function 古いまま出して裏で更新(key, req){
  return caches.open(VER).then(function(c){
    return c.match(key).then(function(hit){
      var net = 更新して入れる(key, req).catch(function(){ return null; });
      if(hit) return hit;
      return net.then(function(r){ return r || Response.error(); });
    });
  });
}
function ネット優先(key, req, ms){
  var net = 更新して入れる(key, req);
  var guard = ms ? Promise.race([net, new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('slow')); }, ms); })]) : net;
  return guard.catch(function(){
    return caches.open(VER).then(function(c){ return c.match(key); }).then(function(hit){ return hit || net.catch(function(){ return Response.error(); }); });
  });
}

self.addEventListener('fetch', function(ev){
  var req = ev.request;
  if(req.method !== 'GET') return;
  if(req.headers.has('range')) return;                       // 版の確認（先頭だけ読む）はネットへ
  var url = new URL(req.url);
  // cdnjs の3つ
  if(CDN.indexOf(url.href) >= 0){
    ev.respondWith(古いまま出して裏で更新(url.href, new Request(url.href, { mode: 'no-cors' })));
    return;
  }
  // Google Fonts（文字の見た目）。電波が弱いと、これを待って画面が出ないことがあるので、いちど取ったらキャッシュから出す
  if(url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com'){
    ev.respondWith(古いまま出して裏で更新(url.href, req));
    return;
  }
  if(url.origin !== SCOPE.origin) return;                    // Firebase など、ほかのサイトは触らない
  if(url.pathname.indexOf(SCOPE.pathname) !== 0) return;
  var rel = url.pathname.slice(SCOPE.pathname.length);
  var isIndex = (rel === '' || rel === 'index.html');
  if(isIndex){
    var 新しさ確認 = url.searchParams.has('v') || req.cache === 'no-store' || req.cache === 'reload' || req.cache === 'no-cache';
    var plain = new Request(INDEX, { cache: 'no-cache' });
    if(新しさ確認){
      // ?v=… の再読み込み（新しい版が出たとき）だけネット優先。切れていればキャッシュの版
      if(req.mode === 'navigate') ev.respondWith(ネット優先(INDEX, plain));
      return;                                                // それ以外の確認はそのままネットへ
    }
    // 本体は「ネット優先」：開くたびに最新かを確認する（変わっていなければ 304 で軽い）。4秒たっても返らない・切れているときはキャッシュの版
    ev.respondWith(ネット優先(INDEX, plain, 9000));   /* スマホの電波でも本体（約10MB）を取り切れるよう、切り替えは9秒 */
    return;
  }
  if(rel === 'sw.js') return;
  // 同じフォルダのほかのページ・画像（車両管理報告書などの ./sharyo.html）も、いちど開いたらキャッシュ優先
  if(LOCAL.indexOf(url.origin + url.pathname) >= 0 || /\.(html|png|jpe?g|svg|webmanifest|json|css|js)$/i.test(rel)){
    ev.respondWith(古いまま出して裏で更新(url.origin + url.pathname, req));
  }
});
