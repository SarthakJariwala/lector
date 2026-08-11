import { describe, expect, it } from "vitest";
import { sanitizeArticleHtml } from "./article-content";

describe("sanitizeArticleHtml", () => {
  it("removes executable markup and unsafe URLs", () => {
    const clean = sanitizeArticleHtml(`
      <script>alert(1)</script>
      <svg onload="alert(1)"><script>alert(2)</script></svg>
      <img src="https://example.com/image.jpg" onerror="alert(3)" style="display:none">
      <a href="javascript:alert(4)" onclick="alert(5)">unsafe</a>
      <form action="https://example.com"><input name="secret"></form>
      <iframe src="https://evil.example/embed/abcdefghijk" srcdoc="<script>alert(6)</script>"></iframe>
    `);

    expect(clean).not.toMatch(/script|svg|onerror|onclick|javascript:|style=|form|input|iframe|srcdoc/i);
    expect(clean).toContain('src="https://example.com/image.jpg"');
  });

  it("keeps normalized YouTube embeds and ordinary article markup", () => {
    const clean = sanitizeArticleHtml(`
      <h2>Heading</h2>
      <p>Story with <a href="/relative">a link</a>.</p>
      <iframe
        src="https://www.youtube-nocookie.com/embed/abcdefghijk"
        loading="lazy"
        allowfullscreen
      ></iframe>
    `);

    expect(clean).toContain("<h2>Heading</h2>");
    expect(clean).toContain('href="/relative"');
    expect(clean).toContain('src="https://www.youtube-nocookie.com/embed/abcdefghijk"');
  });

  it("strips application UI classes while retaining reader-owned classes", () => {
    const clean = sanitizeArticleHtml(`
      <div class="modal-backdrop sidebar-scrim">Fake sign-in</div>
      <aside class="callout modal-backdrop">A real callout</aside>
    `);

    expect(clean).not.toMatch(/modal-backdrop|sidebar-scrim/);
    expect(clean).toContain('class="callout"');
  });
});
