// Runs the REAL game.js in Node with a small stand-in for three.js, then exposes its internal state.
// Only the maths the game relies on for placement is real (rotation about Y, translation, Box3 transforms);
// everything visual (materials, geometry, textures, rendering) is a do-nothing stub.
const fs = require('fs'), vm = require('vm');

function any(){                                   // chainable do-nothing object
  const f = function(){};
  return new Proxy(f, {
    get(t,p){ if(p==='then') return undefined; if(p===Symbol.toPrimitive) return ()=>0; if(p in t) return t[p]; const v = any(); t[p]=v; return v; },
    set(t,p,v){ t[p]=v; return true; },
    apply(){ return any(); }, construct(){ return any(); }
  });
}
const cos=Math.cos, sin=Math.sin;
class V3{ constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z}
  set(x,y,z){this.x=x;this.y=y;this.z=z;return this} copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this}
  clone(){return new V3(this.x,this.y,this.z)} add(v){this.x+=v.x;this.y+=v.y;this.z+=v.z;return this}
  sub(v){this.x-=v.x;this.y-=v.y;this.z-=v.z;return this} multiplyScalar(k){this.x*=k;this.y*=k;this.z*=k;return this}
  lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z} length(){return Math.sqrt(this.lengthSq())}
  normalize(){const l=this.length()||1;return this.multiplyScalar(1/l)} distanceTo(v){return Math.hypot(this.x-v.x,this.y-v.y,this.z-v.z)}
  applyMatrix4(m){ const x=this.x,z=this.z,c=cos(m.rotY),s=sin(m.rotY); this.x=x*c+z*s+m.tx; this.z=-x*s+z*c+m.tz; this.y+=m.ty; return this }
  addScaledVector(v,k){this.x+=v.x*k;this.y+=v.y*k;this.z+=v.z*k;return this} }
class Box3{ constructor(a,b){ this.min=a?a.clone():new V3(Infinity,Infinity,Infinity); this.max=b?b.clone():new V3(-Infinity,-Infinity,-Infinity) }
  setFromCenterAndSize(c,s){ this.min.set(c.x-s.x/2,c.y-s.y/2,c.z-s.z/2); this.max.set(c.x+s.x/2,c.y+s.y/2,c.z+s.z/2); return this }
  setFromObject(o){ const p=new V3(); o.getWorldPosition(p); this.min.set(p.x-.15,p.y-.15,p.z-.15); this.max.set(p.x+.15,p.y+.15,p.z+.15); return this }
  applyMatrix4(m){ const pts=[]; for(const x of [this.min.x,this.max.x]) for(const y of [this.min.y,this.max.y]) for(const z of [this.min.z,this.max.z]) pts.push(new V3(x,y,z).applyMatrix4(m));
    this.min.set(Math.min(...pts.map(p=>p.x)),Math.min(...pts.map(p=>p.y)),Math.min(...pts.map(p=>p.z)));
    this.max.set(Math.max(...pts.map(p=>p.x)),Math.max(...pts.map(p=>p.y)),Math.max(...pts.map(p=>p.z))); return this }
  intersectsBox(b){ return !(b.max.x<this.min.x||b.min.x>this.max.x||b.max.y<this.min.y||b.min.y>this.max.y||b.max.z<this.min.z||b.min.z>this.max.z) }
  isEmpty(){ return this.max.x<this.min.x }
  getSize(t){ t.set(this.max.x-this.min.x,this.max.y-this.min.y,this.max.z-this.min.z); return t }
  getCenter(t){ t.set((this.max.x+this.min.x)/2,(this.max.y+this.min.y)/2,(this.max.z+this.min.z)/2); return t } }
class Euler{ constructor(){this.x=0;this.y=0;this.z=0;this.order='XYZ'} set(x,y,z,o){this.x=x;this.y=y;this.z=z;if(o)this.order=o;return this} }
class O3{ constructor(){ this.position=new V3(); this.rotation=new Euler(); this.scale=new V3(1,1,1); this.children=[]; this.parent=null; this.userData={}; this.matrixWorld={rotY:0,tx:0,ty:0,tz:0}; this.visible=true }
  add(...cs){ cs.forEach(c=>{ if(c.parent) c.parent.remove(c); c.parent=this; this.children.push(c) }); return this }
  remove(c){ const i=this.children.indexOf(c); if(i>=0){ this.children.splice(i,1); c.parent=null } }
  traverse(fn){ fn(this); this.children.forEach(c=>c.traverse(fn)) }
  _local(){ const m={rotY:this.rotation.y,tx:this.position.x,ty:this.position.y,tz:this.position.z};
    if(!this.parent) return m; const P=this.parent.matrixWorld, c=cos(P.rotY), s=sin(P.rotY);
    return { rotY:P.rotY+m.rotY, tx:P.tx+m.tx*c+m.tz*s, ty:P.ty+m.ty, tz:P.tz-m.tx*s+m.tz*c } }
  updateMatrixWorld(){ this.matrixWorld=this._local(); this.children.forEach(c=>c.updateMatrixWorld()) }
  updateWorldMatrix(up,down){ if(up&&this.parent) this.parent.updateWorldMatrix(true,false); this.matrixWorld=this._local(); if(down) this.children.forEach(c=>c.updateWorldMatrix(false,true)) }
  getWorldPosition(t){ this.updateWorldMatrix(true,false); t.set(this.matrixWorld.tx,this.matrixWorld.ty,this.matrixWorld.tz); return t }
  clone(){ const c=new this.constructor(this.geometry,this.material); c.position.copy(this.position); return c } }
