'use strict';
// Ghost modules: what each module screen is, which connectors it looks for, and what it accepts as input.
// Data only. A module screen runs the connectors that are installed on this computer (through the Ghost connector core) and shows
// "Not installed" for the ones that are not: it never invents a result. The input kinds are a closed list that has no person, username, email or phone.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.GhostModules = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const INPUT_KINDS = ['domain', 'ip', 'cidr', 'asn', 'url', 'cert-hash', 'org-name', 'lei', 'file', 'place-text', 'coords', 'keyword', 'rules-file', 'log-file', 'instance-url', 'entity'];
  // Connectors that ship with Mayfair. BUILTIN are Mayfair's own lookups (src/main/ghost/modules), SECURITY the security-tool connectors
  // (src/main/ghost/connectors-security). Both are registered when Ghost starts; the user approves each one. A test keeps these lists equal to the folders.
  const BUILTIN = ['dns-doh', 'rdap-domain', 'rdap-ip-asn', 'ct-crtsh', 'wayback-cdx', 'exif-meta', 'gdelt-doc', 'wikidata', 'nasa-cmr', 'usgs-landsat', 'archivebox',
    'exiftool', 'mediainfo', 'tesseract', 'ocrmypdf', 'tika', 'ffmpeg-frames', 'gdal-info', 'qgis-open',
    'gleif', 'sec-edgar', 'nominatim', 'overpass-query', 'nasa-gibs', 'earth-search-stac', 'gdelt-geo', 'common-crawl-index', 'rdns', 'cisa-kev', 'nvd', 'hash-file', 'stix-import', 'local-snapshot'];
  const SECURITY = ['amass', 'bbot', 'bbot-active', 'dnsx', 'findomain', 'masscan', 'misp-client', 'neo4j-client', 'nmap', 'opencti-client', 'openosint', 'opensearch-client', 'photon',
    'recon-ng', 'sigma-match', 'spiderfoot', 'subfinder', 'suricata', 'testssl', 'theharvester', 'whatweb', 'yara', 'zap-baseline', 'zeek'];
  // Lookups that are expected on a screen but have not been built yet. They show as "Not installed" and never return anything.
  // A test fails when a screen lists an id that is neither shipped nor named here.
  const PLANNED = ['ip-geo-local', 'web-headers', 'security-txt', 'graph-pivot', 'protomaps-region', 'mapillary', 'kartaview'];
  // wants: [connector id, label] this module looks for, in the order shown. The id is the id in the connector's own manifest.
  // A connector is also matched when its capabilities list names `ghost-<module id>`.
  const MODULES = [
    { id: 'domains', name: 'Domains and networks', icon: 'globe', scope: 'passive', inputs: ['domain', 'ip', 'asn', 'url'], placeholder: 'domain, IP, ASN or URL', blurb: 'DNS records, registration, certificates in public logs, hosting network, reverse DNS, headers of one page.',
      wants: [['dns-doh', 'DNS records'], ['rdap-domain', 'Registration data of a domain (RDAP)'], ['rdap-ip-asn', 'Registration data of an IP address or ASN (RDAP)'], ['ct-crtsh', 'Certificates in public logs'], ['ip-geo-local', 'IP location (local database)'], ['rdns', 'Reverse DNS'], ['web-headers', 'HTTP headers of one page'], ['security-txt', 'security.txt']] },
    { id: 'infra', name: 'Infrastructure map', icon: 'net', scope: 'passive', inputs: ['entity'], placeholder: 'an entity in your case', blurb: 'Shared addresses, certificates and name servers across what a case already holds, drawn as relations.', local: 'pivots',
      wants: [['graph-pivot', 'Pivots over the case (built in)'], ['rdap-ip-asn', 'Network and ASN registration'], ['ct-crtsh', 'Certificates in public logs']] },
    { id: 'companies', name: 'Companies and public records', icon: 'org', scope: 'passive', inputs: ['org-name', 'lei', 'domain'], placeholder: 'organisation name, LEI or domain', blurb: 'Registered entities, identifiers, public filings and linked organisations. Organisations only.', guardPeople: true,
      wants: [['gleif', 'GLEIF legal entities'], ['sec-edgar', 'SEC EDGAR filings'], ['wikidata', 'Wikidata organisations']] },
    { id: 'files', name: 'Files and images', icon: 'image', scope: 'passive', inputs: ['file'], placeholder: 'choose a file on this computer', blurb: 'Metadata, embedded location as a place, text recognition, hashes and video frames. Files never leave this computer.', fileInput: true,
      wants: [['exif-meta', 'File metadata (built in)'], ['exiftool', 'Metadata (EXIF, XMP, Office) with ExifTool'], ['mediainfo', 'Audio and video details (MediaInfo)'], ['tika', 'Document metadata (Apache Tika)'], ['hash-file', 'Hashes'], ['tesseract', 'Text in images (OCR)'], ['ocrmypdf', 'Text in scanned PDFs (OCRmyPDF)'], ['ffmpeg-frames', 'Video frames']] },
    { id: 'places', name: 'Places', icon: 'pin', scope: 'passive', inputs: ['place-text', 'coords'], placeholder: 'a site, landmark or "lat, lon"', blurb: 'Geocoding for organisations, sites and landmarks, map pins, a globe, street-level imagery.', guardPeople: true, places: true,
      wants: [['wikidata', 'Wikidata places'], ['nasa-cmr', 'Satellite data search (NASA Earthdata)'], ['usgs-landsat', 'Landsat scene search (USGS)'], ['gdal-info', 'Map and raster file details (GDAL)'], ['qgis-open', 'Open a map file in QGIS'], ['nominatim', 'Place search (OpenStreetMap)'], ['overpass-query', 'Map features in a small area'], ['protomaps-region', 'Offline map region'], ['nasa-gibs', 'Satellite imagery (NASA)'], ['earth-search-stac', 'Satellite scenes (STAC)'], ['mapillary', 'Street-level imagery (Mapillary)'], ['kartaview', 'Street-level imagery (KartaView)']] },
    { id: 'news', name: 'News and events', icon: 'news', scope: 'passive', inputs: ['keyword', 'org-name', 'domain', 'place-text'], placeholder: 'keyword, organisation, domain or place', blurb: 'Global news and events volume and coverage, with a timeline of mentions and the list of sources.', guardPeople: true,
      wants: [['gdelt-doc', 'News coverage (GDELT)'], ['gdelt-geo', 'Events by place (GDELT)']] },
    { id: 'archive', name: 'Web archive', icon: 'archive', scope: 'passive', inputs: ['url', 'domain'], placeholder: 'URL or domain', blurb: 'Snapshot history, first and last capture, and saved copies of pages for the case.',
      wants: [['wayback-cdx', 'Internet Archive captures'], ['archivebox', 'Saved copies in your own ArchiveBox'], ['common-crawl-index', 'Common Crawl index'], ['local-snapshot', 'Local snapshot of a page']] },
    { id: 'threat', name: 'Threat intel', icon: 'threat', scope: 'passive', inputs: ['keyword', 'file', 'rules-file', 'log-file', 'instance-url'], placeholder: 'indicator, CVE id or file', blurb: 'Indicators, YARA and Sigma rules you bring, public lists, and your own MISP or OpenCTI.',
      wants: [['stix-import', 'STIX import'], ['yara', 'YARA scan of a file'], ['sigma-match', 'Sigma rules on your logs'], ['cisa-kev', 'CISA known exploited list'], ['nvd', 'NVD vulnerabilities'], ['misp-client', 'Your MISP'], ['opencti-client', 'Your OpenCTI'], ['opensearch-client', 'Your OpenSearch'], ['neo4j-client', 'Your Neo4j'],
        ['subfinder', 'Subdomains (Subfinder, passive)'], ['findomain', 'Subdomains (Findomain, passive)'], ['amass', 'Amass (passive)'], ['dnsx', 'DNS resolver checks (dnsx)'], ['recon-ng', 'Recon-ng host discovery (passive)'], ['spiderfoot', 'SpiderFoot domain footprint'], ['theharvester', 'theHarvester company domain (hosts only)'], ['bbot', 'BBOT passive discovery'], ['openosint', 'OpenOSINT (not wired yet)'],
        ['zeek', 'Zeek on a capture file'], ['suricata', 'Suricata on a capture file']] },
    { id: 'scan', name: 'Active scanning', icon: 'scan', scope: 'active', inputs: ['domain', 'ip', 'cidr'], placeholder: 'a domain or IP you own or may test', blurb: 'Port and service discovery, TLS and web checks. Only behind the scope guard, and every scan is logged in your vault.', active: true,
      wants: [['nmap', 'Nmap'], ['testssl', 'testssl.sh TLS check'], ['zap-baseline', 'OWASP ZAP baseline'], ['masscan', 'Masscan'], ['whatweb', 'WhatWeb site fingerprint'], ['photon', 'Photon site crawl'], ['bbot-active', 'BBOT active web scan']] },
  ];
  const byId = (id) => MODULES.find((m) => m.id === id) || null;
  const wantedIds = () => [...new Set(MODULES.flatMap((m) => m.wants.map((w) => w[0])))];
  const isShipped = (id) => BUILTIN.includes(id) || SECURITY.includes(id);
  // The one honest state of a connector on a screen. entry is the manager's list entry, or null when the connector is not on this computer.
  //   not-installed | needs-approval | program-missing | test-failed | not-tested | passed
  function statusOf(entry, id) {
    if (!entry) return { key: 'not-installed', label: 'Not installed', planned: PLANNED.includes(id), detail: PLANNED.includes(id) ? 'Not built yet.' : isShipped(id) ? 'Ghost has not set it up on this computer yet.' : 'Not on this computer.' };
    if (entry.health === 'broken') return { key: 'not-installed', label: 'Not installed', detail: 'Its files are missing or not valid.' };
    if (entry.state === 'not-approved') return { key: 'needs-approval', label: 'Needs your approval', detail: entry.health === 'changed' ? 'Its files changed after you approved it.' : 'Nothing runs until you approve it.' };
    const reqs = (entry.install && entry.install.requirements) || [], bad = reqs.find((r) => r.status !== 'ok' && r.status !== 'untested');
    const v = entry.install && entry.install.verified;
    if (bad) return { key: 'program-missing', label: 'Program missing', detail: bad.name + ' is not available on this computer.' };
    if (v === 'failed') return { key: 'test-failed', label: 'Test failed', detail: String((entry.install.lastTest && entry.install.lastTest.detail) || '') };
    if (v === 'tested' && entry.install.installed) return { key: 'passed', label: 'Test passed', detail: '' };
    return { key: 'not-tested', label: 'Not tested', detail: 'It has not passed its own test on this computer.' };
  }
  return { MODULES, INPUT_KINDS, BUILTIN, SECURITY, PLANNED, isShipped, statusOf, byId, wantedIds };
});
