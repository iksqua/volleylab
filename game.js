/* VOLLEYLAB — prototype WebGL avec salons privés synchronisés.
   V0.17 : prediction locale, interpolation réseau, qualité adaptative. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const canvas=$('scene');
const gpu=canvas.getContext('webgl',{alpha:true,antialias:true,depth:true,powerPreference:'high-performance'});
// Si la carte graphique bloque WebGL, le même monde 3D reste jouable via Canvas 2D.
const software=!gpu;
const ctx=software?canvas.getContext('2d'):null;
if(software&&!ctx){$('fallback').classList.remove('hidden');return;}
const noop=()=>{};
const gl=gpu||new Proxy({}, {get:(_,key)=>['createBuffer','createShader','createProgram','getUniformLocation'].includes(key)?(()=>({})):['getShaderParameter','getProgramParameter'].includes(key)?(()=>true):key==='getAttribLocation'?(()=>0):typeof key==='string'?noop:undefined});
let softQueue=[];

// ---------- Mathématiques 3D ----------
const PI=Math.PI, TAU=PI*2;
const clamp=(a,lo,hi)=>Math.min(hi,Math.max(lo,a));
const lerp=(a,b,t)=>a+(b-a)*t;
const v=(x=0,y=0,z=0)=>[x,y,z];
const add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const mul=(a,k)=>[a[0]*k,a[1]*k,a[2]*k];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>{let l=Math.hypot(...a);return l>1e-5?mul(a,1/l):v(0,1,0)};
const dist2=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);
function matMul(a,b){let o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)o[c*4+r]+=a[k*4+r]*b[c*4+k];return o;}
function perspective(fovy,aspect,near,far){let f=1/Math.tan(fovy/2),o=new Float32Array(16);o[0]=f/aspect;o[5]=f;o[10]=(far+near)/(near-far);o[11]=-1;o[14]=2*far*near/(near-far);return o;}
function lookAt(eye,target){let z=norm(sub(eye,target)),x=norm(cross(v(0,1,0),z)),y=cross(z,x);return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);}
function model(pos,scale,yaw=0){let c=Math.cos(yaw),s=Math.sin(yaw);return new Float32Array([c*scale[0],0,-s*scale[0],0,0,scale[1],0,0,s*scale[2],0,c*scale[2],0,pos[0],pos[1],pos[2],1]);}
function cylinderModel(a,b,radius){let d=sub(b,a),len=Math.hypot(...d);if(len<.001)return model(a,[.01,.01,.01]);let y=mul(d,1/len);let support=Math.abs(y[2])>.93?v(0,1,0):v(0,0,1);let x=norm(cross(y,support)),z=norm(cross(x,y));let rr=radius*2;let m=mul(add(a,b),.5);return new Float32Array([x[0]*rr,x[1]*rr,x[2]*rr,0,y[0]*len,y[1]*len,y[2]*len,0,z[0]*rr,z[1]*rr,z[2]*rr,0,m[0],m[1],m[2],1]);}

// ---------- Mini renderer WebGL ----------
const vs=`attribute vec3 position;attribute vec3 normal;uniform mat4 uVP,uModel;varying vec3 vNormal,vLocal;void main(){vec4 world=uModel*vec4(position,1.);vNormal=mat3(uModel)*normal;vLocal=position;gl_Position=uVP*world;}`;
const fs=`precision mediump float;varying vec3 vNormal,vLocal;uniform vec4 uColor;uniform vec3 uLight;uniform float uBall,uFlat;void main(){vec3 n=normalize(vNormal);float light=mix(.64+max(dot(n,normalize(uLight)),0.)*.36,1.,uFlat);vec3 base=uColor.rgb;if(uBall>.5){float a=atan(vLocal.z,vLocal.x);float line=abs(sin(a*2.3+vLocal.y*4.));float stripes=smoothstep(.32,.69,line);base=mix(vec3(.96,.97,1.),vec3(.11,.33,.87),stripes*.93);if(abs(vLocal.y)>.34)base=mix(base,vec3(1.,.79,.19),.8);}gl_FragColor=vec4(base*light,uColor.a);}`;
function shader(type,src){let s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
let program;
try{program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vs));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));}catch(e){console.error(e);$('fallback').classList.remove('hidden');return;}
gl.useProgram(program);
const loc={position:gl.getAttribLocation(program,'position'),normal:gl.getAttribLocation(program,'normal'),vp:gl.getUniformLocation(program,'uVP'),model:gl.getUniformLocation(program,'uModel'),color:gl.getUniformLocation(program,'uColor'),light:gl.getUniformLocation(program,'uLight'),ball:gl.getUniformLocation(program,'uBall'),flat:gl.getUniformLocation(program,'uFlat')};
gl.uniform3f(loc.light,.48,1,.8);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
function mesh(vertices,normals,indices){const vb=gl.createBuffer(),ib=gl.createBuffer(),interleaved=[];for(let i=0;i<vertices.length;i+=3)interleaved.push(vertices[i],vertices[i+1],vertices[i+2],normals[i],normals[i+1],normals[i+2]);gl.bindBuffer(gl.ARRAY_BUFFER,vb);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(interleaved),gl.STATIC_DRAW);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);return{vb,ib,count:indices.length,sourceVertices:vertices,sourceNormals:normals,sourceIndices:indices};}
function buildBox(){let q=[
{p:[[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]],n:[0,0,1]},
{p:[[.5,-.5,-.5],[-.5,-.5,-.5],[-.5,.5,-.5],[.5,.5,-.5]],n:[0,0,-1]},
{p:[[-.5,-.5,-.5],[-.5,-.5,.5],[-.5,.5,.5],[-.5,.5,-.5]],n:[-1,0,0]},
{p:[[.5,-.5,.5],[.5,-.5,-.5],[.5,.5,-.5],[.5,.5,.5]],n:[1,0,0]},
{p:[[-.5,.5,.5],[.5,.5,.5],[.5,.5,-.5],[-.5,.5,-.5]],n:[0,1,0]},
{p:[[-.5,-.5,-.5],[.5,-.5,-.5],[.5,-.5,.5],[-.5,-.5,.5]],n:[0,-1,0]}];let V=[],N=[],I=[];for(let f of q){let k=V.length/3;for(let pt of f.p){V.push(...pt);N.push(...f.n);}I.push(k,k+1,k+2,k,k+2,k+3)}return mesh(V,N,I);}
function buildSphere(steps=16,tiers=12){let V=[],N=[],I=[];for(let j=0;j<=tiers;j++){let t=j/tiers*PI;for(let i=0;i<=steps;i++){let a=i/steps*TAU,x=Math.sin(t)*Math.cos(a)*.5,y=Math.cos(t)*.5,z=Math.sin(t)*Math.sin(a)*.5;V.push(x,y,z);N.push(x*2,y*2,z*2);}}for(let j=0;j<tiers;j++)for(let i=0;i<steps;i++){let a=j*(steps+1)+i,b=a+steps+1;I.push(a,b,a+1,b,b+1,a+1)}return mesh(V,N,I);}
function buildCylinder(segments=14){let V=[],N=[],I=[];for(let i=0;i<=segments;i++){let a=i/segments*TAU,x=Math.cos(a)*.5,z=Math.sin(a)*.5;for(let y of [-.5,.5]){V.push(x,y,z);N.push(Math.cos(a),0,Math.sin(a));}}for(let i=0;i<segments;i++){let a=i*2;I.push(a,a+2,a+1,a+1,a+2,a+3);}for(let side of [-1,1]){let c=V.length/3;V.push(0,side*.5,0);N.push(0,side,0);for(let i=0;i<=segments;i++){let a=i/segments*TAU;V.push(Math.cos(a)*.5,side*.5,Math.sin(a)*.5);N.push(0,side,0);}for(let i=0;i<segments;i++)I.push(c,c+1+i,c+2+i);}return mesh(V,N,I);}
const BOX=buildBox(),SPHERE=buildSphere(),CYL=buildCylinder();BOX.kind='box';SPHERE.kind='sphere';CYL.kind='cylinder';
const colorCache={};function rgba(s,alpha=1){if(s.startsWith('#')){let id=s+':'+alpha;if(colorCache[id])return colorCache[id];let hex=s.slice(1);if(hex.length===3)hex=hex.split('').map(c=>c+c).join('');return colorCache[id]=[parseInt(hex.slice(0,2),16)/255,parseInt(hex.slice(2,4),16)/255,parseInt(hex.slice(4,6),16)/255,alpha];}return s;}
let graphicsQuality='auto',autoGraphicsScale=1,measuredFps=60,slowFrames=0,fastFrames=0,qualityAge=0;
try{graphicsQuality=localStorage.getItem('volleylab:quality')||'auto';}catch{}
if(!['auto','eco','high'].includes(graphicsQuality))graphicsQuality='auto';
let VP,screenW=0,screenH=0,camera={eye:v(16,17,-26),target:v(0,1,0),right:v(1,0,0),up:v(0,1,0),forward:v(0,0,1),fov:48*PI/180};
// Software 3D : projection perspective des véritables objets du monde (sans WebGL).
function transformPoint(m,x,y,z){return v(m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]);}
function shadeColor(color,shade){let m=rgba(color);return 'rgb('+m.slice(0,3).map(x=>Math.round(clamp(x*shade,0,1)*255)).join(',')+')';}
function softDraw(mesh_,m,color,opts={}){
 const alpha=opts.alpha===undefined?1:opts.alpha;
 if(mesh_.kind==='box'){
  const local=[[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]];
  const faces=[[4,5,6,7],[1,0,3,2],[0,4,7,3],[5,1,2,6],[7,6,2,3],[0,1,5,4]];
  const shades=[.95,.67,.74,.84,1,.68],pr=local.map(p=>screenProject(transformPoint(m,...p)));
  for(let f=0;f<faces.length;f++){const pts=faces[f].map(i=>pr[i]);if(pts.some(q=>!q))continue;const depth=pts.reduce((acc,q)=>acc+q.w,0)/4;softQueue.push({depth,draw:()=>{ctx.globalAlpha=alpha;ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<4;i++)ctx.lineTo(pts[i].x,pts[i].y);ctx.closePath();ctx.fillStyle=shadeColor(color,opts.flat?1:shades[f]);ctx.fill();ctx.globalAlpha=1;}});}
 }else if(mesh_.kind==='cylinder'){
  const p=screenProject(transformPoint(m,0,-.5,0)),q=screenProject(transformPoint(m,0,.5,0)),mid=screenProject(transformPoint(m,0,0,0)),rpt=screenProject(transformPoint(m,.5,0,0));if(!p||!q||!mid||!rpt)return;
  let radius=clamp(Math.hypot(rpt.x-mid.x,rpt.y-mid.y),.65,52);softQueue.push({depth:(p.w+q.w)/2,draw:()=>{ctx.globalAlpha=alpha;ctx.strokeStyle=shadeColor(color,1);ctx.lineWidth=radius*2;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();ctx.globalAlpha=1;}});
 }else{
  const c=screenProject(transformPoint(m,0,0,0));if(!c)return;
  const dirs=[[.5,0,0],[0,.5,0],[0,0,.5]],ss=dirs.map(d=>screenProject(transformPoint(m,...d))||c);let rx=Math.max(...ss.map(d=>Math.abs(d.x-c.x)),1),ry=Math.max(...ss.map(d=>Math.abs(d.y-c.y)),1);
  const isShadow=ry<3&&rx>2;
  softQueue.push({depth:c.w,draw:()=>{ctx.globalAlpha=alpha;ctx.beginPath();ctx.ellipse(c.x,c.y,clamp(rx,.8,200),clamp(ry,.8,200),0,0,TAU);
   if(opts.ball){let g=ctx.createRadialGradient(c.x-rx*.2,c.y-ry*.3,rx*.15,c.x,c.y,Math.max(rx,ry));g.addColorStop(0,'#ffffff');g.addColorStop(.53,'#f9f5de');g.addColorStop(.65,'#266dd0');g.addColorStop(.83,'#306bcb');g.addColorStop(1,'#f2c751');ctx.fillStyle=g;}else if(isShadow||opts.flat){ctx.fillStyle=color;}else{let g=ctx.createRadialGradient(c.x-rx*.32,c.y-ry*.32,1,c.x,c.y,Math.max(rx,ry)*1.25);g.addColorStop(0,shadeColor(color,1.12));g.addColorStop(1,shadeColor(color,.68));ctx.fillStyle=g;}ctx.fill();ctx.globalAlpha=1;}});
 }
}
function softBackground(){ctx.clearRect(0,0,screenW,screenH);const g=ctx.createLinearGradient(0,0,0,screenH);g.addColorStop(0,'#5da5dc');g.addColorStop(.57,'#b8e6ee');g.addColorStop(.58,'#e8e2c8');g.addColorStop(1,'#c8ac7a');ctx.fillStyle=g;ctx.fillRect(0,0,screenW,screenH);ctx.fillStyle='#fff6cc';ctx.globalAlpha=.82;ctx.beginPath();ctx.arc(screenW*.86,screenH*.23,35,0,TAU);ctx.fill();ctx.globalAlpha=1;}
let staticCapture=null,staticBatches=null,drawCallsThisFrame=0;
function drawMesh(mesh_,mat,color,opts={}){if(staticCapture){staticCapture.push({mesh_,mat,color,opts});return;}if(software){softDraw(mesh_,mat,color,opts);return;}const c=rgba(color,opts.alpha===undefined?1:opts.alpha);gl.uniformMatrix4fv(loc.model,false,mat);gl.uniform4fv(loc.color,c);gl.uniform1f(loc.ball,opts.ball?1:0);gl.uniform1f(loc.flat,opts.flat?1:0);gl.bindBuffer(gl.ARRAY_BUFFER,mesh_.vb);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,mesh_.ib);gl.enableVertexAttribArray(loc.position);gl.vertexAttribPointer(loc.position,3,gl.FLOAT,false,24,0);gl.enableVertexAttribArray(loc.normal);gl.vertexAttribPointer(loc.normal,3,gl.FLOAT,false,24,12);drawCallsThisFrame++;gl.drawElements(gl.TRIANGLES,mesh_.count,gl.UNSIGNED_SHORT,0);}
function cube(x,y,z,w,h,d,color,opts){drawMesh(BOX,model(v(x,y,z),v(w,h,d),opts?.yaw||0),color,opts);}
function sphere(x,y,z,w,h,d,color,opts){drawMesh(SPHERE,model(v(x,y,z),v(w,h,d),opts?.yaw||0),color,opts);}
function beam(a,b,r,color,opts){drawMesh(CYL,cylinderModel(a,b,r),color,opts);}
function ring(x,z,r,color,opacity=1){for(let i=0;i<22;i++){let a=i/22*TAU,b=(i+1)/22*TAU;beam(v(x+Math.cos(a)*r,.065,z+Math.sin(a)*r),v(x+Math.cos(b)*r,.065,z+Math.sin(b)*r),.025,color,{alpha:opacity,flat:true});}}

// Prépare une seule fois les géométries du décor fixe (par matériau/couleur).
// Évite de réémettre chaque roche, palmier, poteau et fil du filet à chaque frame.
const identityModel=model(v(0,0,0),v(1,1,1));
function buildStaticBatches(){
  staticCapture=[];drawWorld();drawNet();const objects=staticCapture;staticCapture=null;
  const groups=new Map();
  for(const item of objects){
    const {mesh_,mat,color,opts}=item;
    const key=color+'|'+(opts?.alpha??1)+'|'+(opts?.flat?1:0);
    let group=groups.get(key);
    if(!group){group={vertices:[],normals:[],indices:[],color,opts};groups.set(key,group);}
    const base=group.vertices.length/3;
    const sx2=mat[0]**2+mat[1]**2+mat[2]**2||1;
    const sy2=mat[4]**2+mat[5]**2+mat[6]**2||1;
    const sz2=mat[8]**2+mat[9]**2+mat[10]**2||1;
    const coords=mesh_.sourceVertices,normals=mesh_.sourceNormals;
    for(let i=0;i<coords.length;i+=3){
      const x=coords[i],y=coords[i+1],z=coords[i+2];
      group.vertices.push(mat[0]*x+mat[4]*y+mat[8]*z+mat[12],mat[1]*x+mat[5]*y+mat[9]*z+mat[13],mat[2]*x+mat[6]*y+mat[10]*z+mat[14]);
      const nx=normals[i],ny=normals[i+1],nz=normals[i+2];
      let ax=mat[0]*nx/sx2+mat[4]*ny/sy2+mat[8]*nz/sz2;
      let ay=mat[1]*nx/sx2+mat[5]*ny/sy2+mat[9]*nz/sz2;
      let az=mat[2]*nx/sx2+mat[6]*ny/sy2+mat[10]*nz/sz2;
      const d=Math.hypot(ax,ay,az)||1;group.normals.push(ax/d,ay/d,az/d);
    }
    for(const idx of mesh_.sourceIndices)group.indices.push(idx+base);
  }
  staticBatches=[];
  for(const group of groups.values()){
    if(group.vertices.length/3>65535){console.warn('Décor trop vaste pour un unique lot',group.color);continue;}
    staticBatches.push({mesh:mesh(group.vertices,group.normals,group.indices),color:group.color,opts:group.opts});
  }
  console.info('VOLLEYLAB: décor optimisé',objects.length,'objets →',staticBatches.length,'lots GPU');
}
function drawStaticWorld(){
  if(software){drawWorld();drawNet();return;}
  if(!staticBatches)buildStaticBatches();
  for(const group of staticBatches)drawMesh(group.mesh,identityModel,group.color,group.opts);
}

function screenProject(world){const p=world,m=VP,cx=m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],cy=m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],cw=m[3]*p[0]+m[7]*p[1]+m[11]*p[2]+m[15];if(cw<=.1)return null;return{x:(cx/cw*.5+.5)*screenW,y:(-.5*cy/cw+.5)*screenH,w:cw};}
function resize(){let qualityCap=graphicsQuality==='eco'?0.9:graphicsQuality==='high'?1.65:1.35*autoGraphicsScale;let dpr=software?1:Math.min(window.devicePixelRatio||1,qualityCap),r=canvas.getBoundingClientRect(),w=Math.max(300,Math.round(r.width)),h=Math.max(300,Math.round(r.height));if(w!==screenW||h!==screenH||canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){screenW=w;screenH=h;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);gl.viewport(0,0,canvas.width,canvas.height);}}

// ---------- Gameplay ----------
const P={gravity:14,assist:2.8,speed:8.5,smash:1};
const JUMP_TAP_WINDOW=.27; // Temps bref de flexion avant le décollage, permet deux appuis sans double saut en l’air.
const JUMP_SPEED=9.1, CHARGED_JUMP_SPEED=11.35, GROUND_ACCEL=30, GROUND_BRAKE=35;
const COURT_X=6.35,COURT_Z=9.8,NET=2.45,BALL_R=.36;
// Les lignes délimitent UNIQUEMENT la zone valable pour marquer.
// Les personnages peuvent courir sur toute la plage, jusqu'aux barrières en bois (x +/-14, z +/-13).
// Une marge évite que leurs corps de 0.62m traversent les poteaux et les panneaux.
const BEACH_X=13.0,BEACH_Z=12.12,BEACH_NET_GAP=.85;
const isInsideCourt=(x,z)=>Math.abs(x)<=COURT_X && Math.abs(z)<=COURT_Z;
const isInsideOppositeCourt=(x,z)=>Math.abs(x)<=COURT_X && z>=0 && z<=COURT_Z;
function playableLimits(p){
 const blue=p.team==='blue';
 const front=blue?-BEACH_NET_GAP:BEACH_NET_GAP;
 const back=blue?-BEACH_Z:BEACH_Z;
 const atOwnService=game.mode==='serve'&&game.server==='blue'&&p.id===0;
 return {minX:-BEACH_X,maxX:BEACH_X,minZ:blue?back:front,maxZ:blue?(atOwnService?-COURT_Z-.18:front):back};
}
const rand=(a,b)=>a+Math.random()*(b-a);
// Composition dynamique : 1 humain + (n−1) bots bleus contre n bots rouges.
let selectedTeamSize=2;
const BLUE_NAMES=['TOI','LÉO','MIA','NOA'];
const RED_NAMES=['NOVA','KAI','RUBY','AXEL'];
const FORMATIONS={
  1:[[0, -5.7]],
  2:[[-2.6,-5.6],[2.6,-5.1]],
  3:[[0,-6.4],[-3.7,-3.85],[3.7,-3.85]],
  4:[[-3.8,-6.7],[3.8,-6.7],[-3.8,-3.3],[3.8,-3.3]]
};
function newPlayer(team,name,id){return{x:0,z:0,vy:0,jump:0,team,name,id,move:0,hitAge:9,cool:0,dive:0,diveVX:0,diveVZ:team==='blue'?1:-1,diveCooldown:0,lastHitStyle:'normal',vx:0,vz:0,inAir:false,jumpPrep:0,jumpBoost:false,crouch:false,crouchPose:0};}
const players=[];
function makeRoster(){
 players.length=0;
 for(let i=0;i<game.teamSize;i++)players.push(newPlayer('blue',BLUE_NAMES[i],players.length));
 for(let i=0;i<game.teamSize;i++)players.push(newPlayer('red',RED_NAMES[i],players.length));
 resetPlayers();
 rebuildPlayerLabels();
 playerSpeechUntil=Array(players.length).fill(0);
}
function redServer(){return players.find(p=>p.team==='red');}
function sidePlayers(team){return players.filter(p=>p.team===team);}
function friendlyBots(){return players.filter(p=>p.team==='blue'&&p.id!==0);}
function matchChip(){
 const n=game.teamSize;
 if(onlineMode){$('scoreMode').textContent='2v2 EN LIGNE';$('rosterChip').textContent='SALON '+onlineRoom;return;}
 $('scoreMode').textContent=n+'v'+n;
 $('rosterChip').innerHTML=n+'v'+n+' <span>•</span> '+(n===1?'Duel contre 1 bot':'Toi + '+(n-1)+' bot'+(n>2?'s':'')+' contre '+n+' bots');
}
const ball={x:0,y:3.4,z:4,vx:0,vy:0,vz:0,spin:0};
const trail=[],particles=[];
const game={teamSize:2,mode:'menu',blue:0,red:0,server:'blue',serveStage:'ready',serveElapsed:0,serveClock:12,timer:0,elapsed:0,camera:1,paused:false,touchTeam:null,touchCount:0,pointReason:'',hitQueued:null,toastTimer:0,camSmooth:null,ballLive:false,after:0,passToMate:false,smashFX:0,lastAction:'',actionTimer:0,lastCommand:'',commandCount:0};
// ----- Connection multijoueur : le serveur valide les mouvements, les tirs et le score. -----
let onlineMode=false, onlineRoom='', onlineSlot=-1, onlineTeam='blue', onlineSocket=null;
let onlineFrameAge=0, onlineNotice='', onlineRoster='', onlineInputElapsed=0;
let onlineSnapshots=[],onlineSelfServer=null,onlineServerMode='',onlinePingMs=null,onlinePingElapsed=0;
const MATCH_TARGET=15;
const hasMatchWinner=(blue,red)=>Math.max(blue,red)>=MATCH_TARGET&&Math.abs(blue-red)>=2;
const matchWinnerTeam=(blue,red)=>hasMatchWinner(blue,red)?(blue>red?'blue':'red'):null;
const onlinePhysics={speed:8.5,accel:30,brake:35,gravity:21,walkLimit:13,netGap:.85,beachZ:12.12};
const numSmooth=(a,b,t)=>a+(b-a)*t;
const expSmooth=(speed,dt)=>1-Math.exp(-speed*Math.max(0,dt));
const onlineReady=()=>onlineSocket&&onlineSocket.readyState===WebSocket.OPEN;
function onlineSend(obj){if(onlineReady())onlineSocket.send(JSON.stringify(obj));}
function onlineSetStatus(text){$('onlineStatus').textContent=text;}
function onlineInvite(){return location.origin+'/?room='+encodeURIComponent(onlineRoom);}
async function copyRoomInvite(){if(!onlineRoom)return;try{await navigator.clipboard.writeText(onlineInvite());showToast('LIEN D’INVITATION COPIÉ !',1.8);}catch{window.prompt('Copie le lien :',onlineInvite());}}
function onlineLobbyOverlay(open){$('onlineOverlay').classList.toggle('hidden',!open);}
function openOnline(){audio.unlock();closeOptions();onlineLobbyOverlay(true);onlineSetStatus('Crée un salon ou rejoins un ami avec son code.');$('roomInfo').classList.add('hidden');try{$('onlineName').value=localStorage.getItem('volleylab:pseudo')||'Joueur';}catch{}}
function closeOnline(){if(onlineRoom){onlineLeave();return;}onlineLobbyOverlay(false);}
function onlineConnect(mode){
 if(onlineSocket&&onlineSocket.readyState===WebSocket.CONNECTING)return;
 if(onlineSocket)onlineSocket.close();
 const name=$('onlineName').value.trim().slice(0,17)||'Joueur';try{localStorage.setItem('volleylab:pseudo',name);}catch{}
 const code=$('onlineCode').value.trim().toUpperCase();if(mode==='join'&&!/^[A-HJ-NP-Z2-9]{6}$/.test(code)){onlineSetStatus('Entre un code valide de six caractères.');return;}
 onlineSetStatus('Connexion au serveur…');
 let socket;
 try{socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');}catch{onlineSetStatus('Impossible de contacter le serveur.');return;}
 onlineSocket=socket;
 socket.addEventListener('open',()=>{socket.send(JSON.stringify(mode==='join'?{type:'join',code,name}:{type:'create',name}));});
 socket.addEventListener('message',e=>{if(socket!==onlineSocket)return;let data;try{data=JSON.parse(e.data);}catch{return;}onlineMessage(data);});
 socket.addEventListener('close',()=>{if(socket!==onlineSocket)return;hideVictory();game.winTeam=null;onlineSocket=null;onlineMode=false;onlineRoom='';onlineSlot=-1;onlineSnapshots.length=0;onlineSelfServer=null;$('app').classList.remove('online-active');game.mode='menu';audio.setActive(false);$('roomBadge').classList.add('hidden');onlineLobbyOverlay(true);onlineSetStatus('Connexion perdue. Rejoins le salon pour reprendre.');modal.classList.add('hidden');});
 socket.addEventListener('error',()=>{onlineSetStatus('Le serveur ne répond pas. Réessaie.');});
}
function onlineLeave(){hideVictory();game.winTeam=null;const old=onlineSocket;onlineSocket=null;onlineMode=false;onlineRoom='';onlineSlot=-1;onlineSnapshots.length=0;onlineSelfServer=null;$('app').classList.remove('online-active');keys.clear();stopCharge();if(old)old.close();$('roomBadge').classList.add('hidden');for(const id of ['servePracticeBtn','practiceBtn','smashPracticeBtn'])$(id).classList.remove('hidden');onlineLobbyOverlay(false);game.mode='menu';game.paused=false;game.camSmooth=null;modal.classList.remove('hidden');resetMatch();backToMenu();}
function onlineMakeRoster(state){const ordered=[state.players.find(p=>p.slot===onlineSlot),...state.players.filter(p=>p.slot!==onlineSlot)].filter(Boolean);
 const sig=ordered.map(p=>p.slot+':'+p.name).join('|');if(sig===onlineRoster)return;
 onlineRoster=sig;onlineSnapshots.length=0;onlineSelfServer=null;players.length=0;for(let i=0;i<ordered.length;i++){const sp=ordered[i],p=newPlayer(sp.team,i===0?sp.name+' (TOI)':sp.name,i);p.slot=sp.slot;players.push(p);}
 playerSpeechUntil=players.map(()=>0);rebuildPlayerLabels();game.camSmooth=null;
}
function onlineMessage(data){
 if(data.type==='pong'){
   const elapsed=performance.now()-Number(data.sent);
   if(Number.isFinite(elapsed)&&elapsed>=0&&elapsed<10000)onlinePingMs=onlinePingMs===null?elapsed:numSmooth(onlinePingMs,elapsed,.2);
   return;
 }
 if(data.type==='error'){onlineSetStatus('⚠ '+String(data.message||'Erreur'));return;}
 if(data.type==='joined'){onlineMode=true;onlineRoom=data.code;onlineSlot=data.slot;onlineTeam=data.team;onlineSnapshots.length=0;onlineSelfServer=null;onlinePingElapsed=0;aim.z=data.team==='red'?-6:6;onlineRoster='';$('app').classList.add('online-active');$('roomCode').textContent=data.code;$('roomBadgeText').textContent='2v2 · '+data.code;$('roomInfo').classList.remove('hidden');$('roomBadge').classList.remove('hidden');modal.classList.add('hidden');for(const id of ['servePracticeBtn','practiceBtn','smashPracticeBtn'])$(id).classList.add('hidden');onlineSetStatus('Salon prêt ! Partage le lien avec trois amis.');return;}
 if(data.type==='lobby'){const slots=new Map((data.players||[]).map(p=>[p.slot,p]));$('roomBlue').textContent=[0,1].map(i=>slots.get(i)?.name||'En attente…').join(' · ');$('roomRed').textContent=[2,3].map(i=>slots.get(i)?.name||'En attente…').join(' · ');$('roomBadgeText').textContent='2v2 · '+data.code+' · '+data.players.length+'/4';onlineSetStatus(data.notice||data.players.length+'/4 joueurs connectés');if(!data.active){onlineLobbyOverlay(true);game.mode='menu';}return;}
 if(data.type==='start'){hideVictory();game.winTeam=null;onlineLobbyOverlay(false);game.mode='serve';game.teamSize=2;game.camSmooth=null;game.paused=false;cancelPendingShots();stopCharge();audio.unlock();audio.setActive(true);showToast('🏐 MATCH EN LIGNE — 2 CONTRE 2 !',2);return;}
 if(data.type==='state'){
   if(!onlineMode)return;
   onlineFrameAge=0;
   onlineMakeRoster(data);
   const now=performance.now();
   // Chaque trame reste dans un tampon temporel : pas de téléportation visuelle à 30 Hz.
   const previousServerMode=onlineServerMode;
   const reset=onlineSnapshots.length===0 || (onlineServerMode!==data.mode && (data.mode==='point'||data.mode==='serve'||data.mode==='live'));
   if(previousServerMode==='ended'&&data.mode==='serve'){hideVictory();game.winTeam=null;}
   if(reset)onlineSnapshots.length=0;
   const entry={at:now,state:data};onlineSnapshots.push(entry);
   while(onlineSnapshots.length>22 || (onlineSnapshots.length>3 && now-onlineSnapshots[0].at>1400))onlineSnapshots.shift();
   onlineServerMode=data.mode;
   for(let i=0;i<players.length;i++){
     const p=players[i],sp=data.players.find(s=>s.slot===p.slot);
     if(!sp)continue;
     if(reset)Object.assign(p,sp);
     else if(p.slot!==onlineSlot){
       // L'animation reçoit son état ; la position réelle est lissée à chaque image.
       Object.assign(p,{inAir:sp.inAir,jumpBoost:sp.jumpBoost,jumpPrep:sp.jumpPrep,crouch:sp.crouch,diveVX:sp.diveVX,diveVZ:sp.diveVZ,diveCooldown:sp.diveCooldown,lastHitStyle:sp.lastHitStyle});
     }else{
       p.lastHitStyle=sp.lastHitStyle;
     }
   }
   if(reset)Object.assign(ball,data.ball);
   const mine=data.players.find(sp=>sp.slot===onlineSlot);
   if(mine)onlineSelfServer={...mine,receivedAt:now};
   game.mode=data.mode;game.server=data.server;game.serveStage=data.serveStage;
   game.serveClock=data.serveClock;game.ballLive=data.ballLive;
   game.blue=data.score[0];game.red=data.score[1];game.touchCount=data.touchCount;game.teamSize=2;
   updateHUD();$('scoreMode').textContent='2v2 EN LIGNE';$('rosterChip').textContent='EN LIGNE · '+onlineRoom;
   if(game.mode==='serve'){
     $('servePanel').classList.add('hidden');
     $('hitType').textContent=data.serveSlot===onlineSlot?(data.serveStage==='ready'?'TON SERVICE : '+formatKey(bindings.jump)+' POUR LANCER':'FRAPPE : '+formatKey(bindings.hit)+' · DOUBLE CLIC : LOB'):('SERVICE ADVERSE · SOIS PRÊT');
   }
   return;
 }
 if(data.type==='event'){
   const p=players.find(p=>p.slot===data.slot);
   if(data.name==='hit'){if(p){const kind=data.kind||'normal';sayPlayer(p.id,({normal:'FRAPPE',lob:'LOB',pass:'PASSE',passLob:'PASSE LOBÉE',smash:'SMASH',smashLob:'SMASH LOBÉ'})[kind]||'FRAPPE');playFX(kind==='normal'?'hit':kind,Number(data.power)||.7,p.x);}return;}
   if(data.name==='point'){if(data.ground){playFX('ground',.62,Number(ball.x)||0);playFX('pointFun',.74,0,.14);}else playFX('score',.56);showToast((data.team==='blue'?'POINT BLEU ! ':'POINT ROUGE ! ')+(data.reason||''),1.3);return;}
   if(data.name==='net'){playFX('net',.7,Number(data.x)||0);return;}
   if(data.name==='dive'){if(p){playFX('dive',.7,p.x);sayPlayer(p.id,'PLONGEON');}return;}
   if(data.name==='serve'){if(p){sayPlayer(p.id,'SERVICE !');playFX('serve',.8,p.x);}return;}
   if(data.name==='toss'){if(p)sayPlayer(p.id,'SERVICE');return;}
   if(data.name==='end'){startVictory(data.winner||matchWinnerTeam(data.blue,data.red),data.blue,data.red,true);return;}
 }
}
// Mouvements immédiats du joueur local : le serveur conserve l'autorité pour les règles.
function onlinePredictLocal(dt){
 if(!onlineMode||!onlineSelfServer||!players[0]||!['serve','live'].includes(game.mode))return;
 const p=players[0],o=onlinePhysics;
 if(p.dive>0){p.dive=Math.max(0,p.dive-dt);p.diveCooldown=Math.max(0,p.diveCooldown-dt);p.x+=p.diveVX*12*dt;p.z+=p.diveVZ*12*dt;p.move=12;}
 else if(p.inAir){p.x+=p.vx*dt;p.z+=p.vz*dt;p.move=Math.hypot(p.vx,p.vz);}
 else{
   const sign=onlineTeam==='blue'?1:-1;
   const dx=(Number(keys.has(bindings.left))-Number(keys.has(bindings.right)))*sign;
   const dz=(Number(keys.has(bindings.forward))-Number(keys.has(bindings.back)))*sign;
   const mag=Math.hypot(dx,dz);
   p.crouch=keys.has(bindings.crouch);
   const speed=o.speed*(p.crouch?.46:p.jumpBoost&&p.jumpPrep>0?.55:1);
   const tx=mag?dx/mag*speed:0,tz=mag?dz/mag*speed:0;
   const accel=(mag?o.accel:o.brake)*dt;
   p.vx+=clamp(tx-p.vx,-accel,accel);p.vz+=clamp(tz-p.vz,-accel,accel);
   p.x+=p.vx*dt;p.z+=p.vz*dt;p.move=Math.hypot(p.vx,p.vz);
   if(p.jumpPrep>0){p.jumpPrep=Math.max(0,p.jumpPrep-dt);if(p.jumpPrep<=0){p.inAir=true;p.vy=p.jumpBoost?11.35:9.1;}}
 }
 p.crouchPose+=clamp((p.crouch?.82:p.jumpPrep>0?p.jumpBoost?1:.55:0)-p.crouchPose,-dt*12,dt*12);
 if(p.inAir){p.jump+=p.vy*dt;p.vy-=o.gravity*dt;if(p.jump<=0){p.jump=0;p.vy=0;p.inAir=false;p.jumpBoost=false;}}
 p.x=clamp(p.x,-o.walkLimit,o.walkLimit);
 p.z=clamp(p.z,onlineTeam==='blue'?-o.beachZ:o.netGap,onlineTeam==='blue'?-o.netGap:o.beachZ);
 // Collisions visuelles entre joueurs : le serveur vérifie les vraies collisions.
 for(const other of players.slice(1)){
   if(Math.abs(p.jump-other.jump)>1.35)continue;
   let dx=p.x-other.x,dz=p.z-other.z,dist=Math.hypot(dx,dz);
   if(dist>0.0001&&dist<1.24){p.x+=dx/dist*(1.24-dist);p.z+=dz/dist*(1.24-dist);}
 }
 const authority=onlineSelfServer;
 if(onlineFrameAge<.42){
   const ahead=clamp((onlinePingMs??90)/2000+(performance.now()-authority.receivedAt)/1000+.015,.025,.20);
   const desiredX=authority.x+authority.vx*ahead,desiredZ=authority.z+authority.vz*ahead;
   const d=Math.hypot(desiredX-p.x,desiredZ-p.z);
   const moving=keys.has(bindings.left)||keys.has(bindings.right)||keys.has(bindings.forward)||keys.has(bindings.back);
   if(d>4){p.x=desiredX;p.z=desiredZ;p.vx=authority.vx;p.vz=authority.vz;}
   else if(d>(moving?.75:.08)){
     const blend=expSmooth(moving?2.0:6.0,dt);
     p.x=numSmooth(p.x,desiredX,blend);p.z=numSmooth(p.z,desiredZ,blend);
   }
   if(!p.inAir && authority.inAir && authority.jump>p.jump+.7){p.inAir=true;p.vy=authority.vy;p.jump=authority.jump;}
 }
}
// Images à l'heure de l'écran (~90ms derrière le serveur) : tous les autres joueurs et la balle
// sont interpolés, et jamais copiés brutalement à chaque paquet WebSocket.
function onlineVisualSample(){
 if(!onlineMode||!onlineSnapshots.length)return;
 const now=performance.now(),delay=clamp(90+(onlinePingMs??80)*.13,90,140),target=now-delay;
 const entries=onlineSnapshots;
 let a=entries[0],b=entries[entries.length-1];
 for(let i=0;i<entries.length-1;i++){
   if(target>=entries[i].at && target<=entries[i+1].at){a=entries[i];b=entries[i+1];break;}
   if(target>entries[i+1].at){a=entries[i+1];b=entries[i+1];}
 }
 const ratio=a===b?0:clamp((target-a.at)/Math.max(1,b.at-a.at),0,1);
 const extrap=a===b?clamp((target-b.at)/1000,0,.08):0;
 const ap=a.state.players,bp=b.state.players;
 for(const p of players){
   if(p.slot===onlineSlot)continue;
   const u=ap.find(x=>x.slot===p.slot),v=bp.find(x=>x.slot===p.slot);if(!u||!v)continue;
   const snapDist=Math.hypot(v.x-u.x,v.z-u.z);
   const f=snapDist>4?1:ratio;
   for(const k of ['x','z','jump','crouchPose','dive','move','hitAge','vx','vz','vy'])p[k]=numSmooth(u[k],v[k],f);
   if(extrap&&b.state.mode==='live'){p.x+=v.vx*extrap;p.z+=v.vz*extrap;p.jump=Math.max(0,p.jump+v.vy*extrap-.5*21*extrap*extrap);}
 }
 const ab=a.state.ball,bb=b.state.ball;
 const bigJump=Math.hypot(ab.x-bb.x,ab.y-bb.y,ab.z-bb.z)>11;
 for(const k of ['x','y','z','spin','vx','vy','vz'])ball[k]=numSmooth(ab[k],bb[k],bigJump?1:ratio);
 if(extrap&&b.state.mode==='live'){
   ball.x+=bb.vx*extrap;ball.z+=bb.vz*extrap;
   ball.y=Math.max(.36,ball.y+bb.vy*extrap-.5*14*extrap*extrap);
   ball.spin+=8*extrap;
 }
}
function onlineTick(dt){
 onlineFrameAge+=dt;onlineInputElapsed+=dt;onlinePingElapsed+=dt;
 onlinePredictLocal(dt);
 if(onlineMode&&onlineInputElapsed>=1/30&&onlineReady()&&players[0]){
   onlineInputElapsed-=1/30;
   if(onlineInputElapsed>.10)onlineInputElapsed=0;
   onlineSend({type:'input',input:{left:keys.has(bindings.left),right:keys.has(bindings.right),forward:keys.has(bindings.forward),back:keys.has(bindings.back),crouch:keys.has(bindings.crouch)},aim:{x:aim.x,z:aim.z}});
 }
 if(onlineMode&&onlinePingElapsed>=2&&onlineReady()){
   onlinePingElapsed=0;onlineSend({type:'ping',sent:performance.now()});
 }
 if(onlineMode&&onlineFrameAge>8)$('roomBadgeText').textContent='RECONNEXION…';
}
function onlineControl(action){
 if(action==='jump'){
   onlineSend({type:'jump'});
   const p=players[0];
   if(p&&game.mode==='live'&&!p.inAir&&p.dive<=0){
     if(p.jumpPrep>0){p.jumpBoost=true;p.jumpPrep=.30;}
     else {p.jumpPrep=.27;p.jumpBoost=false;}
   }
   return true;
 }
 if(action==='dive'){
   onlineSend({type:'dive'});
   const p=players[0];
   if(p&&game.mode==='live'&&!p.inAir&&p.dive<=0&&p.diveCooldown<=0){
     const sign=onlineTeam==='blue'?1:-1;
     let dx=(Number(keys.has(bindings.left))-Number(keys.has(bindings.right)))*sign;
     let dz=(Number(keys.has(bindings.forward))-Number(keys.has(bindings.back)))*sign;
     const norm=Math.hypot(dx,dz);
     if(norm<.1){dx=ball.x-p.x;dz=ball.z-p.z;}
     const len=Math.hypot(dx,dz)||1;p.diveVX=dx/len;p.diveVZ=dz/len;
     p.dive=.7;p.diveCooldown=1.3;p.jump=0;p.inAir=false;p.vx=0;p.vz=0;
   }
   return true;
 }
 if(action==='practice'||action==='practiceSmash'||action==='practiceServe'||action==='restart'){showToast('INDISPONIBLE EN MATCH PRIVÉ',.8);return true;}
 if(action==='pause'){showToast('PAUSE DÉSACTIVÉE EN LIGNE',.9);return true;}
 return false;
}

const audio=new VolleyAudio();
const keys=new Set();let charging=false,chargeStart=0,chargeControl=null,chargeAction=null,chargeSecondTap=false,chargeAerial=false,charge=0,mouseX=0,mouseY=0,mouseMoved=false,aim={x:0,z:6};
const DOUBLE_TAP_MS=275;const pendingClicks={hit:null,pass:null};
// Un code par action. La frappe et la passe partagent chacune les variantes simple, double clic et saut.
// Profil : clic gauche = frappe ; double gauche = lob ; clic droit = passe ; double droit = passe lobée.
// Uniquement pendant le grand saut (double appui sur SAUT), clic gauche devient un smash.
const ARROW_BINDINGS={left:'ArrowLeft',right:'ArrowRight',forward:'ArrowUp',back:'ArrowDown',jump:'Space',crouch:'ShiftLeft',hit:'Mouse0',pass:'Mouse2',dive:'ControlLeft',practice:'KeyB',practiceSmash:'KeyG',practiceServe:'KeyH',pause:'KeyP',settings:'KeyT',restart:'KeyR'};
const ZQSD_BINDINGS={...ARROW_BINDINGS,left:'KeyQ',right:'KeyD',forward:'KeyZ',back:'KeyS'};
const KEY_LABELS={left:'Gauche',right:'Droite',forward:'Avancer',back:'Reculer',jump:'Sauter',crouch:'S’accroupir',hit:'Frappe / smash après grand saut (×2 : lob)',pass:'Passe (×2 : lobée)',dive:'Plonger',practice:'Balle test',practiceSmash:'Balle smash',practiceServe:'Recommencer un service',pause:'Pause',settings:'Options',restart:'Recommencer'};
const cameraSettings={distance:12.9,height:6.4};
let bindings={...ARROW_BINDINGS},awaitingAction=null,pausedByOptions=false,helpVisible=false;
const STORAGE_KEY='volleylab:v09:options';
const MODE_STORAGE_KEY='volleylab:team-size';
const RESERVED_CODES=new Set(['Escape','MetaLeft','MetaRight','OSLeft','OSRight','F5','F11','F12','PrintScreen']);
function formatKey(code){if(!code)return '—';const map={ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',Space:'Espace',ShiftLeft:'Maj G',ShiftRight:'Maj D',Enter:'Entrée',Backspace:'Retour',ControlLeft:'Ctrl G',ControlRight:'Ctrl D',AltLeft:'Alt G',AltRight:'Alt D',Tab:'Tab',CapsLock:'Verr Maj',Mouse0:'Clic G',Mouse1:'Molette',Mouse2:'Clic D',Mouse3:'Souris 4',Mouse4:'Souris 5',Backquote:'²',Comma:',',Period:'.',Semicolon:';',Minus:'-',Equal:'='};return map[code]||code.replace(/^Key/,'').replace(/^Digit/,'').replace(/^Numpad/,'Pavé ');}
function validCode(code){return typeof code==='string'&&code.length>0&&code.length<40&&!RESERVED_CODES.has(code)&&(/^[A-Z][a-zA-Z0-9]*$/.test(code)||/^Mouse[0-4]$/.test(code));}
function restoreOptions(){
 try {
  // Reprendre mouvements, caméra et options de l'ancienne version, mais pas ses frappes.
  const legacyKeys=[STORAGE_KEY,'volleylab:v08:options','volleylab:v07:options','volleylab:v06:options','volleylab:v05:options','volleylab:v04:options','volleylab:v03:options','volleylab:v02:options'];
  let s=null;
  for(const key of legacyKeys){let raw=localStorage.getItem(key);if(raw){s=JSON.parse(raw);break;}}
  if(s && typeof s.helpVisible==='boolean')helpVisible=s.helpVisible;
  if(s?.bindings){
   for(const name of Object.keys(ARROW_BINDINGS)){
    if(name==='hit'||name==='pass')continue; // Nouveau mapping demandé : G = frappe, D = passe.
    if(validCode(s.bindings[name]))bindings[name]=s.bindings[name];
   }
  }
  if(s&&Number.isFinite(s.distance))cameraSettings.distance=clamp(s.distance,7,24);
  if(s&&Number.isFinite(s.height))cameraSettings.height=clamp(s.height,3,14);
  if(s?.audio){
   if(typeof s.audio.enabled==='boolean')audio.setEnabled(s.audio.enabled);
   if(Number.isFinite(s.audio.volume))audio.setVolume(s.audio.volume);
   if(Number.isFinite(s.audio.ambience))audio.setAmbience(s.audio.ambience);
  }
 }catch(e){/* stockage indisponible ou corrompu : conserver les commandes par défaut */}
 // Privilégier les deux boutons de souris demandés, même si un ancien profil les utilisait ailleurs.
 const seen=new Set(['Mouse0','Mouse2']);
 for(const name of Object.keys(bindings)){
  if(name==='hit'||name==='pass')continue;
  let key=bindings[name];
  if(seen.has(key)){
   key=ARROW_BINDINGS[name];
   if(seen.has(key)){
    key=['KeyJ','KeyK','KeyL','KeyU','KeyI','KeyO','KeyN'].find(k=>!seen.has(k))||'KeyM';
   }
   bindings[name]=key;
  }
  seen.add(key);
 }
}
function storeOptions(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify({bindings,helpVisible,distance:cameraSettings.distance,height:cameraSettings.height,audio:{enabled:audio.enabled,volume:audio.volume,ambience:audio.ambience}}));}catch(e){}}
function restoreModeSelection(){try{const val=Number(localStorage.getItem(MODE_STORAGE_KEY));if([1,2,3,4].includes(val))selectedTeamSize=val;}catch(e){}}
function updateAudioUI(){
 const btn=$('soundBtn');btn.textContent=audio.enabled?'🔊':'🔇';btn.title=audio.enabled?'Couper les sons':'Activer les sons';btn.setAttribute('aria-pressed',audio.enabled?'true':'false');btn.setAttribute('aria-label',audio.enabled?'Couper les sons':'Activer les sons');
 for(const [id,val,out] of [['audioVolume',audio.volume,'audioVolumeValue'],['audioAmbience',audio.ambience,'audioAmbienceValue']]){const el=$(id);if(el)el.value=Math.round(val*100);if($(out))$(out).textContent=Math.round(val*100)+' %';}
 const note=$('audioNote');if(note)note.textContent=!audio.supported?'Audio Web indisponible dans ce navigateur.':audio.enabled?'Audio activé · teste les sons ci-dessous.':'Sons coupés · clique sur 🔇 pour les réactiver.';
}
function updateKeyUI(){
 const movement=['forward','left','back','right'];
 for(const name of Object.keys(KEY_LABELS)){
  const btn=$('bind-'+name);
  if(btn){btn.textContent=awaitingAction===name?'…':formatKey(bindings[name]);btn.classList.toggle('listening',awaitingAction===name);btn.setAttribute('aria-label','Configurer '+KEY_LABELS[name]+', actuel '+formatKey(bindings[name]));}
 }
 for(const [id,name] of [['tutorialForward','forward'],['tutorialLeft','left'],['tutorialBack','back'],['tutorialRight','right'],['tutorialJump','jump'],['tutorialJumpSmash','jump'],['tutorialCrouch','crouch'],['tutorialPass','pass'],['tutorialHit','hit'],['tutorialSmash','hit'],['tutorialLob','hit'],['tutorialSmashLob','hit'],['tutorialPassLob','pass'],['tutorialDive','dive'],['tutorialPractice','practice'],['tutorialSmashPractice','practiceSmash'],['tutorialServeJump','jump'],['tutorialServeHit','hit'],['tutorialServePractice','practiceServe']]){
  const el=$(id); if(el) el.textContent=formatKey(bindings[name]);
 }
 $('movementLabel').textContent=movement.map(n=>formatKey(bindings[n])).join(' ');
 const boost=$('jumpBoostHint');if(boost)boost.textContent='×2 '+formatKey(bindings.jump);
 for(const [id,name] of [['jumpHint','jump'],['crouchHint','crouch'],['passHint','pass'],['hitHint','hit'],['smashHint','hit'],['lobHint','hit'],['diveHint','dive'],['practiceLegend','practice'],['smashPracticeLegend','practiceSmash'],['servePracticeLegend','practiceServe'],['servePracticeBtnKey','practiceServe'],['settingsLegend','settings'],['pauseLegend','pause'],['practiceBtnKey','practice'],['smashPracticeBtnKey','practiceSmash']]){
  const el=$(id);if(el)el.textContent=formatKey(bindings[name]);
 }
 $('smashHint').textContent='×2 '+formatKey(bindings.jump)+' + '+formatKey(bindings.hit);
 $('lobHint').textContent='×2 '+formatKey(bindings.hit);
 $('passLobHint').textContent='×2 '+formatKey(bindings.pass);
 $('smashLobHint').textContent='×2 '+formatKey(bindings.jump)+' + ×2 '+formatKey(bindings.hit);
 $('presetArrows').classList.toggle('active',movement.every(n=>bindings[n]===ARROW_BINDINGS[n]));
 $('presetZqsd').classList.toggle('active',movement.every(n=>bindings[n]===ZQSD_BINDINGS[n]));
}
function bindMessage(message){$('bindMessage').textContent=message;}
function setPreset(preset){awaitingAction=null;bindings={...preset};keys.clear();stopCharge();updateKeyUI();storeOptions();bindMessage('Touches appliquées : souris et clavier personnalisables.');}
function cancelCapture(){awaitingAction=null;$('bindCapture').classList.add('hidden');updateKeyUI();bindMessage('Modification annulée.');}
function captureCode(code){if(!awaitingAction)return;
 if(code==='Escape'){cancelCapture();return;}
 if(!validCode(code)){bindMessage('Cette touche est réservée par le navigateur. Choisis une autre commande.');return;}
 const action=awaitingAction,old=bindings[action],other=Object.keys(bindings).find(k=>k!==action&&bindings[k]===code);
 bindings[action]=code;if(other)bindings[other]=old;
 awaitingAction=null;$('bindCapture').classList.add('hidden');keys.clear();stopCharge();updateKeyUI();storeOptions();
 bindMessage(KEY_LABELS[action]+' → '+formatKey(code)+(other?' · Échangée avec '+KEY_LABELS[other]+'.':'.'));
}
function setHelpVisible(value){
 helpVisible=!!value;
 $('controlsLeft').classList.toggle('hidden',!helpVisible);
 $('controlsRight').classList.toggle('hidden',!helpVisible||game.mode==='serve');
 const btn=$('helpToggle');btn.setAttribute('aria-pressed',String(helpVisible));btn.setAttribute('aria-label',helpVisible?'Masquer les commandes':'Afficher les commandes');btn.title=helpVisible?'Masquer le tutoriel':'Afficher le tutoriel';btn.classList.toggle('active',helpVisible);
 $('showHelp').checked=helpVisible;
 storeOptions();
}
function setupOptionsUI(){
 $('helpToggle').addEventListener('click',()=>setHelpVisible(!helpVisible));
 $('showHelp').addEventListener('change',e=>setHelpVisible(e.target.checked));
 const grid=$('bindingGrid');for(const [id,label] of Object.entries(KEY_LABELS)){
   const row=document.createElement('div');row.className='binding-row';const txt=document.createElement('span');txt.textContent=label;
   const btn=document.createElement('button');btn.type='button';btn.className='bind-btn';btn.id='bind-'+id;
   btn.addEventListener('click',()=>{awaitingAction=id;keys.clear();stopCharge();$('captureAction').textContent=label.toUpperCase();$('bindCapture').classList.remove('hidden');updateKeyUI();bindMessage('Choisis une touche ou un bouton de souris pour '+label+'.');btn.blur();});row.append(txt,btn);grid.append(row);
 }
 $('presetArrows').addEventListener('click',()=>setPreset(ARROW_BINDINGS));
 $('presetZqsd').addEventListener('click',()=>setPreset(ZQSD_BINDINGS));
 $('resetKeys').addEventListener('click',()=>setPreset(ARROW_BINDINGS));
 $('cancelCapture').addEventListener('click',cancelCapture);
 function updateCameraSliders(){ $('camDist').value=cameraSettings.distance;$('camHeight').value=cameraSettings.height;$('camDistValue').textContent=cameraSettings.distance.toFixed(1).replace('.',',')+' m';$('camHeightValue').textContent=cameraSettings.height.toFixed(1).replace('.',',')+' m';}
 $('camDist').addEventListener('input',e=>{cameraSettings.distance=Number(e.target.value);updateCameraSliders();storeOptions();});
 $('camHeight').addEventListener('input',e=>{cameraSettings.height=Number(e.target.value);updateCameraSliders();storeOptions();});
 $('camReset').addEventListener('click',()=>{cameraSettings.distance=12.9;cameraSettings.height=6.4;updateCameraSliders();storeOptions();});
 $('audioVolume').addEventListener('input',e=>{audio.setVolume(+e.target.value/100);updateAudioUI();storeOptions();});
 $('audioAmbience').addEventListener('input',e=>{audio.setAmbience(+e.target.value/100);updateAudioUI();storeOptions();});
 for(const btn of document.querySelectorAll('[data-preview-sound]'))btn.addEventListener('click',()=>{if(!audio.enabled)audio.setEnabled(true);audio.unlock();audio.play(btn.dataset.previewSound,.87,0);updateAudioUI();storeOptions();});
 updateCameraSliders();updateKeyUI();updateAudioUI();setHelpVisible(helpVisible);
}
function openOptions(lookAtCamera=false){
 if(!$('settings').classList.contains('hidden')){if(lookAtCamera)$('cameraOptions').scrollIntoView({block:'start',behavior:'smooth'});return;}
 $('settings').classList.remove('hidden');keys.clear();stopCharge();awaitingAction=null;$('bindCapture').classList.add('hidden');updateKeyUI();
 pausedByOptions=(game.mode==='live'||game.mode==='serve'||game.mode==='point')&&!game.paused;
 if(pausedByOptions)game.paused=true;audio.setActive(!game.paused&&['live','serve','point'].includes(game.mode));
 if(lookAtCamera)$('settings').scrollTop=0;
}
function closeOptions(){awaitingAction=null;$('bindCapture').classList.add('hidden');$('settings').classList.add('hidden');keys.clear();stopCharge();updateKeyUI();if(pausedByOptions){game.paused=false;pausedByOptions=false;}audio.setActive(!game.paused&&['live','serve','point'].includes(game.mode));}
function toggleOptions(){if($('settings').classList.contains('hidden'))openOptions();else closeOptions();}
restoreOptions();setupOptionsUI();
let toastEl=$('toast'),modal=$('modal');
function showToast(msg,dur=1.25){toastEl.textContent=msg;toastEl.classList.add('active');game.toastTimer=dur;}
// Bulles courtes projetées au-dessus du nom de chaque joueur : jamais de grand texte au milieu du terrain.
let playerSpeechUntil=[];
function sayPlayer(playerId,message,duration=1.05){
 const node=labelEls[playerId]?.querySelector('.player-speech');
 if(!node)return;
 node.textContent=message;
 playerSpeechUntil[playerId]=game.elapsed+duration;
 node.classList.add('speaking');
}
function actionPop(title,subtitle,playerId=0){
 game.lastAction=title;
 game.actionTimer=1.08; // Conservé pour le suivi du prototype, mais aucun bandeau plein écran.
 const shortTitle=title.replace(/^[^A-ZÀ-Ÿ]+/u,'').replace(/\s*!+\s*$/u,'').trim();
 sayPlayer(playerId,shortTitle||'GO !',1.02);
}
function updateHUD(){
 $('scoreBlue').textContent=game.blue;$('scoreRed').textContent=game.red;
 $('status').textContent=game.mode==='serve'?'SERVICE '+(game.server==='blue'?'BLEU':'ROUGE'):game.mode==='point'?'POINT !':game.paused?'PAUSE':(game.mode==='ended'||game.mode==='celebration')?'FIN DU MATCH':'PREMIER SET';
 $('powerVal').textContent=Math.round(charge*100)+'%';$('powerFill').style.width=Math.round(charge*100)+'%';
 $('powerTitle').textContent=game.mode==='serve'&&game.server==='blue'?'PUISSANCE DU SERVICE':charging?(chargeAction==='pass'?'PUISSANCE DE PASSE':'PUISSANCE DE FRAPPE'):'PUISSANCE DE FRAPPE';
 $('hitType').textContent=game.mode==='serve'?(game.server==='blue'?(game.serveStage==='ready'?'Lance : '+formatKey(bindings.jump)+' · Service : '+formatKey(bindings.hit):'Service : '+formatKey(bindings.hit)+' · Double appui : lobé'):'Le serveur rouge se prépare…'):charging?'Relâche '+formatKey(chargeControl)+' · '+(chargeSecondTap?'LOB EN PRÉPARATION':'maintien = puissance'):
  pendingClicks.hit?'Encore '+formatKey(bindings.hit)+' pour lober !':
  pendingClicks.pass?'Encore '+formatKey(bindings.pass)+' pour passer en lob !':
  formatKey(bindings.hit)+' : frappe · ×2 : lob · Double saut + frappe : smash · '+formatKey(bindings.pass)+' : passe';
 $('ballDist').textContent=game.mode==='serve'||game.mode==='live'?'BALLON '+Math.hypot(ball.x-players[0].x,ball.z-players[0].z).toFixed(1)+' m':'BALLON —';
 $('camLabel').textContent='Vue arrière';
 const p=players[0],near=Math.hypot(ball.x-p.x,ball.z-p.z)<P.assist+.6;
 const inSmashJump=p.jumpBoost&&p.inAir&&p.jump>.20;
 const ready=game.mode==='live'&&inSmashJump&&ball.y>2&&near;
 $('smashReady').textContent=game.mode==='serve'?(game.server==='blue'?(game.serveStage==='ready'?'🏐 SERVICE : LANCE '+formatKey(bindings.jump):'🏐 SERVICE : '+formatKey(bindings.hit)+' POUR FRAPPER · ×2 POUR LOBER'):'🏐 SERVICE ROUGE : SOIS PRÊT !'):ready?'💥 SMASH PRÊT : '+formatKey(bindings.hit)+' · ×2 = SMASH LOBÉ':
  p.inAir&&!p.jumpBoost?'↟ SAUT SIMPLE : FRAPPE NORMALE, PAS DE SMASH':
  'SMASH : ×2 '+formatKey(bindings.jump)+' PUIS '+formatKey(bindings.hit)+' · '+formatKey(bindings.practiceSmash)+' POUR TESTER';
 $('smashReady').classList.toggle('ready',game.mode==='live'&&ready);
 const panel=$('servePanel');
 const activeServe=game.mode==='serve';panel.classList.toggle('hidden',!activeServe);
 const rightGuide=$('controlsRight');if(rightGuide)rightGuide.classList.toggle('hidden',activeServe||!helpVisible);
 panel.classList.toggle('red-serving',game.server==='red');
 if(activeServe){
  $('serveEyebrow').textContent=game.server==='blue'?'🏐 SERVICE BLEU — À TOI':'🏐 SERVICE ROUGE — '+redServer().name;
  $('serveTitle').textContent=game.server==='red'?'PRÉPARE LA RÉCEPTION':game.serveStage==='ready'?'PRÉPARE TON SERVICE':'FRAPPE MAINTENANT !';
  $('serveHelp').textContent=game.server==='red'?redServer().name+' va lancer la balle, puis engager.':game.serveStage==='ready'?formatKey(bindings.jump)+' : lancer le ballon · '+formatKey(bindings.hit)+' : frapper':formatKey(bindings.hit)+' : service · ×2 : lobé · Maintenir : puissance';
  $('serveTimer').textContent=game.server==='red'?'L’engagement adverse commence…':game.serveStage==='toss'?'Balle en l’air — frappe avant qu’elle retombe !':'Derrière la ligne de fond · '+Math.ceil(game.serveClock)+' s pour lancer';
 }
 const info=$('jumpStatus');
 if(game.mode==='serve')info.textContent=game.server==='blue'?(game.serveStage==='ready'?'🏐 '+formatKey(bindings.jump)+' : LANCER LE BALLON':'🏐 '+formatKey(bindings.hit)+' : FRAPPER · ×2 : SERVICE LOBÉ'):'🏐 SERVICE ADVERSAIRE · PRÉPARE LA RÉCEPTION';
 else if(p.jumpPrep>0)info.textContent=p.jumpBoost?'⚡ FLEXION · SMASH ACTIVÉ AU DÉCOLLAGE':'↧ FLEXION · DOUBLE APPUI POUR GRAND SAUT';
 else if(p.inAir)info.textContent=p.jumpBoost?'⚡ GRAND SAUT · SMASH ACTIVÉ · TRAJECTOIRE VERROUILLÉE':'↗ SAUT SIMPLE · SANS SMASH · TRAJECTOIRE VERROUILLÉE';
 else if(p.crouch)info.textContent='⬇ ACCROUPI · DÉPLACEMENT LENT';
 else info.textContent='↟ ×2 '+formatKey(bindings.jump)+' : GRAND SAUT + SMASH · ÉLAN CONSERVÉ EN L’AIR';
 info.classList.toggle('boost',p.jumpBoost&&(p.inAir||p.jumpPrep>0));
 info.classList.toggle('airborne',p.inAir);
 // Les retours d'action sont maintenant des bulles au-dessus des joueurs.
}
function playFX(type,strength=.7,x=0,delay=0){audio.play(type,strength,x,delay);}
function hideVictory(){
 const overlay=$('matchCelebration');
 if(overlay)overlay.classList.add('hidden');
}
function startVictory(team,blue=game.blue,red=game.red,isOnline=false){
 if(team!=='blue'&&team!=='red')return;
 game.winTeam=team;
 game.toastTimer=0;toastEl.classList.remove('active');
 game.celebrationUntil=game.elapsed+(isOnline?6.3:5.15);
 const overlay=$('matchCelebration');
 overlay.classList.remove('hidden','victory-blue','victory-red');
 overlay.classList.add(team==='blue'?'victory-blue':'victory-red');
 $('celebrationTeam').textContent=team==='blue'?'LES BLEUS':'LES ROUGES';
 $('celebrationResult').textContent=String(blue)+' — '+String(red);
 $('celebrationSub').textContent=isOnline?'LES GAGNANTS DANSENT · LES PERDANTS PLEURENT !':'LES GAGNANTS DANSENT · LES PERDANTS PLEURENT !';
 $('celebrationFooter').textContent=isOnline?'PROCHAIN MATCH AUTOMATIQUE':'LA REVANCHE ARRIVE…';
 playFX(team===(onlineMode?onlineTeam:'blue')?'victory':'defeat',.75,0,.10);
 players.forEach(p=>sayPlayer(p.id,p.team===team?'ON A GAGNÉ !':'BOUHOU…',2.8));
}

