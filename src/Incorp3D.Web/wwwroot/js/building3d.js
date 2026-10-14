import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Dimensões em metros. Torre quadrada com 4 unidades de canto por andar.
const HALF = 12;
const LOBBY_H = 6;
const FLOOR_H = 3.3;
const SLAB_T = 0.35;
const COLUMN = 0.9;
const GLASS_INSET = 0.45;
const BALCONY_D = 1.8;

const HOME_TARGET = new THREE.Vector3(0, 30, 0);
const HOME_POSITION = new THREE.Vector3(78, 44, 100);
const INTRO_POSITION = new THREE.Vector3(170, 110, 240);
const IDLE_RESUME_MS = 7000;
const PANEL_SHIFT_PX = 226;
const MOBILE_BREAKPOINT = 760;

const COLOR = {
    sold: new THREE.Color('#ffb46b'),
    available: new THREE.Color('#000000'),
    availableHint: new THREE.Color('#3fd8c4'),
    hover: new THREE.Color('#5eead4'),
    frame: new THREE.Color('#ffe2a8').multiplyScalar(4)
};

// Posição 1..4 -> sinal do canto (x, z). Frente da torre = +z.
const CORNERS = {
    1: { sx: -1, sz: 1 },
    2: { sx: 1, sz: 1 },
    3: { sx: 1, sz: -1 },
    4: { sx: -1, sz: -1 }
};

let ctx = null;

export function init(container, data, dotnet) {
    dispose();

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog('#2b2342', 160, 700);

    const camera = new THREE.PerspectiveCamera(38, width / height, 1, 2500);
    camera.position.copy(INTRO_POSITION);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(HOME_TARGET);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 28;
    controls.maxDistance = 170;
    controls.minPolarAngle = Math.PI * 0.12;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.45;
    controls.rotateSpeed = 0.6;

    const sky = createSky();
    scene.add(sky.mesh);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.mesh.clone());
    const envTarget = pmrem.fromScene(envScene, 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.55;

    addLights(scene);
    addSurroundings(scene);

    const roomTextures = [101, 202, 303, 404].map(makeRoomTexture);
    const units = buildTower(scene, data, roomTextures);

    const selectionBox = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(HALF + 0.8, FLOOR_H + 0.1, HALF + 0.8 + BALCONY_D)),
        new THREE.LineBasicMaterial({ color: COLOR.frame }));
    selectionBox.visible = false;
    scene.add(selectionBox);

    const composer = createComposer(renderer, scene, camera, width, height);

    const tooltip = document.createElement('div');
    tooltip.className = 'unit-tip';
    container.appendChild(tooltip);

    ctx = {
        container, dotnet, renderer, scene, camera, controls, composer, pmrem, envTarget, roomTextures,
        units, tooltip, selectionBox,
        hitBoxes: [...units.values()].map(u => u.hitBox),
        raycaster: new THREE.Raycaster(),
        pointer: { x: 0, y: 0, dirty: false, down: null },
        hoveredId: null,
        selectedId: null,
        onlyAvailable: false,
        tween: null,
        viewShift: 0,
        idleTimer: 0,
        readySent: false,
        listeners: []
    };

    units.forEach(applyVisual);
    wireEvents();
    flyTo(HOME_POSITION, HOME_TARGET, 2600, () => { if (ctx && !ctx.selectedId) ctx.controls.autoRotate = true; });
    renderer.setAnimationLoop(frame);
}

export function select(id) {
    if (!ctx) return;
    const previous = ctx.selectedId;
    ctx.selectedId = id && ctx.units.has(id) ? id : null;

    if (previous && ctx.units.has(previous)) applyVisual(ctx.units.get(previous));
    ctx.selectionBox.visible = !!ctx.selectedId;
    if (ctx.selectedId) {
        const unit = ctx.units.get(ctx.selectedId);
        ctx.selectionBox.position.copy(unit.hitBox.position);
        applyVisual(unit);
        focusUnit(unit);
    } else {
        flyTo(ctx.camera.position.clone().setY(Math.max(ctx.camera.position.y, 20)), HOME_TARGET, 1200);
        scheduleAutoRotate();
    }
}

export function setFilter(onlyAvailable) {
    if (!ctx) return;
    ctx.onlyAvailable = !!onlyAvailable;
    ctx.units.forEach(applyVisual);
}

