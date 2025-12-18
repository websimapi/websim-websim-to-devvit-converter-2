// Template strings for Devvit project generation

export const generatePackageJson = (slug) => JSON.stringify({
  "name": slug,
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "devvit playtest",
    "setup": "node scripts/setup.js", 
    "register": "devvit upload",
    "upload": "devvit upload",
    "validate": "node scripts/validate.js"
  },
  "dependencies": {
    "@devvit/public-api": "latest",
    "@devvit/kit": "latest",
    "@devvit/web": "latest"
  },
  "devDependencies": {
    "devvit": "latest",
    "typescript": "^5.0.0"
  }
}, null, 2);

// Modern Devvit uses devvit.yaml for configuration
export const generateDevvitYaml = (slug) => `
name: ${slug}
version: 0.1.0
webroot: webroot
`;

// Standalone tsconfig
export const tsConfig = JSON.stringify({
  "compilerOptions": {
    "target": "es2020",
    "module": "es2020",
    "moduleResolution": "node",
    "lib": ["es2020", "dom"],
    "jsx": "react",
    "jsxFactory": "Devvit.createElement",
    "jsxFragmentFactory": "Devvit.Fragment",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noImplicitAny": false
  },
  "include": [
    "src"
  ]
}, null, 2);

export const getMainTsx = (title, webviewPath) => `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useState, useChannel } from '@devvit/public-api';

Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true, // Enable Realtime
});

Devvit.addCustomPostType({
  name: 'WebSim Game',
  height: 'tall',
  render: (context) => {
    const [key, setKey] = useState(0);
    
    // Realtime Channel Bridge
    const channel = useChannel({
      name: 'websim_global',
      onMessage: (msg) => {
        // Forward realtime events to WebView
        context.ui.webView.postMessage('gameview', {
          type: 'WEBSIM_SOCKET_EVT',
          payload: msg
        });
      },
    });

    // Subscribe on mount
    channel.subscribe();

    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id="gameview"
          url="${webviewPath}"
          width="100%"
          height="100%"
          key={key.toString()}
          onMessage={(msg) => {
            // 1. Handle Realtime Sends from WebView
            if (msg.type === 'WEBSIM_SOCKET_MSG') {
               // Simply relay the whole payload to the channel
               // The polyfill manages senderId to avoid self-echo issues if needed
               channel.send(msg.payload);
            }
            
            // 2. Handle Console Logs
            if (msg.type === 'console' && msg.args) {
              const prefix = '[Web]';
              const args = [prefix, ...(msg.args || [])];
              if (msg.level === 'error') console.error(...args);
              else if (msg.level === 'warn') console.warn(...args);
              else if (msg.level === 'info') console.log(...args);
              else console.log(...args);
            }
          }}
        />
        <vstack padding="medium" gap="medium">
            <button icon="refresh" onPress={() => setKey(k => k + 1)}>Reload Game</button>
            <text size="small" color="neutral-content-weak">Logs are piped to terminal</text>
        </vstack>
      </vstack>
    );
  },
});

Devvit.addMenuItem({
  label: 'Create ${title.replace(/'/g, "\\'")}',
  location: 'subreddit',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      const post = await reddit.submitPost({
        title: '${title.replace(/'/g, "\\'")}',
        subredditName: subreddit.name,
        preview: (
          <vstack height="100%" width="100%" alignment="center middle">
            <text size="large">Loading Game...</text>
          </vstack>
        ),
      });
      ui.showToast('Game created!');
      ui.navigateTo(post);
    } catch (error) {
      console.error('Error creating post:', error);
      ui.showToast('Failed to create game post');
    }
  },
});

export default Devvit;
`;

