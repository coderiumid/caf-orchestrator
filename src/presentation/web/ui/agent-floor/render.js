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
 * The office is one open-plan room. Each agent has a fixed seat (see ST).
 * Working always happens at the seat. Leaving it is idle-only decoration
 * (see "idle activities"): it never delays or stands in for a state change.
 *
 * Callers: demo.js (mock scenarios) and adapter.js (live and replay).
 * An agent may be referenced by id ('planner', 'backend', 'frontend', 'qa',
 * 'reviewer', 'docs', 'human') or by its object.
 */
(function(){
'use strict';
/* ====== world constants ====== */
var W=400,H=320,CS=1.5;
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

/* One open-plan room. Everything that is drawn in two places (once into the
   static background, once per frame for its animated part) takes its
   position from here. */
var ROOM={x:8,y:8,w:384,h:H-16,wall:40};
/* The two main rugs share their top and bottom edges. */
var RUG={x:46,y:80,w:144,h:136};          /* under the desk pod */
var GATE={x:284,y:80,w:100,h:136};        /* PR gate: the PR box and Manager's desk */
var MEET={x:284,y:232,w:100,h:64};        /* meeting corner, below the PR gate */
var BOARD={x:16,y:12};                    /* planning whiteboard */
var COUNTER={x:286,y:48};                 /* coffee counter */
var PRBOX={x:306,y:92};                   /* where finished work goes */
/* Below the pod, inside the rug's left and right edges: bookshelf, server racks. */
var SHELF={x:46,y:266};
var RACKS=[{x:152,y:262},{x:172,y:262}];
var TABLE={x:292,y:256};                  /* meeting table */
/* Plants stand in the room's corners or against furniture, never on open floor. */
var DECOR_PLANTS=[[14,54],[374,54],[94,280],[136,280],[266,82],[266,278]];
var LABELS=[['Workspace',48,207],['PR gate',286,207],['Meeting',286,287]];
var SHADOW='rgba(0,0,0,.18)';             /* strip on the floor under every piece of furniture */
/* The agents' desks sit close together in one workspace, with Manager at the
   PR gate facing the PR box. Docs shares the workspace but remains off duty. */
var ST={
 planner:{cx:72,fy:124},
 backend:{cx:118,fy:124},
 frontend:{cx:164,fy:124},
 qa:{cx:72,fy:188},
 reviewer:{cx:164,fy:188},
 human:{cx:330,fy:188},
 docs:{cx:118,fy:188}
};
var OUTBOX={x:PRBOX.x+28,y:PRBOX.y+10};

/* ====== idle activities ======
   Only these agents leave their seat; Manager stays at the PR gate and Docs
   stays asleep, because where they are carries meaning. */
var ROAM={planner:1,backend:1,frontend:1,qa:1,reviewer:1};
var WALK=50,RUSH=190;                      /* world units per simulated second: strolling, hurrying back to work */
var AISLE_DY=14;                           /* the walkway in front of each desk row, below the seat */
var LANE_R=206,LANE_L=34;                  /* corridors right and left of the desk pod */
/* Where an agent stands for each activity, how long it stays, and which corridor leads there. */
var SPOT={
 coffee:{x:COUNTER.x+12,y:COUNTER.y+26,lane:LANE_R,ms:1600},
 board:{x:BOARD.x+26,y:BOARD.y+52,lane:LANE_L,ms:3600},
 shelf:{x:SHELF.x+22,y:SHELF.y+40,lane:LANE_L,ms:3200},
 fridge:{x:271,y:68,lane:LANE_R,ms:2400},
 stretch:{ms:2600},                         /* at the seat, no walking */
 chat:{ms:5200}                             /* two agents; they stand at CHAT[0] and CHAT[1] */
};
/* Where the two chatting agents stand, side by side in the meeting corner. */
var CHAT=[{x:MEET.x+34,y:MEET.y+14,lane:LANE_R},{x:MEET.x+60,y:MEET.y+14,lane:LANE_R}];
var IDLE_KINDS=['board','shelf','stretch','coffee','fridge','chat'];
var ACT_LABEL={coffee:'Getting coffee',board:'At the whiteboard',shelf:'At the bookshelf',stretch:'Stretching',fridge:'At the fridge',chat:'Chatting'};

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
 human:{name:'Manager',file:'',color:'#17181f',hair:'#17181f',skin:'#c68a5e',acc:'capw',rate:0,
  access:'Mandatory review before merge',out:'merge decision',
  desc:'No auto-merge. Every PR stops at this desk.'}
};

/* ====== state ====== */
var bgc=null,DPR=1,zoom=1;
var cv=$('#cv'),ctx=cv.getContext('2d'),scene=$('#scene'),ov=$('#ov'),stage=$('#stage');
var simT=0,speed=1,paused=false,epoch=0,timers=[],runT0=0,runEnd=null;
var A={},docs=[],bugs=[],outboxFlag=false,selected='planner',nextIdleAt=0;
var stepsState={};
var STEPS=[['plan','Plan'],['impl','Implement and verify'],['qa','QA'],['review','Review'],['pr','PR and Linear']];
/* mock=true only in demo mode: cost, tokens, and work time are computed from
   sample rates. Otherwise all three change only through usage(). */
var mock=false,runClock=null;
function AG(a){return typeof a==='string'?A[a]:a;}

/* ====== agent ====== */
ORDER.forEach(function(id){
  A[id]={id:id,def:DEF[id],x:0,y:0,state:'idle',tone:'',bubble:null,checks:[0,0,0],attempt:'',cost:0,hasCost:false,tokens:null,activeMs:0,board:0,_bk:'',mv:null,want:false};
});
/* Every agent has a fixed seat, and work shows only through pose and screen
   there, so a state change stays readable however fast it comes. */
function placeInitial(a){a.x=ST[a.id].cx;a.y=ST[a.id].fy;a.mv=null;a.want=false;}

/* ====== idle activities: movement ======
   a.mv is the activity in progress: {kind, route, path, i, phase, until, rush, cup, dy}.
   route runs seat -> spot along the walkways, so an agent never cuts through a desk. */
function routeTo(a,sp){
  var s=ST[a.id],ay=s.fy+AISLE_DY;
  return [{x:s.cx,y:s.fy},{x:s.cx,y:ay},{x:sp.lane,y:ay},{x:sp.lane,y:sp.y},{x:sp.x,y:sp.y}];
}
function startAct(a,kind,sp){
  if(kind==='stretch'){a.mv={kind:kind,phase:'at',until:simT+SPOT.stretch.ms};return;}
  var r=routeTo(a,sp||SPOT[kind]);
  a.mv={kind:kind,route:r,path:r,i:1,phase:'go',until:0,rush:false,cup:false,dy:1};
}
/* A chat needs two: each gets a place, and knows who it is talking to. */
function startChat(a,b){
  startAct(a,'chat',CHAT[0]);a.mv.mate=b.id;a.mv.slot=0;a.mv.wait=true;
  startAct(b,'chat',CHAT[1]);b.mv.mate=a.id;b.mv.slot=1;b.mv.wait=true;
}
function chatting(a){return !!a.mv&&a.mv.kind==='chat'&&a.mv.phase!=='back';}
function away(a){return !!a.mv&&a.mv.kind!=='stretch';}
/* Turn round and go back the way the agent came. rush: work has arrived (or
   the run ended badly), so hurry; the state itself has already changed. */
function headBack(a,rush){
  var m=a.mv;if(!m)return;
  if(m.kind==='stretch'){a.mv=null;return;}
  if(m.phase==='go'){m.path=m.route.slice(0,m.i).reverse();m.i=0;}
  else if(m.phase==='at'){m.path=m.route.slice(0,-1).reverse();m.i=0;}
  m.phase='back';m.rush=m.rush||rush;
}
function stepAct(a,dt){
  var m=a.mv;
  if(a.state!=='idle'&&!(m.phase==='back'&&m.rush)){headBack(a,true);m=a.mv;if(!m)return;}
  /* The other half of a chat was called away: nobody is left talking alone. */
  if(m.kind==='chat'&&m.phase!=='back'&&!chatting(A[m.mate]))headBack(a,false);
  if(m.phase==='at'){
    if(m.wait){
      /* first to arrive waits; the chat is timed from when both are there */
      var mate=A[m.mate].mv;
      if(mate.phase==='at'){m.wait=mate.wait=false;m.until=mate.until=simT+SPOT.chat.ms;}
      return;
    }
    if(simT<m.until)return;
    if(m.kind==='stretch'){a.mv=null;return;}
    headBack(a,false);m.cup=m.kind==='coffee';
    return;
  }
  var left=(m.rush?RUSH:WALK)*dt;
  while(left>0&&m.i<m.path.length){
    var p=m.path[m.i],dx=p.x-a.x,dy=p.y-a.y,d=Math.sqrt(dx*dx+dy*dy);
    if(d<=left){a.x=p.x;a.y=p.y;left-=d;m.i++;}
    else {a.x+=dx/d*left;a.y+=dy/d*left;m.dy=dy;left=0;}
  }
  if(m.i<m.path.length)return;
  if(m.phase==='go'){m.phase='at';if(m.kind!=='chat')m.until=simT+SPOT[m.kind].ms;}
  else a.mv=null;
}
/* While paused nothing walks, but live data still arrives: an agent caught
   away from its seat when work comes in is put straight back, so a paused
   (or reduced-motion) page never shows a working agent somewhere else. */
function settle(){
  ORDER.forEach(function(id){var a=A[id];if(a.mv&&a.state!=='idle')placeInitial(a);});
}
/* Called every tick. A finished task earns a coffee run; after that, when
   nobody else is away, one seated idle agent wanders off for something else,
   or two of them meet for a chat. */
function idleLife(dt){
  var free=[];
  ORDER.forEach(function(id){
    var a=A[id];if(!ROAM[id])return;
    if(a.mv){stepAct(a,dt);return;}
    if(a.state!=='idle'){a.want=false;return;}
    if(a.want){a.want=false;startAct(a,'coffee');return;}
    free.push(a);
  });
  if(simT<nextIdleAt)return;
  nextIdleAt=simT+6000+Math.random()*6000;
  var busy=ORDER.some(function(id){return !!A[id].mv;});
  if(busy||!free.length)return;
  var kind=IDLE_KINDS[(Math.random()*IDLE_KINDS.length)|0];
  var a=free.splice((Math.random()*free.length)|0,1)[0];
  if(kind!=='chat')startAct(a,kind);
  else if(free.length)startChat(a,free[(Math.random()*free.length)|0]);
  else startAct(a,'fridge');                /* nobody free to talk to */
}

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
  /* Coming off a task (not merely staying idle): go and get a coffee. */
  a.want=s==='idle'&&a.state!=='idle'&&!!ROAM[a.id];
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
  outboxFlag=false;nextIdleAt=simT+4000;
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
  R(g,x+1.5,y+18,9,2,SHADOW);
  P(2,7,4,5,'#a35f3a');P(1,6,6,2,'#b87245');
  P(3,0,2,7,'#2f8f4e');P(0,2,4,3,'#3fae60');P(4,1,4,3,'#3fae60');
}
function tiles(g,r,c1,c2){
  for(var ty=0;ty*8<r.h;ty++)for(var tx=0;tx*8<r.w;tx++){
    R(g,r.x+tx*8,r.y+ty*8,Math.min(8,r.w-tx*8),Math.min(8,r.h-ty*8),((tx+ty)&1)?c2:c1);
  }
}
function buildBG(){
  bgc=document.createElement('canvas');bgc.width=cv.width;bgc.height=cv.height;
  var g=bgc.getContext('2d'),rm=ROOM,x,i;
  R(g,0,0,W,H,'#252740');
  /* floor, then the rugs that mark the desk pod, the PR gate, and the meeting corner */
  tiles(g,{x:rm.x,y:rm.y+rm.wall,w:rm.w,h:rm.h-rm.wall-4},'#ebe6da','#e2dccd');
  R(g,RUG.x-1,RUG.y-1,RUG.w+2,RUG.h+2,'#bfc7e6');tiles(g,RUG,'#dde2f5','#d3d9f0');
  R(g,GATE.x-1,GATE.y-1,GATE.w+2,GATE.h+2,'#d8cf97');tiles(g,GATE,'#f7f0c6','#ede4ad');
  R(g,MEET.x-1,MEET.y-1,MEET.w+2,MEET.h+2,'#b5cdb9');tiles(g,MEET,'#e3f0e4','#d8e8da');
  /* back wall with panel seams, and the strip along the bottom edge */
  R(g,rm.x,rm.y,rm.w,rm.wall,'#3a3e66');R(g,rm.x,rm.y,rm.w,3,'#4d5282');
  for(x=rm.x+16;x<rm.x+rm.w;x+=16)R(g,x,rm.y+3,1,rm.wall-5,'#33375c');
  R(g,rm.x,rm.y+rm.wall-2,rm.w,2,'#2a2d4d');
  R(g,rm.x,rm.y+rm.h-4,rm.w,4,'#3a3e66');
  /* planning whiteboard */
  R(g,BOARD.x,BOARD.y,52,28,'#8b8fa8');R(g,BOARD.x+1,BOARD.y+1,50,26,'#f4f5f9');R(g,BOARD.x+1,BOARD.y+27,50,2,'#8b8fa8');
  /* PIV poster */
  R(g,78,11,30,19,'#f4f5f9');R(g,78,11,30,1,'#8b8fa8');R(g,78,29,30,1,'#8b8fa8');
  R(g,81,16,6,6,'#3f7de0');R(g,90,16,6,6,'#7a5af0');R(g,99,16,6,6,'#36a35b');
  R(g,87,18,3,2,'#555a6e');R(g,96,18,3,2,'#555a6e');
  /* QA poster */
  R(g,120,11,20,22,'#f4f5f9');
  for(i=0;i<4;i++){R(g,123,15+i*5,3,3,'#36a35b');R(g,128,16+i*5,9,1,'#9aa0b8');}
  /* window */
  R(g,190,13,52,25,'#8b8fa8');R(g,192,15,48,21,'#a9d6f5');R(g,192,15,48,7,'#c6e6fb');
  R(g,215,15,2,21,'#8b8fa8');R(g,192,25,48,1,'#8b8fa8');R(g,188,38,56,2,'#c2c5d6');
  /* fridge */
  R(g,262,20,18,36,'#dfe3ee');R(g,262,20,18,1,'#f4f5f9');R(g,262,34,18,1,'#aeb2ca');R(g,277,24,1,7,'#8b8fa8');R(g,277,38,1,10,'#8b8fa8');
  R(g,262,56,18,2,SHADOW);
  /* coffee counter: machine and cups */
  R(g,COUNTER.x,COUNTER.y+18,50,2,SHADOW);
  R(g,COUNTER.x,COUNTER.y,50,18,'#8b7355');R(g,COUNTER.x,COUNTER.y,50,5,'#cdbb9c');
  R(g,COUNTER.x+4,COUNTER.y-12,10,12,'#b3392e');R(g,COUNTER.x+6,COUNTER.y-9,6,3,'#2a2e48');
  R(g,COUNTER.x+22,COUNTER.y-3,3,3,'#fff');R(g,COUNTER.x+27,COUNTER.y-3,3,3,'#fff');R(g,COUNTER.x+36,COUNTER.y-5,8,5,'#6e4a2c');
  /* wall clock */
  R(g,354,15,12,12,'#8b8fa8');R(g,355,16,10,10,'#f4f5f9');R(g,360,18,1,4,'#20243a');R(g,360,21,3,1,'#20243a');
  /* bookshelf */
  R(g,SHELF.x,SHELF.y+32,44,2,SHADOW);
  R(g,SHELF.x,SHELF.y,44,32,'#6e4a2c');
  var bk=['#d9534f','#3f7de0','#36a35b','#f2c230','#7a5af0'];
  for(var sh=0;sh<3;sh++){
    R(g,SHELF.x+2,SHELF.y+2+sh*10,40,8,'#8a6038');
    for(var b=0;b<9;b++)R(g,SHELF.x+3+b*4.3,SHELF.y+3+sh*10,3,7,bk[(b+sh*2)%5]);
  }
  /* server racks; their lamps are drawn per frame in render() */
  RACKS.forEach(function(r){
    R(g,r.x,r.y,18,36,'#2a2e48');R(g,r.x+1,r.y+1,16,34,'#363b5c');
    for(i=0;i<5;i++)R(g,r.x+2,r.y+3+i*7,14,5,'#1d2036');
    R(g,r.x,r.y+36,18,2,SHADOW);
  });
  /* meeting table with stools on both sides */
  for(i=0;i<3;i++){R(g,TABLE.x+10+i*26,TABLE.y-8,10,6,'#4d5282');R(g,TABLE.x+10+i*26,TABLE.y+18,10,6,'#4d5282');}
  R(g,TABLE.x,TABLE.y+16,84,2,SHADOW);
  R(g,TABLE.x,TABLE.y,84,16,'#d3a173');R(g,TABLE.x,TABLE.y,84,1,'#e4bc92');R(g,TABLE.x,TABLE.y+14,84,2,'#8c5e3a');
  R(g,TABLE.x+34,TABLE.y+5,16,6,'#e8e9f0');R(g,TABLE.x+36,TABLE.y+7,12,1,'#9aa0b8');
  /* PR box */
  R(g,PRBOX.x,PRBOX.y+26,56,2,SHADOW);
  R(g,PRBOX.x,PRBOX.y,56,26,'#7d6a42');R(g,PRBOX.x,PRBOX.y,56,4,'#a38d5a');
  R(g,PRBOX.x+18,PRBOX.y+10,20,3,'#1d1a10');R(g,PRBOX.x+4,PRBOX.y+17,48,5,'#cdbb82');
  /* plants */
  DECOR_PLANTS.forEach(function(p){plant(g,p[0],p[1]);});
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
  R(g,cx-18,fy,36,2,SHADOW);
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
  /* Off duty (Docs): slumped over the desk, asleep. */
  var asleep=st==='offduty';
  /* Away from the seat on an idle activity: walking there or back, or standing at the spot. */
  var m=a.mv,out=away(a),walking=out&&m.phase!=='at';
  /* Back to us while facing the screen; turned to the front when idle, done, or needing attention. */
  var back=a.id==='human'?(st!=='alert'):(asleep||!!BACKFACE[st]);
  if(out)back=walking?m.dy<0:m.kind!=='chat';   /* walking up the room, or facing the counter/board/shelf/fridge */
  /* In a chat the two take turns speaking. */
  var talk=out&&!walking&&m.kind==='chat',speaking=talk&&!m.wait&&(((T/1.3)|0)%2===m.slot);
  /* Seated, except while jumping to celebrate or away from the seat. sd: how far the body is lowered. */
  var sit=st!=='celebrating'&&!out,sd=sit?2:0;
  if(st==='celebrating'&&!out)y-=Math.abs(Math.sin(T*9))*4;
  if(st==='error'&&!out)x+=(((T*14)|0)%2?1:-1);
  y=Math.round(y*K)/K;
  function P(dx,dy,w,h,c){R(g,x+dx*cs,y+dy*cs,w*cs,h*cs,c);}
  R(g,x-4*cs,gy-1*cs,8*cs,2*cs,SHADOW);
  /* chair: backrest behind the body when facing front */
  if(sit&&!back){P(-5,-11,10,9,'#3a3f5e');P(-5,-11,10,1,'#4d5282');}
  var l1=walking&&f?1:0,l2=walking&&!f?1:0;   /* walking: the legs take turns lifting */
  P(-3,-4,3,4-l1,'#2a3050');P(0,-4,3,4-l2,'#2a3050');
  P(-3,-1-l1,3,1,'#15172b');P(0,-1-l2,3,1,'#15172b');
  y+=sd*cs;
  P(-4,-10,8,6,d.color);P(-4,-5,8,1,'rgba(0,0,0,.15)');
  var sk=d.skin,sl=d.color,pose='down';
  /* Idle: sips coffee roughly every 3 seconds; the phase is shifted per agent so they are not in sync. */
  var sip=((T+a.def.name.length*.7)%3.2)<.9;
  if(walking)pose='walk';
  else if(talk)pose=speaking?'talk':'down';
  else if(out)pose=m.kind==='coffee'?'type':'reach';
  else if(m&&m.kind==='stretch'&&st==='idle')pose='stretch';
  else if(st==='celebrating')pose='up';
  else if(st==='error')pose='head';
  else if(st==='blocked'||(a.id==='human'&&st==='alert'))pose='wave';
  else if(st==='retrying')pose='scratch';
  else if(WORKING[st])pose='type';
  else if(st==='idle'&&a.id!=='human')pose='coffee';
  else if(asleep)pose='sleep';
  if(pose==='down'){P(-5,-10,1,4,sl);P(-5,-6,1,1,sk);P(4,-10,1,4,sl);P(4,-6,1,1,sk);}
  else if(pose==='type'){P(-5,-10,1,3,sl);P(4,-10,1,3,sl);P(-5,-7+f,1,1,sk);P(4,-6-f,1,1,sk);}
  else if(pose==='up'){P(-5,-13,1,4,sl);P(-5,-14,1,1,sk);P(4,-13,1,4,sl);P(4,-14,1,1,sk);}
  else if(pose==='head'){P(-5,-11,1,3,sl);P(4,-11,1,3,sl);P(-4,-14,1,2,sk);P(3,-14,1,2,sk);}
  else if(pose==='wave'){P(-5,-10,1,4,sl);P(-5,-6,1,1,sk);var wv=f?0:1;P(4,-14+wv,1,5,sl);P(4,-15+wv,1,1,sk);}
  else if(pose==='scratch'){P(-5,-10,1,4,sl);P(-5,-6,1,1,sk);P(4,-13,1,4,sl);P(3,-14,2,1,sk);P(-6,-14+(((T*4)|0)%2),1,2,'#7fd8ff');}
  else if(pose==='sleep'){P(-5,-12,1,3,sl);P(4,-12,1,3,sl);P(-5,-13,1,1,sk);P(4,-13,1,1,sk);}   /* arms folded on the desk */
  else if(pose==='walk'){
    P(-5,-10,1,4-f,sl);P(-5,-6-f,1,1,sk);
    if(m.cup){P(4,-10,1,3,sl);P(4,-7,1,1,sk);}       /* carrying the fresh cup back */
    else {P(4,-10,1,3+f,sl);P(4,-7+f,1,1,sk);}
  }
  else if(pose==='talk'){P(-5,-10,1,4,sl);P(-5,-6,1,1,sk);P(4,-10,1,2,sl);P(5,-10-f,1,2,sl);P(6,-11-f,1,1,sk);}
  else if(pose==='reach'){P(-5,-10,1,4,sl);P(-5,-6,1,1,sk);var rc=((T*2)|0)%2;P(4,-14+rc,1,5,sl);P(4,-15+rc,1,1,sk);}
  else if(pose==='stretch'){var sx=((T*2)|0)%2;P(-5-sx,-13,1,4,sl);P(-5-sx,-14,1,1,sk);P(4+sx,-13,1,4,sl);P(4+sx,-14,1,1,sk);}
  else if(pose==='coffee'){
    P(-5,-10,1,4,sl);P(-5,-6,1,1,sk);
    if(sip){P(4,-12,1,3,sl);P(3,-12,1,1,sk);}       /* arm raised, cup at the mouth */
    else {P(4,-10,1,3,sl);P(4,-7,1,1,sk);}           /* cup held in front of the chest */
  }
  var hy=asleep?-14+(((T*.8)|0)%2):-16;   /* head down, rising and falling with each breath */
  if(back){P(-3,hy,6,6,d.hair);P(-2,hy+5,4,1,sk);}
  else {
    P(-3,hy,6,6,sk);P(-3,hy,6,2,d.hair);P(-3,hy+2,1,2,d.hair);P(2,hy+2,1,2,d.hair);
    P(-2,hy+3,1,1,'#15172b');P(1,hy+3,1,1,'#15172b');
    if(st==='celebrating'||st==='error'||st==='blocked')P(-1,hy+5,2,1,'#7a2a2a');
  }
  accessory(a,P,hy,back);
  if(pose==='walk'&&m.cup&&!back){P(4,-8,2,2,'#fff');P(6,-8,1,1,'#fff');}
  if(speaking){P(-5,-25,10,7,'#15172b');P(-4,-24,8,5,'#fff');P(-1,-18,2,1,'#15172b');
    for(var dt3=0;dt3<3;dt3++)if(((T*3)|0)%4>dt3)P(-3+dt3*2,-22,1,1,'#15172b');}
  if(pose==='coffee'){
    if(sip){P(1,-12,2,2,'#fff');P(1,-12,2,1,'#e8e9f0');}
    else {P(4,-8,2,2,'#fff');P(6,-8,1,1,'#fff');if(((T*2)|0)%2)P(5,-11,1,1,'rgba(255,255,255,.8)');}
  }
  /* chair: backrest covers the back when turned away from us */
  if(sit&&back){P(-3,-9,6,6,'#3a3f5e');P(-3,-9,6,1,'#4d5282');}
  if(st==='error'){var ff=((T*10)|0)%2;P(-1,hy-3+ff,2,2,'#ff9d2e');P(0,hy-5+ff,1,2,'#ffd24a');}
  g.globalAlpha=1;
}
function render(){
  var T=simT/1000,g=ctx;
  if(!bgc)buildBG();
  g.setTransform(1,0,0,1,0,0);g.imageSmoothingEnabled=false;g.drawImage(bgc,0,0);
  var nb=Math.floor(A.planner.board);
  for(var i=0;i<nb&&i<7;i++)R(g,BOARD.x+4,BOARD.y+4+i*3,10+((i*9)%30),1,i%2?'#d9534f':'#3f7de0');
  var busy=A.backend.state==='implementing'||A.backend.state==='verifying'||A.frontend.state==='implementing'||A.frontend.state==='verifying';
  var rate=busy?7:1.5;
  RACKS.forEach(function(r,ri){
    for(var u=0;u<5;u++)for(var j=0;j<3;j++){
      var on=(((T*rate)|0)+u*3+j*2+ri*5)%4<2;
      R(g,r.x+4+j*4,r.y+5+u*7,2,1,on?(j===1?'#ffcf4a':'#4ade80'):'#2c3250');
    }
  });
  for(var k=0;k<3;k++){var ph=((T*.8+k*.33)%1);R(g,COUNTER.x+9+Math.round(Math.sin(ph*6+k)*2),COUNTER.y-14-Math.round(ph*12),1,1,'rgba(255,255,255,.75)');}
  if(outboxFlag){R(g,PRBOX.x+59,PRBOX.y,1,22,'#2b2b2b');R(g,PRBOX.x+60,PRBOX.y,8,5,'#e5493a');}
  ORDER.forEach(function(id){drawDesk(id,T);});
  /* the chair left behind by whoever is away from their seat */
  ORDER.forEach(function(id){
    if(!away(A[id]))return;
    var s=ST[id];R(g,s.cx-4.5,s.fy-10.5,9,9,'#3a3f5e');R(g,s.cx-4.5,s.fy-10.5,9,1.5,'#4d5282');
  });
  var sa=A[selected];R(g,sa.x-9,sa.y+1.5,18,1,'#5b4bdb');R(g,sa.x-7,sa.y+3,14,1,'#5b4bdb');
  ORDER.map(function(id){return A[id];}).sort(function(p,q){return p.y-q.y;}).forEach(function(a){drawChar(a,T);});
  bugs=bugs.filter(function(b){return simT<b.until;});
  bugs.forEach(function(){
    /* crawls on the floor beside QA's desk */
    var bx=ST.qa.cx-16+Math.abs(((T*16)%64)-32),by=ST.qa.fy+12+(((T*10)|0)%2);
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
  LABELS.forEach(function(z){
    var l=document.createElement('div');l.className='rl';l.textContent=z[0];
    l.style.left=(z[1]/W*100)+'%';l.style.top=(z[2]/H*100)+'%';ov.appendChild(l);
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
function stLabel(a){
  if(a.id==='human'&&a.state==='idle')return 'Waiting for PR';
  if(a.state==='idle'&&a.mv)return a.mv.phase==='back'&&a.mv.kind!=='coffee'?'Heading back':ACT_LABEL[a.mv.kind];
  return STATE_LABEL[a.state]||a.state;
}
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
  idleLife(dt);
  var due=timers.filter(function(t){return t.at<=simT;});
  if(due.length){timers=timers.filter(function(t){return t.at>simT;});due.forEach(function(t){t.ok();});}
}
var last=performance.now(),lastPanel=0;
function frame(now){
  var dt=Math.min(.1,(now-last)/1000);last=now;
  if(!paused)advance(dt*speed); else settle();
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
