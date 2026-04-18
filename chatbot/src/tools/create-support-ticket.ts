/**
 * Support ticket creation tool (mocked backend).
 *
 * Schema follows OpenAI function calling format — same shape Azure OpenAI
 * Service expects (the Azure SDK uses identical JSON schema definitions).
 *
 * On production this would POST to úlovdomov's CRM / Zendesk / Jira API.
 * For the demo we mock the call and return a synthetic ticket ID.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions.js";

export const createSupportTicketTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "create_support_ticket",
    description:
      "Open a support ticket in the úlovdomov ticketing system. Use this for complaints, " +
      "unresolved technical issues, or any flow where a human operator must follow up. " +
      "Always include the customer's verbatim message in customer_message.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["priority", "category", "summary", "customer_message"],
      properties: {
        priority: {
          type: "string",
          enum: ["low", "medium", "high", "urgent"],
          description:
            "urgent if message contains legal-action / media / regulatory keywords " +
            "(advokát, ČOI, médiá, recenzia). high for explicit complaints. " +
            "medium for unresolved questions. low for general follow-ups.",
        },
        category: {
          type: "string",
          enum: ["billing", "viewing", "account", "fraud", "technical", "other"],
          description: "Best-fit category from the predefined set.",
        },
        summary: {
          type: "string",
          description:
            "1-2 sentence neutral summary of the issue in English. " +
            "Do NOT include emotional language; this is for triage queue display.",
          minLength: 10,
          maxLength: 400,
        },
        customer_message: {
          type: "string",
          description: "Verbatim text of the customer's complaint, in their original language.",
          minLength: 1,
          maxLength: 4000,
        },
      },
    },
  },
};

export interface CreateSupportTicketArgs {
  priority: "low" | "medium" | "high" | "urgent";
  category: "billing" | "viewing" | "account" | "fraud" | "technical" | "other";
  summary: string;
  customer_message: string;
}

export interface SupportTicket {
  ticket_id: string;
  priority: CreateSupportTicketArgs["priority"];
  category: CreateSupportTicketArgs["category"];
  sla_hours: number;
  status: "open";
}

/** Mock implementation. v0.2 will POST to a real ticketing backend. */
export async function createSupportTicket(
  args: CreateSupportTicketArgs,
): Promise<SupportTicket> {
  const slaByPriority: Record<CreateSupportTicketArgs["priority"], number> = {
    urgent: 1,
    high: 4,
    medium: 24,
    low: 72,
  };

  const ticket_id = `TICK-${new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  return {
    ticket_id,
    priority: args.priority,
    category: args.category,
    sla_hours: slaByPriority[args.priority],
    status: "open",
  };
}
