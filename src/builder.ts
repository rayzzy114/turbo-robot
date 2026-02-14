import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { fileURLToPath } from 'url';
import { createHash, randomBytes, randomInt } from 'crypto';
import { OrderConfig } from './bot_helpers.js';

const execAsync = util.promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// We are in src/, so root is one level up
const ROOT_DIR = path.resolve(__dirname, '..');

const PREVIEWS_DIR = path.join(ROOT_DIR, 'previews');
const TEMP_DIR = path.join(ROOT_DIR, 'temp');
const DEPS_CACHE_ROOT = path.join(TEMP_DIR, "_deps_cache");
const BUILD_TIMEOUT_MS = 120_000;
const BUILD_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const DEPS_INSTALL_TIMEOUT_MS = 300_000;
const PROTECTION_TIMEOUT_MS = 300_000;
const MAX_BUILD_QUEUE_SIZE = 20;
const PREVIEW_MAX_INTERACTIONS = 4;
const ASSET_PATH_REGEX = /(?:\.\/|\/)?(?!https?:\/\/|data:|\/\/)[^"'`()<>]+\.(?:png|jpe?g|webp|gif|svg|mp3|ogg|wav|m4a|webm|json|woff2?|ttf)(?:\?[a-zA-Z0-9=%&._-]+)?(?:#[a-zA-Z0-9=%&._-]+)?/gi;
const RAILROAD_THEME_REQUIRED_ASSETS: Record<string, string[]> = {
    chicken_farm: [
        "assets/ground_tile.webp",
        "assets/railroad.webp",
        "assets/platform.webp",
        "assets/idle.gif",
        "assets/death.gif",
        "assets/train.webp",
        "assets/coin_small.webp",
        "assets/scroll_body.webp",
        "assets/audio/main_theme.ogg",
        "assets/audio/move.ogg",
        "assets/audio/pn.ogg",
        "assets/audio/big_win.ogg",
    ],
    cyber_city: [
        "assets/cyber/ground.webp",
        "assets/cyber/rail.webp",
        "assets/cyber/platform.webp",
        "assets/cyber/robot_idle.png",
        "assets/cyber/robot_jump.png",
        "assets/cyber/explosion.png",
        "assets/cyber/car.webp",
        "assets/cyber/chip.webp",
        "assets/cyber/holo_panel.webp",
        "assets/audio/cyber_theme.ogg",
        "assets/audio/laser_jump.ogg",
        "assets/audio/glitch.ogg",
        "assets/audio/cyber_win.ogg",
    ],
};

type TemplateBuildConfig = {
    templateDirName: string;
    buildCommand: string | null;
    requiredBins: string[];
    outputHtmlRelativePath: string;
    configMode: "railroad" | "runtime";
};

type ResolutionCheck = {
    relativePath: string;
    patterns: Array<{
        regex: RegExp;
        description: string;
    }>;
};

const TEMPLATE_BY_GAME: Record<string, TemplateBuildConfig> = {
    railroad: {
        templateDirName: "railroad",
        buildCommand: "npm run build",
        requiredBins: ["tsc", "vite"],
        outputHtmlRelativePath: path.join("dist", "index.html"),
        configMode: "railroad",
    },
    olympus: {
        templateDirName: "gate_of_olympus",
        buildCommand: "node build-release.js",
        requiredBins: [],
        outputHtmlRelativePath: path.join("release", "index.html"),
        configMode: "runtime",
    },
    matching: {
        templateDirName: "matching",
        buildCommand: "npm run build",
        requiredBins: ["vite"],
        outputHtmlRelativePath: path.join("dist", "index.html"),
        configMode: "runtime",
    },
    match3: {
        templateDirName: "3_v_ryad",
        buildCommand: "npm run build",
        requiredBins: ["vite"],
        outputHtmlRelativePath: path.join("dist", "index.html"),
        configMode: "runtime",
    },
};

const LIBRARY_GAME_ID_BY_KEY: Record<string, string> = {
    railroad: "game_railroad",
    olympus: "game_olympus",
    matching: "game_drag",
    match3: "game_match3",
};

const TEMPLATE_RESOLUTION_CHECKS: Record<string, ResolutionCheck[]> = {
    railroad: [
        {
            relativePath: path.join("src", "Game.ts"),
            patterns: [
                { regex: /width:\s*1080\b/, description: "Pixi width is 1080" },
                { regex: /height:\s*1920\b/, description: "Pixi height is 1920" },
            ],
        },
    ],
    matching: [
        {
            relativePath: path.join("src", "config.js"),
            patterns: [
                { regex: /width:\s*1080\b/, description: "Design width is 1080" },
                { regex: /height:\s*1920\b/, description: "Design height is 1920" },
            ],
        },
    ],
    "3_v_ryad": [
        {
            relativePath: path.join("src", "main.js"),
            patterns: [
                { regex: /const\s+DESIGN_W\s*=\s*1080\b/, description: "DESIGN_W is 1080" },
                { regex: /const\s+DESIGN_H\s*=\s*1920\b/, description: "DESIGN_H is 1920" },
            ],
        },
    ],
    gate_of_olympus: [
        {
            relativePath: path.join("dev", "scripts", "game.js"),
            patterns: [
                { regex: /const\s+DESIGN_WIDTH\s*=\s*1080\b/, description: "DESIGN_WIDTH is 1080" },
                { regex: /const\s+DESIGN_HEIGHT\s*=\s*1920\b/, description: "DESIGN_HEIGHT is 1920" },
            ],
        },
        {
            relativePath: path.join("dev", "styles", "main.css"),
            patterns: [
                { regex: /--design-width:\s*1080\b/, description: "CSS --design-width is 1080" },
                { regex: /--design-height:\s*1920\b/, description: "CSS --design-height is 1920" },
            ],
        },
    ],
};

const depsCachePromises = new Map<string, Promise<string>>();

async function runByteHideShield(filePath: string): Promise<void> {
    const token = process.env.BYTEHIDE_SHIELD_TOKEN?.trim();
    if (!token) return;

    const configPath = process.env.BYTEHIDE_SHIELD_CONFIG?.trim() || "shield.config.json";
    const command = `npx @bytehide/shield-cli protect "${filePath}" --token "${token}" --config "${configPath}" --output "${filePath}"`;
    await execAsync(command, {
        cwd: ROOT_DIR,
        timeout: PROTECTION_TIMEOUT_MS,
        maxBuffer: BUILD_MAX_BUFFER_BYTES,
    });
    console.log(`[Builder] ByteHide Shield applied: ${path.basename(filePath)}`);
}

async function runFreeObfuscator(filePath: string): Promise<void> {
    const enabled = process.env.FREE_OBFUSCATOR_ENABLED === "1";
    if (!enabled) return;

    const binName = process.platform === "win32" ? "javascript-obfuscator.cmd" : "javascript-obfuscator";
    const localBin = path.join(ROOT_DIR, "node_modules", ".bin", binName);
    const hasLocalBin = await fs
        .access(localBin, fsConstants.F_OK)
        .then(() => true)
        .catch(() => false);
    if (!hasLocalBin) {
        console.warn("[Builder] FREE_OBFUSCATOR_ENABLED=1 but javascript-obfuscator is not installed locally. Skipping.");
        return;
    }

    const command = [
        `"${localBin}"`,
        `"${filePath}"`,
        "--output", `"${filePath}"`,
        "--compact", "true",
        "--control-flow-flattening", "true",
        "--control-flow-flattening-threshold", "0.75",
        "--dead-code-injection", "true",
        "--dead-code-injection-threshold", "0.4",
        "--string-array", "true",
        "--string-array-encoding", "base64",
        "--string-array-threshold", "1",
        "--identifier-names-generator", "hexadecimal",
        "--self-defending", "true",
        "--simplify", "true",
        "--split-strings", "true",
        "--split-strings-chunk-length", "6",
    ].join(" ");
    await execAsync(command, {
        cwd: ROOT_DIR,
        timeout: PROTECTION_TIMEOUT_MS,
        maxBuffer: BUILD_MAX_BUFFER_BYTES,
    });
    console.log(`[Builder] Free obfuscator applied: ${path.basename(filePath)}`);
}

async function applyExternalProtections(filePath: string): Promise<void> {
    try {
        await runByteHideShield(filePath);
    } catch (error) {
        console.error("[Builder] ByteHide Shield failed:", error);
    }
    try {
        await runFreeObfuscator(filePath);
    } catch (error) {
        console.error("[Builder] Free obfuscator failed:", error);
    }
}

function isBuildTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const execError = error as { message?: string; killed?: boolean; signal?: string | number };
    const message = String(execError.message ?? "").toLowerCase();
    if (message.includes("timed out")) return true;
    return execError.killed === true && execError.signal === "SIGTERM";
}

function getMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    if (ext === ".gif") return "image/gif";
    if (ext === ".svg") return "image/svg+xml";
    if (ext === ".mp3") return "audio/mpeg";
    if (ext === ".ogg") return "audio/ogg";
    if (ext === ".wav") return "audio/wav";
    if (ext === ".m4a") return "audio/mp4";
    if (ext === ".webm") return "video/webm";
    if (ext === ".json") return "application/json";
    if (ext === ".woff") return "font/woff";
    if (ext === ".woff2") return "font/woff2";
    if (ext === ".ttf") return "font/ttf";
    return null;
}

function shouldReplaceWithInlinePlaceholder(normalizedAssetPath: string): boolean {
    return (
        normalizedAssetPath.startsWith("assets/cyber/") ||
        normalizedAssetPath.startsWith("assets/audio/cyber_") ||
        normalizedAssetPath === "assets/audio/laser_jump.ogg" ||
        normalizedAssetPath === "assets/audio/glitch.ogg"
    );
}

function buildEmptyDataUri(assetPath: string): string {
    const mime = getMimeType(assetPath) ?? "application/octet-stream";
    return `data:${mime};base64,`;
}

type InlineAssetOptions = {
    isPreview: boolean;
    gameKey: string;
};

function isHighValuePreviewAsset(normalizedAssetPath: string, gameKey: string): boolean {
    const lower = normalizedAssetPath.toLowerCase();
    if (gameKey !== "olympus") return false;
    if (/\.(mp3|ogg|wav|m4a)$/i.test(lower)) return true;
    return false;
}

function buildPreviewPlaceholderDataUri(assetPath: string): string {
    const lower = assetPath.toLowerCase();
    if (/\.(png|webp|gif|jpe?g|svg)$/i.test(lower)) {
        // 1x1 transparent PNG
        return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    }
    return buildEmptyDataUri(assetPath);
}

