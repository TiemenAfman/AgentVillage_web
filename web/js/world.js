// The island itself: ground, sea, forest, sky and the passage of the day.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, fbm2, makeSimplex2D, hash32, smoothstep, clamp, lerp } from 'shared/rng.mjs';
import { POLDER_H } from 'shared/terrain.mjs';
import * as models from './models.js';
import { groundWearField, riverBankField, dressGroundWear } from './ground-wear.js';
import { decodeOwnership, settledDistance, buildBorders, planFields, buildFieldDecals, dressFieldMaterial, createBoundaryMaterial, orchardTrees, FIELD_COVERAGE, NONE, TOWN } from './hamlets.js';

const tmpColor = new THREE.Color();
const tmpTint = new THREE.Color();

const tmpObj = new THREE.Object3D();

const SEASON = {
  spring: { meadow: 0x93cf62, upland: 0x74ad4c, canopyMul: 1.06, summit: 0xa39d90 },
  summer: { meadow: 0x8fbf5a, upland: 0x6fa64a, canopyMul: 1.0, summit: 0xa39d90 },
  autumn: { meadow: 0x91ad68, upland: 0x738b53, canopyMul: 0.95, summit: 0xa39d90 },
  winter: { meadow: 0x8f9f76, upland: 0x77855f, canopyMul: 0.86, summit: 0xe6e6e0 },
};
export function seasonOf(month) {
  if (month <= 1 || month === 11) return 'winter';
  if (month <= 4) return 'spring';
  if (month <= 7) return 'summer';
  return 'autumn';
}

// hour -> the look of the sky. Interpolated linearly between neighbours.
const DAY = [
  { h: 0, top: 0x0b1430, hor: 0x1c2a55, key: 0x8fa6ff, int: 0.28, sky: 0x243a6b, ground: 0x101820, amb: 0.13, night: 1, fire: 1, stars: 1 },
  { h: 5, top: 0x182a55, hor: 0x3a4a7a, key: 0xa0b0ff, int: 0.3, sky: 0x2c4270, ground: 0x14202a, amb: 0.15, night: 1, fire: 0.6, stars: 0.8 },
  { h: 6.5, top: 0x5a6fb0, hor: 0xffc9a0, key: 0xffb070, int: 1.5, sky: 0x7f8fc0, ground: 0x5a4a3a, amb: 0.26, night: 0.55, fire: 0, stars: 0 },
  { h: 8, top: 0x6fb2e8, hor: 0xe8f3ff, key: 0xfff0d0, int: 2.6, sky: 0xbfe0ff, ground: 0x7a8a5a, amb: 0.36, night: 0, fire: 0, stars: 0 },
  { h: 12, top: 0x5ea6e6, hor: 0xdcefff, key: 0xfff8ea, int: 3.0, sky: 0xbfe0ff, ground: 0x8f8a60, amb: 0.4, night: 0, fire: 0, stars: 0 },
  // Late afternoon is the hour the island is meant to be looked at, so it carries the
  // warmth: a goldener key, a little more of it, and a horizon that has already turned.
  // `ground` is the light the meadow throws back up - warm here, which is what keeps a
  // north wall from going flat grey now that the sun sits so low that it never reaches one.
  { h: 17, top: 0x6fa8e0, hor: 0xffd7a2, key: 0xffc98a, int: 2.6, sky: 0xb0c8e8, ground: 0x8a7850, amb: 0.38, night: 0.15, fire: 0, stars: 0 },
  { h: 18.5, top: 0x3d4f8a, hor: 0xff8f46, key: 0xff8f52, int: 1.7, sky: 0x705a80, ground: 0x53402f, amb: 0.28, night: 0.7, fire: 0.3, stars: 0.1 },
  { h: 20, top: 0x141f45, hor: 0x3a3560, key: 0x8fa6ff, int: 0.32, sky: 0x2a3a6a, ground: 0x141c28, amb: 0.15, night: 1, fire: 1, stars: 0.8 },
  { h: 24, top: 0x0b1430, hor: 0x1c2a55, key: 0x8fa6ff, int: 0.28, sky: 0x243a6b, ground: 0x101820, amb: 0.13, night: 1, fire: 1, stars: 1 },
];

function dayAt(hour) {
  const h = ((hour % 24) + 24) % 24;
  let a = DAY[0], b = DAY[DAY.length - 1];
  for (let i = 0; i < DAY.length - 1; i++) {
    if (h >= DAY[i].h && h <= DAY[i + 1].h) { a = DAY[i]; b = DAY[i + 1]; break; }
  }
  const t = b.h === a.h ? 0 : (h - a.h) / (b.h - a.h);
  return {
    top: tmpColor.setHex(a.top).lerp(new THREE.Color(b.top), t).clone(),
    hor: new THREE.Color(a.hor).lerp(new THREE.Color(b.hor), t),
    key: new THREE.Color(a.key).lerp(new THREE.Color(b.key), t),
    sky: new THREE.Color(a.sky).lerp(new THREE.Color(b.sky), t),
    ground: new THREE.Color(a.ground).lerp(new THREE.Color(b.ground), t),
    int: lerp(a.int, b.int, t),
    amb: lerp(a.amb, b.amb, t),
    night: lerp(a.night, b.night, t),
    fire: lerp(a.fire, b.fire, t),
    stars: lerp(a.stars, b.stars, t),
  };
}

export function sunDirection(hour) {
  const h = ((hour % 24) + 24) % 24;
  const day = h >= 6 && h <= 18;
  const p = day ? (h - 6) / 12 : (((h + 6) % 24) / 12);
  // How high the sun climbs at noon. It used to reach 1.15 rad - 66 degrees, a sun over
  // the tropics - and at that angle a roof casts a shadow shorter than its own eaves at
  // midday and the island reads as a flat map at every hour. 0.85 rad tops out at 49
  // degrees and puts the sun at about 13 degrees at five in the afternoon, which is where
  // the long raking light of the reference picture comes from. The clamp below stays: it
  // is what keeps the shadow frustum's own maths out of trouble when the sun is on the
  // horizon, not a lighting choice.
  const el = Math.sin(Math.PI * p) * (day ? 0.85 : 0.9);
  const az = Math.PI * p + 3.5;
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.max(0.06, Math.sin(el)), Math.cos(el) * Math.cos(az)).normalize();
}

// The shadow frustum as [tightest, widest] half-width, and the share of the camera's
// distance it tries to cover. It used to be a fixed 42 - 84 units across, chosen when a
// whole island fitted inside it - and from the distance this one is framed at, two thirds
// of the picture came out shadowless. Widening it for good instead would spend the same
// shadow map on nine times the ground and blur every eave you zoom in on, so it breathes:
// tight when you are down among the houses, wide enough for the coast when you pull back.
const SHADOW_SPAN = [42, 130];
const SHADOW_OF_DIST = 0.48;

// Where the sand gives up and the meadow takes over. The bands below still change on a
// line at 0.35 - the height `terrain.mjs` calls the top of a beach, and the height the
// Node layout decides where a house may stand by - but the *drawing* crossfades across
// this range instead, which on this island's gradients is two to six cells of dune grass
// rather than a contour line running round the island like a coastline on a map.
// `terrain.mjs` is untouched on purpose: what moved is the painting, not the rule, so
// `isBeach` answers exactly what it did and Node and the browser still agree.
const SHORE = [0.25, 0.6];
const SHORE_SAND = 0xefddb2;

function bandColour(h, season) {
  const s = SEASON[season];
  if (h < -0.6) return 0x3f6a7c;
  if (h < 0) return 0x8f9f7a;
  if (h < 0.35) return SHORE_SAND;
  if (h < 1.6) return s.meadow;
  if (h < 3.4) return s.upland;
  if (h < 5.2) return 0x8f8a80;
  return s.summit;
}

// The sheets the island is drawn on, and the one place that knows how to fetch one.
// Everything here is optional: a sheet that does not arrive leaves the surface exactly
// as it was drawn before there were any, which is why nothing below waits on one.
const TEXTURES = 'textures/';
const texLoader = new THREE.TextureLoader();
function sheet(name, onLoad) {
  texLoader.load(`${TEXTURES}${name}.png`, (tex) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;              // the renderer clamps this to whatever the card allows
    onLoad(tex);
  }, undefined, () => {
    console.warn(`[island] no texture at web/${TEXTURES}${name}.png; that surface stays as it was`);
  });
}

