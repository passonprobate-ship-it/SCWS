import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { braveGet } from "../brave-client.js";

function formatWebResults(data: any): string {
  if (!data) return "No results found.";

  const parts: string[] = [];

  // Query info
  if (data.query) {
    parts.push(`Query: ${data.query.original || ""}`);
  }

  // Web results
  if (data.web?.results?.length) {
    parts.push("\n## Web Results\n");
    for (const r of data.web.results) {
      parts.push(`### ${r.title}`);
      parts.push(`URL: ${r.url}`);
      if (r.description) parts.push(r.description);
      if (r.age) parts.push(`Age: ${r.age}`);
      parts.push("");
    }
  }

  // Knowledge graph / infobox
  if (data.infobox) {
    parts.push("\n## Infobox\n");
    parts.push(`**${data.infobox.title || ""}**`);
    if (data.infobox.description) parts.push(data.infobox.description);
    if (data.infobox.long_desc) parts.push(data.infobox.long_desc);
    parts.push("");
  }

  // FAQ
  if (data.faq?.results?.length) {
    parts.push("\n## FAQ\n");
    for (const faq of data.faq.results) {
      parts.push(`**Q: ${faq.question}**`);
      parts.push(`A: ${faq.answer}`);
      parts.push("");
    }
  }

  // Discussions
  if (data.discussions?.results?.length) {
    parts.push("\n## Discussions\n");
    for (const d of data.discussions.results) {
      parts.push(`- [${d.title}](${d.url})`);
    }
    parts.push("");
  }

  return parts.join("\n") || "No results found.";
}

function formatNewsResults(data: any): string {
  if (!data?.results?.length) return "No news results found.";

  const parts: string[] = ["## News Results\n"];
  for (const r of data.results) {
    parts.push(`### ${r.title}`);
    parts.push(`URL: ${r.url}`);
    if (r.description) parts.push(r.description);
    if (r.age) parts.push(`Published: ${r.age}`);
    if (r.meta_url?.hostname) parts.push(`Source: ${r.meta_url.hostname}`);
    parts.push("");
  }
  return parts.join("\n");
}

function formatVideoResults(data: any): string {
  if (!data?.results?.length) return "No video results found.";

  const parts: string[] = ["## Video Results\n"];
  for (const r of data.results) {
    parts.push(`### ${r.title}`);
    parts.push(`URL: ${r.url}`);
    if (r.description) parts.push(r.description);
    if (r.age) parts.push(`Published: ${r.age}`);
    if (r.meta_url?.hostname) parts.push(`Source: ${r.meta_url.hostname}`);
    parts.push("");
  }
  return parts.join("\n");
}

