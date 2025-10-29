const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = 3000;
const REVIT_MCP_PATH = 'D:\\Programs\\Revit-mcp\\build\\index.js'; // Adjust this to your path

// Store the MCP server process
let mcpProcess = null;
let isInitialized = false;
let requestQueue = new Map();
let requestId = 0;

// Start the revit-mcp server as a child process
function startMCPServer() {
  console.log('🚀 Starting revit-mcp server...');
  console.log('📁 Path:', REVIT_MCP_PATH);
  
  mcpProcess = spawn('node', [REVIT_MCP_PATH], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Handle stdout from MCP server
  let buffer = '';
  mcpProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    
    // Try to parse complete JSON messages
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer
    
    lines.forEach(line => {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          console.log('📥 Received from MCP:', JSON.stringify(response, null, 2));
          
          // Find and resolve the matching request
          if (response.id && requestQueue.has(response.id)) {
            const { resolve } = requestQueue.get(response.id);
            resolve(response);
            requestQueue.delete(response.id);
          }
        } catch (e) {
          console.error('❌ Failed to parse MCP response:', line, e);
        }
      }
    });
  });

  mcpProcess.stderr.on('data', (data) => {
    console.log('🔧 MCP Server stderr:', data.toString());
  });

  mcpProcess.on('close', (code) => {
    console.log(`⚠️  MCP server process exited with code ${code}`);
    isInitialized = false;
    mcpProcess = null;
  });

  // Initialize the MCP connection
  setTimeout(async () => {
    await initializeMCP();
  }, 1000);
}

// Initialize MCP connection
async function initializeMCP() {
  console.log('🔄 Initializing MCP connection...');
  
  const initMessage = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'n8n-bridge',
        version: '1.0.0'
      }
    },
    id: getNextRequestId()
  };

  try {
    const response = await sendToMCP(initMessage);
    console.log('✅ MCP initialized:', response);
    
    // Send initialized notification
    const notifyMessage = {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    };
    mcpProcess.stdin.write(JSON.stringify(notifyMessage) + '\n');
    
    isInitialized = true;
    console.log('✅ Bridge ready to accept requests');
    console.log('');
  } catch (error) {
    console.error('❌ Failed to initialize MCP:', error);
  }
}

// Get next request ID
function getNextRequestId() {
  return ++requestId;
}

// Send message to MCP server and wait for response
function sendToMCP(message) {
  return new Promise((resolve, reject) => {
    if (!mcpProcess) {
      reject(new Error('MCP server not running'));
      return;
    }

    const timeout = setTimeout(() => {
      requestQueue.delete(message.id);
      reject(new Error('Request timeout'));
    }, 30000); // 30 second timeout

    requestQueue.set(message.id, { 
      resolve: (response) => {
        clearTimeout(timeout);
        resolve(response);
      }
    });

    const messageStr = JSON.stringify(message) + '\n';
    console.log('📤 Sending to MCP:', messageStr.trim());
    mcpProcess.stdin.write(messageStr);
  });
}

// Health check endpoint
app.get('/', (req, res) => {
  res.send(`✅ Revit MCP Bridge running
MCP Initialized: ${isInitialized}
MCP Running: ${mcpProcess !== null}
`);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mcpInitialized: isInitialized,
    mcpRunning: mcpProcess !== null 
  });
});

// List available tools - DISABLED to prevent n8n from discovering tools directly
app.get('/tools', (req, res) => {
  console.log('⚠️  /tools endpoint called - returning disabled message');
  res.status(404).json({ 
    error: 'Tool discovery disabled',
    message: 'n8n should use the "Bridge communication" tool only, not discover tools directly'
  });
});

// Call a tool
app.post('/tools/call', async (req, res) => {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║         NEW /tools/call REQUEST                                ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('📥 Request body:', JSON.stringify(req.body, null, 2));
  
  if (!isInitialized) {
    console.log('❌ MCP not initialized');
    return res.status(503).json({ error: 'MCP server not initialized' });
  }

  const { name, arguments: args } = req.body;

  if (!name) {
    console.log('❌ Missing tool name');
    return res.status(400).json({ error: 'Tool name is required' });
  }

  const message = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: name,
      arguments: args || {}
    },
    id: getNextRequestId()
  };

  try {
    const response = await sendToMCP(message);
    console.log('✅ Response:', JSON.stringify(response, null, 2));
    res.json(response);
  } catch (error) {
    console.log('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Generic MCP request endpoint
app.post('/mcp', async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: 'MCP server not initialized' });
  }

  const message = {
    ...req.body,
    id: req.body.id || getNextRequestId()
  };

  try {
    const response = await sendToMCP(message);
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the bridge server
app.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  🌉 Revit MCP Bridge');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  📍 Listening on: http://localhost:${PORT}`);
  console.log('');
  console.log('  Endpoints:');
  console.log(`    GET  /           - Status`);
  console.log(`    GET  /health     - Health check`);
  console.log(`    POST /tools/call - Call a tool`);
  console.log(`    POST /mcp        - Generic MCP request`);
  console.log('');
  console.log('  ⚠️  /tools endpoint DISABLED to prevent direct tool discovery');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  
  startMCPServer();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  if (mcpProcess) {
    mcpProcess.kill();
  }
  process.exit(0);
});