export const simpleLoggerJs = `
(function() {
  // Enhanced logger that forwards console events to Devvit host
  const _log = console.log;
  const _warn = console.warn;
  const _error = console.error;
  const _info = console.info;
  
  function post(level, args) {
    try {
      // Robust serialization to string for Devvit consumption
      const serialized = args.map(a => {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (a instanceof Error) return '[Error: ' + (a.message || 'unknown') + ']\\n' + (a.stack || '');
        if (typeof a === 'object') {
            try { 
                return JSON.stringify(a, (key, value) => {
                    if (typeof value === 'function') return '[Function]';
                    return value;
                }); 
            } catch(e) { return '[Circular/Object]'; }
        }
        return String(a);
      });
      
      // Send to parent (Devvit WebView wrapper)
      window.parent.postMessage({ type: 'console', level, args: serialized }, '*');
      
    } catch(e) {
        // Fallback
    }
  }

  // Override console methods
  console.log = function(...args) { _log.apply(console, args); post('info', args); };
  console.info = function(...args) { _info.apply(console, args); post('info', args); };
  console.warn = function(...args) { _warn.apply(console, args); post('warn', args); };
  console.error = function(...args) { _error.apply(console, args); post('error', args); };

  // Global Error Handler
  window.addEventListener('error', function(e) {
    post('error', ['[Uncaught Exception]', e.message, 'at', e.filename, ':', e.lineno, 'col', e.colno]);
  });
  
  // Promise Rejection Handler
  window.addEventListener('unhandledrejection', function(e) {
    post('error', ['[Unhandled Promise Rejection]', e.reason ? (e.reason.message || e.reason) : 'Unknown']);
  });

  // Signal ready
  console.log('[WebSim Logger] Bridge initialized.');
})();
`;

export const websimSocketPolyfill = `
(function() {
    // Polyfill for WebsimSocket using Devvit Realtime Bridge
    // This allows existing WebSim games to work by proxying events through the Devvit Host.
    
    console.log('[WebSim Socket] Initializing Polyfill...');

    // 1. Mock Data Structures for Global State
    // These need to be globally consistent for the polyfill to simulate a room
    const _roomState = {};
    const _presence = {};
    const _peers = {};
    const _clientId = Math.random().toString(36).substr(2, 9);
    
    // Initialize self in peers
    _peers[_clientId] = { 
        username: 'Player ' + _clientId.substr(0,4), 
        avatarUrl: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png',
        id: _clientId 
    };
    _presence[_clientId] = {};

    class WebsimSocket {
        constructor() {
            this.clientId = _clientId;
            // Reference the global objects so all instances share state (singleton-like behavior)
            this.roomState = _roomState;
            this.presence = _presence;
            this.peers = _peers;
            this.listeners = {};
            this.connected = false;
            
            // Listen for messages from Parent (Devvit Host)
            window.addEventListener('message', (e) => {
                if (!e.data || e.data.type !== 'WEBSIM_SOCKET_EVT') return;
                
                const { type, payload, senderId } = e.data.payload || {};
                
                // If it's an echo from ourselves, ignore it to prevent loops
                // (unless we want optimistic verification, but for games simpler is better)
                if (senderId === this.clientId) return;

                this._handleRemoteEvent(type, payload, senderId);
            });
        }

        // --- Core API ---

        async initialize() {
            console.log('[WebSim Socket] Connecting...');
            this.connected = true;
            
            // Announce join to others
            this._sendInternal('join', { 
                username: this.peers[this.clientId].username,
                avatarUrl: this.peers[this.clientId].avatarUrl
            });
            
            // Simulate initialization delay
            return new Promise(resolve => setTimeout(resolve, 50));
        }

        // --- State Management ---

        updatePresence(update) {
            // 1. Local Apply
            const current = this.presence[this.clientId] || {};
            this.presence[this.clientId] = { ...current, ...update };
            
            // 2. Notify Local Listeners
            this._emit('presence', this.presence);
            
            // 3. Broadcast
            this._sendInternal('presence_update', update);
        }

        updateRoomState(update) {
            // 1. Local Apply
            Object.assign(this.roomState, update);
            
            // 2. Notify Local Listeners
            this._emit('roomState', this.roomState);
            
            // 3. Broadcast
            this._sendInternal('room_state_update', update);
        }
        
        requestPresenceUpdate(targetClientId, data) {
             this._sendInternal('request_presence', { targetClientId, data });
        }

        // --- Event / Messaging ---

        send(eventData) {
            // eventData: { type: "foo", ... }
            this._sendInternal('broadcast_event', eventData);
        }
        
        // Old style emit
        emit(event, data) {
            this.send({ type: event, ...data });
        }
        
        onmessage(event) {
            // Default handler, user overrides this
            console.log('[WebSim Socket] Message received:', event);
        }

        // --- Subscriptions ---

        subscribePresence(callback) {
            return this._on('presence', callback);
        }

        subscribeRoomState(callback) {
            return this._on('roomState', callback);
        }
        
        subscribePresenceUpdateRequests(callback) {
            return this._on('presence_request', callback);
        }

        // --- Internal Helpers ---

        _sendInternal(msgType, data) {
            window.parent.postMessage({
                type: 'WEBSIM_SOCKET_MSG',
                payload: {
                    type: msgType,
                    payload: data,
                    senderId: this.clientId
                }
            }, '*');
        }

        _handleRemoteEvent(type, data, senderId) {
            // Ensure peer exists in our registry
            if (!this.peers[senderId]) {
                this.peers[senderId] = { 
                    id: senderId, 
                    username: 'User ' + senderId.substr(0,4),
                    avatarUrl: ''
                };
            }

            switch(type) {
                case 'join':
                    this.peers[senderId] = { ...this.peers[senderId], ...data };
                    // Send our presence back so they know about us immediately (naive mesh sync)
                    this._sendInternal('presence_update', this.presence[this.clientId] || {});
                    break;
                    
                case 'presence_update':
                    this.presence[senderId] = { ...(this.presence[senderId] || {}), ...data };
                    this._emit('presence', this.presence);
                    break;
                    
                case 'room_state_update':
                    Object.assign(this.roomState, data);
                    this._emit('roomState', this.roomState);
                    break;
                    
                case 'broadcast_event':
                    // Map to onmessage
                    if (this.onmessage) {
                        // Construct an event object similar to WebSim
                        this.onmessage({ 
                            data: { 
                                ...data, 
                                clientId: senderId, 
                                username: this.peers[senderId].username 
                            } 
                        });
                    }
                    break;
                
                case 'request_presence':
                    if (data.targetClientId === this.clientId) {
                        this._emit('presence_request', data.data, senderId);
                    }
                    break;
            }
        }

        _on(event, cb) {
            if (!this.listeners[event]) this.listeners[event] = [];
            this.listeners[event].push(cb);
            return () => {
                this.listeners[event] = this.listeners[event].filter(x => x !== cb);
            };
        }

        _emit(event, ...args) {
            if (this.listeners[event]) {
                this.listeners[event].forEach(cb => {
                    try { cb(...args); } catch(e) { console.error(e); }
                });
            }
        }
    }

    // Expose Global
    window.WebsimSocket = WebsimSocket;
    
    // Also polyfill 'party' object if used by older games
    if (!window.party) {
        window.party = new WebsimSocket();
    }
})();
`;

