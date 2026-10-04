
(function(){

/* ============================================================
   CONFIG
   ============================================================ */
const CORRECT_POINTS = 10;
const INTERACT_DISTANCE = 5.2;

const DIFFICULTIES = {
  easy:   { time: 360, wrongPenalty: 2, minimap: 'full'  },
  normal: { time: 240, wrongPenalty: 5, minimap: 'basic' },
  hard:   { time: 150, wrongPenalty: 8, minimap: 'none'  }
};

// Controls how much harder each level actually is to *observe*, not just
// score/time — lighting, visibility distance, and how obvious the props
// themselves are.
const DIFFICULTY_CONTENT = {
  easy: {
    lightingMult: 1.0, fogNear: 18, fogFar: 62,
    stickyNoteColor: 0xf6e35a, stickyNoteScale: 1.0,
    wedgeColor: 0xff7a3c,
    camLedOffIntensity: 0.0,
    emailTier: 'obvious',
    strangerTier: 'obvious'
  },
  normal: {
    lightingMult: 0.82, fogNear: 13, fogFar: 46,
    stickyNoteColor: 0xe4d089, stickyNoteScale: 0.82,
    wedgeColor: 0xaa6a4a,
    camLedOffIntensity: 0.18,
    emailTier: 'moderate',
    strangerTier: 'moderate'
  },
  hard: {
    lightingMult: 0.62, fogNear: 9, fogFar: 32,
    stickyNoteColor: 0xd7cfae, stickyNoteScale: 0.6,
    wedgeColor: 0x9a978e,
    camLedOffIntensity: 0.35,
    emailTier: 'subtle',
    strangerTier: 'subtle'
  }
};

// UI-facing "Level 1/2/3" labeling. Internally the game still keys
// everything off easy/normal/hard (scoring, XP multipliers, content
// scaling, server achievement ids) — this is purely a display mapping.
const LEVEL_NUMBER = { easy: 1, normal: 2, hard: 3 };
const LEVEL_ORDER = ['easy', 'normal', 'hard'];
function levelLabel(diff){ return 'LEVEL ' + (LEVEL_NUMBER[diff] || 1); }

const urlParams = new URLSearchParams(window.location.search);
const lockedLevel = ['easy','normal','hard'].includes(urlParams.get('level')) ? urlParams.get('level') : null;

let difficulty = lockedLevel || 'normal';
let wrongPenalty = DIFFICULTIES[difficulty].wrongPenalty;
let minimapMode = DIFFICULTIES[difficulty].minimap;
let wrongCount = 0;
let decoysCorrectCount = 0;

let currentUsername = null;
let scene, camera, renderer, clock;
let yaw = 0, pitch = 0;
let playerPos = new THREE.Vector3(0, 1.7, 21);
let playerHeight = 1.7;
let velocity = new THREE.Vector3();
const keys = { w:false, a:false, s:false, d:false };
let pointerLocked = false;
let gameRunning = false;
let paused = false;
let mapOpen = false;
let practiceMode = false;
let gameSettings = null; // cached once per shift so we're not hitting localStorage every frame
let hoveredGlowData = null; // tracks which object's glow outline is currently lit
let judgmentOpen = false;
let timeLeft = DIFFICULTIES[difficulty].time;

let interactables = []; // {mesh, data}
let obstacles = []; // THREE.Box3
let workers = [];
let officer = null;
let ZONE_HUMANOIDS = []; // static characters (Danger Zone) that idle-bob but don't patrol

// Each level has its own floor plan:
//   Level 1 (easy)   'hall'    the original tall training hall
//   Level 2 (normal) 'lshape'  an L-shaped warehouse: two wings meeting at a corner
//   Level 3 (hard)   'hub'     a wide east–west distribution hub
let layout = 'hall';
let hubLayout = false;      // Level 3 only
let lshapeLayout = false;   // Level 2 only
let customLayout = false;   // Level 2 or Level 3 (anything but the original hall)
let RACK_RECTS = [];            // {x,z,w,d} footprints, shared by the world builder and both maps
const OBJ_OF = new WeakMap();   // interactable data -> the 3D object it was registered on

let score = 0;
let foundCount = 0;
let mistakeRoster = []; // {id,title,explain,isMistake,found}

let raycaster = new THREE.Raycaster();
let audioCtx = null;

/* ============================================================
   BOOT
   ============================================================ */
function setLoad(pct, msg){
  document.getElementById('loadbar').style.width = pct + '%';
  if(msg) document.querySelector('#loading .ltxt').textContent = msg;
}

function init(){
  setLoad(5, 'PREPARING SCENE…');

  // Pick this level's floor plan. (Opening game.html with no ?level= keeps the original hall.)
  layout = !lockedLevel ? 'hall' : (difficulty === 'hard' ? 'hub' : (difficulty === 'normal' ? 'lshape' : 'hall'));
  hubLayout = (layout === 'hub');
  lshapeLayout = (layout === 'lshape');
  customLayout = hubLayout || lshapeLayout;
  Object.assign(ROOM, hubLayout ? ROOM_HUB : (lshapeLayout ? ROOM_LSHAPE : ROOM_STANDARD));
  {
    const mm = document.getElementById('minimap');
    const sm = document.getElementById('sitemap-canvas');
    if(hubLayout){
      playerPos.set(-22.5, 1.7, 9);   // just inside the west entrance
      yaw = -Math.PI/2;               // facing east, down the main aisle
      if(mm){ mm.width = 200; mm.height = 144; }   // landscape maps for a landscape room
      if(sm){ sm.width = 460; sm.height = 331; }
    } else if(lshapeLayout){
      playerPos.set(21.5, 1.7, 12);   // just inside the east entrance, at the end of the south wing
      yaw = Math.PI/2;                // facing west, along the south wing
      if(mm){ mm.width = 176; mm.height = 161; }   // near-square maps for the L-shaped plan
      if(sm){ sm.width = 440; sm.height = 403; }
    }
  }
  const rulesEl = document.querySelector('.rules');
  if(rulesEl) rulesEl.style.display = (getSettings().tutorial === false) ? 'none' : '';

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f11);
  scene.fog = new THREE.Fog(0x0d0f11, DIFFICULTY_CONTENT[difficulty].fogNear, DIFFICULTY_CONTENT[difficulty].fogFar);

  camera = new THREE.PerspectiveCamera(72, window.innerWidth/window.innerHeight, 0.1, 200);
  camera.rotation.order = 'YXZ';

  const quality = getSettings().graphicsQuality || 'high';
  const qualityAA = quality !== 'low';
  renderer = new THREE.WebGLRenderer({ antialias: qualityAA });
  const pixelRatioCap = quality === 'low' ? 1 : (quality === 'medium' ? 1.5 : 2);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = quality !== 'low';
  renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
  document.getElementById('canvas-wrap').appendChild(renderer.domElement);

  clock = new THREE.Clock();

  setLoad(15, 'POURING CONCRETE…');
  buildLighting();
  buildFloorWallsCeiling();

  setLoad(35, 'ASSEMBLING RACKS…');
  buildRacks();

  setLoad(45, 'STAGING WORKSTATIONS & MISTAKES…');
  if(hubLayout){
    buildHubAreas();
  } else if(lshapeLayout){
    buildLShapeAreas();
  } else {
    buildOfficeNook();
    buildServerRoom();
    buildReception();
    buildPackingStation();
    buildDispatchDesk();
    buildBreakRoom();
    buildMeetingRoom();
    buildEntranceDoor();
    buildManagerOffice();
    buildDangerZone();
  }

  setLoad(65, 'MOUNTING SECURITY CAMERAS…');
  buildSecurityCameras();

  setLoad(75, 'BUILDING CHARACTERS…');
  buildCharacters();

  setLoad(85, 'ADDING TOOLS & CLUTTER…');
  buildToolsAndClutter();
  buildDustMotes();

  setLoad(96, 'FINISHING TOUCHES…');
  window.addEventListener('resize', onResize);
  setupInput();
  updateHud();

  setLoad(100, 'READY');
  setTimeout(()=>{
    document.getElementById('loading').style.display='none';
  }, 250);

  animate();
}

/* ============================================================
   PROCEDURAL TEXTURES (canvas-generated only, no external images)
   ============================================================ */
function makeCanvas(w,h){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function concreteTexture(){
  const c = makeCanvas(256,256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#83837c';
  ctx.fillRect(0,0,256,256);
  for(let i=0;i<4500;i++){
    const v = Math.random()*40-20;
    ctx.fillStyle = `rgba(${20+v<0?0:20+v},${20+v<0?0:20+v},${18+v<0?0:18+v},${Math.random()*0.12})`;
    ctx.fillRect(Math.random()*256, Math.random()*256, 1.6, 1.6);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1.5;
  for(let i=0;i<5;i++){
    ctx.beginPath();
    let x = Math.random()*256;
    ctx.moveTo(x,0);
    for(let y=0;y<256;y+=16){ x += (Math.random()-0.5)*10; ctx.lineTo(x,y); }
    ctx.stroke();
  }
  // faint hazard walkway line
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10,16);
  return tex;
}

function floorLaneTexture(){
  const c = makeCanvas(64,64);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#83837c';
  ctx.fillRect(0,0,64,64);
  ctx.fillStyle = '#ffc93c';
  ctx.fillRect(0,0,4,64);
  ctx.fillRect(60,0,4,64);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1,20);
  return tex;
}

function metalPanelTexture(base){
  base = base || '#3a4048';
  const c = makeCanvas(128,128);
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0,0,128,128);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(2,2,124,124);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for(let i=0;i<10;i++){
    ctx.beginPath();
    ctx.moveTo(0, i*13);
    ctx.lineTo(128, i*13+4);
    ctx.stroke();
  }
  // rivets
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  [[10,10],[118,10],[10,118],[118,118]].forEach(p=>{
    ctx.beginPath(); ctx.arc(p[0],p[1],3,0,Math.PI*2); ctx.fill();
  });
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function corrugatedWallTexture(){
  const c = makeCanvas(128,128);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#4a525c';
  ctx.fillRect(0,0,128,128);
  for(let x=0;x<128;x+=8){
    const g = ctx.createLinearGradient(x,0,x+8,0);
    g.addColorStop(0,'rgba(255,255,255,0.10)');
    g.addColorStop(0.5,'rgba(0,0,0,0.18)');
    g.addColorStop(1,'rgba(255,255,255,0.04)');
    ctx.fillStyle = g;
    ctx.fillRect(x,0,8,128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14,4);
  return tex;
}

function cardboardTexture(){
  const c = makeCanvas(128,128);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#b98a54';
  ctx.fillRect(0,0,128,128);
  for(let i=0;i<800;i++){
    ctx.fillStyle = `rgba(90,60,30,${Math.random()*0.08})`;
    ctx.fillRect(Math.random()*128, Math.random()*128, 2,2);
  }
  ctx.strokeStyle = 'rgba(70,45,20,0.55)';
  ctx.lineWidth = 4;
  ctx.strokeRect(0,0,128,128);
  ctx.beginPath();
  ctx.moveTo(64,0); ctx.lineTo(64,128);
  ctx.moveTo(0,64); ctx.lineTo(128,64);
  ctx.stroke();
  // tape strip
  ctx.fillStyle = 'rgba(230,220,190,0.5)';
  ctx.fillRect(0,58,128,12);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function hazardStripeTexture(){
  const c = makeCanvas(64,64);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#161616';
  ctx.fillRect(0,0,64,64);
  ctx.fillStyle = '#ffc93c';
  for(let i=-64;i<64;i+=16){
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(i,64); ctx.lineTo(i+8,64); ctx.lineTo(i+72,0); ctx.lineTo(i+64,0);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function drawnScreenTexture(drawFn, w, h, bg){
  w = w || 512; h = h || 320;
  const c = makeCanvas(w,h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg || '#0c1420';
  ctx.fillRect(0,0,w,h);
  drawFn(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/* ============================================================
   LIGHTING
   ============================================================ */
function buildLighting(){
  const mult = DIFFICULTY_CONTENT[difficulty].lightingMult;

  const hemi = new THREE.HemisphereLight(0x9fb3c8, 0x22201c, 0.55 * mult);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d6, 0.35 * mult);
  sun.position.set(-20, 25, 10);
  scene.add(sun);

  // hanging warehouse lamps: down the central aisle (hall) or along the main aisle (hub)
  const lamps = hubLayout
    ? [ {x:-20,z:7,sh:true},{x:-10,z:7,sh:true},{x:0,z:7,sh:true},{x:10,z:7,sh:true},{x:20,z:7,sh:true},
        {x:-14,z:-10.5,sh:false},{x:14,z:-10.5,sh:false} ]      // two fill lamps over the north lane (no shadows: cheaper)
    : lshapeLayout
    ? [ {x:-14.75,z:-16,sh:true},{x:-14.75,z:-4,sh:true},{x:-14.75,z:9,sh:true},{x:6,z:10,sh:true},{x:16,z:10,sh:true},
        {x:-4,z:-12,sh:false},{x:-18,z:16,sh:false} ]           // lamps follow both wings of the L; none over the solid block
    : [ -15, -7.5, 0, 7.5, 15 ].map(z=>({x:0,z,sh:true}));
  lamps.forEach(({x:lx, z, sh})=>{
    const spot = new THREE.SpotLight(0xfff2d0, 1.15 * mult, 26, Math.PI/4.4, 0.55, 1.4);
    spot.position.set(lx, 9.6, z);
    spot.target.position.set(lx, 0, z);
    spot.castShadow = sh;
    if(sh) spot.shadow.mapSize.set(1024,1024);
    scene.add(spot);
    scene.add(spot.target);

    const fixture = new THREE.Group();
    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55,0.75,0.4,16),
      new THREE.MeshStandardMaterial({color:0x24262a, roughness:0.6, metalness:0.5})
    );
    shade.position.set(lx,9.75,z);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.22,12,12),
      new THREE.MeshStandardMaterial({color:0xfff6d8, emissive:0xffdf8a, emissiveIntensity:1.2})
    );
    bulb.position.set(lx,9.5,z);
    fixture.add(shade,bulb);
    scene.add(fixture);
  });
}

/* ------------------------------------------------------------
   Level 2 helpers
   ------------------------------------------------------------ */
function addFloorLane(cx, cz, length, alongX, width){
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(width, length),
    new THREE.MeshStandardMaterial({ map:floorLaneTexture(), roughness:0.9 })
  );
  lane.rotation.x = -Math.PI/2;
  lane.position.y = 0.005;
  const g = new THREE.Group();
  g.add(lane);
  g.rotation.y = alongX ? Math.PI/2 : 0;
  g.position.set(cx, 0, cz);
  scene.add(g);
}

// The solid block that turns the rectangle into an L. Two wall faces show
// (one looks into the west wing, one into the south wing) plus one collision box.
function buildCornerBlock(){
  const wallMat = new THREE.MeshStandardMaterial({ map:corrugatedWallTexture(), roughness:0.8, metalness:0.3 });
  const h = ROOM.height;
  const westFace = new THREE.Mesh(new THREE.PlaneGeometry(24, h), wallMat);   // seen from the west wing
  westFace.position.set(0, h/2, -12);
  westFace.rotation.y = -Math.PI/2;
  westFace.receiveShadow = true;
  scene.add(westFace);
  const southFace = new THREE.Mesh(new THREE.PlaneGeometry(24, h), wallMat);  // seen from the south wing
  southFace.position.set(12, h/2, 0);
  southFace.receiveShadow = true;
  scene.add(southFace);
  obstacles.push(new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(12, h/2, -12), new THREE.Vector3(24, h, 24)
  ));
}

/* ============================================================
   FLOOR / WALLS / CEILING
   ============================================================ */
const ROOM_STANDARD = { minX:-18, maxX:18, minZ:-25, maxZ:25, height:10 };   // Levels 1 and 2: tall hall
const ROOM_HUB      = { minX:-25, maxX:25, minZ:-18, maxZ:18, height:10 };   // Level 3: wide hub
const ROOM_LSHAPE   = { minX:-24, maxX:24, minZ:-24, maxZ:20, height:10 };   // Level 2: L-shaped (bounding box; the NE corner x 0..24, z -24..0 is a solid block)
const ROOM = Object.assign({}, ROOM_STANDARD);   // init() switches this to the L-shape (Level 2) or the hub (Level 3)

/* ------------------------------------------------------------
   withFrame(): build an existing area exactly as it always was,
   then slide / turn it to its Level 3 spot.

   Every builder lays its area out in the original room's
   coordinates. Rather than rewrite them all, this builds the area
   inside a temporary group (with the original room size in force),
   then rotates the group by a multiple of 90 degrees and moves it.
   Collision boxes follow the group, and each task's map position is
   re-read afterwards so the maps, arrows and tick marks line up.
   ------------------------------------------------------------ */
function withFrame(rotY, tx, tz, buildFn){
  const realScene = scene;
  const savedRoom = Object.assign({}, ROOM);
  const grp = new THREE.Group();
  const obsStart = obstacles.length;
  const rosterStart = mistakeRoster.length;

  Object.assign(ROOM, ROOM_STANDARD);   // builders compute their positions from the original room
  scene = grp;
  try{
    buildFn();
  } finally {
    scene = realScene;
    Object.assign(ROOM, savedRoom);
  }

  grp.rotation.y = rotY;
  grp.position.set(tx, 0, tz);
  scene.add(grp);
  grp.updateMatrixWorld(true);

  for(let i = obsStart; i < obstacles.length; i++){
    obstacles[i].applyMatrix4(grp.matrixWorld);
  }
  for(let i = rosterStart; i < mistakeRoster.length; i++){
    const data = mistakeRoster[i];
    const obj = OBJ_OF.get(data);
    if(obj){ obj.getWorldPosition(data.worldPos); }
  }
  return grp;
}

function buildFloorWallsCeiling(){
  const floorTex = concreteTexture();
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.maxX-ROOM.minX, ROOM.maxZ-ROOM.minZ),
    new THREE.MeshStandardMaterial({ map:floorTex, roughness:0.95, metalness:0.05 })
  );
  floor.rotation.x = -Math.PI/2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Level 2: one walking lane down the south wing and one up the west wing
  if(lshapeLayout){
    addFloorLane(10, 10, 28, true, 4);        // south wing: east–west, x -4..24 along z = 10
    addFloorLane(-14.75, -9, 26, false, 3);   // west wing: north–south along x = -14.75, between the rack columns
  }

  // central walking lane markers (hall: north–south down the middle; hub: east–west along the main aisle)
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(4, hubLayout ? ROOM.maxX-ROOM.minX : ROOM.maxZ-ROOM.minZ),
    new THREE.MeshStandardMaterial({ map:floorLaneTexture(), roughness:0.9 })
  );
  lane.rotation.x = -Math.PI/2;
  lane.position.y = 0.005;
  if(hubLayout){
    const laneGroup = new THREE.Group();
    laneGroup.add(lane);
    laneGroup.rotation.y = Math.PI/2;
    laneGroup.position.set(0, 0, 7);
    scene.add(laneGroup);
  } else if(!lshapeLayout){
    scene.add(lane);
  }

  // Level 2: the inside of the L is solid (x 0..24, z -24..0)
  if(lshapeLayout) buildCornerBlock();

  const wallTex = corrugatedWallTexture();
  const wallMat = new THREE.MeshStandardMaterial({ map:wallTex, roughness:0.8, metalness:0.3 });

  const wallDefs = [
    { w: ROOM.maxX-ROOM.minX, pos:[0, ROOM.height/2, ROOM.minZ], rotY:0 },
    { w: ROOM.maxX-ROOM.minX, pos:[0, ROOM.height/2, ROOM.maxZ], rotY:Math.PI },
    { w: ROOM.maxZ-ROOM.minZ, pos:[ROOM.minX, ROOM.height/2, 0], rotY:Math.PI/2 },
    { w: ROOM.maxZ-ROOM.minZ, pos:[ROOM.maxX, ROOM.height/2, 0], rotY:-Math.PI/2 },
  ];
  wallDefs.forEach(wd=>{
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(wd.w, ROOM.height), wallMat);
    wall.position.set(wd.pos[0], wd.pos[1], wd.pos[2]);
    wall.rotation.y = wd.rotY;
    wall.receiveShadow = true;
    scene.add(wall);
  });

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.maxX-ROOM.minX, ROOM.maxZ-ROOM.minZ),
    new THREE.MeshStandardMaterial({ color:0x1c1f22, roughness:0.9 })
  );
  ceiling.rotation.x = Math.PI/2;
  ceiling.position.y = ROOM.height;
  scene.add(ceiling);

  // roof trusses for realism
  const trussMat = new THREE.MeshStandardMaterial({color:0x2b2f34, roughness:0.6, metalness:0.5});
  for(let z=ROOM.minZ+4; z<=ROOM.maxZ-4; z+=8){
    const truss = new THREE.Mesh(new THREE.BoxGeometry(ROOM.maxX-ROOM.minX-1, 0.4, 0.4), trussMat);
    truss.position.set(0, ROOM.height-0.4, z);
    scene.add(truss);
  }
}

