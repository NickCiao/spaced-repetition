import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import {
  htmlToMarkdown, parseAnkiTsv, parseMochi, rewriteMediaRefs, sanitizeRepresentable
} from "../src/interop";

describe("htmlToMarkdown", () => {
  it("converts common Anki HTML", () => {
    const out = htmlToMarkdown("Database transactions behave&nbsp;<b><i>as if</i></b> they ran<br><br>next");
    expect(out).toContain("**");
    expect(out).toContain("*as if*");
    expect(out).not.toContain("&nbsp;");
    expect(out).not.toContain("<b>");
  });
});

describe("sanitizeRepresentable", () => {
  it("prefixes marker lines", () => {
    expect(sanitizeRepresentable("---\nQ: hi")).toBe(" ---\n Q: hi");
  });
});

describe("parseAnkiTsv", () => {
  it("parses headerless cards export", () => {
    const text = `#separator:tab
#html:true
"What does Serializable mean?"	answer one
Q two	A two`;
    const { decks, warnings } = parseAnkiTsv(text, "Deck");
    expect(warnings).toEqual([]);
    expect(decks).toHaveLength(1);
    expect(decks[0].name).toBe("Deck");
    expect(decks[0].prompts).toHaveLength(2);
    expect(decks[0].prompts[0].question).toContain("Serializable");
    expect(decks[0].prompts[0].answer).toBe("answer one");
  });

  it("parses headered notes export with reversed notetype", () => {
    const text = `#separator:tab
#html:true
#guid column:1
#notetype column:2
#deck column:3
#tags column:6
g1	Basic (and reversed card)	System Design	Redis RDB	A Redis persistence mechanism
g2	Basic	System Design	What is X?	Answer Y`;
    const { decks } = parseAnkiTsv(text, "fallback");
    const sd = decks.find(d => d.name === "System Design")!;
    expect(sd.prompts.filter(p => p.question === "Redis RDB")).toHaveLength(1);
    expect(sd.prompts.filter(p => p.question === "A Redis persistence mechanism")).toHaveLength(1);
    expect(sd.prompts.find(p => p.question === "What is X?")?.answer).toBe("Answer Y");
  });
});

describe("parseMochi", () => {
  it("skips trashed cards with warning", () => {
    const data = {
      "~:decks": [{
        "~:name": "Deck",
        "~:cards": { "~#list": [
          { "~:name": "ok", "~:content": "Q?\n---\nA." },
          { "~:name": "trashed", "~:content": "x", "~:trashed?": { "~#dt": 1 } }
        ] }
      }]
    };
    const { decks, warnings } = parseMochi({ "data.json": strToU8(JSON.stringify(data)) });
    expect(decks[0].prompts).toHaveLength(1);
    expect(warnings.some(w => w.includes("trashed"))).toBe(true);
  });
});

describe("rewriteMediaRefs", () => {
  it("rewrites @media links", () => {
    const map = new Map([["img.png", "abcd1234"]]);
    expect(rewriteMediaRefs("![alt](@media/img.png)", map)).toBe("![alt](assets/abcd1234)");
  });
});

describe("mochi zip fixture", () => {
  it("builds minimal mochi for template resolution", () => {
    const data = {
      "~:decks": [{
        "~:name": "Test Deck",
        "~:cards": { "~#list": [{
          "~:name": "Front text",
          "~:content": "",
          "~:template-id": "~:T1",
          "~:fields": {
            "~:name": { "~:id": "~:name", "~:value": "Question?" },
            "~:back": { "~:id": "~:back", "~:value": "Answer." }
          }
        }] }
      }],
      "~:templates": { "~#list": [{
        "~:id": "~:T1",
        "~:content": "<<Front>>\n---\n<<Back>>",
        "~:fields": {
          "~:name": { "~:id": "~:name", "~:name": "Front" },
          "~:back": { "~:id": "~:back", "~:name": "Back" }
        }
      }] }
    };
    const files = { "data.json": strToU8(JSON.stringify(data)) };
    const { decks } = parseMochi(files);
    expect(decks[0].prompts[0]).toEqual({ kind: "qa", question: "Question?", answer: "Answer." });
  });
});
