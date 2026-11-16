import 'dotenv/config';
import compression from 'compression';
import express, { type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getLoadBalancer } from './src/server/loadBalancer.ts';
import { getRedisStore } from './src/server/redisStore.ts';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const DIST_DIR = path.resolve(__dirname, 'dist');

const redis = getRedisStore();
const lb = getLoadBalancer();
const telemetryRateWindows = new Map<string, { startedAt: number; count: number }>();
let epochCache: { value: number; expiresAt: number } | null = null;
let epochLookupInFlight: Promise<number> | null = null;
let bootstrapHotCache: { key: string; expiresAt: number; payload: Record<string, unknown> } | null = null;
let leaderboardHotCache: { expiresAt: number; payload: Record<string, unknown> } | null = null;

// In-memory LRU byte cache for ultra-fast repeat WebP Pokémon sprite hits on 2G
const webpMemoryCache = new Map<string, Buffer>();
const MAX_WEBP_MEMORY_BYTES = 48 * 1024 * 1024;
let webpMemoryCacheBytes = 0;

function getCachedWebp(key: string): Buffer | null {
  const cached = webpMemoryCache.get(key);
  if (!cached) return null;
  webpMemoryCache.delete(key);
  webpMemoryCache.set(key, cached);
  return cached;
}

function cacheWebp(key: string, image: Buffer): void {
  const existing = webpMemoryCache.get(key);
  if (existing) {
    webpMemoryCacheBytes -= existing.length;
    webpMemoryCache.delete(key);
  }
  webpMemoryCache.set(key, image);
  webpMemoryCacheBytes += image.length;
  while (webpMemoryCacheBytes > MAX_WEBP_MEMORY_BYTES && webpMemoryCache.size > 0) {
    const oldestKey = webpMemoryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldestImage = webpMemoryCache.get(oldestKey);
    webpMemoryCache.delete(oldestKey);
    webpMemoryCacheBytes -= oldestImage?.length || 0;
  }
}

