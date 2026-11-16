import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export interface SpriteAlignment {
  tx: string;
  ty: string;
  scale: number;
}

export interface Pokemon3DPokeballRevealProps {
  /** Whether the reveal sequence is active / visible */
  active?: boolean;
  /** National Pokédex ID for sprite lookup */
  pokemonId: number | string | undefined;
  /** Display / speech name */
  pokemonName?: string;
  /** Increment to replay the 3D Pokéball drop -> open -> Pokémon reveal animation */
  revealKey?: number;
  /** Optional hook called on Pokéball bounce impacts (intensity 0..1) */
  onDropImpact?: (volume: number) => void;
  /** Optional hook called the instant the 3D Pokéball hinges open */
  onBallOpen?: () => void;
  /** Optional hook called when the Pokémon silhouette begins emerging */
  onPokemonEmerge?: () => void;
  /** Force official-artwork yellow-glow fallback sprite (for testing/preview) */
  forceFallbackGlow?: boolean;
  /** Enable built-in Web Audio SFX if external audio callbacks are not provided */
  useBuiltInSfx?: boolean;
}

const DEFAULT_PRIMARY_ALIGNMENT: SpriteAlignment = { tx: '0%', ty: '12%', scale: 1 };
const DEFAULT_FALLBACK_ALIGNMENT: SpriteAlignment = { tx: '0%', ty: '7%', scale: 1 };
const spriteAlignmentCache = new Map<string, SpriteAlignment>();

export function getPokemon3DArtworkUrl(pokemonId: number | string | undefined): string {
  const id = Number(pokemonId);
  if (!id || Number.isNaN(id)) return '';
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-ix/scarlet-violet/${id}.webp`;
}

export function getPokemon3DFallbackArtworkUrl(_pokemonId: number | string | undefined): string {
  return '';
}

function clampNum(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function measureSpriteAlignment(
  img: HTMLImageElement,
  src: string,
  isFallback: boolean
): SpriteAlignment {
  const cached = spriteAlignmentCache.get(src);
  if (cached) return cached;

  const fallback = isFallback ? DEFAULT_FALLBACK_ALIGNMENT : DEFAULT_PRIMARY_ALIGNMENT;
  try {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return fallback;

    const S = 96;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return fallback;

    ctx.clearRect(0, 0, S, S);
    const scaleDraw = Math.min(S / w, S / h);
    const dw = w * scaleDraw;
    const dh = h * scaleDraw;
    const dx = (S - dw) / 2;
    const dy = S - dh;
    ctx.drawImage(img, dx, dy, dw, dh);

    const data = ctx.getImageData(0, 0, S, S).data;
    let minX = S;
    let maxX = -1;
    let minY = S;
    let maxY = -1;

    for (let y = 0; y < S; y++) {
      const rowOffset = y * S * 4;
      for (let x = 0; x < S; x++) {
        if (data[rowOffset + x * 4 + 3] > 36) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) return fallback;

    // Measure horizontal center of bottom 25% (feet/base) so wide tails don't off-center it
    const spriteH = Math.max(1, maxY - minY + 1);
    const baseTop = Math.max(minY, Math.floor(maxY - spriteH * 0.25));
    let baseMinX = S;
    let baseMaxX = -1;
    for (let y = baseTop; y <= maxY; y++) {
      const rowOffset = y * S * 4;
      for (let x = minX; x <= maxX; x++) {
        if (data[rowOffset + x * 4 + 3] > 36) {
          if (x < baseMinX) baseMinX = x;
          if (x > baseMaxX) baseMaxX = x;
        }
      }
    }

    const baseCenterFrac =
      baseMaxX >= baseMinX ? (baseMinX + baseMaxX) / (2 * S) : (minX + maxX) / (2 * S);
    const bottomGapFrac = (S - 1 - maxY) / S;

    const leftDist = Math.abs(minX / S - baseCenterFrac);
    const rightDist = Math.abs(maxX / S - baseCenterFrac);
    const symmetricWidthFrac = Math.max(leftDist, rightDist) * 2;
    const widthScale = symmetricWidthFrac > 0.84 ? 0.84 / symmetricWidthFrac : 1;
    const heightScale = spriteH / S > 0.90 ? 0.90 / (spriteH / S) : 1;
    const fitScale = clampNum(Math.min(1, widthScale, heightScale), 0.68, 1);

    const tyPct = clampNum((bottomGapFrac * fitScale - 0.01) * 100, -2, 26);
    const txPct = clampNum((0.5 - baseCenterFrac) * fitScale * 100, -18, 18);

    const alignment: SpriteAlignment = {
      tx: `${txPct.toFixed(2)}%`,
      ty: `${tyPct.toFixed(2)}%`,
      scale: Number(fitScale.toFixed(3)),
    };
    spriteAlignmentCache.set(src, alignment);
    return alignment;
  } catch {
    return fallback;
  }
}

// ============================================================================
// Procedural Canvas Textures (Zero 404 external image dependencies for 3D scene)
// ============================================================================
function createRadialGlowTexture(
  stops: Array<[number, string]>,
  size = 256
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const cx = size / 2;
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    stops.forEach(([offset, color]) => grad.addColorStop(offset, color));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createBeamGradientTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, size, 0, 0);
    grad.addColorStop(0, 'rgba(255, 250, 220, 0.95)');
    grad.addColorStop(0.28, 'rgba(250, 204, 21, 0.55)');
    grad.addColorStop(0.62, 'rgba(96, 165, 250, 0.28)');
    grad.addColorStop(1, 'rgba(96, 165, 250, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createPedestalRingTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const c = size / 2;
    const bg = ctx.createRadialGradient(c, c, size * 0.05, c, c, size * 0.5);
    bg.addColorStop(0, '#0f172a');
    bg.addColorStop(0.65, '#091124');
    bg.addColorStop(1, '#040814');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    // Subtle concentric holographic tech ticks
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.28)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const r1 = i % 3 === 0 ? size * 0.36 : size * 0.39;
      const r2 = size * 0.43;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
      ctx.lineTo(c + Math.cos(a) * r2, c + Math.sin(a) * r2);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ============================================================================
// Optional Built-in Web Audio SFX for Standalone Use
// ============================================================================
let builtinAudioCtx: AudioContext | null = null;
function getBuiltinAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!builtinAudioCtx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    builtinAudioCtx = new Ctor();
  }
  if (builtinAudioCtx.state === 'suspended') {
    builtinAudioCtx.resume().catch(() => {});
  }
  return builtinAudioCtx;
}

function playBuiltinDrop(vol: number): void {
  const ctx = getBuiltinAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(135, now);
    osc.frequency.exponentialRampToValueAtTime(58, now + 0.16);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.18 * vol, now + 0.018);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.22);
  } catch {
    // ignore autoplay restriction
  }
}

function playBuiltinOpen(): void {
  const ctx = getBuiltinAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const click = ctx.createOscillator();
    const clickG = ctx.createGain();
    click.type = 'sine';
    click.frequency.setValueAtTime(760, now);
    click.frequency.exponentialRampToValueAtTime(320, now + 0.09);
    clickG.gain.setValueAtTime(0.0001, now);
    clickG.gain.exponentialRampToValueAtTime(0.12, now + 0.012);
    clickG.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
    click.connect(clickG);
    clickG.connect(ctx.destination);
    click.start(now);
    click.stop(now + 0.1);

    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const t = now + 0.14 + i * 0.07;
      osc.type = 'triangle';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    });
  } catch {
    // ignore autoplay restriction
  }
}

// ============================================================================
// Scoped CSS for the Pokémon emergence overlay synchronized to the 3D canvas
// ============================================================================
const STAGE_3D_STYLES = `
@keyframes pk3d-emerge {
  0% { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.06); }
  20% { opacity: 1; transform: translateX(-50%) translateY(-18px) scale(0.55); }
  62% { opacity: 1; transform: translateX(-50%) translateY(-24px) scale(1.1); }
  84% { opacity: 1; transform: translateX(-50%) translateY(3px) scale(0.98); }
  100% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}