export function dispose() {
    if (!ctx) return;
    const c = ctx;
    ctx = null;

    c.renderer.setAnimationLoop(null);
    clearTimeout(c.idleTimer);
    c.listeners.forEach(off => off());
    c.controls.dispose();

    c.scene.traverse(obj => {
        obj.geometry?.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach(m => m?.dispose());
    });
    c.roomTextures.forEach(t => t.dispose());
    c.envTarget.dispose();
    c.pmrem.dispose();
    c.composer.dispose();
    c.renderer.dispose();
    c.renderer.domElement.remove();
    c.tooltip.remove();
}

// ---------- Cena ----------

function createSky() {
    const material = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
            top: { value: new THREE.Color('#070b24') },
            mid: { value: new THREE.Color('#2d2563') },
            horizon: { value: new THREE.Color('#e0784f') },
            ground: { value: new THREE.Color('#120f1c') },
            sunDir: { value: new THREE.Vector3(-0.75, 0.06, 0.65).normalize() }
        },
        vertexShader: /* glsl */`
            varying vec3 vDir;
            void main() {
                vDir = normalize(position);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: /* glsl */`
            uniform vec3 top;
            uniform vec3 mid;
            uniform vec3 horizon;
            uniform vec3 ground;
            uniform vec3 sunDir;
            varying vec3 vDir;
            void main() {
                vec3 dir = normalize(vDir);
                float h = dir.y;
                vec3 col = mix(horizon, mid, smoothstep(0.0, 0.22, h));
                col = mix(col, top, smoothstep(0.18, 0.75, h));
                float sun = pow(max(dot(dir, sunDir), 0.0), 6.0);
                col += horizon * sun * 0.3 * (1.0 - smoothstep(0.0, 0.35, h));
                col = mix(col, ground, smoothstep(0.0, -0.08, h));
                gl_FragColor = vec4(col, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 24), material);
    return { mesh };
}

function addLights(scene) {
    scene.add(new THREE.HemisphereLight('#8f7fd6', '#1a1420', 0.9));

    const sun = new THREE.DirectionalLight('#ffb07a', 2.4);
    sun.position.set(-130, 55, 110);
    sun.target.position.set(0, 20, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -70; s.right = 70; s.top = 70; s.bottom = -40; s.near = 20; s.far = 400;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);

    const fill = new THREE.DirectionalLight('#6f7cff', 0.35);
    fill.position.set(120, 40, -90);
    scene.add(fill);
}

function addSurroundings(scene) {
    const ground = new THREE.Mesh(
        new THREE.CircleGeometry(900, 64),
        new THREE.MeshStandardMaterial({ color: '#17151f', roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const lawn = new THREE.Mesh(
        new THREE.RingGeometry(34, 78, 72),
        new THREE.MeshStandardMaterial({ color: '#1d2a22', roughness: 1 }));
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.y = 0.03;
    lawn.receiveShadow = true;
    scene.add(lawn);

    const plaza = new THREE.Mesh(
        new THREE.CircleGeometry(34, 64),
        new THREE.MeshStandardMaterial({ color: '#4a4550', roughness: 0.55, metalness: 0.1 }));
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 0.05;
    plaza.receiveShadow = true;
    scene.add(plaza);

    const rnd = mulberry32(7);
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3, 6);
    const crownGeo = new THREE.IcosahedronGeometry(2.6, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: '#3b2f2a', roughness: 1 });
    const crownMat = new THREE.MeshStandardMaterial({ color: '#2e4a3a', roughness: 0.9, flatShading: true });
    const trees = 22;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, trees);
    const m = new THREE.Matrix4();
    for (let i = 0; i < trees; i++) {
        const angle = (i / trees) * Math.PI * 2 + rnd() * 0.15;
        const radius = 44 + rnd() * 26;
        const scale = 0.8 + rnd() * 0.6;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        m.compose(new THREE.Vector3(x, 1.5 * scale, z), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale));
        trunks.setMatrixAt(i, m);
        m.compose(new THREE.Vector3(x, 4.6 * scale, z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rnd() * Math.PI, 0)),
            new THREE.Vector3(scale, scale * 1.15, scale));
        crowns.setMatrixAt(i, m);
    }
    trunks.castShadow = crowns.castShadow = true;
    scene.add(trunks, crowns);

    const lamps = 16;
    const postGeo = new THREE.CylinderGeometry(0.07, 0.09, 3.2, 6);
    const bulbGeo = new THREE.SphereGeometry(0.22, 12, 8);
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: '#222228', metalness: 0.6, roughness: 0.4 }), lamps);
    const bulbs = new THREE.InstancedMesh(bulbGeo, new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#ffd29a', emissiveIntensity: 3 }), lamps);
    for (let i = 0; i < lamps; i++) {
        const angle = (i / lamps) * Math.PI * 2;
        const x = Math.cos(angle) * 31;
        const z = Math.sin(angle) * 31;
        m.makeTranslation(x, 1.6, z);
        posts.setMatrixAt(i, m);
        m.makeTranslation(x, 3.3, z);
        bulbs.setMatrixAt(i, m);
    }
    scene.add(posts, bulbs);
}