/* ============================================================
   RACKS + CRATES
   ============================================================ */
function buildRacks(){
  const metalTex = metalPanelTexture('#3a4048');
  const frameMat = new THREE.MeshStandardMaterial({ map:metalTex, roughness:0.55, metalness:0.7 });
  const crateTex = cardboardTexture();
  const crateMat = new THREE.MeshStandardMaterial({ map:crateTex, roughness:0.95 });

  RACK_RECTS = [];

  if(hubLayout){
    // Level 3: rack fields in east–west rows. They are the walls of the maze —
    // they block sight-lines between the offices, the dock and the entrance.
    const rows = [];
    [-21.8, -17.0, -12.2].forEach(x=>[-7.8, -4.4, -1.0].forEach(z=>rows.push({x, z, w:4.4, d:2.4})));   // west field
    [-7.8, -4.4, -1.0].forEach(z=>rows.push({x:12.2, z, w:4.4, d:2.4}));                              // east-centre
    [18.4, 22.6].forEach(x=>[-7.0, -3.6, -0.2].forEach(z=>rows.push({x, z, w:4.2, d:2.4})));          // east field
    rows.forEach(r=>{
      const rack = buildRackUnit(frameMat, crateMat);
      rack.position.set(r.x, 0, r.z);       // long side runs east–west
      scene.add(rack);
      obstacles.push(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(r.x,1.5,r.z), new THREE.Vector3(r.w,3,r.d)
      ));
      RACK_RECTS.push(r);
    });
    return;
  }

  if(lshapeLayout){
    // Level 2: north–south rack columns in the west wing (an aisle between them),
    // and one east–west rack row along the south face of the solid block.
    const rows = [];
    [-17.5, -12.0].forEach(x=>[-15.5, -9.6, -3.7].forEach(z=>rows.push({x, z, w:2.4, d:4.4, rot:Math.PI/2})));
    [5.2, 9.6, 14.0, 18.4].forEach(x=>rows.push({x, z:2.0, w:4.4, d:2.4, rot:0}));
    rows.forEach(r=>{
      const rack = buildRackUnit(frameMat, crateMat);
      rack.position.set(r.x, 0, r.z);
      rack.rotation.y = r.rot;
      scene.add(rack);
      obstacles.push(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(r.x,1.5,r.z), new THREE.Vector3(r.w,3,r.d)
      ));
      RACK_RECTS.push({x:r.x, z:r.z, w:r.w, d:r.d});
    });
    return;
  }

  const zSlots = [-15,-9,-3,3,9,15];
  const xSides = [-11, 11];

  xSides.forEach(x=>{
    zSlots.forEach(z=>{
      const rack = buildRackUnit(frameMat, crateMat);
      rack.position.set(x, 0, z);
      rack.rotation.y = x < 0 ? Math.PI/2 : -Math.PI/2;
      scene.add(rack);
      obstacles.push(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x,1.5,z), new THREE.Vector3(2.4,3,4.4)
      ));
      RACK_RECTS.push({x, z, w:2.4, d:4.4});
    });
  });
}

function buildRackUnit(frameMat, crateMat){
  const group = new THREE.Group();
  const width = 4, depth = 1.4, height = 7.6;
  const postGeo = new THREE.BoxGeometry(0.14,height,0.14);
  const positions = [
    [-width/2,height/2,-depth/2], [width/2,height/2,-depth/2],
    [-width/2,height/2, depth/2], [width/2,height/2, depth/2]
  ];
  positions.forEach(p=>{
    const post = new THREE.Mesh(postGeo, frameMat);
    post.position.set(p[0],p[1],p[2]);
    post.castShadow = true;
    group.add(post);
  });

  const shelfLevels = [0.05, 2.6, 5.1, 7.5];
  shelfLevels.forEach((y,i)=>{
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(width, 0.08, depth), frameMat);
    shelf.position.set(0,y,0);
    shelf.receiveShadow = true; shelf.castShadow = true;
    group.add(shelf);

    if(i < shelfLevels.length-1){
      // crates on this shelf
      const count = 2 + Math.floor(Math.random()*2);
      let cx = -width/2 + 0.5;
      for(let c=0;c<count;c++){
        const cw = 0.7 + Math.random()*0.5;
        const ch = 0.5 + Math.random()*0.5;
        const cd = 0.7 + Math.random()*0.4;
        const crate = new THREE.Mesh(new THREE.BoxGeometry(cw,ch,cd), crateMat);
        crate.position.set(cx + cw/2, y + ch/2 + 0.04, (Math.random()-0.5)*0.2);
        crate.rotation.y = (Math.random()-0.5)*0.2;
        crate.castShadow = true; crate.receiveShadow = true;
        group.add(crate);
        cx += cw + 0.15;
        if(cx > width/2-0.3) break;
      }
    }
  });

  // diagonal bracing for realism
  const braceMat = frameMat;
  const brace = new THREE.Mesh(new THREE.BoxGeometry(0.06, Math.sqrt(width*width+height*height)*0.5, 0.06), braceMat);
  brace.position.set(-width/2, height*0.25, 0);
  brace.rotation.z = Math.atan2(height*0.5,width*0.5) - Math.PI/2;
  group.add(brace);

  return group;
}

/* ============================================================
   INTERACTABLE REGISTRY
   ============================================================ */
function registerInteractable(object, data){
  data.found = false;
  data.resolved = false;
  data.correct = undefined;

  // Some props (server cabinets, cameras, the rogue router) stash a
  // blinking-LED reference on userData.leds before being registered here.
  // Reassigning userData below would silently wipe that out, so preserve
  // it — this is what keeps their LEDs actually blinking in-game.
  const preservedLeds = object.userData && object.userData.leds;
  object.userData = data;
  if(preservedLeds) object.userData.leds = preservedLeds;

  object.traverse(child=>{
    const childLeds = child.userData && child.userData.leds;
    child.userData = data;
    if(childLeds) child.userData.leds = childLeds;
  });
  interactables.push(object);

  if(object.updateWorldMatrix){ object.updateWorldMatrix(true, true); }
  else { object.updateMatrixWorld(true); }

  // Every prop gets a padded "glow box" wrapped around its real shape.
  // It's invisible (opacity 0) until this exact object is what the player
  // is currently aiming at, at which point it lights up bright yellow —
  // a much more obvious cue than a tiny reticle dot changing color.
  // For small props it also serves as the forgiving hit area (so aim
  // doesn't need to be pixel-perfect); for large ones it's purely visual,
  // since the real mesh is already an easy, precise target.
  const box = new THREE.Box3().setFromObject(object);
  if(!box.isEmpty()){
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const pad = Math.max(0.05, maxDim * 0.15);
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(size.x + pad*2, size.y + pad*2, size.z + pad*2),
      new THREE.MeshBasicMaterial({
        color:0xffc93c, transparent:true, opacity:0, depthWrite:false
      })
    );
    glow.position.copy(center);
    glow.renderOrder = 998;
    scene.add(glow);
    data.glowMesh = glow;
    if(maxDim > 0 && maxDim < 0.4){
      // small prop — the glow box also acts as the generous raycasting target
      glow.userData = data;
      interactables.push(glow);
    }
  }

  // Auto-capture a readable close-up if this prop's material uses a
  // canvas-drawn texture (CanvasTexture.image IS the source canvas).
  if(!data.zoomImage && object.material && object.material.map && object.material.map.image
     && typeof object.material.map.image.toDataURL === 'function'){
    try{ data.zoomImage = object.material.map.image.toDataURL(); }catch(e){ /* not critical */ }
  }

  if(data.isMistake !== undefined){
    const wp = new THREE.Vector3();
    object.getWorldPosition(wp);
    data.worldPos = wp;
    OBJ_OF.set(data, object);
    mistakeRoster.push(data);
  }
}

function popup(kind, title, body){
  const el = document.getElementById('popup');
  el.className = 'show ' + kind;
  el.innerHTML = `<div class="p-title">${title}</div><div class="p-body">${body}</div>`;
  clearTimeout(popup._t);
  popup._t = setTimeout(()=>{ el.className = ''; }, 3400);
}

/* ============================================================
   OFFICE NOOK  (north-west): sticky-note password + phishing email + locked decoy
   ============================================================ */
function buildDesk(x,z,rotY){
  const group = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({color:0x5a4a3a, roughness:0.8});
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.6,0.08,0.8), woodMat);
  top.position.y = 0.78;
  top.castShadow = true; top.receiveShadow = true;
  group.add(top);
  const legGeo = new THREE.BoxGeometry(0.07,0.78,0.07);
  [[-0.72,-0.32],[0.72,-0.32],[-0.72,0.32],[0.72,0.32]].forEach(p=>{
    const leg = new THREE.Mesh(legGeo, woodMat);
    leg.position.set(p[0],0.39,p[1]);
    group.add(leg);
  });
  // chair
  const chairMat = new THREE.MeshStandardMaterial({color:0x2b2b2b, roughness:0.7});
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.08,0.5), chairMat);
  seat.position.set(0,0.46,0.9);
  group.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.55,0.06), chairMat);
  back.position.set(0,0.78,1.13);
  group.add(back);
  const chairPole = new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,0.46,8), chairMat);
  chairPole.position.set(0,0.23,0.9);
  group.add(chairPole);

  group.position.set(x,0,z);
  group.rotation.y = rotY || 0;
  scene.add(group);
  return group;
}

function buildMonitor(parentDesk, screenDrawFn, screenBg){
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({color:0x1c1c1c, roughness:0.5, metalness:0.3});
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.09,0.22,10), bodyMat);
  stand.position.set(0,0.11,0);
  group.add(stand);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.14,0.14,0.02,16), bodyMat);
  group.add(base);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.66,0.42,0.03), bodyMat);
  frame.position.set(0,0.42,0);
  group.add(frame);
  const screenTex = drawnScreenTexture(screenDrawFn, 512, 320, screenBg);
  const screenMat = new THREE.MeshStandardMaterial({ map:screenTex, emissive:0xffffff, emissiveMap:screenTex, emissiveIntensity:0.55, roughness:0.4 });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.6,0.36), screenMat);
  screen.position.set(0,0.42,0.018);
  group.add(screen);

  const kb = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.02,0.2), bodyMat);
  kb.position.set(0,0.795,0.32);
  group.add(kb);

  parentDesk.add(group);
  group.position.set(0,0.78,-0.15);
  return { group, screen };
}

function buildStickyNote(){
  const dc = DIFFICULTY_CONTENT[difficulty];
  const c = makeCanvas(256,256);
  const ctx = c.getContext('2d');
  const hexColor = '#' + dc.stickyNoteColor.toString(16).padStart(6,'0');
  ctx.fillStyle = hexColor;
  ctx.fillRect(0,0,256,256);
  ctx.strokeStyle='rgba(0,0,0,0.15)'; ctx.lineWidth=3; ctx.strokeRect(0,0,256,256);
  ctx.fillStyle = '#333';
  ctx.font = '32px monospace';
  ctx.fillText('PW:', 24, 88);
  ctx.fillText('Ware', 24, 136);
  ctx.fillText('house', 16, 180);
  ctx.fillText('#2024', 16, 224);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshStandardMaterial({map:tex, roughness:0.9});
  const size = 0.16 * dc.stickyNoteScale;
  const note = new THREE.Mesh(new THREE.PlaneGeometry(size,size), mat);
  return note;
}

function buildOfficeNook(){
  // --- Desk A: MISTAKE - password sticky note on monitor ---
  const deskA = buildDesk(-12.5, -19, Math.PI);
  const monA = buildMonitor(deskA, (ctx,w,h)=>{
    ctx.fillStyle = '#0c1420'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#4fa8ff';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('Warehouse OS', 24, 46);
    ctx.strokeStyle = '#274766'; ctx.lineWidth=2;
    for(let i=0;i<4;i++){ ctx.strokeRect(24, 80+i*46, w-48, 34); }
    ctx.fillStyle = '#7fa0bd'; ctx.font='14px sans-serif';
    ctx.fillText('Inventory', 34, 102);
    ctx.fillText('Shipping Manifest', 34, 148);
    ctx.fillText('Reports', 34, 194);
    ctx.fillText('Settings', 34, 240);
  });
  const note = buildStickyNote();
  note.position.set(0.2, 0.15, 0.02);
  note.rotation.z = -0.08;
  monA.group.add(note);
  registerInteractable(note, {
    isMistake:true,
    prompt:'There\'s a small paper note stuck to the edge of this monitor.',
    title:'Password on a Sticky Note',
    explain:'Writing a password and leaving it in plain view lets anyone walking past read and reuse it. Passwords belong in a password manager, never on paper stuck to a screen.'
  });

  // --- Desk B: MISTAKE - phishing email left open on screen ---
  const deskB = buildDesk(-8.5, -19, Math.PI);
  const emailTier = DIFFICULTY_CONTENT[difficulty].emailTier;
  const monB = buildMonitor(deskB, (ctx,w,h)=>{
    if(emailTier === 'obvious'){
      ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0,0,w,h);
      ctx.fillStyle = '#d33'; ctx.fillRect(0,0,w,44);
      ctx.fillStyle = '#fff'; ctx.font='bold 18px sans-serif';
      ctx.fillText('⚠ URGENT: Account Suspended', 16, 28);
      ctx.fillStyle = '#333'; ctx.font='13px sans-serif';
      ctx.fillText('From: IT-Security@paypa1-alerts.net', 16, 74);
      ctx.fillText('To: warehouse-staff@company.com', 16, 94);
      ctx.fillStyle = '#111'; ctx.font='14px sans-serif';
      ctx.fillText('Your access will be revoked in 24 hours unless', 16, 130);
      ctx.fillText('you verify your login now:', 16, 150);
      ctx.fillStyle = '#2255cc'; ctx.font='underline 14px sans-serif';
      ctx.fillText('http://verify-account-now.support-portal.ru', 16, 176);
      ctx.strokeStyle='#ccc'; ctx.strokeRect(16,200,140,36);
      ctx.fillStyle='#d33'; ctx.fillText('VERIFY NOW', 40, 222);
    } else if(emailTier === 'moderate'){
      ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0,0,w,h);
      ctx.fillStyle = '#e4e6e8'; ctx.fillRect(0,0,w,40);
      ctx.fillStyle = '#333'; ctx.font='bold 15px sans-serif';
      ctx.fillText('Action Needed: Update Your Password', 16, 26);
      ctx.fillStyle = '#555'; ctx.font='12px sans-serif';
      ctx.fillText('From: hr-support@warehouse-corp.net', 16, 68);
      ctx.fillText('To: staff@warehousecorp.com', 16, 86);
      ctx.fillStyle = '#222'; ctx.font='13px sans-serif';
      ctx.fillText('Please update your password within 5 business', 16, 120);
      ctx.fillText('days to stay compliant with the new security policy.', 16, 138);
      ctx.fillStyle = '#2255cc'; ctx.font='13px sans-serif';
      ctx.fillText('http://warehousecorp-account.net/update', 16, 172);
    } else {
      ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0,0,w,h);
      ctx.fillStyle = '#e4e6e8'; ctx.fillRect(0,0,w,38);
      ctx.fillStyle = '#333'; ctx.font='bold 14px sans-serif';
      ctx.fillText('Password Policy Update', 16, 25);
      ctx.fillStyle = '#555'; ctx.font='12px sans-serif';
      ctx.fillText('From: it.helpdesk@warehouse-hub.com', 16, 64);
      ctx.fillText('To: team@warehousehub.com', 16, 82);
      ctx.fillStyle = '#222'; ctx.font='13px sans-serif';
      ctx.fillText('As part of our regular security review, please', 16, 116);
      ctx.fillText('confirm your details using the link below.', 16, 134);
      ctx.fillStyle = '#2255cc'; ctx.font='13px sans-serif';
      ctx.fillText('https://warehousehub-portal.com/confirm', 16, 168);
    }
  }, '#f2f2f2');
  registerInteractable(monB.screen, {
    isMistake:true,
    prompt:'This monitor has an email open on screen.',
    title:'Phishing Email Left Open',
    explain:'Urgent tone, a mismatched sender domain, and a suspicious link are classic phishing signs. It should be reported to IT, not left open or clicked.'
  });

  // --- Desk C: decoy - properly locked workstation ---
  const deskC = buildDesk(-4.5, -19, Math.PI);
  const monC = buildMonitor(deskC, (ctx,w,h)=>{
    ctx.fillStyle = '#12161c'; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = '#66707a'; ctx.lineWidth = 4;
    ctx.strokeRect(w/2-30, h/2-40, 60, 46);
    ctx.beginPath(); ctx.arc(w/2, h/2-40, 22, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = '#8a949e'; ctx.font='14px sans-serif';
    ctx.fillText('Session Locked', w/2-52, h/2+40);
  }, '#12161c');
  registerInteractable(monC.screen, {
    isMistake:false,
    prompt:'This monitor shows a lock screen.',
    title:'Nothing Wrong Here',
    explain:'This workstation is locked while unattended, exactly what good practice looks like. No penalty, but no points either — keep looking.'
  });

  // --- Desk D: MISTAKE - personal phone charging via USB into the work PC ---
  const deskD = buildDesk(-0.5, -19, Math.PI);
  const towerD = buildTower();
  towerD.position.set(0.7,0.27,-0.1);
  deskD.add(towerD);
  const monD = buildMonitor(deskD, (ctx,w,h)=>{
    ctx.fillStyle = '#0c1420'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#4fa8ff'; ctx.font='bold 20px sans-serif';
    ctx.fillText('Inventory Terminal', 24, 44);
    ctx.fillStyle = '#7fa0bd'; ctx.font='13px sans-serif';
    ctx.fillText('Scanning enabled — bay 4', 24, 90);
  });
  const phoneMat = new THREE.MeshStandardMaterial({color:0x111214, roughness:0.35, metalness:0.4});
  const phone = new THREE.Mesh(new THREE.BoxGeometry(0.07,0.15,0.01), phoneMat);
  phone.position.set(-0.55,0.815,-0.02);
  phone.rotation.z = 0.15;
  deskD.add(phone);
  const cableMat = new THREE.MeshStandardMaterial({color:0xdedede, roughness:0.6});
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.006,0.006,0.35,6), cableMat);
  cable.position.set(-0.05,0.79,-0.08);
  cable.rotation.z = Math.PI/2.3;
  deskD.add(cable);
  registerInteractable(phone, {
    isMistake:true,
    prompt:'A phone is plugged into this computer over USB, charging.',
    title:'Personal Phone Charging via Work PC',
    explain:'Plugging a personal phone into a work computer over USB can bridge two networks of trust — data can move either way, and the phone could be carrying malware. Use a wall charger, not a company workstation, for personal devices.'
  });
}

