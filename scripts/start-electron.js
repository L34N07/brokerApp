const { spawn } = require('child_process');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const electronBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronArgs = process.argv.length > 2 ? process.argv.slice(2) : ['.'];

const child = spawn(electronBin, electronArgs, {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