function buildTower(scene, data, roomTextures) {
    const floors = data.floors;
    const topY = LOBBY_H + floors * FLOOR_H;
    const span = HALF * 2;

    const concrete = new THREE.MeshStandardMaterial({ color: '#d9d3c9', roughness: 0.72 });
    const columnMat = new THREE.MeshStandardMaterial({ color: '#cbc3b7', roughness: 0.8 });
    const darkMat = new THREE.MeshStandardMaterial({ color: '#15151b', roughness: 0.9 });
    const mullionMat = new THREE.MeshStandardMaterial({ color: '#2b2b33', metalness: 0.7, roughness: 0.35 });
    const railingMat = new THREE.MeshStandardMaterial({ color: '#9fc4d8', transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.2, depthWrite: false });

    const core = new THREE.Mesh(new THREE.BoxGeometry(span - GLASS_INSET * 2 - 0.2, topY - LOBBY_H, span - GLASS_INSET * 2 - 0.2), darkMat);
    core.position.y = LOBBY_H + (topY - LOBBY_H) / 2;
    scene.add(core);

    const slabGeo = new THREE.BoxGeometry(span + 0.4, SLAB_T, span + 0.4);
    for (let f = 0; f <= floors; f++) {
        const slab = new THREE.Mesh(slabGeo, concrete);
        slab.position.y = LOBBY_H + f * FLOOR_H;
        slab.castShadow = slab.receiveShadow = true;
        scene.add(slab);
    }

    const columnGeo = new THREE.BoxGeometry(COLUMN, topY, COLUMN);
    for (const [cx, cz] of [[-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1]]) {
        const column = new THREE.Mesh(columnGeo, columnMat);
        column.position.set(cx * (HALF - COLUMN / 2 + 0.2), topY / 2, cz * (HALF - COLUMN / 2 + 0.2));
        column.castShadow = column.receiveShadow = true;
        scene.add(column);
    }

    addLobby(scene, span, concrete);
    addCrown(scene, span, topY, concrete, darkMat);

    const glassW = HALF - COLUMN - 0.1;
    const glassH = FLOOR_H - SLAB_T;
    const glassGeo = new THREE.PlaneGeometry(glassW, glassH);
    const mullionsPerPanel = 6;
    const mullionGeo = new THREE.BoxGeometry(0.08, glassH, 0.14);
    const mullions = new THREE.InstancedMesh(mullionGeo, mullionMat, data.units.length * 2 * mullionsPerPanel);
    const balconyW = HALF - 2.6;
    const balconySlabs = new THREE.InstancedMesh(new THREE.BoxGeometry(balconyW, 0.28, BALCONY_D), concrete, data.units.length);
    const railings = new THREE.InstancedMesh(new THREE.BoxGeometry(balconyW, 1.1, 0.05), railingMat, data.units.length);
    balconySlabs.castShadow = balconySlabs.receiveShadow = true;

    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    const hitGeo = new THREE.BoxGeometry(HALF + 0.6, FLOOR_H - 0.05, HALF + 0.6 + BALCONY_D);
    const rnd = mulberry32(42);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    let mullionIndex = 0;
    const units = new Map();

    data.units.forEach((u, i) => {
        const corner = CORNERS[u.position];
        if (!corner) return;
        const { sx, sz } = corner;
        const yBase = LOBBY_H + (u.floor - 1) * FLOOR_H;
        const yMid = yBase + SLAB_T / 2 + glassH / 2;

        const material = new THREE.MeshStandardMaterial({
            color: '#0e1828',
            metalness: 0.85,
            roughness: 0.08,
            emissive: '#000000',
            emissiveMap: roomTextures[i % roomTextures.length]
        });

        // Painel na fachada frontal/traseira (normal ±z) e na lateral (normal ±x).
        const front = new THREE.Mesh(glassGeo, material);
        front.position.set(sx * HALF / 2, yMid, sz * (HALF - GLASS_INSET));
        front.rotation.y = sz > 0 ? 0 : Math.PI;
        const side = new THREE.Mesh(glassGeo, material);
        side.position.set(sx * (HALF - GLASS_INSET), yMid, sz * HALF / 2);
        side.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
        scene.add(front, side);

        for (let k = 1; k <= mullionsPerPanel; k++) {
            const offset = -glassW / 2 + (glassW / (mullionsPerPanel + 1)) * k;
            m.compose(new THREE.Vector3(front.position.x + offset, yMid, front.position.z + sz * 0.05), q, one);
            mullions.setMatrixAt(mullionIndex++, m);
            m.compose(new THREE.Vector3(side.position.x + sx * 0.05, yMid, side.position.z + offset),
                new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)), one);
            mullions.setMatrixAt(mullionIndex++, m);
        }

        const bx = sx * HALF / 2;
        const bz = sz * (HALF + BALCONY_D / 2);
        m.compose(new THREE.Vector3(bx, yBase + 0.14, bz), q, one);
        balconySlabs.setMatrixAt(i, m);
        m.compose(new THREE.Vector3(bx, yBase + 0.85, sz * (HALF + BALCONY_D)), q, one);
        railings.setMatrixAt(i, m);

        const hitBox = new THREE.Mesh(hitGeo, hitMat);
        hitBox.position.set(sx * (HALF + 0.6) / 2, yMid, sz * (HALF + 0.6 + BALCONY_D) / 2);
        hitBox.userData.unitId = u.id;
        scene.add(hitBox);

        units.set(u.id, {
            ...u,
            material,
            hitBox,
            focus: new THREE.Vector3(sx * HALF / 2, yMid, sz * HALF / 2),
            dir: new THREE.Vector3(sx, 0, sz).normalize(),
            glow: 2.4 + rnd() * 1.2,
            tint: COLOR.sold.clone().offsetHSL((rnd() - 0.5) * 0.03, 0, (rnd() - 0.5) * 0.06)
        });
    });

    mullions.count = mullionIndex;
    scene.add(mullions, balconySlabs, railings);
    return units;
}