function resetPlayers(){
 for(const p of players){
  const sideIndex=sidePlayers(p.team).indexOf(p);
  const formation=FORMATIONS[game.teamSize][sideIndex];
  p.x=formation[0];p.z=p.team==='blue'?formation[1]:-formation[1];
  p.vx=0;p.vz=0;p.vy=0;p.jump=0;p.inAir=false;p.jumpPrep=0;p.jumpBoost=false;
  p.crouch=false;p.crouchPose=0;p.cool=0;p.dive=0;p.diveBlocked=false;
  p.diveCooldown=0;p.hitAge=9;p.lastHitStyle='normal';p.move=0;
 }
}
function resetMatch(){
 game.teamSize=selectedTeamSize;
 makeRoster();matchChip();walkSoundTimer=0;audio.setActive(true);cancelPendingShots();game.lastCommand='';game.commandCount=0;
 game.blue=0;game.red=0;game.touchTeam=null;game.touchCount=0;game.elapsed=0;game.paused=false;game.hitQueued=null;
 game.passToMate=false;stopCharge();game.actionTimer=0;game.smashFX=0;playerSpeechUntil.fill(0);game.winTeam=null;game.celebrationUntil=0;hideVictory();
 trail.length=0;particles.length=0;game.after='serve';game.camSmooth=null;
 nextServe('blue');showToast('MODE '+game.teamSize+'v'+game.teamSize+' — À TOI DE SERVIR !',2);updateHUD();
}
function play(){audio.unlock();closeOptions();modal.classList.add('hidden');if(game.mode==='ended'||game.mode==='menu')resetMatch();else game.paused=false;audio.setActive(true);canvas.focus?.();}
function showEnd(){hideVictory();game.winTeam=null;closeOptions();game.mode='ended';audio.setActive(false);$('modalTitle').innerHTML=game.blue>game.red?'VICTOIRE !<br/><em>BIEN JOUÉ.</em>':'FIN DU MATCH.<br/><em>REVANCHE ?</em>';$('modalDesc').innerHTML='Résultat en '+game.teamSize+'v'+game.teamSize+' : <strong>'+game.blue+' – '+game.red+'</strong>. Match d’entraînement contre des bots : aucun point de classement. Choisis un nouveau format ou lance la revanche.';$('playBtn').innerHTML='REJOUER <span>↗</span>';modal.classList.remove('hidden');}
function setHeldServeBall(){
 const p=game.server==='blue'?players[0]:redServer(),side=game.server==='blue'?1:-1;
 ball.x=p.x+.64;ball.y=2.02+Math.sin(game.elapsed*2)*.035;ball.z=p.z+side*.12;
 ball.vx=ball.vy=ball.vz=0;
}
function nextServe(team){
 cancelPendingShots();stopCharge();resetPlayers();trail.length=0;
 game.server=team;game.ballLive=false;game.mode='serve';game.paused=false;
 game.serveStage=team==='blue'?'ready':'botWait';game.serveElapsed=0;game.serveClock=12;
 game.timer=team==='blue'?0:1.15;game.hitQueued=null;game.touchTeam=null;game.touchCount=0;game.passToMate=false;
 if(team==='blue'){players[0].x=-1.65;players[0].z=-10.65;}else{redServer().x=-1.5;redServer().z=10.65;}
 setHeldServeBall();showToast(team==='blue'?'TON SERVICE — '+formatKey(bindings.jump)+' POUR LANCER !':'SERVICE ROUGE — PRÉPARE-TOI !',1.7);
}
function tossServe(team){
 if(game.mode!=='serve'||game.server!==team)return;
 if(game.serveStage!==(team==='blue'?'ready':'botWait'))return;
 const p=team==='blue'?players[0]:redServer();game.serveStage=team==='blue'?'toss':'botToss';game.serveElapsed=0;
 ball.x=p.x+.64;ball.y=2.22;ball.z=p.z+(team==='blue'?.15:-.15);
 ball.vx=0;ball.vy=7.4;ball.vz=0;ball.spin=0;
 game.ballLive=false;playFX('windup',.55,ball.x);
 if(team==='blue')showToast('FRAPPE TON SERVICE !',1.0);
}
function serveHit(lob,power,team='blue'){
 if(game.mode!=='serve'||game.server!==team||!(game.serveStage==='toss'||game.serveStage==='botToss'))return false;
 if(ball.y<1.5||ball.y>5.2)return false;
 const p=team==='blue'?players[0]:redServer();
 // Tir réalisé depuis l’endroit réel de la balle lancée ; plus de téléportation.
 const lateral=team==='blue'?clamp(aim.x,-BEACH_X,BEACH_X):rand(-4.1,4.1);
 const depth=team==='blue'?clamp(aim.z,BEACH_NET_GAP,BEACH_Z):rand(-8,-4);
 const usefulPower=clamp(power,.2,1);
 const tz=team==='blue'?lerp(1.15,depth,.33+.67*usefulPower):depth;
 game.touchTeam=team;game.touchCount=1;game.mode='live';game.ballLive=true;game.passToMate=false;
 p.hitAge=0;p.lastHitStyle=lob?'lob':'normal';p.cool=.30;
 game.lastCommand=team==='blue'?(lob?'serveLob':'serve'):'serveBot';game.commandCount++;
 // Service à la fois orientable et chargé : le lob passe plus haut, le service tendu est plus rapide.
 launchTo(lateral,tz,lob?'lob':'normal',lob?.66:usefulPower,team,true);
 contactParticles(ball,team==='blue'?'#8affda':'#ffbd97');
 actionPop(lob?'☁ SERVICE LOBÉ !':'🏐 SERVICE !',team==='blue'?'PUISSANCE '+Math.round(usefulPower*100)+'%':'ENGAGEMENT ADVERSE',p.id);
 showToast(team==='blue'?'SERVICE LANCÉ !':'SERVICE ROUGE !',.85);
 return true;
}
function serviceFault(){
 cancelPendingShots();stopCharge();
 point('red','FAUTE DE SERVICE');
}