/* ============================================================
   SERVER ROOM (north-east): unlocked cabinet + locked decoy
   ============================================================ */
function buildServerCabinet(x,z,locked, label){
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({color:0x24272b, roughness:0.5, metalness:0.6});
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1,2.2,0.9), bodyMat);
  body.position.y = 1.1;
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);

  // blinking LEDs
  const ledGroup = new THREE.Group();
  for(let i=0;i<6;i++){
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.02,6,6),
      new THREE.MeshStandardMaterial({color:0x2fff6a, emissive:0x2fff6a, emissiveIntensity:1}));
    led.position.set(-0.45+ (i%3)*0.1, 1.7 - Math.floor(i/3)*0.1, 0.46);
    led._blink = Math.random()*Math.PI*2;
    ledGroup.add(led);
  }
  group.add(ledGroup);
  group.userData.leds = ledGroup;

  const door = new THREE.Mesh(new THREE.BoxGeometry(1.0,2.1,0.05), new THREE.MeshStandardMaterial({color:0x2c3036, roughness:0.4, metalness:0.7}));
  door.position.set(-0.5,1.1,0.475);
  const doorPivot = new THREE.Group();
  doorPivot.position.set(-1.0,0,0.45);
  door.position.set(0.5,1.1,0.03);
  doorPivot.add(door);
  group.add(doorPivot);

  if(!locked){
    doorPivot.rotation.y = -1.15; // swung open
    // exposed cables
    const cableMat = new THREE.MeshStandardMaterial({color:0x111111, roughness:0.8});
    for(let i=0;i<5;i++){
      const cable = new THREE.Mesh(new THREE.TorusGeometry(0.12,0.02,6,10, Math.PI*1.3), cableMat);
      cable.position.set(-0.1+Math.random()*0.2, 1.3-i*0.15, 0.1);
      cable.rotation.set(Math.random(),Math.random(),Math.random());
      group.add(cable);
    }
  } else {
    // padlock icon on the door
    const lockMat = new THREE.MeshStandardMaterial({color:0xffc93c, emissive:0xffc93c, emissiveIntensity:0.3});
    const lockBody = new THREE.Mesh(new THREE.BoxGeometry(0.12,0.1,0.03), lockMat);
    lockBody.position.set(-0.5,1.1,0.51);
    group.add(lockBody);
    const lockShackle = new THREE.Mesh(new THREE.TorusGeometry(0.05,0.015,6,10,Math.PI), lockMat);
    lockShackle.position.set(-0.5,1.17,0.51);
    group.add(lockShackle);
  }

  group.position.set(x,0,z);
  scene.add(group);
  return group;
}

function buildServerRoom(){
  // cage fencing for atmosphere
  const fenceMat = new THREE.MeshStandardMaterial({color:0x3a3f45, roughness:0.6, metalness:0.5, transparent:true, opacity:0.55, wireframe:true});
  const fence = new THREE.Mesh(new THREE.BoxGeometry(5.6,2.6,4.2), fenceMat);
  fence.position.set(10.5,1.3,-18.5);
  scene.add(fence);

  const open = buildServerCabinet(9.2, -19.6, false, 'unlocked');
  registerInteractable(open, {
    isMistake:true,
    prompt:'This server cabinet\'s door is standing open.',
    title:'Server Cabinet Left Unlocked',
    explain:'An open, unattended server cabinet exposes network hardware and cabling to tampering or theft. Server rooms and racks should always stay locked when no one is working on them.'
  });

  const locked = buildServerCabinet(11.6, -19.6, true, 'locked');
  registerInteractable(locked, {
    isMistake:false,
    prompt:'This server cabinet\'s door is closed and latched.',
    title:'Properly Secured',
    explain:'This cabinet is locked as it should be. Good practice — no points, but nothing to report either.'
  });

  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(9.2,1.1,-19.6), new THREE.Vector3(1.2,2.2,1)));
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(11.6,1.1,-19.6), new THREE.Vector3(1.2,2.2,1)));
}

/* ============================================================
   RECEPTION (near entrance): unattended badge
   ============================================================ */
function buildBadge(){
  const c = makeCanvas(192,128);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0,0,192,128);
  ctx.strokeStyle='#888'; ctx.lineWidth=3; ctx.strokeRect(2,2,188,124);
  ctx.fillStyle = '#2f9e52';
  ctx.fillRect(12,12,48,48);
  ctx.fillStyle='#1a1a1a'; ctx.font='bold 18px sans-serif';
  ctx.fillText('J. SMITH', 68, 36);
  ctx.font = '14px sans-serif';
  ctx.fillText('ACCESS: ALL AREAS', 68, 60);
  ctx.fillText('ID# 88231', 68, 84);
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(0,0,192,8);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshStandardMaterial({map:tex, roughness:0.6});
  const badge = new THREE.Mesh(new THREE.BoxGeometry(0.28,0.02,0.18), mat);
  return badge;
}

function buildRogueRouter(){
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({color:0x1e1f22, roughness:0.5});
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.16,0.03,0.1), bodyMat);
  group.add(body);
  const antMat = new THREE.MeshStandardMaterial({color:0x0a0a0a, roughness:0.6});
  [-0.05,0.05].forEach(x=>{
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004,0.004,0.09,6), antMat);
    ant.position.set(x,0.06,0);
    ant.rotation.z = (x<0?0.25:-0.25);
    group.add(ant);
  });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.011,8,8),
    new THREE.MeshStandardMaterial({color:0xff3b3b, emissive:0xff3b3b, emissiveIntensity:1.4}));
  led.position.set(0.06,0.017,0.04);
  led._blink = Math.random()*Math.PI*2;
  const ledGroup = new THREE.Group(); ledGroup.add(led);
  group.add(ledGroup);
  group.userData.leds = ledGroup;
  return group;
}

function buildReception(){
  const desk = buildDesk(-3, 15, 0);
  const badge = buildBadge();
  badge.position.set(-2.35, 0.815, 14.9);
  badge.rotation.y = 0.4;
  badge.rotation.x = -0.3; // propped up against the monitor base, not lying flat — same visibility fix as the meeting-room paper
  scene.add(badge);
  registerInteractable(badge, {
    isMistake:true,
    prompt:'An employee ID badge is sitting on this desk.',
    title:'Access Badge Left Unattended',
    explain:'An unattended ID badge could let anyone badge into restricted areas pretending to be that employee. Badges should stay on the person, not on an empty desk.'
  });

  const rogue = buildRogueRouter();
  rogue.position.set(0.35, 0.05, 0.22); // local offset: tucked under the desktop, near a leg
  rogue.rotation.y = 0.6;
  desk.add(rogue);
  registerInteractable(rogue, {
    isMistake:true,
    prompt:'There\'s a small router tucked under this desk, not part of the visible setup.',
    title:'Unauthorized Wireless Access Point',
    explain:'A small router hidden under a desk, not managed by IT, can create a backdoor onto the network that bypasses every firewall rule in place. Unknown access points should be reported and removed immediately.'
  });

  const emailTier = DIFFICULTY_CONTENT[difficulty].emailTier;
  const mon = buildMonitor(desk, (ctx,w,h)=> drawAttachmentEmail(ctx,w,h,emailTier), '#f2f2f2');
  registerInteractable(mon.screen, {
    isMistake:true,
    prompt:'This monitor has an email open, with a file attached.',
    title:'Suspicious Email Attachment',
    explain:'An unexpected attachment with a double file extension (like "Invoice.pdf.exe") is a classic way to disguise a malicious program as a harmless document. Unexpected attachments should be checked with IT before opening, never opened directly.'
  });

  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(-3,0.4,15), new THREE.Vector3(1.7,0.9,0.9)));
}

function drawAttachmentEmail(ctx,w,h,tier){
  if(tier === 'obvious'){
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#e4e6e8'; ctx.fillRect(0,0,w,40);
    ctx.fillStyle = '#333'; ctx.font='bold 15px sans-serif';
    ctx.fillText('Invoice Overdue — Action Required', 16, 26);
    ctx.fillStyle = '#555'; ctx.font='12px sans-serif';
    ctx.fillText('From: billing@supplier-invoices.net', 16, 68);
    ctx.fillText('To: reception@warehousecorp.com', 16, 86);
    ctx.fillStyle = '#222'; ctx.font='13px sans-serif';
    ctx.fillText('Please see the attached invoice and pay immediately', 16, 118);
    ctx.fillText('to avoid late fees.', 16, 136);
    ctx.strokeStyle='#999'; ctx.strokeRect(16,156,168,30);
    ctx.fillStyle = '#333'; ctx.font='bold 12px sans-serif';
    ctx.fillText('📎 Invoice.pdf.exe', 24, 175);
  } else if(tier === 'moderate'){
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#e4e6e8'; ctx.fillRect(0,0,w,38);
    ctx.fillStyle = '#333'; ctx.font='bold 14px sans-serif';
    ctx.fillText('Delivery Note Attached', 16, 25);
    ctx.fillStyle = '#555'; ctx.font='12px sans-serif';
    ctx.fillText('From: dispatch@warehouse-partners.com', 16, 64);
    ctx.fillText('To: reception@warehousecorp.com', 16, 82);
    ctx.fillStyle = '#222'; ctx.font='13px sans-serif';
    ctx.fillText('Please find the delivery note for your records', 16, 114);
    ctx.fillText('attached below.', 16, 132);
    ctx.strokeStyle='#999'; ctx.strokeRect(16,150,160,28);
    ctx.fillStyle = '#333'; ctx.font='11px sans-serif';
    ctx.fillText('📎 Delivery_Note.docx.js', 22, 168);
  } else {
    ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#e4e6e8'; ctx.fillRect(0,0,w,36);
    ctx.fillStyle = '#333'; ctx.font='bold 13px sans-serif';
    ctx.fillText('Updated Warehouse Schedule', 16, 24);
    ctx.fillStyle = '#555'; ctx.font='11px sans-serif';
    ctx.fillText('From: ops.updates@warehouse-corp.com', 16, 60);
    ctx.fillText('To: reception@warehousecorp.com', 16, 78);
    ctx.fillStyle = '#222'; ctx.font='12px sans-serif';
    ctx.fillText('Attached is next week\'s shift schedule.', 16, 108);
    ctx.strokeStyle='#aaa'; ctx.strokeRect(16,126,150,26);
    ctx.fillStyle = '#333'; ctx.font='10.5px sans-serif';
    ctx.fillText('📎 Schedule.xlsx.scr', 22, 143);
  }
}

/* ============================================================
   ENTRANCE DOOR: propped open with a wedge
   ============================================================ */
function buildEntranceDoor(){
  const frameMat = new THREE.MeshStandardMaterial({color:0x2c2f33, roughness:0.6, metalness:0.5});
  const frame = new THREE.Mesh(new THREE.BoxGeometry(3.4,4.4,0.2), frameMat);
  frame.position.set(6, 2.2, ROOM.maxZ-0.05);
  scene.add(frame);

  const doorMat = new THREE.MeshStandardMaterial({color:0x8b8f94, roughness:0.4, metalness:0.7});
  const doorPivot = new THREE.Group();
  doorPivot.position.set(6-1.5, 0, ROOM.maxZ-0.1);
  const door = new THREE.Mesh(new THREE.BoxGeometry(3,4.2,0.08), doorMat);
  door.position.set(1.5,2.1,0);
  doorPivot.add(door);
  doorPivot.rotation.y = 0.85; // propped open
  scene.add(doorPivot);

  const wedgeMat = new THREE.MeshStandardMaterial({color:DIFFICULTY_CONTENT[difficulty].wedgeColor, roughness:0.6});
  const wedge = new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.16,0.1,10), wedgeMat);
  wedge.position.set(5.1, 0.05, ROOM.maxZ-1.6);
  scene.add(wedge);

  registerInteractable(wedge, {
    isMistake:true,
    prompt:'This exterior door is being held open by something on the floor.',
    title:'Exterior Door Propped Open',
    explain:'A wedged-open exterior door defeats badge access control and lets anyone walk in unchecked (tailgating). Doors with access control should always close and latch behind you.'
  });

  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(2.5,2,ROOM.maxZ-0.5), new THREE.Vector3(3,4,1)));
}

/* ============================================================
   PACKING STATION (east-center): USB left inserted + locked decoy
   ============================================================ */
function buildTower(){
  const mat = new THREE.MeshStandardMaterial({color:0x1a1c1f, roughness:0.5, metalness:0.4});
  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.22,0.55,0.45), mat);
  return tower;
}
function buildUSB(){
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({color:0xd8d8d8, roughness:0.4, metalness:0.6});
  const capMat = new THREE.MeshStandardMaterial({color:0x2255cc, roughness:0.5});
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.03,0.05,0.02), bodyMat);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.05,0.06,0.03), capMat);
  cap.position.x = 0.04;
  group.add(body,cap);
  return group;
}

function buildPackingStation(){
  const deskA = buildDesk(13.5, 3, -Math.PI/2);
  const towerA = buildTower();
  towerA.position.set(0.9,0.27,-0.15);
  deskA.add(towerA);
  const usb = buildUSB();
  usb.position.set(0,0.27,0.08);
  towerA.add(usb);
  const monA = buildMonitor(deskA, (ctx,w,h)=>{
    ctx.fillStyle = '#0c1420'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#4fa8ff'; ctx.font='bold 22px sans-serif';
    ctx.fillText('Packing Terminal — Logged In', 24, 40);
    ctx.fillStyle = '#7fa0bd'; ctx.font = '13px sans-serif';
    ctx.fillText('Order #48213  Ready to ship', 24, 90);
    ctx.fillText('Order #48214  Ready to ship', 24, 116);
  });
  registerInteractable(usb, {
    isMistake:true,
    prompt:'A USB drive is plugged into this computer.',
    title:'Unknown USB Drive Plugged In',
    explain:'Unrecognized USB drives can carry malware that runs automatically when plugged in. Found media should be handed to IT, never plugged into a live workstation.'
  });

  const deskB = buildDesk(13.5, 8, -Math.PI/2);
  const towerB = buildTower();
  towerB.position.set(0.9,0.27,-0.15);
  deskB.add(towerB);
  const monB = buildMonitor(deskB, (ctx,w,h)=>{
    ctx.fillStyle = '#0e1a14'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#4fa8ff'; ctx.font='bold 20px sans-serif';
    ctx.fillText('Packing Terminal', 24, 42);
    const cx = w/2, cy = h/2+18;
    ctx.beginPath(); ctx.arc(cx,cy,34,0,Math.PI*2);
    ctx.strokeStyle = '#5ac87a'; ctx.lineWidth = 4; ctx.stroke();
    ctx.strokeStyle = '#5ac87a'; ctx.lineWidth = 5; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(cx-14,cy); ctx.lineTo(cx-4,cy+12); ctx.lineTo(cx+16,cy-14); ctx.stroke();
    ctx.fillStyle = '#5ac87a'; ctx.font='13px sans-serif'; ctx.textAlign='center';
    ctx.fillText('Two-Factor Authentication Verified', cx, cy+58);
    ctx.textAlign='left';
  }, '#0e1a14');
  registerInteractable(monB.screen, {
    isMistake:false,
    prompt:'This monitor shows a login confirmation of some kind, and nothing unusual is plugged into the tower.',
    title:'Two-Factor Authentication Verified',
    explain:'A second verification step beyond just a password, confirmed and completed properly here — exactly the kind of extra protection that makes an account much harder to break into, even if the password alone were compromised.'
  });
}