function addLobby(scene, span, concrete) {
    const lobby = new THREE.Mesh(
        new THREE.BoxGeometry(span - 3, LOBBY_H - 0.4, span - 3),
        new THREE.MeshStandardMaterial({ color: '#1a1a1a', emissive: '#ffcf99', emissiveIntensity: 0.55, roughness: 0.2 }));
    lobby.position.y = (LOBBY_H - 0.4) / 2;
    scene.add(lobby);

    const canopy = new THREE.Mesh(new THREE.BoxGeometry(11, 0.4, 6), concrete);
    canopy.position.set(0, 4.6, HALF + 2.6);
    canopy.castShadow = true;
    scene.add(canopy);

    const strip = new THREE.Mesh(
        new THREE.BoxGeometry(10.6, 0.08, 0.08),
        new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#ffe2b8', emissiveIntensity: 5 }));
    strip.position.set(0, 4.38, HALF + 5.5);
    scene.add(strip);
}

function addCrown(scene, span, topY, concrete, darkMat) {
    const crown = new THREE.Mesh(new THREE.BoxGeometry(span - 5, 4, span - 5), darkMat);
    crown.position.y = topY + 2;
    crown.castShadow = true;
    scene.add(crown);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(span - 3.6, 0.5, span - 3.6), concrete);
    cap.position.y = topY + 4.25;
    scene.add(cap);

    const band = new THREE.Mesh(
        new THREE.BoxGeometry(span - 4.8, 0.18, span - 4.8),
        new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#f5c26b', emissiveIntensity: 4 }));
    band.position.y = topY + 3.7;
    scene.add(band);
}

function createComposer(renderer, scene, camera, width, height) {
    const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(width, height);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.45, 0.35, 1.1));
    composer.addPass(new OutputPass());
    return composer;
}