function point(team,why='',ground=false){if(game.mode!=='live'&&game.mode!=='serve')return;cancelPendingShots();stopCharge();game.mode='point';game.ballLive=false;game.timer=1.55;game.blue+=(team==='blue'?1:0);game.red+=(team==='red'?1:0);game.server=team;game.pointReason=why;if(ground)playFX('pointFun',.78,0,.15);else playFX('score',.54,0,.12);showToast((team==='blue'?'POINT BLEU ! ':'POINT ROUGE ! ')+(why||''),1.5);game.after=hasMatchWinner(game.blue,game.red)?'end':'serve';updateHUD();}
function contactParticles(pos,color){for(let i=0;i<13;i++){let ang=rand(0,TAU);particles.push({x:pos.x,y:pos.y,z:pos.z,vx:Math.cos(ang)*rand(1,4),vy:rand(1,5),vz:Math.sin(ang)*rand(1,4),life:.42,color});}}
function launchTo(tx,tz,kind,power,team,isServe=false){let dx=tx-ball.x,dz=tz-ball.z,d=Math.hypot(dx,dz);let flight=kind==='lob'||kind==='passLob'?1.62+(.55*(1-power)):kind==='smash'?(0.53+.24*(1-power))/P.smash:kind==='smashLob'?(1.1+.24*(1-power))/Math.sqrt(P.smash):kind==='pass'?.95+.24*(1-power):1.06+.40*(1-power);flight=Math.max(flight,d/21);const landHeight=kind==='pass'||kind==='passLob'?1.35:.42;ball.vx=dx/flight;ball.vz=dz/flight;ball.vy=(landHeight-ball.y+.5*P.gravity*flight*flight)/flight;ball.spin+=(power+.4)*4;game.ballLive=true;if(isServe)playFX('serve',power*.8,ball.x);if(!isServe){if(game.touchTeam===team){game.touchCount++;if(game.touchCount>3){point(team==='blue'?'red':'blue','4 TOUCHES');return;}}else{game.touchCount=1;game.touchTeam=team;}contactParticles(ball,team==='blue'?'#78dfff':'#ffae87');playFX(kind==='normal'?'hit':kind, power*(team==='blue'?1:.88),ball.x);}}
function userHit(kind,power){
 if(game.mode!=='live')return false;
 const p=players[0], d=Math.hypot(ball.x-p.x,ball.z-p.z), vertical=Math.abs(ball.y-(p.jump+1.65));
 const isPass=kind==='pass'||kind==='passLob';
 const isSmash=kind==='smash'||kind==='smashLob';
 if(isSmash&&(!p.jumpBoost||!p.inAir||p.jump<.20||ball.y<2.1))return false; // Smash uniquement après double appui de saut.
 if(d>P.assist+(p.dive>0?1.2:0)||vertical>2.15||p.cool>0)return false;
 const mode=kind;
 const accuracy=clamp(1-vertical/3.2-.12*d/P.assist,.4,1),jitter=(1-accuracy)*1.65+Math.max(0,power-.84)*.85;
 const mate=isPass?choosePassReceiver(p):null;
 const tx=isPass?(mate?mate.x:p.x+(.3*Math.sign(p.x||1))):clamp(aim.x+rand(-jitter,jitter),-BEACH_X,BEACH_X);
 const tz=isPass?(mate?mate.z:p.z+1.45):clamp(aim.z+rand(-jitter,jitter),BEACH_NET_GAP,BEACH_Z);
 const passPower=kind==='passLob'?.63:.75;
 launchTo(tx,tz,mode,isPass?passPower:clamp(power*.72+.2,.25,1),p.team);
 game.passToMate=isPass;p.hitAge=0;p.lastHitStyle=mode;p.cool=isSmash?.57:.40;
 if(mode==='smash'){
  game.smashFX=.50;contactParticles(ball,'#ffe475');contactParticles(ball,'#ffffff');
  actionPop('💥 SMASH !','PUISSANCE '+Math.round(power*100)+'%');
 }else if(mode==='smashLob'){
  game.smashFX=.42;contactParticles(ball,'#cdfbff');contactParticles(ball,'#ffe475');
  actionPop('☄ SMASH LOBÉ !','ATTAQUE HAUTE');
 }else if(p.dive>0&&isPass){actionPop('🛟 SAUVETAGE !',mode==='passLob'?'Passe lobée sauvée':'Plongeon réussi');}
 else if(mode==='passLob'){actionPop('☁ PASSE LOBÉE !',mate?'Pour '+mate.name:'Pour soi');}
 else if(mode==='pass'){actionPop('↗ PASSE !',mate?'Pour '+mate.name:'Pour soi');}
 else if(mode==='lob'){actionPop('☁ LOB !','Trajectoire haute');}
 else{actionPop('✦ FRAPPE !','Bien joué');}
 return true;
}
function requestHit(mode,power){
 if(game.mode!=='live'||game.paused)return;
 game.lastCommand=mode;game.commandCount++;
 game.hitQueued={mode,power,life:mode==='smash'||mode==='smashLob'?.65:.43};
 if(userHit(mode,power))game.hitQueued=null;
 else if((mode==='smash'||mode==='smashLob')&&!players[0].jumpBoost)showToast('SMASH : DOUBLE APPUI '+formatKey(bindings.jump)+' PUIS '+formatKey(bindings.hit)+' !',.8);
}
function aiHit(p){if(p.cool>0||game.mode!=='live')return;let d=Math.hypot(ball.x-p.x,ball.z-p.z),vertical=Math.abs(ball.y-(p.jump+1.65));if(d>1.76||vertical>1.75)return;let team=p.team,targetZ=team==='blue'?rand(3.3,8.5):rand(-8.5,-3.2),targetX=rand(-4.4,4.4);
  // Le partenaire essaie souvent de garder les échanges accessibles.
  if(team==='blue'&&Math.random()<.35){targetX=rand(-3.5,3.5);targetZ=rand(3.5,7.8);}
  if(team==='red'&&Math.random()<.65){targetX=clamp(players[0].x+rand(-2.8,2.8),-5.2,5.2);targetZ=clamp(players[0].z+rand(-2.5,2.5),-8.5,-2.0);}
  if(p.team==='blue')game.passToMate=false;const style=Math.random()<.22?'lob':Math.random()<.12&&ball.y>2.75?'smash':'normal';launchTo(targetX,targetZ,style,rand(.53,.9),team);p.hitAge=0;p.cool=.55;sayPlayer(p.id,style==='smash'?'SMASH':style==='lob'?'LOB':'FRAPPE',.80);}
