# Revit MCP HTTP Bridge

This bridge server allows n8n (or any HTTP client) to communicate with revit-mcp, which uses stdio transport.

## Architecture

```
n8n → HTTP → Bridge Server → stdio → revit-mcp → Socket → Revit Plugin
```

## Setup

1. **Download the files**
   - Save `revit-mcp-bridge.js` and `package.json` to a folder (e.g., `C:\revit-mcp-bridge\`)

2. **Edit the path in revit-mcp-bridge.js**
   - Open `revit-mcp-bridge.js` in a text editor
   - Find this line (around line 8):
   ```javascript
   const REVIT_MCP_PATH = 'D:\\Programs\\Revit-mcp\\build\\index.js';
   ```
   - Change it to YOUR actual path where revit-mcp is installed
   - Use double backslashes `\\` in Windows paths

3. **Install dependencies**
   ```bash
   cd C:\revit-mcp-bridge
   npm install
   ```

4. **Start the bridge server**
   ```bash
   npm start
   ```

   You should see:
   ```
   Revit MCP Bridge listening on http://localhost:3000
   Starting revit-mcp server...
   MCP Server: Revit MCP Server start success
   MCP initialized: {...}
   Bridge ready to accept requests
   ```

## API Endpoints

### GET /health
Check if the bridge and MCP server are running.

**Response:**
```json
{
  "status": "ok",
  "mcpInitialized": true,
  "mcpRunning": true
}
```

### GET /tools
List all available Revit MCP tools.

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "tools": [
      {
        "name": "get_current_view_info",
        "description": "Get current view info",
        ...
      },
      ...
    ]
  },
  "id": 2
}
```

### POST /tools/call
Call a specific tool.

**Request body:**
```json
{
  "name": "get_current_view_info",
  "arguments": {}
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{...view info...}"
      }
    ]
  },
  "id": 3
}
```

### POST /mcp
Send a raw MCP JSON-RPC request.

**Request body:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "params": {},
  "id": 1
}
```

## Testing with curl

```bash
# Health check
curl http://localhost:3000/health

# List tools
curl http://localhost:3000/tools

# Call a tool
curl -X POST http://localhost:3000/tools/call \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"get_current_view_info\", \"arguments\": {}}"
```

## Using with n8n

1. **Start the bridge server** (as shown above)

2. **In n8n, use HTTP Request node** instead of MCP Client node:
   - Method: `POST`
   - URL: `http://localhost:3000/tools/call`
   - Body: JSON
   ```json
   {
     "name": "get_current_view_info",
     "arguments": {}
   }
   ```

3. **Parse the response** to extract the data you need from the MCP response format

## Example n8n Workflow

```
[Trigger] → [HTTP Request to Bridge] → [Parse Response] → [Use Data]
```

**HTTP Request Node Settings:**
- URL: `http://localhost:3000/tools/call`
- Method: `POST`
- Body:
```json
{
  "name": "get_current_view_info",
  "arguments": {}
}
```

## Troubleshooting

**Bridge won't start:**
- Check that the REVIT_MCP_PATH is correct
- Make sure Node.js is installed
- Check if port 3000 is already in use

**MCP not initializing:**
- Ensure revit-mcp is built (`npm run build` in revit-mcp folder)
- Check that Revit is running with the plugin enabled
- Look at the bridge console for error messages

**Timeout errors:**
- Make sure Revit MCP Plugin is enabled in Revit (Add-ins → Revit MCP Switch)
- Check if the Socket service is running (should be on port 8765 by default)

## Advanced: Changing the Port

Edit `revit-mcp-bridge.js` line 7:
```javascript
const PORT = 3000; // Change to your desired port
```

## Notes

- The bridge server must be running whenever you want to use n8n with Revit
- Keep Revit open with the MCP plugin enabled
- Each request has a 30-second timeout
- The bridge maintains a single connection to revit-mcp
