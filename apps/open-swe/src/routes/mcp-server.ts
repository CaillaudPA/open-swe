import { Hono } from "hono";
import { Context } from "hono";
import { BlankEnv, BlankInput } from "hono/types";
import { v4 as uuidv4 } from "uuid";
import { HTTPException } from "hono/http-exception";
import { createLogger, LogLevel } from "../utils/logger.js";
import {
  AgentRegistrationSchema,
  AgentTaskRequestSchema,
  AgentTaskResponseSchema,
  AgentHeartbeatSchema,
  TaskExecutionStatus,
  MCP_API_PATHS,
  MCP_ERROR_CODES,
  type AgentRegistration,
  type AgentTaskRequest,
  type AgentTaskResponse,
  type AgentHeartbeat,
} from "@open-swe/shared/open-swe/mcp-server";
import {
  MANAGER_GRAPH_ID,
  PLANNER_GRAPH_ID,
  PROGRAMMER_GRAPH_ID,
} from "@open-swe/shared/constants";

const logger = createLogger(LogLevel.INFO, "MCPServer");

// In-memory storage for agents and tasks (in production, use a database)
const registeredAgents = new Map<string, AgentRegistration>();
const activeTasks = new Map<string, AgentTaskResponse>();
const taskQueue = new Map<string, AgentTaskRequest>();

export const mcpServerApp = new Hono();

/**
 * Middleware to validate MCP API key authentication
 */
const validateMCPAuth = async (c: Context, next: () => Promise<void>) => {
  const apiKey = c.req.header("x-mcp-api-key");
  
  if (!apiKey) {
    logger.warn("Missing MCP API key in request");
    throw new HTTPException(401, {
      message: "Missing MCP API key",
    });
  }

  // For now, we'll use a simple API key validation
  // In production, this should validate against a secure key store
  const validApiKey = process.env.MCP_API_KEY || "mcp-dev-key";
  
  if (apiKey !== validApiKey) {
    logger.warn(`Invalid MCP API key provided: ${apiKey}`);
    throw new HTTPException(401, {
      message: "Invalid MCP API key",
    });
  }

  await next();
};

/**
 * Middleware to parse and validate JSON body
 */
const parseJsonBody = async (c: Context, next: () => Promise<void>) => {
  try {
    const body = await c.req.json();
    c.set("parsedBody", body);
    await next();
  } catch (error) {
    logger.error(`Failed to parse JSON body: ${error}`);
    throw new HTTPException(400, {
      message: "Invalid JSON body",
    });
  }
};

/**
 * Error handler middleware
 */
const errorHandler = (err: Error, c: Context) => {
  logger.error(`MCP Server Error: ${err.message}`, { error: err });
  
  if (err instanceof HTTPException) {
    return c.json({
      error: err.message,
      code: err.status === 400 ? MCP_ERROR_CODES.VALIDATION_ERROR : MCP_ERROR_CODES.INTERNAL_ERROR,
    }, err.status);
  }

  return c.json({
    error: "Internal server error",
    code: MCP_ERROR_CODES.INTERNAL_ERROR,
  }, 500);
};

// Apply error handler
mcpServerApp.onError(errorHandler);

/**
 * Health check endpoint
 */
mcpServerApp.get(MCP_API_PATHS.HEALTH.CHECK, (c) => {
  return c.json({
    status: "healthy",
    timestamp: Date.now(),
    version: "1.0.0",
    activeAgents: registeredAgents.size,
    activeTasks: activeTasks.size,
    queuedTasks: taskQueue.size,
  });
});

/**
 * Metrics endpoint
 */
