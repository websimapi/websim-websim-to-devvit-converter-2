// Processing Logic (Dependencies, Imports, HTML Parsing)

// Helper to sanitize filenames
export const cleanName = (name) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export function uint8ToString(u8) {
  if (typeof u8 === 'string') return u8;
  if (!(u8 instanceof Uint8Array)) return String(u8 ?? '');
  return new TextDecoder().decode(u8);
}

// --- Dependency Management ---

export class DependencyManager {
    constructor() {
        this.downloads = new Map(); // url -> { localPath, processPromise }
        this.vendorCount = 0;
    }

    normalizeLibraryUrl(url) {
        if (!url) return null;
        const lower = url.toLowerCase();
        
        // Use reliable ESM builds from unpkg/esm.sh for core libs
        if (lower.includes('/three@') || lower.endsWith('/three') || lower.endsWith('/three.js') || lower === 'three') {
             if (!lower.includes('/addons/') && !lower.includes('/examples/') && !lower.includes('three-')) {
                 return 'https://unpkg.com/three@0.160.0/build/three.module.js';
             }
        }
        
        if (lower.includes('tween.js') || lower === '@tweenjs/tween.js') {
            return 'https://unpkg.com/@tweenjs/tween.js@23.1.1/dist/tween.esm.js';
        }
        
        return null;
    }

