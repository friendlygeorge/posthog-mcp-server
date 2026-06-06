# PostHog MCP Server

> Connect AI assistants to [PostHog](https://posthog.com/) — query events, persons, insights, dashboards, feature flags, cohorts, and experiments through the Model Context Protocol.

Works with **Claude Desktop**, **Cursor**, **Windsurf**, **Cline**, **Continue**, and any MCP-compatible client.

## Features

| Tool | Description |
|------|-------------|
| `list_events` | Query events with filters (event name, person, date range, properties) |
| `get_person` | Get a person (user) by distinct_id — properties, creation date, event count |
| `list_persons` | Search and list persons with pagination |
| `list_dashboards` | List all dashboards — names, tags, widget counts |
| `get_dashboard` | Get a specific dashboard with its insights and widgets |
| `execute_insight` | Execute a saved insight (trend, funnel, etc.) and get results |
| `list_feature_flags` | List all feature flags — key, active status, rollout percentage |
| `evaluate_feature_flag` | Evaluate a flag for a specific user and get variant value |
| `list_cohorts` | List cohorts — name, type (dynamic/static/SQL), person count |
| `list_experiments` | List A/B tests — name, status, feature flag, dates |
| `get_experiment` | Get experiment results with variant data and statistical significance |
| `list_actions` | List custom event actions/definitions |
| `get_project_info` | Get project name, ID, settings, and data region |

## Quick Start

### 1. Get a PostHog API Key

Go to **PostHog → Settings → Personal API Keys** and create a key with read access.

Or visit: `https://your-instance.posthog.com/settings/user-api-keys`

### 2. Configure your MCP client

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "posthog": {
      "command": "npx",
      "args": ["-y", "posthog-mcp-server"],
      "env": {
        "POSTHOG_API_KEY": "phx_YOUR_API_KEY_HERE",
        "POSTHOG_HOST": "https://us.i.posthog.com",
        "POSTHOG_PROJECT": "YOUR_PROJECT_ID"
      }
    }
  }
}
```

**Cursor** — add to MCP settings (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "posthog": {
      "command": "npx",
      "args": ["-y", "posthog-mcp-server"],
      "env": {
        "POSTHOG_API_KEY": "phx_YOUR_API_KEY_HERE",
        "POSTHOG_HOST": "https://us.i.posthog.com",
        "POSTHOG_PROJECT": "YOUR_PROJECT_ID"
      }
    }
  }
}
```

### 3. Run manually (for testing)

```bash
# Clone and build
git clone https://github.com/friendlygeorge/posthog-mcp-server.git
cd posthog-mcp-server
npm install
npm run build

# Run
POSTHOG_API_KEY=phx_... POSTHOG_PROJECT=12345 node dist/index.js
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTHOG_API_KEY` | ✅ | — | Your PostHog personal API key (`phx_...`) |
| `POSTHOG_HOST` | ❌ | `https://us.i.posthog.com` | PostHog instance URL (use `https://eu.i.posthog.com` for EU) |
| `POSTHOG_PROJECT` | ❌ | `""` | Default project ID. If empty, must be specified per-call. |

### Self-hosted PostHog

If you run PostHog on your own infrastructure, set `POSTHOG_HOST` to your instance URL:

```
POSTHOG_HOST=https://posthog.yourcompany.com
```

## Example Queries

Once configured, ask your AI assistant:

- *"Show me the last 20 pageview events"*
- *"Who are the most active users this week?"*
- *"What's the status of our signup conversion experiment?"*
- *"Is the new-checkout-flow feature flag enabled for user abc123?"*
- *"Show me all active dashboards"*
- *"Execute insight 42 and show me the trend"*
- *"List all feature flags that are currently active"*
- *"How many people are in the 'Power Users' cohort?"*

## API Reference

This server wraps the PostHog REST API (v1). Full documentation:

- **PostHog API docs**: https://posthog.com/docs/api
- **MCP protocol**: https://modelcontextprotocol.io
- **PostHog**: https://posthog.com

## Development

```bash
npm install
npm run dev     # Build and run
npm run build   # Build only
npm start       # Run built output
```

## License

MIT © Nova
