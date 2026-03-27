import { describe, expect, it } from "vitest";
import { parseWebSearchResultsHtml } from "../src/lib/web-research.js";

describe("parseWebSearchResultsHtml", () => {
  it("parses DuckDuckGo-style result cards into normalized search results", () => {
    const html = `
      <html>
        <body>
          <div class="results">
            <div class="result">
              <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Falpha%3Fref%3D1">
                Alpha <b>Result</b>
              </a>
              <a class="result__snippet">
                Alpha snippet with &amp; entity.
              </a>
            </div>
            <div class="result">
              <a class="result__a" href="https://example.org/beta">
                Beta Result
              </a>
              <a class="result__snippet">
                Beta <span>snippet</span>
              </a>
            </div>
          </div>
        </body>
      </html>
    `;

    expect(parseWebSearchResultsHtml(html, 5)).toEqual([
      {
        title: "Alpha Result",
        url: "https://example.com/alpha?ref=1",
        snippet: "Alpha snippet with & entity.",
      },
      {
        title: "Beta Result",
        url: "https://example.org/beta",
        snippet: "Beta snippet",
      },
    ]);
  });

  it("applies the result limit and filters incomplete entries", () => {
    const html = `
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst">First</a>
      <a class="result__snippet">First snippet</a>
      <a class="result__a" href="">Missing url</a>
      <a class="result__snippet">Missing url snippet</a>
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fsecond">Second</a>
      <a class="result__snippet">Second snippet</a>
    `;

    expect(parseWebSearchResultsHtml(html, 1)).toEqual([
      {
        title: "First",
        url: "https://example.com/first",
        snippet: "First snippet",
      },
    ]);
  });
});
