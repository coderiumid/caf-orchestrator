/*
 * CAF-DASHBOARD-02 Agent Floor — event translator.
 *
 * A pure function with no DOM: one contract event (from
 * GET /api/pipelines/:repoId/:ticketId/floor-events) becomes a list of calls
 * on the public window.AgentFloor API, as [functionName, ...arguments].
 * Used identically by the live and replay paths in adapter.js, and loaded
 * directly by the unit tests (module.exports).
 */
(function(root){
'use strict';

var NAME={planner:'Planner',backend:'Backend',frontend:'Frontend',qa:'QA',reviewer:'Reviewer',docs:'Docs',human:'Manager'};
var GATE={implementation:'implementation',qa:'QA',reviewer:'Reviewer'};
var CHECK_LABEL=[['lint','lint'],['typecheck','typecheck'],['test','test']];
var WORK_TEXT={planning:'Planning',implementing:'Implementing',verifying:'Testing',reviewing:'Reviewing'};

function money(v){return '$'+v.toFixed(4);}

/* "2/3", "2", or '' when the verify report states no attempt number. */
function attemptText(verify){
  if(!verify||verify.attempt===null||verify.attempt===undefined)return '';
  return verify.attempt+(verify.maxAttempts?'/'+verify.maxAttempts:'');
}
function checksText(verify){
  var parts=[];
  CHECK_LABEL.forEach(function(c){
    var v=verify.checks&&verify.checks[c[0]];
    if(v==='pass')parts.push(c[1]+' passed'); else if(v==='fail')parts.push(c[1]+' failed');
  });
  return parts.join(', ');
}

/*
 * ctx.runStartMs: the attempt's start time (epoch ms) for the log's time
 * column; set by the caller from the run_started event.
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
      calls.push(['log','info',e.attempt>1?'Run restarted, attempt '+e.attempt:'Run started, branch '+e.branch,0]);
      break;

    case 'agent_state':
      if(WORK_TEXT[e.state]){
        /* checks:null: no verify bars for real data. */
        calls.push(['setState',e.agent,e.state,WORK_TEXT[e.state],'info',0,{checks:null}]);
      } else if(e.state==='retrying'){
        var r=e.retry||{count:1,max:null},rt='retry '+r.count+'/'+(r.max===null||r.max===undefined?'?':r.max);
        calls.push(['setState',e.agent,'retrying','Rejected, '+rt,'warn',0,{checks:null}]);
        log('warn',name+': '+(GATE[e.gate]||e.gate)+' gate rejected, '+rt);
      } else if(e.state==='blocked'){
        calls.push(['setState',e.agent,'blocked','Need Manager','bad']);
        log('bad',name+': NEEDS_HUMAN at the '+(GATE[e.gate]||e.gate)+' gate');
      } else if(e.state==='error'){
        calls.push(['setState',e.agent,'error','Error'+(e.outcome?': '+e.outcome:''),'bad']);
        log('bad',name+': agent process failed'+(e.outcome?' ('+e.outcome+')':''));
      } else if(e.state==='celebrating'){
        calls.push(['celebrate',e.agent,'Done']);
      } else if(e.state==='idle'){
        calls.push(['setState',e.agent,'idle',undefined,'',0,e.verify?{attempt:attemptText(e.verify)}:undefined]);
        calls.push(['say',e.agent,null]);
        if(e.verify){
          var bits=[];
          if(attemptText(e.verify))bits.push('attempt '+attemptText(e.verify));
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
        log('ok',e.note+' opened');
        /* "PR #n" = the final PR; "Draft PR #n" = the PR from a gate that stopped the run. */
        if(/^PR /.test(e.note||''))calls.push(['setState','human','alert',e.note+', ready for review','ok']);
        else calls.push(['say','human',e.note+' waiting','bad']);
      }
      break;

    case 'usage':
      calls.push(['usage',e.agent,{costUsd:e.costUsd,tokens:e.tokens,durationMs:e.durationMs}]);
      var u=[];
      if(e.costUsd!==null&&e.costUsd!==undefined)u.push(money(e.costUsd));
      if(e.durationMs!==null&&e.durationMs!==undefined)u.push(Math.round(e.durationMs/1000)+' s');
      log('info',name+': finished'+(u.length?' ('+u.join(', ')+')':''));
      break;

    case 'run_finished':
      if(e.finalStatus==='SUCCESS'){
        calls.push(['setStatus','success']);
        calls.push(['setState','human','alert','Run finished','ok']);
        log('ok','final_status: SUCCESS');
      } else if(e.finalStatus==='NEEDS_HUMAN'){
        calls.push(['setStatus','needs']);
        calls.push(['setState','human','alert','Something needs a look','bad']);
        log('bad','final_status: NEEDS_HUMAN'+(e.gate?' ('+(GATE[e.gate]||e.gate)+' gate)':''));
      } else if(e.finalStatus==='ERROR'){
        calls.push(['setStatus','error']);
        log('bad','final_status: ERROR, BullMQ may retry the job');
      } else {
        /* An earlier attempt whose final status has been overwritten: do not guess it. */
        log('warn','Attempt '+e.attempt+' ended, its final status was not recorded');
      }
      break;
  }
  return calls;
}

/*
 * Delay (simulation ms) before the next event during replay: the real gap is
 * compressed 30x and clamped, so a 10-minute run replays in a few tens of
 * seconds at 1x. Events from the same row (zero gap) get only a short delay.
 */
function replayDelay(prevTimestamp,timestamp){
  var gap=Date.parse(timestamp)-Date.parse(prevTimestamp);
  if(!(gap>0))return 120;
  return Math.min(3500,Math.max(350,Math.round(gap/30)));
}

var api={translate:translate,replayDelay:replayDelay,attemptText:attemptText};
if(typeof module==='object'&&module.exports)module.exports=api; else root.AgentFloorTranslate=api;
})(typeof window!=='undefined'?window:this);
