import { describe, expect, it, vi } from "vitest";
import { guardInkboxSend, guardInstabox, sendAllowlist } from "./executors.js";
import { DEFAULT_ASSETS } from "./catalog.js";
import type { AgentContext, Asset, Executor } from "./types.js";

const ctx: AgentContext = { agent_id: "swarm-001", swarm_id: "t", attestation: "unverified", payout_address: null, machine: null, identity: null };
const asset = (id: string) => DEFAULT_ASSETS.find((a) => a.id === id)! as Asset;
const ok = (): Executor & { calls: number } => {
  const e = { calls: 0, async execute(a: Asset) { e.calls++; return { asset_id: a.id, ok: true, output: "sent", ms: 0, error: null, friction: false }; } };
  return e;
};

describe("inkbox_send allowlist", () => {
  it("parses handles, ignoring @, case and blanks", () => {
    expect([...sendAllowlist({ INKBOX_SEND_ALLOW: " @Samantha, aze ,," })]).toEqual(["samantha", "aze"]);
    expect(sendAllowlist({}).size).toBe(0);
  });

  it("no allowlist = no send, and the log names the rule, never the recipient or text", async () => {
    const inner = ok();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await guardInkboxSend(inner, {}).execute(asset("inkbox_send"), { to: "samantha", body: "secret text" }, ctx);
    expect(r).toMatchObject({ ok: false, error: "recipient not allowed" });
    expect(inner.calls).toBe(0);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("INKBOX_SEND_ALLOW");
    expect(logged).not.toContain("samantha");
    expect(logged).not.toContain("secret text");
    warn.mockRestore();
  });

  it("sends only to listed handles; other inkbox assets pass through", async () => {
    const inner = ok();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = guardInkboxSend(inner, { INKBOX_SEND_ALLOW: "samantha" });
    expect(await g.execute(asset("inkbox_send"), { to: "@Samantha", body: "hi" }, ctx)).toMatchObject({ ok: true });
    expect(await g.execute(asset("inkbox_send"), { to: "someone@example.com", body: "hi" }, ctx)).toMatchObject({ ok: false, error: "recipient not allowed" });
    expect(await g.execute(asset("inkbox_send"), { body: "hi" }, ctx)).toMatchObject({ ok: false });
    expect(await guardInkboxSend(inner, {}).execute(asset("inkbox_inbox"), {}, ctx)).toMatchObject({ ok: true });
    expect(inner.calls).toBe(2);
    warn.mockRestore();
  });
});

describe("instabox box id", () => {
  it("comes from INSTABOX_BOX_ID only; a caller-named box is refused", async () => {
    const inner = ok();
    expect(await guardInstabox(inner, {}).execute(asset("instabox_exec"), { command: "ls" }, ctx)).toMatchObject({ ok: false, error: "not configured" });
    const g = guardInstabox(inner, { INSTABOX_BOX_ID: "box-from-env" });
    for (const k of ["box_id", "boxId", "box"]) {
      expect(await g.execute(asset("instabox_exec"), { command: "ls", [k]: "other" }, ctx)).toMatchObject({ ok: false, error: "box id comes from env only" });
    }
    expect(inner.calls).toBe(0);
    expect(await g.execute(asset("instabox_exec"), { command: "ls" }, ctx)).toMatchObject({ ok: true });
  });
});
