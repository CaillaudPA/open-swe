export const TIMEOUT_SEC = 60; // 1 minute
export const SANDBOX_ROOT_DIR = "/home/daytona";
export const DAYTONA_IMAGE_NAME = "daytonaio/langchain-open-swe:0.1.0";
export const DAYTONA_SNAPSHOT_NAME = "open-swe-vcpu2-mem4-disk5";
export const PLAN_INTERRUPT_DELIMITER = ":::";
export const PLAN_INTERRUPT_ACTION_TITLE = "Approve/Edit Plan";

// Prefix the access token with `x-` so that it's included in requests to the LangGraph server.
export const GITHUB_TOKEN_COOKIE = "x-github-access-token";
export const GITHUB_INSTALLATION_TOKEN_COOKIE = "x-github-installation-token";
export const GITHUB_INSTALLATION_NAME = "x-github-installation-name";
export const GITHUB_PAT = "x-github-pat";
export const GITHUB_INSTALLATION_ID = "x-github-installation-id";
export const LOCAL_MODE_HEADER = "x-local-mode";
export const DO_NOT_RENDER_ID_PREFIX = "do-not-render-";
export const GITHUB_AUTH_STATE_COOKIE = "github_auth_state";
export const GITHUB_INSTALLATION_ID_COOKIE = "github_installation_id";
export const GITHUB_TOKEN_TYPE_COOKIE = "github_token_type";

export const MANAGER_GRAPH_ID = "manager";
export const PLANNER_GRAPH_ID = "planner";
export const PROGRAMMER_GRAPH_ID = "programmer";

export const GITHUB_USER_ID_HEADER = "x-github-user-id";
export const GITHUB_USER_LOGIN_HEADER = "x-github-user-login";

export const DEFAULT_MCP_SERVERS = {
  "langgraph-docs-mcp": {
    command: "uvx",
    args: [
      "--from",
      "mcpdoc",
      "mcpdoc",
      "--urls",
      "LangGraphPY:https://langchain-ai.github.io/langgraph/llms.txt LangGraphJS:https://langchain-ai.github.io/langgraphjs/llms.txt",
      "--transport",
      "stdio",
    ],
    stderr: "inherit" as const,
  },
};

export const API_KEY_REQUIRED_MESSAGE =
  "Unknown users must provide API keys to use the Open SWE demo application";

export const OPEN_SWE_STREAM_MODE = [
  "values",
  "updates",
  "messages",
  "messages-tuple",
  "custom",
];

// MCP Server Configuration Constants
export const MCP_SERVER_ENDPOINTS = {
  AGENTS: {
    REGISTER: "/mcp/agents/register",
    HEARTBEAT: "/mcp/agents/heartbeat",
    LIST: "/mcp/agents",
    UNREGISTER: "/mcp/agents/unregister",
  },
  TASKS: {
    SUBMIT: "/mcp/tasks/submit",
    STATUS: "/mcp/tasks/status",
    RESULTS: "/mcp/tasks/results",
    CANCEL: "/mcp/tasks/cancel",
  },
  SYSTEM: {
    HEALTH: "/mcp/health",
    METRICS: "/mcp/metrics",
  },
} as const;

// MCP Server Timeouts (in milliseconds)
export const MCP_TIMEOUTS = {
  TASK_EXECUTION: 30 * 60 * 1000, // 30 minutes
  AGENT_HEARTBEAT: 5 * 60 * 1000, // 5 minutes
  AGENT_REGISTRATION: 30 * 1000, // 30 seconds
  TASK_SUBMISSION: 60 * 1000, // 1 minute
  HEALTH_CHECK: 10 * 1000, // 10 seconds
} as const;

// MCP Agent Registration Limits
export const MCP_AGENT_LIMITS = {
  MAX_REGISTERED_AGENTS: 100,
  MAX_CONCURRENT_TASKS_PER_AGENT: 5,
  MAX_TOTAL_CONCURRENT_TASKS: 50,
  AGENT_NAME_MAX_LENGTH: 64,
  AGENT_DESCRIPTION_MAX_LENGTH: 256,
  MAX_CAPABILITIES_PER_AGENT: 10,
  MAX_SUPPORTED_GRAPHS_PER_AGENT: 3,
} as const;

// MCP Task Execution Parameters
export const MCP_TASK_EXECUTION = {
  DEFAULT_PRIORITY: 5,
  MIN_PRIORITY: 1,
  MAX_PRIORITY: 10,
  TASK_QUEUE_MAX_SIZE: 1000,
  TASK_RESULT_RETENTION_MS: 24 * 60 * 60 * 1000, // 24 hours
  MAX_TASK_RETRIES: 3,
  RETRY_DELAY_MS: 5 * 1000, // 5 seconds
  TASK_DESCRIPTION_MAX_LENGTH: 512,
} as const;

// MCP Rate Limiting Configuration
export const MCP_RATE_LIMITS = {
  JWT_REQUESTS_PER_MINUTE: 1000,
  API_KEY_REQUESTS_PER_MINUTE: 500,
  REGISTRATION_REQUESTS_PER_HOUR: 10,
  TASK_SUBMISSION_REQUESTS_PER_MINUTE: 100,
  RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute
} as const;

// MCP Authentication Configuration
export const MCP_AUTH = {
  JWT_EXPIRATION: "24h",
  API_KEY_LENGTH: 32,
  JWT_ISSUER: "open-swe-mcp",
  JWT_AUDIENCE: "mcp-agents",
} as const;

// MCP Error Messages
export const MCP_ERROR_MESSAGES = {
  AGENT_NOT_FOUND: "Agent not found",
  AGENT_ALREADY_REGISTERED: "Agent already registered",
  TASK_NOT_FOUND: "Task not found",
  INVALID_TASK_STATUS: "Invalid task status",
  QUEUE_FULL: "Task queue is full",
  AGENT_LIMIT_EXCEEDED: "Maximum number of registered agents exceeded",
  CONCURRENT_TASK_LIMIT_EXCEEDED: "Concurrent task limit exceeded",
  INVALID_GRAPH_TARGET: "Invalid graph target specified",
  AUTHENTICATION_REQUIRED: "MCP authentication required",
  INSUFFICIENT_PERMISSIONS: "Insufficient permissions for this operation",
} as const;