export function createWorld(scene, terrain, village, opts = {}) {
  const size = terrain.size, half = terrain.half, N = terrain.N;
  const season = seasonOf(opts.month ?? new Date().getMonth());
  const group = new THREE.Group();
  scene.add(group);

  // ---- ground -------------------------------------------------------------
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * N * 3);
  const col = new Float32Array(N * N * 3);
  // Grass is a nap rather than a pattern, so the sheet is tiled small and often. Three
  // units - twelve metres - is about as large as it can be before the eye starts to read
  // the sheet itself instead of the ground.
  const GRASS_UNITS = 3;
  const uv = new Float32Array(N * N * 2);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = i + j * N;
      pos[k * 3] = i - half;
      pos[k * 3 + 1] = terrain.H[k];
      pos[k * 3 + 2] = j - half;
      uv[k * 2] = (i - half) / GRASS_UNITS;
      uv[k * 2 + 1] = (j - half) / GRASS_UNITS;
    }
  }
  const idx = new Uint32Array(size * size * 6);
  let p = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const a = i + j * N, b = a + 1, c = a + N, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  // Whose land a ground vertex stands on, and how far inside it. A vertex touches up to
  // four cells, and `inset` already ramps over three of them, so the tint feathers over
  // about three world units for free - farmland fading into heath rather than a border
  // drawn on a political map.
  const tintHue = new Float32Array(N * N);
  const tintAmt = new Float32Array(N * N);
  function computeTint(owner, inset, hues) {
    tintAmt.fill(0);
    if (!owner) return;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let best = NONE, depth = 0;
        for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
          const gx = i + dx, gz = j + dz;
          if (gx < 0 || gz < 0 || gx >= size || gz >= size) continue;
          const o = owner[gx + gz * size];
          if (o === NONE) continue;
          const d = inset[gx + gz * size];
          if (best === NONE || d > depth || (d === depth && o < best)) { best = o; depth = d; }
        }
        const k = i + j * N;
        if (best === NONE || hues[best] == null) continue;
        tintHue[k] = hues[best];
        tintAmt[k] = Math.min(1, depth / 3);
      }
    }
  }

  const TINT = 0.11;          // past about 0.14 the hue reads as a category, not as soil
  const meadowNoise = makeSimplex2D(hash32(`meadow:${village.seed || 0}`));

  // Reclaimed land, which is not a beach however low it lies. A polder floor is stamped
  // at exactly POLDER_H - 0.375, chosen over in terrain.mjs so that it clears the beach
  // line by four hundredths rather than falling under it - and the soft shore above would
  // read seven tenths of it as sand: a village that had just drained a bay would be handed
  // a sandpit. The sea wall put that ground there, and the heightfield is the record of
  // it: a cell all four of whose corners sit exactly on the reclamation height is polder
  // floor, and polder floor is the lowest meadow on the island rather than its highest
  // beach. Derived from the terrain rather than from `village.polders` so that it follows
  // `reshape`, which is handed a new heightfield and no village at all.
  const reclaimed = new Uint8Array(N * N);
  function findReclaimed() {
    reclaimed.fill(0);
    for (let gz = 0; gz < size; gz++) {
      for (let gx = 0; gx < size; gx++) {
        const k = gx + gz * N;
        if (terrain.H[k] !== POLDER_H || terrain.H[k + 1] !== POLDER_H
          || terrain.H[k + N] !== POLDER_H || terrain.H[k + N + 1] !== POLDER_H) continue;
        reclaimed[k] = 1; reclaimed[k + 1] = 1; reclaimed[k + N] = 1; reclaimed[k + N + 1] = 1;
      }
    }
  }

  function paintGround(seasonName) {
    findReclaimed();
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = i + j * N;
        const h = terrain.H[k];
        tmpColor.setHex(bandColour(h, seasonName));
        // The shore, crossfaded rather than stepped. See SHORE above.
        if (h > SHORE[0] && h < SHORE[1] && !reclaimed[k]) {
          tmpColor.setHex(SHORE_SAND).lerp(tmpTint.setHex(SEASON[seasonName].meadow), smoothstep(SHORE[0], SHORE[1], h));
        }
        // Broad, stable patches of colour soften the grid without textures or geometry.
        // They start where the sand starts to go, not on the old line at 0.35, or the
        // last trace of that line would be the edge of the mottling.
        if (h >= SHORE[0] && h < 3.4) {
          tmpColor.multiplyScalar(1 + meadowNoise(i * 0.12, j * 0.12) * 0.065);
        }
        const a = tintAmt[k];
        // Meadow and upland only: tinting the sand or the summit is what would make this
        // look like an overlay rather than like farmland.
        if (a > 0 && h >= 0.35 && h < 3.4) {
          tmpTint.setHSL(tintHue[k] / 360, 0.3, 0.5);
          tmpColor.lerp(tmpTint, TINT * a);
          tmpColor.offsetHSL(0, 0, 0.015 * a);
        }
        col[k * 3] = tmpColor.r; col[k * 3 + 1] = tmpColor.g; col[k * 3 + 2] = tmpColor.b;
      }
    }
    geo.attributes.color.needsUpdate = true;
  }

  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: false, roughness: 0.96, metalness: 0,
  }));
  const wearResolution = Math.min(2048, size * 8);
  const wearTexture = new THREE.DataTexture(new Uint8Array(wearResolution * wearResolution), wearResolution, wearResolution, THREE.RedFormat);
  wearTexture.magFilter = wearTexture.minFilter = THREE.LinearFilter;
  wearTexture.needsUpdate = true;
  const plazaTexture = wearTexture.clone();
  plazaTexture.image = {data:new Uint8Array(wearResolution*wearResolution),width:wearResolution,height:wearResolution};
  plazaTexture.needsUpdate = true;
  const bank = riverBankField(size, village.seed || 0, terrain.riverBankCells, wearResolution);
  const bankTexture = new THREE.DataTexture(bank.data, bank.resolution, bank.resolution, THREE.RedFormat);
  bankTexture.magFilter = bankTexture.minFilter = THREE.LinearFilter;
  bankTexture.needsUpdate = true;
  const blankRiverSheet = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  blankRiverSheet.needsUpdate = true;
  const riverSheet = { value: blankRiverSheet };
  dressGroundWear(ground.material, wearTexture, size, THREE, plazaTexture, { texture: bankTexture, sheet: riverSheet });
  sheet('river-shingle', (tex) => { riverSheet.value = tex; });
  ground.receiveShadow = true;
  ground.name = 'ground';
  group.add(ground);
  // The bands, the season, the district tint and the meadow noise are all already in the
  // vertex colours. The sheet is brightness only, so it grains the ground without having
  // an opinion about any of them.
  sheet('grass', (tex) => { ground.material.map = tex; ground.material.needsUpdate = true; });

  // ---- sea, the lake and the rivers ---------------------------------------
  // One surface for all the water there is: everything below SEA_LEVEL is under this
  // plane and the ground mesh hides it everywhere else, which is how the lake has always
  // been drawn and is now how the rivers are drawn too. A river is only about two cells
  // across, though, and the old two-unit grid put barely a vertex in the channel - the
  // depth it shaded by came from the bank. Hence a vertex per unit here.
  //
  // 260 was a fixed number that happened to fit a grid of 140 with room to spare. A grid
  // can be 512, and then the detailed patch stopped at 130 while the coast ran on to 256:
  // half the island's own water had no rivers shaded into it. It follows the island now,
  // with the same margin - which on a small island is less to draw than before, not more.
  const wSpan = Math.max(260, size + 120);
  const wSeg = opts.modest ? Math.round(wSpan / 2) : wSpan;
  const waterGeo = new THREE.PlaneGeometry(wSpan, wSpan, wSeg, wSeg);
  waterGeo.rotateX(-Math.PI / 2);
  const wp = waterGeo.attributes.position;
  const depth = new Float32Array(wp.count);
  for (let i = 0; i < wp.count; i++) {
    depth[i] = terrain.worldHeight(wp.getX(i), wp.getZ(i));
    if (Math.abs(wp.getX(i)) > half || Math.abs(wp.getZ(i)) > half) depth[i] = -2.5;
  }
  waterGeo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));

  const waterMat = new THREE.ShaderMaterial({
    fog: true,
    transparent: true,
    depthWrite: false,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x215e78) },
        uShallow: { value: new THREE.Color(0x65c4b5) },
        uFoam: { value: new THREE.Color(0xeaf6f8) },
        uPatchHalf: { value: wSpan * 0.5 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xffffff) },
        uNight: { value: 0 },
      },
    ]),
    vertexShader: `
      #include <fog_pars_vertex>
      attribute float aDepth;
      uniform float uTime;
      varying float vDepth;
      varying vec3 vWorld;
      varying vec3 vWave;
      varying float vPatchEdge;
      void main() {
        vDepth = aDepth;
        vec3 p = position;
        float w1 = sin(p.x * 1.3 + uTime * 1.1);
        float w2 = sin(p.z * 1.7 - uTime * 0.9);
        p.y += 0.05 * w1 + 0.04 * w2;
        vWave = vec3(-0.065 * cos(p.x * 1.3 + uTime * 1.1), 1.0, -0.068 * cos(p.z * 1.7 - uTime * 0.9));
        vPatchEdge = max(abs(p.x), abs(p.z));
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform vec3 uDeep, uShallow, uFoam, uSunColor;
      uniform vec3 uSunDir;
      uniform float uTime, uNight, uPatchHalf;
      varying float vDepth;
      varying vec3 vWorld;
      varying vec3 vWave;
      varying float vPatchEdge;
      void main() {
        float shallow = smoothstep(-2.0, -0.1, vDepth);
        vec3 col = mix(uDeep, uShallow, shallow);
        // The surf. It used to fade in over three tenths of a unit of depth, which on
        // this island's shelf is barely two cells across: a white hairline drawn round
        // the coast rather than water breaking on a beach. Two terms now. A broad band
        // of foaming shallow water, squared so that widening its reach does not simply
        // wash the whole bay pale - the far half of the band stays water that happens to
        // be light. And the line where the sea actually runs up the sand, which is the
        // part the eye reads as surf and which the broad band on its own smeared away.
        // The swell is slower across the band as well: sixteen cycles over three times
        // the depth range, so it reads as two or three rows of breakers instead of a
        // fine corduroy.
        float shore = smoothstep(-0.65, 0.02, vDepth);
        float swell = 0.55 + 0.45 * sin(uTime * 1.3 + vDepth * 16.0 + sin(vWorld.x * 0.7 + vWorld.z * 0.5));
        float foam = shore * shore * swell + smoothstep(-0.14, 0.0, vDepth) * 0.5;
        col = mix(col, uFoam, clamp(foam, 0.0, 1.0) * 0.66);
        vec3 n = normalize(vWave);
        vec3 v = normalize(cameraPosition - vWorld);
        float fresnel = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        col = mix(col, uShallow, fresnel * 0.18);
        vec3 r = reflect(-normalize(uSunDir), n);
        float spec = pow(max(dot(r, v), 0.0), 60.0);
        col += uSunColor * spec * 0.55 * (1.0 - uNight * 0.8);
        col *= mix(1.0, 0.34, uNight);
        // This detailed sheet lies over the open-ocean disc. Fade it out while there is
        // still plenty of water between it and the island, otherwise its square edge is
        // visible whenever its denser waves and translucent colour differ from the disc.
        // The ocean uses this shader too, but is opaque, so its alpha is intentionally
        // ignored and the two surfaces meet without a line or a hole.
        float patchFade = smoothstep(0.0, 24.0, uPatchHalf - vPatchEdge);
        gl_FragColor = vec4(col, 0.88 * patchFade);
        #include <fog_fragment>
      }
    `,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.y = 0;
  water.renderOrder = 1;
  group.add(water);

  // The open sea, beyond the detailed patch. It used to be a flat blue card of radius 500,
  // which was enough while nothing stood on it. The neighbours do: they lie at 150 to 190
  // and an island of the largest grid reaches 256 further again, so the far water is
  // something you look at rather than past. It is the same shader now, sharing the same
  // uniforms so there is one clock and one sun over the whole sea, and it runs out to
  // 1200 - inside the camera's far plane, with the sky grown to stay outside it.
  //
  // A handful of segments is all it needs. Out here `aDepth` is the same -2.5 the patch
  // gives everything past its own edge, so the colour is constant and there is nothing to
  // interpolate; the waves are 5 cm on a surface a kilometre across.
  //
  // Opaque, unlike the patch, because there is nothing underneath it to show through.
  const OCEAN_R = 1200;
  const oceanGeo = new THREE.CircleGeometry(OCEAN_R, 128);
  oceanGeo.rotateX(-Math.PI / 2);
  const oceanDepth = new Float32Array(oceanGeo.attributes.position.count).fill(-2.5);
  oceanGeo.setAttribute('aDepth', new THREE.BufferAttribute(oceanDepth, 1));
  const oceanMat = waterMat.clone();
  oceanMat.uniforms = waterMat.uniforms;   // one clock, one sun, one nightfall
  oceanMat.transparent = false;
  oceanMat.depthWrite = true;
  const ocean = new THREE.Mesh(oceanGeo, oceanMat);
  // Wave troughs reach -0.09. Keep the backdrop underneath them to avoid blue tiles: this
  // disc carries the same wave, but with a vertex only at its centre and its rim it is
  // flat where the patch is not, so the two do not dip together.
  ocean.position.y = -0.2;
  ocean.renderOrder = 0;
  group.add(ocean);

  // ---- sky ----------------------------------------------------------------
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x5ea6e6) },
      uHor: { value: new THREE.Color(0xdcefff) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uStars: { value: 0 },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uTop, uHor, uSunColor; uniform vec3 uSunDir; uniform float uStars;
      varying vec3 vDir;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
      void main(){
        vec3 d = normalize(vDir);
        vec3 col = mix(uHor, uTop, smoothstep(-0.05, 0.45, d.y));
        float halo = pow(max(dot(d, normalize(uSunDir)), 0.0), 48.0);
        col += uSunColor * halo * 0.5;
        if (uStars > 0.01 && d.y > 0.0) {
          vec2 g = floor(d.xz * 260.0 + d.y * 40.0);
          float s = step(0.9975, hash(g));
          col += vec3(s) * uStars * (0.6 + 0.4 * hash(g + 3.0)) * smoothstep(0.0, 0.35, d.y);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1340, 26, 16), skyMat);   // outside the sea, inside the camera's far plane
  sky.frustumCulled = false;
  group.add(sky);

  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(11, 14, 10), new THREE.MeshBasicMaterial({ color: 0xfff3d0, fog: false }));
  const moonDisc = new THREE.Mesh(new THREE.SphereGeometry(8, 14, 10), new THREE.MeshBasicMaterial({ color: 0xe6ecff, fog: false }));
  group.add(sunDisc, moonDisc);

  // The haze exists here because every material has to compile knowing there is fog, but
  // the two distances are set from main.js and nowhere else. They used to be set in both
  // places - scaled to the island here, overwritten with a fixed 235 on every neighbour
  // sync there - and the fixed pair always won. Colour still follows the sky, below.
  scene.fog = new THREE.Fog(0xdcefff, terrain.half * 1.1, terrain.half * 3.4);

  // ---- lights --------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x8f8a60, 0.85);
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  const key = new THREE.DirectionalLight(0xfff8ea, 3.0);
  key.castShadow = true;
  key.shadow.mapSize.set(opts.shadowSize || 2048, opts.shadowSize || 2048);
  // Half-width of the shadow frustum. `followShadow` moves it with the zoom, so this is
  // only the tightest it ever gets; SHADOW_SPAN below says what the numbers mean.
  key.shadow.camera.left = -SHADOW_SPAN[0]; key.shadow.camera.right = SHADOW_SPAN[0];
  key.shadow.camera.top = SHADOW_SPAN[0]; key.shadow.camera.bottom = -SHADOW_SPAN[0];
  key.shadow.camera.near = 10; key.shadow.camera.far = 2 * SHADOW_SPAN[0] + 90;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  // One step softer, now that the sun is low enough for a shadow to run the length of a
  // lane: a hard edge that far from its caster reads as a painted stripe. PCFSoft only,
  // so `modest` (PCFShadowMap, which ignores the radius) is untouched.
  key.shadow.radius = 4;
  scene.add(hemi, ambient, key, key.target);

  // ---- vegetation ----------------------------------------------------------
  // Two sets, and the difference matters. `clearedBase` is ground that buildings, roads
  // and squares have taken - that is what decides where a field may go. `cleared` is that
  // plus the fields themselves, which is what keeps the forest from growing on top of
  // them. Planning fields against `cleared` would find nothing the second time round,
  // because the first plan's own cells would have ruled every candidate out.
  const baseCleared = (v) => {
    const out = new Set((v.cleared || []).map(([gx, gz]) => gx + gz * size));
    // The wire clears the paths but not every paved cell of a square, and a field
    // planned over paving comes out as furrows running across the stones. It never
    // showed while the paving was a flat sandy colour and the furrows were sandy too;
    // against cobbles it is the first thing you see.
    for (const [gx, gz] of squareCells(v)) out.add(gx + gz * size);
    // A bridge is a road that happens to be off the ground, and nothing grows on a
    // deck. Without this the scatter plants a wood straight through the planks - which
    // is exactly what it was doing, because the wire does not clear a bridge either.
    for (const b of v.bridges || []) for (const [gx, gz] of b.cells || []) out.add(gx + gz * size);
    // A dike is a wall and a causeway is a road. Neither is ground that grows anything,
    // and both are flat and high enough that the scatter below would otherwise plant
    // trees along the top of the sea wall.
    for (const p of v.polders || []) {
      for (const [gx, gz] of [...(p.dike || []), ...(p.road || [])]) out.add(gx + gz * size);
    }
    for (const b of v.buildings || []) {
      if (!b.plot) continue;
      for (let z = -1; z <= b.plot.d; z++) for (let x = -1; x <= b.plot.w; x++) out.add((b.plot.gx + x) + (b.plot.gz + z) * size);
    }
    return out;
  };
  // How much of the countryside is under the plough. The chronicle hands down a share so
  // the fields arrive with the village that works them; a live village has none and gets
  // the full spread.
  //
  // The square goes in with it. A parcel that runs up against the paving hems the village
  // in where it is meant to open out: the one piece of ground everybody crosses ends in a
  // fence and a furrow instead of in grass, and from the air the heart of the island reads
  // as a farmyard. So the survey is told where the paving lies and leaves it a verge.
  const fieldOpts = (v) => ({
    square: townSquare(v),
    ...(v.farmShare == null ? {} : { coverage: FIELD_COVERAGE * v.farmShare }),
  });

  // Which cells the settlers walk on. The boundaries have always needed this to know
  // where to leave a gate; the fields and the forest now need it too, because how far a
  // cell is from a road is most of what decides whether anybody ploughs it or nobody has
  // ever cleared it. Built once here rather than three times over.
  const roadSet = (v) => {
    const out = new Set();
    for (const p of v.paths || []) for (const c of p.cells) out.add(c[0] + c[1] * size);
    for (const c of squareCells(v)) out.add(c[0] + c[1] * size);
    return out;
  };

  // The paved heart of the village and nothing else. `squareCells` also hands back every
  // district's paving, and that is a different kind of place - a hamlet's own yard, which
  // has its fields right up against it because that is what a hamlet is.
  const townSquare = (v) => {
    const out = new Set();
    const town = v.island && v.island.town;
    if (town?.paved) for (const [gx, gz] of town.paved) out.add(gx + gz * size);
    else if (town?.square) {
      const n = town.size || 3;
      for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) out.add((town.square[0] + x) + (town.square[1] + z) * size);
    }
    return out;
  };

  let clearedBase = baseCleared(village);
  const cleared = new Set(clearedBase);
  // Reclaimed land is farmland, not heath. It sits at POLDER_H, just under the height
  // the scatter treats as shore, so without this every polder comes out strewn with
  // boulders - about one cell in ten. It stays out of `clearedBase` so that a hamlet
  // which settles a polder still gets its fields.
  for (const p of village.polders || []) {
    for (const [gx, gz] of p.cells || []) cleared.add(gx + gz * size);
  }

  let own = decodeOwnership(village, size);
  let hues = village.districts.map((d) => d.hue);
  // Before the fields are planned, not after: clearedBase is what planFields reads to
  // decide where a patch may go.
  wallVerge(own.owner, clearedBase);
  wallVerge(own.owner, cleared);
  let roads = roadSet(village);
  let settled = settledDistance(terrain, own.owner, roads);
  let fieldPlan = planFields(village, terrain, own.owner, clearedBase, { ...fieldOpts(village), settled, paved: roads });
  computeTint(own.owner, own.inset, hues);
  paintGround(season);
  // Tilled ground is cleared ground: without this the forest is scattered straight on
  // top of the fields.
  for (const p of [...fieldPlan.patches, ...fieldPlan.orchards, ...fieldPlan.gardens]) {
    for (const [gx, gz] of p.cells) cleared.add(gx + gz * size);
  }

  // A tree is dropped at its cell's middle give or take 0.38, and an oak's canopy is
  // 0.45 across, so it reaches 0.83 from the middle - a third of a cell past its own
  // edge. A boundary wall stands on that edge and is up to 0.5 thick, so a tree beside
  // one goes straight through it. There is no offset that fixes this: half a cell minus
  // half a wall leaves 0.25, and the canopy alone is 0.44. So the wall gets a verge, and
  // a cell that touches a boundary is simply not planted.
  //
  // It began as a rule about trees, on the reasoning that a field may run right up to a
  // wall. It may not: a patch is a rectangle laid over whole cells and it will happily
  // take the cells either side of a boundary, so the ploughing ran under the wall and out
  // into the next hamlet's land. The verge is now the same for both - nothing is planted
  // and nothing is tilled on a cell that touches a boundary, which also gives every wall
  // the strip of grass along it that a wall in a field has anyway.
  //
  // This mirrors the test in buildBorders(): the town puts up nothing of its own and the
  // coast is a boundary already, so neither of those earns a verge.
  function wallVerge(ownerArr, into) {
    const at = (gx, gz) => (gx < 0 || gz < 0 || gx >= size || gz >= size ? NONE : ownerArr[gx + gz * size]);
    const walled = (o) => o !== NONE && o !== TOWN;
    for (let gz = 0; gz < size; gz++) {
      for (let gx = 0; gx < size; gx++) {
        const k = at(gx, gz);
        if (!walled(k)) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = at(gx + dx, gz + dz);
          if (n === k || !terrain.isLand(gx + dx, gz + dz)) continue;
          into.add(gx + gz * size);
          if (walled(n) || n === NONE) into.add((gx + dx) + (gz + dz) * size);
        }
      }
    }
  }

  const rng = makeRng(terrain.seed).fork('flora');
  const forest = makeSimplex2D(hash32(terrain.seed + ':forest'));

  // ---- what a tree is made of ----------------------------------------------
  // One material, twice, with a sheet each. Clones rather than new materials so that a
  // tree on a checkout with no textures at all is pixel for pixel the tree the island
  // always drew.
  const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
  const barkMat = treeMat.clone();
  const foliageMat = treeMat.clone();
  // Grass blades have no thickness in the Blender bake. Their own material shows the
  // same foliage sheet from both sides without making every closed tree canopy double-sided.
  const grassMat = treeMat.clone();
  grassMat.side = THREE.DoubleSide;
  sheet('bark', (tex) => { tex.repeat.set(2, 1); barkMat.map = tex; barkMat.needsUpdate = true; });
  sheet('foliage', (tex) => {
    tex.repeat.set(2, 2);
    foliageMat.map = tex; foliageMat.needsUpdate = true;
    grassMat.map = tex; grassMat.needsUpdate = true;
  });
  // Which material draws which group. A plant is asked for by its slots and gets its
  // materials back in the same order, so the two can never be listed apart: handing an
  // InstancedMesh [bark, foliage] for a geometry grouped foliage-first is a tree with a
  // wooden canopy, and nothing in three will say so.
  const SLOT_MAT = { bark: barkMat, foliage: foliageMat, plain: treeMat };
  const CANOPY = ['bark', 'foliage'];

  // A plant's geometry and the materials for its groups - from Blender if the set has
  // been baked, and from the shapes world.js grew by hand if it has not.
  //
  // The fallback is the point of the shape of this function. `flora-mesh.js` is
  // committed, so the branch below is not a loading state; it is what the island draws
  // on a checkout where the bake has been renamed or has yet to happen, and it is the
  // only reason a missing .blend cannot take the forest with it. Both branches have to
  // answer with their own material list, because the hand-built pine is three merged
  // shapes and three groups where the baked one is two.
  //
  // `_lo` is the modest GPU's copy of the same plant - two skirts instead of four, one
  // lobe instead of two - asked for by name rather than through variants(), which would
  // offer it as a third kind of pine for the rng to pick.
  function plant(name, slots, fallback) {
    const want = opts.modest && models.hasAsset(`${name}_lo`) ? `${name}_lo` : name;
    if (models.hasAsset(want)) {
      const geo = models.grouped(want, slots);
      if (geo) return { geo, mats: slots.map((s) => SLOT_MAT[s]) };
    }
    const grown = fallback();
    return { geo: grown.geo, mats: grown.mats };
  }

  // The trunk runs 0 to 0.5 and the first cone starts at 0.42, so its skirt closes over
  // the wood instead of hanging above it. The tree loses a little height by it, which
  // the trunk takes back: a conifer is mostly stem at the bottom anyway.
  const pine = plant('flora_pine_a', CANOPY, () => ({
    geo: merge([
      cyl(0.06, 0.09, 0.62, 5, 0x6b4a2f, 0.31),
      cone(0.42, 0.8, 6, 0x3f7d47, 0.42),
      cone(0.3, 0.7, 6, 0x478950, 0.85),
    ], true),
    mats: [barkMat, foliageMat, foliageMat],
  }));
  const oak = plant('flora_oak_a', CANOPY, () => ({
    geo: merge([
      cyl(0.07, 0.09, 0.5, 5, 0x6b4a2f, 0.25),
      ico(0.45, 0x5c9a3f, 0.72, 0.85),
    ], true),
    mats: [barkMat, foliageMat],
  }));
  const rock = plant('flora_rock_a', ['plain'], () => {
    const geo = dodeca(0.22, 0x7f7a72, 0.1);
    geo.computeVertexNormals();
    return { geo, mats: [treeMat] };
  });
  // The coast's own shape, and the one plant with no fallback: a flat shelf is new, and
  // the island drew nothing there before, so without the bake there is simply nothing to
  // put on the shore rather than a wrong thing.
  const slab = models.hasAsset('flora_rock_b')
    ? { geo: models.grouped('flora_rock_b', ['plain']), mats: [treeMat] } : null;
  const bush = models.hasAsset('flora_bush_a')
    ? { geo: models.grouped('flora_bush_a', ['foliage']), mats: [foliageMat] } : null;
  const grass = plant('flora_grass_a', ['foliage'], () => {
    const geo = cone(0.08, 0.18, 3, 0x7fb64d, 0.09);
    geo.computeVertexNormals();
    return { geo, mats: [treeMat] };
  });

  // ---- where the forest stands ---------------------------------------------
  // It used to be noise alone, which put the same even spatter of trees on the town
  // square's doorstep as on the far headland - nowhere was a clearing and nowhere was a
  // wood. The same distance field the fields are surveyed against shapes it now: inside
  // six cells of a door or a lane the canopy is pulled open, from eight out to twenty-four
  // it thins into heath with copses standing in it, and past that it closes into the dark
  // pine edge the island is meant to be ringed by. `cleared` is still the hard line, so a
  // polder stays bare grass however far from anybody it lies.
  const NEAR_CLEARING = 0.15;   // canopy a doorstep takes away
  const FAR_CANOPY = 0.35;      // canopy the wilderness adds back
  // Past CLOSED the third stem on a cell is bought and never seen: the canopy over it is
  // already shut. Past DEEP one stem to a cell is a wood from any distance the camera can
  // get to. Neither is a saving for its own sake - the trees are instanced and cost one
  // draw call between them - but the shadow pass walks every instance on the island, and
  // that is the bill `?stats` cannot show you, because three resets renderer.info after
  // the shadow pass and before the colour one.
  const CLOSED = 20, DEEP = 36;
  const TREE_CAP = opts.modest ? 9000 : 25000;

  // How many stems this cell wants. Noise and distance only - not one random number in
  // it - which is what makes the counting pass below affordable.
  // How much canopy this cell wants, before anything is counted. Split out of stems()
  // because the undergrowth is surveyed against the same number: a bush belongs in the
  // band just under the threshold a tree needs, which is only a meaningful place to
  // stand if both read it off one function.
  const density = (gx, gz, wx, wz) => {
    const d = settled.dist[gx + gz * size];
    return fbm2(forest, wx * 0.09, wz * 0.09, { octaves: 3 })
      - NEAR_CLEARING * (1 - smoothstep(0, 6, d))
      + FAR_CANOPY * smoothstep(8, 24, d);
  };
  const stems = (gx, gz, wx, wz) => {
    const d = settled.dist[gx + gz * size];
    const dens = density(gx, gz, wx, wz);
    if (dens < 0.12) return 0;
    let n = 1 + (dens > 0.3 ? 1 : 0) + (dens > 0.45 ? 1 : 0);
    if (d > CLOSED) n = Math.min(n, 2);
    if (d > DEEP) n = 1;
    return n;
  };
  const plantable = (gx, gz, h) =>
    !cleared.has(gx + gz * size) && h >= 0.45 && !terrain.isBeach(gx, gz)
    && terrain.slope(gx, gz) <= 1.3 && h <= 5.0;

  // Count first, plant second. Stopping dead once the budget is full would plant in the
  // order `landCells` happens to come in and leave one whole side of the island bald; a
  // ratio takes the same number of stems off evenly, and which cell loses one is decided
  // by that cell's own hash rather than by where the loop had got to. One extra noise
  // lookup per cell is the whole price.
  let wanted = 0;
  for (const [gx, gz] of terrain.landCells) {
    const h = terrain.heightAt(gx, gz);
    if (!plantable(gx, gz, h)) continue;
    const [wx, wz] = terrain.cellWorld(gx, gz);
    wanted += stems(gx, gz, wx, wz);
  }
  const thin = wanted > TREE_CAP ? TREE_CAP / wanted : 1;

  const trees = [];
  const treeCells = new Map();
  const pines = [], oaks = [], rocks = [], tufts = [], bushes = [];
  // How much undergrowth there may be. Four thousand bushes is forty triangles apiece
  // either side of the shadow pass, which is the same order as a thousand extra trees -
  // so it gets a ceiling of its own rather than riding on the forest's.
  const BUSH_CAP = opts.modest ? 1500 : 4000;
  // The band of canopy noise that is too thin for a wood and too green for bare heath:
  // the shoulder under the 0.12 a tree needs. Read off the same noise the trees are, so
  // a bush stands where the wood peters out rather than in a ring of its own.
  //
  // The lower edge is well under nothing on purpose. The plan asked for 0.06 to 0.12 and
  // that band was drawn for an island of 31,296 land cells; on the 7,556 this one has it
  // came to 133 bushes, which is not undergrowth but a rounding error. Reaching down to
  // -0.06 takes in the heath either side of the forest edge and gives 365 - about one
  // bush to six trees - for nine thousand triangles. Widening the band rather than
  // raising the chance is deliberate: the same number of bushes spread over more ground
  // reads as heath, and concentrated in a narrow ring reads as a hedge round the wood.
  const BUSH_LO = -0.06, BUSH_HI = 0.12;
  // Its own stream, so that adding undergrowth does not move a single tree. Every draw
  // taken from `rng` inside the loop below shifts every draw after it, and one extra
  // chance() per cell would have reshuffled the whole forest between pine and oak and
  // shuffled the trunks sideways - which would have made the before and after pictures
  // of this card unreadable for a change that is meant to be about shape.
  const bushRng = makeRng(terrain.seed).fork('bush');
  for (const [gx, gz] of terrain.landCells) {
    const k = gx + gz * size;
    const h = terrain.heightAt(gx, gz);
    const [wx, wz] = terrain.cellWorld(gx, gz);
    if (h < 0.45 || terrain.isBeach(gx, gz)) {
      if (h >= 0.05 && rng.chance(0.1)) rocks.push([wx + rng.range(-0.3, 0.3), wz + rng.range(-0.3, 0.3), rng.range(0.4, 0.9)]);
      continue;
    }
    if (cleared.has(k)) continue;
    if (terrain.slope(gx, gz) > 1.3 || h > 5.0) {
      if (rng.chance(0.3)) {
        rocks.push([wx + rng.range(-0.3, 0.3), wz + rng.range(-0.3, 0.3), rng.range(0.6, 1.6)]);
        // In the lee of a boulder, which is where one grows: sheltered from the wind and
        // never ploughed. Anything past this point is already known not to be `cleared`,
        // so no bush can land on a field, a lane or a plot.
        if (bush && bushes.length < BUSH_CAP && bushRng.chance(0.3)) {
          bushes.push([wx + bushRng.range(-0.34, 0.34), wz + bushRng.range(-0.34, 0.34), bushRng.range(0.7, 1.25)]);
        }
      }
      continue;
    }
    let n = stems(gx, gz, wx, wz);
    if (rng.chance(0.5)) tufts.push([wx + rng.range(-0.45, 0.45), wz + rng.range(-0.45, 0.45), rng.range(0.7, 1.3)]);
    // Undergrowth where the canopy noise is not quite a wood. A cell that grows a tree
    // does not also grow a bush: a stem is already the thing you look at there, and the
    // bush would be under it and invisible from anywhere but inside the branches.
    if (bush && !n && bushes.length < BUSH_CAP) {
      const dens = density(gx, gz, wx, wz);
      if (dens >= BUSH_LO && dens < BUSH_HI && bushRng.chance(0.5)) {
        bushes.push([wx + bushRng.range(-0.4, 0.4), wz + bushRng.range(-0.4, 0.4), bushRng.range(0.65, 1.3)]);
      }
    }
    if (thin < 1) {
      // Stochastic rounding on a spatial hash: the expected count is exactly `n * thin`,
      // and it is the same on every reload and the same for every viewer.
      const want = n * thin;
      n = Math.floor(want);
      if ((hash32(`thin:${gx},${gz}`) % 1000) / 1000 < want - n) n += 1;
    }
    if (!n) continue;
    const highland = h > 3.0;
    for (let t = 0; t < n; t++) {
      const x = wx + rng.range(-0.38, 0.38), z = wz + rng.range(-0.38, 0.38);
      // A wider spread of sizes than the old 0.6-0.98, which put every tree within a
      // third of every other and gave the canopy a mown look from the air. One draw
      // either way, so the forest stands where it stood - only the heights change.
      const item = { x, z, s: rng.range(0.55, 1.15), rot: rng.range(0, 6.283), cell: k, kind: highland || rng.chance(0.45) ? 'pine' : 'oak' };
      (item.kind === 'pine' ? pines : oaks).push(item);
      trees.push(item);
      if (!treeCells.has(k)) treeCells.set(k, []);
      treeCells.get(k).push(item);
    }
  }

  const orchard = orchardTrees(fieldPlan, terrain);
  const ORCHARD_CAP = 1500;
  const pineMesh = new THREE.InstancedMesh(pine.geo, pine.mats, Math.max(1, pines.length));
  const oakMesh = new THREE.InstancedMesh(oak.geo, oak.mats, Math.max(1, oaks.length));
  const rockMesh = new THREE.InstancedMesh(rock.geo, rock.mats, Math.max(1, rocks.length));
  const grassMesh = new THREE.InstancedMesh(grass.geo, grassMat, Math.max(1, tufts.length));
  const orchardMesh = new THREE.InstancedMesh(oak.geo, oak.mats, ORCHARD_CAP);
  for (const m of [pineMesh, oakMesh, rockMesh, orchardMesh]) { m.castShadow = true; m.receiveShadow = true; }
  // A tuft of grass is two hand spans high and its shadow would be a smudge under
  // itself, which is not worth walking twelve thousand instances through the depth pass
  // for. A bush is knee high and casts the contact shadow that stops it looking pasted
  // onto the grass, so that one does.
  grassMesh.castShadow = false;
  group.add(pineMesh, oakMesh, rockMesh, grassMesh, orchardMesh);

  // The seventh and eighth: undergrowth, and the shelf along the waterline. Both only
  // exist when the flora set has been baked - see `plant()` - and both are left out of
  // the scene entirely when it has not, rather than added empty.
  const bushMesh = bush ? new THREE.InstancedMesh(bush.geo, bush.mats, Math.max(1, bushes.length)) : null;
  const slabMesh = slab ? new THREE.InstancedMesh(slab.geo, slab.mats, Math.max(1, terrain.coastCells.length)) : null;
  for (const m of [bushMesh, slabMesh]) {
    if (!m) continue;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }

  // Planted rather than scattered: a grid, one size, barely any rotation.
  function placeOrchard(list, seasonName) {
    orchardMesh.count = Math.min(ORCHARD_CAP, list.length);
    const autumn = seasonName === 'autumn';
    for (let i = 0; i < orchardMesh.count; i++) {
      const [x, z, sc] = list[i];
      tmpObj.position.set(x, terrain.worldHeight(x, z) - 0.02, z);
      tmpObj.rotation.set(0, ((hash32(`o${x},${z}`) % 12) / 12) * 0.5, 0);
      tmpObj.scale.set(sc, sc * 1.05, sc);
      tmpObj.updateMatrix();
      orchardMesh.setMatrixAt(i, tmpObj.matrix);
      const tint = autumn ? 0xd7a24a : 0x6fae4a;
      orchardMesh.setColorAt(i, tmpColor.setHex(tint).multiplyScalar(0.9 + ((hash32(`t${x},${z}`) % 20) / 100)));
    }
    orchardMesh.instanceMatrix.needsUpdate = true;
    if (orchardMesh.instanceColor) orchardMesh.instanceColor.needsUpdate = true;
  }
  placeOrchard(orchard, season);

  function placeTrees(list, mesh, seasonName) {
    const autumn = seasonName === 'autumn';
    const mul = SEASON[seasonName].canopyMul;
    list.forEach((it, i) => {
      it.mesh = mesh; it.index = i; it.scale = it.s;
      tmpObj.position.set(it.x, terrain.worldHeight(it.x, it.z) - 0.05, it.z);
      tmpObj.rotation.set(0, it.rot, 0);
      tmpObj.scale.setScalar(it.s);
      tmpObj.updateMatrix();
      mesh.setMatrixAt(i, tmpObj.matrix);
      let tint = 0.86 + ((hash32(i + ':' + it.x) % 100) / 100) * 0.3;
      tmpColor.setScalar(tint * mul);
      if (autumn && mesh === oakMesh && (hash32('a' + i) % 100) < 42) {
        tmpColor.setHex((hash32('b' + i) % 2) ? 0xd68a3a : 0xc9553a).multiplyScalar(1.05);
      }
      mesh.setColorAt(i, tmpColor);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  placeTrees(pines, pineMesh, season);
  placeTrees(oaks, oakMesh, season);
  rocks.forEach((r, i) => {
    tmpObj.position.set(r[0], terrain.worldHeight(r[0], r[1]) - 0.04, r[1]);
    tmpObj.rotation.set(rng.range(0, 1), rng.range(0, 6.28), rng.range(0, 1));
    tmpObj.scale.setScalar(r[2]);
    tmpObj.updateMatrix();
    rockMesh.setMatrixAt(i, tmpObj.matrix);
    rockMesh.setColorAt(i, tmpColor.setScalar(0.85 + ((hash32('r' + i) % 100) / 100) * 0.3));
  });
  rockMesh.instanceMatrix.needsUpdate = true;
  tufts.forEach((g, i) => {
    tmpObj.position.set(g[0], terrain.worldHeight(g[0], g[1]) - 0.02, g[1]);
    tmpObj.rotation.set(0, hash32('g' + i) % 6, 0);
    tmpObj.scale.set(g[2], g[2] * 1.2, g[2]);
    tmpObj.updateMatrix();
    grassMesh.setMatrixAt(i, tmpObj.matrix);
    grassMesh.setColorAt(i, tmpColor.setScalar(0.8 + ((hash32('h' + i) % 100) / 100) * 0.4));
  });
  grassMesh.instanceMatrix.needsUpdate = true;

  // The undergrowth. Turned and sized off its own hash rather than off `rng`, the way
  // the orchard is: everything below this point in the function runs after the last tree
  // has been decided, but a hash keeps it that way even if something is inserted above.
  function placeBushes(seasonName) {
    if (!bushMesh) return;
    const mul = SEASON[seasonName].canopyMul;
    bushMesh.count = Math.max(1, bushes.length);
    bushes.forEach((b, i) => {
      tmpObj.position.set(b[0], terrain.worldHeight(b[0], b[1]) - 0.04, b[1]);
      tmpObj.rotation.set(0, ((hash32(`bu${i}`) % 64) / 64) * 6.283, 0);
      // Wider than tall by a little, and never the same twice: a bush is a spreading
      // thing and a row of identical hemispheres is the one way to make it look planted.
      const s = b[2];
      tmpObj.scale.set(s * (0.94 + (hash32(`bw${i}`) % 22) / 100), s * (0.8 + (hash32(`bh${i}`) % 30) / 100), s);
      tmpObj.updateMatrix();
      bushMesh.setMatrixAt(i, tmpObj.matrix);
      bushMesh.setColorAt(i, tmpColor.setScalar((0.82 + ((hash32(`bc${i}`) % 100) / 100) * 0.32) * mul));
    });
    bushMesh.instanceMatrix.needsUpdate = true;
    if (bushMesh.instanceColor) bushMesh.instanceColor.needsUpdate = true;
  }
  placeBushes(season);

  // The shelf along the waterline. Not on every cell of the coast: a plate on all of
  // them is a kerb round the island, and what the shore wants is a broken line with sand
  // showing through the gaps. Which cells get one is the cell's own hash, so the same
  // headland is rocky for every viewer and stays rocky across a reload.
  const COAST_FILL = 0.62;
  if (slabMesh) {
    let i = 0;
    for (const [gx, gz] of terrain.coastCells) {
      if ((hash32(`coast:${gx},${gz}`) % 100) / 100 >= COAST_FILL) continue;
      const [wx, wz] = terrain.cellWorld(gx, gz);
      const jx = ((hash32(`cx:${gx},${gz}`) % 100) / 100 - 0.5) * 0.7;
      const jz = ((hash32(`cz:${gx},${gz}`) % 100) / 100 - 0.5) * 0.7;
      // Sunk further than a boulder is. A shelf is bedrock the sea has worn down to the
      // waterline, not a stone dropped on the sand, so it wants its edge in the ground.
      tmpObj.position.set(wx + jx, terrain.worldHeight(wx + jx, wz + jz) - 0.09, wz + jz);
      tmpObj.rotation.set(0, ((hash32(`cr:${gx},${gz}`) % 64) / 64) * 6.283, 0);
      const s = 0.7 + (hash32(`cs:${gx},${gz}`) % 90) / 100;
      tmpObj.scale.set(s, s * (0.7 + (hash32(`ct:${gx},${gz}`) % 60) / 100), s);
      tmpObj.updateMatrix();
      slabMesh.setMatrixAt(i, tmpObj.matrix);
      slabMesh.setColorAt(i, tmpColor.setScalar(0.8 + ((hash32(`cc:${gx},${gz}`) % 100) / 100) * 0.34));
      i++;
    }
    slabMesh.count = Math.max(1, i);
    slabMesh.instanceMatrix.needsUpdate = true;
    if (slabMesh.instanceColor) slabMesh.instanceColor.needsUpdate = true;
  }

  // ---- paths and worn yards, painted into the terrain -----------------------
  // A single coverage texture joins every sandy surface. It uses the terrain's
  // own normals, lighting and shadows: no raised strips and no colour-matched
  // skirts that turn into visible borders when the grass texture arrives.
  const NO_WEAR = new Set(['bench', 'lamp', 'planter', 'terrace', 'tables', 'board', 'issues',
    'statue', 'well', 'fountain', 'watertower']);
  let wearVillage = village, wearGraph = null;
  let frontages = new Map(), frontageKey = '';
  function setHouseFrontages(records) {
    const entries = [...records].filter(r=>r.spec.kind==='house' || (r.spec.kind==='civic' && r.spec.plot?.w===3)).map(r=>
      [r.id, {x:r.group.position.x,z:r.group.position.z,yaw:r.group.rotation.y}]);
    const key=JSON.stringify(entries);
    if(key===frontageKey)return;
    frontageKey=key;frontages=new Map(entries);buildGroundWear();
  }
  function buildGroundWear() {
    if (!wearGraph) return;
    const centre = (c) => terrain.cellWorld(c[0], c[1]);
    const strokes = [], yards = [];
    for (const chain of wearGraph.chains) {
      const line = [centre(chain.from), ...chain.run.map(centre)];
      if (chain.to) line.push(centre(chain.to));
      strokes.push({ points: smoothLane(line, .18) });
    }
    for (const tile of wearGraph.tiles) {
      if (tile.kind === 'plaza') continue;
      const at = centre([tile.gx, tile.gz]);
      strokes.push({ points: [at] });
      // Adjacent junctions have no chain between them. These short connectors
      // also carry sand right up to the edge of the square.
      for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        if (tile.gx+dx >= 0 && tile.gx+dx < size && tile.gz+dz >= 0 && tile.gz+dz < size
          && wearGraph.kind.has(tile.gx+dx+(tile.gz+dz)*size))
          strokes.push({ points: [at, centre([tile.gx+dx,tile.gz+dz])] });
      }
    }
    for (const b of wearVillage.buildings || []) {
      if (!b.plot || b.harbour || (b.kind === 'civic' && NO_WEAR.has(b.civicType))) continue;
      const p = b.plot;
      const at = frontages.get(b.id);
      const [x,z] = at ? [at.x,at.z] : centre([p.gx+(p.w-1)/2,p.gz+(p.d-1)/2]);
      yards.push({x,z,rx:Math.max(.38,p.w/2-.35),rz:Math.max(.38,p.d/2-.35)});
      if (b.door) {
        const points=[[x,z]];
        if(at)points.push([x+Math.sin(at.yaw)*.9,z+Math.cos(at.yaw)*.9]);
        points.push(centre(b.door));
        strokes.push({ points: smoothLane(points,.18), radius:.34, feather:.42 });
      }
    }
    const field = groundWearField(size, wearVillage.seed || 0, strokes, yards, wearResolution);
    const plazaYards = wearGraph.tiles.filter(t=>t.kind==='plaza').map(t=>{
      const [x,z]=centre([t.gx,t.gz]);return {x,z,rx:.84,rz:.84};
    });
    const plaza = groundWearField(size, wearVillage.seed || 0, [], plazaYards, wearResolution);
    for(let i=0;i<field.data.length;i++)field.data[i]=Math.max(field.data[i],plaza.data[i]);
    plazaTexture.image.data=plaza.data;plazaTexture.needsUpdate=true;
    wearTexture.image.data = field.data;
    wearTexture.needsUpdate = true;
  }


  function squareCells(v) {
    const out = [], town = v.island && v.island.town;
    if (town?.paved) out.push(...town.paved);
    else if (town?.square) {
      const n=town.size || 3;
      for(let z=0;z<n;z++)for(let x=0;x<n;x++)out.push([town.square[0]+x,town.square[1]+z]);
    }
    for(const d of v.districts || [])for(const c of d.paved || [])out.push(c);
    return out;
  }
  function buildPaths(paths, squares = squareCells(wearVillage)) {
    wearGraph=roadGraph(paths,squares,size);
    buildGroundWear();
  }
  buildPaths(village.paths);

  // ---- riverbanks ----------------------------------------------------------
  // Shingle is painted into the terrain above, along with the paths and yards. Only the
  // reeds need geometry of their own here. Keeping them separate stops a texture meant
  // for stones from being stretched over every blade.
  function buildRiverReeds() {
    if (!terrain.riverBankCells || !terrain.riverBankCells.length) return null;
    const pos = [], col = [], idx = [];
    let v = 0;
    const tri = (a, b, c, hex) => {
      tmpColor.setHex(hex);
      for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); col.push(tmpColor.r, tmpColor.g, tmpColor.b); }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 1);      // both faces: a blade has no back
      v += 3;
    };
    for (const [gx, gz] of terrain.riverBankCells) {
      const [x, z] = terrain.cellWorld(gx, gz);
      const h = hash32(`bank:${gx},${gz}`);
      // Reeds only where the bank is close to the waterline; the top of a ravine is dry.
      if (terrain.worldHeight(x, z) > 0.9) continue;
      const clumps = 1 + (h % 3);
      for (let n = 0; n < clumps; n++) {
        const g = hash32(`reed:${gx},${gz},${n}`);
        const rx = x + ((g % 100) / 100 - 0.5) * 0.8;
        const rz = z + (((g >>> 7) % 100) / 100 - 0.5) * 0.8;
        const y = terrain.worldHeight(rx, rz);
        const tall = 0.3 + ((g >>> 14) % 100) / 400;
        const hue = (g >>> 21) & 1 ? 0x6f7f46 : 0x86924f;
        for (let b = 0; b < 3; b++) {
          const a = ((g >>> (b * 3)) % 8) / 8 * 6.2832;
          const lx = Math.cos(a) * 0.13, lz = Math.sin(a) * 0.13;
          tri([rx - 0.035, y, rz], [rx + 0.035, y, rz], [rx + lx, y + tall, rz + lz], hue);
        }
      }
    }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  {
    const bg = buildRiverReeds();
    if (bg) {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
      mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
      const bm = new THREE.Mesh(bg, mat);
      bm.receiveShadow = true;
      group.add(bm);
    }
  }

  // ---- boundaries and fields -----------------------------------------------
  let borderMesh = null, fieldMesh = null;
  const groundMat = () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });

  function buildHamletDressing(v, seasonName) {
    if (borderMesh) { group.remove(borderMesh); borderMesh.geometry.dispose(); borderMesh.material.dispose(); borderMesh = null; }
    if (fieldMesh) { group.remove(fieldMesh); fieldMesh.geometry.dispose(); fieldMesh.material.dispose(); fieldMesh = null; }

    // A boundary opens where a road crosses it, and the road set is the one the settlers
    // already walk on, so no extra data is needed to know where the gates are. The field
    // plan goes in with it: a parcel is fenced and gated by the same pass, out of the
    // same merged geometry, for no extra draw call.
    const bg = buildBorders(v, terrain, own.owner, roads, fieldPlan);
    if (bg) {
      // Rail, palings, hedge and wall all come back welded into one geometry, so the sheet
      // cannot be chosen per mesh: hamlets.js writes which one each vertex wants and its own
      // material reads that, projecting from three axes so nothing needs a UV. It dresses
      // itself when the sheets land, and draws the flat colours until they do.
      borderMesh = new THREE.Mesh(bg, createBoundaryMaterial());
      borderMesh.castShadow = true;
      borderMesh.receiveShadow = true;
      group.add(borderMesh);
    }
    // The hues go in with it: every parcel knows which hamlet works it, and a field that
    // carries a breath of its owner's colour tells two estates apart where their
    // headlands meet - the same trick the meadow under them already plays.
    const fg = buildFieldDecals(fieldPlan, terrain, seasonName, hues);
    if (fg) {
      const mat = groundMat();
      mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
      // The fields are drawn here but dressed there: hamlets.js hands back bare geometry
      // and owns the ploughed-soil sheet, so it is the only place that knows the tiling
      // and the brightness the sheet has to be corrected for. It handles the wait itself -
      // a sheet that lands after this material was made still reaches it.
      dressFieldMaterial(mat);
      fieldMesh = new THREE.Mesh(fg, mat);
      fieldMesh.receiveShadow = true;
      group.add(fieldMesh);
    }
  }
  buildHamletDressing(village, season);

  // The land register changed: a parcel grew, a hamlet was founded, a boundary moved out.
  function setOwnership(v, seasonName = currentSeason) {
    own = decodeOwnership(v, size);
    hues = v.districts.map((d) => d.hue);
    clearedBase = baseCleared(v);
    wallVerge(own.owner, clearedBase);
    roads = roadSet(v);
    settled = settledDistance(terrain, own.owner, roads);
    fieldPlan = planFields(v, terrain, own.owner, clearedBase, { ...fieldOpts(v), settled, paved: roads });
    for (const p of [...fieldPlan.patches, ...fieldPlan.orchards, ...fieldPlan.gardens]) {
      for (const [gx, gz] of p.cells) cleared.add(gx + gz * size);
    }
    wallVerge(own.owner, cleared);
    computeTint(own.owner, own.inset, hues);
    paintGround(seasonName);
    placeOrchard(orchardTrees(fieldPlan, terrain), seasonName);
    buildHamletDressing(v, seasonName);
    // A new house has a new yard, and every yard's feather is the colour of the ground
    // `paintGround` has just rewritten - so this goes after both, not before either.
    wearVillage = v;
    buildGroundWear();
  }

  // ---- clouds --------------------------------------------------------------
  // Nine clouds, each a handful of squashed icosahedra. They used to be some 34 separate
  // meshes, and every one cost a draw call in the colour pass and another in the shadow
  // pass. One InstancedMesh over a unit icosahedron draws the whole layer in two: each
  // puff is an instance whose matrix carries its radius, its squash and its place in the
  // cloud. The random draws happen in the same order as before, so the clouds look the
  // same and the fireflies further down still land where they did.
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xfbfbf7, flatShading: true, roughness: 1 });
  const cloudGeo = new THREE.IcosahedronGeometry(1, 0);
  const cloudPuffs = []; // one per instance: which cloud it belongs to, its offset and its size
  const cloudDrift = []; // one per cloud: where it is and how fast it drifts
  for (let i = 0; i < 9; i++) {
    const parts = 3 + rng.int(3);
    for (let k = 0; k < parts; k++) {
      const r = rng.range(1.6, 3.2);
      const ox = rng.range(-3, 3), oy = rng.range(-0.4, 0.4), oz = rng.range(-2, 2);
      const squash = rng.range(0.4, 0.6);
      cloudPuffs.push({ cloud: i, ox, oy, oz, sx: r, sy: r * squash, sz: r });
    }
    cloudDrift.push({ x: rng.range(-70, 70), y: rng.range(24, 33), z: rng.range(-70, 70), speed: rng.range(0.35, 0.75) });
  }
  const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, cloudPuffs.length);
  clouds.castShadow = true;
  // The instances drift and wrap around the island, so a bounding sphere taken at boot
  // would go stale and cull clouds that are plainly in view. The layer is always in
  // sight anyway, like the sky and the fireflies.
  clouds.frustumCulled = false;
  function placeClouds() {
    for (let i = 0; i < cloudPuffs.length; i++) {
      const p = cloudPuffs[i], c = cloudDrift[p.cloud];
      tmpObj.position.set(c.x + p.ox, c.y + p.oy, c.z + p.oz);
      tmpObj.rotation.set(0, 0, 0);
      tmpObj.scale.set(p.sx, p.sy, p.sz);
      tmpObj.updateMatrix();
      clouds.setMatrixAt(i, tmpObj.matrix);
    }
    clouds.instanceMatrix.needsUpdate = true;
  }
  placeClouds();
  group.add(clouds);

  // ---- fireflies -----------------------------------------------------------
  // Fireflies gather near the lake and along the edge of the forest, not out at sea.
  const nearWater = terrain.landCells.filter(([gx, gz]) => {
    const [x, z] = terrain.cellWorld(gx, gz);
    const dl = Math.hypot(x - terrain.lakeCentre[0], z - terrain.lakeCentre[1]);
    return dl < 9 || (terrain.heightAt(gx, gz) > 0.6 && terrain.heightAt(gx, gz) < 2.6);
  });
  const pool = nearWater.length > 40 ? nearWater : terrain.landCells;
  const FF = 190;
  const ffPos = new Float32Array(FF * 3);
  const ffCol = new Float32Array(FF * 3);
  const ffBase = [];
  for (let i = 0; i < FF; i++) {
    const c = pool[rng.int(pool.length)];
    const [x, z] = terrain.cellWorld(c[0], c[1]);
    const bx = x + rng.range(-0.5, 0.5), bz = z + rng.range(-0.5, 0.5);
    ffBase.push({ x: bx, z: bz, y: terrain.worldHeight(bx, bz) + rng.range(0.35, 1.1), ph: rng.range(0, 6.28) });
    ffPos[i * 3] = bx; ffPos[i * 3 + 1] = ffBase[i].y; ffPos[i * 3 + 2] = bz;
  }
  const ffGeo = new THREE.BufferGeometry();
  ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPos, 3));
  ffGeo.setAttribute('color', new THREE.BufferAttribute(ffCol, 3));
  const fireflies = new THREE.Points(ffGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexColors: true,
    uniforms: { uScale: { value: window.innerHeight * 0.5 } },
    vertexShader: `varying vec3 vC; uniform float uScale;
      void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = 0.13 * uScale / max(0.001, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vC;
      void main(){ float d = length(gl_PointCoord - 0.5);
        float m = smoothstep(0.5, 0.0, d); if (m <= 0.01) discard;
        gl_FragColor = vec4(vC, m * m); }`,
  }));
  fireflies.frustumCulled = false;
  fireflies.renderOrder = 2;
  group.add(fireflies);

  // ---- update --------------------------------------------------------------
  let time = 0;
  let currentSeason = season;
  const state = { night: 0, fire: 0, sun: new THREE.Vector3() };
  // The shadow frustum follows what you are looking at, and now also how far away you are
  // standing: anchored and fixed it covered 84 units of a 234-unit island, so from the
  // boot camera most of the coast cast nothing at all. Following the target alone was not
  // enough, because the whole point of pulling back is to see all of it at once. So the
  // half-width comes from the camera distance - and only the half-width, so zoomed in you
  // keep today's 24 shadow-map pixels per unit and today's crisp eaves.
  //
  // The light rides out with it. It sat a flat 90 units up the sun ray, which is fine for
  // a 42-unit frustum but puts everything on the sunward half of a 130-unit one *behind*
  // the lamp, where the shadow camera cannot see it - the coast would have gone dark-free
  // again for a subtler reason. Near and far follow for the same reason, and because a
  // depth range no wider than it needs to be is what keeps `shadow.bias` honest: tight
  // when you are close, which is exactly when a millimetre of peter-panning shows.
  const shadowFocus = new THREE.Vector3();
  let shadowSpan = SHADOW_SPAN[0];
  let lightRange = shadowSpan + 60;
  const followShadow = (x, z, dist) => {
    shadowFocus.set(x, 0, z);
    if (!(dist > 0)) return;
    const f = clamp(dist * SHADOW_OF_DIST, SHADOW_SPAN[0], SHADOW_SPAN[1]);
    if (Math.abs(f - shadowSpan) < 0.5) return;   // a matrix rebuild per frame of zoom, not per frame
    shadowSpan = f;
    lightRange = f + 60;
    const cam = key.shadow.camera;
    cam.left = -f; cam.right = f; cam.top = f; cam.bottom = -f;
    cam.near = 10; cam.far = 2 * f + 90;
    cam.updateProjectionMatrix();
  };

  function update(dt, hour, month) {
    time += dt;
    const d = dayAt(hour);
    const dir = sunDirection(hour);
    state.sun.copy(dir);
    state.night = d.night;

    key.target.position.lerp(shadowFocus, Math.min(1, dt * 4));
    key.position.copy(key.target.position).addScaledVector(dir, lightRange);
    key.color.copy(d.key);
    key.intensity = d.int;
    hemi.color.copy(d.sky); hemi.groundColor.copy(d.ground);
    hemi.intensity = lerp(0.5, 0.9, 1 - d.night);
    ambient.intensity = d.amb + d.night * 0.09;

    skyMat.uniforms.uTop.value.copy(d.top);
    skyMat.uniforms.uHor.value.copy(d.hor);
    skyMat.uniforms.uSunDir.value.copy(dir);
    skyMat.uniforms.uSunColor.value.copy(d.key);
    skyMat.uniforms.uStars.value = d.stars;
    // The haze is the horizon seen through more of itself, with a quarter of the sky's own
    // blue mixed back in. Less of that blue than before and a breath of the sun's colour
    // on top, so the far coast goes gold in the afternoon instead of grey-blue - the
    // distance in the reference picture is warm, not cold. Distances: see main.js.
    scene.fog.color.copy(d.hor).lerp(d.top, 0.15).lerp(d.key, 0.12);

    waterMat.uniforms.uTime.value = time;
    waterMat.uniforms.uSunDir.value.copy(dir);
    waterMat.uniforms.uSunColor.value.copy(d.key);
    waterMat.uniforms.uNight.value = d.night;
    // The open sea used to be a plain colour that had to be dimmed by hand to follow the
    // rest of the water into the evening. It shares these uniforms now, so it darkens on
    // its own - one nightfall over the whole sea rather than two kept in step.

    const isDay = hour >= 6 && hour <= 18;
    sunDisc.visible = isDay; moonDisc.visible = !isDay;
    (isDay ? sunDisc : moonDisc).position.copy(dir).multiplyScalar(430);

    for (const c of cloudDrift) {
      c.x += c.speed * dt;
      if (c.x > 90) c.x = -90;
    }
    placeClouds();

    fireflies.visible = d.fire > 0.02;
    if (fireflies.visible) {
      const arr = ffGeo.attributes.position.array, ca = ffGeo.attributes.color.array;
      for (let i = 0; i < FF; i++) {
        const b = ffBase[i];
        arr[i * 3] = b.x + 0.2 * Math.sin(time * 0.7 + b.ph);
        arr[i * 3 + 1] = b.y + 0.25 * Math.sin(time * 1.3 + b.ph * 1.7);
        arr[i * 3 + 2] = b.z + 0.2 * Math.cos(time * 0.6 + b.ph * 0.7);
        const g = (0.3 + 0.7 * Math.max(0, Math.sin(time * 3 + b.ph))) * d.fire;
        ca[i * 3] = 1.0 * g; ca[i * 3 + 1] = 0.78 * g; ca[i * 3 + 2] = 0.22 * g;
      }
      ffGeo.attributes.position.needsUpdate = true;
      ffGeo.attributes.color.needsUpdate = true;
    }

    const s = seasonOf(month);
    if (s !== currentSeason) {
      currentSeason = s;
      paintGround(s);
      placeTrees(pines, pineMesh, s);
      placeTrees(oaks, oakMesh, s);
      placeBushes(s);
      placeOrchard(orchardTrees(fieldPlan, terrain), s);
      buildHamletDressing(village, s);      // ploughed earth in spring, stubble after the harvest
      buildGroundWear();                    // and the feather round a yard follows the meadow
    }
    // felling animation
    for (let i = falling.length - 1; i >= 0; i--) {
      const f = falling[i];
      f.t += dt;
      const k = clamp(f.t / 0.7, 0, 1);
      tmpObj.position.set(f.it.x, terrain.worldHeight(f.it.x, f.it.z) - 0.05, f.it.z);
      tmpObj.rotation.set(k * 1.4, f.it.rot, 0);
      tmpObj.scale.setScalar(f.it.s * (1 - k));
      tmpObj.updateMatrix();
      f.it.mesh.setMatrixAt(f.it.index, tmpObj.matrix);
      f.it.mesh.instanceMatrix.needsUpdate = true;
      if (k >= 1) falling.splice(i, 1);
    }
  }

  const falling = [];
  function fellTrees(cells, animate = true) {
    const out = [];
    for (const [gx, gz] of cells) {
      const list = treeCells.get(gx + gz * size);
      if (!list) continue;
      for (const it of list) {
        if (it.felled) continue;
        it.felled = true;
        out.push([it.x, it.z]);
        if (animate) falling.push({ it, t: 0 });
        else {
          tmpObj.position.set(0, -999, 0); tmpObj.scale.setScalar(0.0001); tmpObj.rotation.set(0, 0, 0); tmpObj.updateMatrix();
          it.mesh.setMatrixAt(it.index, tmpObj.matrix);
          it.mesh.instanceMatrix.needsUpdate = true;
        }
      }
      treeCells.delete(gx + gz * size);
    }
    return out;
  }
  // anything already cleared at load time is simply not planted, so nothing to do here

  // The coast of another moment. Polders are stamped into the heightfield rather than
  // drawn on top of it, so replaying the island's history means moving the ground
  // itself - there is no visibility flag that can put the sea back. Everything else is
  // already incremental: the colour attribute is written in place by `paintGround`, and
  // the scatter never touches a polder or its dike, so nothing is left hanging in the
  // air when the water returns.
  function reshape(next) {
    terrain = next;
    const pa = geo.attributes.position;
    for (let k = 0; k < N * N; k++) pa.array[k * 3 + 1] = terrain.H[k];
    pa.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    paintGround(currentSeason);
    // The decals stand on the heightfield, so a coast that has moved takes them with it.
    buildGroundWear();
    const wa = waterGeo.attributes.aDepth;
    for (let i = 0; i < wp.count; i++) {
      const x = wp.getX(i), z = wp.getZ(i);
      wa.array[i] = (Math.abs(x) > half || Math.abs(z) > half) ? -2.5 : terrain.worldHeight(x, z);
    }
    wa.needsUpdate = true;
  }

  return {
    group, ground, water, sky, key, hemi, ambient, clouds, fireflies, update, fellTrees,
    buildPaths, squareCells, setOwnership, setHouseFrontages, followShadow, ownership: () => own, state,
    season: () => currentSeason, reshape,
  };
}