/* ============================================================
   DISPATCH DESK (east side, near Packing): package-tracking scam
   ============================================================ */
function drawCourierMessage(ctx,w,h,tier){
  if(tier === 'obvious'){
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#d33'; ctx.fillRect(0,0,w,44);
    ctx.fillStyle = '#fff'; ctx.font='bold 17px sans-serif';
    ctx.fillText('⚠ Delivery Failed — Pay Fee to Reschedule', 14, 28);
    ctx.fillStyle = '#333'; ctx.font='13px sans-serif';
    ctx.fillText('From: tracking@express-courrier-delivery.com', 16, 72);
    ctx.fillStyle = '#111'; ctx.font='14px sans-serif';
    ctx.fillText('Your package could not be delivered. A small fee', 16, 106);
    ctx.fillText('is required to reschedule:', 16, 126);
    ctx.fillStyle = '#2255cc'; ctx.font='13px sans-serif';
    ctx.fillText('http://courrier-redelivery.net/pay-now', 16, 152);
    ctx.strokeStyle='#ccc'; ctx.strokeRect(16,172,140,32);
    ctx.fillStyle='#d33'; ctx.font='bold 12px sans-serif'; ctx.fillText('PAY £1.99 NOW', 28, 192);
  } else if(tier === 'moderate'){
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#e4e6e8'; ctx.fillRect(0,0,w,40);
    ctx.fillStyle = '#333'; ctx.font='bold 15px sans-serif';
    ctx.fillText('Parcel Tracking Update', 16, 26);
    ctx.fillStyle = '#555'; ctx.font='12px sans-serif';
    ctx.fillText('From: updates@parcel-track-service.com', 16, 68);
    ctx.fillStyle = '#222'; ctx.font='13px sans-serif';
    ctx.fillText('Confirm your address to receive your parcel', 16, 102);
    ctx.fillText('this week.', 16, 120);
    ctx.fillStyle = '#2255cc'; ctx.font='13px sans-serif';
    ctx.fillText('http://parcel-track-service.com/confirm', 16, 148);
  } else {
    ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#e4e6e8'; ctx.fillRect(0,0,w,38);
    ctx.fillStyle = '#333'; ctx.font='bold 14px sans-serif';
    ctx.fillText('Shipment Notification', 16, 25);
    ctx.fillStyle = '#555'; ctx.font='12px sans-serif';
    ctx.fillText('From: notify@courier-shipments.com', 16, 64);
    ctx.fillStyle = '#222'; ctx.font='13px sans-serif';
    ctx.fillText('Your shipment details have changed. Review', 16, 98);
    ctx.fillText('and confirm the new schedule.', 16, 116);
    ctx.fillStyle = '#2255cc'; ctx.font='13px sans-serif';
    ctx.fillText('https://courier-shipments.com/review', 16, 144);
  }
}

function buildDispatchDesk(){
  const desk = buildDesk(13.5, -2, -Math.PI/2);
  const emailTier = DIFFICULTY_CONTENT[difficulty].emailTier;
  const mon = buildMonitor(desk, (ctx,w,h)=> drawCourierMessage(ctx,w,h,emailTier), '#f2f2f2');
  registerInteractable(mon.screen, {
    isMistake:true,
    prompt:'This monitor has a courier/tracking message open.',
    title:'Package-Tracking Scam',
    explain:'A fake courier message pressuring you to pay a small fee or click a link to "reschedule" a delivery is a common scam designed to steal card details. Genuine couriers don\'t ask for payment by email link — check the tracking number on the courier\'s own website instead.'
  });
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(13.5,0.4,-2), new THREE.Vector3(1.7,0.9,0.9)));
}

/* ============================================================
   BREAK ROOM (south-west): decorative noticeboard, no scenario here
   ============================================================ */
function buildBreakRoom(){
  const tableMat = new THREE.MeshStandardMaterial({color:0x6b5642, roughness:0.8});
  const table = new THREE.Mesh(new THREE.CylinderGeometry(0.9,0.9,0.06,20), tableMat);
  table.position.set(-13,0.75,17);
  table.castShadow = true;
  scene.add(table);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.08,0.75,10), tableMat);
  pole.position.set(-13,0.375,17);
  scene.add(pole);

  const boardMat = new THREE.MeshStandardMaterial({color:0xf4f4f4, roughness:0.4});
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.6,1.1,0.04), boardMat);
  board.position.set(-16.7,2,15);
  board.rotation.y = Math.PI/2;
  scene.add(board);

  const tex = drawnScreenTexture((ctx,w,h)=>{
    ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#333'; ctx.font = '24px "Comic Sans MS", cursive, sans-serif';
    ctx.fillText('Lunch rota this week:', 20, 60);
    ctx.fillStyle = '#555'; ctx.font='16px sans-serif';
    ctx.fillText('Mon - Tue: Aisle team A', 20, 110);
    ctx.fillText('Wed - Thu: Aisle team B', 20, 140);
    ctx.fillText('Fri: Everyone (pizza!)', 20, 170);
    ctx.fillStyle = '#888'; ctx.font='13px sans-serif';
    ctx.fillText('Please wash your mug — Facilities', 20, 220);
  }, 512,320,'#f4f4f4');
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.58,1.08),
    new THREE.MeshStandardMaterial({map:tex, roughness:0.6}));
  face.position.set(-16.68,2,15);
  face.rotation.y = Math.PI/2;
  scene.add(face);
  // Decorative only — a harmless staff noticeboard, not a security scenario.

  // stools around the table
  const stoolMat = new THREE.MeshStandardMaterial({color:0x2b2b2b, roughness:0.7});
  [[0,1.15],[0,-1.15],[1.15,0]].forEach(off=>{
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.28,0.06,14), stoolMat);
    seat.position.set(-13+off[0], 0.5, 17+off[1]);
    scene.add(seat);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,0.5,8), stoolMat);
    leg.position.set(-13+off[0], 0.25, 17+off[1]);
    scene.add(leg);
  });

  // fridge
  const fridgeMat = new THREE.MeshStandardMaterial({color:0xd8dbdd, roughness:0.35, metalness:0.4});
  const fridge = new THREE.Mesh(new THREE.BoxGeometry(0.65,1.5,0.6), fridgeMat);
  fridge.position.set(-17.3,0.75,19.2);
  fridge.castShadow = true;
  scene.add(fridge);
  const handleMat = new THREE.MeshStandardMaterial({color:0x888c90, metalness:0.7, roughness:0.3});
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03,0.7,0.03), handleMat);
  handle.position.set(-17.3+0.34,0.9,19.2);
  scene.add(handle);
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(-17.3,0.75,19.2), new THREE.Vector3(0.75,1.5,0.7)));

  // counter with microwave
  const counterMat = new THREE.MeshStandardMaterial({color:0x5a4a3a, roughness:0.7});
  const counter = new THREE.Mesh(new THREE.BoxGeometry(1.3,0.85,0.5), counterMat);
  counter.position.set(-15.4,0.425,19.2);
  scene.add(counter);
  const microMat = new THREE.MeshStandardMaterial({color:0x28292b, roughness:0.4, metalness:0.3});
  const micro = new THREE.Mesh(new THREE.BoxGeometry(0.45,0.3,0.35), microMat);
  micro.position.set(-15.4,0.99,19.2);
  scene.add(micro);
  const glassMat = new THREE.MeshStandardMaterial({color:0x1a2226, roughness:0.2, metalness:0.5});
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.26,0.18), glassMat);
  glass.position.set(-15.4-0.11,0.99,19.2+0.176);
  glass.rotation.y = Math.PI;
  scene.add(glass);
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(-15.4,0.5,19.2), new THREE.Vector3(1.4,1.2,0.6)));

  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(-13,0.4,17), new THREE.Vector3(2,1,2)));
}

/* ============================================================
   FORKLIFT BAY (forklift + hazard decal) — in the hall it sits in the
   main aisle; in the hub it is built inside the Danger Zone frame
   ============================================================ */
function buildForkliftBay(){
  // Forklift (decorative, primitives only)
  const forklift = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({color:0xe0a52c, roughness:0.5, metalness:0.4});
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.4,0.9,2.2), bodyMat);
  body.position.y = 0.6;
  forklift.add(body);
  const cage = new THREE.Mesh(new THREE.BoxGeometry(1.1,1.1,0.1), new THREE.MeshStandardMaterial({color:0x333, wireframe:true}));
  cage.position.set(0,1.5,-0.9);
  forklift.add(cage);
  const wheelMat = new THREE.MeshStandardMaterial({color:0x111, roughness:0.9});
  [[-0.65,0.3,0.8],[0.65,0.3,0.8],[-0.65,0.3,-0.8],[0.65,0.3,-0.8]].forEach(p=>{
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.3,0.25,14), wheelMat);
    wheel.rotation.z = Math.PI/2;
    wheel.position.set(p[0],p[1],p[2]);
    forklift.add(wheel);
  });
  const forkMat = new THREE.MeshStandardMaterial({color:0x888, roughness:0.4, metalness:0.7});
  [[-0.25],[0.25]].forEach(p=>{
    const fork = new THREE.Mesh(new THREE.BoxGeometry(0.12,0.06,1.4), forkMat);
    fork.position.set(p[0],0.25,1.6);
    forklift.add(fork);
  });
  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.9,2.4,0.1), new THREE.MeshStandardMaterial({color:0x555, metalness:0.6}));
  mast.position.set(0,1.2,1.05);
  forklift.add(mast);
  forklift.position.set(-5,0,10);
  forklift.rotation.y = 0.3;
  scene.add(forklift);
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(-5,0.9,10), new THREE.Vector3(2,1.8,3.6)));

  // hazard floor decal near the forklift bay
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(3.4,4.2), new THREE.MeshStandardMaterial({map:hazardStripeTexture(), roughness:0.9}));
  decal.rotation.x = -Math.PI/2;
  decal.position.set(-5,0.012,10);
  scene.add(decal);
}

/* ============================================================
   TOOLS + CLUTTER (forklift, pallet jack, pegboard) — atmosphere only
   ============================================================ */
function buildToolsAndClutter(){
  if(!customLayout) buildForkliftBay();   // in Levels 2 and 3 the forklift lives inside the Danger Zone

  // Pallet jack
  const jack = new THREE.Group();
  const jackBody = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.15,1.4), new THREE.MeshStandardMaterial({color:0xcc3b2c}));
  jackBody.position.y = 0.15;
  jack.add(jackBody);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.03,1.1,8), new THREE.MeshStandardMaterial({color:0x222}));
  handle.rotation.x = Math.PI/3.2;
  handle.position.set(0,0.55,-0.9);
  jack.add(handle);
  const jackAt = hubLayout ? [-9, 14] : (lshapeLayout ? [-4, 14] : [2, 17.5]);
  jack.position.set(jackAt[0], 0, jackAt[1]);
  jack.rotation.y = 1.1;
  scene.add(jack);

  // Wooden pallets scattered
  const palletMat = new THREE.MeshStandardMaterial({color:0x9c7a4d, roughness:0.9});
  (hubLayout ? [[-13,5],[9,8],[-8,16.5]] : (lshapeLayout ? [[-3,5],[10,9],[-7,16.5]] : [[4,-2],[ -2,6],[6,-10]])).forEach(p=>{
    const pallet = new THREE.Group();
    for(let i=0;i<5;i++){
      const plank = new THREE.Mesh(new THREE.BoxGeometry(1.0,0.04,0.12), palletMat);
      plank.position.set(0,0.1,-0.4+i*0.2);
      pallet.add(plank);
    }
    pallet.position.set(p[0],0,p[1]);
    scene.add(pallet);
  });

  // Tool pegboard on east wall (near packing) — decorative, not a mistake
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.05,1.6,2.2), new THREE.MeshStandardMaterial({color:0x3a3a3a}));
  board.position.set(ROOM.maxX-0.05, 2.2, 4);
  board.rotation.y = Math.PI/2;
  scene.add(board);
  const toolMat = new THREE.MeshStandardMaterial({color:0xb0b3b8, metalness:0.7, roughness:0.3});
  const toolHandleMat = new THREE.MeshStandardMaterial({color:0xdd6633, roughness:0.7});
  for(let i=0;i<4;i++){
    const wrench = new THREE.Mesh(new THREE.BoxGeometry(0.03,0.35,0.05), toolMat);
    wrench.position.set(ROOM.maxX-0.15, 2.7-i*0.35, 3.2+i*0.3);
    wrench.rotation.z = 0.15;
    scene.add(wrench);
  }
  for(let i=0;i<3;i++){
    const screwdriver = new THREE.Mesh(new THREE.CylinderGeometry(0.015,0.015,0.3,8), toolHandleMat);
    screwdriver.position.set(ROOM.maxX-0.15, 1.9-i*0.25, 4.6);
    screwdriver.rotation.z = Math.PI/2;
    scene.add(screwdriver);
  }

  // Fire extinguisher (pure scenery)
  const ext = new THREE.Mesh(new THREE.CylinderGeometry(0.09,0.11,0.5,10), new THREE.MeshStandardMaterial({color:0xcc2222, roughness:0.4}));
  ext.position.set(ROOM.minX+0.3, 0.5, -10);
  scene.add(ext);

  // decorative loading-dock roller door on the west exterior wall
  const rollerTex = drawnScreenTexture((ctx,w,h)=>{
    ctx.fillStyle = '#5b6169'; ctx.fillRect(0,0,w,h);
    for(let y=0;y<h;y+=18){
      ctx.fillStyle = y%36===0 ? '#4a4f56' : '#666c74';
      ctx.fillRect(0,y,w,16);
    }
    ctx.strokeStyle = '#2c2f33'; ctx.lineWidth = 6;
    ctx.strokeRect(3,3,w-6,h-6);
  }, 256,384,'#5b6169');
  const roller = new THREE.Mesh(new THREE.PlaneGeometry(3.6,5.2), new THREE.MeshStandardMaterial({map:rollerTex, roughness:0.6, metalness:0.3}));
  roller.position.set(ROOM.minX+0.06, 2.6, hubLayout ? 14.5 : (lshapeLayout ? 8 : -6));
  roller.rotation.y = Math.PI/2;
  scene.add(roller);
}

/* ============================================================
   SECURITY CAMERAS  (working decoys + one disabled — a mistake)
   ============================================================ */
function buildCameraDome(active){
  const dc = DIFFICULTY_CONTENT[difficulty];
  const group = new THREE.Group();
  const mountMat = new THREE.MeshStandardMaterial({color:0x2b2e33, roughness:0.6, metalness:0.4});
  const mount = new THREE.Mesh(new THREE.BoxGeometry(0.12,0.06,0.12), mountMat);
  group.add(mount);
  const domeMat = new THREE.MeshStandardMaterial({
    color: active ? 0xdedede : 0x55585c, roughness:0.3, metalness:0.2, transparent:true, opacity:0.88
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.08,12,8,0,Math.PI*2,0,Math.PI/2), domeMat);
  dome.rotation.x = Math.PI;
  dome.position.y = -0.05;
  group.add(dome);

  if(active){
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.012,6,6),
      new THREE.MeshStandardMaterial({color:0xff2b2b, emissive:0xff2b2b, emissiveIntensity:1}));
    led.position.set(0.07,-0.08,0.02);
    led._blink = Math.random()*Math.PI*2;
    const ledGroup = new THREE.Group(); ledGroup.add(led);
    group.add(ledGroup);
    group.userData.leds = ledGroup;
  } else {
    // Even the "disconnected" camera gets a faint, non-blinking LED on
    // harder levels — the only tell left is that it never flickers.
    if(dc.camLedOffIntensity > 0){
      const dimLed = new THREE.Mesh(new THREE.SphereGeometry(0.012,6,6),
        new THREE.MeshStandardMaterial({color:0xff2b2b, emissive:0xff2b2b, emissiveIntensity:dc.camLedOffIntensity}));
      dimLed.position.set(0.07,-0.08,0.02);
      group.add(dimLed);
    }
    // the giveaway dangling wire only shows up on the easier levels
    if(difficulty !== 'hard'){
      const wireMat = new THREE.MeshStandardMaterial({color:0x111111, roughness:0.8});
      const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.005,0.005,0.22,6), wireMat);
      wire.position.set(0.06,-0.16,0);
      wire.rotation.z = 0.35;
      group.add(wire);
    }
  }
  return group;
}

function buildSecurityCameras(){
  // All three cameras are working scenery here — camera coverage itself
  // isn't one of this build's judged scenarios (see the Danger Zone and
  // Reception areas for this level's real access-control issues).
  (hubLayout ? [[-23.5,12.5],[23.5,-10],[0,-17.2]] : (lshapeLayout ? [[-23.5,12],[23.5,16],[-23.5,-21]] : [[-2,22],[8,-17],[4,23]])).forEach(([x,z])=>{
    const cam = buildCameraDome(true);
    cam.position.set(x, 5.5, z);
    cam.rotation.x = 0.3;
    scene.add(cam);
  });
}

/* ============================================================
   MANAGER'S OFFICE (south-east pocket): unlocked admin laptop +
   unshredded documents, plus a properly locked decoy cabinet
   ============================================================ */
