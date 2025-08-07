import { v4 as uuidv4 } from "uuid";
import { createLogger, LogLevel } from "./logger.js";
import { createLangGraphClient } from "./langgraph-client.js";
import { createNewTask } from "@open-swe/shared/open-swe/tasks";
import { HumanMessage } from "@langchain/core/messages";
import { StreamMode } from "@langchain/langgraph-sdk";
import {
  TaskExecutionStatus,
  GraphTarget,
  TaskPriority,
  MCP_DEFAULTS,
  type AgentTaskRequest,
  type AgentTaskResponse,
  type TaskExecutionResult,
  type TaskQueueItem,
} from "@open-swe/shared/open-swe/mcp-server";
import {
  MANAGER_GRAPH_ID,
  PLANNER_GRAPH_ID,
  PROGRAMMER_GRAPH_ID,
  OPEN_SWE_STREAM_MODE,
} from "@open-swe/shared/constants";
import { ManagerGraphUpdate } from "@open-swe/shared/open-swe/manager/types";

const logger = createLogger(LogLevel.INFO, "MCPTaskManager");

/**
 * Task execution context for managing task state and metadata
 */
interface TaskExecutionContext {
  taskId: string;
  agentId: string;
  threadId: string;
  runId?: string;
  startTime: number;
  lastUpdate: number;
  retryCount: number;
  logs: Array<{
    timestamp: number;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    metadata?: Record<string, any>;
  }>;
}

/**
 * Graph execution configuration
 */
interface GraphExecutionConfig {
  recursionLimit?: number;
  configurable?: Record<string, any>;
  streamMode?: StreamMode[];
  timeout?: number;
}

/**
 * MCPTaskManager handles task execution and routing for the MCP server
 */
export class MCPTaskManager {
  private taskQueue: Map<string, TaskQueueItem> = new Map();
  private activeTasks: Map<string, AgentTaskResponse> = new Map();
  private executionContexts: Map<string, TaskExecutionContext> = new Map();
  private isProcessing = false;
  private processingInterval: NodeJS.Timeout | null = null;

  constructor(
    private maxConcurrentTasks: number = MCP_DEFAULTS.MAX_CONCURRENT_TASKS,
    private taskTimeout: number = MCP_DEFAULTS.TASK_TIMEOUT * 1000, // Convert to milliseconds
    private processingIntervalMs: number = 5000, // 5 seconds
  ) {
    this.startTaskProcessor();
    logger.info("MCPTaskManager initialized", {
      maxConcurrentTasks: this.maxConcurrentTasks,
      taskTimeout: this.taskTimeout,
      processingInterval: this.processingIntervalMs,
    });
  }

  /**
   * Submit a new task for execution
   */
  async submitTask(taskRequest: AgentTaskRequest): Promise<AgentTaskResponse> {
    const taskId = taskRequest.taskId!;
    
    logger.info(`Submitting task: ${taskId}`, {
      agentId: taskRequest.agentId,
      targetGraph: taskRequest.targetGraph,
      title: taskRequest.title,
      priority: taskRequest.priority,
    });

    // Create task queue item
    const queueItem: TaskQueueItem = {
      taskId,
      agentId: taskRequest.agentId,
      priority: taskRequest.priority || TaskPriority.NORMAL,
      targetGraph: taskRequest.targetGraph,
      queuedAt: Date.now(),
      estimatedDuration: taskRequest.timeout,
      dependencies: taskRequest.context?.parentTaskId ? [taskRequest.context.parentTaskId] : undefined,
    };

    // Create initial task response
    const taskResponse: AgentTaskResponse = {
      taskId,
      agentId: taskRequest.agentId,
      status: TaskExecutionStatus.QUEUED,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      retryCount: 0,
      logs: [{
        timestamp: Date.now(),
        level: "info",
        message: "Task queued for execution",
        metadata: {
          targetGraph: taskRequest.targetGraph,
          priority: taskRequest.priority,
        },
      }],
    };

    // Store task data
    this.taskQueue.set(taskId, queueItem);
    this.activeTasks.set(taskId, taskResponse);

    // Store the original task request for execution
    (taskResponse as any)._originalRequest = taskRequest;

    logger.info(`Task queued successfully: ${taskId}`);
    return taskResponse;
  }

  /**
   * Get task status
   */
  getTaskStatus(taskId: string): AgentTaskResponse | null {
    return this.activeTasks.get(taskId) || null;
  }