// ---- the road, as a graph --------------------------------------------------
// Which cells of paving are a junction and which are a stretch of lane between two of
// them. Pure, and exported, because the one hard requirement on the drawing is measurable
// and tests/paths.test.mjs measures it: a settler walks from cell middle to cell middle
// and `gateOf` in main.js looks a road cell up by its middle, so wherever the paving ends
// up drawn it has to still be under those middles.
//
// A junction, a dead end and every cell of a plaza keep a tile of their own. The plaza is
// the interesting one: the corner cell of a five-by-five square has exactly two
// neighbours, so by degree alone it would be taken for a stretch of lane and the square
// would come out with a bite out of each corner.
const ROAD_N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function roadGraph(paths, squares, size) {
  const kind = new Map();
  const at = (gx, gz) => gx + gz * size;
  const inside = (gx, gz) => gx >= 0 && gz >= 0 && gx < size && gz < size;
  const put = (gx, gz, k) => { if (inside(gx, gz) && !kind.has(at(gx, gz))) kind.set(at(gx, gz), k); };
  for (const p of paths || []) {
    // Every route is trodden earth; only explicitly paved plaza cells are stone.
    const k = 'sand';
    for (const c of p.cells) put(c[0], c[1], k);
  }
  // The plaza wins where a path enters it, so sand never cuts stripes through its paving.
  const plaza = new Set();
  for (const c of squares || []) {
    if (!inside(c[0], c[1])) continue;
    plaza.add(at(c[0], c[1]));
    kind.set(at(c[0], c[1]), 'plaza');
  }
  const has = (gx, gz) => inside(gx, gz) && kind.has(at(gx, gz));
  const nbs = (gx, gz) => {
    const out = [];
    for (const [dx, dz] of ROAD_N4) if (has(gx + dx, gz + dz)) out.push([gx + dx, gz + dz]);
    return out;
  };
  const cells = [];
  for (const k of kind.keys()) cells.push([k % size, (k - (k % size)) / size]);

  const nodes = new Set();
  for (const [gx, gz] of cells) if (plaza.has(at(gx, gz)) || nbs(gx, gz).length !== 2) nodes.add(at(gx, gz));
  const isNode = (gx, gz) => nodes.has(at(gx, gz));

  const chains = [];
  const taken = new Set();
  const walk = (from, first) => {
    const run = [];
    let prev = from, cur = first;
    while (cur && !isNode(cur[0], cur[1]) && !taken.has(at(cur[0], cur[1]))) {
      run.push(cur);
      taken.add(at(cur[0], cur[1]));
      const next = nbs(cur[0], cur[1]).find((q) => q[0] !== prev[0] || q[1] !== prev[1]);
      prev = cur;
      cur = next;
    }
    if (!run.length) return;
    chains.push({ from, run, to: cur || null, kind: 'sand' });
  };
  for (const [gx, gz] of cells) {
    if (!isNode(gx, gz)) continue;
    for (const n of nbs(gx, gz)) if (!isNode(n[0], n[1]) && !taken.has(at(n[0], n[1]))) walk([gx, gz], n);
  }
  // A ring of degree-two cells has no junction to be cut at, so it is cut anywhere: the
  // cell we happen to reach first becomes a tile and the rest of the loop a lane that
  // starts and ends on it.
  for (const [gx, gz] of cells) {
    if (isNode(gx, gz) || taken.has(at(gx, gz))) continue;
    nodes.add(at(gx, gz));
    for (const n of nbs(gx, gz)) if (!isNode(n[0], n[1]) && !taken.has(at(n[0], n[1]))) walk([gx, gz], n);
  }
  // Last, so that a cell promoted above still gets its tile.
  const tiles = [];
  for (const [gx, gz] of cells) {
    if (!isNode(gx, gz)) continue;
    tiles.push({
      gx, gz, kind: kind.get(at(gx, gz)),
      west: has(gx - 1, gz), east: has(gx + 1, gz), north: has(gx, gz - 1), south: has(gx, gz + 1),
    });
  }
  return { cells, kind, tiles, chains };
}