mcpServerApp.get(MCP_API_PATHS.HEALTH.METRICS, validateMCPAuth, (c) => {
  const agents = Array.from(registeredAgents.values()).map(agent => ({
    agentId: agent.agentId,
    name: agent.name,
    capabilities: agent.capabilities,
    supportedGraphs: agent.supportedGraphs,
    maxConcurrentTasks: agent.maxConcurrentTasks,
    registeredAt: agent.registeredAt,
    lastHeartbeat: agent.lastHeartbeat,
  }));

  const tasks = Array.from(activeTasks.values()).map(task => ({
    taskId: task.taskId,
    agentId: task.agentId,
    status: task.status,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
  }));

  return c.json({
    agents,
    tasks,
    statistics: {
      totalAgents: registeredAgents.size,
      activeAgents: agents.filter(a => a.lastHeartbeat && (Date.now() - a.lastHeartbeat) < 60000).length,
      totalTasks: activeTasks.size,
      runningTasks: tasks.filter(t => t.status === TaskExecutionStatus.RUNNING).length,
      queuedTasks: taskQueue.size,
    },
  });
});

/**
 * Agent registration endpoint
 */
mcpServerApp.post(MCP_API_PATHS.AGENTS.REGISTER, validateMCPAuth, parseJsonBody, async (c) => {
  const body = c.get("parsedBody") as any;
  
  try {
    const agentData = AgentRegistrationSchema.parse({
      ...body,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
    });

    if (registeredAgents.has(agentData.agentId)) {
      logger.warn(`Agent already registered: ${agentData.agentId}`);
      throw new HTTPException(409, {
        message: `Agent ${agentData.agentId} is already registered`,
      });
    }

    registeredAgents.set(agentData.agentId, agentData);
    logger.info(`Agent registered successfully: ${agentData.agentId}`, {
      name: agentData.name,
      capabilities: agentData.capabilities,
      supportedGraphs: agentData.supportedGraphs,
    });

    return c.json({
      success: true,
      message: "Agent registered successfully",
      agentId: agentData.agentId,
      registeredAt: agentData.registeredAt,
    }, 201);
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    logger.error(`Agent registration validation failed: ${error}`);
    throw new HTTPException(400, {
      message: `Validation failed: ${error}`,
    });
  }
});

/**
 * Agent unregistration endpoint
 */
mcpServerApp.delete(MCP_API_PATHS.AGENTS.UNREGISTER, validateMCPAuth, parseJsonBody, async (c) => {
  const body = c.get("parsedBody") as any;
  const { agentId } = body;

  if (!agentId) {
    throw new HTTPException(400, {
      message: "Agent ID is required",
    });
  }

  if (!registeredAgents.has(agentId)) {
    throw new HTTPException(404, {
      message: `Agent ${agentId} not found`,
    });
  }

  // Cancel any active tasks for this agent
  const agentTasks = Array.from(activeTasks.entries()).filter(([_, task]) => task.agentId === agentId);
  for (const [, task] of agentTasks) {
    if (task.status === TaskExecutionStatus.RUNNING || task.status === TaskExecutionStatus.QUEUED) {
      task.status = TaskExecutionStatus.CANCELLED;
      task.updatedAt = Date.now();
      task.error = "Agent unregistered";
    }
  }

  registeredAgents.delete(agentId);
  logger.info(`Agent unregistered: ${agentId}`);

  return c.json({
    success: true,
    message: "Agent unregistered successfully",
    cancelledTasks: agentTasks.length,
  });
});

/**
 * Agent heartbeat endpoint
 */
mcpServerApp.post(MCP_API_PATHS.AGENTS.HEARTBEAT, validateMCPAuth, parseJsonBody, async (c) => {
  const body = c.get("parsedBody") as any;
  
  try {
    const heartbeat = AgentHeartbeatSchema.parse({
      ...body,
      timestamp: Date.now(),
    });

    const agent = registeredAgents.get(heartbeat.agentId);
    if (!agent) {
      throw new HTTPException(404, {
        message: `Agent ${heartbeat.agentId} not found`,
      });
    }

    // Update agent's last heartbeat
    agent.lastHeartbeat = heartbeat.timestamp;
    registeredAgents.set(heartbeat.agentId, agent);

    return c.json({
      success: true,
      message: "Heartbeat received",
      timestamp: heartbeat.timestamp,
    });
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    logger.error(`Heartbeat validation failed: ${error}`);
    throw new HTTPException(400, {
      message: `Validation failed: ${error}`,
    });
  }
});

