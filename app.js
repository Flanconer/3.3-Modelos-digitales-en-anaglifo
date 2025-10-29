import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { AnaglyphEffect } from 'three/addons/effects/AnaglyphEffect.js';

// 🔧 Ruta de TU modelo
const MODEL_URL = './Stepping Backward (3).fbx';

// UI
const viewerEl     = document.getElementById('viewer');
const anaglyphChk  = document.getElementById('anaglyphToggle');
const playPauseBtn = document.getElementById('playPauseBtn');
const recenterBtn  = document.getElementById('recenterBtn');
const ipdRange     = document.getElementById('ipdRange');
const ipdVal       = document.getElementById('ipdVal');
const focusRange   = document.getElementById('focusRange');
const focusVal     = document.getElementById('focusVal');
const duboisChk    = document.getElementById('duboisToggle');

// Core
let renderer, scene, camera, controls, loader, clock;
let grid, ground, model;

// Animación
let mixer = null;
let activeAction = null;

// Anaglifo
let effect;
let useAnaglyph = true;

// Auto-clamp (para que no se hunda si la animación baja el rig)
let AUTO_CLAMP_TO_GROUND = true;

// Matrices Dubois (LCD)
const DUBOIS_LEFT = new THREE.Matrix3().fromArray([
   0.456100, -0.0400822, -0.0152161,
   0.500484, -0.0378246, -0.0205971,
   0.176381, -0.0157589, -0.00546856
]);
const DUBOIS_RIGHT = new THREE.Matrix3().fromArray([
  -0.0434706,  0.378476,   -0.0721527,
  -0.0879388,  0.733640,   -0.1129610,
  -0.00155529, -0.0184503,  1.2264000
]);

init();
loadFixedModel(MODEL_URL);
animate();

/* ------------ INIT ------------ */
function init(){
  clock = new THREE.Clock();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(viewerEl.clientWidth, viewerEl.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x0b0f2a, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewerEl.appendChild(renderer.domElement);

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(55, viewerEl.clientWidth/viewerEl.clientHeight, 0.1, 3000);
  camera.position.set(2.8, 2.0, 4.6);
  camera.focus = parseFloat(focusRange.value); // usado por el estéreo

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1, 0);

  // Luces
  const hemi = new THREE.HemisphereLight(0xffffff, 0x303040, 1.0);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(5, 10, 7);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 0.5;
  dir.shadow.camera.far = 50;
  dir.shadow.camera.left = -15;
  dir.shadow.camera.right = 15;
  dir.shadow.camera.top = 15;
  dir.shadow.camera.bottom = -15;
  scene.add(dir);

  // Suelo + grid
  grid = new THREE.GridHelper(26, 52, 0x7c5cff, 0x28306b);
  grid.material.opacity = 0.25;
  grid.material.transparent = true;
  scene.add(grid);

  ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x0a0f2b, metalness: 0.08, roughness: 0.92 })
  );
  ground.rotation.x = -Math.PI/2;
  ground.receiveShadow = true;
  scene.add(ground);

  loader = new FBXLoader();

  // AnaglyphEffect oficial
  effect = new AnaglyphEffect(renderer);
  effect.setSize(viewerEl.clientWidth, viewerEl.clientHeight);

  // Eventos UI
  window.addEventListener('resize', onResize);

  anaglyphChk.addEventListener('change', e => { useAnaglyph = e.target.checked; });

  playPauseBtn.addEventListener('click', () => {
    if (!mixer || !activeAction) return;
    activeAction.paused = !activeAction.paused;
    playPauseBtn.textContent = activeAction.paused ? '▶️ Reproducir' : '⏸️ Pausar';
  });

  recenterBtn.addEventListener('click', () => fitCameraToObject(model, true));

  // IPD (separación ocular)
  ipdRange.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    ipdVal.value = v.toFixed(3);
    const stereo = effect.stereo || effect._stereo || effect.stereoCamera;
    if (stereo && 'eyeSep' in stereo) stereo.eyeSep = v;
  });

  // Focus (convergencia)
  focusRange.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    focusVal.value = v.toFixed(1);
    camera.focus = v;
    camera.updateProjectionMatrix();
  });

  // Dubois
  duboisChk.addEventListener('change', e => {
    if (effect.colorMatrixLeft && effect.colorMatrixRight) {
      if (e.target.checked) {
        effect.colorMatrixLeft.copy(DUBOIS_LEFT);
        effect.colorMatrixRight.copy(DUBOIS_RIGHT);
      } else {
        effect.colorMatrixLeft.identity();
        effect.colorMatrixRight.identity();
      }
    }
  });

  // Estados iniciales
  ipdVal.value   = parseFloat(ipdRange.value).toFixed(3);
  focusVal.value = parseFloat(focusRange.value).toFixed(1);
  useAnaglyph = anaglyphChk.checked;
}