function formatImageResults(data: any): string {
  if (!data?.results?.length) return "No image results found.";

  const parts: string[] = ["## Image Results\n"];
  for (const r of data.results) {
    parts.push(`### ${r.title || "Untitled"}`);
    parts.push(`URL: ${r.url}`);
    if (r.source) parts.push(`Source: ${r.source}`);
    if (r.properties?.width && r.properties?.height) {
      parts.push(`Size: ${r.properties.width}x${r.properties.height}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

export function registerSearchTools(server: McpServer): void {
  // Web Search
  server.tool(
    "brave_web_search",
    "Search the web using Brave Search. Returns web results, knowledge panels, FAQs, and discussions.",
    {
      query: z.string().max(400).describe("Search query (max 400 chars, 50 words)"),
      count: z.number().min(1).max(20).optional().describe("Number of results (default 10, max 20)"),
      offset: z.number().min(0).max(9).optional().describe("Pagination offset (max 9)"),
      country: z.string().length(2).optional().describe("Country code (e.g., US, GB, DE)"),
      search_lang: z.string().optional().describe("Search language (e.g., en, fr, de)"),
      freshness: z.enum(["pd", "pw", "pm", "py"]).optional().describe("Freshness: pd=past day, pw=past week, pm=past month, py=past year"),
      safesearch: z.enum(["off", "moderate", "strict"]).optional().describe("Safe search level (default: moderate)"),
      result_filter: z.string().optional().describe("Comma-separated result types: discussions, faq, infobox, news, query, summarizer, videos, web, locations"),
    },
    async (params) => {
      const res = await braveGet("/web/search", {
        q: params.query,
        count: params.count,
        offset: params.offset,
        country: params.country,
        search_lang: params.search_lang,
        freshness: params.freshness,
        safesearch: params.safesearch,
        result_filter: params.result_filter,
      });

      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Brave API error ${res.status}: ${JSON.stringify(res.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: formatWebResults(res.data) }],
      };
    }
  );

  // Local Search
  server.tool(
    "brave_local_search",
    "Search for local businesses, places, and services. Returns names, addresses, phone numbers, ratings, and hours.",
    {
      query: z.string().max(400).describe("Local search query (e.g., 'pizza near downtown Austin')"),
      count: z.number().min(1).max(20).optional().describe("Number of results (default 5)"),
      country: z.string().length(2).optional().describe("Country code"),
      search_lang: z.string().optional().describe("Search language"),
    },
    async (params) => {
      const res = await braveGet("/web/search", {
        q: params.query,
        count: params.count || 5,
        country: params.country,
        search_lang: params.search_lang,
        result_filter: "locations",
        extra_snippets: true,
      });

      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Brave API error ${res.status}: ${JSON.stringify(res.data)}` }],
          isError: true,
        };
      }

      const locations = res.data?.locations?.results || [];
      if (!locations.length) {
        // Fall back to web results with location context
        return {
          content: [{ type: "text", text: formatWebResults(res.data) }],
        };
      }

      const parts: string[] = ["## Local Results\n"];
      for (const loc of locations) {
        parts.push(`### ${loc.title || loc.name || "Unknown"}`);
        if (loc.address) {
          const addr = loc.address;
          const addrParts = [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean);
          parts.push(`Address: ${addrParts.join(", ")}`);
        }
        if (loc.phone) parts.push(`Phone: ${loc.phone}`);
        if (loc.rating) parts.push(`Rating: ${loc.rating.ratingValue}/${loc.rating.bestRating} (${loc.rating.ratingCount || "?"} reviews)`);
        if (loc.openingHours) parts.push(`Hours: ${loc.openingHours}`);
        if (loc.priceRange) parts.push(`Price: ${loc.priceRange}`);
        parts.push("");
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
      };
    }
  );

  // News Search
  server.tool(
    "brave_news_search",
    "Search for recent news articles. Returns headlines, descriptions, sources, and publication dates.",
    {
      query: z.string().max(400).describe("News search query"),
      count: z.number().min(1).max(50).optional().describe("Number of results (default 10, max 50)"),
      offset: z.number().min(0).optional().describe("Pagination offset"),
      freshness: z.enum(["pd", "pw", "pm", "py"]).optional().describe("Freshness filter (default: past 24h for news)"),
      country: z.string().length(2).optional().describe("Country code"),
      search_lang: z.string().optional().describe("Search language"),
    },
    async (params) => {
      const res = await braveGet("/news/search", {
        q: params.query,
        count: params.count || 10,
        offset: params.offset,
        freshness: params.freshness || "pd",
        country: params.country,
        search_lang: params.search_lang,
      });

      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Brave API error ${res.status}: ${JSON.stringify(res.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: formatNewsResults(res.data) }],
      };
    }
  );

  // Video Search
  server.tool(
    "brave_video_search",
    "Search for videos. Returns titles, URLs, descriptions, and sources.",
    {
      query: z.string().max(400).describe("Video search query"),
      count: z.number().min(1).max(50).optional().describe("Number of results (default 10, max 50)"),
      offset: z.number().min(0).optional().describe("Pagination offset"),
      freshness: z.enum(["pd", "pw", "pm", "py"]).optional().describe("Freshness filter"),
      country: z.string().length(2).optional().describe("Country code"),
      search_lang: z.string().optional().describe("Search language"),
    },
    async (params) => {
      const res = await braveGet("/videos/search", {
        q: params.query,
        count: params.count || 10,
        offset: params.offset,
        freshness: params.freshness,
        country: params.country,
        search_lang: params.search_lang,
      });

      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Brave API error ${res.status}: ${JSON.stringify(res.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: formatVideoResults(res.data) }],
      };
    }
  );

  // Image Search
  server.tool(
    "brave_image_search",
    "Search for images. Returns image URLs, titles, sources, and dimensions.",
    {
      query: z.string().max(400).describe("Image search query"),
      count: z.number().min(1).max(200).optional().describe("Number of results (default 10, max 200)"),
      safesearch: z.enum(["off", "moderate", "strict"]).optional().describe("Safe search (default: strict)"),
      country: z.string().length(2).optional().describe("Country code"),
      search_lang: z.string().optional().describe("Search language"),
    },
    async (params) => {
      const res = await braveGet("/images/search", {
        q: params.query,
        count: params.count || 10,
        safesearch: params.safesearch || "strict",
        country: params.country,
        search_lang: params.search_lang,
      });

      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Brave API error ${res.status}: ${JSON.stringify(res.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: formatImageResults(res.data) }],
      };
    }
  );

  // Summarizer
  server.tool(
    "brave_summarizer",
    "Get an AI-generated summary from a previous web search. First run brave_web_search with result_filter including 'summarizer', then use the summary key from the response.",
    {
      key: z.string().describe("Summary key from a previous brave_web_search response (found in data.summarizer.key)"),
      entity_info: z.boolean().optional().describe("Include entity info in summary"),
    },
    async (params) => {
      const res = await braveGet("/summarizer/search", {
        key: params.key,
        entity_info: params.entity_info ? 1 : undefined,
      });

      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Brave API error ${res.status}: ${JSON.stringify(res.data)}` }],
          isError: true,
        };
      }

      const summary = res.data;
      const parts: string[] = [];
      if (summary?.title) parts.push(`## ${summary.title}\n`);
      if (summary?.summary?.length) {
        for (const s of summary.summary) {
          parts.push(s.text || s.data || "");
        }
      } else if (summary?.message) {
        parts.push(summary.message);
      } else {
        parts.push(JSON.stringify(summary, null, 2));
      }

      return {
        content: [{ type: "text", text: parts.join("\n") || "No summary available." }],
      };
    }
  );
}
