#!/usr/bin/env node
/**
 * 多平台二进制构建脚本
 *
 * 使用方法：
 *   node scripts/build.js --target <platform>
 *
 * 支持的平台：
 *   linux-x64, linux-arm64, win-x64, macos-x64, macos-arm64
 */
import * as esbuild from 'esbuild';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, '..');
const backendDir = path.join(rootDir, 'backend');
const distDir = path.join(rootDir, 'dist');
const releaseDir = path.join(distDir, 'release');

// 目标平台配置
const TARGETS = {
    'linux-x64': { pkg: 'node18-linux-x64', outExt: '' },
    'linux-arm64': { pkg: 'node18-linux-arm64', outExt: '' },
    'win-x64': { pkg: 'node18-win-x64', outExt: '.exe' },
    'macos-x64': { pkg: 'node18-macos-x64', outExt: '' },
    'macos-arm64': { pkg: 'node18-macos-arm64', outExt: '' }
};

function usage() {
    const targets = Object.keys(TARGETS).join(', ');
    console.log(`
Antigravity Proxy 构建脚本

用法：
  node scripts/build.js --target <${targets}>

注意：
  - 在目标平台上运行此脚本，以确保 better-sqlite3 编译正确的原生模块
  - CI 应使用 Node 18，以匹配 pkg target
`);
}

function getArgValue(argv, name) {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === name) return argv[i + 1] ?? null;
        if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    }
    return null;
}