/* ------------ RESIZE ------------ */
function onResize(){
  const w = viewerEl.clientWidth;
  const h = viewerEl.clientHeight;
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
  renderer.setSize(w,h);
  effect.setSize(w,h);
}

/* ------------ CARGA MODELO (con limpieza/normalizado) ------------ */
function loadFixedModel(url){
  setLoading(true);
  loader.load(
    url,
    (obj) => {
      setLoading(false);

      // limpia previo
      if (model){
        if (mixer) mixer.stopAllAction();
        disposeObject(model);
        scene.remove(model);
      }

      model = obj;

      // 1) quitar planos de preview/overlay
      stripFlatPlanes(model);

      // 2) materiales + sombras
      model.traverse((c)=>{
        if (c.isMesh){
          c.castShadow = true;
          c.receiveShadow = true;
          if (c.material?.map) c.material.map.colorSpace = THREE.SRGBColorSpace;
        }
      });

      // 3) normaliza escala, centra y coloca sobre el piso
      normalizeScale(model, 1.8);       // altura objetivo
      hardCenterObject(model);          // al origen
      placeOnGround(model);             // 👈 deja los pies a y=0

      scene.add(model);

      // 4) animación (autoplay primera)
      const clips = Array.isArray(model.animations) ? model.animations : [];
      if (clips.length){
        mixer = new THREE.AnimationMixer(model);
        activeAction = mixer.clipAction(clips[0]);
        activeAction.reset();
        activeAction.setLoop(THREE.LoopRepeat, Infinity);
        activeAction.play();
        playPauseBtn.disabled = false;
        playPauseBtn.textContent = '⏸️ Pausar';
      } else {
        mixer = null;
        activeAction = null;
        playPauseBtn.disabled = true;
      }

      // 5) encuadre cómodo (más al centro y más cerca)
      fitTight(model);
      recenterBtn.disabled = false;

      // 6) presets 3D más notorios al iniciar
      anaglyphChk.checked = true;
      useAnaglyph = true;

      ipdRange.value = 0.085;     ipdVal.value = '0.085';
      const stereo = effect?.stereo || effect?._stereo || effect?.stereoCamera;
      if (stereo && 'eyeSep' in stereo) stereo.eyeSep = parseFloat(ipdRange.value);

      focusRange.value = 12;      focusVal.value = '12.0';
      camera.focus = 12;
      camera.updateProjectionMatrix();
    },
    undefined,
    (err)=>{
      setLoading(false);
      console.error('Error al cargar FBX:', err);
      alert('No se pudo cargar el FBX. Ver consola.');
    }
  );
}

/* ------------ HELPERS DE LIMPIEZA, CENTRADO, PISO Y ENCUADRE ------------ */
// Oculta planos "de preview" u overlays muy delgados y grandes
function stripFlatPlanes(root) {
  root.traverse((c) => {
    if (!c.isMesh || !c.geometry) return;

    // Oculta por nombre
    const n = (c.name || '').toLowerCase();
    if (n.includes('plane') || n.includes('shadow') || n.includes('card') || n.includes('board')) {
      c.visible = false;
      return;
    }

    // Heurística geométrica: plano muy delgado
    c.geometry.computeBoundingBox?.();
    const bb = c.geometry.boundingBox;
    if (!bb) return;
    const sz = new THREE.Vector3().subVectors(bb.max, bb.min);
    const dims = [Math.abs(sz.x), Math.abs(sz.y), Math.abs(sz.z)].sort((a,b)=>a-b);
    const thin = dims[0], mid = dims[1], big = dims[2];
    const isFlatPlane = thin < big * 0.02 && (mid * big) > 0.2;
    if (isFlatPlane && !c.isSkinnedMesh) c.visible = false;
  });
}

