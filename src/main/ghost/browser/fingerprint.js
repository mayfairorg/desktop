'use strict';
// Ghost investigation browser: fingerprint reduction. Honest scope: this narrows what a page can READ through script and headers so every
// case window looks alike. It cannot make the browser look like every other browser: see LIMITS.
const FIXED = Object.freeze({
  locale: 'en-US', languages: ['en-US', 'en'], acceptLanguage: 'en-US,en;q=0.9', timezone: 'UTC',
  screen: Object.freeze({ width: 1920, height: 1080, colorDepth: 24, dpr: 1 }),
  platform: 'Win32', cores: 4, memory: 8,
  glVendor: 'Google Inc.', glRenderer: 'ANGLE (Generic Renderer)',
});
const LIMITS = Object.freeze([
  'Window size and layout still vary and can be measured; the screen values reported are fixed.',
  'Installed fonts can be inferred from text measurements.',
  'Network-level traits (TLS and HTTP/2 behaviour) identify a Chromium browser and its rough version.',
  'Blocking canvas and audio readouts is itself unusual, and some sites will not work.',
  'Timing, the exact browser version, and how a person types and moves the mouse are not hidden.',
  'A site you sign in to knows who you are, whatever the fingerprint.',
]);

function userAgent(chromeVersion) {
  const major = String(chromeVersion || '140.0.0.0').split('.')[0];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
function metadata(chromeVersion) {
  const major = String(chromeVersion || '140.0.0.0').split('.')[0];
  return {
    brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not=A?Brand', version: '24' }],
    fullVersionList: [{ brand: 'Chromium', version: major + '.0.0.0' }, { brand: 'Google Chrome', version: major + '.0.0.0' }, { brand: 'Not=A?Brand', version: '24.0.0.0' }],
    fullVersion: major + '.0.0.0', platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false,
  };
}
// The DevTools-protocol calls made before the first real load.
function cdpCommands(chromeVersion) {
  return [
    ['Page.enable', {}],
    ['Emulation.setUserAgentOverride', { userAgent: userAgent(chromeVersion), acceptLanguage: FIXED.acceptLanguage, platform: FIXED.platform, userAgentMetadata: metadata(chromeVersion) }],
    ['Emulation.setTimezoneOverride', { timezoneId: FIXED.timezone }],
    ['Emulation.setLocaleOverride', { locale: FIXED.locale }],
    // width/height 0 keep the real viewport; only window.screen is fixed
    ['Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: FIXED.screen.dpr, mobile: false, screenWidth: FIXED.screen.width, screenHeight: FIXED.screen.height }],
    ['Page.addScriptToEvaluateOnNewDocument', { source: script() }],
  ];
}

// Runs before any page script. Only narrows values and removes readouts; no page code is rewritten.
function script() {
  const F = JSON.stringify(FIXED);
  return `(()=>{try{const F=${F};
const def=(o,k,v)=>{try{Object.defineProperty(o,k,{get:()=>v,configurable:true})}catch(e){}};
const N=typeof Navigator!=='undefined'?Navigator.prototype:null;
if(N){def(N,'hardwareConcurrency',F.cores);def(N,'deviceMemory',F.memory);def(N,'languages',Object.freeze(F.languages.slice()));def(N,'language',F.locale);
def(N,'platform',F.platform);def(N,'plugins',Object.freeze([]));def(N,'mimeTypes',Object.freeze([]));def(N,'maxTouchPoints',0);
def(N,'getBattery',undefined);def(N,'connection',undefined);def(N,'getGamepads',()=>[]);
def(N,'mediaDevices',{enumerateDevices:()=>Promise.resolve([]),getUserMedia:()=>Promise.reject(new DOMException('Not allowed','NotAllowedError')),getDisplayMedia:()=>Promise.reject(new DOMException('Not allowed','NotAllowedError')),addEventListener(){},removeEventListener(){}});}
if(typeof Screen!=='undefined'){const S=Screen.prototype;def(S,'width',F.screen.width);def(S,'height',F.screen.height);def(S,'availWidth',F.screen.width);def(S,'availHeight',F.screen.height);def(S,'colorDepth',F.screen.colorDepth);def(S,'pixelDepth',F.screen.colorDepth);}
if(typeof window!=='undefined'){def(window,'devicePixelRatio',F.screen.dpr);}
const BLANK='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
if(typeof HTMLCanvasElement!=='undefined'){const C=HTMLCanvasElement.prototype;C.toDataURL=function(){return BLANK};C.toBlob=function(cb){try{const b=atob(BLANK.split(',')[1]);const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);setTimeout(()=>cb(new Blob([a],{type:'image/png'})),0)}catch(e){cb(null)}};}
if(typeof CanvasRenderingContext2D!=='undefined'){CanvasRenderingContext2D.prototype.getImageData=function(x,y,w,h){return new ImageData(Math.max(1,Math.abs(w|0)),Math.max(1,Math.abs(h|0)))};}
if(typeof OffscreenCanvas!=='undefined'){OffscreenCanvas.prototype.convertToBlob=function(){return Promise.reject(new DOMException('Not allowed','NotAllowedError'))};}
for(const n of ['WebGLRenderingContext','WebGL2RenderingContext']){const G=typeof window!=='undefined'?window[n]:undefined;if(!G)continue;const gp=G.prototype.getParameter;
G.prototype.getParameter=function(p){if(p===37445)return F.glVendor;if(p===37446)return F.glRenderer;return gp.call(this,p)};
G.prototype.readPixels=function(x,y,w,h,f,t,buf){if(buf&&buf.fill)buf.fill(0)};}
if(typeof AnalyserNode!=='undefined'){for(const m of ['getFloatFrequencyData','getByteFrequencyData','getFloatTimeDomainData','getByteTimeDomainData']){AnalyserNode.prototype[m]=function(a){if(a&&a.fill)a.fill(0)}}}
if(typeof OfflineAudioContext!=='undefined'){const sr=OfflineAudioContext.prototype.startRendering;OfflineAudioContext.prototype.startRendering=function(){return sr.call(this).then((b)=>{try{for(let c=0;c<b.numberOfChannels;c++)b.getChannelData(c).fill(0)}catch(e){}return b})};}
if(typeof AudioBuffer!=='undefined'){const g=AudioBuffer.prototype.copyFromChannel;AudioBuffer.prototype.copyFromChannel=function(d){if(d&&d.fill)d.fill(0)};}
for(const n of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCSessionDescription','RTCIceCandidate']){try{if(typeof window!=='undefined'&&n in window)Object.defineProperty(window,n,{value:undefined,configurable:true})}catch(e){}}
}catch(e){}})();`;
}

module.exports = { FIXED, LIMITS, userAgent, metadata, cdpCommands, script };
