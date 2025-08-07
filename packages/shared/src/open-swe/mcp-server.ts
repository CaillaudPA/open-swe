import { z } from "zod";

/**
 * Task execution status enum
 */
export enum TaskExecutionStatus {
  PENDING = "pending",
  QUEUED = "queued",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

/**
 * Agent capability types for task routing
 */
export enum AgentCapability {
  PLANNING = "planning",
  PROGRAMMING = "programming",
  MANAGEMENT = "management",
  REVIEW = "review",
  GENERAL = "general",
}

/**
 * Task priority levels
 */
export enum TaskPriority {
  LOW = "low",
  NORMAL = "normal",
  HIGH = "high",
  URGENT = "urgent",
}

/**
 * Graph execution target
 */
export enum GraphTarget {
  MANAGER = "manager",
  PLANNER = "planner",
  PROGRAMMER = "programmer",
}

/**
 * Zod schema for task execution status
 */
export const TaskExecutionStatusSchema = z.nativeEnum(TaskExecutionStatus);

/**
 * Zod schema for agent capabilities
 */
export const AgentCapabilitySchema = z.nativeEnum(AgentCapability);

/**
 * Zod schema for task priority
 */
export const TaskPrioritySchema = z.nativeEnum(TaskPriority);

/**
 * Zod schema for graph target
 */
export const GraphTargetSchema = z.nativeEnum(GraphTarget);

/**
 * Agent registration schema
 */
export const AgentRegistrationSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  name: z.string().min(1, "Agent name is required"),
  description: z.string().optional(),
  capabilities: z.array(AgentCapabilitySchema).min(1, "At least one capability is required"),
  version: z.string().default("1.0.0"),
  endpoint: z.string().url("Valid endpoint URL is required"),
  apiKey: z.string().min(1, "API key is required"),
  maxConcurrentTasks: z.number().int().positive().default(1),
  supportedGraphs: z.array(GraphTargetSchema).min(1, "At least one supported graph is required"),
  metadata: z.record(z.string(), z.any()).optional(),
  registeredAt: z.number().optional(),
  lastHeartbeat: z.number().optional(),
});

/**
 * Agent task request schema
 */
export const AgentTaskRequestSchema = z.object({
  taskId: z.string().uuid("Valid UUID required for task ID").optional(),
  agentId: z.string().min(1, "Agent ID is required"),
  title: z.string().min(1, "Task title is required"),
  description: z.string().min(1, "Task description is required"),
  priority: TaskPrioritySchema.default(TaskPriority.NORMAL),
  targetGraph: GraphTargetSchema,
  requiredCapabilities: z.array(AgentCapabilitySchema).optional(),
  context: z.object({
    repository: z.object({
      owner: z.string().min(1, "Repository owner is required"),
      repo: z.string().min(1, "Repository name is required"),
      branch: z.string().optional(),
      baseCommit: z.string().optional(),
    }).optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    parentTaskId: z.string().uuid().optional(),
    customRules: z.object({
      generalRules: z.string().optional(),
      repositoryStructure: z.string().optional(),
      dependenciesAndInstallation: z.string().optional(),
      testingInstructions: z.string().optional(),
      pullRequestFormatting: z.string().optional(),
    }).optional(),
  }).optional(),
  timeout: z.number().int().positive().default(3600), // 1 hour default
  retryCount: z.number().int().min(0).max(3).default(0),
  metadata: z.record(z.string(), z.any()).optional(),
  createdAt: z.number().optional(),
});

/**
 * Task execution result schema
 */
export const TaskExecutionResultSchema = z.object({
  success: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
  artifacts: z.array(z.object({
    type: z.string(),
    path: z.string().optional(),
    content: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })).optional(),
  metrics: z.object({
    executionTime: z.number().optional(),
    tokensUsed: z.number().optional(),
    cost: z.number().optional(),
    stepsCompleted: z.number().optional(),
    totalSteps: z.number().optional(),
  }).optional(),
});

/**
 * Agent task response schema
 */
export const AgentTaskResponseSchema = z.object({
  taskId: z.string().uuid("Valid UUID required for task ID"),
  agentId: z.string().min(1, "Agent ID is required"),
  status: TaskExecutionStatusSchema,
  result: TaskExecutionResultSchema.optional(),
  progress: z.object({
    currentStep: z.number().int().min(0).optional(),
    totalSteps: z.number().int().min(0).optional(),
    description: z.string().optional(),
    percentage: z.number().min(0).max(100).optional(),
  }).optional(),
  logs: z.array(z.object({
    timestamp: z.number(),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
  })).optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  updatedAt: z.number().optional(),
  error: z.string().optional(),
  retryCount: z.number().int().min(0).default(0),
});

/**
 * MCP server configuration schema
 */
