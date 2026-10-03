/*
 * CAF-DASHBOARD-02 Agent Floor — penerjemah event.
 *
 * Fungsi murni tanpa DOM: satu event ber-kontrak (dari
 * GET /api/pipelines/:repoId/:ticketId/floor-events) menjadi daftar panggilan
 * ke API publik window.AgentFloor, dalam bentuk [namaFungsi, ...argumen].
 * Dipakai sama persis oleh jalur live dan replay di adapter.js, dan dimuat
 * langsung oleh unit test (module.exports).
 */
(function(root){
'use strict';

var NAME={planner:'Planner',backend:'Backend',frontend:'Frontend',qa:'QA',reviewer:'Reviewer',docs:'Docs',human:'Ganjar'};
var GATE={implementation:'implementasi',qa:'QA',reviewer:'Reviewer'};
var CHECK_LABEL=[['lint','lint'],['typecheck','typecheck'],['test','test']];
var WORK_TEXT={planning:'Menyusun rencana',implementing:'Mengimplementasi',verifying:'Menguji',reviewing:'Mereview'};

function money(v){return '$'+v.toFixed(4);}

/* "2/3", "2", atau '' bila laporan verify tidak menyebut nomor percobaan. */
function attemptText(verify){
  if(!verify||verify.attempt===null||verify.attempt===undefined)return '';
  return verify.attempt+(verify.maxAttempts?'/'+verify.maxAttempts:'');
}
function checksText(verify){
  var parts=[];
  CHECK_LABEL.forEach(function(c){
    var v=verify.checks&&verify.checks[c[0]];
    if(v==='pass')parts.push(c[1]+' lolos'); else if(v==='fail')parts.push(c[1]+' gagal');
  });
  return parts.join(', ');
}

/*
 * ctx.runStartMs: waktu mulai attempt (ms epoch) untuk kolom waktu di log;
 * diisi pemanggil dari event run_started.
 */
function translate(e,ctx){
  var calls=[],name=NAME[e.agent]||e.agent;
  var at=(ctx&&ctx.runStartMs!==undefined&&ctx.runStartMs!==null)?Math.max(0,Date.parse(e.timestamp)-ctx.runStartMs):0;
  function log(level,text){calls.push(['log',level,text,at]);}

  switch(e.type){
    case 'run_started':
      calls.push(['reset']);
      calls.push(['setRun',{
        title:e.ticket+'  '+e.ticketTitle,
        meta:'repo '+e.repo+', branch '+e.branch+(e.attempt>1?', attempt '+e.attempt:''),
        startedAt:e.startedAt
      }]);
      calls.push(['setStatus','run']);
      calls.push(['log','info',e.attempt>1?'Run diulang, attempt '+e.attempt:'Run dimulai, branch '+e.branch,0]);
      break;

    case 'agent_state':
      if(WORK_TEXT[e.state]){
        /* checks:null: tanpa bar verify pada data nyata. */
        calls.push(['setState',e.agent,e.state,WORK_TEXT[e.state],'info',0,{checks:null}]);
      } else if(e.state==='retrying'){
        var r=e.retry||{count:1,max:null},rt='retry '+r.count+'/'+(r.max===null||r.max===undefined?'?':r.max);
        calls.push(['setState',e.agent,'retrying','Menolak, '+rt,'warn',0,{checks:null}]);
        log('warn',name+': gate '+(GATE[e.gate]||e.gate)+' menolak, '+rt);
      } else if(e.state==='blocked'){
        calls.push(['setState',e.agent,'blocked','Butuh Ganjar','bad']);
        log('bad',name+': NEEDS_HUMAN di gate '+(GATE[e.gate]||e.gate));
      } else if(e.state==='error'){
        calls.push(['setState',e.agent,'error','Error'+(e.outcome?': '+e.outcome:''),'bad']);
        log('bad',name+': proses agent gagal'+(e.outcome?' ('+e.outcome+')':''));
      } else if(e.state==='celebrating'){
        calls.push(['celebrate',e.agent,'Selesai']);
      } else if(e.state==='idle'){
        calls.push(['setState',e.agent,'idle',undefined,'',0,e.verify?{attempt:attemptText(e.verify)}:undefined]);
        calls.push(['say',e.agent,null]);
        if(e.verify){
          var bits=[];
          if(attemptText(e.verify))bits.push('percobaan '+attemptText(e.verify));
          if(checksText(e.verify))bits.push(checksText(e.verify));
          if(bits.length)log('info',name+': verify '+bits.join(', '));
        }
      } else {
        calls.push(['setState',e.agent,e.state]);
      }
      break;

    case 'handoff':
      calls.push(['sendDoc',e.from,e.to,e.file]);
      break;

    case 'step':
      calls.push(['step',e.step,e.status,e.note||'']);
      if(e.step==='pr'&&e.status==='pass'){
        log('ok',e.note+' dibuka');
        /* "PR #n" = PR final; "Draft PR #n" = PR dari gate yang berhenti. */
        if(/^PR /.test(e.note||''))calls.push(['setState','human','alert',e.note+', siap direview','ok']);
        else calls.push(['say','human',e.note+' menunggu','bad']);
      }
      break;

    case 'usage':
      calls.push(['usage',e.agent,{costUsd:e.costUsd,tokens:e.tokens,durationMs:e.durationMs}]);
      var u=[];
      if(e.costUsd!==null&&e.costUsd!==undefined)u.push(money(e.costUsd));
      if(e.durationMs!==null&&e.durationMs!==undefined)u.push(Math.round(e.durationMs/1000)+' dtk');
      log('info',name+': selesai'+(u.length?' ('+u.join(', ')+')':''));
      break;

    case 'run_finished':
      if(e.finalStatus==='SUCCESS'){
        calls.push(['setStatus','success']);
        calls.push(['setState','human','alert','Run selesai','ok']);
        log('ok','final_status: SUCCESS');
      } else if(e.finalStatus==='NEEDS_HUMAN'){
        calls.push(['setStatus','needs']);
        calls.push(['setState','human','alert','Ada yang perlu dicek','bad']);
        log('bad','final_status: NEEDS_HUMAN'+(e.gate?' (gate '+(GATE[e.gate]||e.gate)+')':''));
      } else if(e.finalStatus==='ERROR'){
        calls.push(['setStatus','error']);
        log('bad','final_status: ERROR, job dapat diulang BullMQ');
      } else {
        /* Attempt lama yang status akhirnya sudah tertimpa: jangan ditebak. */
        log('warn','Attempt '+e.attempt+' berakhir, status akhirnya tidak tercatat');
      }
      break;
  }
  return calls;
}

/*
 * Jeda (ms waktu simulasi) sebelum event berikutnya saat replay: jarak waktu
 * nyata dipadatkan 30x dan dibatasi, supaya run 10 menit selesai diputar
 * dalam beberapa puluh detik pada 1x. Event dari baris yang sama (selisih 0)
 * hanya diberi jeda pendek.
 */
function replayDelay(prevTimestamp,timestamp){
  var gap=Date.parse(timestamp)-Date.parse(prevTimestamp);
  if(!(gap>0))return 120;
  return Math.min(3500,Math.max(350,Math.round(gap/30)));
}

var api={translate:translate,replayDelay:replayDelay,attemptText:attemptText};
if(typeof module==='object'&&module.exports)module.exports=api; else root.AgentFloorTranslate=api;
})(typeof window!=='undefined'?window:this);