  /**
   * Cancel a task
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      return false;
    }

    // Remove from queue if still queued
    this.taskQueue.delete(taskId);

    // Update task status
    task.status = TaskExecutionStatus.CANCELLED;
    task.updatedAt = Date.now();
    task.error = "Task cancelled by user";

    // Add cancellation log
    if (!task.logs) task.logs = [];
    task.logs.push({
      timestamp: Date.now(),
      level: "info",
      message: "Task cancelled by user",
    });

    // Clean up execution context
    this.executionContexts.delete(taskId);

    logger.info(`Task cancelled: ${taskId}`);
    return true;
  }

  /**
   * Get queue status
   */
  getQueueStatus(): TaskQueueItem[] {
    return Array.from(this.taskQueue.values()).sort((a, b) => {
      // Sort by priority first, then by queued time
      const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
      const aPriority = priorityOrder[a.priority as keyof typeof priorityOrder] ?? 2;
      const bPriority = priorityOrder[b.priority as keyof typeof priorityOrder] ?? 2;
      
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      
      return a.queuedAt - b.queuedAt;
    });
  }

  /**
   * Start the task processor
   */
  private startTaskProcessor(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }

    this.processingInterval = setInterval(() => {
      this.processTaskQueue();
    }, this.processingIntervalMs);