export const MCPServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().positive().default(3001),
  host: z.string().default("localhost"),
  maxConcurrentTasks: z.number().int().positive().default(10),
  taskTimeout: z.number().int().positive().default(3600), // 1 hour
  agentTimeout: z.number().int().positive().default(300), // 5 minutes
  maxRetries: z.number().int().min(0).max(5).default(3),
  rateLimiting: z.object({
    enabled: z.boolean().default(true),
    maxRequestsPerMinute: z.number().int().positive().default(60),
    maxRequestsPerHour: z.number().int().positive().default(1000),
  }).optional(),
  authentication: z.object({
    required: z.boolean().default(true),
    jwtSecret: z.string().optional(),
    apiKeyHeader: z.string().default("x-mcp-api-key"),
    tokenExpiration: z.number().int().positive().default(86400), // 24 hours
  }).optional(),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    enableRequestLogging: z.boolean().default(true),
    enableTaskLogging: z.boolean().default(true),
  }).optional(),
});

/**
 * Agent heartbeat schema
 */
export const AgentHeartbeatSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  status: z.enum(["active", "idle", "busy", "offline"]),
  currentTasks: z.array(z.string().uuid()).optional(),
  systemInfo: z.object({
    cpuUsage: z.number().min(0).max(100).optional(),
    memoryUsage: z.number().min(0).max(100).optional(),
    diskUsage: z.number().min(0).max(100).optional(),
  }).optional(),
  timestamp: z.number().optional(),
});

/**
 * Task queue item schema
 */
export const TaskQueueItemSchema = z.object({
  taskId: z.string().uuid(),
  agentId: z.string(),
  priority: TaskPrioritySchema,
  targetGraph: GraphTargetSchema,
  queuedAt: z.number(),
  estimatedDuration: z.number().optional(),
  dependencies: z.array(z.string().uuid()).optional(),
});

/**
 * Agent discovery response schema
 */
export const AgentDiscoveryResponseSchema = z.object({
  agents: z.array(z.object({
    agentId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    capabilities: z.array(AgentCapabilitySchema),
    supportedGraphs: z.array(GraphTargetSchema),
    status: z.enum(["active", "idle", "busy", "offline"]),
    currentTasks: z.number().int().min(0),
    maxConcurrentTasks: z.number().int().positive(),
    registeredAt: z.number(),
    lastHeartbeat: z.number(),
  })),
  totalCount: z.number().int().min(0),
});

/**
 * TypeScript types derived from Zod schemas
 */
export type AgentRegistration = z.infer<typeof AgentRegistrationSchema>;
export type AgentTaskRequest = z.infer<typeof AgentTaskRequestSchema>;
export type AgentTaskResponse = z.infer<typeof AgentTaskResponseSchema>;
export type TaskExecutionResult = z.infer<typeof TaskExecutionResultSchema>;
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;
export type AgentHeartbeat = z.infer<typeof AgentHeartbeatSchema>;
export type TaskQueueItem = z.infer<typeof TaskQueueItemSchema>;
export type AgentDiscoveryResponse = z.infer<typeof AgentDiscoveryResponseSchema>;

/**
 * API endpoint paths
 */
export const MCP_API_PATHS = {
  AGENTS: {
    REGISTER: "/mcp/agents/register",
    UNREGISTER: "/mcp/agents/unregister",
    HEARTBEAT: "/mcp/agents/heartbeat",
    DISCOVER: "/mcp/agents/discover",
    STATUS: "/mcp/agents/:agentId/status",
  },
  TASKS: {
    SUBMIT: "/mcp/tasks/submit",
    STATUS: "/mcp/tasks/status/:taskId",
    RESULTS: "/mcp/tasks/results/:taskId",
    CANCEL: "/mcp/tasks/cancel/:taskId",
    LIST: "/mcp/tasks/list",
    QUEUE: "/mcp/tasks/queue",
  },
  HEALTH: {
    CHECK: "/mcp/health",
    METRICS: "/mcp/metrics",
  },
} as const;

/**
 * Default configuration values
 */
export const MCP_DEFAULTS = {
  MAX_CONCURRENT_TASKS: 10,
  TASK_TIMEOUT: 3600, // 1 hour in seconds
  AGENT_TIMEOUT: 300, // 5 minutes in seconds
  MAX_RETRIES: 3,
  HEARTBEAT_INTERVAL: 30, // 30 seconds
  CLEANUP_INTERVAL: 300, // 5 minutes
  MAX_QUEUE_SIZE: 1000,
  DEFAULT_PRIORITY: TaskPriority.NORMAL,
} as const;

/**
 * Error codes for MCP server operations
 */
export const MCP_ERROR_CODES = {
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  AGENT_ALREADY_REGISTERED: "AGENT_ALREADY_REGISTERED",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_ALREADY_EXISTS: "TASK_ALREADY_EXISTS",
  INVALID_AGENT_CREDENTIALS: "INVALID_AGENT_CREDENTIALS",
  INSUFFICIENT_PERMISSIONS: "INSUFFICIENT_PERMISSIONS",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  QUEUE_FULL: "QUEUE_FULL",
  GRAPH_NOT_AVAILABLE: "GRAPH_NOT_AVAILABLE",
  TASK_TIMEOUT: "TASK_TIMEOUT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
