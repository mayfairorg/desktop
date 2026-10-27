'use strict';
// Ghost modules: what each module screen is, which connectors it looks for, and what it accepts as input.
// Data only. A module screen runs the connectors that are installed on this computer (through the Ghost connector core) and shows
// "Connector not installed" for the ones that are not: it never invents a result. The input kinds are a closed list that has no person, username, email or phone.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.GhostModules = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const INPUT_KINDS = ['domain', 'ip', 'cidr', 'asn', 'url', 'cert-hash', 'org-name', 'lei', 'file', 'place-text', 'coords', 'keyword', 'rules-file', 'log-file', 'instance-url', 'entity'];
  // wants: connector ids this module looks for, in the order shown. A connector is also matched when its capabilities list names `ghost-<module id>`.
  const MODULES = [
    { id: 'domains', name: 'Domains and networks', icon: 'globe', scope: 'passive', inputs: ['domain', 'ip', 'asn', 'url'], placeholder: 'domain, IP, ASN or URL', blurb: 'DNS records, registration, certificates in public logs, hosting network, reverse DNS, headers of one page.',
      wants: [['dns-doh', 'DNS records'], ['rdap', 'Registration data (RDAP)'], ['ct-crtsh', 'Certificates in public logs'], ['asn-ripestat', 'Hosting network and ASN'], ['ip-geo-local', 'IP location (local database)'], ['rdns', 'Reverse DNS'], ['web-headers', 'HTTP headers of one page'], ['security-txt', 'security.txt']] },
    { id: 'infra', name: 'Infrastructure map', icon: 'net', scope: 'passive', inputs: ['entity'], placeholder: 'an entity in your case', blurb: 'Shared addresses, certificates and name servers across what a case already holds, drawn as relations.', local: 'pivots',
      wants: [['graph-pivot', 'Pivots over the case (built in)'], ['asn-ripestat', 'ASN neighbours'], ['ct-crtsh', 'Certificates in public logs']] },
    { id: 'companies', name: 'Companies and public records', icon: 'org', scope: 'passive', inputs: ['org-name', 'lei', 'domain'], placeholder: 'organisation name, LEI or domain', blurb: 'Registered entities, identifiers, public filings and linked organisations. Organisations only.', guardPeople: true,
      wants: [['gleif', 'GLEIF legal entities'], ['sec-edgar', 'SEC EDGAR filings'], ['wikidata', 'Wikidata organisations'], ['companies-house-uk', 'Companies House (your own key)'], ['opencorporates', 'OpenCorporates (your own key)']] },
    { id: 'files', name: 'Files and images', icon: 'image', scope: 'passive', inputs: ['file'], placeholder: 'choose a file on this computer', blurb: 'Metadata, embedded location as a place, text recognition, hashes and video frames. Files never leave this computer.', fileInput: true,
      wants: [['exiftool', 'Metadata (EXIF, XMP, Office)'], ['pdf-meta', 'PDF metadata'], ['hash-file', 'Hashes'], ['tesseract', 'Text in images (OCR)'], ['ffmpeg-frames', 'Video frames']] },
    { id: 'places', name: 'Places', icon: 'pin', scope: 'passive', inputs: ['place-text', 'coords'], placeholder: 'a site, landmark or "lat, lon"', blurb: 'Geocoding for organisations, sites and landmarks, map pins, a globe, street-level imagery.', guardPeople: true, places: true,
      wants: [['nominatim', 'Place search (OpenStreetMap)'], ['overpass-query', 'Map features in a small area'], ['protomaps-region', 'Offline map region'], ['nasa-gibs', 'Satellite imagery (NASA)'], ['earth-search-stac', 'Satellite scenes (STAC)'], ['mapillary', 'Street-level imagery (Mapillary)'], ['kartaview', 'Street-level imagery (KartaView)']] },
    { id: 'news', name: 'News and events', icon: 'news', scope: 'passive', inputs: ['keyword', 'org-name', 'domain', 'place-text'], placeholder: 'keyword, organisation, domain or place', blurb: 'Global news and events volume and coverage, with a timeline of mentions and the list of sources.', guardPeople: true,
      wants: [['gdelt-doc', 'News coverage (GDELT)'], ['gdelt-geo', 'Events by place (GDELT)']] },
    { id: 'archive', name: 'Web archive', icon: 'archive', scope: 'passive', inputs: ['url', 'domain'], placeholder: 'URL or domain', blurb: 'Snapshot history, first and last capture, and saved copies of pages for the case.',
      wants: [['wayback-cdx', 'Internet Archive captures'], ['common-crawl-index', 'Common Crawl index'], ['local-snapshot', 'Local snapshot of a page']] },
    { id: 'threat', name: 'Threat intel', icon: 'threat', scope: 'passive', inputs: ['keyword', 'file', 'rules-file', 'log-file', 'instance-url'], placeholder: 'indicator, CVE id or file', blurb: 'Indicators, YARA and Sigma rules you bring, public lists, and your own MISP or OpenCTI.',
      wants: [['stix-import', 'STIX import'], ['yara', 'YARA scan of a file'], ['sigma-match', 'Sigma rules on your logs'], ['cisa-kev', 'CISA known exploited list'], ['nvd', 'NVD vulnerabilities'], ['misp-client', 'Your MISP'], ['opencti-client', 'Your OpenCTI'], ['abusech', 'abuse.ch (your own key)'], ['subfinder', 'Subdomains (passive)'], ['dnsx', 'DNS resolver checks'], ['amass', 'Amass'], ['whatweb', 'Web technology'], ['zeek', 'Zeek on a capture file'], ['suricata', 'Suricata on a capture file']] },
    { id: 'scan', name: 'Active scanning', icon: 'scan', scope: 'active', inputs: ['domain', 'ip', 'cidr'], placeholder: 'a domain or IP you own or may test', blurb: 'Port and service discovery, TLS and web checks. Only behind the scope guard, and every scan is logged in your vault.', active: true,
      wants: [['nmap', 'Nmap'], ['testssl', 'testssl.sh'], ['zap-baseline', 'OWASP ZAP baseline'], ['masscan', 'Masscan']] },
  ];
  const byId = (id) => MODULES.find((m) => m.id === id) || null;
  const wantedIds = () => [...new Set(MODULES.flatMap((m) => m.wants.map((w) => w[0])))];
  return { MODULES, INPUT_KINDS, byId, wantedIds };
});
