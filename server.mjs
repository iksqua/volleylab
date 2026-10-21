/** VOLLEYLAB — multiplayer prototype server, Node.js 22+, no dependencies.
 * Four human players per private room. Authoritative positions, ball and score.
 * Single instance / in-memory rooms; no ranked progression or persistence yet.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT=Number(process.env.PORT||3000),ROOT=path.resolve(import.meta.dirname);
const ROOM_CAP=4, GRAVITY=14, BALL_R=.36, NET=2.45, COURT_X=6.35, COURT_Z=9.8;
const BEACH_X=13,BEACH_Z=12.12, NET_GAP=.85, SPEED=8.5, JUMP=.27;
const ALLOWED=new Set(['/','/index.html','/style.css','/audio.js','/game.js']);
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8'};
const rooms=new Map(), clients=new Set();
const cl=(n,a,b)=>Math.max(a,Math.min(b,n));
const rnd=(a,b)=>a+Math.random()*(b-a);
const cleanName=(v)=>String(v||'').normalize('NFKC').replace(/[^\p{L}\p{N} _.-]/gu,'').trim().slice(0,17)||'Joueur';
const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(){let c;do{const b=crypto.randomBytes(6);c=[...b].map(n=>CODE_CHARS[n%CODE_CHARS.length]).join('');}while(rooms.has(c));return c;}
function send(c,data){if(!c||c.closed)return;let dataBuffer=Buffer.from(JSON.stringify(data));let n=dataBuffer.length,head=n<126?Buffer.alloc(2):n<=65535?Buffer.alloc(4):Buffer.alloc(10);head[0]=0x81;if(n<126)head[1]=n;else if(n<=65535){head[1]=126;head.writeUInt16BE(n,2);}else{head[1]=127;head.writeBigUInt64BE(BigInt(n),2);}try{c.socket.write(Buffer.concat([head,dataBuffer]));}catch{endClient(c);}}
function rawFrame(c,opcode,data=Buffer.alloc(0)){if(c.closed)return;try{c.socket.write(Buffer.from([0x80|opcode,data.length]));if(data.length)c.socket.write(data);}catch{endClient(c);}}
function broadcast(room,obj){for(const c of room.clients)send(c,obj);}
function participants(room){return room.slots.map((c,slot)=>c?{slot,team:slot<2?'blue':'red',name:c.name}:null).filter(Boolean);}
function lobby(room,notice=''){broadcast(room,{type:'lobby',code:room.code,players:participants(room),active:room.active,notice});}
function newRoom(){const room={code:newCode(),slots:[null,null,null,null],clients:new Set(),active:false,game:null,idle:Date.now()};rooms.set(room.code,room);return room;}
function newPlayer(slot,name){let index=slot%2,blue=slot<2;return {slot,id:slot,team:blue?'blue':'red',name,x:index===0?-2.6:2.6,z:(blue?-1:1)*(index===0?5.6:5.1),jump:0,vy:0,vx:0,vz:0,inAir:false,jumpBoost:false,jumpPrep:0,crouch:false,crouchPose:0,dive:0,diveVX:0,diveVZ:blue?1:-1,diveCooldown:0,cool:0,move:0,hitAge:8,lastHitStyle:'normal',input:{left:false,right:false,forward:false,back:false,crouch:false},aim:{x:0,z:blue?5:-5},queued:null};}
function resetPositions(g,servingSlot){for(const p of g.players){const blue=p.team==='blue',index=p.slot%2;p.x=index===0?-2.6:2.6;p.z=(blue?-1:1)*(index===0?5.6:5.1);p.vx=p.vz=p.vy=p.jump=0;p.inAir=false;p.jumpPrep=0;p.jumpBoost=false;p.dive=0;p.cool=0;p.diveCooldown=0;p.queued=null;p.crouch=false;p.crouchPose=0;p.move=0;}
 const server=g.players[servingSlot];server.x=-1.65;server.z=server.team==='blue'?-10.65:10.65;
}
function beginServe(g,side){g.mode='serve';g.serveStage='ready';g.server=side;g.serveElapsed=0;g.serveClock=12;g.touchTeam=null;g.touchCount=0;g.ballLive=false;g.serveSlot=side==='blue'?0:2;resetPositions(g,g.serveSlot);setHeld(g);}
function setHeld(g){const p=g.players[g.serveSlot],sign=p.team==='blue'?1:-1;Object.assign(g.ball,{x:p.x+.64,y:2.02,z:p.z+sign*.12,vx:0,vy:0,vz:0});}
function startRoom(room){room.active=true;room.game={mode:'serve',players:room.slots.map((c,i)=>newPlayer(i,c.name)),ball:{x:0,y:2,z:0,vx:0,vy:0,vz:0,spin:0},blue:0,red:0,server:'blue',serveSlot:0,serveStage:'ready',serveClock:12,serveElapsed:0,touchTeam:null,touchCount:0,ballLive:false,timer:0,lastEvent:'',tick:0};beginServe(room.game,'blue');lobby(room,'La partie commence !');broadcast(room,{type:'start',code:room.code});}
function endClient(c){if(c.closed)return;c.closed=true;clients.delete(c);try{c.socket.destroy();}catch{}
 const room=c.room;if(!room)return;room.clients.delete(c);if(room.slots[c.slot]===c)room.slots[c.slot]=null;c.room=null;room.idle=Date.now();if(room.active){room.active=false;room.game=null;}if(!room.clients.size)rooms.delete(room.code);else lobby(room,'Un joueur est parti : la partie revient au salon.');}
function joinRoom(c,room){if(c.room)return send(c,{type:'error',message:'Déjà dans un salon'});let slot=room.slots.findIndex(x=>!x);if(slot<0)return send(c,{type:'error',message:'Salon complet'});room.slots[slot]=c;room.clients.add(c);room.idle=Date.now();c.room=room;c.slot=slot;send(c,{type:'joined',code:room.code,slot,team:slot<2?'blue':'red'});lobby(room,`${c.name} a rejoint le salon`);if(room.slots.every(Boolean)&&!room.active)startRoom(room);}
function announce(room,name,data={}){broadcast(room,{type:'event',name,...data});}
function point(room,team,reason=''){const g=room.game;if(!g||g.mode==='point'||g.mode==='ended')return;g.mode='point';g.ballLive=false;g.timer=1.65;g[team]++;g.server=team;g.reason=reason;announce(room,'point',{team,reason,blue:g.blue,red:g.red});}
function faultService(room){const g=room.game;point(room,g.server==='blue'?'red':'blue','FAUTE DE SERVICE');}
function launch(g,x,z,kind,power,isServe=false){const b=g.ball,d=Math.hypot(x-b.x,z-b.z),flight=Math.max(kind==='lob'||kind==='passLob'?1.62+.55*(1-power):kind==='smash'?.53+.24*(1-power):kind==='smashLob'?1.1+.24*(1-power):kind==='pass'?.95+.24*(1-power):1.06+.4*(1-power),d/21);const landing=(kind==='pass'||kind==='passLob')?1.35:.42;b.vx=(x-b.x)/flight;b.vz=(z-b.z)/flight;b.vy=(landing-b.y+.5*GRAVITY*flight*flight)/flight;b.spin+=(power+.4)*4;g.ballLive=true;}
function toss(room,p){const g=room.game;if(g.mode!=='serve'||g.serveStage!=='ready'||g.serveSlot!==p.slot)return;g.serveStage='toss';g.serveElapsed=0;Object.assign(g.ball,{x:p.x+.64,y:2.22,z:p.z+(p.team==='blue'?.15:-.15),vx:0,vy:7.4,vz:0});announce(room,'toss',{slot:p.slot});}
function shot(room,p,kind,power,tx,tz){const g=room.game,b=g.ball;
 if(g.mode==='serve'){if(g.serveSlot!==p.slot||g.serveStage!=='toss'||(kind!=='normal'&&kind!=='lob'))return;if(b.y<1.5||b.y>5.2)return;const z=cl(tz,p.team==='blue'?NET_GAP:-BEACH_Z,p.team==='blue'?BEACH_Z:-NET_GAP),effective=cl(power,.2,1),depth=p.team==='blue'?lerp(1.15,z,.33+.67*effective):lerp(-1.15,z,.33+.67*effective);launch(g,cl(tx,-BEACH_X,BEACH_X),depth,kind,kind==='lob'?.66:effective,true);g.mode='live';g.touchTeam=p.team;g.touchCount=1;p.hitAge=0;p.cool=.3;p.lastHitStyle=kind;announce(room,'serve',{slot:p.slot,kind,power:effective});return;}
 if(g.mode!=='live'||p.cool>0)return;
 const d=Math.hypot(p.x-b.x,p.z-b.z),vertical=Math.abs(b.y-(p.jump+1.65)),smash=kind==='smash'||kind==='smashLob',isPass=kind==='pass'||kind==='passLob';
 if(smash&&(!p.jumpBoost||!p.inAir||p.jump<.20||b.y<2.1))return;
 if(d>2.8+(p.dive>0?1.2:0)||vertical>2.15){p.queued={kind,power,tx,tz,expires:.22};return;}
 if(g.touchTeam===p.team){if(g.touchCount>=3){point(room,p.team==='blue'?'red':'blue','4 TOUCHES');return;}g.touchCount++;}else{g.touchTeam=p.team;g.touchCount=1;}
 let targetX=cl(tx,-BEACH_X,BEACH_X),targetZ=cl(tz,p.team==='blue'?NET_GAP:-BEACH_Z,p.team==='blue'?BEACH_Z:-NET_GAP);
 if(isPass){const mate=g.players.find(x=>x.slot!==p.slot&&x.team===p.team);if(!mate)return;targetX=mate.x;targetZ=mate.z+(p.team==='blue'?1.2:-1.2);}
 const jit=cl(vertical/3.2+.12*d/2.8,0,.65)*1.2;targetX+=rnd(-jit,jit);targetZ+=rnd(-jit,jit);
 launch(g,targetX,targetZ,kind,isPass?(kind==='passLob'?.63:.75):cl(power*.72+.2,.25,1));p.hitAge=0;p.lastHitStyle=kind;p.cool=smash?.57:.4;p.queued=null;announce(room,'hit',{slot:p.slot,kind,power});
}
const lerp=(a,b,t)=>a+(b-a)*t;
function collide(g){const pp=g.players,r=1.24;for(let i=0;i<pp.length;i++)for(let j=i+1;j<pp.length;j++){const a=pp[i],b=pp[j];if(Math.abs(a.jump-b.jump)>1.35)continue;let dx=b.x-a.x,dz=b.z-a.z,d=Math.hypot(dx,dz);if(d>=r)continue;if(d<.0001){dx=(i+j)%2?.01:-.01;dz=.01;d=Math.hypot(dx,dz);}let push=(r-d)/2,nx=dx/d,nz=dz/d;a.x-=nx*push;a.z-=nz*push;b.x+=nx*push;b.z+=nz*push;bounds(a);bounds(b);}}
function bounds(p){p.x=cl(p.x,-BEACH_X,BEACH_X);const blue=p.team==='blue';p.z=cl(p.z,blue?-BEACH_Z:NET_GAP,blue?-NET_GAP:BEACH_Z);}
function simulation(room,dt){const g=room.game;if(!g)return;g.tick++;if(g.mode==='point'){g.timer-=dt;if(g.timer<=0){if(g.blue>=7||g.red>=7){g.mode='ended';g.timer=6;announce(room,'end',{blue:g.blue,red:g.red});}else beginServe(g,g.server);}return;}
 if(g.mode==='ended'){g.timer-=dt;if(g.timer<=0){g.blue=0;g.red=0;beginServe(g,'blue');}return;}
 for(const p of g.players){p.cool=Math.max(0,p.cool-dt);p.diveCooldown=Math.max(0,p.diveCooldown-dt);p.dive=Math.max(0,p.dive-dt);p.hitAge+=dt;
  if(p.dive>0){p.x+=p.diveVX*12*dt;p.z+=p.diveVZ*12*dt;p.move=12;bounds(p);}else if(p.inAir){p.x+=p.vx*dt;p.z+=p.vz*dt;bounds(p);}else{const i=p.input,s=p.team==='blue'?1:-1;let dx=(Number(i.left)-Number(i.right))*s,dz=(Number(i.forward)-Number(i.back))*s,mag=Math.hypot(dx,dz),max=SPEED*(i.crouch?.46:p.jumpBoost&&p.jumpPrep>0?.55:1);p.crouch=!!i.crouch;const tx=mag?dx/mag*max:0,tz=mag?dz/mag*max:0,accel=(mag?30:35)*dt;p.vx+=cl(tx-p.vx,-accel,accel);p.vz+=cl(tz-p.vz,-accel,accel);p.move=Math.hypot(p.vx,p.vz);p.x+=p.vx*dt;p.z+=p.vz*dt;bounds(p);if(p.jumpPrep>0){p.jumpPrep=Math.max(0,p.jumpPrep-dt);if(!p.jumpPrep){p.inAir=true;p.vy=p.jumpBoost?11.35:9.1;announce(room,'jump',{slot:p.slot,charged:p.jumpBoost});}}}
  p.crouchPose+=cl((p.crouch?0.82:p.jumpPrep>0?p.jumpBoost?1:.55:0)-p.crouchPose,-dt*12,dt*12);
  if(p.inAir){p.jump+=p.vy*dt;p.vy-=21*dt;if(p.jump<=0){p.jump=0;p.vy=0;p.inAir=false;p.jumpBoost=false;}}
 }
 collide(g);
 for(const p of g.players){if(p.queued){p.queued.expires-=dt;if(p.queued.expires<=0)p.queued=null;else if(Math.hypot(p.x-g.ball.x,p.z-g.ball.z)<2.8&&Math.abs(g.ball.y-(p.jump+1.65))<2.15){const q=p.queued;p.queued=null;shot(room,p,q.kind,q.power,q.tx,q.tz);}}}
 if(g.mode==='serve'){
  if(g.serveStage==='ready'){setHeld(g);g.serveClock-=dt;if(g.serveClock<=0)faultService(room);return;}
  if(g.serveStage==='toss'){g.serveElapsed+=dt;g.ball.vy-=GRAVITY*.66*dt;g.ball.y+=g.ball.vy*dt;if(g.ball.y<=BALL_R||g.serveElapsed>1.9)faultService(room);return;}
 }
 if(g.mode!=='live')return;
 const b=g.ball,prevz=b.z;b.vy-=GRAVITY*dt;b.x+=b.vx*dt;b.y+=b.vy*dt;b.z+=b.vz*dt;b.spin+=dt*8;
 if(prevz*b.z<=0&&Math.abs(b.x)<COURT_X+.2&&b.y-BALL_R<NET){b.z=Math.sign(prevz||-1)*BALL_R*.7;b.vz*=-.22;b.vy=Math.max(.6,b.vy*.45);announce(room,'net',{x:b.x});}
 if(b.y<=BALL_R){b.y=BALL_R;const inside=Math.abs(b.x)<=COURT_X&&Math.abs(b.z)<=COURT_Z;const winner=inside?(b.z<0?'red':'blue'):(g.touchTeam==='blue'?'red':'blue');point(room,winner,inside?'':'DEHORS');return;}
 if(Math.abs(b.x)>23||Math.abs(b.z)>31)point(room,g.touchTeam==='blue'?'red':'blue','DEHORS');
}
function snapshot(room){const g=room.game;if(!g)return;broadcast(room,{type:'state',code:room.code,mode:g.mode,server:g.server,serveSlot:g.serveSlot,serveStage:g.serveStage,serveClock:Math.max(0,g.serveClock),score:[g.blue,g.red],touchCount:g.touchCount,ballLive:g.ballLive,ball:g.ball,players:g.players.map(p=>({slot:p.slot,team:p.team,name:p.name,x:p.x,z:p.z,vx:p.vx,vz:p.vz,jump:p.jump,vy:p.vy,inAir:p.inAir,jumpBoost:p.jumpBoost,jumpPrep:p.jumpPrep,crouch:p.crouch,crouchPose:p.crouchPose,dive:p.dive,diveVX:p.diveVX,diveVZ:p.diveVZ,diveCooldown:p.diveCooldown,move:p.move,hitAge:p.hitAge,lastHitStyle:p.lastHitStyle})),tick:g.tick});}
function onMessage(c,data){if(!data||typeof data!=='object'||Array.isArray(data))return;const type=String(data.type||'');
 if(type==='ping'){if(Number.isFinite(data.sent)&&data.sent>=0&&data.sent<1e15)send(c,{type:'pong',sent:data.sent});return;}
 if(type==='create'){if(c.room)return;c.name=cleanName(data.name);return joinRoom(c,newRoom());}
 if(type==='join'){if(c.room)return;c.name=cleanName(data.name);const room=rooms.get(String(data.code||'').toUpperCase());if(!room)return send(c,{type:'error',message:'Salon introuvable (ou expiré).'});return joinRoom(c,room);}
 if(type==='leave')return endClient(c);
 const room=c.room;if(!room||!room.active||!room.game)return;const g=room.game,p=g.players[c.slot];if(!p)return;
 if(type==='input'){const i=data.input;if(!i||typeof i!=='object')return;for(const k of ['left','right','forward','back','crouch'])p.input[k]=i[k]===true;if(data.aim&&Number.isFinite(data.aim.x)&&Number.isFinite(data.aim.z)){p.aim.x=cl(data.aim.x,-BEACH_X,BEACH_X);p.aim.z=cl(data.aim.z,-BEACH_Z,BEACH_Z);}return;}
 if(type==='jump'){if(g.mode==='serve'&&g.serveSlot===p.slot)return toss(room,p);if(g.mode!=='live'||p.inAir||p.dive>0||p.diveCooldown>1.05)return;if(p.jumpPrep>0){p.jumpBoost=true;p.jumpPrep=.30;}else{p.jumpPrep=JUMP;p.jumpBoost=false;}return;}
 if(type==='dive'){if(g.mode!=='live'||p.inAir||p.dive>0||p.diveCooldown>0)return;let i=p.input,sign=p.team==='blue'?1:-1,dx=(Number(i.left)-Number(i.right))*sign,dz=(Number(i.forward)-Number(i.back))*sign;let d=Math.hypot(dx,dz);if(d<.1){dx=g.ball.x-p.x;dz=g.ball.z-p.z;d=Math.hypot(dx,dz)||1;}p.diveVX=dx/d;p.diveVZ=dz/d;p.dive=.7;p.diveCooldown=1.3;p.inAir=false;p.jump=0;p.vx=p.vz=0;announce(room,'dive',{slot:p.slot});return;}
 if(type==='hit'){const kind=String(data.kind||'');if(!['normal','lob','pass','passLob','smash','smashLob'].includes(kind))return;const power=Number(data.power);if(!Number.isFinite(power)||power<0||power>1)return;const tx=Number(data.aim?.x),tz=Number(data.aim?.z);if(!Number.isFinite(tx)||!Number.isFinite(tz))return;shot(room,p,kind,power,cl(tx,-BEACH_X,BEACH_X),cl(tz,-BEACH_Z,BEACH_Z));}
}
function parseFrames(c,data){c.buffer=Buffer.concat([c.buffer,data]);if(c.buffer.length>32768)return endClient(c);let steps=0;while(c.buffer.length>=2&&steps++<30){let b=c.buffer,opcode=b[0]&15,fin=!!(b[0]&128),masked=!!(b[1]&128),len=b[1]&127,off=2;if(!fin||!masked)return endClient(c);if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4;}else if(len===127){if(b.length<10)return;const n=b.readBigUInt64BE(2);if(n>8192n)return endClient(c);len=Number(n);off=10;}if(len>8192)return endClient(c);if(b.length<off+4+len)return;const mask=b.subarray(off,off+4),payload=Buffer.from(b.subarray(off+4,off+4+len));for(let i=0;i<len;i++)payload[i]^=mask[i%4];c.buffer=b.subarray(off+4+len);if(opcode===8){endClient(c);return;}if(opcode===9){rawFrame(c,10,payload.subarray(0,125));continue;}if(opcode===10)continue;if(opcode!==1)return endClient(c);let obj;try{obj=JSON.parse(payload.toString('utf8'));}catch{return endClient(c);}const now=Date.now();if(now-c.rateAt>1000){c.rateAt=now;c.rate=0;}if(++c.rate>45)return endClient(c);onMessage(c,obj);}}
const server=http.createServer((req,res)=>{const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`),pathname=url.pathname;if(pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,rooms:rooms.size,clients:clients.size}));}if(!ALLOWED.has(pathname)){res.writeHead(404);return res.end('Not found');}const file=pathname==='/'?'index.html':pathname.slice(1);fs.readFile(path.join(ROOT,file),(err,bytes)=>{if(err){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(bytes);});});
server.on('upgrade',(req,socket,head)=>{const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);if(url.pathname!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||req.headers['sec-websocket-version']!=='13'||!req.headers['sec-websocket-key'])return socket.destroy();const origin=req.headers.origin;if(origin){try{const o=new URL(origin);if(o.host!==req.headers.host&&!(o.hostname==='localhost'&&String(req.headers.host).startsWith('localhost:')))return socket.destroy();}catch{return socket.destroy();}}
const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');const c={socket,buffer:Buffer.alloc(0),closed:false,room:null,slot:-1,name:'Joueur',rate:0,rateAt:Date.now()};clients.add(c);socket.on('data',b=>parseFrames(c,b));socket.on('error',()=>endClient(c));socket.on('close',()=>endClient(c));if(head.length)parseFrames(c,head);send(c,{type:'hello',version:'0.17',message:'VOLLEYLAB Multiplayer'});});
let previous=process.hrtime.bigint(),acc=0,snapAcc=0;
setInterval(()=>{const now=process.hrtime.bigint(),dt=Math.min(.15,Number(now-previous)/1e9);previous=now;acc+=dt;snapAcc+=dt;let loops=0;while(acc>=1/60&&loops++<8){for(const r of rooms.values())if(r.active)simulation(r,1/60);acc-=1/60;}if(snapAcc>=1/30){for(const r of rooms.values())if(r.active)snapshot(r);snapAcc-=1/30;if(snapAcc>1/10)snapAcc=0;}for(const r of rooms.values())if(!r.clients.size&&Date.now()-r.idle>60000)rooms.delete(r.code);},16).unref();
// Heartbeat keepalive : les amis peuvent attendre dans un salon sans que le proxy ferme un WebSocket inactif.
setInterval(()=>{for(const c of clients)rawFrame(c,9);},20000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`VOLLEYLAB multiplayer :${PORT}`));