export const validateScript = `
import fs from 'fs';
import path from 'path';

const WEBROOT = './webroot';

function walk(dir, callback) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filepath = path.join(dir, file);
    const stats = fs.statSync(filepath);
    if (stats.isDirectory()) {
      walk(filepath, callback);
    } else {
      callback(filepath, stats);
    }
  });
}

console.log('🔍 Verifying Webroot Integrity...');

if (!fs.existsSync(WEBROOT)) {
    console.error('❌ Webroot folder missing!');
    process.exit(1);
}

const files = [];
walk(WEBROOT, (f, s) => files.push({ path: f, size: s.size }));
console.log(\`   Found \${files.length} files in webroot.\`);

let hasIndex = false;
let issues = 0;

files.forEach(fileObj => {
    const f = fileObj.path;
    if (f.endsWith('index.html')) hasIndex = true;
    
    // Check for 0 byte files
    if (fileObj.size === 0) {
        console.warn(\`⚠️  Empty file detected: \${f}\`);
        issues++;
    }
    
    // Check content for remote URLs (CSP violators)
    if (f.endsWith('.html') || f.endsWith('.js')) {
        const content = fs.readFileSync(f, 'utf8');

        // Warning for .mjs usage
        if (f.endsWith('.mjs')) {
            console.warn(\`⚠️  .mjs file detected: \${f}. Devvit might serve this with wrong MIME type.\`);
            issues++;
        }
        
        // Check for http/https usage in imports/scripts
        // Only warn if it looks like a script source or import
        if (content.match(/from\\s*['"]http/) || content.match(/src\\s*=\\s*['"]http/)) {
            console.warn(\`⚠️  Possible remote import in \${f}. Devvit may block this.\`);
            console.warn(\`   Context: \${content.match(/(from|src).*http[^'"]*/)?.[0]}\`);
            issues++;
        }

        // Check for inline scripts in HTML
        if (f.endsWith('.html')) {
             const scriptRegex = new RegExp('<script[^>]*>[^<]+</script>', 'i');
             // Ignore type="application/json" etc
             if (scriptRegex.test(content) && !content.includes('type="application/json"')) {
                 if (content.includes('console.log') || content.includes('function') || content.includes('var ') || content.includes('const ')) {
                     console.warn(\`⚠️  Potential inline script remaining in \${f}\`);
                     issues++;
                 }
             }
        }
    }
});

if (!hasIndex) {
    console.error('❌ No index.html found! The game will not load.');
    process.exit(1);
}

if (issues > 0) {
    console.log(\`\\n⚠️  Found \${issues} potential issues. See above warnings.\`);
    console.log('   Devvit Webviews are strict. External scripts must be downloaded locally.');
} else {
    console.log('✅ Webroot looks good!');
}
`;