    resolve(importSource, referrerUrl = null) {
        let downloadUrl;
        
        if (referrerUrl) {
            try {
                if (importSource.startsWith('.')) {
                    downloadUrl = new URL(importSource, referrerUrl).href;
                } else if (importSource.startsWith('http')) {
                    downloadUrl = importSource;
                } else if (importSource.startsWith('/')) {
                     const origin = new URL(referrerUrl).origin;
                     downloadUrl = new URL(importSource, origin).href;
                } else {
                    downloadUrl = `https://esm.sh/${importSource}?target=es2020`;
                }
            } catch (e) {
                return importSource;
            }
        } else {
            if (importSource.startsWith('.') || importSource.startsWith('/')) {
                return importSource; 
            }
            if (importSource.startsWith('http')) {
                downloadUrl = importSource;
            } else {
                downloadUrl = `https://esm.sh/${importSource}?target=es2020`;
            }
        }

        const canonical = this.normalizeLibraryUrl(downloadUrl || importSource);
        if (canonical) {
            downloadUrl = canonical;
        }

        // --- Three.js Global Shim ---
        if (downloadUrl && (downloadUrl.includes('/three') || downloadUrl.includes('three.module.js')) && !downloadUrl.includes('/addons/')) {
            const coreUrl = downloadUrl;
            const wrapperPath = './vendor/three.js';
            const wrapperKey = 'virtual:three-global-wrapper';
            
            if (this.downloads.has(wrapperKey)) return wrapperPath;

            let coreFilename = 'three-core.js';
            const corePath = `./vendor/${coreFilename}`;
            
            this.downloads.set(coreUrl, {
                localPath: corePath,
                processPromise: this._fetchAndProcess(coreUrl, false) // Don't mangle huge three.js
            });

            this.downloads.set(wrapperKey, {
                localPath: wrapperPath,
                processPromise: Promise.resolve(`
import * as THREE_NS from './three-core.js';
const THREE = {};
function copyProps(src) {
    if (!src) return;
    Object.getOwnPropertyNames(src).forEach(key => {
        if (key === 'default' || key === '__esModule') return;
        try { THREE[key] = src[key]; } catch(e) {}
    });
}
copyProps(THREE_NS);
if (THREE_NS.default && typeof THREE_NS.default === 'object') copyProps(THREE_NS.default);
if (typeof window !== 'undefined') {
    window.THREE = THREE;
    console.log('[WebSim] THREE.js Shim: Global window.THREE initialized.', { 
        rev: THREE.REVISION, 
        hasScene: !!THREE.Scene,
        keys: Object.keys(THREE).length
    });
}
export default THREE;
export * from './three-core.js';`)
            });
            return wrapperPath;
        }

        if (this.downloads.has(downloadUrl)) {
            return this.downloads.get(downloadUrl).localPath;
        }

        let safeName = `vendor-${this.vendorCount++}`;
        try {
            const u = new URL(downloadUrl);
            const pathParts = u.pathname.split('/');
            const filename = pathParts[pathParts.length - 1];
            if (filename && filename.length < 50) {
                 const base = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9.-]/g, '_');
                 if (base) safeName = `${this.vendorCount}_${base}`;
            }
        } catch(e) {}
        
        const localPath = `./vendor/${safeName}.js`;
        this.downloads.set(downloadUrl, { 
            localPath, 
            processPromise: this._fetchAndProcess(downloadUrl) 
        });
        
        return localPath;
    }

    async _fetchAndProcess(url, shouldRewrite = true) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
            let code = await res.text();

            if (!shouldRewrite) return `// Source: ${url}\n${code}`;

            const rewritePath = (specifier) => {
                 // Prevent infinite loops/over-incrementing vendorCount during rewrite
                 if (specifier.startsWith('http') || !specifier.match(/^\.?\.?\//)) {
                    const resolvedLocal = this.resolve(specifier, url);
                    const parts = resolvedLocal.split('/');
                    return `./${parts[parts.length - 1]}`;
                 }
                 return specifier;
            };

            const regex = /(from\s*['"]|import\s*['"]|import\s*\(\s*['"])([^'"]+)(['"]\s*\)?)/g;
            code = code.replace(regex, (match, prefix, src, suffix) => {
                if (src.startsWith('data:') || src.startsWith('#')) return match;
                return `${prefix}${rewritePath(src)}${suffix}`;
            });

            return `// Source: ${url}\n${code}`;
        } catch (err) {
            console.error("Vendor download error:", err);
            return `/* Error downloading ${url}: ${err.message} */`;
        }
    }

    async getVendorFiles() {
        const files = {};
        const processed = new Set();
        
        while(true) {
            const urls = Array.from(this.downloads.keys());
            let hasNew = false;
            
            for(const url of urls) {
                if(processed.has(url)) continue;
                hasNew = true;
                processed.add(url);
                
                const entry = this.downloads.get(url);
                let content = await entry.processPromise;
                
                content = content.replace(/from\s*['"]([^'"]+)\.mjs['"]/g, "from '$1.js'");
                
                const zipPath = entry.localPath.replace(/^\.\//, '');
                files[zipPath] = content;
            }
            if(!hasNew) break;
        }
        return files;
    }
}

function computeRelativePath(fromFile, toRootPath) {
    // toRootPath is like "./vendor/file.js"
    const targetPath = toRootPath.replace(/^\.\//, ''); // "vendor/file.js"
    
    const fromParts = fromFile.split('/');
    fromParts.pop(); // remove filename, get dir parts
    
    if (fromParts.length === 0) return `./${targetPath}`;
    
    const up = fromParts.map(() => '..').join('/');
    return `${up}/${targetPath}`;
}

// Parse JS files to detect imports, download them, and rewrite paths
export function processJsForImports(jsContent, depManager, filePath) {
  let js = uint8ToString(jsContent);
  let isModule = false;
  let usesGlobalThree = false;

  // Basic check for module syntax
  if (/^\s*(import|export)\s/m.test(js) || /import\s*\(/.test(js)) {
    isModule = true;
  }
  
  // Fix Common Legacy Import Issues

  // Heuristic: If script uses global THREE, treat it as a module so it waits for vendor injection
  // Exclude actual Three.js library files from this heuristic to prevent breaking UMD definitions
  const isLib = /(^|\/)three(\.min)?\.js$/i.test(filePath) || /(^|\/)three-core\.js$/i.test(filePath);
  
  if (!isLib) {
      // Check for global usage pattern (and not just inside an import statement)
      if ((js.includes('THREE.') || js.includes('new THREE')) && !js.includes('import * as THREE')) {
          usesGlobalThree = true;
          isModule = true; // Force module to ensure defer loading if possible
      }
  }

  // Regex to match imports:
  // 1. import ... from "..."
  // 2. export ... from "..."
  // 3. import("...")
  
  const replaceCallback = (match, prefix, source, suffix) => {
      // If it looks like a remote URL or bare import, resolve it
      if (source.startsWith('http') || !source.match(/^\.?\.?\//)) {
          const rootLocalPath = depManager.resolve(source);
          const relativePath = computeRelativePath(filePath, rootLocalPath);
          return `${prefix}${relativePath}${suffix}`;
      }
      // Fix local .mjs imports
      if (source.endsWith('.mjs')) {
          return `${prefix}${source.replace(/\.mjs$/, '.js')}${suffix}`;
      }
      return match;
  };

  // Replace 'from "..."'
  js = js.replace(/(from\s*['"])([^'"]+)(['"])/g, replaceCallback);

  // Replace 'import "..."' (side effect)
  js = js.replace(/(import\s*['"])([^'"]+)(['"])/g, replaceCallback);

  // Replace dynamic import('...')
  js = js.replace(/(import\s*\(\s*['"])([^'"]+)(['"]\s*\))/g, replaceCallback);

  return { content: js, isModule, usesGlobalThree };
}

// Parse HTML to extract scripts and handle import maps
export function processHtmlForCSP(htmlContent, filePath, depManager, knownModules = new Set(), forceThree = false) {
  let html = uint8ToString(htmlContent);
  const baseFilename = filePath.split('/').pop();
  const extractedScripts = [];
  let scriptCounter = 0;

  // Add DOCTYPE if missing
  if (!html.trim().toLowerCase().startsWith('<!doctype')) {
    html = '<!DOCTYPE html>\n' + html;
  }
  
  // Detect if THREE is used in the HTML itself
  let needsThree = forceThree;
  if (!needsThree && (html.includes('THREE.') || html.includes('new THREE'))) {
      needsThree = true;
  }

  // Calculate relative path to root for vendor files
  const depth = filePath.split('/').filter(p => p && p !== '.').length - 1;
  const toRoot = depth > 0 ? '../'.repeat(depth) : './';

  // 1. Inject Logger & Socket Polyfill
  let polyfills = `<script src="${toRoot}logger.js"></script>\n    <script src="${toRoot}websim_socket.js"></script>`;
  
  if (needsThree) {
      const threePathRaw = depManager.resolve('three'); 
      const threePath = threePathRaw.replace(/^\.\//, toRoot);
      polyfills += `\n    <script src="${threePath}" type="module"></script>`;
  }

  if (html.includes('<head>')) {
    html = html.replace('<head>', '<head>\n    ' + polyfills);
  } else if (html.includes('<body>')) {
    html = html.replace('<body>', '<body>\n    ' + polyfills);
  } else {
    html = polyfills + '\n' + html;
  }

  // 2. Handle Import Maps
  // Remove import maps to prevent CSP inline script violations.
  // We rewrite all imports in JS files (including extracted inline scripts) so the map is redundant.
  html = html.replace(/<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi, '<!-- Import Map Removed -->');

  // 3. Process Scripts
  const normalizePath = (p) => p.replace(/^(\.|\/)+/, '');

  html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, content) => {
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    if (srcMatch) {
        let src = srcMatch[1];
        if (src.endsWith('.mjs')) {
             src = src.replace(/\.mjs$/, '.js');
             attrs = attrs.replace(srcMatch[1], src);
        }

        if (src.startsWith('http') || src.startsWith('//')) {
            if (src.startsWith('//')) src = 'https:' + src;
            const localPathRaw = depManager.resolve(src);
            const localPath = localPathRaw.replace(/^\.\//, toRoot);
            
            let newAttrs = attrs.replace(srcMatch[0], `src="${localPath}"`);
            if (!newAttrs.includes('type="module"')) newAttrs += ' type="module"';
            return `<script ${newAttrs}></script>`;
        }

        const dir = filePath.split('/').slice(0, -1).join('/');
        const fullLocalPath = dir ? normalizePath(`${dir}/${src}`) : normalizePath(src);
        
        let found = false;
        for (const modPath of knownModules) {
            if (normalizePath(modPath) === fullLocalPath) {
                found = true;
                break;
            }
        }

        if (found && !attrs.includes('type="module"')) {
            return `<script type="module" ${attrs}></script>`;
        }
        return match;
    }

    if (!content.trim() || attrs.includes('type="application/json"')) return match;

    scriptCounter++;
    const safeBase = baseFilename.replace(/[^\w-]/g, '_');
    const scriptFilename = `${safeBase}_inline_${scriptCounter}.js`;
    
    const processed = processJsForImports(content, depManager, filePath);
    let isModule = processed.isModule || /\btype\s*=\s*["']module["']/i.test(attrs);
    if (processed.usesGlobalThree) needsThree = true;

    extractedScripts.push({ filename: scriptFilename, content: processed.content, usesGlobalThree: processed.usesGlobalThree });

    let newAttrs = attrs;
    if (isModule && !newAttrs.toLowerCase().includes('type="module"')) newAttrs += ' type="module"';
    return `<script src="${scriptFilename}" ${newAttrs}></script>`;
  });

  // Remove CSP violations
  html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');

  return { html, extractedScripts };
}

