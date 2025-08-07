import { Auth, HTTPException } from "@langchain/langgraph-sdk/auth";
import {
  verifyGithubUser,
  GithubUser,
  verifyGithubUserId,
} from "@open-swe/shared/github/verify-user";
import {
  GITHUB_INSTALLATION_ID,
  GITHUB_INSTALLATION_NAME,
  GITHUB_INSTALLATION_TOKEN_COOKIE,
  GITHUB_TOKEN_COOKIE,
  GITHUB_USER_ID_HEADER,
  GITHUB_USER_LOGIN_HEADER,
  LOCAL_MODE_HEADER,
} from "@open-swe/shared/constants";
import { decryptSecret } from "@open-swe/shared/crypto";
import { verifyGitHubWebhookOrThrow } from "./github.js";
import { createWithOwnerMetadata, createOwnerFilter } from "./utils.js";
import { LANGGRAPH_USER_PERMISSIONS } from "../constants.js";
import { getGitHubPatFromRequest } from "../utils/github-pat.js";
import { 
  verifyMCPAgentJWT, 
  verifyAPIKeyHash
} from "@open-swe/shared/jwt";
import { 
  AgentCapability, 
  GraphTarget
} from "@open-swe/shared/open-swe/mcp-server";

// TODO: Export from LangGraph SDK
export interface BaseAuthReturn {
  is_authenticated?: boolean;
  display_name?: string;
  identity: string;
  permissions: string[];
}

interface AuthenticateReturn extends BaseAuthReturn {
  metadata: {
    installation_name: string;
    agent_type?: "github" | "mcp" | "local";
    agent_capabilities?: string[];
    supported_graphs?: string[];
  };
}

/**
 * MCP Agent permissions based on capabilities and supported graphs
 */
const MCP_AGENT_PERMISSIONS = [
  "threads:create",
  "threads:create_run",
  "threads:read",
  "assistants:read",
  "store:access",
] as const;

/**
 * Rate limiting storage (in production, use Redis or similar)
 */
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

/**
 * Check rate limit for a given identifier
 */
function checkRateLimit(
  identifier: string,
  maxRequests: number = 100,
  windowMs: number = 60 * 1000 // 1 minute
): boolean {
  const now = Date.now();
  const key = `rate_limit:${identifier}`;
  
  const current = rateLimitStore.get(key);
  
  if (!current || now > current.resetTime) {
    // Reset or initialize
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs,
    });
    return true;
  }
  
  if (current.count >= maxRequests) {
    return false;
  }
  
  current.count++;
  rateLimitStore.set(key, current);
  return true;
}

/**
 * Get permissions based on agent capabilities and supported graphs
 * Uses standard LangGraph permissions for compatibility
 */
function getMCPAgentPermissions(
  _capabilities: string[],
  _supportedGraphs: string[]
): string[] {
  // Start with base MCP agent permissions (standard LangGraph permissions)
  const permissions = [...MCP_AGENT_PERMISSIONS];
  
  // MCP agents get additional permissions based on their capabilities
  // We store the custom capabilities in metadata for later use
  // but only return standard LangGraph permissions here
  
  return permissions;
}

/**
 * Authenticate MCP agent using JWT token
 */
async function authenticateMCPAgentJWT(request: Request): Promise<AuthenticateReturn | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  
  const token = authHeader.substring(7);
  const jwtSecret = process.env.MCP_JWT_SECRET;
  
  if (!jwtSecret) {
    throw new HTTPException(500, {
      message: "MCP JWT secret not configured",
    });
  }
  
  const payload = verifyMCPAgentJWT(token, jwtSecret);
  if (!payload) {
    return null;
  }
  
  // Check rate limit
  if (!checkRateLimit(`mcp_agent:${payload.agentId}`, 1000, 60 * 1000)) {
    throw new HTTPException(429, {
      message: "Rate limit exceeded for MCP agent",
    });
  }
  
  const permissions = getMCPAgentPermissions(
    payload.capabilities,
    payload.supportedGraphs
  );
  
  return {
    identity: `mcp_agent:${payload.agentId}`,
    is_authenticated: true,
    display_name: payload.agentName,
    permissions,
    metadata: {
      installation_name: "mcp-agent",
      agent_type: "mcp",
      agent_capabilities: payload.capabilities,
      supported_graphs: payload.supportedGraphs,
    },
  };
}

/**
 * Authenticate MCP agent using API key
 */
