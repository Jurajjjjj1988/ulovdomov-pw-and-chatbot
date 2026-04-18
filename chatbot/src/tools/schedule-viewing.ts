/**
 * Schedule property viewing tool (mocked backend).
 *
 * v0.2 will integrate with a real calendar mock + send confirmation email.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions.js";

export const scheduleViewingTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "schedule_viewing",
    description:
      "Schedule a property viewing for a specific listing ID at a customer-proposed time. " +
      "The customer's contact info comes from session context.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["listing_id", "preferred_datetime"],
      properties: {
        listing_id: {
          type: "string",
          description: "úlovdomov listing ID — 6-7 digit number, sometimes with letter prefix.",
        },
        preferred_datetime: {
          type: "string",
          description: "ISO 8601 timestamp the customer prefers.",
        },
        alternative_datetimes: {
          type: "array",
          items: { type: "string" },
          description: "Up to 2 fallback times if the preferred is unavailable.",
          maxItems: 2,
        },
        notes: {
          type: "string",
          description: "Optional context (pets, number of viewers, etc.)",
          maxLength: 500,
        },
      },
    },
  },
};
