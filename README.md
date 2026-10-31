# Inciteful MCP

**https://incitefulmed.com/academic/mcp**

Add this URL to your assistant as a remote MCP server. It connects Claude, ChatGPT, Cursor or any MCP client to Inciteful's citation graph: it snowballs from seed papers, finds the important and review papers around them, and traces the paths between two papers.

Free · No account · OpenAlex metadata (CC0) · Open-source server (MIT)

## Set up

The transport is Streamable HTTP. There is no API key, header or sign-in.

### Claude

1. In Claude, open **Customize → Connectors**, click **+ Add**, then **Add custom connector**.
2. Name it “Inciteful”, paste `https://incitefulmed.com/academic/mcp` as the server URL, and continue.
3. Under **Authentication**, choose **No sign in**, then click **Add**.
4. In a chat, click **+**, open **Connectors** and turn Inciteful on.
5. Ask: *“Using Inciteful, find papers similar to 10.1038/nature14539.”*

Free plans allow one custom connector. On Team and Enterprise plans, an owner adds it under **Organization settings → Connectors**, and members connect it from **Customize → Connectors**.

Steps checked on 2026-10-30 against https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

### ChatGPT

1. Open ChatGPT’s Plugins page (chatgpt.com/plugins), select the **+** button, then **Add custom MCP server**.
2. Enter the name “Inciteful” and a short description. Under **Connection**, choose a public endpoint and paste `https://incitefulmed.com/academic/mcp`.
3. For authentication, pick the option without sign-in: Inciteful needs no account. Review the warning, select **I understand and want to continue**, then **Create as a plugin**.
4. In a new chat, type **@**, pick Inciteful and ask your question.

Account and workspace policies decide whether you can add custom MCP servers. In a business workspace, an admin may need to allow it.

Steps checked on 2026-10-30 against https://developers.openai.com/plugins/deploy/connect-chatgpt

### Cursor

1. Open `~/.cursor/mcp.json` for all your projects, or `.cursor/mcp.json` in one project.
2. Add the server:

   ```json
   {
     "mcpServers": {
       "inciteful": {
         "url": "https://incitefulmed.com/academic/mcp"
       }
     }
   }
   ```

3. Save the file. Inciteful appears with your MCP servers under **Customize** in the sidebar, where you can turn it on or off.

Steps checked on 2026-10-30 against https://cursor.com/docs/mcp

### Claude Code

1. Run:

   ```sh
   claude mcp add --transport http inciteful https://incitefulmed.com/academic/mcp
   ```

2. That adds it for the current project. Add `--scope user` to use it in all your projects.
3. Start `claude` and ask, for example: *“Using Inciteful, find the important papers around 10.1038/nature14539.”*

Steps checked on 2026-10-30 against https://code.claude.com/docs/en/mcp

### VS Code

1. Open the Command Palette and run **MCP: Add Server**, then choose **HTTP (HTTP or Server-Sent Events)**.
2. Paste `https://incitefulmed.com/academic/mcp`, enter the ID `inciteful`, and choose where to save it (**Global** makes it available in every workspace).
3. Or add it to `.vscode/mcp.json` yourself:

   ```json
   {
     "servers": {
       "inciteful": {
         "type": "http",
         "url": "https://incitefulmed.com/academic/mcp"
       }
     }
   }
   ```

4. Ask your question in the Chat view.

Steps checked on 2026-10-30 against https://code.visualstudio.com/docs/agent-customization/mcp-servers

### Other clients

1. Add a remote MCP server with the URL `https://incitefulmed.com/academic/mcp`. The transport is Streamable HTTP.
2. Leave authentication empty: no API key, header or sign-in.
3. Clients configured with JSON often take `{"mcpServers": {"inciteful": {"url": "…"}}}`, but key names vary, so check your client’s docs.

Steps checked on 2026-10-30 against https://modelcontextprotocol.io/specification/2026-07-28/basic/transports

If your assistant doesn't use Inciteful, name it in your prompt, for example “Using Inciteful…”.

## Tools

Every tool reads data and changes nothing.

| Tool | What it does |
| --- | --- |
| `search_literature` | Search OpenAlex by topic. |
| `get_papers` | Fetch up to 100 paper records, with abstracts. |
| `find_similar_papers` | Rank papers by citation-pattern similarity to one seed paper or several. |
| `explore_citation_network` | Build the citation network two steps out from your seeds, then rank the important, similar, review and recent papers, plus authors, journals and institutions. |
| `connect_papers` | Show the citation paths and bridge papers between two works. |
| `query_citation_graph` | Run your own SELECT query over the network, with the same engine as the web app's SQL view. |
| `read_paper` | Read open-access full text from PubMed Central. |
| `export_citations` | Export BibTeX or RIS, for Zotero, EndNote and other reference managers. |

The `literature_review` prompt runs the iterative snowball with you: resolve your seeds, find similar papers, agree 3–5 seeds, explore the network, read the finalists' abstracts, then write with a DOI for every paper.

Every citation-graph result names the method that ranked it and carries a provenance block (graph snapshot, graph size, method, filters and the SQL that ran), so you can report your citation searching.

Title filters match paper titles only, not abstracts or full text. Very highly cited papers aren't expanded, which keeps graphs a usable size; the result says how many were skipped. Per-caller rate limits apply.

## Privacy and security

What we keep and who receives data: https://incitefulmed.com/academic/mcp/privacy · Terms: https://incitefulmed.com/academic/mcp/terms

The server is public, takes no credentials and sends `Access-Control-Allow-Origin: *`, so any web page may call it. Browser requests from any `https:` origin are accepted, as are `http://localhost`, `http://127.0.0.1` and `http://[::1]` on any port (MCP Inspector and other local tools). Any other `Origin`, including `null`, gets HTTP 403. Requests without an `Origin` header, as most MCP clients send them, are unaffected.

## This repository

This is the server behind the URL above. It calls Inciteful's hosted citation graph service, which isn't part of this repository.

```sh
npm ci
npm run check
npm test
npm run build
```

Tests use mocked upstream responses and don't call live services. The `Dockerfile` builds the production image.

## Licence

The server is MIT licensed (see `LICENSE`). Paper metadata comes from OpenAlex under CC0; full text from PubMed Central carries each article's own licence. The DM Sans font in `assets/` is under the SIL Open Font License (`assets/DM-Sans-OFL.txt`).