function timeToLand(){let g=P.gravity,disc=Math.max(0,ball.vy*ball.vy+2*g*(ball.y-BALL_R));return clamp((ball.vy+Math.sqrt(disc))/g,0,3);}
function predictedLanding(){let t=timeToLand();return{x:ball.x+ball.vx*t,z:ball.z+ball.vz*t};}
function moveBot(p,tx,tz,dt){
 const bounds=playableLimits(p);tx=clamp(tx,bounds.minX,bounds.maxX);tz=clamp(tz,bounds.minZ,bounds.maxZ);
 if(p.inAir){moveWithBounds(p,dt);p.move=Math.hypot(p.vx,p.vz);return;}
 let dx=tx-p.x,dz=tz-p.z,d=Math.hypot(dx,dz),speed=p.team==='blue'?6.25:6.55;
 let step=Math.min(d,speed*dt);
 p.vx=d>.05?dx/d*(step/dt):0;p.vz=d>.05?dz/d*(step/dt):0;
 p.x+=p.vx*dt;p.z+=p.vz*dt;p.move=Math.hypot(p.vx,p.vz);
 if(game.mode==='live'&&p.cool<=0){let bb=Math.hypot(ball.x-p.x,ball.z-p.z);if(bb<2.3&&ball.y>2.9&&ball.vy<1.2){p.vy=7.8;p.inAir=true;}}
}
function choosePassReceiver(p){
 // En 1v1, le clic droit prépare une passe à soi-même pour enchaîner une attaque.
 const mates=players.filter(q=>q.team===p.team&&q.id!==p.id);
 if(!mates.length)return null;
 // Préférer un partenaire proche du filet mais accessible (éviter la passe à un joueur sur nous).
 return mates.reduce((best,q)=>{
  const score=q.z*.42+(Math.hypot(q.x-p.x,q.z-p.z)<1.3?-9:0)-Math.abs(q.x-p.x)*.07;
  return !best||score>best.score?{q,score}:best;
 },null).q;
}
function formationTarget(team,index){
 const raw=FORMATIONS[game.teamSize][index]||[0,-5];
 return{x:raw[0],z:team==='blue'?raw[1]:-raw[1]};
}
function updateBots(dt){
 if(game.mode==='serve')return;
 const land=predictedLanding();
 for(const team of ['blue','red']){
  const side=sidePlayers(team),bots=side.filter(p=>p.id!==0);
  if(!bots.length)continue;
  const ballIncoming=game.mode==='live' && (team==='blue'?ball.vz<0&&land.z<-.3:ball.vz>0&&land.z>.3);
  let receiver=null;
  if(ballIncoming){
   // Un humain assez proche de la trajectoire reçoit prioritairement, les bots assurent la couverture.
   const humanClose=team==='blue'&&Math.hypot(players[0].x-land.x,players[0].z-land.z)<2.75&&!game.passToMate;
   if(!humanClose)receiver=bots.reduce((best,p)=>!best||dist2([p.x,0,p.z],[land.x,0,land.z])<dist2([best.x,0,best.z],[land.x,0,land.z])?p:best,null);
  }
  bots.forEach((p)=>{
   if(p===receiver)moveBot(p,land.x,land.z,dt);
   else{
    const ownIndex=side.indexOf(p),f=formationTarget(team,ownIndex);
    // Les partenaires sans ballon couvrent leur zone sans tous converger sous la balle.
    const coverX=clamp(f.x+(ballIncoming?(land.x-f.x)*.12:0),-COURT_X+.6,COURT_X-.6);
    const coverZ=clamp(f.z+(ballIncoming?(land.z-f.z)*.08:0),team==='blue'?-8.8:1.5,team==='blue'?-1.5:8.8);
    moveBot(p,coverX,coverZ,dt);
   }
  });
  bots.forEach(aiHit);
 }
}
// Sur cette caméra arrière, le côté droit de l'écran correspond à X négatif dans le monde.
function startDive(){
 if(game.mode!=='live'||game.paused)return;
 const p=players[0];if(p.dive>0||p.diveCooldown>0||p.inAir||p.jumpPrep>0)return;
 let dx=(keys.has(bindings.left)?1:0)-(keys.has(bindings.right)?1:0),dz=(keys.has(bindings.forward)?1:0)-(keys.has(bindings.back)?1:0);
 if(Math.hypot(dx,dz)<.1){dx=(ball.x-p.x)*.6;dz=ball.z-p.z;}
 const len=Math.hypot(dx,dz)||1;
 p.diveVX=dx/len;p.diveVZ=dz/len;p.dive=.70;p.diveBlocked=false;p.diveCooldown=1.30;p.vy=0;p.vx=0;p.vz=0;p.jump=0;p.inAir=false;p.jumpPrep=0;p.jumpBoost=false;
 for(let i=0;i<20;i++){let a=rand(0,TAU),speed=rand(1,4.4);particles.push({x:p.x,y:.12,z:p.z,vx:Math.cos(a)*speed,vy:rand(.2,2.1),vz:Math.sin(a)*speed,life:rand(.35,.7),color:i%3?'#ead1a7':'#fef2dc'});}
 playFX('dive',.92,p.x);actionPop('🏐 PLONGEON !','Sauve la balle !');
}
function moveWithBounds(p,dt){
 const oldX=p.x,oldZ=p.z,bounds=playableLimits(p);
 const desiredX=p.x+p.vx*dt,desiredZ=p.z+p.vz*dt;
 p.x=clamp(desiredX,bounds.minX,bounds.maxX);
 p.z=clamp(desiredZ,bounds.minZ,bounds.maxZ);
 // Seules les barrières extérieures et la séparation entre équipes bloquent le déplacement.
 if(p.x!==desiredX && Math.abs(p.vx)>0)p.vx=0;
 if(p.z!==desiredZ && Math.abs(p.vz)>0)p.vz=0;
}
function startJumpPreparation(){
 const p=players[0];
 if(game.mode!=='live'||game.paused||p.inAir||p.dive>0||p.diveCooldown>1.05)return;
 if(p.jumpPrep>0){
   if(!p.jumpBoost){p.jumpBoost=true;p.jumpPrep=.30;playFX('windup',.55,p.x);actionPop('⚡ GRAND SAUT !','FLEXION AVANT LE DÉCOLLAGE');}
   return;
 }
 p.jumpPrep=JUMP_TAP_WINDOW;p.jumpBoost=false;
}
function launchPlayerJump(p){
 // La vitesse horizontale est calculée AVANT le décollage, puis figée.
 p.inAir=true;p.vy=p.jumpBoost?CHARGED_JUMP_SPEED:JUMP_SPEED;p.jumpPrep=0;
 if(p.jumpBoost){
   showToast('⚡ GRAND SAUT : SMASH DISPONIBLE !',.8);
   for(let i=0;i<16;i++){let a=rand(0,TAU),r=rand(1,3);particles.push({x:p.x,y:.1,z:p.z,vx:Math.cos(a)*r,vy:rand(.3,2.2),vz:Math.sin(a)*r,life:rand(.2,.52),color:'#fff1b8'});}
   playFX('jump',.95,p.x);
 }else playFX('jump',.45,p.x);
}
let walkSoundTimer=0;
function updateHuman(dt){
 const p=players[0];const left=keys.has(bindings.left),right=keys.has(bindings.right),fwd=keys.has(bindings.forward),back=keys.has(bindings.back);
 const crouching=keys.has(bindings.crouch)&&!p.inAir&&p.dive<=0;
 p.crouch=crouching;
 const pose=p.jumpPrep>0?(p.jumpBoost?1:.55):crouching?.82:0;
 p.crouchPose=lerp(p.crouchPose,pose,Math.min(1,dt*15));
 if(p.dive>0){
   let phase=1-p.dive/.70;
   let speed=p.diveBlocked?0:15*(phase<.2?1:phase<.65?.8:.35);
   const bounds=playableLimits(p);
   p.x=clamp(p.x+p.diveVX*speed*dt,bounds.minX,bounds.maxX);
   p.z=clamp(p.z+p.diveVZ*speed*dt,bounds.minZ,bounds.maxZ);
   p.move=speed;
   if(game.mode==='live'&&p.cool<=0&&ball.y<2.3&&Math.hypot(ball.x-p.x,ball.z-p.z)<2.1)userHit('pass',.65);
   return;
 }
 if(p.inAir){
   // AUCUNE modification des vitesses X/Z par les touches en vol : inertie pure.
   moveWithBounds(p,dt);
   p.move=Math.hypot(p.vx,p.vz);
   return;
 }
 const dx=(left?1:0)-(right?1:0),dz=(fwd?1:0)-(back?1:0),mag=Math.hypot(dx,dz);
 const topSpeed=P.speed*(p.jumpPrep>0&&p.jumpBoost?.55:crouching?.46:1);
 const targetX=mag>0?dx/mag*topSpeed:0,targetZ=mag>0?dz/mag*topSpeed:0;
 // Accélération et freinage progressifs : un vrai élan à conserver au décollage.
 const approach=(current,target,maxDelta)=>current+clamp(target-current,-maxDelta,maxDelta);
 const accel=(mag?GROUND_ACCEL:p.jumpPrep>0?GROUND_BRAKE*.30:GROUND_BRAKE)*dt;
 p.vx=approach(p.vx,targetX,accel);p.vz=approach(p.vz,targetZ,accel);
 p.move=Math.hypot(p.vx,p.vz);
 if(p.move>3.2&&p.jumpPrep<=0&&!p.crouch){
   walkSoundTimer-=dt;
   if(walkSoundTimer<=0){playFX('step',clamp(p.move/P.speed,.35,.95),p.x);walkSoundTimer=.37-clamp(p.move/P.speed,0,1)*.1;}
 }else walkSoundTimer=0;
 moveWithBounds(p,dt);
 if(p.jumpPrep>0){
   p.jumpPrep=Math.max(0,p.jumpPrep-dt);
   if(p.jumpPrep===0)launchPlayerJump(p);
 }
}
// ---------- Collisions physiques entre joueurs ----------
// Corps = capsule 2D sur le sol (cercle debout, capsule allongée en plongeon).
// Test de recouvrement vertical : une personne sautant vraiment AU-DESSUS d'une autre
// peut passer, mais deux corps qui se touchent ne peuvent plus se traverser.
const BODY_RADIUS=.62;
const DIVE_RADIUS=.50;
const DIVE_HALF_LENGTH=.98;
function collisionBody(p){
 const prone=p.dive>0;
 const f=prone?DIVE_HALF_LENGTH:0;
 return {
   ax:p.x-p.diveVX*f,az:p.z-p.diveVZ*f,
   bx:p.x+p.diveVX*f,bz:p.z+p.diveVZ*f,
   radius:prone?DIVE_RADIUS:BODY_RADIUS,
   base:prone?0:p.jump,
   top:prone?1.05:p.jump+2.65*(1-.36*p.crouchPose)
 };
}
// Points les plus proches entre deux segments en 2D, y compris points dégénérés.
function closestSegments(a,b){
 const ux=a.bx-a.ax,uz=a.bz-a.az,vx=b.bx-b.ax,vz=b.bz-b.az;
 const wx=a.ax-b.ax,wz=a.az-b.az;
 const aa=ux*ux+uz*uz,bb=ux*vx+uz*vz,cc=vx*vx+vz*vz;
 const dd=ux*wx+uz*wz,ee=vx*wx+vz*wz;
 let t=0,s=0;
 if(aa<1e-9&&cc<1e-9){/* les deux sont debout */}
 else if(aa<1e-9){s=clamp(ee/cc,0,1);}
 else if(cc<1e-9){t=clamp(-dd/aa,0,1);}
 else{
   const denom=aa*cc-bb*bb;
   t=denom>1e-9?clamp((bb*ee-cc*dd)/denom,0,1):0;
   s=(bb*t+ee)/cc;
   if(s<0){s=0;t=clamp(-dd/aa,0,1);}
   else if(s>1){s=1;t=clamp((bb-dd)/aa,0,1);}
 }
 return {ax:a.ax+t*ux,az:a.az+t*uz,bx:b.ax+s*vx,bz:b.az+s*vz};
}
function clampPlayerToCourt(p){
 const bounds=playableLimits(p);
 p.x=clamp(p.x,bounds.minX,bounds.maxX);
 p.z=clamp(p.z,bounds.minZ,bounds.maxZ);
}
function resolvePlayerCollisions(){
 // Plusieurs passes stabilisent les contacts entre trois personnes et les bords.
 for(let pass=0;pass<5;pass++){
   let contacts=0;
   for(let i=0;i<players.length;i++)for(let j=i+1;j<players.length;j++){
     const a=players[i],b=players[j];
     const ca=collisionBody(a),cb=collisionBody(b);
     if(ca.top<=cb.base+.01||cb.top<=ca.base+.01)continue;
     const near=closestSegments(ca,cb);
     let nx=near.ax-near.bx,nz=near.az-near.bz;
     let d=Math.hypot(nx,nz),minD=ca.radius+cb.radius;
     if(d>=minD-.0001)continue;
     contacts++;
     if(d<.00001){
       // Centres ou segments confondus : choisir un axe déterministe.
       nx=a.x-b.x;nz=a.z-b.z;d=Math.hypot(nx,nz);
       if(d<.00001){nx=i%2===0?-1:1;nz=0;d=1;}
     }
     nx/=d;nz/=d; // de B vers A
     const overlap=minD-Math.hypot(near.ax-near.bx,near.az-near.bz)+.001;
     // Une collision de plongée ne transforme pas le plongeur en bulldozer.
     const wa=a.dive>0?.55:1,wb=b.dive>0?.55:1,sum=wa+wb;
     a.x+=nx*overlap*wa/sum;a.z+=nz*overlap*wa/sum;
     b.x-=nx*overlap*wb/sum;b.z-=nz*overlap*wb/sum;
     clampPlayerToCourt(a);clampPlayerToCourt(b);
     // Supprimer uniquement la composante de vitesse qui pénètre le corps adverse.
     // En vol, la souris / le clavier ne réorientent pas : seul le choc peut ralentir.
     const closing=(a.vx-b.vx)*nx+(a.vz-b.vz)*nz;
     if(closing<0){const impulse=-closing/sum;
       a.vx+=nx*impulse*wa;a.vz+=nz*impulse*wa;
       b.vx-=nx*impulse*wb;b.vz-=nz*impulse*wb;
     }
     // Si le plongeur heurte un joueur devant lui, sa glissade s'arrête.
     if(a.dive>0 && (b.x-a.x)*a.diveVX+(b.z-a.z)*a.diveVZ>0.06)a.diveBlocked=true;
     if(b.dive>0 && (a.x-b.x)*b.diveVX+(a.z-b.z)*b.diveVZ>0.06)b.diveBlocked=true;
   }
   if(!contacts)break;
 }
}
function updatePlayers(dt){
 for(let p of players){
   p.hitAge+=dt;p.cool=Math.max(0,p.cool-dt);p.diveCooldown=Math.max(0,p.diveCooldown-dt);p.dive=Math.max(0,p.dive-dt);
   if(p.inAir){p.jump+=p.vy*dt;p.vy-=21*dt;
     if(p.jump<=0){if(p.id===0)playFX('land',clamp(-p.vy/10,.35,1),p.x);p.jump=0;p.vy=0;p.inAir=false;p.jumpBoost=false;p.crouchPose=0;}
   }
 }
}
function updatePhysics(dt){if(game.mode==='serve'){
  if(game.server==='blue'&&game.serveStage==='ready'){
   game.serveClock-=dt;
   setHeldServeBall();
   if(game.serveClock<=0)serviceFault();
   return;
  }
  if(game.server==='red'&&game.serveStage==='botWait'){
   setHeldServeBall();game.timer-=dt;
   if(game.timer<=0)tossServe('red');
   return;
  }
  if(game.serveStage==='toss'||game.serveStage==='botToss'){
   game.serveElapsed+=dt;
   ball.vy-=P.gravity*.66*dt;ball.y+=ball.vy*dt;ball.spin+=dt*4;
   if(game.serveStage==='botToss'&&game.serveElapsed>.53){serveHit(false,.66+Math.random()*.20,'red');return;}
   if(ball.y<=BALL_R||game.serveElapsed>1.9){if(game.server==='blue')serviceFault();else point('blue','FAUTE DE SERVICE ROUGE');}
   return;
  }
  return;
 }

  if(game.mode==='point'){game.timer-=dt;if(game.timer<=0){if(game.after==='end'){game.mode='celebration';startVictory(matchWinnerTeam(game.blue,game.red),game.blue,game.red,false);}else nextServe(game.server);}return;}
  if(game.mode!=='live')return;
  const prevz=ball.z;
  ball.vy-=P.gravity*dt;ball.x+=ball.vx*dt;ball.y+=ball.vy*dt;ball.z+=ball.vz*dt;ball.spin+=dt*8;
  // Collision physique avec le filet si la balle passe trop bas.
  if(prevz*ball.z<=0&&Math.abs(ball.x)<COURT_X+.2&&ball.y-BALL_R<NET){
   const netStrength=clamp(Math.hypot(ball.vx,ball.vy,ball.vz)/21,.22,1);
   playFX(Math.abs(ball.x)>COURT_X-.35?'pole':'net',netStrength,ball.x);
   ball.z=Math.sign(prevz||-1)*BALL_R*.7;ball.vz*=-.22;ball.vy=Math.max(.6,ball.vy*.45);showToast('LE FILET !',.6);
  }
  if(ball.y<=BALL_R){playFX('ground',clamp(-ball.vy/12,.22,1),ball.x);let inside=isInsideCourt(ball.x,ball.z);let winning=inside?(ball.z<0?'red':'blue'):(game.touchTeam==='blue'?'red':'blue');point(winning,inside?'':'DEHORS !',inside);ball.y=BALL_R;return;}
  if(Math.abs(ball.x)>23||Math.abs(ball.z)>31)point(game.touchTeam==='blue'?'red':'blue','DEHORS !');
  if(game.hitQueued){game.hitQueued.life-=dt;if(userHit(game.hitQueued.mode,game.hitQueued.power))game.hitQueued=null;else if(game.hitQueued.life<=0){showToast('TROP LOIN DU BALLON',.65);game.hitQueued=null;}}
  if(Math.random()<.50){trail.unshift({x:ball.x,y:ball.y,z:ball.z,life:.22});if(trail.length>14)trail.pop();}
}
function updateParticles(dt){for(let i=trail.length-1;i>=0;i--){trail[i].life-=dt;if(trail[i].life<=0)trail.splice(i,1);}for(let i=particles.length-1;i>=0;i--){let q=particles[i];q.x+=q.vx*dt;q.y+=q.vy*dt;q.z+=q.vz*dt;q.vy-=P.gravity*dt*.4;q.life-=dt;if(q.life<=0)particles.splice(i,1);}}
function step(dt){if(onlineMode){game.elapsed+=dt;game.toastTimer-=dt;if(game.toastTimer<=0)toastEl.classList.remove('active');if(charging)charge=clamp((performance.now()-chargeStart)/850,0,1);else charge=0;onlineTick(dt);updateParticles(dt);return;}game.elapsed+=dt;game.actionTimer=Math.max(0,game.actionTimer-dt);game.smashFX=Math.max(0,game.smashFX-dt);game.toastTimer-=dt;if(game.toastTimer<=0)toastEl.classList.remove('active');if(charging){charge=clamp((performance.now()-chargeStart)/850,0,1);}else charge=0;
  if(game.mode==='celebration'){if(game.elapsed>=game.celebrationUntil)showEnd();updateHUD();return;}
  if(game.mode==='menu'||game.mode==='ended'||game.paused){updateHUD();return;}
  updateHuman(dt);updateBots(dt);updatePlayers(dt);resolvePlayerCollisions();updatePhysics(dt);updateParticles(dt);updateHUD();}

