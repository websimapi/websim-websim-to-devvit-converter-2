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
        
        // Force singleton Three.js
        if (lower.includes('/three@') || lower.endsWith('/three') || lower.endsWith('/three.js') || lower === 'three') {
             // Avoid addons/examples
             if (!lower.includes('/addons/') && !lower.includes('/examples/') && !lower.includes('three-')) {
                 return 'https://esm.sh/three@0.160.0?target=es2020';
             }
        }
        
        // Force singleton Tween.js
        if (lower.includes('tween.js') || lower === '@tweenjs/tween.js') {
            return 'https://esm.sh/@tweenjs/tween.js@23.1.1?target=es2020';
        }
        
        return null;
    }

    // Resolves an import. 
    resolve(importSource, referrerUrl = null) {
        let downloadUrl;
        
        // 1. Determine URL
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
                    downloadUrl = `https://esm.sh/${importSource}?target=es2020&bundle&deps-inline=true`;
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
                downloadUrl = `https://esm.sh/${importSource}?target=es2020&bundle&deps-inline=true`;
            }
        }

        // 1.5. Canonicalize
        const canonical = this.normalizeLibraryUrl(downloadUrl || importSource);
        if (canonical) {
            downloadUrl = canonical;
        }

        // --- SPECIAL: Three.js Wrapper (Global Shim) ---
        // Generates a wrapper file that exports Three modules AND sets window.THREE
        if (downloadUrl && (downloadUrl.includes('/three@') || downloadUrl.includes('/three.js')) && !downloadUrl.includes('/addons/')) {
            const coreUrl = downloadUrl;
            const corePath = './vendor/three-core.js';
            const wrapperPath = './vendor/three.js';
            const wrapperKey = 'virtual:three-global-wrapper';

            // Ensure core is downloaded
            if (!this.downloads.has(coreUrl)) {
                this.downloads.set(coreUrl, {
                    localPath: corePath,
                    processPromise: this._fetchAndProcess(coreUrl)
                });
            }

            // Ensure wrapper exists
            if (!this.downloads.has(wrapperKey)) {
                this.downloads.set(wrapperKey, {
                    localPath: wrapperPath,
                    processPromise: Promise.resolve(`
import * as THREE_NS from './three-core.js';
const THREE = (THREE_NS && THREE_NS.default) ? THREE_NS.default : THREE_NS;
if (typeof window !== 'undefined') {
    window.THREE = THREE;
}
export default THREE;
export * from './three-core.js';
`)
                });
            }
            return wrapperPath;
        }

        // 2. Check Cache
        if (this.downloads.has(downloadUrl)) {
            return this.downloads.get(downloadUrl).localPath;
        }

        // 3. Generate Local Path
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

        // 4. Start Download
        this.downloads.set(downloadUrl, { 
            localPath, 
            processPromise: this._fetchAndProcess(downloadUrl) 
        });
        
        return localPath;
    }

    async _fetchAndProcess(url) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
            let code = await res.text();

            const rewritePath = (specifier) => {
                 const resolvedLocal = this.resolve(specifier, url);
                 // If resolved is absolute/remote, it might be an issue, but usually resolve handles it.
                 // Ensure we keep relative paths clean
                 if (!resolvedLocal.startsWith('.')) return resolvedLocal;
                 
                 const parts = resolvedLocal.split('/');
                 return `./${parts[parts.length - 1]}`;
            };

            const regex = /(from\s*['"]|import\s*['"]|import\s*\(\s*['"])([^'"]+)(['"]\s*\)?)/g;
            code = code.replace(regex, (match, prefix, src, suffix) => {
                if (src.startsWith('data:')) return match;
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

  // Basic check for module syntax
  if (/^\s*(import|export)\s/m.test(js) || /import\s*\(/.test(js)) {
    isModule = true;
  }
  
  // Fix Common Legacy Import Issues

  // Heuristic: If script uses global THREE, treat it as a module so it waits for vendor injection
  if (js.includes('THREE.') || js.includes('new THREE')) {
      isModule = true;
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

  return { content: js, isModule };
}

// Parse HTML to extract scripts and handle import maps
export function processHtmlForCSP(htmlContent, filePath, depManager, knownModules = new Set()) {
  let html = uint8ToString(htmlContent);
  const baseFilename = filePath.split('/').pop();
  const extractedScripts = [];
  let scriptCounter = 0;

  // Add DOCTYPE if missing
  if (!html.trim().toLowerCase().startsWith('<!doctype')) {
    html = '<!DOCTYPE html>\n' + html;
  }

  // 1. Inject Logger & Socket Polyfill
  const polyfills = '<script src="logger.js"></script>\n    <script src="websim_socket.js"></script>';
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
  html = html.replace(/<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi, '<!-- Import Map Removed by Converter -->');

  // 3. Process Scripts
  html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, content) => {
    
    // CASE A: External Script
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    if (srcMatch) {
        let src = srcMatch[1];
        
        // Fix mjs extension
        if (src.endsWith('.mjs')) {
             src = src.replace(/\.mjs$/, '.js');
             attrs = attrs.replace(srcMatch[1], src);
        }

        // If it's remote, we must download it!
        if (src.startsWith('http') || src.startsWith('//')) {
            if (src.startsWith('//')) src = 'https:' + src;
            const localPath = depManager.resolve(src);
            
            let newAttrs = attrs.replace(srcMatch[0], `src="${localPath}"`);
            
            // Force type="module" for downloaded dependencies (esm.sh) to ensure they load correctly
            if (!newAttrs.includes('type="module"') && !newAttrs.includes("type='module'")) {
                 newAttrs += ' type="module"';
            }

            return `<script ${newAttrs}>${content}</script>`;
        }

        let filename = src;
        // Clean path to match map keys
        const cleanKey = filename.replace(/^(\.|\/)+/, '');
        
        if (knownModules.has(cleanKey)) {
            if (!attrs.includes('type="module"') && !attrs.includes("type='module'")) {
                return `<script type="module" ${attrs}>${content}</script>`;
            }
        }
        return match;
    }

    // CASE B: Inline Script
    if (!content.trim()) return '';

    // If it's a JSON script (importmap, ld+json), leave it alone
    if (attrs.includes('type="application/json"') || attrs.includes('type="importmap"')) {
        return match;
    }

    scriptCounter++;
    const safeBase = baseFilename.replace(/[^\w-]/g, '_');
    const scriptFilename = `${safeBase}_inline_${scriptCounter}.js`;
    
    let isModule = /\btype\s*=\s*["']module["']/i.test(attrs);
    
    const processed = processJsForImports(content, depManager, filePath);
    if (processed.isModule) isModule = true;

    extractedScripts.push({ filename: scriptFilename, content: processed.content });

    let newAttrs = attrs;
    if (isModule && !newAttrs.toLowerCase().includes('type="module"')) {
        newAttrs += ' type="module"';
    }
    
    return `<script src="${scriptFilename}" ${newAttrs}></script>`;
  });

  // Remove CSP violations
  html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');

  return { html, extractedScripts };
}