function buildManagerOffice(){
  const wallMat = new THREE.MeshStandardMaterial({color:0x2c3036, roughness:0.7});
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(5.4,3,0.15), wallMat);
  backWall.position.set(15.2,1.5,19);
  scene.add(backWall);
  const sideWall = new THREE.Mesh(new THREE.BoxGeometry(0.15,3,8), wallMat);
  sideWall.position.set(12.5,1.5,15);
  scene.add(sideWall);
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(15.2,1.5,19), new THREE.Vector3(5.4,3,0.4)));
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(12.5,1.5,15), new THREE.Vector3(0.4,3,8)));

  // desk with an unlocked laptop open on an HR admin panel
  const desk = buildDesk(16, 15, Math.PI/2);
  const laptopBase = new THREE.Mesh(new THREE.BoxGeometry(0.34,0.02,0.24),
    new THREE.MeshStandardMaterial({color:0x3a3d42, roughness:0.4, metalness:0.5}));
  laptopBase.position.set(0,0.79,-0.1);
  desk.add(laptopBase);
  const screenTex = drawnScreenTexture((ctx,w,h)=>{
    ctx.fillStyle = '#101418'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#ffc93c'; ctx.font = 'bold 20px sans-serif';
    ctx.fillText('HR Admin Panel — All Employees', 16,34);
    ctx.fillStyle = '#c9d2da'; ctx.font = '13px sans-serif';
    const rows = [['A. Rossi','$54,200'],['T. Meyer','$61,000'],['S. Lund','$48,750'],['J. Smith','$58,300']];
    rows.forEach((r,i)=>{
      ctx.fillText(r[0], 16, 70+i*28);
      ctx.fillText(r[1], 190, 70+i*28);
    });
    ctx.fillStyle = '#5ac87a'; ctx.font = '12px sans-serif';
    ctx.fillText('Session active — no lock required', 16, h-16);
  }, 512,320,'#101418');
  const laptopScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.3,0.2),
    new THREE.MeshStandardMaterial({map:screenTex, emissive:0xffffff, emissiveMap:screenTex, emissiveIntensity:0.5}));
  laptopScreen.position.set(0,0.9,-0.21);
  laptopScreen.rotation.x = -0.35;
  desk.add(laptopScreen);
  registerInteractable(laptopScreen, {
    isMistake:true,
    prompt:'A laptop here is open, showing something on screen.',
    title:'Unlocked Admin Session Left Open',
    explain:"A manager's laptop logged into an HR admin panel, unattended and unlocked, exposes every employee's personal and pay data to anyone walking past. Lock the screen every time you step away, even for a minute."
  });

  // filing cabinet with overflowing, unshredded documents
  const cabinetMat = new THREE.MeshStandardMaterial({color:0x4a4f56, roughness:0.6, metalness:0.4});
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.5,1.0,0.5), cabinetMat);
  cabinet.position.set(17.3,0.5,17.5);
  scene.add(cabinet);
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(17.3,0.5,17.5), new THREE.Vector3(0.6,1,0.6)));

  // Filing cabinet and shredder are scenery here — this office's judged
  // scenario is the unlocked admin session above; a tidy stack of paper
  // by the shredder (nothing left loose) avoids overlapping the new,
  // more realistic document scenario in the Meeting Room.
  const shredder = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.35,0.25), new THREE.MeshStandardMaterial({color:0x1c1e21, roughness:0.5}));
  shredder.position.set(16.6,0.18,17.9);
  scene.add(shredder);

  // decoy: a second, properly locked cabinet
  const cabinet2 = new THREE.Mesh(new THREE.BoxGeometry(0.5,1.0,0.5), cabinetMat);
  cabinet2.position.set(17.3,0.5,12.5);
  scene.add(cabinet2);
  const lockMat = new THREE.MeshStandardMaterial({color:0xffc93c, emissive:0xffc93c, emissiveIntensity:0.3});
  const lockBody = new THREE.Mesh(new THREE.BoxGeometry(0.08,0.07,0.02), lockMat);
  lockBody.position.set(17.05,0.55,12.5);
  scene.add(lockBody);
  registerInteractable(cabinet2, {
    isMistake:false,
    prompt:'This filing cabinet is closed.',
    title:'Nothing Wrong Here',
    explain:'Locked filing cabinet — exactly how records should be stored when nobody is using them.'
  });
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(17.3,0.5,12.5), new THREE.Vector3(0.6,1,0.6)));

  // leather chair for atmosphere
  const chairMat = new THREE.MeshStandardMaterial({color:0x3a2a20, roughness:0.6});
  const chairSeat = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.08,0.5), chairMat);
  chairSeat.position.set(16,0.5,13.6);
  scene.add(chairSeat);
  const chairBack = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.6,0.08), chairMat);
  chairBack.position.set(16,0.85,13.33);
  scene.add(chairBack);
}

/* ============================================================
   DANGER ZONE (forklift bay, main aisle): unescorted person +
   authorised-operator decoy
   ============================================================ */
function buildDangerZoneBoard(x,z){
  const postMat = new THREE.MeshStandardMaterial({color:0x2b2b2b, roughness:0.6, metalness:0.4});
  [-0.9, 0.9].forEach(dx=>{
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,2.4,8), postMat);
    post.position.set(x+dx, 1.2, z);
    scene.add(post);
  });
  const tex = drawnScreenTexture((ctx,w,h)=>{
    ctx.fillStyle = '#141414'; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = '#ffc93c'; ctx.lineWidth = 8; ctx.strokeRect(6,6,w-12,h-12);
    ctx.fillStyle = '#ffc93c'; ctx.font='bold 48px sans-serif'; ctx.textAlign='center';
    ctx.fillText('⚠ DANGER ZONE', w/2, h/2-6);
    ctx.font='16px sans-serif';
    ctx.fillText('AUTHORISED PERSONNEL ONLY — BADGE REQUIRED', w/2, h/2+34);
    ctx.textAlign='left';
  }, 640,180,'#141414');
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.4,0.96),
    new THREE.MeshStandardMaterial({map:tex, roughness:0.5}));
  board.position.set(x, 2.3, z+0.05);
  scene.add(board);

  // A pair of flashing hazard beacons either side of the board — an
  // "advanced" access-control touch beyond the plain warning sign,
  // reusing the same LED-blink system the cameras/router already use.
  const beaconGroup = new THREE.Group();
  [-1.3, 1.3].forEach(dx=>{
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.07,10,10),
      new THREE.MeshStandardMaterial({color:0xff7a1e, emissive:0xff7a1e, emissiveIntensity:1}));
    beacon.position.set(x+dx, 2.05, z+0.1);
    beacon._blink = Math.random()*Math.PI*2;
    beaconGroup.add(beacon);
  });
  scene.add(beaconGroup);
  // hook into the same per-frame LED pulse used elsewhere — attach to a
  // dummy object with userData.leds so animate()'s existing traversal finds it
  const beaconAnchor = new THREE.Group();
  beaconAnchor.userData.leds = beaconGroup;
  scene.add(beaconAnchor);
}

function buildWarningSign(x,z,rotY){
  const postMat = new THREE.MeshStandardMaterial({color:0x2b2b2b, roughness:0.6});
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,1.6,8), postMat);
  post.position.set(x,0.8,z);
  scene.add(post);
  const tex = drawnScreenTexture((ctx,w,h)=>{
    ctx.fillStyle = '#ffc93c'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#141414';
    ctx.beginPath(); ctx.moveTo(w/2,20); ctx.lineTo(w-24,h-30); ctx.lineTo(24,h-30); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffc93c'; ctx.font='bold 34px sans-serif'; ctx.textAlign='center';
    ctx.fillText('!', w/2, h-48);
    ctx.fillStyle = '#141414'; ctx.font='bold 15px sans-serif';
    ctx.fillText('RESTRICTED', w/2, h-14);
    ctx.textAlign='left';
  }, 160,160,'#ffc93c');
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.5,0.5), new THREE.MeshStandardMaterial({map:tex, roughness:0.6}));
  sign.position.set(x,1.5,z+0.06);
  sign.rotation.y = rotY || 0;
  scene.add(sign);
}

function buildBadgeReader(){
  const group = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({color:0x3a3f45, roughness:0.5, metalness:0.5});
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.1,1.1,0.1), postMat);
  post.position.y = 0.55;
  group.add(post);
  const readerTex = drawnScreenTexture((ctx,w,h)=>{
    ctx.fillStyle = '#1c1e21'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#2f9e52'; ctx.fillRect(w/2-14,h/2-14,28,28);
  }, 64,64,'#1c1e21');
  const reader = new THREE.Mesh(new THREE.BoxGeometry(0.12,0.16,0.03), new THREE.MeshStandardMaterial({map:readerTex}));
  reader.position.set(0,1.0,0.06);
  group.add(reader);
  return group;
}

function buildDangerZone(){
  // Warning signage, a labeled overhead board, and a badge reader mark
  // this out as a restricted area, around the existing forklift bay
  // (built in buildToolsAndClutter).
  buildDangerZoneBoard(-5, 13.55);
  buildWarningSign(-5, 13.6, Math.PI);
  const reader = buildBadgeReader();
  reader.position.set(-2.3, 0, 13.6);
  scene.add(reader);
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(-2.3,0.5,13.6), new THREE.Vector3(0.4,1.1,0.4)));

  // hazard barrier tape around the bay perimeter, now with corner posts
  // so it reads as a real cordoned-off enclosure rather than floating planes
  const tapeMat = new THREE.MeshStandardMaterial({map:hazardStripeTexture(), roughness:0.9});
  const postMat2 = new THREE.MeshStandardMaterial({color:0x2b2b2b, roughness:0.6, metalness:0.3});
  const corners = [[-7.2,7.6],[-2.8,7.6],[-7.2,12.4],[-2.8,12.4]];
  corners.forEach(([cx,cz])=>{
    const cpost = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,1.3,8), postMat2);
    cpost.position.set(cx,0.65,cz);
    scene.add(cpost);
  });
  [[-7.2,7.6,0],[-2.8,7.6,0],[-7.2,12.4,Math.PI/2],[-2.8,12.4,Math.PI/2]].forEach(([tx,tz,rot])=>{
    const tape = new THREE.Mesh(new THREE.PlaneGeometry(4.8,0.35), tapeMat);
    tape.position.set(tx,1.1,tz);
    tape.rotation.y = rot;
    scene.add(tape);
  });

  // floor hazard striping outlining the enclosure, so the boundary is
  // readable from a distance, not just at barrier height
  const floorHazard = new THREE.Mesh(new THREE.RingGeometry(3.0,3.35,4,1), tapeMat);
  floorHazard.rotation.x = -Math.PI/2;
  floorHazard.position.set(-5,0.015,10);
  floorHazard.rotation.z = Math.PI/4;
  scene.add(floorHazard);

  // warm accent spotlight over the zone, giving it a distinct look from
  // the rest of the warehouse floor rather than just standard overhead lighting
  const accentLight = new THREE.SpotLight(0xffb020, 1.1, 14, Math.PI/5, 0.5, 1.3);
  accentLight.position.set(-5, 8.5, 10);
  accentLight.target.position.set(-5, 0, 10);
  scene.add(accentLight);
  scene.add(accentLight.target);

  const strangerTier = DIFFICULTY_CONTENT[difficulty].strangerTier;
  const strangerPrompt = strangerTier === 'obvious'
    ? 'Someone in plain clothes, with no hi-vis vest or badge visible, is standing inside the restricted bay.'
    : strangerTier === 'moderate'
    ? 'Someone is standing inside the restricted bay. You don\'t recognize them, and they aren\'t wearing a visible badge.'
    : 'Someone is standing near the edge of the restricted bay, not clearly wearing any visible ID.';

  // Real issue: an unescorted person with no visible badge or PPE, inside the restricted bay.
  const stranger = buildHumanoid({shirt:0x555a61, pants:0x2b2b2b, skin:0xc9a06b});
  const hoodMat = new THREE.MeshStandardMaterial({color:0x2c2f33, roughness:0.9});
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.19,12,10,0,Math.PI*2,0,Math.PI/1.7), hoodMat);
  hood.position.y = 1.60;
  stranger.group.add(hood);
  stranger.group.position.set(-6, 0, 9.5);
  stranger.group.rotation.y = 0.6;
  scene.add(stranger.group);
  updateIdleBob(stranger, 0);
  registerInteractable(stranger.group, {
    isMistake:true,
    prompt:strangerPrompt,
    title:'Unescorted Person in Danger Zone',
    explain:'Restricted areas with moving machinery need controlled, badge-checked access — an unescorted person without visible ID or PPE inside one is both a safety and a security risk. They should be challenged or reported immediately, not assumed to belong there.'
  });

  // Decoy: a properly badged, hi-vis operator, also standing in the bay.
  const operator = buildHumanoid({shirt:0xff8a1e, pants:0x2c3540, helmet:0xffd23f, vestStripes:true});
  const badgeMat = new THREE.MeshStandardMaterial({color:0xf2f2f2, roughness:0.4});
  const chestBadge = new THREE.Mesh(new THREE.BoxGeometry(0.09,0.12,0.01), badgeMat);
  chestBadge.position.set(0.12,1.2,0.14);
  operator.torso.add(chestBadge);
  operator.group.position.set(-3.6, 0, 10.5);
  operator.group.rotation.y = -0.4;
  scene.add(operator.group);
  updateIdleBob(operator, 0);
  registerInteractable(operator.group, {
    isMistake:false,
    prompt:'A worker in a hi-vis vest and helmet, with a visible badge, is operating in the restricted bay.',
    title:'Authorised Operator',
    explain:'Properly badged, in the right protective equipment, and working in the area they\'re cleared for — exactly how the restricted bay should be used.'
  });

  ZONE_HUMANOIDS.push(stranger, operator);
}

/* ============================================================
   MEETING ROOM (north-center, behind Office Nook): confidential
   printout left unattended + a locked-waste-bin decoy
   ============================================================ */
function buildMeetingRoom(){
  const roomX = 4, roomZ = -22, halfW = 4.4, halfD = 2.6;
  const glassMat = new THREE.MeshStandardMaterial({color:0x8fa3b0, roughness:0.15, metalness:0.1, transparent:true, opacity:0.22});
  const frameMat = new THREE.MeshStandardMaterial({color:0x2b2f34, roughness:0.6, metalness:0.5});

  // four low glass walls with corner framing posts, so the room reads as
  // an enclosed meeting space without blocking sightlines into it
  const wallDefs = [
    { w: halfW*2, pos:[roomX, 1.1, roomZ-halfD], rotY:0 },
    { w: halfW*2, pos:[roomX, 1.1, roomZ+halfD], rotY:Math.PI },
    { w: halfD*2, pos:[roomX-halfW, 1.1, roomZ], rotY:Math.PI/2 },
    { w: halfD*2, pos:[roomX+halfW, 1.1, roomZ], rotY:-Math.PI/2 },
  ];
  wallDefs.forEach(wd=>{
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(wd.w, 2.2), glassMat);
    wall.position.set(wd.pos[0], wd.pos[1], wd.pos[2]);
    wall.rotation.y = wd.rotY;
    scene.add(wall);
  });
  [[-halfW,-halfD],[halfW,-halfD],[-halfW,halfD],[halfW,halfD]].forEach(([dx,dz])=>{
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08,2.2,0.08), frameMat);
    post.position.set(roomX+dx, 1.1, roomZ+dz);
    scene.add(post);
  });
  // doorway gap left open on the +Z side (facing the main floor) — one
  // post is set back to leave a walk-in gap rather than a solid wall
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(roomX, 1.1, roomZ-halfD), new THREE.Vector3(halfW*2, 2.2, 0.15)));
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(roomX-halfW, 1.1, roomZ), new THREE.Vector3(0.15, 2.2, halfD*2)));
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(roomX+halfW, 1.1, roomZ), new THREE.Vector3(0.15, 2.2, halfD*2)));

  // meeting table + chairs
  const tableMat = new THREE.MeshStandardMaterial({color:0x5a4a3a, roughness:0.7});
  const table = new THREE.Mesh(new THREE.BoxGeometry(2.4,0.06,1.1), tableMat);
  table.position.set(roomX, 0.75, roomZ);
  scene.add(table);
  const legGeo = new THREE.BoxGeometry(0.06,0.75,0.06);
  [[-1.1,-0.45],[1.1,-0.45],[-1.1,0.45],[1.1,0.45]].forEach(([dx,dz])=>{
    const leg = new THREE.Mesh(legGeo, tableMat);
    leg.position.set(roomX+dx, 0.375, roomZ+dz);
    scene.add(leg);
  });
  const chairMat = new THREE.MeshStandardMaterial({color:0x2b2b2b, roughness:0.7});
  [[-0.9,-0.85],[0,-0.85],[0.9,-0.85],[-0.9,0.85],[0,0.85],[0.9,0.85]].forEach(([dx,dz])=>{
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.4,0.06,0.4), chairMat);
    seat.position.set(roomX+dx, 0.46, roomZ+dz);
    scene.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.4,0.45,0.05), chairMat);
    back.position.set(roomX+dx, 0.7, roomZ+dz + (dz<0?-0.19:0.19));
    scene.add(back);
  });
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(roomX,0.75,roomZ), new THREE.Vector3(3.4,1.5,2.4)));

  // wall-mounted screen (decorative)
  const screenTex = drawnScreenTexture((ctx,w,h)=>{
    ctx.fillStyle = '#101418'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#ffc93c'; ctx.font='bold 18px sans-serif';
    ctx.fillText('Weekly Ops Review', 16,32);
    ctx.fillStyle = '#7fa0bd'; ctx.font='12px sans-serif';
    ctx.fillText('Agenda loading…', 16,60);
  }, 400,240,'#101418');
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.1,0.66), new THREE.MeshStandardMaterial({map:screenTex, emissive:0xffffff, emissiveMap:screenTex, emissiveIntensity:0.4}));
  screen.position.set(roomX+halfW-0.1, 1.7, roomZ);
  screen.rotation.y = -Math.PI/2;
  scene.add(screen);

  // printer with the (moved) confidential printout scenario
  const printerMat = new THREE.MeshStandardMaterial({color:0x2a2c2f, roughness:0.5});
  const printer = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.35,0.4), printerMat);
  printer.position.set(roomX-halfW+0.4, 0.5, roomZ-halfD+0.35);
  scene.add(printer);
  const printerStand = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.35,0.4), new THREE.MeshStandardMaterial({color:0x4a4d52, roughness:0.6}));
  printerStand.position.set(roomX-halfW+0.4, 0.15, roomZ-halfD+0.35);
  scene.add(printerStand);

  const paperTex = drawnScreenTexture((ctx,w,h)=>{
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#111'; ctx.font='bold 20px serif';
    ctx.fillText('CONFIDENTIAL', 18,36);
    ctx.font='12px serif';
    ctx.fillText('Shipment Manifest — Customer Records', 18,64);
    ctx.fillText('Name: A. Rossi   SSN: •••-••-1234', 18,100);
    ctx.fillText('Name: T. Meyer   SSN: •••-••-8890', 18,120);
    ctx.fillText('Address & payment details attached...', 18,146);
  }, 256,320,'#fff');
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.24,0.31),
    new THREE.MeshStandardMaterial({map:paperTex, roughness:0.9}));
  paper.rotation.x = -Math.PI/2 + 0.55; // propped up in the tray, not lying perfectly flat — visible from a normal standing viewpoint
  paper.position.set(roomX-halfW+0.3, 0.78, roomZ-halfD+0.42);
  paper.rotation.z = 0.12;
  scene.add(paper);
  registerInteractable(paper, {
    isMistake:true,
    prompt:'There\'s a printed document sitting in the printer\'s output tray.',
    title:'Confidential Printout Left Unattended',
    explain:'Sensitive documents sitting in an open printer tray can be read or taken by anyone passing by. Confidential printouts should be collected immediately or sent to a secure "follow-me" print queue.'
  });
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(roomX-halfW+0.4,0.5,roomZ-halfD+0.35), new THREE.Vector3(0.6,1,0.6)));

  // decoy: a locked confidential-waste bin, properly secured
  const binMat = new THREE.MeshStandardMaterial({color:0x3a3f45, roughness:0.6, metalness:0.3});
  const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.22,0.5,12), binMat);
  bin.position.set(roomX+halfW-0.4, 0.25, roomZ+halfD-0.35);
  scene.add(bin);
  const lockMat = new THREE.MeshStandardMaterial({color:0xffc93c, emissive:0xffc93c, emissiveIntensity:0.3});
  const lock = new THREE.Mesh(new THREE.BoxGeometry(0.06,0.08,0.02), lockMat);
  lock.position.set(roomX+halfW-0.4+0.22, 0.35, roomZ+halfD-0.35);
  scene.add(lock);
  registerInteractable(bin, {
    isMistake:false,
    prompt:'There\'s a confidential-waste bin here, latched shut.',
    title:'Properly Secured',
    explain:'A locked confidential-waste bin, exactly how documents that are actually finished with should be disposed of. No points, but nothing to report either.'
  });
  obstacles.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(roomX+halfW-0.4,0.25,roomZ+halfD-0.35), new THREE.Vector3(0.5,0.5,0.5)));
}

