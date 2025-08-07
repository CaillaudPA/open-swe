import jsonwebtoken from "jsonwebtoken";

/**
 * Generates a JWT for GitHub App authentication
 */
export function generateJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iat: now,
    exp: now + 10 * 60,
    iss: appId,
  };

  return jsonwebtoken.sign(payload, privateKey, { algorithm: "RS256" });
}

/**
 * MCP Agent JWT payload interface
 */
export interface MCPAgentJWTPayload {
  agentId: string;
  agentName: string;
  capabilities: string[];
  supportedGraphs: string[];
  iat: number;
  exp: number;
  iss: string;
}

/**
 * Creates a JWT token for MCP agent authentication
 */
export function createMCPAgentJWT(
  agentId: string,
  agentName: string,
  capabilities: string[],
  supportedGraphs: string[],
  secret: string,
  expirationHours: number = 24
): string {
  const now = Math.floor(Date.now() / 1000);
  
  const payload: MCPAgentJWTPayload = {
    agentId,
    agentName,
    capabilities,
    supportedGraphs,
    iat: now,
    exp: now + (expirationHours * 60 * 60),
    iss: "open-swe-mcp-server",
  };

  return jsonwebtoken.sign(payload, secret, { algorithm: "HS256" });
}

/**
 * Verifies and decodes an MCP agent JWT token
 */
export function verifyMCPAgentJWT(
  token: string,
  secret: string
): MCPAgentJWTPayload | null {
  try {
    const decoded = jsonwebtoken.verify(token, secret, { 
      algorithms: ["HS256"],
      issuer: "open-swe-mcp-server"
    }) as MCPAgentJWTPayload;
    
    return decoded;
  } catch (_error) {
    return null;
  }
}

/**
 * Creates a simple API key hash for MCP agents
 */
export function createAPIKeyHash(agentId: string, secret: string): string {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', secret).update(agentId).digest('hex');
}

/**
 * Verifies an API key hash
 */
export function verifyAPIKeyHash(
  apiKey: string,
  agentId: string,
  secret: string
): boolean {
  const expectedHash = createAPIKeyHash(agentId, secret);
  return apiKey === expectedHash;
}


