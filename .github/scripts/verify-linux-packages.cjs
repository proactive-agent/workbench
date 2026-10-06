#!/usr/bin/env node
/**
 * Verify the Linux deb package was built correctly.
 *
 * Lists the deb contents to verify that the bundled Electron application
 * (app.asar) is present.
 *
 * Usage: node .github/scripts/verify-linux-packages.cjs [dist-dir]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✓ ${message}`, colors.green);
}

function logError(message) {
  log(`✗ ${message}`, colors.red);
}

function logWarning(message) {
  log(`⚠ ${message}`, colors.yellow);
}

function logInfo(message) {
  log(`ℹ ${message}`, colors.cyan);
}

/**
 * Check if a command exists
 * Uses 'which' directly without shell interpolation to prevent command injection
 */
function commandExists(cmd) {
  const result = spawnSync('which', [cmd], { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * Find the deb package in the dist directory
 */
function findDeb(distDir) {
  if (!fs.existsSync(distDir)) {
    logError(`Distribution directory not found: ${distDir}`);
    return null;
  }

  const debs = fs.readdirSync(distDir).filter((file) => file.endsWith('.deb'));
  if (debs.length > 1) {
    logWarning(`Multiple deb files found, using first: ${debs[0]}`);
  }
  return debs.length > 0 ? path.join(distDir, debs[0]) : null;
}

/**
 * Verify that a file listing contains the bundled Electron app (app.asar)
 * @param {string[]} files - List of files from package
 * @returns {Object} Verification result with verified flag and issues array
 */
function verifyFileList(files) {
  const issues = [];

  // Use boundary-safe match to avoid false positives from resources/app.asar.unpacked
  const appAsarPattern = /[\\/]resources[\\/]app\.asar$/;
  if (!files.some((f) => appAsarPattern.test(f.trim()))) {
    issues.push('app.asar not found in deb package — the Electron app bundle is missing');
  }

  return {
    verified: issues.length === 0,
    issues,
    fileCount: files.filter((f) => f.trim()).length,
  };
}

/**
 * Verify deb package contents
 */
function verifyDeb(debPath) {
  logInfo(`Verifying deb package: ${path.basename(debPath)}`);

  if (!commandExists('dpkg-deb')) {
    return { verified: false, issues: ['dpkg-deb not available (install with: sudo apt-get install dpkg)'] };
  }

  const result = spawnSync('dpkg-deb', ['-c', debPath], {
    stdio: 'pipe',
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error) {
    return { verified: false, issues: [`Command execution failed: ${result.error.message}`] };
  }

  if (result.status !== 0) {
    return { verified: false, issues: [`Failed to read deb package: ${result.stderr}`] };
  }

  return verifyFileList(result.stdout.split('\n'));
}

function main() {
  const distDir = process.argv[2] || path.join(__dirname, '..', '..', 'dist');

  log('\n=== Linux Package Verification ===\n', colors.blue);
  logInfo(`Distribution directory: ${distDir}\n`);

  const debPath = findDeb(distDir);
  if (!debPath) {
    logError('No deb package found — expected build target is missing');
    process.exit(1);
  }
  logSuccess(`Found deb: ${path.basename(debPath)}`);

  const result = verifyDeb(debPath);
  if (!result.verified) {
    logError('\n=== VERIFICATION FAILED ===\n');
    for (const issue of result.issues) {
      logError(`  - ${issue}`);
    }
    process.exit(1);
  }

  logSuccess('\n=== DEB PACKAGE VERIFIED ===\n');
  logInfo(`Files: ${result.fileCount}`);
  process.exit(0);
}

main();