/* ============================================================
   LEVEL 3 — THE HUB
   A wide east–west distribution hub. Every area is the same one used on
   Levels 1 and 2 (same 13 tasks, same 6 decoys), moved to its Level 3
   spot with withFrame(rotation, x, z, builder). Rotations are quarter
   turns, so collision boxes stay exact.

     west wall ........ main entrance, reception, IT officer
     north wall ....... office nook, break room (scenery), server room
     centre block ..... meeting room + manager's office
     south, middle .... danger zone (forklift bay)
     south-east ....... packing station, dispatch desk
     east wall ........ loading-dock door (the propped-open door)
   ============================================================ */
function buildMainEntranceDoor(side, z){
  // The main entrance, closed. (The propped-open door task is a different door:
  // the loading-dock door.) side = 'west' (x = minX) or 'east' (x = maxX).
  const wallX = side === 'east' ? ROOM.maxX : ROOM.minX;
  const into = side === 'east' ? -1 : 1;          // which way is "inside the room"
  const frameMat = new THREE.MeshStandardMaterial({color:0x2c2f33, roughness:0.6, metalness:0.5});
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.2,4.4,3.4), frameMat);
  frame.position.set(wallX + 0.05*into, 2.2, z);
  scene.add(frame);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.08,4.2,3.0),
    new THREE.MeshStandardMaterial({color:0x8b8f94, roughness:0.4, metalness:0.7}));
  door.position.set(wallX + 0.15*into, 2.1, z);
  scene.add(door);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06,0.08,1.2),
    new THREE.MeshStandardMaterial({color:0xcfd3d8, roughness:0.3, metalness:0.8}));
  bar.position.set(wallX + 0.22*into, 1.1, z);
  scene.add(bar);
}

function buildHubAreas(){
  buildMainEntranceDoor('west', 9);

  withFrame(Math.PI,    -22.5, -34.1, buildOfficeNook);    // desks along the north wall, screens facing the north lane
  withFrame(Math.PI,    -23,    29.5, buildReception);     // beside the entrance, screen facing the player
  withFrame(0,           10.5,   4.5, buildServerRoom);    // north-east corner
  withFrame(-Math.PI/2,  20,     0.5, buildPackingStation);// south-east, desks facing the main aisle
  withFrame(-Math.PI/2,  20,     0.5, buildDispatchDesk);  // next to the packing desks, near the dock
  withFrame(-Math.PI/2,  17.5,   0,   buildBreakRoom);     // scenery on the north wall
  withFrame(0,           -7.5,  16.5, buildMeetingRoom);   // centre block, west half (open side faces south)
  withFrame(Math.PI,      18.9, 10.9, buildManagerOffice); // centre block, east half, door faces south
  withFrame(Math.PI/2,    0,    14.5, buildEntranceDoor);  // loading-dock door on the east wall (propped open)
  withFrame(Math.PI,     -3.5,  24,   ()=>{               // restricted bay south of the main aisle
    buildDangerZone();
    buildForkliftBay();
  });
}

/* ============================================================
   LEVEL 2 — THE L-SHAPED WAREHOUSE
   Two wings meeting at a corner; the inside of the L is a solid block.
   Same areas, same 13 tasks and 6 decoys as every other level — each area is
   built as it always was and moved into place with withFrame(rotation, x, z, builder).

     south wing (x 0..24, z 0..20) ... main entrance (east wall), reception,
                                        packing station, dispatch desk
     the corner (x -24..0, z 0..20) ... danger zone, break room (scenery)
     west wing (x -24..0, z -24..0) ... office nook, meeting room, manager's
                                        office, server room, loading-dock door
   ============================================================ */
function buildLShapeAreas(){
  buildMainEntranceDoor('east', 12);

  withFrame( Math.PI/2,   3.5,  4,    buildReception);      // beside the entrance, screen facing the player
  withFrame(-Math.PI/2,  17,    3.5,  buildPackingStation); // along the south wall, desks facing the aisle
  withFrame(-Math.PI/2,  17,    3.5,  buildDispatchDesk);   // next to the packing desks
  withFrame( 0,          -6,    0,    buildBreakRoom);      // scenery in the south-west corner
  withFrame( 0,         -30,   -2,    buildServerRoom);     // north-west corner of the west wing
  withFrame(-Math.PI/2, -41,   -3,    buildOfficeNook);     // desks down the west wall, screens facing east
  withFrame(-Math.PI/2, -24.8, -17.1, buildMeetingRoom);    // against the solid block, open side facing west
  withFrame( Math.PI/2, -19.2, 11.5,  buildManagerOffice);  // against the solid block, open side facing west
  withFrame( Math.PI,    -6,    1,    buildEntranceDoor);   // loading-dock door on the north wall (propped open)
  withFrame( Math.PI/2, -19,    4,    ()=>{                // restricted bay at the corner, board facing the south wing
    buildDangerZone();
    buildForkliftBay();
  });
}

/* ============================================================
   DUST MOTES (subtle atmosphere, procedural sprite, no images)
   ============================================================ */
let dustPoints = null;
function dustSpriteTexture(){
  const c = makeCanvas(32,32);
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(16,16,0,16,16,16);
  grad.addColorStop(0,'rgba(255,255,255,0.9)');
  grad.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0,0,32,32);
  return new THREE.CanvasTexture(c);
}
function buildDustMotes(){
  const count = 220;
  const positions = new Float32Array(count*3);
  for(let i=0;i<count;i++){
    positions[i*3] = ROOM.minX + Math.random()*(ROOM.maxX-ROOM.minX);
    positions[i*3+1] = 0.5 + Math.random()*8;
    positions[i*3+2] = ROOM.minZ + Math.random()*(ROOM.maxZ-ROOM.minZ);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  const mat = new THREE.PointsMaterial({
    size:0.06, map:dustSpriteTexture(), transparent:true, opacity:0.3,
    depthWrite:false, color:0xfff3d6
  });
  dustPoints = new THREE.Points(geo, mat);
  scene.add(dustPoints);
}

/* ============================================================
   CHARACTERS  (humanoids built from primitives, no images)
   ============================================================ */
function buildHumanoid(opts){
  opts = opts || {};
  const skin = opts.skin || 0xd9a066;
  const shirt = opts.shirt || 0xff8a1e;
  const pants = opts.pants || 0x2c3540;
  const helmet = opts.helmet;

  const group = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({color:skin, roughness:0.8});
  const shirtMat = new THREE.MeshStandardMaterial({color:shirt, roughness:0.7});
  const pantsMat = new THREE.MeshStandardMaterial({color:pants, roughness:0.8});

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44,0.58,0.26), shirtMat);
  torso.position.y = 1.15;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16,14,14), skinMat);
  head.position.y = 1.58;
  head.castShadow = true;
  group.add(head);

  if(helmet){
    const hat = new THREE.Mesh(new THREE.SphereGeometry(0.175,14,10,0,Math.PI*2,0,Math.PI/1.9), new THREE.MeshStandardMaterial({color:helmet, roughness:0.4}));
    hat.position.y = 1.63;
    group.add(hat);
  } else {
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.165,14,10,0,Math.PI*2,0,Math.PI/2.2), new THREE.MeshStandardMaterial({color:0x2b2118, roughness:0.9}));
    hair.position.y = 1.62;
    group.add(hair);
  }

  const armGeo = new THREE.CylinderGeometry(0.055,0.05,0.5,10);
  const leftArmPivot = new THREE.Group(); leftArmPivot.position.set(-0.28,1.42,0);
  const leftArm = new THREE.Mesh(armGeo, shirtMat); leftArm.position.y=-0.25; leftArm.castShadow=true;
  leftArmPivot.add(leftArm); group.add(leftArmPivot);
  const rightArmPivot = new THREE.Group(); rightArmPivot.position.set(0.28,1.42,0);
  const rightArm = new THREE.Mesh(armGeo, shirtMat); rightArm.position.y=-0.25; rightArm.castShadow=true;
  rightArmPivot.add(rightArm); group.add(rightArmPivot);

  const legGeo = new THREE.CylinderGeometry(0.07,0.06,0.62,10);
  const leftLegPivot = new THREE.Group(); leftLegPivot.position.set(-0.12,0.86,0);
  const leftLeg = new THREE.Mesh(legGeo, pantsMat); leftLeg.position.y=-0.31; leftLeg.castShadow=true;
  leftLegPivot.add(leftLeg); group.add(leftLegPivot);
  const rightLegPivot = new THREE.Group(); rightLegPivot.position.set(0.12,0.86,0);
  const rightLeg = new THREE.Mesh(legGeo, pantsMat); rightLeg.position.y=-0.31; rightLeg.castShadow=true;
  rightLegPivot.add(rightLeg); group.add(rightLegPivot);

  if(opts.vestStripes){
    const stripeMat = new THREE.MeshStandardMaterial({color:0xffe14d, emissive:0xffe14d, emissiveIntensity:0.15});
    const s1 = new THREE.Mesh(new THREE.BoxGeometry(0.45,0.07,0.27), stripeMat);
    s1.position.set(0,1.28,0); torso.add(s1);
    const s2 = s1.clone(); s2.position.y = -0.22; torso.add(s2);
  }

  return {
    group, torso, head,
    leftArmPivot, rightArmPivot, leftLegPivot, rightLegPivot,
    phase: Math.random()*Math.PI*2
  };
}

function updateWalkCycle(char, dt, speed){
  char.phase += dt * speed * 5.2;
  const amp = 0.55;
  char.leftLegPivot.rotation.x = Math.sin(char.phase) * amp;
  char.rightLegPivot.rotation.x = Math.sin(char.phase+Math.PI) * amp;
  char.leftArmPivot.rotation.x = Math.sin(char.phase+Math.PI) * amp * 0.8;
  char.rightArmPivot.rotation.x = Math.sin(char.phase) * amp * 0.8;
}

function updateIdleBob(char, t){
  char.torso.scale.y = 1 + Math.sin(t*1.6 + char.phase)*0.015;
  char.head.position.y = 1.58 + Math.sin(t*1.6 + char.phase)*0.008;
}

function buildCharacters(){
  // Worker 1 - patrols central aisle
  const w1 = buildHumanoid({shirt:0xff8a1e, pants:0x2c3540, helmet:0xffd23f, vestStripes:true});
  w1.group.position.set(hubLayout ? -14 : (lshapeLayout ? 12 : 0), 0, hubLayout ? 7 : (lshapeLayout ? 10 : -12));
  scene.add(w1.group);
  w1.path = hubLayout ? [ new THREE.Vector3(-14,0,7), new THREE.Vector3(14,0,7) ]        // main aisle
          : lshapeLayout ? [ new THREE.Vector3(20,0,10), new THREE.Vector3(-4,0,10) ]    // south wing aisle
                      : [ new THREE.Vector3(0,0,-16), new THREE.Vector3(0,0,10) ];
  w1.pathIndex = 0;
  w1.speed = 1.1;
  workers.push(w1);

  // Worker 2 - patrols packing side aisle
  const w2 = buildHumanoid({shirt:0xffb020, pants:0x33383f, helmet:0xffd23f, vestStripes:true});
  w2.group.position.set(hubLayout ? -10 : (lshapeLayout ? -14.75 : 9), 0, hubLayout ? -10.5 : (lshapeLayout ? -8 : 3));
  scene.add(w2.group);
  w2.path = hubLayout ? [ new THREE.Vector3(-16,0,-10.5), new THREE.Vector3(16,0,-10.5) ]   // north lane
          : lshapeLayout ? [ new THREE.Vector3(-14.75,0,-18), new THREE.Vector3(-14.75,0,5) ] // west wing aisle, between the rack columns
                      : [ new THREE.Vector3(9,0,-2), new THREE.Vector3(9,0,12) ];
  w2.pathIndex = 0;
  w2.speed = 0.9;
  workers.push(w2);

  // IT Officer - stands near entrance, clickable for hints
  const off = buildHumanoid({shirt:0x2255aa, pants:0x2b2e33, skin:0xc98a5b});
  off.group.position.set(hubLayout ? -22.4 : (lshapeLayout ? 22.4 : 2.5), 0, hubLayout ? 5.3 : (lshapeLayout ? 8.3 : 17.5));
  off.group.rotation.y = hubLayout ? Math.PI/2 : (lshapeLayout ? -0.25 : Math.PI);
  scene.add(off.group);

  const tabletMat = new THREE.MeshStandardMaterial({color:0xeeeeee, roughness:0.3});
  const tablet = new THREE.Mesh(new THREE.BoxGeometry(0.18,0.24,0.02), tabletMat);
  tablet.position.set(0.05,-0.15,0.18);
  off.rightArmPivot.add(tablet);

  officer = off;
  officer.hintIndex = 0;
  officer.hints = [
    'Anything written down near a keyboard is worth a second look.',
    'Check whether the server room door is actually secured.',
    'An exterior door should never stay propped open.',
    'Unattended access badges are an easy way in for the wrong person.',
    'If a screen is unlocked and nobody is sitting there, take a look.',
    'Unknown USB drives should never go into a live machine.',
    'Printed documents left sitting out can walk away with anyone.',
    'An unexpected email attachment is worth checking carefully before opening.',
    'A courier message asking you to pay or click a link is worth a second look.',
    'Restricted areas should only ever have badged, authorised people in them.'
  ];

  registerInteractable(officer.group, { type:'officer' });
}

/* ============================================================
   INPUT
   ============================================================ */