@keyframes pk3d-sil-dissolve {
  0%, 38% { opacity: 1; }
  70% { opacity: 0.35; }
  100% { opacity: 0; }
}

@keyframes pk3d-float {
  0%, 100% {
    transform: translate(var(--pk-tx, 0%), var(--pk-ty, 10%))
      scaleX(calc(var(--pk-scale, 1) * 1.02))
      scaleY(calc(var(--pk-scale, 1) * 0.98));
  }
  50% {
    transform: translate(var(--pk-tx, 0%), var(--pk-ty, 10%))
      scaleX(calc(var(--pk-scale, 1) * 0.99))
      scaleY(calc(var(--pk-scale, 1) * 1.02));
  }
}

.pk3d-stage {
  position: relative;
  width: clamp(220px, 44vh, 320px);
  height: clamp(190px, 38vh, 285px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: visible;
  pointer-events: none;
}

.pk3d-canvas-host {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.pk3d-canvas-host canvas {
  display: block;
  width: 100% !important;
  height: 100% !important;
  pointer-events: none;
}

.pk3d-pop {
  position: absolute;
  left: 50%;
  bottom: var(--pk3d-anchor-bottom, 19%);
  width: var(--pk3d-sprite-size, min(168px, 24vh));
  height: var(--pk3d-sprite-size, min(168px, 24vh));
  transform: translateX(-50%) scale(0);
  transform-origin: center bottom;
  opacity: 0;
  z-index: 12;
  pointer-events: none;
}

.pk3d-stage.is-emerged .pk3d-pop {
  animation: pk3d-emerge 1s 0.04s cubic-bezier(0.3, 0.9, 0.35, 1) both;
}

.pk3d-pop img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: bottom center;
  transform-origin: center bottom;
  transform: translate(var(--pk-tx, 0%), var(--pk-ty, 10%)) scale(var(--pk-scale, 1));
  pointer-events: none;
  will-change: transform, opacity;
  backface-visibility: hidden;
  -webkit-user-drag: none;
  image-rendering: -webkit-optimize-contrast;
  image-rendering: smooth;
}

.pk3d-silhouette {
  z-index: 13;
  filter: brightness(0) invert(1) drop-shadow(0 0 18px rgba(255, 246, 214, 0.85));
  opacity: 1;
}

.pk3d-stage.is-emerged .pk3d-silhouette {
  animation: pk3d-sil-dissolve 1s 0.04s ease-out both;
}

.pk3d-sprite {
  z-index: 12;
  filter: none;
}

.pk3d-sprite.is-fallback {
  filter: drop-shadow(0 0 24px rgba(234, 179, 8, 0.55));
}

.pk3d-stage.is-emerged .pk3d-sprite {
  animation: pk3d-float 2.8s 1.25s ease-in-out infinite;
}

@media (max-height: 640px) {
  .pk3d-stage {
    width: clamp(190px, 38vh, 250px);
    height: clamp(160px, 34vh, 220px);
  }
}
`;

// Pre-allocated math helpers outside render loop (zero GC in tick)
const _projVec = new THREE.Vector3();
const _edgeVec = new THREE.Vector3();

// Timeline milestones (seconds)
const T_DROP_END = 1.28;
const T_IMPACT_1 = 0.715;
const T_IMPACT_2 = 1.066;
const T_BALL_OPEN = 1.38;
const T_POKEMON_EMERGE = 1.62;
const T_BALL_RETRACT_END = 2.35;

function easeOutCubic(t: number): number {
  const x = clampNum(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

function easeOutBack(t: number): number {
  const x = clampNum(t, 0, 1);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function easeInQuad(t: number): number {
  const x = clampNum(t, 0, 1);
  return x * x;
}

export const Pokemon3DPokeballReveal: React.FC<Pokemon3DPokeballRevealProps> = ({
  active = true,
  pokemonId,
  pokemonName = 'Caught Pokémon',
  revealKey = 0,
  onDropImpact,
  onBallOpen,
  onPokemonEmerge,
  forceFallbackGlow = false,
  useBuiltInSfx = false,
}) => {
  const stageElRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);

  const primaryUrl = forceFallbackGlow
    ? getPokemon3DFallbackArtworkUrl(pokemonId)
    : getPokemon3DArtworkUrl(pokemonId);
  const initialFallback = forceFallbackGlow || !primaryUrl;

  const [imgSrc, setImgSrc] = useState<string>(primaryUrl);
  const [usingFallback, setUsingFallback] = useState<boolean>(initialFallback);
  const [spriteAlign, setSpriteAlign] = useState<SpriteAlignment>(
    spriteAlignmentCache.get(primaryUrl) ||
      (initialFallback ? DEFAULT_FALLBACK_ALIGNMENT : DEFAULT_PRIMARY_ALIGNMENT)
  );
  const [emerged, setEmerged] = useState<boolean>(false);

  const callbacksRef = useRef({
    onDropImpact,
    onBallOpen,
    onPokemonEmerge,
    useBuiltInSfx,
  });
  callbacksRef.current = {
    onDropImpact,
    onBallOpen,
    onPokemonEmerge,
    useBuiltInSfx,
  };

  const timelineStateRef = useRef({
    active,
    elapsed: 0,
    impact1Fired: false,
    impact2Fired: false,
    openFired: false,
    emergeFired: false,
    restartRequested: false,
  });

  useEffect(() => {
    const nextUrl = forceFallbackGlow
      ? getPokemon3DFallbackArtworkUrl(pokemonId)
      : getPokemon3DArtworkUrl(pokemonId);
    const nextIsFallback = forceFallbackGlow || !nextUrl;
    setImgSrc(nextUrl);
    setUsingFallback(nextIsFallback);
    setSpriteAlign(
      spriteAlignmentCache.get(nextUrl) ||
        (nextIsFallback ? DEFAULT_FALLBACK_ALIGNMENT : DEFAULT_PRIMARY_ALIGNMENT)
    );
  }, [pokemonId, forceFallbackGlow]);

  useEffect(() => {
    timelineStateRef.current.active = active;
    if (active) {
      timelineStateRef.current.elapsed = 0;
      timelineStateRef.current.impact1Fired = false;
      timelineStateRef.current.impact2Fired = false;
      timelineStateRef.current.openFired = false;
      timelineStateRef.current.emergeFired = false;
      timelineStateRef.current.restartRequested = true;
      setEmerged(false);
    } else {
      setEmerged(false);
    }
  }, [active, pokemonId, revealKey, forceFallbackGlow]);

  // Initialize Three.js 3D Pokéball + 3D Holographic Platform Scene ONCE
  useEffect(() => {
    const host = canvasHostRef.current;
    const stageEl = stageElRef.current;
    if (!host || !stageEl) return;

    // Software WebGL probe
    const isSoftwareGl = (() => {
      try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2');
        if (!gl) return true;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
        const gpu = String(gl.getParameter(param) || '');
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      } catch {
        return true;
      }
    })();

    const width = Math.max(host.clientWidth || 260, 120);
    const height = Math.max(host.clientHeight || 230, 120);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x000000, 0);

    host.innerHTML = '';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    // Studio environment map for metallic/clearcoat Pokéball & pedestal reflections
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTarget = pmremGenerator.fromScene(roomEnv, 0.04);
    scene.environment = envTarget.texture;
    roomEnv.dispose();
    pmremGenerator.dispose();

    const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 40);
    camera.position.set(0, 1.48, 4.95);
    camera.lookAt(0, 0.68, 0);

    // 3-point warm/cool studio lighting rig
    const hemiLight = new THREE.HemisphereLight(0x7dd3fc, 0x090e1a, 0.85);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff5e4, 2.2);
    keyLight.position.set(2.8, 5.2, 3.6);
    keyLight.castShadow = !isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 16;
    const d = 2.5;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x60a5fa, 1.4);
    rimLight.position.set(-2.8, 2.6, -2.5);
    scene.add(rimLight);

    // Track disposable resources cleanly
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const textures: THREE.Texture[] = [];
    const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
      geometries.push(g);
      return g;
    };
    const trackMat = <T extends THREE.Material>(m: T): T => {
      materials.push(m);
      return m;
    };
    const trackTex = <T extends THREE.Texture>(t: T): T => {
      textures.push(t);
      return t;
    };

    const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy() || 1);

    // =========================================================================
    // 1) 3D UNIVERSAL HOLOGRAPHIC PEDESTAL PLATFORM (Multi-part Lathe + Rings)
    // =========================================================================
    const platformGroup = new THREE.Group();
    scene.add(platformGroup);

    const PEDESTAL_R = 1.24;
    const PEDESTAL_TOP_Y = 0.14;

    // Beveled lathe base profile
    const lathePoints = [
      new THREE.Vector2(0.0, 0.0),
      new THREE.Vector2(PEDESTAL_R * 1.06, 0.0),
      new THREE.Vector2(PEDESTAL_R * 1.08, 0.045),
      new THREE.Vector2(PEDESTAL_R * 1.0, 0.095),
      new THREE.Vector2(PEDESTAL_R * 0.96, PEDESTAL_TOP_Y),
      new THREE.Vector2(0.0, PEDESTAL_TOP_Y),
    ];
    const baseGeo = trackGeo(new THREE.LatheGeometry(lathePoints, 56));
    const baseMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x101a30,
        roughness: 0.42,
        metalness: 0.76,
      })
    );
    const pedestalBaseMesh = new THREE.Mesh(baseGeo, baseMat);
    pedestalBaseMesh.receiveShadow = true;
    platformGroup.add(pedestalBaseMesh);

    // Top holographic grid plate (polygonOffset to prevent Z-fighting)
    const deckTex = trackTex(createPedestalRingTexture(512));
    deckTex.anisotropy = maxAnisotropy;
    const deckGeo = trackGeo(new THREE.CircleGeometry(PEDESTAL_R * 0.92, 56));
    deckGeo.rotateX(-Math.PI / 2);
    const deckMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: deckTex,
        roughness: 0.25,
        metalness: 0.45,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    );
    const deckMesh = new THREE.Mesh(deckGeo, deckMat);
    deckMesh.position.y = PEDESTAL_TOP_Y + 0.004;
    deckMesh.receiveShadow = true;
    platformGroup.add(deckMesh);

    // Outer glowing blue torus ring
    const outerRingGeo = trackGeo(new THREE.TorusGeometry(PEDESTAL_R * 0.92, 0.026, 16, 64));
    outerRingGeo.rotateX(Math.PI / 2);
    const outerRingMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x60a5fa,
        emissive: 0x3b82f6,
        emissiveIntensity: 1.7,
        roughness: 0.2,
        metalness: 0.6,
      })
    );
    const outerRingMesh = new THREE.Mesh(outerRingGeo, outerRingMat);
    outerRingMesh.position.y = PEDESTAL_TOP_Y + 0.015;
    platformGroup.add(outerRingMesh);

    // Mid glowing gold torus ring
    const midRingGeo = trackGeo(new THREE.TorusGeometry(PEDESTAL_R * 0.68, 0.022, 16, 64));
    midRingGeo.rotateX(Math.PI / 2);
    const midRingMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xfde047,
        emissive: 0xeab308,
        emissiveIntensity: 1.5,
        roughness: 0.22,
        metalness: 0.7,
      })
    );
    const midRingMesh = new THREE.Mesh(midRingGeo, midRingMat);
    midRingMesh.position.y = PEDESTAL_TOP_Y + 0.018;
    platformGroup.add(midRingMesh);

    // Glowing holographic core disc
    const coreGlowTex = trackTex(
      createRadialGlowTexture([
        [0, 'rgba(255, 255, 255, 0.95)'],
        [0.35, 'rgba(96, 165, 250, 0.65)'],
        [0.7, 'rgba(59, 130, 246, 0.18)'],
        [1, 'rgba(59, 130, 246, 0)'],
      ])
    );
    const coreGlowGeo = trackGeo(new THREE.PlaneGeometry(PEDESTAL_R * 1.15, PEDESTAL_R * 1.15));
    coreGlowGeo.rotateX(-Math.PI / 2);
    const coreGlowMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: coreGlowTex,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    const coreGlowMesh = new THREE.Mesh(coreGlowGeo, coreGlowMat);
    coreGlowMesh.position.y = PEDESTAL_TOP_Y + 0.012;
    platformGroup.add(coreGlowMesh);

    // Contact shadow grounding directly under the Pokéball
    const shadowTex = trackTex(
      createRadialGlowTexture([
        [0, 'rgba(2, 6, 23, 0.85)'],
        [0.55, 'rgba(2, 6, 23, 0.36)'],
        [1, 'rgba(2, 6, 23, 0)'],
      ])
    );
    const shadowGeo = trackGeo(new THREE.PlaneGeometry(1.15, 1.15));
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
    );
    const contactShadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    contactShadowMesh.position.y = PEDESTAL_TOP_Y + 0.022;
    platformGroup.add(contactShadowMesh);

    // Expanding 3D shockwave ring on ball open
    const shockwaveGeo = trackGeo(new THREE.TorusGeometry(0.45, 0.022, 12, 48));
    shockwaveGeo.rotateX(Math.PI / 2);
    const shockwaveMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    const shockwaveMesh = new THREE.Mesh(shockwaveGeo, shockwaveMat);
    shockwaveMesh.position.y = PEDESTAL_TOP_Y + 0.28;
    platformGroup.add(shockwaveMesh);

    // Volumetric holographic beam cone emerging when the 3D Pokéball opens
    const beamTex = trackTex(createBeamGradientTexture(256));
    const beamGeo = trackGeo(new THREE.CylinderGeometry(0.86, 0.22, 1.85, 36, 1, true));
    beamGeo.translate(0, 0.925, 0);
    const beamMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: beamTex,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    const beamMesh = new THREE.Mesh(beamGeo, beamMat);
    beamMesh.position.y = PEDESTAL_TOP_Y + 0.16;
    platformGroup.add(beamMesh);

    // =========================================================================
    // 2) COMPOSITE 3D POKÉBALL (10-part articulated Group with real 3D hinge)
    // =========================================================================
    const BALL_R = 0.42;
    const ballRoot = new THREE.Group();
    scene.add(ballRoot);

    // Offset inside ballRoot so origin is at the bottom contact point of the ball (for clean squash & bounce)
    const ballCenterGroup = new THREE.Group();
    ballCenterGroup.position.y = BALL_R;
    ballRoot.add(ballCenterGroup);

    // Inner dark metallic core ring / waist
    const waistGeo = trackGeo(new THREE.CylinderGeometry(BALL_R * 0.97, BALL_R * 0.97, 0.075, 48));
    const darkMetalMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x0b101b,
        roughness: 0.36,
        metalness: 0.82,
      })
    );
    const waistMesh = new THREE.Mesh(waistGeo, darkMetalMat);
    ballCenterGroup.add(waistMesh);

    // Inner energy cavity & glowing sphere (visible when top shell opens in 3D!)
    const coreEnergyGeo = trackGeo(new THREE.SphereGeometry(BALL_R * 0.56, 28, 20));
    const coreEnergyMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0xfef9c3,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
      })
    );
    const coreEnergyMesh = new THREE.Mesh(coreEnergyGeo, coreEnergyMat);
    ballCenterGroup.add(coreEnergyMesh);

    const openPointLight = new THREE.PointLight(0xfde047, 0, 5.5, 2);
    openPointLight.position.set(0, 0.15, 0.1);
    ballCenterGroup.add(openPointLight);

    // Lower hemisphere (pearlescent white outer + dark hollow inner cavity)
    const bottomGroup = new THREE.Group();
    ballCenterGroup.add(bottomGroup);

    const lowerShellGeo = trackGeo(
      new THREE.SphereGeometry(BALL_R, 48, 24, 0, Math.PI * 2, Math.PI * 0.53, Math.PI * 0.47)
    );
    const whiteShellMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0xf8fafc,
        roughness: 0.16,
        metalness: 0.12,
        clearcoat: 0.95,
        clearcoatRoughness: 0.08,
      })
    );
    const lowerShellMesh = new THREE.Mesh(lowerShellGeo, whiteShellMat);
    lowerShellMesh.castShadow = !isSoftwareGl;
    bottomGroup.add(lowerShellMesh);

    const lowerInnerGeo = trackGeo(
      new THREE.SphereGeometry(BALL_R * 0.93, 36, 18, 0, Math.PI * 2, Math.PI * 0.53, Math.PI * 0.47)
    );
    const innerCavityMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x111827,
        roughness: 0.55,
        metalness: 0.65,
        side: THREE.BackSide,
      })
    );
    const lowerInnerMesh = new THREE.Mesh(lowerInnerGeo, innerCavityMat);
    bottomGroup.add(lowerInnerMesh);

    // Lower rim collar
    const lowerRimGeo = trackGeo(new THREE.TorusGeometry(BALL_R * 0.96, 0.022, 12, 48));
    lowerRimGeo.rotateX(Math.PI / 2);
    const lowerRimMesh = new THREE.Mesh(lowerRimGeo, darkMetalMat);
    lowerRimMesh.position.y = -0.025;
    bottomGroup.add(lowerRimMesh);

    // Rear mechanical hinge barrel
    const hingeGeo = trackGeo(new THREE.CylinderGeometry(0.042, 0.042, 0.16, 16));
    hingeGeo.rotateZ(Math.PI / 2);
    const hingeMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x334155,
        roughness: 0.3,
        metalness: 0.9,
      })
    );
    const hingeMesh = new THREE.Mesh(hingeGeo, hingeMat);
    hingeMesh.position.set(0, 0, -BALL_R * 0.96);
    ballCenterGroup.add(hingeMesh);

    // Upper hemisphere hinged at the back (topPivot rotates backward in 3D!)
    const topPivot = new THREE.Group();
    topPivot.position.set(0, 0, -BALL_R * 0.96);
    ballCenterGroup.add(topPivot);

    const topShellGroup = new THREE.Group();
    topShellGroup.position.set(0, 0, BALL_R * 0.96);
    topPivot.add(topShellGroup);

    const upperShellGeo = trackGeo(
      new THREE.SphereGeometry(BALL_R, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.47)
    );
    const redShellMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0xdc143c,
        roughness: 0.15,
        metalness: 0.24,
        clearcoat: 1.0,
        clearcoatRoughness: 0.06,
      })
    );
    const upperShellMesh = new THREE.Mesh(upperShellGeo, redShellMat);
    upperShellMesh.castShadow = !isSoftwareGl;
    topShellGroup.add(upperShellMesh);

    const upperInnerGeo = trackGeo(
      new THREE.SphereGeometry(BALL_R * 0.93, 36, 18, 0, Math.PI * 2, 0, Math.PI * 0.47)
    );
    const upperInnerMesh = new THREE.Mesh(upperInnerGeo, innerCavityMat);
    topShellGroup.add(upperInnerMesh);

    const upperRimGeo = trackGeo(new THREE.TorusGeometry(BALL_R * 0.96, 0.022, 12, 48));
    upperRimGeo.rotateX(Math.PI / 2);
    const upperRimMesh = new THREE.Mesh(upperRimGeo, darkMetalMat);
    upperRimMesh.position.y = 0.025;
    topShellGroup.add(upperRimMesh);

    // Front latch collar + glowing button (attached to ballCenterGroup so it faces camera cleanly)
    const buttonCollarGeo = trackGeo(new THREE.CylinderGeometry(0.105, 0.115, 0.05, 28));
    buttonCollarGeo.rotateX(Math.PI / 2);
    const buttonCollarMesh = new THREE.Mesh(buttonCollarGeo, darkMetalMat);
    buttonCollarMesh.position.set(0, 0, BALL_R * 0.97);
    ballCenterGroup.add(buttonCollarMesh);

    const buttonCoreGeo = trackGeo(new THREE.CylinderGeometry(0.068, 0.068, 0.062, 28));
    buttonCoreGeo.rotateX(Math.PI / 2);
    const buttonMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.35,
        roughness: 0.18,
        metalness: 0.2,
      })
    );
    const buttonMesh = new THREE.Mesh(buttonCoreGeo, buttonMat);
    buttonMesh.position.set(0, 0, BALL_R * 0.985);
    ballCenterGroup.add(buttonMesh);

    // =========================================================================
    // 3) 3D BURST PARTICLES (28 energy motes emitted on Pokéball open)
    // =========================================================================
    const PARTICLE_COUNT = 28;
    const sparkGeo = trackGeo(new THREE.OctahedronGeometry(0.032, 0));
    const sparkMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
      })
    );
    const sparksMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, PARTICLE_COUNT);
    sparksMesh.frustumCulled = false;
    scene.add(sparksMesh);

    const sparkSeeds = Array.from({ length: PARTICLE_COUNT }, (_, idx) => {
      const angle = (idx / PARTICLE_COUNT) * Math.PI * 2 + (idx % 3) * 0.3;
      const speed = 0.75 + (idx % 5) * 0.22;
      const upSpeed = 1.45 + (idx % 4) * 0.42;
      return { angle, speed, upSpeed };
    });
    const sparkDummy = new THREE.Object3D();

    // Pre-warm shaders once on real GPU
    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // Update exact CSS projection anchor so Pokémon's feet sit directly on the 3D platform center
    const syncOverlayProjection = () => {
      _projVec.set(0, PEDESTAL_TOP_Y + 0.015, 0).project(camera);
      const bottomPct = clampNum(((_projVec.y + 1) * 0.5) * 100, 8, 36);
      stageEl.style.setProperty('--pk3d-anchor-bottom', `${bottomPct.toFixed(2)}%`);

      _edgeVec.set(PEDESTAL_R * 0.78, PEDESTAL_TOP_Y + 0.015, 0).project(camera);
      const halfSpanPx = Math.abs(_edgeVec.x - _projVec.x) * 0.5 * (host.clientWidth || 260);
      const spriteBoxPx = clampNum(
        Math.min(halfSpanPx * 2.05, (host.clientHeight || 240) * 0.72),
        104,
        210
      );
      stageEl.style.setProperty('--pk3d-sprite-size', `${Math.round(spriteBoxPx)}px`);
    };
    syncOverlayProjection();

    const handleResize = () => {
      const w = Math.max(host.clientWidth || 260, 120);
      const h = Math.max(host.clientHeight || 230, 120);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
      renderer.setSize(w, h);
      syncOverlayProjection();
    };
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null;
    resizeObserver?.observe(host);

    // =========================================================================
    // 4) FRAME-ACCURATE 3D ANIMATION LOOP
    // =========================================================================
    let frameId = 0;
    let alive = true;
    let lastTs = performance.now();

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (!gl || typeof gl.fenceSync !== 'function') {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (!alive) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    const updateScene = (t: number, dt: number) => {
      const st = timelineStateRef.current;

      // Ambient holographic core pulse on platform
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.1);
      coreGlowMat.opacity = 0.65 + pulse * 0.25;
      coreGlowMesh.scale.setScalar(0.95 + pulse * 0.1);
      outerRingMat.emissiveIntensity = 1.45 + pulse * 0.4;
      midRingMat.emissiveIntensity = 1.35 + pulse * 0.35;

      // Subtle idle rotation on holographic deck
      deckMesh.rotation.y += dt * 0.25;

      if (!st.active) {
        ballRoot.visible = false;
        beamMesh.visible = false;
        shockwaveMesh.visible = false;
        sparksMesh.visible = false;
        shadowMat.opacity = 0;
        return;
      }

      if (st.restartRequested) {
        st.restartRequested = false;
        ballRoot.visible = true;
        ballRoot.scale.set(1, 1, 1);
        topPivot.rotation.x = 0;
        coreEnergyMat.opacity = 0;
        openPointLight.intensity = 0;
        buttonMat.emissiveIntensity = 0.35;
        buttonMat.emissive.setHex(0x38bdf8);
      }

      // Trigger synced SFX & Pokémon emergence milestones
      if (!st.impact1Fired && t >= T_IMPACT_1) {
        st.impact1Fired = true;
        if (callbacksRef.current.onDropImpact) {
          callbacksRef.current.onDropImpact(0.22);
        } else if (callbacksRef.current.useBuiltInSfx) {
          playBuiltinDrop(0.85);
        }
      }
      if (!st.impact2Fired && t >= T_IMPACT_2) {
        st.impact2Fired = true;
        if (callbacksRef.current.onDropImpact) {
          callbacksRef.current.onDropImpact(0.12);
        } else if (callbacksRef.current.useBuiltInSfx) {
          playBuiltinDrop(0.5);
        }
      }
      if (!st.openFired && t >= T_BALL_OPEN) {
        st.openFired = true;
        if (callbacksRef.current.onBallOpen) {
          callbacksRef.current.onBallOpen();
        } else if (callbacksRef.current.useBuiltInSfx) {
          playBuiltinOpen();
        }
      }
      if (!st.emergeFired && t >= T_POKEMON_EMERGE) {
        st.emergeFired = true;
        setEmerged(true);
        callbacksRef.current.onPokemonEmerge?.();
      }

      // Phase A: 3D Pokéball Drop + Squash/Stretch Bounces (0 .. T_DROP_END)
      let impactPulse = 0;
      if (t < T_DROP_END) {
        const p = t / T_DROP_END;
        let yOffset = 0;
        let sx = 1;
        let sy = 1;
        let rotZ = 0;
        let rotY = 0.25;

        if (p < 0.55) {
          const k = p / 0.55;
          yOffset = 3.8 * (1 - k * k);
          rotZ = 0.22 * (1 - k);
          rotY = 0.25 + 0.9 * (1 - k);
          shadowMat.opacity = 0.18 + 0.62 * k;
        } else if (p < 0.72) {
          const k = (p - 0.55) / 0.17;
          const arc = Math.sin(k * Math.PI);
          yOffset = 0.42 * arc;
          const squash = Math.max(0, 1 - k * 2.4);
          sx = 1 + 0.15 * squash;
          sy = 1 - 0.16 * squash;
          rotZ = -0.09 * arc;
          impactPulse = squash;
          shadowMat.opacity = 0.85 - 0.35 * arc;
        } else if (p < 0.88) {
          const k = (p - 0.72) / 0.16;
          const arc = Math.sin(k * Math.PI);
          yOffset = 0.14 * arc;
          const squash = Math.max(0, 1 - k * 2.5);
          sx = 1 + 0.08 * squash;
          sy = 1 - 0.09 * squash;
          rotZ = 0.04 * arc;
          impactPulse = squash * 0.6;
          shadowMat.opacity = 0.8 - 0.2 * arc;
        } else {
          yOffset = 0;
          shadowMat.opacity = 0.72;
        }

        ballRoot.visible = true;
        ballRoot.position.set(0, PEDESTAL_TOP_Y + 0.02 + yOffset, 0.05);
        ballRoot.scale.set(sx, sy, sx);
        ballRoot.rotation.set(0.08, rotY, rotZ);
        topPivot.rotation.x = 0;
        beamMesh.visible = false;
        shockwaveMesh.visible = false;
        sparksMesh.visible = false;
      } else if (t < T_BALL_OPEN) {
        // Phase B: Pre-open anticipation tremble & latch charge (1.28 .. 1.38)
        const k = (t - T_DROP_END) / (T_BALL_OPEN - T_DROP_END);
        const tremble = Math.sin(k * Math.PI * 6) * 0.035;
        ballRoot.visible = true;
        ballRoot.position.set(tremble, PEDESTAL_TOP_Y + 0.02, 0.05);
        ballRoot.scale.set(1 + 0.04 * k, 1 - 0.04 * k, 1 + 0.04 * k);
        ballRoot.rotation.set(0.14, 0.22 * (1 - k), 0);
        buttonMat.emissive.setHex(0xfef08a);
        buttonMat.emissiveIntensity = 0.8 + k * 2.2;
        coreEnergyMat.opacity = k * 0.45;
        shadowMat.opacity = 0.72;
      } else if (t < T_BALL_RETRACT_END) {
        // Phase C: True 3D Pokéball Hinge Open -> Light Beam + Burst -> Retract into Pokémon
        const openT = t - T_BALL_OPEN;
        const hingeProgress = easeOutBack(openT / 0.36);

        // Top hemisphere swings open backward around the rear hinge (~ -108°)
        topPivot.rotation.x = -1.88 * hingeProgress;

        // Core flares white-gold & casts real PointLight on the 3D pedestal
        const flashCurve = Math.sin(clampNum(openT / 0.7, 0, 1) * Math.PI);
        coreEnergyMat.opacity = clampNum(0.95 * flashCurve, 0, 1);
        coreEnergyMesh.scale.setScalar(0.85 + flashCurve * 0.75);
        openPointLight.intensity = 4.2 * flashCurve;
        buttonMat.emissiveIntensity = 2.6 * (1 - clampNum(openT / 0.5, 0, 1));

        // 3D Volumetric energy beam shoots upward out of the opened Pokéball
        const beamFade = Math.sin(clampNum(openT / 0.95, 0, 1) * Math.PI);
        beamMesh.visible = beamFade > 0.01;
        beamMat.opacity = beamFade * 0.85;
        beamMesh.scale.set(0.75 + 0.45 * easeOutCubic(openT / 0.5), 0.3 + 0.9 * easeOutCubic(openT / 0.45), 0.75 + 0.45 * easeOutCubic(openT / 0.5));

        // Expanding 3D shockwave ring across the pedestal
        const shockP = clampNum(openT / 0.65, 0, 1);
        shockwaveMesh.visible = shockP < 1;
        shockwaveMesh.scale.setScalar(0.5 + easeOutCubic(shockP) * 2.8);
        shockwaveMat.opacity = (1 - shockP) * 0.9;

        // 3D Energy spark motes erupting from the opened Pokéball
        const sparkP = clampNum(openT / 0.85, 0, 1);
        sparksMesh.visible = sparkP < 1;
        sparkMat.opacity = (1 - easeInQuad(sparkP)) * 0.95;
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          const seed = sparkSeeds[i];
          const r = 0.08 + seed.speed * sparkP * 1.15;
          const y = PEDESTAL_TOP_Y + 0.32 + seed.upSpeed * sparkP - 0.5 * sparkP * sparkP;
          sparkDummy.position.set(Math.cos(seed.angle) * r, y, Math.sin(seed.angle) * r);
          sparkDummy.rotation.set(sparkP * 5 + i, sparkP * 4, 0);
          sparkDummy.scale.setScalar(Math.max(0.01, (1 - sparkP) * 1.15));
          sparkDummy.updateMatrix();
          sparksMesh.setMatrixAt(i, sparkDummy.matrix);
        }
        sparksMesh.instanceMatrix.needsUpdate = true;

        // Smoothly shrink & dissolve the opened Pokéball away as the Pokémon emerges on the platform
        const retractDelay = 0.48;
        if (openT > retractDelay) {
          const retP = easeInQuad((openT - retractDelay) / (T_BALL_RETRACT_END - T_BALL_OPEN - retractDelay));
          const s = Math.max(0.001, 1 - retP);
          ballRoot.scale.setScalar(s);
          ballRoot.position.set(0, PEDESTAL_TOP_Y + 0.02 + retP * 0.25, 0.05);
          ballRoot.visible = s > 0.01;
          shadowMat.opacity = 0.72 * (1 - retP * 0.45);
        } else {
          ballRoot.visible = true;
          ballRoot.scale.setScalar(1);
          ballRoot.position.set(0, PEDESTAL_TOP_Y + 0.02, 0.05);
          ballRoot.rotation.set(0.16, 0, 0);
          shadowMat.opacity = 0.72;
        }
      } else {
        // Phase D: Pokémon stands cleanly centered on the 3D holographic pedestal
        ballRoot.visible = false;
        beamMesh.visible = false;
        shockwaveMesh.visible = false;
        sparksMesh.visible = false;
        openPointLight.intensity = 0;
        shadowMat.opacity = 0.42;
      }

      // Pedestal ring impact recoil when Pokéball bounces
      const ringScale = 1 + impactPulse * 0.065;
      outerRingMesh.scale.set(ringScale, ringScale, 1);
      midRingMesh.scale.set(1 + impactPulse * 0.045, 1 + impactPulse * 0.045, 1);
    };

    const tick = () => {
      if (!alive) return;
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;

      if (timelineStateRef.current.active) {
        timelineStateRef.current.elapsed += dt;
      }

      updateScene(timelineStateRef.current.elapsed, dt);
      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = window.requestAnimationFrame(tick);
      }
    };

    if (isSoftwareGl) {
      updateScene(timelineStateRef.current.elapsed, 0.016);
      renderer.render(scene, camera);
      afterDraw(tick);
    } else {
      frameId = window.requestAnimationFrame(tick);
    }

    return () => {
      alive = false;
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(frameId);
      resizeObserver?.disconnect();

      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((tx) => tx.dispose());
      envTarget.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, []);

  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const measured = measureSpriteAlignment(e.currentTarget, imgSrc, usingFallback);
    setSpriteAlign(measured);
  };

  const handleImgError = () => {
    setImgSrc('');
    setUsingFallback(false);
    setSpriteAlign(DEFAULT_PRIMARY_ALIGNMENT);
  };

  return (
    <>
      <style>{STAGE_3D_STYLES}</style>
      <div
        ref={stageElRef}
        id="pokemonReveal"
        className={`pk3d-stage${emerged ? ' is-emerged' : ''}`}
      >
        {/* Dedicated empty Three.js WebGL canvas host */}
        <div ref={canvasHostRef} className="pk3d-canvas-host" />

        {/* Real Pokémon emerging directly out of the opened 3D Pokéball onto the 3D platform */}
        <div
          className="pk3d-pop"
          style={
            {
              '--pk-tx': spriteAlign.tx,
              '--pk-ty': spriteAlign.ty,
              '--pk-scale': String(spriteAlign.scale),
            } as React.CSSProperties
          }
        >
          {imgSrc && <img
            id="caughtPokemonSilhouette"
            src={imgSrc}
            crossOrigin="anonymous"
            onError={handleImgError}
            className="pk3d-silhouette"
            alt=""
            aria-hidden="true"
            decoding="async"
          />}
          {imgSrc && <img
            id="caughtPokemonImg"
            src={imgSrc}
            crossOrigin="anonymous"
            onLoad={handleImgLoad}
            onError={handleImgError}
            className={`pk3d-sprite${usingFallback ? ' is-fallback' : ''}`}
            alt={pokemonName}
            decoding="async"
          />}
        </div>
      </div>
    </>
  );
};

// ============================================================================
// Standalone Demo Wrapper (drop-in single-file preview with Replay & Switcher)
// ============================================================================
const DEMO_POKEMON = [
  { id: 25, name: 'Pikachu' },
  { id: 6, name: 'Charizard' },
  { id: 94, name: 'Gengar' },
  { id: 150, name: 'Mewtwo' },
  { id: 448, name: 'Lucario' },
  { id: 658, name: 'Greninja' },
];

export const Pokemon3DPokeballRevealStandalone: React.FC = () => {
  const [selected, setSelected] = useState(DEMO_POKEMON[0]);
  const [revealKey, setRevealKey] = useState(0);
  const [forceFallbackGlow, setForceFallbackGlow] = useState(false);

  const replay = useCallback(() => {
    setRevealKey((k) => k + 1);
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
        background: 'radial-gradient(circle at 50% 35%, #111c36 0%, #050914 72%, #02040a 100%)',
        color: '#e2e8f0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <Pokemon3DPokeballReveal
        active
        pokemonId={selected.id}
        pokemonName={selected.name}
        revealKey={revealKey}
        forceFallbackGlow={forceFallbackGlow}
        useBuiltInSfx
      />

      <h2
        style={{
          marginTop: 14,
          fontSize: 13,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#4ade80',
          fontWeight: 800,
        }}
      >
        Decryption Successful
      </h2>

      <div
        style={{
          marginTop: 18,
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 8,
          maxWidth: 520,
        }}
      >
        <button
          type="button"
          onClick={replay}
          style={{
            background: 'linear-gradient(135deg, #eab308, #ca8a04)',
            color: '#090e1a',
            border: '1px solid #fde047',
            borderRadius: 10,
            padding: '8px 14px',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Replay 3D Reveal
        </button>

        {DEMO_POKEMON.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setSelected(p);
              setRevealKey((k) => k + 1);
            }}
            style={{
              background: 'rgba(15, 23, 42, 0.9)',
              color: selected.id === p.id ? '#fde047' : '#e2e8f0',
              border: `1px solid ${selected.id === p.id ? '#fde047' : 'rgba(96, 165, 250, 0.35)'}`,
              borderRadius: 10,
              padding: '8px 12px',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            #{p.id} {p.name}
          </button>
        ))}

        <button
          type="button"
          onClick={() => {
            setForceFallbackGlow((v) => !v);
            setRevealKey((k) => k + 1);
          }}
          style={{
            background: 'rgba(15, 23, 42, 0.9)',
            color: forceFallbackGlow ? '#fde047' : '#e2e8f0',
            border: `1px solid ${forceFallbackGlow ? '#fde047' : 'rgba(96, 165, 250, 0.35)'}`,
            borderRadius: 10,
            padding: '8px 12px',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {forceFallbackGlow ? 'Fallback Glow: ON' : 'Primary WebP (No Glow)'}
        </button>
      </div>
    </div>
  );
};

export default Pokemon3DPokeballRevealStandalone;