/**
 * Agent discovery endpoint
 */
mcpServerApp.get(MCP_API_PATHS.AGENTS.DISCOVER, validateMCPAuth, (c) => {
  const agents = Array.from(registeredAgents.values()).map(agent => ({
    agentId: agent.agentId,
    name: agent.name,
    description: agent.description,
    capabilities: agent.capabilities,
    supportedGraphs: agent.supportedGraphs,
    status: agent.lastHeartbeat && (Date.now() - agent.lastHeartbeat) < 60000 ? "active" : "offline",
    currentTasks: Array.from(activeTasks.values()).filter(task => 
      task.agentId === agent.agentId && 
      (task.status === TaskExecutionStatus.RUNNING || task.status === TaskExecutionStatus.QUEUED)
    ).length,
    maxConcurrentTasks: agent.maxConcurrentTasks,
    registeredAt: agent.registeredAt || 0,
    lastHeartbeat: agent.lastHeartbeat || 0,
  }));

  return c.json({
    agents,
    totalCount: agents.length,
  });
});

/**
 * Task submission endpoint
 */
mcpServerApp.post(MCP_API_PATHS.TASKS.SUBMIT, validateMCPAuth, parseJsonBody, async (c) => {
  const body = c.get("parsedBody") as any;
  
  try {
    const taskRequest = AgentTaskRequestSchema.parse({
      ...body,
      taskId: body.taskId || uuidv4(),
      createdAt: Date.now(),
    });

    // Validate agent exists and is active
    const agent = registeredAgents.get(taskRequest.agentId);
    if (!agent) {
      throw new HTTPException(404, {
        message: `Agent ${taskRequest.agentId} not found`,
      });
    }

    // Check if agent supports the target graph
    if (!agent.supportedGraphs.includes(taskRequest.targetGraph)) {
      throw new HTTPException(400, {
        message: `Agent ${taskRequest.agentId} does not support graph ${taskRequest.targetGraph}`,
      });
    }

    // Check if task already exists
    if (activeTasks.has(taskRequest.taskId!)) {
      throw new HTTPException(409, {
        message: `Task ${taskRequest.taskId} already exists`,
      });
    }

    // Create initial task response
    const taskResponse: AgentTaskResponse = {
      taskId: taskRequest.taskId!,
      agentId: taskRequest.agentId,
      status: TaskExecutionStatus.QUEUED,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      retryCount: 0,
    };

    // Store task
    activeTasks.set(taskRequest.taskId!, taskResponse);
    taskQueue.set(taskRequest.taskId!, taskRequest);

    logger.info(`Task queued successfully: ${taskRequest.taskId}`, {
      agentId: taskRequest.agentId,
      targetGraph: taskRequest.targetGraph,
      title: taskRequest.title,
    });

    // TODO: In the next task, we'll implement the MCPTaskManager to actually execute the task
    // For now, we just queue it and return success

    return c.json({
      success: true,
      taskId: taskRequest.taskId,
      status: TaskExecutionStatus.QUEUED,
      message: "Task queued successfully",
      queuedAt: Date.now(),
    }, 201);
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    logger.error(`Task submission validation failed: ${error}`);
    throw new HTTPException(400, {
      message: `Validation failed: ${error}`,
    });
  }
});

/**
 * Task status endpoint
 */
mcpServerApp.get(MCP_API_PATHS.TASKS.STATUS.replace(":taskId", ":taskId"), validateMCPAuth, (c) => {
  const taskId = c.req.param("taskId");
  
  if (!taskId) {
    throw new HTTPException(400, {
      message: "Task ID is required",
    });
  }

  const task = activeTasks.get(taskId);
  if (!task) {
    throw new HTTPException(404, {
      message: `Task ${taskId} not found`,
    });
  }

  return c.json(task);
});

/**
 * Task results endpoint
 */
