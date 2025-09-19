#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const directoriesToCopy = ['src', 'views', 'docs'];
const filesToCopy = ['package.json', 'package-lock.json', 'README.md', 'AGENTS.md'];

async function run() {
  console.log('[build] Cleaning existing dist directory');
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  console.log('[build] Copying project assets');
  await Promise.all(directoriesToCopy.map(async (dir) => {
    await cp(path.join(projectRoot, dir), path.join(distDir, dir), { recursive: true });
  }));

  await Promise.all(filesToCopy.map(async (file) => {
    await cp(path.join(projectRoot, file), path.join(distDir, file));
  }));

  console.log('[build] Installing production dependencies');
  await runCommand('npm', ['ci', '--omit=dev'], distDir);

  const buildInfo = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    dependenciesInstalled: true
  };
  await writeFile(path.join(distDir, 'BUILD_INFO.json'), JSON.stringify(buildInfo, null, 2));

  console.log('[build] Artifact ready in dist/');
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

run().catch((error) => {
  console.error('[build] Failed:', error);
  process.exitCode = 1;
});