function setupInput(){
  const canvas = renderer.domElement;

  if(lockedLevel){
    document.getElementById('diff-row').style.display = 'none';
    const label = document.getElementById('mission-locked-label');
    label.textContent = 'MISSION: ' + levelLabel(lockedLevel);
    label.style.display = 'block';
  } else {
    document.querySelectorAll('.diff-btn').forEach(btn=>{
      if(btn.dataset.diff === difficulty) btn.classList.add('active');
      else btn.classList.remove('active');
      btn.addEventListener('click', ()=>{
        document.querySelectorAll('.diff-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        difficulty = btn.dataset.diff;
      });
    });
  }

  document.getElementById('start-btn').addEventListener('click', ()=>{
    ensureAudio();
    startAmbientMusic();
    gameSettings = getSettings();
    const d = DIFFICULTIES[difficulty];
    timeLeft = d.time;
    wrongPenalty = d.wrongPenalty;
    minimapMode = d.minimap;
    practiceMode = (gameSettings.timerEnabled === false);

    document.getElementById('start-overlay').classList.add('hidden');
    document.getElementById('hud').style.display='flex';
    document.getElementById('hint-bar').style.display='block';
    document.getElementById('crosshair').style.display='block';
    document.getElementById('compass').style.display = gameSettings.hints === false ? 'none' : 'block';
    document.getElementById('minimap-wrap').style.display = (minimapMode === 'none' || gameSettings.hints === false) ? 'none' : 'block';

    gameRunning = true;
    updateTimer(0);
    canvas.requestPointerLock();
  });

  document.getElementById('resume-btn').addEventListener('click', ()=>{
    canvas.requestPointerLock();
  });

  document.getElementById('exit-dashboard-btn').addEventListener('click', ()=>{
    window.location.href = 'dashboard.html';
  });

  document.getElementById('restart-btn').addEventListener('click', ()=>{
    location.reload();
  });

  document.getElementById('dashboard-btn').addEventListener('click', ()=>{
    window.location.href = '/dashboard.html';
  });

  canvas.addEventListener('click', ()=>{
    if(mapOpen || judgmentOpen) return;
    if(gameRunning && !pointerLocked){
      canvas.requestPointerLock();
    } else if(gameRunning && pointerLocked && !paused){
      tryInteract();
    }
  });

  document.addEventListener('pointerlockchange', ()=>{
    pointerLocked = document.pointerLockElement === canvas;
    if(gameRunning && !mapOpen && !judgmentOpen){
      paused = !pointerLocked;
      document.getElementById('pause-overlay').classList.toggle('hidden', pointerLocked);
    }
  });

  document.addEventListener('mousemove', (e)=>{
    if(!pointerLocked || paused || mapOpen || judgmentOpen) return;
    const sens = 0.0022;
    yaw -= e.movementX * sens;
    pitch -= e.movementY * sens;
    pitch = Math.max(-Math.PI/2.3, Math.min(Math.PI/2.3, pitch));
  });

  document.getElementById('map-open-btn').addEventListener('click', openSiteMap);
  document.getElementById('map-close-btn').addEventListener('click', closeSiteMap);

  document.getElementById('judge-flag-btn').addEventListener('click', ()=> chooseJudgment(true));
  document.getElementById('judge-clear-btn').addEventListener('click', ()=> chooseJudgment(false));
  document.getElementById('judgment-continue-btn').addEventListener('click', closeJudgment);

  document.addEventListener('keydown', (e)=>{
    switch(e.code){
      case 'KeyW': keys.w = true; break;
      case 'KeyA': keys.a = true; break;
      case 'KeyS': keys.s = true; break;
      case 'KeyD': keys.d = true; break;
      case 'KeyM':
        if(gameRunning && !judgmentOpen){
          if(gameSettings && gameSettings.hints === false){
            popup('info', 'Hints Disabled', 'Turn Hints back on in Settings to use the Site Map.');
          } else {
            mapOpen ? closeSiteMap() : openSiteMap();
          }
        }
        break;
      case 'Escape':
        if(judgmentOpen){ closeJudgment(); break; }
        if(mapOpen) closeSiteMap();
        break;
    }
  });
  document.addEventListener('keyup', (e)=>{
    switch(e.code){
      case 'KeyW': keys.w = false; break;
      case 'KeyA': keys.a = false; break;
      case 'KeyS': keys.s = false; break;
      case 'KeyD': keys.d = false; break;
    }
  });
}

function onResize(){
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/* ============================================================
   AUDIO FEEDBACK (procedural, WebAudio only)
   ============================================================ */
/* ============================================================
   AUDIO — distinct correct/wrong feedback + a level-clear fanfare.
   audioCtx is created (or resumed) on the very first click so
   browsers don't silently block it later.
   ============================================================ */
function getSettings(){
  return (window.CyberSettings && window.CyberSettings.get()) || {
    masterVolume:80, sfxVolume:80, musicVolume:45, muted:false,
    hints:true, timerEnabled:true, tutorial:true, interactionIndicator:true,
    reduceMotion:false, graphicsQuality:'high'
  };
}
function effectiveVolume(kind){
  const s = getSettings();
  if(s.muted) return 0;
  const base = kind === 'music' ? s.musicVolume : s.sfxVolume;
  return (s.masterVolume/100) * (base/100);
}

function ensureAudio(){
  try{
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(audioCtx.state === 'suspended') audioCtx.resume();
  }catch(e){ /* audio not critical */ }
}

function beep(freq, dur, type){
  try{
    ensureAudio();
    const vol = effectiveVolume('sfx');
    if(vol <= 0) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08 * vol, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  }catch(e){ /* audio not critical */ }
}

function playCorrectSound(){
  // quick two-note upward "ding" — 880Hz then 1175Hz
  beep(880, 0.12, 'sine');
  setTimeout(()=> beep(1175, 0.16, 'sine'), 90);
}

function playWrongSound(){
  // short descending buzz — unmistakably "not that"
  beep(220, 0.16, 'sawtooth');
  setTimeout(()=> beep(140, 0.22, 'sawtooth'), 80);
}

function playLevelClearFanfare(){
  // short ascending arpeggio: C5, E5, G5, C6
  const notes = [523, 659, 784, 1046];
  notes.forEach((f, i)=>{
    setTimeout(()=> beep(f, 0.28, 'triangle'), i * 130);
  });
}

/* ============================================================
   AMBIENT MUSIC — a subtle looping warehouse hum, tied to Music Volume
   ============================================================ */
let ambientNodes = null;
function startAmbientMusic(){
  try{
    ensureAudio();
    stopAmbientMusic();
    const vol = effectiveVolume('music');

    const masterGain = audioCtx.createGain();
    masterGain.gain.value = vol * 0.05; // kept deliberately subtle
    masterGain.connect(audioCtx.destination);

    const osc1 = audioCtx.createOscillator();
    osc1.type = 'sine'; osc1.frequency.value = 55;
    const osc2 = audioCtx.createOscillator();
    osc2.type = 'sine'; osc2.frequency.value = 55.6; // slight detune for a machine-hum beat

    const lfo = audioCtx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = audioCtx.createGain();
    lfoGain.gain.value = vol * 0.012;
    lfo.connect(lfoGain);
    lfoGain.connect(masterGain.gain);

    osc1.connect(masterGain);
    osc2.connect(masterGain);
    osc1.start(); osc2.start(); lfo.start();

    ambientNodes = { osc1, osc2, lfo, masterGain };
  }catch(e){ /* music not critical */ }
}
function updateAmbientVolume(){
  if(!ambientNodes) return;
  try{ ambientNodes.masterGain.gain.value = effectiveVolume('music') * 0.05; }catch(e){}
}
function stopAmbientMusic(){
  if(!ambientNodes) return;
  try{
    ambientNodes.osc1.stop(); ambientNodes.osc2.stop(); ambientNodes.lfo.stop();
    ambientNodes.osc1.disconnect(); ambientNodes.osc2.disconnect();
    ambientNodes.lfo.disconnect(); ambientNodes.masterGain.disconnect();
  }catch(e){}
  ambientNodes = null;
}

/* ============================================================
   FOUND MARKER (persistent check/X hovering over solved spots,
   so already-cleared items are obviously different from open leads)
   ============================================================ */
let _checkmarkTex = null;
let _wrongMarkTex = null;

function checkmarkTexture(){
  if(_checkmarkTex) return _checkmarkTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,64,64);
  ctx.beginPath();
  ctx.arc(32,32,27,0,Math.PI*2);
  ctx.fillStyle = 'rgba(15,20,17,0.7)';
  ctx.fill();
  ctx.strokeStyle = '#5ac87a';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = '#5ac87a';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(17,34);
  ctx.lineTo(27,44);
  ctx.lineTo(47,20);
  ctx.stroke();
  _checkmarkTex = new THREE.CanvasTexture(c);
  return _checkmarkTex;
}

function wrongMarkTexture(){
  if(_wrongMarkTex) return _wrongMarkTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,64,64);
  ctx.beginPath();
  ctx.arc(32,32,27,0,Math.PI*2);
  ctx.fillStyle = 'rgba(20,15,15,0.7)';
  ctx.fill();
  ctx.strokeStyle = '#e6483e';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = '#e6483e';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(20,20); ctx.lineTo(44,44);
  ctx.moveTo(44,20); ctx.lineTo(20,44);
  ctx.stroke();
  _wrongMarkTex = new THREE.CanvasTexture(c);
  return _wrongMarkTex;
}

function markFoundInWorld(data){
  if(!data.worldPos || data.markerAdded) return;
  data.markerAdded = true;
  const tex = data.correct ? checkmarkTexture() : wrongMarkTexture();
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest:false, transparent:true });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(data.worldPos);
  sprite.position.y += 0.55;
  sprite.scale.set(0.4, 0.4, 0.4);
  sprite.renderOrder = 999;
  scene.add(sprite);
}

function tryInteract(){
  raycaster.setFromCamera({x:0,y:0}, camera);
  const hits = raycaster.intersectObjects(interactables, true);
  if(hits.length === 0) return;

  let obj = hits[0].object;
  const data = obj.userData;
  if(!data) return;

  const dist = camera.position.distanceTo(hits[0].point);
  if(dist > INTERACT_DISTANCE){
    popup('info','Too Far Away','Move closer to get a proper look.');
    return;
  }

  if(data.type === 'officer'){
    popup('info', 'IT Officer', officer.hints[officer.hintIndex % officer.hints.length]);
    officer.hintIndex++;
    beep(520,0.12,'triangle');
    return;
  }

  if(data.resolved){
    popup('info', 'Already Reviewed', data.correct
      ? 'You already made the right call here — keep moving.'
      : 'You already made your call here — it didn\u2019t match what was actually going on.');
    return;
  }

  openJudgment(data);
}

/* ============================================================
   JUDGMENT MODAL — inspect, decide, then get told if you were right
   ============================================================ */
let pendingJudgment = null;

function openJudgment(data){
  pendingJudgment = data;
  judgmentOpen = true;
  if(pointerLocked) document.exitPointerLock();

  document.getElementById('judgment-prompt').textContent = data.prompt || 'You notice something worth a closer look.';

  const imgWrap = document.getElementById('judgment-image-wrap');
  const img = document.getElementById('judgment-image');
  if(data.zoomImage){
    img.src = data.zoomImage;
    imgWrap.style.display = 'block';
  } else {
    imgWrap.style.display = 'none';
  }

  document.getElementById('judgment-buttons').style.display = 'flex';
  document.getElementById('judgment-feedback').style.display = 'none';
  document.getElementById('judgment-overlay').classList.remove('hidden');
}

function chooseJudgment(flaggedAsIssue){
  const data = pendingJudgment;
  if(!data || data.resolved) return;

  data.resolved = true;
  const correct = (flaggedAsIssue === data.isMistake);
  data.correct = correct;

  if(correct){
    score += CORRECT_POINTS;
    if(data.isMistake){
      data.found = true;
      foundCount++;
    } else {
      decoysCorrectCount++;
    }
  } else {
    score = Math.max(0, score - wrongPenalty);
    wrongCount++;
  }
  markFoundInWorld(data);
  updateHud();
  if(correct) playCorrectSound(); else playWrongSound();

  document.getElementById('judgment-buttons').style.display = 'none';
  const fb = document.getElementById('judgment-feedback');
  const verdictEl = document.getElementById('jf-verdict');
  verdictEl.textContent = correct ? '\u2714 Good call' : '\u2718 Not quite';
  verdictEl.className = 'jf-verdict ' + (correct ? 'correct' : 'incorrect');
  document.getElementById('jf-explain').textContent = data.explain;
  fb.style.display = 'block';
}

function closeJudgment(){
  document.getElementById('judgment-overlay').classList.add('hidden');
  judgmentOpen = false;
  pendingJudgment = null;
  if(gameRunning) renderer.domElement.requestPointerLock();

  const totalMistakes = mistakeRoster.filter(m=>m.isMistake).length;
  if(foundCount >= totalMistakes){
    setTimeout(()=>endGame(true), 300);
    return;
  }

  // Every real issue has now been judged (some right, some wrong) — there's
  // nothing left that could still change the outcome, so don't make the
  // player sit and watch the clock run out for no reason.
  const resolvedMistakes = mistakeRoster.filter(m=>m.isMistake && m.resolved).length;
  if(resolvedMistakes >= totalMistakes){
    setTimeout(()=>endGame(false), 300);
  }
}

function updateHud(){
  const totalMistakes = mistakeRoster.filter(m=>m.isMistake).length;
  document.getElementById('found-count').textContent = foundCount + ' / ' + totalMistakes;
  document.getElementById('score').textContent = score;
}

/* ============================================================
   MOVEMENT + COLLISION
   ============================================================ */
function updateMovement(dt){
  const speed = 4.2;
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(-1);
  const right = new THREE.Vector3(Math.sin(yaw+Math.PI/2), 0, Math.cos(yaw+Math.PI/2)).multiplyScalar(-1);

  const move = new THREE.Vector3();
  if(keys.w) move.add(forward);
  if(keys.s) move.add(forward.clone().multiplyScalar(-1));
  if(keys.a) move.add(right.clone().multiplyScalar(-1));
  if(keys.d) move.add(right);

  if(move.lengthSq() > 0){
    move.normalize().multiplyScalar(speed*dt);
    const next = playerPos.clone().add(move);

    // wall bounds
    next.x = Math.max(ROOM.minX+0.6, Math.min(ROOM.maxX-0.6, next.x));
    next.z = Math.max(ROOM.minZ+0.6, Math.min(ROOM.maxZ-0.6, next.z));

    // obstacle collision (simple radius vs box)
    const radius = 0.4;
    let blocked = false;
    const testBox = new THREE.Box3(
      new THREE.Vector3(next.x-radius, 0, next.z-radius),
      new THREE.Vector3(next.x+radius, 2, next.z+radius)
    );
    for(let i=0;i<obstacles.length;i++){
      if(testBox.intersectsBox(obstacles[i])){ blocked = true; break; }
    }
    if(!blocked){
      playerPos.x = next.x;
      playerPos.z = next.z;
    } else {
      // try sliding along axes independently
      const nx = playerPos.clone(); nx.x = next.x;
      const bx = new THREE.Box3(new THREE.Vector3(nx.x-radius,0,nx.z-radius), new THREE.Vector3(nx.x+radius,2,nx.z+radius));
      let bxBlocked = false;
      for(let i=0;i<obstacles.length;i++){ if(bx.intersectsBox(obstacles[i])){ bxBlocked=true; break; } }
      if(!bxBlocked) playerPos.x = nx.x;

      const nz = playerPos.clone(); nz.z = next.z;
      const bz = new THREE.Box3(new THREE.Vector3(nz.x-radius,0,nz.z-radius), new THREE.Vector3(nz.x+radius,2,nz.z+radius));
      let bzBlocked = false;
      for(let i=0;i<obstacles.length;i++){ if(bz.intersectsBox(obstacles[i])){ bzBlocked=true; break; } }
      if(!bzBlocked) playerPos.z = nz.z;
    }
  }

  camera.position.set(playerPos.x, playerHeight, playerPos.z);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}

/* ============================================================
   TIMER
   ============================================================ */
let lastTimerUpdate = 0;
function updateTimer(dt){
  const el = document.getElementById('timer');
  if(practiceMode){
    el.textContent = '∞';
    el.classList.remove('low');
    return;
  }
  timeLeft -= dt;
  if(timeLeft <= 0){
    timeLeft = 0;
    endGame(false);
  }
  const m = Math.floor(timeLeft/60);
  const s = Math.floor(timeLeft%60);
  const label = (m<10?'0':'')+m + ':' + (s<10?'0':'')+s;
  el.textContent = label;
  el.classList.toggle('low', timeLeft < 30);
}

/* ============================================================
   END GAME
   ============================================================ */
