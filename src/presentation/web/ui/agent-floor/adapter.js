/*
 * CAF-DASHBOARD-02 Agent Floor — adapter data (live dan replay).
 *
 * Satu-satunya modul yang berbicara dengan server, dan hanya membaca (GET):
 *   GET /api/pipelines                                   daftar run
 *   GET /api/pipelines/:repoId/:ticketId/floor-events    event ber-kontrak, berkursor
 *   GET /api/events/stream                               SSE, hanya sinyal "ada perubahan"
 *
 * Live dan replay memakai jalur yang sama: event dari endpoint di atas
 * diterjemahkan translate.js lalu dipanggilkan ke API publik render.js.
 * Bedanya hanya jeda antar event. Dengan ?demo=1 modul ini tidak mengambil
 * data apa pun dan menyerahkan halaman ke demo.js.
 */
(function(){
'use strict';
var AF=window.AgentFloor,TR=window.AgentFloorTranslate;
var $=function(s){return document.querySelector(s)};
var params=new URLSearchParams(location.search);

if(params.get('demo')==='1'){window.AgentFloorDemo.start();return;}

var STATUS={RUNNING:['run','Berjalan'],SUCCESS:['success','SUCCESS'],NEEDS_HUMAN:['needs','NEEDS_HUMAN'],ERROR:['error','ERROR']};
var LIVE_GAP_MS=250;

var runs=[],repo=params.get('repo')||null;
/* current: run yang sedang ditampilkan.
   mode 'live' mengikuti run yang berjalan; 'replay' memutar ulang run dari awal.
   pinned: dipilih manual, jadi tidak digeser otomatis oleh run aktif yang baru. */
var current=null,token=0;
var queue=[],draining=false,polling=false,pollAgain=false,runsTimer=null;
var listEl=$('#scen'),repoEl=$('#repo'),connEl=$('#conn');

/* ====== server (hanya baca) ====== */
function reloadOnce(){
  /* 401: cookie SSE atau sesi Basic Auth sudah tidak berlaku. Memuat ulang
     halaman melewati Basic Auth lagi dan memasang cookie baru. Dibatasi agar
     tidak berputar bila server terus menolak. */
  var last=0;
  try{last=+sessionStorage.getItem('caf-floor-reload')||0;}catch{}
  if(Date.now()-last<30000)return;
  try{sessionStorage.setItem('caf-floor-reload',String(Date.now()));}catch{}
  location.reload();
}
function getJson(url){
  return fetch(url,{headers:{accept:'application/json'}}).then(function(r){
    if(r.status===401){reloadOnce();throw new Error('401');}
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.json();
  });
}
function eventsUrl(run,after){
  return '/api/pipelines/'+encodeURIComponent(run.repoId)+'/'+encodeURIComponent(run.ticketId)+'/floor-events'+
    (after?'?after='+encodeURIComponent(after):'');
}

/* ====== menerapkan event ====== */
function apply(e){
  if(e.type==='run_started'){current.startMs=Date.parse(e.startedAt);current.endMs=null;}
  if(e.type==='run_finished')current.endMs=Date.parse(e.timestamp);
  current.lastMs=Date.parse(e.timestamp);
  TR.translate(e,{runStartMs:current.startMs}).forEach(function(call){
    var fn=call[0],args=call.slice(1);
    if(fn==='setRun'){
      var c=current;
      /* Lama run dari cap waktu server: replay mengikuti posisi putar, live mengikuti jam. */
      args[0].clock=function(){
        if(c.startMs===undefined)return 0;
        var end=c.mode==='replay'?c.lastMs:(c.endMs||Date.now());
        return Math.max(0,end-c.startMs);
      };
    }
    AF[fn].apply(null,args);
  });
}
/* Antrean tunggal: event diterapkan berurutan walau datang dari beberapa
   polling, dan menunggu bila animasi dijeda. */
function enqueue(events,delayOf,live){
  var t=token,prev=null;
  events.forEach(function(e){queue.push({e:e,t:t,delay:delayOf(prev,e),live:!!live});prev=e;});
  if(!draining)drain();
}
function realDelay(ms){return new Promise(function(res){setTimeout(res,ms);});}
function drain(){
  draining=true;
  (async function(){
    try{
      while(queue.length){
        var item=queue.shift();
        if(item.t!==token)continue;
        /* Replay menunggu di waktu simulasi, jadi ikut Jeda dan 1x/2x/4x.
           Live menunggu di waktu nyata: data nyata tetap masuk walau animasi
           dijeda (termasuk prefers-reduced-motion). */
        if(item.delay>0)await (item.live?realDelay(item.delay):AF.wait(item.delay));
        if(item.t!==token)continue;
        apply(item.e);
      }
    }catch(err){
      /* AF.reset() membatalkan penantian yang sedang berjalan; itu bukan error. */
      if(err!==AF.CANCEL)console.error(err);
    }
    draining=false;
    if(queue.length)drain();
  })();
}

/* ====== membuka run ====== */
function open(run,mode,pinned){
  token++;queue=[];
  AF.reset();
  current={repoId:run.repoId,ticketId:run.ticketId,mode:mode,pinned:pinned,cursor:null};
  $('#ver').textContent=mode;
  renderRuns();
  var t=token;
  getJson(eventsUrl(run)).then(function(body){
    if(t!==token)return;
    current.cursor=body.nextCursor;
    if(mode==='replay'){
      enqueue(body.events,function(prev,e){return prev?TR.replayDelay(prev.timestamp,e.timestamp):0;});
    } else {
      /* Menyusul keadaan terkini tanpa jeda, lalu lanjut mengikuti. */
      enqueue(body.events,function(){return 0;});
      poll();
    }
  }).catch(function(){ if(t===token)AF.log('bad','Gagal memuat event run'); });
}
function poll(){
  if(!current||current.mode!=='live'||current.cursor===null)return;
  if(polling){pollAgain=true;return;}
  polling=true;
  var t=token,c=current;
  getJson(eventsUrl(c,c.cursor)).then(function(body){
    if(t!==token)return;
    c.cursor=body.nextCursor||c.cursor;
    if(body.events.length)enqueue(body.events,function(){return LIVE_GAP_MS;},true);
  }).catch(function(){}).then(function(){
    polling=false;
    if(pollAgain){pollAgain=false;poll();}
  });
}

/* ====== daftar run dan pemilih repo ====== */
function inRepo(){return runs.filter(function(r){return r.repoId===repo;});}
function isCurrent(r){return !!current&&current.repoId===r.repoId&&current.ticketId===r.ticketId;}
function renderRepoOptions(){
  var list=runs.map(function(r){return r.repoId;}).filter(function(v,i,a){return a.indexOf(v)===i;}).sort();
  if(list.indexOf(repo)===-1){
    var active=runs.filter(function(r){return r.status==='RUNNING';})[0];
    repo=active?active.repoId:(list[0]||null);
  }
  repoEl.innerHTML='';
  list.forEach(function(v){
    var o=document.createElement('option');o.value=v;o.textContent=v;o.selected=v===repo;repoEl.appendChild(o);
  });
  $('#lpt').hidden=list.length===0;
}
function renderRuns(){
  var list=inRepo();
  $('#scn').textContent=list.length+' run';
  listEl.innerHTML='';
  if(!list.length){
    var p=document.createElement('p');p.className='lp-empty';
    p.textContent=runs.length?'Belum ada run untuk repo ini.':'Belum ada run tercatat.';
    listEl.appendChild(p);return;
  }
  list.forEach(function(r){
    var st=STATUS[r.status]||['idle',r.status];
    var b=document.createElement('button');b.type='button';b.className='sc';
    b.setAttribute('aria-pressed',isCurrent(r)?'true':'false');
    b.innerHTML='<span class="t"></span><span class="d"></span><span class="s"></span>';
    b.querySelector('.t').textContent=r.ticketId+'  '+r.ticketTitle;
    b.querySelector('.d').textContent=new Date(r.startedAt).toLocaleString('id-ID')+
      (r.attempt>1?', attempt '+r.attempt:'')+(r.prNumber?', PR #'+r.prNumber:'');
    var s=b.querySelector('.s');s.className='s '+st[0];
    s.textContent=st[1]+(r.status==='RUNNING'?' (ikuti live)':' (putar ulang)');
    b.addEventListener('click',function(){
      if(r.status==='RUNNING')open(r,'live',false); else open(r,'replay',true);
    });
    listEl.appendChild(b);
  });
}
/* Tanpa pilihan manual, kantor mengikuti run yang sedang berjalan di repo terpilih. */
function autoFollow(){
  var list=inRepo();
  var active=list.filter(function(r){return r.status==='RUNNING';})[0];
  if(current){
    if(current.pinned)return;
    var mine=list.filter(isCurrent)[0];
    if(mine&&mine.status==='RUNNING')return;
  }
  if(active&&!isCurrent(active))open(active,'live',false);
}
function loadRuns(){
  return getJson('/api/pipelines').then(function(data){
    runs=data;renderRepoOptions();renderRuns();autoFollow();
  }).catch(function(){});
}
function scheduleRuns(){
  if(runsTimer)return;
  runsTimer=setTimeout(function(){runsTimer=null;loadRuns();},300);
}
repoEl.addEventListener('change',function(){
  repo=repoEl.value;
  params.set('repo',repo);
  history.replaceState(null,'',location.pathname+'?'+params.toString());
  token++;queue=[];current=null;
  AF.reset();$('#ver').textContent='live';
  renderRuns();autoFollow();
});

/* ====== SSE: hanya sinyal ====== */
function setConn(up){
  connEl.hidden=false;
  connEl.className='conn '+(up?'up':'down');
  connEl.textContent=up?'Terhubung':'Terputus, mencoba lagi';
}
function probeAuth(){
  /* EventSource tidak memberi tahu status HTTP. Permintaan biasa ke alamat
     yang sama membedakan "server tidak terjangkau" dari "401". */
  var ctl=new AbortController();
  fetch('/api/events/stream',{signal:ctl.signal}).then(function(r){
    var status=r.status;ctl.abort();
    if(status===401)reloadOnce();
  }).catch(function(){});
}
function connect(){
  var source=new EventSource('/api/events/stream');
  source.onopen=function(){
    setConn(true);
    /* Apa pun yang terlewat selama terputus diambil ulang; kursor mencegah event ganda. */
    loadRuns();poll();
  };
  source.onerror=function(){setConn(false);probeAuth();};
  source.onmessage=function(msg){
    var sig=null;
    try{sig=JSON.parse(msg.data);}catch{}
    scheduleRuns();
    if(sig&&current&&current.mode==='live'&&sig.repoId===current.repoId&&sig.ticketId===current.ticketId)poll();
  };
}

/* ====== mulai ====== */
AF.setMock(false);
AF.setRun({title:'Tidak ada run aktif'});
loadRuns();
connect();
})();
