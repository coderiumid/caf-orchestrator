/*
 * CAF-DASHBOARD-02 Agent Floor — mode demo (FR-7).
 *
 * Skenario mock dari prototype, dipindahkan apa adanya. Tidak mengambil data
 * apa pun dari server; hanya memanggil API publik window.AgentFloor.
 * Dijalankan oleh adapter.js bila URL memuat ?demo=1.
 */
(function(){
'use strict';
var AF=window.AgentFloor;
var wait=AF.wait,ready=AF.ready,fire=AF.fire,celebrate=AF.celebrate;
var setState=AF.setState,say=AF.say,sendDoc=AF.sendDoc,step=AF.step,setStatus=AF.setStatus,log=AF.log;
var CHK=AF.CHK,CANCEL=AF.CANCEL,NAME=AF.name;
var $=function(s){return document.querySelector(s)};
var currentKey=null;

var SCEN={
 lancar:{label:'Berjalan lancar',ticket:'GAN-142',title:'Filter tanggal di laporan penjualan',pr:118,
  desc:'Tiket fullstack lewat Backend lalu Frontend. Semua gate hijau dan PR siap direview.',
  impl:[['backend',{task:'Tambah query tanggal di DTO',attempts:[null]}],['frontend',{task:'Pasang filter di halaman laporan',attempts:[null]}]],qa:['pass']},
 retry:{label:'Verify gagal, retry',ticket:'GAN-143',title:'Rapikan tabel laporan penjualan',pr:119,
  desc:'Frontend gagal di typecheck, lalu di test, dan baru lolos pada percobaan ketiga.',
  impl:[['frontend',{task:'Ubah komponen tabel laporan',attempts:[1,2,null]}]],qa:['pass']},
 qaretry:{label:'QA menolak sekali',ticket:'GAN-144',title:'Validasi rentang tanggal',pr:120,
  desc:'QA menemukan bug. Sisa satu retry gate QA terpakai, lalu hasilnya lolos.',
  impl:[['frontend',{task:'Tambah validasi rentang tanggal',attempts:[null]}]],qa:['fail','pass']},
 manusia:{label:'Butuh manusia',ticket:'GAN-145',title:'Ekspor laporan ke Excel',pr:0,
  desc:'Tiga percobaan habis. Pipeline berhenti, komentar masuk ke Linear, status tiket menjadi Blocked.',
  impl:[['frontend',{task:'Buat tombol ekspor Excel',attempts:[1,2,2]}]],qa:[]},
 crash:{label:'Crash, BullMQ retry',ticket:'GAN-146',title:'Sinkron stok setelah transaksi',pr:121,
  desc:'Exception di tengah run. Run ditandai ERROR, lalu BullMQ mengulang job-nya.',
  impl:[['backend',{task:'Sinkronkan stok setelah transaksi',attempts:[null],crashOnce:true}]],qa:['pass']}
};

/* ====== alur pipeline ====== */
function verify(a,failAt,n){
  setState(a,'verifying','Verify '+n+'/3','info',0,{attempt:n+'/3',checks:[0,0,0]});
  return (async function(){
    for(var i=0;i<3;i++){
      AF.checks(a,i,1);await wait(1100);
      if(failAt===i){AF.checks(a,i,3);return false;}
      AF.checks(a,i,2);
    }
    return true;
  })();
}
async function implStage(a,spec){
  await ready(a);
  if(spec.crashOnce){
    setState(a,'implementing',spec.task,'info');await wait(2300);
    setState(a,'error','Exception: MCP timeout','bad');
    log('bad',NAME(a)+': exception di tengah run');
    setStatus('error');step('impl','fail','ERROR');
    await wait(2800);
    log('info','BullMQ: job diulang (attempt 2/3)');
    setStatus('run');step('impl','active',NAME(a)+' mengulang');
  }
  setState(a,'implementing',spec.task,'info');await wait(3400);
  var atts=spec.attempts||[null];
  for(var n=1;n<=3;n++){
    var f=atts[n-1];if(f===undefined)f=null;
    var ok=await verify(a,f,n);
    if(ok){
      log('ok',NAME(a)+': Status: SUCCESS (percobaan '+n+'/3)');
      step('impl','active',NAME(a)+' lolos verify');
      return true;
    }
    log('warn',NAME(a)+': verify gagal di '+CHK[f].toLowerCase()+' (percobaan '+n+'/3)');
    if(n<3){
      setState(a,'retrying',CHK[f]+' gagal. Ulang '+(n+1)+'/3','warn');
      step('impl','active',NAME(a)+' mengulang '+(n+1)+'/3');
      await wait(1900);
      setState(a,'implementing','Perbaiki '+CHK[f].toLowerCase(),'info');await wait(2500);
    }
  }
  return false;
}
async function pipeline(sc){
  var P='planner',Q='qa',Rv='reviewer',H='human';
  AF.setRun({title:sc.ticket+'  '+sc.title,meta:'Linear, repo umkm-pos, branch ai-agent/'+sc.ticket});
  setStatus('run');
  log('info','Linear: '+sc.ticket+' berubah ke "Ready for AI"');
  log('info','Webhook diterima, branch ai-agent/'+sc.ticket+' dibuat');

  step('plan','active','Planner membaca tiket');
  setState(P,'planning','Baca tiket','info');await ready(P);await wait(2200);
  say(P,'Cek DTO dan kontrak API','info');await wait(2400);
  say(P,'Tulis rencana','info');await wait(2200);
  log('ok','Planner: requirements.md dan tasks.md siap');
  step('plan','pass','requirements.md, tasks.md');

  var prev=P,last=null;
  for(var i=0;i<sc.impl.length;i++){
    var a=sc.impl[i][0],spec=sc.impl[i][1];
    step('impl','active',NAME(a)+' mengerjakan');
    setState(a,'implementing','Terima rencana','info');
    if(prev===P){
      fire(sendDoc(P,a,'requirements.md'));await wait(350);await sendDoc(P,a,'tasks.md');
      celebrate(P,'Rencana beres');
    } else {
      await sendDoc(prev,a,'verify-report.md');
    }
    var ok=await implStage(a,spec);
    if(!ok){
      log('bad',NAME(a)+': Status: NEEDS_HUMAN, pipeline berhenti');
      setState(a,'blocked','Butuh Ganjar','bad');
      step('impl','fail','NEEDS_HUMAN');
      await wait(900);
      await sendDoc(a,'human','verify-report.md');
      log('warn','Komentar error dikirim ke Linear, tiket menjadi Blocked');
      setStatus('needs');
      setState(H,'alert','Ada yang perlu dicek','bad');
      return;
    }
    if(i<sc.impl.length-1)celebrate(a,'Status: SUCCESS');
    prev=a;last=a;
  }
  step('impl','pass',NAME(last)+': verify-report.md');

  step('qa','active','QA menguji');
  setState(Q,'verifying','Terima laporan','info');
  celebrate(last,'Status: SUCCESS');
  await sendDoc(last,Q,'verify-report.md');await ready(Q);
  for(var q=0;q<sc.qa.length;q++){
    var res=sc.qa[q],failed=false;
    setState(Q,'verifying',q===0?'Uji edge case':'Uji ulang','info',0,{checks:[0,0,0]});
    for(var k=0;k<3;k++){
      AF.checks(Q,k,1);await wait(1300);
      if(res==='fail'&&k===2){AF.checks(Q,k,3);failed=true;break;}
      AF.checks(Q,k,2);
    }
    if(!failed){log('ok','QA: Status: PASS (qa-report.md)');break;}
    log('warn','QA: Status: FAIL, retry gate 1/1');
    setState(Q,'retrying','Bug ditemukan','warn');
    step('qa','active','QA menolak, retry 1/1');
    await wait(1500);
    setState(last,'implementing','Perbaiki temuan QA','info');
    await sendDoc(Q,last,'qa-report.md');await ready(last);await wait(2600);
    var ok2=await verify(last,null,1);
    if(ok2)log('ok',NAME(last)+': perbaikan lolos verify');
    celebrate(last,'Status: SUCCESS');
    setState(Q,'verifying','Terima perbaikan','info');
    await sendDoc(last,Q,'verify-report.md');
  }
  celebrate(Q,'Status: PASS');
  step('qa','pass','qa-report.md: PASS');

  step('review','active','Reviewer menilai');
  setState(Rv,'reviewing','Terima qa-report.md','info');
  await sendDoc(Q,Rv,'qa-report.md');await ready(Rv);
  var checks=['Cek pendekatan','Cek keamanan','Cek technical debt'];
  for(var c=0;c<checks.length;c++){say(Rv,checks[c],'info');await wait(1900);}
  log('ok','Reviewer: review-notes.md selesai');
  step('review','pass','review-notes.md');

  step('pr','active','Membuka PR');
  celebrate(Rv,'Review beres');
  await sendDoc(Rv,'outbox','review-notes.md');
  log('ok','PR #'+sc.pr+' dibuka dari ai-agent/'+sc.ticket);
  log('info','Komentar ke Linear: branch siap review');
  step('pr','pass','PR #'+sc.pr);
  setStatus('success');
  setState(H,'alert','PR baru, siap direview','ok');
}
function runScenario(key){
  AF.reset();currentKey=key;renderScen();
  var sc=SCEN[key];
  (async function(){
    try{await pipeline(sc);}catch(e){if(e!==CANCEL)console.error(e);}
  })();
}

var scenEl=$('#scen');
function buildScen(){
  $('#scn').textContent=Object.keys(SCEN).length+' skenario';
  Object.keys(SCEN).forEach(function(k){
    var b=document.createElement('button');b.type='button';b.className='sc';b.dataset.k=k;
    b.innerHTML='<span class="t"></span><span class="d"></span>';
    b.querySelector('.t').textContent=SCEN[k].label;b.querySelector('.d').textContent=SCEN[k].desc;
    b.addEventListener('click',function(){runScenario(k);});scenEl.appendChild(b);
  });
}
function renderScen(){
  Array.prototype.forEach.call(scenEl.children,function(b){b.setAttribute('aria-pressed',b.dataset.k===currentKey?'true':'false');});
}

window.AgentFloorDemo={
  start:function(){
    AF.setMock(true);
    $('#lph').textContent='Skenario';$('#lps').setAttribute('aria-label','Skenario');
    $('#ver').textContent='demo';$('#mock').hidden=false;
    $('#helpnote').textContent='Semua kejadian, waktu, dan biaya di mode demo dibuat oleh skrip skenario, bukan data nyata.';
    var link=$('#modelink');link.textContent='Live';link.href='/dashboard/agent-floor';
    buildScen();
    runScenario('lancar');
  }
};
})();
