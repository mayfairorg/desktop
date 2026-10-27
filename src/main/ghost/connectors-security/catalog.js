'use strict';
// Download catalog for the security tools: where each separate program comes from, how it is verified, and how it is tested.
// This is a SEED. Per the Ghost spec the authoritative copy is the signed index served by Mayfair, which supplies pinned sha256 values;
// pass it to ToolInstaller as `catalog`. Nothing here is fetched at build time, and the URL patterns and versions below follow each
// project's usual release naming but were NOT confirmed against the live release pages (the build environment could not reach them).
// `verified: false` says so. An entry with no pinned sha256 and no upstream checksum file cannot be installed: the installer refuses.
//
// versionArgs / versionRe repeat the connector's own SPEC (a test keeps them equal) so the installer never has to load connector code.
const GH = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const MB = 1024 * 1024;

const pd = (tool, ver, repo, assets, sums, extra = {}) => ({
  tool, requestedVersion: ver, hosts: GH, maxBytes: 200 * MB, verified: false,
  checksums: { url: `https://github.com/${repo}/releases/download/v${ver}/${sums}` },
  platforms: Object.fromEntries(Object.entries(assets).map(([k, file]) => [k, { url: `https://github.com/${repo}/releases/download/v${ver}/${file}`, file, archive: 'zip', sha256: null }])),
  ...extra,
});

