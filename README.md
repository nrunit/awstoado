# Minimal AWS Quick Suite → Azure DevOps MCP Server

This is the smallest useful MCP server for your ask:

```text
AWS Quick Suite
  → hosted MCP server
    → Azure DevOps
```

The Mule team only needs to host this server. They do not need Mule-specific business logic.

## Tools included

- `ado_search_work_items`
- `ado_create_work_item`
- `ado_add_comment`

## Required environment variables

```bash
PORT=3000
ADO_ORG=your-ado-org
ADO_PROJECT=your-ado-project
ADO_PAT=your-ado-personal-access-token
ADO_API_VERSION=7.1
```

## Local setup

```bash
npm install
cp .env.example .env
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

Expected:

```json
{ "ok": true, "service": "minimal-aws-quick-ado-mcp" }
```

## MCP endpoint

```text
http://localhost:3000/mcp
```

Do not open `/mcp` directly in a browser. It is a protocol endpoint, not a webpage.

Use MCP Inspector for local testing:

```bash
npx @modelcontextprotocol/inspector
```

Connect to:

```text
http://localhost:3000/mcp
```

## Example WIQL test

Use tool `ado_search_work_items`:

```json
{
  "wiql": "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC",
  "top": 5
}
```

## Build

```bash
npm run build
npm start
```

## Hosting ask for Mule team

Host this Node.js service behind HTTPS and provide these environment variables securely:

```bash
PORT=3000
ADO_ORG=<ado-org>
ADO_PROJECT=<ado-project>
ADO_PAT=<secure-secret>
ADO_API_VERSION=7.1
```

AWS Quick Suite should be configured with:

```text
https://hosted-server.example.com/mcp
```

## Security note

This MVP has no built-in authentication. That is acceptable only for local testing or a tightly controlled internal proof of concept.

For production, put it behind your organization’s approved gateway/authentication pattern and store the ADO PAT in a secret manager.