// Centra al origen restando el centro del bounding box total
function hardCenterObject(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  // ajusta target del orbit
  const box2 = new THREE.Box3().setFromObject(obj);
  controls.target.set(0, Math.max(0.0, -box2.min.y), 0);
  controls.update();
}

// Escala el modelo a una altura objetivo (ej. 1.8)
function normalizeScale(obj, targetHeight = 1.8) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  if (size.y > 0) {
    const s = targetHeight / size.y;
    obj.scale.setScalar(s);
  }
}

// Coloca el modelo justo sobre y=0 (piso)
function placeOnGround(obj) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const deltaY = box.min.y;       // si es negativo, está hundido
  obj.position.y -= deltaY;       // corrige
  obj.updateMatrixWorld(true);
}

// Auto-clamp durante la animación (si el rig baja del piso)
function clampIfBelowGround(obj) {
  if (!obj) return;
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.min.y < 0) {
    obj.position.y -= box.min.y;
    obj.updateMatrixWorld(true);
  }
}

// Re-encuadre de cámara más cerradito
function fitTight(sceneObj) {
  const box = new THREE.Box3().setFromObject(sceneObj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  const dist = (maxDim / 2) / Math.tan(fov / 2);
  const dir = new THREE.Vector3(0, 0.15, 1).normalize();
  const newPos = center.clone().add(dir.multiplyScalar(dist * 1.05));

  const newTarget = new THREE.Vector3(0, Math.max(0, -box.min.y), 0);
  tweenCamera(camera.position.clone(), newPos, controls.target.clone(), newTarget, 0.45);
}

/* ------------ OTRAS UTILIDADES ------------ */
function fitCameraToObject(obj, smooth=false){
  if (!obj) return;
  const box   = new THREE.Box3().setFromObject(obj);
  const size  = box.getSize(new THREE.Vector3());
  const center= box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI/180);
  const dist = (maxDim / 2) / Math.tan(fov/2);

  const dir = new THREE.Vector3(0, 0.25, 1).normalize();
  const newPos = center.clone().add(dir.multiplyScalar(dist*1.2));
  const newTarget = new THREE.Vector3(0, Math.max(0.0, -box.min.y), 0);

  if (smooth){
    tweenCamera(camera.position.clone(), newPos, controls.target.clone(), newTarget, 0.45);
  } else {
    camera.position.copy(newPos);
    controls.target.copy(newTarget);
    controls.update();
  }
}

function tweenCamera(p0,p1,t0,t1,dur=0.4){
  const start = performance.now();
  function step(now){
    const k = Math.min(1,(now-start)/(dur*1000));
    const e = k<.5 ? 4*k*k*k : 1 - Math.pow(-2*k+2,3)/2;
    camera.position.lerpVectors(p0,p1,e);
    controls.target.lerpVectors(t0,t1,e);
    controls.update();
    if (k<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function disposeObject(obj){
  obj.traverse((child)=>{
    if (child.isMesh){
      child.geometry?.dispose();
      const mats = Array.isArray(child.material)? child.material : [child.material];
      mats.forEach(m=>{
        if (!m) return;
        for (const k in m){
          const v = m[k];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose?.();
      });
    }
  });
}

function setLoading(on){
  viewerEl.style.cursor = on ? 'progress' : 'default';
}

/* ------------ LOOP ------------ */
function animate(){
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (mixer) mixer.update(dt);

  // 👇 Mantén pies al ras si la animación intenta hundirlo
  if (AUTO_CLAMP_TO_GROUND) clampIfBelowGround(model);

  controls.update();
  if (useAnaglyph) effect.render(scene, camera);
  else renderer.render(scene, camera);
}