// A chain of cell middles, turned into a curve. The straights stay straight and every
// corner is replaced by a circular fillet tangent to both legs.
//
// A fillet rather than a spline, and that is the whole of the argument. Chaikin or
// Catmull-Rom would be shorter, but neither can promise how far it wanders from the points
// it was built from, and here that promise is the requirement: two passes of Chaikin cut a
// single right angle by 0.177, which fits inside 0.18, and a staircase of right angles by
// twice as much, which does not - and a staircase is exactly what a meandering router
// produces. A fillet's depth is arithmetic: for an interior angle a and radius r it is
// r (1/sin(a/2) - 1), so the radius can be solved for the depth that is allowed. The
// bound then holds at every corner on the island by construction rather than by
// measurement, and the radius is capped at half of the shorter leg so two fillets on
// neighbouring corners never eat into each other.
export function smoothLane(pts, maxDev, arcStep = 0.5) {
  if (pts.length < 3) return pts.slice();
  const leg = (p, v) => {
    const x = p[0] - v[0], z = p[1] - v[1];
    const len = Math.hypot(x, z) || 1;
    return { x: x / len, z: z / len, len };
  };
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const v = pts[i];
    const a = leg(pts[i - 1], v), b = leg(pts[i + 1], v);
    const angle = Math.acos(clamp(a.x * b.x + a.z * b.z, -1, 1));
    if (angle > Math.PI - 0.02) { out.push(v); continue; }       // straight: nothing to cut
    const h = angle / 2;
    const r = Math.min(maxDev / (1 / Math.sin(h) - 1), Math.min(a.len, b.len) * 0.5 * Math.tan(h));
    const t = r / Math.tan(h);
    const bl = Math.hypot(a.x + b.x, a.z + b.z) || 1;
    const cx = v[0] + ((a.x + b.x) / bl) * (r / Math.sin(h));
    const cz = v[1] + ((a.z + b.z) / bl) * (r / Math.sin(h));
    const a0 = Math.atan2(v[1] + a.z * t - cz, v[0] + a.x * t - cx);
    let d = Math.atan2(v[1] + b.z * t - cz, v[0] + b.x * t - cx) - a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const seg = Math.max(1, Math.ceil(Math.abs(d) / arcStep));
    for (let k = 0; k <= seg; k++) {
      const ang = a0 + (d * k) / seg;
      out.push([cx + Math.cos(ang) * r, cz + Math.sin(ang) * r]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// How far the furthest of `pts` ends up from the polyline `curve`. The measurement the
// bound above is stated in, and the reason `smoothLane` is a separate function at all.
export function offCurve(pts, curve) {
  let worst = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < curve.length; i++) {
      const [ax, az] = curve[i], [bx, bz] = curve[i + 1];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 ? clamp(((p[0] - ax) * dx + (p[1] - az) * dz) / l2, 0, 1) : 0;
      best = Math.min(best, Math.hypot(p[0] - (ax + dx * t), p[1] - (az + dz * t)));
    }
    if (best > worst) worst = best;
  }
  return worst;
}

// ---- tiny geometry helpers (vertex-coloured, flat shaded) -----------------
function paint(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  // The UV stays: three's own cylinder and cone wrap sensibly, which is all a trunk or a
  // cone of needles needs. (The normal goes because merge() recomputes it flat.)
  g.deleteAttribute('normal');
  return g;
}
function cyl(rt, rb, h, seg, hex, y) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.translate(0, y, 0);
  return paint(g, hex);
}
function cone(r, h, seg, hex, y) {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(0, y + h / 2, 0);
  return paint(g, hex);
}
function ico(r, hex, y, sy) {
  const g = new THREE.IcosahedronGeometry(r, 0);
  g.scale(1, sy || 1, 1);
  g.translate(0, y, 0);
  return paint(g, hex);
}
function dodeca(r, hex, y) {
  const g = new THREE.DodecahedronGeometry(r, 0);
  g.translate(0, y, 0);
  return paint(g, hex);
}
function merge(geos, groups = false) {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = mergeGeometries(flat, groups);
  out.computeVertexNormals();
  return out;
}
