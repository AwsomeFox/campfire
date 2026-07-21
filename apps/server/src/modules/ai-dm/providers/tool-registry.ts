/**
 * Tool-call normalization (#309). Campfire's tools are MCP tools: a `name`, a
 * `description`, and a zod/JSON-Schema `inputSchema`. This module is the single seam that
 * turns that ONE registry into the vendor-neutral `AiToolSchema[]` every adapter offers
 * to a model, and turns a model's `AiToolCall` back into an MCP tool invocation the
 * driver runtime (#312) can execute under write-mode.
 *
 * "One tool registry, two wire formats" lives here: adapters translate `AiToolSchema` to
 * OpenAI `function` and Anthropic `input_schema`; this file is what produces the
 * `AiToolSchema` in the first place and what maps the response back, so neither the
 * driver runtime nor the tool layer ever sees an OpenAI/Anthropic type.
 */

import type { AiToolCall, AiToolSchema } from './ai-provider';

/**
 * The minimal shape of an MCP tool this layer needs. `inputSchema` is a JSON Schema
 * object (Campfire already derives one per tool from its zod schema for `tools/list`).
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A normalized MCP tool invocation ready for the driver runtime to dispatch. */
export interface McpToolInvocation {
  /** The model's call id — echo it on the tool-result message so the loop stays linked. */
  callId: string;
  /** MCP tool name. */
  name: string;
  /** Parsed JSON arguments to pass as the tool's input. */
  arguments: Record<string, unknown>;
}

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

/** Map one MCP tool to the neutral `AiToolSchema`. */
export function mcpToolToAiSchema(tool: McpToolDefinition): AiToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    // Both wire formats want a JSON Schema object; guarantee at least an empty object schema.
    parameters: normalizeParameters(tool.inputSchema),
  };
}

/** Map a whole MCP tool registry to the neutral registry offered to the model. */
export function mcpToolsToAiSchemas(tools: McpToolDefinition[]): AiToolSchema[] {
  return tools.map(mcpToolToAiSchema);
}

/**
 * Normalize a model's tool call into an MCP invocation. Optionally validates the tool
 * name against the offered registry so a hallucinated tool is caught here (returns
 * `undefined`) rather than failing deep in the tool layer.
 */
export function aiToolCallToMcpInvocation(call: AiToolCall, allowed?: Set<string>): McpToolInvocation | undefined {
  if (allowed && !allowed.has(call.name)) return undefined;
  return { callId: call.id, name: call.name, arguments: call.arguments ?? {} };
}

/** Map every tool call in a turn, dropping any that name a tool outside the registry. */
export function aiToolCallsToMcpInvocations(calls: AiToolCall[], tools?: McpToolDefinition[]): McpToolInvocation[] {
  const allowed = tools ? new Set(tools.map((t) => t.name)) : undefined;
  const out: McpToolInvocation[] = [];
  for (const c of calls) {
    const inv = aiToolCallToMcpInvocation(c, allowed);
    if (inv) out.push(inv);
  }
  return out;
}

function normalizeParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { ...EMPTY_OBJECT_SCHEMA };
  // Ensure a `type: 'object'` root — some providers reject a schema without it.
  if (!('type' in schema)) return { type: 'object', ...schema };
  return schema;
}
