/*
 * CAF-DASHBOARD-02 Agent Floor — demo mode (FR-7).
 *
 * The prototype's mock scenarios, moved as they were. Fetches nothing from
 * the server; only calls the public window.AgentFloor API.
 * Started by adapter.js when the URL contains ?demo=1.
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
 smooth:{label:'Smooth run',ticket:'GAN-142',title:'Date filter on the sales report',pr:118,
  desc:'A full-stack ticket through Backend then Frontend. Every gate is green and the PR is ready for review.',
  impl:[['backend',{task:'Add date query to the DTO',attempts:[null]}],['frontend',{task:'Wire the filter into the report page',attempts:[null]}]],qa:['pass']},
 retry:{label:'Verify fails, retry',ticket:'GAN-143',title:'Tidy the sales report table',pr:119,
  desc:'Frontend fails typecheck, then test, and only passes on the third attempt.',
  impl:[['frontend',{task:'Rework the report table component',attempts:[1,2,null]}]],qa:['pass']},
 qaretry:{label:'QA rejects once',ticket:'GAN-144',title:'Date range validation',pr:120,
  desc:'QA finds a bug. The QA gate\'s single retry is used, then the result passes.',
  impl:[['frontend',{task:'Add date range validation',attempts:[null]}]],qa:['fail','pass']},
 human:{label:'Needs human',ticket:'GAN-145',title:'Export the report to Excel',pr:0,
  desc:'All three attempts are used up. The pipeline stops, a comment goes to Linear, and the ticket becomes Blocked.',
  impl:[['frontend',{task:'Build the Excel export button',attempts:[1,2,2]}]],qa:[]},
 crash:{label:'Crash, BullMQ retry',ticket:'GAN-146',title:'Sync stock after a transaction',pr:121,
  desc:'An exception mid-run. The run is marked ERROR, then BullMQ retries the job.',
  impl:[['backend',{task:'Sync stock after a transaction',attempts:[null],crashOnce:true}]],qa:['pass']}
};

/* ====== pipeline flow ====== */
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
    log('bad',NAME(a)+': exception mid-run');
    setStatus('error');step('impl','fail','ERROR');
    await wait(2800);
    log('info','BullMQ: job retried (attempt 2/3)');
    setStatus('run');step('impl','active',NAME(a)+' retrying');
  }
  setState(a,'implementing',spec.task,'info');await wait(3400);
  var atts=spec.attempts||[null];
  for(var n=1;n<=3;n++){
    var f=atts[n-1];if(f===undefined)f=null;
    var ok=await verify(a,f,n);
    if(ok){
      log('ok',NAME(a)+': Status: SUCCESS (attempt '+n+'/3)');
      step('impl','active',NAME(a)+' passed verify');
      return true;
    }
    log('warn',NAME(a)+': verify failed at '+CHK[f].toLowerCase()+' (attempt '+n+'/3)');
    if(n<3){
      setState(a,'retrying',CHK[f]+' failed. Retry '+(n+1)+'/3','warn');
      step('impl','active',NAME(a)+' retrying '+(n+1)+'/3');
      await wait(1900);
      setState(a,'implementing','Fix '+CHK[f].toLowerCase(),'info');await wait(2500);
    }
  }
  return false;
}
async function pipeline(sc){
  var P='planner',Q='qa',Rv='reviewer',H='human';
  AF.setRun({title:sc.ticket+'  '+sc.title,meta:'Linear, repo umkm-pos, branch ai-agent/'+sc.ticket});
  setStatus('run');
  log('info','Linear: '+sc.ticket+' moved to "Ready for AI"');
  log('info','Webhook received, branch ai-agent/'+sc.ticket+' created');

  step('plan','active','Planner reading the ticket');
  setState(P,'planning','Read ticket','info');await ready(P);await wait(2200);
  say(P,'Check DTO and API contract','info');await wait(2400);
  say(P,'Write the plan','info');await wait(2200);
  log('ok','Planner: requirements.md and tasks.md ready');
  step('plan','pass','requirements.md, tasks.md');

  var prev=P,last=null;
  for(var i=0;i<sc.impl.length;i++){
    var a=sc.impl[i][0],spec=sc.impl[i][1];
    step('impl','active',NAME(a)+' working');
    setState(a,'implementing','Got the plan','info');
    if(prev===P){
      fire(sendDoc(P,a,'requirements.md'));await wait(350);await sendDoc(P,a,'tasks.md');
      celebrate(P,'Plan done');
    } else {
      await sendDoc(prev,a,'verify-report.md');
    }
    var ok=await implStage(a,spec);
    if(!ok){
      log('bad',NAME(a)+': Status: NEEDS_HUMAN, pipeline stopped');
      setState(a,'blocked','Need Manager','bad');
      step('impl','fail','NEEDS_HUMAN');
      await wait(900);
      await sendDoc(a,'human','verify-report.md');
      log('warn','Error comment sent to Linear, ticket becomes Blocked');
      setStatus('needs');
      setState(H,'alert','Something needs a look','bad');
      return;
    }
    if(i<sc.impl.length-1)celebrate(a,'Status: SUCCESS');
    prev=a;last=a;
  }
  step('impl','pass',NAME(last)+': verify-report.md');

  step('qa','active','QA testing');
  setState(Q,'verifying','Got the report','info');
  celebrate(last,'Status: SUCCESS');
  await sendDoc(last,Q,'verify-report.md');await ready(Q);
  for(var q=0;q<sc.qa.length;q++){
    var res=sc.qa[q],failed=false;
    setState(Q,'verifying',q===0?'Test edge cases':'Retest','info',0,{checks:[0,0,0]});
    for(var k=0;k<3;k++){
      AF.checks(Q,k,1);await wait(1300);
      if(res==='fail'&&k===2){AF.checks(Q,k,3);failed=true;break;}
      AF.checks(Q,k,2);
    }
    if(!failed){log('ok','QA: Status: PASS (qa-report.md)');break;}
    log('warn','QA: Status: FAIL, retry gate 1/1');
    setState(Q,'retrying','Bug found','warn');
    step('qa','active','QA rejected, retry 1/1');
    await wait(1500);
    setState(last,'implementing','Fix QA findings','info');
    await sendDoc(Q,last,'qa-report.md');await ready(last);await wait(2600);
    var ok2=await verify(last,null,1);
    if(ok2)log('ok',NAME(last)+': fix passed verify');
    celebrate(last,'Status: SUCCESS');
    setState(Q,'verifying','Got the fix','info');
    await sendDoc(last,Q,'verify-report.md');
  }
  celebrate(Q,'Status: PASS');
  step('qa','pass','qa-report.md: PASS');

  step('review','active','Reviewer assessing');
  setState(Rv,'reviewing','Got qa-report.md','info');
  await sendDoc(Q,Rv,'qa-report.md');await ready(Rv);
  var checks=['Check approach','Check security','Check technical debt'];
  for(var c=0;c<checks.length;c++){say(Rv,checks[c],'info');await wait(1900);}
  log('ok','Reviewer: review-notes.md done');
  step('review','pass','review-notes.md');

  step('pr','active','Opening PR');
  celebrate(Rv,'Review done');
  await sendDoc(Rv,'outbox','review-notes.md');
  log('ok','PR #'+sc.pr+' opened from ai-agent/'+sc.ticket);
  log('info','Comment to Linear: branch ready for review');
  step('pr','pass','PR #'+sc.pr);
  setStatus('success');
  setState(H,'alert','New PR, ready for review','ok');
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
  $('#scn').textContent=Object.keys(SCEN).length+' scenarios';
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
    $('#lph').textContent='Scenarios';$('#lps').setAttribute('aria-label','Scenarios');
    $('#ver').textContent='demo';$('#mock').hidden=false;
    $('#helpnote').textContent='Every event, time, and cost in demo mode is produced by the scenario script, not real data.';
    var link=$('#modelink');link.textContent='Live';link.href='/dashboard/agent-floor';
    buildScen();
    runScenario('smooth');
  }
};
})();
