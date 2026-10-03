/*
 * CAF-DASHBOARD-02 Agent Floor — render.
 *
 * Moved from agent-floor.prototype.html: the world, sprites, canvas, panels,
 * and controls. This module does not know where data comes from. All data
 * enters through window.AgentFloor:
 *
 *   setState, say, sendDoc, step, setStatus, log   (entry points from the prototype)
 *   reset, setRun, usage, checks                   (complements: run_started, usage, demo verify bars)
 *   wait, ready, later, fire, celebrate            (simulation-time choreography)
 *
 * Agents do not walk: each sits in a fixed place (see placeInitial).
 *
 * Callers: demo.js (mock scenarios) and adapter.js (live and replay).
 * An agent may be referenced by id ('planner', 'backend', 'frontend', 'qa',
 * 'reviewer', 'docs', 'human') or by its object.
 */
(function(){
'use strict';
/* ====== world constants ====== */
var W=400,H=300,CS=1.5;
var K=2;
var CANCEL={cancel:true};
var $=function(s){return document.querySelector(s)};
function R(g,x,y,w,h,c){
  var x0=Math.round(x*K),y0=Math.round(y*K),x1=Math.round((x+w)*K),y1=Math.round((y+h)*K);
  g.fillStyle=c;g.fillRect(x0,y0,Math.max(1,x1-x0),Math.max(1,y1-y0));
}
var CHK=['Lint','Typecheck','Test'];
var ORDER=['planner','backend','frontend','qa','reviewer','docs','human'];
var WORKING={planning:1,implementing:1,verifying:1,retrying:1,reviewing:1};
var BACKFACE={planning:1,implementing:1,verifying:1,reviewing:1};
var STATE_LABEL={idle:'Idle',planning:'Planning',implementing:'Implementing',verifying:'Verifying',retrying:'Retrying',reviewing:'Reviewing',celebrating:'Done',blocked:'Needs human',error:'Error',offduty:'Off duty',alert:'Notification'};

var ZONES=[
 {id:'plan',x:8,y:8,w:128,h:128,c1:'#cbdffb',c2:'#bcd4f3',top:true,label:'Planning',lx:11,ly:124},
 {id:'eng',x:144,y:8,w:144,h:128,c1:'#ddd6f7',c2:'#cfc6f0',top:true,label:'Engineering',lx:147,ly:124},
 {id:'qa',x:296,y:8,w:96,h:128,c1:'#cfeedf',c2:'#bfe5d1',top:true,label:'QA lab',lx:299,ly:124},
 {id:'rev',x:8,y:156,w:128,h:136,c1:'#f8ddc5',c2:'#f0cfb0',top:false,label:'Review',lx:11,ly:159},
 {id:'pantry',x:144,y:156,w:144,h:136,c1:'#ece7db',c2:'#e0dacb',top:false,label:'Pantry',lx:147,ly:159},
 {id:'pr',x:296,y:156,w:96,h:136,c1:'#f7f0c6',c2:'#ede4ad',top:false,label:'PR gate',lx:299,ly:278}
];
var ST={
 planner:{cx:96,fy:84,door:130},
 backend:{cx:172,fy:84,door:208},
 frontend:{cx:256,fy:84,door:226},
 qa:{cx:344,fy:84,door:304},
 reviewer:{cx:72,fy:210,door:118},
 docs:{cx:216,fy:250,door:216},
 human:{cx:344,fy:240,door:344}
};
var OUTBOX={x:344,y:174};

var DEF={
 planner:{name:'Planner',file:'caf-planner',color:'#3f7de0',hair:'#5b3a29',skin:'#f1c9a5',acc:'pencil',rate:.010,
  access:'Read-only, never touches code',out:'requirements.md, tasks.md',
  desc:'Reads the ticket and writes the plan before a single line of code is touched.'},
 backend:{name:'Backend',file:'caf-backend',color:'#12958a',hair:'#2b2b2b',skin:'#c68a5e',acc:'cap',rate:.028,
  access:'Write, API scope',out:'code and verify-report.md',
  desc:'Works on the NestJS and Prisma side, then runs lint, typecheck, and test itself before claiming it is done.'},
 frontend:{name:'Frontend',file:'caf-frontend',color:'#7a5af0',hair:'#c0572b',skin:'#e8b98f',acc:'phones',rate:.028,
  access:'Write, web scope',out:'code and verify-report.md',
  desc:'Works on the Vue 3 and Vite side with the same pattern: implement, verify, repeat up to three times.'},
 qa:{name:'QA',file:'caf-qa',color:'#36a35b',hair:'#e8c25a',skin:'#8d5a3a',acc:'goggles',rate:.016,
  access:'Tests, writes a report',out:'qa-report.md',
  desc:'Tests more deeply and checks edge cases. This gate has one retry.'},
 reviewer:{name:'Reviewer',file:'caf-reviewer',color:'#e07b30',hair:'#6e6e78',skin:'#f3d2b5',acc:'glasses',rate:.012,
  access:'Read-only',out:'review-notes.md',
  desc:'Qualitative review: approach, technical debt, and security. This gate also has one retry.'},
 docs:{name:'Docs',file:'caf-documentation',color:'#8b90a0',hair:'#3a2a22',skin:'#d9a47a',acc:'bun',rate:0,
  access:'Write, in docs/',out:'docs updates',
  desc:'Not instrumented: it has no piv_phase, so the dashboard deliberately shows it off duty.'},
 human:{name:'Ganjar',file:'',color:'#17181f',hair:'#17181f',skin:'#c68a5e',acc:'capw',rate:0,
  access:'Mandatory review before merge',out:'merge decision',
  desc:'No auto-merge. Every PR stops at this desk.'}
};

/* ====== state ====== */
var bgc=null,DPR=1,zoom=1;
var cv=$('#cv'),ctx=cv.getContext('2d'),scene=$('#scene'),ov=$('#ov'),stage=$('#stage');
var simT=0,speed=1,paused=false,epoch=0,timers=[],runT0=0,runEnd=null;
var A={},docs=[],bugs=[],outboxFlag=false,selected='planner';
var stepsState={};
var STEPS=[['plan','Plan'],['impl','Implement and verify'],['qa','QA'],['review','Review'],['pr','PR and Linear']];
/* mock=true only in demo mode: cost, tokens, and work time are computed from
   sample rates. Otherwise all three change only through usage(). */
var mock=false,runClock=null;
function AG(a){return typeof a==='string'?A[a]:a;}

/* ====== agent ====== */
ORDER.forEach(function(id){
  A[id]={id:id,def:DEF[id],x:0,y:0,state:'idle',tone:'',bubble:null,checks:[0,0,0],attempt:'',cost:0,hasCost:false,tokens:null,activeMs:0,board:0,_bk:''};
});
/* Every agent has a fixed place and never moves: the five agents and Ganjar
   at their own desks, Docs on the pantry sofa. State shows only through pose
   and screen, so a state change stays readable however fast it comes (there
   is no walk that has to finish first). */
function placeInitial(a){a.x=ST[a.id].cx;a.y=ST[a.id].fy;}

/* ====== simulation time ====== */
function wait(ms){
  var e=epoch;
  return new Promise(function(res,rej){
    timers.push({at:simT+ms,ok:function(){ if(e===epoch)res(); else rej(CANCEL); },rej:rej});
  });
}
function fire(p){ if(p&&p.catch)p.catch(function(){}); }
function later(ms,fn){ var p=wait(ms).then(fn); fire(p); }

/* ====== API: data entry points ====== */
function say(a,text,tone,ttl){
  a=AG(a);
  a.bubble=text?{text:text,tone:tone||'',until:ttl?simT+ttl:0}:null;
}
/* extra (optional): {attempt:'2/3', checks:[0,0,0]}. checks:null means no verify bars
   (real data: per-check results are not available while the agent is running). */
function setState(a,s,text,tone,ttl,extra){
  a=AG(a);
  if(a.id==='qa'&&s==='retrying')spawnBug();
  a.state=s;a.tone=tone||'';
  if(extra){
    if(extra.attempt!==undefined)a.attempt=extra.attempt;
    if('checks' in extra)a.checks=extra.checks?extra.checks.slice():null;
  }
  if(text!==undefined)say(a,text,tone,ttl);
}
/* Kept for the demo scenarios: it used to wait for an agent to reach its desk. */
function ready(){return Promise.resolve();}
function celebrate(a,text){
  a=AG(a);
  setState(a,'celebrating',text,'ok',2300);
  later(2000,function(){ if(a.state==='celebrating'){setState(a,'idle');say(a,null);} });
}
function sendDoc(from,to,label,dur){
  from=AG(from);
  dur=dur||1100;
  /* Paused: no flying document (it would hang motionless in mid-air). */
  if(paused){if(to==='outbox')outboxFlag=true;return wait(dur);}
  var p0={x:from.x,y:from.y-16},p1;
  if(to==='outbox'){p1={x:OUTBOX.x,y:OUTBOX.y};later(dur,function(){outboxFlag=true;});}
  else if(to==='human')p1={x:ST.human.cx,y:ST.human.fy-20};
  else p1={x:ST[AG(to).id].cx,y:ST[AG(to).id].fy-20};
  var el=document.createElement('div');el.className='docl';el.textContent=label;ov.appendChild(el);
  docs.push({p0:p0,p1:p1,t0:simT,dur:dur,el:el});
  return wait(dur);
}
function spawnBug(){bugs.push({until:simT+4800});}
/* Verify bars (demo only): checks(agent,[..]) or checks(agent,i,value). */
function checks(a,i,v){
  a=AG(a);
  if(Array.isArray(i))a.checks=i.slice(); else {if(!a.checks)a.checks=[0,0,0];a.checks[i]=v;}
}
/* Real data per agent run: {costUsd, tokens, durationMs}; null means not recorded. */
function usage(a,u){
  a=AG(a);
  if(u.costUsd!==null&&u.costUsd!==undefined){a.cost+=u.costUsd;a.hasCost=true;}
  if(u.tokens!==null&&u.tokens!==undefined)a.tokens=(a.tokens||0)+u.tokens;
  if(u.durationMs)a.activeMs+=u.durationMs;
}

/* ====== UI: log, steps, status ====== */
var logEl=$('#log');
function fmt(ms){ms=Math.max(0,ms);var s=Math.floor(ms/1000),m=Math.floor(s/60);s=s%60;return (m<10?'0':'')+m+':'+(s<10?'0':'')+s;}
/* atMs (optional): time since the run started, for real data. Without it, simulation time is used. */
function log(level,text,atMs){
  var em=logEl.querySelector('.empty');if(em)logEl.removeChild(em);
  var li=document.createElement('li');li.className=level;
  var t=document.createElement('time');t.textContent=fmt(atMs===undefined?simT-runT0:atMs);
  var sp=document.createElement('span');sp.textContent=text;
  li.appendChild(t);li.appendChild(sp);logEl.insertBefore(li,logEl.firstChild);
  while(logEl.children.length>80)logEl.removeChild(logEl.lastChild);
}
function renderLogEmpty(){
  logEl.innerHTML='';var li=document.createElement('li');li.className='empty';
  li.innerHTML='<time>&nbsp;</time><span>Pipeline events will appear here.</span>';logEl.appendChild(li);
}
var stepsEl=$('#steps');
function renderSteps(){
  stepsEl.innerHTML='';
  STEPS.forEach(function(s){
    var st=stepsState[s[0]]||{status:'pending',note:''};
    var li=document.createElement('li');li.className=st.status;
    li.innerHTML='<span class="m"></span><span><span class="l"></span><span class="n"></span></span>';
    li.querySelector('.l').textContent=s[1];
    li.querySelector('.n').textContent=st.note||(st.status==='pending'?'Waiting':'');
    stepsEl.appendChild(li);
  });
}
function step(id,status,note){stepsState[id]={status:status,note:note||''};renderSteps();}
var PILL={idle:['Waiting for ticket','NULL'],run:['Running','NULL'],success:['Done, PR ready for review','SUCCESS'],needs:['Needs human','NEEDS_HUMAN'],error:['Error, BullMQ will retry','ERROR']};
function setStatus(k){
  var p=$('#rpill');
  if(k==='success'||k==='needs')runEnd=simT; else if(k==='run'||k==='idle')runEnd=null;
  p.className='pill '+k;p.textContent=PILL[k][0];$('#rfs').textContent=PILL[k][1];
}
/* Fills the "Current run" panel. clock (optional): a function returning the run's elapsed ms from real data. */
function setRun(r){
  runT0=simT;runClock=r.clock||null;
  $('#rtk').textContent=r.title||'No ticket yet';
  if(r.meta)$('#rmeta').textContent=r.meta; else $('#rmeta').innerHTML='&nbsp;';
}

/* ====== reset ====== */
function resetWorld(){
  epoch++;
  timers.forEach(function(t){t.rej(CANCEL);});timers=[];
  docs.forEach(function(d){if(d.el.parentNode)d.el.parentNode.removeChild(d.el);});docs.length=0;bugs.length=0;
  outboxFlag=false;
  ORDER.forEach(function(id){
    var a=A[id];a.state=(id==='docs')?'offduty':'idle';a.tone='';
    a.bubble=null;a.checks=[0,0,0];a.attempt='';a.cost=0;a.hasCost=false;a.tokens=mock?0:null;a.activeMs=0;a.board=0;
    placeInitial(a);
  });
  say(A.docs,'zZ','mute');
  stepsState={};renderSteps();renderLogEmpty();
  setRun({});setStatus('idle');
}

/* ====== drawing ====== */
function plant(g,x,y){
  var s=1.5;
  function P(dx,dy,w,h,c){R(g,x+dx*s,y+dy*s,w*s,h*s,c);}
  P(2,7,4,5,'#a35f3a');P(1,6,6,2,'#b87245');
  P(3,0,2,7,'#2f8f4e');P(0,2,4,3,'#3fae60');P(4,1,4,3,'#3fae60');
}
function buildBG(){
  bgc=document.createElement('canvas');bgc.width=cv.width;bgc.height=cv.height;
  var g=bgc.getContext('2d');
  R(g,0,0,W,H,'#252740');
  R(g,4,136,392,20,'#c4c7d9');
  for(var x=10;x<392;x+=16)R(g,x,145,8,2,'#aeb2ca');
  ZONES.forEach(function(z){
    for(var ty=0;ty*8<z.h;ty++)for(var tx=0;tx*8<z.w;tx++){
      R(g,z.x+tx*8,z.y+ty*8,8,Math.min(8,z.h-ty*8),((tx+ty)&1)?z.c2:z.c1);
    }
    if(z.top){
      R(g,z.x,z.y,z.w,36,'#3a3e66');R(g,z.x,z.y,z.w,3,'#4d5282');
      for(var wx=z.x+16;wx<z.x+z.w;wx+=16)R(g,wx,z.y+3,1,31,'#33375c');
      R(g,z.x,z.y+34,z.w,2,'#2a2d4d');
    } else R(g,z.x,z.y+z.h-4,z.w,4,'#3a3e66');
  });
  /* planning whiteboard */
  R(g,13,10,52,28,'#8b8fa8');R(g,14,11,50,26,'#f4f5f9');R(g,14,37,50,2,'#8b8fa8');
  /* PIV poster */
  R(g,151,11,30,19,'#f4f5f9');R(g,151,11,30,1,'#8b8fa8');R(g,151,29,30,1,'#8b8fa8');
  R(g,154,16,6,6,'#3f7de0');R(g,163,16,6,6,'#7a5af0');R(g,172,16,6,6,'#36a35b');
  R(g,160,18,3,2,'#555a6e');R(g,169,18,3,2,'#555a6e');
  /* QA poster */
  R(g,299,11,20,22,'#f4f5f9');
  for(var r=0;r<4;r++){R(g,302,15+r*5,3,3,'#36a35b');R(g,307,16+r*5,9,1,'#9aa0b8');}
  /* server rack */
  R(g,208,16,18,36,'#2a2e48');R(g,209,17,16,34,'#363b5c');
  for(var u=0;u<5;u++)R(g,210,19+u*7,14,5,'#1d2036');
  R(g,208,52,18,2,'rgba(0,0,0,.18)');
  /* pantry */
  R(g,250,164,36,20,'#8b7355');R(g,250,164,36,5,'#cdbb9c');
  R(g,254,153,10,12,'#b3392e');R(g,256,156,6,3,'#2a2e48');
  R(g,270,161,3,3,'#fff');R(g,275,161,3,3,'#fff');
  /* sofa (where Docs sits), coffee table, fridge */
  R(g,186,226,60,26,'#6b5ca8');R(g,188,226,56,7,'#7a6bc0');R(g,189,233,54,15,'#8a7bd0');
  R(g,186,232,5,20,'#5a4c96');R(g,241,232,5,20,'#5a4c96');
  R(g,196,262,40,12,'#8c5e3a');R(g,196,262,40,2,'#d3a173');R(g,198,274,3,5,'#6e4a2c');R(g,231,274,3,5,'#6e4a2c');
  R(g,204,259,4,4,'#fff');R(g,222,258,7,5,'#e8e9f0');R(g,223,259,5,1,'#9aa0b8');
  R(g,150,160,18,34,'#dfe3ee');R(g,150,160,18,1,'#f4f5f9');R(g,150,174,18,1,'#aeb2ca');R(g,165,164,1,7,'#8b8fa8');R(g,165,178,1,10,'#8b8fa8');
  /* review bookshelf */
  R(g,12,236,44,32,'#6e4a2c');
  var bk=['#d9534f','#3f7de0','#36a35b','#f2c230','#7a5af0'];
  for(var sh=0;sh<3;sh++){
    R(g,14,238+sh*10,40,8,'#8a6038');
    for(var b=0;b<9;b++)R(g,15+b*4.3,239+sh*10,3,7,bk[(b+sh*2)%5]);
  }
  /* PR box */
  R(g,316,164,56,26,'#7d6a42');R(g,316,164,56,4,'#a38d5a');
  R(g,334,174,20,3,'#1d1a10');R(g,320,181,48,5,'#cdbb82');
  /* plants */
  [[16,100],[110,112],[188,112],[270,112],[330,112],[372,112],[62,262],[158,262],[272,262],[300,262],[372,262]].forEach(function(p){plant(g,p[0],p[1]);});
}
function fit(){
  DPR=window.devicePixelRatio||1;
  var cw=stage.clientWidth-6,ch=stage.clientHeight-6;
  var base=Math.min(cw/W,ch/H);
  if(!isFinite(base)||base<=0)base=1.5;
  var cssK=base*zoom;
  K=cssK*DPR;
  if(W*K>4096)K=4096/W;
  cv.width=Math.round(W*K);cv.height=Math.round(H*K);
  scene.style.width=(W*cssK)+'px';scene.style.height=(H*cssK)+'px';
  scene.style.setProperty('--u',cssK+'px');
  bgc=null;
}
var CHKC=['#4a5270','#ffcf4a','#4ade80','#ff5d52'];
function screenMode(a){
  switch(a.state){
    case 'planning':return 'text';
    case 'implementing':return 'code';
    case 'verifying':case 'retrying':return a.checks?'checks':'diff';
    case 'reviewing':return 'diff';
    case 'celebrating':return 'ok';
    case 'blocked':return 'bad';
    case 'error':return 'bad';
    case 'alert':return a.tone==='bad'?'bad':'ok';
    default:return 'off';
  }
}
function drawScreen(a,sx,sy,sw,sh,T){
  var g=ctx,m=screenMode(a),i,kx=sw/26,ky=sh/15;
  function Q(x,y,w,h,c){R(g,sx+x*kx,sy+y*ky,w*kx,h*ky,c);}
  Q(0,0,26,15,'#0f1424');
  if(m==='off'){ if(((T*1.2)|0)%2)Q(3,3,2,1,'#3a4260'); }
  else if(m==='text'){
    var n=1+((T*1.6)|0)%6;
    for(i=0;i<n&&i<5;i++)Q(3,2+i*3,8+((i*7)%15),1,i%2?'#7fb2ff':'#cfe0ff');
  } else if(m==='code'){
    var cols=['#ff9d6e','#7fe3b0','#b79bff','#7fb2ff'];
    for(i=0;i<5;i++){var k=((T*3)|0)+i,ind=(k%3)*3,w=Math.min(5+((k*7)%15),22-ind);Q(2+ind,2+i*3,w,1,cols[k%4]);}
  } else if(m==='checks'){
    for(i=0;i<3;i++){
      var y=2+i*4,c=a.checks[i];
      var col=CHKC[c];if(c===1&&((T*5)|0)%2)col='#8a6d1c';
      Q(2,y,3,3,col);Q(7,y+1,16,1,'#2a3350');
      if(c===2)Q(7,y+1,16,1,'#4ade80');
      else if(c===3)Q(7,y+1,16,1,'#ff5d52');
      else if(c===1)Q(7,y+1,((T*12)%16)|0,1,'#ffcf4a');
    }
  } else if(m==='diff'){
    for(i=0;i<5;i++){var t=((T*2)|0)+i,cc=['#cfd3e8','#4ade80','#cfd3e8','#ff7b71','#cfd3e8'][t%5];Q(2,2+i*3,4+((t*5)%18),1,cc);}
  } else if(m==='ok'){
    Q(0,0,26,15,'#12351f');
    [[8,8],[10,10],[12,8],[14,6],[16,4]].forEach(function(p){Q(p[0],p[1],2,2,'#4ade80');});
  } else if(m==='bad'){
    Q(0,0,26,15,((T*6)|0)%2?'#3c1216':'#531821');
    Q(12,2,2,7,'#ff6b5e');Q(12,11,2,2,'#ff6b5e');
  }
}
function drawDesk(id,T){
  var s=ST[id],a=A[id],g=ctx,cx=s.cx,fy=s.fy;
  R(g,cx-18,fy-24,36,14,'#d3a173');R(g,cx-18,fy-24,36,1,'#e4bc92');R(g,cx-18,fy-10,36,2,'#8c5e3a');
  R(g,cx-17,fy-8,3,8,'#8c5e3a');R(g,cx+14,fy-8,3,8,'#8c5e3a');
  R(g,cx-6,fy-19,12,2,'#e8e9f0');R(g,cx-6,fy-17,12,1,'#c2c5d6');
  var mx=cx-9,my=fy-37;
  R(g,mx,my,18,13,'#20243a');drawScreen(a,mx+1,my+1,16,9,T);R(g,cx-2,fy-25,4,1,'#20243a');
}
function accessory(a,P,hy,back){
  var k=a.def.acc;
  if(k==='pencil')P(3,hy+2,1,3,'#f2c230');
  else if(k==='cap'){P(-3,hy-1,6,2,'#222a44');if(!back)P(-3,hy+1,6,1,'#222a44');}
  else if(k==='phones'){P(-3,hy-1,6,1,'#e8e8f0');P(-4,hy+2,1,3,'#e8e8f0');P(3,hy+2,1,3,'#e8e8f0');}
  else if(k==='goggles')P(-3,hy+2,6,2,'#48d1e6');
  else if(k==='glasses'){if(!back)P(-3,hy+2,6,1,'#222');}
  else if(k==='bun')P(-1,hy-2,3,2,'#3a2a22');
  else if(k==='capw'){P(-3,hy-1,6,2,'#e8e8e8');if(!back)P(-3,hy+1,6,1,'#e8e8e8');}
}
function drawChar(a,T){
  var g=ctx,d=a.def,st=a.state,cs=CS;
  var f=((T*8)|0)%2;
  var x=Math.round(a.x*K)/K,gy=Math.round(a.y*K)/K,y=gy;
  var docs=a.id==='docs';
  /* Back to us while facing the screen; turned to the front when idle, done, or needing attention. */
  var back=a.id==='human'?(st!=='alert'):(!docs&&!!BACKFACE[st]);
  /* Seated, except while jumping to celebrate. sd: how far the body is lowered. */
  var sit=st!=='celebrating',sd=sit?2:0;
  if(st==='celebrating')y-=Math.abs(Math.sin(T*9))*4;
  if(st==='error')x+=(((T*14)|0)%2?1:-1);
  y=Math.round(y*K)/K;
  function P(dx,dy,w,h,c){R(g,x+dx*cs,y+dy*cs,w*cs,h*cs,c);}
  if(docs)g.globalAlpha=.55;
  R(g,x-4*cs,gy-1*cs,8*cs,2*cs,'rgba(0,0,0,.18)');
  /* chair: backrest behind the body when facing front */
  if(sit&&!docs&&!back){P(-5,-11,10,9,'#3a3f5e');P(-5,-11,10,1,'#4d5282');}
  P(-3,-4,3,4,'#2a3050');P(0,-4,3,4,'#2a3050');
  P(-3,-1,3,1,'#15172b');P(0,-1,3,1,'#15172b');
  y+=sd*cs;
  P(-4,-10,8,6,d.color);P(-4,-5,8,1,'rgba(0,0,0,.15)');
  var sk=d.skin,sl=d.color,pose='down';
  /* Idle: sips coffee roughly every 3 seconds; the phase is shifted per agent so they are not in sync. */
  var sip=((T+a.def.name.length*.7)%3.2)<.9;
  if(st==='celebrating')pose='up';
  else if(st==='error')pose='head';
  else if(st==='blocked'||(a.id==='human'&&st==='alert'))pose='wave';
  else if(st==='retrying')pose='scratch';
  else if(WORKING[st])pose='type';
  else if(st==='idle'&&a.id!=='human')pose='coffee';
  if(pose==='down'){P(-5,-10,1,4,sl);P(-5,-6,1,1,sk);P(4,-10,1,4,sl);P(4,-6,1,1,sk);}
  else if(pose==='type'){P(-5,-10,1,3,sl);P(4,-10,1,3,sl);P(-5,-7+f,1,1,sk);P(4,-6-f,1,1,sk);}
  else if(pose==='up'){P(-5,-13,1,4,sl);P(-5,-14,1,1,sk);P(4,-13,1,4,sl);P(4,-14,1,1,sk);}
  else if(pose==='head'){P(-5,-11,1,3,sl);P(4,-11,1,3,sl);P(-4,-14,1,2,sk);P(3,-14,1,2,sk);}
  else if(pose==='wave'){P(-5,-10,1,4,sl);P(-5,-6,1,1,sk);var wv=f?0:1;P(4,-14+wv,1,5,sl);P(4,-15+wv,1,1,sk);}
  else if(pose==='scratch'){P(-5,-10,1,4,sl);P(-5,-6,1,1,sk);P(4,-13,1,4,sl);P(3,-14,2,1,sk);P(-6,-14+(((T*4)|0)%2),1,2,'#7fd8ff');}
  else if(pose==='coffee'){
    P(-5,-10,1,4,sl);P(-5,-6,1,1,sk);
    if(sip){P(4,-12,1,3,sl);P(3,-12,1,1,sk);}       /* arm raised, cup at the mouth */
    else {P(4,-10,1,3,sl);P(4,-7,1,1,sk);}           /* cup held in front of the chest */
  }
  var hy=-16;
  if(back){P(-3,hy,6,6,d.hair);P(-2,hy+5,4,1,sk);}
  else {
    P(-3,hy,6,6,sk);P(-3,hy,6,2,d.hair);P(-3,hy+2,1,2,d.hair);P(2,hy+2,1,2,d.hair);
    if(docs){P(-2,hy+3,2,1,'#15172b');P(1,hy+3,2,1,'#15172b');}   /* eyes closed: off duty */
    else {P(-2,hy+3,1,1,'#15172b');P(1,hy+3,1,1,'#15172b');}
    if(st==='celebrating'||st==='error'||st==='blocked')P(-1,hy+5,2,1,'#7a2a2a');
  }
  accessory(a,P,hy,back);
  if(pose==='coffee'){
    if(sip){P(1,-12,2,2,'#fff');P(1,-12,2,1,'#e8e9f0');}
    else {P(4,-8,2,2,'#fff');P(6,-8,1,1,'#fff');if(((T*2)|0)%2)P(5,-11,1,1,'rgba(255,255,255,.8)');}
  }
  /* chair: backrest covers the back when turned away from us */
  if(sit&&!docs&&back){P(-3,-9,6,6,'#3a3f5e');P(-3,-9,6,1,'#4d5282');}
  if(st==='error'){var ff=((T*10)|0)%2;P(-1,hy-3+ff,2,2,'#ff9d2e');P(0,hy-5+ff,1,2,'#ffd24a');}
  g.globalAlpha=1;
}
function render(){
  var T=simT/1000,g=ctx;
  if(!bgc)buildBG();
  g.setTransform(1,0,0,1,0,0);g.imageSmoothingEnabled=false;g.drawImage(bgc,0,0);
  var nb=Math.floor(A.planner.board);
  for(var i=0;i<nb&&i<7;i++)R(g,17,14+i*3,10+((i*9)%30),1,i%2?'#d9534f':'#3f7de0');
  var busy=A.backend.state==='implementing'||A.backend.state==='verifying'||A.frontend.state==='implementing'||A.frontend.state==='verifying';
  var rate=busy?7:1.5;
  for(var u=0;u<5;u++)for(var j=0;j<3;j++){
    var on=(((T*rate)|0)+u*3+j*2)%4<2;
    R(g,212+j*4,21+u*7,2,1,on?(j===1?'#ffcf4a':'#4ade80'):'#2c3250');
  }
  for(var k=0;k<3;k++){var ph=((T*.8+k*.33)%1);R(g,259+Math.round(Math.sin(ph*6+k)*2),150-Math.round(ph*12),1,1,'rgba(255,255,255,.75)');}
  if(outboxFlag){R(g,375,164,1,22,'#2b2b2b');R(g,376,164,8,5,'#e5493a');}
  ORDER.forEach(function(id){if(id!=='docs')drawDesk(id,T);});
  var sa=A[selected];R(g,sa.x-9,sa.y+1.5,18,1,'#5b4bdb');R(g,sa.x-7,sa.y+3,14,1,'#5b4bdb');
  ORDER.map(function(id){return A[id];}).sort(function(p,q){return p.y-q.y;}).forEach(function(a){drawChar(a,T);});
  bugs=bugs.filter(function(b){return simT<b.until;});
  bugs.forEach(function(){
    var bx=326+Math.abs(((T*16)%64)-32),by=104+(((T*10)|0)%2);
    function B(dx,dy,w,h,c){R(g,bx+dx*1.5,by+dy*1.5,w*1.5,h*1.5,c);}
    B(0,0,5,3,'#1a1a1a');B(1,-1,3,1,'#c0392b');B(-1,(((T*10)|0)%2),1,1,'#1a1a1a');B(5,1,1,1,'#1a1a1a');
  });
  docs=docs.filter(function(d){
    if(simT>=d.t0+d.dur){if(d.el.parentNode)d.el.parentNode.removeChild(d.el);return false;}
    return true;
  });
  docs.forEach(function(d){
    var p=(simT-d.t0)/d.dur;p=Math.max(0,Math.min(1,p));var e=p*p*(3-2*p);
    for(var tr=2;tr>=0;tr--){
      var pe=Math.max(0,e-tr*.06);
      var px=d.p0.x+(d.p1.x-d.p0.x)*pe,py=d.p0.y+(d.p1.y-d.p0.y)*pe-30*Math.sin(Math.PI*pe);
      g.globalAlpha=tr===0?1:(tr===1?.3:.15);
      var D=function(dx,dy,w,h,c){R(g,px+dx*1.4,py+dy*1.4,w*1.4,h*1.4,c);};
      D(-3,-4,7,9,'#ffffff');D(-3,-4,7,1,'#15172b');D(-3,4,7,1,'#15172b');D(-3,-4,1,9,'#15172b');D(3,-4,1,9,'#15172b');
      D(-1,-2,4,1,'#9aa0b8');D(-1,0,4,1,'#9aa0b8');D(-1,2,3,1,'#9aa0b8');
    }
    g.globalAlpha=1;
    var ex=d.p0.x+(d.p1.x-d.p0.x)*e,ey=d.p0.y+(d.p1.y-d.p0.y)*e-30*Math.sin(Math.PI*e);
    d.el.style.left=(ex/W*100)+'%';d.el.style.top=((ey+8)/H*100)+'%';
  });
  var h=A.human,lx=ST.human.cx+22,ly=ST.human.fy;
  R(g,lx,ly-12,6,3,'#2b2b2b');
  if(h.state==='alert'){
    var bc=h.tone==='bad'?'#ff4b3e':'#4ade80',on2=((T*3)|0)%2;
    R(g,lx+1,ly-17,4,5,on2?bc:(h.tone==='bad'?'#8a2a24':'#1f7a45'));
    g.globalAlpha=on2?.3:.12;R(g,lx-6,ly-24,18,18,bc);g.globalAlpha=1;
  } else R(g,lx+1,ly-17,4,5,'#3a3e55');
  updateDOM();
}

/* ====== DOM overlay ====== */
function buildOverlay(){
  ZONES.forEach(function(z){
    var l=document.createElement('div');l.className='rl';l.textContent=z.label;
    l.style.left=(z.lx/W*100)+'%';l.style.top=(z.ly/H*100)+'%';ov.appendChild(l);
  });
  ORDER.forEach(function(id){
    var a=A[id],el=document.createElement('div');el.className='ag';
    el.innerHTML='<div class="bub" hidden></div><div class="tag"></div>';
    ov.appendChild(el);a.el=el;a.bubEl=el.firstChild;a.tagEl=el.lastChild;a.tagEl.textContent=a.def.name;
  });
}
function updateDOM(){
  ORDER.forEach(function(id){
    var a=A[id];
    a.el.style.left=(a.x/W*100)+'%';a.el.style.top=(a.y/H*100)+'%';
    var b=a.bubble,show=b&&(!b.until||simT<b.until);
    var key=show?(b.tone+'|'+b.text):'';
    if(key!==a._bk){
      a._bk=key;
      if(show){a.bubEl.hidden=false;a.bubEl.textContent=b.text;a.bubEl.className='bub t-'+(b.tone||'info');}
      else a.bubEl.hidden=true;
    }
  });
}

/* ====== panels and controls ====== */
var agl=$('#agl');
function buildAgentList(){
  $('#agn').textContent=ORDER.length+' agents';
  ORDER.forEach(function(id){
    var a=A[id],b=document.createElement('button');b.type='button';b.className='ar';
    b.innerHTML='<i></i><span class="nm"></span><span class="st"></span><span class="sb"></span>';
    b.querySelector('i').style.background=a.def.color;b.querySelector('.nm').textContent=a.def.name;
    b.addEventListener('click',function(){select(id,true);});
    /* Enter/Space on a row selects the agent, same as clicking it on the canvas. */
    agl.appendChild(b);a.row=b;
  });
}
function showTab(which){
  var log=which==='log';
  $('#tab-log').setAttribute('aria-selected',log?'true':'false');
  $('#tab-ag').setAttribute('aria-selected',log?'false':'true');
  $('#tab-log').tabIndex=log?0:-1;$('#tab-ag').tabIndex=log?-1:0;
  $('#pane-log').hidden=!log;$('#pane-ag').hidden=log;
}
$('#tab-log').addEventListener('click',function(){showTab('log');});
$('#tab-ag').addEventListener('click',function(){showTab('ag');});
/* WAI-ARIA tab pattern: left/right arrows switch tabs, only the active tab is in the Tab order. */
document.querySelector('.tabs').addEventListener('keydown',function(ev){
  if(ev.key!=='ArrowLeft'&&ev.key!=='ArrowRight')return;
  var toLog=$('#tab-log').getAttribute('aria-selected')!=='true';
  showTab(toLog?'log':'ag');$(toLog?'#tab-log':'#tab-ag').focus();ev.preventDefault();
});
function select(id,explicit){selected=id;if(explicit)showTab('ag');updatePanel();}
function stLabel(a){ if(a.id==='human'&&a.state==='idle')return 'Waiting for PR'; return STATE_LABEL[a.state]||a.state; }
function fmtDur(ms){return Math.round(ms/1000)+' s';}
function money(a){ if(mock)return '$'+a.cost.toFixed(3); return a.hasCost?'$'+a.cost.toFixed(4):'not available yet'; }
function updatePanel(){
  var a=A[selected],d=a.def,sfx=mock?' (sample)':'';
  ORDER.forEach(function(id){
    var x=A[id],r=x.row;
    r.setAttribute('aria-pressed',id===selected?'true':'false');
    r.querySelector('.st').textContent=stLabel(x);
    var sb=[];
    if(x.attempt&&(WORKING[x.state]||!mock))sb.push('Attempt '+x.attempt);
    if(x.def.rate)sb.push(money(x));
    else if(id==='docs')sb.push('Not instrumented');
    else if(id==='human')sb.push('No auto-merge');
    r.querySelector('.sb').textContent=sb.join(', ');
  });
  $('#adn').textContent=d.name;
  $('#adf').textContent=d.file?('.claude/agents/'+d.file+'.md'):'Human, not an agent';
  var tok=a.tokens===null?(d.rate?'not recorded':'-'):a.tokens.toLocaleString('en-US');
  var rows=[['Status',stLabel(a)],['Verify attempt',a.attempt||'-'],['Work time',fmtDur(a.activeMs)],
    ['Tokens'+sfx,tok],['Cost'+sfx,(d.rate||mock)?money(a):'-'],['Access',d.access],['Produces',d.out]];
  var dl=$('#adk');dl.innerHTML='';
  rows.forEach(function(r){var t=document.createElement('dt'),v=document.createElement('dd');t.textContent=r[0];v.textContent=r[1];dl.appendChild(t);dl.appendChild(v);});
  $('#add').textContent=d.desc;
  var total=0,any=false;ORDER.forEach(function(id){total+=A[id].cost;any=any||A[id].hasCost;});
  $('#rcostk').textContent='Cost'+sfx;
  $('#rcost').textContent=mock?'$'+total.toFixed(3):(any?'$'+total.toFixed(4):'not available yet');
  $('#rel').textContent=fmt(runClock?runClock():(runEnd===null?simT:runEnd)-runT0);
}
$('#pp').addEventListener('click',function(){paused=!paused;this.textContent=paused?'Resume':'Pause';this.setAttribute('aria-pressed',paused?'true':'false');});
Array.prototype.forEach.call($('#spd').children,function(b){
  b.addEventListener('click',function(){
    speed=+b.dataset.s;
    Array.prototype.forEach.call($('#spd').children,function(o){o.setAttribute('aria-pressed',o===b?'true':'false');});
  });
});
$('#zin').addEventListener('click',function(){zoom=Math.min(3,zoom*1.25);fit();});
$('#zout').addEventListener('click',function(){zoom=Math.max(.5,zoom/1.25);fit();});
$('#zfit').addEventListener('click',function(){zoom=1;fit();stage.scrollLeft=0;stage.scrollTop=0;});
var dlg=$('#help');
$('#helpb').addEventListener('click',function(){ if(dlg.showModal)dlg.showModal(); else dlg.setAttribute('open',''); });
$('#helpx').addEventListener('click',function(){ if(dlg.close)dlg.close(); else dlg.removeAttribute('open'); });
scene.addEventListener('pointerdown',function(ev){
  var r=scene.getBoundingClientRect(),px=(ev.clientX-r.left)/r.width*W,py=(ev.clientY-r.top)/r.height*H;
  var best=null,bd=1e9;
  ORDER.forEach(function(id){
    var a=A[id],dx=Math.abs(px-a.x),dy=py-(a.y-12);
    if(dx<12&&Math.abs(dy)<18){var d=dx+Math.abs(dy);if(d<bd){bd=d;best=id;}}
  });
  if(best)select(best,true);
});

/* ====== loop ====== */
function advance(dt){
  simT+=dt*1000;
  ORDER.forEach(function(id){
    var a=A[id];
    if(WORKING[a.state]){
      if(mock){a.cost+=a.def.rate*dt;a.tokens=Math.round(a.cost*45000);a.activeMs+=dt*1000;}
      if(a.id==='planner'&&a.state==='planning')a.board=Math.min(7,a.board+dt*1.1);
    }
  });
  var due=timers.filter(function(t){return t.at<=simT;});
  if(due.length){timers=timers.filter(function(t){return t.at>simT;});due.forEach(function(t){t.ok();});}
}
var last=performance.now(),lastPanel=0;
function frame(now){
  var dt=Math.min(.1,(now-last)/1000);last=now;
  if(!paused)advance(dt*speed);
  render();
  if(now-lastPanel>200){lastPanel=now;updatePanel();}
  requestAnimationFrame(frame);
}

/* ====== start ====== */
buildAgentList();buildOverlay();fit();
if('ResizeObserver' in window){new ResizeObserver(function(){fit();}).observe(stage);}
else window.addEventListener('resize',fit);
resetWorld();
if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches){paused=true;$('#pp').textContent='Resume';$('#pp').setAttribute('aria-pressed','true');}
requestAnimationFrame(frame);

window.AgentFloor={
  setState:setState,say:say,sendDoc:sendDoc,step:step,setStatus:setStatus,log:log,
  reset:resetWorld,setRun:setRun,usage:usage,checks:checks,
  wait:wait,ready:ready,later:later,fire:fire,celebrate:celebrate,CANCEL:CANCEL,
  setMock:function(v){mock=!!v;},
  isPaused:function(){return paused;},
  name:function(a){return AG(a).def.name;},
  CHK:CHK
};
})();