// ---------- Caméras, décor 3D et personnages ----------
const decorRocks=Array.from({length:65},(_,i)=>{let t=i*13.91,s=Math.sin(i*42.82),x=clamp(Math.sin(t)*20,-26,26),z=Math.cos(i*12.234)*22;return{x,z,r:.1+Math.abs(s)*.23};}).filter(o=>Math.abs(o.x)>7.1||Math.abs(o.z)>11);
const palmData=[[-16,-1,4.5],[17,13,5],[-18,15,4.4],[18,-18,4.8],[-18,-18,4.3]];
function drawPalm(x,z,h,idx){let top=v(x+(idx%2?-.6:.7),h,z+.2);beam(v(x,.12,z),top,.22,'#a36e40');for(let i=0;i<7;i++){let a=i/7*TAU+idx;let ext=2.2+((i+idx)%3)*.24;let end=v(top[0]+Math.cos(a)*ext,top[1]-.9,top[2]+Math.sin(a)*ext);beam(top,end,.14,i%2===0?'#3d986c':'#59b87d');sphere(end[0],end[1],end[2],.45,.18,.7,'#50a46b',{yaw:a});}sphere(top[0],top[1],top[2],.7,.44,.7,'#34855b');}
function drawWorld(){
  // Plage et océan éloigné (réelles géométries 3D éclairées).
  cube(0,-.30,0,90,.37,100,'#ddbc82');cube(0,-.255,40,100,.18,52,'#4fb7ca');
  for(let j=0;j<8;j++)cube(0,-.137,18+j*4,70,.015,.055,j%2?'#b7e6e4':'#8ddada');
  cube(0,-.18,0,27.5,.28,25.3,'#f1cc8f');
  cube(0,-.032,-5,12.7,.022,9.8,'#ebca96');cube(0,-.03,5,12.7,.022,9.8,'#f0cf93');
  // Marquage visible des lignes.
  for(const x of [-COURT_X,COURT_X])cube(x,.045,0,.10,.055,COURT_Z*2,'#fff5df',{flat:true});
  for(const z of [-COURT_Z,COURT_Z])cube(0,.045,z,COURT_X*2,.055,.10,'#fff5df',{flat:true});
  // Marques de jeu : ligne d'attaque discrète.
  for(let z of [-3.2,3.2])for(let x=-5.4;x<5.4;x+=1.4)cube(x,.048,z,.72,.028,.045,'#fff0cd',{alpha:.42,flat:true});
  // Barrières et panneaux de plage.
  for(let z of [-13,13]){for(let i=-13;i<=13;i+=2.7){cube(i,.62,z,.16,1.25,.2,'#aa7949');}beam(v(-13,1.05,z),v(13,1.05,z),.08,'#9e6e42');}
  for(let x of [-14,14]){for(let z=-11;z<=11;z+=3.0)cube(x,.6,z,.22,1.2,.22,'#a7794c');}
  // Bannières publicitaires stylisées.
  for(let z of [-12.85,12.85])for(let x of [-6.4,0,6.4])cube(x,.75,z+(z>0?-.11:.11),5.1,.65,.08,x===0?'#163e61':'#185a7a');
  for(let o of (software?decorRocks.slice(0,9):decorRocks))sphere(o.x,.02,o.z,o.r,.065,o.r*.74,(Math.sin(o.x*21)>0?'#f6d9a1':'#cab084'));
  (software?palmData.slice(0,2):palmData).forEach((a,i)=>drawPalm(...a,i));
  // parasols derrière le terrain
  for(let [x,z] of (software?[]:[[-11,-11.3],[11,10.6],[11,-12]])){beam(v(x,.1,z),v(x,3.2,z),.09,'#b7aa8a');sphere(x,3.2,z,3,.48,3,x<0?'#e67d61':'#eee6cf');}
}
function drawServiceGuides(){
  // Repères derrière les lignes de fond pendant le service.
  if(game.mode==='serve'){
   const zz=game.server==='blue'?-10.85:10.85;
   for(let x=-5.8;x<5.8;x+=1.18)cube(x,.048,zz,.73,.025,.07,game.server==='blue'?'#7debd7':'#ffb29f',{alpha:.84,flat:true});
   ring(game.server==='blue'?players[0].x:redServer().x,zz,.90,game.server==='blue'?'#65ffd6':'#ffd29b',.75);
  }
}
function drawNet(){for(const x of [-6.8,6.8]){beam(v(x,0,0),v(x,3,0),.105,'#536f82');sphere(x,3,0,.20,.20,.20,'#e2f4f4');}beam(v(-6.75,NET,0),v(6.75,NET,0),.064,'#fffdf4',{flat:true});beam(v(-6.75,.24,0),v(6.75,.24,0),.025,'#e4f4ef',{flat:true});for(let x=-6.5;x<6.5;x+=(software?1.25:.50))beam(v(x,.24,0),v(x,NET,0),.013,'#dcefea',{alpha:.88,flat:true});for(let y=.45;y<NET;y+=(software?.72:.28))beam(v(-6.7,y,0),v(6.7,y,0),.011,'#e2f3ef',{alpha:.82,flat:true});}
function drawPlayer(p){
  const inCeremony=!!game.winTeam&&(game.mode==='celebration'||game.mode==='ended');
  const dancing=inCeremony&&p.team===game.winTeam,sad=inCeremony&&!dancing;
  const beat=game.elapsed*8+p.id*1.6;
  let y=p.jump+(dancing?.16+Math.max(0,Math.sin(beat))*.37:0),x=p.x+(dancing?Math.sin(beat*.5)*.20:0),z=p.z,blue=p.team==='blue',jersey=blue?'#217bd9':'#e45e56',shorts=blue?'#163d7a':'#7b3046',skin=blue?'#e6ab87':'#d6a07c';
  // ombre géométrique adoucie
  sphere(x,.012,z,.94,.016,.65,'#1e4662',{alpha:.15,flat:true});
  // Véritable animation de plongeon : corps horizontal, bras devant, jambes derrière.
  if(p.dive>0&&!inCeremony){
    const f=v(p.diveVX,0,p.diveVZ),perp=v(-f[2],0,f[0]);
    const phase=1-p.dive/.70, height=phase<.13?.45+.65*(1-phase/.13):phase>.84?.45+.55*((phase-.84)/.16):.45;
    const yaw=Math.atan2(f[0],f[2]);
    const po=(a,b=0,h=height)=>v(x+f[0]*a+perp[0]*b,h,z+f[2]*a+perp[2]*b);
    sphere(x,.018,z,1.18,.022,.75,'#1a435c',{alpha:.19,flat:true});
    const torso=po(.10,0,height+.05);sphere(torso[0],torso[1],torso[2],.90,.57,1.30,jersey,{yaw});
    const head=po(.92,0,height+.02);sphere(head[0],head[1],head[2],.64,.65,.62,skin);
    const hair=po(.88,0,height+.34);sphere(hair[0],hair[1],hair[2],.59,.19,.56,'#2d3036');
    for(let s of [-1,1]){
      const shoulder=po(.47,s*.32,height+.11),elbow=po(.92,s*.48,height-.06),hand=po(1.50,s*.49,height-.07);
      beam(shoulder,elbow,.14,skin);beam(elbow,hand,.11,skin);sphere(hand[0],hand[1],hand[2],.23,.23,.23,skin);
      const hip=po(-.43,s*.22,height-.07),knee=po(-.94,s*.25,.29),foot=po(-1.38,s*.24,.23);
      beam(hip,knee,.15,shorts);beam(knee,foot,.12,skin);sphere(foot[0],foot[1],foot[2],.34,.23,.52,'#eaf6fa',{yaw});
    }
    // Ligne de vitesse et sable soulevé le long de la glissade.
    if(p.id===0&&phase<.65){for(let i=0;i<3;i++){const a=po(-.7-i*.23,(i-1)*.46,.09);sphere(a[0],a[1],a[2],.20,.09,.20,'#fff1cc',{alpha:.55,flat:true});}}
    const lab=labelEls[p.id],sp=screenProject(v(x,height+.85,z));if(sp){lab.style.left=sp.x+'px';lab.style.top=sp.y+'px';lab.style.opacity='1';}else lab.style.opacity='0';lab.querySelector('.player-speech').classList.toggle('speaking',game.mode!=='menu' && playerSpeechUntil[p.id]>game.elapsed);
    return;
  }
  // Flexion des jambes : tête / tronc s'abaissent nettement, pieds restent au sol.
  const hScale=1-.36*p.crouchPose-(sad?.18:0), H=h=>y+h*hScale;
  let stride=dancing?Math.sin(beat)*.38:sad?0:p.move>1?Math.sin(game.elapsed*12+p.id)*.27:0;
  let waist=v(x,H(1.00),z),lHip=v(x-.19,H(1.0),z),rHip=v(x+.19,H(1.0),z),lFoot=v(x-.23,y+.12,z+stride),rFoot=v(x+.23,y+.12,z-stride);
  for(let [hip,foot] of [[lHip,lFoot],[rHip,rFoot]]){let knee=v((hip[0]+foot[0])*.5,H(.58), (hip[2]+foot[2])*.5-.1);beam(hip,knee,.14,shorts);beam(knee,foot,.11,skin);sphere(foot[0],foot[1],foot[2]-.1,.39,.20,.57,'#f1f6f9');}
  sphere(x,H(1.34),z,.94,1.08*hScale,.62,jersey);cube(x,H(.93),z,.57,.27*hScale,.53,shorts);
  let attacking=p.hitAge<.38,smashing=attacking&&(p.lastHitStyle==='smash'||p.lastHitStyle==='smashLob'),serving=game.mode==='serve'&&p.id===(game.server==='blue'?0:2),armLift=dancing?1.35+.30*Math.sin(beat):sad?-.40:smashing?1.75:attacking?1.03:serving?.62:.15;
  for(let side of [-1,1]){
    let shoulder=v(x+side*.39,H(1.58),z),elbow=v(x+side*.64,H(1.2+armLift*(dancing?1:side===1?1:.2)),z+(dancing?Math.sin(beat+side)*.36:attacking?.30:.04)),hand=v(x+side*.67,H(1.04+armLift*(dancing?1.13:side===1?1.1:.2)),z+(dancing?Math.sin(beat+side)*.52:attacking?.60:.16));
    beam(shoulder,elbow,.14,skin);beam(elbow,hand,.12,skin);sphere(hand[0],hand[1],hand[2],.22,.22,.22,skin);
  }
  sphere(x+(sad?.09:0),H(2.07),z,.68,.73,.64,skin);sphere(x,H(2.31),z-.025,.72,.25,.67,p.id%2===0?'#253343':'#3d2b25');
  if(sad){const faceZ=z+(blue?.40:-.40),tearY=H(1.91)+Math.sin(game.elapsed*7+p.id)*.025;sphere(x-.19,tearY,faceZ,.095,.18,.07,'#70dfff');sphere(x+.19,tearY-.07,faceZ,.09,.15,.065,'#70dfff');}
  if(smashing)beam(v(x+.52,H(2.45),z),v(x+.9,H(3.58),z+.52),.11,'#f9e69a',{alpha:.85});
  cube(x,H(2.19),z+(blue?.3:-.3),.72,.10,.10,blue?'#77edff':'#ffe1a5');
  if(p.id===0){ring(x,z,.62,'#90ffdb',.87);
    if(p.jumpPrep>0&&p.jumpBoost){ring(x,z,.90,'#ffeb92',.95);}
    if(p.inAir&&Math.hypot(p.vx,p.vz)>.3){
      const le=Math.min(1.65,Math.hypot(p.vx,p.vz)*.20);
      const d=Math.hypot(p.vx,p.vz);beam(v(x,.07,z),v(x+p.vx/d*le,.07,z+p.vz/d*le),.055,'#8effd9',{alpha:.75,flat:true});
    }
  }
  const label=labelEls[p.id],sp=screenProject(v(x,H(2.7),z));if(sp){label.style.left=sp.x+'px';label.style.top=sp.y+'px';label.style.opacity=sp.w<55?'1':'.7';}else label.style.opacity='0';label.querySelector('.player-speech').classList.toggle('speaking',game.mode!=='menu' && playerSpeechUntil[p.id]>game.elapsed);
}
function drawBall(){if(game.mode==='menu'){ball.x=0;ball.z=-.2;ball.y=3.4+Math.sin(game.elapsed*1.8)*.24;}
  const z=clamp(ball.z,-COURT_Z*2,COURT_Z*2),x=clamp(ball.x,-COURT_X*3,COURT_X*3);sphere(x,.025,z,.75,.027,.55,'#364d56',{alpha:clamp(.22-ball.y*.017,.07,.22),flat:true});
  for(let tr of trail)sphere(tr.x,tr.y,tr.z,.20*tr.life/.22,.20*tr.life/.22,.20*tr.life/.22,'#d6f6ff',{alpha:tr.life*.7,flat:true});
  sphere(ball.x,ball.y,ball.z,BALL_R*2,BALL_R*2,BALL_R*2,'#ffffff',{ball:true});
  if(game.smashFX>0&&game.mode==='live'){
    const strength=game.smashFX/.5,r=(1-strength)*1.55+.44;
    ring(ball.x,ball.z,r,'#fff2a6',.28+strength*.6);
    sphere(ball.x,ball.y,ball.z,BALL_R*(3.4-strength),BALL_R*(3.4-strength),BALL_R*(3.4-strength),'#fff0aa',{alpha:strength*.18,flat:true});
  }
  for(let p of particles)sphere(p.x,p.y,p.z,.08,.08,.08,p.color,{alpha:clamp(p.life*2,0,1),flat:true});
}
function drawTarget(){if(game.mode==='menu')return;
  const valid=isInsideCourt(aim.x,aim.z)&&(onlineMode&&onlineTeam==='red'?aim.z<0:aim.z>0),tone=valid?'#9fffd2':'#ff9585',mark=valid?'#c2ffe2':'#ffe3ac';
  ring(aim.x,aim.z,.54,tone,.95);
  beam(v(aim.x-.24,.067,aim.z),v(aim.x+.24,.067,aim.z),.025,mark,{flat:true});
  beam(v(aim.x,.067,aim.z-.24),v(aim.x,.067,aim.z+.24),.025,mark,{flat:true});
  if(game.ballLive&&ball.vz<0){const land=predictedLanding();if(land.z<0&&Math.abs(land.x)<10&&Math.abs(land.z)<13){ring(land.x,land.z,.75,'#ffee89',.66);}}
  if(charging&&game.ballLive&&charge>.15&&Math.abs(ball.z)<11){let launchKind=chargeSecondTap?(chargeAction==='pass'?'passLob':chargeAerial?'smashLob':'lob'):(chargeAction==='pass'?'pass':chargeAerial?'smash':'normal'),flight=launchKind==='lob'||launchKind==='passLob'?1.75:launchKind==='smashLob'?1.3:launchKind==='smash'?.72:1.26;for(let k=1;k<=12;k++){let a=k/13,t=flight*a,xx=lerp(ball.x,aim.x,a),zz=lerp(ball.z,aim.z,a),vy=(.42-ball.y+.5*P.gravity*flight*flight)/flight,yy=ball.y+vy*t-.5*P.gravity*t*t;sphere(xx,Math.max(.15,yy),zz,.085,.085,.085,'#cbf7e4',{alpha:.65,flat:true});}}}