async function authenticateMCPAgentAPIKey(request: Request): Promise<AuthenticateReturn | null> {
  const apiKey = request.headers.get("x-mcp-api-key");
  if (!apiKey) {
    return null;
  }
  
  const agentId = request.headers.get("x-mcp-agent-id");
  if (!agentId) {
    throw new HTTPException(400, {
      message: "MCP agent ID header required for API key authentication",
    });
  }
  
  const apiSecret = process.env.MCP_API_SECRET;
  if (!apiSecret) {
    throw new HTTPException(500, {
      message: "MCP API secret not configured",
    });
  }
  
  // Verify API key
  if (!verifyAPIKeyHash(apiKey, agentId, apiSecret)) {
    throw new HTTPException(401, {
      message: "Invalid MCP API key",
    });
  }
  
  // Check rate limit
  if (!checkRateLimit(`mcp_agent:${agentId}`, 500, 60 * 1000)) {
    throw new HTTPException(429, {
      message: "Rate limit exceeded for MCP agent",
    });
  }
  
  // For API key auth, we need to get agent capabilities from headers or database
  // For now, we'll use headers with fallback to basic permissions
  const capabilitiesHeader = request.headers.get("x-mcp-capabilities");
  const graphsHeader = request.headers.get("x-mcp-supported-graphs");
  
  const capabilities = capabilitiesHeader ? capabilitiesHeader.split(",") : [AgentCapability.GENERAL];
  const supportedGraphs = graphsHeader ? graphsHeader.split(",") : [GraphTarget.PROGRAMMER];
  
  const permissions = getMCPAgentPermissions(capabilities, supportedGraphs);
  
  return {
    identity: `mcp_agent:${agentId}`,
    is_authenticated: true,
    display_name: `MCP Agent ${agentId}`,
    permissions,
    metadata: {
      installation_name: "mcp-agent",
      agent_type: "mcp",
      agent_capabilities: capabilities,
      supported_graphs: supportedGraphs,
    },
  };
}