class Mesh extends O3{ constructor(g,m){ super(); this.geometry=g; this.material=m; this.castShadow=false; this.receiveShadow=false } }
const O3Names=['Object3D','Group','Sprite','Points','SpotLight','DirectionalLight','HemisphereLight','AmbientLight','PointLight','Line','LineSegments'];
const explicit={ Vector3:V3, Box3, Euler, Mesh, Scene:class extends O3{}, PerspectiveCamera:class extends O3{},
  Clock:class{ getDelta(){return 0.016} getElapsedTime(){return 1} },
  Raycaster:class{ setFromCamera(){} intersectObjects(){return []} } };
O3Names.forEach(n=>{ explicit[n]=class extends O3{ constructor(){ super(); this.target=new O3(); this.shadow=any(); this.castShadow=false } } });
function Generic(){ return any(); }
const THREE=new Proxy(explicit,{ get(t,p){ return p in t ? t[p] : Generic } });

function makeCtx(){ return any(); }
function makeEl(id){ const el=any(); el.id=id; el.style={}; el.dataset={}; el.classList={add(){},remove(){},toggle(){},contains(){return false}};
  el.getContext=()=>makeCtx(); el.toDataURL=()=>'data:image/png;base64,'; el.appendChild=()=>{}; el.addEventListener=()=>{}; el.querySelectorAll=()=>[]; el.querySelector=()=>makeEl('q');
  el.width=el.width||64; el.height=el.height||64; el.textContent=''; return el }
const els={};
const document={ getElementById:id=>els[id]||(els[id]=makeEl(id)), querySelector:()=>makeEl('q'), querySelectorAll:()=>[],
  createElement:(t)=>makeEl(t), body:makeEl('body'), addEventListener(){}, exitPointerLock(){}, pointerLockElement:null };

function run(level, file){
  let src = fs.readFileSync(file,'utf8');
  const tail = "  .catch(()=>{ window.location.href = '/'; });\n})();";
  if(!src.includes(tail)) throw new Error('unexpected end of game.js');
  const hook = `  .catch((e)=>{ globalThis.__err = e; });
  globalThis.__t = { get roster(){return mistakeRoster}, get obstacles(){return obstacles}, get ROOM(){return ROOM}, get playerPos(){return playerPos},
    get yaw(){return yaw}, get workers(){return workers}, get officer(){return officer}, get racks(){return typeof RACK_RECTS!=='undefined'?RACK_RECTS:[]}, get hub(){return typeof hubLayout!=='undefined'?hubLayout:false},
    zoneFor, get minimapMode(){return minimapMode}, get labels(){ if(typeof lshapeLayout!=='undefined' && lshapeLayout) return ZONE_LABELS_LSHAPE; return (typeof hubLayout!=='undefined' && hubLayout) ? ZONE_LABELS_HUB : ZONE_LABELS }, get layout(){ return typeof layout!=='undefined'?layout:'hall' } };
})();`;
  src = src.replace(tail, hook);
  const win={ location:{search: level?('?level='+level):'', href:''}, innerWidth:1280, innerHeight:720, devicePixelRatio:1,
    addEventListener(){}, requestAnimationFrame(){}, CyberSettings:{ get:()=>({masterVolume:80,sfxVolume:80,musicVolume:45,muted:false,hints:true,timerEnabled:true,tutorial:true,interactionIndicator:true,reduceMotion:false,graphicsQuality:'low'}) } };
  const ctx={ THREE, document, window:win, console, setTimeout:(f)=>{}, clearTimeout(){}, Date, Math, JSON, URLSearchParams, Promise, performance:{now:()=>0},
    fetch:async()=>({ok:true, json:async()=>({username:'tester'})}), requestAnimationFrame(){}, localStorage:{getItem(){return null},setItem(){}}, navigator:{}, globalThis:null };
  ctx.globalThis=ctx; vm.createContext(ctx);
  vm.runInContext(src, ctx, {filename:file});
  return new Promise(r=>setImmediate(()=>setImmediate(()=>r(ctx))));
}
module.exports = { run, V3, Box3 };