function endGame(allFound){
  if(!gameRunning) return;
  gameRunning = false;
  paused = true;
  document.exitPointerLock();
  stopAmbientMusic();

  document.getElementById('hud').style.display='none';
  document.getElementById('hint-bar').style.display='none';
  document.getElementById('crosshair').style.display='none';

  const levelNumber = LEVEL_NUMBER[difficulty] || 1;
  const endPanel = document.getElementById('end-panel');
  const continueBtn = document.getElementById('continue-level-btn');

  if(allFound){
    const isFinalLevel = LEVEL_ORDER.indexOf(difficulty) === LEVEL_ORDER.length - 1;
    if(isFinalLevel){
      document.getElementById('end-title').innerHTML = '\uD83C\uDFC6 <span>ALL LEVELS COMPLETED</span>';
      document.getElementById('end-sub').textContent = 'Every mission cleared — here is your final Cyber Awareness Report.';
    } else {
      document.getElementById('end-title').innerHTML = '\uD83C\uDF89 CONGRATULATIONS! <span>LEVEL ' + levelNumber + ' COMPLETE</span>';
      document.getElementById('end-sub').textContent = 'Every planted mistake was caught before the buzzer.';
    }
    endPanel.classList.add('level-cleared');
    playLevelClearFanfare();

    const idx = LEVEL_ORDER.indexOf(difficulty);
    const nextDifficulty = idx >= 0 && idx < LEVEL_ORDER.length - 1 ? LEVEL_ORDER[idx + 1] : null;
    if(nextDifficulty){
      continueBtn.textContent = 'CONTINUE TO LEVEL ' + LEVEL_NUMBER[nextDifficulty];
      continueBtn.href = 'game.html?level=' + nextDifficulty;
      continueBtn.style.display = 'block';
    } else {
      continueBtn.style.display = 'none';
    }
  } else {
    const ranOutOfTime = !practiceMode && timeLeft <= 0;
    if(ranOutOfTime){
      document.getElementById('end-title').innerHTML = "TIME'S <span>UP</span>";
      document.getElementById('end-sub').textContent = "Shift ended before every mistake was found — here's the debrief.";
    } else {
      document.getElementById('end-title').innerHTML = "SHIFT <span>ENDED</span>";
      document.getElementById('end-sub').textContent = "Every real issue on this floor has been judged — here's how you did.";
    }
    endPanel.classList.remove('level-cleared');
    continueBtn.style.display = 'none';
  }
  document.getElementById('final-score').textContent = score;

  const recap = document.getElementById('recap');
  recap.innerHTML = '';
  mistakeRoster.filter(m=>m.isMistake).forEach(m=>{
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="tag ${m.found?'found':'missed'} mono">${m.found?'FOUND':'MISSED'}</div><div>${m.title} — ${m.explain}</div>`;
    recap.appendChild(row);
  });

  document.getElementById('end-overlay').classList.remove('hidden');
  saveScoreToServer(allFound);
}

/* ============================================================
   SCORE PERSISTENCE (talks to the local Node server)
   ============================================================ */
function saveScoreToServer(allFound){
  const totalMistakes = mistakeRoster.filter(m=>m.isMistake).length;
  const decoysTotal = mistakeRoster.filter(m=>m.isMistake===false).length;
  const timeLimit = DIFFICULTIES[difficulty].time;

  fetch('/api/save-score', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    credentials:'include',
    body: JSON.stringify({
      score: score,
      found: foundCount,
      total: totalMistakes,
      difficulty: difficulty,
      allFound: !!allFound,
      wrongCount: wrongCount,
      decoysCorrect: decoysCorrectCount,
      decoysTotal: decoysTotal,
      timeLeftAtEnd: timeLeft,
      timeLimit: timeLimit
    })
  })
  .then(r => r.ok ? r.json() : null)
  .then(data => { if(data) renderProgressFeedback(data); })
  .catch(()=>{ /* saving is best-effort; the shift report still shows locally */ });
}

function renderProgressFeedback(data){
  const el = document.getElementById('progress-feedback');
  if(!el) return;
  let html = `<div class="pf-xp">+${data.xpGained} XP earned</div>`;

  const idx = LEVEL_ORDER.indexOf(difficulty);
  const nextLevel = idx >= 0 && idx < LEVEL_ORDER.length - 1 ? LEVEL_ORDER[idx+1] : null;
  const justClearedThisLevel = (data.newAchievements || []).some(a => a.id === 'perfect_' + difficulty);
  if(nextLevel && justClearedThisLevel){
    html += `<div class="pf-unlock">🔓 ${levelLabel(nextLevel)} unlocked!</div>`;
  }

  (data.newAchievements || []).forEach(a=>{
    html += `<div class="pf-achv">🏅 Achievement unlocked: <b>${a.name}</b> — ${a.desc}</div>`;
  });

  el.innerHTML = html;
  el.style.display = 'block';
}

/* ============================================================
   ZONES + "NEXT LEAD" (map hint system)
   ============================================================ */
const ZONE_LOOKUP = {
  'Password on a Sticky Note': 'Office Nook',
  'Phishing Email Left Open': 'Office Nook',
  'Personal Phone Charging via Work PC': 'Office Nook',
  'Server Cabinet Left Unlocked': 'Server Room',
  'Access Badge Left Unattended': 'Reception Desk',
  'Unauthorized Wireless Access Point': 'Reception Desk',
  'Suspicious Email Attachment': 'Reception Desk',
  'Exterior Door Propped Open': 'Entrance',
  'Unknown USB Drive Plugged In': 'Packing Station',
  'Package-Tracking Scam': 'Dispatch Desk',
  'Unlocked Admin Session Left Open': "Manager's Office",
  'Confidential Printout Left Unattended': 'Meeting Room',
  'Unescorted Person in Danger Zone': 'Danger Zone'
};
// In Levels 2 and 3 the propped-open door is the loading-dock door, not the main entrance.
const ZONE_LOOKUP_HUB = Object.assign({}, ZONE_LOOKUP, { 'Exterior Door Propped Open': 'Loading Dock' });
function zoneFor(title){ return (customLayout ? ZONE_LOOKUP_HUB : ZONE_LOOKUP)[title] || 'Warehouse Floor'; }

function getNearestUnfound(){
  let best = null, bestDist = Infinity;
  mistakeRoster.filter(m=>m.isMistake && !m.resolved && m.worldPos).forEach(m=>{
    const dx = m.worldPos.x - playerPos.x;
    const dz = m.worldPos.z - playerPos.z;
    const flat = Math.sqrt(dx*dx + dz*dz);
    if(flat < bestDist){ bestDist = flat; best = m; }
  });
  return best ? { mistake: best, dist: bestDist } : null;
}

/* ============================================================
   OBJECTIVE / LOCATION PANEL
   (replaces the old raw compass heading — the arrow still uses the
   same bearing math, it's just no longer paired with "NE 37°" text)
   ============================================================ */
function updateObjectivePanel(){
  const leadArrow = document.getElementById('lead-arrow');
  const leadText = document.getElementById('lead-text');
  const objText = document.getElementById('objective-text');
  if(!leadArrow || !leadText) return;

  const lead = getNearestUnfound();
  if(!lead){
    objText.textContent = 'All clear — every real issue has been resolved';
    leadText.textContent = 'No active leads';
    leadArrow.style.opacity = '0.25';
    return;
  }

  objText.textContent = 'Inspect the area for a security concern';

  // Direction and distance are a Level 1 (Trainee) aid only — matching
  // the minimap's own "full" tier. Normal and Hard give no directional
  // help at all, so difficulty actually means something on every level,
  // not just on the minimap.
  if(minimapMode !== 'full'){
    leadText.textContent = 'Keep exploring';
    leadArrow.style.opacity = '0.15';
    return;
  }

  let deg = ((-yaw * 180/Math.PI) % 360 + 360) % 360; // yaw 0 faces -Z
  const dx = lead.mistake.worldPos.x - playerPos.x;
  const dz = lead.mistake.worldPos.z - playerPos.z;
  const bearing = (Math.atan2(dx, -dz) * 180/Math.PI + 360) % 360;
  const relative = ((bearing - deg) + 540) % 360 - 180; // -180..180, 0 = straight ahead
  leadArrow.style.transform = `rotate(${relative}deg)`;
  leadArrow.style.opacity = '1';
  leadText.textContent = `${zoneFor(lead.mistake.title)} — ${Math.round(lead.dist)}m away`;
}

/* ============================================================
   MINI-MAP (2D canvas, top-down, bottom-right HUD)
   ============================================================ */
let minimapCtx = null;
function drawMinimap(){
  const canvasEl = document.getElementById('minimap');
  if(!minimapCtx) minimapCtx = canvasEl.getContext('2d');
  const ctx = minimapCtx;
  const W = canvasEl.width, H = canvasEl.height;
  ctx.clearRect(0,0,W,H);

  const worldW = ROOM.maxX - ROOM.minX;
  const worldD = ROOM.maxZ - ROOM.minZ;
  const pad = 6;
  const sx = (W-pad*2)/worldW;
  const sz = (H-pad*2)/worldD;
  function toMap(x,z){
    return [ pad + (x-ROOM.minX)*sx, pad + (z-ROOM.minZ)*sz ];
  }

  ctx.fillStyle = 'rgba(40,44,49,0.9)';
  ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = '#555b62';
  ctx.strokeRect(pad,pad,W-pad*2,H-pad*2);
  drawBlockOnMap(ctx, toMap);

  // rack blocks (the real footprints, so the map matches whichever layout is loaded)
  ctx.fillStyle = 'rgba(120,128,138,0.55)';
  RACK_RECTS.forEach(r=>{
    const p1 = toMap(r.x - r.w/2, r.z - r.d/2);
    const p2 = toMap(r.x + r.w/2, r.z + r.d/2);
    ctx.fillRect(p1[0], p1[1], p2[0]-p1[0], p2[1]-p1[1]);
  });

  // mistake blips (easy mode only, undiscovered ones)
  if(minimapMode === 'full'){
    mistakeRoster.filter(m=>m.isMistake && !m.resolved && m.worldPos).forEach(m=>{
      const p = toMap(m.worldPos.x, m.worldPos.z);
      ctx.beginPath();
      ctx.arc(p[0],p[1], 3.2, 0, Math.PI*2);
      ctx.fillStyle = '#ffc93c';
      ctx.fill();
    });
    // Decoys get their own blip too, in green — this only helps you find
    // them faster; correctly judging one as "Looks Fine" once you're
    // there is still entirely up to you, same as before.
    mistakeRoster.filter(m=>m.isMistake===false && !m.resolved && m.worldPos).forEach(m=>{
      const p = toMap(m.worldPos.x, m.worldPos.z);
      ctx.beginPath();
      ctx.arc(p[0],p[1], 3.2, 0, Math.PI*2);
      ctx.fillStyle = '#5ac87a';
      ctx.fill();
    });
  }

  // player
  const pp = toMap(playerPos.x, playerPos.z);
  ctx.save();
  ctx.translate(pp[0], pp[1]);
  ctx.rotate(-yaw);
  ctx.beginPath();
  ctx.moveTo(0,-6);
  ctx.lineTo(4,5);
  ctx.lineTo(-4,5);
  ctx.closePath();
  ctx.fillStyle = '#5ac87a';
  ctx.fill();
  ctx.restore();
}

/* ============================================================
   SITE MAP (full-screen hint overlay — press M)
   ============================================================ */
const ZONE_LABELS = [
  { name:'OFFICE NOOK', x:-8.5, z:-19 },
  { name:'SERVER ROOM', x:10.5, z:-19.5 },
  { name:'ENTRANCE', x:6, z:23.5 },
  { name:'RECEPTION', x:-3, z:15 },
  { name:'PACKING', x:13.5, z:5 },
  { name:'DISPATCH DESK', x:13.5, z:-2 },
  { name:'BREAK ROOM', x:-15, z:17.5 },
  { name:'MEETING ROOM', x:4, z:-22 },
  { name:"MANAGER'S OFFICE", x:15, z:15 },
  { name:'DANGER ZONE', x:-5, z:10 }
];

const ZONE_LABELS_HUB = [
  { name:'OFFICE NOOK', x:-16, z:-17 },
  { name:'BREAK ROOM', x:0.3, z:-16.5 },
  { name:'SERVER ROOM', x:21, z:-17 },
  { name:'MEETING ROOM', x:-3.5, z:-9.2 },
  { name:"MANAGER'S OFFICE", x:3.7, z:-9.2 },
  { name:'MAIN ENTRANCE', x:-20, z:11.6 },
  { name:'RECEPTION', x:-20, z:17.3 },
  { name:'DANGER ZONE', x:1.5, z:17.6 },
  { name:'PACKING', x:14.5, z:16.6 },
  { name:'DISPATCH', x:22, z:16.6 },
  { name:'LOADING DOCK', x:21, z:5.4 }
];

const ZONE_LABELS_LSHAPE = [
  { name:'SERVER ROOM', x:-19.5, z:-19.6 },
  { name:'OFFICE NOOK', x:-20.5, z:0.9 },
  { name:'MEETING ROOM', x:-2.8, z:-18.4 },
  { name:"MANAGER'S OFFICE", x:-4.2, z:-0.3 },
  { name:'LOADING DOCK', x:-8.5, z:-23.2 },
  { name:'DANGER ZONE', x:-9, z:12.5 },
  { name:'BREAK ROOM', x:-21, z:17.3 },
  { name:'RECEPTION', x:18.4, z:9.2 },
  { name:'PACKING', x:11.5, z:15.4 },
  { name:'DISPATCH', x:19, z:15.4 },
  { name:'MAIN ENTRANCE', x:20, z:10.2 }
];

// The solid block that makes Level 2 an L: shade it on a map so the shape reads at a glance.
function drawBlockOnMap(ctx, toMap){
  if(!lshapeLayout) return;
  const a = toMap(0, -24), b = toMap(24, 0);
  ctx.fillStyle = '#14171a';
  ctx.fillRect(a[0], a[1], b[0]-a[0], b[1]-a[1]);
  ctx.strokeStyle = '#555b62';
  ctx.strokeRect(a[0], a[1], b[0]-a[0], b[1]-a[1]);
}

function openSiteMap(){
  if(!gameRunning || mapOpen || judgmentOpen) return;
  mapOpen = true;
  if(pointerLocked) document.exitPointerLock();
  document.getElementById('map-overlay').classList.remove('hidden');
  const sub = document.querySelector('#map-overlay .subtitle');
  if(sub){
    sub.textContent = (minimapMode === 'full')
      ? 'Every planted mistake, pinned to its area. Green = correctly flagged, red = missed.'
      : 'Floor plan only — no hints on this level. A pin appears once you have judged an object.';
  }
  drawSiteMap();
  renderMapLegend();
}
function closeSiteMap(){
  if(!mapOpen) return;
  mapOpen = false;
  document.getElementById('map-overlay').classList.add('hidden');
  if(gameRunning) renderer.domElement.requestPointerLock();
}

function drawSiteMap(){
  const canvasEl = document.getElementById('sitemap-canvas');
  const ctx = canvasEl.getContext('2d');
  const W = canvasEl.width, H = canvasEl.height;
  ctx.clearRect(0,0,W,H);

  const worldW = ROOM.maxX - ROOM.minX;
  const worldD = ROOM.maxZ - ROOM.minZ;
  const pad = 10;
  const sx = (W-pad*2)/worldW;
  const sz = (H-pad*2)/worldD;
  function toMap(x,z){
    return [ pad + (x-ROOM.minX)*sx, pad + (z-ROOM.minZ)*sz ];
  }

  ctx.fillStyle = '#282c31';
  ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = '#555b62';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad,pad,W-pad*2,H-pad*2);
  drawBlockOnMap(ctx, toMap);

  // rack blocks (the real footprints, so the map matches whichever layout is loaded)
  ctx.fillStyle = 'rgba(120,128,138,0.55)';
  RACK_RECTS.forEach(r=>{
    const p1 = toMap(r.x - r.w/2, r.z - r.d/2);
    const p2 = toMap(r.x + r.w/2, r.z + r.d/2);
    ctx.fillRect(p1[0], p1[1], p2[0]-p1[0], p2[1]-p1[1]);
  });

  // zone labels
  ctx.fillStyle = 'rgba(232,230,222,0.5)';
  ctx.font = '9px Consolas, monospace';
  ctx.textAlign = 'center';
  (hubLayout ? ZONE_LABELS_HUB : (lshapeLayout ? ZONE_LABELS_LSHAPE : ZONE_LABELS)).forEach(z=>{
    const p = toMap(z.x, z.z);
    ctx.fillText(z.name, p[0], p[1]);
  });
  ctx.textAlign = 'left';

  // numbered mistake pins
  const numbered = mistakeRoster.filter(m=>m.isMistake && m.worldPos);
  // Level 1 (Trainee) pins every issue. Levels 2 and 3 are floor-plan only —
  // a pin appears only after you've judged that object yourself.
  const showAllPins = (minimapMode === 'full');
  numbered.forEach((m, i)=>{
    if(!showAllPins && !m.resolved) return;
    const p = toMap(m.worldPos.x, m.worldPos.z);
    let color = '#ffc93c', symbol = String(i+1);
    if(m.resolved){
      color = m.correct ? '#5ac87a' : '#e6483e';
      symbol = m.correct ? '✓' : '✗';
    }
    ctx.beginPath();
    ctx.arc(p[0], p[1], 8, 0, Math.PI*2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#141414';
    ctx.font = 'bold 9px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(symbol, p[0], p[1]+0.5);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
  });

  // player position
  const pp = toMap(playerPos.x, playerPos.z);
  ctx.save();
  ctx.translate(pp[0], pp[1]);
  ctx.rotate(-yaw);
  ctx.beginPath();
  ctx.moveTo(0,-9);
  ctx.lineTo(6,8);
  ctx.lineTo(-6,8);
  ctx.closePath();
  ctx.fillStyle = '#4fa8ff';
  ctx.fill();
  ctx.strokeStyle = '#0d1420';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function renderMapLegend(){
  const legend = document.getElementById('map-legend');
  const numbered = mistakeRoster.filter(m=>m.isMistake && m.worldPos);
  const showAllPins = (minimapMode === 'full');
  const rows = numbered.map((m, i)=>{
    if(!showAllPins && !m.resolved) return '';
    let cls = '', num = String(i+1), suffix = '';
    if(m.resolved){
      if(m.correct){ cls = 'found'; num = '✓'; suffix = ' — correctly flagged'; }
      else { cls = 'wrong'; num = '✗'; suffix = ' — missed'; }
    }
    return `
    <div class="map-legend-item ${cls}">
      <div class="num">${num}</div>
      <div>${zoneFor(m.title)}${suffix}</div>
    </div>
  `;
  }).filter(Boolean);
  if(!showAllPins){
    rows.unshift('<div class="map-legend-item"><div>No hints on this level — explore the floor and trust your judgment. Areas you have judged appear here.</div></div>');
  }
  legend.innerHTML = rows.join('');
}

/* ============================================================
   MAIN LOOP
   ============================================================ */
function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.getElapsedTime();

  if(gameRunning && !paused && !mapOpen && !judgmentOpen){
    updateMovement(dt);
    updateTimer(dt);
  }

  // characters always animate for atmosphere, even while paused/menu is up
  workers.forEach(w=>{
    const target = w.path[w.pathIndex];
    const dir = target.clone().sub(w.group.position);
    const dist = dir.length();
    if(dist < 0.15){
      w.pathIndex = (w.pathIndex+1) % w.path.length;
    } else {
      dir.normalize();
      w.group.position.addScaledVector(dir, w.speed*dt);
      w.group.rotation.y = Math.atan2(dir.x, dir.z);
      updateWalkCycle(w, dt, w.speed);
    }
  });
  if(officer) updateIdleBob(officer, t);
  ZONE_HUMANOIDS.forEach(c=> updateIdleBob(c, t));

  // dust motes drift
  if(dustPoints){
    dustPoints.rotation.y += dt * 0.008;
    dustPoints.position.y = Math.sin(t*0.15) * 0.15;
  }

  // server LEDs blink
  scene.traverse(obj=>{
    if(obj.userData && obj.userData.leds){
      obj.userData.leds.children.forEach(led=>{
        led._blink += dt*4;
        led.material.emissiveIntensity = 0.5 + Math.sin(led._blink)*0.5;
      });
    }
  });

  if(gameRunning){
    updateObjectivePanel();
    if(minimapMode !== 'none') drawMinimap();
  }

  // crosshair + object-glow hover feedback
  const indicatorOn = !gameSettings || gameSettings.interactionIndicator !== false;
  if(gameRunning && pointerLocked && !paused && indicatorOn){
    raycaster.setFromCamera({x:0,y:0}, camera);
    const hits = raycaster.intersectObjects(interactables, true);
    const crosshair = document.getElementById('crosshair');
    const validHit = hits.length > 0 && camera.position.distanceTo(hits[0].point) <= INTERACT_DISTANCE;

    if(validHit){
      crosshair.classList.add('active');
    } else {
      crosshair.classList.remove('active');
    }

    const hitData = validHit ? hits[0].object.userData : null;
    if(hoveredGlowData !== hitData){
      if(hoveredGlowData && hoveredGlowData.glowMesh) hoveredGlowData.glowMesh.material.opacity = 0;
      if(hitData && hitData.glowMesh) hitData.glowMesh.material.opacity = 0.45;
      hoveredGlowData = hitData;
    }
  } else if(hoveredGlowData){
    if(hoveredGlowData.glowMesh) hoveredGlowData.glowMesh.material.opacity = 0;
    hoveredGlowData = null;
  }

  renderer.render(scene, camera);
}

fetch('/api/me', { credentials:'include' })
  .then(r => { if(!r.ok) throw new Error('not authenticated'); return r.json(); })
  .then(me => {
    currentUsername = me.username;
    const tag = document.getElementById('user-tag');
    if(tag) tag.textContent = 'Signed in as ' + me.username;
    init();
  })
  .catch(()=>{ window.location.href = '/'; });
})();
