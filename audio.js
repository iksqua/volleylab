/* VOLLEYLAB 0.8 — audio procédural original, sans fichiers ni requêtes externes.
   Sons spatialises, intensité proportionnelle aux chocs, ambiance de plage discrète.
   AudioContext n'est créé qu'après une interaction du joueur. */
(function(global){
  'use strict';
  const TAU=Math.PI*2, clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
  const sounds={
    hit:{duration:.23,gain:.64}, lob:{duration:.26,gain:.54},
    pass:{duration:.18,gain:.48}, passLob:{duration:.24,gain:.47},
    smash:{duration:.34,gain:1.05}, smashLob:{duration:.40,gain:.83},
    serve:{duration:.24,gain:.55}, net:{duration:.52,gain:.78},
    pole:{duration:.51,gain:.7}, ground:{duration:.31,gain:.75},
    dive:{duration:.58,gain:.56}, jump:{duration:.21,gain:.31},
    windup:{duration:.20,gain:.24}, land:{duration:.19,gain:.33},
    step:{duration:.14,gain:.16}, bump:{duration:.22,gain:.42},
    score:{duration:.62,gain:.24}
  };
  class VolleyAudio {
    constructor(){
      this.ctx=null; this.master=null; this.ambienceBus=null; this.ambienceSource=null;
      this.enabled=true;this.volume=.72;this.ambience=.22;this.active=false;
      this.events=[];this.buffers={};this.supported=!!(global.AudioContext||global.webkitAudioContext);
    }
    unlock(){
      if(!this.supported)return false;
      try {
        if(!this.ctx){
          const Ctx=global.AudioContext||global.webkitAudioContext;
          const ctx=this.ctx=new Ctx();
          const compressor=ctx.createDynamicsCompressor();
          compressor.threshold.value=-14;compressor.knee.value=11;
          compressor.ratio.value=3;compressor.attack.value=.004;compressor.release.value=.22;
          compressor.connect(ctx.destination);
          this.master=ctx.createGain();this.master.gain.value=this.enabled?this.volume:0;
          this.master.connect(compressor);
          this.ambienceBus=ctx.createGain();this.ambienceBus.connect(this.master);
          this.startAmbience();
        }
        if(this.ctx.state==='suspended')this.ctx.resume().catch(()=>{});
        this.updateLevels();
        return true;
      }catch(e){console.warn('Audio Web non disponible',e);this.supported=false;return false;}
    }
    setEnabled(on){this.enabled=!!on;this.updateLevels();}
    setVolume(level){this.volume=clamp(Number(level)||0,0,1);this.updateLevels();}
    setAmbience(level){this.ambience=clamp(Number(level)||0,0,1);this.updateLevels();}
    setActive(on){this.active=!!on;this.updateLevels();}
    updateLevels(){
      if(!this.ctx)return;
      const now=this.ctx.currentTime;
      this.master.gain.setTargetAtTime(this.enabled?this.volume:0,now,.025);
      // Très bas dans le mix, pour ne pas masquer le bruit du ballon.
      this.ambienceBus.gain.setTargetAtTime(this.active?this.ambience*.125:0,now,.35);
    }
    startAmbience(){
      if(!this.ctx)return;
      const ctx=this.ctx,sr=ctx.sampleRate,n=Math.floor(sr*8),buffer=ctx.createBuffer(1,n,sr),data=buffer.getChannelData(0);
      // Bruit de surf rose/grave avec houle lente, petite fondu aux bords pour boucler.
      let a=0,b=0,seed=411;
      const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296*2-1;};
      for(let i=0;i<n;i++){
        const t=i/sr,white=random();a+=(white-a)*.018;b+=(a-b)*.013;
        const swell=.29+.71*Math.pow(.5+.5*Math.sin(TAU*(t/7.95-.15)),2);
        data[i]=clamp((white*.05+a*.95+b*.7)*swell*1.5,-1,1);
      }
      // La houle boucle sans clic aux frontières.
      const xf=Math.floor(sr*.5);
      for(let i=0;i<xf;i++){const alpha=i/xf;data[n-xf+i]=data[n-xf+i]*(1-alpha)+data[i]*alpha;}
      const src=ctx.createBufferSource();src.buffer=buffer;src.loop=true;
      const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=720;lp.Q.value=.4;
      src.connect(lp);lp.connect(this.ambienceBus);src.start();this.ambienceSource=src;
    }
    sample(type,strength){
      const ctx=this.ctx,opts=sounds[type]||sounds.hit,sr=ctx.sampleRate;
      const n=Math.ceil(sr*opts.duration),buffer=ctx.createBuffer(1,n,sr),data=buffer.getChannelData(0);
      let seed=(Math.random()*0xffffffff)>>>0;
      const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1;};
      let lo=0,hi=0,max=0;const power=clamp(strength,.05,1.25),soft=1-power*.15;
      const pitch=1+(Math.random()-.5)*.075;
      for(let i=0;i<n;i++){
        const t=i/sr,nz=rand();lo+=(nz-lo)*.045;hi+=(nz-hi)*.35;
        const crack=nz-lo,body=nz*.24+lo*.76;
        let s=0;
        if(['hit','pass','lob','passLob','serve','smash','smashLob'].includes(type)){
          const attack=type==='smash'||type==='smashLob',passing=type==='pass'||type==='passLob',high=type==='lob'||type==='passLob'||type==='smashLob';
          const base=(passing?162:attack?112:high?205:185)*pitch;
          // Peau de ballon: membrane vibrante, transitoire de paume, resonance courte.
          const phi=TAU*(base*t-35*t*t);
          const membrane=Math.sin(phi)*Math.exp(-(attack?16:high?18:23)*t);
          const overtone=Math.sin(phi*2.13+.45)*Math.exp(-31*t);
          const slap=crack*Math.exp(-(attack?65:90)*t);
          const air=hi*Math.exp(-16*t);
          s=membrane*(attack?.78:passing?.42:.58)+overtone*.18+slap*(attack?.49:passing?.19:.30)+air*(attack?.20:high?.10:.07);
          if(attack){ // Petit souffle de manchette puissante, sans effet de laser.
            const whoosh=Math.sin(TAU*(450*t-70*t*t))*Math.exp(-19*t);
            s+=whoosh*.13+body*.17*Math.exp(-9*t);
          }
        }else if(type==='net'){
          // Filet de cordes: impact mat, vibrations de tension et froissement irrégulier.
          const shake=Math.pow(.55+.45*Math.sin(TAU*(23*t+9*t*t)),3);
          const rustle=(crack*.33+lo*.38)*Math.exp(-6.6*t)*shake;
          const pluck=(Math.sin(TAU*(480*t-22*t*t))+.35*Math.sin(TAU*782*t)) * Math.exp(-19*t);
          const first=(body*.35+crack*.28)*Math.exp(-75*t);
          s=rustle*.95+pluck*.22+first;
        }else if(type==='pole'){
          // Bande supérieure / poteau: tintement bref et filet qui tremble.
          s=(Math.sin(TAU*320*pitch*t)*.43+Math.sin(TAU*710*pitch*t)*.30)*Math.exp(-10*t)
            +crack*.16*Math.exp(-18*t)+lo*.27*Math.exp(-12*t);
        }else if(type==='ground'){
          // Sable: rebond sourd + grains secs. Plus grave pour une balle rapide.
          const freq=(96+40*soft)*pitch;
          s=Math.sin(TAU*(freq*t-35*t*t))*.72*Math.exp(-23*t)+body*.34*Math.exp(-24*t)+crack*.20*Math.exp(-39*t);
        }else if(type==='dive'){
          // Glissade: souffle granuleux pendant ~500 ms et petit choc initial.
          const slide=(1-Math.exp(-t*55))*Math.exp(-4.5*t);
          const grains=(crack*.22+hi*.3+lo*.2)*slide;
          const thud=Math.sin(TAU*(83*t-11*t*t))*.4*Math.exp(-17*t);
          s=grains+thud;
        }else if(type==='jump'||type==='land'||type==='step'||type==='windup'){
          const thump=type==='land'?.50:type==='jump'?.32:.15;
          s=crack*.15*Math.exp(-(type==='windup'?25:40)*t)
            +body*.25*Math.exp(-24*t)
            +Math.sin(TAU*(type==='windup'?175:95)*t)*thump*Math.exp(-27*t);
        }else if(type==='bump'){
          s=Math.sin(TAU*(105*t-20*t*t))*.55*Math.exp(-20*t)+body*.30*Math.exp(-26*t);
        }else if(type==='score'){
          // Petit sifflet de fin de point, ni jingle agressif ni longue mélodie.
          const env=(1-Math.exp(-80*t))*Math.exp(-7*t);
          s=(Math.sin(TAU*740*t)*.42+Math.sin(TAU*1110*t)*.17)*env;
          if(t>.19){const q=t-.19;s+=Math.sin(TAU*880*q)*Math.exp(-8*q)*.30;}
        }
        // Limite la crête sans rendre toutes les puissances identiques.
        const sample=clamp(s,-2.5,2.5);
        data[i]=sample;max=Math.max(max,Math.abs(sample));
      }
      if(max>0.92){const correction=.92/max;for(let i=0;i<n;i++)data[i]*=correction;}
      // Fenêtre de sécurité: aucune coupure abrupte à la fin d'un son.
      const tail=Math.min(Math.floor(sr*.012),n>>2);
      for(let i=0;i<tail;i++)data[n-1-i]*=i/tail;
      return buffer;
    }
    play(type,strength=.7,x=0,delay=0){
      if(!this.enabled)return false;
      if(!this.unlock())return false;
      if(!sounds[type])type='hit';
      const ctx=this.ctx,s=clamp(Number(strength)||.1,.1,1.2);
      const source=ctx.createBufferSource();source.buffer=this.buffers[type]||(this.buffers[type]=this.sample(type,.75));
      source.playbackRate.value=clamp(.94+s*.08+(Math.random()-.5)*.045,.85,1.13);
      const gain=ctx.createGain();gain.gain.value=sounds[type].gain*(.35+.65*s)*.64;
      let target=gain;
      if(typeof ctx.createStereoPanner==='function'){
        const pan=ctx.createStereoPanner();pan.pan.value=clamp(-x/11,-.55,.55);
        gain.connect(pan);pan.connect(this.master);target=pan;
      }else gain.connect(this.master);
      source.connect(gain);source.start(ctx.currentTime+Math.max(0,delay));
      this.events.push({type,strength:s,x,time:Date.now()});if(this.events.length>80)this.events.shift();
      source.onended=()=>{try{source.disconnect();gain.disconnect();if(target!==gain)target.disconnect();}catch(e){}};
      return true;
    }
    state(){return{enabled:this.enabled,volume:this.volume,ambience:this.ambience,active:this.active,context:this.ctx?.state||'uninitialized',events:this.events.slice(-20)};}
  }
  global.VolleyAudio=VolleyAudio;
})(window);
