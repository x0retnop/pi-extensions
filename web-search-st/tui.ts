// Small /web settings menu — select-loop, same pattern as ui-theme / context-guard.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type ProviderName,
  type WebSearchStSettings,
  PROVIDER_ORDER,
  keySource,
  maskKey,
  moveProvider,
  normalizeDisabled,
} from "./settings.js";

export interface WebTuiDeps {
  getSessionEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
  getSettings: () => WebSearchStSettings;
  saveSettings: (s: WebSearchStSettings) => void;
  chainPreview: () => string;
}

function parseId(item: string): string | undefined {
  return item.match(/\[([^\]]+)\]\s*$/)?.[1];
}

function envBrave(): string | undefined {
  return process.env.BRAVE_API_KEY;
}

function envTavily(): string | undefined {
  return process.env.TAVILY_API_KEY;
}

function providerAvail(name: ProviderName, s: WebSearchStSettings): string {
  if (name === "brave") {
    const src = keySource(envBrave(), s.braveKey);
    if (src === "none") return "no key";
    return src === "env" ? "key · env" : "key · saved";
  }
  if (name === "tavily") {
    const src = keySource(envTavily(), s.tavilyKey);
    if (src === "none") return "no key";
    return src === "env" ? "key · env" : "key · saved";
  }
  return "available";
}

function keyLine(label: string, id: string, envVal: string | undefined, saved: string): string {
  const src = keySource(envVal, saved);
  const shown = src === "env" ? maskKey(envVal ?? "") : maskKey(saved);
  const tag = src === "none" ? "empty" : src === "env" ? (saved ? "env (saved too)" : "env") : "saved";
  return `🔑  ${label}: ${shown} · ${tag}  [${id}]`;
}

async function editKey(
  ctx: ExtensionCommandContext,
  title: string,
): Promise<string | undefined> {
  const value = await ctx.ui.input(title, "paste key, empty = clear saved");
  if (value === undefined) return undefined;
  return value.trim();
}

async function providerMenu(
  ctx: ExtensionCommandContext,
  deps: WebTuiDeps,
  name: ProviderName,
): Promise<void> {
  const s = deps.getSettings();
  const disabled = new Set(s.disabled);
  const on = !disabled.has(name);
  const options = [
    `${on ? "Disable" : "Enable"} ${name}`,
    "Move up",
    "Move down",
    "",
    "← Back",
  ];
  const choice = await ctx.ui.select(`${name} · ${providerAvail(name, s)}`, options);
  if (!choice || choice === "← Back") return;

  if (choice.startsWith("Disable") || choice.startsWith("Enable")) {
    const nextDisabled = on
      ? normalizeDisabled([...s.disabled, name])
      : normalizeDisabled(s.disabled.filter((n) => n !== name));
    deps.saveSettings({ ...s, disabled: nextDisabled });
    ctx.ui.notify(`${name} → ${on ? "off" : "on"}`, "info");
    return;
  }
  if (choice === "Move up") {
    deps.saveSettings({ ...s, chain: moveProvider(s.chain, name, -1) });
    return;
  }
  if (choice === "Move down") {
    deps.saveSettings({ ...s, chain: moveProvider(s.chain, name, 1) });
  }
}

export async function runWebMenu(ctx: ExtensionCommandContext, deps: WebTuiDeps): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(deps.chainPreview(), "info");
    return;
  }

  while (true) {
    const s = deps.getSettings();
    const sessionOn = deps.getSessionEnabled();
    const disabled = new Set(s.disabled);
    const preview = deps.chainPreview();

    const options: string[] = [
      `${sessionOn ? "●" : "○"}  Tools (this session + default)  [enabled]`,
      `${s.fallback ? "●" : "○"}  Fallback on empty / error  [fallback]`,
      `${s.browserFallback ? "●" : "○"}  Browser fetch last resort (local Chrome)  [browser]`,
      "",
      `Chain  ${preview}`,
    ];
    for (const name of s.chain) {
      const on = !disabled.has(name);
      options.push(`${on ? "●" : "○"}  ${name.padEnd(7)} ${providerAvail(name, s)}  [p:${name}]`);
    }
    options.push(
      "",
      keyLine("Brave ", "k:brave", envBrave(), s.braveKey),
      keyLine("Tavily", "k:tavily", envTavily(), s.tavilyKey),
      "",
      "↺  Reset chain / fallback defaults",
      "← Done",
    );

    const choice = await ctx.ui.select("web-search", options);
    if (!choice || choice === "← Done") return;
    if (choice.startsWith("Chain ")) continue;

    if (choice.startsWith("↺")) {
      deps.saveSettings({
        ...s,
        fallback: true,
        chain: [...PROVIDER_ORDER],
        disabled: [],
      });
      ctx.ui.notify("Chain reset to exa → brave → tavily → bing, fallback on", "info");
      continue;
    }

    const id = parseId(choice);
    if (!id) continue;

    if (id === "enabled") {
      deps.setEnabled(!sessionOn);
      ctx.ui.notify(`Web access ${!sessionOn ? "ON" : "OFF"}`, "info");
      continue;
    }
    if (id === "fallback") {
      deps.saveSettings({ ...s, fallback: !s.fallback });
      ctx.ui.notify(`Fallback → ${!s.fallback ? "ON" : "OFF"}`, "info");
      continue;
    }
    if (id === "browser") {
      deps.saveSettings({ ...s, browserFallback: !s.browserFallback });
      ctx.ui.notify(`Browser fetch last resort → ${!s.browserFallback ? "ON" : "OFF"}`, "info");
      continue;
    }
    if (id.startsWith("p:")) {
      const name = id.slice(2);
      if (name === "exa" || name === "brave" || name === "tavily" || name === "bing") {
        await providerMenu(ctx, deps, name);
      }
      continue;
    }
    if (id === "k:brave") {
      const next = await editKey(ctx, "Brave API key (empty clears saved)");
      if (next === undefined) continue;
      deps.saveSettings({ ...s, braveKey: next });
      ctx.ui.notify(next ? `Brave key saved ${maskKey(next)}` : "Brave saved key cleared", "info");
      continue;
    }
    if (id === "k:tavily") {
      const next = await editKey(ctx, "Tavily API key (empty clears saved)");
      if (next === undefined) continue;
      deps.saveSettings({ ...s, tavilyKey: next });
      ctx.ui.notify(next ? `Tavily key saved ${maskKey(next)}` : "Tavily saved key cleared", "info");
    }
  }
}
