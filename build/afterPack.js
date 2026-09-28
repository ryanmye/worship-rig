'use strict';
// electron-builder afterPack hook (SPEC §7, REVIEW 1.19): ad-hoc sign the .app on macOS so an
// unsigned arm64 build still launches ("identity: null" skips electron-builder's own signing).
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

exports.default = async function afterPack(context) {
  if (process.platform !== 'darwin' || context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    console.warn(`[afterPack] ${appPath} not found; skipping ad-hoc signing`);
    return;
  }
  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '-s', '-', appPath], { stdio: 'inherit' });
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  } catch (err) {
    console.warn('[afterPack] codesign verify reported a problem:', err.message);
  }
};
