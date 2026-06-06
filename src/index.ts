#!/usr/bin/env node
/**
 * PostHog MCP Server
 *
 * Connect AI assistants to PostHog's product analytics API.
 * Query events, persons, insights, dashboards, feature flags,
 * cohorts, and experiments through the Model Context Protocol.
 *
 * Works with Claude Desktop, Cursor, Windsurf, Cline, and any MCP client.
 *
 * Environment variables:
 *   POSTHOG_API_KEY  — PostHog personal API key (required)
 *   POSTHOG_HOST     — PostHog instance URL (default: https://us.i.posthog.com)
 *   POSTHOG_PROJECT  — PostHog project ID (optional, used as default)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Configuration ──
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "";
const DEFAULT_PROJECT_ID = process.env.POSTHOG_PROJECT || "";

if (!POSTHOG_API_KEY) {
  console.error(
    "Error: POSTHOG_API_KEY environment variable is required.\n" +
      "Get one at https://app.posthog.com/settings/user-api-keys"
  );
  process.exit(1);
}

// ── Rate limiter ──
let lastCall = 0;
const MIN_INTERVAL = 110; // ~9 calls/sec, safe for PostHog rate limits

async function rateLimitedFetch(
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const now = Date.now();
  const wait = MIN_INTERVAL - (now - lastCall);
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastCall = Date.now();

  const url = new URL(path, POSTHOG_HOST);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${POSTHOG_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(options.headers as Record<string, string> || {}),
  };

  const res = await fetch(url.toString(), {
    ...options,
    headers,
  });

  if (res.status === 429) {
    // Rate limited — wait and retry once
    await new Promise((r) => setTimeout(r, 5000));
    const retry = await fetch(url.toString(), { ...options, headers });
    if (!retry.ok) {
      throw new Error(
        `PostHog API error: ${retry.status} ${retry.statusText}`
      );
    }
    return retry.json();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `PostHog API error: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`
    );
  }

  // Handle 204 No Content (common for write operations)
  if (res.status === 204) return null;

  return res.json();
}

// Helper: build query string from params
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== ""
  );
  if (entries.length === 0) return "";
  return (
    "?" +
    entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&")
  );
}

// ── Create server ──
const server = new McpServer({
  name: "posthog",
  version: "1.0.0",
});

// ══════════════════════════════════════════════════════════
//  Tool: list_events
//  Query events from PostHog with filters
// ══════════════════════════════════════════════════════════
server.tool(
  "list_events",
  "Query events from PostHog. Filter by event name, person, date range, and properties. Returns recent events matching your criteria.",
  {
    event: z.string().optional().describe("Event name to filter by (e.g. '$pageview', 'sign_up')"),
    distinct_id: z.string().optional().describe("Person's distinct_id to filter by"),
    after: z.string().optional().describe("ISO 8601 datetime — only events after this time (e.g. '2026-01-01T00:00:00Z')"),
    before: z.string().optional().describe("ISO 8601 datetime — only events before this time"),
    limit: z.number().optional().describe("Max events to return (default 100, max 1000)"),
    properties: z.string().optional().describe('JSON string of property filters, e.g. {"$browser": "Chrome"}'),
  },
  async ({ event, distinct_id, after, before, limit, properties }) => {
    try {
      const params: Record<string, string | number> = {
        limit: Math.min(limit || 100, 1000),
      };
      if (event) params.event = event;
      if (distinct_id) params.distinct_id = distinct_id;
      if (after) params.after = after;
      if (before) params.before = before;
      if (properties) {
        try {
          // PostHog API accepts property filters as JSON-encoded string
          params.properties = properties;
        } catch {
          // ignore parse errors, pass as-is
        }
      }

      const data = await rateLimitedFetch(`/api/projects/${DEFAULT_PROJECT_ID}/events/${qs(params)}`);

      if (!data || !data.results) {
        return {
          content: [{ type: "text", text: "No events found matching your criteria." }],
        };
      }

      const events = data.results.map((e: any) => {
        const props = e.properties
          ? Object.entries(e.properties)
              .slice(0, 10)
              .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
              .join("\n")
          : "  (no properties)";
        return [
          `**${e.event}** @ ${e.timestamp}`,
          `  distinct_id: ${e.distinct_id}`,
          props,
          "",
        ].join("\n");
      });

      const text = `**${data.results.length} events** (of ${data.count || "unknown"} total)\n\n${events.join("\n")}`;
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: get_person
//  Get a person (user) by distinct_id or person ID
// ══════════════════════════════════════════════════════════
server.tool(
  "get_person",
  "Get a PostHog person (user) by their distinct_id. Returns person properties, creation date, and event count.",
  {
    distinct_id: z.string().describe("The person's distinct_id to look up"),
  },
  async ({ distinct_id }) => {
    try {
      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/persons/?distinct_id=${encodeURIComponent(distinct_id)}`
      );

      if (!data || !data.results || data.results.length === 0) {
        return {
          content: [{ type: "text", text: `No person found with distinct_id: ${distinct_id}` }],
        };
      }

      const person = data.results[0];
      const props = person.properties
        ? Object.entries(person.properties)
            .map(([k, v]) => `- **${k}**: ${JSON.stringify(v)}`)
            .join("\n")
        : "(no properties)";

      const text = [
        `**Person: ${person.name || person.distinct_ids?.[0] || "unknown"}**`,
        `- ID: ${person.id}`,
        `- Distinct IDs: ${person.distinct_ids?.join(", ") || "N/A"}`,
        `- Created: ${person.created_at}`,
        `- Last seen: ${person.last_seen_at || "N/A"}`,
        `- Event count: ${person.event_count || "N/A"}`,
        "",
        "**Properties:**",
        props,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: list_persons
//  List persons with search/pagination
// ══════════════════════════════════════════════════════════
server.tool(
  "list_persons",
  "List PostHog persons (users). Search by name or distinct_id, with pagination.",
  {
    search: z.string().optional().describe("Search query to filter persons by name or distinct_id"),
    limit: z.number().optional().describe("Max persons to return (default 100)"),
    offset: z.number().optional().describe("Offset for pagination (default 0)"),
  },
  async ({ search, limit, offset }) => {
    try {
      const params: Record<string, string | number> = {};
      if (search) params.search = search;
      if (limit) params.limit = Math.min(limit, 500);
      if (offset) params.offset = offset;

      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/persons/${qs(params)}`
      );

      if (!data || !data.results || data.results.length === 0) {
        return {
          content: [{ type: "text", text: "No persons found." }],
        };
      }

      const persons = data.results.map((p: any) => {
        return [
          `**${p.name || "unnamed"}** (ID: ${p.id})`,
          `  distinct_id: ${p.distinct_ids?.[0] || "N/A"}`,
          `  events: ${p.event_count || "?"} | created: ${p.created_at?.slice(0, 10) || "?"}`,
        ].join("\n");
      });

      const text = [
        `**${data.results.length} persons** (showing ${data.offset || 0}–${(data.offset || 0) + data.results.length} of ${data.count || "?"})`,
        "",
        ...persons,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: list_dashboards
//  List all dashboards in the project
// ══════════════════════════════════════════════════════════
server.tool(
  "list_dashboards",
  "List all PostHog dashboards in the project. Returns dashboard names, IDs, and widget counts.",
  {
    limit: z.number().optional().describe("Max dashboards to return (default 50)"),
  },
  async ({ limit }) => {
    try {
      const params = limit ? `?limit=${Math.min(limit, 200)}` : "";
      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/dashboards/${params}`
      );

      if (!data || !data.results || data.results.length === 0) {
        return {
          content: [{ type: "text", text: "No dashboards found." }],
        };
      }

      const dashboards = data.results.map((d: any) => {
        return [
          `**${d.name || "Untitled"}** (ID: ${d.id})`,
          `  Tags: ${d.tags?.join(", ") || "none"}`,
          `  Created: ${d.created_at?.slice(0, 10) || "?"} | Updated: ${d.updated_at?.slice(0, 10) || "?"}`,
        ].join("\n");
      });

      const text = [
        `**${data.results.length} dashboards** (of ${data.count || "?"} total)`,
        "",
        ...dashboards,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: get_dashboard
//  Get a dashboard with its insights/widgets
// ══════════════════════════════════════════════════════════
server.tool(
  "get_dashboard",
  "Get a specific PostHog dashboard by ID, including its insights and widgets.",
  {
    dashboard_id: z.number().describe("The dashboard ID to retrieve"),
  },
  async ({ dashboard_id }) => {
    try {
      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/dashboards/${dashboard_id}/`
      );

      if (!data) {
        return {
          content: [{ type: "text", text: `Dashboard ${dashboard_id} not found.` }],
        };
      }

      const widgets = data.tiles?.map((t: any) => {
        return [
          `  - **${t.name || t.query?.kind || "Widget"}** (ID: ${t.id})`,
          `    Type: ${t.type || t.query?.kind || "unknown"}`,
        ].join("\n");
      }) || ["  (no widgets)"];

      const text = [
        `**Dashboard: ${data.name || "Untitled"}**`,
        `- ID: ${data.id}`,
        `- Description: ${data.description || "(none)"}`,
        `- Tags: ${data.tags?.join(", ") || "none"}`,
        `- Created: ${data.created_at?.slice(0, 10) || "?"}`,
        `- Updated: ${data.updated_at?.slice(0, 10) || "?"}`,
        "",
        "**Insights/Widgets:**",
        ...widgets,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: execute_insight
//  Execute a saved insight by ID and return results
// ══════════════════════════════════════════════════════════
server.tool(
  "execute_insight",
  "Execute a saved PostHog insight by ID and return the results. Use list_dashboards to find insight IDs, or pass a raw insight definition.",
  {
    insight_id: z.number().describe("The saved insight ID to execute"),
    refresh: z.boolean().optional().describe("Force a fresh computation (default false, uses cache)"),
  },
  async ({ insight_id, refresh }) => {
    try {
      const params = refresh ? "?refresh=true" : "";
      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/insights/${insight_id}/${params}`
      );

      if (!data) {
        return {
          content: [{ type: "text", text: `Insight ${insight_id} not found.` }],
        };
      }

      // Format results based on insight type
      let resultText = "";
      const result = data.result;

      if (result && Array.isArray(result)) {
        // Trend / time-series result
        resultText = result
          .map((series: any) => {
            const values = series.data?.slice(-5) || [];
            const latest = values[values.length - 1] || 0;
            return `- **${series.label || "Series"}**: latest=${latest}, last 5 points=[${values.join(", ")}]`;
          })
          .join("\n");
      } else if (result?.results) {
        // Funnel result
        resultText = result.results
          .map((step: any, i: number) => {
            return `- Step ${i + 1}: **${step.name || step.action?.event || "?"}** — ${step.count || 0} (${step.average_conversion_time ? `avg ${Math.round(step.average_conversion_time)}s` : ""})`;
          })
          .join("\n");
      } else {
        resultText = JSON.stringify(result || data, null, 2).slice(0, 3000);
      }

      const text = [
        `**Insight: ${data.name || "Untitled"}**`,
        `- Type: ${data.query?.kind || data.derived_trend?.trend_type || data.type || "unknown"}`,
        `- ID: ${data.id}`,
        "",
        "**Results:**",
        resultText || "(no results returned)",
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: list_feature_flags
//  List all feature flags in the project
// ══════════════════════════════════════════════════════════
server.tool(
  "list_feature_flags",
  "List all PostHog feature flags in the project. Shows name, key, active status, and rollout percentage.",
  {
    active: z.boolean().optional().describe("Filter by active status (true = active only, false = inactive only)"),
    limit: z.number().optional().describe("Max flags to return (default 100)"),
  },
  async ({ active, limit }) => {
    try {
      const params: Record<string, string | number | boolean> = {};
      if (active !== undefined) params.active = active;
      if (limit) params.limit = Math.min(limit, 500);

      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/feature_flags/${qs(params)}`
      );

      if (!data || !data.results || data.results.length === 0) {
        return {
          content: [{ type: "text", text: "No feature flags found." }],
        };
      }

      const flags = data.results.map((f: any) => {
        const rollout =
          f.rollout_percentage !== undefined
            ? `${f.rollout_percentage}%`
            : f.aggregation_group_type_index !== undefined
              ? `group ${f.aggregation_group_type_index}`
              : "all users";
        const status = f.active ? "🟢 active" : "🔴 inactive";
        return [
          `**${f.key}** — ${f.name || "(unnamed)"}`,
          `  Status: ${status} | Rollout: ${rollout}`,
          `  Created: ${f.created_at?.slice(0, 10) || "?"}`,
        ].join("\n");
      });

      const text = [
        `**${data.results.length} feature flags** (of ${data.count || "?"} total)`,
        "",
        ...flags,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: evaluate_feature_flag
//  Evaluate a feature flag for a specific user/context
// ══════════════════════════════════════════════════════════
server.tool(
  "evaluate_feature_flag",
  "Evaluate a feature flag for a specific user. Returns whether the flag is enabled and its variant value.",
  {
    flag_key: z.string().describe("The feature flag key to evaluate"),
    distinct_id: z.string().describe("The user's distinct_id to evaluate the flag for"),
  },
  async ({ flag_key, distinct_id }) => {
    try {
      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/feature_flags/evaluation/?key=${encodeURIComponent(flag_key)}&distinct_id=${encodeURIComponent(distinct_id)}`
      );

      if (data === null || data === undefined) {
        // Try the local evaluation endpoint
        const localData = await rateLimitedFetch(
          `/api/projects/${DEFAULT_PROJECT_ID}/feature_flags/${encodeURIComponent(flag_key)}/get_v2/?distinct_id=${encodeURIComponent(distinct_id)}`
        );

        const text = [
          `**Feature Flag: ${flag_key}**`,
          `- For user: ${distinct_id}`,
          `- Enabled: ${localData?.enabled ?? localData?.active ?? "unknown"}`,
          `- Value: ${JSON.stringify(localData?.value || localData?.variant || "N/A")}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      }

      const text = [
        `**Feature Flag: ${flag_key}**`,
        `- For user: ${distinct_id}`,
        `- Enabled: ${data.enabled ?? "unknown"}`,
        `- Value: ${JSON.stringify(data.value || data.variant || "N/A")}`,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: list_cohorts
//  List all cohorts in the project
// ══════════════════════════════════════════════════════════
server.tool(
  "list_cohorts",
  "List all PostHog cohorts in the project. Shows name, type, person count, and creation date.",
  {
    search: z.string().optional().describe("Search query to filter cohorts by name"),
    limit: z.number().optional().describe("Max cohorts to return (default 100)"),
  },
  async ({ search, limit }) => {
    try {
      const params: Record<string, string | number> = {};
      if (search) params.search = search;
      if (limit) params.limit = Math.min(limit, 500);

      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/cohorts/${qs(params)}`
      );

      if (!data || !data.results || data.results.length === 0) {
        return {
          content: [{ type: "text", text: "No cohorts found." }],
        };
      }

      const cohorts = data.results.map((c: any) => {
        const typeMap: Record<number, string> = {
          1: "dynamic",
          2: "static",
          3: "sql",
        };
        return [
          `**${c.name || "Untitled"}** (ID: ${c.id})`,
          `  Type: ${typeMap[c.type] || `type ${c.type}`}`,
          `  People count: ${c.count || "?"}`,
          `  Created: ${c.created_at?.slice(0, 10) || "?"}`,
        ].join("\n");
      });

      const text = [
        `**${data.results.length} cohorts** (of ${data.count || "?"} total)`,
        "",
        ...cohorts,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: list_experiments
//  List all experiments (A/B tests) in the project
// ══════════════════════════════════════════════════════════
server.tool(
  "list_experiments",
  "List all PostHog experiments (A/B tests) in the project. Shows name, status, and key results.",
  {
    limit: z.number().optional().describe("Max experiments to return (default 50)"),
  },
  async ({ limit }) => {
    try {
      const params = limit ? `?limit=${Math.min(limit, 200)}` : "";
      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/experiments/${params}`
      );

      if (!data || !data.results || data.results.length === 0) {
        return {
          content: [{ type: "text", text: "No experiments found." }],
        };
      }

      const experiments = data.results.map((e: any) => {
        const statusMap: Record<string, string> = {
          draft: "📝 draft",
          running: "🟢 running",
          completed: "✅ completed",
          archived: "📦 archived",
        };
        return [
          `**${e.name || "Untitled"}** (ID: ${e.id})`,
          `  Status: ${statusMap[e.status] || e.status}`,
          `  Feature flag: ${e.feature_flag_key || "N/A"}`,
          `  Start: ${e.start_date?.slice(0, 10) || "?"} | End: ${e.end_date?.slice(0, 10) || "ongoing"}`,
        ].join("\n");
      });

      const text = [
        `**${data.results.length} experiments** (of ${data.count || "?"} total)`,
        "",
        ...experiments,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: get_experiment
//  Get detailed experiment results
// ══════════════════════════════════════════════════════════
server.tool(
  "get_experiment",
  "Get detailed results for a specific PostHog experiment, including variants, metrics, and statistical significance.",
  {
    experiment_id: z.number().describe("The experiment ID to retrieve"),
  },
  async ({ experiment_id }) => {
    try {
      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/experiments/${experiment_id}/`
      );

      if (!data) {
        return {
          content: [{ type: "text", text: `Experiment ${experiment_id} not found.` }],
        };
      }

      const variants = data.variants?.map((v: any) => {
        const prob = v.probability_being_best
          ? `${(v.probability_being_best * 100).toFixed(1)}%`
          : "?";
        return [
          `  **${v.key}** — ${v.name || v.key}`,
          `    Users: ${v.sample_size || "?"} | Conversion: ${v.conversion_rate ? `${(v.conversion_rate * 100).toFixed(2)}%` : "?"} | P(best): ${prob}`,
        ].join("\n");
      }) || ["  (no variant data)"];

      const text = [
        `**Experiment: ${data.name || "Untitled"}**`,
        `- ID: ${data.id}`,
        `- Status: ${data.status || "unknown"}`,
        `- Feature flag: ${data.feature_flag_key || "N/A"}`,
        `- Start: ${data.start_date?.slice(0, 10) || "?"} | End: ${data.end_date?.slice(0, 10) || "ongoing"}`,
        `- Significance level: ${data.significance_level || "?"}`,
        "",
        "**Variants:**",
        ...variants,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: list_project_actions
//  List event actions/definitions
// ══════════════════════════════════════════════════════════
server.tool(
  "list_actions",
  "List PostHog event actions (custom event definitions). Shows name, steps, and creation date.",
  {
    limit: z.number().optional().describe("Max actions to return (default 50)"),
  },
  async ({ limit }) => {
    try {
      const params = limit ? `?limit=${Math.min(limit, 200)}` : "";
      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/actions/${params}`
      );

      if (!data || !data.results || data.results.length === 0) {
        return {
          content: [{ type: "text", text: "No actions found." }],
        };
      }

      const actions = data.results.map((a: any) => {
        return [
          `**${a.name}** (ID: ${a.id})`,
          `  Steps: ${a.steps?.length || 0} | Type: ${a.type || "?"}`,
          `  Created: ${a.created_at?.slice(0, 10) || "?"}`,
        ].join("\n");
      });

      const text = [
        `**${data.results.length} actions**`,
        "",
        ...actions,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ══════════════════════════════════════════════════════════
//  Tool: get_project_info
//  Get basic project information
// ══════════════════════════════════════════════════════════
server.tool(
  "get_project_info",
  "Get basic information about the PostHog project — name, ID, created date, and available features.",
  {},
  async () => {
    try {
      const data = await rateLimitedFetch(
        `/api/projects/${DEFAULT_PROJECT_ID}/`
      );

      if (!data) {
        return {
          content: [{ type: "text", text: "Could not retrieve project info." }],
        };
      }

      const text = [
        `**Project: ${data.name || "Untitled"}**`,
        `- ID: ${data.id}`,
        `- Created: ${data.created_at?.slice(0, 10) || "?"}`,
        `- Organization: ${data.organization?.name || "N/A"}`,
        `- Week starts on: ${data.week_starting_on || "Monday"}`,
        `- Session recording: ${data.session_recording_opt_in ? "enabled" : "disabled"}`,
        `- Data region: ${data.data_region || "unknown"}`,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ── Start server ──
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("PostHog MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
