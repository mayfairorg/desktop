'use strict';
// Ghost app: what each lookup that ships with Mayfair is for. Data and tiny pure functions only, no I/O.
//   category : the group the tool index shows
//   kinds    : the kinds of search input the master search may hand to the tool (a closed list, see search.js KINDS)
//   input    : (kind, value) -> the tool's own input object (checked again against the tool's manifest before anything runs)
//   program  : the separate program the tool needs on this computer (its own requirement check decides, not this file)
//   own      : a tool that needs something the person brings (their own ArchiveBox): never joins a master search by itself
// A tool that is not named here still works from its own page; it just has no master-search mapping.

const CATEGORIES = ['Domains and networks', 'Companies', 'Files and images', 'Places', 'News', 'Archive', 'Threat intel'];

const bbox = (value, d = 0.05) => {
  const [lat, lon] = value.split(',').map(Number);
  const r = (n) => Math.round(n * 1e5) / 1e5;
  return [r(Math.max(-180, lon - d)), r(Math.max(-90, lat - d)), r(Math.min(180, lon + d)), r(Math.min(90, lat + d))].join(',');
};
const gdelt = (kind, value) => ({ kind: { 'org-name': 'organisation', domain: 'domain', 'place-text': 'place', keyword: 'topic' }[kind], query: value });
const CVE = /^CVE-\d{4}-\d{4,}$/i;

const TOOLS = {
  'dns-doh': { category: 'Domains and networks', kinds: ['domain'], input: (k, v) => ({ domain: v, types: 'all' }) },
  'rdap-domain': { category: 'Domains and networks', kinds: ['domain'], input: (k, v) => ({ domain: v }) },
  'rdap-ip-asn': { category: 'Domains and networks', kinds: ['ip', 'asn'], input: (k, v) => ({ kind: k, value: v }) },
  'ct-crtsh': { category: 'Domains and networks', kinds: ['domain'], input: (k, v) => ({ domain: v, expired: 'exclude' }) },
  rdns: { category: 'Domains and networks', kinds: ['ip'], input: (k, v) => ({ value: v }) },
  gleif: { category: 'Companies', kinds: ['org-name', 'lei'], input: (k, v) => ({ kind: k === 'lei' ? 'lei' : 'name', query: v, limit: 10 }) },
  'sec-edgar': { category: 'Companies', kinds: ['org-name'], input: (k, v) => ({ kind: 'company', query: v, limit: 10 }) },
  wikidata: { category: 'Companies', kinds: ['org-name', 'place-text'], input: (k, v) => ({ kind: k === 'place-text' ? 'place' : 'organisation', query: v }) },
  'exif-meta': { category: 'Files and images', kinds: ['file'], input: (k, v) => ({ file: v }) },
  'hash-file': { category: 'Files and images', kinds: ['file'], input: (k, v) => ({ file: v, types: 'all' }) },
  exiftool: { category: 'Files and images', kinds: ['file'], program: 'ExifTool', input: (k, v) => ({ file: v }) },
  mediainfo: { category: 'Files and images', kinds: ['file'], program: 'MediaInfo', input: (k, v) => ({ file: v }) },
  tika: { category: 'Files and images', kinds: ['file'], program: 'Apache Tika', input: (k, v) => ({ file: v }) },
  tesseract: { category: 'Files and images', kinds: ['file'], program: 'Tesseract', input: (k, v) => ({ file: v }) },
  ocrmypdf: { category: 'Files and images', kinds: ['file'], program: 'OCRmyPDF', input: (k, v) => ({ file: v }) },
  'ffmpeg-frames': { category: 'Files and images', kinds: ['file'], program: 'FFmpeg', input: (k, v) => ({ file: v }) },
  'gdal-info': { category: 'Places', kinds: ['file'], program: 'GDAL', input: (k, v) => ({ file: v }) },
  'qgis-open': { category: 'Places', kinds: [], program: 'QGIS', input: () => null },        // opens a window: never part of a search
  nominatim: { category: 'Places', kinds: ['place-text', 'coords'], input: (k, v) => ({ kind: k === 'coords' ? 'reverse' : 'geocode', query: v, limit: 5 }) },
  'overpass-query': { category: 'Places', kinds: [], input: () => null },                    // needs a map tag as well as an area: its own page
  'usgs-landsat': { category: 'Places', kinds: ['coords'], input: (k, v) => ({ bbox: bbox(v), limit: 10 }) },
  'earth-search-stac': { category: 'Places', kinds: ['coords'], input: (k, v) => ({ bbox: bbox(v), limit: 10 }) },
  'nasa-cmr': { category: 'Places', kinds: ['keyword'], input: (k, v) => ({ kind: 'collections', query: v, limit: 10 }) },
  'nasa-gibs': { category: 'Places', kinds: [], input: () => null },                        // a picture layer and a date: its own page
  'gdelt-doc': { category: 'News', kinds: ['org-name', 'domain', 'place-text', 'keyword'], input: (k, v) => ({ ...gdelt(k, v), mode: 'articles', timespan: '1month' }) },
  'gdelt-geo': { category: 'News', kinds: ['org-name', 'domain', 'place-text', 'keyword'], input: (k, v) => ({ ...gdelt(k, v), timespan: '1month', limit: 10 }) },
  'wayback-cdx': { category: 'Archive', kinds: ['url', 'domain'], input: (k, v) => ({ target: v, mode: 'summary' }) },
  'common-crawl-index': { category: 'Archive', kinds: ['domain'], input: (k, v) => ({ domain: v, limit: 20 }) },
  archivebox: { category: 'Archive', kinds: [], own: 'your own ArchiveBox', input: () => null },
  'local-snapshot': { category: 'Archive', kinds: ['file'], input: (k, v) => ({ file: v }) },
  'cisa-kev': { category: 'Threat intel', kinds: ['keyword'], input: (k, v) => ({ query: v, limit: 20 }) },
  nvd: { category: 'Threat intel', kinds: ['keyword'], input: (k, v) => ({ kind: CVE.test(v) ? 'cve' : 'keyword', query: CVE.test(v) ? v.toUpperCase() : v, limit: 10 }) },
  'stix-import': { category: 'Threat intel', kinds: [], input: () => null },                 // imports a file the person says is STIX: its own page
};

const info = (id) => (Object.prototype.hasOwnProperty.call(TOOLS, id) ? TOOLS[id] : null);
module.exports = { TOOLS, CATEGORIES, info, bbox };
