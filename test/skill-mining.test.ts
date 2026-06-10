import { describe, it, expect } from "vitest";
import {
  normalizeCommand,
  commandTokens,
  redact,
  extractSignature,
  clusterCandidates,
  applyConfidenceGate,
  type SessionSignature,
  type ScoredCandidate,
} from "../server/skill-mining.js";

// --- helpers to build raw log lines -----------------------------------------
const user = (text: string) => ({ type: "user", message: { content: text } });
const toolResult = () => ({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
const bash = (command: string, sidechain = false) => ({
  type: "assistant",
  isSidechain: sidechain,
  message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
});
const edit = (file_path: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Edit", input: { file_path } }] },
});

describe("normalizeCommand — Stage 1 command normalization", () => {
  it("pulls the meaningful subcommand and unwraps launchers", () => {
    expect(normalizeCommand("xcodebuild -project A.xcodeproj -scheme B archive")).toBe("xcodebuild:archive");
    expect(normalizeCommand("git commit -m 'msg'")).toBe("git:commit");
    expect(normalizeCommand("xcrun altool --upload-app -f x.ipa")).toBe("altool:upload-app");
    expect(normalizeCommand("npx convex run habits:list")).toBe("convex:run");
    expect(normalizeCommand("agvtool new-version -all 22")).toBe("agvtool:new-version");
  });

  it("falls back to the program basename for plain commands", () => {
    expect(normalizeCommand("/usr/bin/grep -r foo .")).toBe("grep");
    expect(normalizeCommand("ls -la")).toBe("ls");
  });

  it("takes only the first segment of a pipeline/chain", () => {
    expect(normalizeCommand("git push && echo done")).toBe("git:push");
  });
});

describe("commandTokens — recovers the real command behind cd/ls/&&", () => {
  it("does not lose the work behind a leading `cd … &&` (the bug)", () => {
    // Before the fix this normalized to just "cd" and was dropped as generic.
    expect(commandTokens("cd ~/Developer/chief && git log --oneline -5")).toEqual(["git"]);
  });

  it("captures every meaningful command in a chain, drops generics", () => {
    const toks = commandTokens("cd ~/app && xcodebuild -scheme B archive && xcrun altool --upload-app -f x.ipa");
    expect(toks).toContain("xcodebuild:archive");
    expect(toks).toContain("altool:upload-app");
    expect(toks).not.toContain("cd");
  });

  it("returns nothing for an all-generic chain", () => {
    expect(commandTokens("cd /tmp && ls -la | head")).toEqual([]);
  });

  it("only emits allowlisted programs — unknown programs and code fragments are ignored", () => {
    expect(commandTokens("mytool --foo && python3 build.py")).toEqual(["python3"]);
    expect(commandTokens("def foo(): && print('x')")).toEqual([]); // code fragment, not a program
  });

  it("skips heredoc bodies so commit messages / inline scripts never leak tokens", () => {
    const toks = commandTokens(
      "git commit -F - <<'EOF'\nAdd thing\nCo-Authored-By: Someone <x@y.com>\nfor i in 1 2 3\nEOF\ngit push",
    );
    expect(toks).toEqual(["git:commit", "git:push"]); // heredoc body contributes nothing
  });

  it("never tokenizes a secret-bearing command into anything but the program", () => {
    const toks = commandTokens("curl -H 'Authorization: Bearer sk-live-abc123' https://api.example.com");
    expect(toks).toEqual(["curl"]); // no Bearer/sk- token ever
  });
});

describe("redact — secrets/PII never reach the model bundle", () => {
  it("masks emails, keys, bearer tokens, and long opaque strings", () => {
    expect(redact("ping user@example.com")).toContain("<email>");
    expect(redact("export K=sk-live-abcdefghijklmnop")).toContain("<key>");
    expect(redact("curl -H 'Authorization: Bearer abcDEF123ghiJKL456'")).toContain("Bearer <token>");
    expect(redact("AuthKey_FAKEKEY0000 deadbeefdeadbeefdeadbeefdeadbeef")).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef");
  });

  it("leaves ordinary command text alone", () => {
    expect(redact("git commit -m wip && git push")).toBe("git commit -m wip && git push");
  });
});

describe("extractSignature — Stage 1 session signature", () => {
  it("captures the first real user prompt as the gist, ignoring tool_result", () => {
    const sig = extractSignature("s1", [toolResult(), user("ship a TestFlight build"), user("second")]);
    expect(sig.gist).toBe("ship a TestFlight build");
  });

  it("extracts cmd tokens, drops generic commands, and records steps", () => {
    const sig = extractSignature("s1", [
      user("build it"),
      bash("ls -la"), // generic -> dropped
      bash("xcodebuild -scheme B archive"),
      bash("xcrun altool --upload-app -f x.ipa"),
    ]);
    expect(sig.tokens).toContain("cmd:xcodebuild:archive");
    expect(sig.tokens).toContain("cmd:altool:upload-app");
    expect(sig.tokens).not.toContain("cmd:ls");
    expect(sig.steps.length).toBe(2); // the two non-generic commands
  });

  it("recovers commands behind a leading cd in a real session line", () => {
    const sig = extractSignature("s1", [
      user("ship it"),
      bash("cd ~/Developer/ChiefApp && agvtool new-version -all 23 && git commit -am wip && git push"),
    ]);
    expect(sig.tokens).toContain("cmd:agvtool:new-version");
    expect(sig.tokens).toContain("cmd:git:commit");
    expect(sig.tokens).toContain("cmd:git:push");
    expect(sig.tokens).not.toContain("cmd:cd");
  });

  it("extracts file-extension and top-dir tokens from edits", () => {
    const sig = extractSignature("s1", [user("edit"), edit("/Users/x/proj/server/foo.ts")]);
    expect(sig.tokens).toContain("file:.ts");
    expect(sig.tokens).toContain("path:server");
  });

  it("ignores sidechain (subagent) lines", () => {
    const sig = extractSignature("s1", [user("go"), bash("convex deploy", true)]);
    expect(sig.tokens).not.toContain("cmd:convex:deploy");
  });

  it("builds an ordered command sequence for n-gram mining", () => {
    const sig = extractSignature("s1", [
      user("ship"),
      bash("cd ~/app && agvtool new-version -all 23"),
      bash("xcrun altool --upload-app -f x.ipa"),
    ]);
    expect(sig.sequence).toEqual(["cmd:agvtool:new-version", "cmd:altool:upload-app"]);
  });

  it("redacts secrets in gist + steps that feed the model (the n-gram path too)", () => {
    const sig = extractSignature("s1", [
      user("deploy with sk-live-supersecretkey0000abcd"),
      bash("curl -H 'Authorization: Bearer abc123def456ghi789jkl012mno345pqr678' https://api.x.com"),
    ]);
    expect(sig.gist).not.toContain("supersecretkey");
    expect(sig.steps.join(" ")).not.toContain("abc123def456ghi789jkl012mno345pqr678");
    expect(sig.sequence).toEqual(["cmd:curl"]); // only the allowlisted program tokenizes
  });
});

// terse signature builder for Stage 2/3 tests — the array IS the ordered sequence
const sig = (sessionId: string, sequence: string[]): SessionSignature => ({
  sessionId,
  gist: `gist ${sessionId}`,
  tokens: [...new Set(sequence)],
  sequence,
  steps: [`step ${sessionId}`],
});

describe("clusterCandidates — Stage 2 = GATE 1 (recurring ordered n-grams, >= 2 sessions)", () => {
  it("does NOT propose a run seen in only one session", () => {
    const out = clusterCandidates([
      sig("a", ["cmd:xcodebuild:archive", "cmd:altool:upload-app"]),
      sig("b", ["cmd:git:commit"]),
    ]);
    expect(out).toEqual([]);
  });

  it("proposes a candidate for a run recurring across >= 2 sessions, preserving order", () => {
    const run = ["cmd:agvtool:new-version", "cmd:xcodebuild:archive", "cmd:altool:upload-app"];
    const out = clusterCandidates([sig("a", run), sig("b", run)]);
    expect(out).toHaveLength(1);
    expect(out[0].occurrences).toBe(2);
    expect(out[0].tokens).toEqual(run); // ordered run, not a bag
  });

  it("keeps the MAXIMAL run and drops a sub-run over the same sessions", () => {
    const long = [
      "cmd:agvtool:new-version", "cmd:xcodebuild:archive", "cmd:xcodebuild", "cmd:altool:upload-app",
    ];
    const out = clusterCandidates([sig("a", long), sig("b", long)]);
    expect(out).toHaveLength(1); // every sub-run shares {a,b} -> only the maximal survives
    expect(out[0].tokens).toEqual(long);
  });

  it("keeps a shorter run that recurs in MORE sessions than the long one", () => {
    const long = ["cmd:git:commit", "cmd:git:push", "cmd:xcodebuild:archive"];
    const out = clusterCandidates([
      sig("a", long),
      sig("b", long),
      sig("c", ["cmd:git:commit", "cmd:git:push"]), // commit→push also stands alone here
    ]);
    const commitPush = out.find((c) => c.tokens.join() === "cmd:git:commit,cmd:git:push");
    expect(commitPush?.occurrences).toBe(3); // appears in a session the long run doesn't
  });

  it("treats different orderings as different runs", () => {
    const out = clusterCandidates([
      sig("a", ["cmd:git:commit", "cmd:git:push"]),
      sig("b", ["cmd:git:push", "cmd:git:commit"]),
    ]);
    expect(out).toEqual([]); // neither order recurs across two sessions
  });

  it("separates two distinct workflows that don't share sessions", () => {
    const out = clusterCandidates([
      sig("a", ["cmd:xcodebuild:archive", "cmd:altool:upload-app"]),
      sig("b", ["cmd:xcodebuild:archive", "cmd:altool:upload-app"]),
      sig("c", ["cmd:convex:run", "cmd:convex:data"]),
      sig("d", ["cmd:convex:run", "cmd:convex:data"]),
    ]);
    expect(out).toHaveLength(2);
  });

  it("respects the maxCandidates cap", () => {
    const r1 = ["cmd:git:commit", "cmd:git:push"];
    const r2 = ["cmd:convex:run", "cmd:convex:data"];
    const out = clusterCandidates([sig("a", r1), sig("b", r1), sig("c", r2), sig("d", r2)], { maxCandidates: 1 });
    expect(out).toHaveLength(1);
  });
});

describe("applyConfidenceGate — Stage 3 = GATE 2 (cutoff in code)", () => {
  const mk = (patternKey: string, isReusableWorkflow: boolean, confidence: number): ScoredCandidate => ({
    patternKey,
    tokens: [],
    occurrences: 2,
    sessions: [],
    isReusableWorkflow,
    confidence,
    skillTitle: "t",
    skillEntry: "e",
    pitch: "p",
  });

  it("keeps only real workflows at or above the cutoff", () => {
    const out = applyConfidenceGate(
      [mk("hi", true, 0.9), mk("edge", true, 0.7), mk("low", true, 0.69), mk("notwf", false, 0.99)],
      0.7,
    );
    expect(out.map((c) => c.patternKey)).toEqual(["hi", "edge"]);
  });

  it("both gates required: a high-confidence non-workflow is dropped", () => {
    expect(applyConfidenceGate([mk("x", false, 0.95)], 0.7)).toEqual([]);
  });
});
