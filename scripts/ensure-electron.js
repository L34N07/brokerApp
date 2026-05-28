const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const electronPackageDir = path.join(projectRoot, 'node_modules', 'electron');
const electronPackageJson = path.join(electronPackageDir, 'package.json');

function getPlatformPath(platform = os.platform()) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

function electronBinaryPath() {
  return path.join(electronPackageDir, 'dist', getPlatformPath());
}

function electronLooksInstalled() {
  const expectedPath = getPlatformPath();
  const binaryPath = electronBinaryPath();
  const pathFile = path.join(electronPackageDir, 'path.txt');

  try {
    if (fs.readFileSync(pathFile, 'utf8') !== expectedPath) {
      return false;
    }
    if (!fs.existsSync(binaryPath)) {
      return false;
    }
    if (process.platform !== 'win32') {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function verifyElectronRuns() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const result = spawnSync(electronBinaryPath(), ['--version'], {
    env,
    encoding: 'utf8'
  });

  return result.status === 0 && /^v?\d+\.\d+\.\d+/.test(String(result.stdout).trim());
}

async function installElectronBinary() {
  const { downloadArtifact } = require('@electron/get');
  const { version } = require(electronPackageJson);
  const checksums = require(path.join(electronPackageDir, 'checksums.json'));
  const platform = process.env.npm_config_platform || process.platform;
  const arch = process.env.npm_config_arch || process.arch;
  const distPath = path.join(electronPackageDir, 'dist');

  console.log(`Installing Electron ${version} for ${platform}-${arch}...`);

  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    cacheRoot: process.env.electron_config_cache,
    checksums,
    platform,
    arch
  });

  fs.rmSync(distPath, { recursive: true, force: true });
  fs.mkdirSync(distPath, { recursive: true });
  await extractElectronZip(zipPath, distPath);

  const typeDefInDist = path.join(distPath, 'electron.d.ts');
  const typeDefTarget = path.join(electronPackageDir, 'electron.d.ts');
  if (fs.existsSync(typeDefInDist)) {
    fs.renameSync(typeDefInDist, typeDefTarget);
  }

  fs.writeFileSync(path.join(electronPackageDir, 'path.txt'), getPlatformPath(platform));

  if (process.platform !== 'win32') {
    for (const relativePath of [getPlatformPath(platform), 'chrome-sandbox', 'chrome_crashpad_handler']) {
      const filePath = path.join(distPath, relativePath);
      if (fs.existsSync(filePath)) {
        fs.chmodSync(filePath, 0o755);
      }
    }
  }
}

async function extractElectronZip(zipPath, distPath) {
  if (process.platform !== 'win32') {
    const result = spawnSync('unzip', ['-q', '-o', zipPath, '-d', distPath], {
      encoding: 'utf8'
    });

    if (result.status === 0) {
      return;
    }
  }

  const extract = require('extract-zip');
  await extract(zipPath, { dir: distPath });
}

(async () => {
  if (!fs.existsSync(electronPackageJson)) {
    return;
  }

  if (electronLooksInstalled() && verifyElectronRuns()) {
    return;
  }

  await installElectronBinary();

  if (!electronLooksInstalled() || !verifyElectronRuns()) {
    throw new Error('Electron binary could not be installed or verified.');
  }

  console.log('Electron binary ready.');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