let labelEls=[];
function rebuildPlayerLabels(){
 for(const label of labelEls)label.remove();
 labelEls=players.map(p=>{
  const label=document.createElement('div');label.className='player-label '+(p.team==='blue'?'team-blue':'team-red');
  const name=document.createElement('span');name.className='player-name';name.textContent=p.name;
  const speech=document.createElement('span');speech.className='player-speech';speech.setAttribute('aria-hidden','true');
  label.append(name,speech);$('app').appendChild(label);return label;
 });
}
function updateCamera(dt){let p=players[0],dir=onlineMode&&onlineTeam==='red'?-1:1,destination={eye:v(p.x*.53+1.2*dir,cameraSettings.height+p.jump*.35,p.z-cameraSettings.distance*dir),target:v(p.x*.4,1.8,p.z+10*dir)};if(!game.camSmooth)game.camSmooth={eye:[...destination.eye],target:[...destination.target]};let s=clamp(dt*4.2,0,1);for(let i=0;i<3;i++){game.camSmooth.eye[i]=lerp(game.camSmooth.eye[i],destination.eye[i],s);game.camSmooth.target[i]=lerp(game.camSmooth.target[i],destination.target[i],s);}camera.eye=game.camSmooth.eye;camera.target=game.camSmooth.target;camera.fov=61*PI/180;camera.forward=norm(sub(camera.target,camera.eye));camera.right=norm(cross(camera.forward,v(0,1,0)));camera.up=norm(cross(camera.right,camera.forward));let asp=screenW/screenH;VP=matMul(perspective(camera.fov,asp,.1,200),lookAt(camera.eye,camera.target));gl.uniformMatrix4fv(loc.vp,false,VP);}
function updateAim(){if(!mouseMoved)return;
 const ndcX=mouseX/screenW*2-1,ndcY=1-mouseY/screenH*2,scale=Math.tan(camera.fov/2);
 const dir=norm(add(camera.forward,add(mul(camera.right,ndcX*scale*(screenW/screenH)),mul(camera.up,ndcY*scale))));
 if(dir[1]>=-.025)return;
 const t=(-camera.eye[1]+.07)/dir[1];if(t<=0)return;
 const pt=add(camera.eye,mul(dir,t));
 aim.x=clamp(pt[0],-BEACH_X,BEACH_X);
 aim.z=(onlineMode&&onlineTeam==='red')?clamp(pt[2],-BEACH_Z,-BEACH_NET_GAP):clamp(pt[2],BEACH_NET_GAP,BEACH_Z);
 const inCourt=isInsideCourt(aim.x,aim.z)&&(onlineMode&&onlineTeam==='red'?aim.z<0:aim.z>0);
 const label=$('targetStatus');
 label.textContent=inCourt?((game.mode==='serve'?'Service — ':'Cible : ')+(aim.x<=0?'droite':'gauche')+' • '+(aim.z>5?'fond':'près du filet')):'⚠ HORS DES LIGNES — BALLE DEHORS SI ELLE TOMBE ICI';
 label.parentElement.classList.toggle('out-aim',!inCourt);
}
function render(dt){if(onlineMode)onlineVisualSample();resize();updateCamera(dt);updateAim();drawCallsThisFrame=0;if(software){softQueue=[];softBackground();}else{gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}drawStaticWorld();if(software){softQueue.sort((a,b)=>b.depth-a.depth);for(let item of softQueue)item.draw();softQueue=[];}drawServiceGuides();drawTarget();players.forEach(drawPlayer);drawBall();if(software){softQueue.sort((a,b)=>b.depth-a.depth);for(let item of softQueue)item.draw();}}

