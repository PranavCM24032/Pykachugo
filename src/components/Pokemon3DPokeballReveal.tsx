import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { getPokemonArtworkUrl, getPokemonSilhouetteUrl } from '../services/gameBackend';

export interface SpriteAlignment {
  tx: string;
  ty: string;
  scale: number;
}

export interface Pokemon3DPokeballRevealProps {
  /** Whether the reveal sequence is active / visible */
  active?: boolean;
  pokemonId?: number;
  /** National Pokédex ID for sprite lookup */
  /** Optional direct artwork URL stored on the puzzle */
  pokemonLink?: string;
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
  /** Force the Pokémon sprite to be omitted for layout preview */
  forceFallbackGlow?: boolean;
}

const DEFAULT_PRIMARY_ALIGNMENT: SpriteAlignment = { tx: '0%', ty: '12%', scale: 1 };
const DEFAULT_FALLBACK_ALIGNMENT: SpriteAlignment = { tx: '0%', ty: '7%', scale: 1 };
const spriteAlignmentCache = new Map<string, SpriteAlignment>();

function getFallbackArtworkUrl(pokemonId: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/${pokemonId}.png`;
}

function resolvePokemonId(pokemonId?: number, pokemonLink?: string): number | null {
  const explicitId = Number(pokemonId);
  if (Number.isInteger(explicitId) && explicitId > 0) return explicitId;
  const match = String(pokemonLink || '').match(/(?:^|\/)(\d+)(?:\.[^/?#]+)?(?:[?#].*)?$/);
  return match ? Number(match[1]) : null;
}

export function getPokemon3DArtworkUrl(
  pokemonLink?: string
): string {
  return getPokemonArtworkUrl(pokemonLink);
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

    const S = 64;
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

    const spriteH = Math.max(1, maxY - minY + 1);
    // Use the lower quarter as the stance anchor. Centering from the whole
    // silhouette can shift a Pokémon with a tail, head, or uneven pose sideways.
    const baseTop = Math.max(minY, Math.floor(maxY - spriteH * 0.25));
    let baseMinX = S;
    let baseMaxX = -1;
    for (let y = baseTop; y <= maxY; y++) {
      const rowOffset = y * S * 4;
      for (let x = minX; x <= maxX; x++) {
        if (data[rowOffset + x * 4 + 3] > 36) {
          baseMinX = Math.min(baseMinX, x);
          baseMaxX = Math.max(baseMaxX, x);
        }
      }
    }
    const stanceCenterFrac =
      baseMaxX >= baseMinX ? (baseMinX + baseMaxX + 1) / (2 * S) : (minX + maxX + 1) / (2 * S);
    const bottomGapFrac = (S - 1 - maxY) / S;

    const leftDist = Math.abs(minX / S - stanceCenterFrac);
    const rightDist = Math.abs((maxX + 1) / S - stanceCenterFrac);
    const visibleWidthFromStance = Math.max(0.01, 2 * Math.max(leftDist, rightDist));
    const visibleHeight = Math.max(0.01, spriteH / S);
    // Scale from the opaque Pokémon bounds, since many source WebPs include
    // transparent margins that make an image-box-based scale look too small.
    const targetScale = 0.9 / Math.max(visibleWidthFromStance, visibleHeight);
    const widthLimit = 0.94 / visibleWidthFromStance;
    const heightLimit = 0.88 / visibleHeight;
    const fitScale = clampNum(Math.min(targetScale, widthLimit, heightLimit), 0.68, 1.8);

    const tyPct = clampNum((bottomGapFrac * fitScale - 0.01) * 100, -2, 26);
    const txPct = clampNum((0.5 - stanceCenterFrac) * fitScale * 100, -18, 18);

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
// Lightweight Procedural Textures (Zero IBL/PMREM overhead, instant mount)
// ============================================================================
function createRadialGlowTexture(
  stops: Array<[number, string]>,
  size = 128
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

function createBeamGradientTexture(size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, size, 0, 0);
    grad.addColorStop(0, 'rgba(255, 251, 235, 0.9)');
    grad.addColorStop(0.3, 'rgba(250, 204, 21, 0.45)');
    grad.addColorStop(0.65, 'rgba(52, 211, 153, 0.24)');
    grad.addColorStop(1, 'rgba(52, 211, 153, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createPedestalRingTexture(size = 384): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const c = size / 2;
    // Sleek Poké-Arena Jade-Slate court floor (high contrast with CRT dark backdrop & crisp for all Pokémon)
    const bg = ctx.createRadialGradient(c, c, size * 0.04, c, c, size * 0.5);
    bg.addColorStop(0, '#26493a');
    bg.addColorStop(0.45, '#193228');
    bg.addColorStop(0.82, '#11221b');
    bg.addColorStop(1, '#0b1511');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    // Subtle classic Pokéball court emblem on arena floor
    ctx.strokeStyle = 'rgba(241, 245, 249, 0.26)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(c, c, size * 0.31, 0, Math.PI * 2);
    ctx.stroke();

    // Horizontal Pokéball divider band across center court
    ctx.beginPath();
    ctx.moveTo(c - size * 0.31, c);
    ctx.lineTo(c - size * 0.095, c);
    ctx.moveTo(c + size * 0.095, c);
    ctx.lineTo(c + size * 0.31, c);
    ctx.stroke();

    // Center Pokéball ring
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.48)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(c, c, size * 0.095, 0, Math.PI * 2);
    ctx.stroke();

    // Clean emerald-mint & warm-gold outer stadium degree ticks
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const isMajor = i % 3 === 0;
      ctx.strokeStyle = isMajor ? 'rgba(253, 224, 71, 0.62)' : 'rgba(52, 211, 153, 0.36)';
      ctx.lineWidth = isMajor ? 2.5 : 1.5;
      const r1 = isMajor ? size * 0.36 : size * 0.39;
      const r2 = size * 0.45;
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

const STAGE_3D_STYLES = `
@keyframes pk3d-emerge {
  0% { opacity: 0; transform: translate3d(-50%, 10px, 0) scale(0.08); }
  24% { opacity: 1; transform: translate3d(-50%, -16px, 0) scale(0.62); }
  62% { opacity: 1; transform: translate3d(-50%, -22px, 0) scale(1.08); }
  84% { opacity: 1; transform: translate3d(-50%, 2px, 0) scale(0.98); }
  100% { opacity: 1; transform: translate3d(-50%, 0, 0) scale(1); }
}

@keyframes pk3d-sil-dissolve {
  0%, 35% { opacity: 1; }
  72% { opacity: 0.32; }
  100% { opacity: 0; }
}

.pk3d-stage {
  position: relative;
  width: clamp(210px, 42vh, 300px);
  height: clamp(165px, 34vh, 265px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: visible;
  pointer-events: none;
  contain: layout style;
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
  width: var(--pk3d-sprite-size, min(160px, 23vh));
  height: var(--pk3d-sprite-size, min(160px, 23vh));
  transform: translate3d(-50%, 0, 0) scale(0);
  transform-origin: center bottom;
  opacity: 0;
  z-index: 12;
  pointer-events: none;
  will-change: transform, opacity;
}

.pk3d-stage.is-emerged .pk3d-pop {
  animation: pk3d-emerge 0.92s 0.03s cubic-bezier(0.3, 0.9, 0.35, 1) both;
}

.pk3d-pop img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: bottom center;
  transform-origin: center bottom;
  transform: translate3d(var(--pk-tx, 0%), var(--pk-ty, 10%), 0) scale(var(--pk-scale, 1));
  pointer-events: none;
  will-change: transform, opacity;
  backface-visibility: hidden;
  -webkit-user-drag: none;
}

.pk3d-silhouette {
  z-index: 13;
  opacity: 1;
}

.pk3d-stage.is-emerged .pk3d-silhouette {
  animation: pk3d-sil-dissolve 0.92s 0.03s ease-out forwards;
}

.pk3d-sprite {
  z-index: 12;
}

@media (max-height: 640px) {
  .pk3d-stage {
    width: clamp(180px, 34vh, 235px);
    height: clamp(140px, 30vh, 198px);
  }
}
`;

// Pre-allocated math helpers outside render loop
const _projVec = new THREE.Vector3();
const _edgeVec = new THREE.Vector3();

// Timeline milestones (seconds)
const T_DROP_END = 1.2;
const T_IMPACT_1 = 0.67;
const T_IMPACT_2 = 1.0;
const T_BALL_OPEN = 1.3;
const T_POKEMON_EMERGE = 1.52;
const T_BALL_RETRACT_END = 2.22;

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
  pokemonLink,
  pokemonName = 'Caught Pokémon',
  revealKey = 0,
  onDropImpact,
  onBallOpen,
  onPokemonEmerge,
  forceFallbackGlow = false,
}) => {
  const stageElRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);

  const resolvedPokemonId = resolvePokemonId(pokemonId, pokemonLink);
  // Use the artwork configured for this puzzle as the main reveal sprite.
  // If it fails or is still loading after 800 ms, switch to the Home artwork
  // for the same Pokédex ID (for example, other/home/7.png for Squirtle).
  const primaryUrl = forceFallbackGlow || !resolvedPokemonId
    ? ''
    : getPokemonArtworkUrl(pokemonLink);
  const silUrl = primaryUrl || (forceFallbackGlow ? '' : getPokemonSilhouetteUrl(pokemonLink));

  const [imgSrc, setImgSrc] = useState<string>(primaryUrl);
  const [silSrc, setSilSrc] = useState<string>(silUrl);
  const [showSilhouette, setShowSilhouette] = useState<boolean>(true);
  const [spriteFailed, setSpriteFailed] = useState(false);
  const [silhouetteFailed, setSilhouetteFailed] = useState(false);
  const spriteLoadedRef = useRef(false);
  const fallbackTimerRef = useRef<number | null>(null);
  const [spriteAlign, setSpriteAlign] = useState<SpriteAlignment>(
    spriteAlignmentCache.get(primaryUrl) || DEFAULT_PRIMARY_ALIGNMENT
  );
  const [emerged, setEmerged] = useState<boolean>(false);

  const callbacksRef = useRef({
    onDropImpact,
    onBallOpen,
    onPokemonEmerge,
  });
  callbacksRef.current = {
    onDropImpact,
    onBallOpen,
    onPokemonEmerge,
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
    const nextId = resolvePokemonId(pokemonId, pokemonLink);
    const nextUrl = forceFallbackGlow || !nextId
      ? ''
      : getPokemonArtworkUrl(pokemonLink);
    const nextSilUrl = nextUrl || (forceFallbackGlow ? '' : getPokemonSilhouetteUrl(pokemonLink));
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    spriteLoadedRef.current = false;
    setImgSrc(nextUrl);
    setSilSrc(nextSilUrl);
    setSpriteFailed(false);
    setSilhouetteFailed(false);

    const cached = spriteAlignmentCache.get(nextUrl);
    if (cached) {
      setSpriteAlign(cached);
    } else {
      setSpriteAlign(DEFAULT_PRIMARY_ALIGNMENT);
    }
  }, [pokemonId, pokemonLink, forceFallbackGlow]);

  useEffect(() => {
    if (!active || forceFallbackGlow || !resolvedPokemonId || spriteLoadedRef.current) return;
    const fallbackUrl = getFallbackArtworkUrl(resolvedPokemonId);
    fallbackTimerRef.current = window.setTimeout(() => {
      fallbackTimerRef.current = null;
      if (spriteLoadedRef.current) return;
      setImgSrc(fallbackUrl);
      setSpriteFailed(false);
      setSpriteAlign(spriteAlignmentCache.get(fallbackUrl) || DEFAULT_FALLBACK_ALIGNMENT);
    }, 800);
    return () => {
      if (fallbackTimerRef.current !== null) {
        window.clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  }, [active, pokemonId, pokemonLink, revealKey, forceFallbackGlow]);

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
      setShowSilhouette(true);
    }
  }, [active, pokemonLink, revealKey, forceFallbackGlow]);

  useEffect(() => {
    if (!emerged) return;
    const t = window.setTimeout(() => {
      setShowSilhouette(false);
    }, 1050);
    return () => window.clearTimeout(t);
  }, [emerged]);

  useEffect(() => {
    const host = canvasHostRef.current;
    const stageEl = stageElRef.current;
    if (!host || !stageEl) return;

    const isSoftwareGl = (() => {
      try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2') || probe.getContext('webgl');
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

    const width = Math.max(host.clientWidth || 240, 120);
    const height = Math.max(host.clientHeight || 200, 120);

    // Fast, zero-stall WebGL renderer (no PMREM/RoomEnvironment, no PCFSoftShadowMap pass)
    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = false;
    renderer.setClearColor(0x000000, 0);

    host.innerHTML = '';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 30);
    camera.position.set(0, 1.48, 4.95);
    camera.lookAt(0, 0.68, 0);

    // Crisp 3-point studio lighting (zero IBL cubemap compilation cost)
    const hemiLight = new THREE.HemisphereLight(0xf0fdf4, 0x1e293b, 1.15);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfffbeb, 1.65);
    keyLight.position.set(2.6, 5.0, 3.8);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x34d399, 1.05);
    rimLight.position.set(-2.6, 2.4, -2.2);
    scene.add(rimLight);

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

    // 1) Sleek Titanium-Slate & Poké-Emerald Championship Pedestal
    const platformGroup = new THREE.Group();
    scene.add(platformGroup);

    const PEDESTAL_R = 1.24;
    const PEDESTAL_TOP_Y = 0.14;

    const lathePoints = [
      new THREE.Vector2(0.0, 0.0),
      new THREE.Vector2(PEDESTAL_R * 1.06, 0.0),
      new THREE.Vector2(PEDESTAL_R * 1.08, 0.045),
      new THREE.Vector2(PEDESTAL_R * 1.0, 0.095),
      new THREE.Vector2(PEDESTAL_R * 0.96, PEDESTAL_TOP_Y),
      new THREE.Vector2(0.0, PEDESTAL_TOP_Y),
    ];
    const baseGeo = trackGeo(new THREE.LatheGeometry(lathePoints, 40));
    const baseMat = trackMat(
      new THREE.MeshPhongMaterial({
        color: 0x334155,
        emissive: 0x0f1c24,
        specular: 0x94a3b8,
        shininess: 48,
      })
    );
    platformGroup.add(new THREE.Mesh(baseGeo, baseMat));

    // Lower satin gold chassis trim ring
    const lowerChassisRingGeo = trackGeo(new THREE.TorusGeometry(PEDESTAL_R * 1.055, 0.017, 10, 44));
    lowerChassisRingGeo.rotateX(Math.PI / 2);
    const lowerChassisRingMat = trackMat(
      new THREE.MeshPhongMaterial({
        color: 0xeab308,
        emissive: 0x713f12,
        specular: 0xfef08a,
        shininess: 72,
      })
    );
    const lowerChassisRing = new THREE.Mesh(lowerChassisRingGeo, lowerChassisRingMat);
    lowerChassisRing.position.y = 0.042;
    platformGroup.add(lowerChassisRing);

    // Mid emerald bevel collar
    const midBevelRingGeo = trackGeo(new THREE.TorusGeometry(PEDESTAL_R * 1.0, 0.015, 10, 44));
    midBevelRingGeo.rotateX(Math.PI / 2);
    const midBevelRingMat = trackMat(
      new THREE.MeshPhongMaterial({
        color: 0x10b981,
        emissive: 0x065f46,
        specular: 0xa7f3d0,
        shininess: 68,
      })
    );
    const midBevelRing = new THREE.Mesh(midBevelRingGeo, midBevelRingMat);
    midBevelRing.position.y = 0.095;
    platformGroup.add(midBevelRing);

    const deckTex = trackTex(createPedestalRingTexture(384));
    const deckGeo = trackGeo(new THREE.CircleGeometry(PEDESTAL_R * 0.92, 40));
    deckGeo.rotateX(-Math.PI / 2);
    const deckMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: deckTex,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    );
    const deckMesh = new THREE.Mesh(deckGeo, deckMat);
    deckMesh.position.y = PEDESTAL_TOP_Y + 0.004;
    platformGroup.add(deckMesh);

    const outerRingGeo = trackGeo(new THREE.TorusGeometry(PEDESTAL_R * 0.92, 0.025, 10, 48));
    outerRingGeo.rotateX(Math.PI / 2);
    const outerRingMat = trackMat(
      new THREE.MeshPhongMaterial({
        color: 0xfde047,
        emissive: 0xa16207,
        specular: 0xffffff,
        shininess: 85,
      })
    );
    const outerRingMesh = new THREE.Mesh(outerRingGeo, outerRingMat);
    outerRingMesh.position.y = PEDESTAL_TOP_Y + 0.014;
    platformGroup.add(outerRingMesh);

    const midRingGeo = trackGeo(new THREE.TorusGeometry(PEDESTAL_R * 0.68, 0.02, 10, 44));
    midRingGeo.rotateX(Math.PI / 2);
    const midRingMat = trackMat(
      new THREE.MeshPhongMaterial({
        color: 0x34d399,
        emissive: 0x059669,
        specular: 0xd1fae5,
        shininess: 80,
      })
    );
    const midRingMesh = new THREE.Mesh(midRingGeo, midRingMat);
    midRingMesh.position.y = PEDESTAL_TOP_Y + 0.017;
    platformGroup.add(midRingMesh);

    const coreGlowTex = trackTex(
      createRadialGlowTexture([
        [0, 'rgba(255, 255, 255, 0.72)'],
        [0.35, 'rgba(52, 211, 153, 0.38)'],
        [0.72, 'rgba(250, 204, 21, 0.16)'],
        [1, 'rgba(16, 185, 129, 0)'],
      ])
    );
    const coreGlowGeo = trackGeo(new THREE.PlaneGeometry(PEDESTAL_R * 1.15, PEDESTAL_R * 1.15));
    coreGlowGeo.rotateX(-Math.PI / 2);
    const coreGlowMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: coreGlowTex,
        transparent: true,
        opacity: 0.78,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    const coreGlowMesh = new THREE.Mesh(coreGlowGeo, coreGlowMat);
    coreGlowMesh.position.y = PEDESTAL_TOP_Y + 0.012;
    platformGroup.add(coreGlowMesh);

    const shadowTex = trackTex(
      createRadialGlowTexture([
        [0, 'rgba(2, 6, 23, 0.8)'],
        [0.55, 'rgba(2, 6, 23, 0.34)'],
        [1, 'rgba(2, 6, 23, 0)'],
      ])
    );
    const shadowGeo = trackGeo(new THREE.PlaneGeometry(1.1, 1.1));
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

    const shockwaveGeo = trackGeo(new THREE.TorusGeometry(0.45, 0.022, 10, 36));
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

    const beamTex = trackTex(createBeamGradientTexture(128));
    const beamGeo = trackGeo(new THREE.CylinderGeometry(0.84, 0.22, 1.82, 24, 1, true));
    beamGeo.translate(0, 0.91, 0);
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

    // 2) Composite 3D Articulated Pokéball (Glossy Phong — crisp highlights, 0 IBL cost)
    const BALL_SCALE = 0.8;
    const BALL_R = 0.42;
    const ballRoot = new THREE.Group();
    scene.add(ballRoot);

    const ballCenterGroup = new THREE.Group();
    ballCenterGroup.position.y = BALL_R;
    ballRoot.add(ballCenterGroup);

    const waistGeo = trackGeo(new THREE.CylinderGeometry(BALL_R * 0.97, BALL_R * 0.97, 0.075, 32));
    const darkMetalMat = trackMat(
      new THREE.MeshPhongMaterial({
        color: 0x0f172a,
        specular: 0x64748b,
        shininess: 55,
      })
    );
    ballCenterGroup.add(new THREE.Mesh(waistGeo, darkMetalMat));

    const coreEnergyGeo = trackGeo(new THREE.SphereGeometry(BALL_R * 0.56, 18, 12));
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

    const bottomGroup = new THREE.Group();
    ballCenterGroup.add(bottomGroup);

    const lowerShellGeo = trackGeo(
      new THREE.SphereGeometry(BALL_R, 32, 16, 0, Math.PI * 2, Math.PI * 0.53, Math.PI * 0.47)
    );
    const whiteShellMat = trackMat(
      new THREE.MeshPhongMaterial({
        color: 0xf8fafc,
        emissive: 0x1e293b,
        specular: 0xffffff,
        shininess: 92,
      })
    );
    bottomGroup.add(new THREE.Mesh(lowerShellGeo, whiteShellMat));

    const lowerInnerGeo = trackGeo(
      new THREE.SphereGeometry(BALL_R * 0.93, 24, 12, 0, Math.PI * 2, Math.PI * 0.53, Math.PI * 0.47)
    );
    const innerCavityMat = trackMat(
      new THREE.MeshPhongMaterial({
        color: 0x111827,
        specular: 0x334155,
        shininess: 24,
        side: THREE.BackSide,
      })
    );
    bottomGroup.add(new THREE.Mesh(lowerInnerGeo, innerCavityMat));

    const lowerRimGeo = trackGeo(new THREE.TorusGeometry(BALL_R * 0.96, 0.022, 8, 32));
    lowerRimGeo.rotateX(Math.PI / 2);
    const lowerRimMesh = new THREE.Mesh(lowerRimGeo, darkMetalMat);
    lowerRimMesh.position.y = -0.025;
    bottomGroup.add(lowerRimMesh);

    const hingeGeo = trackGeo(new THREE.CylinderGeometry(0.042, 0.042, 0.16, 12));
    hingeGeo.rotateZ(Math.PI / 2);
    const hingeMesh = new THREE.Mesh(hingeGeo, darkMetalMat);
    hingeMesh.position.set(0, 0, -BALL_R * 0.96);
    ballCenterGroup.add(hingeMesh);

    const topPivot = new THREE.Group();
    topPivot.position.set(0, 0, -BALL_R * 0.96);
    ballCenterGroup.add(topPivot);

    const topShellGroup = new THREE.Group();
    topShellGroup.position.set(0, 0, BALL_R * 0.96);
    topPivot.add(topShellGroup);

    const upperShellGeo = trackGeo(
      new THREE.SphereGeometry(BALL_R, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.47)
    );
    const redShellMat = trackMat(
      new THREE.MeshPhongMaterial({
        color: 0xe11d48,
        emissive: 0x450a0a,
        specular: 0xffffff,
        shininess: 105,
      })
    );
    topShellGroup.add(new THREE.Mesh(upperShellGeo, redShellMat));

    const upperInnerGeo = trackGeo(
      new THREE.SphereGeometry(BALL_R * 0.93, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.47)
    );
    topShellGroup.add(new THREE.Mesh(upperInnerGeo, innerCavityMat));

    const upperRimGeo = trackGeo(new THREE.TorusGeometry(BALL_R * 0.96, 0.022, 8, 32));
    upperRimGeo.rotateX(Math.PI / 2);
    const upperRimMesh = new THREE.Mesh(upperRimGeo, darkMetalMat);
    upperRimMesh.position.y = 0.025;
    topShellGroup.add(upperRimMesh);

    const buttonCollarGeo = trackGeo(new THREE.CylinderGeometry(0.105, 0.115, 0.05, 20));
    buttonCollarGeo.rotateX(Math.PI / 2);
    const buttonCollarMesh = new THREE.Mesh(buttonCollarGeo, darkMetalMat);
    buttonCollarMesh.position.set(0, 0, BALL_R * 0.97);
    ballCenterGroup.add(buttonCollarMesh);

    const buttonCoreGeo = trackGeo(new THREE.CylinderGeometry(0.068, 0.068, 0.062, 20));
    buttonCoreGeo.rotateX(Math.PI / 2);
    const buttonMat = trackMat(
      new THREE.MeshPhongMaterial({
        color: 0xffffff,
        emissive: 0x34d399,
        emissiveIntensity: 0.4,
        specular: 0xffffff,
        shininess: 90,
      })
    );
    const buttonMesh = new THREE.Mesh(buttonCoreGeo, buttonMat);
    buttonMesh.position.set(0, 0, BALL_R * 0.985);
    ballCenterGroup.add(buttonMesh);

    // 3) 3D Burst Particles
    const PARTICLE_COUNT = 20;
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

    const syncOverlayProjection = () => {
      _projVec.set(0, PEDESTAL_TOP_Y + 0.015, 0).project(camera);
      const bottomPct = clampNum(((_projVec.y + 1) * 0.5) * 100, 8, 36);
      stageEl.style.setProperty('--pk3d-anchor-bottom', `${bottomPct.toFixed(2)}%`);

      _edgeVec.set(PEDESTAL_R * 0.78, PEDESTAL_TOP_Y + 0.015, 0).project(camera);
      const halfSpanPx = Math.abs(_edgeVec.x - _projVec.x) * 0.5 * (host.clientWidth || 240);
      const spriteBoxPx = clampNum(
        Math.min(halfSpanPx * 2.05, (host.clientHeight || 200) * 0.72),
        96,
        205
      );
      stageEl.style.setProperty('--pk3d-sprite-size', `${Math.round(spriteBoxPx)}px`);
    };
    syncOverlayProjection();

    const handleResize = () => {
      const w = Math.max(host.clientWidth || 240, 120);
      const h = Math.max(host.clientHeight || 200, 120);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(w, h);
      syncOverlayProjection();
    };
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null;
    resizeObserver?.observe(host);

    let frameId = 0;
    let idleTimer: number | null = null;
    let alive = true;
    let lastTs = performance.now();

    const updateScene = (t: number, dt: number) => {
      const st = timelineStateRef.current;

      const pulse = 0.5 + 0.5 * Math.sin(t * 2.8);
      coreGlowMat.opacity = 0.68 + pulse * 0.18;
      coreGlowMesh.scale.setScalar(0.96 + pulse * 0.07);
      outerRingMat.emissiveIntensity = 0.85 + pulse * 0.35;
      midRingMat.emissiveIntensity = 0.9 + pulse * 0.35;

      deckMesh.rotation.y += dt * 0.22;

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
        ballRoot.scale.setScalar(BALL_SCALE);
        topPivot.rotation.x = 0;
        coreEnergyMat.opacity = 0;
        buttonMat.emissiveIntensity = 0.4;
        buttonMat.emissive.setHex(0x34d399);
      }

      if (!st.impact1Fired && t >= T_IMPACT_1) {
        st.impact1Fired = true;
        callbacksRef.current.onDropImpact?.(0.22);
      }
      if (!st.impact2Fired && t >= T_IMPACT_2) {
        st.impact2Fired = true;
        callbacksRef.current.onDropImpact?.(0.12);
      }
      if (!st.openFired && t >= T_BALL_OPEN) {
        st.openFired = true;
        callbacksRef.current.onBallOpen?.();
      }
      if (!st.emergeFired && t >= T_POKEMON_EMERGE) {
        st.emergeFired = true;
        setEmerged(true);
        callbacksRef.current.onPokemonEmerge?.();
      }

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
        ballRoot.scale.set(sx * BALL_SCALE, sy * BALL_SCALE, sx * BALL_SCALE);
        ballRoot.rotation.set(0.08, rotY, rotZ);
        topPivot.rotation.x = 0;
        beamMesh.visible = false;
        shockwaveMesh.visible = false;
        sparksMesh.visible = false;
      } else if (t < T_BALL_OPEN) {
        const k = (t - T_DROP_END) / (T_BALL_OPEN - T_DROP_END);
        const tremble = Math.sin(k * Math.PI * 6) * 0.035;
        ballRoot.visible = true;
        ballRoot.position.set(tremble, PEDESTAL_TOP_Y + 0.02, 0.05);
        ballRoot.scale.set(
          (1 + 0.04 * k) * BALL_SCALE,
          (1 - 0.04 * k) * BALL_SCALE,
          (1 + 0.04 * k) * BALL_SCALE
        );
        ballRoot.rotation.set(0.14, 0.22 * (1 - k), 0);
        buttonMat.emissive.setHex(0xfef08a);
        buttonMat.emissiveIntensity = 0.8 + k * 2.0;
        coreEnergyMat.opacity = k * 0.45;
        shadowMat.opacity = 0.72;
      } else if (t < T_BALL_RETRACT_END) {
        const openT = t - T_BALL_OPEN;
        const hingeProgress = easeOutBack(openT / 0.36);
        topPivot.rotation.x = -1.88 * hingeProgress;

        const flashCurve = Math.sin(clampNum(openT / 0.7, 0, 1) * Math.PI);
        coreEnergyMat.opacity = clampNum(0.95 * flashCurve, 0, 1);
        coreEnergyMesh.scale.setScalar(0.85 + flashCurve * 0.75);
        buttonMat.emissiveIntensity = 2.2 * (1 - clampNum(openT / 0.5, 0, 1));

        const beamFade = Math.sin(clampNum(openT / 0.9, 0, 1) * Math.PI);
        beamMesh.visible = beamFade > 0.01;
        beamMat.opacity = beamFade * 0.82;
        beamMesh.scale.set(
          0.75 + 0.45 * easeOutCubic(openT / 0.5),
          0.3 + 0.9 * easeOutCubic(openT / 0.45),
          0.75 + 0.45 * easeOutCubic(openT / 0.5)
        );

        const shockP = clampNum(openT / 0.65, 0, 1);
        shockwaveMesh.visible = shockP < 1;
        shockwaveMesh.scale.setScalar(0.5 + easeOutCubic(shockP) * 2.8);
        shockwaveMat.opacity = (1 - shockP) * 0.88;

        const sparkP = clampNum(openT / 0.82, 0, 1);
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

        const retractDelay = 0.46;
        if (openT > retractDelay) {
          const retP = easeInQuad(
            (openT - retractDelay) / (T_BALL_RETRACT_END - T_BALL_OPEN - retractDelay)
          );
          const s = Math.max(0.001, 1 - retP);
          ballRoot.scale.setScalar(s * BALL_SCALE);
          ballRoot.position.set(0, PEDESTAL_TOP_Y + 0.02 + retP * 0.25, 0.05);
          ballRoot.visible = s > 0.01;
          shadowMat.opacity = 0.72 * (1 - retP * 0.45);
        } else {
          ballRoot.visible = true;
          ballRoot.scale.setScalar(BALL_SCALE);
          ballRoot.position.set(0, PEDESTAL_TOP_Y + 0.02, 0.05);
          ballRoot.rotation.set(0.16, 0, 0);
          shadowMat.opacity = 0.72;
        }
      } else {
        ballRoot.visible = false;
        beamMesh.visible = false;
        shockwaveMesh.visible = false;
        sparksMesh.visible = false;
        shadowMat.opacity = 0.42;
      }

      const ringScale = 1 + impactPulse * 0.065;
      outerRingMesh.scale.set(ringScale, ringScale, 1);
      midRingMesh.scale.set(1 + impactPulse * 0.045, 1 + impactPulse * 0.045, 1);
    };

    const tick = () => {
      if (!alive) return;

      if (!timelineStateRef.current.active || document.hidden) {
        lastTs = performance.now();
        idleTimer = window.setTimeout(tick, document.hidden ? 500 : 100);
        return;
      }

      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;

      if (timelineStateRef.current.active) {
        timelineStateRef.current.elapsed += dt;
      }

      const isPostRevealIdle = timelineStateRef.current.elapsed > T_BALL_RETRACT_END + 0.18;
      updateScene(timelineStateRef.current.elapsed, dt);
      renderer.render(scene, camera);

      if (isPostRevealIdle) {
        idleTimer = window.setTimeout(tick, 66);
      } else {
        frameId = window.requestAnimationFrame(tick);
      }
    };

    updateScene(timelineStateRef.current.elapsed, 0.016);
    renderer.render(scene, camera);
    frameId = window.requestAnimationFrame(tick);

    return () => {
      alive = false;
      window.cancelAnimationFrame(frameId);
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      resizeObserver?.disconnect();

      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((tx) => tx.dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, []);

  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    spriteLoadedRef.current = true;
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    const isFallback = imgSrc === getFallbackArtworkUrl(resolvedPokemonId || 0);
    const cached = spriteAlignmentCache.get(imgSrc);
    if (cached) {
      setSpriteAlign(cached);
      return;
    }
    const measured = measureSpriteAlignment(e.currentTarget, imgSrc, isFallback);
    spriteAlignmentCache.set(imgSrc, measured);
    setSpriteAlign(measured);
  };

  const handleImgError = () => {
    if (imgSrc === getFallbackArtworkUrl(resolvedPokemonId || 0)) setSpriteFailed(true);
  };

  return (
    <>
      <style>{STAGE_3D_STYLES}</style>
      <div
        ref={stageElRef}
        id="pokemonReveal"
        className={`pk3d-stage${emerged ? ' is-emerged' : ''}`}
      >
        <div ref={canvasHostRef} className="pk3d-canvas-host" />

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
          {showSilhouette && silSrc && !silhouetteFailed && (
            <img
              id="caughtPokemonSilhouette"
              src={silSrc}
              crossOrigin="anonymous"
              className="pk3d-silhouette"
              alt=""
              aria-hidden="true"
              decoding="async"
              onError={() => setSilhouetteFailed(true)}
            />
          )}
          {imgSrc && !spriteFailed && (
            <img
              id="caughtPokemonImg"
              src={imgSrc}
              crossOrigin="anonymous"
              onLoad={handleImgLoad}
              onError={handleImgError}
              className="pk3d-sprite"
              alt={pokemonName}
              decoding="async"
            />
          )}
        </div>
      </div>
    </>
  );
};
