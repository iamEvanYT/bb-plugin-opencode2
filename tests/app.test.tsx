// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { opencodeSettingsRpcContract } from "../src/settings-contract.ts";

const mountedSlots: Array<{ lifecycle: { unmount(): void } }> = [];

afterEach(() => {
  for (const slot of mountedSlots.splice(0)) slot.lifecycle.unmount();
});

describe("OpenCode settings", () => {
  it("loads models and persists provider changes", async () => {
    const app = await loadPluginApp(() => import("../src/app.tsx"));
    const registration = app.settingsSections[0];
    expect(registration?.id).toBe("models");

    const saveSettings = vi.fn(async (settings) => settings);
    const slot = renderSlot<{}, typeof opencodeSettingsRpcContract>(
      registration!,
      {},
      {
        rpc: {
          getSettings: async () => ({
            providerEnabled: true,
            enabledModels: null,
            disableSubagents: true,
            hideBbToolsOutsideBb: true,
          }),
          listModels: async () => ({
            models: [
              {
                id: "openai/gpt-5",
                providerId: "openai",
                displayName: "GPT-5",
              },
            ],
          }),
          saveSettings,
          getStatus: async () => ({
            hosts: [
              {
                hostId: "host_1",
                hostName: "laptop",
                status: {
                  status: "ready" as const,
                  statusMessage: null,
                  installedVersion: "2.0.27",
                  latestVersion: "2.0.28",
                  minimumSupportedVersion: "2.0.26",
                  loginCommand: "opencode2 auth login",
                  modelCount: 1,
                },
              },
            ],
          }),
        },
      },
    );
    mountedSlots.push(slot);

    expect(await slot.findByText(/Ready · OpenCode 2\.0\.27/)).toBeTruthy();
    expect(slot.getByText(/OpenCode 2\.0\.28 is available/)).toBeTruthy();

    // Provider groups start collapsed; expanding shows the models.
    const group = await slot.findByRole("button", { name: /openai/ });
    expect(slot.queryByText("GPT-5")).toBeNull();
    fireEvent.click(group);
    expect(await slot.findByText("GPT-5")).toBeTruthy();

    fireEvent.click(
      slot.getByRole("switch", { name: "Allow OpenCode subagents" }),
    );
    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith({
        providerEnabled: true,
        enabledModels: null,
        disableSubagents: false,
        hideBbToolsOutsideBb: true,
      });
    });

    fireEvent.click(
      slot.getByRole("switch", { name: "Enable OpenCode v2 provider" }),
    );

    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith({
        providerEnabled: false,
        enabledModels: null,
        disableSubagents: false,
        hideBbToolsOutsideBb: true,
      });
    });
  });
});