    logger.info("Task processor started");
  }

  /**
   * Stop the task processor
   */
  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    logger.info("Task processor stopped");
  }

  /**
   * Process the task queue
   */
  private async processTaskQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      // Check for timed-out tasks
      await this.checkTaskTimeouts();

      // Get currently running tasks
      const runningTasks = Array.from(this.activeTasks.values()).filter(
        task => task.status === TaskExecutionStatus.RUNNING
      );

      // Check if we can start new tasks
      const availableSlots = this.maxConcurrentTasks - runningTasks.length;
      if (availableSlots <= 0) {
        return;
      }

      // Get queued tasks sorted by priority
      const queuedTasks = this.getQueueStatus().slice(0, availableSlots);

      // Process each queued task
      for (const queueItem of queuedTasks) {
        try {
          await this.executeTask(queueItem);
        } catch (error) {
          logger.error(`Failed to execute task ${queueItem.taskId}: ${error}`);
          await this.handleTaskError(queueItem.taskId, error as Error);
        }
      }
    } catch (error) {
      logger.error(`Task processor error: ${error}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Check for timed-out tasks
   */
  private async checkTaskTimeouts(): Promise<void> {
    const now = Date.now();
    
    for (const [taskId, task] of this.activeTasks.entries()) {
      if (task.status === TaskExecutionStatus.RUNNING) {
        const executionTime = now - (task.startedAt || 0);
        
        if (executionTime > this.taskTimeout) {
          logger.warn(`Task timeout: ${taskId}`, { executionTime });
          await this.handleTaskTimeout(taskId);
        }
      }
    }
  }

  /**
   * Execute a task
   */
  private async executeTask(queueItem: TaskQueueItem): Promise<void> {
    const { taskId } = queueItem;
    const task = this.activeTasks.get(taskId);
    const originalRequest = (task as any)?._originalRequest as AgentTaskRequest;

    if (!task || !originalRequest) {
      throw new Error(`Task data not found for ${taskId}`);
    }

    logger.info(`Starting task execution: ${taskId}`, {
      targetGraph: queueItem.targetGraph,
      agentId: queueItem.agentId,
    });

    // Remove from queue and update status
    this.taskQueue.delete(taskId);
    task.status = TaskExecutionStatus.RUNNING;
    task.startedAt = Date.now();
    task.updatedAt = Date.now();

    // Create execution context
    const threadId = uuidv4();
    const context: TaskExecutionContext = {
      taskId,
      agentId: queueItem.agentId,
      threadId,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      retryCount: task.retryCount || 0,
      logs: task.logs || [],
    };

    this.executionContexts.set(taskId, context);

    // Add execution log
    context.logs.push({
      timestamp: Date.now(),
      level: "info",
      message: "Task execution started",
      metadata: {
        threadId,
        targetGraph: queueItem.targetGraph,
      },
    });

    try {
      // Route to appropriate graph
      const result = await this.routeToGraph(originalRequest, context);
      
      // Update task with success
      task.status = TaskExecutionStatus.COMPLETED;
      task.completedAt = Date.now();
      task.updatedAt = Date.now();
      task.result = result;
      task.logs = context.logs;

      context.logs.push({
        timestamp: Date.now(),
        level: "info",
        message: "Task completed successfully",
        metadata: {
          executionTime: Date.now() - context.startTime,
        },
      });

      logger.info(`Task completed successfully: ${taskId}`, {
        executionTime: Date.now() - context.startTime,
      });

    } catch (error) {
      await this.handleTaskError(taskId, error as Error);
    }
  }

  /**
   * Route task to appropriate graph based on target
   */
  private async routeToGraph(
    taskRequest: AgentTaskRequest,
    context: TaskExecutionContext
  ): Promise<TaskExecutionResult> {
    const { targetGraph } = taskRequest;
    const client = createLangGraphClient();

    // Create graph-specific input based on target
    let graphId: string;
    let input: any;
    let config: GraphExecutionConfig = {
      recursionLimit: 400,
      streamMode: OPEN_SWE_STREAM_MODE as StreamMode[],
      timeout: taskRequest.timeout,
    };

    switch (targetGraph) {
      case GraphTarget.MANAGER:
        graphId = MANAGER_GRAPH_ID;
        input = this.createManagerGraphInput(taskRequest, context);
        break;
      
      case GraphTarget.PLANNER:
        graphId = PLANNER_GRAPH_ID;
        input = this.createPlannerGraphInput(taskRequest, context);
        break;
      
      case GraphTarget.PROGRAMMER:
        graphId = PROGRAMMER_GRAPH_ID;
        input = this.createProgrammerGraphInput(taskRequest, context);
        break;
      
      default:
        throw new Error(`Unsupported graph target: ${targetGraph}`);
    }

    // Add repository context if provided
    if (taskRequest.context?.repository) {
      config.configurable = {
        ...config.configurable,
        targetRepository: taskRequest.context.repository,
      };
    }

    // Add custom rules if provided
    if (taskRequest.context?.customRules) {
      config.configurable = {
        ...config.configurable,
        customRules: taskRequest.context.customRules,
      };
    }

    context.logs.push({
      timestamp: Date.now(),
      level: "info",
      message: `Routing to ${targetGraph} graph`,
      metadata: {
        graphId,
        threadId: context.threadId,
      },
    });

    // Execute the graph
    const run = await client.runs.create(context.threadId, graphId, {
      input,
      config,
      ifNotExists: "create",
      streamResumable: true,
      streamMode: config.streamMode,
    });

    context.runId = run.run_id;

    // Wait for completion
    const result = await this.waitForGraphCompletion(context, client);
    
    return result;
  }

  /**
   * Create input for Manager graph
   */
  private createManagerGraphInput(
    taskRequest: AgentTaskRequest,
    context: TaskExecutionContext
  ): ManagerGraphUpdate {
    return {
      messages: [
        new HumanMessage({
          id: uuidv4(),
          content: `**${taskRequest.title}**\n\n${taskRequest.description}`,
          additional_kwargs: {
            mcpTaskId: context.taskId,
            agentId: context.agentId,
          },
        }),
      ],
      targetRepository: taskRequest.context?.repository,
      githubIssueId: taskRequest.context?.pullRequestNumber,
      autoAcceptPlan: false, // MCP tasks require manual approval by default
    };
  }

  /**
   * Create input for Planner graph
   */
  private createPlannerGraphInput(
    taskRequest: AgentTaskRequest,
    context: TaskExecutionContext
  ): PlannerGraphUpdate {
    return {
      messages: [
        new HumanMessage({
          id: uuidv4(),
          content: `**${taskRequest.title}**\n\n${taskRequest.description}`,
          additional_kwargs: {
            mcpTaskId: context.taskId,
            agentId: context.agentId,
          },
        }),
      ],
      targetRepository: taskRequest.context?.repository,
    };
  }

  /**
   * Create input for Programmer graph
   */
  private createProgrammerGraphInput(
    taskRequest: AgentTaskRequest,
    context: TaskExecutionContext
  ): ProgrammerGraphUpdate {
    // Create a simple task plan for the programmer
    const taskPlan = createNewTask(
      taskRequest.description,
      taskRequest.title,
      [{
        index: 0,
        plan: taskRequest.description,
        completed: false,
      }]
    );

    return {
      messages: [
        new HumanMessage({
          id: uuidv4(),
          content: `**${taskRequest.title}**\n\n${taskRequest.description}`,
          additional_kwargs: {
            mcpTaskId: context.taskId,
            agentId: context.agentId,
          },
        }),
      ],
      taskPlan,
      targetRepository: taskRequest.context?.repository,
    };
  }

  /**
   * Wait for graph completion and collect results
   */
  private async waitForGraphCompletion(
    context: TaskExecutionContext,
    client: any
  ): Promise<TaskExecutionResult> {
    const startTime = Date.now();
    const maxWaitTime = this.taskTimeout;
    let lastLogTime = startTime;

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Get run status
        const run = await client.runs.get(context.threadId, context.runId!);
        
        // Log progress periodically
        if (Date.now() - lastLogTime > 30000) { // Every 30 seconds
          context.logs.push({
            timestamp: Date.now(),
            level: "info",
            message: `Graph execution in progress`,
            metadata: {
              status: run.status,
              elapsedTime: Date.now() - startTime,
            },
          });
          lastLogTime = Date.now();
        }

        // Check if completed
        if (run.status === "success") {
          context.logs.push({
            timestamp: Date.now(),
            level: "info",
            message: "Graph execution completed successfully",
            metadata: {
              runId: context.runId,
              executionTime: Date.now() - startTime,
            },
          });

          return {
            success: true,
            output: "Task completed successfully",
            artifacts: [], // TODO: Extract artifacts from run results
            metrics: {
              executionTime: Date.now() - startTime,
              stepsCompleted: 1,
              totalSteps: 1,
            },
          };
        }

        if (run.status === "error" || run.status === "failed") {
          throw new Error(`Graph execution failed: ${run.status}`);
        }

        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, 5000));

      } catch (error) {
        context.logs.push({
          timestamp: Date.now(),
          level: "error",
          message: `Error checking graph status: ${error}`,
        });
        throw error;
      }
    }

    throw new Error("Graph execution timeout");
  }

  /**
   * Handle task error
   */
  private async handleTaskError(taskId: string, error: Error): Promise<void> {
    const task = this.activeTasks.get(taskId);
    const context = this.executionContexts.get(taskId);

    if (!task) return;

    logger.error(`Task error: ${taskId}`, { error: error.message });

    // Update task status
    task.status = TaskExecutionStatus.FAILED;
    task.updatedAt = Date.now();
    task.error = error.message;

    // Add error log
    if (context) {
      context.logs.push({
        timestamp: Date.now(),
        level: "error",
        message: error.message,
        metadata: {
          stack: error.stack,
        },
      });
      task.logs = context.logs;
    }

    // Clean up
    this.taskQueue.delete(taskId);
    this.executionContexts.delete(taskId);
  }

  /**
   * Handle task timeout
   */
  private async handleTaskTimeout(taskId: string): Promise<void> {
    const task = this.activeTasks.get(taskId);
    const context = this.executionContexts.get(taskId);

    if (!task) return;

    // Update task status
    task.status = TaskExecutionStatus.FAILED;
    task.updatedAt = Date.now();
    task.error = "Task execution timeout";

    // Add timeout log
    if (context) {
      context.logs.push({
        timestamp: Date.now(),
        level: "error",
        message: "Task execution timeout",
        metadata: {
          executionTime: Date.now() - context.startTime,
          timeout: this.taskTimeout,
        },
      });
      task.logs = context.logs;
    }

    // Clean up
    this.taskQueue.delete(taskId);
    this.executionContexts.delete(taskId);

    logger.warn(`Task timeout: ${taskId}`);
  }

  /**
   * Get task manager statistics
   */
  getStatistics() {
    const runningTasks = Array.from(this.activeTasks.values()).filter(
      task => task.status === TaskExecutionStatus.RUNNING
    ).length;

    const completedTasks = Array.from(this.activeTasks.values()).filter(
      task => task.status === TaskExecutionStatus.COMPLETED
    ).length;

    const failedTasks = Array.from(this.activeTasks.values()).filter(
      task => task.status === TaskExecutionStatus.FAILED
    ).length;

    return {
      queueSize: this.taskQueue.size,
      runningTasks,
      completedTasks,
      failedTasks,
      totalTasks: this.activeTasks.size,
      maxConcurrentTasks: this.maxConcurrentTasks,
      taskTimeout: this.taskTimeout,
    };
  }
}

// Singleton instance
let taskManagerInstance: MCPTaskManager | null = null;

/**
 * Get the singleton MCPTaskManager instance
 */
export function getMCPTaskManager(): MCPTaskManager {
  if (!taskManagerInstance) {
    taskManagerInstance = new MCPTaskManager();
  }
  return taskManagerInstance;
}

/**
 * Initialize the MCPTaskManager with custom configuration
 */
export function initializeMCPTaskManager(
  maxConcurrentTasks?: number,
  taskTimeout?: number,
  processingInterval?: number
): MCPTaskManager {
  if (taskManagerInstance) {
    taskManagerInstance.stop();
  }
  
  taskManagerInstance = new MCPTaskManager(
    maxConcurrentTasks,
    taskTimeout,
    processingInterval
  );
  
  return taskManagerInstance;
}

