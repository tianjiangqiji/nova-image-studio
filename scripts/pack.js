const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const BACKEND_DIR = path.join(ROOT, 'backend');
const TEMP_DIR = path.join(ROOT, 'temp');
const ZIP_PATH = path.join(ROOT, 'out.zip');

// 后端文件列表
const BACKEND_FILES = [
  { src: path.join(BACKEND_DIR, 'server.js'), dest: 'server.js' },
  { src: path.join(BACKEND_DIR, 'package.json'), dest: 'package.json' },
  { src: path.join(BACKEND_DIR, '.env.example'), dest: '.env.example' },
  { src: path.join(BACKEND_DIR, 'blacklist.json'), dest: 'blacklist.json' },
  { src: path.join(BACKEND_DIR, 'prompts.json'), dest: 'prompts.json' },
];

// 后端目录列表。视频插件运行时与已安装的插件包都要进部署包——
// 少了 plugin-runtime 服务直接起不来，少了 plugins 视频 tab 会变成「未安装插件」。
const BACKEND_DIRS = [
  { src: path.join(BACKEND_DIR, 'plugin-runtime'), dest: 'plugin-runtime' },
  { src: path.join(BACKEND_DIR, 'plugins'), dest: 'plugins' },
];

// 前端构建产物目录
const FRONTEND_OUT_DIR = { src: path.join(FRONTEND_DIR, 'out'), dest: 'out' };

// 1. Build frontend
console.log('[1/4] Building frontend...');
execSync('npm run build', { cwd: FRONTEND_DIR, stdio: 'inherit' });

// 2. Prepare temp directory
console.log('[2/4] Preparing temp/...');
if (fs.existsSync(TEMP_DIR)) {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Copy backend files into temp/backend/
const TEMP_BACKEND = path.join(TEMP_DIR, 'backend');
fs.mkdirSync(TEMP_BACKEND, { recursive: true });
for (const file of BACKEND_FILES) {
  if (!fs.existsSync(file.src)) {
    console.warn(`Warning: ${file.dest} not found, skipping.`);
    continue;
  }
  fs.copyFileSync(file.src, path.join(TEMP_BACKEND, file.dest));
}
for (const dir of BACKEND_DIRS) {
  if (!fs.existsSync(dir.src)) {
    console.warn(`Warning: ${dir.dest}/ not found, skipping.`);
    continue;
  }
  // fixtures 只用于开发期自检，不必进部署包
  fs.cpSync(dir.src, path.join(TEMP_BACKEND, dir.dest), {
    recursive: true,
    filter: src => !src.split(/[\\/]/).includes('fixtures'),
  });
}

// Copy frontend out/ folder into temp/frontend/out/
const TEMP_FRONTEND = path.join(TEMP_DIR, 'frontend');
fs.mkdirSync(TEMP_FRONTEND, { recursive: true });
fs.cpSync(FRONTEND_OUT_DIR.src, path.join(TEMP_FRONTEND, 'out'), { recursive: true });

// Generate root package.json for one-command deploy
const backendPkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8'));
const rootPkg = {
  name: 'nova-image',
  version: backendPkg.version || '1.0.0',
  private: true,
  description: 'Nova Studio - 生产部署包',
  scripts: {
    start: 'node backend/server.js',
  },
  dependencies: backendPkg.dependencies,
};
fs.writeFileSync(path.join(TEMP_DIR, 'package.json'), JSON.stringify(rootPkg, null, 2) + '\n');

// 3. Create out.zip (overwrite if exists)
console.log('[3/4] Creating out.zip...');
if (fs.existsSync(ZIP_PATH)) {
  fs.unlinkSync(ZIP_PATH);
}

// Use PowerShell to zip (Windows native)
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${TEMP_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force"`,
  { cwd: ROOT, stdio: 'inherit' }
);

// 4. Remove temp/
console.log('[4/4] Cleaning up temp/...');
fs.rmSync(TEMP_DIR, { recursive: true, force: true });

console.log('Done! -> out.zip');