function rmrf(p) {
    fs.rmSync(p, { recursive: true, force: true });
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function copyFileSync(src, dst) {
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
}

function copyDirRecursive(srcDir, dstDir) {
    if (!fs.existsSync(srcDir)) {
        throw new Error(`Missing directory: ${srcDir}`);
    }
    ensureDir(dstDir);
    for (const name of fs.readdirSync(srcDir)) {
        const src = path.join(srcDir, name);
        const dst = path.join(dstDir, name);
        const st = fs.statSync(src);
        if (st.isDirectory()) {
            copyDirRecursive(src, dst);
        } else if (st.isFile()) {
            copyFileSync(src, dst);
        }
    }
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function findBetterSqlite3Addon() {
    const candidates = [
        path.join(rootDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
        path.join(backendDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error(
        `better_sqlite3.node not found. Did you run "npm ci" on this platform?\n` +
        `Tried:\n- ${candidates.join('\n- ')}`
    );
}

function sanitizeBuildId(s) {
    return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function runPkg(buildDir, pkgTarget, outputPath) {
    const pkgBin = path.join(
        rootDir,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'pkg.cmd' : 'pkg'
    );
    if (!fs.existsSync(pkgBin)) {
        throw new Error(`pkg not found at ${pkgBin}. Did you install devDependencies?`);
    }

    const env = {
        ...process.env,
        // 避免在受限 CI 环境中写入 ~/.pkg-cache
        PKG_CACHE_PATH: path.join(distDir, '.pkg-cache')
    };

    console.log(`[pkg] Building ${pkgTarget} -> ${outputPath}`);
    const res = spawnSync(pkgBin, ['package.json', '--targets', pkgTarget, '--output', outputPath, '--debug'], {
        cwd: buildDir,
        stdio: 'inherit',
        env,
        // Windows 需要 shell 模式运行 .cmd
        shell: process.platform === 'win32'
    });
    if (res.error) {
        console.error('[pkg] Spawn error:', res.error);
        process.exit(1);
    }
    if (res.status !== 0) {
        console.error(`[pkg] Failed with exit code ${res.status}`);
        process.exit(res.status ?? 1);
    }
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('-h') || argv.includes('--help')) {
        usage();
        process.exit(0);
    }

    const target = getArgValue(argv, '--target');
    if (!target || !TARGETS[target]) {
        usage();
        throw new Error(`Invalid or missing --target. Got: ${target ?? '(none)'}`);
    }
    const { pkg: pkgTarget, outExt } = TARGETS[target];

    // 读取版本号
    const backendPkg = JSON.parse(fs.readFileSync(path.join(backendDir, 'package.json'), 'utf8'));
    const version = String(backendPkg.version || '0.0.0');
    const refName = String(process.env.GITHUB_REF_NAME || '');
    const buildIdRaw = refName.startsWith('v') ? refName.slice(1) : version;
    const buildId = sanitizeBuildId(buildIdRaw);

    console.log(`\n========================================`);
    console.log(`  Antigravity Proxy Build`);
    console.log(`  Target: ${target}`);
    console.log(`  Version: ${buildId}`);
    console.log(`========================================\n`);

    const buildDir = path.join(distDir, 'build', target);
    rmrf(buildDir);
    ensureDir(buildDir);
    ensureDir(releaseDir);

    // ---- 阶段 1：复制资源到构建目录 ----
    console.log('[1/5] Copying assets...');

    // 复制 public 目录
    const publicSrc = path.join(backendDir, 'public');
    const publicDst = path.join(buildDir, 'public');
    copyDirRecursive(publicSrc, publicDst);
    console.log(`  ✓ Copied public/ (${fs.readdirSync(publicDst).length} files)`);

    // 复制原生模块
    const nativeAddonSrc = findBetterSqlite3Addon();
    const nativeAddonDst = path.join(buildDir, 'native', 'better_sqlite3.node');
    copyFileSync(nativeAddonSrc, nativeAddonDst);
    console.log(`  ✓ Copied better_sqlite3.node`);

    // ---- 阶段 2：使用 esbuild 打包 ----
    console.log('[2/5] Bundling with esbuild...');

    await esbuild.build({
        entryPoints: [path.join(backendDir, 'src', 'packaged-entry.js')],
        outfile: path.join(buildDir, 'app.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: ['node18'],
        logLevel: 'info',
        sourcemap: false,
        // 内联 SQL 文件
        loader: {
            '.sql': 'text'
        },
        // 注入构建信息
        define: {
            AGP_BUILD_VERSION: JSON.stringify(buildId),
            AGP_BUILD_TARGET: JSON.stringify(target),
            // 将 import.meta.url 替换为 CJS 兼容的表达式
            'import.meta.url': 'importMetaUrl'
        },
        // 在文件开头注入 import.meta.url 的 polyfill
        banner: {
            js: `const importMetaUrl = require('url').pathToFileURL(__filename).href;`
        }
    });

    console.log(`  ✓ Bundle created: ${path.join(buildDir, 'app.cjs')}`);

    // ---- 阶段 3：生成 pkg 配置并打包 ----
    console.log('[3/5] Building executable with pkg...');

    // pkg 需要 package.json 配置
    fs.writeFileSync(
        path.join(buildDir, 'package.json'),
        JSON.stringify(
            {
                name: 'antigravity-proxy',
                version: buildId,
                private: true,
                bin: 'app.cjs',
                pkg: {
                    // 这些资源会被打包进可执行文件
                    assets: ['public/**/*', 'native/**/*']
                }
            },
            null,
            2
        ) + '\n',
        'utf8'
    );

    const outName = `antigravity-proxy-${target}${outExt}`;
    const outPath = path.join(releaseDir, outName);
    runPkg(buildDir, pkgTarget, outPath);

    // ---- 阶段 4：创建压缩包 ----
    console.log('[4/5] Creating release archive...');

    // 创建临时打包目录
    const archiveDir = path.join(distDir, 'archive', target);
    rmrf(archiveDir);
    ensureDir(archiveDir);

    // 复制可执行文件到打包目录
    copyFileSync(outPath, path.join(archiveDir, outName));

    // 复制 .env.example 到打包目录
    const envExampleSrc = path.join(rootDir, '.env.example');
    if (fs.existsSync(envExampleSrc)) {
        copyFileSync(envExampleSrc, path.join(archiveDir, '.env.example'));
    }

    // 创建压缩包
    const isWindows = target.includes('win');
    const archiveName = isWindows
        ? `antigravity-proxy-${target}.zip`
        : `antigravity-proxy-${target}.tar.gz`;
    const archivePath = path.join(releaseDir, archiveName);

    if (isWindows) {
        // Windows: 使用 zip
        // 检查是否有 zip 命令，否则使用 PowerShell
        const zipResult = spawnSync('zip', ['-r', archivePath, '.'], {
            cwd: archiveDir,
            stdio: 'pipe'
        });
        if (zipResult.status !== 0) {
            // 回退到 tar（如果在 Linux/macOS 上交叉编译 Windows 版本）
            spawnSync('tar', ['-czvf', archivePath.replace('.zip', '.tar.gz'), '-C', archiveDir, '.'], {
                stdio: 'inherit'
            });
            console.log(`  ✓ Created ${archiveName.replace('.zip', '.tar.gz')} (fallback)`);
        } else {
            console.log(`  ✓ Created ${archiveName}`);
        }
    } else {
        // Linux/macOS: 使用 tar.gz
        spawnSync('tar', ['-czvf', archivePath, '-C', archiveDir, '.'], {
            stdio: 'pipe'
        });
        console.log(`  ✓ Created ${archiveName}`);
    }

    // ---- 阶段 5：生成校验和 ----
    console.log('[5/5] Generating checksums...');

    // 为压缩包生成校验和
    const archiveSum = sha256File(archivePath);
    fs.writeFileSync(`${archivePath}.sha256`, `${archiveSum}  ${archiveName}\n`, 'utf8');

    const stats = fs.statSync(archivePath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log(`\n========================================`);
    console.log(`  ✓ Build complete!`);
    console.log(`  Archive: ${archivePath}`);
    console.log(`  Size: ${sizeMB} MB`);
    console.log(`  SHA256: ${archiveSum}`);
    console.log(`========================================\n`);

    console.log(`📦 Archive contents:`);
    console.log(`   - ${outName}`);
    console.log(`   - .env.example`);
}

main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
});
