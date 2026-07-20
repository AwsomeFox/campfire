import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Public } from '../../common/decorators/public.decorator';
import type { RequestUser } from '../../common/user.types';
import { McpToolsService } from './mcp-tools';

/**
 * Stateless MCP Streamable HTTP endpoint at POST /mcp (outside the /api/v1
 * prefix — see the setGlobalPrefix exclude list in main.ts / test-app.ts).
 *
 * @Public() so the global SessionAuthGuard does NOT throw its own bare 401
 * before this handler runs: the guard still resolves req.user from an
 * `Authorization: Bearer cf_pat_...` PAT, a `Bearer cf_mcp_...` MCP OAuth access
 * token (issue #37), or a session cookie when present — but when it can't, this
 * handler owns the 401 so it can attach the RFC 9728 `WWW-Authenticate` challenge
 * pointing MCP clients at the protected-resource metadata (the OAuth discovery
 * entry point for adding Campfire as a connector). DEV_AUTH header users
 * (user.devRole set) are rejected explicitly — MCP is for real tokens/sessions.
 *
 * Stateless pattern: a fresh McpServer (tools bound to THIS request's user)
 * plus a fresh StreamableHTTPServerTransport per POST; no session ids, JSON
 * responses only. GET/DELETE (SSE stream / session termination) return 405.
 */
@ApiExcludeController()
@Public()
@Controller('mcp')
export class McpController {
  constructor(private readonly tools: McpToolsService) {}

  @Post()
  async handlePost(@Req() req: Request & { user?: RequestUser }, @Res() res: Response): Promise<void> {
    const user = req.user;
    if (!user || user.devRole) {
      const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol;
      const base = `${proto}://${req.get('host')}`;
      // RFC 9728 §5.1 — point unauthenticated MCP clients at the protected-resource
      // metadata so Claude's connector UI can discover the OAuth authorization server.
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message:
            'MCP requires a personal access token (Authorization: Bearer cf_pat_...), an MCP OAuth access token, or a real session; dev headers are not accepted.',
        },
        id: null,
      });
      return;
    }

    const server = this.tools.buildServer(user);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  @Get()
  methodNotAllowedGet(@Res() res: Response): void {
    this.methodNotAllowed(res);
  }

  @Delete()
  methodNotAllowedDelete(@Res() res: Response): void {
    this.methodNotAllowed(res);
  }

  private methodNotAllowed(res: Response): void {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This stateless MCP endpoint only supports POST.' },
      id: null,
    });
  }
}
