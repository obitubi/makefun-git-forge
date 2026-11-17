// Minimal MCP server stub. Real MCP is protocol-heavy; this registers a /mcp
// endpoint for the spec's health check and basic requests.
import { installGraphQLRoutes } from './gql.ts';
import { installRestRoutes } from './rest.ts';

export function installMCPRoutes(app: any) {
  // MCP health
  app.get('/mcp', (_req: any, res: any) => res.end(JSON.stringify({ id: 1, jsonrpc: '2.0', result: { capabilities: {} } })));
  // MCP basic request — forward to GitHub-compatible shapes
  app.post('/mcp', (req: any, res: any) => {
    const body = req.body || {};
    if (body.id && typeof body.id === 'number') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', result: { id: body.id } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' } }));
    }
  });
  installGraphQLRoutes(app);
}