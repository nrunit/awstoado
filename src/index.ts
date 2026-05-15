#!/usr/bin/env node
import "dotenv/config";
import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? "3000");
const ADO_ORG = required("ADO_ORG");
const ADO_PROJECT = required("ADO_PROJECT");
const ADO_PAT = required("ADO_PAT");
const ADO_API_VERSION = process.env.ADO_API_VERSION ?? "7.1";

const WORK_ITEM_TYPES = [
  "Epic",
  "Feature",
  "Product Backlog Item",
  "Task",
  "Bug",
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function escapeWiql(value: string): string {
  return value.replaceAll("'", "''");
}

function mcpText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function adoAuthHeader(): string {
  // Azure DevOps PAT auth uses Basic auth with an empty username and the PAT as password.
  return `Basic ${Buffer.from(`:${ADO_PAT}`).toString("base64")}`;
}

async function adoRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `https://dev.azure.com/${encodeURIComponent(ADO_ORG)}/${encodeURIComponent(
    ADO_PROJECT
  )}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: adoAuthHeader(),
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });

  const rawBody = await response.text();
  let parsedBody: unknown = rawBody;

  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    // Keep raw text if the response is not JSON.
  }

  if (!response.ok) {
    throw new Error(
      `Azure DevOps request failed: ${response.status} ${response.statusText}\n${JSON.stringify(
        parsedBody,
        null,
        2
      )}`
    );
  }

  return parsedBody as T;
}

function workItemPatch(fields: Record<string, unknown>) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([field, value]) => ({
      op: "add",
      path: `/fields/${field}`,
      value,
    }));
}

async function getWorkItemDetails(ids: number[]) {
  if (ids.length === 0) {
    return { workItems: [] };
  }

  return adoRequest<Record<string, unknown>>(
    `/_apis/wit/workitems?ids=${ids.join(",")}&$expand=fields&api-version=${ADO_API_VERSION}`
  );
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "minimal-aws-quick-ado-mcp",
    version: "0.3.0",
  });

  server.registerTool(
    "ado_search_work_items",
    {
      title: "Search Azure DevOps work items",
      description:
        "Searches Azure DevOps work items only in the configured ADO project. Supports Epic, Feature, Product Backlog Item, Task, and Bug.",
      inputSchema: {
        searchText: z.string().optional(),
        workItemTypes: z
          .array(z.enum(WORK_ITEM_TYPES))
          .optional()
          .describe("Optional filter for work item levels/types."),
        state: z
          .string()
          .optional()
          .describe("Optional state filter, for example New, Active, Resolved, Closed, Done."),
        top: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ searchText, workItemTypes, state, top }) => {
      const project = escapeWiql(ADO_PROJECT);

      const selectedTypes =
        workItemTypes && workItemTypes.length > 0
          ? workItemTypes
          : [...WORK_ITEM_TYPES];

      const typeFilter = selectedTypes
        .map((type) => `'${escapeWiql(type)}'`)
        .join(", ");

      const textFilter = searchText
        ? `AND (
            [System.Title] CONTAINS '${escapeWiql(searchText)}'
            OR [System.Description] CONTAINS '${escapeWiql(searchText)}'
          )`
        : "";

      const stateFilter = state
        ? `AND [System.State] = '${escapeWiql(state)}'`
        : "";

      const wiql = `
        SELECT
          [System.Id],
          [System.Title],
          [System.State],
          [System.WorkItemType],
          [System.TeamProject],
          [System.AssignedTo],
          [System.IterationPath],
          [System.ChangedDate]
        FROM WorkItems
        WHERE [System.TeamProject] = '${project}'
          AND [System.WorkItemType] IN (${typeFilter})
          ${stateFilter}
          ${textFilter}
        ORDER BY [System.ChangedDate] DESC
      `;

      const result = await adoRequest<Record<string, unknown>>(
        `/_apis/wit/wiql?$top=${top}&api-version=${ADO_API_VERSION}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: wiql }),
        }
      );

      const refs = (result.workItems as Array<{ id: number }> | undefined) ?? [];
      const ids = refs.map((item) => item.id);

      const details = await getWorkItemDetails(ids);
      return mcpText(details);
    }
  );

  server.registerTool(
    "ado_get_iteration_report",
    {
      title: "Get Azure DevOps iteration report",
      description:
        "Gets work items in a specific Azure DevOps iteration, including owner, current state, estimates, remaining work, completed work, story points, effort, and changed date. Supports Epic, Feature, Product Backlog Item, Task, and Bug.",
      inputSchema: {
        iterationPath: z
          .string()
          .min(1)
          .describe("Exact Azure DevOps iteration path, for example ProjectName\\2026\\0504 - 0515."),
        changedSince: z
          .string()
          .optional()
          .describe("Optional ISO date filter, for example 2026-05-04T00:00:00Z."),
        workItemTypes: z
          .array(z.enum(WORK_ITEM_TYPES))
          .optional()
          .describe("Optional filter for work item levels/types."),
        top: z.number().int().min(1).max(200).default(100),
      },
    },
    async ({ iterationPath, changedSince, workItemTypes, top }) => {
      const project = escapeWiql(ADO_PROJECT);
      const iteration = escapeWiql(iterationPath);

      const selectedTypes =
        workItemTypes && workItemTypes.length > 0
          ? workItemTypes
          : [...WORK_ITEM_TYPES];

      const typeFilter = selectedTypes
        .map((type) => `'${escapeWiql(type)}'`)
        .join(", ");

      const changedFilter = changedSince
        ? `AND [System.ChangedDate] >= '${escapeWiql(changedSince)}'`
        : "";

      const wiql = `
        SELECT
          [System.Id],
          [System.Title],
          [System.WorkItemType],
          [System.State],
          [System.AssignedTo],
          [System.IterationPath],
          [System.ChangedDate],
          [Microsoft.VSTS.Scheduling.OriginalEstimate],
          [Microsoft.VSTS.Scheduling.RemainingWork],
          [Microsoft.VSTS.Scheduling.CompletedWork],
          [Microsoft.VSTS.Scheduling.StoryPoints],
          [Microsoft.VSTS.Scheduling.Effort]
        FROM WorkItems
        WHERE [System.TeamProject] = '${project}'
          AND [System.IterationPath] = '${iteration}'
          AND [System.WorkItemType] IN (${typeFilter})
          ${changedFilter}
        ORDER BY [System.WorkItemType], [System.State], [System.AssignedTo]
      `;

      const result = await adoRequest<Record<string, unknown>>(
        `/_apis/wit/wiql?$top=${top}&api-version=${ADO_API_VERSION}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: wiql }),
        }
      );

      const refs = (result.workItems as Array<{ id: number }> | undefined) ?? [];
      const ids = refs.map((item) => item.id);

      const details = await getWorkItemDetails(ids);
      return mcpText(details);
    }
  );

  server.registerTool(
    "ado_get_work_item",
    {
      title: "Get Azure DevOps work item",
      description:
        "Gets a single Azure DevOps work item by ID. Works for Epic, Feature, Product Backlog Item, Task, and Bug.",
      inputSchema: {
        id: z.number().int().positive(),
      },
    },
    async ({ id }) => {
      const result = await adoRequest<Record<string, unknown>>(
        `/_apis/wit/workitems/${id}?$expand=all&api-version=${ADO_API_VERSION}`
      );

      return mcpText(result);
    }
  );

  server.registerTool(
    "ado_get_work_item_history",
    {
      title: "Get Azure DevOps work item history",
      description:
        "Gets Azure DevOps update/history records for a work item. Use this to inspect who changed fields such as iteration path and when.",
      inputSchema: {
        id: z.number().int().positive(),
        top: z.number().int().min(1).max(200).default(100),
      },
    },
    async ({ id, top }) => {
      const result = await adoRequest<Record<string, unknown>>(
        `/_apis/wit/workItems/${id}/updates?$top=${top}&api-version=${ADO_API_VERSION}`
      );

      return mcpText(result);
    }
  );

  server.registerTool(
    "ado_find_iteration_changes",
    {
      title: "Find Azure DevOps iteration changes",
      description:
        "Gets work item update/history records and returns the updates where System.IterationPath changed. Use this to find when an item was moved into or out of an iteration and who changed it.",
      inputSchema: {
        id: z.number().int().positive(),
        top: z.number().int().min(1).max(200).default(100),
      },
    },
    async ({ id, top }) => {
      const updates = await adoRequest<Record<string, unknown>>(
        `/_apis/wit/workItems/${id}/updates?$top=${top}&api-version=${ADO_API_VERSION}`
      );

      const values = (updates.value as Array<Record<string, unknown>> | undefined) ?? [];

      const iterationChanges = values
        .map((update) => {
          const fields = update.fields as Record<string, unknown> | undefined;
          const iterationField = fields?.["System.IterationPath"] as
            | { oldValue?: unknown; newValue?: unknown }
            | undefined;

          if (!iterationField) {
            return null;
          }

          return {
            id: update.id,
            revisedDate: update.revisedDate,
            revisedBy: update.revisedBy,
            oldIterationPath: iterationField.oldValue,
            newIterationPath: iterationField.newValue,
            url: update.url,
          };
        })
        .filter(Boolean);

      return mcpText({
        workItemId: id,
        iterationChanges,
      });
    }
  );

  server.registerTool(
    "ado_create_work_item",
    {
      title: "Create Azure DevOps work item",
      description:
        "Creates an Azure DevOps work item at any supported tracking level: Epic, Feature, Product Backlog Item, Task, or Bug.",
      inputSchema: {
        type: z.enum(WORK_ITEM_TYPES).default("Product Backlog Item"),
        title: z.string().min(1),
        description: z.string().optional(),
        assignedTo: z.string().optional(),
        tags: z.string().optional(),
        priority: z.number().int().min(1).max(4).optional(),
      },
    },
    async ({ type, title, description, assignedTo, tags, priority }) => {
      const fields: Record<string, unknown> = {
        "System.Title": title,
        "System.Description": description,
        "System.AssignedTo": assignedTo,
        "System.Tags": tags,
        "Microsoft.VSTS.Common.Priority": priority,
      };

      const result = await adoRequest<Record<string, unknown>>(
        `/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=${ADO_API_VERSION}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json-patch+json" },
          body: JSON.stringify(workItemPatch(fields)),
        }
      );

      return mcpText(result);
    }
  );

  server.registerTool(
    "ado_update_work_item",
    {
      title: "Update Azure DevOps work item",
      description:
        "Updates an existing Azure DevOps work item. Works for Epic, Feature, Product Backlog Item, Task, and Bug.",
      inputSchema: {
        id: z.number().int().positive(),
        title: z.string().optional(),
        description: z.string().optional(),
        assignedTo: z.string().optional(),
        tags: z.string().optional(),
        priority: z.number().int().min(1).max(4).optional(),
        state: z.string().optional(),
        iterationPath: z.string().optional(),
      },
    },
    async ({ id, title, description, assignedTo, tags, priority, state, iterationPath }) => {
      const fields: Record<string, unknown> = {
        "System.Title": title,
        "System.Description": description,
        "System.AssignedTo": assignedTo,
        "System.Tags": tags,
        "Microsoft.VSTS.Common.Priority": priority,
        "System.State": state,
        "System.IterationPath": iterationPath,
      };

      const result = await adoRequest<Record<string, unknown>>(
        `/_apis/wit/workitems/${id}?api-version=${ADO_API_VERSION}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json-patch+json" },
          body: JSON.stringify(workItemPatch(fields)),
        }
      );

      return mcpText(result);
    }
  );

  server.registerTool(
    "ado_add_comment",
    {
      title: "Add comment to Azure DevOps work item",
      description:
        "Adds a comment to an existing Azure DevOps work item. Works for Epic, Feature, Product Backlog Item, Task, and Bug.",
      inputSchema: {
        id: z.number().int().positive(),
        comment: z.string().min(1),
      },
    },
    async ({ id, comment }) => {
      const result = await adoRequest<Record<string, unknown>>(
        `/_apis/wit/workItems/${id}/comments?api-version=${ADO_API_VERSION}-preview.4`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: comment }),
        }
      );

      return mcpText(result);
    }
  );

  server.registerTool(
    "ado_get_completed_work_report",
    {
      title: "Get Azure DevOps completed work report",
      description:
        "Gets work items completed during a date range, regardless of their current iteration path. Use this for sprint reports based on completion date rather than current iteration assignment.",
      inputSchema: {
        startDate: z
          .string()
          .min(1)
          .describe("Start date/time for completed work, for example 2026-05-04T00:00:00Z."),
        endDate: z
          .string()
          .min(1)
          .describe("End date/time for completed work, for example 2026-05-16T00:00:00Z."),
        assignedTo: z
          .string()
          .optional()
          .describe("Optional assignee filter, for example Shelby Baker."),
        workItemTypes: z
          .array(z.enum(WORK_ITEM_TYPES))
          .optional()
          .describe("Optional filter for work item levels/types."),
        top: z.number().int().min(1).max(200).default(100),
      },
    },
    async ({ startDate, endDate, assignedTo, workItemTypes, top }) => {
      const project = escapeWiql(ADO_PROJECT);

      const selectedTypes =
        workItemTypes && workItemTypes.length > 0
          ? workItemTypes
          : [...WORK_ITEM_TYPES];

      const typeFilter = selectedTypes
        .map((type) => `'${escapeWiql(type)}'`)
        .join(", ");

      const assignedToFilter = assignedTo
        ? `AND [System.AssignedTo] CONTAINS '${escapeWiql(assignedTo)}'`
        : "";

      const wiql = `
        SELECT
          [System.Id],
          [System.Title],
          [System.WorkItemType],
          [System.State],
          [System.AssignedTo],
          [System.IterationPath],
          [System.ChangedDate],
          [Microsoft.VSTS.Common.ClosedDate],
          [Microsoft.VSTS.Scheduling.OriginalEstimate],
          [Microsoft.VSTS.Scheduling.RemainingWork],
          [Microsoft.VSTS.Scheduling.CompletedWork],
          [Microsoft.VSTS.Scheduling.StoryPoints],
          [Microsoft.VSTS.Scheduling.Effort]
        FROM WorkItems
        WHERE [System.TeamProject] = '${project}'
          AND [System.WorkItemType] IN (${typeFilter})
          AND [Microsoft.VSTS.Common.ClosedDate] >= '${escapeWiql(startDate)}'
          AND [Microsoft.VSTS.Common.ClosedDate] < '${escapeWiql(endDate)}'
          ${assignedToFilter}
        ORDER BY [Microsoft.VSTS.Common.ClosedDate] DESC
      `;

      const result = await adoRequest<Record<string, unknown>>(
        `/_apis/wit/wiql?$top=${top}&api-version=${ADO_API_VERSION}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: wiql }),
        }
      );

      const refs = (result.workItems as Array<{ id: number }> | undefined) ?? [];
      const ids = refs.map((item) => item.id);

      const details = await getWorkItemDetails(ids);
      return mcpText(details);
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "minimal-aws-quick-ado-mcp" });
});

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string) => {
          transports[newSessionId] = transport;
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid MCP session ID provided",
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP POST error", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    res.status(400).send("Invalid or missing MCP session ID");
    return;
  }

  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    res.status(400).send("Invalid or missing MCP session ID");
    return;
  }

  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`Minimal AWS Quick ADO MCP server listening on http://localhost:${PORT}/mcp`);
});