function readJsonFile<T>(relPath: string, fallback: T): T {
  try {
    const full = path.join(PUBLIC_DIR, relPath);
    if (!fs.existsSync(full)) return fallback;
    return JSON.parse(fs.readFileSync(full, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function safeSecretEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function isValidAdminPassword(candidate: string): boolean {
  const password = String(candidate || '').trim();
  if (!password) return false;
  const configuredPassword = String(process.env.ADMIN_PASSWORD || '').trim();
  if (configuredPassword) return safeSecretEqual(password, configuredPassword);
  if (IS_PROD) return false;
  const admins = readJsonFile<Array<{ password?: string }>>('data/admin.json', []);
  return admins.some((admin) => safeSecretEqual(password, String(admin.password || '').trim()));
}

function isValidAdminLogin(name: string, password: string): boolean {
  const cleanName = String(name || '').trim().toUpperCase();
  const admins = readJsonFile<Array<{ name?: string; password?: string }>>('data/admin.json', []);
  const knownAdmin = admins.find((admin) => String(admin.name || '').trim().toUpperCase() === cleanName);
  return Boolean(knownAdmin && isValidAdminPassword(password));
}

function getArtworkContentType(buf: Buffer): string {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  return 'application/octet-stream';
}

interface SpriteAlignmentMeta {
  tx: string;
  ty: string;
  scale: number;
}

const spriteAlignMemoryCache = new Map<number, SpriteAlignmentMeta>();

function clampServerNum(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function computeAlignmentFromBbox(
  canvasW: number,
  canvasH: number,
  bboxW: number,
  bboxH: number,
  offX: number,
  offY: number
): SpriteAlignmentMeta {
  if (canvasW <= 0 || canvasH <= 0 || bboxW <= 0 || bboxH <= 0) {
    return { tx: '0%', ty: '12%', scale: 1 };
  }
  const minXFrac = offX / canvasW;
  const maxXFrac = (offX + bboxW) / canvasW;
  const centerXFrac = (minXFrac + maxXFrac) * 0.5;
  const bottomGapFrac = Math.max(0, (canvasH - (offY + bboxH)) / canvasH);
  const symWidthFrac = Math.max(Math.abs(minXFrac - centerXFrac), Math.abs(maxXFrac - centerXFrac)) * 2;
  const widthScale = symWidthFrac > 0.84 ? 0.84 / symWidthFrac : 1;
  const heightFrac = bboxH / canvasH;
  const heightScale = heightFrac > 0.9 ? 0.9 / heightFrac : 1;
  const fitScale = clampServerNum(Math.min(1, widthScale, heightScale), 0.68, 1);
  const tyPct = clampServerNum((bottomGapFrac * fitScale - 0.01) * 100, -2, 26);
  const txPct = clampServerNum((0.5 - centerXFrac) * fitScale * 100, -18, 18);
  return {
    tx: `${txPct.toFixed(2)}%`,
    ty: `${tyPct.toFixed(2)}%`,
    scale: Number(fitScale.toFixed(3)),
  };
}

async function computeAndCacheSpriteAlign(pokemonId: number, filePath: string): Promise<void> {
  if (spriteAlignMemoryCache.has(pokemonId)) return;
  try {
    const { stdout } = await execFileAsync('identify', ['-format', '%W %H %@\n', `${filePath}[0]`]);
    const line = stdout.trim().split('\n')[0] || '';
    const m = line.match(/^(\d+)\s+(\d+)\s+(\d+)x(\d+)\+(\d+)\+(\d+)/);
    if (m) {
      const align = computeAlignmentFromBbox(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6])
      );
      spriteAlignMemoryCache.set(pokemonId, align);
      await redis.set(`pokemon:align:v1:${pokemonId}`, JSON.stringify(align), 60 * 60 * 24 * 7);
    }
  } catch {
    // ignore identify parse issues
  }
}

async function getSpriteAlignMeta(pokemonId: number): Promise<SpriteAlignmentMeta | null> {
  const mem = spriteAlignMemoryCache.get(pokemonId);
  if (mem) return mem;
  const raw = await redis.get(`pokemon:align:v1:${pokemonId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SpriteAlignmentMeta;
    spriteAlignMemoryCache.set(pokemonId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

type PokemonWebpVariant = 'anim' | 'lite' | 'sil';

async function fetchAndConvertPokemonWebp(
  pokemonId: number,
  variant: PokemonWebpVariant = 'anim'
): Promise<Buffer> {
  const tagPrefix = variant === 'sil' ? 'sil3d' : variant === 'lite' ? 'lite3d' : 'anim3d';
  const cacheTag = `${tagPrefix}:${pokemonId}`;
  // v7 also accepts the upstream WebP unchanged when local image converters are unavailable.
  const redisKey = `pokemon:webp:v7:${cacheTag}`;
  const memHit = getCachedWebp(cacheTag);
  if (memHit && memHit.length > 0) return memHit;

  const redisHit = await redis.get(redisKey);
  if (redisHit) {
    const buf = Buffer.from(redisHit, 'base64');
    if (buf.length > 0) {
      cacheWebp(cacheTag, buf);
      return buf;
    }
  }

  // Prefer Generation IX Scarlet-Violet animated 3D WebP (~900KB raw -> ~50KB smooth 16fps anim, ~3KB static, ~1.4KB silhouette)
  const candidates =
    variant === 'lite' || variant === 'sil'
      ? [
          `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-ix/scarlet-violet/${pokemonId}.webp`,
          `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/${pokemonId}.png`,
          `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${pokemonId}.png`,
          `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${pokemonId}.png`,
        ]
      : [
          `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-ix/scarlet-violet/${pokemonId}.webp`,
          `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/showdown/${pokemonId}.gif`,
          `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/${pokemonId}.png`,
          `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${pokemonId}.png`,
          `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${pokemonId}.png`,
        ];

  let originalWebp: Buffer | null = null;
  for (const url of candidates) {
    const isGif = url.endsWith('.gif');
    const isWebp = url.endsWith('.webp');
    const ext = isWebp ? '.webp' : isGif ? '.gif' : '.png';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const tmpIn = path.join(os.tmpdir(), `poke_${pokemonId}_${stamp}${ext}`);
    const tmpOut = path.join(os.tmpdir(), `poke_${pokemonId}_${stamp}_out.webp`);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const rawBuf = Buffer.from(await res.arrayBuffer());
      if (rawBuf.length < 100) continue;
      if (isWebp) originalWebp = rawBuf;

      fs.writeFileSync(tmpIn, rawBuf);
      if (isWebp) {
        if (variant === 'sil') {
          // Server-baked static luminous pearl-white silhouette (~1.4KB) -> zero client CSS drop-shadow/filter overhead
          await execFileAsync('convert', [
            `${tmpIn}[0]`,
            '-resize',
            '156x156>',
            '-alpha',
            'extract',
            '-background',
            '#fffbeb',
            '-alpha',
            'shape',
            '-quality',
            '72',
            '-define',
            'webp:method=6',
            tmpOut,
          ]);
        } else if (variant === 'lite') {
          // 2G Lite: crisp static first 3D frame (~3KB)
          await execFileAsync('convert', [
            `${tmpIn}[0]`,
            '-resize',
            '164x164>',
            '-quality',
            '74',
            '-define',
            'webp:method=6',
            tmpOut,
          ]);
        } else {
          // Standard: Inspect frame count/delay; decimate 2x cleanly after -coalesce so browser decodes ~16fps (~50KB) with zero lag
          let frameCount = 1;
          let frameDelay = 4;
          try {
            const { stdout: idOut } = await execFileAsync('identify', [
              '-format',
              '%n %T\n',
              tmpIn,
            ]);
            const firstLine = idOut.trim().split('\n')[0] || '';
            const parts = firstLine.trim().split(/\s+/);
            frameCount = Math.max(1, Number(parts[0] || 1));
            frameDelay = Math.max(2, Number(parts[1] || 4));
          } catch {
            frameCount = 1;
          }

          const args: string[] = [tmpIn, '-coalesce', '-background', 'none'];
          if (frameCount >= 20) {
            const oddIndices: number[] = [];
            for (let i = 1; i < frameCount; i += 2) {
              oddIndices.push(i);
            }
            const nextDelay = Math.min(12, Math.max(6, frameDelay * 2));
            args.push('-delete', oddIndices.join(','), '-set', 'delay', String(nextDelay));
          }
          args.push('-resize', '156x156>', '-quality', '62', '-define', 'webp:method=6', tmpOut);
          await execFileAsync('convert', args);
        }
      } else if (isGif) {
        if (variant === 'sil') {
          await execFileAsync('convert', [
            `${tmpIn}[0]`,
            '-resize',
            '140x140>',
            '-alpha',
            'extract',
            '-background',
            '#fffbeb',
            '-alpha',
            'shape',
            '-quality',
            '72',
            tmpOut,
          ]);
        } else {
          await execFileAsync('ffmpeg', [
            '-y',
            '-v',
            'error',
            '-i',
            tmpIn,
            '-vf',
            'fps=12,scale=128:128:force_original_aspect_ratio=decrease:flags=lanczos',
            '-loop',
            '0',
            '-c:v',
            'libwebp_anim',
            '-lossless',
            '0',
            '-q:v',
            '46',
            '-compression_level',
            '6',
            tmpOut,
          ]);
        }
      } else {
        if (variant === 'sil') {
          await execFileAsync('convert', [
            tmpIn,
            '-resize',
            '160x160>',
            '-alpha',
            'extract',
            '-background',
            '#fffbeb',
            '-alpha',
            'shape',
            '-quality',
            '72',
            tmpOut,
          ]);
        } else {
          await execFileAsync('convert', [
            tmpIn,
            '-resize',
            '180x180>',
            '-quality',
            '74',
            '-define',
            'webp:method=6',
            tmpOut,
          ]);
        }
      }

      if (fs.existsSync(tmpOut)) {
        const webpBuf = fs.readFileSync(tmpOut);
        if (webpBuf.length > 0) {
          cacheWebp(cacheTag, webpBuf);
          await redis.set(redisKey, webpBuf.toString('base64'), 60 * 60 * 24 * 7);
          await computeAndCacheSpriteAlign(pokemonId, tmpOut);
          return webpBuf;
        }
      }
    } catch {
      // Windows installs often lack ImageMagick. Preserve a valid upstream WebP
      // so the browser can render it directly instead of showing the Pikachu fallback.
      if (isWebp && originalWebp) {
        cacheWebp(cacheTag, originalWebp);
        await redis.set(redisKey, originalWebp.toString('base64'), 60 * 60 * 24 * 7);
        return originalWebp;
      }
    } finally {
      clearTimeout(timer);
      try {
        if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
      } catch {
        // ignore cleanup
      }
    }
  }

  if (originalWebp) return originalWebp;

  return Buffer.alloc(0);
}

async function prewarmPokemonCatalog(): Promise<void> {
  try {
    const puzzles = readJsonFile<Array<{ pokemonId?: number }>>('data/puzzle.json', []);
    const ids = Array.from(
      new Set(
        [1025, 25, ...puzzles.map((p) => Math.floor(Number(p.pokemonId || 0)))].filter(
          (id) => id >= 1 && id <= 1025
        )
      )
    );
    for (const id of ids) {
      await Promise.all([
        lb.coalesce(`pokemon:anim3d:${id}`, () => fetchAndConvertPokemonWebp(id, 'anim')),
        lb.coalesce(`pokemon:lite3d:${id}`, () => fetchAndConvertPokemonWebp(id, 'lite')),
        lb.coalesce(`pokemon:sil3d:${id}`, () => fetchAndConvertPokemonWebp(id, 'sil')),
      ]);
    }
    console.log(`[Pykachu Go] Pre-warmed ${ids.length} Pokémon WebP sprites (anim + lite + silhouette) in Redis/memory.`);
  } catch (err) {
    console.warn('[Pykachu Go] Non-fatal prewarm error:', err);
  }
}

async function getCurrentEpoch(): Promise<number> {
  const now = Date.now();
  if (epochCache && epochCache.expiresAt > now) return epochCache.value;
  if (epochLookupInFlight) return epochLookupInFlight;
  epochLookupInFlight = redis.get('pykachu:epoch')
    .then((stored) => {
      const value = Math.max(1, Number(stored || 1));
      epochCache = { value, expiresAt: Date.now() + 1000 };
      return value;
    })
    .finally(() => {
      epochLookupInFlight = null;
    });
  return epochLookupInFlight;
}

function toLevelTag(levelNum: unknown): 'REG' | 'L1' | 'L2' | 'L3' {
  const raw = String(levelNum ?? '').toUpperCase().trim();
  if (raw === 'REG') return 'REG';
  if (raw === 'L2' || raw === '2') return 'L2';
  if (raw === 'L3' || raw === '3') return 'L3';
  const digits = raw.replace(/\D/g, '');
  if (digits === '2') return 'L2';
  if (digits === '3') return 'L3';
  return 'L1';
}

interface StoredTeamProgress {
  tid: string;
  teamName: string;
  mission: string;
  language: string;
  sessionId: string;
  score: number;
  solved: number[];
  unlocked: number[];
  hintsUsed: number[];
  currentPuzzle: number;
  tabSwitches: number;
  epoch: number;
  registeredAt: string;
  updatedAt: string;
}

async function processTelemetryEvent(evt: Record<string, unknown>, currentEpoch: number): Promise<void> {
  const tid = String(evt.tid || '').trim().toUpperCase().slice(0, 32);
  const teamName = String(evt.teamName || '').trim().slice(0, 60);
  if (!tid && !teamName) return;

  const action = String(evt.action || 'SUMMARY').trim().toUpperCase();
  const eventId = String(evt.eventId || '').trim().slice(0, 120);
  const timestamp = String(evt.timestamp || new Date().toISOString());
  const levelTag = action === 'REGISTRATION' ? 'REG' : toLevelTag(evt.puzzleLevel ?? evt.level);
  const puzzleId = Math.max(0, Math.floor(Number(evt.puzzleId || 0)));
  let status = String(
    evt.status || (action === 'REGISTRATION' ? 'REGISTERED' : action === 'SOLVED' ? 'SOLVED' : 'UNSOLVED')
  ).toUpperCase();

  const teamKey = tid ? `pykachu:team:${tid}` : '';
  const baseRowId = action === 'REGISTRATION'
    ? `reg_${tid}`
    : `${levelTag}_${tid}_P${puzzleId || '0'}`;
  const [previousRaw, baseExistingRaw] = await redis.pipeline([
    ['GET', teamKey],
    ['HGET', 'pykachu:logs', baseRowId],
  ]);
  const previous = typeof previousRaw === 'string'
    ? (JSON.parse(previousRaw) as StoredTeamProgress)
    : null;
  const sameEpoch = previous && previous.epoch === currentEpoch ? previous : null;
  const solvedSet = new Set<number>(sameEpoch?.solved || []);
  const puzzles = readJsonFile<Array<Record<string, unknown>>>('data/puzzle.json', []);
  const puzzleById = new Map(puzzles.map((p) => [Number(p.id), p]));
  let acceptedPoints = 0;

  if (action === 'SOLVED') {
    const puzzle = puzzleById.get(puzzleId);
    if (!puzzle || !puzzleId) return;
    const isRepeat = solvedSet.has(puzzleId);
    const isStartingPuzzle =
      puzzle.requiresStartCode !== false && Boolean(String(puzzle.startCode || '').trim());
    const isUnlocked = isStartingPuzzle || isRepeat || [...solvedSet].some((solvedId) => {
      const solvedPuzzle = puzzleById.get(solvedId);
      return Array.isArray(solvedPuzzle?.nextPuzzleId) && solvedPuzzle.nextPuzzleId.some((id) => Number(id) === puzzleId);
    });
    const points = Math.max(0, Math.floor(Number(puzzle.points) || 0));
    const reportedPoints = Number(evt.points);
    const expectedPoints = isRepeat ? -points : points;
    if (!isUnlocked || !points || reportedPoints !== expectedPoints) return;
    acceptedPoints = expectedPoints;
    status = isRepeat ? 'REPEAT_SOLVE' : 'SOLVED';
    solvedSet.add(puzzleId);
  }

  const maxPossibleScore = puzzles.reduce((sum, puzzle) => sum + Math.max(0, Math.floor(Number(puzzle.points) || 0)), 0);
  const nextScore = action === 'SOLVED'
    ? Math.max(0, Math.min(maxPossibleScore, (sameEpoch?.score || 0) + acceptedPoints))
    : Math.max(0, Math.min(maxPossibleScore, sameEpoch?.score || 0));
  const unlockedSet = new Set<number>();
  puzzles.forEach((puzzle) => {
    if (puzzle.requiresStartCode !== false && String(puzzle.startCode || '').trim()) {
      unlockedSet.add(Number(puzzle.id));
    }
  });
  solvedSet.forEach((solvedId) => {
    const solvedPuzzle = puzzleById.get(solvedId);
    if (!solvedPuzzle) return;
    unlockedSet.add(solvedId);
    if (Array.isArray(solvedPuzzle.nextPuzzleId)) {
      solvedPuzzle.nextPuzzleId.forEach((id) => unlockedSet.add(Number(id)));
    }
  });

  // Persist log row into Redis hash
  const rowId =
    action === 'REGISTRATION'
      ? `reg_${tid}`
      : action === 'SOLVED' && status === 'REPEAT_SOLVE'
        ? `${levelTag}_${tid}_P${puzzleId}_repeat_${eventId || Date.now()}`
        : `${levelTag}_${tid}_P${puzzleId || '0'}`;

  const existingRaw = rowId === baseRowId
    ? baseExistingRaw as string | null
    : await redis.hget('pykachu:logs', rowId);
  const existing = existingRaw ? (JSON.parse(existingRaw) as Record<string, unknown>) : null;
  const alreadySolved = existing && String(existing.status || '').toUpperCase() === 'SOLVED';

  const nextRow: Record<string, unknown> = {
    ...(existing || {}),
    id: rowId,
    action: action === 'REGISTRATION' ? 'REGISTRATION' : 'SUMMARY',
    level: levelTag,
    tid,
    teamName: teamName || String(existing?.teamName || ''),
    mission: String(evt.mission || existing?.mission || ''),
    language: String(evt.language || existing?.language || 'PYTHON'),
    sessionId: String(evt.sessionId || existing?.sessionId || ''),
    puzzleId,
    linkid: String(evt.linkid || existing?.linkid || (puzzleId ? `P${puzzleId}` : '')),
    status: alreadySolved && action !== 'SOLVED' ? 'SOLVED' : status,
    wrongAttempts: Math.max(Number(existing?.wrongAttempts || 0), Number(evt.wrongAttempts || 0)),
    tabSwitches: Math.max(Number(existing?.tabSwitches || 0), Number(evt.tabSwitches || 0)),
    hintUsed: Boolean(existing?.hintUsed) || Boolean(evt.hintUsed),
    scanCount: Math.max(Number(existing?.scanCount || 0), Number(evt.scanCount || 0)),
    points: action === 'SOLVED' ? acceptedPoints : Number(existing?.points || 0),
    totalScore: nextScore,
    unlockedPuzzles: Array.from(unlockedSet).sort((a, b) => a - b).join(','),
    solvedPuzzles: Array.from(solvedSet).sort((a, b) => a - b).join(','),
    timestamp,
    lastActive: timestamp,
    registeredAt: String(existing?.registeredAt || timestamp),
  };

  if (eventId) {
    const fresh = await redis.setNX(`event:dedup:${eventId}`, '1', 60 * 60 * 24);
    if (!fresh) return;
  }

  // Persist the event, team state, and leaderboard together over one Redis
  // pipeline round-trip, which reduces write latency during simultaneous solves.
  const writeCommands: Array<Array<string | number>> = [
    ['HSET', 'pykachu:logs', rowId, JSON.stringify(nextRow)],
  ];
  if (tid) {
    const hintsSet = new Set<number>(sameEpoch?.hintsUsed || []);
    if ((action === 'HINT_USED' || evt.hintUsed) && puzzleId > 0) hintsSet.add(puzzleId);

    const updated: StoredTeamProgress = {
      tid,
      teamName: teamName || sameEpoch?.teamName || tid,
      mission: String(evt.mission || sameEpoch?.mission || ''),
      language: String(evt.language || sameEpoch?.language || 'PYTHON'),
      sessionId: String(evt.sessionId || sameEpoch?.sessionId || ''),
      score: nextScore,
      solved: Array.from(solvedSet).sort((a, b) => a - b),
      unlocked: Array.from(unlockedSet).sort((a, b) => a - b),
      hintsUsed: Array.from(hintsSet).sort((a, b) => a - b),
      currentPuzzle: puzzleId || sameEpoch?.currentPuzzle || 0,
      tabSwitches: Math.max(sameEpoch?.tabSwitches || 0, Math.min(10000, Number(evt.tabSwitches || 0))),
      epoch: currentEpoch,
      registeredAt: sameEpoch?.registeredAt || timestamp,
      updatedAt: timestamp,
    };

    writeCommands.push(
      ['SET', teamKey, JSON.stringify(updated), 'EX', 60 * 60 * 24 * 7],
      ['ZADD', 'pykachu:leaderboard', updated.score, `${tid}:${updated.teamName}`]
    );
    leaderboardHotCache = null;
  }
  await redis.pipeline(writeCommands);
}

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');

  // 2G Optimization: Compress all responses aggressively
  app.use(
    compression({
      threshold: 512,
      level: 6,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  // Health & Infrastructure Inspection
  app.get('/api/health', async (_req: Request, res: Response) => {
    const [redisStats, epoch] = await Promise.all([redis.stats(), getCurrentEpoch()]);
    res.json({
      ok: true,
      epoch,
      redis: redisStats,
      sharedStateReady: redis.backend === 'upstash-rest' && redisStats.connected,
      loadBalancer: lb.getSnapshot(),
      webpMemoryCachedCount: webpMemoryCache.size,
      webpMemoryCacheBytes,
    });
  });

  // Single-RTT 2G Bootstrap Endpoint with ETag & Redis Caching
  app.get('/api/bootstrap', async (req: Request, res: Response) => {
    try {
      const epoch = await getCurrentEpoch();
      const catalogRevision = ['config.json', 'meme.json', 'puzzle.json'].map((file) => {
        try {
          const stat = fs.statSync(path.join(PUBLIC_DIR, 'data', file));
          return `${file}:${stat.mtimeMs}:${stat.size}`;
        } catch {
          return `${file}:missing`;
        }
      }).join('|');
      const hotKey = `${catalogRevision}:${epoch}`;
      let payload = bootstrapHotCache?.key === hotKey && bootstrapHotCache.expiresAt > Date.now()
        ? bootstrapHotCache.payload
        : null;

      if (!payload) {
        payload = await lb.coalesce(`bootstrap:${hotKey}`, async () => {
          if (bootstrapHotCache?.key === hotKey && bootstrapHotCache.expiresAt > Date.now()) {
            return bootstrapHotCache.payload;
          }
          const bootstrapKey = `pykachu:bootstrap:v3:${catalogRevision}`;
          const cached = await redis.get(bootstrapKey);
          if (cached) {
            const parsed = JSON.parse(cached) as Record<string, unknown>;
            const snapshot = { ...parsed, epoch };
            bootstrapHotCache = { key: hotKey, expiresAt: Date.now() + 30_000, payload: snapshot };
            return snapshot;
          }
          const config = readJsonFile('data/config.json', {});
          const puzzles = readJsonFile('data/puzzle.json', []);
          const memes = readJsonFile('data/meme.json', []);
          const teams = readJsonFile<Array<unknown>>('data/teams.json', []);
          const snapshot = {
            puzzles,
            memes,
            config,
            teamsCount: Array.isArray(teams) ? teams.length : 0,
            catalogVersion: 3,
            epoch,
          };
          await redis.set(bootstrapKey, JSON.stringify(snapshot), 300);
          bootstrapHotCache = { key: hotKey, expiresAt: Date.now() + 30_000, payload: snapshot };
          return snapshot;
        });
      }

      const bodyStr = JSON.stringify(payload);
      const etag = `"${crypto.createHash('sha1').update(bodyStr).digest('hex').slice(0, 16)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5, stale-while-revalidate=30');
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.type('application/json').send(bodyStr);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Bootstrap failed' });
    }
  });

  // Server-computed sprite alignment metadata (avoids client-side canvas getImageData readback lag)
  app.get('/api/pokemon/:id/align', async (req: Request, res: Response) => {
    const id = Math.floor(Number(req.params.id));
    if (!id || Number.isNaN(id) || id < 1 || id > 1025) {
      res.json({ ok: true, align: { tx: '0%', ty: '12%', scale: 1 } });
      return;
    }
    let align = await getSpriteAlignMeta(id);
    if (!align) {
      await lb.coalesce(`pokemon:lite3d:${id}`, () => fetchAndConvertPokemonWebp(id, 'lite'));
      align = await getSpriteAlignMeta(id);
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ ok: true, align: align || { tx: '0%', ty: '12%', scale: 1 } });
  });

  // Pokémon WebP Endpoint (converts & caches compact 16fps anim / 2G lite / static silhouette WebP in Redis + memory)
  app.get('/api/pokemon/:id.webp', async (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    const rawId = String(req.params.id || '').replace(/\.webp$/i, '');
    const id = Math.floor(Number(rawId));
    if (!id || Number.isNaN(id) || id < 1 || id > 1025) {
      res.status(404).end();
      return;
    }

    const isSil = req.query.sil === '1' || req.query.sil === 'true';
    const isLite = req.query.lite === '1' || req.query.lite === 'true';
    const variant: PokemonWebpVariant = isSil ? 'sil' : isLite ? 'lite' : 'anim';
    const tagPrefix = variant === 'sil' ? 'sil3d' : variant === 'lite' ? 'lite3d' : 'anim3d';
    const cacheTag = `${tagPrefix}:${id}`;
    try {
      const wasHit = webpMemoryCache.has(cacheTag);
      const webpBuf = await lb.coalesce(`pokemon:${cacheTag}`, () =>
        fetchAndConvertPokemonWebp(id, variant)
      );
      if (webpBuf.length === 0) {
        res.status(502).end();
        return;
      }
      const align = await getSpriteAlignMeta(id);
      if (align) {
        res.setHeader('X-Sprite-Align', `${align.tx},${align.ty},${align.scale}`);
        res.setHeader('Access-Control-Expose-Headers', 'X-Sprite-Align, X-Cache-Store');
      }
      res.setHeader('Content-Type', getArtworkContentType(webpBuf));
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Cache-Store', wasHit ? 'HIT' : 'FILL');
      res.send(webpBuf);
    } catch {
      res.status(502).end();
    }
  });

  // Register / Restore Team State via Redis (+ Apps Script upstream if configured)
  app.post('/api/team/state', async (req: Request, res: Response) => {
    try {
      const tid = String(req.body?.tid || '').trim().toUpperCase().slice(0, 32);
      const teamName = String(req.body?.teamName || '').trim().slice(0, 60);
      const sessionId = String(req.body?.sessionId || '').trim().slice(0, 64);
      const epoch = await getCurrentEpoch();

      if (!tid) {
        res.status(400).json({ ok: false, error: 'Missing tid' });
        return;
      }

      const raw = await redis.get(`pykachu:team:${tid}`);
      let state = raw ? (JSON.parse(raw) as StoredTeamProgress) : null;
      if (state && state.epoch !== epoch) {
        state = null;
      }

      // Redis is the hot source of truth for active teams. Only query Sheets
      // for a cold team cache; avoid one Apps Script request per returning team.
      if (!state && lb.hasUpstreams()) {
        try {
          const remote = (await lb.coalesce(`team-state:${tid}`, () =>
            lb.forwardPost({ action: 'GET_TEAM_STATE', tid, teamName, sessionId }, 3000)
          )) as Record<string, unknown>;
          const remoteEpoch = Number(remote?.epoch || epoch);
          if (remoteEpoch === epoch && remote) {
            const solved = Array.isArray(remote.solved) ? remote.solved.map(Number).filter((n) => n > 0) : [];
            const hintsUsed = Array.isArray(remote.hintsUsed)
              ? remote.hintsUsed.map(Number).filter((n) => n > 0)
              : [];
            state = {
              tid,
              teamName: teamName || tid,
              mission: '',
              language: 'PYTHON',
              sessionId,
              score: Math.max(0, Number(remote.score || 0)),
              solved: Array.from(new Set(solved)).sort((a, b) => a - b),
              unlocked: [],
              hintsUsed: Array.from(new Set(hintsUsed)).sort((a, b) => a - b),
              currentPuzzle: Number(remote.currentPuzzle || 0),
              tabSwitches: Math.max(0, Number(remote.tabSwitches || 0)),
              epoch,
              registeredAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            await redis.set(`pykachu:team:${tid}`, JSON.stringify(state), 60 * 60 * 24 * 7);
          }
        } catch {
          // Graceful Redis-only fallback when remote upstream is unavailable
        }
      }

      res.json({ ok: true, epoch, state });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'State error' });
    }
  });

  // Batch & Single Telemetry Ingestion (Idempotent Redis + Load-Balanced Write-Behind)
  app.post('/api/telemetry', async (req: Request, res: Response) => {
    try {
      const now = Date.now();
      const body = (req.body || {}) as Record<string, unknown>;
      const events: Array<Record<string, unknown>> =
        body.action === 'SESSION_BATCH' && Array.isArray(body.events)
          ? (body.events as Array<Record<string, unknown>>)
          : [body];

      if (events.length > 50 || events.some((evt) => !evt || typeof evt !== 'object' || Array.isArray(evt))) {
        res.status(400).json({ ok: false, error: 'Invalid telemetry batch' });
        return;
      }
      const allowedActions = new Set([
        'REGISTRATION', 'SUMMARY', 'SOLVED', 'PUZZLE_ABANDONED', 'WRONG_ATTEMPT',
        'HINT_USED', 'PENALTY_TRIGGERED', 'QR_SCANNED', 'QR_BLOCKED',
        'PUZZLE_UNLOCKED', 'UNLOCK_FAILED',
      ]);
      if (events.some((evt) => !allowedActions.has(String(evt.action || 'SUMMARY').trim().toUpperCase()))) {
        res.status(400).json({ ok: false, error: 'Unknown telemetry action' });
        return;
      }

      const clientKey = String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 80);
      const teamId = String(body.tid || events[0]?.tid || '').trim().toUpperCase().slice(0, 32);
      const rateKeys = teamId
        ? [[`team:${teamId}`, 120], [`ip:${clientKey}`, 12_000]] as const
        : [[`ip:${clientKey}`, 120]] as const;
      let rateLimited = false;
      for (const [key, limit] of rateKeys) {
        const window = telemetryRateWindows.get(key);
        const currentWindow = !window || now - window.startedAt >= 60_000
          ? { startedAt: now, count: 0 }
          : window;
        currentWindow.count += 1;
        telemetryRateWindows.set(key, currentWindow);
        if (currentWindow.count > limit) rateLimited = true;
      }
      if (rateLimited) {
        res.status(429).json({ ok: false, error: 'Telemetry rate limit exceeded' });
        return;
      }
      if (telemetryRateWindows.size > 5000) {
        for (const [key, value] of telemetryRateWindows) {
          if (now - value.startedAt >= 120_000) telemetryRateWindows.delete(key);
        }
      }

      const epoch = await getCurrentEpoch();

      for (const evt of events) {
        await processTelemetryEvent(evt, epoch);
      }

      if (lb.hasUpstreams()) {
        lb.enqueueTelemetry(events);
      }

      res.json({ ok: true, accepted: events.length, epoch });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Telemetry error' });
    }
  });

  // Epoch Lookup
  app.get('/api/epoch', async (_req: Request, res: Response) => {
    const epoch = await getCurrentEpoch();
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1, stale-while-revalidate=2');
    res.json({ ok: true, epoch });
  });

  // Leaderboard (from Redis Sorted Set)
  app.get('/api/leaderboard', async (_req: Request, res: Response) => {
    let payload = leaderboardHotCache?.expiresAt && leaderboardHotCache.expiresAt > Date.now()
      ? leaderboardHotCache.payload
      : null;
    if (!payload) {
      payload = await lb.coalesce('leaderboard:snapshot', async () => {
        if (leaderboardHotCache && leaderboardHotCache.expiresAt > Date.now()) {
          return leaderboardHotCache.payload;
        }
        const [entries, epoch] = await Promise.all([
          redis.zrevrangeWithScores('pykachu:leaderboard', 0, 49),
          getCurrentEpoch(),
        ]);
        const snapshot = {
          ok: true,
          epoch,
          entries: entries.map((entry, idx) => {
            const [tid, ...rest] = entry.member.split(':');
            return { rank: idx + 1, tid, teamName: rest.join(':') || tid, score: entry.score };
          }),
        };
        leaderboardHotCache = { payload: snapshot, expiresAt: Date.now() + 2000 };
        return snapshot;
      });
    }
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=2, stale-while-revalidate=3');
    res.json(payload);
  });

  // Admin Logs & Epoch Snapshot
  app.post('/api/admin/auth', async (req: Request, res: Response) => {
    const name = String(req.body?.name || '').trim();
    const password = String(req.body?.password || '').trim();
    if (!isValidAdminLogin(name, password)) {
      res.status(401).json({ ok: false });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/admin/logs', async (req: Request, res: Response) => {
    const adminKey = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!isValidAdminPassword(adminKey)) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    const epoch = await getCurrentEpoch();

    if (lb.hasUpstreams()) {
      try {
        const remote = (await lb.coalesce(`admin_logs:${adminKey}`, () =>
          lb.forwardGet('ADMIN_GET_DATA', { adminKey: adminKey || undefined }, 10_000)
        )) as Record<string, unknown> | unknown[];
        const remoteLogs = Array.isArray(remote)
          ? remote
          : Array.isArray(remote?.logs)
            ? remote.logs
            : null;
        if (remoteLogs) {
          const localHash = await redis.hgetall('pykachu:logs');
          const combined = new Map<string, Record<string, unknown>>();
          remoteLogs.forEach((entry, index) => {
            if (entry && typeof entry === 'object') {
              const row = entry as Record<string, unknown>;
              combined.set(String(row.id || `${row.tid || index}_${row.puzzleId || 0}`), row);
            }
          });
          Object.values(localHash).forEach((value) => {
            try {
              const row = JSON.parse(value) as Record<string, unknown>;
              combined.set(String(row.id || `${row.tid || ''}_${row.puzzleId || 0}`), row);
            } catch {
              // Skip malformed Redis rows.
            }
          });
          res.json({
            ok: true,
            epoch: Array.isArray(remote) ? epoch : Math.max(epoch, Number(remote.epoch || epoch)),
            logs: Array.from(combined.values()),
            source: 'upstream+redis',
          });
          return;
        }
      } catch {
        // Fall through to Redis snapshot
      }
    }

    const rawHash = await redis.hgetall('pykachu:logs');
    const logs = Object.values(rawHash)
      .map((s) => {
        try {
          return JSON.parse(s) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => Boolean(x));

    res.json({ ok: true, epoch, logs, source: 'redis' });
  });

  // Admin Reset Epoch
  app.post('/api/admin/reset', async (req: Request, res: Response) => {
    const adminKey = String(req.body?.adminKey || '').trim();
    if (!isValidAdminPassword(adminKey)) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    const curEpoch = await getCurrentEpoch();
    let nextEpoch = Math.min(1_000_000, curEpoch + 1);

    await redis.del('pykachu:logs');
    await redis.del('pykachu:leaderboard');
    await redis.deleteByPrefix('pykachu:team:');
    await redis.deleteByPrefix('event:dedup:');

    if (lb.hasUpstreams()) {
      try {
        const remote = (await lb.forwardPost({
          action: 'RESET_ALL',
          adminKey: adminKey || undefined,
        })) as Record<string, unknown>;
        const re = Number(remote?.epoch || 0);
        if (Number.isFinite(re) && re > 0) nextEpoch = Math.max(nextEpoch, Math.floor(re));
      } catch {
        // continue with local epoch bump
      }
    }

    await redis.set('pykachu:epoch', String(nextEpoch));
    epochCache = { value: nextEpoch, expiresAt: Date.now() + 1000 };
    bootstrapHotCache = null;
    leaderboardHotCache = null;
    res.json({ ok: true, epoch: nextEpoch });
  });

  // Static Asset Caching Middleware for 2G Devices
  app.use(
    '/assets',
    express.static(path.join(PUBLIC_DIR, 'assets'), {
      maxAge: IS_PROD ? '7d' : '1d',
      setHeaders(res) {
        if (IS_PROD) res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=2592000');
      },
    })
  );

  app.use(
    '/data',
    express.static(path.join(PUBLIC_DIR, 'data'), {
      maxAge: '60s',
      setHeaders(res, filePath) {
        if (path.basename(filePath) === 'admin.json') {
          res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
          return;
        }
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
      },
    })
  );

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(
      express.static(DIST_DIR, {
        maxAge: '365d',
        immutable: true,
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Pykachu Go] Server listening on http://0.0.0.0:${PORT} (${IS_PROD ? 'prod' : 'dev'})`);
    if (IS_PROD && redis.backend !== 'upstash-rest') {
      console.warn('[Capacity] Shared Redis is not configured; this instance cannot safely share game state across replicas.');
    }
    setTimeout(() => {
      void prewarmPokemonCatalog();
    }, 250);
  });
}

void startServer();