// ---------- Estado visual das unidades ----------

function applyVisual(unit) {
    const mat = unit.material;
    const isSelected = ctx.selectedId === unit.id;
    const isHovered = ctx.hoveredId === unit.id;

    if (isSelected) {
        mat.emissive.copy(unit.sold ? unit.tint : COLOR.hover);
        mat.emissiveIntensity = selectedIntensity(unit);
    } else if (isHovered) {
        mat.emissive.copy(unit.sold ? unit.tint : COLOR.hover);
        mat.emissiveIntensity = unit.sold ? unit.glow * 1.25 : 1.8;
    } else if (unit.sold) {
        mat.emissive.copy(unit.tint);
        mat.emissiveIntensity = ctx.onlyAvailable ? 0.18 : unit.glow;
    } else if (ctx.onlyAvailable) {
        mat.emissive.copy(COLOR.availableHint);
        mat.emissiveIntensity = 0.75;
    } else {
        mat.emissive.copy(COLOR.available);
        mat.emissiveIntensity = 0;
    }
}

function selectedIntensity(unit) {
    return unit.sold ? unit.glow : 1.8;
}

function focusUnit(unit) {
    ctx.controls.autoRotate = false;
    clearTimeout(ctx.idleTimer);
    const distance = Math.min(Math.max(ctx.camera.position.distanceTo(ctx.controls.target), 50), 85);
    const position = unit.focus.clone()
        .addScaledVector(unit.dir, distance)
        .add(new THREE.Vector3(0, 6, 0));
    flyTo(position, unit.focus.clone(), 1300);
}

function flyTo(position, target, duration, done) {
    ctx.tween = {
        fromPos: ctx.camera.position.clone(),
        toPos: position,
        fromTarget: ctx.controls.target.clone(),
        toTarget: target,
        start: performance.now(),
        duration,
        done
    };
}

function scheduleAutoRotate() {
    clearTimeout(ctx.idleTimer);
    ctx.idleTimer = setTimeout(() => {
        if (ctx && !ctx.selectedId && !ctx.tween) ctx.controls.autoRotate = true;
    }, IDLE_RESUME_MS);
}

// ---------- Interação ----------

function wireEvents() {
    const el = ctx.renderer.domElement;
    const on = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        ctx.listeners.push(() => target.removeEventListener(type, handler, options));
    };

    on(el, 'pointermove', e => {
        if (e.pointerType !== 'mouse') return;
        const rect = el.getBoundingClientRect();
        ctx.pointer.x = e.clientX - rect.left;
        ctx.pointer.y = e.clientY - rect.top;
        ctx.pointer.dirty = true;
    });
    on(el, 'pointerleave', () => setHovered(null));
    on(el, 'pointerdown', e => {
        ctx.pointer.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    on(el, 'pointerup', e => {
        const down = ctx.pointer.down;
        ctx.pointer.down = null;
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 600) return;
        const rect = el.getBoundingClientRect();
        const id = pick(e.clientX - rect.left, e.clientY - rect.top);
        if (!id) return;
        select(id);
        ctx.dotnet.invokeMethodAsync('OnUnitClicked', id);
    });
    on(window, 'keydown', e => {
        if (e.key === 'Escape' && ctx.selectedId) ctx.dotnet.invokeMethodAsync('OnCloseRequested');
    });

    const onStart = () => {
        ctx.tween = null;
        ctx.controls.autoRotate = false;
        clearTimeout(ctx.idleTimer);
    };
    const onEnd = () => { if (!ctx.selectedId) scheduleAutoRotate(); };
    ctx.controls.addEventListener('start', onStart);
    ctx.controls.addEventListener('end', onEnd);

    const observer = new ResizeObserver(() => resize());
    observer.observe(ctx.container);
    ctx.listeners.push(() => observer.disconnect());
}

function pick(x, y) {
    const { clientWidth: w, clientHeight: h } = ctx.renderer.domElement;
    ctx.raycaster.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), ctx.camera);
    const hit = ctx.raycaster.intersectObjects(ctx.hitBoxes, false)[0];
    return hit?.object.userData.unitId ?? null;
}