const CATALOG = {
  subfinder: pd('subfinder', '2.6.6', 'projectdiscovery/subfinder', {
    'linux-x64': 'subfinder_2.6.6_linux_amd64.zip', 'linux-arm64': 'subfinder_2.6.6_linux_arm64.zip', 'darwin-x64': 'subfinder_2.6.6_macOS_amd64.zip', 'darwin-arm64': 'subfinder_2.6.6_macOS_arm64.zip', 'win32-x64': 'subfinder_2.6.6_windows_amd64.zip',
  }, 'subfinder_2.6.6_checksums.txt', { exeName: { default: 'subfinder', win32: 'subfinder.exe' }, versionArgs: ['-version'], versionRe: '(?:Current Version|version)[: ]+v?(\\d+\\.\\d+\\.\\d+)' }),
  dnsx: pd('dnsx', '1.2.1', 'projectdiscovery/dnsx', {
    'linux-x64': 'dnsx_1.2.1_linux_amd64.zip', 'linux-arm64': 'dnsx_1.2.1_linux_arm64.zip', 'darwin-x64': 'dnsx_1.2.1_macOS_amd64.zip', 'darwin-arm64': 'dnsx_1.2.1_macOS_arm64.zip', 'win32-x64': 'dnsx_1.2.1_windows_amd64.zip',
  }, 'dnsx_1.2.1_checksums.txt', { exeName: { default: 'dnsx', win32: 'dnsx.exe' }, versionArgs: ['-version'], versionRe: '(?:Current Version|version)[: ]+v?(\\d+\\.\\d+\\.\\d+)' }),
  amass: pd('amass', '4.2.0', 'owasp-amass/amass', {
    'linux-x64': 'amass_Linux_amd64.zip', 'linux-arm64': 'amass_Linux_arm64.zip', 'darwin-x64': 'amass_Darwin_amd64.zip', 'darwin-arm64': 'amass_Darwin_arm64.zip', 'win32-x64': 'amass_Windows_amd64.zip',
  }, 'amass_checksums.txt', { exeName: { default: 'amass', win32: 'amass.exe' }, versionArgs: ['-version'], versionRe: 'v?(\\d+\\.\\d+\\.\\d+)' }),
  // Findomain publishes no checksum file: it can be installed only once a pinned sha256 is supplied by the signed index.
  findomain: {
    tool: 'findomain', requestedVersion: '9.0.4', hosts: GH, maxBytes: 100 * MB, verified: false, checksums: null,
    exeName: { default: 'findomain', win32: 'findomain.exe' }, versionArgs: ['--version'], versionRe: 'findomain\\s+v?(\\d+\\.\\d+\\.\\d+)',
    platforms: {
      'linux-x64': { url: 'https://github.com/Findomain/Findomain/releases/download/9.0.4/findomain-linux.zip', file: 'findomain-linux.zip', archive: 'zip', sha256: null },
      'linux-arm64': { url: 'https://github.com/Findomain/Findomain/releases/download/9.0.4/findomain-aarch64.zip', file: 'findomain-aarch64.zip', archive: 'zip', sha256: null },
      'darwin-arm64': { url: 'https://github.com/Findomain/Findomain/releases/download/9.0.4/findomain-osx.zip', file: 'findomain-osx.zip', archive: 'zip', sha256: null },
      'win32-x64': { url: 'https://github.com/Findomain/Findomain/releases/download/9.0.4/findomain-windows.exe.zip', file: 'findomain-windows.exe.zip', archive: 'zip', sha256: null },
    },
  },
  // Nmap's licence (NPSL) forbids redistribution in a proprietary product, so Mayfair never mirrors it. The only portable archive nmap.org offers is
  // the Windows zip; everywhere else the user installs Nmap with their package manager and uses adopt(). No checksum file: pinned sha256 required.
  nmap: {
    tool: 'nmap', requestedVersion: '7.95', hosts: ['nmap.org'], maxBytes: 100 * MB, verified: false, checksums: null,
    exeName: { default: 'nmap', win32: 'nmap.exe' }, versionArgs: ['--version'], versionRe: 'Nmap version (\\d+\\.\\d+[\\w.]*)',
    platforms: { 'win32-x64': { url: 'https://nmap.org/dist/nmap-7.95-win32.zip', file: 'nmap-7.95-win32.zip', archive: 'zip', sha256: null } },
    manualHint: 'Install Nmap with your package manager (or from nmap.org), then use "Use my own copy" to point Ghost at it.',
  },
  // Masscan, Zeek and Suricata have no portable official binaries: use your package manager and "Use my own copy".
  masscan: { tool: 'masscan', requestedVersion: null, hosts: [], maxBytes: 0, verified: false, checksums: null, exeName: { default: 'masscan', win32: 'masscan.exe' }, versionArgs: ['--version'], versionRe: 'Masscan version (\\d+\\.\\d+(?:\\.\\d+)?)', platforms: {}, manualHint: 'Masscan publishes source only. Install it with your package manager, then use "Use my own copy".' },
  zeek: { tool: 'zeek', requestedVersion: null, hosts: [], maxBytes: 0, verified: false, checksums: null, exeName: { default: 'zeek', win32: 'zeek.exe' }, versionArgs: ['--version'], versionRe: 'zeek version (\\d+\\.\\d+(?:\\.\\d+)?)', platforms: {}, manualHint: 'Zeek has no portable download. Install it with your package manager (Linux or macOS), then use "Use my own copy".' },
  suricata: { tool: 'suricata', requestedVersion: null, hosts: [], maxBytes: 0, verified: false, checksums: null, exeName: { default: 'suricata', win32: 'suricata.exe' }, versionArgs: ['-V'], versionRe: 'Suricata version (\\d+\\.\\d+(?:\\.\\d+)?)', platforms: {}, manualHint: 'Suricata has no portable download. Install it with your package manager, then use "Use my own copy".' },
  yara: { tool: 'yara', requestedVersion: null, hosts: [], maxBytes: 0, verified: false, checksums: null, exeName: { default: 'yara', win32: 'yara64.exe' }, versionArgs: ['--version'], versionRe: '^\\s*v?(\\d+\\.\\d+\\.\\d+)', platforms: {}, manualHint: 'Install YARA with your package manager, or use the Windows build from the YARA releases page, then use "Use my own copy".' },
  // Script tools: need their runtime (Ruby, Bash, Java). Source archives from GitHub are not byte-stable, so a pinned sha256 is required.
  whatweb: { tool: 'whatweb', requestedVersion: '0.5.5', hosts: GH, maxBytes: 50 * MB, verified: false, checksums: null, exeName: { default: 'whatweb' }, versionArgs: ['--version'], versionRe: 'WhatWeb version (\\d+\\.\\d+(?:\\.\\d+)?)',
    platforms: { 'linux-x64': { url: 'https://github.com/urbanadventurer/WhatWeb/archive/refs/tags/v0.5.5.tar.gz', file: 'v0.5.5.tar.gz', archive: 'tar.gz', sha256: null }, 'linux-arm64': { url: 'https://github.com/urbanadventurer/WhatWeb/archive/refs/tags/v0.5.5.tar.gz', file: 'v0.5.5.tar.gz', archive: 'tar.gz', sha256: null }, 'darwin-arm64': { url: 'https://github.com/urbanadventurer/WhatWeb/archive/refs/tags/v0.5.5.tar.gz', file: 'v0.5.5.tar.gz', archive: 'tar.gz', sha256: null }, 'darwin-x64': { url: 'https://github.com/urbanadventurer/WhatWeb/archive/refs/tags/v0.5.5.tar.gz', file: 'v0.5.5.tar.gz', archive: 'tar.gz', sha256: null } },
    manualHint: 'Needs Ruby 2 or newer.' },
  testssl: { tool: 'testssl.sh', requestedVersion: '3.2.0', hosts: GH, maxBytes: 50 * MB, verified: false, checksums: null, exeName: { default: 'testssl.sh' }, versionArgs: ['--version'], versionRe: 'testssl\\.sh\\s+(\\d+\\.\\d+(?:\\.\\d+)?)',
    platforms: { 'linux-x64': { url: 'https://github.com/testssl/testssl.sh/archive/refs/tags/v3.2.0.tar.gz', file: 'v3.2.0.tar.gz', archive: 'tar.gz', sha256: null }, 'linux-arm64': { url: 'https://github.com/testssl/testssl.sh/archive/refs/tags/v3.2.0.tar.gz', file: 'v3.2.0.tar.gz', archive: 'tar.gz', sha256: null }, 'darwin-arm64': { url: 'https://github.com/testssl/testssl.sh/archive/refs/tags/v3.2.0.tar.gz', file: 'v3.2.0.tar.gz', archive: 'tar.gz', sha256: null }, 'darwin-x64': { url: 'https://github.com/testssl/testssl.sh/archive/refs/tags/v3.2.0.tar.gz', file: 'v3.2.0.tar.gz', archive: 'tar.gz', sha256: null } },
    manualHint: 'Needs Bash. Not supported on native Windows.' },
  'zap-baseline': { tool: 'zap', requestedVersion: '2.16.0', hosts: GH, maxBytes: 400 * MB, verified: false, checksums: null, exeName: { default: 'zap.sh', win32: 'zap.bat' }, versionArgs: ['-version'], versionRe: '^\\s*v?(\\d+\\.\\d+\\.\\d+)\\s*$',
    platforms: Object.fromEntries(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'].map((k) => [k, { url: 'https://github.com/zaproxy/zaproxy/releases/download/v2.16.0/ZAP_2.16.0_Crossplatform.zip', file: 'ZAP_2.16.0_Crossplatform.zip', archive: 'zip', sha256: null }])),
    manualHint: 'Needs Java 17 or newer.' },
};

// Python tools: GitHub source archives are not byte-stable, so a pinned sha256 from the signed index is required before Ghost will download them.
// "launcher" runs the script with the user's python3. Any of them can instead be registered with adopt().
const GHSRC = (repo, ver, tag) => ({ url: `https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`, file: `${tag}.tar.gz`, archive: 'tar.gz', sha256: null });
const pySrc = (tool, repo, ver, tag, exe, versionArgs, versionRe, hint) => ({
  tool, requestedVersion: ver, hosts: GH, maxBytes: 100 * MB, verified: false, checksums: null, launcher: ['python3'], exeName: { default: exe }, versionArgs, versionRe, manualHint: hint,
  platforms: Object.fromEntries(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].map((k) => [k, GHSRC(repo, ver, tag)])),
});
Object.assign(CATALOG, {
  spiderfoot: pySrc('spiderfoot', 'smicallef/spiderfoot', '4.0', 'v4.0', 'sf.py', ['-V'], 'SpiderFoot (\\d+\\.\\d+(?:\\.\\d+)?)', 'Needs Python 3 and the SpiderFoot Python packages. Run with the person-lookup modules left out; Ghost passes a fixed module list.'),
  'recon-ng': pySrc('recon-ng', 'lanmaster53/recon-ng', '5.1.2', 'v5.1.2', 'recon-cli', ['--version'], 'recon-?ng[^\\d]{0,20}v?(\\d+\\.\\d+\\.\\d+)', 'Needs Python 3 and its requirements; install the three allowed modules inside Recon-ng first.'),
  theharvester: pySrc('theHarvester', 'laramies/theHarvester', '4.6.0', '4.6.0', 'theHarvester.py', ['-h'], 'theHarvester\\s+v?(\\d+\\.\\d+\\.\\d+)', 'Needs Python 3.'),
  photon: pySrc('photon', 's0md3v/Photon', '1.3.0', 'v1.3.0', 'photon.py', ['-h'], 'v?(\\d+\\.\\d+\\.\\d+)', 'Needs Python 3.'),
  // BBOT is installed with pipx or pip, not from an archive: register your own copy.
  bbot: { tool: 'bbot', requestedVersion: null, hosts: [], maxBytes: 0, verified: false, checksums: null, exeName: { default: 'bbot', win32: 'bbot.exe' }, versionArgs: ['--version'], versionRe: 'v?(\\d+\\.\\d+\\.\\d+)', platforms: {}, manualHint: 'Install BBOT with pipx, then use "Use my own copy". BBOT is AGPL: Ghost never bundles it.' },
  'bbot-active': { tool: 'bbot', requestedVersion: null, hosts: [], maxBytes: 0, verified: false, checksums: null, exeName: { default: 'bbot', win32: 'bbot.exe' }, versionArgs: ['--version'], versionRe: 'v?(\\d+\\.\\d+\\.\\d+)', platforms: {}, manualHint: 'Install BBOT with pipx, then use "Use my own copy". BBOT is AGPL: Ghost never bundles it.' },
  // OpenOSINT: the owner fills `ownerUrl` (and platforms) once the project address is known. Until then the installer refuses with "owner-url-missing".
  openosint: { tool: 'openosint', requestedVersion: null, ownerUrl: null, hosts: [], maxBytes: 0, verified: false, checksums: null, exeName: { default: 'openosint' }, versionArgs: ['--version'], versionRe: '(\\d+\\.\\d+\\.\\d+)', platforms: {}, manualHint: 'The owner has not supplied the OpenOSINT project address yet.' },
});

module.exports = { CATALOG, GH };