// Outils de débogage pour itérer rapidement sur la physique et les sensations.
window.VOLLEYLAB_DEV={
 state:()=>({matchTarget:MATCH_TARGET,winningByTwo:true,winTeam:game.winTeam||null,network:{active:onlineMode,pingMs:onlinePingMs,frameAge:onlineFrameAge,snapshotCount:onlineSnapshots.length,fps:Math.round(measuredFps),renderer:software?'Canvas 2D':'WebGL',drawCalls:drawCallsThisFrame,staticBatches:staticBatches?.length??0,quality:graphicsQuality,scale:autoGraphicsScale},mode:game.mode,teamSize:game.teamSize,selectedTeamSize,roster:players.map(p=>({id:p.id,team:p.team,name:p.name})),rankedEnabled:false,server:game.server,serveStage:game.serveStage,serveElapsed:game.serveElapsed,serveClock:game.serveClock,score:[game.blue,game.red],lastCommand:game.lastCommand,commandCount:game.commandCount,pendingClick:{hit:!!pendingClicks.hit,pass:!!pendingClicks.pass},ball:{...ball},player:{x:players[0].x,z:players[0].z,vx:players[0].vx,vz:players[0].vz,vy:players[0].vy,jump:players[0].jump,inAir:players[0].inAir,jumpPrep:players[0].jumpPrep,jumpBoost:players[0].jumpBoost,crouch:players[0].crouch,crouchPose:players[0].crouchPose,dive:players[0].dive,diveCooldown:players[0].diveCooldown,lastHitStyle:players[0].lastHitStyle},camera:'arrière',cameraSettings:{...cameraSettings},bindings:{...bindings},target:{...aim},limits:{sandX:BEACH_X,sandZ:BEACH_Z,courtX:COURT_X,courtZ:COURT_Z},targetIn: isInsideOppositeCourt(aim.x,aim.z),lastAction:game.lastAction,actionTimer:game.actionTimer,speech:players.map((p,i)=>({name:p.name,text:labelEls[i].querySelector('.player-speech').textContent,visible:playerSpeechUntil[i]>game.elapsed})),parameters:{...P}}),
 players:()=>players.map(p=>({...p})),
 selectMode:n=>selectMatchMode(n),
 makeRoster:()=>makeRoster(),
  audioState:()=>audio.state(),
  startService:()=>nextServe('blue'),
  tossService:()=>tossServe('blue'),
  hitService:(power=.65,lob=false)=>serveHit(lob,power,'blue'),
  testSetScore:(blue=0,red=0)=>{game.blue=Math.max(0,Math.floor(blue));game.red=Math.max(0,Math.floor(red));updateHUD();},
  forcePoint:(team='blue')=>{game.mode='live';point(team,'TEST');},
  testFinishMatch:(team='blue')=>{game.blue=team==='blue'?15:10;game.red=team==='red'?15:10;game.mode='celebration';startVictory(team,game.blue,game.red,false);updateHUD();},
  advanceTicks:(n=1)=>{for(let i=0;i<Math.min(Math.max(0,n),5000);i++)step(1/90);},
  previewSound:(type,power=.8)=>audio.play(type,power,0),
  previewSpeech:(text='PASSE !',playerId=0)=>sayPlayer(playerId,text,1.05),
  testSetBall:values=>{for(const k of ['x','y','z','vx','vy','vz'])if(values[k]!==undefined)ball[k]=values[k];},
  testSetAim:(x,z)=>{aim.x=clamp(x,-BEACH_X,BEACH_X);aim.z=clamp(z,BEACH_NET_GAP,BEACH_Z);},
  testAimFromMouse:(x,y)=>{mouseX=x;mouseY=y;mouseMoved=true;updateAim();},
 testSetPlayer:(id,values)=>{const p=players[id];if(!p)return;for(const k of ['x','z','vx','vy','vz','jump','jumpBoost','jumpPrep','cool','dive','diveVX','diveVZ','crouchPose','inAir','diveBlocked'])if(values[k]!==undefined)p[k]=values[k];},
 testCollisions:()=>resolvePlayerCollisions(),
 practiceBall:()=>{let p=players[0];game.mode='live';game.ballLive=true;ball.x=p.x+.2;ball.z=p.z+1.1;ball.y=2.1;ball.vx=0;ball.vy=.6;ball.vz=-.3;game.touchTeam='red';game.touchCount=1;showToast('TEST DE FRAPPE — À TOI !',1);},
 practiceSmash:()=>{let p=players[0];game.mode='live';game.ballLive=true;ball.x=p.x;ball.z=p.z+1.3;ball.y=3.55;ball.vx=0;ball.vy=5.8;ball.vz=-.3;game.touchTeam='red';game.touchCount=1;showToast('TEST SMASH : ×2 '+formatKey(bindings.jump)+' PUIS '+formatKey(bindings.hit),1.7);},
};
// ---------- Commandes contextuelles simplifiées ----------
// G (simple) frappe, G (×2) lob, GRAND SAUT + G smash, GRAND SAUT + G (×2) smash lobé.
// D (simple) passe, D (×2) passe lobée. Le saut simple ne déclenche jamais de smash.
// On attend brièvement le second clic AVANT de lancer l'action simple :
// aucune frappe parasite ne part au premier clic d'un double clic.
function cancelPendingShots(){
 for(const name of ['hit','pass']){
  const pending=pendingClicks[name];if(pending){clearTimeout(pending.timer);pendingClicks[name]=null;}
 }
}
function stopCharge(clearPending=true){
 charging=false;charge=0;chargeStart=0;chargeAction=null;chargeControl=null;chargeSecondTap=false;chargeAerial=false;
 if(clearPending)cancelPendingShots();
}
function isSmashJumpForShot(){const p=players[0];return p&&p.jumpBoost&&p.inAir&&p.jump>.12;}
function dispatchGesture(action,doubleTap,aerial,power){
 if(onlineMode){const kind=action==='pass'?(doubleTap?'passLob':'pass'):(aerial?(doubleTap?'smashLob':'smash'):(doubleTap?'lob':'normal'));onlineSend({type:'hit',kind,power,aim:{x:aim.x,z:aim.z}});return;}
 if(game.mode==='serve'&&game.server==='blue'){if(action==='hit'){if(!serveHit(doubleTap,power))showToast('BALLE HORS DE PORTÉE !',.65);}return;}
 const mode=action==='pass'?(doubleTap?'passLob':'pass'):(aerial?(doubleTap?'smashLob':'smash'):(doubleTap?'lob':'normal'));
 requestHit(mode,power);
}
function beginCharge(action,control){
 if(!(game.mode==='live'||(game.mode==='serve'&&(onlineMode?game.server===onlineTeam:game.server==='blue')&&game.serveStage==='toss'))||game.paused||charging)return;
 const now=performance.now(),pending=pendingClicks[action];
 const isSecond=!!pending&&(now-pending.releasedAt<=DOUBLE_TAP_MS);
 if(isSecond)clearTimeout(pending.timer); // Le 1er clic ne peut plus produire de frappe.
 charging=true;chargeAction=action;chargeControl=control;chargeStart=now;charge=0;
 chargeSecondTap=isSecond;chargeAerial=isSmashJumpForShot();
}
function finishCharge(control){
 if(!charging||control!==chargeControl)return;
 const now=performance.now(),duration=now-chargeStart;
 const action=chargeAction,aerial=chargeAerial||isSmashJumpForShot(),isSecond=chargeSecondTap;
 const power=clamp(duration/850,.30,1);
 stopCharge(false);
 if(isSecond){
  const first=pendingClicks[action];pendingClicks[action]=null;
  dispatchGesture(action,true,aerial||(first&&first.aerial),Math.max(power,first?.power||0));
 }else if(duration>DOUBLE_TAP_MS){
  dispatchGesture(action,false,aerial,power); // Appui maintenu : frappe chargée immédiate.
 }else{
  // Si 2e appui avant l'expiration, le timeout est annulé dans beginCharge.
  const shot={power,aerial,releasedAt:now,timer:null};
  pendingClicks[action]=shot;
  shot.timer=setTimeout(()=>{
   if(pendingClicks[action]!==shot)return;
   pendingClicks[action]=null;
   dispatchGesture(action,false,shot.aerial,shot.power);
  },DOUBLE_TAP_MS);
 }
}
function downControl(code){
 const action=Object.keys(bindings).find(name=>bindings[name]===code);
 if(!action||game.mode==='menu'||game.mode==='ended'||game.mode==='celebration')return;
 if(game.paused&&action!=='pause'&&action!=='settings')return;
 if(['left','right','forward','back'].includes(action))return;
 if(action==='settings'){openOptions();return;}
 if(onlineMode&&onlineControl(action))return;
 if(action==='pause'){game.paused=!game.paused;audio.setActive(!game.paused);if(game.paused)stopCharge();showToast(game.paused?'PAUSE':'C’EST REPARTI !',1);return;}
 if(action==='restart'){resetMatch();modal.classList.add('hidden');return;}
 if(action==='practice'){window.VOLLEYLAB_DEV.practiceBall();return;}
 if(action==='practiceSmash'){window.VOLLEYLAB_DEV.practiceSmash();return;}
 if(action==='practiceServe'){nextServe('blue');return;}
 if(action==='jump'){if(game.mode==='serve'&&game.server==='blue'){tossServe('blue');return;}startJumpPreparation();return;}
 if(action==='crouch'){return;}
 if(action==='dive'){startDive();return;}
 if(action==='hit'||action==='pass'){if(game.mode==='serve'&&(onlineMode?game.server===onlineTeam:game.server==='blue')&&game.serveStage==='ready'){showToast('LANCE D’ABORD LA BALLE : '+formatKey(bindings.jump),.9);return;}if(game.mode==='serve'&&action==='pass')return;beginCharge(action,code);}
}
// Pendant la saisie, tout le reste est bloqué (dont clic droit et clic gauche).
window.addEventListener('keydown',e=>{
 if(awaitingAction){e.preventDefault();e.stopPropagation();if(!e.repeat)captureCode(e.code);return;}
 if(e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement)return;
 if(!e.metaKey&&(Object.values(bindings).includes(e.code)||['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.code)))e.preventDefault();
 if(!$('settings').classList.contains('hidden')){if(e.code==='Escape'||e.code===bindings.settings){e.preventDefault();closeOptions();}return;}
 if(e.code==='Escape'&&onlineMode){showToast('EN LIGNE — PAS DE PAUSE',.8);return;}
 if(e.code==='Escape'&&game.mode!=='menu'){game.paused=!game.paused;audio.setActive(!game.paused);if(game.paused)stopCharge();showToast(game.paused?'PAUSE':'C’EST REPARTI !',1);return;}
 if(e.repeat)return;
 keys.add(e.code);downControl(e.code);
},true);
window.addEventListener('keyup',e=>{keys.delete(e.code);finishCharge(e.code);},true);
window.addEventListener('blur',()=>{keys.clear();stopCharge();});
window.addEventListener('pointerdown',e=>{
 if(!awaitingAction)return;
 if(e.target.closest('#cancelCapture'))return;
 e.preventDefault();e.stopPropagation();captureCode('Mouse'+e.button);
},true);
// Le clic droit ne doit jamais ouvrir le menu contextuel pendant la capture ou le jeu.
window.addEventListener('contextmenu',e=>{if(awaitingAction||e.target===canvas){e.preventDefault();}},true);
canvas.addEventListener('pointermove',e=>{const r=canvas.getBoundingClientRect();mouseX=e.clientX-r.left;mouseY=e.clientY-r.top;mouseMoved=true;});
canvas.addEventListener('pointerdown',e=>{
 if(awaitingAction||!['live','serve'].includes(game.mode)||game.paused)return;
 const code='Mouse'+e.button;
 if(!Object.values(bindings).includes(code))return;
 e.preventDefault();keys.add(code);downControl(code);
});
window.addEventListener('pointerup',e=>{const code='Mouse'+e.button;keys.delete(code);finishCharge(code);});
// Quatre formats jouables immédiatement en local ; mode classé visible mais volontairement inactif.
function selectMatchMode(n){
 if(![1,2,3,4].includes(n))return;
 selectedTeamSize=n;
 document.querySelectorAll('[data-team-size]').forEach(btn=>{
  const active=Number(btn.dataset.teamSize)===n;
  btn.classList.toggle('selected',active);
  btn.setAttribute('aria-pressed',active?'true':'false');
 });
 $('modeExplain').textContent=n===1?'1v1 : duel contre un bot. La passe droite est une passe à soi-même.':n+'v'+n+' : toi + '+(n-1)+' partenaire'+(n>2?'s':'')+' IA contre '+n+' adversaire'+(n>1?'s':'')+' IA.';
 $('playBtn').innerHTML='JOUER EN '+n+'v'+n+' <span>↗</span>';
 try{localStorage.setItem(MODE_STORAGE_KEY,String(n));}catch(e){}
}
function backToMenu(){
 hideVictory();game.winTeam=null;closeOptions();game.paused=false;game.mode='menu';game.ballLive=false;cancelPendingShots();stopCharge();
 audio.setActive(false);$('modalTitle').innerHTML='UN SMASH.<br/><em>ENCORE UN MATCH.</em>';
 $('modalDesc').textContent='Choisis ton format de match et lance une nouvelle rencontre. Les adversaires et partenaires sont contrôlés par l’IA.';
 modal.classList.remove('hidden');
}
restoreModeSelection();selectMatchMode(selectedTeamSize);
makeRoster();matchChip();
for(const btn of document.querySelectorAll('[data-team-size]'))btn.addEventListener('click',()=>selectMatchMode(Number(btn.dataset.teamSize)));
$('backMenuBtn').addEventListener('click',()=>onlineMode?onlineLeave():backToMenu());
$('playBtn').addEventListener('click',play);
$('practiceBtn').addEventListener('click',()=>{if(onlineMode)return;if(game.mode!=='menu'&&game.mode!=='ended')window.VOLLEYLAB_DEV.practiceBall();});
$('smashPracticeBtn').addEventListener('click',()=>{if(onlineMode)return;if(game.mode!=='menu'&&game.mode!=='ended')window.VOLLEYLAB_DEV.practiceSmash();});
$('servePracticeBtn').addEventListener('click',()=>{if(onlineMode)return;if(game.mode!=='menu'&&game.mode!=='ended')nextServe('blue');});
$('cameraBtn').addEventListener('click',()=>openOptions(true));
$('graphicsQuality').value=graphicsQuality;
$('graphicsQuality').addEventListener('change',e=>{
 graphicsQuality=e.target.value;
 autoGraphicsScale=1;
 slowFrames=0;fastFrames=0;
 try{localStorage.setItem('volleylab:quality',graphicsQuality);}catch{}
});
setInterval(()=>{
  if(!document.hidden){
    $('performanceStats').textContent='FPS : '+Math.round(measuredFps)+' · Ping : '+(onlinePingMs===null?'—':Math.round(onlinePingMs)+' ms')+' · Rendu : '+(software?'Canvas 2D (lent)':'WebGL')+' · Appels 3D : '+drawCallsThisFrame+' · Mode : '+(graphicsQuality==='auto'?'Auto':graphicsQuality==='eco'?'Performance':'Qualité');
  }
},1000);
$('settingsBtn').addEventListener('click',toggleOptions);
$('menuSettingsBtn').addEventListener('click',()=>openOptions(true));
$('closeSettings').addEventListener('click',closeOptions);
$('soundBtn').addEventListener('click',()=>{audio.setEnabled(!audio.enabled);if(audio.enabled){audio.unlock();audio.play('hit',.58,0);}updateAudioUI();storeOptions();});
$('resetBtn').addEventListener('click',()=>{if(onlineMode){closeOptions();showToast('RESTART DÉSACTIVÉ EN LIGNE',1);return;}closeOptions();resetMatch();modal.classList.add('hidden');});
for(let name of ['gravity','assist','speed','smash']){$(name).addEventListener('input',e=>{P[name]=parseFloat(e.target.value);$(name+'Value').textContent=P[name].toFixed(1);});}
$('onlineOpenBtn').addEventListener('click',openOnline);
$('onlineClose').addEventListener('click',closeOnline);
$('onlineCreate').addEventListener('click',()=>onlineConnect('create'));
$('onlineJoin').addEventListener('click',()=>onlineConnect('join'));
$('onlineCopy').addEventListener('click',copyRoomInvite);
$('roomCopy').addEventListener('click',copyRoomInvite);
$('roomLeave').addEventListener('click',onlineLeave);
const inviteRoom=new URLSearchParams(location.search).get('room');
if(inviteRoom&&/^[A-HJ-NP-Z2-9]{6}$/.test(inviteRoom.toUpperCase())){openOnline();$('onlineCode').value=inviteRoom.toUpperCase();onlineSetStatus('Tu as reçu une invitation : indique ton pseudo, puis clique sur Rejoindre.');}
// Chaque itération garde un pas de simulation borné pour éviter les ratés après mise en veille.
let previous=performance.now();let accum=0;
function samplePerformance(dt){
 if(dt<=0||dt>.12)return;
 const fps=1/dt;measuredFps=numSmooth(measuredFps,fps,.035);
 if(graphicsQuality!=='auto'||software)return;
 if(measuredFps<46){slowFrames+=dt;fastFrames=0;}
 else if(measuredFps>57){fastFrames+=dt;slowFrames=0;}
 else{slowFrames=Math.max(0,slowFrames-dt);fastFrames=Math.max(0,fastFrames-dt);}
 if(slowFrames>1.8 && autoGraphicsScale>.68){autoGraphicsScale=Math.max(.68,autoGraphicsScale-.14);slowFrames=0;}
 if(fastFrames>7 && autoGraphicsScale<1){autoGraphicsScale=Math.min(1,autoGraphicsScale+.08);fastFrames=0;}
}
function loop(now){const rawDt=(now-previous)/1000,dt=clamp(rawDt,0,.05);previous=now;samplePerformance(rawDt);accum+=dt;let n=0;while(accum>=1/90&&n++<5){step(1/90);accum-=1/90;}render(dt);requestAnimationFrame(loop);}requestAnimationFrame(loop);
})();
