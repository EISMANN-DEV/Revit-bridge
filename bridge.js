/**
 * Revit MCP Bridge
 * n8n/LLM  <->  (HTTP)  <->  this bridge  <->  (stdin/stdout)  <->  Revit MCP (node index.js)
 *
 * How to run:
 *   1) Install Node.js (LTS)
 *   2) Open Windows PowerShell in this folder
 *   3) npm install
 *   4) Set REVIT_MCP_PATH below to your built MCP index.js path
 *   5) node bridge.js
 *
 * Endpoints:
 *   GET  /health       - health & status
 *   GET  /tools        - list tools from MCP
 *   POST /tools/call   - call a tool: { "name": "...", "arguments": { ... } }
 *   POST /mcp          - generic JSON-RPC passthrough
 */

const express = require('express');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '2mb', type: 'application/json', strict: true }));

const PORT = process.env.PORT || 3000;

// >>>> SET THIS TO YOUR MCP BUILD <<<<
const REVIT_MCP_PATH = process.env.REVIT_MCP_PATH || 'D:\\Programs\\Revit-mcp\\build\\index.js';

let mcpProcess = null;
let isInitialized = false;
let requestQueue = new Map();
let requestId = 0;

// Simple in-order queue (Revit is single-threaded)
let inFlight = Promise.resolve();
function queueMcp(message, opts) {
  const job = () => sendToMCP(message, opts);
  inFlight = inFlight.then(job, job);
  return inFlight;
}

function startMCPServer() {
  console.log('Starting Revit MCP server...');
  mcpProcess = spawn('node', [REVIT_MCP_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

  let buffer = '';
  mcpProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // hold partial
    lines.forEach((line) => {
      if (!line.trim()) return;
      try {
        const response = JSON.parse(line);
        // console.log('<< MCP:', JSON.stringify(response));
        if (response.id && requestQueue.has(response.id)) {
          const { resolve } = requestQueue.get(response.id);
          resolve(response);
          requestQueue.delete(response.id);
        }
      } catch (e) {
        console.error('Failed to parse MCP response line:', line);
      }
    });
  });

  mcpProcess.stderr.on('data', (data) => {
    console.log('MCP STDERR:', data.toString());
  });

  mcpProcess.on('close', (code) => {
    console.log(`MCP exited with code ${code}`);
    isInitialized = false;
    mcpProcess = null;
    // Auto-restart after small backoff
    setTimeout(startMCPServer, 1500);
  });

  // Initialize after small delay (let MCP boot)
  setTimeout(initializeMCP, 800);
}

function getNextRequestId() {
  // Keep ids small and positive
  requestId = (requestId + 1) % 1_000_000;
  if (requestId === 0) requestId = 1;
  return requestId;
}

async function initializeMCP() {
  if (!mcpProcess) return;

  const initMessage = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'n8n-bridge', version: '1.0.0' }
    },
    id: getNextRequestId()
  };

  try {
    const response = await sendToMCP(initMessage, { timeoutMs: 20000 });
    console.log('MCP initialize -> ok');
    // Notify initialized
    mcpProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    isInitialized = true;
  } catch (err) {
    console.error('Initialize failed:', err.message);
  }
}

function sendToMCP(message, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!mcpProcess) return reject(new Error('MCP server not running'));

    const id = message.id ?? getNextRequestId();
    message.id = id;

    const timeout = setTimeout(() => {
      requestQueue.delete(id);
      reject(new Error('Request timeout'));
    }, timeoutMs);

    requestQueue.set(id, {
      resolve: (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      }
    });

    const out = JSON.stringify(message) + '\n';
    // console.log('>> MCP:', out.trim());
    mcpProcess.stdin.write(out, 'utf8');
  });
}

function normalizeMcpResult(response) {
  if (!response) return { success: false, errorMessage: 'No response', data: null };
  if (response.error) {
    return { success: false, errorMessage: response.error.message || 'MCP error', data: null };
  }
  const r = response.result;
  if (!r) return { success: false, errorMessage: 'Empty result', data: null };

  // If tool returns content blocks
  if (Array.isArray(r.content)) {
    const text = r.content.map(c => c && c.text).filter(Boolean).join('\n');
    const looksError = /error|failed|exception|编译|类型|命名空间/i.test(text);
    return { success: !looksError, errorMessage: looksError ? text : null, data: text || r };
  }

  if (typeof r.success === 'boolean') {
    return { success: r.success, errorMessage: r.errorMessage || null, data: r.result ?? r.data ?? null };
  }

  return { success: true, errorMessage: null, data: r };
}

// --- Routes ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', mcpInitialized: isInitialized, mcpRunning: !!mcpProcess });
});

app.get('/tools', async (req, res) => {
  if (!isInitialized) return res.status(503).json({ error: 'MCP not initialized' });
  try {
    const response = await queueMcp({ jsonrpc: '2.0', method: 'tools/list' });
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/tools/call', async (req, res) => {
  if (!isInitialized) return res.status(503).json({ error: 'MCP not initialized' });

  let { name, arguments: args } = req.body || {};
  if (!name) return res.status(400).json({ success: false, error: 'Tool name is required' });

  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Arguments must be valid JSON' });
    }
  }

  const message = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name, arguments: args || {} }
  };

  try {
    const response = await queueMcp(message);
    const norm = normalizeMcpResult(response);
    res.json({ success: norm.success, result: norm.data, error: norm.errorMessage || null, toolCalled: name });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/mcp', async (req, res) => {
  if (!isInitialized) return res.status(503).json({ error: 'MCP not initialized' });
  const msg = { ...req.body, id: req.body.id || getNextRequestId() };
  try {
    const response = await queueMcp(msg);
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Revit MCP Bridge listening on http://localhost:${PORT}`);
  console.log(`GET  /health`);
  console.log(`GET  /tools`);
  console.log(`POST /tools/call`);
  console.log(`POST /mcp`);
  startMCPServer();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  if (mcpProcess) try { mcpProcess.kill(); } catch {}
  process.exit(0);
});