function buildTrashWatermarkedImageDataUri(): string {
    const tinyNoise =
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAIUlEQVR42mNgQAX/Gf4zQAFjYGBg+M8ABYwMDAyMDAwAAG0hBCE4xY0zAAAAAElFTkSuQmCC";
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <filter id="px" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
  </defs>
  <rect width="1080" height="1920" fill="#111"/>
  <image href="data:image/png;base64,${tinyNoise}" width="1080" height="1920" preserveAspectRatio="none" filter="url(#px)" opacity="0.85"/>
  <g opacity="0.28">
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#ff2d2d" font-size="132" font-family="Arial, sans-serif" transform="rotate(-24 540 960)">rwbrr</text>
    <text x="50%" y="68%" text-anchor="middle" dominant-baseline="middle" fill="#ff2d2d" font-size="132" font-family="Arial, sans-serif" transform="rotate(-24 540 1305)">rwbrr</text>
    <text x="50%" y="32%" text-anchor="middle" dominant-baseline="middle" fill="#ff2d2d" font-size="132" font-family="Arial, sans-serif" transform="rotate(-24 540 615)">rwbrr</text>
  </g>
</svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}

async function inlineLocalAssetsInHtml(htmlPath: string, workDir: string, options: InlineAssetOptions): Promise<void> {
    const html = await fs.readFile(htmlPath, "utf-8");
    const refs = html.match(ASSET_PATH_REGEX);
    if (!refs || refs.length === 0) return;

    const uniqueRefs = Array.from(new Set(refs));
    let updated = html;
    let replacedCount = 0;
    const unresolvedRefs: string[] = [];

    for (const ref of uniqueRefs) {
        const cleanRef = ref.split("#")[0].split("?")[0];
        const normalized = cleanRef.replace(/^\.?\//, "");
        if (!normalized || normalized.includes("..") || /^(https?:)?\/\//i.test(normalized) || normalized.startsWith("data:")) continue;

        if (options.isPreview && isHighValuePreviewAsset(normalized, options.gameKey)) {
            updated = updated.split(ref).join(buildPreviewPlaceholderDataUri(normalized));
            replacedCount++;
            continue;
        }

        const assetPath = path.join(workDir, normalized);
        const assetExists = await fs
            .access(assetPath, fsConstants.F_OK)
            .then(() => true)
            .catch(() => false);
        if (!assetExists) {
            if (shouldReplaceWithInlinePlaceholder(normalized)) {
                updated = updated.split(ref).join(buildEmptyDataUri(normalized));
                replacedCount++;
                continue;
            }
            unresolvedRefs.push(ref);
            continue;
        }

        const mimeType = getMimeType(assetPath);
        if (!mimeType) {
            if (shouldReplaceWithInlinePlaceholder(normalized)) {
                updated = updated.split(ref).join(buildEmptyDataUri(normalized));
                replacedCount++;
                continue;
            }
            unresolvedRefs.push(ref);
            continue;
        }

        let dataUri: string;
        if (options.isPreview && /^image\//.test(mimeType)) {
            dataUri = buildTrashWatermarkedImageDataUri();
        } else if (options.isPreview && /^audio\//.test(mimeType)) {
            dataUri = buildEmptyDataUri(normalized);
        } else {
            const payload = await fs.readFile(assetPath);
            const base64 = payload.toString("base64");
            dataUri = `data:${mimeType};base64,${base64}`;
        }

        if (updated.includes(ref)) {
            updated = updated.split(ref).join(dataUri);
            replacedCount++;
        }
    }

    if (replacedCount > 0 && updated !== html) {
        await fs.writeFile(htmlPath, updated, "utf-8");
        if (options.isPreview) {
            console.log(`[Builder] Inlined/stripped ${replacedCount} asset reference(s) for preview in ${path.basename(htmlPath)}.`);
        } else {
            console.log(`[Builder] Inlined ${replacedCount} local asset reference(s) into ${path.basename(htmlPath)}.`);
        }
    }

    if (unresolvedRefs.length > 0) {
        const sample = Array.from(new Set(unresolvedRefs)).slice(0, 5).join(", ");
        console.warn(`[Builder] Unresolved asset references (${unresolvedRefs.length}): ${sample}`);
    }
}

function resolveTemplateConfig(game: string | undefined): TemplateBuildConfig {
    if (game && TEMPLATE_BY_GAME[game]) return TEMPLATE_BY_GAME[game];
    return TEMPLATE_BY_GAME.railroad;
}

async function validateRailroadThemeAssets(workDir: string, themeId: string | undefined): Promise<void> {
    const selectedTheme =
        themeId && RAILROAD_THEME_REQUIRED_ASSETS[themeId]
            ? themeId
            : "chicken_farm";
    const requiredAssets = RAILROAD_THEME_REQUIRED_ASSETS[selectedTheme];
    const missingAssets: string[] = [];

    for (const relPath of requiredAssets) {
        const normalized = relPath.replace(/^\.?\//, "");
        const absolutePath = path.join(workDir, normalized);
        const exists = await fs
            .access(absolutePath, fsConstants.F_OK)
            .then(() => true)
            .catch(() => false);
        if (!exists) missingAssets.push(relPath);
    }

    if (missingAssets.length === 0) return;

    const sample = missingAssets.slice(0, 8).join(", ");
    const suffix = missingAssets.length > 8 ? ` (+${missingAssets.length - 8} more)` : "";
    throw new Error(`[Builder] Missing required assets for theme ${selectedTheme}: ${sample}${suffix}`);
}

async function hasAllDevDeps(nodeModulesDir: string, packageJsonPath: string): Promise<boolean> {
    try {
        const raw = await fs.readFile(packageJsonPath, "utf-8");
        const pkg = JSON.parse(raw) as { devDependencies?: Record<string, string> };
        const devDeps = Object.keys(pkg.devDependencies ?? {});
        if (devDeps.length === 0) return true;
        for (const dep of devDeps) {
            const depPath = path.join(nodeModulesDir, ...dep.split("/"));
            const depManifest = path.join(depPath, "package.json");
            try {
                await fs.access(depManifest, fsConstants.F_OK);
            } catch {
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

async function hasBin(nodeModulesDir: string, bin: string): Promise<boolean> {
    const candidates = [bin, `${bin}.cmd`, `${bin}.ps1`, `${bin}.exe`];
    for (const candidate of candidates) {
        const binPath = path.join(nodeModulesDir, ".bin", candidate);
        try {
            await fs.access(binPath, fsConstants.F_OK);
            return true;
        } catch {}
    }
    return false;
}

async function hasBuildBins(nodeModulesDir: string, bins: string[]): Promise<boolean> {
    try {
        for (const bin of bins) {
            if (!(await hasBin(nodeModulesDir, bin))) {
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

async function ensureDepsCache(templateDir: string, requiredBins: string[]): Promise<string> {
    const cacheKey = `${path.basename(templateDir)}__${requiredBins.join("_") || "none"}`;
    const existingPromise = depsCachePromises.get(cacheKey);
    if (existingPromise) return existingPromise;

    const createdPromise = (async () => {
        const cacheDir = path.join(DEPS_CACHE_ROOT, cacheKey);
        await fs.mkdir(cacheDir, { recursive: true });

        const cachePackageJson = path.join(cacheDir, "package.json");
        const templatePackageJson = path.join(templateDir, "package.json");
        const templatePkg = await fs.readFile(templatePackageJson, "utf-8");
        await fs.writeFile(cachePackageJson, templatePkg, "utf-8");

        const cacheNodeModules = path.join(cacheDir, "node_modules");
        let needsInstall = true;
        try {
            await fs.access(cacheNodeModules, fsConstants.F_OK);
            needsInstall = false;
        } catch {}

        if (!needsInstall) {
            const devDepsOk = await hasAllDevDeps(cacheNodeModules, cachePackageJson);
            const binsOk = await hasBuildBins(cacheNodeModules, requiredBins);
            if (!devDepsOk || !binsOk) needsInstall = true;
        }

        if (needsInstall) {
            console.log(`[Builder] Installing dependency cache for ${path.basename(templateDir)}...`);
            await execAsync(`npm install --no-audit --no-fund --include=dev`, {
                cwd: cacheDir,
                timeout: DEPS_INSTALL_TIMEOUT_MS,
                maxBuffer: BUILD_MAX_BUFFER_BYTES,
            });
        }

        return cacheNodeModules;
    })();

    depsCachePromises.set(cacheKey, createdPromise);
    return createdPromise;
}

// Build Queue Configuration
const MAX_CONCURRENT_BUILDS = 2;
let activeBuilds = 0;
const buildQueue: (() => void)[] = [];

/**
 * Cleans up the entire temp directory on startup.
 */
export async function cleanupTemp() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
        const entries = await fs.readdir(TEMP_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === path.basename(DEPS_CACHE_ROOT)) continue;
            const targetPath = path.join(TEMP_DIR, entry.name);
            await fs.rm(targetPath, { recursive: true, force: true });
        }
        await fs.mkdir(TEMP_DIR, { recursive: true });
    } catch (e) {
        console.error("[Builder] Cleanup error:", e);
    }
}

// Ensure previews folder exists
(async () => {
    try {
        await fs.mkdir(PREVIEWS_DIR, { recursive: true });
    } catch (e) {}
})();

interface Order {
    id: string;
    config: OrderConfig & { isWatermarked: boolean };
}

function toRuntimeConfig(config: OrderConfig & { isWatermarked: boolean }) {
    const runtimeConfig: Record<string, unknown> = {
        game: config.game ?? "railroad",
        themeId: config.themeId ?? "default",
        language: config.language ?? "en",
        currency: config.currency ?? "$",
        startingBalance: config.startingBalance ?? 1000,
        isWatermarked: config.isWatermarked,
        previewMaxInteractions: PREVIEW_MAX_INTERACTIONS,
    };

    const extra = config as unknown as Record<string, unknown>;
    if (typeof extra.clickUrl === "string" && extra.clickUrl.trim()) {
        runtimeConfig.clickUrl = extra.clickUrl;
    }
    if (typeof extra.targetBalance === "number" && Number.isFinite(extra.targetBalance)) {
        runtimeConfig.targetBalance = extra.targetBalance;
    }

    return runtimeConfig;
}

function buildPreviewGuardPayload(config: Record<string, unknown>): string {
    const fields = [
        String(config.game ?? ""),
        String(config.themeId ?? ""),
        String(config.language ?? ""),
        String(config.currency ?? ""),
        String(config.startingBalance ?? ""),
        String(config.previewMaxInteractions ?? ""),
        String(config.isWatermarked ?? ""),
        String(config.clickUrl ?? ""),
        "guard_v2",
    ];
    return fields.join("|");
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

async function injectRuntimeConfig(htmlPath: string, runtimeConfig: Record<string, unknown>) {
    const html = await fs.readFile(htmlPath, "utf-8");
    const isWatermarked = Boolean(runtimeConfig.isWatermarked);
    const guardSalt = randomBytes(6).toString("hex");
    if (isWatermarked) {
        const payload = buildPreviewGuardPayload(runtimeConfig);
        runtimeConfig.__guardSig = sha256Hex(`${payload}|${guardSalt}`);
        runtimeConfig.__guardVer = "v2";
    }
    const json = JSON.stringify(runtimeConfig)
        .replaceAll("<", "\\u003c")
        .replaceAll("-->", "--\\>");
    const script = `<script>(function(){window.__USER_CONFIG__=${json};if(window.__USER_CONFIG__&&typeof window.__USER_CONFIG__.clickUrl==="string"){window.STORE_URL=window.__USER_CONFIG__.clickUrl;}window.__PLAYABLE_DIMENSIONS__={width:1080,height:1920};var GUARD_SALT="${guardSalt}";var WATERMARK_ID="builder-preview-watermark";var STYLE_ID="builder-preview-style";var FINISH_ID="builder-preview-finished";var LOCKED=false;var interactions=0;function ensureStyle(){if(document.getElementById(STYLE_ID))return;var style=document.createElement("style");style.id=STYLE_ID;style.textContent="#"+WATERMARK_ID+"{position:fixed;inset:0;z-index:2147483646;pointer-events:none;display:grid;place-items:center;font:900 42px/1.1 Arial,sans-serif;color:rgba(255,0,0,.28);text-transform:uppercase;letter-spacing:2px;transform:rotate(-24deg);white-space:pre;text-align:center;}#"+FINISH_ID+"{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.82);display:none;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;}#"+FINISH_ID+".show{display:flex;}#"+FINISH_ID+" .msg{max-width:780px;text-align:center;color:#fff;font:800 34px/1.25 Arial,sans-serif;text-transform:uppercase;letter-spacing:1px;text-shadow:0 2px 8px rgba(0,0,0,.4);}";document.head.appendChild(style);}function removeWatermarks(){[WATERMARK_ID,FINISH_ID,"watermark","watermark2","watermark3","watermark-overlay"].forEach(function(id){var el=document.getElementById(id);if(el&&el.parentNode){el.parentNode.removeChild(el);}});document.querySelectorAll(".watermark").forEach(function(el){if(el&&el.parentNode){el.parentNode.removeChild(el);}});}function isBlockedTarget(target){if(!target||!(target instanceof Element))return false;if(target.closest("#"+FINISH_ID))return true;if(target.closest("#"+WATERMARK_ID))return true;return false;}function hardStop(reason){if(LOCKED)return;LOCKED=true;var allButtons=document.querySelectorAll("button,input,select,textarea");allButtons.forEach(function(el){if(el&&("disabled" in el)){try{el.disabled=true;}catch(_){}}});var uiLayer=document.getElementById("ui-layer");if(uiLayer){uiLayer.style.pointerEvents="none";}try{if(window.PIXI&&window.PIXI.Ticker&&window.PIXI.Ticker.shared){window.PIXI.Ticker.shared.stop();}}catch(_){ }try{if(window.app&&window.app.ticker&&typeof window.app.ticker.stop==="function"){window.app.ticker.stop();}}catch(_){ }var finish=document.getElementById(FINISH_ID);if(!finish){finish=document.createElement("div");finish.id=FINISH_ID;var msg=document.createElement("div");msg.className="msg";msg.textContent=String.fromCharCode(1055,1056,1045,1042,1068,1070,32,1054,1050,1054,1053,1063,1045,1053,1054,46,32,1050,1059,1055,1048,1058,1045,32,1055,1054,1051,1053,1059,1070,32,1042,1045,1056,1057,1048,1070,46);finish.appendChild(msg);document.body.appendChild(finish);}finish.classList.add("show");document.dispatchEvent(new CustomEvent("preview:ended",{detail:{reason:reason||"limit"}}));}function sha256Hex(str){if(window.crypto&&window.crypto.subtle&&window.TextEncoder){return window.crypto.subtle.digest("SHA-256",new TextEncoder().encode(str)).then(function(buf){var arr=Array.from(new Uint8Array(buf));return arr.map(function(b){return b.toString(16).padStart(2,"0");}).join("");});}return Promise.resolve("");}function buildGuardPayload(cfg){return [String(cfg.game||""),String(cfg.themeId||""),String(cfg.language||""),String(cfg.currency||""),String(cfg.startingBalance||""),String(cfg.previewMaxInteractions||""),String(cfg.isWatermarked||""),String(cfg.clickUrl||""),"guard_v2"].join("|");}function validateGuard(cfg){if(!cfg||!cfg.isWatermarked)return Promise.resolve(true);if(cfg.__guardVer!=="v2"||typeof cfg.__guardSig!=="string"||!cfg.__guardSig){return Promise.resolve(false);}return sha256Hex(buildGuardPayload(cfg)+"|"+GUARD_SALT).then(function(sig){if(!sig)return false;return sig===cfg.__guardSig;});}function tickInteraction(){if(LOCKED)return;interactions+=1;var cfg=window.__USER_CONFIG__||{};var limit=Number(cfg.previewMaxInteractions||4);if(!Number.isFinite(limit)||limit<1){limit=4;}if(interactions>=limit){setTimeout(function(){hardStop("interaction_limit");},120);}}function ensureWatermark(){if(document.getElementById(WATERMARK_ID))return;var overlay=document.createElement("div");overlay.id=WATERMARK_ID;overlay.textContent="PREVIEW MODE\\nPURCHASE TO UNLOCK";document.body.appendChild(overlay);}function blockDownloadAndEscape(){document.addEventListener("click",function(ev){var el=ev.target instanceof Element?ev.target.closest("a[download],a[href^='blob:']"):null;if(el){ev.preventDefault();ev.stopPropagation();hardStop("download_blocked");}},{capture:true});try{var oldOpen=window.open;window.open=function(){hardStop("window_open_blocked");return null;};Object.defineProperty(window,"open",{configurable:false,writable:false,value:window.open});if(typeof oldOpen==="function"&&String(oldOpen).indexOf("[native code]")===-1){hardStop("open_tampered");}}catch(_){ }}function setupTamperWatch(cfg){var removedCount=0;var lastSig=cfg.__guardSig||"";setInterval(function(){if(LOCKED)return;var finish=document.getElementById(FINISH_ID);if(finish&&finish.classList.contains("show"))return;if(!document.getElementById(WATERMARK_ID)){removedCount+=1;ensureWatermark();if(removedCount>=2){hardStop("watermark_removed");}}if((cfg.__guardSig||"")!==lastSig){hardStop("guard_sig_mutated");}validateGuard(cfg).then(function(ok){if(!ok){hardStop("guard_invalid");}}).catch(function(){hardStop("guard_error");});if((window.outerWidth-window.innerWidth)>220||(window.outerHeight-window.innerHeight)>220){hardStop("devtools_detected");}},1200);}function setupPreviewLimiter(){var cfg=window.__USER_CONFIG__||{};if(!cfg.isWatermarked){removeWatermarks();return;}validateGuard(cfg).then(function(ok){if(!ok){hardStop("guard_invalid_init");return;}try{Object.freeze(cfg);}catch(_){ }ensureStyle();ensureWatermark();blockDownloadAndEscape();setupTamperWatch(cfg);document.addEventListener("pointerdown",function(ev){if(isBlockedTarget(ev.target))return;tickInteraction();},{passive:true,capture:true});document.addEventListener("keydown",function(ev){if(LOCKED)return;if(ev.key!=="Enter"&&ev.key!==" "&&ev.key!=="Spacebar")return;if(isBlockedTarget(document.activeElement))return;tickInteraction();},{capture:true});}).catch(function(){hardStop("guard_boot_error");});}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",setupPreviewLimiter,{once:true});}else{setupPreviewLimiter();}})();</script>`;
    const withConfig = html.includes("</head>")
        ? html.replace("</head>", `${script}</head>`)
        : `${script}\n${html}`;
    await fs.writeFile(htmlPath, withConfig, "utf-8");
}

async function obfuscateInlineScriptsInHtml(htmlPath: string): Promise<void> {
    const html = await fs.readFile(htmlPath, "utf-8");
    let changed = false;

    const obfuscated = html.replace(
        /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
        (full, attrsRaw: string, contentRaw: string) => {
            const attrs = String(attrsRaw ?? "");
            const content = String(contentRaw ?? "");
            if (!content.trim()) return full;
            if (/\bsrc\s*=/.test(attrs)) return full;
            if (/\btype\s*=\s*["']module["']/i.test(attrs)) return full;

            const encoded = Buffer.from(content, "utf-8").toString("base64");
            changed = true;
            return `<script${attrs}>(function(){const __b64="${encoded}";(0,eval)(atob(__b64));})();</script>`;
        },
    );

    if (changed) {
        await fs.writeFile(htmlPath, obfuscated, "utf-8");
    }
}

async function wrapHtmlWithEncodedBootstrap(htmlPath: string): Promise<void> {
    const html = await fs.readFile(htmlPath, "utf-8");
    const codecs = ["rot13", "shift"] as const;
    const shiftBy = randomInt(3, 18);
    const pick = () => codecs[randomInt(0, codecs.length)];
    const steps = ["b64", pick(), pick(), pick(), pick()] as const;

    const applyEncode = (input: string, step: "b64" | (typeof codecs)[number]): string => {
        if (step === "b64") return Buffer.from(input, "utf-8").toString("base64");
        if (step === "rot13") return input.replace(/[a-zA-Z]/g, (c) => {
            const base = c <= "Z" ? 65 : 97;
            return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
        });
        // shift inside base64 alphabet
        const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
        return input
            .split("")
            .map((ch) => {
                const idx = alpha.indexOf(ch);
                if (idx < 0) return ch;
                return alpha[(idx + shiftBy) % alpha.length];
            })
            .join("");
    };

    let encoded = html;
    for (const step of steps) encoded = applyEncode(encoded, step);

    const stepsJson = JSON.stringify(steps);
    const wrapped =
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>" +
        "<body><script>(function(){var d='" + encoded.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "';var s=" + stepsJson + ";var sh=" + shiftBy + ";" +
        "function r13(t){return t.replace(/[a-zA-Z]/g,function(c){var b=c<='Z'?65:97;return String.fromCharCode(((c.charCodeAt(0)-b+13)%26)+b);});}" +
        "for(var i=s.length-1;i>=0;i--){var x=s[i];if(x==='b64'){d=atob(d);}else if(x==='rot13'){d=r13(d);}else if(x==='shift'){var al='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var out='';for(var m=0;m<d.length;m++){var ch=d.charAt(m);var idx=al.indexOf(ch);if(idx<0){out+=ch;}else{out+=al.charAt((idx-sh+al.length)%al.length);}}d=out;}}" +
        "document.open();document.write(d);document.close();})();</script></body></html>";
    await fs.writeFile(htmlPath, wrapped, "utf-8");
}

async function validateTemplateResolutionContract(templateConfig: TemplateBuildConfig, workDir: string): Promise<void> {
    const checks = TEMPLATE_RESOLUTION_CHECKS[templateConfig.templateDirName];
    if (!checks || checks.length === 0) return;

    for (const check of checks) {
        const checkPath = path.join(workDir, check.relativePath);
        let content = "";
        try {
            content = await fs.readFile(checkPath, "utf-8");
        } catch {
            throw new Error(`[Builder] Resolution contract file is missing: ${check.relativePath}`);
        }

        for (const rule of check.patterns) {
            if (!rule.regex.test(content)) {
                throw new Error(
                    `[Builder] Resolution contract failed for ${templateConfig.templateDirName} ` +
                    `(${check.relativePath}): ${rule.description}`
                );
            }
        }
    }
}

function getLibraryArtifactPath(order: Order): string | null {
    const gameKey = String(order.config.game ?? "railroad");
    const gameId = LIBRARY_GAME_ID_BY_KEY[gameKey];
    if (!gameId) return null;
    const geoId = String(order.config.geoId ?? "en_usd");
    const kind = order.config.isWatermarked ? "preview" : "final";
    return path.join(ROOT_DIR, "library", gameId, `${geoId}_${kind}.html`);
}

function buildOutputFilename(order: Order): string {
    const isPreview = order.config.isWatermarked;
    if (isPreview) {
        return `PREVIEW_${order.id}.html`;
    }

    const game = (order.config.game ?? "railroad").replace(/[^a-zA-Z0-9_-]/g, "");
    const theme = (order.config.themeId ?? "default").replace(/[^a-zA-Z0-9_-]/g, "");
    const language = (order.config.language ?? "en").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    const safeCurrency = (order.config.currency ?? "$").replace(/[^a-zA-Z0-9]/g, "");
    return `${game}_${theme}_${language}_${safeCurrency}.html`;
}

async function injectTemplateConfig(
    templateConfig: TemplateBuildConfig,
    workDir: string,
    config: OrderConfig & { isWatermarked: boolean },
) {
    if (templateConfig.configMode !== "railroad") return;

    const configPath = path.join(workDir, "src", "UserConfig.json");
    const userConfig = {
        language: config.language ?? "en",
        currency: config.currency ?? "$",
        startingBalance: config.startingBalance ?? 1000,
        defaultBet: 50,
        minBet: 10,
        maxBet: 1000,
        themeId: config.themeId ?? "chicken_farm",
        isWatermarked: config.isWatermarked,
    };
    await fs.writeFile(configPath, JSON.stringify(userConfig, null, 2), "utf-8");
}

async function ensureWorkDependencies(
    templateConfig: TemplateBuildConfig,
    templateDir: string,
    workDir: string,
) {
    const templatePackageJson = path.join(templateDir, "package.json");
    const hasPackageJson = await fs
        .access(templatePackageJson, fsConstants.F_OK)
        .then(() => true)
        .catch(() => false);
    if (!hasPackageJson) return;

    const templateNodeModules = path.join(templateDir, "node_modules");
    const workNodeModules = path.join(workDir, "node_modules");
    const hasTemplateDeps = await fs
        .access(templateNodeModules, fsConstants.F_OK)
        .then(() => true)
        .catch(() => false);

    const canReuseTemplateDeps = hasTemplateDeps
        ? (await hasAllDevDeps(templateNodeModules, templatePackageJson)) &&
          (await hasBuildBins(templateNodeModules, templateConfig.requiredBins))
        : false;

    let linkedNodeModules = false;
    async function resetWorkNodeModules(): Promise<void> {
        await fs.rm(workNodeModules, { recursive: true, force: true }).catch(() => {});
    }

    if (canReuseTemplateDeps) {
        try {
            await fs.symlink(templateNodeModules, workNodeModules, "dir");
            linkedNodeModules = true;
        } catch {
            await resetWorkNodeModules();
            await fs.cp(templateNodeModules, workNodeModules, { recursive: true });
            linkedNodeModules = true;
        }
    }

    if (!linkedNodeModules) {
        const cacheNodeModules = await ensureDepsCache(templateDir, templateConfig.requiredBins);
        try {
            await fs.symlink(cacheNodeModules, workNodeModules, "dir");
        } catch {
            await resetWorkNodeModules();
            await fs.cp(cacheNodeModules, workNodeModules, { recursive: true });
        }
    }

    const nodeModulesPath = path.join(workDir, "node_modules");
    const devDepsOk = await hasAllDevDeps(nodeModulesPath, path.join(workDir, "package.json"));
    const binsOk = await hasBuildBins(nodeModulesPath, templateConfig.requiredBins);

    if (!devDepsOk || !binsOk) {
        throw new Error(
            `[Builder] Missing build dependencies in work dir for ${templateConfig.templateDirName}. ` +
            `Runtime npm install is disabled; warm dependency cache before serving traffic.`,
        );
    }
}

/**
 * Internal worker that performs the actual build.
 */
async function performBuild(order: Order): Promise<string | null> {
    const isPreview = order.config.isWatermarked;
    const modeLabel = isPreview ? "PREVIEW" : "FINAL";
    console.log(`[Builder] [Job ${order.id}] Processing ${modeLabel}...`);
    const filename = buildOutputFilename(order);
    const finalPath = path.join(PREVIEWS_DIR, filename);

    // Fast path: use prebuilt library artifact by game+geo and inject runtime config (CTA, locale, balance).
    const libraryPath = getLibraryArtifactPath(order);
    if (libraryPath) {
        const exists = await fs
            .access(libraryPath, fsConstants.F_OK)
            .then(() => true)
            .catch(() => false);
        if (exists) {
            await fs.mkdir(PREVIEWS_DIR, { recursive: true });
            await fs.copyFile(libraryPath, finalPath);
            await injectRuntimeConfig(finalPath, toRuntimeConfig(order.config));
            return finalPath;
        }
    }

    const templateConfig = resolveTemplateConfig(order.config.game);
    const templateDir = path.join(ROOT_DIR, "templates", templateConfig.templateDirName);

    if (process.env.BUILDER_FAST_TEST === "1") {
        const filename = buildOutputFilename(order);
        const finalPath = path.join(PREVIEWS_DIR, filename);
        const payload = toRuntimeConfig(order.config);
        await fs.mkdir(PREVIEWS_DIR, { recursive: true });
        await fs.writeFile(
            finalPath,
            `<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>`,
            "utf-8"
        );
        await injectRuntimeConfig(finalPath, payload);
        return finalPath;
    }
    
    // 1. Create Temp Work Directory
    const workDir = path.join(TEMP_DIR, order.id);
    
    try {
        await fs.mkdir(workDir, { recursive: true });
        await fs.access(templateDir, fsConstants.F_OK);
        
        // 2. Copy Template (skip node_modules to keep builds fast)
        await fs.cp(templateDir, workDir, {
            recursive: true,
            filter: (src) => !src.includes(`${path.sep}node_modules`)
        });

        // 3. Link dependencies when template has package.json
        await ensureWorkDependencies(templateConfig, templateDir, workDir);

        // 4. Inject template-specific config
        await injectTemplateConfig(templateConfig, workDir, order.config);
        await validateTemplateResolutionContract(templateConfig, workDir);

        if (templateConfig.configMode === "railroad") {
            await validateRailroadThemeAssets(workDir, order.config.themeId);
        }
        
        // 5. Build
        if (templateConfig.buildCommand) {
            console.log(`[Builder] [Job ${order.id}] Building ${templateConfig.templateDirName}...`);
            await execAsync(templateConfig.buildCommand, {
                cwd: workDir,
                timeout: BUILD_TIMEOUT_MS,
                maxBuffer: BUILD_MAX_BUFFER_BYTES,
            });
        }

        // 6. Move Result
        const distPath = path.join(workDir, templateConfig.outputHtmlRelativePath);
        await fs.access(distPath, fsConstants.F_OK);
        if (order.config.isWatermarked) {
            await inlineLocalAssetsInHtml(distPath, workDir, {
                isPreview: true,
                gameKey: String(order.config.game ?? "railroad"),
            });
        }
        await fs.copyFile(distPath, finalPath);
        // Keep output as plain single-file playable: no obfuscation, no wrappers, no external protections.
        await injectRuntimeConfig(finalPath, toRuntimeConfig(order.config));
        
        return finalPath;
    } catch (e) {
        if (isBuildTimeoutError(e)) {
            console.error(`[Builder] [Job ${order.id}] BUILD_TIMEOUT after ${BUILD_TIMEOUT_MS}ms`);
        }
        console.error(`[Builder] [Job ${order.id}] Failed:`, e);
        return null;
    } finally {
        // Always attempt cleanup to avoid orphaned temp dirs
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Entry point for building playables with concurrency control.
 */
export async function generatePlayable(order: Order): Promise<string | null> {
    if (activeBuilds >= MAX_CONCURRENT_BUILDS) {
        if (buildQueue.length >= MAX_BUILD_QUEUE_SIZE) {
            console.error(`[Builder] Queue overflow: ${buildQueue.length} waiting. Rejecting job ${order.id}.`);
            return null;
        }
        console.log(`[Builder] Queueing job ${order.id}... (${buildQueue.length} in queue)`);
        await new Promise<void>(resolve => buildQueue.push(resolve));
    }

    activeBuilds++;
    try {
        return await performBuild(order);
    } finally {
        activeBuilds--;
        const next = buildQueue.shift();
        if (next) next();
    }
}


