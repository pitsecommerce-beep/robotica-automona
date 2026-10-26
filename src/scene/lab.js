import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export const TABLE_HEIGHT = 0.75;
const ABB_RED = 0xff000f;

/** Escena de laboratorio: suelo de resina, mesa de perfil de aluminio, cinta de seguridad y luces de estudio. */
export function createLab(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe2e5);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
  camera.position.set(0.95, 1.3, 1.05);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0.05, TABLE_HEIGHT + 0.28, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 0.3;
  controls.maxDistance = 6;

  // Luces: cenital de estudio con sombras + relleno suave.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9da3aa, 0.45));
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(2.5, 4.5, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -2;
  key.shadow.camera.right = 2;
  key.shadow.camera.top = 2;
  key.shadow.camera.bottom = -2;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);

  buildFloor(scene);
  buildWalls(scene);
  const table = buildTable(scene);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  return { renderer, scene, camera, controls, table };
}

function buildFloor(scene) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({ color: 0xa9aeb4, roughness: 0.5, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(12, 24, 0xaeb3b8, 0xbec2c6);
  grid.position.y = 0.001;
  scene.add(grid);

  // Cinta de seguridad amarilla/negra delimitando la celda.
  const tape = stripeTexture();
  const mat = new THREE.MeshStandardMaterial({ map: tape, roughness: 0.6 });
  const w = 0.06;
  const cell = { x: 2.6, z: 2.2 };
  const pieces = [
    [cell.x, w, 0, cell.z / 2],
    [cell.x, w, 0, -cell.z / 2],
    [cell.z, w, cell.x / 2, 0, true],
    [cell.z, w, -cell.x / 2, 0, true],
  ];
  for (const [len, width, x, z, rot] of pieces) {
    const t = tape.clone();
    t.repeat.set(len / 0.2, 1);
    t.needsUpdate = true;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, width), mat.clone());
    m.material.map = t;
    m.rotation.x = -Math.PI / 2;
    if (rot) m.rotation.z = Math.PI / 2;
    m.position.set(x, 0.002, z);
    m.receiveShadow = true;
    scene.add(m);
  }
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#f2c200';
  g.fillRect(0, 0, 64, 16);
  g.fillStyle = '#1b1b1b';
  for (let x = -16; x < 64; x += 32) {
    g.beginPath();
    g.moveTo(x, 16);
    g.lineTo(x + 16, 0);
    g.lineTo(x + 32, 0);
    g.lineTo(x + 16, 16);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildWalls(scene) {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.9 });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(14, 4), wallMat);
  back.position.set(0, 2, -4);
  back.receiveShadow = true;
  scene.add(back);
  const side = back.clone();
  side.rotation.y = Math.PI / 2;
  side.position.set(-5, 2, 0);
  scene.add(side);

  // Franja corporativa roja y zócalo gris oscuro.
  const band = new THREE.Mesh(new THREE.PlaneGeometry(14, 0.08), new THREE.MeshStandardMaterial({ color: ABB_RED, roughness: 0.5 }));
  band.position.set(0, 1.25, -3.99);
  scene.add(band);
  const plinth = new THREE.Mesh(new THREE.PlaneGeometry(14, 0.12), new THREE.MeshStandardMaterial({ color: 0x3a3d41, roughness: 0.7 }));
  plinth.position.set(0, 0.06, -3.99);
  scene.add(plinth);

  // Paneles de luz en el techo (solo visuales).
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const [x, z] of [[-1.5, -1], [1.5, -1], [-1.5, 1.5], [1.5, 1.5]]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), panelMat);
    p.rotation.x = Math.PI / 2;
    p.position.set(x, 3.6, z);
    scene.add(p);
  }
}

/** Mesa de trabajo con estructura de perfil de aluminio 45×45 y tablero gris claro. */
function buildTable(scene) {
  const group = new THREE.Group();
  const size = { x: 1.2, z: 0.8, top: 0.025 };
  const alu = new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 0.85, roughness: 0.32 });
  const topMat = new THREE.MeshStandardMaterial({ color: 0x6b7178, roughness: 0.55 });

  const top = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.top, size.z), topMat);
  top.position.y = TABLE_HEIGHT - size.top / 2;
  group.add(top);

  const p = 0.045;
  const legH = TABLE_HEIGHT - size.top;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(p, legH, p), alu);
      leg.position.set(sx * (size.x / 2 - p / 2), legH / 2, sz * (size.z / 2 - p / 2));
      group.add(leg);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.02, 20), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 }));
      foot.position.set(leg.position.x, 0.01, leg.position.z);
      group.add(foot);
    }
  }
  for (const y of [0.12, legH - p / 2]) {
    for (const sz of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(size.x - 2 * p, p, p), alu);
      rail.position.set(0, y, sz * (size.z / 2 - p / 2));
      group.add(rail);
    }
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(p, p, size.z - 2 * p), alu);
      rail.position.set(sx * (size.x / 2 - p / 2), y, 0);
      group.add(rail);
    }
  }
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  scene.add(group);
  return { group, size, height: TABLE_HEIGHT };
}
