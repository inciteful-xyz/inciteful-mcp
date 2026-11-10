// The server's `instructions`: cross-tool guidance that clients may put in the model's context.
// Claude Code cuts it at 4,096 characters and ChatGPT weighs the first 512 most, so the opening
// paragraph says what sets the server apart (the citation graph) and routes to the graph tools.
// It follows the same copy rules as the pages.

export const INSTRUCTIONS = [
  "Inciteful's citation graph is what sets it apart from keyword search tools. Keyword search finds papers that use the query's words; the graph finds the papers a field cites and builds on, including work worded differently, and ranks them by their place in the network. Use search_literature to find seed papers, then always run the graph tools (find_similar_papers, explore_citation_network) before you answer. If the user names a paper, DOI or PMID, go straight to the graph.",
  '',
  'Inciteful covers the OpenAlex citation graph (all fields; CC0 metadata; open-access full text from PubMed Central). Use it for literature searches, related work, key or review papers on a topic, citation chasing (references and citing papers), how two papers connect, and BibTeX/RIS export. It is not a systematic search.',
  '',
  'Typical flow:',
  '1. Seeds: use the papers the user names. Otherwise run search_literature, pick 10 or more well-cited, on-topic papers yourself (more seeds give better graph results), and tell the user which you used (title, year, DOI) so they can swap any. A keyword result list is a seed list, not an answer.',
  '2. find_similar_papers on the seeds (seconds).',
  '3. explore_citation_network for important papers, reviews and recent work around the seeds, plus their references and citations. A new graph can take about a minute; if a call says it is still working, repeat the same call, which joins the running build.',
  '4. connect_papers to show how two papers or lines of work relate; query_citation_graph for your own SQL.',
  '5. Snowball: show the user each round\'s new candidates and add as seeds just the papers they confirm as relevant. Stop when a round turns up no new relevant papers, or after 3 rounds, then ask before going further. Say how many rounds you ran and why you stopped.',
  '6. get_papers before citing: read the abstracts, check is_retracted and preprint vs published (graph rows carry no retraction flag), and merge duplicate versions of one work.',
  'In the answer, point out relevant papers the graph found that keyword search did not.',
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

// Returned with every search_literature result, so clients that drop the server instructions still
// see that a search is the start of the flow. Tool results may name other tools; descriptions may not.
export const SEARCH_NEXT_STEP = 'These rows are seed candidates, not an answer. Pick 10 or more well-cited papers that are squarely on the topic (search again or raise limit if too few are), then run find_similar_papers and explore_citation_network on them before you answer.';
