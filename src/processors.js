// Processing Logic (Dependencies, Imports, HTML Parsing)

// Helper to sanitize filenames
export const cleanName = (name) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

// Sanitize a file path to prevent MIME type issues (e.g. .core.js -> _core.js)
export function sanitizeFilename(filePath) {
    const parts = filePath.split('/');
    let filename = parts.pop();
    
    // Normalize extension
    let ext = '';
    if (filename.endsWith('.mjs')) {
        ext = '.js';
        filename = filename.slice(0, -4);
    } else if (filename.endsWith('.js')) {
        ext = '.js';
        filename = filename.slice(0, -3);
    } else {
        // preserve other extensions (css, html) or no extension
        return filePath;
    }

    // Replace dots in base name with underscores to avoid "text/plain" MIME type issues
    filename = filename.replace(/\./g, '_');
    
    return [...parts, filename + ext].join('/');
}

// Helper to rewrite local paths in content (HTML src or JS imports) to match sanitized names
export function getSanitizedPathForReference(refPath) {
    // refPath is like "./vendor/three.core.js" or "three.core.js"
    const parts = refPath.split('/');
    let filename = parts.pop();
    let ext = '.js'; // Default to js for code
    
    // Strip query params
    filename = filename.split('?')[0];

    // Detect and strip extension
    if (filename.endsWith('.mjs')) {
        filename = filename.slice(0, -4);
    } else if (filename.endsWith('.js')) {
        filename = filename.slice(0, -3);
    }
    
    // Sanitize base name
    filename = filename.replace(/\./g, '_');
    
    return [...parts, filename + ext].join('/');
}

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
        const cleanUrl = url.split('?')[0];
        const lower = cleanUrl.toLowerCase();
        
        // Use reliable ESM builds from jsdelivr for core libs.
        // jsdelivr is more consistent with Content-Type and availability than unpkg for some environments.
        if (lower.endsWith('/three') || 
            lower.endsWith('/three.js') || 
            lower.endsWith('/three.module.js') ||
            lower.includes('/three@') ||
            cleanUrl === 'three') {
            
             if (!lower.includes('/addons/') && 
                 !lower.includes('/examples/') && 
                 !lower.includes('three-') &&
                 !lower.includes('stdlib')) {

                 // Extract version if available
                 const versionMatch = lower.match(/three@([\d\.]+)/);
                 const version = versionMatch ? versionMatch[1] : '0.172.0';
                 // Using jsdelivr for robust cdn
                 return `https://cdn.jsdelivr.net/npm/three@${version}/build/three.module.js`;
             }
        }
        
        if (lower.includes('tween.js') || lower === '@tweenjs/tween.js') {
            return 'https://cdn.jsdelivr.net/npm/@tweenjs/tween.js@23.1.1/dist/tween.esm.js';
        }
        
        return null;
    }

    resolve(importSource, referrerUrl = null) {
        let downloadUrl;
        
        // 1. Resolve full URL
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

        // --- Three.js Direct Download ---
        // Download Three.js as a single file with inline global assignment
        // Also catch "three.core.js" or "three.min.js" which are often the core lib
        const isThreeCore = downloadUrl && (
            downloadUrl.includes('/three.js') || 
            downloadUrl.includes('/three.module.js') || 
            downloadUrl.includes('/three.core.js') ||
            downloadUrl.includes('/three.min.js')
        );

        if (isThreeCore && !downloadUrl.includes('/addons/')) {
            const threePath = './vendor/three.js';
            
            if (!this.downloads.has(downloadUrl)) {
                this.downloads.set(downloadUrl, {
                    localPath: threePath,
                    processPromise: this._fetchThreeJs(downloadUrl)
                });
            }
            return threePath;
        }

        if (this.downloads.has(downloadUrl)) {
            return this.downloads.get(downloadUrl).localPath;
        }

        // Generic Vendor File Handling
        let safeName = `vendor-${this.vendorCount++}`;
        try {
            const u = new URL(downloadUrl);
            const pathParts = u.pathname.split('/');
            let filename = pathParts[pathParts.length - 1];
            // Remove version strings from filenames to keep them clean
            filename = filename.replace(/@[\d\.]+/, '');
            
            if (filename && filename.length < 50) {
                 // Replace all dots with underscores except the last one to avoid 'file.core.js' issues if platform is strict
                 const base = filename.replace(/\.[^.]+$/, '').replace(/[\.]/g, '_').replace(/[^a-zA-Z0-9_-]/g, '_');
                 if (base) safeName = `${this.vendorCount}_${base}`;
            }
        } catch(e) {}
        
        // Force .js extension
        const localPath = `./vendor/${safeName}.js`;
        this.downloads.set(downloadUrl, { 
            localPath, 
            processPromise: this._fetchAndProcess(downloadUrl) 
        });
        
        return localPath;
    }

    async _fetchThreeJs(url) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
            
            let code = await res.text();
            
            // Append global assignment at the end
            code += `\n\n// Auto-injected global\nif (typeof window !== 'undefined') {\n  window.THREE = {};\n  for (const key in exports) {\n    if (key !== 'default' && key !== '__esModule') window.THREE[key] = exports[key];\n  }\n  if (exports.default) Object.assign(window.THREE, exports.default);\n  console.log('[WebSim] THREE.js loaded globally', { keys: Object.keys(window.THREE).length });\n}\n`;
            
            return `// Source: ${url}\n${code}`;
        } catch (err) {
            console.error("Three.js download error:", err);
            return `/* Error downloading ${url}: ${err.message} */`;
        }
    }

    async _fetchAndProcess(url, shouldRewrite = true) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
            
            const contentType = res.headers.get('content-type');
            let code = await res.text();

            // Safety check for HTML error pages masquerading as JS
            if (code.trim().startsWith('<!DOCTYPE') || code.trim().startsWith('<html')) {
                throw new Error('Received HTML instead of JS');
            }

            if (!shouldRewrite) return `// Source: ${url}\n${code}`;

            const rewritePath = (specifier) => {
                 if (specifier.startsWith('data:') || specifier.startsWith('#')) return specifier;

                 try {
                     const resolvedLocal = this.resolve(specifier, url);
                     const parts = resolvedLocal.split('/');
                     return `./${parts[parts.length - 1]}`;
                 } catch(e) {
                     return specifier;
                 }
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
        
        // Iterative processing to catch nested dependencies discovered during rewrite
        while(true) {
            const urls = Array.from(this.downloads.keys());
            let hasNew = false;
            
            for(const url of urls) {
                if(processed.has(url)) continue;
                hasNew = true;
                processed.add(url);
                
                const entry = this.downloads.get(url);
                try {
                    let content = await entry.processPromise;
                    
                    // Final cleanup of imports
                    content = content.replace(/from\s*['"]([^'"]+)\.mjs['"]/g, "from '$1.js'");
                    
                    const zipPath = entry.localPath.replace(/^\.\//, '');
                    files[zipPath] = content;
                } catch (e) {
                    console.error(`Failed to process vendor file ${url}:`, e);
                    // Create a valid JS file that logs the error, to prevent browser "SyntaxError" or "MIME" issues on 404s
                    const zipPath = entry.localPath.replace(/^\.\//, '');
                    files[zipPath] = `console.error("Failed to load dependency: ${url} - ${e.message}");`;
                }
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
  // Exclude actual Three.js library files to prevent breaking UMD definitions
  // We check for various forms of 'three' filenames after sanitization
  const isLib = /(^|\/)three(_min)?\.js$/i.test(filePath) || /(^|\/)three(_core)?\.js$/i.test(filePath) || filePath.includes('vendor/');
  
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
      // 1. Remote / Bare Imports
      if (source.startsWith('http') || !source.match(/^\.?\.?\//)) {
          const rootLocalPath = depManager.resolve(source);
          const relativePath = computeRelativePath(filePath, rootLocalPath);
          return `${prefix}${relativePath}${suffix}`;
      }
      
      // 2. Local Imports - Sanitize Filenames
      // If the source looks like a JS file, apply the same sanitization we apply to the file assets
      if (source.endsWith('.js') || source.endsWith('.mjs')) {
          const newSource = getSanitizedPathForReference(source);
          return `${prefix}${newSource}${suffix}`;
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
        // Sanitize local src paths in HTML to match file system sanitization
        if (!src.startsWith('http') && !src.startsWith('//')) {
            const parts = src.split('/');
            let filename = parts.pop();
            let newFilename = filename;
            
            // Mirror logic from sanitizeFilename
            if (filename.endsWith('.mjs')) {
                newFilename = filename.replace(/\.mjs$/, '.js');
                const base = newFilename.slice(0, -3).replace(/\./g, '_');
                newFilename = base + '.js';
            } else if (filename.endsWith('.js')) {
                const base = filename.slice(0, -3).replace(/\./g, '_');
                newFilename = base + '.js';
            }
            
            if (newFilename !== filename) {
                const newSrc = [...parts, newFilename].join('/');
                attrs = attrs.replace(srcMatch[1], newSrc);
                src = newSrc;
            }
        }

        if (src.startsWith('http') || src.startsWith('//')) {
            if (src.startsWith('//')) src = 'https:' + src;
            const localPathRaw = depManager.resolve(src);
            const localPath = localPathRaw.replace(/^\.\//, toRoot);
            
            let newAttrs = attrs.replace(srcMatch[0], `src="${localPath}"`);
            if (!newAttrs.includes('type="module"')) newAttrs += ' type="module"';
            return `<script ${newAttrs}></script>`;
        }

        // Local Script: Rewrite path to match sanitized filename logic
        const sanitizedSrc = getSanitizedPathForReference(src);
        if (sanitizedSrc !== src) {
             const newSrc = sanitizedSrc;
             attrs = attrs.replace(srcMatch[1], newSrc);
             src = newSrc;
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
        return `<script ${attrs}>${content}</script>`;
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