export const auth = new Auth()
  .authenticate<AuthenticateReturn>(async (request: Request) => {
    const isProd = process.env.NODE_ENV === "production";

    if (request.method === "OPTIONS") {
      return {
        identity: "anonymous",
        permissions: [],
        is_authenticated: false,
        display_name: "CORS Preflight",
        metadata: {
          installation_name: "n/a",
        },
      };
    }

    // Check for MCP agent authentication first (JWT or API key)
    const mcpJWTAuth = await authenticateMCPAgentJWT(request);
    if (mcpJWTAuth) {
      return mcpJWTAuth;
    }

    const mcpAPIKeyAuth = await authenticateMCPAgentAPIKey(request);
    if (mcpAPIKeyAuth) {
      return mcpAPIKeyAuth;
    }

    // Check for local mode
    const localModeHeader = request.headers.get(LOCAL_MODE_HEADER);
    const isRunningLocalModeEnv = process.env.OPEN_SWE_LOCAL_MODE === "true";
    if (localModeHeader === "true" && isRunningLocalModeEnv) {
      return {
        identity: "local-user",
        is_authenticated: true,
        display_name: "Local User",
        metadata: {
          installation_name: "local-mode",
          agent_type: "local",
        },
        permissions: LANGGRAPH_USER_PERMISSIONS,
      };
    }

    const ghSecretHashHeader = request.headers.get("X-Hub-Signature-256");
    if (ghSecretHashHeader) {
      // This will either return a valid user, or throw an error
      return await verifyGitHubWebhookOrThrow(request);
    }

    const encryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error("Missing SECRETS_ENCRYPTION_KEY environment variable.");
    }

    // Check for GitHub PAT authentication (simpler mode for evals, etc.)
    const githubPat = getGitHubPatFromRequest(request, encryptionKey);
    if (githubPat && !isProd) {
      const user = await verifyGithubUser(githubPat);
      if (!user) {
        throw new HTTPException(401, {
          message: "Invalid GitHub PAT",
        });
      }

      return {
        identity: user.id.toString(),
        is_authenticated: true,
        display_name: user.login,
        metadata: {
          installation_name: "pat-auth",
          agent_type: "github",
        },
        permissions: LANGGRAPH_USER_PERMISSIONS,
      };
    }

    // GitHub App authentication mode (existing logic)
    const installationNameHeader = request.headers.get(
      GITHUB_INSTALLATION_NAME,
    );
    if (!installationNameHeader) {
      throw new HTTPException(401, {
        message: "GitHub installation name header missing",
      });
    }
    const installationIdHeader = request.headers.get(GITHUB_INSTALLATION_ID);
    if (!installationIdHeader) {
      throw new HTTPException(401, {
        message: "GitHub installation ID header missing",
      });
    }

    // We don't do anything with this token right now, but still confirm it
    // exists as it will cause issues later on if it's not present.
    const encryptedInstallationToken = request.headers.get(
      GITHUB_INSTALLATION_TOKEN_COOKIE,
    );
    if (!encryptedInstallationToken) {
      throw new HTTPException(401, {
        message: "GitHub installation token header missing",
      });
    }

    const encryptedAccessToken = request.headers.get(GITHUB_TOKEN_COOKIE);
    const decryptedAccessToken = encryptedAccessToken
      ? decryptSecret(encryptedAccessToken, encryptionKey)
      : undefined;
    const decryptedInstallationToken = decryptSecret(
      encryptedInstallationToken,
      encryptionKey,
    );

    let user: GithubUser | undefined;

    if (!decryptedAccessToken) {
      // If there isn't a user access token, check to see if the user info is in headers.
      // This would indicate a bot created the request.
      const userIdHeader = request.headers.get(GITHUB_USER_ID_HEADER);
      const userLoginHeader = request.headers.get(GITHUB_USER_LOGIN_HEADER);
      if (!userIdHeader || !userLoginHeader) {
        throw new HTTPException(401, {
          message: "Github-User-Id or Github-User-Login header missing",
        });
      }
      user = await verifyGithubUserId(
        decryptedInstallationToken,
        Number(userIdHeader),
        userLoginHeader,
      );
    } else {
      // Ensure we decrypt the token before passing to the verification function.
      user = await verifyGithubUser(decryptedAccessToken);
    }

    if (!user) {
      throw new HTTPException(401, {
        message: "User not found",
      });
    }

    return {
      identity: user.id.toString(),
      is_authenticated: true,
      display_name: user.login,
      metadata: {
        installation_name: installationNameHeader,
        agent_type: "github",
      },
      permissions: LANGGRAPH_USER_PERMISSIONS,
    };
  })

  // THREADS: create operations with metadata
  .on("threads:create", ({ value, user }) =>
    createWithOwnerMetadata(value, user),
  )
  .on("threads:create_run", ({ value, user }) =>
    createWithOwnerMetadata(value, user),
  )

  // THREADS: read, update, delete, search operations
  .on("threads:read", ({ user }) => createOwnerFilter(user))
  .on("threads:update", ({ user }) => createOwnerFilter(user))
  .on("threads:delete", ({ user }) => createOwnerFilter(user))
  .on("threads:search", ({ user }) => createOwnerFilter(user))

  // ASSISTANTS: create operation with metadata
  .on("assistants:create", ({ value, user }) =>
    createWithOwnerMetadata(value, user),
  )

  // ASSISTANTS: read, update, delete, search operations
  .on("assistants:read", ({ user }) => createOwnerFilter(user))
  .on("assistants:update", ({ user }) => createOwnerFilter(user))
  .on("assistants:delete", ({ user }) => createOwnerFilter(user))
  .on("assistants:search", ({ user }) => createOwnerFilter(user))

  // STORE: permission-based access
  .on("store", ({ user }) => {
    return { owner: user.identity };
  });

/**
 * Utility function to check if user has specific MCP permission
 */
export function hasMCPPermission(user: any, permission: string): boolean {
  return user.permissions && user.permissions.includes(permission);
}

/**
 * Utility function to get MCP agent metadata
 */
export function getMCPAgentMetadata(user: any): {
  agentType?: string;
  capabilities?: string[];
  supportedGraphs?: string[];
} | null {
  if (!user.metadata || user.metadata.agent_type !== "mcp") {
    return null;
  }
  
  return {
    agentType: user.metadata.agent_type,
    capabilities: user.metadata.agent_capabilities,
    supportedGraphs: user.metadata.supported_graphs,
  };
}

/**
 * Rate limiting middleware for MCP endpoints
 */
export function createMCPRateLimitMiddleware(
  maxRequests: number = 100,
  windowMs: number = 60 * 1000
) {
  return (req: Request, next: () => void) => {
    const identifier = req.headers.get("x-mcp-agent-id") || 
                      req.headers.get("authorization")?.substring(7, 20) || // First part of JWT
                      "unknown";
    
    if (!checkRateLimit(`mcp_middleware:${identifier}`, maxRequests, windowMs)) {
      throw new HTTPException(429, {
        message: "Rate limit exceeded",
      });
    }
    
    next();
  };
}

/**
 * Cleanup rate limit store (should be called periodically)
 */
export function cleanupRateLimitStore(): void {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}

// Cleanup rate limit store every 5 minutes
setInterval(cleanupRateLimitStore, 5 * 60 * 1000);