export const setupScript = `
import { execSync } from 'child_process';
import fs from 'fs';

console.log('🚀 Setting up your Reddit Game...');

// Cleanup old config if exists to prevent conflicts
if (fs.existsSync('devvit.json')) {
    try {
        fs.unlinkSync('devvit.json');
        console.log('cleaned up old devvit.json');
    } catch(e) {}
}

// 1. Check CLI
try {
    console.log('Checking for Devvit CLI...');
    execSync('devvit --version', { stdio: 'ignore' });
} catch (e) {
    console.error('❌ Devvit CLI not found.');
    console.log('Please install it globally: npm install -g devvit');
    process.exit(1);
}

// 2. Install Dependencies
console.log('📦 Installing dependencies...');
try {
    execSync('npm install', { stdio: 'inherit' });
} catch(e) {
    console.warn('⚠️ npm install had some issues, but continuing...');
}

// 3. Validation
console.log('🧐 Validating assets...');
try {
    execSync('node scripts/validate.js', { stdio: 'inherit' });
} catch(e) {
    console.warn('⚠️ Validation found issues.');
}

// 4. Check Login
console.log('🔒 Checking Devvit login status...');
try {
    execSync('devvit whoami', { stdio: 'ignore' });
} catch (e) {
    console.log('⚠️  You are not logged in to Devvit.');
    console.log('👉 Please run: npx devvit login');
    console.log('   Then run: npm run setup');
    process.exit(1);
}

// 5. Register App
console.log('✨ Registering App on Reddit...');
console.log('   IMPORTANT: If asked to create the app, please type "y" and press Enter!');
try {
    // Force upload to register
    execSync('npx devvit upload', { stdio: 'inherit' });
    console.log('✅ App registered successfully!');
} catch (e) {
    console.log('\\n⚠️  Registration process encountered an issue.');
    console.log('   If you saw a config error, the project structure might be invalid.');
    console.log('   If you simply declined the creation, run "npm run register" to try again.');
}

console.log('\\n🎮 Setup complete!');
console.log('To start the game emulator, run: npm run dev');
`;

export const generateReadme = (title, url) => `
# ${title}

Converted from WebSim: ${url}

## Quick Start

1. **Setup**: Install dependencies and register the app.
   \`\`\`bash
   npm run setup
   \`\`\`
   *Note: Requires Node.js and the Devvit CLI (\`npm i -g devvit\`).*

2. **Run**: Start the emulator.
   \`\`\`bash
   npm run dev
   \`\`\`
   *Access the emulator at http://localhost:5173 (or as indicated in terminal).*

## How it Works

- **Webroot**: The \`webroot/\` directory contains the game files. These are served inside a webview in the Reddit app.
- **Logging**: Console logs from the game are piped to your terminal. Look for lines starting with \`[Web]\`.
- **Validation**: The \`npm run setup\` command runs \`scripts/validate.js\` to check for common issues (CSP violations, missing files).

## Troubleshooting

- **"App doesn't exist"**: Run \`npx devvit upload\` manually.
- **"Invalid token/syntax"**: Ensure your Node version is up to date (v18+).
- **White Screen/Loading Forever**: Check the terminal for JS errors.
  - If you see "Content Security Policy" warnings, some external resources might be blocked by Reddit's strict security rules.
  - Verify \`webroot/index.html\` exists and has content.

## Modifications

To modify the game, edit files in \`webroot/\`.
To modify the Reddit app wrapper, edit \`src/main.tsx\`.
`;

