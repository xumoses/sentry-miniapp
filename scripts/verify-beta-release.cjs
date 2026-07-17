#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const versionSource = fs.readFileSync(path.join(projectRoot, 'src/version.ts'), 'utf8');
const sdkVersion = /SDK_VERSION\s*=\s*'([^']+)'/.exec(versionSource)?.[1];
const expectedReleaseTag = `v${packageJson.version}`;
const githubRefName = process.env.GITHUB_REF_NAME;
const failures = [];

if (packageJson.name !== '@xumoses/sentry-miniapp') {
  failures.push(`package name must be @xumoses/sentry-miniapp, got ${packageJson.name}`);
}
if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(packageJson.version)) {
  failures.push(`version must match x.y.z-beta.N, got ${packageJson.version}`);
}
if (sdkVersion !== packageJson.version) {
  failures.push(`SDK_VERSION must match package version, got ${sdkVersion}`);
}
if (packageJson.publishConfig?.access !== 'public') {
  failures.push('publishConfig.access must be public');
}
if (packageJson.publishConfig?.tag !== 'beta') {
  failures.push('publishConfig.tag must be beta');
}
if (packageJson.publishConfig?.registry !== 'https://registry.npmjs.org/') {
  failures.push('publishConfig.registry must be https://registry.npmjs.org/');
}
if (process.env.npm_config_tag && process.env.npm_config_tag !== 'beta') {
  failures.push(`npm publish tag must be beta, got ${process.env.npm_config_tag}`);
}
if (process.env.GITHUB_ACTIONS === 'true' && !githubRefName) {
  failures.push('GITHUB_REF_NAME must be set for GitHub Actions releases');
}
if (githubRefName && githubRefName !== expectedReleaseTag) {
  failures.push(`release tag must be ${expectedReleaseTag}, got ${githubRefName}`);
}

if (failures.length) {
  console.error(`[beta-release] ${failures.join('\n[beta-release] ')}`);
  process.exit(1);
}

console.log(`[beta-release] verified ${packageJson.name}@${packageJson.version}`);