mcpServerApp.get(MCP_API_PATHS.TASKS.RESULTS.replace(":taskId", ":taskId"), validateMCPAuth, (c) => {
  const taskId = c.req.param("taskId");
  
  if (!taskId) {
    throw new HTTPException(400, {
      message: "Task ID is required",
    });
  }

  const task = activeTasks.get(taskId);
  if (!task) {
    throw new HTTPException(404, {
      message: `Task ${taskId} not found`,
    });
  }

  if (task.status !== TaskExecutionStatus.COMPLETED && task.status !== TaskExecutionStatus.FAILED) {
    throw new HTTPException(400, {
      message: `Task ${taskId} is not completed yet. Current status: ${task.status}`,
    });
  }

  return c.json({
    taskId: task.taskId,
    agentId: task.agentId,
    status: task.status,
    result: task.result,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    logs: task.logs,
    error: task.error,
  });
});

/**
 * Task cancellation endpoint
 */
mcpServerApp.post(MCP_API_PATHS.TASKS.CANCEL.replace(":taskId", ":taskId"), validateMCPAuth, (c) => {
  const taskId = c.req.param("taskId");
  
  if (!taskId) {
    throw new HTTPException(400, {
      message: "Task ID is required",
    });
  }

  const task = activeTasks.get(taskId);
  if (!task) {
    throw new HTTPException(404, {
      message: `Task ${taskId} not found`,
    });
  }

  if (task.status === TaskExecutionStatus.COMPLETED || task.status === TaskExecutionStatus.FAILED) {
    throw new HTTPException(400, {
      message: `Task ${taskId} cannot be cancelled. Current status: ${task.status}`,
    });
  }

  task.status = TaskExecutionStatus.CANCELLED;
  task.updatedAt = Date.now();
  task.error = "Task cancelled by user";
  
  // Remove from queue if it's still there
  taskQueue.delete(taskId);

  logger.info(`Task cancelled: ${taskId}`);

  return c.json({
    success: true,
    taskId,
    status: TaskExecutionStatus.CANCELLED,
    message: "Task cancelled successfully",
    cancelledAt: Date.now(),
  });
});

/**
 * Task list endpoint
 */
mcpServerApp.get(MCP_API_PATHS.TASKS.LIST, validateMCPAuth, (c) => {
  const agentId = c.req.query("agentId");
  const status = c.req.query("status") as TaskExecutionStatus;
  const limit = parseInt(c.req.query("limit") || "50");
  const offset = parseInt(c.req.query("offset") || "0");

  let tasks = Array.from(activeTasks.values());

  // Filter by agent ID if provided
  if (agentId) {
    tasks = tasks.filter(task => task.agentId === agentId);
  }

  // Filter by status if provided
  if (status && Object.values(TaskExecutionStatus).includes(status)) {
    tasks = tasks.filter(task => task.status === status);
  }

  // Sort by updated time (newest first)
  tasks.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  // Apply pagination
  const paginatedTasks = tasks.slice(offset, offset + limit);

  return c.json({
    tasks: paginatedTasks,
    pagination: {
      total: tasks.length,
      limit,
      offset,
      hasMore: offset + limit < tasks.length,
    },
  });
});

/**
 * Task queue status endpoint
 */
mcpServerApp.get(MCP_API_PATHS.TASKS.QUEUE, validateMCPAuth, (c) => {
  const queuedTasks = Array.from(taskQueue.entries()).map(([taskId, request]) => ({
    taskId,
    agentId: request.agentId,
    title: request.title,
    priority: request.priority,
    targetGraph: request.targetGraph,
    createdAt: request.createdAt,
  }));

  // Sort by priority and creation time
  queuedTasks.sort((a, b) => {
    const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
    const aPriority = priorityOrder[a.priority as keyof typeof priorityOrder] ?? 2;
    const bPriority = priorityOrder[b.priority as keyof typeof priorityOrder] ?? 2;
    
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  return c.json({
    queue: queuedTasks,
    queueSize: queuedTasks.length,
  });
});

// Export the MCP server app
export default mcpServerApp;