function setHovered(id) {
    if (ctx.hoveredId === id) return;
    const previous = ctx.hoveredId;
    ctx.hoveredId = id;
    if (previous) applyVisual(ctx.units.get(previous));
    if (id) applyVisual(ctx.units.get(id));
    ctx.renderer.domElement.style.cursor = id ? 'pointer' : '';

    const tip = ctx.tooltip;
    if (!id) {
        tip.classList.remove('visible');
        return;
    }
    const unit = ctx.units.get(id);
    tip.innerHTML = '';
    const title = document.createElement('strong');
    title.textContent = unit.title;
    const subtitle = document.createElement('span');
    subtitle.textContent = unit.subtitle;
    const status = document.createElement('em');
    status.className = unit.sold ? 'sold' : 'available';
    status.textContent = unit.sold ? 'Vendida' : 'Disponível';
    tip.append(title, subtitle, status);
    tip.classList.add('visible');
}

function resize() {
    const { clientWidth: w, clientHeight: h } = ctx.container;
    if (!w || !h) return;
    ctx.camera.aspect = w / h;
    ctx.camera.updateProjectionMatrix();
    ctx.renderer.setSize(w, h);
    ctx.composer.setSize(w, h);
}

// ---------- Loop ----------

function frame(time) {
    if (!ctx) return;

    if (ctx.tween) {
        const tw = ctx.tween;
        const k = Math.min(1, (performance.now() - tw.start) / tw.duration);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        ctx.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
        ctx.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
        // Os controles limitariam a distância durante a animação de entrada.
        ctx.camera.lookAt(ctx.controls.target);
        if (k >= 1) {
            ctx.tween = null;
            tw.done?.();
        }
    } else {
        ctx.controls.update();
    }

    updateViewShift();

    if (ctx.pointer.dirty) {
        ctx.pointer.dirty = false;
        setHovered(pick(ctx.pointer.x, ctx.pointer.y));
        ctx.tooltip.style.transform = `translate(${ctx.pointer.x + 18}px, ${ctx.pointer.y + 18}px)`;
    }

    if (ctx.selectedId) {
        const unit = ctx.units.get(ctx.selectedId);
        unit.material.emissiveIntensity = selectedIntensity(unit) * (0.85 + Math.sin(time * 0.004) * 0.2);
    }

    ctx.composer.render();

    if (!ctx.readySent) {
        ctx.readySent = true;
        ctx.dotnet.invokeMethodAsync('OnSceneReady');
    }
}

// ---------- Utilitários ----------

// Mantém a unidade selecionada no centro da área livre ao lado do painel.
function updateViewShift() {
    const { clientWidth: w, clientHeight: h } = ctx.container;
    const target = ctx.selectedId && w > MOBILE_BREAKPOINT ? PANEL_SHIFT_PX : 0;
    if (Math.abs(target - ctx.viewShift) < 0.5) {
        if (target === 0 && ctx.camera.view?.enabled) ctx.camera.clearViewOffset();
        ctx.viewShift = target;
        if (target === 0) return;
    } else {
        ctx.viewShift += (target - ctx.viewShift) * 0.08;
    }
    ctx.camera.setViewOffset(w, h, ctx.viewShift, 0, w, h);
}

function makeRoomTexture(seed) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const g = canvas.getContext('2d');
    const rnd = mulberry32(seed);

    const gradient = g.createLinearGradient(0, 0, 0, 64);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.5, '#c4c4c4');
    gradient.addColorStop(1, '#707070');
    g.fillStyle = gradient;
    g.fillRect(0, 0, 256, 64);

    // Cortinas e silhuetas de móveis para o vidro aceso não parecer uma caixa de luz.
    g.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 0; i < 4; i++) {
        const w = 8 + rnd() * 26;
        g.fillRect(rnd() * (256 - w), 0, w, 64);
    }
    g.fillStyle = 'rgba(0,0,0,0.4)';
    for (let i = 0; i < 3; i++) {
        const w = 24 + rnd() * 50;
        const h = 10 + rnd() * 16;
        g.fillRect(rnd() * (256 - w), 64 - h, w, h);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
