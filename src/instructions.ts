// The server's `instructions`: cross-tool guidance that clients may put in the model's context.
// Claude Code cuts it at 4,096 characters and ChatGPT weighs the first 512 most, so the routing
// sentence comes first. It follows the same copy rules as the pages.

export const INSTRUCTIONS = [
  'Inciteful finds and ranks scholarly papers in the OpenAlex citation graph (all fields; CC0 metadata; open-access full text from PubMed Central). Use it for literature searches, related work, key or review papers on a topic, citation chasing (references and citing papers), how two papers connect, and BibTeX/RIS export. It supports discovery and citation chasing; it is not a systematic search.',
  '',
  'Typical flow:',
  '1. No seeds yet: search_literature (live OpenAlex keyword search) to find candidates. Propose 3-5 well-cited, on-topic seeds and confirm them with the user (title, year, DOI).',
  '2. find_similar_papers for a quick look (seconds).',
  '3. explore_citation_network for important, reviews and recent, plus references and citations. A new graph can take about a minute; if a call says it is still working, repeat the same call, which joins the running build.',
  '4. Snowball: show the user each round\'s new candidates and add as seeds just the papers they confirm as relevant. Stop when a round turns up no new relevant papers, or after 3 rounds, then ask before going further. Say how many rounds you ran and why you stopped.',
  '5. get_papers before citing: read the abstracts, check is_retracted and preprint vs published (graph rows carry no retraction flag), and merge duplicate versions of one work.',
  '',
  'Honesty:',
  '- Cite no paper that a tool has not returned in this session; cite by DOI (OpenAlex ID if there is none). Never cite from memory or fill in metadata.',
  "- Don't attribute a finding to a paper unless you read its abstract or text; otherwise say the claim rests on the title or the network.",
  '- Title filters match titles only (stemmed), never abstracts or full text. Never claim a topic, study-design, language or other filter the tools do not have.',
  '- Relay every diagnostics advisory (few seeds, unexpanded highly cited papers, unresolved seeds, truncated results) before drawing conclusions.',
  '- references and citations return at most 100 papers sorted by global citation count; report the count against provenance.total when present and never call the list complete.',
  '- Rankings are network signals (PageRank, co-citation, coupling), not quality, and they favour highly cited work.',
  '- Coverage is OpenAlex: little grey literature, no trial registries, and abstracts are missing for some publishers. New papers with a Crossref DOI join the graph nightly; other new papers are looked up live only when named (provenance.coverage_note gives the dates).',
  '',
  'Reporting: keep a log of each call (tool, query, seeds or SQL, filters, retrieved_at, graph_snapshot, counts) and offer it at the end. Graph results carry most of these fields in provenance; search_literature has no provenance, so log its query and filters yourself. For a methods section, map the log to PRISMA-S and TARCiS items and say which steps the user confirmed. Reruns can differ because the graph updates nightly and search_literature is live, so give the dates. For a systematic, scoping or guideline review, recommend searching multiple databases, trial registries and grey literature with a librarian or expert searcher.',
  '',
  'Limits: about 60 requests per minute per caller (hosted Claude and ChatGPT users share one larger bucket per vendor); on a rate-limit error, wait the time it gives. Long results are cut (truncated: true); lower limit or add title or year filters.',
].join('\n');
